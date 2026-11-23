import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
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

export interface Config {
  readonly stateDirectory: string;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly dockerPath: string;
  /** CoderFleet workspace root holding accounts.conf and projects.conf. */
  readonly workspace: string;
}

export function readConfig(path: string): Config {
  const raw = record(JSON.parse(readFileSync(path, 'utf8')));
  const base = resolve(path, '..');
  const token = process.env.CODERFLEET_NODE_TOKEN || text(raw.token);
  if (token.length < 24) throw new Error('Configure an API token of at least 24 characters');
  const port = Number(raw.port ?? 8877);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const workspace = text(raw.workspace);
  if (!workspace) throw new Error('Configure the CoderFleet workspace directory');
  return {
    host: text(raw.host) || '127.0.0.1', port, token, dockerPath: text(raw.dockerPath) || 'docker',
    workspace: resolve(base, workspace.replace(/^~(?=$|\/)/, homedir())),
    stateDirectory: resolve(base, text(raw.stateDirectory) || '.coderfleet-node'),
  };
}

export interface Conversation {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly createdAt: string;
}

/**
 * running → waiting (approval pending) → running → completed | failed;
 * denied when the user rejected it; interrupted or unknown when the turn
 * ended before the tool reported a result.
 */
export type ToolStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'denied' | 'interrupted' | 'unknown';
export interface Tool {
  readonly id: string;
  readonly title: string;
  readonly status: ToolStatus;
  /** A short line from the tool input: command, path, pattern or query. */
  readonly detail?: string;
}

export type Block = { kind: 'text'; text: string } | { kind: 'tool'; id: string };

export interface QuestionOption { readonly label: string; readonly description: string }
export interface Question { readonly question: string; readonly header: string; readonly multiSelect: boolean; readonly options: readonly QuestionOption[] }

/** A pending tool approval, or a native question when `questions` is set. */
export interface Permission {
  readonly id: string;
  readonly title: string;
  readonly details: string;
  readonly allow: boolean;
  readonly questions?: readonly Question[];
  /** The tool call this approval belongs to, when the agent reports it. */
  readonly toolId?: string;
}

export type Decision = 'allow' | 'deny';
export type Status = 'starting' | 'running' | 'done' | 'failed' | 'cancelled';
export interface Turn {
  readonly id: string;
  readonly conversationId: string;
  readonly projectId: string;
  readonly prompt: string;
  readonly requestedModel: string;
  readonly createdAt: string;
  readonly resumeId: string;
  status: Status;
  sessionId?: string;
  model?: string;
  answer: string;
  tools: Tool[];
  /** Text and tool calls in the order they happened; `answer` keeps the full text. */
  blocks?: Block[];
  permission?: Permission;
  error?: string;
  interrupted?: boolean;
  finishedAt?: string;
  /** Capability for this run's control mailbox; never returned by the API. */
  controlToken?: string;
  controlReady?: boolean;
  /** Bytes of the worker's event log already applied to this record. */
  logOffset?: number;
  launchedAt?: string;
  cancelRequested?: boolean;
}

export class Store {
  private readonly conversationIndex = new Map<string, Conversation>();
  private readonly turnIndex = new Map<string, Turn>();

  // This service is the only writer of its state directory, so records are
  // read once at start-up and every save writes through.
  public constructor(private readonly root: string) {
    for (const directory of ['conversations', 'turns']) mkdirSync(join(root, directory), { recursive: true, mode: 0o700 });
    for (const value of this.load<Conversation>('conversations')) this.conversationIndex.set(value.id, value);
    for (const value of this.load<Turn>('turns')) this.turnIndex.set(value.id, value);
  }

  public conversation(id: string): Conversation | undefined { return this.conversationIndex.get(id); }
  public turn(id: string): Turn | undefined { return this.turnIndex.get(id); }
  public conversations(): Conversation[] { return [...this.conversationIndex.values()]; }
  public turns(): Turn[] { return [...this.turnIndex.values()]; }

  public saveConversation(value: Conversation): void {
    atomicJSON(this.file('conversations', value.id), value);
    this.conversationIndex.set(value.id, value);
  }

  public saveTurn(value: Turn): void {
    atomicJSON(this.file('turns', value.id), value);
    this.turnIndex.set(value.id, value);
  }

  private file(directory: string, id: string): string {
    return join(this.root, directory, identifier(id) + '.json');
  }

  private load<T>(directory: string): T[] {
    return readdirSync(join(this.root, directory), { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => JSON.parse(readFileSync(join(this.root, directory, entry.name), 'utf8')) as T);
  }
}

export function active(turn: Turn): boolean {
  return turn.status === 'starting' || turn.status === 'running';
}
