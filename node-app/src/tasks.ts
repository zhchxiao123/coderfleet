// Host side of an Antigravity turn, following the Python scheduler's worker
// protocol: artifacts and a task specification are written to the project's
// .coderfleet-tasks directory, the worker is started detached inside the
// persistent container, and the service reads its event log and exit file from
// the bind-mounted project directory. A restarted service resumes from the
// saved log offset; the prompt is never replayed.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type WorkspaceProject } from './conf.js';
import { ControlMailbox, type CommandKind } from './control.js';
import { containerPath, execDetached, quote, signalGroup, workerAlive } from './docker.js';
import { message, record, text, type RecordValue, type Store, type Turn } from './state.js';

export const PERMISSION_TIMEOUT_SECONDS = 600;
const START_GRACE = 60_000;
const PROBE_INTERVAL = 10_000;
const MAX_READ = 4 * 1024 * 1024;
const MAX_ANSWER = 4_000_000;
const TASKS = '.coderfleet-tasks';

function artifact(name: string): { bytes: Buffer; hash: string } {
  const bytes = readFileSync(fileURLToPath(new URL('./' + name, import.meta.url)));
  return { bytes, hash: createHash('sha256').update(bytes).digest('hex').slice(0, 16) };
}

function writeShared(path: string, bytes: Buffer | string): void {
  const temporary = path + '.' + randomBytes(6).toString('hex') + '.tmp';
  writeFileSync(temporary, bytes, { mode: 0o644 });
  chmodSync(temporary, 0o644);
  renameSync(temporary, path);
}

export function hostTaskDirectory(project: WorkspaceProject): string { return join(project.path, TASKS); }

/** Applies one worker event to the turn record. Returns true when the record changed. */
export function applyEvent(turn: Turn, event: RecordValue): boolean {
  const type = event.type;
  if (type === 'system') {
    if (event.task_id !== turn.id) return false;
    switch (event.subtype) {
      case 'coderfleet_acp_session': turn.sessionId = text(event.session_id) || turn.sessionId; return true;
      case 'coderfleet_control_ready': turn.controlReady = true; if (turn.status === 'starting') turn.status = 'running'; return true;
      case 'coderfleet_permission_pending': {
        const details = JSON.stringify(event.tool_input ?? {}, null, 2).slice(0, 16_000);
        turn.permission = { id: text(event.tool_call_id), title: text(event.tool_name) || 'Tool approval', details, allow: event.can_allow === true };
        return true;
      }
      case 'coderfleet_permission_closed':
        if (turn.permission?.id === event.tool_call_id) { delete turn.permission; return true; }
        return false;
      case 'coderfleet_interrupted': turn.interrupted = true; return true;
      default: return false;
    }
  }
  if (type === 'stream_event') {
    const delta = record(record(event.event).delta);
    if (record(event.event).type !== 'content_block_delta' || delta.type !== 'text_delta') return false;
    turn.answer = (turn.answer + text(delta.text)).slice(0, MAX_ANSWER);
    return true;
  }
  if (type === 'assistant' || type === 'user') {
    let changed = false;
    for (const block of Array.isArray(record(event.message).content) ? record(event.message).content as unknown[] : []) {
      const item = record(block);
      if (item.type === 'tool_use' && text(item.id) && !turn.tools.some(tool => tool.id === item.id)) {
        turn.tools.push({ id: text(item.id), title: text(item.name) || 'Tool', status: 'running' });
        changed = true;
      } else if (item.type === 'tool_result') {
        const index = turn.tools.findIndex(tool => tool.id === item.tool_use_id);
        const current = turn.tools[index];
        if (current) { turn.tools[index] = { ...current, status: item.is_error ? 'failed' : 'completed' }; changed = true; }
      }
    }
    return changed;
  }
  if (type === 'error') { turn.error = text(event.message) || 'Antigravity failed'; return true; }
  return false;
}

export class TaskRunner {
  private readonly signalled = new Set<string>();
  private readonly lastProbe = new Map<string, number>();
  private readonly busy = new Set<string>();

  public constructor(
    private readonly store: Store,
    private readonly dockerPath: string,
    private readonly project: (id: string) => WorkspaceProject | undefined,
  ) {}

