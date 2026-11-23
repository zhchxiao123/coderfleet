import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type RecordValue = Record<string, unknown>;
export function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}
export function entries(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.map(record) : [];
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
export function identifier(value: unknown): string {
  const name = text(value);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(name)) throw new Error('Invalid identifier');
  return name;
}
export function atomicJSON(path: string, value: unknown, exclusive = false): void {
  const temporary = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    if (exclusive) linkSync(temporary, path);
    else renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); }
    catch (error) { if (record(error).code !== 'ENOENT') throw error; }
  }
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly dockerPath: string;
  readonly containerUser: string;
  readonly workspace: string;
  readonly accountDirectory: string;
  readonly network: string;
  readonly dns: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

export interface Config {
  readonly stateDirectory: string;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly dockerPath: string;
  readonly projects: readonly Project[];
}

export function readConfig(path: string): Config {
  const raw = record(JSON.parse(readFileSync(path, 'utf8')));
  const base = resolve(path, '..');
  const token = process.env.CODERFLEET_NODE_TOKEN || text(raw.token);
  if (token.length < 24) throw new Error('Configure an API token of at least 24 characters');
  const port = Number(raw.port ?? 8877);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  if (!Array.isArray(raw.projects) || raw.projects.length === 0) throw new Error('Configure at least one project');
  const dockerPath = text(raw.dockerPath) || 'docker';
  const projects = entries(raw.projects).map((project): Project => {
    const id = identifier(project.id);
    const image = text(project.image);
    const workspace = text(project.workspace);
    const accountDirectory = text(project.accountDirectory);
    const network = text(project.network);
    const dns = Array.isArray(project.dns) ? project.dns.map(text).filter(Boolean) : [];
    if (!image || image.startsWith('-') || !workspace || !accountDirectory || !network) throw new Error('Missing image, network or project directories for ' + id);
    const environment = Object.fromEntries(Object.entries(record(project.environment)).map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string') throw new Error('Invalid container environment variable');
      return [key, value];
    }));
    return {
      id, name: text(project.name) || id, image, workspace: resolve(base, workspace),
      dockerPath,
      containerUser: text(project.containerUser) || (process.platform === 'linux' && process.getuid?.() ? process.getuid() + ':' + process.getgid?.() : ''),
      accountDirectory: resolve(base, accountDirectory), network, dns, environment,
    };
  });
  if (new Set(projects.map(project => project.id)).size !== projects.length) throw new Error('Duplicate project ID');
  return {
    host: text(raw.host) || '127.0.0.1', port, token, projects, dockerPath,
    stateDirectory: resolve(base, text(raw.stateDirectory) || '.coderfleet-node'),
  };
}

export interface Conversation {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface Tool {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

export interface Permission {
  readonly id: string;
  readonly title: string;
  readonly details: string;
  readonly allow: boolean;
}

export type Decision = 'allow' | 'deny';
export type Status = 'starting' | 'running' | 'done' | 'failed' | 'cancelled' | 'blocked';
export interface Turn {
  readonly id: string;
  readonly conversationId: string;
  readonly projectId: string;
  readonly prompt: string;
  readonly requestedModel: string;
  readonly createdAt: string;
  readonly resumeId: string;
  status: Status;
  workerPid?: number;
  sessionId?: string;
  model?: string;
  answer: string;
  tools: Tool[];
  permission?: Permission;
  error?: string;
}

type Control = { readonly type: 'cancel' } | { readonly type: 'permission'; readonly decision: Decision };

export class Store {
  public constructor(private readonly root: string) {
    for (const directory of ['conversations', 'turns', 'control']) {
      mkdirSync(join(root, directory), { recursive: true, mode: 0o700 });
    }
  }

  public conversation(id: string): Conversation | undefined { return this.read('conversations', id); }
  public turn(id: string): Turn | undefined { return this.read('turns', id); }
  public saveConversation(value: Conversation): void { atomicJSON(this.file('conversations', value.id), value); }
  public saveTurn(value: Turn): void { atomicJSON(this.file('turns', value.id), value); }
  public conversations(): Conversation[] { return this.list('conversations'); }
  public turns(): Turn[] { return this.list('turns'); }

  public putControl(turnId: string, key: string, control: Control): void {
    const id = identifier(turnId) + '-' + identifier(key);
    try { atomicJSON(this.file('control', id), control, true); }
    catch (error) {
      if (record(error).code !== 'EEXIST') throw error;
      const existing = this.read<Control>('control', id);
      if (JSON.stringify(existing) !== JSON.stringify(control)) throw new Error('A different decision was already sent');
    }
  }

  public control(turnId: string, key: string): Control | undefined {
    return this.read('control', identifier(turnId) + '-' + identifier(key));
  }

  private file(directory: string, id: string): string {
    return join(this.root, directory, identifier(id) + '.json');
  }

  private read<T>(directory: string, id: string): T | undefined {
    try { return JSON.parse(readFileSync(this.file(directory, id), 'utf8')) as T; }
    catch (error) {
      if (record(error).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private list<T>(directory: string): T[] {
    return readdirSync(join(this.root, directory), { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => this.read<T>(directory, entry.name.slice(0, -5)))
      .filter((value): value is T => value !== undefined);
  }
}

export function active(turn: Turn): boolean {
  return turn.status === 'starting' || turn.status === 'running' || turn.status === 'blocked';
}
