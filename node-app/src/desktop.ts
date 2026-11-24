import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, safeStorage, type IpcMainInvokeEvent } from 'electron';
import { findBundle, freePort, install, probe, Tunnel, validateTarget, type SshTarget } from './remote.js';
import { atomicJSON, message, readConfig, record, text } from './state.js';
import { BUILD_ID } from './version.js';
import { ensureLocal } from './local-backend.js';

interface Profile {
  readonly id: string;
  readonly name: string;
  readonly kind: 'local' | 'remote' | 'ssh';
  readonly url: string;
  readonly configPath?: string;
  readonly encryptedToken?: string;
  /** SSH backends: the machine, the forwarded local port and the remote service port. */
  readonly ssh?: SshTarget;
  readonly localPort?: number;
  readonly remotePort?: number;
  readonly version?: string;
}

interface Job { status: 'running' | 'succeeded' | 'failed'; log: string; result?: unknown; error?: string }

const uiPath = fileURLToPath(new URL('../ui/index.html', import.meta.url));
const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
let mainWindow: BrowserWindow | undefined;
let profiles: Profile[] = [];
const requests = new Set<string>();
const tunnels = new Map<string, Tunnel>();
const jobs = new Map<string, Job>();
const bundlesDirectory = fileURLToPath(new URL('../bundles/', import.meta.url));
const SSH = process.platform === 'win32' ? 'ssh.exe' : 'ssh';

function backendUrl(value: string): string {
  const url = new URL(value.trim());
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('Use HTTPS for a remote backend, or HTTP on loopback (including an SSH tunnel)');
  }
  return url.href.replace(/\/+$/, '');
}

function publicProfiles(): Record<string, unknown>[] {
  return profiles.map(({ id, name, kind, url, ssh, version }) => ({ id, name, kind, url, host: ssh?.host, version }));
}

function persist(): void {
  atomicJSON(join(app.getPath('userData'), 'backends.json'), profiles);
}

function guard(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame?.url !== pathToFileURL(uiPath).href) {
    throw new Error('Untrusted request');
  }
}

function findProfile(id: unknown): Profile {
  const profile = profiles.find(item => item.id === id);
  if (!profile) throw new Error('Backend not found');
  return profile;
}

function tunnelFor(profile: Profile): Tunnel {
  let tunnel = tunnels.get(profile.id);
  if (!tunnel && profile.ssh && profile.localPort && profile.remotePort) {
    tunnel = new Tunnel(SSH, profile.ssh, profile.localPort, profile.remotePort);
    tunnels.set(profile.id, tunnel);
  }
  if (!tunnel) throw new Error('This SSH backend is incomplete; reinstall it in Settings');
  return tunnel;
}

async function credentials(profile: Profile): Promise<{ url: string; token: string }> {
  if (profile.kind === 'ssh') {
    const tunnel = tunnelFor(profile);
    if (!tunnel.running) await tunnel.ready();
    if (!profile.encryptedToken || !safeStorage.isEncryptionAvailable()) throw new Error('Backend credentials are unavailable');
    return { url: 'http://127.0.0.1:' + tunnel.localPort, token: safeStorage.decryptString(Buffer.from(profile.encryptedToken, 'base64')) };
  }
  if (profile.kind === 'local' && profile.configPath) {
    const config = readConfig(profile.configPath);
    if (!['127.0.0.1', 'localhost'].includes(config.host)) throw new Error('An App-managed service must listen on loopback');
    return { url: 'http://' + config.host + ':' + config.port, token: config.token };
  }
  if (!profile.encryptedToken || !safeStorage.isEncryptionAvailable()) throw new Error('Backend credentials are unavailable');
  return { url: profile.url, token: safeStorage.decryptString(Buffer.from(profile.encryptedToken, 'base64')) };
}

