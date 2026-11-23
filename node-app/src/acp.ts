import { createInterface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { record, type RecordValue, text } from './state.js';

type RequestId = string | number;
type Pending = { resolve: (value: RecordValue) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
export type AgentMessage = {
  readonly method: string;
  readonly params: RecordValue;
  readonly id?: RequestId;
};

export class Acp {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private failure?: Error;
  private listener?: (event: AgentMessage) => void;

  public constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      try { this.receive(line); }
      catch (error) { this.fail(error instanceof Error ? error : new Error('Invalid ACP message')); }
    });
    lines.on('close', () => this.fail(new Error('Antigravity closed the ACP stream')));
    child.once('error', error => this.fail(error));
    child.stdin.on('error', error => this.fail(error));
    child.stderr.resume();
  }

  public onMessage(listener: (event: AgentMessage) => void): void { this.listener = listener; }

  public request(method: string, params: RecordValue, timeout = 30_000): Promise<RecordValue> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(method + ' timed out'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { this.fail(error instanceof Error ? error : new Error('ACP send failed')); }
    });
  }

  public notify(method: string, params: RecordValue): void { this.send({ method, params }); }
  public reply(id: RequestId, result: RecordValue): void { this.send({ id, result }); }
  public unsupported(id: RequestId): void {
    this.send({ id, error: { code: -32601, message: 'Client method not supported' } });
  }

  private send(fields: RecordValue): void {
    if (this.failure) throw this.failure;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...fields }) + '\n');
  }

  private receive(line: string): void {
    const event = record(JSON.parse(line));
    if (event.jsonrpc !== '2.0') throw new Error('Invalid ACP JSON-RPC frame');
    const method = text(event.method);
    const id = typeof event.id === 'number' || typeof event.id === 'string' ? event.id : undefined;
    if (method) {
      this.listener?.({ method, params: record(event.params), id });
      return;
    }
    if (typeof id !== 'number') return;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (event.error) pending.reject(new Error(text(record(event.error).message) || 'Antigravity RPC error'));
    else pending.resolve(record(event.result));
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
