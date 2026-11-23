// Remote Docker hosts over SSH: probe the machine, upload and install the
// backend bundle, and keep a local port forwarded to the remote service.
// Uses the system `ssh` with the user's keys and ~/.ssh/config; nothing here
// depends on Electron, so the tests drive it directly.
import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';

export interface SshTarget {
  /** A host name, `user@host`, or an alias from ~/.ssh/config. */
  readonly host: string;
  readonly port?: number;
  readonly identityFile?: string;
}

export interface InstallResult {
  readonly port: number;
  readonly token: string;
  readonly version: string;
  readonly mode: string;
  readonly docker: string;
  readonly workspace: string;
}

export interface Probe { readonly arch: 'x64' | 'arm64' | ''; readonly machine: string; readonly docker: string; readonly installed: string }

const HOST = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._:\[\]-]+$/;

export function validateTarget(target: SshTarget): SshTarget {
  const host = target.host.trim();
  if (!HOST.test(host) || host.startsWith('-')) throw new Error('SSH 主机格式不对，应为 user@host 或 ~/.ssh/config 里的别名');
  if (target.port !== undefined && (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535)) throw new Error('SSH 端口无效');
  if (target.identityFile && !existsSync(target.identityFile)) throw new Error('找不到密钥文件 ' + target.identityFile);
  return { host, port: target.port, identityFile: target.identityFile || undefined };
}

/** Options shared by every connection: keys only, no prompts, detect dead links. */
export function sshOptions(target: SshTarget): string[] {
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new'];
  if (target.port) args.push('-p', String(target.port));
  if (target.identityFile) args.push('-i', target.identityFile, '-o', 'IdentitiesOnly=yes');
  return args;
}

export interface ExecResult { readonly code: number; readonly stdout: string; readonly stderr: string }

/** Runs a shell command on the remote host. `input` is streamed to its stdin. */
export function sshExec(ssh: string, target: SshTarget, command: string,
  { input, timeout = 60_000, onOutput }: { input?: string; timeout?: number; onOutput?: (text: string) => void } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(ssh, [...sshOptions(target), target.host, command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('SSH 命令超时')); }, timeout);
    child.stdout.on('data', chunk => { stdout += chunk; onOutput?.(String(chunk)); });
    child.stderr.on('data', chunk => { stderr += chunk; onOutput?.(String(chunk)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code: code ?? 255, stdout, stderr }); });
    if (input) createReadStream(input).on('error', reject).pipe(child.stdin);
    else child.stdin.end();
  });
}

function explain(result: ExecResult): Error {
  const text = (result.stderr || result.stdout).trim();
  if (result.code === 255 && /Permission denied|publickey/i.test(text)) return new Error('SSH 登录被拒绝：请先配置密钥登录（ssh-copy-id），App 不保存密码');
  if (result.code === 255 && /Could not resolve|Name or service not known/i.test(text)) return new Error('找不到这台主机：' + text);
  if (result.code === 255 && /timed out|Connection refused|No route/i.test(text)) return new Error('连不上这台主机：' + text);
  return new Error(text.split('\n').filter(Boolean).slice(-3).join('\n') || 'SSH 命令失败（' + result.code + '）');
}

export async function probe(ssh: string, target: SshTarget): Promise<Probe> {
  const result = await sshExec(ssh, target, 'uname -sm; (docker version --format "{{.Server.Version}}" 2>/dev/null || echo "-"); '
    + 'cat "${CODERFLEET_BACKEND_HOME:-$HOME/.coderfleet-backend}/current/VERSION" 2>/dev/null || echo "-"', { timeout: 30_000 });
  if (result.code !== 0) throw explain(result);
  const [system = '', docker = '-', installed = '-'] = result.stdout.trim().split('\n').map(line => line.trim());
  const [kernel, machine = ''] = system.split(/\s+/);
  if (kernel !== 'Linux') throw new Error('远端系统是 ' + (kernel || '未知') + '，目前只支持 Linux');
  const arch = /^(x86_64|amd64)$/.test(machine) ? 'x64' : /^(aarch64|arm64)$/.test(machine) ? 'arm64' : '';
  return { arch, machine, docker: docker === '-' ? '' : docker, installed: installed === '-' ? '' : installed };
}

