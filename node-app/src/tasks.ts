// Host side of a conversation turn, following the Python scheduler's worker
// protocol: artifacts and a task specification are written to the project's
// .coderfleet-tasks directory, the worker is started detached inside the
// persistent container, and the service reads its event log and exit file from
// the bind-mounted project directory. A restarted service resumes from the
// saved log offset; the prompt is never replayed.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountType } from './accounts.js';
import { type WorkspaceProject } from './conf.js';
import { ControlMailbox, type CommandKind } from './control.js';
import { assertContainer, containerPath, execDetached, execText, quote, signalGroup, workerAlive } from './docker.js';
import { entries, message, record, text, type RecordValue, type ToolStatus, type Turn } from './state.js';
import type { WorkspaceStore } from './store.js';

export const PERMISSION_TIMEOUT_SECONDS = 600;
const START_GRACE = 60_000;
const PROBE_INTERVAL = 10_000;
/** How long a stop request may go unanswered before the next, harder step: interrupt → TERM → KILL. */
const STOP_ESCALATION = 20_000;
const MAX_READ = 4 * 1024 * 1024;
const MAX_ANSWER = 4_000_000;
const TASKS = '.coderfleet-tasks';

/** The in-container worker for each account type that supports conversations. */
const WORKERS: Readonly<Record<string, string>> = {
  claude: 'claude-worker.js', codex: 'codex-worker.js', opencode: 'opencode-worker.js', pi: 'pi-worker.js', hermes: 'hermes-worker.js',
  antigravity: 'acp-worker.js', kimi: 'acp-worker.js', grok: 'acp-worker.js',
};
const BUNDLE_FILES = ['control.js', 'worker-kit.js', 'claude-models.js', ...new Set(Object.values(WORKERS))];

/** Worker files plus the vendored SDKs, copied into each project under a content hash. */
interface Bundle { readonly name: string; readonly files: ReadonlyMap<string, Buffer> }
let bundle: Bundle | undefined;

function addTree(files: Map<string, Buffer>, directory: string, prefix: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) addTree(files, path, prefix + entry.name + '/');
    else files.set(prefix + entry.name, readFileSync(path));
  }
}

function workerBundle(): Bundle {
  if (bundle) return bundle;
  const files = new Map<string, Buffer>();
  for (const name of BUNDLE_FILES) files.set(name, readFileSync(fileURLToPath(new URL('./' + name, import.meta.url))));
  addTree(files, fileURLToPath(new URL('./vendor/', import.meta.url)), '');
  const hash = createHash('sha256');
  for (const [name, bytes] of [...files].sort(([left], [right]) => left.localeCompare(right))) hash.update(name).update('\0').update(bytes);
  bundle = { name: 'node-workers-' + hash.digest('hex').slice(0, 16), files };
  return bundle;
}

/** Copies the bundle into the project once; a partially copied directory is never used. */
function installBundle(host: string): string {
  const current = workerBundle();
  const target = join(host, current.name);
  if (existsSync(join(target, '.complete'))) return current.name;
  const staging = target + '.' + randomBytes(6).toString('hex') + '.tmp';
  mkdirSync(staging, { recursive: true });
  for (const [name, bytes] of current.files) {
    mkdirSync(join(staging, name, '..'), { recursive: true, mode: 0o755 });
    writeFileSync(join(staging, name), bytes, { mode: 0o644 });
  }
  writeFileSync(join(staging, 'package.json'), '{"type":"module"}\n', { mode: 0o644 });
  writeFileSync(join(staging, '.complete'), '');
  chmodSync(staging, 0o755);
  try { renameSync(staging, target); }
  catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (!existsSync(join(target, '.complete'))) throw error;
  }
  return current.name;
}

export function chatSupported(type: string): boolean { return type in WORKERS; }

function writeShared(path: string, bytes: Buffer | string): void {
  const temporary = path + '.' + randomBytes(6).toString('hex') + '.tmp';
  writeFileSync(temporary, bytes, { mode: 0o644 });
  chmodSync(temporary, 0o644);
  renameSync(temporary, path);
}

