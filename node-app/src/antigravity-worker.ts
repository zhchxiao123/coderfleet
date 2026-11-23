// Runs one Antigravity ACP turn inside the project's persistent container.
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
import { emit, errorMessage, list, object, openMailbox, runMain, str, writeState, type BaseSpec, type Json } from './worker-kit.js';

export const AGY_VERSION = '1.5.15';
const RPC_TIMEOUT = 30_000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

type Id = number | string;
export type WorkerSpec = BaseSpec;
interface Permission { request: Id; key: string; title: string; details: Json; choices: Partial<Record<'allow_once' | 'reject_once', string>> }

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
          if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new AcpError('Antigravity sent an oversized ACP frame');
          const message = object(JSON.parse(line));
          if (message.jsonrpc !== '2.0') throw new AcpError('Antigravity returned an invalid JSON-RPC frame');
          if ('method' in message) { dispatch(message); return; }
          const waiter = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
          if (!waiter) return;
          this.pending.delete(message.id as number);
          if (message.error && typeof message.error === 'object') {
            const error = object(message.error);
            waiter.reject(new AcpError(str(error.message) || 'ACP request failed', typeof error.code === 'number' ? error.code : undefined));
          } else if (message.result && typeof message.result === 'object') waiter.resolve(object(message.result));
          else waiter.reject(new AcpError('Antigravity returned an invalid ACP response'));
        } catch (error) { this.fail(error instanceof Error ? error : new AcpError(String(error))); }
      });
      lines.on('close', () => { this.fail(new AcpError('Antigravity ACP stream closed')); resolve(); });
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

  public constructor(private readonly spec: WorkerSpec, private readonly mailbox: ControlMailbox) {}

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
        emit('assistant', { message: { content: [{ type: 'tool_use', id, name: str(tool.title) || 'Antigravity tool', input: tool.rawInput ?? {} }] } });
      }
      if ((tool.status === 'completed' || tool.status === 'failed') && !tool._settled) {
        tool._settled = true;
        const output = tool.rawOutput ?? tool.content ?? '';
        emit('user', { message: { content: [{
          type: 'tool_result', tool_use_id: id,
          content: typeof output === 'string' ? output : JSON.stringify(output), is_error: tool.status === 'failed',
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
      tool_call_id: permission.key, tool_name: permission.title, tool_input: permission.details,
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
    const details: Json = {};
    for (const key of ['rawInput', 'content', 'locations']) if (key in tool) details[key] = tool[key];
    this.permissions.push({ request, key: randomUUID().replaceAll('-', ''), title: str(tool.title) || 'Antigravity tool', details, choices });
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
        this.mailbox.acknowledge(command.id, undefined, 'Antigravity did not offer one-time approval');
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
        if (this.cancelled && now >= this.cancelDeadline) throw new AcpError('Antigravity did not settle after cancellation');
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

  private async configureMode(rpc: Connection, session: Json): Promise<void> {
    const params = { sessionId: this.sessionId };
    for (const option of list(session.configOptions)) {
      if (option.category === 'mode' && option.type === 'select') {
        if (option.currentValue !== 'default') await rpc.request('session/set_config_option', { ...params, configId: option.id, value: 'default' });
        return;
      }
    }
    const modes = object(session.modes);
    if (modes.currentModeId === 'default') return;
    if (!list(modes.availableModes).some(mode => mode.id === 'default')) throw new AcpError('Antigravity did not expose the default approval mode');
    await rpc.request('session/set_mode', { ...params, modeId: 'default' });
  }

  private async configureModel(rpc: Connection, session: Json): Promise<void> {
    const model = this.spec.model;
    if (!model) return;
    for (const option of list(session.configOptions)) {
      if (option.category === 'model' && option.type === 'select') {
        if (option.currentValue !== model) await rpc.request('session/set_config_option', { sessionId: this.sessionId, configId: option.id, value: model });
        return;
      }
    }
    throw new AcpError('Antigravity did not expose an ACP model selector');
  }

  public async run(rpc: Connection): Promise<number> {
    this.mailbox.publish('starting');
    const initialized = await rpc.request('initialize', {
      protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'coderfleet', version: '1' },
    });
    if (initialized.protocolVersion !== 1) throw new AcpError('Antigravity negotiated an unsupported ACP version');
    const capabilities = object(object(initialized.agentCapabilities).sessionCapabilities);
    const params: Json = { cwd: this.spec.cwd, mcpServers: [] };
    const supplied = this.spec.session_id;
    if (supplied) {
      if (!('resume' in capabilities)) throw new AcpError('Antigravity ACP cannot resume the saved session');
      params.sessionId = supplied;
    }
    if (this.spec.env_auth) {
      if (!process.env.GEMINI_API_KEY?.trim()) throw new AcpError('Configure GEMINI_API_KEY for this Antigravity account');
      if (!list(initialized.authMethods).some(method => method.id === 'gemini-api-key')) throw new AcpError('Antigravity ACP did not advertise Gemini API key authentication');
      await rpc.request('authenticate', { methodId: 'gemini-api-key' });
    }
    const session = await rpc.request(supplied ? 'session/resume' : 'session/new', params);
    if (supplied && session.sessionId !== undefined && session.sessionId !== supplied) throw new AcpError('Antigravity ACP returned a different session ID on resume');
    this.sessionId = supplied || str(session.sessionId);
    if (!this.sessionId) throw new AcpError('Antigravity ACP returned no session ID');
    this.system('coderfleet_acp_session', { session_id: this.sessionId });
    this.system('coderfleet_session', { session_id: this.sessionId });
    try {
      await this.configureMode(rpc, session);
      await this.configureModel(rpc, session);
      this.active = true;
      this.mailbox.publish('accepting');
      this.system('coderfleet_control_ready', { capabilities: ['approval', 'interrupt'], permission_mode: 'default' });
      const stop = { done: false };
      const prompt = rpc.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: this.spec.prompt }] }, null);
      const control = this.control(rpc, stop);
      let result: Json;
      try {
        result = await Promise.race([prompt, control.then(() => { throw new AcpError('Control loop stopped'); }),
          rpc.closed.then(() => { throw rpc.failure ?? new AcpError('Antigravity ACP stream closed'); })]);
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
      if (this.cancelled || reason !== 'end_turn') throw new AcpError('Antigravity stopped with ' + (str(reason) || 'an unknown reason'));
      return 0;
    } finally {
      if ('close' in capabilities && !rpc.failure) {
        try { await rpc.request('session/close', { sessionId: this.sessionId }, 5_000); }
        catch (error) { if (!(error instanceof AcpError) || error.code !== -32002) throw error; }
      }
    }
  }
}

function agyVersion(env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('agy', ['--version'], { env, timeout: 10_000 }, (error, stdout) => {
      if (error) reject(new AcpError('Antigravity ' + AGY_VERSION + ' is required (found unknown)'));
      else resolve(stdout.trim());
    });
  });
}

export async function runWorker(spec: WorkerSpec): Promise<number> {
  const mailbox = openMailbox(spec);
  const turn = new Turn(spec, mailbox);
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
    if (!spec.env_auth) delete env.GEMINI_API_KEY;
    const actual = await agyVersion(env);
    if (actual !== AGY_VERSION) throw new AcpError('Antigravity ' + AGY_VERSION + ' is required (found ' + (actual || 'unknown') + ')');
    turn.system('coderfleet_backend', { execution_backend: 'acp', cli_version: actual });
    child = spawn('agy', ['acp'], { cwd: spec.cwd, env, stdio: ['pipe', 'pipe', 'inherit'] }) as unknown as ChildProcessWithoutNullStreams;
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
    emit('error', { message: errorMessage(error) });
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
