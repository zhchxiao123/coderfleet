// Runs one Claude Code turn inside the project's persistent container with the
// TypeScript Claude Agent SDK. Follows coderfleet_claude_sdk_worker.py:
// acceptEdits by default (bypassPermissions in auto mode), images as content
// blocks, messages sent mid-turn go into the same session, tool approvals and native questions through the
// control mailbox, native interrupt, resume by session ID. SDK messages are
// written to stdout unchanged; CoderFleet events are `system` lines.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Command } from './control.js';
import { attachments, emit, errorMessage, list, object, openMailbox, pumpCommands, runMain, str, system, writeState, type BaseSpec, type Json } from './worker-kit.js';

export interface ClaudeSpec extends BaseSpec {
  sdk_directory: string; permission_mode?: string;
  /** A fork's first turn: resume session_id at resume_session_at as the new session fork_session_id. */
  fork_session_id?: string; resume_session_at?: string;
}

type Decision = { decision: 'allow' | 'deny'; answers?: Record<string, string>; message?: string };
type PermissionResult = { behavior: 'allow'; updatedInput: Json } | { behavior: 'deny'; message: string };
interface Query extends AsyncIterable<Json> { interrupt(): Promise<unknown> }
type QueryFunction = (input: { prompt: AsyncIterable<Json>; options: Json }) => Query;

const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan']);
/** After a result, how long to wait for the run that answers a message sent mid-turn. */
const FOLLOW_UP_WAIT = 5_000;
/** After an interrupt, how long the CLI gets to wind down before the worker exits anyway. */
const INTERRUPT_GRACE = 15_000;
/** Lifecycle states after which the CLI will not run a sent message (again). */
const COMMAND_ENDED = new Set(['completed', 'cancelled', 'failed', 'discarded']);

/**
 * A user message (Python `_input_content`): plain text, or text plus base64 image and PDF
 * blocks; any other attachment is named by its path for Claude to read.
 */
export function userContent(cwd: string, text: string, uploads: readonly string[] | undefined): string | Json[] {
  const files = attachments(cwd, uploads);
  if (!files.length) return text;
  return [...(text ? [{ type: 'text', text }] : []),
    ...files.map(file => file.kind === 'file' ? { type: 'text', text: '[Attached file: ' + file.path + ']' }
      : { type: file.kind === 'pdf' ? 'document' : 'image', source: { type: 'base64', media_type: file.mime, data: file.data() } })];
}

function cliPath(): string {
  try { return execFileSync('bash', ['-lc', 'command -v claude'], { encoding: 'utf8', timeout: 10_000 }).trim(); }
  catch { throw new Error('Claude Code is not installed in this container'); }
}

function cliVersion(path: string): string {
  try { return execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim().split(/\s+/)[0] ?? ''; }
  catch { return ''; }
}

