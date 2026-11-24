// Runs one Hermes Agent turn inside the project's persistent container. Hermes
// has no TypeScript SDK, so the worker drives `hermes chat -q` like the Python
// scheduler. With `--format stream-json` (documented JSONL: system/text/
// tool_use/tool_result/result) it reports text and tool calls; an older CLI
// without that flag falls back to plain text and the "Session: <id>" line.
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Command } from './control.js';
import { attachments, emit, errorMessage, object, openMailbox, pumpCommands, runMain, str, system, withPaths, writeState, type BaseSpec, type Json } from './worker-kit.js';

const HERMES = process.env.CODERFLEET_HERMES_BIN || 'hermes';

function supportsStreamJson(): Promise<boolean> {
  return new Promise(resolve => {
    execFile(HERMES, ['chat', '--help'], { timeout: 20_000 }, (error, stdout, stderr) => resolve(!error && /--format/.test(stdout + stderr)));
  });
}

function delta(text: string): void {
  if (text) emit('stream_event', { event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
}

export async function runHermes(spec: BaseSpec): Promise<number> {
  const mailbox = openMailbox(spec);
  writeState(spec);
  const structured = await supportsStreamJson();
  // Auto mode matches the Python command line: --yolo skips Hermes' approvals.
  const args = [...(spec.session_id ? ['--resume', spec.session_id] : []), 'chat', '-q', withPaths(spec.prompt, attachments(spec.cwd, spec.images)),
    ...(spec.auto ? ['--yolo'] : []), ...(structured ? ['--format', 'stream-json'] : [])];
  let interrupted = false;
  const child = spawn(HERMES, args, { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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
    else mailbox.acknowledge(command.id, undefined, 'Hermes runs without interactive approvals here');
  };
  let pump: ReturnType<typeof pumpCommands> | undefined;
  let failure = '';
  let session = '';
  const announce = (id: string): void => {
    if (id && id !== session) { session = id; system(spec, 'coderfleet_session', { session_id: id }); }
  };
  try {
    mailbox.publish('accepting');
    system(spec, 'coderfleet_backend', { execution_backend: structured ? 'cli-stream-json' : 'cli-text' });
    system(spec, 'coderfleet_control_ready', { capabilities: ['interrupt'], permission_mode: 'default' });
    pump = pumpCommands(spec, mailbox, handle);
    const exit = new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve(code ?? 1));
    });
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk;
      process.stderr.write(chunk);
      announce(/^session_id:\s*(\S+)/m.exec(stderr)?.[1] ?? /^Session:\s+(\S+)/m.exec(stderr)?.[1] ?? '');
    });
    // Tool calls carry no ID: number them and match results by name in order.
    const open: { id: string; name: string }[] = [];
    let sequence = 0;
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      if (!structured) {
        const match = /^Session:\s+(\S+)/.exec(line);
        if (match) { announce(match[1] as string); continue; }
        delta(line + '\n');
        continue;
      }
      let event: Json;
      try { event = object(JSON.parse(line)); }
      catch { process.stderr.write(line + '\n'); continue; }
      if (event.type === 'system') announce(str(event.session_id));
      else if (event.type === 'text') delta(str(event.text));
      else if (event.type === 'tool_use') {
        const id = 'hermes-' + ++sequence;
        open.push({ id, name: str(event.name) });
        emit('assistant', { message: { content: [{ type: 'tool_use', id, name: str(event.name) || 'tool', input: object(event.input) }] } });
      } else if (event.type === 'tool_result') {
        const index = open.findIndex(item => item.name === str(event.name));
        const tool = open.splice(index >= 0 ? index : 0, 1)[0];
        if (tool) emit('user', { message: { content: [{ type: 'tool_result', tool_use_id: tool.id, content: str(event.output), is_error: event.is_error === true }] } });
      } else if (event.type === 'result') {
        announce(str(event.session_id));
        if (event.error) failure = str(event.error) || JSON.stringify(event.error);
        else if (typeof event.exit_code === 'number' && event.exit_code !== 0) failure = 'Hermes exited with status ' + event.exit_code;
      }
    }
    const code = await exit;
    if (interrupted) return 143;
    if (failure || code !== 0) throw new Error(failure || stderr.trim().split('\n').slice(-3).join('\n') || 'Hermes exited with status ' + code);
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

await runMain(import.meta.url, runHermes);
