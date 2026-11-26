// The machine helper (helper/, shipped compiled in dist/helper): a separate
// program on this machine that runs listed commands for tasks holding a token.
// CoderFleet installs and starts it, asks it for one token per task, shows what
// it wants confirmed and revokes the token when the task ends. The master secret
// stays in the helper's own directory and is read from there for each request.
import { execFile, spawn } from 'node:child_process';
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { helperBridgePort, helperPort } from './compose.js';
import { loadConfig, projectHelperAccess, WorkspaceError, type WorkspaceProject } from './conf.js';
import { message, record, text } from './state.js';

const run = promisify(execFile);

/** One command a task wants to run and the helper's rules want confirmed first. */
export interface HelperPending { readonly id: string; readonly task: string; readonly argv: readonly string[]; readonly cwd: string; readonly expires: number }

export interface HelperStatus {
  /** The helper this build ships. */
  readonly bundled: string;
  /** The installed one ('' when not installed). */
  readonly installed: string;
  readonly running: boolean;
  /** The running one's version; differs from `bundled` when it should be upgraded. */
  readonly version: string;
  /** False when the running helper speaks another protocol: no task gets a token until it is upgraded. */
  readonly compatible: boolean;
  readonly upgrade: boolean;
  readonly host: string;
  readonly port: number;
  /** What tasks in relay containers connect to. */
  readonly url: string;
  /** The relay's forward to the helper: there, not there (restart the relay), or the relay is not running. */
  readonly relay: 'ready' | 'missing' | 'stopped' | 'unknown';
  readonly home: string;
  readonly tasks: number;
  readonly pending: number;
  readonly policyError: string;
  readonly machine: string;
}

export type HelperDecision = 'allow' | 'allow-task' | 'deny';

/** The answers on a confirmation card, in the order shown. */
export const HELPER_ANSWERS: readonly { label: string; description: string; decision: HelperDecision }[] = [
  { label: '允许这一次', description: '只放行这一条命令', decision: 'allow' },
  { label: '这个任务里同样的命令都允许', description: '这个任务结束前，同一个程序、同样的参数不再问', decision: 'allow-task' },
  { label: '拒绝', description: '不运行，任务会收到被拒绝的结果', decision: 'deny' },
];

/** Turn approvals that belong to the helper carry this prefix, so answers go to it and not to the worker. */
export const HELPER_CARD = 'helper-';

/** Environment variables that hand a task its connection; the worker removes them before the agent starts. */
export const HELPER_URL_ENV = 'CODERFLEET_HELPER_URL';
export const HELPER_TOKEN_ENV = 'CODERFLEET_HELPER_TOKEN';

const bundle = fileURLToPath(new URL('./helper/', import.meta.url));

export class HelperHost {
  public readonly home = process.env.CODERFLEET_HELPER_HOME || join(homedir(), '.coderfleet-helper');
  private shipped?: Promise<{ version: string; protocol: number }>;

  public constructor(private readonly workspace: string, private readonly dockerPath: string) {}

  private config(): { host: string; port: number; url: string; bridge: string } {
    const config = loadConfig(this.workspace);
    const bridge = helperBridgePort(config);
    return {
      host: config.HELPER_HOST || '127.0.0.1', port: Number(helperPort(config)), bridge,
      url: 'http://' + (config.RELAY_IP || '172.21.0.2') + ':' + bridge + '/mcp',
    };
  }

  /** The helper compiled into this build. */
  private bundled(): Promise<{ version: string; protocol: number }> {
    return this.shipped ??= import(pathToFileURL(join(bundle, 'version.js')).href)
      .then(module => ({ version: text(module.VERSION), protocol: Number(module.PROTOCOL) }));
  }

  private installedVersion(): string {
    try { return readFileSync(join(this.home, 'bin', 'VERSION'), 'utf8').trim(); } catch { return ''; }
  }