export async function runClaude(spec: ClaudeSpec): Promise<number> {
  const mailbox = openMailbox(spec);
  writeState(spec);
  const pending = new Map<string, (decision: Decision) => void>();
  let interrupted = false;
  let query: Query | undefined;
  let finished: () => void = () => undefined;
  const done = new Promise<void>(resolve => { finished = resolve; });
  // The SDK reads user messages from this queue; mid-turn messages are appended to it.
  const inbox: Json[] = [];
  let wakeInput: () => void = () => undefined;
  let accepting = false;
  // Messages sent mid-turn that the CLI has not reported finished (command_lifecycle).
  const open = new Set<string>();
  let sentSinceResult = 0;
  const send = (content: string | Json[], uuid = randomUUID()): void => {
    inbox.push({ type: 'user', session_id: '', parent_tool_use_id: null, uuid, message: { role: 'user', content } });
    wakeInput();
  };
  // Approvals and questions are shown one at a time, like the Python worker.
  let queue: Promise<unknown> = Promise.resolve();

  const ask = (toolName: string, input: Json, toolUseId: string, signal?: AbortSignal): Promise<PermissionResult> => {
    const next = queue.then(async (): Promise<PermissionResult> => {
      if (interrupted) return { behavior: 'deny', message: 'The turn was interrupted' };
      const question = toolName === 'AskUserQuestion';
      const questions = list(input.questions);
      if (question && !questions.length) return { behavior: 'deny', message: 'Invalid native question' };
      const prefix = question ? 'coderfleet_question' : 'coderfleet_permission';
      const deadline = new Date(Date.now() + spec.permission_timeout * 1000).toISOString();
      system(spec, prefix + '_pending', question
        ? { tool_call_id: toolUseId, deadline, questions }
        : { tool_call_id: toolUseId, deadline, tool_name: toolName, tool_input: input, can_allow: true });
      let status = 'cancelled';
      try {
        const decision = await new Promise<Decision | undefined>(resolve => {
          const timer = setTimeout(() => resolve(undefined), spec.permission_timeout * 1000);
          pending.set(toolUseId, value => { clearTimeout(timer); resolve(value); });
          signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(undefined); }, { once: true });
        });
        if (!decision) {
          status = interrupted || signal?.aborted ? 'cancelled' : 'timed_out';
          return { behavior: 'deny', message: question ? 'User question timed out; no answer was provided' : 'Tool approval timed out' };
        }
        if (question) {
          status = 'answered';
          return { behavior: 'allow', updatedInput: { ...input, answers: decision.answers ?? {} } };
        }
        status = decision.decision === 'allow' ? 'approved' : 'denied';
        return decision.decision === 'allow'
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: decision.message || 'Operator denied this tool' };
      } finally {
        pending.delete(toolUseId);
        system(spec, prefix + '_closed', { tool_call_id: toolUseId, status });
      }
    });
    queue = next.catch(() => undefined);
    return next;
  };

  const handle = async (command: Command): Promise<void> => {
    const payload = command.payload;
    if (command.kind === 'ping') mailbox.acknowledge(command.id, { connected: true });
    else if (command.kind === 'interrupt') {
      await stop();
      mailbox.acknowledge(command.id, { interrupted: true });
    } else if (command.kind === 'approval' || command.kind === 'answer') {
      const resolve = pending.get(str(payload.tool_call_id));
      if (!resolve) { mailbox.acknowledge(command.id, undefined, 'This approval is no longer pending'); return; }
      if (command.kind === 'answer') {
        const answers = object(payload.answers);
        if (!Object.values(answers).every(value => typeof value === 'string')) { mailbox.acknowledge(command.id, undefined, 'Answers must be text'); return; }
        resolve({ decision: 'allow', answers: answers as Record<string, string> });
      } else {
        const decision = payload.decision;
        if (decision !== 'allow' && decision !== 'deny') { mailbox.acknowledge(command.id, undefined, 'Invalid decision'); return; }
        resolve({ decision, message: str(payload.message) });
      }
      mailbox.acknowledge(command.id);
    } else if (command.kind === 'message') {
      const text = payload.text;
      const images = payload.images ?? [];
      if (!accepting || interrupted) { mailbox.acknowledge(command.id, undefined, 'The turn is finishing; send it as a new message'); return; }
      if (typeof text !== 'string' || !Array.isArray(images) || !images.every(item => typeof item === 'string') || (!text.trim() && !images.length)) {
        mailbox.acknowledge(command.id, undefined, 'A non-empty message is required');
        return;
      }
      let content: string | Json[];
      try { content = userContent(spec.cwd, text, images as string[]); }
      catch (error) { mailbox.acknowledge(command.id, undefined, errorMessage(error)); return; }
      sentSinceResult += 1;
      const uuid = randomUUID();
      open.add(uuid);
      send(content, uuid);
      system(spec, 'coderfleet_message_accepted', { request_id: command.id, text, images });
      mailbox.acknowledge(command.id, { queued_in_sdk: true });
    } else mailbox.acknowledge(command.id, undefined, 'Command is unavailable for this Claude turn');
  };

  let pump: ReturnType<typeof pumpCommands> | undefined;
  // Stops the run and closes the input, so the CLI exits even when it sits idle
  // between runs (an interrupt alone does nothing then). A CLI that still does
  // not end is killed with the worker after INTERRUPT_GRACE.
  async function stop(): Promise<void> {
    if (interrupted) return;
    interrupted = true;
    accepting = false;
    for (const resolve of pending.values()) resolve({ decision: 'deny', message: 'The turn was interrupted' });
    system(spec, 'coderfleet_interrupted');
    setTimeout(() => {
      // The launcher starts the worker as a process group leader: the CLI goes with it.
      try { mailbox.close(); process.kill(-process.pid, 'SIGKILL'); } finally { process.exit(143); }
    }, INTERRUPT_GRACE).unref();
    await query?.interrupt().catch(() => undefined);
    finished();
  }
  const onSignal = (): void => { void stop(); };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  try {
    mailbox.publish('starting');
    const path = cliPath();
    system(spec, 'coderfleet_backend', { execution_backend: 'sdk', cli_version: cliVersion(path) });
    const sdk = await import(pathToFileURL(join(spec.sdk_directory, 'sdk.mjs')).href) as { query: QueryFunction };
    send(userContent(spec.cwd, spec.prompt, spec.images));
    async function* input(): AsyncGenerator<Json> {
      let ended = false;
      void done.then(() => { ended = true; wakeInput(); });
      while (true) {
        while (inbox.length) yield inbox.shift() as Json;
        if (ended) return;
        await new Promise<void>(resolve => { wakeInput = resolve; });
      }
    }
    const permissionMode = spec.auto ? 'bypassPermissions'
      : PERMISSION_MODES.has(spec.permission_mode ?? '') ? spec.permission_mode : 'acceptEdits';
    query = sdk.query({
      prompt: input(),
      options: {
        cwd: spec.cwd, pathToClaudeCodeExecutable: path, model: spec.model || undefined, resume: spec.session_id || undefined,
        ...(spec.fork_session_id && spec.session_id && spec.resume_session_at
          ? { forkSession: true, sessionId: spec.fork_session_id, resumeSessionAt: spec.resume_session_at } : {}),
        permissionMode, ...(spec.auto ? { allowDangerouslySkipPermissions: true } : {}), settingSources: ['user', 'project', 'local'], includePartialMessages: true,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        canUseTool: (toolName: string, toolInput: Json, context: Json) =>
          ask(toolName, toolInput, str(context.toolUseID) || randomUUID(), context.signal as AbortSignal | undefined),
        stderr: (data: string) => process.stderr.write(data),
      },
    });
    mailbox.publish('accepting');
    accepting = true;
    pump = pumpCommands(spec, mailbox, handle);
    let result: Json | undefined;
    let announced = false;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const close = (): void => { clearTimeout(settle); settle = undefined; accepting = false; finished(); };
    for await (const message of query) {
      if (message.type === 'command_lifecycle') {
        // The CLI reports each sent message as queued, started and ended; newer CLIs fold
        // messages sent mid-turn into the running turn, so no run of their own follows.
        if (COMMAND_ENDED.has(str(message.state))) open.delete(str(message.command_uuid));
        process.stdout.write(JSON.stringify(message) + '\n');
        if (settle && !open.size) close();
        continue;
      }
      // Output after a result means a message sent mid-turn started its own run.
      if (settle && ['assistant', 'user', 'stream_event'].includes(str(message.type))) { clearTimeout(settle); settle = undefined; result = undefined; }
      const sessionId = str(message.session_id);
      if (!announced && sessionId) {
        announced = true;
        system(spec, 'coderfleet_session', { session_id: sessionId });
        system(spec, 'coderfleet_control_ready', { capabilities: ['approval', 'answer', 'interrupt', 'message'], permission_mode: permissionMode });
      }
      process.stdout.write(JSON.stringify(message) + '\n');
      if (message.type === 'result') {
        result = message;
        // A message sent during this run may be answered by a run of its own, or merged
        // into this one (then nothing follows): wait briefly before closing the input.
        if (sentSinceResult > 0 && open.size && !interrupted) { sentSinceResult = 0; settle = setTimeout(close, FOLLOW_UP_WAIT); }
        else close();
      }
    }
    if (interrupted) return 143;
    if (!result) throw new Error('Claude Code ended without a result');
    if (result.is_error || result.subtype !== 'success') {
      const errors = list(result.errors).map(item => str(item.message)).filter(Boolean);
      throw new Error(str(result.result) || errors.join('; ') || 'Claude Code stopped with ' + str(result.subtype));
    }
    return 0;
  } catch (error) {
    if (interrupted) return 143;
    emit('error', { message: errorMessage(error) });
    return 1;
  } finally {
    finished();
    pump?.stop();
    await pump?.done.catch(() => undefined);
    mailbox.close();
  }
}

await runMain(import.meta.url, runClaude);
