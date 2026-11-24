// Phones paired with this backend. Each gets its own token that only reaches
// the chat API (see DEVICE_ROUTES in server.ts) and can be revoked from the
// desktop App; the backend's main token never leaves the computer. Tokens are
// stored only as SHA-256 hashes, in the backend's own state directory.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJSON, entries, text } from './state.js';

export interface Device {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
  readonly lastAddress?: string;
}

interface Stored extends Device { readonly hash: string }

const PREFIX = 'cfd_';
const TOUCH_INTERVAL = 60_000;

const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

export class Devices {
  private readonly path: string;
  private cache: { mtime: number; items: Stored[] } | undefined;
  private readonly touched = new Map<string, number>();

  public constructor(stateDirectory: string) {
    mkdirSync(stateDirectory, { recursive: true });
    this.path = join(stateDirectory, 'devices.json');
  }

  private read(): Stored[] {
    try {
      return entries(JSON.parse(readFileSync(this.path, 'utf8'))).map(item => ({
        id: text(item.id), name: text(item.name), hash: text(item.hash), createdAt: text(item.createdAt),
        lastUsedAt: text(item.lastUsedAt) || undefined, lastAddress: text(item.lastAddress) || undefined,
      })).filter(item => item.id && /^[a-f0-9]{64}$/.test(item.hash));
    } catch { return []; }
  }

  /** One synchronous read-modify-write. */
  private update<T>(change: (items: Stored[]) => T): T {
    const items = this.read();
    const result = change(items);
    atomicJSON(this.path, items);
    this.cache = undefined;
    return result;
  }

  public list(): Device[] {
    return this.read().map(({ hash: _hash, ...device }) => device);
  }

  /** Pairs a new device; the token is returned once and never stored in clear. */
  public create(name: string): { device: Device; token: string } {
    const token = PREFIX + randomBytes(32).toString('base64url');
    const device: Stored = { id: randomBytes(6).toString('hex'), name: name.trim().slice(0, 60) || '手机', hash: hash(token), createdAt: new Date().toISOString() };
    this.update(items => { items.push(device); });
    const { hash: _hash, ...visible } = device;
    return { device: visible, token };
  }

  public revoke(id: string): boolean {
    return this.update(items => {
      const index = items.findIndex(item => item.id === id);
      if (index >= 0) items.splice(index, 1);
      return index >= 0;
    });
  }

  /** The device a bearer token belongs to, if any. Records when and from where it was last used. */
  public authenticate(token: string, address: string): Device | undefined {
    if (!token.startsWith(PREFIX)) return undefined;
    let mtime = 0;
    try { mtime = statSync(this.path).mtimeMs; } catch { /* no devices yet */ }
    if (!this.cache || this.cache.mtime !== mtime) this.cache = { mtime, items: this.read() };
    const wanted = Buffer.from(hash(token), 'hex');
    const found = this.cache.items.find(item => timingSafeEqual(Buffer.from(item.hash, 'hex'), wanted));
    if (!found) return undefined;
    const last = this.touched.get(found.id) ?? 0;
    if (Date.now() - last > TOUCH_INTERVAL) {
      this.touched.set(found.id, Date.now());
      const now = new Date().toISOString();
      this.update(items => {
        const index = items.findIndex(item => item.id === found.id);
        const current = items[index];
        if (current) items[index] = { ...current, lastUsedAt: now, lastAddress: address };
      });
    }
    const { hash: _hash, ...device } = found;
    return device;
  }
}

/**
 * Failed bearer tokens per remote address. Past a few failures an address is
 * answered 429 (without checking the token) for an exponentially growing time.
 * A valid token is always accepted, so a flood from a shared tunnel address
 * cannot lock out the owner.
 */
export class FailedAuth {
  private readonly failures = new Map<string, { count: number; until: number; last: number }>();

  public blocked(address: string): number {
    const entry = this.failures.get(address);
    return entry && entry.until > Date.now() ? Math.ceil((entry.until - Date.now()) / 1000) : 0;
  }

  public record(address: string): void {
    const entry = this.failures.get(address) ?? { count: 0, until: 0, last: 0 };
    entry.count += 1;
    entry.last = Date.now();
    if (entry.count >= 5) entry.until = Date.now() + Math.min(2 ** (entry.count - 5), 900) * 1000;
    this.failures.set(address, entry);
    if (this.failures.size > 1000) this.failures.delete(this.failures.keys().next().value as string);
  }

  public clear(address: string): void { this.failures.delete(address); }

  /** Recent failures, newest first, for the desktop App. */
  public recent(): { address: string; count: number; at: string; blockedSeconds: number }[] {
    return [...this.failures].map(([address, entry]) => ({ address, count: entry.count, at: new Date(entry.last).toISOString(), blockedSeconds: this.blocked(address) }))
      .sort((left, right) => right.at.localeCompare(left.at)).slice(0, 20);
  }
}
