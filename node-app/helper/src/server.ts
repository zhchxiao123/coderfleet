// The helper's one HTTP server.
//   /mcp        MCP over HTTP for tasks; every request carries a task token.
//   /control/…  for whoever manages the helper; only the master secret opens it.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { arch, hostname, release, type as systemType } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { openAudit, readAudit } from './audit.ts';
import type { AuditRecord } from './audit.ts';
import { childEnvironment, run } from './exec.ts';
import type { Outcome, Running } from './exec.ts';
import { ensureHome, readRun, readSecret, writeAtomic } from './home.ts';
import type { RunRecord } from './home.ts';
import { BUILT_IN, findProgram, judge, listedPrograms, loadPolicy, programInHome, removeRule, setPath, setRule, setUnlisted } from './policy.ts';
import type { Policy } from './policy.ts';
import { listSerialPorts, MAX_SERIAL_SECONDS, readSerial } from './serial.ts';
import { readToken, signToken } from './token.ts';
import type { Grant } from './token.ts';
import { PROTOCOL, VERSION } from './version.ts';

export const DEFAULT_PORT = 8790;
export const TOKEN_SECONDS = 24 * 3600;
const MAX_TIMEOUT_SECONDS = 1800;
const MAX_BODY = 1024 * 1024;
const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export interface HelperOptions {
  readonly home: string;
  readonly host?: string;
  /** 0 picks a free port. */
  readonly port?: number;
  /** How long a command that needs confirmation waits for an answer. */
  readonly confirmSeconds?: number;
  readonly platform?: NodeJS.Platform;
  /** Where serial devices are listed from (tests point this at a directory of their own). */
  readonly serialDirectory?: string;
  /** How often a waiting tool call sends a keep-alive line. */
  readonly keepaliveMs?: number;
  /** Called after `/control/stop` has answered; the caller closes the helper. */
  readonly onStop?: () => void;
}
export interface Helper { readonly host: string; readonly port: number; close(): Promise<void> }

type Decision = 'allow' | 'allow-task' | 'deny';
type Answer = Decision | 'timeout' | 'revoked' | 'gone';
interface Pending {
  readonly id: string; readonly task: string; readonly label: string;
  readonly argv: readonly string[]; readonly cwd: string;
  readonly created: number; readonly expires: number;
  readonly settle: (answer: Answer) => void;
}
/** What the helper remembers about a task while its token is good. */
interface TaskState { readonly allowed: Set<string>; readonly stops: Set<(force?: boolean) => void> }
interface ToolResult { readonly payload: Record<string, unknown>; readonly failed?: boolean }

class Refusal extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const TOOLS = [
  {
    name: 'machine_info',
    description: 'Describes the machine these tools operate (the host, not your container): system, what this task may do, and which programs the rules allow. Call it first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'run_command',
    description: 'Runs one program on the host machine, without a shell (no pipes, redirects or globs). Only programs the machine\'s rules list may run; some need the owner to confirm, which can take minutes. Returns the exit code and the last 200 lines of output; the full output is in the file named by "log", inside the project directory.',
    inputSchema: {
      type: 'object',
      properties: {
        argv: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Program name (a bare name, not a path) followed by its arguments.' },
        cwd: { type: 'string', description: 'Working directory, relative to the project directory. Default ".".' },
        timeout_s: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_SECONDS, description: 'Seconds before the command and everything it started is killed. Default 120.' },
      },
      required: ['argv'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_serial_ports',
    description: 'Lists the serial ports of the host machine (development boards plugged into it).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_serial',
    description: 'Reads what a serial port of the host machine sends for a number of seconds (at most ' + MAX_SERIAL_SECONDS + '). With reset=true the board is reset first through esptool, so its boot log is included.',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'string', description: 'A port from list_serial_ports.' },
        baud: { type: 'integer', description: 'Default 115200.' },
        seconds: { type: 'integer', minimum: 1, maximum: MAX_SERIAL_SECONDS, description: 'Default 10.' },
        reset: { type: 'boolean', description: 'Reset the board before reading. Default false.' },
      },
      required: ['port'],
      additionalProperties: false,
    },
  },
] as const;

