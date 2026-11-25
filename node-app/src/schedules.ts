// 定时: things the service starts by itself at set times, each run in a new
// conversation of the project. Kept in the backend's own state directory
// (schedules.json) with the last runs of every item. Times are this
// computer's local time; there is no cron syntax.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJSON, entries, record, text } from './state.js';

export class ScheduleError extends Error {}

/** `days`: 0 (Sunday) … 6 (Saturday), as Date.getDay(). */
export type Rule =
  | { readonly kind: 'daily'; readonly time: string }
  | { readonly kind: 'weekly'; readonly days: readonly number[]; readonly time: string }
  | { readonly kind: 'every'; readonly hours: number };

/**
 * starting → started (its conversation exists) | failed (it could not start);
 * skipped: the previous run was still going; missed: more than a day late.
 */
export type RunResult = 'starting' | 'started' | 'skipped' | 'failed' | 'missed';
export interface Run {
  readonly at: string;
  readonly result: RunResult;
  readonly conversationId?: string;
  readonly note?: string;
  /** Started with 立即跑一次, not by the clock. */
  readonly manual?: boolean;
}

export interface Schedule {
  readonly id: string;
  readonly projectId: string;
  readonly prompt: string;
  readonly rule: Rule;
  /** 做完为止: every run works in its own branch until its criteria are met. */
  readonly job: boolean;
  readonly enabled: boolean;
  readonly createdAt: string;
  /** The next time the clock starts it. */
  readonly nextAt: string;
  /** Oldest first, at most MAX_RUNS. */
  readonly runs: readonly Run[];
}

export const MAX_RUNS = 20;
/** A run this late is not made up. */
export const MISSED_AFTER = 24 * 3600_000;
const MAX_ORIGINS = 500;
const HOUR = 3600_000;
const WEEKDAYS = '日一二三四五六';

const clock = (value: string): [number, number] => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  const hours = Number(match?.[1]); const minutes = Number(match?.[2]);
  if (!match || hours > 23 || minutes > 59) throw new ScheduleError('时间写成 HH:MM，例如 09:00');
  return [hours, minutes];
};
const padded = ([hours, minutes]: [number, number]): string => String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');

/** A rule from a request body or the saved file; throws ScheduleError when it is not one. */
export function parseRule(value: unknown): Rule {
  const raw = record(value);
  if (raw.kind === 'daily') return { kind: 'daily', time: padded(clock(text(raw.time))) };
  if (raw.kind === 'weekly') {
    const days = [...new Set(Array.isArray(raw.days) ? raw.days.map(Number) : [])].sort((left, right) => left - right);
    if (!days.length || !days.every(day => Number.isInteger(day) && day >= 0 && day <= 6)) throw new ScheduleError('每周至少选一天');
    return { kind: 'weekly', days, time: padded(clock(text(raw.time))) };
  }
  if (raw.kind === 'every') {
    const hours = Number(raw.hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new ScheduleError('间隔是 1 到 168 之间的整小时数');
    return { kind: 'every', hours };
  }
  throw new ScheduleError('不认识的时间规则');
}

/**
 * The rule as the command line writes it: `daily 09:00`, `weekly 1,3 03:00`
 * (1 = Monday … 7 = Sunday) or `every 6`. Returns the rule and how many words it took.
 */
export function ruleFromWords(words: readonly string[]): { rule: Rule; used: number } {
  const [kind, first, second] = words;
  if (kind === 'daily' && first) return { rule: parseRule({ kind, time: first }), used: 2 };
  if (kind === 'weekly' && first && second) {
    const days = first.split(',').map(Number);
    if (!days.every(day => Number.isInteger(day) && day >= 1 && day <= 7)) throw new ScheduleError('星期写成 1 到 7（1 是周一，7 是周日），用逗号隔开');
    return { rule: parseRule({ kind, days: days.map(day => day % 7), time: second }), used: 3 };
  }
  if (kind === 'every' && first) return { rule: parseRule({ kind, hours: Number(first.replace(/h$/i, '')) }), used: 2 };
  throw new ScheduleError('时间规则写成：daily HH:MM | weekly 1,3 HH:MM | every <小时数>');
}

/** How a rule reads everywhere it is shown: 每天 09:00 · 每周一、三 03:00 · 每隔 6 小时. */
export function label(rule: Rule): string {
  if (rule.kind === 'daily') return '每天 ' + rule.time;
  if (rule.kind === 'every') return '每隔 ' + rule.hours + ' 小时';
  if (rule.days.length === 7) return '每天 ' + rule.time;
  // Monday first, Sunday last.
  const days = [...rule.days].sort((left, right) => (left || 7) - (right || 7));
  return '每周' + days.map(day => WEEKDAYS[day]).join('、') + ' ' + rule.time;
}

/** The first time after `from` the rule falls on (local time). */
export function nextAfter(rule: Rule, from: Date): Date {
  if (rule.kind === 'every') return new Date(from.getTime() + rule.hours * HOUR);
  const [hours, minutes] = clock(rule.time);
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset, hours, minutes, 0, 0);
    if (day.getTime() > from.getTime() && (rule.kind === 'daily' || rule.days.includes(day.getDay()))) return day;
  }
  throw new ScheduleError('这个规则没有下一次');
}

