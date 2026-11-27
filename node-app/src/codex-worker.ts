// Runs one Codex turn inside the project's persistent container with the
// official TypeScript Codex SDK (@openai/codex-sdk), which drives the
// container's `codex` CLI. Codex's own sandbox is off (danger-full-access, no
// approvals): it needs bubblewrap, which cannot create its user namespace in
// a container, so every command would fail; the container is the boundary.
// Resume by thread ID; images as local_image inputs. Codex thread events are
// translated into the shared stream-json events.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Command } from './control.js';
import { attachments, withPaths, emit, errorMessage, object, openMailbox, pumpCommands, runMain, str, system, writeState, type BaseSpec, type Json } from './worker-kit.js';

function text(type: 'text' | 'thinking', value: string, id: string): void {
  if (!value) return;
  emit('stream_event', { event: { type: 'message_start', message: { id } } });
  emit('stream_event', { event: { type: 'content_block_delta', index: 0, delta: { type: type + '_delta', [type]: value } } });
  emit('stream_event', { event: { type: 'message_stop' } });
  emit('assistant', { message: { id, content: [{ type, [type]: value }] } });
}

function toolUse(id: string, name: string, input: Json): void {
  emit('assistant', { message: { content: [{ type: 'tool_use', id, name, input }] } });
}

function toolResult(id: string, content: string, isError: boolean): void {
  emit('user', { message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
}

const started = new Set<string>();

/** Translates one `codex exec --json` event. Returns an error message for failed turns. */
export function translate(spec: BaseSpec, event: Json): string | undefined {
  const type = str(event.type);
  if (type === 'thread.started' && str(event.thread_id)) {
    system(spec, 'coderfleet_session', { session_id: str(event.thread_id) });
    return undefined;
  }
  if (type === 'turn.failed') return str(object(event.error).message) || 'Codex turn failed';
  if (type === 'error') return str(event.message) || 'Codex reported an error';
  if (type !== 'item.started' && type !== 'item.completed') return undefined;
  const item = object(event.item);
  const id = str(item.id);
  const completed = type === 'item.completed';
  switch (item.type) {
    case 'agent_message': if (completed) text('text', str(item.text), id); break;
    case 'reasoning': if (completed) text('thinking', str(item.text), id); break;
    case 'command_execution':
    case 'file_change':
    case 'mcp_tool_call':
    case 'web_search': {
      const name = item.type === 'command_execution' ? 'Shell' : item.type === 'file_change' ? 'Edit files'
        : item.type === 'web_search' ? 'Web search' : [str(item.server), str(item.tool)].filter(Boolean).join(' · ') || 'MCP tool';
      const input: Json = item.type === 'command_execution' ? { command: item.command }
        : item.type === 'file_change' ? { changes: item.changes } : item.type === 'web_search' ? { query: item.query } : { arguments: item.arguments };
      if (!started.has(id)) { started.add(id); toolUse(id, name, input); }
      if (completed) {
        const failed = item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0);
        const output = item.aggregated_output ?? item.result ?? item.error ?? '';
        toolResult(id, typeof output === 'string' ? output : JSON.stringify(output), failed);
      }
      break;
    }
    default: break;
  }
  return undefined;
}

export interface CodexSpec extends BaseSpec { vendor_directory: string }

interface CodexThread { runStreamed(input: string | Json[], options: { signal: AbortSignal }): Promise<{ events: AsyncIterable<Json> }> }
interface CodexClient {
  startThread(options: Json): CodexThread;
  resumeThread(id: string, options: Json): CodexThread;
}

function codexPath(): string {
  try { return execFileSync('bash', ['-lc', 'command -v codex'], { encoding: 'utf8', timeout: 10_000 }).trim(); }
  catch { throw new Error('Codex CLI is not installed in this container'); }
}

export async function runCodex(spec: CodexSpec): Promise<number> {
  const mailbox = openMailbox(spec);
  writeState(spec);
  const abort = new AbortController();
  let interrupted = false;
  const stop = (): void => {
    if (interrupted) return;
    interrupted = true;
    system(spec, 'coderfleet_interrupted');
    abort.abort();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const handle = (command: Command): void => {
    if (command.kind === 'ping') mailbox.acknowledge(command.id, { connected: true });
    else if (command.kind === 'interrupt') { stop(); mailbox.acknowledge(command.id, { interrupted: true }); }
    else mailbox.acknowledge(command.id, undefined, 'Codex runs without interactive approvals');
  };
  let pump: ReturnType<typeof pumpCommands> | undefined;
  let failure: string | undefined;
  try {
    const sdk = await import(pathToFileURL(join(spec.vendor_directory, 'codex-sdk', 'index.js')).href) as { Codex: new (options: Json) => CodexClient };
    const codex = new sdk.Codex({ codexPathOverride: codexPath() });
    // A read-only turn has no sandbox to hold it to that either: its prompt says so.
    const sandboxMode = 'danger-full-access';
    const options: Json = { workingDirectory: spec.cwd, skipGitRepoCheck: true, sandboxMode, approvalPolicy: 'never', ...(spec.model ? { model: spec.model } : {}) };
    const files = attachments(spec.cwd, spec.images);
    const images = files.filter(file => file.kind === 'image');
    const prompt = withPaths(spec.prompt, files.filter(file => file.kind !== 'image'));
    const thread = spec.session_id ? codex.resumeThread(spec.session_id, options) : codex.startThread(options);
    mailbox.publish('accepting');
    system(spec, 'coderfleet_backend', { execution_backend: 'sdk' });
    system(spec, 'coderfleet_control_ready', { capabilities: ['interrupt'], permission_mode: sandboxMode });
    pump = pumpCommands(spec, mailbox, handle);
    // A resumed thread does not announce itself again; keep the saved ID.
    if (spec.session_id) system(spec, 'coderfleet_session', { session_id: spec.session_id });
    const { events } = await thread.runStreamed(images.length
      ? [...(prompt ? [{ type: 'text', text: prompt }] : []), ...images.map(image => ({ type: 'local_image', path: image.path }))]
      : prompt, { signal: abort.signal });
    for await (const event of events) failure = translate(spec, object(event)) ?? failure;
    if (interrupted) return 143;
    if (failure) throw new Error(failure);
    return 0;
  } catch (error) {
    if (interrupted) return 143;
    emit('error', { message: failure || errorMessage(error) });
    return 1;
  } finally {
    pump?.stop();
    await pump?.done.catch(() => undefined);
    mailbox.close();
  }
}

await runMain(import.meta.url, runCodex);
