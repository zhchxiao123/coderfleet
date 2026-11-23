// Interactive terminals inside containers, used for account login and for a
// project shell. `script` allocates the pseudo-terminal inside the container,
// so the host needs no native PTY module; the desktop client polls output and
// posts keystrokes. Login runs in the account's running project container, or
// in a temporary container like coderfleet/login_cmd.py.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { accountType } from './accounts.js';
import { imageName } from './compose.js';
import { ensureBindMountDir, loadConfig, readWorkspace, WorkspaceError, type Account } from './conf.js';
import { join } from 'node:path';

const run = promisify(execFile);
const MAX_BUFFER = 1024 * 1024;
const IDLE_LIMIT = 30 * 60 * 1000;

function quote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }

export interface TerminalChunk { readonly data: string; readonly offset: number; readonly exited: boolean; readonly exitCode: number | null; readonly title: string }

class Session {
  private buffer = Buffer.alloc(0);
  private start = 0;
  public exitCode: number | null = null;
  public exited = false;
  public touched = Date.now();
  private readonly waiters = new Set<() => void>();

  public constructor(public readonly id: string, public readonly title: string, private readonly child: ChildProcessWithoutNullStreams,
    private readonly cleanup?: () => void) {
    const append = (chunk: Buffer): void => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > MAX_BUFFER) {
        const drop = this.buffer.length - MAX_BUFFER;
        this.buffer = this.buffer.subarray(drop);
        this.start += drop;
      }
      this.notify();
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.stdin.on('error', () => undefined);
    child.once('error', error => { append(Buffer.from('\r\n' + error.message + '\r\n')); this.finish(1); });
    child.once('close', code => this.finish(code ?? 1));
  }

  private finish(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.cleanup?.();
    this.notify();
  }

  private notify(): void { for (const waiter of this.waiters) waiter(); this.waiters.clear(); }

  public async read(offset: number, wait: number): Promise<TerminalChunk> {
    this.touched = Date.now();
    const end = (): number => this.start + this.buffer.length;
    if (offset >= end() && !this.exited && wait > 0) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, wait);
        this.waiters.add(() => { clearTimeout(timer); resolve(); });
      });
    }
    const from = Math.max(offset, this.start);
    const data = this.buffer.subarray(from - this.start).toString('base64');
    return { data, offset: end(), exited: this.exited, exitCode: this.exitCode, title: this.title };
  }

  public write(data: Buffer): void {
    this.touched = Date.now();
    if (!this.exited) this.child.stdin.write(data);
  }

  public close(): void {
    if (this.exited) return;
    this.child.stdin.end();
    setTimeout(() => { if (!this.exited) this.child.kill('SIGKILL'); }, 3_000).unref();
  }
}

export class Terminals {
  private readonly sessions = new Map<string, Session>();

  public constructor(private readonly workspace: string, private readonly dockerPath: string) {
    setInterval(() => {
      for (const [id, session] of this.sessions) {
        if (Date.now() - session.touched > IDLE_LIMIT) { session.close(); this.sessions.delete(id); }
        else if (session.exited && Date.now() - session.touched > 60_000) this.sessions.delete(id);
      }
    }, 60_000).unref();
  }

  private open(title: string, args: string[], cleanup?: () => void): string {
    const child = spawn(this.dockerPath, args, { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    const id = randomUUID();
    this.sessions.set(id, new Session(id, title, child, cleanup));
    return id;
  }

  public session(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new WorkspaceError('终端已关闭');
    return session;
  }

  public close(id: string): void {
    this.sessions.get(id)?.close();
  }

  private static wrap(command: string[], cols: number, rows: number): string[] {
    const size = 'stty cols ' + Math.max(20, Math.min(400, cols)) + ' rows ' + Math.max(5, Math.min(200, rows)) + ' 2>/dev/null; ';
    return ['env', 'TERM=xterm-256color', 'script', '-qfec', size + 'exec ' + command.map(quote).join(' '), '/dev/null'];
  }

  private async running(container: string): Promise<boolean> {
    try {
      const { stdout } = await run(this.dockerPath, ['inspect', '--format', '{{.State.Running}}', container], { timeout: 10_000 });
      return stdout.trim() === 'true';
    } catch { return false; }
  }

  /** A login shell in a running project container. */
  public async shell(projectName: string, cols: number, rows: number): Promise<string> {
    const project = readWorkspace(this.workspace).projects.find(item => item.name === projectName);
    if (!project) throw new WorkspaceError('项目不存在');
    if (!await this.running(project.container)) throw new WorkspaceError('容器未运行，请先启动项目');
    return this.open(project.name + ' · 终端', ['exec', '-i', '--workdir', '/workspace', project.container, ...Terminals.wrap(['bash', '-l'], cols, rows)]);
  }

  /** The account type's login command, in a running project container or a temporary one. */
  public async login(account: Account, cols: number, rows: number): Promise<string> {
    if (account.auth === 'env') throw new WorkspaceError('该账号使用环境变量认证，不需要登录');
    const spec = accountType(account.type);
    const title = account.name + ' · 登录';
    for (const project of readWorkspace(this.workspace).projects) {
      if (project.account.name === account.name && await this.running(project.container)) {
        return this.open(title, ['exec', '-i', project.container, ...Terminals.wrap([...spec.login], cols, rows)]);
      }
    }
    const config = loadConfig(this.workspace);
    const image = imageName(config);
    try { await run(this.dockerPath, ['image', 'inspect', '--format', '{{.Id}}', image], { timeout: 10_000 }); }
    catch { throw new WorkspaceError('镜像 ' + image + ' 不存在，请先在「设置」里构建镜像'); }
    const proxyUrl = 'http://' + (config.PROXY_HOST || 'host.docker.internal') + ':' + (config.PROXY_HTTP_PORT || '7890');
    const authSource = join(this.workspace, 'accounts', account.name);
    ensureBindMountDir(authSource);
    const name = 'coderfleet-login-' + account.type + '-' + account.name;
    await run(this.dockerPath, ['rm', '-f', name], { timeout: 15_000 }).catch(() => undefined);
    const env = {
      HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, ALL_PROXY: proxyUrl, all_proxy: proxyUrl,
      NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1', CODEX_HOME: '/home/byclaw/.codex', CLAUDE_CONFIG_DIR: '/home/byclaw/.claude',
      TZ: config.CONTAINER_TIMEZONE || 'Asia/Shanghai', CODERFLEET_ACCOUNT_NAME: account.name, CODERFLEET_ACCOUNT_TYPE: account.type,
      CODERFLEET_RELAY_IP: config.PROXY_HOST || 'host.docker.internal', CODERFLEET_RELAY_PORT: config.PROXY_HTTP_PORT || '7890', ...spec.envVars,
    };
    const args = ['run', '--rm', '-i', '--name', name, '--platform', config.BUILD_PLATFORM || 'linux/amd64',
      '--add-host', 'host.docker.internal:host-gateway'];
    for (const [key, value] of Object.entries(env)) args.push('-e', key + '=' + value);
    // The image's entrypoint runs first, as for `coderfleet login`.
    args.push('-v', authSource + ':' + spec.authDir, '-w', '/workspace', image, ...Terminals.wrap([...spec.login], cols, rows));
    return this.open(title, args, () => { void run(this.dockerPath, ['rm', '-f', name], { timeout: 15_000 }).catch(() => undefined); });
  }
}
