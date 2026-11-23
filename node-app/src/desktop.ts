import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, safeStorage, type IpcMainInvokeEvent } from 'electron';
import { atomicJSON, message, readConfig, record, text } from './state.js';

interface Profile {
  readonly id: string;
  readonly name: string;
  readonly kind: 'local' | 'remote';
  readonly url: string;
  readonly configPath?: string;
  readonly encryptedToken?: string;
}

const uiPath = fileURLToPath(new URL('../ui/index.html', import.meta.url));
const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
let mainWindow: BrowserWindow | undefined;
let profiles: Profile[] = [];
const requests = new Set<string>();

function backendUrl(value: string): string {
  const url = new URL(value.trim());
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('Use HTTPS for a remote backend, or HTTP on loopback (including an SSH tunnel)');
  }
  return url.href.replace(/\/+$/, '');
}

function publicProfiles(): Pick<Profile, 'id' | 'name' | 'kind' | 'url'>[] {
  return profiles.map(({ id, name, kind, url }) => ({ id, name, kind, url }));
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

function credentials(profile: Profile): { url: string; token: string } {
  if (profile.kind === 'local' && profile.configPath) {
    const config = readConfig(profile.configPath);
    if (!['127.0.0.1', 'localhost'].includes(config.host)) throw new Error('An App-managed service must listen on loopback');
    return { url: 'http://' + config.host + ':' + config.port, token: config.token };
  }
  if (!profile.encryptedToken || !safeStorage.isEncryptionAvailable()) throw new Error('Backend credentials are unavailable');
  return { url: profile.url, token: safeStorage.decryptString(Buffer.from(profile.encryptedToken, 'base64')) };
}

async function api(profile: Profile, method: string, path: string, data?: unknown): Promise<unknown> {
  const { url, token } = credentials(profile);
  const response = await fetch(url + path, {
    method, redirect: 'error', signal: AbortSignal.timeout(35_000),
    headers: { Authorization: 'Bearer ' + token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result: unknown = await response.json();
  if (!response.ok) throw new Error(text(record(result).error) || 'Backend returned HTTP ' + response.status);
  return result;
}

async function connect(profile: Profile): Promise<unknown> {
  try {
    const health = await api(profile, 'GET', '/v1/health');
    if (record(health).service !== 'coderfleet-node' || record(health).version !== 1) throw new Error('Incompatible CoderFleet service');
    return health;
  } catch (error) {
    if (profile.kind !== 'local' || !profile.configPath || !(error instanceof TypeError)) throw error;
  }
  if (requests.has(profile.id)) throw new Error('The local backend is already starting');
  requests.add(profile.id);
  try {
    const child = spawn(process.execPath, [cliPath, 'serve', profile.configPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      detached: true, windowsHide: true, stdio: 'ignore',
    });
    let spawnError: Error | undefined;
    child.once('error', error => { spawnError = error; });
    child.unref();
    for (let attempt = 0; attempt < 24; attempt += 1) {
      try {
        const health = await api(profile, 'GET', '/v1/health');
        if (record(health).service !== 'coderfleet-node' || record(health).version !== 1) throw new Error('Incompatible CoderFleet service');
        return health;
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        if (spawnError) throw spawnError;
        await sleep(250);
      }
    }
    throw new Error('Could not start the local backend. Run the backend CLI to see its startup error.');
  } finally { requests.delete(profile.id); }
}

/**
 * Creates (once) the App-managed local backend: a configuration in the App's
 * data directory with a random token, serving the default CoderFleet workspace.
 */
function setupLocal(): string {
  const configPath = join(app.getPath('userData'), 'local-backend.json');
  if (!existsSync(configPath)) {
    atomicJSON(configPath, {
      port: 8877, token: randomBytes(32).toString('base64url'), workspace: join(homedir(), '.coderfleet'),
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
    profiles = profiles.filter(profile => profile.id !== id);
    persist();
    return publicProfiles();
  });
  ipcMain.handle('backends:connect', (event, id: unknown) => {
    guard(event);
    return connect(findProfile(id));
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
}

if (!app.requestSingleInstanceLock()) app.quit();
else void startDesktop().catch(error => {
  dialog.showErrorBox('CoderFleet could not start', message(error));
  app.quit();
});
