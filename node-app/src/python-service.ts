// Detects the original Python service (`coderfleet server`) running on the same
// workspace. Both services read and write tasks/ and conversations/, and the
// Python one reattaches to every task marked running when it starts, including
// turns this backend launched, so the App warns when both are up.
import { readFileSync, realpathSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { loadConfig } from './conf.js';
import { record, text } from './state.js';

export interface PythonService {
  /** Where it answers, or undefined when only its pid file shows it. */
  readonly url?: string;
  readonly pid?: number;
}

const real = (path: string): string => { try { return realpathSync(path); } catch { return path; } };

function health(port: number): Promise<{ workspace: string } | undefined> {
  return new Promise(resolve => {
    const call = request({ host: '127.0.0.1', port, path: '/api/health', timeout: 800, agent: false }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try {
          const value = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          resolve(value.status === 'ok' && text(value.workspace) ? { workspace: text(value.workspace) } : undefined);
        } catch { resolve(undefined); }
      });
    });
    call.on('timeout', () => call.destroy());
    call.on('error', () => resolve(undefined));
    call.end();
  });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** The Python service on this workspace, if one is running. */
export async function findPythonService(workspace: string): Promise<PythonService | undefined> {
  let port = 8765;
  try { port = Number(loadConfig(workspace).CODERFLEET_PORT) || 8765; } catch { /* no config yet */ }
  const answer = await health(port);
  let pid: number | undefined;
  try {
    const value = Number(readFileSync(join(workspace, 'server.pid'), 'utf8').trim());
    if (Number.isInteger(value) && value > 0 && alive(value)) pid = value;
  } catch { /* no daemon pid file */ }
  const same = answer !== undefined && real(answer.workspace) === real(workspace);
  if (!same && pid === undefined) return undefined;
  return { url: same ? 'http://127.0.0.1:' + port : undefined, pid };
}
