import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeClaude } from './fakes.mjs';
import { environment, lastTurn, until } from './helpers.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const lines = values => values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + '\n';

/** Writes a Python-service conversation and its tasks into the workspace. */
function seed(workspace, project, conversation, tasks) {
  mkdirSync(join(workspace, 'conversations'), { recursive: true });
  mkdirSync(join(workspace, 'tasks'), { recursive: true });
  writeFileSync(join(workspace, 'conversations', conversation.id + '.json'), JSON.stringify({
    name: '历史对话', title: { source: 'auto', revision: 2 }, account: 'a', type: 'claude', project, project_name: '', native_session_id: '',
    status: 'active', mode: 'chat', created: '2026-11-01T08:00:00+00:00', updated: '2026-11-01T09:00:00+00:00', last_task_id: '', ...conversation,
  }));
  for (const [index, task] of tasks.entries()) {
    writeFileSync(join(workspace, 'tasks', task.id + '.json'), JSON.stringify({
      status: 'done', account: 'a', type: 'claude', prompt: 'p' + index, project, project_name: '', conversation_id: conversation.id,
      native_session_id: '', created: '2026-11-01T08:0' + index + ':00+00:00', execution_backend: 'cli', ...task, log: undefined,
    }));
    writeFileSync(join(workspace, 'tasks', task.id + '.log'), task.log);
  }
}

