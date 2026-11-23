// Reads the authoritative CoderFleet workspace configuration (accounts.conf,
// projects.conf). Same tokenizer as coderfleet/config.py:parse_conf.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type ConfRecord = Record<string, string>;

export function parseConf(path: string): ConfRecord[] {
  if (!existsSync(path)) return [];
  const records: ConfRecord[] = [];
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim().replace(/\r$/, '');
    if (!line || line.startsWith('#')) continue;
    const record: ConfRecord = {};
    for (const token of line.split(/\s+/)) {
      const index = token.indexOf('=');
      if (index > 0) record[token.slice(0, index).toUpperCase()] = token.slice(index + 1);
    }
    if (Object.keys(record).length) records.push(record);
  }
  return records;
}

export interface Account {
  readonly name: string;
  readonly type: string;
  readonly auth: 'login' | 'env';
  readonly proxy: 'relay' | 'off';
  readonly runtime: 'container' | 'local';
}

export interface WorkspaceProject {
  readonly name: string;
  readonly account: Account;
  /** Host directory mounted at /workspace in the project's container. */
  readonly path: string;
  /** Persistent container created by `coderfleet apply` (compose.py: `<type>-<project>`). */
  readonly container: string;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

function expand(path: string, workspace: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return resolve(workspace, path);
}

export function readWorkspace(workspace: string): { accounts: Account[]; projects: WorkspaceProject[] } {
  const accounts = parseConf(join(workspace, 'accounts.conf')).flatMap((record): Account[] => {
    const name = record.NAME ?? '';
    if (!NAME.test(name)) return [];
    return [{
      name, type: record.TYPE || 'codex',
      auth: record.AUTH === 'env' ? 'env' : 'login',
      proxy: record.PROXY === 'off' ? 'off' : 'relay',
      runtime: record.RUNTIME === 'local' ? 'local' : 'container',
    }];
  });
  const byName = new Map(accounts.map(account => [account.name, account]));
  const projects = parseConf(join(workspace, 'projects.conf')).flatMap((record): WorkspaceProject[] => {
    const name = record.NAME ?? '';
    const account = byName.get(record.ACCOUNT ?? '');
    if (!NAME.test(name) || !account || !record.PATH) return [];
    return [{ name, account, path: expand(record.PATH, workspace), container: account.type + '-' + name }];
  });
  return { accounts, projects };
}