  /** One request to the helper's management port; undefined when nothing answers there. */
  private async control(method: string, path: string, body?: unknown, timeout = 5_000): Promise<{ status: number; body: Record<string, unknown> } | undefined> {
    let secret: string; let address: { host: string; port: number };
    try {
      secret = readFileSync(join(this.home, 'secret'), 'utf8').trim();
      address = JSON.parse(readFileSync(join(this.home, 'run.json'), 'utf8')) as { host: string; port: number };
    } catch { return undefined; }
    const host = address.host.includes(':') ? '[' + address.host + ']' : address.host;
    try {
      const response = await fetch('http://' + host + ':' + address.port + '/control/' + path, {
        method, headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout),
      });
      return { status: response.status, body: record(await response.json()) };
    } catch { return undefined; }
  }

  /** Like `control`, for what the user asked for: a helper that is not there or refuses is an error. */
  private async ask(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const answer = await this.control(method, path, body);
    if (!answer) throw new WorkspaceError('机器助手没有在运行');
    if (answer.status >= 400) throw new WorkspaceError(text(answer.body.error) || '机器助手拒绝了这个请求（' + answer.status + '）');
    return answer.body;
  }

  private async relay(bridge: string): Promise<HelperStatus['relay']> {
    try {
      const { stdout } = await run(this.dockerPath, ['ps', '-a', '--format', '{{.Names}}\t{{.State}}'], { timeout: 5_000, maxBuffer: 4_000_000 });
      if (!stdout.split('\n').some(line => line.split('\t')[0] === 'coderfleet-proxy-relay' && line.split('\t')[1] === 'running')) return 'stopped';
    } catch { return 'unknown'; }
    try { await run(this.dockerPath, ['exec', 'coderfleet-proxy-relay', 'nc', '-z', 'localhost', bridge], { timeout: 5_000 }); return 'ready'; }
    catch (error) { return record(error).code === 1 ? 'missing' : 'unknown'; }
  }

  public async status(): Promise<HelperStatus> {
    const [shipped, answer] = await Promise.all([this.bundled(), this.control('GET', 'status')]);
    const settings = this.config();
    const live = answer?.status === 200 ? answer.body : undefined;
    const installed = this.installedVersion();
    return {
      bundled: shipped.version, installed, running: Boolean(live), version: text(live?.version),
      compatible: !live || live.protocol === shipped.protocol,
      upgrade: Boolean(installed) && installed !== shipped.version || Boolean(live) && live?.version !== shipped.version,
      host: settings.host, port: settings.port, url: settings.url, relay: live ? await this.relay(settings.bridge) : 'unknown',
      home: this.home, tasks: Number(live?.tasks ?? 0), pending: Number(live?.pending ?? 0),
      policyError: text(live?.policy_error), machine: live ? [text(live.hostname), text(live.system), text(live.arch)].filter(Boolean).join(' · ') : '',
    };
  }

  /** Copies the helper this build ships into its own directory; rules, secret and log stay. */
  public async install(): Promise<void> {
    if (!existsSync(join(bundle, 'main.js'))) throw new WorkspaceError('这个版本没有带机器助手');
    const shipped = await this.bundled();
    const target = join(this.home, 'bin');
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    chmodSync(this.home, 0o700);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { mode: 0o700 });
    for (const name of readdirSync(bundle)) if (name.endsWith('.js')) cpSync(join(bundle, name), join(target, name));
    writeFileSync(join(target, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(target, 'VERSION'), shipped.version + '\n');
  }

  public async start(): Promise<void> {
    if ((await this.control('GET', 'status'))?.status === 200) return;
    const script = join(this.home, 'bin', 'main.js');
    if (!existsSync(script)) throw new WorkspaceError('机器助手还没有安装');
    const settings = this.config();
    const logPath = join(this.home, 'helper.log');
    const log = openSync(logPath, 'a', 0o600);
    try {
      // Its own process group and no ties to this service: it keeps running when the backend restarts.
      const child = spawn(process.execPath, [script, 'serve', '--port', String(settings.port), '--host', settings.host], {
        detached: true, stdio: ['ignore', log, log],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CODERFLEET_HELPER_HOME: this.home },
      });
      child.unref();
    } finally { closeSync(log); }
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await sleep(100);
      if ((await this.control('GET', 'status', undefined, 1_000))?.status === 200) return;
    }
    let tail = '';
    try { tail = readFileSync(logPath, 'utf8').trim().split('\n').slice(-3).join('\n'); } catch { /* no log */ }
    throw new WorkspaceError('机器助手没有启动起来' + (tail ? '：' + tail : ''));
  }

  /** Stops the helper and every command it is running. */
  public async stop(): Promise<void> {
    if (!await this.control('POST', 'stop', {})) return;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await sleep(100);
      if (!await this.control('GET', 'status', undefined, 1_000)) return;
    }
    throw new WorkspaceError('机器助手没有停下来');
  }

  /** Replaces the installed helper with the one this build ships; a running one is restarted. */
  public async upgrade(): Promise<void> {
    const running = Boolean(await this.control('GET', 'status'));
    if (running) await this.stop();
    await this.install();
    if (running) await this.start();
  }

  /**
   * The environment that connects one task to the helper, or nothing when the
   * project has no access, the account cannot reach it, or the helper is not there.
   * `reason` says why, for the service log.
   */
  public async grant(project: WorkspaceProject, taskId: string): Promise<{ env: Record<string, string>; reason?: string }> {
    const access = projectHelperAccess(project);
    if (access === 'off') return { env: {} };
    if (project.account.type !== 'claude' || project.account.runtime !== 'container') return { env: {}, reason: '只有容器里的 Claude Code 任务能用机器助手' };
    if (project.account.proxy !== 'relay') return { env: {}, reason: '不走 relay 的账号连不到机器助手' };
    const status = await this.control('GET', 'status');
    if (status?.status !== 200) return { env: {}, reason: '机器助手没有在运行' };
    if (status.body.protocol !== (await this.bundled()).protocol) return { env: {}, reason: '机器助手的版本和这个后端对不上，请先升级它' };
    const answer = await this.control('POST', 'token', { task: taskId, label: project.name, access, root: project.path });
    const token = text(answer?.body.token);
    if (answer?.status !== 200 || !token) return { env: {}, reason: text(answer?.body.error) || '机器助手没有发出令牌' };
    return { env: { [HELPER_URL_ENV]: this.config().url, [HELPER_TOKEN_ENV]: token } };
  }

  /** Ends a task's access: its token stops working and what it started is killed. */
  public async revoke(taskId: string): Promise<void> {
    const answer = await this.control('POST', 'revoke', { task: taskId });
    if (answer && answer.status >= 400) console.error('Helper did not revoke', taskId, message(answer.body.error));
  }

  /** Commands waiting for a person; undefined when the helper does not answer. */
  public async pending(): Promise<HelperPending[] | undefined> {
    const answer = await this.control('GET', 'pending', undefined, 3_000);
    if (answer?.status !== 200 || !Array.isArray(answer.body.pending)) return undefined;
    return answer.body.pending.map(record).map(item => ({
      id: text(item.id), task: text(item.task), cwd: text(item.cwd), expires: Number(item.expires),
      argv: Array.isArray(item.argv) ? item.argv.map(text) : [],
    }));
  }

  public async decide(id: string, decision: HelperDecision): Promise<void> { await this.ask('POST', 'decide', { id, decision }); }
  public policy(): Promise<Record<string, unknown>> { return this.ask('GET', 'policy'); }
  public changePolicy(change: unknown): Promise<Record<string, unknown>> { return this.ask('POST', 'policy', change); }
  public audit(count: number): Promise<Record<string, unknown>> { return this.ask('GET', 'audit?n=' + count); }
}