  private paths(project: WorkspaceProject, turn: Turn) {
    const host = hostTaskDirectory(project);
    return {
      host, log: join(host, turn.id + '.log'), exit: join(host, turn.id + '.exit'),
      diagnostic: join(host, turn.id + '.sdk-diagnostic.log'), state: join(host, turn.id + '.sdk-state.json'),
      control: join(host, turn.id + '.control'), spec: join(host, turn.id + '.sdk.json'),
    };
  }

  private mailbox(project: WorkspaceProject, turn: Turn): ControlMailbox {
    if (!turn.controlToken) throw new Error('This turn has no control channel');
    return new ControlMailbox(this.paths(project, turn).control, turn.id, turn.controlToken);
  }

  public async launch(turn: Turn): Promise<void> {
    const project = this.project(turn.projectId);
    try {
      if (!project) throw new Error('The project configuration is missing');
      const paths = this.paths(project, turn);
      mkdirSync(paths.host, { recursive: true });
      chmodSync(paths.host, 0o777);
      const worker = artifact('antigravity-worker.js');
      const control = artifact('control.js');
      const workerName = 'acp-worker-' + worker.hash + '.mjs';
      const controlName = 'sdk-control-' + control.hash + '.mjs';
      if (!existsSync(join(paths.host, workerName))) writeShared(join(paths.host, workerName), worker.bytes);
      if (!existsSync(join(paths.host, controlName))) writeShared(join(paths.host, controlName), control.bytes);
      const inside = (name: string): string => containerPath(TASKS + '/' + name);
      turn.controlToken = randomBytes(32).toString('hex');
      turn.controlReady = false;
      turn.logOffset = 0;
      writeShared(paths.spec, JSON.stringify({
        task_id: turn.id, cwd: containerPath('').replace(/\/$/, ''), prompt: turn.prompt, session_id: turn.resumeId,
        model: turn.requestedModel, env_auth: project.account.auth === 'env',
        state_path: inside(turn.id + '.sdk-state.json'), control_module: inside(controlName),
        control_directory: inside(turn.id + '.control'), control_token: turn.controlToken,
        permission_timeout: PERMISSION_TIMEOUT_SECONDS,
      }));
      turn.launchedAt = new Date().toISOString();
      this.store.saveTurn(turn);
      const log = quote(inside(turn.id + '.log'));
      const exit = quote(inside(turn.id + '.exit'));
      const body = '( setsid -w node ' + quote(inside(workerName)) + ' --spec ' + quote(inside(turn.id + '.sdk.json'))
        + ' --task-marker ' + quote('coderfleet-task-' + turn.id) + ' ) >> ' + log + ' 2>> ' + quote(inside(turn.id + '.sdk-diagnostic.log'))
        + '; cf_rc=$?; echo $cf_rc > ' + exit + '.tmp; mv ' + exit + '.tmp ' + exit;
      await execDetached(this.dockerPath, project.container, { CODERFLEET_TASK_ID: turn.id }, body);
    } catch (error) {
      this.finish(turn, 'failed', message(error));
    }
  }

  private finish(turn: Turn, status: 'done' | 'failed' | 'cancelled', error?: string): void {
    turn.status = status;
    if (error && !turn.error) turn.error = error;
    turn.controlReady = false;
    turn.finishedAt = new Date().toISOString();
    delete turn.permission;
    this.store.saveTurn(turn);
    this.signalled.delete(turn.id);
    this.lastProbe.delete(turn.id);
  }

