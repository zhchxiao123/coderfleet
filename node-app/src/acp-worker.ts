// Runs one Agent Client Protocol (ACP) turn inside the project's persistent
// container, for every CLI that speaks ACP over stdio: Antigravity (`agy acp`),
// Kimi Code (`kimi acp`) and Grok (`grok agent stdio`).
// Port of coderfleet/data/scripts/coderfleet_antigravity_worker.py: same task
// specification, same stream-json events on stdout, same control mailbox and
// exit codes (0 done, 143 interrupted, 1 failed). Only Node built-ins may be
// imported: the host copies this file into the project's .coderfleet-tasks.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Command, ControlMailbox } from './control.js';
import { attachments, emit, errorMessage, list, object, openMailbox, runMain, str, withPaths, writeState, type BaseSpec, type Json } from './worker-kit.js';

export const AGY_VERSION = '1.5.15';

/** How each ACP agent is started and configured. */
export interface AcpAgent {
  readonly label: string;
  readonly command: readonly string[];
  /** Exact CLI version this integration was accepted with, when pinned. */
  readonly version?: { readonly command: readonly string[]; readonly expected: string };
  /** Antigravity must run in its manual-approval mode; others use it when offered. */
  readonly requireDefaultMode: boolean;
  /** Environment-variable authentication: the variable and the ACP auth method. */
  readonly envAuth?: { readonly variable: string; readonly method: string };
}

export const ACP_AGENTS: Readonly<Record<string, AcpAgent>> = {
  antigravity: {
    label: 'Antigravity', command: ['agy', 'acp'], version: { command: ['agy', '--version'], expected: AGY_VERSION },
    requireDefaultMode: true, envAuth: { variable: 'GEMINI_API_KEY', method: 'gemini-api-key' },
  },
  kimi: { label: 'Kimi Code', command: ['kimi', 'acp'], requireDefaultMode: false },
  grok: { label: 'Grok', command: ['grok', '--no-auto-update', 'agent', 'stdio'], requireDefaultMode: false },
};
const RPC_TIMEOUT = 30_000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

type Id = number | string;
export interface WorkerSpec extends BaseSpec { agent?: string }
interface Permission { request: Id; key: string; toolId: string; title: string; details: Json; choices: Partial<Record<'allow_once' | 'reject_once', string>> }

class AcpError extends Error {
  public constructor(message: string, public readonly code?: number) { super(message); }
}

class Connection {
  private sequence = 0;
  private readonly pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>();
  public readonly closed: Promise<void>;
  public failure?: Error;