const INSTRUCTIONS = 'These tools act on the host machine that runs your container, with its owner\'s account. '
  + 'The project directory is the same one you see in the container, so files you write there are visible to the commands, and their logs to you. '
  + 'What may run is decided by rules on that machine which you cannot change; a refusal says which rule applied — do not try to work around it.';

function inside(directory: string, path: string): boolean {
  return path === directory || path.startsWith(directory + sep);
}

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...headers });
  response.end(text);
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Refusal(413, 'The request is too large');
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Refusal(400, 'The request body is not JSON'); }
}

function bearer(request: IncomingMessage): string {
  const header = request.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

export async function startHelper(options: HelperOptions): Promise<Helper> {
  const home = options.home;
  const platform = options.platform ?? process.platform;
  const confirmMs = (options.confirmSeconds ?? 600) * 1000;
  const keepaliveMs = options.keepaliveMs ?? 15_000;
  ensureHome(home, platform);
  const secret = readSecret(home);

  const tasks = new Map<string, TaskState>();
  /** Revoked task → when the entry may be forgotten (after any token for it has expired). */
  const revoked = new Map<string, number>();
  const pending = new Map<string, Pending>();
  let version = 1;
  let waiters: Array<() => void> = [];
  let sequence = 0;

  const changed = (): void => {
    version += 1;
    const waiting = waiters;
    waiters = [];
    for (const wake of waiting) wake();
  };
  const state = (task: string): TaskState => {
    let entry = tasks.get(task);
    if (!entry) { entry = { allowed: new Set(), stops: new Set() }; tasks.set(task, entry); }
    return entry;
  };
  const policyNow = (): { policy?: Policy; error?: string } => {
    try { return { policy: loadPolicy(home) }; }
    catch (error) { return { error: (error as Error).message }; }
  };

  function revoke(task: string, force = false): number {
    const now = Date.now();
    for (const [name, forget] of revoked) if (forget < now) revoked.delete(name);
    revoked.set(task, now + (TOKEN_SECONDS + 3600) * 1000);
    const entry = tasks.get(task);
    tasks.delete(task);
    const stopped = entry?.stops.size ?? 0;
    for (const stop of [...(entry?.stops ?? [])]) stop(force);
    for (const item of [...pending.values()]) if (item.task === task) item.settle('revoked');
    return stopped;
  }

  /** Parks a command until someone with the master secret answers, or time runs out. */
  function confirm(grant: Grant, argv: readonly string[], cwd: string, gone: AbortSignal): Promise<Answer> {
    return new Promise(resolvePromise => {
      const id = 'c' + Date.now().toString(36) + randomBytes(4).toString('hex');
      const created = Date.now();
      const timer = setTimeout(() => settle('timeout'), confirmMs);
      const left = (): void => settle('gone');
      function settle(answer: Answer): void {
        if (!pending.delete(id)) return;
        clearTimeout(timer);
        gone.removeEventListener('abort', left);
        changed();
        resolvePromise(answer);
      }
      pending.set(id, { id, task: grant.task, label: grant.label, argv, cwd, created, expires: created + confirmMs, settle });
      gone.addEventListener('abort', left);
      changed();
      if (gone.aborted) left();
    });
  }

  /** Runs something for a task so that revoking the task, or the caller going away, stops it. */
  async function supervised(grant: Grant, gone: AbortSignal, running: Running): Promise<Outcome> {
    const entry = tasks.get(grant.task);
    const stop = (force?: boolean): void => running.stop(force === true);
    const left = (): void => stop();
    entry?.stops.add(stop);
    gone.addEventListener('abort', left);
    // No entry: the task was revoked while this call was on its way here.
    if (!entry || gone.aborted) stop();
    try { return await running.done; }
    finally { entry?.stops.delete(stop); gone.removeEventListener('abort', left); }
  }

  function machineInfo(grant: Grant): ToolResult {
    const current = policyNow();
    return {
      payload: {
        system: systemType(), version: release(), arch: arch(), hostname: hostname(),
        access: grant.access,
        programs: current.policy ? listedPrograms(current.policy) : { allow: [], confirm: [], deny: [], anything_else: 'deny', error: 'The rules file is not valid, so nothing may run: ' + current.error },
        gui: { available: false, reason: 'Screen tools are not part of this version of the helper' },
        cwd: 'run_command\'s cwd is relative to the project directory',
      },
    };
  }

  async function runCommand(grant: Grant, call: string, input: Record<string, unknown>, gone: AbortSignal, note: (fields: Partial<AuditRecord>) => void): Promise<ToolResult> {
    const argv = input.argv;
    const cwdInput = input.cwd ?? '.';
    const timeout = input.timeout_s ?? 120;
    if (!Array.isArray(argv) || !argv.length || !argv.every(item => typeof item === 'string' && !item.includes('\0')) || !argv[0]) throw new Error('argv must be a non-empty list of strings: the program name, then its arguments');
    if (typeof cwdInput !== 'string' || cwdInput.includes('\0')) throw new Error('cwd must be a path relative to the project directory');
    if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_SECONDS) throw new Error('timeout_s must be a whole number from 1 to ' + MAX_TIMEOUT_SECONDS);
    const refuse = (rule: string, message: string, verdict = 'deny', extra: Record<string, unknown> = {}): ToolResult => {
      note({ verdict, rule });
      return { payload: { ran: false, verdict, rule, message, ...extra } };
    };

    let root: string;
    try { root = realpathSync(grant.root); }
    catch { throw new Error('The project directory of this task does not exist on this machine'); }
    let cwd: string;
    try { cwd = realpathSync(resolve(root, cwdInput)); }
    catch { return refuse('cwd-not-found', 'cwd does not exist. It is relative to the project directory, e.g. "." or "ios"'); }
    if (!inside(root, cwd)) return refuse('cwd-outside-root', 'cwd must stay inside the project directory. It is relative to the project directory, e.g. "." or "ios"');
    if (!statSync(cwd).isDirectory()) return refuse('cwd-not-found', 'cwd is not a directory');

    const current = policyNow();
    const verdict = judge(current.policy, home, argv as string[], cwd);
    if (verdict.verdict === 'deny') {
      const why = verdict.rule === 'not-listed' ? 'The rules of this machine do not list this command. Its owner can add it; you cannot.'
        : !verdict.rule.includes(':') && verdict.rule !== 'policy-invalid' && verdict.rule !== 'program-not-a-bare-name' ? 'The owner of this machine has switched this command off. Only they can change that.'
        : verdict.rule === 'policy-invalid' ? 'The rules file of this machine is not valid, so nothing may run: ' + current.error
          : verdict.rule === 'program-not-a-bare-name' ? 'Give the program as a bare name (for example "xcodebuild"), not a path.'
            : 'This is refused on this machine and no rule can allow it.';
      return refuse(verdict.rule, why);
    }
    const policy = current.policy as Policy;
    const file = findProgram(policy, argv[0] as string);
    if (!file) return refuse('not-installed', argv[0] + ' is not installed in the directories this machine runs programs from (' + policy.path.join(', ') + ')');
    if (programInHome(home, file)) return refuse('builtin:helper-directory', 'This is refused on this machine and no rule can allow it.');

    let confirmation: string | undefined;
    if (verdict.verdict === 'confirm') {
      const key = JSON.stringify(argv);
      if (tasks.get(grant.task)?.allowed.has(key)) confirmation = 'allowed-for-task';
      else {
        const answer = await confirm(grant, argv as string[], cwd, gone);
        if (answer === 'allow-task') tasks.get(grant.task)?.allowed.add(key);
        if (answer !== 'allow' && answer !== 'allow-task') {
          confirmation = answer === 'deny' ? 'denied' : answer;
          note({ confirmation });
          return refuse(verdict.rule, answer === 'deny' ? 'The owner of this machine refused this command.'
            : answer === 'timeout' ? 'Nobody confirmed this command in time.' : 'The task was stopped before this command was confirmed.', 'deny-unconfirmed', { confirmation });
        }
        confirmation = 'allowed';
      }
      note({ confirmation });
    }
    if (revoked.has(grant.task)) return refuse(verdict.rule, 'The task was stopped.', 'deny-unconfirmed', { confirmation: 'revoked' });

    const logs = join(root, '.coderfleet-tasks', 'helper');
    mkdirSync(logs, { recursive: true });
    if (!inside(root, realpathSync(logs))) throw new Error('The log directory .coderfleet-tasks/helper leads outside the project directory; the command was not run');
    const log = join('.coderfleet-tasks', 'helper', call + '.log');
    note({ verdict: verdict.verdict, rule: verdict.rule });
    const outcome = await supervised(grant, gone, run({
      file, args: (argv as string[]).slice(1), cwd, env: childEnvironment(policy.path, platform), timeoutMs: timeout * 1000, logPath: join(root, log),
    }));
    note({ exit_code: outcome.exit_code, seconds: outcome.seconds });
    return {
      payload: {
        ran: true, verdict: verdict.verdict, rule: verdict.rule, ...(confirmation ? { confirmation } : {}),
        exit_code: outcome.exit_code, ...(outcome.signal ? { signal: outcome.signal } : {}),
        ...(outcome.timed_out ? { timed_out: true, message: 'Killed after ' + timeout + ' seconds (timeout_s).' } : {}),
        ...(outcome.stopped ? { stopped: true } : {}),
        stdout: outcome.stdout, stderr: outcome.stderr, truncated: outcome.truncated, log, seconds: outcome.seconds,
      },
    };
  }

  async function serial(grant: Grant, input: Record<string, unknown>, gone: AbortSignal, note: (fields: Partial<AuditRecord>) => void): Promise<ToolResult> {
    const port = input.port;
    const baud = input.baud ?? 115200;
    const seconds = input.seconds ?? 10;
    const reset = input.reset ?? false;
    const ports = listSerialPorts(platform, options.serialDirectory);
    if (typeof port !== 'string' || !ports.includes(port)) throw new Error('port must be one of the ports list_serial_ports returns' + (ports.length ? ': ' + ports.join(', ') : ' (there are none right now)'));
    if (typeof baud !== 'number' || !Number.isInteger(baud) || baud < 300 || baud > 4_000_000) throw new Error('baud must be a whole number from 300 to 4000000');
    if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 1 || seconds > MAX_SERIAL_SECONDS) throw new Error('seconds must be a whole number from 1 to ' + MAX_SERIAL_SECONDS);
    if (typeof reset !== 'boolean') throw new Error('reset must be true or false');
    const current = policyNow();
    const environment = childEnvironment(current.policy?.path ?? [], platform);
    if (reset) {
      // A reset is an esptool run like any other, so the rules decide whether it may happen.
      const argv = ['esptool', '--port', port, '--after', 'hard-reset', 'flash-id'];
      const verdict = judge(current.policy, home, argv, '/');
      const file = current.policy && findProgram(current.policy, 'esptool');
      if (verdict.verdict !== 'allow') throw new Error('reset runs "' + argv.join(' ') + '", which the rules of this machine do not allow without confirmation (' + verdict.rule + ')');
      if (!file) throw new Error('reset needs esptool, which is not installed in the directories this machine runs programs from');
      const done = await supervised(grant, gone, run({ file, args: argv.slice(1), cwd: '/', env: environment, timeoutMs: 60_000 }));
      if (done.exit_code !== 0) throw new Error('Resetting the board failed: ' + (done.stderr.trim() || done.stdout.trim() || 'esptool exited with ' + done.exit_code).slice(-2000));
    }
    const outcome = await supervised(grant, gone, readSerial({ port, baud, seconds, platform, env: environment }));
    note({ seconds: outcome.seconds });
    return { payload: { port, baud, seconds: outcome.seconds, text: outcome.stdout, truncated: outcome.truncated, ...(outcome.stopped ? { stopped: true } : {}) } };
  }

  /** One tool call: exactly one line in the operation log, opened before anything happens. */
  async function callTool(grant: Grant, name: string, input: Record<string, unknown>, gone: AbortSignal): Promise<ToolResult> {
    sequence += 1;
    const call = Date.now().toString(36) + '-' + sequence.toString(36) + randomBytes(3).toString('hex');
    let audit: ReturnType<typeof openAudit>;
    try { audit = openAudit(home); }
    catch (error) {
      return { failed: true, payload: { ran: false, error: 'The operation log of this machine cannot be written (' + (error as NodeJS.ErrnoException).code + '), so nothing was done.' } };
    }
    let record: AuditRecord = { time: new Date().toISOString(), call, task: grant.task, label: grant.label, tool: name, args: input, verdict: 'allow' };
    const note = (fields: Partial<AuditRecord>): void => { record = { ...record, ...fields }; };
    state(grant.task);
    try {
      if (name === 'machine_info') return machineInfo(grant);
      if (name === 'run_command') return await runCommand(grant, call, input, gone, note);
      if (name === 'list_serial_ports') return { payload: { ports: listSerialPorts(platform, options.serialDirectory) } };
      if (name === 'read_serial') return await serial(grant, input, gone, note);
      const screen = policyNow().policy?.gui_tools.includes(name);
      if (screen && grant.access !== 'gui') throw new Error('This task has no screen access on this machine');
      if (screen) throw new Error('Screen tools are not part of this version of the helper');
      throw new Error('There is no tool called ' + name);
    } catch (error) {
      note({ verdict: 'error', error: (error as Error).message });
      return { failed: true, payload: { ran: false, error: (error as Error).message } };
    } finally {
      audit.write(record);
    }
  }

  async function mcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const grant = readToken(secret, bearer(request));
    if (!grant || revoked.has(grant.task)) throw new Refusal(401, 'The task token is missing, wrong, expired or revoked');
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    const message = await body(request) as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> };
    const reply = (result: unknown): void => send(response, 200, { jsonrpc: '2.0', id: message.id, result });
    const fault = (code: number, text: string): void => send(response, 200, { jsonrpc: '2.0', id: message.id ?? null, error: { code, message: text } });
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return fault(-32600, 'Not a JSON-RPC 2.0 request');
    if (message.id === undefined || message.id === null) {
      // Notifications (and stray responses) need no answer.
      response.writeHead(202).end();
      return;
    }
    if (message.method === 'initialize') {
      const asked = message.params?.protocolVersion;
      return reply({
        protocolVersion: typeof asked === 'string' && MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'machine', title: 'CoderFleet machine helper', version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    if (message.method === 'ping') return reply({});
    if (message.method === 'tools/list') return reply({ tools: TOOLS });
    if (message.method !== 'tools/call') return fault(-32601, 'Unknown method ' + message.method);
    const name = message.params?.name;
    const input = message.params?.arguments ?? {};
    if (typeof name !== 'string' || typeof input !== 'object' || input === null || Array.isArray(input)) return fault(-32602, 'tools/call needs a tool name and an arguments object');

    // A call may wait for a confirmation and then run for half an hour. Answering as an
    // event stream lets keep-alive lines flow meanwhile, so nothing in between gives up
    // on a silent connection.
    const gone = new AbortController();
    response.on('close', () => { if (!response.writableEnded) gone.abort(); });
    const stream = String(request.headers.accept ?? '').includes('text/event-stream');
    let beat: NodeJS.Timeout | undefined;
    if (stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform' });
      response.write(': waiting\n\n');
      beat = setInterval(() => response.write(': keepalive\n\n'), keepaliveMs);
    }
    let result: ToolResult;
    try { result = await callTool(grant, name, input as Record<string, unknown>, gone.signal); }
    finally { clearInterval(beat); }
    const answer = { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result.payload, null, 1) }], isError: result.failed === true } };
    if (stream) response.end('event: message\ndata: ' + JSON.stringify(answer) + '\n\n');
    else send(response, 200, answer);
  }

  async function control(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const given = Buffer.from(bearer(request), 'hex');
    if (given.length !== secret.length || !timingSafeEqual(given, secret)) throw new Refusal(401, 'The management port needs the master secret');
    const route = request.method + ' ' + url.pathname.slice('/control/'.length);
    const input = request.method === 'POST' ? await body(request) as Record<string, unknown> : {};
    if (route === 'GET status') {
      const current = policyNow();
      return send(response, 200, {
        version: VERSION, protocol: PROTOCOL, pid: process.pid, hostname: hostname(), system: systemType(), arch: arch(),
        tasks: tasks.size, running: [...tasks.values()].reduce((sum, entry) => sum + entry.stops.size, 0), pending: pending.size,
        policy_valid: !current.error, ...(current.error ? { policy_error: current.error } : {}),
      });
    }
    if (route === 'GET pending') {
      const since = Number(url.searchParams.get('since') ?? 0);
      const wait = Math.min(Math.max(Number(url.searchParams.get('wait') ?? 0) || 0, 0), 60);
      if (since === version && wait > 0) {
        await new Promise<void>(resolvePromise => {
          const timer = setTimeout(wake, wait * 1000);
          function wake(): void { clearTimeout(timer); response.off('close', wake); resolvePromise(); }
          waiters.push(wake);
          response.on('close', wake);
        });
      }
      return send(response, 200, {
        version,
        pending: [...pending.values()].map(({ id, task, label, argv, cwd, created, expires }) => ({ id, task, label, tool: 'run_command', argv, cwd, created, expires })),
      });
    }
    if (route === 'POST decide') {
      const item = pending.get(String(input.id));
      if (!item) throw new Refusal(404, 'That request is no longer waiting');
      if (input.decision !== 'allow' && input.decision !== 'allow-task' && input.decision !== 'deny') throw new Refusal(400, 'decision must be allow, allow-task or deny');
      item.settle(input.decision);
      return send(response, 200, { ok: true });
    }
    if (route === 'POST revoke') {
      if (typeof input.task !== 'string' || !input.task) throw new Refusal(400, 'Say which task to revoke');
      return send(response, 200, { ok: true, stopped: revoke(input.task) });
    }
    if (route === 'POST token') {
      const { task, label, access, root } = input;
      if (typeof task !== 'string' || !task || task.length > 200) throw new Refusal(400, 'task must be a short name');
      if (access !== 'command' && access !== 'gui') throw new Refusal(400, 'access must be command or gui');
      if (typeof root !== 'string') throw new Refusal(400, 'root must be a directory');
      let directory: string;
      try { directory = realpathSync(root); if (!statSync(directory).isDirectory()) throw new Error('not a directory'); }
      catch { throw new Refusal(400, 'root must be a directory that exists on this machine: ' + root); }
      if (revoked.has(task)) throw new Refusal(409, 'That task has been revoked');
      const exp = Math.floor(Date.now() / 1000) + TOKEN_SECONDS;
      return send(response, 200, { token: signToken(secret, { task, label: typeof label === 'string' ? label : task, access, root: directory, exp }), exp });
    }
    if (route === 'GET policy') {
      const current = policyNow();
      return send(response, 200, { ...(current.policy ? { policy: current.policy } : { error: current.error }), file: join(home, 'policy.json'), built_in: BUILT_IN });
    }
    if (route === 'POST policy') {
      try {
        if (input.set !== undefined) return send(response, 200, { policy: setRule(home, input.set) });
        if (input.remove !== undefined) return send(response, 200, { policy: removeRule(home, input.remove) });
        if (input.unlisted !== undefined) return send(response, 200, { policy: setUnlisted(home, input.unlisted) });
        if (input.path !== undefined) return send(response, 200, { policy: setPath(home, input.path) });
      } catch (error) { throw new Refusal(400, (error as Error).message); }
      throw new Refusal(400, 'Send {"set": rule}, {"remove": rule}, {"unlisted": action} or {"path": directories}');
    }
    if (route === 'GET audit') {
      const count = Math.min(Math.max(Number(url.searchParams.get('n') ?? 50) || 50, 1), 1000);
      return send(response, 200, { records: readAudit(home, count) });
    }
    if (route === 'POST stop') {
      send(response, 200, { ok: true });
      setImmediate(() => options.onStop?.());
      return;
    }
    throw new Refusal(404, 'Not found');
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://helper');
    const handled = url.pathname === '/mcp' ? mcp(request, response)
      : url.pathname.startsWith('/control/') ? control(request, response, url)
        : Promise.reject(new Refusal(404, 'Not found'));
    handled.catch((error: unknown) => {
      if (response.headersSent) { response.end(); return; }
      const status = error instanceof Refusal ? error.status : 500;
      if (status === 500) console.error(error);
      send(response, status, { error: error instanceof Refusal ? error.message : 'The helper failed to handle this request' });
    });
  });
  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? DEFAULT_PORT, host, () => { server.off('error', reject); resolvePromise(); });
  });
  const port = (server.address() as { port: number }).port;
  const record: RunRecord = { pid: process.pid, host, port, version: VERSION, protocol: PROTOCOL };
  writeAtomic(join(home, 'run.json'), JSON.stringify(record) + '\n');

  return {
    host, port,
    async close() {
      for (const task of [...tasks.keys()]) revoke(task, true);
      for (const item of [...pending.values()]) item.settle('revoked');
      if (readRun(home)?.pid === process.pid) rmSync(join(home, 'run.json'), { force: true });
      server.closeAllConnections();
      await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
    },
  };
}