test('Python history appears in every account format and new turns continue it', { timeout: 120_000 }, async () => {
  const env = await environment({
    accounts: 'NAME=claude-a TYPE=claude\n', projects: project => `NAME=app ACCOUNT=claude-a PATH=${project}\n`,
    containers: { 'claude-app': 'running' }, bins: { claude: fakeClaude },
  });
  try {
    const tool = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
    const result = (id, error = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: error }] } });
    seed(env.workspace, env.project, { id: 'c1', native_session_id: 'claude-old' }, [
      // Claude CLI: whole assistant messages, no deltas.
      { id: 't1', native_session_id: 'claude-old', log: lines(['$ claude -p …', { type: 'system', subtype: 'init', session_id: 'claude-old' },
        tool('u1', 'Bash', { command: 'ls' }), result('u1'), { type: 'assistant', message: { content: [{ type: 'text', text: 'Listed.' }] } },
        { type: 'result', subtype: 'success', is_error: false, result: 'Listed.' }]) },
      // Claude SDK backend: streamed deltas plus the same text in the assistant message.
      { id: 't2', execution_backend: 'sdk', log: lines([
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } }]) },
      { id: 't3', status: 'killed', interrupted: true, log: lines([{ type: 'assistant', message: { content: [{ type: 'text', text: 'Stopped' }] } }]) },
      { id: 't4', status: 'failed', log: lines([{ type: 'result', subtype: 'error', is_error: true, result: 'quota exceeded' }]) },
      { id: 't5', status: 'pending', log: '' },
    ]);
    seed(env.workspace, env.project, { id: 'c2', type: 'codex', project_name: 'app', native_session_id: 'thread-9' }, [
      { id: 'x1', type: 'codex', native_session_id: 'thread-9', log: lines([{ type: 'thread.started', thread_id: 'thread-9' },
        { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'npm test' } },
        { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'npm test', exit_code: 1, status: 'failed' } },
        { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'Tests fail.' } }]) },
    ]);
    seed(env.workspace, env.project, { id: 'c3', type: 'opencode', project_name: 'app' }, [
      { id: 'o1', type: 'opencode', log: lines([{ type: 'step_start', sessionID: 'ses_old' },
        { type: 'tool_use', part: { callID: 'k', tool: 'read', state: { status: 'completed', input: { filePath: 'a.ts' } } } },
        { type: 'text', part: { type: 'text', text: 'Read it.' } }]) },
    ]);
    seed(env.workspace, env.project, { id: 'c4', type: 'kimi', project_name: 'app' }, [
      { id: 'k1', type: 'kimi', log: lines([{ role: 'assistant', content: 'Working', tool_calls: [{ id: 'q', function: { name: 'Shell', arguments: '{"command":"make"}' } }] },
        { role: 'tool', tool_call_id: 'q', content: 'ok' }, { role: 'meta', type: 'session.resume_hint', session_id: 'kimi-old' }]) },
    ]);
    seed(env.workspace, env.project, { id: 'c5', type: 'grok', project_name: 'app' }, [
      { id: 'g1', type: 'grok', log: lines(['grok_session_id=grok-old', { type: 'text_delta', text: 'Hi ' }, { type: 'text', data: 'there' }]) },
    ]);
    seed(env.workspace, env.project, { id: 'c6', type: 'pi', project_name: 'app' }, [
      { id: 'p1', type: 'pi', log: lines([{ type: 'session', id: 'pi-old' }, { type: 'tool_execution_start', toolCallId: 'z', toolName: 'bash', args: { command: 'ls' } },
        { type: 'tool_execution_end', toolCallId: 'z', isError: false }, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }]) },
    ]);
    seed(env.workspace, env.project, { id: 'c7', type: 'hermes', project_name: 'app' }, [
      { id: 'h1', type: 'hermes', log: 'Line one\nLine two\nSession: hermes-old\n' },
    ]);
    seed(env.workspace, env.project, { id: 'c8', status: 'archived' }, []);
    // The store rescans the workspace at most once a second.
    await new Promise(resolve => setTimeout(resolve, 1_100));

    const conversations = (await env.get('conversations')).body;
    assert.deepEqual(conversations.map(item => item.id).sort(), ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
    assert.ok(conversations.every(item => item.projectId === 'app'), 'conversations without project_name map by path');
    const c1 = conversations.find(item => item.id === 'c1');
    assert.deepEqual([c1.name, c1.turns, c1.status], ['历史对话', 5, 'queued']);

    const view = async id => (await env.get('conversations/' + id + '/turns')).body;
    const old = await view('c1');
    assert.deepEqual(old.map(turn => turn.status), ['done', 'done', 'cancelled', 'failed', 'queued']);
    assert.equal(old[0].answer, 'Listed.');
    assert.deepEqual(old[0].tools.map(item => [item.title, item.status, item.detail]), [['Bash', 'completed', 'ls']]);
    assert.deepEqual(old[0].blocks.map(block => block.kind), ['tool', 'text']);
    assert.equal(old[0].sessionId, 'claude-old');
    assert.equal(old[1].answer, 'Hello', 'deltas only, not the repeated assistant text');
    assert.equal(old[3].error, 'quota exceeded');
    const codex = (await view('c2'))[0];
    assert.deepEqual([codex.answer, codex.tools[0].title, codex.tools[0].status, codex.tools[0].detail], ['Tests fail.', 'Shell', 'failed', 'npm test']);
    const opencode = (await view('c3'))[0];
    assert.deepEqual([opencode.answer, opencode.tools[0].detail, opencode.sessionId], ['Read it.', 'a.ts', 'ses_old']);
    const kimi = (await view('c4'))[0];
    assert.deepEqual([kimi.answer, kimi.tools[0].detail, kimi.tools[0].status, kimi.sessionId], ['Working', 'make', 'completed', 'kimi-old']);
    assert.equal((await view('c5'))[0].answer, 'Hi there');
    assert.equal((await view('c6'))[0].answer, 'Done.');
    const hermes = (await view('c7'))[0];
    assert.deepEqual([hermes.answer, hermes.sessionId], ['Line one\nLine two\n', 'hermes-old']);

    // A queued Python task blocks new turns in its conversation.
    assert.equal((await env.post('conversations/c1/turns', { prompt: 'next' })).status, 409);
    // A conversation of another account type cannot continue on this project's Claude account.
    assert.equal((await env.post('conversations/c2/turns', { prompt: 'next' })).status, 409);

    // A new turn in an old Claude conversation resumes its native session and is stored the Python way.
    seed(env.workspace, env.project, { id: 'c9', native_session_id: 'claude-old', project_name: 'app' }, [{ id: 'q1', log: '' }]);
    await new Promise(resolve => setTimeout(resolve, 1_100));
    await env.post('conversations/c9/turns', { prompt: 'again' });
    const resumed = await until(() => lastTurn(env, 'c9'), value => value.status === 'done', 'resumed turn');
    assert.equal(resumed.answer, 'echo:again::resumed=claude-old');
    const task = JSON.parse(readFileSync(join(env.workspace, 'tasks', resumed.id + '.json'), 'utf8'));
    assert.deepEqual([task.status, task.conversation_id, task.native_session_id, task.execution_backend, task.project], ['done', 'c9', 'claude-old', 'sdk', env.project]);
    assert.match(readFileSync(join(env.workspace, 'tasks', resumed.id + '.log'), 'utf8'), /echo:again/);
    const conversation = JSON.parse(readFileSync(join(env.workspace, 'conversations', 'c9.json'), 'utf8'));
    assert.deepEqual([conversation.native_session_id, conversation.last_task_id], ['claude-old', resumed.id]);

    // After a restart the turn is rebuilt from the workspace files alone.
    await env.restart();
    const again = await lastTurn(env, 'c9');
    assert.deepEqual([again.answer, again.status, again.sessionId], ['echo:again::resumed=claude-old', 'done', 'claude-old']);

    // A new conversation started here is readable by the Python models.
    const created = (await env.post('conversations', { projectId: 'app' })).body.id;
    await env.post('conversations/' + created + '/turns', { prompt: 'fresh' });
    const fresh = await until(() => lastTurn(env, created), value => value.status === 'done', 'fresh turn');
    try { execFileSync('uv', ['--version'], { stdio: 'ignore' }); } catch { return; }
    const script = `
import sys
from pathlib import Path
from coderfleet.server.models import Conversation, Task
ws = Path(sys.argv[1])
c = Conversation.load(ws / 'conversations' / (sys.argv[2] + '.json'))
t = Task.load(ws / 'tasks' / (sys.argv[3] + '.json'))
print(c.name, c.type.value, c.native_session_id, t.status.value, t.conversation_id == c.id, t.native_session_id)
`;
    const output = execFileSync('uv', ['run', '--quiet', 'python', '-c', script, env.workspace, created, fresh.id], { cwd: repository, encoding: 'utf8' });
    assert.equal(output.trim(), 'fresh claude claude-session-1 done True claude-session-1');
  } finally { await env.close(); }
});

