// Runs one Codex turn inside the project's persistent container with
// `codex exec --json`, using the same flags as the Python scheduler's Codex
// command (manual mode: workspace-write sandbox, resume by thread ID). Codex
// events are translated into the shared stream-json events.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Command } from './control.js';
import { emit, errorMessage, object, openMailbox, pumpCommands, runMain, str, system, writeState, type BaseSpec, type Json } from './worker-kit.js';

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

export async function runCodex(spec: BaseSpec): Promise<number> {
  const mailbox = openMailbox(spec);
  writeState(spec);
  const args = spec.session_id
    ? ['exec', 'resume', spec.session_id, '--json', '--skip-git-repo-check']
    : ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write'];
  if (spec.model) args.push('--model', spec.model);
  let interrupted = false;
  const child = spawn('codex', args, { cwd: spec.cwd, stdio: ['pipe', 'pipe', 'inherit'] });
  const stop = (): void => {
    if (interrupted) return;
    interrupted = true;
    system(spec, 'coderfleet_interrupted');
    child.kill('SIGINT');
    setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
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
    mailbox.publish('accepting');
    system(spec, 'coderfleet_backend', { execution_backend: 'cli' });
    system(spec, 'coderfleet_control_ready', { capabilities: ['interrupt'], permission_mode: 'workspace-write' });
    pump = pumpCommands(spec, mailbox, handle);
    child.stdin.end(spec.prompt + '\n');
    const exit = new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve(code ?? 1));
    });
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      let event: Json;
      try { event = object(JSON.parse(line)); }
      catch { process.stderr.write(line + '\n'); continue; }
      failure = translate(spec, event) ?? failure;
    }
    const code = await exit;
    if (interrupted) return 143;
    if (code !== 0 || failure) throw new Error(failure || 'Codex exited with status ' + code);
    return 0;
  } catch (error) {
    if (interrupted) return 143;
    emit('error', { message: errorMessage(error) });
    return 1;
  } finally {
    pump?.stop();
    await pump?.done.catch(() => undefined);
    mailbox.close();
  }
}

await runMain(import.meta.url, runCodex);
