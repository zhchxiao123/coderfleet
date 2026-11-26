// The CoderFleet workspace: config.conf, accounts.conf, projects.conf and the
// per-account directories. Same formats as coderfleet/config.py and the
// Python account/project commands. Every mutation is one synchronous
// read-modify-write of a single file.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { ACCOUNT_TYPES, accountType } from './accounts.js';

export type ConfRecord = Record<string, string>;

export function parseConf(path: string): ConfRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').map(parseLine).filter(record => Object.keys(record).length);
}

export function truthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

/** Host directory bind-mounted for the container user (compose.py: ensure_bind_mount_dir). */
export function ensureBindMountDir(path: string): void {
  mkdirSync(path, { recursive: true });
  chmodSync(path, 0o777);
}

function writeText(path: string, content: string, mode = 0o644): void {
  const temporary = path + '.' + process.pid + '.' + Date.now() + '.tmp';
  writeFileSync(temporary, content, { encoding: 'utf8', mode });
  renameSync(temporary, path);
}

function confLine(tokens: ConfRecord): string {
  return Object.entries(tokens).map(([key, value]) => key + '=' + value).join('  ');
}

function parseLine(line: string): ConfRecord {
  const trimmed = line.trim().replace(/\r$/, '');
  const record: ConfRecord = {};
  if (!trimmed || trimmed.startsWith('#')) return record;
  for (const token of trimmed.split(/\s+/)) {
    const index = token.indexOf('=');
    if (index > 0) record[token.slice(0, index).toUpperCase()] = token.slice(index + 1);
  }
  return record;
}

/** Rewrites matching lines of a conf file in one read-modify-write; `null` removes the line. */
function rewriteConf(path: string, key: string, value: string, change: (record: ConfRecord) => ConfRecord | null): boolean {
  if (!existsSync(path)) return false;
  let found = false;
  const lines = readFileSync(path, 'utf8').split('\n').flatMap(line => {
    const record = parseLine(line);
    if (record[key] !== value) return [line];
    found = true;
    const next = change(record);
    return next ? [confLine(next)] : [];
  });
  if (found) writeText(path, lines.join('\n'));
  return found;
}

function appendConf(path: string, tokens: ConfRecord): void {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const separator = existing && !existing.endsWith('\n') ? '\n' : '';
  writeText(path, existing + separator + confLine(tokens) + '\n');
}

export function loadConfig(workspace: string): ConfRecord {
  const result: ConfRecord = {};
  for (const record of parseConf(join(workspace, 'config.conf'))) Object.assign(result, record);
  return result;
}

export interface Account {
  readonly name: string;
  readonly type: string;
  readonly auth: 'login' | 'env';
  readonly envFile: string;
  readonly proxy: 'relay' | 'off';
  readonly runtime: 'container' | 'local';
  readonly record: ConfRecord;
}

export interface WorkspaceProject {
  readonly name: string;
  readonly account: Account;
  /** Host directory mounted at /workspace in the project's container. */
  readonly path: string;
  readonly active: boolean;
  /** Persistent container created from docker-compose.yml (compose.py: `<type>-<project>`). */
  readonly container: string;
  readonly service: string;
  readonly record: ConfRecord;
}

export const NAME = /^[A-Za-z0-9-]+$/;

function toAccount(workspace: string, record: ConfRecord): Account {
  const name = record.NAME ?? '';
  const auth = record.AUTH === 'env' ? 'env' : 'login';
  return {
    name, type: record.TYPE || 'codex', auth,
    envFile: auth === 'env' ? resolve(workspace, record.ENV_FILE || './accounts/' + name + '/env') : '',
    proxy: record.PROXY === 'off' ? 'off' : 'relay',
    runtime: record.RUNTIME === 'local' ? 'local' : 'container',
    record,
  };
}

export function readWorkspace(workspace: string): { accounts: Account[]; projects: WorkspaceProject[] } {
  const accounts = parseConf(join(workspace, 'accounts.conf')).filter(record => record.NAME).map(record => toAccount(workspace, record));
  const byName = new Map(accounts.map(account => [account.name, account]));
  const projects = parseConf(join(workspace, 'projects.conf')).flatMap((record): WorkspaceProject[] => {
    const name = record.NAME ?? '';
    const account = byName.get(record.ACCOUNT ?? '');
    if (!name || !account || !record.PATH) return [];
    const path = expandHome(record.PATH);
    return [{
      name, account, path: isAbsolute(path) ? path : resolve(workspace, path), active: truthy(record.ACTIVE ?? 'on'),
      container: account.type + '-' + name, service: account.type + '-project-' + name, record,
    }];
  });
  return { accounts, projects };
}

