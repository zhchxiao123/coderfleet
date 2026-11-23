import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { cleanContainer, models } from './docker.js';
import { active, identifier, message, readConfig, record, Store, text, type Turn } from './state.js';

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

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return record(error).code === 'EPERM'; }
}

export async function serve(configPath: string): Promise<Server> {
  const config = readConfig(configPath);
  const store = new Store(config.stateDirectory);
  const token = Buffer.from('Bearer ' + config.token);
  const seen = new Set<string>();
  const recovering = new Set<string>();
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));

  async function recover(turn: Turn): Promise<void> {
    if (recovering.has(turn.id)) return;
    recovering.add(turn.id);
    try {
      if (!turn.workerPid && Date.now() - Date.parse(turn.createdAt) < 30_000) return;
      if (turn.workerPid && alive(turn.workerPid)) return;
      await cleanContainer(config.dockerPath, turn.id);
      const current = store.turn(turn.id);
      if (!current || !active(current) || (current.workerPid && alive(current.workerPid))) return;
      current.status = 'failed';
      current.error = 'The worker exited. Its Docker container was cleaned up. The original prompt was not replayed.';
      delete current.permission;
      store.saveTurn(current);
    } catch {
      // A Docker outage leaves the task active so another turn cannot overlap it.
    } finally { recovering.delete(turn.id); }
  }

  function startTurn(turn: Turn): void {
    store.saveTurn(turn);
    const child = spawn(process.execPath, [cli, 'worker', configPath, turn.id], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    seen.add(turn.id);
    child.once('error', error => {
      const current = store.turn(turn.id);
      if (current?.status !== 'starting' || current.workerPid) return;
      current.status = 'failed';
      current.error = message(error);
      store.saveTurn(current);
    });
    child.once('exit', () => seen.delete(turn.id));
    child.unref();
  }

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
        reply(response, 200, config.projects.map(project => ({ id: project.id, name: project.name })));
      } else if (method === 'GET' && route === 'projects' && id && sub === 'models') {
        const project = config.projects.find(item => item.id === id);
        if (!project) throw new HttpError(404, 'Project not found');
        try { reply(response, 200, await models(project)); }
        catch { throw new HttpError(502, 'Could not list Antigravity models. Verify the project login and Docker connection.'); }
      } else if (method === 'GET' && route === 'conversations' && !id) {
        reply(response, 200, store.conversations().sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
      } else if (method === 'POST' && route === 'conversations' && !id) {
        const input = await body(request);
        const project = config.projects.find(item => item.id === input.projectId);
        if (!project) throw new HttpError(404, 'Project not found');
        const conversation = { id: randomUUID(), projectId: project.id, name: text(input.name).trim().slice(0, 100) || 'New conversation', createdAt: new Date().toISOString() };
        store.saveConversation(conversation);
        reply(response, 201, conversation);
      } else if (route === 'conversations' && id && sub === 'turns') {
        const conversation = store.conversation(identifier(id));
        if (!conversation) throw new HttpError(404, 'Conversation not found');
        const input = method === 'POST' ? await body(request) : undefined;
        const turns = store.turns().filter(turn => turn.conversationId === id)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
        if (method === 'GET') {
          reply(response, 200, turns.map(publicTurn));
        } else if (input) {
          if (turns.some(active)) throw new HttpError(409, 'A turn in this conversation is still active');
          const prompt = text(input.prompt).trim();
          const model = text(input.model).trim();
          if (!prompt || prompt.length > 60_000 || model.length > 180) throw new HttpError(400, 'Invalid prompt or model');
          const previous = turns.findLast(turn => turn.sessionId);
          const turn: Turn = {
            id: randomUUID(), conversationId: id, projectId: conversation.projectId,
            prompt, requestedModel: model, createdAt: new Date().toISOString(), resumeId: previous?.sessionId ?? '',
            status: 'starting', answer: '', tools: [],
          };
          startTurn(turn);
          reply(response, 202, publicTurn(turn));
        } else throw new HttpError(405, 'Method not allowed');
      } else if (method === 'POST' && route === 'turns' && id && (sub === 'permission' || sub === 'cancel')) {
        const input = sub === 'permission' ? await body(request) : {};
        const turn = store.turn(identifier(id));
        if (!turn) throw new HttpError(404, 'Turn not found');
        if (sub === 'cancel') {
          if (!active(turn) || turn.status === 'blocked') throw new HttpError(409, 'The turn can no longer be cancelled');
          store.putControl(id, 'cancel', { type: 'cancel' });
        } else {
          const key = identifier(input.id);
          const decision = input.decision;
          if (decision !== 'allow' && decision !== 'deny') throw new HttpError(400, 'Invalid approval decision');
          const previous = store.control(id, key);
          if (previous?.type === 'permission' && previous.decision === decision) {
            reply(response, 202, { accepted: true });
            return;
          }
          if (turn.permission?.id !== key || (decision === 'allow' && !turn.permission.allow) || previous) {
            throw new HttpError(409, 'This approval is no longer available');
          }
          store.putControl(id, key, { type: 'permission', decision });
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
  const timer = setInterval(() => {
    for (const turn of store.turns()) {
      if (active(turn) && !seen.has(turn.id)) void recover(turn);
    }
  }, 2_000);
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

function publicTurn(turn: Turn): Omit<Turn, 'workerPid' | 'resumeId'> {
  const { workerPid: _workerPid, resumeId: _resumeId, ...visible } = turn;
  return visible;
}
