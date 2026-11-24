// Conversations and turns stored in the CoderFleet workspace in the Python
// service's formats: conversations/<id>.json (Conversation), tasks/<id>.json
// (Task) and tasks/<id>.log (the run's event log). Existing history shows up
// as is, and turns started here are visible to the Python service. Fields
// this service needs and Python does not model live under the Task's "node"
// key; every Python field is preserved on save.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeLog } from './history.js';
import { record, text, type Conversation, type RecordValue, type Status, type Turn } from './state.js';
import { applyEvent } from './tasks.js';

type Raw = RecordValue;

function now(): string { return new Date().toISOString(); }

function writeJson(path: string, value: unknown): void {
  const temporary = join(path, '..', '.' + path.split('/').pop() + '.' + process.pid + '.' + randomUUID().slice(0, 8) + '.tmp');
  writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o644 });
  renameSync(temporary, path);
}

function readJson(path: string): Raw | undefined {
  try { return record(JSON.parse(readFileSync(path, 'utf8'))); } catch { return undefined; }
}

const FROM_PYTHON: Readonly<Record<string, Status>> = {
  scheduled: 'queued', pending: 'queued', running: 'running', done: 'done', failed: 'failed', killed: 'cancelled',
};
const TO_PYTHON: Readonly<Record<Status, string>> = {
  queued: 'pending', starting: 'running', running: 'running', done: 'done', failed: 'failed', cancelled: 'killed',
};

/** Node-only Task fields, kept under the Task's "node" key. */
interface NodeFields {
  launchedAt?: string; controlReady?: boolean; logOffset?: number; cancelRequested?: boolean; error?: string; requestedModel?: string;
}

interface Entry { readonly mtime: number; readonly raw: Raw }

export class WorkspaceStore {
  private readonly conversationsDir: string;
  private readonly tasksDir: string;
  private readonly conversationIndex = new Map<string, Entry>();
  private readonly taskIndex = new Map<string, Entry>();
  /** Turns launched by this service, as the runner updates them. */
  private readonly live = new Map<string, Turn>();
  /** Parsed views of other turns, by log size. */
  private readonly parsed = new Map<string, { key: string; turn: Turn }>();
  private refreshedAt = 0;

  public constructor(workspace: string, private readonly projectForPath: (path: string) => string | undefined) {
    this.conversationsDir = join(workspace, 'conversations');
    this.tasksDir = join(workspace, 'tasks');
    mkdirSync(this.conversationsDir, { recursive: true });
    mkdirSync(this.tasksDir, { recursive: true });
    this.refresh(true);
    // Turns this service launched and had not finished keep running in their containers.
    for (const { raw } of this.taskIndex.values()) {
      const node = record(raw.node) as NodeFields;
      if (node.launchedAt && ['running', 'pending'].includes(text(raw.status))) {
        const turn = this.build(raw);
        if (turn) this.live.set(turn.id, turn);
      }
    }
  }

  /** Rereads changed records; at most once a second unless forced. */
  private refresh(force = false): void {
    if (!force && Date.now() - this.refreshedAt < 1_000) return;
    this.refreshedAt = Date.now();
    for (const [directory, index] of [[this.conversationsDir, this.conversationIndex], [this.tasksDir, this.taskIndex]] as const) {
      const seen = new Set<string>();
      for (const name of readdirSync(directory)) {
        if (!name.endsWith('.json') || name.startsWith('.')) continue;
        const id = name.slice(0, -5);
        seen.add(id);
        let mtime: number;
        try { mtime = statSync(join(directory, name)).mtimeMs; } catch { continue; }
        if (index.get(id)?.mtime === mtime) continue;
        const raw = readJson(join(directory, name));
        if (raw && text(raw.id) === id) index.set(id, { mtime, raw });
      }
      for (const id of [...index.keys()]) if (!seen.has(id)) index.delete(id);
    }
  }

  // ── Conversations ────────────────────────────────────

  private conversationView(raw: Raw): Conversation | undefined {
    if (raw.status === 'archived' || (raw.mode && raw.mode !== 'chat') || raw.ephemeral === true) return undefined;
    const projectId = text(raw.project_name) || this.projectForPath(text(raw.project)) || '';
    return {
      id: text(raw.id), projectId, name: text(raw.name) || '对话', createdAt: text(raw.created), updatedAt: text(raw.updated) || text(raw.created),
      nativeSessionId: text(raw.native_session_id), account: text(raw.account), type: text(raw.type), project: text(raw.project),
    };
  }

  public conversations(): Conversation[] {
    this.refresh();
    return [...this.conversationIndex.values()].flatMap(({ raw }) => this.conversationView(raw) ?? []);
  }

  public conversation(id: string): Conversation | undefined {
    this.refresh();
    const entry = this.conversationIndex.get(id);
    return entry ? this.conversationView(entry.raw) : undefined;
  }

