// The App-managed local backend: a detached `serve` process that outlives the
// window. Connecting checks who answers on its port (this App's build, an older
// build, another backend, or nothing) and starts, replaces or moves it.
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { freePort } from './remote.js';
import { atomicJSON, readConfig, record, text } from './state.js';

export type LocalState = { kind: 'ours'; health: unknown } | { kind: 'stale'; pid?: number; build: string } | { kind: 'foreign' } | { kind: 'down' };

/** What answers on a local backend's port: this App's backend, an older one, someone else's, or nothing. */
export async function probeLocal(url: string, token: string, version: string): Promise<LocalState> {
  let response: Response;
  try { response = await fetch(url + '/v1/health', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(3_000) }); }
  catch { return { kind: 'down' }; }
  if (response.status === 401) return { kind: 'foreign' };
  let health: Record<string, unknown>;
  try { health = record(await response.json()); } catch { return { kind: 'foreign' }; }
  if (!response.ok || health.service !== 'coderfleet-node') return { kind: 'foreign' };
  if ((health.buildId ?? health.build) !== version) return { kind: 'stale', pid: typeof health.pid === 'number' ? health.pid : undefined, build: text(health.build) || '旧版本' };
  return { kind: 'ours', health };
}


function logTail(path: string): string {
  try { return readFileSync(path, 'utf8').trim().split('\n').slice(-8).join('\n'); } catch { return ''; }
}

async function waitDown(url: string, token: string): Promise<boolean> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if ((await probeLocal(url, token, '')).kind === 'down') return true;
    await sleep(200);
  }
  return false;
}

/** Stops an older backend of this App: a graceful shutdown, else its recorded process. */
async function stopLocal(url: string, token: string, pidPath: string, pid?: number): Promise<boolean> {
  try { await fetch(url + '/v1/shutdown', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(3_000) }); } catch { /* older builds lack it */ }
  if (await waitDown(url, token)) return true;
  let recorded = pid;
  try { recorded ??= Number(readFileSync(pidPath, 'utf8')); } catch { /* no record */ }
  if (recorded) { try { process.kill(recorded, 'SIGTERM'); } catch { /* already gone */ } }
  return waitDown(url, token);
}

export interface LocalBackend {
  readonly configPath: string;
  /** The App created this configuration and may move it to another port. */
  readonly managed: boolean;
  readonly logPath: string;
  readonly pidPath: string;
  /** The program and script that run `serve <config>`. */
  readonly command: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  /** The backend build this App ships (BUILD_ID); any other build is replaced. */
  readonly version: string;
  readonly restart?: boolean;
}

/**
 * Makes sure this App's own backend answers on the configured port, starting,
 * upgrading or moving it as needed, and returns its health.
 */
export async function ensureLocal(options: LocalBackend): Promise<unknown> {
  const path = options.configPath;
  let config = readConfig(path);
  let url = 'http://' + config.host + ':' + config.port;
  let state = await probeLocal(url, config.token, options.version);
  if (state.kind === 'ours' && !options.restart) return state.health;
  if (state.kind === 'ours' || state.kind === 'stale') {
    const pid = state.kind === 'stale' ? state.pid : record(state.health).pid as number | undefined;
    state = await stopLocal(url, config.token, options.pidPath, pid) ? { kind: 'down' } : { kind: 'foreign' };
  }
  if (state.kind === 'foreign') {
    // Another backend holds the port. An App-managed configuration moves to a free port;
    // a configuration the user chose keeps its port and reports the conflict.
    if (!options.managed) throw new Error('端口 ' + config.port + ' 已被另一个后端占用（令牌不同）。请关掉那个后端，或在配置文件里换一个端口。');
    const raw = record(JSON.parse(readFileSync(path, 'utf8')));
    atomicJSON(path, { ...raw, port: await freePort() });
    config = readConfig(path);
    url = 'http://' + config.host + ':' + config.port;
  }
  const log = openSync(options.logPath, 'a');
  const [program, ...args] = options.command;
  const child = spawn(program as string, [...args, 'serve', path], { env: options.env, detached: true, windowsHide: true, stdio: ['ignore', log, log] });
  closeSync(log);
  let spawnError: Error | undefined;
  child.once('error', error => { spawnError = error; });
  if (child.pid) writeFileSync(options.pidPath, String(child.pid));
  child.unref();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = await probeLocal(url, config.token, options.version);
    if (current.kind === 'ours') return current.health;
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) break;
    await sleep(250);
  }
  const tail = logTail(options.logPath);
  throw new Error('本机后端没有启动起来。' + (tail ? '\n\n' + tail : ''));
}
