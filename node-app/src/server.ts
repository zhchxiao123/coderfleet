import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { gzip } from 'node:zlib';
import { ACCOUNT_TYPES, accountType } from './accounts.js';
import {
  addAccount, addProject, envKeys, initWorkspace, readSettings, readWorkspace, removeAccount, setProjectActive, updateEnv, writeSettings, WorkspaceError, type Account, type WorkspaceProject, projectAs, setProjectAccounts, readProjectEnv, writeProjectEnv, projectHelperAccess, projectMountSpecs, setProjectHelper, setProjectMounts, defaultProjectImage, projectImage, readProjectDockerfile, setProjectImage, writeProjectDockerfile,
} from './conf.js';
import { projectMounts } from './compose.js';
import { assertContainer, codexModels, models, shellText } from './docker.js';
import { Devices, FailedAuth, type Device } from './devices.js';
import { FollowUps, type FollowUp } from './follow-ups.js';
import { acceptPrompt, CHECK_ROUNDS, closedNote, criteria, JobError, Jobs, open as jobOpen, preamble, reviewFeedback, reviewPrompt, reviewVerdict, unmetFeedback, type Job } from './jobs.js';
import { ForkError, forkOf, transcript } from './fork.js';
import { HELPER_ANSWERS, HELPER_CARD, HelperHost, type HelperPending } from './helper-host.js';
import { Lead, LeadError, LEAD_UPLOADS, leadUploads } from './lead.js';
import { Lifecycle } from './lifecycle.js';
import { label as ruleLabel, nextAfter, parseRule, ScheduleError, Schedules, type Run, type Schedule } from './schedules.js';
import { ExtraAddresses, interfaceAddresses, listensBeyondLoopback, pairingLink, tailscaleName, type Address } from './mobile.js';
import { Titles } from './titles.js';
import { FileAccessError, listFiles, previewFile, rawFile, sentFile } from './files.js';
import { configured, SystemLLMError, systemLLM, TranslationCache, translateText } from './translate.js';
import { findPythonService, stopPythonTask, type PythonService } from './python-service.js';
import { active, identifier, message, readConfig, record, text, type Conversation, type Turn } from './state.js';
import { WorkspaceStore } from './store.js';
import { chatSupported, claudeModels, TaskRunner, type ModelChoice } from './tasks.js';
import { Terminals } from './terminal.js';
import { NoContainerError, UsageTracker, usageSupported } from './usage.js';
import { BUILD_ID, VERSION } from './version.js';

class HttpError extends Error {
  public constructor(public readonly status: number, message: string) { super(message); }
}

/** Answers below this size are sent as they are: compressing them saves nothing. */
const GZIP_FROM = 1024;

function reply(request: IncomingMessage, response: ServerResponse, status: number, data: unknown): void {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const content = Buffer.from(JSON.stringify(data) ?? 'null');
  if (content.length < GZIP_FROM || !/\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''))) {
    response.writeHead(status, headers);
    response.end(content);
    return;
  }
  // Conversation lists and turns are repetitive JSON: about a fifth of the size over a phone's network.
  gzip(content, (error, packed) => {
    if (error) { response.writeHead(status, headers); response.end(content); return; }
    response.writeHead(status, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
    response.end(packed);
  });
}

async function body(request: IncomingMessage, limit = 160_000): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new HttpError(413, 'The request body is too large');
    chunks.push(buffer);
  }
  if (!size) return {};
  try { return record(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch { throw new HttpError(400, 'Expected a JSON request body'); }
}

/** The largest attachment a message can carry. */
const MAX_UPLOAD = 500 * 1024 * 1024;
const TOO_LARGE = '附件不能超过 500 MB';
/** The most attachments one message carries. */
const MAX_ATTACHMENTS = 20;
// <16 hex>-<name> (or the older <16 hex>.<ext>); only characters the Python service also accepts.
const UPLOAD_NAME = '[a-f0-9]{16}[-.][\\p{L}\\p{N}_.-]{0,120}';
const UPLOAD_PATH = new RegExp('^/workspace/\\.coderfleet-uploads/' + UPLOAD_NAME + '$', 'u');
const LEAD_UPLOAD_PATH = new RegExp('^' + LEAD_UPLOADS + UPLOAD_NAME + '$', 'u');
const UPLOAD_TYPES: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

/**
 * Saves the request's file in `directory` under a unique prefix plus the name in characters every
 * tool handles. The file is the request body (application/octet-stream, named by ?name=), written to
 * disk as it arrives; older clients send JSON { name, data: base64 }, which stays limited to 20 MB.
 */
async function saveUpload(request: IncomingMessage, url: URL, directory: string): Promise<{ file: string; name: string; size: number }> {
  const raw = (request.headers['content-type'] ?? '').startsWith('application/octet-stream');
  if (raw && Number(request.headers['content-length']) > MAX_UPLOAD) throw new HttpError(413, TOO_LARGE);
  const input = raw ? { name: url.searchParams.get('name') ?? '' } : await body(request, 28 * 1024 * 1024);
  const data = raw ? undefined : Buffer.from(text(input.data), 'base64');
  if (data && !data.length) throw new HttpError(400, '文件是空的');
  if (data && data.length > 20 * 1024 * 1024) throw new HttpError(400, '附件不能超过 20 MB');
  mkdirSync(directory, { recursive: true });
  const original = text(input.name).split(/[\\/]/).pop() ?? '';
  const dot = original.lastIndexOf('.');
  const extension = dot > 0 ? original.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) : '';
  const stem = (dot > 0 ? original.slice(0, dot) : original).normalize('NFC').replace(/[^\p{L}\p{N}_.-]+/gu, '_').replace(/^[_.]+|[_.]+$/g, '').slice(0, 80) || 'file';
  const file = randomBytes(8).toString('hex') + '-' + stem + (extension ? '.' + extension : '');
  let size = data?.length ?? 0;
  if (data) writeFileSync(join(directory, file), data, { mode: 0o644 });
  else {
    // Under a temporary name until it is complete: a dropped connection leaves nothing behind.
    const partial = join(directory, '.' + file + '.part');
    const counted = new Transform({ transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      done(size > MAX_UPLOAD ? new HttpError(413, TOO_LARGE) : null, chunk);
    } });
    try {
      await pipeline(request, counted, createWriteStream(partial, { mode: 0o644 }));
      if (!size) throw new HttpError(400, '文件是空的');
      renameSync(partial, join(directory, file));
    } catch (error) {
      rmSync(partial, { force: true });
      throw error;
    }
  }
  return { file, name: text(input.name).slice(0, 200), size };
}

/** An uploaded image of `directory` for its preview, by its URL-encoded name. */
function readUpload(directory: string, encoded: string): { mime: string; data: string } {
  let file = '';
  try { file = decodeURIComponent(encoded); } catch { throw new HttpError(400, '无效的文件名'); }
  if (!/^[a-f0-9]{16}[-.][\p{L}\p{N}_.-]*$/u.test(file)) throw new HttpError(400, '无效的文件名');
  const path = join(directory, file);
  if (!existsSync(path) || statSync(path).size > 20 * 1024 * 1024) throw new HttpError(404, '图片不存在');
  return { mime: UPLOAD_TYPES[file.split('.').pop()?.toLowerCase() as string] as string, data: readFileSync(path).toString('base64') };
}

/** Validated upload references of a message: at most 20, each matching `pattern` and still a file of `directory`. */
function attached(value: unknown, pattern: RegExp, directory: string, where: string): string[] {
  const list = Array.isArray(value) ? value : [];
  if (list.length > MAX_ATTACHMENTS) throw new HttpError(400, '一次最多 ' + MAX_ATTACHMENTS + ' 个附件');
  if (!list.every(item => typeof item === 'string' && pattern.test(item) && !item.includes('..'))) throw new HttpError(400, '附件必须是' + where + '上传的文件');
  for (const item of list as string[]) if (!existsSync(join(directory, item.split('/').pop() as string))) throw new HttpError(400, '附件已不存在，请重新添加');
  return list as string[];
}

function size(input: Record<string, unknown>): [number, number] {
  const cols = Number(input.cols); const rows = Number(input.rows);
  return [Number.isFinite(cols) ? cols : 100, Number.isFinite(rows) ? rows : 30];
}

/** How long a Claude project's model list is reused before Claude Code is asked again. */
const CLAUDE_MODELS_TTL = 10 * 60_000;

type Handler = (request: IncomingMessage, params: string[], url: URL) => Promise<unknown>;

/**
 * What a paired phone's device token may call: the chat API only. Everything
 * else (accounts, projects management, terminals, settings, devices) needs the
 * backend's main token, which stays on the computer.
 */
const DEVICE_ROUTES: readonly [string, RegExp][] = [
  ['GET', /^health$/], ['GET', /^device$/], ['GET', /^projects$/], ['GET', /^projects\/[\w.-]+\/models$/],
  ['GET', /^conversations$/], ['GET', /^conversations\/changes$/], ['POST', /^conversations$/], ['PUT', /^conversations\/[\w-]+$/],
  ['GET', /^conversations\/[\w-]+\/(turns|changes|follow-ups)$/], ['POST', /^conversations\/[\w-]+\/(turns|fork)$/],
  ['DELETE', /^conversations\/[\w-]+\/follow-ups\/[\w-]+$/],
  ['POST', /^(projects\/[\w.-]+|lead)\/uploads$/], ['GET', /^(projects\/[\w.-]+|lead)\/uploads\/[^/]+$/],
  ['GET', /^turns\/[\w-]+\/tools\/.+$/], ['GET', /^turns\/[\w-]+\/files$/], ['POST', /^turns\/[\w-]+\/(permission|cancel)$/],
  ['GET', /^system-llm$/], ['POST', /^translate$/],
  // 领航: its thread, the user's words and answers to it, and who keeps a conversation. Its switch stays on the computer.
  ['GET', /^lead$/], ['GET', /^lead\/changes$/], ['POST', /^lead\/(messages|stop|asks\/[\w-]+|undo\/[\w-]+)$/], ['PUT', /^conversations\/[\w-]+\/lead$/],
];
export function deviceAllowed(method: string, path: string): boolean {
  return DEVICE_ROUTES.some(([allowed, pattern]) => allowed === method && pattern.test(path));
}

const digest = (value: unknown): string => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const LONG_POLL_MAX = 30_000;
/** Turns in one page of earlier history when the phone names no size. */
const EARLIER_PAGE = 10;
/** A page size from the query: a whole number from 1 to 500, or 0 when absent or invalid (no paging). */
const count = (value: string | null): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 500) : 0;
};

type AuthedRequest = IncomingMessage & { device?: Device };

export interface ServeOptions {
  /** Called after an authenticated POST /v1/shutdown; only the standalone service passes it. */
  readonly onShutdown?: () => void;
}

