// Shared pieces of the in-container workers. Workers, this module and the
// control mailbox are copied together into the project's .coderfleet-tasks,
// so only Node built-ins and sibling files may be imported here.
import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ControlMailbox, type Command } from './control.js';

export interface BaseSpec {
  task_id: string; cwd: string; prompt: string; session_id: string; model: string; env_auth: boolean;
  state_path: string; control_module: string; control_directory: string; control_token: string; permission_timeout: number;
}

export type Json = Record<string, unknown>;

export function object(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}
export function list(value: unknown): Json[] { return Array.isArray(value) ? value.map(object) : []; }
export function str(value: unknown): string { return typeof value === 'string' ? value : ''; }

/** One stream-json event line on stdout (the Task log). */
export function emit(type: string, fields: Json = {}): void {
  process.stdout.write(JSON.stringify({ type, ...fields }) + '\n');
}

export function system(spec: BaseSpec, subtype: string, fields: Json = {}): void {
  emit('system', { subtype, task_id: spec.task_id, ...fields });
}

export function openMailbox(spec: BaseSpec): ControlMailbox {
  return new ControlMailbox(spec.control_directory, spec.task_id, spec.control_token);
}

/** Records the worker PID; the launcher starts it through `setsid`, so the PID is the process group. */
export function writeState(spec: BaseSpec): string {
  const ownershipToken = randomBytes(16).toString('hex');
  const temporary = spec.state_path + '.tmp';
  writeFileSync(temporary, JSON.stringify({ task_id: spec.task_id, pid: process.pid, pgid: process.pid, ownership_token: ownershipToken }));
  renameSync(temporary, spec.state_path);
  return ownershipToken;
}

/**
 * Delivers pending mailbox commands to `handle` until `stop()` is called.
 * File events wake the loop at once; a slow tick covers missed events.
 */
export function pumpCommands(spec: BaseSpec, mailbox: ControlMailbox, handle: (command: Command) => void | Promise<void>): { stop: () => void; done: Promise<void> } {
  let stopped = false;
  let wake: () => void = () => undefined;
  let watcher: FSWatcher | undefined;
  try { watcher = watch(join(spec.control_directory, 'requests'), () => wake()); }
  catch { /* polling alone still delivers commands */ }
  const done = (async () => {
    try {
      while (!stopped) {
        for (const command of mailbox.pending()) {
          mailbox.claim(command.id);
          await handle(command);
        }
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 200);
          wake = () => { clearTimeout(timer); resolve(); };
        });
      }
    } finally { watcher?.close(); }
  })();
  return { stop: () => { stopped = true; wake(); }, done };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}

/** Entry point shared by all workers: `node <worker> --spec <path> --task-marker <marker>`. */
export async function runMain<T extends BaseSpec>(moduleUrl: string, run: (spec: T) => Promise<number>): Promise<void> {
  if (!process.argv[1] || moduleUrl !== pathToFileURL(process.argv[1]).href) return;
  const args = process.argv.slice(2);
  const index = args.indexOf('--spec');
  if (index < 0 || !args[index + 1] || !args.includes('--task-marker')) {
    process.stderr.write('Usage: worker --spec <path> --task-marker <marker>\n');
    process.exitCode = 2;
    return;
  }
  process.exitCode = await run(JSON.parse(readFileSync(args[index + 1] as string, 'utf8')) as T);
}