test('a turn the Python service runs is stopped there, never marked by this service', { timeout: 60_000 }, async () => {
  const env = await environment({
    accounts: 'NAME=claude-a TYPE=claude\n', projects: project => `NAME=app ACCOUNT=claude-a PATH=${project}\n`,
    containers: { 'claude-app': 'running' }, bins: { claude: fakeClaude },
  });
  const stops = [];
  const python = createServer((request, response) => {
    if (request.method === 'DELETE') stops.push([request.url, request.headers.authorization]);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(request.url === '/api/health' ? { status: 'ok', workspace: env.workspace } : { id: 'py1' }));
  });
  try {
    // Started long ago by the Python service (no "node" fields): older than this service's start grace.
    seed(env.workspace, env.project, { id: 'pc', project_name: 'app' }, [
      { id: 'py1', status: 'running', execution_backend: 'sdk', log: lines([{ type: 'assistant', message: { content: [{ type: 'text', text: 'Working' }] } }]) },
    ]);
    await until(() => env.get('conversations/pc/turns'), value => value.body.at?.(-1)?.id === 'py1', 'seeded turn');
    const refused = await env.post('turns/py1/cancel');
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /原 Python 服务运行，它现在没有运行/);
    let turn = await lastTurn(env, 'pc');
    assert.deepEqual([turn.status, turn.error], ['running', undefined], 'the view is not marked as failed');

    await new Promise(resolve => python.listen(0, '127.0.0.1', resolve));
    appendFileSync(join(env.workspace, 'config.conf'), 'CODERFLEET_PORT=' + python.address().port + '\n');
    writeFileSync(join(env.workspace, 'api_key.txt'), 'python-key\n');
    assert.equal((await env.post('turns/py1/cancel')).status, 200);
    assert.deepEqual(stops, [['/api/tasks/py1', 'Bearer python-key']]);
    turn = await lastTurn(env, 'pc');
    assert.deepEqual([turn.status, turn.error], ['running', undefined], 'the Python service records the outcome');
  } finally { python.close(); await env.close(); }
});
