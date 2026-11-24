import { randomUUID, timingSafeEqual } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNT_TYPES, accountType } from './accounts.js';
import {
  addAccount, addProject, envKeys, initWorkspace, readSettings, readWorkspace, removeAccount, setProjectActive, updateEnv, writeSettings, WorkspaceError, type WorkspaceProject, readProjectEnv, writeProjectEnv,
} from './conf.js';
import { assertContainer, models } from './docker.js';
import { FollowUps, type FollowUp } from './follow-ups.js';
import { ForkError, forkOf, transcript } from './fork.js';
import { Lifecycle } from './lifecycle.js';
import { Titles } from './titles.js';
import { configured, SystemLLMError, systemLLM, TranslationCache, translateText } from './translate.js';
import { findPythonService, stopPythonTask, type PythonService } from './python-service.js';
import { active, identifier, message, readConfig, record, text, type Conversation, type Turn } from './state.js';
import { WorkspaceStore } from './store.js';
import { chatSupported, TaskRunner } from './tasks.js';
import { Terminals } from './terminal.js';
import { BUILD_ID, VERSION } from './version.js';

class HttpError extends Error {
  public constructor(public readonly status: number, message: string) { super(message); }
}

function reply(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
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

function size(input: Record<string, unknown>): [number, number] {
  const cols = Number(input.cols); const rows = Number(input.rows);
  return [Number.isFinite(cols) ? cols : 100, Number.isFinite(rows) ? rows : 30];
}

const CLAUDE_MODELS = [
  { id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'haiku', label: 'Haiku' },
];

type Handler = (request: IncomingMessage, params: string[], url: URL) => Promise<unknown>;

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
  const template = fileURLToPath(new URL('../template/', import.meta.url));
  const chatProject = (id: string): WorkspaceProject | undefined =>
    readWorkspace(workspace).projects.find(item => item.name === id && chatSupported(item.account.type) && item.account.runtime === 'container');
  const runner = new TaskRunner(store, config.dockerPath, chatProject);
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
  const translations = new TranslationCache(join(workspace, 'translations'));
  // Automatic conversation titles with the system LLM, as the Python service names them.
  const titles = new Titles(store, workspace);
  runner.onFinish = turn => titles.observe(turn);

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

  /** Starts a new turn in a conversation that has none running. */
  const startTurn = async (conversation: Conversation, input: Omit<FollowUp, 'id' | 'createdAt'>): Promise<Turn> => {
    const target = chatProject(conversation.projectId);
    if (!target) throw new HttpError(404, 'Project not found');
    if (conversation.type && conversation.type !== target.account.type) throw new HttpError(409, '这个对话属于 ' + conversation.type + ' 账号，项目现在绑定的是 ' + target.account.type);
    try { await assertContainer(config.dockerPath, target); }
    catch (error) { throw new HttpError(409, message(error)); }
    // Re-read after the await: the check and the save below run without yielding.
    const turns = turnsOf(conversation.id);
    if (turns.some(active)) throw new HttpError(409, 'A turn in this conversation is still active');
    if (turns.some(turn => turn.status === 'queued')) throw new HttpError(409, '这个对话还有原服务排队中的任务');
    // Later turns resume the conversation's agent session (Python: native_session_id).
    let resume = conversation.nativeSessionId || turns.findLast(turn => turn.sessionId)?.sessionId || '';
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
      account: target.account.name, type: target.account.type, prompt: input.text, images: input.images, auto: input.auto,
      requestedModel: input.model || (fork && !conversation.nativeSessionId ? fork.model : ''), createdAt: new Date().toISOString(), resumeId: resume,
      status: 'starting', answer: '', tools: [], blocks: [], ...(forkAt ? { forkAt } : {}),
    };
    store.createTurn(turn, target.path);
    titles.observe(turn);
    if (turns.length === 0 && conversation.name === '新对话') {
      const title = (input.text || '图片').replace(/\s+/g, ' ').slice(0, 40);
      store.saveConversation({ ...conversation, name: title });
    }
    await runner.launch(turn);
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

  const UPLOAD_TYPES: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
  // <16 hex>-<name> (or the older <16 hex>.<ext>); only characters the Python service also accepts.
  const UPLOAD_PATH = /^\/workspace\/\.coderfleet-uploads\/[a-f0-9]{16}[-.][\p{L}\p{N}_.-]{0,120}$/u;
  /** Validated upload references of a message: at most 20, each a file of this project. */
  const uploads = (projectId: string, value: unknown): string[] => {
    const list = Array.isArray(value) ? value : [];
    if (list.length > 20 || !list.every(item => typeof item === 'string' && UPLOAD_PATH.test(item) && !item.includes('..'))) throw new HttpError(400, '附件必须是这个项目里上传的文件');
    const directory = join(project(projectId).path, '.coderfleet-uploads');
    for (const item of list as string[]) if (!existsSync(join(directory, item.split('/').pop() as string))) throw new HttpError(400, '附件已不存在，请重新添加');
    return list as string[];
  };

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
        const authDirectory = join(workspace, 'accounts', item.name);
        let hasLogin = false;
        try { hasLogin = readdirSync(authDirectory).length > 0; } catch { /* none yet */ }
        return {
          name: item.name, type: item.type, typeLabel: accountType(item.type).label, auth: item.auth, proxy: item.proxy, runtime: item.runtime,
          projects: projects.filter(entry => entry.account.name === item.name).map(entry => entry.name),
          envKeys: envKeys(item), hasLogin,
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
    ['POST', /^accounts\/([\w-]+)\/login$/, async (request, [name]) => {
      const [cols, rows] = size(await body(request));
      return { terminalId: await terminals.login(account(name as string), cols, rows) };
    }],

    // Projects and containers
    ['GET', /^projects$/, async () => {
      const { projects } = readWorkspace(workspace);
      let containers = new Map<string, { state: string; status: string }>();
      try { containers = await lifecycle.containers(); } catch { /* Docker unavailable: states stay unknown */ }
      return projects.map(item => ({
        id: item.name, name: item.name, account: item.account.name, type: item.account.type, typeLabel: accountType(item.account.type).label,
        path: item.path, active: item.active, runtime: item.account.runtime, container: item.container,
        state: containers.get(item.container)?.state ?? 'missing', status: containers.get(item.container)?.status ?? '',
        chat: chatSupported(item.account.type) && item.account.runtime === 'container',
      }));
    }],
    ['POST', /^projects$/, async request => {
      const input = await body(request);
      const name = text(input.name).trim();
      addProject(workspace, { name, account: text(input.account), path: text(input.path) });
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
    ['POST', /^projects\/([\w-]+)\/(enable|disable)$/, async (_request, [name, action]) => {
      project(name as string);
      setProjectActive(workspace, name as string, action === 'enable');
      return { active: action === 'enable' };
    }],
    ['POST', /^projects\/([\w-]+)\/terminal$/, async (request, [name]) => {
      const [cols, rows] = size(await body(request));
      return { terminalId: await terminals.shell(project(name as string).name, cols, rows) };
    }],
    ['GET', /^projects\/([\w-]+)\/models$/, async (_request, [name]) => {
      const target = chatProject(name as string);
      if (!target) throw new HttpError(404, '项目不支持对话');
      if (target.account.type === 'claude') return CLAUDE_MODELS;
      if (target.account.type !== 'antigravity') return [];
      try { return await models(config.dockerPath, target); }
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

    // Conversations
    ['GET', /^conversations$/, async () => {
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
        summaries.set(conversationId, {
          updatedAt: time(activity) > time(current.updatedAt) ? activity : current.updatedAt,
          latest: newest ? item.createdAt : current.latest,
          status: newest ? item.status : current.status,
          turns: current.turns + 1,
          attention: current.attention || item.attention,
        });
      }
      return store.conversations().map(item => {
        const summary = summaries.get(item.id);
        return { id: item.id, projectId: item.projectId, name: item.name, createdAt: item.createdAt, type: item.type ?? '',
          forkedFrom: item.fork ? { conversationId: item.fork.source_conversation_id, turnId: item.fork.source_task_id } : null,
          updatedAt: summary?.updatedAt || item.updatedAt || item.createdAt, status: summary?.status ?? '', turns: summary?.turns ?? 0, attention: summary?.attention ?? false };
      }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }],
    ['POST', /^conversations$/, async request => {
      const input = await body(request);
      const target = chatProject(text(input.projectId));
      if (!target) throw new HttpError(404, '项目不存在或不支持对话');
      const conversation = { id: randomUUID().replaceAll('-', '').slice(0, 12), projectId: target.name, name: text(input.name).trim().slice(0, 100) || '新对话',
        createdAt: new Date().toISOString(), account: target.account.name, type: target.account.type, project: target.path, nativeSessionId: '' };
      store.saveConversation(conversation);
      return conversation;
    }],
    ['PUT', /^conversations\/([\w-]+)$/, async (request, [id]) => {
      const conversation = store.conversation(identifier(id));
      if (!conversation) throw new HttpError(404, 'Conversation not found');
      const name = text((await body(request)).name).trim().slice(0, 100);
      if (!name) throw new HttpError(400, '名称不能为空');
      const renamed = { ...conversation, name };
      store.saveConversation(renamed);
      return renamed;
    }],
    ['GET', /^conversations\/([\w-]+)\/turns$/, async (_request, [id]) => {
      const conversation = store.conversation(identifier(id));
      if (!conversation) throw new HttpError(404, 'Conversation not found');
      // A fork shows the turns it branched from, read-only, before its own.
      const inherited = (conversation.fork?.inherited_task_ids ?? []).flatMap(turnId => {
        const turn = store.turn(turnId);
        return turn ? [{ ...publicTurn(turn), inherited: true }] : [];
      });
      return [...inherited, ...turnsOf(id as string).map(publicTurn)];
    }],
    // Project environment variables (applied when the project's container is recreated).
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
      const prompt = text(input.prompt).trim();
      const model = text(input.model).trim();
      const images = uploads(conversation.projectId, input.images);
      if ((!prompt && !images.length) || prompt.length > 60_000 || model.length > 180) throw new HttpError(400, 'Invalid prompt or model');
      const message_ = { text: prompt, images, auto: input.auto === true, model };
      const running = turnsOf(conversation.id).find(active);
      if (!running) return { delivered: 'turn', turn: publicTurn(await startTurn(conversation, message_)) };
      if (running.controlReady && running.capabilities?.includes('message') && !running.cancelRequested) {
        try {
          await runner.message(running, { text: prompt, images });
          titles.observeMessage(running, prompt, randomUUID());
          return { delivered: 'message', turn: publicTurn(running) };
        } catch { /* the run is finishing: queue it as the next turn instead */ }
      }
      try { return { delivered: 'queued', followUp: followUps.add(conversation.id, message_) }; }
      catch (error) { throw new HttpError(409, message(error)); }
    }],
    ['GET', /^conversations\/([\w-]+)\/follow-ups$/, async (_request, [id]) => followUps.list(identifier(id))],
    ['DELETE', /^conversations\/([\w-]+)\/follow-ups\/([\w-]+)$/, async (_request, [id, item]) => {
      if (!followUps.remove(identifier(id), identifier(item))) throw new HttpError(404, '这条消息已经发出');
      return { removed: true };
    }],
    // Images for a message, saved in the project like the Python service (.coderfleet-uploads).
    ['POST', /^projects\/([\w.-]+)\/uploads$/, async (request, [name]) => {
      const target = project(name as string);
      const input = await body(request, 28 * 1024 * 1024);
      const data = Buffer.from(text(input.data), 'base64');
      if (!data.length) throw new HttpError(400, '文件是空的');
      if (data.length > 20 * 1024 * 1024) throw new HttpError(400, '附件不能超过 20 MB');
      const directory = join(target.path, '.coderfleet-uploads');
      mkdirSync(directory, { recursive: true });
      // A unique prefix plus the name in characters every tool handles; the agent sees a readable file name.
      const original = text(input.name).split(/[\\/]/).pop() ?? '';
      const dot = original.lastIndexOf('.');
      const extension = dot > 0 ? original.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) : '';
      const stem = (dot > 0 ? original.slice(0, dot) : original).normalize('NFC').replace(/[^\p{L}\p{N}_.-]+/gu, '_').replace(/^[_.]+|[_.]+$/g, '').slice(0, 80) || 'file';
      const file = randomBytes(8).toString('hex') + '-' + stem + (extension ? '.' + extension : '');
      writeFileSync(join(directory, file), data, { mode: 0o644 });
      return { path: '/workspace/.coderfleet-uploads/' + file, name: text(input.name).slice(0, 200), size: data.length };
    }],
    ['GET', /^projects\/([\w.-]+)\/uploads\/([a-f0-9]{16}[-.%][^/]*\.(?:png|jpe?g|webp|gif))$/i, async (_request, [name, encoded]) => {
      let file = '';
      try { file = decodeURIComponent(encoded as string); } catch { throw new HttpError(400, '无效的文件名'); }
      if (!/^[a-f0-9]{16}[-.][\p{L}\p{N}_.-]*$/u.test(file)) throw new HttpError(400, '无效的文件名');
      const path = join(project(name as string).path, '.coderfleet-uploads', file);
      if (!existsSync(path) || statSync(path).size > 20 * 1024 * 1024) throw new HttpError(404, '图片不存在');
      return { mime: UPLOAD_TYPES[file.split('.').pop()?.toLowerCase() as string], data: readFileSync(path).toString('base64') };
    }],
    ['GET', /^turns\/([\w-]+)\/tools\/(.+)$/, async (_request, [id, toolId]) => {
      const turn = store.turn(identifier(id));
      const tool = turn?.tools.find(item => item.id === decodeURIComponent(toolId as string));
      if (!tool) throw new HttpError(404, '找不到这次工具调用');
      return { id: tool.id, title: tool.title, status: tool.status, input: tool.input ?? {}, output: tool.output ?? '', images: toolImages(turn?.id as string, tool.id) };
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
      const input = await body(request);
      const key = identifier(input.id);
      if (turn.permission?.id !== key) throw new HttpError(409, 'This approval is no longer available');
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
    }],
  ];

  const server = createServer(async (request, response) => {
    try {
      const auth = Buffer.from(request.headers.authorization ?? '');
      if (token.length !== auth.length || !timingSafeEqual(auth, token)) throw new HttpError(401, 'Invalid backend token');
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (!url.pathname.startsWith('/v1/')) throw new HttpError(404, 'Unknown API endpoint');
      const path = url.pathname.slice('/v1/'.length);
      for (const [method, pattern, handler] of routes) {
        const match = pattern.exec(path);
        if (!match || method !== request.method) continue;
        const result = await handler(request, match.slice(1), url);
        reply(response, request.method === 'POST' && /^(accounts|projects|conversations)$/.test(path) ? 201 : 200, result);
        return;
      }
      throw new HttpError(404, 'Unknown API endpoint');
    } catch (error) {
      if (error instanceof HttpError) reply(response, error.status, { error: error.message });
      else if (error instanceof WorkspaceError) reply(response, 400, { error: error.message });
      else if (message(error) === 'Invalid identifier') reply(response, 400, { error: 'Invalid identifier' });
      else {
        console.error('Request failed:', message(error));
        reply(response, 500, { error: message(error) || 'Backend request failed' });
      }
    }
  });
  // Follows every active turn; after a restart this resumes from the saved log offsets.
  let titlesTicked = 0;
  const timer = setInterval(() => {
    for (const turn of store.liveTurns()) if (active(turn)) void runner.tick(turn);
    void drainFollowUps();
    if (Date.now() - titlesTicked > 1_000) { titlesTicked = Date.now(); titles.tick(); }
  }, 250);
  timer.unref();
  server.once('close', () => clearInterval(timer));
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
function publicTurn(turn: Turn): Record<string, unknown> {
  const { resumeId: _resume, controlToken: _token, logOffset: _offset, launchedAt: _launched, cancelRequested: _cancel, ...visible } = turn;
  return {
    ...visible,
    ...(turn.cancelRequested && active(turn) ? { stopping: true } : {}),
    tools: turn.tools.map(({ input, output, ...tool }) => ({ ...tool, hasDetail: Boolean(output) || Object.keys(record(input)).length > 0 })),
  };
}