export class WorkspaceError extends Error {}

export interface NewAccount { name: string; type: string; auth: 'login' | 'env'; proxy: 'relay' | 'off' }

export function addAccount(workspace: string, input: NewAccount): Account {
  if (!NAME.test(input.name)) throw new WorkspaceError('账号名只能包含字母、数字和连字符');
  if (!ACCOUNT_TYPES[input.type]) throw new WorkspaceError('不支持的账号类型');
  if (input.auth === 'env' && !accountType(input.type).envAuth) throw new WorkspaceError(accountType(input.type).label + ' 不支持环境变量认证');
  const path = join(workspace, 'accounts.conf');
  if (parseConf(path).some(record => record.NAME === input.name)) throw new WorkspaceError('账号 ' + input.name + ' 已存在');
  const tokens: ConfRecord = { NAME: input.name, TYPE: input.type, AUTH: input.auth };
  if (input.auth === 'env') tokens.ENV_FILE = './accounts/' + input.name + '/env';
  tokens.PROXY = input.proxy;
  tokens.RUNTIME = 'container';
  tokens.SANDBOX_CONFIRMED = 'false';
  tokens.CLAUDE_BACKEND = input.type === 'claude' ? 'sdk' : 'cli';
  mkdirSync(workspace, { recursive: true });
  appendConf(path, tokens);
  ensureBindMountDir(join(workspace, 'accounts', input.name));
  return toAccount(workspace, tokens);
}

export function removeAccount(workspace: string, name: string): void {
  const used = parseConf(join(workspace, 'projects.conf')).filter(record => record.ACCOUNT === name).map(record => record.NAME);
  if (used.length) throw new WorkspaceError('账号仍被项目使用：' + used.join('、') + '。请先删除这些项目。');
  if (!rewriteConf(join(workspace, 'accounts.conf'), 'NAME', name, () => null)) throw new WorkspaceError('账号不存在');
}

/** Environment variable names in an env-auth account's file. Values are never returned. */
export function envKeys(account: Account): string[] {
  if (account.auth !== 'env' || !existsSync(account.envFile)) return [];
  return readFileSync(account.envFile, 'utf8').split('\n').flatMap(line => {
    const trimmed = line.trim();
    const index = trimmed.indexOf('=');
    return trimmed && !trimmed.startsWith('#') && index > 0 ? [trimmed.slice(0, index).trim()] : [];
  });
}

