// Control mailbox shared by the host service and the in-container worker.
// The on-disk format matches coderfleet/data/scripts/coderfleet_sdk_control.py,
// so either service can read a Task's channel. This file may import only Node
// built-ins: the host copies it next to the worker inside the project.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_PAYLOAD_BYTES = 64 * 1024;
export const MAX_COMMANDS = 256;
export type CommandKind = 'ping' | 'answer' | 'interrupt' | 'message' | 'approval' | 'control' | 'session';
export type ChannelStatus = 'starting' | 'accepting' | 'closing' | 'closed';
type Json = Record<string, unknown>;
export interface Command { id: string; task_id: string; token: string; kind: CommandKind; payload: Json; order: number; expires_at: number }
export interface Reply { id: string; task_id: string; generation: string; status: 'accepted' | 'rejected'; result: Json; error: string }

const KINDS = new Set<CommandKind>(['ping', 'answer', 'interrupt', 'message', 'approval', 'control', 'session']);
const IDENTITY = /^[A-Za-z0-9_-]{1,128}$/;

export class ControlError extends Error {}

function code(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
}

function now(): number { return Date.now() / 1000; }

// time.monotonic_ns() in Python: only ordering inside one channel matters.
function order(): number { return Number(process.hrtime.bigint()); }

export class ControlMailbox {
  public readonly generation: string;
  private readonly requests: string;
  private readonly replies: string;
  private readonly started: string;

  public constructor(private readonly directory: string, private readonly taskId: string, private readonly token: string) {
    if (!IDENTITY.test(taskId)) throw new ControlError('Invalid Task identity');
    if (!/^[0-9a-f]{64}$/.test(token)) throw new ControlError('Invalid control capability');
    this.generation = createHash('sha256').update(token).digest('hex');
    this.requests = join(directory, 'requests');
    this.replies = join(directory, 'replies');
    this.started = join(directory, 'started');
  }

  private static read(path: string): Json {
    let raw: string;
    try { raw = readFileSync(path, 'utf8'); }
    catch (error) {
      if (code(error) === 'ENOENT') return {};
      throw new ControlError('Cannot read control record');
    }
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { throw new ControlError('Cannot read control record'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ControlError('Invalid control record');
    return value as Json;
  }

  private static write(path: string, value: Json, exclusive = false): void {
    const temporary = path + '.' + randomUUID().replaceAll('-', '') + '.tmp';
    try {
      writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
      chmodSync(temporary, 0o644);
      if (exclusive) linkSync(temporary, path);
      else renameSync(temporary, path);
    } finally {
      try { unlinkSync(temporary); } catch (error) { if (code(error) !== 'ENOENT') throw error; }
    }
  }

  private static identifier(id: string): string {
    if (!IDENTITY.test(id)) throw new ControlError('Invalid command identity');
    return id;
  }

  public publish(status: ChannelStatus): void {
    for (const path of [this.directory, this.requests, this.replies, this.started]) {
      mkdirSync(path, { recursive: true });
      chmodSync(path, 0o777);
    }
    ControlMailbox.write(join(this.directory, 'state.json'), {
      task_id: this.taskId, generation: this.generation, status, updated_at: now(),
    });
  }

  public state(): Json {
    const value = ControlMailbox.read(join(this.directory, 'state.json'));
    if (Object.keys(value).length && (value.task_id !== this.taskId || value.generation !== this.generation)) {
      throw new ControlError('Control channel belongs to another Task run');
    }
    return value;
  }

  public submit(commandId: string, kind: CommandKind, payload: Json, timeout = 10): string {
    const id = ControlMailbox.identifier(commandId);
    if (!KINDS.has(kind)) throw new ControlError('Unsupported worker command');
    if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) throw new ControlError('Control payload is too large');
    const path = join(this.requests, id + '.json');
    const existing = ControlMailbox.read(path);
    if (Object.keys(existing).length) {
      if (existing.kind !== kind || JSON.stringify(existing.payload) !== JSON.stringify(payload)
          || existing.task_id !== this.taskId || existing.token !== this.token) {
        throw new ControlError('Command identity was already used for different input');
      }
      return id;
    }
    if (this.state().status !== 'accepting') throw new ControlError('Task is not accepting control commands');
    if (readdirSync(this.requests).filter(name => name.endsWith('.json')).length >= MAX_COMMANDS) {
      throw new ControlError('Task control command limit reached');
    }
    const record: Command = { id, task_id: this.taskId, token: this.token, kind, payload, order: order(), expires_at: now() + timeout };
    try { ControlMailbox.write(path, record as unknown as Json, true); }
    catch (error) {
      if (code(error) === 'EEXIST') return this.submit(id, kind, payload, timeout);
      throw error;
    }
    return id;
  }

  public pending(): Command[] {
    const records: Command[] = [];
    let names: string[];
    try { names = readdirSync(this.requests); }
    catch (error) { if (code(error) === 'ENOENT') return []; throw error; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = ControlMailbox.identifier(name.slice(0, -5));
      if (existsSync(join(this.replies, name)) || existsSync(join(this.started, name))) continue;
      const value = ControlMailbox.read(join(this.requests, name));
      const token = value.token;
      if (value.task_id !== this.taskId || typeof token !== 'string' || token.length !== this.token.length
          || !timingSafeEqual(Buffer.from(token), Buffer.from(this.token))) {
        this.acknowledge(id, undefined, 'Control capability does not match this Task');
        continue;
      }
      if (value.id !== id || !Number.isInteger(value.order)) {
        this.acknowledge(id, undefined, 'Invalid command record');
        continue;
      }
      if (typeof value.expires_at !== 'number' || value.expires_at < now()) {
        this.acknowledge(id, undefined, 'Control command expired before delivery');
        continue;
      }
      records.push(value as unknown as Command);
    }
    return records.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  }

  // Persist delivery start before any agent effect; a claimed input is never replayed.
  public claim(commandId: string): void {
    const id = ControlMailbox.identifier(commandId);
    ControlMailbox.write(join(this.started, id + '.json'), { id }, true);
  }

  public acknowledge(commandId: string, result?: Json, error = ''): void {
    const id = ControlMailbox.identifier(commandId);
    ControlMailbox.write(join(this.replies, id + '.json'), {
      id, task_id: this.taskId, generation: this.generation,
      status: error ? 'rejected' : 'accepted', result: result ?? {}, error,
    });
  }

  public reply(commandId: string): Reply | undefined {
    const value = ControlMailbox.read(join(this.replies, ControlMailbox.identifier(commandId) + '.json'));
    if (!Object.keys(value).length) return undefined;
    if (value.task_id !== this.taskId || value.generation !== this.generation || value.id !== commandId) {
      throw new ControlError('Reply does not belong to this Task command');
    }
    return value as unknown as Reply;
  }

  public close(): void {
    this.publish('closing');
    for (const command of this.pending()) this.acknowledge(command.id, undefined, 'Task finished before accepting this command');
    this.publish('closed');
  }
}
