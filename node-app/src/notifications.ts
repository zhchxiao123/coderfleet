// System notifications of the desktop App: a conversation waits for an
// approval or an answer, finished, or failed. The App's main process
// long-polls the selected backend's conversation list and compares each answer
// with the previous one; the phone App does the same in mobile/lib/src/notifications.dart.
import { setTimeout as sleep } from 'node:timers/promises';
import { entries, record, text } from './state.js';

export interface ConversationSummary {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly status: string;
  readonly attention: boolean;
  readonly turns: number;
}

export type EventKind = 'attention' | 'done' | 'failed';
export interface ConversationEvent { readonly kind: EventKind; readonly conversation: ConversationSummary }

const ACTIVE = new Set(['queued', 'starting', 'running']);
const LABELS: Readonly<Record<EventKind, string>> = { attention: '等你批准或回答', done: '已完成', failed: '失败了' };

export function summaries(value: unknown): ConversationSummary[] {
  return entries(value).map(item => ({
    id: text(item.id), projectId: text(item.projectId), name: text(item.name), status: text(item.status),
    attention: item.attention === true, turns: typeof item.turns === 'number' ? item.turns : 0,
  })).filter(item => item.id);
}

/** What changed between two lists that deserves a notification; conversations new in `current` are skipped. */
export function conversationEvents(previous: readonly ConversationSummary[], current: readonly ConversationSummary[]): ConversationEvent[] {
  const before = new Map(previous.map(item => [item.id, item]));
  const events: ConversationEvent[] = [];
  for (const conversation of current) {
    const old = before.get(conversation.id);
    if (!old) continue;
    if (conversation.attention && !old.attention) { events.push({ kind: 'attention', conversation }); continue; }
    // A turn ended, or a new one started and ended between two answers.
    if (!ACTIVE.has(old.status) && conversation.turns <= old.turns) continue;
    if (conversation.status === 'done' || conversation.status === 'failed') events.push({ kind: conversation.status, conversation });
  }
  return events;
}

export function notificationText(event: ConversationEvent): { title: string; body: string } {
  return { title: event.conversation.name, body: event.conversation.projectId + ' · ' + LABELS[event.kind] };
}

export interface WatchOptions {
  /** GET conversations/changes?since=…&wait=… on the watched backend. */
  readonly changes: (since: string, wait: number) => Promise<unknown>;
  readonly onEvent: (event: ConversationEvent) => void;
  readonly signal: AbortSignal;
  readonly wait?: number;
}

/** Long-polls until `signal` aborts. The first answer is the baseline; errors back off from 2 s to 60 s. */
export async function watchConversations({ changes, onEvent, signal, wait = 25_000 }: WatchOptions): Promise<void> {
  let etag = '';
  let previous: ConversationSummary[] | undefined;
  let delay = 2_000;
  while (!signal.aborted) {
    try {
      const answer = record(await changes(etag, previous ? wait : 0));
      if (signal.aborted) return;
      delay = 2_000;
      if (answer.unchanged === true) continue;
      etag = text(answer.etag);
      const current = summaries(answer.conversations);
      if (previous) for (const event of conversationEvents(previous, current)) onEvent(event);
      previous = current;
    } catch {
      if (signal.aborted) return;
      await sleep(delay, undefined, { signal }).catch(() => undefined);
      delay = Math.min(delay * 2, 60_000);
    }
  }
}