  /** Creates or updates a conversation, keeping the Python fields it does not change. */
  public saveConversation(value: Conversation): void {
    const path = join(this.conversationsDir, value.id + '.json');
    const current = readJson(path) ?? {
      title: { source: 'fallback', status: 'idle', revision: 0, attempts: 0, retry_at: '', error: '', first_task_id: '', first_goal_task_id: '',
        topic_task_id: '', latest_task_id: '', context_key: '', latest_message: '' },
      sdk_options: {}, fork: null, status: 'active', mode: 'chat', tmux_session: '', last_task_id: '', ephemeral: false, output_dir: '',
      ephemeral_retention: 'release_on_finish', ephemeral_ttl_minutes: 120, ephemeral_container_name: '', ephemeral_expires_at: '',
      created: value.createdAt,
    };
    // Replacing the "新对话" placeholder with the first prompt is not a manual rename.
    const renamed = text(current.name) !== value.name && Boolean(current.name) && current.name !== '新对话';
    const title = record(current.title);
    const next: Raw = {
      ...current, id: value.id, name: value.name, account: value.account ?? current.account, type: value.type ?? current.type,
      project: value.project ?? current.project, project_name: value.projectId, native_session_id: value.nativeSessionId ?? current.native_session_id ?? '',
      updated: now(),
      // A manual rename wins over automatic titles, as in the Python service.
      ...(renamed ? { title: { ...title, source: 'manual', revision: Number(title.revision ?? 0) + 1 } } : {}),
    };
    writeJson(path, next);
    this.conversationIndex.set(value.id, { mtime: statSync(path).mtimeMs, raw: next });
  }

  private touchConversation(id: string, change: (raw: Raw) => void): void {
    const path = join(this.conversationsDir, id + '.json');
    const raw = readJson(path);
    if (!raw) return;
    change(raw);
    raw.updated = now();
    writeJson(path, raw);
    this.conversationIndex.set(id, { mtime: statSync(path).mtimeMs, raw });
  }

  // ── Turns ────────────────────────────────────────────

  public logPath(id: string): string { return join(this.tasksDir, id + '.log'); }

  /** A turn view from a Task record and its log. */
  private build(raw: Raw): Turn | undefined {
    const id = text(raw.id);
    if (!id) return undefined;
    const node = record(raw.node) as NodeFields;
    const origin = node.launchedAt ? 'node' : 'python';
    const turn: Turn = {
      id, origin, conversationId: text(raw.conversation_id), projectId: text(raw.project_name) || this.projectForPath(text(raw.project)) || '',
      account: text(raw.account), type: text(raw.type), prompt: text(raw.prompt), requestedModel: node.requestedModel ?? text(raw.model),
      images: Array.isArray(raw.images) ? raw.images.filter((item): item is string => typeof item === 'string') : [], auto: raw.auto === true,
      createdAt: text(raw.created), resumeId: '', status: FROM_PYTHON[text(raw.status)] ?? 'failed',
      answer: '', tools: [], blocks: [], sessionId: text(raw.native_session_id) || undefined, model: text(raw.model) || undefined,
      interrupted: raw.interrupted === true || undefined, finishedAt: text(raw.finished) || undefined,
      controlToken: text(raw.sdk_control_token) || undefined, controlReady: node.controlReady,
      logOffset: node.logOffset ?? Number(raw.sdk_source_offset ?? 0), launchedAt: node.launchedAt, cancelRequested: node.cancelRequested,
    };
    let content = '';
    try { content = readFileSync(this.logPath(id), 'utf8'); } catch { /* no log yet */ }
    // Python CLI backends log each tool's native format; SDK/ACP workers and this service log normalized events.
    const native = origin === 'python' && raw.execution_backend !== 'sdk' && raw.execution_backend !== 'acp';
    for (const event of normalizeLog(text(raw.type), native, content)) applyEvent(turn, event);
    if (node.error) turn.error = node.error;
    if (turn.status !== 'running' && turn.status !== 'starting') delete turn.permission;
    return turn;
  }

  public turn(id: string): Turn | undefined {
    const live = this.live.get(id);
    if (live) return live;
    this.refresh();
    const entry = this.taskIndex.get(id);
    if (!entry) return undefined;
    let size = 0;
    try { size = statSync(this.logPath(id)).size; } catch { /* no log */ }
    const key = entry.mtime + ':' + size;
    const cached = this.parsed.get(id);
    if (cached?.key === key) return cached.turn;
    const turn = this.build(entry.raw);
    if (turn) this.parsed.set(id, { key, turn });
    return turn;
  }