export function hostTaskDirectory(project: WorkspaceProject): string { return join(project.path, TASKS); }

export interface ModelChoice { readonly id: string; readonly label: string; readonly title?: string }

/**
 * The models a Claude project's account may use, as Claude Code lists them
 * (SDK `supportedModels()`, run in the container with that account's sign-in
 * and settings). Its `default` row becomes id '' — no `--model` — labelled
 * with the model it currently resolves to.
 */
export async function claudeModels(dockerPath: string, project: WorkspaceProject): Promise<ModelChoice[]> {
  await assertContainer(dockerPath, project);
  const host = hostTaskDirectory(project);
  mkdirSync(host, { recursive: true });
  chmodSync(host, 0o777);
  const bundleName = installBundle(host);
  const inside = (name: string): string => containerPath(TASKS + '/' + bundleName + '/' + name);
  const stdout = await execText(dockerPath, project.container,
    ['node', inside('claude-models.js'), inside('claude-agent-sdk'), containerPath('').replace(/\/$/, '')], 60_000);
  const rows = entries(JSON.parse(stdout.trim().split('\n').at(-1) || '[]'));
  return rows.flatMap(row => {
    const id = text(row.value);
    if (!id) return [];
    if (id !== 'default') return [{ id, label: text(row.displayName) || id, title: text(row.description) }];
    const resolved = text(row.resolvedModel);
    const name = text(rows.find(other => other !== row && text(other.resolvedModel) === resolved)?.displayName) || resolved;
    return [{ id: '', label: name ? '默认（' + name + '）' : '默认模型', title: text(row.description) }];
  });
}

const DETAIL_KEYS = ['command', 'cmd', 'file_path', 'filePath', 'path', 'notebook_path', 'pattern', 'query', 'url', 'description', 'prompt', 'skill'];

