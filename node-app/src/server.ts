import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNT_TYPES, accountType } from './accounts.js';
import {
  addAccount, addProject, envKeys, initWorkspace, readSettings, readWorkspace, removeAccount, setProjectActive, updateEnv,
  writeSettings, WorkspaceError, type WorkspaceProject,
} from './conf.js';
import { assertContainer, models } from './docker.js';
import { Lifecycle } from './lifecycle.js';
import { findPythonService, type PythonService } from './python-service.js';
import { active, identifier, message, readConfig, record, text, type Turn } from './state.js';
import { WorkspaceStore } from './store.js';
import { chatSupported, TaskRunner } from './tasks.js';
import { Terminals } from './terminal.js';
import { VERSION } from './version.js';

class HttpError extends Error {
  public constructor(public readonly status: number, message: string) { super(message); }
}

function reply(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 160_000) throw new HttpError(413, 'The request body is too large');
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

  const routes: [string, RegExp, Handler][] = [
    ['GET', /^health$/, async () => ({ service: 'coderfleet-node', version: 1, build: VERSION, pid: process.pid })],
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
        backend: { build: VERSION, pid: process.pid, host: config.host, port: config.port },
        python: python.value ?? null,
        accountTypes: Object.values(ACCOUNT_TYPES).map(({ id, label, envAuth, envHint, chat }) => ({ id, label, envAuth, envHint, chat })),
        operations: lifecycle.recent(),
      };
    }],
    ['POST', /^workspace\/init$/, async () => ({ created: initWorkspace(workspace, template) })],
    ['GET', /^settings$/, async () => readSettings(workspace)],
    ['PUT', /^settings$/, async request => {
      const input = await body(request);
      writeSettings(workspace, Object.fromEntries(Object.entries(input).map(([key, value]) => [key, text(value).trim()])));
      return readSettings(workspace);
    }],
    ['POST', /^image\/build$/, async () => lifecycle.build()],
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
      const summaries = new Map<string, { updatedAt: string; status: string; turns: number; attention: boolean }>();
      for (const item of store.turnIds()) {
        const conversationId = store.turnConversation(item.id);
        if (!conversationId) continue;
        const current = summaries.get(conversationId) ?? { updatedAt: '', status: '', turns: 0, attention: false };
        summaries.set(conversationId, { updatedAt: item.createdAt, status: item.status, turns: current.turns + 1, attention: item.attention });
      }
      return store.conversations().map(item => {
        const summary = summaries.get(item.id);
        return { id: item.id, projectId: item.projectId, name: item.name, createdAt: item.createdAt, type: item.type ?? '',
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
      if (!store.conversation(identifier(id))) throw new HttpError(404, 'Conversation not found');
      return turnsOf(id as string).map(publicTurn);
    }],
    ['POST', /^conversations\/([\w-]+)\/turns$/, async (request, [id]) => {
      const conversation = store.conversation(identifier(id));
      if (!conversation) throw new HttpError(404, 'Conversation not found');
      const input = await body(request);
      const prompt = text(input.prompt).trim();
      const model = text(input.model).trim();
      if (!prompt || prompt.length > 60_000 || model.length > 180) throw new HttpError(400, 'Invalid prompt or model');
      const target = chatProject(conversation.projectId);
      if (!target) throw new HttpError(404, 'Project not found');
      try { await assertContainer(config.dockerPath, target); }
      catch (error) { throw new HttpError(409, message(error)); }
      // Re-read after the await: the check and the save below run without yielding.
      const turns = turnsOf(id as string);
      if (turns.some(active)) throw new HttpError(409, 'A turn in this conversation is still active');
      if (turns.some(turn => turn.status === 'queued')) throw new HttpError(409, '这个对话还有原服务排队中的任务');
      // Later turns resume the conversation's agent session (Python: native_session_id).
      const resume = conversation.nativeSessionId || turns.findLast(turn => turn.sessionId)?.sessionId || '';
      if (conversation.type && conversation.type !== target.account.type) throw new HttpError(409, '这个对话属于 ' + conversation.type + ' 账号，项目现在绑定的是 ' + target.account.type);
      const turn: Turn = {
        id: randomUUID().replaceAll('-', '').slice(0, 12), origin: 'node', conversationId: id as string, projectId: conversation.projectId,
        account: target.account.name, type: target.account.type, prompt, requestedModel: model, createdAt: new Date().toISOString(),
        resumeId: resume, status: 'starting', answer: '', tools: [], blocks: [],
      };
      store.createTurn(turn, target.path);
      if (turns.length === 0 && conversation.name === '新对话') store.saveConversation({ ...conversation, name: prompt.replace(/\s+/g, ' ').slice(0, 40) });
      await runner.launch(turn);
      return publicTurn(turn);
    }],
    ['GET', /^turns\/([\w-]+)\/tools\/(.+)$/, async (_request, [id, toolId]) => {
      const turn = store.turn(identifier(id));
      const tool = turn?.tools.find(item => item.id === decodeURIComponent(toolId as string));
      if (!tool) throw new HttpError(404, '找不到这次工具调用');
      return { id: tool.id, title: tool.title, status: tool.status, input: tool.input ?? {}, output: tool.output ?? '' };
    }],
    ['POST', /^turns\/([\w-]+)\/(permission|cancel)$/, async (request, [id, action]) => {
      const turn = store.turn(identifier(id));
      if (!turn) throw new HttpError(404, 'Turn not found');
      if (!active(turn)) throw new HttpError(409, 'The turn has already finished');
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
  const timer = setInterval(() => {
    for (const turn of store.liveTurns()) if (active(turn)) void runner.tick(turn);
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
    tools: turn.tools.map(({ input, output, ...tool }) => ({ ...tool, hasDetail: Boolean(output) || Object.keys(record(input)).length > 0 })),
  };
}