/** The latest time the rule fell on between `due` (one such time) and `now`. */
function latestDue(rule: Rule, due: Date, now: Date): Date {
  let latest = due;
  for (;;) {
    const next = nextAfter(rule, latest);
    if (next.getTime() > now.getTime()) return latest;
    latest = next;
  }
}

interface File { schedules: Schedule[]; origins: Record<string, string> }

export interface ScheduleInput { readonly projectId: string; readonly prompt: string; readonly rule: Rule; readonly job: boolean }

export class Schedules {
  private readonly path: string;

  public constructor(stateDirectory: string) {
    mkdirSync(stateDirectory, { recursive: true });
    this.path = join(stateDirectory, 'schedules.json');
  }

  private read(): File {
    let raw: Record<string, unknown>;
    try { raw = record(JSON.parse(readFileSync(this.path, 'utf8'))); } catch { return { schedules: [], origins: {} }; }
    const schedules = entries(raw.schedules).flatMap((item): Schedule[] => {
      let rule: Rule;
      try { rule = parseRule(item.rule); } catch { return []; }
      return [{
        id: text(item.id), projectId: text(item.projectId), prompt: text(item.prompt), rule, job: item.job === true, enabled: item.enabled === true,
        createdAt: text(item.createdAt), nextAt: text(item.nextAt),
        runs: entries(item.runs).map((run): Run => ({
          at: text(run.at), result: text(run.result) as RunResult,
          ...(text(run.conversationId) ? { conversationId: text(run.conversationId) } : {}),
          ...(text(run.note) ? { note: text(run.note) } : {}), ...(run.manual === true ? { manual: true } : {}),
        })),
      }];
    });
    return { schedules, origins: Object.fromEntries(Object.entries(record(raw.origins)).map(([id, value]) => [id, text(value)])) };
  }

  /** One synchronous read-modify-write (no await between load and save). */
  private update<T>(change: (file: File) => T): T {
    const file = this.read();
    const result = change(file);
    atomicJSON(this.path, file);
    return result;
  }

  private static replace(file: File, id: string, change: (item: Schedule) => Schedule): Schedule | undefined {
    const index = file.schedules.findIndex(item => item.id === id);
    const current = file.schedules[index];
    if (!current) return undefined;
    const next = change(current);
    file.schedules[index] = { ...next, runs: next.runs.slice(-MAX_RUNS) };
    return file.schedules[index];
  }

