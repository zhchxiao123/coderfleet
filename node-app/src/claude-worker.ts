// Runs one Claude Code turn inside the project's persistent container with the
// TypeScript Claude Agent SDK. Follows coderfleet_claude_sdk_worker.py:
// acceptEdits by default, tool approvals and native questions through the
// control mailbox, native interrupt, resume by session ID. SDK messages are
// written to stdout unchanged; CoderFleet events are `system` lines.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Command } from './control.js';
import { emit, errorMessage, list, object, openMailbox, pumpCommands, runMain, str, system, writeState, type BaseSpec, type Json } from './worker-kit.js';

export interface ClaudeSpec extends BaseSpec { sdk_directory: string; permission_mode?: string }

type Decision = { decision: 'allow' | 'deny'; answers?: Record<string, string>; message?: string };
type PermissionResult = { behavior: 'allow'; updatedInput: Json } | { behavior: 'deny'; message: string };
interface Query extends AsyncIterable<Json> { interrupt(): Promise<unknown> }
type QueryFunction = (input: { prompt: AsyncIterable<Json>; options: Json }) => Query;

const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan']);

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
      if (!interrupted) {
        interrupted = true;
        for (const resolve of pending.values()) resolve({ decision: 'deny', message: 'The turn was interrupted' });
        await query?.interrupt().catch(() => undefined);
        system(spec, 'coderfleet_interrupted');
      }
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
    } else mailbox.acknowledge(command.id, undefined, 'Command is unavailable for this Claude turn');
  };

  let pump: ReturnType<typeof pumpCommands> | undefined;
  const onSignal = (): void => {
    if (interrupted) return;
    interrupted = true;
    for (const resolve of pending.values()) resolve({ decision: 'deny', message: 'The turn was interrupted' });
    void query?.interrupt().catch(() => undefined);
    system(spec, 'coderfleet_interrupted');
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  try {
    mailbox.publish('starting');
    const path = cliPath();
    system(spec, 'coderfleet_backend', { execution_backend: 'sdk', cli_version: cliVersion(path) });
    const sdk = await import(pathToFileURL(join(spec.sdk_directory, 'sdk.mjs')).href) as { query: QueryFunction };
    async function* input(): AsyncGenerator<Json> {
      yield { type: 'user', session_id: '', parent_tool_use_id: null, uuid: randomUUID(), message: { role: 'user', content: spec.prompt } };
      await done;
    }
    const permissionMode = PERMISSION_MODES.has(spec.permission_mode ?? '') ? spec.permission_mode : 'acceptEdits';
    query = sdk.query({
      prompt: input(),
      options: {
        cwd: spec.cwd, pathToClaudeCodeExecutable: path, model: spec.model || undefined, resume: spec.session_id || undefined,
        permissionMode, settingSources: ['user', 'project', 'local'], includePartialMessages: true,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        canUseTool: (toolName: string, toolInput: Json, context: Json) =>
          ask(toolName, toolInput, str(context.toolUseID) || randomUUID(), context.signal as AbortSignal | undefined),
        stderr: (data: string) => process.stderr.write(data),
      },
    });
    mailbox.publish('accepting');
    pump = pumpCommands(spec, mailbox, handle);
    let result: Json | undefined;
    let announced = false;
    for await (const message of query) {
      const sessionId = str(message.session_id);
      if (!announced && sessionId) {
        announced = true;
        system(spec, 'coderfleet_session', { session_id: sessionId });
        system(spec, 'coderfleet_control_ready', { capabilities: ['approval', 'answer', 'interrupt'], permission_mode: permissionMode });
      }
      process.stdout.write(JSON.stringify(message) + '\n');
      if (message.type === 'result') { result = message; finished(); }
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