export async function serve(configPath: string, options: ServeOptions = {}): Promise<Server> {
  const config = readConfig(configPath);
  const workspace = config.workspace;
  let projectPaths = { at: 0, map: new Map<string, string>() };
  const projectForPath = (path: string): string | undefined => {
    if (Date.now() - projectPaths.at > 2_000) {
      projectPaths = { at: Date.now(), map: new Map(readWorkspace(workspace).projects.map(item => [item.path.replace(/\/+$/, ''), item.name])) };
    }
    return projectPaths.map.get(path.replace(/\/+$/, ''));
  };
  const store = new WorkspaceStore(workspace, projectForPath);
  let python: { checked: number; value: PythonService | undefined } = { checked: 0, value: undefined };
  const token = Buffer.from('Bearer ' + config.token);
  const lifecycle = new Lifecycle(workspace, config.dockerPath);
  const terminals = new Terminals(workspace, config.dockerPath);
  const usage = new UsageTracker(workspace, config.dockerPath);
  const template = fileURLToPath(new URL('../template/', import.meta.url));
  const hasLogin = (item: Account): boolean => {
    try { return readdirSync(join(workspace, 'accounts', item.name)).length > 0; } catch { return false; }
  };
  /** How full the account's fullest subscription window is, in percent; null when it has none or none was read yet. */
  const usedMost = (item: Account): number | null => {
    const known = usageSupported(item) ? usage.cached(item.name) : undefined;
    const all = [known?.fiveHour, known?.sevenDay, ...(known?.pools ?? [])].flatMap(window => window ? [window.used] : []);
    return all.length ? Math.round(Math.max(...all)) : null;
  };
  /** An account that can hold conversations. */
  const chatAccount = (item: Account): boolean => chatSupported(item.type) && item.runtime === 'container';
  /** New conversations start with the account the project's newest conversation uses, as long as the project still holds it; else its first. */
  const defaultAccount = (target: WorkspaceProject): Account | undefined => {
    const usable = target.accounts.filter(chatAccount);
    if (usable.length < 2) return usable[0];
    const last = store.conversations().filter(item => item.projectId === target.name).sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .flatMap(item => usable.find(entry => entry.name === item.account) ?? [])[0];
    return last ?? usable[0];
  };
  /** The project as one of its accounts runs conversations in it: the named one, or the one new conversations start with. */
  const chatProject = (id: string, accountName?: string): WorkspaceProject | undefined => {
    const found = readWorkspace(workspace).projects.find(item => item.name === id);
    const chosen = found && (accountName === undefined ? defaultAccount(found) : found.accounts.find(item => item.name === accountName && chatAccount(item)));
    return found && chosen ? projectAs(found, chosen.name) : undefined;
  };
  /**
   * The account a conversation goes on with: the one it began with, or the project's account of the
   * same type when that one was replaced. Nothing when the project holds neither: the conversation can only be read.
   */
  const conversationAccount = (target: WorkspaceProject, conversation: Pick<Conversation, 'account' | 'type'>): Account | undefined => {
    const own = target.accounts.find(item => item.name === conversation.account) ?? (conversation.type
      ? target.accounts.find(item => item.type === conversation.type)
      // Records from before conversations carried a type belong to the project's first account.
      : conversation.account ? undefined : target.accounts[0]);
    return own && chatAccount(own) && (!conversation.type || own.type === conversation.type) ? own : undefined;
  };
  const conversationProject = (conversation: Conversation): WorkspaceProject => {
    const found = readWorkspace(workspace).projects.find(item => item.name === conversation.projectId);
    if (!found) throw new HttpError(404, 'Project not found');
    const own = conversationAccount(found, conversation);
    if (!own) throw new HttpError(409, '这个对话用的' + (conversation.account ? '账号 ' + conversation.account : ' ' + (conversation.type ?? '') + ' 账号') + '已经不在项目里，只能查看');
    return projectAs(found, own.name) as WorkspaceProject;
  };
  const runner = new TaskRunner(store, config.dockerPath, (id, accountName) =>
    accountName === undefined ? readWorkspace(workspace).projects.find(item => item.name === id) : chatProject(id, accountName));
  const helper = new HelperHost(workspace, config.dockerPath);
  runner.taskEnv = async (target, turn) => {
    const granted = await helper.grant(target, turn.id);
    if (granted.reason) console.error('Turn ' + turn.id + ' runs without the machine helper: ' + granted.reason);
    return granted.env;
  };
  /** Active turns of projects that may use the machine helper, or that still show one of its cards. */
  const machineTurns = (): Turn[] => {
    const allowed = new Set(readWorkspace(workspace).projects.filter(item => projectHelperAccess(item) !== 'off').map(item => item.name));
    return store.liveTurns().filter(turn => active(turn) && turn.origin === 'node' && (allowed.has(turn.projectId) || turn.permission?.id.startsWith(HELPER_CARD)));
  };
  const helperCard = (item: HelperPending): NonNullable<Turn['permission']> => {
    const command = item.argv.map(word => /^[\w@%+=:,./-]+$/.test(word) ? word : JSON.stringify(word)).join(' ');
    return {
      id: HELPER_CARD + item.id, title: '要在这台机器上运行命令', details: JSON.stringify({ command, cwd: item.cwd }), allow: true,
      questions: [{
        question: '要在这台机器上运行：' + command + '（目录 ' + item.cwd + '）', header: '机器操作', multiSelect: false,
        options: HELPER_ANSWERS.map(({ label, description }) => ({ label, description })),
      }],
    };
  };
  let helperSyncing = false;
  /** Shows what the helper wants confirmed as the turn's approval card, and takes the card away once it is settled. */
  const syncHelperCards = async (): Promise<void> => {
    if (helperSyncing || !machineTurns().length) return;
    helperSyncing = true;
    try {
      // A helper that does not answer has nothing waiting: its calls ended with it.
      const pending = await helper.pending() ?? [];
      for (const turn of machineTurns()) {
        const mine = pending.filter(item => item.task === turn.id);
        const shown = turn.permission?.id.startsWith(HELPER_CARD) ? turn.permission.id : '';
        if (shown && !mine.some(item => HELPER_CARD + item.id === shown)) { delete turn.permission; store.saveTurn(turn); }
        // One card at a time: the worker's own approval, when there is one, is answered first.
        if (!turn.permission && mine[0]) { turn.permission = helperCard(mine[0]); store.saveTurn(turn); }
      }
    } finally { helperSyncing = false; }
  };
  const claudeModelLists = new Map<string, { at: number; list: Promise<ModelChoice[]> }>();
  const project = (name: string): WorkspaceProject => {
    const found = readWorkspace(workspace).projects.find(item => item.name === name);
    if (!found) throw new HttpError(404, '项目不存在');
    return found;
  };
  const account = (name: string) => {
    const found = readWorkspace(workspace).accounts.find(item => item.name === name);
    if (!found) throw new HttpError(404, '账号不存在');
    return found;
  };
  const turnsOf = (conversationId: string): Turn[] => store.turns(conversationId);
  const followUps = new FollowUps(config.stateDirectory);
  const jobs = new Jobs(config.stateDirectory, config.dockerPath);
  const schedules = new Schedules(config.stateDirectory);
  schedules.recover();
  /** The conversation list (desktop and phone change feed). `latest`, when given, receives each conversation's newest turn. */
  const conversationList = (archived = false, latest?: Map<string, { id: string; finishedAt: string }>, own = false) => {
    // Like the Python service (Conversation.touch at a task's start and end): a conversation's time is
    // its latest activity — the newest turn's finish, or its start while it runs. Status is the newest turn's.
    const time = (value: string): number => Date.parse(value) || 0;
    const summaries = new Map<string, { updatedAt: string; latest: string; status: string; turns: number; attention: boolean }>();
    for (const item of store.turnIds()) {
      const conversationId = store.turnConversation(item.id);
      if (!conversationId) continue;
      const current = summaries.get(conversationId) ?? { updatedAt: '', latest: '', status: '', turns: 0, attention: false };
      const activity = time(item.finishedAt) > time(item.createdAt) ? item.finishedAt : item.createdAt;
      const newest = time(item.createdAt) >= time(current.latest);
      if (newest) latest?.set(conversationId, { id: item.id, finishedAt: item.finishedAt });
      summaries.set(conversationId, {
        updatedAt: time(activity) > time(current.updatedAt) ? activity : current.updatedAt,
        latest: newest ? item.createdAt : current.latest,
        status: newest ? item.status : current.status,
        turns: current.turns + 1,
        attention: current.attention || item.attention,
      });
    }
    const jobStates = new Map(jobs.list().map(job => [job.conversationId, job.state]));
    const origins = schedules.origins();
    const projects = new Map(readWorkspace(workspace).projects.map(item => [item.name, item]));
    const followed = lead.follows();
    const asked = lead.asking();
    return store.conversations({ archived }).map(item => {
      const summary = summaries.get(item.id);
      const owner = projects.get(item.projectId);
      return { id: item.id, projectId: item.projectId, name: item.name, createdAt: item.createdAt, type: item.type ?? '',
        // The account its next turn runs as; '' when the project no longer holds one for it (it can only be read).
        account: (owner && conversationAccount(owner, item)?.name) ?? '',
        forkedFrom: item.fork ? { conversationId: item.fork.source_conversation_id, turnId: item.fork.source_task_id } : null,
        updatedAt: summary?.updatedAt || item.updatedAt || item.createdAt, status: summary?.status ?? '', turns: summary?.turns ?? 0,
        // Waiting for the user. What stops in a conversation 领航 follows waits for 领航, until it hands it over as a card
        // (`own`: 领航's own reading, which sees every stop).
        attention: !own && followed(item.id) ? asked.has(item.id) : summary?.attention ?? false,
        // 做完为止: the state of the job this conversation works on ('' when it has none).
        job: jobStates.get(item.id) ?? '',
        // 定时: the rule of the schedule that started this conversation ('' when the user did).
        schedule: origins[item.id] ?? '',
        // 领航在跟: what stops here goes to 领航 first, not to the user.
        lead: followed(item.id) };
    }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  };
  /** What a finished turn ended on, as one plain line for the phone's list ('' while it runs). Kept per turn: a finished turn's log is read once. */
  const previews = new Map<string, { finishedAt: string; text: string }>();
  const preview = (latest?: { id: string; finishedAt: string }): string => {
    if (!latest?.finishedAt) return '';
    const kept = previews.get(latest.id);
    if (kept?.finishedAt === latest.finishedAt) return kept.text;
    const turn = store.turn(latest.id);
    const last = [...(turn?.blocks ?? [])].reverse().find(block => block.kind === 'text');
    const text = previewLine((last && 'text' in last ? last.text : '') || turn?.answer || '');
    previews.set(latest.id, { finishedAt: latest.finishedAt, text });
    if (previews.size > 2000) previews.delete(previews.keys().next().value as string);
    return text;
  };
  /** The turns a conversation shows, oldest first, by id only (no log is read): a fork's inherited ones, then its own. */
  const turnSequence = (id: string): { id: string; inherited: boolean }[] => {
    const conversation = store.conversation(id);
    if (!conversation) throw new HttpError(404, 'Conversation not found');
    // A fork shows the turns it branched from, read-only, before its own.
    return [
      ...(conversation.fork?.inherited_task_ids ?? []).map(turnId => ({ id: turnId, inherited: true })),
      ...store.turnIds(id).map(item => ({ id: item.id, inherited: false })),
    ];
  };
  const publicTurns = (sequence: { id: string; inherited: boolean }[]): Record<string, unknown>[] => sequence.flatMap(item => {
    const turn = store.turn(item.id);
    if (!turn) return [];
    // What 领航 did in the turn (started it, approved a tool, said something) is shown as its own.
    const marks = lead.marks(turn.id);
    return [{ ...publicTurn(turn), ...(item.inherited ? { inherited: true } : {}), ...(marks ? { lead: marks } : {}) }];
  });
  const conversationTurns = (id: string): Record<string, unknown>[] => publicTurns(turnSequence(id));
  /** Polls `check` until it returns a value, `wait` ms pass (at most 30 s), or the client goes away. */
  const waitFor = async <T>(request: IncomingMessage, url: URL, check: () => T | undefined): Promise<T | undefined> => {
    const wait = Math.min(Math.max(Number(url.searchParams.get('wait')) || 0, 0), LONG_POLL_MAX);
    const deadline = Date.now() + wait;
    let gone = false;
    const onClose = (): void => { gone = true; };
    request.socket.once('close', onClose);
    try {
      for (;;) {
        const value = check();
        if (value !== undefined || gone || Date.now() >= deadline) return value;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    } finally { request.socket.removeListener('close', onClose); }
  };
  const devices = new Devices(config.stateDirectory);
  /** Addresses a phone tries in order: LAN and mesh interfaces (when listening beyond loopback), then added ones. */
  const phoneAddresses = async (): Promise<Address[]> => {
    const own = listensBeyondLoopback(config.host) ? interfaceAddresses(config.port) : [];
    const seen = new Set<string>();
    return [...own, ...extraAddresses.list()].filter(item => !seen.has(item.url) && seen.add(item.url));
  };
  const failedAuth = new FailedAuth();
  const extraAddresses = new ExtraAddresses(config.stateDirectory);
  /** Per-turn hashes of snapshots recently sent, so a change feed returns only changed turns. */
  const sentSnapshots = new Map<string, Map<string, string>>();
  const translations = new TranslationCache(join(workspace, 'translations'));
  // Automatic conversation titles with the system LLM, as the Python service names them.
  const titles = new Titles(store, workspace);
  /**
   * A job follows its conversation's turns. The author stopped by itself: its criteria decide —
   * one needs the user → waiting; none listed or some unmet → back to it, CHECK_ROUNDS times
   * at most, then the user is asked; all met → the reviewer. Failed or stopped → waiting.
   * Once the user has accepted, a turn ends with a look at whether the branch is merged instead.
   */
  /** The turns of one job: a conversation can have had others before it, and goes on after it is closed. */
  const jobTurns = (job: Job): Turn[] => turnsOf(job.conversationId).filter(turn => turn.createdAt >= job.createdAt && (!job.closedAt || turn.createdAt <= job.closedAt));
  const settleJob = (turn: Turn): void => {
    const id = turn.conversationId;
    const job = jobs.get(id);
    // A message the user queued meanwhile runs first; the job is settled after that turn.
    if (!job || job.state !== 'working' || followUps.list(id).length) return;
    // A turn from before the job (stopped just before it started, ending late) is not the job's.
    if (turn.createdAt < job.createdAt) return;
    if (turn.role === 'review') { void settleReview(job, turn); return; }
    if (turn.status === 'failed' || turn.status === 'cancelled') {
      jobs.patch(id, ['working'], { state: 'waiting', reason: turn.status === 'failed' ? 'failed' : 'stopped', error: turn.status === 'failed' ? turn.error : undefined });
      return;
    }
    if (turn.status !== 'done') return;
    if (job.accepting) { void settleAccept(job); return; }
    const items = criteria(jobTurns(job));
    if (items.some(item => item.state === 'ask')) { jobs.patch(id, ['working'], { state: 'waiting', reason: 'question', error: undefined }); return; }
    if (items.length && items.every(item => item.state === 'done')) { void review(job); return; }
    const round = (job.round ?? 0) + 1;
    if (round >= CHECK_ROUNDS) { jobs.patch(id, ['working'], { state: 'waiting', round, reason: 'checks', error: undefined }); return; }
    if (reviewing.has(id)) return;
    reviewing.add(id);
    jobs.patch(id, ['working'], { round });
    void (async () => {
      try {
        const conversation = store.conversation(id);
        if (conversation) await startTurn(conversation, { text: unmetFeedback(items, round), images: [], model: turn.requestedModel, auto: true }, { checkRound: round });
      } catch (error) {
        jobs.patch(id, ['working'], { state: 'waiting', reason: 'failed', error: message(error) });
      } finally { reviewing.delete(id); }
    })();
  };
  /**
   * The author says every criterion is met. A reviewer now checks each against the changes in
   * a read-only turn of its own shown in the same conversation, always on the conversation's own
   * project and account. Claude takes it in the author's session and hands it to a sub-agent
   * (its Task/Agent tool), which starts without the author's context. The other engines have no
   * such tool, and reviewing in the author's session would be the author checking itself, so
   * theirs is a fresh session that resumes nothing. When it cannot start, the job goes to the user.
   */
  const reviewing = new Set<string>();
  const review = async (job: Job): Promise<void> => {
    const id = job.conversationId;
    const toUser = (review?: Job['review']): void => {
      jobs.patch(id, ['working'], { state: 'review', phase: undefined, reason: undefined, error: undefined, ...(review ? { review } : {}) });
    };
    if (reviewing.has(id)) return;
    reviewing.add(id);
    const turnId = randomUUID().replaceAll('-', '').slice(0, 12);
    let account = '';
    try {
      const authored = store.conversation(id);
      const target = authored ? conversationProject(authored) : project(job.projectId);
      account = target.account.name;
      await assertContainer(config.dockerPath, target);
      const turns = turnsOf(id);
      // Re-read after the await: a message of the user's may have started a turn meanwhile.
      if (turns.some(active) || followUps.list(id).length || jobs.get(id)?.state !== 'working') return;
      // Only Claude has a sub-agent tool: it reviews in the author's session, every other engine in a fresh one.
      const subagent = target.account.type === 'claude';
      const turn: Turn = {
        id: turnId, origin: 'node', conversationId: id, projectId: target.name, account, type: target.account.type,
        prompt: reviewPrompt(job, turns.find(item => !item.role && !item.checkRound && item.createdAt >= job.createdAt)?.prompt || job.title, criteria(jobTurns(job)), subagent), images: [], auto: true,
        requestedModel: '', createdAt: new Date().toISOString(), resumeId: subagent && authored ? authorSession(authored, turns) : '', status: 'starting', answer: '', tools: [], blocks: [], role: 'review',
      };
      store.createTurn(turn, target.path);
      jobs.patch(id, ['working'], { phase: 'reviewing' });
      await runner.launch(turn, { cwd: job.directory, readOnly: true });
    } catch (error) {
      toUser({ account, verdict: 'failed', turnId, error: message(error), at: new Date().toISOString() });
    } finally { reviewing.delete(id); }
  };
  /** The reviewer's turn ended: passed (or nothing usable) → the user; changes wanted → back to the author, within the same budget of rounds as unmet criteria. */
  const settleReview = async (job: Job, turn: Turn): Promise<void> => {
    const id = job.conversationId;
    const review = (verdict: NonNullable<Job['review']>['verdict']): NonNullable<Job['review']> =>
      ({ account: turn.account ?? '', verdict, turnId: turn.id, ...(verdict === 'failed' && turn.error ? { error: turn.error } : {}), at: new Date().toISOString() });
    if (reviewing.has(id)) return;
    const verdict = turn.status === 'done' ? reviewVerdict(turn.answer) : 'failed';
    if (verdict !== 'changes') {
      jobs.patch(id, ['working'], { state: 'review', phase: undefined, review: review(verdict), reason: undefined, error: undefined });
      return;
    }
    const failed = (job.round ?? 0) + 1;
    if (failed >= CHECK_ROUNDS) { jobs.patch(id, ['working'], { state: 'waiting', phase: undefined, review: review(verdict), round: failed, reason: 'review', error: undefined }); return; }
    jobs.patch(id, ['working'], { phase: undefined, review: review(verdict), round: failed });
    reviewing.add(id);
    try {
      const conversation = store.conversation(id);
      if (!conversation) return;
      const model = turnsOf(id).findLast(item => item.role !== 'review')?.requestedModel ?? '';
      await startTurn(conversation, { text: reviewFeedback(turn.answer), images: [], model, auto: true }, { role: 'review-feedback' });
    } catch (error) {
      jobs.patch(id, ['working'], { state: 'waiting', phase: undefined, reason: 'failed', error: message(error) });
    } finally { reviewing.delete(id); }
  };
  /** The agent was asked to merge: merged → the job is closed; not yet → the user reads why in the conversation. */
  const settleAccept = async (job: Job): Promise<void> => {
    const id = job.conversationId;
    if (reviewing.has(id)) return;
    reviewing.add(id);
    try { await jobs.finish(project(job.projectId), job); }
    catch (error) { jobs.patch(id, ['working'], { state: 'waiting', reason: 'merge', error: undefined, mergeError: '没能确认有没有合并：' + message(error) }); }
    finally { reviewing.delete(id); }
  };
  runner.onFinish = turn => {
    // The task's token stops working and whatever it started on the machine is killed.
    const owner = readWorkspace(workspace).projects.find(item => item.name === turn.projectId);
    if (owner && projectHelperAccess(owner) !== 'off') void helper.revoke(turn.id);
    titles.observe(turn); settleJob(turn);
  };
  /** After a restart (or a missed finish): a working job whose last turn has ended is settled from that turn. */
  const settleJobs = (): void => {
    for (const job of jobs.list()) {
      if (job.state !== 'working' || followUps.list(job.conversationId).length || reviewing.has(job.conversationId)) continue;
      const turns = turnsOf(job.conversationId);
      const last = turns.at(-1);
      if (last && !turns.some(active)) settleJob(last);
    }
  };
  const jobOf = (conversationId: string): { job: Job; target: WorkspaceProject } => {
    const job = jobs.get(identifier(conversationId));
    if (!job) throw new HttpError(404, '这个对话没有在做的事');
    return { job, target: project(job.projectId) };
  };
  const jobCall = async <T>(run: () => Promise<T>): Promise<T> => {
    try { return await run(); } catch (error) {
      if (error instanceof JobError) throw new HttpError(409, error.message);
      throw error;
    }
  };

  /**
   * Images a tool returned (Claude's Read of a picture, screenshots…), read back from the
   * turn's log instead of being kept in the record: at most 6, each up to ~6 MB.
   */
  const toolImages = (turnId: string, toolId: string): { mime: string; data: string }[] => {
    let log = '';
    try { log = readFileSync(store.logPath(turnId), 'utf8'); } catch { return []; }
    const images: { mime: string; data: string }[] = [];
    for (const line of log.split('\n')) {
      if (images.length >= 6 || !line.includes(toolId) || !line.includes('"image"')) continue;
      let event: Record<string, unknown>;
      try { event = record(JSON.parse(line)); } catch { continue; }
      const blocks = record(event.message).content;
      for (const block of Array.isArray(blocks) ? blocks.map(record) : []) {
        if (block.type !== 'tool_result' || block.tool_use_id !== toolId || !Array.isArray(block.content)) continue;
        for (const item of block.content.map(record)) {
          const source = record(item.source);
          const mime = text(source.media_type);
          if (item.type === 'image' && source.type === 'base64' && /^image\/(png|jpeg|gif|webp)$/.test(mime) && text(source.data).length <= 8_000_000 && images.length < 6) {
            images.push({ mime, data: text(source.data) });
          }
        }
      }
    }
    return images;
  };

  /** The agent session later turns resume (Python: native_session_id): never a fresh-session reviewer's. */
  const authorSession = (conversation: Conversation, turns: readonly Turn[]): string =>
    conversation.nativeSessionId || turns.findLast(turn => turn.sessionId && turn.role !== 'review')?.sessionId || '';
  /** Starts a new turn in a conversation that has none running. */
  const startTurn = async (conversation: Conversation, input: Omit<FollowUp, 'id' | 'createdAt'>, by: { checkRound?: number; role?: 'review-feedback' | 'accept'; jobStart?: boolean } = {}): Promise<Turn> => {
    const system = Boolean(by.checkRound || by.role);
    const target = conversationProject(conversation);
    try { await assertContainer(config.dockerPath, target); }
    catch (error) { throw new HttpError(409, message(error)); }
    // Re-read after the await: the check and the save below run without yielding.
    const turns = turnsOf(conversation.id);
    // A job's turns run in its worktree, without asking for each tool. Once it is closed the
    // worktree is gone and the conversation goes on in the project's directory: the first turn
    // after that tells the agent so.
    const last = jobs.get(conversation.id);
    const job = last && jobOpen(last) ? last : undefined;
    const moved = last && !job && !turns.some(turn => turn.createdAt > (last.closedAt ?? '')) ? closedNote(last) : '';
    if (turns.some(active)) throw new HttpError(409, 'A turn in this conversation is still active');
    if (turns.some(turn => turn.status === 'queued')) throw new HttpError(409, '这个对话还有原服务排队中的任务');
    let resume = authorSession(conversation, turns);
    // A fork's first turn resumes the source at the fork point under the chosen session ID;
    // if that session already exists (the service stopped before recording it), resume it instead.
    const fork = conversation.fork;
    let forkAt: Turn['forkAt'];
    if (fork && !resume) {
      if (transcript(workspace, target.account.name, fork.target_session_id)) resume = fork.target_session_id;
      else { resume = fork.source_session_id; forkAt = { sessionId: fork.target_session_id, messageId: fork.message_uuid }; }
    }
    const turn: Turn = {
      id: randomUUID().replaceAll('-', '').slice(0, 12), origin: 'node', conversationId: conversation.id, projectId: conversation.projectId,
      account: target.account.name, type: target.account.type, prompt: input.text, images: input.images, auto: input.auto || Boolean(job),
      requestedModel: input.model || (fork && !conversation.nativeSessionId ? fork.model : ''), createdAt: new Date().toISOString(), resumeId: resume,
      status: 'starting', answer: '', tools: [], blocks: [], ...(forkAt ? { forkAt } : {}), ...(by.checkRound ? { checkRound: by.checkRound } : {}), ...(by.role ? { role: by.role } : {}),
    };
    store.createTurn(turn, target.path);
    titles.observe(turn);
    if (turns.length === 0 && conversation.name === '新对话') {
      const title = (input.text || '图片').replace(/\s+/g, ' ').slice(0, 40);
      store.saveConversation({ ...conversation, name: title });
    }
    if (job) {
      // The user speaking starts the count of rounds again.
      jobs.patch(conversation.id, ['working', 'waiting', 'review'], { state: 'working', phase: undefined, reason: undefined, error: undefined, mergeError: undefined, ...(by.role === 'accept' ? { accepting: true } : {}), ...(system ? {} : { round: 0, review: undefined }) });
    }
    await runner.launch(turn, job ? { cwd: job.directory, preamble: by.jobStart ? preamble(job, turns.length > 0) : '' } : moved ? { preamble: moved } : {});
    return turn;
  };

  /** Starts the next follow-up of conversations whose turn has ended. */
  let draining = false;
  const retryAt = new Map<string, number>();
  const drainFollowUps = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      for (const conversationId of followUps.conversations()) {
        const conversation = store.conversation(conversationId);
        if (!conversation) { for (const item of followUps.list(conversationId)) followUps.remove(conversationId, item.id); continue; }
        if (turnsOf(conversationId).some(turn => active(turn) || turn.status === 'queued')) continue;
        const next = followUps.list(conversationId)[0];
        if (!next || Date.now() - (retryAt.get(next.id) ?? 0) < 30_000) continue;
        // Removed only once its turn exists, so a stopped container never loses it.
        try { await startTurn(conversation, next); followUps.remove(conversationId, next.id); retryAt.delete(next.id); }
        catch (error) { retryAt.set(next.id, Date.now()); console.error('Follow-up not started:', conversationId, message(error)); }
      }
    } finally { draining = false; }
  };

  const newConversation = (target: WorkspaceProject, name: string): Conversation => {
    const conversation = { id: randomUUID().replaceAll('-', '').slice(0, 12), projectId: target.name, name: name.trim().slice(0, 100) || '新对话',
      createdAt: new Date().toISOString(), account: target.account.name, type: target.account.type, project: target.path, nativeSessionId: '' };
    store.saveConversation(conversation);
    return conversation;
  };
  /** 做完为止: opens a worktree and branch for the conversation and starts its first turn there. */
  const startJob = async (conversation: Conversation, input: Omit<FollowUp, 'id' | 'createdAt'>): Promise<Turn> => {
    const target = conversationProject(conversation);
    const support = await jobs.support(target);
    if (!support.supported) throw new HttpError(409, '这个项目用不了「做完为止」：' + support.reason);
    await jobCall(() => jobs.start(target, conversation.id, randomUUID().replaceAll('-', '').slice(0, 8), input.text || '图片'));
    try { return await startTurn(conversation, input, { jobStart: true }); }
    catch (error) {
      const job = jobs.get(conversation.id);
      if (job) { await jobs.discard(target, job).catch(() => undefined); jobs.forget(conversation.id); }
      throw error;
    }
  };

  /** Whether a job can be closed now; throws what stands in the way. */
  const closable = (job: Job, verb: string): void => {
    if (!jobOpen(job)) throw new HttpError(409, '这件事已经' + (job.state === 'accepted' ? '收下' : '丢弃') + '了');
    if (turnsOf(job.conversationId).some(active) || followUps.list(job.conversationId).length) throw new HttpError(409, '它还在做，先停下再' + verb);
  };
  /**
   * Accepting is a message to the agent: it merges the branch where it belongs (or asks),
   * and the job is closed once that is seen to be done.
   */
  const acceptJob = async (conversationId: string): Promise<Turn> => {
    const { job } = jobOf(conversationId);
    closable(job, '收下');
    const conversation = store.conversation(job.conversationId);
    if (!conversation) throw new HttpError(404, 'Conversation not found');
    if (job.state === 'working') throw new HttpError(409, '它还在做，先停下再收下');
    const model = turnsOf(job.conversationId).findLast(item => item.role !== 'review')?.requestedModel ?? '';
    return startTurn(conversation, { text: acceptPrompt(job), images: [], model, auto: true }, { role: 'accept' });
  };
  /**
   * A message to a conversation: a new turn when nothing runs; into the running turn when its agent
   * takes messages mid-turn (Claude); otherwise queued as the next turn.
   */
  const sendMessage = async (conversation: Conversation, input: { prompt: string; model: string; images: string[]; auto: boolean; job: boolean }):
  Promise<{ delivered: 'turn' | 'message'; turn: Record<string, unknown> } | { delivered: 'queued'; followUp: FollowUp }> => {
    const { prompt, model, images } = input;
    // Writing in an archived conversation brings it back to the list.
    if (conversation.archived && (prompt || images.length)) store.setArchived(conversation.id, false);
    if ((!prompt && !images.length) || prompt.length > 60_000 || model.length > 180) throw new HttpError(400, 'Invalid prompt or model');
    const message_ = { text: prompt, images, auto: input.auto, model };
    const running = turnsOf(conversation.id).find(active);
    // { job: true }: 做完为止. This message opens a worktree and branch for the conversation,
    // new or already going (its agent session is resumed there), also after an earlier job of
    // it was closed. While a job is open the message just goes to it.
    const last = jobs.get(conversation.id);
    if (input.job && !(last && jobOpen(last))) {
      if (running) throw new HttpError(409, '等这一轮结束，再开「做完为止」');
      return { delivered: 'turn', turn: publicTurn(await startJob(conversation, message_)) };
    }
    if (!running) return { delivered: 'turn', turn: publicTurn(await startTurn(conversation, message_)) };
    // A reviewer's turn takes no messages: what the user says waits for the author.
    if (running.role !== 'review' && running.controlReady && running.capabilities?.includes('message') && !running.cancelRequested) {
      try {
        await runner.message(running, { text: prompt, images });
        titles.observeMessage(running, prompt, randomUUID());
        return { delivered: 'message', turn: publicTurn(running) };
      } catch { /* the run is finishing: queue it as the next turn instead */ }
    }
    try { return { delivered: 'queued', followUp: followUps.add(conversation.id, message_) }; }
    catch (error) { throw new HttpError(409, message(error)); }
  };
  /** The answer to what a turn waits for: an approval, the agent's question, or the machine helper's card. */
  const answerPermission = async (turn: Turn, input: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const key = identifier(input.id);
    if (!turn.permission || turn.permission.id !== key) throw new HttpError(409, 'This approval is no longer available');
    if (key.startsWith(HELPER_CARD)) {
      // The machine helper's card: the answer goes to the helper, which holds the call until then.
      const answer = Object.values(record(input.answers)).map(text)[0] || (input.decision === 'allow' ? HELPER_ANSWERS[0]?.label : input.decision === 'deny' ? '拒绝' : '');
      if (!answer) throw new HttpError(400, 'Answer the question first');
      // Anything that is not one of the two ways to allow is a refusal.
      const decision = HELPER_ANSWERS.find(item => item.label === answer)?.decision ?? 'deny';
      try { await helper.decide(key.slice(HELPER_CARD.length), decision); }
      catch (error) { throw new HttpError(409, message(error)); }
      if (turn.permission?.id === key) { delete turn.permission; store.saveTurn(turn); }
      return { accepted: true, decision };
    }
    if (turn.permission.questions) {
      const answers = Object.fromEntries(Object.entries(record(input.answers)).map(([question, value]) => [question, text(value)]));
      if (!Object.keys(answers).length) throw new HttpError(400, 'Answer the question first');
      try { await runner.decide(turn, key, { answers }); }
      catch (error) { throw new HttpError(409, message(error)); }
    } else {
      const decision = input.decision;
      if (decision !== 'allow' && decision !== 'deny') throw new HttpError(400, 'Invalid approval decision');
      if (decision === 'allow' && !turn.permission.allow) throw new HttpError(409, 'This approval is no longer available');
      try { await runner.decide(turn, key, { decision }); }
      catch (error) { throw new HttpError(409, message(error)); }
    }
    return { accepted: true };
  };

  // 领航 acts through the functions the App's and the phone's requests call.
  const leadCall = async <T>(run: () => Promise<T>): Promise<T> => {
    try { return await run(); } catch (error) {
      if (error instanceof LeadError) throw new HttpError(409, error.message);
      throw error;
    }
  };
  const leadConversation = (id: string): Conversation => {
    const conversation = store.conversation(id);
    if (!conversation) throw new LeadError('这个对话已经不在了');
    return conversation;
  };
  /**
   * 领航's attachments for a message to a conversation: copied into its project as uploads (same name), so
   * the conversation gets them as files the user added there, previews and all.
   */
  const handOver = (projectId: string, attachments: readonly string[]): string[] => {
    const from = leadUploads(config.stateDirectory);
    const into = join(project(projectId).path, '.coderfleet-uploads');
    return attached(attachments, LEAD_UPLOAD_PATH, from, '在领航里').map(path => {
      const file = path.slice(LEAD_UPLOADS.length);
      mkdirSync(into, { recursive: true });
      if (!existsSync(join(into, file))) copyFileSync(join(from, file), join(into, file));
      return '/workspace/.coderfleet-uploads/' + file;
    });
  };
  const lead: Lead = new Lead(config.stateDirectory, {
    llm: () => systemLLM(workspace),
    conversations: () => {
      const latest = new Map<string, { id: string; finishedAt: string }>();
      return conversationList(false, latest, true).map(item => ({ id: item.id, projectId: item.projectId, name: item.name, status: item.status, attention: item.attention, job: item.job, account: item.account, last: latest.get(item.id) }));
    },
    turns: turnsOf,
    liveTurns: () => store.liveTurns(),
    job: id => { const job = jobs.get(id); return job && jobOpen(job) ? { job, criteria: criteria(jobTurns(job)) } : undefined; },
    changes: async id => { const { job, target } = jobOf(id); return jobs.changes(target, job); },
    answer: async (turnId, input) => {
      const turn = store.turn(turnId);
      if (!turn || !active(turn)) throw new LeadError('这一轮已经结束了');
      await answerPermission(turn, input);
    },
    send: async (id, words, attachments = []) => {
      const conversation = leadConversation(id);
      // As the conversation's own last message was sent: the same model, tools asked for or not.
      const last = turnsOf(id).findLast(turn => !turn.checkRound && !turn.role);
      const images = handOver(conversation.projectId, attachments);
      const sent = await sendMessage(conversation, { prompt: words, model: last?.requestedModel ?? '', images, auto: last?.auto === true, job: false });
      return sent.delivered === 'queued' ? '' : text(sent.turn.id);
    },
    accept: async id => (await acceptJob(id)).id,
    stop: async turnId => {
      const turn = store.turn(turnId);
      if (!turn || !active(turn)) throw new LeadError('这一轮已经结束了');
      if (turn.origin !== 'node') throw new LeadError('这一轮由原 Python 服务运行，请在它的界面里处理');
      await runner.cancel(turn);
    },
    exec: async (id, command) => {
      const target = conversationProject(leadConversation(id));
      await assertContainer(config.dockerPath, target);
      const job = jobs.get(id);
      return shellText(config.dockerPath, target.container, job && jobOpen(job) ? job.directory : '/workspace', command);
    },
    projects: () => readWorkspace(workspace).projects.map(item => ({
      id: item.name, defaultAccount: defaultAccount(item)?.name ?? '',
      accounts: item.accounts.filter(chatAccount).map(account => ({ name: account.name, type: account.type, used: usedMost(account) })),
    })).filter(item => item.accounts.length),
    start: async (projectId, account, words, attachments = []) => {
      const target = chatProject(projectId, account);
      if (!target) throw new LeadError('项目里没有这个账号，或它不支持对话');
      const job = (await jobs.support(target)).supported;
      const images = handOver(target.name, attachments);
      const conversation = newConversation(target, words.split('\n')[0] ?? '');
      try {
        const sent = await sendMessage(conversation, { prompt: words, model: '', images, auto: false, job });
        return { conversationId: conversation.id, turnId: sent.delivered === 'queued' ? '' : text(sent.turn.id), job };
      } catch (error) {
        // Nothing started: the empty conversation is not left behind.
        store.deleteConversation(conversation.id);
        throw error;
      }
    },
  });

  // 定时
  /** Whether the item's latest run is still going: starting, a turn running or queued, or its job working. */
  const scheduleBusy = (item: Schedule): boolean => {
    const last = item.runs.findLast(run => run.result === 'starting' || run.conversationId);
    if (!last) return false;
    if (last.result === 'starting') return true;
    const id = last.conversationId as string;
    return turnsOf(id).some(turn => active(turn) || turn.status === 'queued') || followUps.list(id).length > 0 || jobs.get(id)?.state === 'working';
  };
  /** A stopped container is started for the run; a run never waits more than three minutes for it. */
  const containerFor = async (target: WorkspaceProject): Promise<void> => {
    try { await assertContainer(config.dockerPath, target); return; } catch { /* started below */ }
    const operation = lifecycle.startProject(target.name);
    const deadline = Date.now() + 180_000;
    while (operation.status === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 500));
    if (operation.status !== 'succeeded') throw new Error('容器没有启动起来' + (operation.error ? '：' + operation.error : ''));
    await assertContainer(config.dockerPath, target);
  };
  /** Starts a run claimed as `at`: a new conversation with the prompt as its first message, tools not asked for. */
  const runSchedule = async (id: string, at: string): Promise<void> => {
    const item = schedules.get(id);
    if (!item) return;
    let conversation: Conversation | undefined;
    try {
      const target = chatProject(item.projectId);
      if (!target) throw new Error('项目不存在或不支持对话');
      await containerFor(target);
      conversation = newConversation(target, '');
      const input = { text: item.prompt, images: [], auto: true, model: '' };
      if (item.job) await startJob(conversation, input); else await startTurn(conversation, input);
      schedules.finish(id, at, { result: 'started', conversationId: conversation.id });
    } catch (error) {
      // A turn that exists shows what went wrong in its conversation; before that, nothing is left behind.
      if (conversation && turnsOf(conversation.id).length) { schedules.finish(id, at, { result: 'started', conversationId: conversation.id }); return; }
      if (conversation) store.deleteConversation(conversation.id);
      schedules.finish(id, at, { result: 'failed', note: message(error) });
      console.error('Schedule not started:', id, message(error));
    }
  };
  const tickSchedules = (): void => {
    for (const due of schedules.claimDue(new Date(), scheduleBusy)) void runSchedule(due.id, due.at);
  };
  /** A run with what became of it: its conversation's name, latest turn and job. */
  const runView = (run: Run): Record<string, unknown> => {
    if (!run.conversationId) return { ...run };
    const conversation = store.conversation(run.conversationId);
    if (!conversation) return { ...run, gone: true };
    const last = turnsOf(conversation.id).at(-1);
    return { ...run, name: conversation.name, status: last?.status ?? '', error: last?.error ?? '', job: jobs.get(conversation.id)?.state ?? '' };
  };
  const scheduleView = (item: Schedule, all = false): Record<string, unknown> => {
    const { runs, ...rest } = item;
    const last = runs.at(-1);
    return { ...rest, label: ruleLabel(item.rule), busy: scheduleBusy(item), last: last ? runView(last) : null,
      ...(all ? { runs: runs.map(runView).reverse() } : {}) };
  };
  const scheduleOf = (id: string | undefined): Schedule => {
    const item = schedules.get(identifier(id));
    if (!item) throw new HttpError(404, '这个定时不存在');
    return item;
  };
  /** The fields of a create or change request that are present, validated. */
  const scheduleInput = (input: Record<string, unknown>): { projectId?: string; prompt?: string; rule?: Schedule['rule']; job?: boolean; enabled?: boolean } => {
    const result: { projectId?: string; prompt?: string; rule?: Schedule['rule']; job?: boolean; enabled?: boolean } = {};
    if (input.projectId !== undefined) {
      const target = chatProject(text(input.projectId));
      if (!target) throw new HttpError(404, '项目不存在或不支持对话');
      result.projectId = target.name;
    }
    if (input.prompt !== undefined) {
      const prompt = text(input.prompt).trim();
      if (!prompt || prompt.length > 60_000) throw new HttpError(400, '写上要做的事');
      result.prompt = prompt;
    }
    if (input.rule !== undefined) {
      try { result.rule = parseRule(input.rule); }
      catch (error) { throw new HttpError(400, error instanceof ScheduleError ? error.message : '不认识的时间规则'); }
    }
    if (typeof input.job === 'boolean') result.job = input.job;
    if (typeof input.enabled === 'boolean') result.enabled = input.enabled;
    return result;
  };

  const uploads = (projectId: string, value: unknown): string[] => attached(value, UPLOAD_PATH, join(project(projectId).path, '.coderfleet-uploads'), '这个项目里');
  const leadAttachments = (value: unknown): string[] => attached(value, LEAD_UPLOAD_PATH, leadUploads(config.stateDirectory), '在领航里');

  const routes: [string, RegExp, Handler][] = [
    ['GET', /^health$/, async () => ({ service: 'coderfleet-node', version: 1, build: VERSION, buildId: BUILD_ID, pid: process.pid })],
    ['POST', /^shutdown$/, async () => {
      if (!options.onShutdown) throw new HttpError(404, 'Unknown API endpoint');
      setTimeout(options.onShutdown, 100).unref();
      return { stopping: true };
    }],

    // Workspace, image and settings
    ['GET', /^overview$/, async () => {
      const initialized = existsSync(join(workspace, 'config.conf')) && existsSync(join(workspace, 'Dockerfile'));
      const docker = await lifecycle.dockerAvailable();
      if (Date.now() - python.checked > 10_000) python = { checked: Date.now(), value: await findPythonService(workspace) };
      return {
        workspace, initialized, docker, image: docker ? await lifecycle.image() : undefined,
        backend: { build: VERSION, buildId: BUILD_ID, pid: process.pid, host: config.host, port: config.port },
        python: python.value ?? null,
        accountTypes: Object.values(ACCOUNT_TYPES).map(({ id, label, envAuth, envHint, chat }) => ({ id, label, envAuth, envHint, chat })),
        operations: lifecycle.recent(),
      };
    }],
    // Translation through the system LLM (SYSTEM_LLM_* in config.conf), cached like the Python service.
    ['GET', /^system-llm$/, async () => {
      const llm = systemLLM(workspace);
      return { configured: configured(llm), provider: llm.provider, model: llm.model };
    }],
    ['POST', /^translate$/, async request => {
      const input = await body(request, 2_000_000);
      const source = text(input.text);
      const target = text(input.target).trim() || '简体中文';
      if (source.length > 400_000 || target.length > 40) throw new HttpError(400, '内容太长');
      if (!source.trim()) return { translated: '', cached: false };
      const cached = translations.get(source, target);
      if (cached !== undefined) return { translated: cached, cached: true };
      const llm = systemLLM(workspace);
      if (!configured(llm)) throw new HttpError(503, '还没有配置翻译用的模型：在 设置 → 翻译 里填写');
      let translated: string;
      try { translated = await translateText(llm, source, target); }
      catch (error) { throw new HttpError(error instanceof SystemLLMError ? 502 : 500, message(error)); }
      if (translated.trim()) translations.put(source, target, translated);
      return { translated, cached: false };
    }],
    ['POST', /^workspace\/init$/, async () => ({ created: initWorkspace(workspace, template) })],
    ['GET', /^settings$/, async () => readSettings(workspace)],
    ['PUT', /^settings$/, async request => {
      const input = await body(request);
      writeSettings(workspace, Object.fromEntries(Object.entries(input).map(([key, value]) => [key, text(value).trim()])));
      return readSettings(workspace);
    }],
    ['POST', /^image\/build$/, async () => lifecycle.build()],
    ['POST', /^image\/pull$/, async () => lifecycle.pull()],
    // Background operations (image builds, container starts…) without their logs, newest first.
    ['GET', /^operations$/, async () => lifecycle.recent()],
    ['GET', /^operations\/([\w-]+)$/, async (_request, [id]) => {
      const operation = lifecycle.operation(id as string);
      if (!operation) throw new HttpError(404, '操作不存在');
      return operation;
    }],

    // Accounts
    ['GET', /^accounts$/, async () => {
      const { accounts, projects } = readWorkspace(workspace);
      return accounts.map(item => {
        return {
          name: item.name, type: item.type, typeLabel: accountType(item.type).label, auth: item.auth, proxy: item.proxy, runtime: item.runtime,
          projects: projects.filter(entry => entry.accounts.some(held => held.name === item.name)).map(entry => entry.name),
          envKeys: envKeys(item), hasLogin: hasLogin(item),
          // null: this kind of account has no subscription windows to show.
          usage: usageSupported(item) ? usage.cached(item.name) ?? {} : null,
        };
      });
    }],
    ['POST', /^accounts$/, async request => {
      const input = await body(request);
      const created = addAccount(workspace, {
        name: text(input.name).trim(), type: text(input.type), auth: input.auth === 'env' ? 'env' : 'login', proxy: input.proxy === 'off' ? 'off' : 'relay',
      });
      const env = record(input.env);
      if (created.auth === 'env' && Object.keys(env).length) updateEnv(created, Object.fromEntries(Object.entries(env).map(([key, value]) => [key, text(value)])));
      return { name: created.name };
    }],
    ['DELETE', /^accounts\/([\w-]+)$/, async (_request, [name]) => { removeAccount(workspace, name as string); return { removed: true }; }],
    ['PUT', /^accounts\/([\w-]+)\/env$/, async (request, [name]) => {
      const input = await body(request);
      updateEnv(account(name as string), Object.fromEntries(Object.entries(record(input.values)).map(([key, value]) => [key, text(value)])));
      return { envKeys: envKeys(account(name as string)) };
    }],
    ['POST', /^accounts\/([\w-]+)\/usage$/, async (_request, [name]) => {
      const item = account(name as string);
      if (!usageSupported(item)) throw new HttpError(400, '只有登录的 Claude Code、Codex 和 Antigravity 账号有套餐额度');
      try { return await usage.refresh(item, readWorkspace(workspace).projects); } catch (error) {
        if (error instanceof NoContainerError) throw new HttpError(409, '先启动这个账号的一个项目，额度要从它的容器里查询');
        throw error;
      }
    }],
    ['POST', /^accounts\/([\w-]+)\/login$/, async (request, [name]) => {
      const [cols, rows] = size(await body(request));
      return { terminalId: await terminals.login(account(name as string), cols, rows) };
    }],

    // Projects and containers
    ['GET', /^projects$/, async () => {
      const { projects } = readWorkspace(workspace);
      let containers = new Map<string, { state: string }>();
      try { containers = await lifecycle.containers(); } catch { /* Docker unavailable: states stay unknown */ }
      // Only what stays the same between polls: Docker's status text ("Up 5 minutes") changes by itself
      // and would make every client redraw its page each time it asks.
      return projects.map(item => ({
        id: item.name, name: item.name, account: item.account.name, type: item.account.type, typeLabel: accountType(item.account.type).label,
        path: item.path, active: item.active, runtime: item.account.runtime, container: item.container,
        state: containers.get(item.container)?.state ?? 'missing', mounts: projectMountSpecs(item), helper: projectHelperAccess(item), image: projectImage(item),
        chat: item.accounts.some(chatAccount),
        // Every account in the container, the first being `account`; `defaultAccount`: the one a new conversation starts with.
        accounts: item.accounts.map(entry => ({ name: entry.name, type: entry.type, typeLabel: accountType(entry.type).label, chat: chatAccount(entry),
          signedIn: entry.auth === 'env' ? envKeys(entry).length > 0 : hasLogin(entry), used: usedMost(entry) })),
        defaultAccount: defaultAccount(item)?.name ?? '',
      }));
    }],
    ['POST', /^projects$/, async request => {
      const input = await body(request);
      const name = text(input.name).trim();
      // `accounts`: the first names the container. `account` alone is the older form of the same request.
      const accounts = Array.isArray(input.accounts) ? input.accounts.map(item => text(item)) : [text(input.account)];
      addProject(workspace, { name, accounts, path: text(input.path) });
      return input.start === false ? { name } : { name, operation: lifecycle.startProject(name) };
    }],
    ['DELETE', /^projects\/([\w-]+)$/, async (_request, [name]) => {
      if (store.liveTurns().some(turn => turn.projectId === name && active(turn))) throw new HttpError(409, '项目里还有正在运行的对话');
      return lifecycle.removeProject(name as string);
    }],
    ['POST', /^projects\/([\w-]+)\/(start|stop|restart)$/, async (_request, [name, action]) => {
      if (action === 'start') return lifecycle.startProject(name as string);
      if (action === 'stop') return lifecycle.stopProject(name as string);
      return lifecycle.restartProject(name as string);
    }],
    // Every container at once. Main token only (not in DEVICE_ROUTES).
    ['POST', /^containers\/(start|stop|restart)$/, async (_request, [action]) => {
      if (action === 'start') return lifecycle.startAll();
      if (action === 'stop') return lifecycle.stopAll();
      return lifecycle.restartAll();
    }],
    ['POST', /^projects\/([\w-]+)\/(enable|disable)$/, async (_request, [name, action]) => {
      project(name as string);
      setProjectActive(workspace, name as string, action === 'enable');
      return { active: action === 'enable' };
    }],
    // The accounts the project's container holds, the first unchanged; applies when the container is recreated.
    // An account whose conversation is running cannot be taken out.
    ['PUT', /^projects\/([\w-]+)\/accounts$/, async (request, [name]) => {
      const target = project(name as string);
      const input = (await body(request)).accounts;
      const names = (Array.isArray(input) ? input : []).map(item => text(item));
      const busy = store.liveTurns().find(turn => turn.projectId === target.name && active(turn) && turn.account && !names.includes(turn.account));
      if (busy) throw new HttpError(409, '账号 ' + busy.account + ' 还有正在运行的对话，等它结束再去掉');
      setProjectAccounts(workspace, target.name, names);
      return { accounts: names };
    }],
    // Extra host directories in the project's container (EXTRA_MOUNTS); they apply when it is recreated.
    ['PUT', /^projects\/([\w-]+)\/mounts$/, async (request, [name]) => {
      const target = project(name as string);
      const input = (await body(request)).mounts;
      const specs = (Array.isArray(input) ? input : []).map(item => text(item).trim()).filter(Boolean);
      projectMounts(target.name, specs.join(','), target.accounts.map(item => accountType(item.type).authDir));
      setProjectMounts(workspace, target.name, specs);
      return { mounts: specs };
    }],
    // The project's own image (IMAGE) and the Dockerfile it is built from; main token only. `image` is '' on the shared one.
    ['GET', /^projects\/([\w-]+)\/image$/, async (_request, [name]) => {
      const target = project(name as string);
      const image = projectImage(target);
      const shared = (await lifecycle.image()).name;
      return { image, shared, suggested: defaultProjectImage(target.name), exists: await lifecycle.imageExists(image || shared), dockerfile: readProjectDockerfile(workspace, target.name) };
    }],
    // Either field alone changes just that one. A new image applies when the container is recreated.
    ['PUT', /^projects\/([\w-]+)\/image$/, async (request, [name]) => {
      const target = project(name as string);
      const input = await body(request);
      if (typeof input.image === 'string') setProjectImage(workspace, target.name, input.image.trim());
      if (typeof input.dockerfile === 'string') writeProjectDockerfile(workspace, target.name, input.dockerfile);
      return { image: projectImage(project(target.name)), dockerfile: readProjectDockerfile(workspace, target.name) };
    }],
    ['POST', /^projects\/([\w-]+)\/image\/build$/, async (_request, [name]) => lifecycle.buildProject(project(name as string).name)],
    // What the project's tasks may do on this machine through the helper (HELPER_ACCESS); applies to tasks started afterwards.
    ['PUT', /^projects\/([\w-]+)\/helper$/, async (request, [name]) => {
      const target = project(name as string);
      const access = text((await body(request)).access);
      if (access === 'gui') throw new HttpError(400, '图形界面操作还没有做，现在只能选 off 或 command');
      setProjectHelper(workspace, target.name, access);
      // Turned off: running tasks lose their access now, not when they end.
      if (access === 'off') for (const turn of store.liveTurns()) if (turn.projectId === target.name && active(turn)) await helper.revoke(turn.id);
      return { helper: access };
    }],
    // The machine helper: main token only (none of these is in DEVICE_ROUTES).
    ['GET', /^helper$/, () => helper.status()],
    ['POST', /^helper\/(install|start|stop|upgrade)$/, async (_request, [action]) => {
      if (action === 'install') { await helper.install(); await helper.start(); }
      else if (action === 'start') await helper.start();
      else if (action === 'stop') await helper.stop();
      else await helper.upgrade();
      return helper.status();
    }],
    ['POST', /^helper\/restart-relay$/, async () => lifecycle.restartRelay()],
    ['GET', /^helper\/policy$/, () => helper.policy()],
    ['POST', /^helper\/policy$/, async request => helper.changePolicy(await body(request))],
    ['GET', /^helper\/audit$/, (_request, _params, url) => helper.audit(Math.min(Math.max(Number(url.searchParams.get('n')) || 50, 1), 1000))],
    ['POST', /^projects\/([\w-]+)\/terminal$/, async (request, [name]) => {
      const [cols, rows] = size(await body(request));
      return { terminalId: await terminals.shell(project(name as string).name, cols, rows) };
    }],
    // ?account=: the models of that account of the project (default: the one new conversations start with).
    ['GET', /^projects\/([\w-]+)\/models$/, async (_request, [name], url) => {
      const target = chatProject(name as string, url.searchParams.get('account') ?? undefined);
      if (!target) throw new HttpError(404, '项目不支持对话');
      if (target.account.type === 'claude') {
        const key = target.name + '\0' + target.account.name;
        let entry = claudeModelLists.get(key);
        if (!entry || Date.now() - entry.at >= CLAUDE_MODELS_TTL) {
          entry = { at: Date.now(), list: claudeModels(config.dockerPath, target) };
          claudeModelLists.set(key, entry);
        }
        const current = entry;
        try { return await current.list; }
        catch (error) {
          // A failure is not remembered: the next request asks Claude Code again.
          if (claudeModelLists.get(key) === current) claudeModelLists.delete(key);
          throw new HttpError(502, '无法列出模型：' + message(error));
        }
      }
      if (target.account.type !== 'antigravity' && target.account.type !== 'codex') return [];
      try { return await (target.account.type === 'codex' ? codexModels : models)(config.dockerPath, target); }
      catch (error) { throw new HttpError(502, '无法列出模型：' + message(error)); }
    }],

    // Terminals
    ['GET', /^terminals\/([\w-]+)$/, async (_request, [id], url) => {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const wait = Math.min(Number(url.searchParams.get('wait') ?? 0) || 0, 15_000);
      return terminals.session(id as string).read(Number.isFinite(offset) ? offset : 0, wait);
    }],
    ['POST', /^terminals\/([\w-]+)\/input$/, async (request, [id]) => {
      const input = await body(request);
      terminals.session(id as string).write(Buffer.from(text(input.data), 'base64'));
      return { accepted: true };
    }],
    ['DELETE', /^terminals\/([\w-]+)$/, async (_request, [id]) => { terminals.close(id as string); return { closed: true }; }],

    // Phones: pairing, devices and the addresses they can use (main token only)
    ['GET', /^device$/, async (request) => (request as AuthedRequest).device ?? { id: '', name: '主令牌' }],
    ['GET', /^mobile$/, async () => ({
      listening: { host: config.host, port: config.port, beyondLoopback: listensBeyondLoopback(config.host) },
      addresses: await phoneAddresses(), interfaces: interfaceAddresses(config.port), extra: extraAddresses.list(),
      tailscale: (await tailscaleName()) ?? null, devices: devices.list(), failures: failedAuth.recent(),
    })],
    ['PUT', /^mobile$/, async request => {
      const input = await body(request);
      const list = (Array.isArray(input.addresses) ? input.addresses : []).map(item => ({ url: text(record(item).url), label: text(record(item).label) }));
      try { return { extra: extraAddresses.save(list) }; }
      catch (error) { throw new HttpError(400, message(error)); }
    }],
    ['POST', /^devices$/, async request => {
      const input = await body(request);
      const addresses = await phoneAddresses();
      if (!addresses.length) throw new HttpError(409, '手机还没有可用的地址：打开“允许局域网访问”，或添加组网 / 公网地址');
      const { device, token: deviceToken } = devices.create(text(input.name));
      return { device, link: pairingLink(text(input.backendName).trim().slice(0, 60) || 'CoderFleet', deviceToken, addresses), addresses };
    }],
    ['DELETE', /^devices\/([\w-]+)$/, async (_request, [id]) => {
      if (!devices.revoke(identifier(id))) throw new HttpError(404, '设备不存在');
      return { revoked: true };
    }],

    // Conversations
    // ?archived=1: the archived ones (Python: include_archived), to restore or delete them.
    ['GET', /^conversations$/, async (_request, _params, url) => conversationList(url.searchParams.get('archived') === '1')],
    // Long poll for phones: answers at once when the list differs from `since`, else waits for a change.
    // ?limit=N: only the N most recent (a phone shows a page and asks for more as it scrolls), with `total`;
    // ?q=: only those whose name or project contains it. With either, the ones waiting for the user come
    // first and each carries `preview`, the line its latest answer ended on.
    ['GET', /^conversations\/changes$/, async (request, _params, url) => {
      const since = url.searchParams.get('since') ?? '';
      const limit = count(url.searchParams.get('limit'));
      const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const result = await waitFor(request, url, () => {
        const latest = new Map<string, { id: string; finishedAt: string }>();
        const all = conversationList(false, latest);
        const found = query ? all.filter(item => item.name.toLowerCase().includes(query) || item.projectId.toLowerCase().includes(query)) : all;
        if (!limit && !query) {
          const etag = digest(found);
          return etag === since ? undefined : { etag, conversations: found };
        }
        const ordered = [...found.filter(item => item.attention), ...found.filter(item => !item.attention)];
        const conversations = (limit ? ordered.slice(0, limit) : ordered).map(item => ({ ...item, preview: preview(latest.get(item.id)) }));
        const etag = digest([conversations, found.length]);
        return etag === since ? undefined : { etag, conversations, total: found.length };
      });
      return result ?? { etag: since, unchanged: true };
    }],
    ['POST', /^conversations$/, async request => {
      const input = await body(request);
      // `account`: which of the project's accounts the conversation uses, for good.
      const target = chatProject(text(input.projectId), input.account === undefined ? undefined : text(input.account));
      if (!target) throw new HttpError(404, input.account === undefined ? '项目不存在或不支持对话' : '项目里没有这个账号，或它不支持对话');
      return newConversation(target, text(input.name));
    }],
    ['PUT', /^conversations\/([\w-]+)$/, async (request, [id]) => {
      const conversation = store.conversation(identifier(id));
      if (!conversation) throw new HttpError(404, 'Conversation not found');
      const input = await body(request);
      // { archived }: archive or restore (Python PATCH status archived/active); otherwise { name }.
      if (typeof input.archived === 'boolean') {
        store.setArchived(conversation.id, input.archived);
        return store.conversation(conversation.id);
      }
      const name = text(input.name).trim().slice(0, 100);
      if (!name) throw new HttpError(400, '名称不能为空');
      const renamed = { ...conversation, name };
      store.saveConversation(renamed);
      return renamed;
    }],
    // Deletes the conversation record (as the Python service); never while one of its turns runs.
    ['DELETE', /^conversations\/([\w-]+)$/, async (_request, [id]) => {
      const conversation = store.conversation(identifier(id));
      if (!conversation) throw new HttpError(404, 'Conversation not found');
      if (turnsOf(conversation.id).some(turn => active(turn) || turn.status === 'queued')) throw new HttpError(409, '这个对话还在运行，先停止再删除');
      const job = jobs.get(conversation.id);
      if (job && jobOpen(job)) throw new HttpError(409, '这个对话里的事还没有收下或丢弃，先处理它');
      jobs.forgetAll(conversation.id);
      for (const item of followUps.list(conversation.id)) followUps.remove(conversation.id, item.id);
      store.deleteConversation(conversation.id);
      return { deleted: true };
    }],
    // ?before=<turn id>&limit=N: the N turns just before that one (a phone scrolling up), and how many are earlier still.
    ['GET', /^conversations\/([\w-]+)\/turns$/, async (_request, [id], url) => {
      const before = url.searchParams.get('before');
      if (before === null) return conversationTurns(identifier(id));
      const sequence = turnSequence(identifier(id));
      const end = sequence.findIndex(item => item.id === before);
      if (end < 0) throw new HttpError(404, 'Turn not found');
      const start = Math.max(0, end - (count(url.searchParams.get('limit')) || EARLIER_PAGE));
      return { turns: publicTurns(sequence.slice(start, end)), earlier: start };
    }],
    // Long poll for phones: the turns that changed since `since` (all of them when it is unknown),
    // the turn order and queued messages; waits for a change when there is none.
    // ?last=N: only the N latest turns are followed (and read from their logs); `earlier` counts the ones
    // before them, which GET turns?before= returns.
    ['GET', /^conversations\/([\w-]+)\/changes$/, async (request, [id], url) => {
      const conversationId = identifier(id);
      const since = url.searchParams.get('since') ?? '';
      const last = count(url.searchParams.get('last'));
      const result = await waitFor(request, url, () => {
        const sequence = turnSequence(conversationId);
        const earlier = last ? Math.max(0, sequence.length - last) : 0;
        const turns = publicTurns(sequence.slice(earlier));
        const queued = followUps.list(conversationId);
        const hashes = new Map(turns.map(turn => [String(turn.id), digest(turn)]));
        const etag = digest(last ? [[...hashes], queued, earlier] : [[...hashes], queued]);
        if (etag === since) return undefined;
        const known = sentSnapshots.get(since);
        sentSnapshots.set(etag, hashes);
        if (sentSnapshots.size > 500) sentSnapshots.delete(sentSnapshots.keys().next().value as string);
        return {
          etag, full: !known, order: turns.map(turn => turn.id), followUps: queued, ...(last ? { earlier } : {}),
          turns: known ? turns.filter(turn => known.get(String(turn.id)) !== hashes.get(String(turn.id))) : turns,
        };
      });
      return result ?? { etag: since, unchanged: true };
    }],
    // Project environment variables (applied when the project's container is recreated).
    // Browsing a project's files (the Python Web UI's 文件 panel); not for phones.
    ['GET', /^projects\/([\w.-]+)\/files$/, async (_request, [name], url) =>
      fileCall(() => listFiles(project(name as string).path, url.searchParams.get('path') ?? ''))],
    ['GET', /^projects\/([\w.-]+)\/files\/preview$/, async (_request, [name], url) =>
      fileCall(() => previewFile(project(name as string).path, url.searchParams.get('path') ?? ''))],
    ['GET', /^projects\/([\w.-]+)\/files\/raw$/, async (_request, [name], url) =>
      fileCall(() => rawFile(project(name as string).path, url.searchParams.get('path') ?? ''))],
    ['GET', /^projects\/([\w.-]+)\/env$/, async (_request, [name]) => ({ vars: readProjectEnv(workspace, project(name as string).name) })],
    ['PUT', /^projects\/([\w.-]+)\/env$/, async (request, [name]) => {
      const target = project(name as string);
      const vars = Object.fromEntries(Object.entries(record((await body(request)).vars)).map(([key, value]) => [key.trim(), text(value)]));
      writeProjectEnv(workspace, target.name, vars);
      return { vars: readProjectEnv(workspace, target.name) };
    }],
    // Names the conversation again with the system LLM (replaces a manual title).
    ['POST', /^conversations\/([\w-]+)\/title$/, async (_request, [id]) => {
      const conversation = store.conversation(identifier(id));
      if (!conversation) throw new HttpError(404, 'Conversation not found');
      if (!configured(systemLLM(workspace))) throw new HttpError(503, '还没有配置命名用的模型：在 设置 → 翻译与命名 里填写');
      try { titles.request(conversation.id); } catch (error) { throw new HttpError(409, message(error)); }
      titles.tick();
      return { queued: true };
    }],
    // Forks a Claude conversation at a finished turn into a new conversation.
    ['POST', /^conversations\/([\w-]+)\/fork$/, async (request, [id]) => {
      const source = store.conversation(identifier(id));
      if (!source) throw new HttpError(404, 'Conversation not found');
      const input = await body(request);
      const turn = store.turn(identifier(input.turnId));
      if (!turn) throw new HttpError(404, '找不到这轮回答');
      let log = '';
      try { log = readFileSync(store.logPath(turn.id), 'utf8'); } catch { /* checked below */ }
      try {
        const child = forkOf(workspace, source, turnsOf(source.id), turn, log, randomUUID().replaceAll('-', '').slice(0, 12), text(input.name));
        store.saveConversation(child);
        return child;
      } catch (error) {
        if (error instanceof ForkError) throw new HttpError(409, error.message);
        throw error;
      }
    }],
    // Sends a message: a new turn when nothing runs; into the running turn when its agent
    // takes messages mid-turn (Claude); otherwise queued as the next turn.
    ['POST', /^conversations\/([\w-]+)\/turns$/, async (request, [id]) => {
      const conversation = store.conversation(identifier(id));
      if (!conversation) throw new HttpError(404, 'Conversation not found');
      const input = await body(request);
      return sendMessage(conversation, { prompt: text(input.prompt).trim(), model: text(input.model).trim(), images: uploads(conversation.projectId, input.images), auto: input.auto === true, job: input.job === true });
    }],
    // 做完为止: the job of a conversation, what it changed, and its two endings (accept: the agent is asked to merge).
    ['GET', /^jobs$/, async () => jobs.list().map(job => ({ ...job, conversation: store.conversation(job.conversationId)?.name ?? '' }))],
    ['GET', /^projects\/([\w.-]+)\/job-support$/, async (_request, [name], url) => {
      const named = url.searchParams.get('account');
      const target = named === null ? chatProject(name as string) ?? project(name as string) : chatProject(name as string, named);
      if (!target) throw new HttpError(404, '项目里没有这个账号，或它不支持对话');
      return jobs.support(target);
    }],
    ['GET', /^conversations\/([\w-]+)\/job$/, async (_request, [id]) => {
      const job = jobs.get(identifier(id));
      return { job: job ? { ...job, criteria: criteria(jobTurns(job)) } : null, earlier: jobs.earlier(identifier(id)) };
    }],
    ['GET', /^conversations\/([\w-]+)\/job\/changes$/, async (_request, [id]) => {
      const { job, target } = jobOf(id as string);
      return jobCall(() => jobs.changes(target, job));
    }],
    ['POST', /^conversations\/([\w-]+)\/job\/(accept|discard)$/, async (_request, [id, action]) => {
      if (action === 'accept') { await acceptJob(id as string); return { job: jobs.get(identifier(id)) }; }
      const { job, target } = jobOf(id as string);
      closable(job, '丢弃');

      try { await assertContainer(config.dockerPath, target); }
      catch (error) { throw new HttpError(409, message(error)); }
      return { job: await jobCall(() => jobs.discard(target, job)) };
    }],
    // 定时: things started by the clock, each run in a new conversation (main token only).
    ['GET', /^schedules$/, async () => schedules.list().map(item => scheduleView(item))],
    ['GET', /^schedules\/([\w-]+)$/, async (_request, [id]) => scheduleView(scheduleOf(id), true)],
    // How a rule reads and when it next falls, before it is saved (the sheet's 下次 line).
    ['POST', /^schedules\/preview$/, async request => {
      const { rule } = scheduleInput({ rule: (await body(request)).rule });
      if (!rule) throw new HttpError(400, '不认识的时间规则');
      return { label: ruleLabel(rule), nextAt: nextAfter(rule, new Date()).toISOString() };
    }],
    ['POST', /^schedules$/, async request => {
      const input = scheduleInput(await body(request));
      if (!input.projectId || !input.prompt || !input.rule) throw new HttpError(400, '要有项目、要做的事和时间');
      return scheduleView(schedules.create({ projectId: input.projectId, prompt: input.prompt, rule: input.rule, job: input.job === true }));
    }],
    ['PUT', /^schedules\/([\w-]+)$/, async (request, [id]) => {
      const changed = schedules.change(scheduleOf(id).id, scheduleInput(await body(request)));
      if (!changed) throw new HttpError(404, '这个定时不存在');
      return scheduleView(changed);
    }],
    ['DELETE', /^schedules\/([\w-]+)$/, async (_request, [id]) => { schedules.remove(scheduleOf(id).id); return { removed: true }; }],
    // 立即跑一次: starts a run now; the next time by the clock stays as it is.
    ['POST', /^schedules\/([\w-]+)\/run$/, async (_request, [id]) => {
      const item = scheduleOf(id);
      if (scheduleBusy(item)) throw new HttpError(409, '上一次还在做，等它结束再跑');
      const at = schedules.begin(item.id);
      if (!at) throw new HttpError(404, '这个定时不存在');
      await runSchedule(item.id, at);
      const run = schedules.get(item.id)?.runs.find(entry => entry.at === at);
      if (run?.result !== 'started') throw new HttpError(409, '没有跑起来：' + (run?.note ?? ''));
      return { conversationId: run.conversationId, schedule: scheduleView(scheduleOf(id)) };
    }],
    ['GET', /^conversations\/([\w-]+)\/follow-ups$/, async (_request, [id]) => followUps.list(identifier(id))],
    ['DELETE', /^conversations\/([\w-]+)\/follow-ups\/([\w-]+)$/, async (_request, [id, item]) => {
      if (!followUps.remove(identifier(id), identifier(item))) throw new HttpError(404, '这条消息已经发出');
      return { removed: true };
    }],
    // Files for a message, saved in the project like the Python service (.coderfleet-uploads).
    ['POST', /^projects\/([\w.-]+)\/uploads$/, async (request, [name], url) => {
      const { file, ...saved } = await saveUpload(request, url, join(project(name as string).path, '.coderfleet-uploads'));
      return { path: '/workspace/.coderfleet-uploads/' + file, ...saved };
    }],
    // `<16 hex>-<name>.png` (this service) or `<16 hex>.png` (the Python service).
    ['GET', /^projects\/([\w.-]+)\/uploads\/([a-f0-9]{16}(?:[-%][^/]*)?\.(?:png|jpe?g|webp|gif))$/i, async (_request, [name, encoded]) =>
      readUpload(join(project(name as string).path, '.coderfleet-uploads'), encoded as string)],
    ['GET', /^turns\/([\w-]+)\/tools\/(.+)$/, async (_request, [id, toolId]) => {
      const turn = store.turn(identifier(id));
      const tool = turn?.tools.find(item => item.id === decodeURIComponent(toolId as string));
      if (!tool) throw new HttpError(404, '找不到这次工具调用');
      return { id: tool.id, title: tool.title, status: tool.status, input: tool.input ?? {}, output: tool.output ?? '', images: toolImages(turn?.id as string, tool.id) };
    }],
    // A file the answer offered with a CF_SEND marker; a phone reaches no other project file.
    ['GET', /^turns\/([\w-]+)\/files$/, async (_request, [id], url) => {
      const turn = store.turn(identifier(id));
      if (!turn) throw new HttpError(404, '找不到这一轮');
      const answer = [turn.answer, ...(turn.blocks ?? []).map(block => block.kind === 'text' ? block.text : '')].join('\n');
      return fileCall(() => sentFile(project(turn.projectId).path, answer, url.searchParams.get('path') ?? ''));
    }],
    ['POST', /^turns\/([\w-]+)\/(permission|cancel)$/, async (request, [id, action]) => {
      const turn = store.turn(identifier(id));
      if (!turn) throw new HttpError(404, 'Turn not found');
      if (!active(turn)) throw new HttpError(409, 'The turn has already finished');
      // A turn the Python service runs (or took over) is stopped there; this service only shows it.
      if (turn.origin !== 'node') {
        if (action !== 'cancel') throw new HttpError(409, '这一轮由原 Python 服务运行，请在它的界面里处理');
        const service = await findPythonService(workspace);
        if (!service?.url) throw new HttpError(409, '这一轮由原 Python 服务运行，它现在没有运行，无法停止');
        try { await stopPythonTask(workspace, service.url, turn.id); }
        catch (error) { throw new HttpError(409, message(error)); }
        return { accepted: true };
      }
      if (action === 'cancel') { await runner.cancel(turn); return { accepted: true }; }
      return answerPermission(turn, await body(request));
    }],
    // 领航: one thread between the user and every conversation it follows.
    ['GET', /^lead$/, async () => lead.view()],
    ['GET', /^lead\/changes$/, async (request, _params, url) => {
      const since = url.searchParams.get('since') ?? '';
      const result = await waitFor(request, url, () => {
        const view = lead.view();
        const etag = digest(view);
        return etag === since ? undefined : { etag, ...view };
      });
      return result ?? { etag: since, unchanged: true };
    }],
    ['POST', /^lead\/messages$/, async request => leadCall(async () => {
      const input = await body(request);
      return { item: lead.say(text(input.text), leadAttachments(input.attachments)) };
    })],
    // { run }: 停止 for the run the view named; `stopped: false` when that one is already over.
    ['POST', /^lead\/stop$/, async request => leadCall(async () => ({ stopped: lead.stop(text((await body(request)).run)) }))],
    // Files for 领航, which belongs to no project: kept in the backend's state directory until handed to a conversation.
    ['POST', /^lead\/uploads$/, async (request, _params, url) => {
      const { file, ...saved } = await saveUpload(request, url, leadUploads(config.stateDirectory));
      return { path: LEAD_UPLOADS + file, ...saved };
    }],
    ['GET', /^lead\/uploads\/([a-f0-9]{16}(?:[-%][^/]*)?\.(?:png|jpe?g|webp|gif))$/i, async (_request, [encoded]) => readUpload(leadUploads(config.stateDirectory), encoded as string)],
    ['POST', /^lead\/asks\/([\w-]+)$/, async (request, [id]) => leadCall(async () => {
      const input = await body(request);
      await lead.answerAsk(identifier(id), { answer: text(input.answer), answers: Object.fromEntries(Object.entries(record(input.answers)).map(([question, value]) => [question, text(value)])) });
      return { accepted: true };
    })],
    ['POST', /^lead\/undo\/([\w-]+)$/, async (_request, [id]) => leadCall(async () => { await lead.undo(identifier(id)); return { accepted: true }; })],
    // { enabled }: 领航 starts or stops handling things; { follow } on a conversation: 领航在跟 / 我自己来.
    ['PUT', /^lead\/settings$/, async request => leadCall(async () => {
      const input = await body(request);
      if (typeof input.enabled !== 'boolean') throw new HttpError(400, 'Invalid setting');
      lead.setEnabled(input.enabled);
      return lead.view();
    })],
    ['PUT', /^conversations\/([\w-]+)\/lead$/, async (request, [id]) => {
      const conversation = store.conversation(identifier(id));
      if (!conversation) throw new HttpError(404, 'Conversation not found');
      const input = await body(request);
      if (typeof input.follow !== 'boolean') throw new HttpError(400, 'Invalid setting');
      lead.setFollow(conversation.id, input.follow);
      return { follow: input.follow };
    }],
  ];

  const server = createServer(async (request, response) => {
    try {
      const address = request.socket.remoteAddress ?? '';
      const header = request.headers.authorization ?? '';
      const auth = Buffer.from(header);
      let device: Device | undefined;
      if (token.length !== auth.length || !timingSafeEqual(auth, token)) {
        device = header.startsWith('Bearer ') ? devices.authenticate(header.slice(7), address) : undefined;
        if (!device) {
          const wait = failedAuth.blocked(address);
          if (wait) { response.setHeader('Retry-After', String(wait)); throw new HttpError(429, '认证失败次数过多，请 ' + wait + ' 秒后再试'); }
          failedAuth.record(address);
          throw new HttpError(401, 'Invalid backend token');
        }
      }
      failedAuth.clear(address);
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (!url.pathname.startsWith('/v1/')) throw new HttpError(404, 'Unknown API endpoint');
      const path = url.pathname.slice('/v1/'.length);
      if (device && !deviceAllowed(request.method ?? '', path)) throw new HttpError(403, '手机只能使用聊天功能');
      (request as AuthedRequest).device = device;
      for (const [method, pattern, handler] of routes) {
        const match = pattern.exec(path);
        if (!match || method !== request.method) continue;
        const result = await handler(request, match.slice(1), url);
        reply(request, response, request.method === 'POST' && /^(accounts|projects|conversations|schedules)$/.test(path) ? 201 : 200, result);
        return;
      }
      throw new HttpError(404, 'Unknown API endpoint');
    } catch (error) {
      if (error instanceof HttpError) reply(request, response, error.status, { error: error.message });
      else if (error instanceof WorkspaceError) reply(request, response, 400, { error: error.message });
      else if (message(error) === 'Invalid identifier') reply(request, response, 400, { error: 'Invalid identifier' });
      else {
        console.error('Request failed:', message(error));
        reply(request, response, 500, { error: message(error) || 'Backend request failed' });
      }
    }
  });
  // Follows every active turn; after a restart this resumes from the saved log offsets.
  let titlesTicked = 0;
  let jobsSettled = 0;
  let schedulesTicked = 0;
  let helperSynced = 0;
  const timer = setInterval(() => {
    for (const turn of store.liveTurns()) if (active(turn)) void runner.tick(turn);
    void drainFollowUps();
    if (Date.now() - jobsSettled > 2_000) { jobsSettled = Date.now(); settleJobs(); }
    if (Date.now() - schedulesTicked > 5_000) {
      schedulesTicked = Date.now();
      try { tickSchedules(); } catch (error) { console.error('Schedules not checked:', message(error)); }
    }
    if (Date.now() - titlesTicked > 1_000) {
      titlesTicked = Date.now(); titles.tick();
      try { lead.scan(); } catch (error) { console.error('Lead scan failed:', message(error)); }
    }
    if (Date.now() - helperSynced > 1_000) {
      helperSynced = Date.now();
      void syncHelperCards().catch(error => console.error('Helper confirmations not read:', message(error)));
    }
  }, 250);
  timer.unref();
  // Subscription usage, asked from the accounts' own containers; see usage.ts for how often.
  const pollUsage = (): void => {
    const { accounts, projects } = readWorkspace(workspace);
    // A turn from before turns named their account ran as its project's first one.
    const busy = new Set(store.liveTurns().filter(active).flatMap(turn => turn.account ?? projects.find(item => item.name === turn.projectId)?.account.name ?? []));
    void usage.poll(accounts, projects, busy).catch(error => console.error('Usage poll failed:', message(error)));
  };
  const usageTimer = setInterval(pollUsage, 30_000);
  usageTimer.unref();
  setTimeout(pollUsage, 2_000).unref();
  server.once('close', () => { clearInterval(timer); clearInterval(usageTimer); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server;
}

/** A turn for the client: no control fields, and tool input/output only as a flag (fetched per tool). */
function fileCall<T>(run: () => T): T {
  try { return run(); } catch (error) {
    if (error instanceof FileAccessError) throw new HttpError(error.status, error.message);
    throw error;
  }
}

/** Markdown as one short plain line: no code blocks, markers or hidden comments. */
function previewLine(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```|<!--[\s\S]*?-->/g, ' ').replace(/[#*`>|_~]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
}

function publicTurn(turn: Turn): Record<string, unknown> {
  const { resumeId: _resume, controlToken: _token, logOffset: _offset, launchedAt: _launched, cancelRequested: _cancel,
    heldMessages, messageStarted: _started, ...visible } = turn;
  return {
    ...visible,
    // A message sent mid-turn shows at the end until the agent's next message starts.
    blocks: [...(turn.blocks ?? []), ...(heldMessages ?? [])],
    ...(turn.cancelRequested && active(turn) ? { stopping: true } : {}),
    tools: turn.tools.map(({ input, output, ...tool }) => ({ ...tool, hasDetail: Boolean(output) || Object.keys(record(input)).length > 0 })),
  };
}
