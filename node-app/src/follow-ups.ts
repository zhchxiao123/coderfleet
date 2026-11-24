// Messages sent while a turn runs on an agent that cannot take them mid-turn
// (everything but Claude). They wait here, in the backend's own state
// directory, and each becomes the conversation's next turn once the current
// one ends. Kept out of the workspace's tasks/ so the Python scheduler never
// sees them as pending tasks.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJSON, entries, record, text } from './state.js';

export interface FollowUp {
  readonly id: string;
  readonly text: string;
  readonly images: string[];
  readonly auto: boolean;
  readonly model: string;
  readonly createdAt: string;
}

export const MAX_FOLLOW_UPS = 5;

export class FollowUps {
  private readonly path: string;

  public constructor(stateDirectory: string) {
    mkdirSync(stateDirectory, { recursive: true });
    this.path = join(stateDirectory, 'follow-ups.json');
  }

  private read(): Record<string, FollowUp[]> {
    try {
      const raw = record(JSON.parse(readFileSync(this.path, 'utf8')));
      return Object.fromEntries(Object.entries(raw).map(([conversation, items]) => [conversation, entries(items).map(item => ({
        id: text(item.id), text: text(item.text), images: Array.isArray(item.images) ? item.images.filter((value): value is string => typeof value === 'string') : [],
        auto: item.auto === true, model: text(item.model), createdAt: text(item.createdAt),
      }))]));
    } catch { return {}; }
  }

  /** One synchronous read-modify-write (no await between load and save). */
  private update<T>(change: (all: Record<string, FollowUp[]>) => T): T {
    const all = this.read();
    const result = change(all);
    for (const [key, items] of Object.entries(all)) if (!items.length) delete all[key];
    atomicJSON(this.path, all);
    return result;
  }

  public list(conversationId: string): FollowUp[] { return this.read()[conversationId] ?? []; }

  public conversations(): string[] { return Object.keys(this.read()); }

  public add(conversationId: string, input: Omit<FollowUp, 'id' | 'createdAt'>): FollowUp {
    return this.update(all => {
      const items = all[conversationId] ??= [];
      if (items.length >= MAX_FOLLOW_UPS) throw new Error('最多排队 ' + MAX_FOLLOW_UPS + ' 条消息，请等当前回答结束');
      const item: FollowUp = { ...input, id: randomUUID().replaceAll('-', '').slice(0, 12), createdAt: new Date().toISOString() };
      items.push(item);
      return item;
    });
  }

  public remove(conversationId: string, id: string): boolean {
    return this.update(all => {
      const items = all[conversationId] ?? [];
      const index = items.findIndex(item => item.id === id);
      if (index >= 0) items.splice(index, 1);
      all[conversationId] = items;
      return index >= 0;
    });
  }

}