/** One short line describing a tool call's input, for the conversation view. */
export function toolDetail(input: unknown): string {
  const value = record(input);
  for (const key of DETAIL_KEYS) {
    const raw = value[key];
    const line = Array.isArray(raw) ? raw.map(text).join(' ') : text(raw);
    if (line.trim()) return line.replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  const changes = entries(value.changes).map(change => text(change.path)).filter(Boolean);
  if (changes.length) return changes.join(', ').slice(0, 160);
  return '';
}

const MAX_TOOL_OUTPUT = 64 * 1024;
const MAX_TOOL_INPUT = 16 * 1024;

/** A tool result's text: a string, or the text blocks of a content array (images are skipped). */
export function resultText(content: unknown): string {
  const value = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(block => record(block).type === 'text' || typeof record(block).text === 'string' ? text(record(block).text) : '').filter(Boolean).join('\n')
      : content && typeof content === 'object' ? JSON.stringify(content, null, 2) : '';
  return value.length > MAX_TOOL_OUTPUT ? value.slice(0, MAX_TOOL_OUTPUT) + '\n…（输出过长，已截断）' : value;
}

function capInput(input: unknown): unknown {
  const serialized = JSON.stringify(input ?? {});
  return serialized.length > MAX_TOOL_INPUT ? { truncated: serialized.slice(0, MAX_TOOL_INPUT) + '…' } : input ?? {};
}

function setTool(turn: Turn, id: string, status: ToolStatus): boolean {
  const index = turn.tools.findIndex(tool => tool.id === id);
  const current = turn.tools[index];
  if (!current || current.status === status) return false;
  turn.tools[index] = { ...current, status };
  return true;
}

/** Moves messages sent mid-turn into the turn, where the agent's next message begins (or at its end). */
export function releaseHeld(turn: Turn): void {
  if (!turn.heldMessages?.length) return;
  (turn.blocks ??= []).push(...turn.heldMessages);
  delete turn.heldMessages;
}

/** Applies one worker event to the turn record. Returns true when the record changed. */
export function applyEvent(turn: Turn, event: RecordValue): boolean {
  const type = event.type;
  if (type === 'system') {
    // Converted history events (Python logs) carry no task ID.
    if (event.task_id !== turn.id && event.history !== true) return false;
    switch (event.subtype) {
      case 'coderfleet_session':
      case 'coderfleet_acp_session': turn.sessionId = text(event.session_id) || turn.sessionId; return true;
      case 'coderfleet_question_pending':
        turn.permission = {
          id: text(event.tool_call_id), title: '需要你回答', details: '', allow: true, toolId: text(event.tool_call_id),
          questions: entries(event.questions).map(item => ({
            question: text(item.question), header: text(item.header), multiSelect: item.multiSelect === true,
            options: entries(item.options).map(option => ({ label: text(option.label), description: text(option.description) })),
          })),
        };
        return true;
      case 'coderfleet_control_ready':
        turn.controlReady = true;
        turn.capabilities = Array.isArray(event.capabilities) ? event.capabilities.filter((item): item is string => typeof item === 'string') : [];
        if (turn.status === 'starting') turn.status = 'running';
        return true;
      case 'coderfleet_message_accepted': {
        // A message sent while the turn ran; the agent takes it into this run.
        const images = Array.isArray(event.images) ? event.images.filter((item): item is string => typeof item === 'string') : [];
        // The model reads it when its next message starts; until then the current one may still stream.
        (turn.heldMessages ??= []).push({ kind: 'user', text: text(event.text), ...(images.length ? { images } : {}) });
        return true;
      }
      case 'coderfleet_permission_pending': {
        const details = JSON.stringify(event.tool_input ?? {}, null, 2).slice(0, 16_000);
        // Claude reports the tool-use ID as the approval ID; Antigravity sends it separately.
        const toolId = text(event.tool_use_id) || text(event.tool_call_id);
        turn.permission = { id: text(event.tool_call_id), title: text(event.tool_name) || 'Tool approval', details, allow: event.can_allow === true, toolId };
        setTool(turn, toolId, 'waiting');
        return true;
      }
      case 'coderfleet_question_closed':
      case 'coderfleet_permission_closed': {
        const permission = turn.permission;
        if (!permission || permission.id !== event.tool_call_id) return false;
        const toolId = permission.toolId;
        if (toolId) {
          const status = event.status === 'approved' || event.status === 'answered' ? 'running'
            : event.status === 'denied' || event.status === 'timed_out' ? 'denied' : 'interrupted';
          if (turn.tools.some(tool => tool.id === toolId)) setTool(turn, toolId, status);
          else if (status !== 'running' && !permission.questions) {
            // The approval came before the call itself; record the outcome so the later
            // error result of a rejected call does not read as a failure.
            let input: unknown;
            try { input = JSON.parse(permission.details); } catch { input = {}; }
            turn.tools.push({ id: toolId, title: permission.title, status, detail: toolDetail(input) });
            (turn.blocks ??= []).push({ kind: 'tool', id: toolId });
          }
        }
        delete turn.permission;
        return true;
      }
      case 'coderfleet_interrupted': turn.interrupted = true; return true;
      case 'coderfleet_background_stopped': {
        // Said in the answer itself, so every client shows it without a field of its own.
        const names = Array.isArray(event.tasks) ? event.tasks.filter((item): item is string => typeof item === 'string' && item !== '') : [];
        const note = '> 这一轮结束时还有后台命令没跑完，已经停掉' + (names.length ? '：' + names.join('、') : '。');
        turn.answer = (turn.answer + (turn.answer ? '\n\n' : '') + note).slice(0, MAX_ANSWER);
        (turn.blocks ??= []).push({ kind: 'text', text: note });
        return true;
      }
      default: return false;
    }
  }
  // A sub-agent's messages carry its Agent call's ID: its text is not the answer,
  // and its tool calls are steps of that Agent call.
  const parent = text(event.parent_tool_use_id);
  if (type === 'stream_event') {
    if (parent) return false;
    if (record(event.event).type === 'message_start') {
      releaseHeld(turn);
      turn.messageStarted = true;
      return true;
    }
    const delta = record(record(event.event).delta);
    if (record(event.event).type !== 'content_block_delta' || delta.type !== 'text_delta') return false;
    const chunk = text(delta.text);
    if (turn.answer.length >= MAX_ANSWER) return false;
    const blocks = turn.blocks ??= [];
    const last = blocks.at(-1);
    // A new assistant message is a new paragraph, never glued to the previous one.
    const fresh = turn.messageStarted === true;
    turn.messageStarted = false;
    turn.answer = (turn.answer + (fresh && turn.answer ? '\n\n' : '') + chunk).slice(0, MAX_ANSWER);
    if (last?.kind === 'text' && !fresh) last.text += chunk; else blocks.push({ kind: 'text', text: chunk });
    return true;
  }
  if (type === 'assistant' || type === 'user') {
    let changed = false;
    for (const block of Array.isArray(record(event.message).content) ? record(event.message).content as unknown[] : []) {
      const item = record(block);
      if (item.type === 'tool_use' && text(item.id) && !turn.tools.some(tool => tool.id === item.id)) {
        // The approval can arrive before the tool call itself.
        const status: ToolStatus = turn.permission?.toolId === item.id ? 'waiting' : 'running';
        turn.tools.push({ id: text(item.id), title: text(item.name) || 'Tool', status, detail: toolDetail(item.input), input: capInput(item.input), ...(parent ? { parent } : {}) });
        if (!parent) (turn.blocks ??= []).push({ kind: 'tool', id: text(item.id) });
        changed = true;
      } else if (item.type === 'tool_result') {
        const current = turn.tools.find(tool => tool.id === item.tool_use_id);
        const output = resultText(item.content);
        if (current && (output || item.output_unreported === true)) {
          const index = turn.tools.indexOf(current);
          turn.tools[index] = { ...current, ...(output ? { output } : { outputUnreported: true }) };
          changed = true;
        }
        // A rejected call reports an error result; it stays "denied", not "failed".
        if (current && current.status !== 'denied') changed = setTool(turn, current.id, item.is_error ? 'failed' : 'completed') || changed;
      }
    }
    return changed;
  }
  if (type === 'error') { turn.error = text(event.message) || 'Antigravity failed'; return true; }
  return false;
}

export class TaskRunner {
  /** Turns being stopped: the last step taken and when. */
  private readonly signalled = new Map<string, { step: 'interrupt' | 'TERM' | 'KILL'; at: number }>();
  private readonly lastProbe = new Map<string, number>();
  private readonly busy = new Set<string>();
  /** Called once a turn has settled (done, failed or cancelled). */
  public onFinish?: (turn: Turn) => void;
  /** Extra environment for one turn's worker (the machine helper's connection); it is not saved anywhere. */
  public taskEnv?: (project: WorkspaceProject, turn: Turn) => Promise<Record<string, string>>;

  public constructor(
    private readonly store: WorkspaceStore,
    private readonly dockerPath: string,
    /** The project as `account` runs it; without one, the project whichever account a turn used. */
    private readonly project: (id: string, account?: string) => WorkspaceProject | undefined,
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

  /** `run.cwd`: where the agent works (default: the project root); `run.preamble`: text put before the prompt, not shown as the user's. */
  public async launch(turn: Turn, run: { cwd?: string; preamble?: string; readOnly?: boolean } = {}): Promise<void> {
    // The turn's own account, never another of the project's: its sign-in and quota are what the turn was started for.
    const project = turn.account ? this.project(turn.projectId, turn.account) : undefined;
    try {
      if (!project) throw new Error('The project configuration is missing');
      const paths = this.paths(project, turn);
      mkdirSync(paths.host, { recursive: true });
      chmodSync(paths.host, 0o777);
      const workerFile = WORKERS[project.account.type];
      if (!workerFile) throw new Error(project.account.type + ' 账号暂不支持对话');
      const bundleName = installBundle(paths.host);
      const inside = (name: string): string => containerPath(TASKS + '/' + name);
      turn.controlToken = randomBytes(32).toString('hex');
      turn.controlReady = false;
      turn.logOffset = 0;
      writeShared(paths.spec, JSON.stringify({
        task_id: turn.id, cwd: run.cwd || containerPath('').replace(/\/$/, ''), prompt: (run.preamble ?? '') + turn.prompt, images: turn.images ?? [], auto: turn.auto === true, session_id: turn.resumeId, ...(run.readOnly ? { read_only: true } : {}),
        ...(turn.forkAt ? { fork_session_id: turn.forkAt.sessionId, resume_session_at: turn.forkAt.messageId } : {}),
        model: turn.requestedModel, env_auth: project.account.auth === 'env',
        state_path: inside(turn.id + '.sdk-state.json'), control_module: inside(bundleName + '/control.js'),
        control_directory: inside(turn.id + '.control'), control_token: turn.controlToken,
        permission_timeout: PERMISSION_TIMEOUT_SECONDS, sdk_directory: inside(bundleName + '/claude-agent-sdk'),
        vendor_directory: inside(bundleName), agent: project.account.type,
      }));
      turn.launchedAt = new Date().toISOString();
      this.store.saveTurn(turn);
      const log = quote(inside(turn.id + '.log'));
      const exit = quote(inside(turn.id + '.exit'));
      const body = '( setsid -w node ' + quote(inside(bundleName + '/' + workerFile)) + ' --spec ' + quote(inside(turn.id + '.sdk.json'))
        + ' --task-marker ' + quote('coderfleet-task-' + turn.id) + ' ) >> ' + log + ' 2>> ' + quote(inside(turn.id + '.sdk-diagnostic.log'))
        + '; cf_rc=$?; echo $cf_rc > ' + exit + '.tmp; mv ' + exit + '.tmp ' + exit;
      const extra = await this.taskEnv?.(project, turn) ?? {};
      // A container shared by several accounts carries no account's settings itself (compose.ts): the turn brings its own.
      const shared = project.accounts.length > 1;
      const own = shared ? accountType(project.account.type).envVars : {};
      const keys = shared && project.account.auth === 'env' && existsSync(project.account.envFile) ? project.account.envFile : undefined;
      await execDetached(this.dockerPath, project.container, { ...own, ...extra, CODERFLEET_TASK_ID: turn.id }, body, keys);
    } catch (error) {
      this.finish(turn, 'failed', message(error));
    }
  }

  private finish(turn: Turn, status: 'done' | 'failed' | 'cancelled', error?: string): void {
    turn.status = status;
    releaseHeld(turn);
    // Calls still open when the turn ends never reported a result.
    turn.tools = turn.tools.map(tool => tool.status === 'running' || tool.status === 'waiting'
      ? { ...tool, status: status === 'done' ? 'unknown' : 'interrupted' } : tool);
    if (error && !turn.error) turn.error = error;
    turn.controlReady = false;
    turn.finishedAt = new Date().toISOString();
    delete turn.permission;
    this.store.saveTurn(turn);
    this.signalled.delete(turn.id);
    this.lastProbe.delete(turn.id);
    try { this.onFinish?.(turn); } catch (error) { console.error('Turn finish hook failed:', turn.id, message(error)); }
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
      const session = turn.sessionId;
      for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try { applyEvent(turn, record(JSON.parse(line))); }
        catch { /* a non-JSON line in the log is diagnostic output */ }
      }
      // Mirror into the workspace's tasks/<id>.log, as the Python service does for SDK workers.
      this.store.appendLog(turn.id, buffer.subarray(0, end + 1));
      // The offset moved, so the record is saved even when no event changed it.
      turn.logOffset = offset + end + 1;
      // A fresh-session reviewer's session is its own: the conversation keeps resuming the author's.
      // (Claude reviews in the author's session, so there it is the same ID anyway.)
      if (turn.sessionId && turn.sessionId !== session && turn.role !== 'review') this.store.setNativeSession(turn.conversationId, turn.sessionId, turn.id);
      return true;
    } finally { closeSync(descriptor); }
  }

  /** One follow step for an active turn. */
  public async tick(turn: Turn): Promise<void> {
    // Only turns this service launched; others are read-only views of another service's work.
    if (turn.origin !== 'node' || this.busy.has(turn.id)) return;
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
      if (turn.cancelRequested) await this.deliverCancel(project, turn);
      if (existsSync(paths.exit)) {
        while (this.readLog(turn, paths.log)) { /* drain */ }
        const code = Number(readFileSync(paths.exit, 'utf8').trim());
        if (code === 0) this.finish(turn, 'done');
        else if (code === 143 || turn.interrupted || turn.cancelRequested) this.finish(turn, 'cancelled');
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

  /**
   * Asks the worker to stop, and stops it harder when it has not exited after
   * STOP_ESCALATION: a native interrupt first, then TERM, then KILL of its process group.
   */
  private async deliverCancel(project: WorkspaceProject, turn: Turn): Promise<void> {
    const last = this.signalled.get(turn.id);
    if (last && (last.step === 'KILL' || Date.now() - last.at < STOP_ESCALATION)) return;
    if (!last && turn.controlReady) {
      try {
        this.mailbox(project, turn).submit('interrupt', 'interrupt', {});
        this.signalled.set(turn.id, { step: 'interrupt', at: Date.now() });
        return;
      } catch { /* the channel closed; fall back to stopping the process group */ }
    }
    const state = this.workerState(this.paths(project, turn).state);
    if (!state) return; // retried on the next tick once the worker has started
    const step = last?.step === 'TERM' ? 'KILL' : 'TERM';
    await signalGroup(this.dockerPath, project.container, state.pgid, step);
    this.signalled.set(turn.id, { step, at: Date.now() });
  }

  public async cancel(turn: Turn): Promise<void> {
    if (turn.origin !== 'node') throw new Error('This turn is run by another service');
    turn.cancelRequested = true;
    this.store.saveTurn(turn);
    await this.tick(turn);
  }

  /**
   * Sends a message into the running turn (Claude takes it into the same session) and
   * waits for the worker's receipt. Throws when the worker cannot take it.
   */
  public async message(turn: Turn, input: { text: string; images: string[] }): Promise<void> {
    const project = this.project(turn.projectId);
    if (!project) throw new Error('The project configuration is missing');
    if (!turn.controlReady || !turn.capabilities?.includes('message')) throw new Error('This turn cannot take messages');
    const mailbox = this.mailbox(project, turn);
    const id = mailbox.submit('message-' + randomBytes(8).toString('hex'), 'message' satisfies CommandKind, input);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const reply = mailbox.reply(id);
      if (reply) {
        if (reply.status !== 'accepted') throw new Error(reply.error || 'The worker rejected this message');
        await this.tick(turn);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('The message was delivered but not confirmed yet. It will not be resent.');
  }

  /** Delivers an approval decision or question answers and waits for the worker's receipt. */
  public async decide(turn: Turn, permissionId: string, input: { decision: 'allow' | 'deny' } | { answers: Record<string, string> }): Promise<void> {
    const project = this.project(turn.projectId);
    if (!project) throw new Error('The project configuration is missing');
    const mailbox = this.mailbox(project, turn);
    const id = 'answers' in input
      ? mailbox.submit('answer-' + permissionId, 'answer' satisfies CommandKind, { tool_call_id: permissionId, answers: input.answers })
      : mailbox.submit('approval-' + permissionId, 'approval' satisfies CommandKind, { tool_call_id: permissionId, decision: input.decision });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const reply = mailbox.reply(id);
      if (reply) {
        if (reply.status !== 'accepted') throw new Error(reply.error || 'The worker rejected this reply');
        await this.tick(turn);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('The reply was delivered but not confirmed yet. It will not be resent.');
  }
}