  public constructor(private readonly child: ChildProcessWithoutNullStreams, dispatch: (message: Json) => void) {
    this.closed = new Promise(resolve => {
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', line => {
        if (this.failure) return;
        try {
          if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new AcpError('The agent sent an oversized ACP frame');
          const message = object(JSON.parse(line));
          if (message.jsonrpc !== '2.0') throw new AcpError('The agent returned an invalid JSON-RPC frame');
          if ('method' in message) { dispatch(message); return; }
          const waiter = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
          if (!waiter) return;
          this.pending.delete(message.id as number);
          if (message.error && typeof message.error === 'object') {
            const error = object(message.error);
            waiter.reject(new AcpError(str(error.message) || 'ACP request failed', typeof error.code === 'number' ? error.code : undefined));
          } else if (message.result && typeof message.result === 'object') waiter.resolve(object(message.result));
          else waiter.reject(new AcpError('The agent returned an invalid ACP response'));
        } catch (error) { this.fail(error instanceof Error ? error : new AcpError(String(error))); }
      });
      lines.on('close', () => { this.fail(new AcpError('The agent closed the ACP stream')); resolve(); });
    });
    child.stdin.on('error', error => this.fail(error));
  }

  private fail(error: Error): void {
    if (!this.failure) this.failure = error;
    for (const waiter of this.pending.values()) waiter.reject(this.failure);
    this.pending.clear();
  }

  public send(message: Json): void {
    if (this.failure) throw this.failure;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }

  public request(method: string, params: Json, timeout: number | null = RPC_TIMEOUT): Promise<Json> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise<Json>((resolve, reject) => {
      const timer = timeout === null ? undefined : setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpError(method + ' timed out'));
      }, timeout);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      try { this.send({ id, method, params }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
}

export class Turn {
  private sessionId = '';
  private active = false;
  public cancelled = false;
  private readonly inbound: Json[] = [];
  private readonly permissions: Permission[] = [];
  private deadline = 0;
  private cancelDeadline = 0;
  private messageId = '';
  private messageKind = '';
  private readonly chunks: string[] = [];
  private readonly tools = new Map<string, Json>();
  private wake: () => void = () => undefined;

  public constructor(private readonly spec: WorkerSpec, private readonly mailbox: ControlMailbox, private readonly agent: AcpAgent) {}

  public system(subtype: string, fields: Json = {}): void {
    emit('system', { subtype, task_id: this.spec.task_id, ...fields });
  }

  private stream(kind: string, fields: Json = {}): void { emit('stream_event', { event: { type: kind, ...fields } }); }

  private flushText(): void {
    if (!this.chunks.length) return;
    this.stream('message_stop');
    emit('assistant', { message: { id: this.messageId, content: [{ type: this.messageKind, [this.messageKind]: this.chunks.join('') }] } });
    this.chunks.length = 0;
  }

  private update(params: Json): void {
    if (!this.active || params.sessionId !== this.sessionId) return;
    const update = object(params.update);
    const kind = update.sessionUpdate;
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      const text = object(update.content).text;
      if (typeof text !== 'string' || !text) return;
      const block = kind === 'agent_message_chunk' ? 'text' : 'thinking';
      if (!this.chunks.length || block !== this.messageKind) {
        this.flushText();
        this.messageKind = block;
        this.messageId = randomUUID().replaceAll('-', '');
        this.stream('message_start', { message: { id: this.messageId } });
      }
      this.chunks.push(text);
      this.stream('content_block_delta', { index: 0, delta: { type: block + '_delta', [block]: text } });
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      this.flushText();
      const id = update.toolCallId;
      if (typeof id !== 'string' || !id) return;
      const initial = !this.tools.has(id);
      const tool = this.tools.get(id) ?? {};
      for (const [key, value] of Object.entries(update)) if (value !== null && value !== undefined) tool[key] = value;
      this.tools.set(id, tool);
      if (initial) {
        emit('assistant', { message: { content: [{ type: 'tool_use', id, name: str(tool.title) || 'Tool', input: tool.rawInput ?? {} }] } });
      }
      if ((tool.status === 'completed' || tool.status === 'failed') && !tool._settled) {
        tool._settled = true;
        const output = toolOutput(tool);
        emit('user', { message: { content: [{
          type: 'tool_result', tool_use_id: id, content: output ?? '', is_error: tool.status === 'failed',
          ...(output === undefined ? { output_unreported: true } : {}),
        }] } });
      }
    }
  }

  public dispatch(message: Json): void {
    if (message.method === 'session/update' && !('id' in message)) this.update(object(message.params));
    else if ('id' in message) { this.inbound.push(message); this.wake(); }
  }

  private showPermission(): void {
    const permission = this.permissions[0];
    if (!permission) return;
    const timeout = this.spec.permission_timeout;
    this.deadline = Date.now() + timeout * 1000;
    this.flushText();
    this.system('coderfleet_permission_pending', {
      tool_call_id: permission.key, tool_use_id: permission.toolId, tool_name: permission.title, tool_input: permission.details,
      deadline: new Date(Date.now() + timeout * 1000).toISOString(), decision_only: true,
      can_allow: Boolean(permission.choices.allow_once),
    });
  }

  private acceptRequest(rpc: Connection, message: Json): void {
    const request = message.id as Id;
    if (message.method !== 'session/request_permission') {
      rpc.send({ id: request, error: { code: -32601, message: 'Unsupported client method' } });
      return;
    }
    const params = object(message.params);
    const tool = object(params.toolCall);
    if (!this.active || params.sessionId !== this.sessionId || this.cancelled) {
      rpc.send({ id: request, result: { outcome: { outcome: 'cancelled' } } });
      return;
    }
    const choices: Permission['choices'] = {};
    for (const option of list(params.options)) {
      if (typeof option.optionId === 'string' && (option.kind === 'allow_once' || option.kind === 'reject_once')) choices[option.kind] = option.optionId;
    }
    if (!Object.keys(choices).length) {
      rpc.send({ id: request, result: { outcome: { outcome: 'cancelled' } } });
      return;
    }
    if (this.spec.auto && choices.allow_once) {
      // Auto mode (Python: --always-approve / --yolo): approve without asking.
      rpc.send({ id: request, result: { outcome: { outcome: 'selected', optionId: choices.allow_once } } });
      return;
    }
    const details: Json = {};
    for (const key of ['rawInput', 'content', 'locations']) if (key in tool) details[key] = tool[key];
    this.permissions.push({ request, key: randomUUID().replaceAll('-', ''), toolId: str(tool.toolCallId), title: str(tool.title) || 'Tool', details, choices });
    if (this.permissions.length === 1) this.showPermission();
  }

  private resolvePermission(rpc: Connection, status: string, choice?: string): void {
    const permission = this.permissions.shift();
    if (!permission) return;
    rpc.send({ id: permission.request, result: { outcome: choice ? { outcome: 'selected', optionId: choice } : { outcome: 'cancelled' } } });
    this.system('coderfleet_permission_closed', { tool_call_id: permission.key, status });
    if (!this.cancelled) this.showPermission();
  }

  public interrupt(rpc: Connection): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.cancelDeadline = Date.now() + 5_000;
    if (this.sessionId) rpc.send({ method: 'session/cancel', params: { sessionId: this.sessionId } });
    while (this.permissions.length) this.resolvePermission(rpc, 'cancelled');
    this.system('coderfleet_interrupted');
  }

  private command(rpc: Connection, command: Command): void {
    this.mailbox.claim(command.id);
    const payload = command.payload;
    if (command.kind === 'ping') this.mailbox.acknowledge(command.id, { connected: true });
    else if (command.kind === 'interrupt' && !this.cancelled) {
      this.interrupt(rpc);
      this.mailbox.acknowledge(command.id, { interrupted: true });
    } else if (command.kind === 'approval' && this.permissions[0]?.key === payload.tool_call_id) {
      const decision = payload.decision;
      if ((decision !== 'allow' && decision !== 'deny') || 'updated_input' in payload || payload.message) {
        this.mailbox.acknowledge(command.id, undefined, 'ACP approval accepts only an allow or deny decision');
        return;
      }
      const option = this.permissions[0]?.choices[decision === 'allow' ? 'allow_once' : 'reject_once'];
      if (decision === 'allow' && !option) {
        this.mailbox.acknowledge(command.id, undefined, 'The agent did not offer one-time approval');
        return;
      }
      this.resolvePermission(rpc, decision === 'allow' ? 'approved' : 'denied', option);
      this.mailbox.acknowledge(command.id);
    } else this.mailbox.acknowledge(command.id, undefined, 'Command is unavailable for this ACP turn');
  }

  // Event-driven control loop: requests from the agent and host commands wake
  // it immediately; a slow tick covers deadlines and missed file events.
  private async control(rpc: Connection, stop: { done: boolean }): Promise<void> {
    let watcher: FSWatcher | undefined;
    try { watcher = watch(join(this.spec.control_directory, 'requests'), () => this.wake()); }
    catch { /* polling alone still delivers commands */ }
    try {
      while (!stop.done) {
        const now = Date.now();
        if (this.cancelled && now >= this.cancelDeadline) throw new AcpError('The agent did not settle after cancellation');
        if (this.permissions.length && now >= this.deadline) this.resolvePermission(rpc, 'timed_out', this.permissions[0]?.choices.reject_once);
        for (const command of this.mailbox.pending()) this.command(rpc, command);
        while (this.inbound.length) this.acceptRequest(rpc, this.inbound.shift() as Json);
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 200);
          this.wake = () => { clearTimeout(timer); resolve(); };
        });
        this.wake = () => undefined;
      }
    } finally { watcher?.close(); }
  }

  /** Selects the manual-approval mode named `default` when the agent offers one. */
  private async configureMode(rpc: Connection, session: Json): Promise<void> {
    const params = { sessionId: this.sessionId };
    for (const option of list(session.configOptions)) {
      if (option.category === 'mode' && option.type === 'select') {
        const values = list(option.options).map(item => item.value);
        if (option.currentValue === 'default') return;
        if (values.length && !values.includes('default') && !this.agent.requireDefaultMode) return;
        await rpc.request('session/set_config_option', { ...params, configId: option.id, value: 'default' });
        return;
      }
    }
    const modes = object(session.modes);
    if (!Object.keys(modes).length || modes.currentModeId === 'default') {
      if (this.agent.requireDefaultMode && !Object.keys(modes).length) throw new AcpError(this.agent.label + ' did not expose the default approval mode');
      return;
    }
    if (!list(modes.availableModes).some(mode => mode.id === 'default')) {
      if (this.agent.requireDefaultMode) throw new AcpError(this.agent.label + ' did not expose the default approval mode');
      return;
    }
    await rpc.request('session/set_mode', { ...params, modeId: 'default' });
  }

  /** Applies the requested model through a config option or the session model selector. */
  private async configureModel(rpc: Connection, session: Json): Promise<void> {
    const model = this.spec.model;
    if (!model) return;
    for (const option of list(session.configOptions)) {
      if (option.category === 'model' && option.type === 'select') {
        if (option.currentValue !== model) await rpc.request('session/set_config_option', { sessionId: this.sessionId, configId: option.id, value: model });
        return;
      }
    }
    const models = object(session.models);
    if (Object.keys(models).length) {
      if (models.currentModelId !== model) await rpc.request('session/set_model', { sessionId: this.sessionId, modelId: model });
      return;
    }
    throw new AcpError(this.agent.label + ' did not expose an ACP model selector');
  }

  public async run(rpc: Connection): Promise<number> {
    this.mailbox.publish('starting');
    const initialized = await rpc.request('initialize', {
      protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'coderfleet', version: '1' },
    });
    if (initialized.protocolVersion !== 1) throw new AcpError(this.agent.label + ' negotiated an unsupported ACP version');
    const capabilities = object(object(initialized.agentCapabilities).sessionCapabilities);
    // Images go as ACP image blocks when the agent accepts them, otherwise as paths in the text.
    const files = attachments(this.spec.cwd, this.spec.images);
    const imageBlocks = object(object(initialized.agentCapabilities).promptCapabilities).image === true;
    const native = imageBlocks ? files.filter(file => file.kind === 'image') : [];
    const listed = withPaths(this.spec.prompt, files.filter(file => !native.includes(file)));
    const content: Json[] = [...(listed ? [{ type: 'text', text: listed }] : []), ...native.map(file => ({ type: 'image', mimeType: file.mime, data: file.data() }))];
    const params: Json = { cwd: this.spec.cwd, mcpServers: [] };
    const supplied = this.spec.session_id;
    if (supplied) {
      if (!('resume' in capabilities)) throw new AcpError(this.agent.label + ' cannot resume the saved session');
      params.sessionId = supplied;
    }
    const envAuth = this.agent.envAuth;
    if (this.spec.env_auth && envAuth) {
      if (!process.env[envAuth.variable]?.trim()) throw new AcpError('Configure ' + envAuth.variable + ' for this ' + this.agent.label + ' account');
      if (!list(initialized.authMethods).some(method => method.id === envAuth.method)) throw new AcpError(this.agent.label + ' did not advertise ' + envAuth.method + ' authentication');
      await rpc.request('authenticate', { methodId: envAuth.method });
    }
    const session = await rpc.request(supplied ? 'session/resume' : 'session/new', params);
    if (supplied && session.sessionId !== undefined && session.sessionId !== supplied) throw new AcpError(this.agent.label + ' returned a different session ID on resume');
    this.sessionId = supplied || str(session.sessionId);
    if (!this.sessionId) throw new AcpError(this.agent.label + ' returned no session ID');
    this.system('coderfleet_acp_session', { session_id: this.sessionId });
    this.system('coderfleet_session', { session_id: this.sessionId });
    try {
      await this.configureMode(rpc, session);
      await this.configureModel(rpc, session);
      this.active = true;
      this.mailbox.publish('accepting');
      this.system('coderfleet_control_ready', { capabilities: ['approval', 'interrupt'], permission_mode: this.spec.auto ? 'auto' : 'default' });
      const stop = { done: false };
      const prompt = rpc.request('session/prompt', { sessionId: this.sessionId, prompt: content }, null);
      const control = this.control(rpc, stop);
      let result: Json;
      try {
        result = await Promise.race([prompt, control.then(() => { throw new AcpError('Control loop stopped'); }),
          rpc.closed.then(() => { throw rpc.failure ?? new AcpError('The agent closed the ACP stream'); })]);
      } finally {
        stop.done = true;
        this.wake();
        this.active = false;
        prompt.catch(() => undefined);
        await control.catch(() => undefined);
        this.flushText();
        for (const permission of this.permissions) this.system('coderfleet_permission_closed', { tool_call_id: permission.key, status: 'cancelled' });
        this.permissions.length = 0;
      }
      const reason = result.stopReason;
      if (reason === 'cancelled') {
        if (!this.cancelled) this.system('coderfleet_interrupted');
        return 143;
      }
      if (this.cancelled || reason !== 'end_turn') throw new AcpError(this.agent.label + ' stopped with ' + (str(reason) || 'an unknown reason'));
      return 0;
    } finally {
      if ('close' in capabilities && !rpc.failure) {
        try { await rpc.request('session/close', { sessionId: this.sessionId }, 5_000); }
        catch (error) { if (!(error instanceof AcpError) || error.code !== -32002) throw error; }
      }
    }
  }
}