async function api(profile: Profile, method: string, path: string, data?: unknown): Promise<unknown> {
  const { url, token } = await credentials(profile);
  const response = await fetch(url + path, {
    method, redirect: 'error', signal: AbortSignal.timeout(35_000),
    headers: { Authorization: 'Bearer ' + token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result: unknown = await response.json();
  if (!response.ok) throw new Error(text(record(result).error) || 'Backend returned HTTP ' + response.status);
  return result;
}

async function connect(profile: Profile, restart = false): Promise<unknown> {
  if (profile.kind === 'local' && profile.configPath) {
    if (requests.has(profile.id)) throw new Error('本机后端正在启动，请稍候');
    requests.add(profile.id);
    try {
      return await ensureLocal({
        configPath: profile.configPath, managed: profile.configPath === join(app.getPath('userData'), 'local-backend.json'),
        logPath: join(app.getPath('userData'), 'backend.log'), pidPath: join(app.getPath('userData'), 'backend.pid'),
        command: [process.execPath, cliPath], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, version: BUILD_ID, restart,
      });
    } finally { requests.delete(profile.id); }
  }
  try {
    const health = await api(profile, 'GET', '/v1/health');
    if (record(health).service !== 'coderfleet-node' || record(health).version !== 1) throw new Error('这不是 CoderFleet 后端，或版本不兼容');
    return health;
  } catch (error) {
    if (profile.kind === 'ssh' && error instanceof TypeError) throw new Error('SSH 隧道已连通，但远端后端没有响应。可以在设置里重新安装。');
    if (message(error) === 'Invalid backend token') throw new Error('服务令牌不对。请在设置里移除这个连接后重新添加。');
    if (error instanceof TypeError) throw new Error('连不上 ' + profile.url + '：服务没有运行，或网络不通。');
    throw error;
  }
}

/**
 * Creates (once) the App-managed local backend: a configuration in the App's
 * data directory with a random token, serving the default CoderFleet workspace.
 */
async function setupLocal(): Promise<string> {
  const configPath = join(app.getPath('userData'), 'local-backend.json');
  if (!existsSync(configPath)) {
    atomicJSON(configPath, {
      // A free port of its own: a fixed port collides with other backends (another build of the App, a manual one).
      port: await freePort(), token: randomBytes(32).toString('base64url'), workspace: join(homedir(), '.coderfleet'),
      stateDirectory: join(app.getPath('userData'), 'node-state'), dockerPath: dockerExecutable(),
    });
  }
  const existing = profiles.find(profile => profile.configPath === configPath);
  if (existing) return existing.id;
  const config = readConfig(configPath);
  const id = randomUUID();
  profiles = [{ id, kind: 'local', name: '本机', url: 'http://' + config.host + ':' + config.port, configPath }, ...profiles];
  persist();
  return id;
}

/** Apps started from Finder get a minimal PATH; look in the usual Docker locations. */
function dockerExecutable(): string {
  for (const path of ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', join(homedir(), '.orbstack', 'bin', 'docker'), '/usr/bin/docker']) {
    if (existsSync(path)) return path;
  }
  return 'docker';
}

function encryptToken(token: string): string {
  if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
    throw new Error('System-backed credential storage is unavailable');
  }
  return safeStorage.encryptString(token).toString('base64');
}

function startJob(work: (log: (text: string) => void) => Promise<unknown>): string {
  const id = randomUUID();
  const job: Job = { status: 'running', log: '' };
  jobs.set(id, job);
  const log = (value: string): void => { job.log = (job.log + value).slice(-200_000); };
  void work(log).then(
    result => { job.status = 'succeeded'; job.result = result; },
    error => { job.status = 'failed'; job.error = message(error); log('\n' + message(error) + '\n'); },
  );
  return id;
}

/**
 * Probes the machine, installs or upgrades the bundled backend over SSH,
 * stores the token in the system keychain and opens the tunnel.
 */
async function setupSsh(name: string, target: SshTarget, existing: Profile | undefined, log: (text: string) => void): Promise<{ id: string }> {
  log('连接 ' + target.host + '…\n');
  const machine = await probe(SSH, target);
  log('系统：Linux ' + machine.machine + (machine.docker ? '，Docker ' + machine.docker : '') + (machine.installed ? '，已安装后端 ' + machine.installed : '') + '\n');
  if (!machine.arch) throw new Error('不支持的处理器架构 ' + machine.machine);
  if (!machine.docker) throw new Error('这台机器上没有可用的 Docker（或当前用户没有权限使用 Docker）');
  const bundle = findBundle(bundlesDirectory, machine.arch);
  if (!bundle) throw new Error('App 里没有 linux-' + machine.arch + ' 的后端安装包');
  const result = await install(SSH, target, bundle.path, log);
  log('后端 ' + result.version + ' 已运行（' + result.mode + '），远端端口 ' + result.port + '\n');
  tunnels.get(existing?.id ?? '')?.stop();
  if (existing) tunnels.delete(existing.id);
  const id = existing?.id ?? randomUUID();
  const profile: Profile = {
    id, name: name || existing?.name || target.host, kind: 'ssh', url: 'ssh://' + target.host, ssh: target,
    localPort: existing?.localPort ?? await freePort(), remotePort: result.port, version: result.version,
    encryptedToken: encryptToken(result.token),
  };
  profiles = [...profiles.filter(item => item.id !== id), profile];
  persist();
  log('建立 SSH 隧道…\n');
  await tunnelFor(profile).ready();
  await connect(profile);
  log('完成。\n');
  return { id };
}

function register(): void {
  ipcMain.handle('backends:list', event => { guard(event); return publicProfiles(); });
  ipcMain.handle('backends:addLocal', async event => {
    guard(event);
    const current = mainWindow;
    if (!current) throw new Error('Window unavailable');
    const result = await dialog.showOpenDialog(current, {
      title: 'Open CoderFleet backend configuration', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    const config = readConfig(path);
    if (!['127.0.0.1', 'localhost'].includes(config.host)) throw new Error('An App-managed service must listen on loopback');
    const existing = profiles.find(profile => profile.configPath === path);
    if (existing) return existing.id;
    const id = randomUUID();
    profiles = [...profiles, { id, kind: 'local', name: 'This computer · ' + config.port, url: 'http://' + config.host + ':' + config.port, configPath: path }];
    persist();
    return id;
  });
  ipcMain.handle('backends:addRemote', (event, input: unknown) => {
    guard(event);
    const raw = record(input);
    const url = backendUrl(text(raw.url));
    const token = text(raw.token).trim();
    const name = text(raw.name).trim().slice(0, 100);
    if (!name || token.length < 24) throw new Error('Enter a backend name and a valid token');
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
      throw new Error('System-backed credential storage is unavailable');
    }
    const existing = profiles.find(profile => profile.kind === 'remote' && profile.url === url);
    const id = existing?.id ?? randomUUID();
    const encryptedToken = safeStorage.encryptString(token).toString('base64');
    profiles = [...profiles.filter(profile => profile.id !== id), { id, kind: 'remote', name, url, encryptedToken }];
    persist();
    return id;
  });
  ipcMain.handle('backends:remove', (event, id: unknown) => {
    guard(event);
    tunnels.get(text(id))?.stop();
    tunnels.delete(text(id));
    profiles = profiles.filter(profile => profile.id !== id);
    persist();
    return publicProfiles();
  });
  ipcMain.handle('backends:connect', (event, id: unknown) => {
    guard(event);
    return connect(findProfile(id));
  });
  ipcMain.handle('backends:restartLocal', (event, id: unknown) => {
    guard(event);
    const profile = findProfile(id);
    if (profile.kind !== 'local' || !profile.configPath) throw new Error('只能重启本机后端');
    return connect(profile, true);
  });
  ipcMain.handle('backends:request', (event, input: unknown) => {
    guard(event);
    const raw = record(input);
    const method = text(raw.method);
    const path = text(raw.path);
    // The renderer may call any versioned API path; the backend authorizes and validates it.
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method) || !/^\/v1\/[\w./?=&%-]*$/.test(path) || path.includes('..')) {
      throw new Error('Unsupported request');
    }
    return api(findProfile(raw.id), method, path, raw.body);
  });
  ipcMain.handle('remote:addSsh', (event, input: unknown) => {
    guard(event);
    const raw = record(input);
    const port = text(raw.port).trim() ? Number(raw.port) : undefined;
    const target = validateTarget({ host: text(raw.host), port, identityFile: text(raw.identityFile).trim() || undefined });
    encryptToken('check');
    const existing = profiles.find(profile => profile.kind === 'ssh' && profile.ssh?.host === target.host && profile.ssh?.port === target.port);
    return startJob(log => setupSsh(text(raw.name).trim().slice(0, 100), target, existing, log));
  });
  ipcMain.handle('remote:reinstall', (event, id: unknown) => {
    guard(event);
    const profile = findProfile(id);
    if (profile.kind !== 'ssh' || !profile.ssh) throw new Error('Only SSH backends can be reinstalled');
    return startJob(log => setupSsh(profile.name, profile.ssh as SshTarget, profile, log));
  });
  ipcMain.handle('jobs:get', (event, id: unknown) => {
    guard(event);
    const job = jobs.get(text(id));
    if (!job) throw new Error('Job not found');
    return job;
  });
  ipcMain.handle('remote:bundle', event => {
    guard(event);
    return { version: findBundle(bundlesDirectory, 'x64')?.version ?? findBundle(bundlesDirectory, 'arm64')?.version ?? '' };
  });
  ipcMain.handle('dialog:file', async event => {
    guard(event);
    const current = mainWindow;
    if (!current) throw new Error('Window unavailable');
    const result = await dialog.showOpenDialog(current, { title: '选择 SSH 密钥', defaultPath: join(homedir(), '.ssh'), properties: ['openFile', 'showHiddenFiles'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('dialog:directory', async event => {
    guard(event);
    const current = mainWindow;
    if (!current) throw new Error('Window unavailable');
    const result = await dialog.showOpenDialog(current, { title: '选择项目目录', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('backends:setupLocal', event => {
    guard(event);
    return setupLocal();
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280, height: 840, minWidth: 900, minHeight: 600, title: 'CoderFleet',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default', backgroundColor: '#f6f5f2',
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      preload: fileURLToPath(new URL('../ui/preload.cjs', import.meta.url)),
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.once('closed', () => { mainWindow = undefined; });
  await mainWindow.loadFile(uiPath);
}

async function startDesktop(): Promise<void> {
  await app.whenReady();
  try {
    profiles = JSON.parse(readFileSync(join(app.getPath('userData'), 'backends.json'), 'utf8'));
    if (!Array.isArray(profiles)) throw new Error('Invalid saved backends');
  } catch (error) {
    if (record(error).code !== 'ENOENT') {
      throw new Error('Could not read saved backends', { cause: error });
    }
  }
  register();
  await createWindow();
  app.on('activate', () => { if (!mainWindow) void createWindow(); });
  app.on('second-instance', () => { mainWindow?.focus(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => { for (const tunnel of tunnels.values()) tunnel.stop(); });
}

if (!app.requestSingleInstanceLock()) app.quit();
else void startDesktop().catch(error => {
  dialog.showErrorBox('CoderFleet could not start', message(error));
  app.quit();
});
