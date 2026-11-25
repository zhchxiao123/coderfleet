// The helper's own directory (~/.coderfleet-helper): master secret, rules, audit log
// and the record of the running service. Nothing a task runs may point into it.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultPolicy } from './policy.ts';

export function helperHome(): string {
  return process.env.CODERFLEET_HELPER_HOME || join(homedir(), '.coderfleet-helper');
}

export function writeAtomic(path: string, content: string, mode = 0o600): void {
  const temporary = path + '.' + process.pid + '.' + randomBytes(4).toString('hex') + '.tmp';
  writeFileSync(temporary, content, { encoding: 'utf8', mode });
  renameSync(temporary, path);
}

/** Creates the directory, the master secret and the default rules; whatever exists is kept. */
export function ensureHome(home: string, platform: NodeJS.Platform = process.platform): void {
  mkdirSync(join(home, 'audit'), { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const secret = join(home, 'secret');
  if (!existsSync(secret)) {
    try { writeFileSync(secret, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const policy = join(home, 'policy.json');
  if (!existsSync(policy)) writeAtomic(policy, JSON.stringify(defaultPolicy(platform), null, 2) + '\n');
}

export function readSecret(home: string): Buffer {
  const text = readFileSync(join(home, 'secret'), 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error('The master secret in ' + join(home, 'secret') + ' is not valid');
  return Buffer.from(text, 'hex');
}

/** What `serve` records about itself, for `status` and for whoever starts it. */
export interface RunRecord { readonly pid: number; readonly host: string; readonly port: number; readonly version: string; readonly protocol: number }

export function readRun(home: string): RunRecord | undefined {
  try { return JSON.parse(readFileSync(join(home, 'run.json'), 'utf8')) as RunRecord; }
  catch { return undefined; }
}
