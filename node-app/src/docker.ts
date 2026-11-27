// Docker boundary. Like the Python scheduler, every operation runs inside the
// project's persistent container (created by `coderfleet apply`) through
// `docker exec`; this service never creates per-turn containers.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type WorkspaceProject } from './conf.js';

const run = promisify(execFile);
const CONTAINER_ROOT = '/workspace';
const NETWORK_CHECK_TTL = 60_000;
const internalNetworks = new Map<string, number>();

export function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export async function containerRunning(dockerPath: string, container: string): Promise<boolean> {
  try {
    const { stdout } = await run(dockerPath, ['inspect', '--format', '{{.State.Running}}', container], { timeout: 10_000 });
    return stdout.trim() === 'true';
  } catch { return false; }
}

/**
 * The container must be running and, unless the account opted out with
 * PROXY=off, attached only to internal networks so that all egress goes
 * through the relay. Running state is checked on every call; a network's
 * internal flag is cached briefly.
 */
export async function assertContainer(dockerPath: string, project: WorkspaceProject): Promise<void> {
  let networks: string[];
  try {
    const { stdout } = await run(dockerPath, ['inspect', '--format',
      '{{.State.Running}} {{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}', project.container], { timeout: 10_000 });
    const [running, ...names] = stdout.trim().split(/\s+/);
    if (running !== 'true') throw new Error('stopped');
    networks = names;
  } catch {
    throw new Error('Container ' + project.container + ' is not running. Start it with `coderfleet up` first.');
  }
  if (project.account.proxy === 'off') return;
  if (!networks.length) throw new Error('Container ' + project.container + ' has no network');
  for (const network of networks) {
    const key = dockerPath + '\0' + network;
    const checked = internalNetworks.get(key);
    if (checked && Date.now() - checked < NETWORK_CHECK_TTL) continue;
    const { stdout } = await run(dockerPath, ['network', 'inspect', '--format', '{{.Internal}}', network], { timeout: 10_000 });
    if (stdout.trim() !== 'true') throw new Error('Container ' + project.container + ' is attached to non-internal network ' + network + '; its traffic would bypass the relay');
    internalNetworks.set(key, Date.now());
  }
}

export function containerPath(relative: string): string { return CONTAINER_ROOT + '/' + relative; }

/** Starts a detached command inside the container and returns once Docker accepted it. */
export async function execDetached(dockerPath: string, container: string, env: Record<string, string>, script: string): Promise<void> {
  const args = ['exec', '-d', '--workdir', CONTAINER_ROOT];
  for (const [key, value] of Object.entries(env)) args.push('--env', key + '=' + value);
  await run(dockerPath, [...args, container, 'bash', '-c', script], { timeout: 30_000 });
}

export async function execText(dockerPath: string, container: string, argv: string[], timeout = 15_000): Promise<string> {
  const { stdout } = await run(dockerPath, ['exec', container, ...argv], { timeout, maxBuffer: 1_000_000 });
  return stdout;
}

/** True when `pid` in the container is still the worker for this Task. */
export async function workerAlive(dockerPath: string, container: string, pid: number, taskId: string): Promise<boolean> {
  const check = 'tr "\\0" "\\n" < /proc/' + pid + '/environ 2>/dev/null | grep -qx ' + quote('CODERFLEET_TASK_ID=' + taskId);
  try { await run(dockerPath, ['exec', container, 'bash', '-c', check], { timeout: 10_000 }); return true; }
  catch (error) {
    // Exit status 1 is a definite "not running"; anything else (Docker down) is unknown.
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
}

export async function signalGroup(dockerPath: string, container: string, pgid: number, signal: 'TERM' | 'KILL'): Promise<void> {
  if (!Number.isInteger(pgid) || pgid <= 1) throw new Error('Invalid worker process group');
  await run(dockerPath, ['exec', container, 'kill', '-' + signal, '--', '-' + pgid], { timeout: 10_000 }).catch(() => undefined);
}

export async function models(dockerPath: string, project: WorkspaceProject): Promise<readonly { id: string; label: string }[]> {
  await assertContainer(dockerPath, project);
  const stdout = await execText(dockerPath, project.container, ['agy', 'models'], 25_000);
  return stdout.trim().split('\n').flatMap(line => {
    const [id, label] = line.trim().split('\t');
    return id && label ? [{ id, label }] : [];
  });
}

/** The models Codex offers this account in its picker (`codex debug models`, visibility `list`), in its own order. */
export async function codexModels(dockerPath: string, project: WorkspaceProject): Promise<readonly { id: string; label: string; title?: string }[]> {
  await assertContainer(dockerPath, project);
  // The catalog carries each model's full instructions: far more than the default buffer.
  const { stdout } = await run(dockerPath, ['exec', project.container, 'codex', 'debug', 'models'], { timeout: 25_000, maxBuffer: 20_000_000 });
  const catalog = (JSON.parse(stdout) as { models?: unknown }).models;
  const rows = (Array.isArray(catalog) ? catalog : []) as Record<string, unknown>[];
  return rows.filter(row => row.visibility === 'list' && typeof row.slug === 'string' && row.slug)
    .sort((left, right) => Number(left.priority ?? 0) - Number(right.priority ?? 0))
    .map(row => ({
      id: row.slug as string, label: typeof row.display_name === 'string' && row.display_name ? row.display_name : row.slug as string,
      ...(typeof row.description === 'string' && row.description ? { title: row.description } : {}),
    }));
}

