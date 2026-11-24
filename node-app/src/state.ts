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

/** Where a forked Claude conversation branched off (Python ConversationFork). */
export interface ConversationFork {
  readonly source_conversation_id: string;
  readonly source_task_id: string;
  readonly source_session_id: string;
  /** The last assistant message of the source turn; the fork resumes there. */
  readonly message_uuid: string;
  /** Chosen up front so a fork interrupted before its first reply is resumed, not forked twice. */
  readonly target_session_id: string;
  /** Source turns shown read-only above the fork's own turns. */
  readonly inherited_task_ids: readonly string[];
  readonly model: string;
}

export interface Conversation {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
  /** The agent session that later turns resume (Python: native_session_id). */
  readonly nativeSessionId?: string;
  readonly account?: string;
  readonly type?: string;
  readonly project?: string;
  readonly fork?: ConversationFork;
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
  /** Full input and output, served on demand (GET /v1/turns/:id/tools/:toolId), capped in size. */
  readonly input?: unknown;
  readonly output?: string;
  /** The Agent (Task) call this step ran inside: a sub-agent's own tool calls. */
  readonly parent?: string;
}

/** `user`: a message sent while the turn was running (Claude takes it into the same run). */
export type Block = { kind: 'text'; text: string } | { kind: 'tool'; id: string } | { kind: 'user'; text: string; images?: string[] };

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
/** `queued`: a Python task waiting in the Python scheduler; this service does not run it. */
export type Status = 'queued' | 'starting' | 'running' | 'done' | 'failed' | 'cancelled';
export interface Turn {
  readonly id: string;
  /** `node`: launched by this service; `python`: a Python task, shown read-only. */
  origin?: 'node' | 'python';
  readonly account?: string;
  readonly type?: string;
  readonly conversationId: string;
  readonly projectId: string;
  readonly prompt: string;
  /** Project uploads sent with the prompt, as container paths (/workspace/.coderfleet-uploads/…). */
  readonly images?: readonly string[];
  /** Tools run without asking (Python `auto`: bypass permissions / --yolo / always approve). */
  readonly auto?: boolean;
  /** The first turn of a fork: resume `resumeId` at this message under this new session ID. */
  readonly forkAt?: { readonly sessionId: string; readonly messageId: string };
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
  /** What the running worker's control channel accepts (`message`: mid-turn messages). */
  capabilities?: string[];
  /**
   * Rebuilt from the log, never saved: messages sent mid-turn wait here until the agent's
   * next message starts (when the model reads them), and whether the next text starts a block.
   */
  heldMessages?: Block[];
  messageStarted?: boolean;
  /** Bytes of the worker's event log already applied to this record. */
  logOffset?: number;
  launchedAt?: string;
  cancelRequested?: boolean;
}

export function active(turn: Turn): boolean {
  return turn.status === 'starting' || turn.status === 'running';
}

/** Hosts an App-managed local backend may listen on: loopback, or every interface for phones on the LAN. */
export const LOCAL_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '0.0.0.0'];

/** How this computer reaches a local backend: over loopback even when it listens on every interface. */
export function localUrl(config: { host: string; port: number }): string {
  return 'http://' + (config.host === '0.0.0.0' ? '127.0.0.1' : config.host) + ':' + config.port;
}