  public list(): Schedule[] { return this.read().schedules; }
  public get(id: string): Schedule | undefined { return this.read().schedules.find(item => item.id === id); }
  /** Conversation → the rule (as shown) of the schedule that started it. */
  public origins(): Record<string, string> { return this.read().origins; }

  public create(input: ScheduleInput, now = new Date()): Schedule {
    return this.update(file => {
      const item: Schedule = { ...input, id: randomUUID().replaceAll('-', '').slice(0, 8), enabled: true, createdAt: now.toISOString(),
        nextAt: nextAfter(input.rule, now).toISOString(), runs: [] };
      file.schedules.push(item);
      return item;
    });
  }

  /** A new rule, or turning it on again, counts the next time from now: nothing is made up for the time it was off. */
  public change(id: string, patch: Partial<ScheduleInput> & { enabled?: boolean }, now = new Date()): Schedule | undefined {
    return this.update(file => Schedules.replace(file, id, item => {
      const next = { ...item, ...patch };
      const restart = patch.rule !== undefined || (patch.enabled === true && !item.enabled);
      return restart ? { ...next, nextAt: nextAfter(next.rule, now).toISOString() } : next;
    }));
  }

  public remove(id: string): boolean {
    return this.update(file => {
      const before = file.schedules.length;
      file.schedules = file.schedules.filter(item => item.id !== id);
      return file.schedules.length < before;
    });
  }

  /**
   * What the clock has reached: every due item moves to its next time and gets a run —
   * missed when even its latest time is over a day ago, skipped while `busy` (its previous
   * run still going), else starting. Returns the starting ones for the caller to start.
   */
  public claimDue(now: Date, busy: (item: Schedule) => boolean): { id: string; at: string }[] {
    return this.update(file => {
      const starting: { id: string; at: string }[] = [];
      for (const item of [...file.schedules]) {
        const due = new Date(item.nextAt);
        if (!item.enabled || !(due.getTime() <= now.getTime())) continue;
        const latest = latestDue(item.rule, due, now);
        const at = now.toISOString();
        const run: Run = now.getTime() - latest.getTime() > MISSED_AFTER ? { at, result: 'missed' }
          : busy(item) ? { at, result: 'skipped' } : { at, result: 'starting' };
        Schedules.replace(file, item.id, current => ({ ...current, nextAt: nextAfter(current.rule, latest).toISOString(), runs: [...current.runs, run] }));
        if (run.result === 'starting') starting.push({ id: item.id, at });
      }
      return starting;
    });
  }

  /** 立即跑一次: a starting run that leaves the next time alone. */
  public begin(id: string, now = new Date()): string | undefined {
    const at = now.toISOString();
    return this.update(file => Schedules.replace(file, id, item => ({ ...item, runs: [...item.runs, { at, result: 'starting', manual: true }] }))) ? at : undefined;
  }

  /** How a starting run ended up; a started one marks its conversation with the rule. */
  public finish(id: string, at: string, outcome: { result: 'started'; conversationId: string } | { result: 'failed'; note: string }): void {
    this.update(file => {
      const item = Schedules.replace(file, id, current => ({
        ...current, runs: current.runs.map(run => run.at === at && run.result === 'starting' ? { ...run, ...outcome } : run),
      }));
      if (!item || outcome.result !== 'started') return;
      file.origins[outcome.conversationId] = label(item.rule);
      const ids = Object.keys(file.origins);
      for (const old of ids.slice(0, Math.max(0, ids.length - MAX_ORIGINS))) delete file.origins[old];
    });
  }

  /** After a restart: a run that was starting when the service stopped did not start. */
  public recover(): void {
    if (!this.list().some(item => item.runs.some(run => run.result === 'starting'))) return;
    this.update(file => {
      for (const item of [...file.schedules]) {
        Schedules.replace(file, item.id, current => ({
          ...current, runs: current.runs.map((run): Run => run.result === 'starting' ? { ...run, result: 'failed', note: '后台在它开始的时候停了' } : run),
        }));
      }
    });
  }
}
