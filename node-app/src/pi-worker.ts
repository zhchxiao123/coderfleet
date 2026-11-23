// Runs one Pi turn inside the project's persistent container with Pi's own SDK
// (`createAgentSession` from @earendil-works/pi-coding-agent, the package the
// image installs globally). The agent runs inside this worker process. Pi has
// no tool-approval system; sessions resume by ID through SessionManager.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Command } from './control.js';
import { emit, errorMessage, list, object, openMailbox, pumpCommands, runMain, str, system, writeState, type BaseSpec, type Json } from './worker-kit.js';

const PACKAGE = '@earendil-works/pi-coding-agent';

interface PiSession {
  readonly sessionId: string;
  readonly messages: readonly Json[];
  subscribe(listener: (event: Json) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}
interface PiSdk {
  createAgentSession(options: Json): Promise<{ session: PiSession }>;
  SessionManager: {
    create(cwd: string): unknown;
    open(path: string): unknown;
    list(cwd: string): Promise<readonly { id: string; path: string }[]>;
  };
}

/** The globally installed Pi package's entry point (CODERFLEET_PI_SDK overrides it). */
function piEntry(): string {
  const override = process.env.CODERFLEET_PI_SDK;
  if (override) return override;
  const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 20_000 }).trim();
  return join(root, PACKAGE, 'dist', 'index.js');
}

export async function runPi(spec: BaseSpec): Promise<number> {
  const mailbox = openMailbox(spec);
  writeState(spec);
  let interrupted = false;
  let session: PiSession | undefined;
  const stop = (): void => {
    if (interrupted) return;
    interrupted = true;
    system(spec, 'coderfleet_interrupted');
    void session?.abort().catch(() => undefined);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const handle = (command: Command): void => {
    if (command.kind === 'ping') mailbox.acknowledge(command.id, { connected: true });
    else if (command.kind === 'interrupt') { stop(); mailbox.acknowledge(command.id, { interrupted: true }); }
    else mailbox.acknowledge(command.id, undefined, 'Pi runs without interactive approvals');
  };
  let pump: ReturnType<typeof pumpCommands> | undefined;
  try {
    let sdk: PiSdk;
    try { sdk = await import(pathToFileURL(piEntry()).href) as PiSdk; }
    catch (error) { throw new Error('Pi is not installed in this container (' + errorMessage(error) + ')'); }
    let manager: unknown;
    if (spec.session_id) {
      const saved = (await sdk.SessionManager.list(spec.cwd)).find(item => item.id === spec.session_id);
      if (!saved) throw new Error('Pi cannot find the saved session ' + spec.session_id);
      manager = sdk.SessionManager.open(saved.path);
    } else manager = sdk.SessionManager.create(spec.cwd);
    const created = await sdk.createAgentSession({ cwd: spec.cwd, sessionManager: manager });
    const agent = created.session;
    session = agent;
    system(spec, 'coderfleet_backend', { execution_backend: 'sdk' });
    system(spec, 'coderfleet_session', { session_id: agent.sessionId });
    const unsubscribe = agent.subscribe(event => {
      if (event.type === 'message_update') {
        const update = object(event.assistantMessageEvent);
        if (update.type === 'text_delta' && str(update.delta)) {
          emit('stream_event', { event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: str(update.delta) } } });
        }
      } else if (event.type === 'tool_execution_start') {
        emit('assistant', { message: { content: [{ type: 'tool_use', id: str(event.toolCallId), name: str(event.toolName) || 'tool', input: object(event.args) }] } });
      } else if (event.type === 'tool_execution_end') {
        const result = event.result;
        const text = typeof result === 'string' ? result : list(object(result).content).map(item => str(item.text)).join('\n');
        emit('user', { message: { content: [{ type: 'tool_result', tool_use_id: str(event.toolCallId), content: text, is_error: event.isError === true }] } });
      }
    });
    mailbox.publish('accepting');
    system(spec, 'coderfleet_control_ready', { capabilities: ['interrupt'], permission_mode: 'none' });
    pump = pumpCommands(spec, mailbox, handle);
    try { await agent.prompt(spec.prompt); }
    finally { unsubscribe(); }
    if (interrupted) return 143;
    const last = [...agent.messages].reverse().find(message => message.role === 'assistant');
    const failure = last && (last.stopReason === 'error' || last.errorMessage) ? str(last.errorMessage) || 'Pi stopped with an error' : '';
    if (failure) throw new Error(failure);
    return 0;
  } catch (error) {
    if (interrupted) return 143;
    emit('error', { message: errorMessage(error) });
    return 1;
  } finally {
    pump?.stop();
    await pump?.done.catch(() => undefined);
    session?.dispose();
    mailbox.close();
  }
}

await runMain(import.meta.url, runPi);