  /** Applies complete new lines from the worker log. Returns true when the offset advanced. */
  private readLog(turn: Turn, path: string): boolean {
    let descriptor: number;
    try { descriptor = openSync(path, 'r'); }
    catch (error) { if (record(error).code === 'ENOENT') return false; throw error; }
    try {
      const offset = turn.logOffset ?? 0;
      const size = fstatSync(descriptor).size;
      if (size <= offset) return false;
      const buffer = Buffer.alloc(Math.min(size - offset, MAX_READ));
      const length = readSync(descriptor, buffer, 0, buffer.length, offset);
      const end = buffer.subarray(0, length).lastIndexOf(10);
      if (end < 0) return false;
      for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try { applyEvent(turn, record(JSON.parse(line))); }
        catch { /* a non-JSON line in the log is diagnostic output */ }
      }
      // The offset moved, so the record is saved even when no event changed it.
      turn.logOffset = offset + end + 1;
      return true;
    } finally { closeSync(descriptor); }
  }

  /** One follow step for an active turn. */
  public async tick(turn: Turn): Promise<void> {
    if (this.busy.has(turn.id)) return;
    if (!turn.launchedAt) {
      // Saved but never dispatched (the service stopped during launch).
      if (Date.now() - Date.parse(turn.createdAt) > START_GRACE) this.finish(turn, 'failed', 'The turn was not started. The prompt was not sent.');
      return;
    }
    this.busy.add(turn.id);
    try {
      const project = this.project(turn.projectId);
      if (!project) { this.finish(turn, 'failed', 'The project was removed from projects.conf'); return; }
      const paths = this.paths(project, turn);
      if (this.readLog(turn, paths.log)) this.store.saveTurn(turn);
      if (turn.cancelRequested && !this.signalled.has(turn.id)) await this.deliverCancel(project, turn);
      if (existsSync(paths.exit)) {
        while (this.readLog(turn, paths.log)) { /* drain */ }
        const code = Number(readFileSync(paths.exit, 'utf8').trim());
        if (code === 0) this.finish(turn, 'done');
        else if (code === 143 || turn.interrupted) this.finish(turn, 'cancelled');
        else this.finish(turn, 'failed', this.diagnostic(paths.diagnostic) || 'Antigravity worker exited with status ' + code);
        return;
      }
      await this.probe(project, turn, paths.state, paths.exit);
    } catch (error) {
      console.error('Turn follow failed:', turn.id, message(error));
    } finally { this.busy.delete(turn.id); }
  }

  private diagnostic(path: string): string {
    try { return readFileSync(path, 'utf8').trim().split('\n').slice(-5).join('\n').slice(-2_000); }
    catch { return ''; }
  }

  private workerState(path: string): { pid: number; pgid: number } | undefined {
    try {
      const value = record(JSON.parse(readFileSync(path, 'utf8')));
      return Number.isInteger(value.pid) && Number.isInteger(value.pgid) ? { pid: value.pid as number, pgid: value.pgid as number } : undefined;
    } catch { return undefined; }
  }

  private async probe(project: WorkspaceProject, turn: Turn, statePath: string, exitPath: string): Promise<void> {
    const last = this.lastProbe.get(turn.id) ?? 0;
    if (Date.now() - last < PROBE_INTERVAL) return;
    this.lastProbe.set(turn.id, Date.now());
    const state = this.workerState(statePath);
    if (!state) {
      if (Date.now() - Date.parse(turn.launchedAt ?? turn.createdAt) > START_GRACE) {
        this.finish(turn, 'failed', this.diagnostic(statePath.replace(/\.sdk-state\.json$/, '.sdk-diagnostic.log')) || 'The worker did not start in the container');
      }
      return;
    }
    // A Docker failure throws here and leaves the turn active.
    if (await workerAlive(this.dockerPath, project.container, state.pid, turn.id)) return;
    if (existsSync(exitPath)) return;
    this.finish(turn, 'failed', 'The worker stopped without a result. The prompt was not replayed.');
  }

  private async deliverCancel(project: WorkspaceProject, turn: Turn): Promise<void> {
    if (turn.controlReady) {
      try {
        this.mailbox(project, turn).submit('interrupt', 'interrupt', {});
        this.signalled.add(turn.id);
        return;
      } catch { /* the channel closed; fall back to stopping the process group */ }
    }
    const state = this.workerState(this.paths(project, turn).state);
    if (!state) return; // retried on the next tick once the worker has started
    await signalGroup(this.dockerPath, project.container, state.pgid, 'TERM');
    this.signalled.add(turn.id);
  }

  public async cancel(turn: Turn): Promise<void> {
    turn.cancelRequested = true;
    this.store.saveTurn(turn);
    await this.tick(turn);
  }

  /** Delivers an approval decision and waits for the worker's receipt. */
  public async decide(turn: Turn, permissionId: string, decision: 'allow' | 'deny'): Promise<void> {
    const project = this.project(turn.projectId);
    if (!project) throw new Error('The project configuration is missing');
    const mailbox = this.mailbox(project, turn);
    const id = mailbox.submit('approval-' + permissionId, 'approval' satisfies CommandKind, { tool_call_id: permissionId, decision });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const reply = mailbox.reply(id);
      if (reply) {
        if (reply.status !== 'accepted') throw new Error(reply.error || 'The approval was rejected');
        await this.tick(turn);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('The approval was delivered but not confirmed yet. It will not be resent.');
  }
}
