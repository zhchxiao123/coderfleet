import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readWorkspace, type WorkspaceProject } from './conf.js';
import { assertContainer, models } from './docker.js';
import { active, identifier, message, readConfig, record, Store, text, type Turn } from './state.js';
import { TaskRunner } from './tasks.js';

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
  try { return record(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch { throw new HttpError(400, 'Expected a JSON request body'); }
}

/** Antigravity projects from projects.conf. Other account types are served by the Python service for now. */
export function antigravityProjects(workspace: string): WorkspaceProject[] {
  return readWorkspace(workspace).projects.filter(project => project.account.type === 'antigravity' && project.account.runtime === 'container');
}

export async function serve(configPath: string): Promise<Server> {
  const config = readConfig(configPath);
  const store = new Store(config.stateDirectory);
  const token = Buffer.from('Bearer ' + config.token);
  const project = (id: string): WorkspaceProject | undefined => antigravityProjects(config.workspace).find(item => item.name === id);
  const runner = new TaskRunner(store, config.dockerPath, project);

  const server = createServer(async (request, response) => {
    try {
      const auth = Buffer.from(request.headers.authorization ?? '');
      if (token.length !== auth.length || !timingSafeEqual(auth, token)) throw new HttpError(401, 'Invalid backend token');
      const method = request.method;
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      const parts = path.split('/').filter(Boolean);
      const [version, route, id, sub] = parts;
      if (version !== 'v1' || parts.length > 4) throw new HttpError(404, 'Unknown API endpoint');
      if (method === 'GET' && route === 'health' && !id) {
        reply(response, 200, { service: 'coderfleet-node', version: 1 });
      } else if (method === 'GET' && route === 'projects' && !id) {
        reply(response, 200, antigravityProjects(config.workspace).map(item => ({ id: item.name, name: item.name })));
      } else if (method === 'GET' && route === 'projects' && id && sub === 'models') {
        const target = project(id);
        if (!target) throw new HttpError(404, 'Project not found');
        try { reply(response, 200, await models(config.dockerPath, target)); }
        catch (error) { throw new HttpError(502, 'Could not list Antigravity models: ' + message(error)); }
      } else if (method === 'GET' && route === 'conversations' && !id) {
        reply(response, 200, store.conversations().sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
      } else if (method === 'POST' && route === 'conversations' && !id) {
        const input = await body(request);
        const target = project(text(input.projectId));
        if (!target) throw new HttpError(404, 'Project not found');
        const conversation = { id: randomUUID(), projectId: target.name, name: text(input.name).trim().slice(0, 100) || 'New conversation', createdAt: new Date().toISOString() };
        store.saveConversation(conversation);
        reply(response, 201, conversation);
      } else if (route === 'conversations' && id && sub === 'turns') {
        const conversation = store.conversation(identifier(id));
        if (!conversation) throw new HttpError(404, 'Conversation not found');
        const turns = store.turns().filter(turn => turn.conversationId === id)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
        if (method === 'GET') {
          reply(response, 200, turns.map(publicTurn));
        } else if (method === 'POST') {
          const input = await body(request);
          const prompt = text(input.prompt).trim();
          const model = text(input.model).trim();
          if (!prompt || prompt.length > 60_000 || model.length > 180) throw new HttpError(400, 'Invalid prompt or model');
          const target = project(conversation.projectId);
          if (!target) throw new HttpError(404, 'Project not found');
          try { await assertContainer(config.dockerPath, target); }
          catch (error) { throw new HttpError(409, message(error)); }
          // Re-read after the await: the check and the save below run without yielding.
          const current = store.turns().filter(turn => turn.conversationId === id);
          if (current.some(active)) throw new HttpError(409, 'A turn in this conversation is still active');
          const previous = turns.findLast(turn => turn.sessionId);
          const turn: Turn = {
            id: randomUUID(), conversationId: id, projectId: conversation.projectId,
            prompt, requestedModel: model, createdAt: new Date().toISOString(), resumeId: previous?.sessionId ?? '',
            status: 'starting', answer: '', tools: [],
          };
          store.saveTurn(turn);
          await runner.launch(turn);
          reply(response, 202, publicTurn(turn));
        } else throw new HttpError(405, 'Method not allowed');
      } else if (method === 'POST' && route === 'turns' && id && (sub === 'permission' || sub === 'cancel')) {
        const input = sub === 'permission' ? await body(request) : {};
        const turn = store.turn(identifier(id));
        if (!turn) throw new HttpError(404, 'Turn not found');
        if (!active(turn)) throw new HttpError(409, 'The turn has already finished');
        if (sub === 'cancel') {
          await runner.cancel(turn);
        } else {
          const key = identifier(input.id);
          const decision = input.decision;
          if (decision !== 'allow' && decision !== 'deny') throw new HttpError(400, 'Invalid approval decision');
          if (turn.permission?.id !== key || (decision === 'allow' && !turn.permission.allow)) {
            throw new HttpError(409, 'This approval is no longer available');
          }
          try { await runner.decide(turn, key, decision); }
          catch (error) { throw new HttpError(409, message(error)); }
        }
        reply(response, 202, { accepted: true });
      } else throw new HttpError(404, 'Unknown API endpoint');
    } catch (error) {
      if (error instanceof HttpError) reply(response, error.status, { error: error.message });
      else if (message(error) === 'Invalid identifier') reply(response, 400, { error: 'Invalid identifier' });
      else {
        console.error('Request failed:', message(error));
        reply(response, 500, { error: 'Backend request failed' });
      }
    }
  });
  // Follows every active turn; after a restart this resumes from the saved log offsets.
  const timer = setInterval(() => {
    for (const turn of store.turns()) if (active(turn)) void runner.tick(turn);
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

function publicTurn(turn: Turn): Omit<Turn, 'resumeId' | 'controlToken' | 'logOffset' | 'launchedAt' | 'cancelRequested'> {
  const { resumeId: _resume, controlToken: _token, logOffset: _offset, launchedAt: _launched, cancelRequested: _cancel, ...visible } = turn;
  return visible;
}
