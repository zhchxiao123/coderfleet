// The operation log: one line per tool call, append only, one file per day.
import { closeSync, openSync, readdirSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export interface AuditRecord {
  readonly time: string;
  readonly call: string;
  readonly task: string;
  readonly label: string;
  readonly tool: string;
  readonly args: unknown;
  readonly verdict: string;
  readonly rule?: string;
  readonly confirmation?: string;
  readonly exit_code?: number | null;
  readonly seconds?: number;
  readonly error?: string;
}

const day = (now: Date): string =>
  now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');

/**
 * Opens today's file before the call does anything, so a call whose line cannot be
 * written never runs. `write` puts the call's single line and closes the file.
 */
export function openAudit(home: string, now = new Date()): { write(record: AuditRecord): void } {
  const descriptor = openSync(join(home, 'audit', day(now) + '.jsonl'), 'a', 0o600);
  let written = false;
  return {
    write(record) {
      if (written) return;
      written = true;
      try { writeSync(descriptor, JSON.stringify(record) + '\n'); }
      finally { closeSync(descriptor); }
    },
  };
}

/** The newest `count` lines, oldest first. */
export function readAudit(home: string, count: number): AuditRecord[] {
  const directory = join(home, 'audit');
  const records: AuditRecord[] = [];
  for (const name of readdirSync(directory).filter(item => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(item)).sort().reverse()) {
    const lines = readFileSync(join(directory, name), 'utf8').split('\n').filter(Boolean);
    for (let index = lines.length - 1; index >= 0 && records.length < count; index--) {
      try { records.push(JSON.parse(lines[index] as string) as AuditRecord); } catch { /* a torn line is skipped */ }
    }
    if (records.length >= count) break;
  }
  return records.reverse();
}