/** The bundled backend archive for an architecture, from `directory`. */
export function findBundle(directory: string, arch: string): { path: string; version: string } | undefined {
  if (!existsSync(directory)) return undefined;
  for (const name of readdirSync(directory)) {
    const match = /^coderfleet-backend-(.+)-linux-(x64|arm64)\.tar\.gz$/.exec(name);
    if (match && match[2] === arch) return { path: join(directory, name), version: match[1] as string };
  }
  return undefined;
}

/** Uploads the bundle, runs its installer and returns the service's port and token. */
export async function install(ssh: string, target: SshTarget, bundle: string, log: (text: string) => void): Promise<InstallResult> {
  const upload = '${CODERFLEET_BACKEND_HOME:-$HOME/.coderfleet-backend}/upload';
  log('上传后端安装包…\n');
  const sent = await sshExec(ssh, target, 'umask 077; mkdir -p "' + upload + '" && cat > "' + upload + '/bundle.tar.gz"', { input: bundle, timeout: 15 * 60_000 });
  if (sent.code !== 0) throw explain(sent);
  log('安装并启动服务…\n');
  const result = await sshExec(ssh, target, 'set -e; cd "' + upload + '"; rm -rf coderfleet-backend; tar -xzf bundle.tar.gz; '
    + 'sh coderfleet-backend/install.sh; rm -rf coderfleet-backend bundle.tar.gz', {
    timeout: 5 * 60_000,
    onOutput: text => log(text.split('\n').filter(line => !line.startsWith('CODERFLEET_INSTALL_RESULT')).join('\n')),
  });
  const line = result.stdout.split('\n').find(item => item.startsWith('CODERFLEET_INSTALL_RESULT '));
  if (result.code !== 0 || !line) throw explain(result);
  const parsed = JSON.parse(line.slice('CODERFLEET_INSTALL_RESULT '.length)) as InstallResult;
  if (!Number.isInteger(parsed.port) || typeof parsed.token !== 'string' || parsed.token.length < 24) throw new Error('安装程序返回的结果无效');
  return parsed;
}

function portOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

/**
 * Forwards 127.0.0.1:localPort to the remote service's loopback port and
 * reconnects with backoff when the SSH connection drops.
 */
export class Tunnel {
  private child?: ChildProcess;
  private stopped = false;
  private failures = 0;
  private lastError = '';

  public constructor(private readonly ssh: string, private readonly target: SshTarget,
    public readonly localPort: number, private readonly remotePort: number) {}

  public get running(): boolean { return Boolean(this.child && this.child.exitCode === null); }

  private launch(): void {
    if (this.stopped) return;
    const child = spawn(this.ssh, [...sshOptions(this.target), '-N', '-o', 'ExitOnForwardFailure=yes',
      '-L', '127.0.0.1:' + this.localPort + ':127.0.0.1:' + this.remotePort, this.target.host], { stdio: ['ignore', 'ignore', 'pipe'] });
    this.child = child;
    let errors = '';
    child.stderr?.on('data', chunk => { errors += chunk; });
    child.once('exit', () => {
      if (this.child === child) this.child = undefined;
      this.lastError = errors.trim();
      if (this.stopped) return;
      this.failures += 1;
      setTimeout(() => this.launch(), Math.min(30_000, 1_000 * 2 ** Math.min(this.failures, 5))).unref();
    });
  }

  /** Starts the tunnel if needed and waits until the local port accepts connections. */
  public async ready(timeout = 20_000): Promise<void> {
    this.stopped = false;
    if (!this.child) this.launch();
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await portOpen(this.localPort) && this.running) { this.failures = 0; return; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('SSH 隧道没有建立' + (this.lastError ? '：' + this.lastError : ''));
  }

  public stop(): void {
    this.stopped = true;
    this.child?.kill();
    this.child = undefined;
  }
}

/** A free local port for a new tunnel. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    import('node:net').then(({ createServer }) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        server.close(() => resolve(port));
      });
    }, reject);
  });
}