/**
 * What a settled tool call reported: the text of its content blocks, else its raw output.
 * `undefined` when the agent sent neither (Antigravity's web search and file reads end that
 * way), which is not the same as a tool that ran and printed nothing.
 */
export function toolOutput(tool: Json): string | undefined {
  const blocks = list(tool.content);
  const texts = blocks.map(block => object(block.content).text).filter((item): item is string => typeof item === 'string');
  if (texts.length) return texts.join('\n');
  const raw = tool.rawOutput;
  if (typeof raw === 'string') return raw;
  if (raw !== null && raw !== undefined) return typeof object(raw).output === 'string' ? object(raw).output as string : JSON.stringify(raw);
  return blocks.length ? JSON.stringify(tool.content) : undefined;
}

function cliVersion(command: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise(resolve => {
    execFile(command[0] as string, command.slice(1), { env, timeout: 10_000 }, (error, stdout) => resolve(error ? '' : stdout.trim()));
  });
}

export async function runWorker(spec: WorkerSpec): Promise<number> {
  const mailbox = openMailbox(spec);
  const agent = ACP_AGENTS[spec.agent || 'antigravity'];
  if (!agent) { emit('error', { message: 'Unsupported ACP agent ' + spec.agent }); mailbox.close(); return 1; }
  const turn = new Turn(spec, mailbox, agent);
  let child: ChildProcessWithoutNullStreams | undefined;
  let rpc: Connection | undefined;
  let interrupted = false;
  const onSignal = (): void => {
    interrupted = true;
    if (rpc) turn.interrupt(rpc);
    else child?.kill('SIGTERM');
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  try {
    const ownershipToken = writeState(spec);
    const env: NodeJS.ProcessEnv = { ...process.env, CODERFLEET_SDK_OWNER_TOKEN: ownershipToken };
    if (agent.envAuth && !spec.env_auth) delete env[agent.envAuth.variable];
    let actual = '';
    if (agent.version) {
      actual = await cliVersion(agent.version.command, env);
      if (actual !== agent.version.expected) throw new AcpError(agent.label + ' ' + agent.version.expected + ' is required (found ' + (actual || 'unknown') + ')');
    }
    turn.system('coderfleet_backend', { execution_backend: 'acp', agent: spec.agent || 'antigravity', cli_version: actual });
    child = spawn(agent.command[0] as string, agent.command.slice(1), { cwd: spec.cwd, env, stdio: ['pipe', 'pipe', 'inherit'] }) as unknown as ChildProcessWithoutNullStreams;
    const spawned = child;
    await new Promise<void>((resolve, reject) => { spawned.once('spawn', resolve); spawned.once('error', reject); });
    rpc = new Connection(spawned, message => turn.dispatch(message));
    if (interrupted) turn.interrupt(rpc);
    return await turn.run(rpc);
  } catch (error) {
    if (interrupted || turn.cancelled) {
      if (!turn.cancelled) turn.system('coderfleet_interrupted');
      return 143;
    }
    const text = errorMessage(error);
    emit('error', { message: /authentication required/i.test(text) ? text + '：这个账号还没有登录，请在「账号」页点登录' : text });
    return 1;
  } finally {
    try { mailbox.close(); }
    finally {
      const running = child;
      if (running && running.exitCode === null && running.signalCode === null) {
        running.stdin.end();
        const exited = new Promise<void>(resolve => running.once('exit', () => resolve()));
        const timer = setTimeout(() => running.kill('SIGKILL'), 2_000);
        await exited;
        clearTimeout(timer);
      }
    }
  }
}

await runMain(import.meta.url, runWorker);
