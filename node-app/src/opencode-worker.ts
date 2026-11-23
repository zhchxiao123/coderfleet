// Runs one OpenCode turn inside the project's persistent container with the
// official OpenCode SDK (@opencode-ai/sdk): the worker starts `opencode serve`
// on loopback, sends the prompt through the SDK client and follows the
// server's event stream. Tool approvals (permission.asked / permission.updated)
// go through the control mailbox. Events are translated into the shared
// stream-json events.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Command } from './control.js';
import { emit, errorMessage, list, object, openMailbox, pumpCommands, runMain, str, system, writeState, type BaseSpec, type Json } from './worker-kit.js';

export interface OpencodeSpec extends BaseSpec { vendor_directory: string }

interface Result { data?: unknown; error?: unknown; response?: { status: number } }
interface OpencodeClient {
  session: {
    create(options: Json): Promise<Result>;
    get(options: Json): Promise<Result>;
    prompt(options: Json): Promise<Result>;
    abort(options: Json): Promise<Result>;
  };
  event: { subscribe(options?: Json): Promise<{ stream: AsyncIterable<Json> }> };
  postSessionIdPermissionsPermissionId(options: Json): Promise<Result>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

/**
 * Starts `opencode serve` on a free loopback port and resolves to its URL.
 * (`--port=0` falls back to 4096, which concurrent turns in one container would share.)
 */
async function startServer(cwd: string): Promise<{ url: string; child: ChildProcess }> {
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const child = spawn('opencode', ['serve', '--hostname=127.0.0.1', '--port=' + port], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('OpenCode server did not start: ' + output.slice(-500))); }, 30_000);
    const read = (chunk: Buffer): void => {
      output += String(chunk);
      const match = /opencode server listening on\s+(https?:\/\/\S+)/.exec(output);
      if (match) { clearTimeout(timer); resolve({ url: match[1] as string, child }); }
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', chunk => { output += String(chunk); process.stderr.write(chunk); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('OpenCode server exited (' + code + '): ' + output.slice(-500))); });
  });
}

function errorText(value: unknown): string {
  const error = object(value);
  return str(object(error.data).message) || str(error.message) || str(error.name) || (value ? JSON.stringify(value).slice(0, 300) : '');
}