/** Sets or removes variables in the env file. An empty value removes the variable. */
export function updateEnv(account: Account, values: Record<string, string>): void {
  if (account.auth !== 'env') throw new WorkspaceError('该账号使用登录认证');
  for (const key of Object.keys(values)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new WorkspaceError('无效的变量名 ' + key);
  for (const value of Object.values(values)) if (/[\r\n]/.test(value)) throw new WorkspaceError('变量值不能包含换行');
  mkdirSync(resolve(account.envFile, '..'), { recursive: true });
  const lines = existsSync(account.envFile) ? readFileSync(account.envFile, 'utf8').split('\n').filter(Boolean) : [];
  const remaining = { ...values };
  const next = lines.flatMap(line => {
    const index = line.indexOf('=');
    const key = index > 0 ? line.slice(0, index).trim() : '';
    if (!key || !(key in remaining)) return [line];
    const value = remaining[key] as string;
    delete remaining[key];
    return value ? [key + '=' + value] : [];
  });
  for (const [key, value] of Object.entries(remaining)) if (value) next.push(key + '=' + value);
  writeText(account.envFile, next.join('\n') + (next.length ? '\n' : ''), 0o600);
  chmodSync(account.envFile, 0o600);
}

/**
 * Project environment variables: projects/<name>/env (KEY=value lines), which the
 * compose file puts into the project's container, over the account's (compose.py).
 */
export function projectEnvPath(workspace: string, name: string): string {
  if (!/^[\w.-]+$/.test(name)) throw new WorkspaceError('无效的项目名');
  return join(workspace, 'projects', name, 'env');
}

export function readProjectEnv(workspace: string, name: string): Record<string, string> {
  const path = projectEnvPath(workspace, name);
  if (!existsSync(path)) return {};
  const result: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    const index = line.indexOf('=');
    if (!line || line.startsWith('#') || index < 0) continue;
    result[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return result;
}

/** Replaces the project's variables with `values` (owner-only file, like the Python service). */
export function writeProjectEnv(workspace: string, name: string, values: Record<string, string>): void {
  for (const key of Object.keys(values)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new WorkspaceError('无效的变量名 ' + key);
  for (const value of Object.values(values)) if (/[\r\n]/.test(value)) throw new WorkspaceError('变量值不能包含换行');
  const path = projectEnvPath(workspace, name);
  mkdirSync(join(path, '..'), { recursive: true });
  const lines = Object.entries(values).filter(([, value]) => value !== '').map(([key, value]) => key + '=' + value.trim());
  writeText(path, lines.join('\n') + (lines.length ? '\n' : ''), 0o600);
  chmodSync(path, 0o600);
}

export interface NewProject { name: string; account: string; path: string }

export function addProject(workspace: string, input: NewProject): void {
  if (!NAME.test(input.name)) throw new WorkspaceError('项目名只能包含字母、数字和连字符');
  const accounts = readWorkspace(workspace).accounts;
  const account = accounts.find(item => item.name === input.account);
  if (!account) throw new WorkspaceError('账号不存在');
  if (account.runtime !== 'container') throw new WorkspaceError('桌面版只管理容器账号');
  const path = expandHome(input.path.trim());
  if (!isAbsolute(path)) throw new WorkspaceError('项目目录必须是绝对路径');
  if (!existsSync(path)) throw new WorkspaceError('项目目录不存在：' + path);
  const conf = join(workspace, 'projects.conf');
  if (parseConf(conf).some(record => record.NAME === input.name)) throw new WorkspaceError('项目 ' + input.name + ' 已存在');
  appendConf(conf, { NAME: input.name, ACCOUNT: input.account, PATH: path });
}

export function removeProject(workspace: string, name: string): void {
  if (!rewriteConf(join(workspace, 'projects.conf'), 'NAME', name, () => null)) throw new WorkspaceError('项目不存在');
}

export function setProjectActive(workspace: string, name: string, active: boolean): void {
  const found = rewriteConf(join(workspace, 'projects.conf'), 'NAME', name, record => ({ ...record, ACTIVE: active ? 'on' : 'off' }));
  if (!found) throw new WorkspaceError('项目不存在');
}

/** A project's extra mounts as written in projects.conf: `HOST:CONTAINER[:ro]` each. */
export function projectMountSpecs(project: WorkspaceProject): string[] {
  return (project.record.EXTRA_MOUNTS ?? '').split(',').map(item => item.trim()).filter(Boolean);
}

/** Replaces the project's EXTRA_MOUNTS; the caller has checked the specs (compose.ts: projectMounts). */
export function setProjectMounts(workspace: string, name: string, specs: readonly string[]): void {
  // projects.conf separates tokens by blanks and mounts by commas, so neither fits inside a path.
  for (const spec of specs) if (/[\s,]/.test(spec)) throw new WorkspaceError('挂载路径不能包含空格或逗号：' + spec);
  const found = rewriteConf(join(workspace, 'projects.conf'), 'NAME', name, record => {
    const { EXTRA_MOUNTS: _previous, ...rest } = record;
    return specs.length ? { ...rest, EXTRA_MOUNTS: specs.join(',') } : rest;
  });
  if (!found) throw new WorkspaceError('项目不存在');
}

export type HelperAccess = 'off' | 'command' | 'gui';

/** What the project's tasks may do on this machine through the helper (HELPER_ACCESS in projects.conf). */
export function projectHelperAccess(project: WorkspaceProject): HelperAccess {
  const value = (project.record.HELPER_ACCESS ?? '').toLowerCase();
  return value === 'command' || value === 'gui' ? value : 'off';
}

export function setProjectHelper(workspace: string, name: string, access: string): void {
  if (access !== 'off' && access !== 'command' && access !== 'gui') throw new WorkspaceError('机器操作只能是 off、command 或 gui');
  const found = rewriteConf(join(workspace, 'projects.conf'), 'NAME', name, record => {
    const { HELPER_ACCESS: _previous, ...rest } = record;
    return access === 'off' ? rest : { ...rest, HELPER_ACCESS: access };
  });
  if (!found) throw new WorkspaceError('项目不存在');
}

/** Settings shown in the desktop client, with config.conf defaults (compose.py / init_wizard.py). */
export const SETTINGS: Readonly<Record<string, string>> = {
  PROXY_HOST: 'host.docker.internal', PROXY_HTTP_PORT: '7890', CONTAINER_TIMEZONE: 'Asia/Shanghai',
  BUILD_PLATFORM: 'linux/amd64', IMAGE_NAME: 'coderfleet', IMAGE_TAG: 'latest',
  // The system LLM for translation (settings_schema.py), never a pooled account.
  SYSTEM_LLM_PROVIDER: 'anthropic', SYSTEM_LLM_API_KEY: '', SYSTEM_LLM_MODEL: '', SYSTEM_LLM_BASE_URL: '', SYSTEM_LLM_PROXY: '',
};
/** Settings whose value is never sent back; the client sees this placeholder when one is set. */
export const SECRET_SETTINGS: ReadonlySet<string> = new Set(['SYSTEM_LLM_API_KEY']);
export const SECRET_PLACEHOLDER = '••••••••';

export function readSettings(workspace: string): Record<string, string> {
  const config = loadConfig(workspace);
  return Object.fromEntries(Object.entries(SETTINGS).map(([key, fallback]) => [key,
    SECRET_SETTINGS.has(key) ? (config[key] ? SECRET_PLACEHOLDER : '') : config[key] || fallback]));
}

/** Updates config.conf in place, keeping comments and other keys. */
export function writeSettings(workspace: string, values: Record<string, string>): void {
  // An unchanged secret comes back as its placeholder: keep the stored value.
  values = Object.fromEntries(Object.entries(values).filter(([key, value]) => !(SECRET_SETTINGS.has(key) && value === SECRET_PLACEHOLDER)));
  for (const [key, value] of Object.entries(values)) {
    if (!(key in SETTINGS)) throw new WorkspaceError('不支持的设置 ' + key);
    if (!/^[^\s#]*$/.test(value)) throw new WorkspaceError(key + ' 不能包含空白或 #');
  }
  const path = join(workspace, 'config.conf');
  const remaining = { ...values };
  const lines = (existsSync(path) ? readFileSync(path, 'utf8') : '').split('\n').map(line => {
    const match = /^\s*([A-Z_][A-Z0-9_]*)=/.exec(line);
    const key = match?.[1];
    if (!key || !(key in remaining)) return line;
    const value = remaining[key] as string;
    delete remaining[key];
    return key + '=' + value;
  });
  while (lines.length && lines.at(-1) === '') lines.pop();
  for (const [key, value] of Object.entries(remaining)) lines.push(key + '=' + value);
  writeText(path, lines.join('\n') + '\n');
}

/**
 * Creates a workspace like `coderfleet init`: directories, empty account and
 * project lists, config.conf, and the image build files bundled with the App.
 * Existing files are kept.
 */
export function initWorkspace(workspace: string, template: string): string[] {
  const created: string[] = [];
  for (const directory of ['accounts', 'tasks', 'conversations', 'scripts']) mkdirSync(join(workspace, directory), { recursive: true });
  const copy = (from: string, to: string, mode = 0o644): void => {
    if (existsSync(to)) return;
    writeFileSync(to, readFileSync(from), { mode });
    created.push(to);
  };
  copy(join(template, 'Dockerfile'), join(workspace, 'Dockerfile'));
  copy(join(template, 'entrypoint.sh'), join(workspace, 'entrypoint.sh'), 0o755);
  for (const name of ['install_claude_sdk.py', 'coderfleet_usage_status.py']) copy(join(template, 'scripts', name), join(workspace, 'scripts', name));
  for (const name of ['accounts.conf', 'projects.conf']) {
    const path = join(workspace, name);
    if (!existsSync(path)) { writeText(path, ''); created.push(path); }
  }
  if (!existsSync(join(workspace, 'config.conf'))) {
    writeSettings(workspace, { ...SETTINGS });
    created.push(join(workspace, 'config.conf'));
  }
  return created;
}