  /** Turn summaries of a conversation (or of all), without reading logs except for live turns. */
  public turnIds(conversationId?: string): { id: string; createdAt: string; status: Status; attention: boolean; projectId: string }[] {
    this.refresh();
    const result: { id: string; createdAt: string; status: Status; attention: boolean; projectId: string }[] = [];
    for (const { raw } of this.taskIndex.values()) {
      const id = text(raw.id);
      if (conversationId !== undefined && text(raw.conversation_id) !== conversationId) continue;
      const live = this.live.get(id);
      result.push({
        id, createdAt: text(raw.created), status: live?.status ?? FROM_PYTHON[text(raw.status)] ?? 'failed', attention: Boolean(live?.permission),
        projectId: text(raw.project_name) || this.projectForPath(text(raw.project)) || '',
      });
    }
    for (const live of this.live.values()) {
      if ((conversationId === undefined || live.conversationId === conversationId) && !result.some(item => item.id === live.id)) {
        result.push({ id: live.id, createdAt: live.createdAt, status: live.status, attention: Boolean(live.permission), projectId: live.projectId });
      }
    }
    return result.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  public turns(conversationId: string): Turn[] {
    return this.turnIds(conversationId).flatMap(item => this.turn(item.id) ?? []);
  }

  public turnConversation(id: string): string {
    return this.live.get(id)?.conversationId ?? text(this.taskIndex.get(id)?.raw.conversation_id);
  }

  /** Turns this service is running. */
  public liveTurns(): Turn[] { return [...this.live.values()]; }

  /** Writes the Task record for a turn this service runs (Python Task fields plus "node"). */
  public saveTurn(turn: Turn): void {
    if (turn.origin !== 'node') return;
    const path = join(this.tasksDir, turn.id + '.json');
    const current = readJson(path) ?? {};
    let logSize = 0;
    try { logSize = statSync(this.logPath(turn.id)).size; } catch { /* no log yet */ }
    const node: NodeFields = {
      launchedAt: turn.launchedAt, controlReady: turn.controlReady, logOffset: turn.logOffset, cancelRequested: turn.cancelRequested,
      error: turn.error, requestedModel: turn.requestedModel,
    };
    const finished = turn.status === 'done' || turn.status === 'failed' || turn.status === 'cancelled';
    const next: Raw = {
      archived: false, pid: '', execution_runtime: 'container', sdk_version: 'node', cli_version: '',
      sdk_capabilities: [], sdk_permission_mode: '', sdk_options: {}, sdk_checkpoints: [], sdk_action: {}, platform_run_id: '',
      terminal_notified: false, git_branch: '', git_worktree: false, git_diff_added: 0, git_diff_removed: 0, execute_at: null,
      parent_task_id: '', depends_on: [], pipeline_id: '', board_card_id: '', tokens_input: 0, tokens_output: 0, cost_usd: 0,
      ephemeral: false, execution_mode: 'persistent', output_dir: '', ephemeral_retention: 'release_on_finish', ephemeral_ttl_minutes: 120,
      ephemeral_container_name: '', task_secrets: {}, continuation_id: '', retry_of: '', retry_count: 0, retry_task_id: '', pending_intervention: null,
      ...current,
      id: turn.id, status: TO_PYTHON[turn.status], account: turn.account ?? current.account, type: turn.type ?? current.type,
      prompt: turn.prompt, images: [...(turn.images ?? [])], auto: turn.auto === true, project: current.project, project_name: turn.projectId, conversation_id: turn.conversationId,
      native_session_id: turn.sessionId ?? '', created: turn.createdAt, finished: finished ? (turn.finishedAt ?? now()) : null,
      model: turn.model ?? turn.requestedModel, execution_backend: 'sdk', interrupted: turn.interrupted === true,
      sdk_control_token: turn.controlToken ?? '', sdk_control_ready: turn.controlReady === true,
      sdk_source_offset: turn.logOffset ?? 0, sdk_log_size: logSize, node,
    };
    writeJson(path, next);
    this.taskIndex.set(turn.id, { mtime: statSync(path).mtimeMs, raw: next });
    if (finished) this.live.delete(turn.id); else this.live.set(turn.id, turn);
    this.parsed.delete(turn.id);
  }

  /** A new turn this service will run; `project` is the host path recorded in the Task. */
  public createTurn(turn: Turn, project: string): void {
    const path = join(this.tasksDir, turn.id + '.json');
    writeJson(path, { id: turn.id, project });
    if (!existsSync(this.logPath(turn.id))) writeFileSync(this.logPath(turn.id), '');
    this.saveTurn(turn);
    this.touchConversation(turn.conversationId, raw => { raw.last_task_id = turn.id; });
  }

  /** Appends worker output to tasks/<id>.log, as the Python service mirrors SDK logs. */
  public appendLog(id: string, bytes: Buffer): void {
    appendFileSync(this.logPath(id), bytes);
  }

  /** Records the agent session on the conversation, which later turns resume. */
  public setNativeSession(conversationId: string, sessionId: string, taskId: string): void {
    this.touchConversation(conversationId, raw => {
      if (raw.native_session_id === sessionId) return;
      raw.native_session_id = sessionId;
      raw.last_task_id = taskId;
    });
  }
}