export async function runOpencode(spec: OpencodeSpec): Promise<number> {
  const mailbox = openMailbox(spec);
  writeState(spec);
  let interrupted = false;
  let server: ChildProcess | undefined;
  let client: OpencodeClient | undefined;
  let sessionId = '';
  const pending = new Map<string, true>();
  const stop = (): void => {
    if (interrupted) return;
    interrupted = true;
    system(spec, 'coderfleet_interrupted');
    for (const id of pending.keys()) system(spec, 'coderfleet_permission_closed', { tool_call_id: id, status: 'cancelled' });
    pending.clear();
    if (client && sessionId) void client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const handle = async (command: Command): Promise<void> => {
    const payload = command.payload;
    if (command.kind === 'ping') mailbox.acknowledge(command.id, { connected: true });
    else if (command.kind === 'interrupt') { stop(); mailbox.acknowledge(command.id, { interrupted: true }); }
    else if (command.kind === 'approval' && client && pending.has(str(payload.tool_call_id))) {
      const id = str(payload.tool_call_id);
      const reply = await client.postSessionIdPermissionsPermissionId({
        path: { id: sessionId, permissionID: id }, body: { response: payload.decision === 'allow' ? 'once' : 'reject' },
      });
      if (reply.error) { mailbox.acknowledge(command.id, undefined, 'OpenCode rejected the reply: ' + errorText(reply.error)); return; }
      pending.delete(id);
      system(spec, 'coderfleet_permission_closed', { tool_call_id: id, status: payload.decision === 'allow' ? 'approved' : 'denied' });
      mailbox.acknowledge(command.id);
    } else mailbox.acknowledge(command.id, undefined, 'Command is unavailable for this OpenCode turn');
  };
  let pump: ReturnType<typeof pumpCommands> | undefined;
  try {
    const sdk = await import(pathToFileURL(join(spec.vendor_directory, 'opencode-sdk', 'client.js')).href) as {
      createOpencodeClient(options: Json): OpencodeClient;
    };
    const started = await startServer(spec.cwd);
    server = started.child;
    client = sdk.createOpencodeClient({ baseUrl: started.url, directory: spec.cwd });
    const opencode = client;
    if (spec.session_id) {
      const existing = await opencode.session.get({ path: { id: spec.session_id } });
      if (existing.error || !object(existing.data).id) throw new Error('OpenCode cannot find the saved session ' + spec.session_id);
      sessionId = spec.session_id;
    } else {
      const created = await opencode.session.create({ body: {} });
      sessionId = str(object(created.data).id);
      if (!sessionId) throw new Error('OpenCode did not create a session: ' + errorText(created.error));
    }
    system(spec, 'coderfleet_backend', { execution_backend: 'sdk' });
    system(spec, 'coderfleet_session', { session_id: sessionId });

    // Follow the event stream for this session.
    const assistantMessages = new Set<string>();
    const partKinds = new Map<string, string>();
    const textSoFar = new Map<string, string>();
    const toolsSeen = new Set<string>();
    const events = await opencode.event.subscribe();
    const follow = (async () => {
      for await (const raw of events.stream) {
        const event = object(raw);
        const properties = object(event.properties);
        const type = str(event.type);
        if (type === 'message.updated') {
          const info = object(properties.info);
          if (info.sessionID === sessionId && info.role === 'assistant') assistantMessages.add(str(info.id));
        } else if (type === 'message.part.updated') {
          const part = object(properties.part);
          if (part.sessionID !== sessionId) continue;
          partKinds.set(str(part.id), str(part.type));
          if (part.type === 'tool') {
            const id = str(part.callID) || str(part.id);
            const state = object(part.state);
            // A pending call has no input yet; wait for it so the row can show what it does.
            const ready = state.status !== 'pending' || Object.keys(object(state.input)).length > 0;
            if (ready && !toolsSeen.has(id)) {
              toolsSeen.add(id);
              emit('assistant', { message: { content: [{ type: 'tool_use', id, name: str(part.tool) || 'tool', input: object(state.input) }] } });
            }
            if (state.status === 'completed' || state.status === 'error') {
              emit('user', { message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: state.status === 'error',
                content: str(state.output) || str(state.error) }] } });
            }
          } else if (part.type === 'text' && assistantMessages.has(str(part.messageID)) && typeof part.text === 'string') {
            // A full snapshot: emit only what the deltas have not delivered yet.
            const previous = textSoFar.get(str(part.id)) ?? '';
            if (part.text.startsWith(previous) && part.text.length > previous.length) {
              const delta = part.text.slice(previous.length);
              textSoFar.set(str(part.id), part.text);
              emit('stream_event', { event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } } });
            }
          }
        } else if (type === 'message.part.delta') {
          if (properties.sessionID !== sessionId || properties.field !== 'text') continue;
          if (partKinds.get(str(properties.partID)) !== 'text' || !assistantMessages.has(str(properties.messageID))) continue;
          const delta = str(properties.delta);
          textSoFar.set(str(properties.partID), (textSoFar.get(str(properties.partID)) ?? '') + delta);
          emit('stream_event', { event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } } });
        } else if (type === 'permission.asked' || type === 'permission.updated') {
          if (properties.sessionID !== sessionId || interrupted) continue;
          const id = str(properties.id);
          const tool = object(properties.tool);
          pending.set(id, true);
          system(spec, 'coderfleet_permission_pending', {
            tool_call_id: id, tool_use_id: str(tool.callID) || str(properties.callID),
            tool_name: str(properties.permission) || str(properties.type) || str(properties.title) || 'Tool',
            tool_input: { patterns: properties.patterns ?? properties.pattern, metadata: properties.metadata, title: properties.title },
            can_allow: true, deadline: new Date(Date.now() + spec.permission_timeout * 1000).toISOString(),
          });
        } else if (type === 'permission.replied') {
          const id = str(properties.requestID) || str(properties.permissionID);
          if (pending.delete(id)) system(spec, 'coderfleet_permission_closed', { tool_call_id: id, status: properties.reply === 'reject' || properties.response === 'reject' ? 'denied' : 'approved' });
        }
      }
    })().catch(() => undefined);

    mailbox.publish('accepting');
    system(spec, 'coderfleet_control_ready', { capabilities: ['approval', 'interrupt'], permission_mode: 'default' });
    pump = pumpCommands(spec, mailbox, handle);
    const [providerID, ...rest] = spec.model.split('/');
    const model = spec.model && rest.length ? { providerID, modelID: rest.join('/') } : undefined;
    const result = await opencode.session.prompt({
      path: { id: sessionId }, body: { ...(model ? { model } : {}), parts: [{ type: 'text', text: spec.prompt }] },
    });
    // Let the stream deliver the final part updates before closing.
    await new Promise(resolve => setTimeout(resolve, 300));
    const info = object(object(result.data).info);
    for (const part of list(object(result.data).parts)) {
      if (part.type !== 'text' || typeof part.text !== 'string') continue;
      const previous = textSoFar.get(str(part.id)) ?? '';
      if (part.text.startsWith(previous) && part.text.length > previous.length) {
        emit('stream_event', { event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part.text.slice(previous.length) } } });
      }
    }
    void follow;
    if (interrupted) return 143;
    const failure = result.error ? errorText(result.error) : info.error ? errorText(info.error) : '';
    if (failure) throw new Error(failure);
    return 0;
  } catch (error) {
    if (interrupted) return 143;
    emit('error', { message: errorMessage(error) });
    return 1;
  } finally {
    pump?.stop();
    await pump?.done.catch(() => undefined);
    mailbox.close();
    server?.kill();
  }
}

await runMain(import.meta.url, runOpencode);
