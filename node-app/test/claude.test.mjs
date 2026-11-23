import assert from 'node:assert/strict';
import { test } from 'node:test';
import { environment, lastTurn, until } from './helpers.mjs';

// Fake Claude Code CLI speaking the SDK's stream-json control protocol.
const fakeClaude = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('2.1.330 (Claude Code)'); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const resume = argv.find(value => value.startsWith('--resume='))?.slice(9) ?? (argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : '');
const model = argv.find(value => value.startsWith('--model='))?.slice(8) ?? '';
const sessionId = resume || 'claude-session-1';
const waiting = new Map();
let sequence = 0;
const ask = (tool, input) => new Promise(resolve => {
  const id = 'req-' + (++sequence);
  waiting.set(id, resolve);
  send({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: tool, input, tool_use_id: 'tool-' + sequence } });
});
const say = text => {
  send({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  send({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text }] } });
};
const finish = (subtype = 'success', result = 'ok') => send({ type: 'result', subtype, is_error: subtype !== 'success', result, session_id: sessionId });
let interrupt;
createInterface({ input: process.stdin }).on('line', line => void handle(JSON.parse(line)));
async function handle(message) {
  if (message.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
    if (message.request.subtype === 'interrupt') interrupt?.();
    return;
  }
  if (message.type === 'control_response') { waiting.get(message.response.request_id)?.(message.response.response); return; }
  if (message.type !== 'user') return;
  send({ type: 'system', subtype: 'init', session_id: sessionId, model });
  const prompt = message.message.content;
  if (prompt === 'tool') {
    const decision = await ask('Bash', { command: 'ls' });
    send({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } }] } });
    send({ type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'x', is_error: decision.behavior !== 'allow' }] } });
    say(decision.behavior === 'allow' ? 'ran' : 'denied:' + decision.message);
    finish();
  } else if (prompt === 'ask') {
    const decision = await ask('AskUserQuestion', { questions: [{ question: 'Pick one?', header: 'Choice', multiSelect: false, options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }] }] });
    say('answer:' + JSON.stringify(decision.updatedInput.answers));
    finish();
  } else if (prompt === 'slow') {
    say('working');
    await new Promise(resolve => { interrupt = resolve; });
    finish('error_during_execution', '');
  } else {
    say('echo:' + prompt + ':' + model + (resume ? ':resumed=' + resume : ''));
    finish();
  }
}
`;

test('Claude turns run through the TypeScript Agent SDK inside the container', { timeout: 120_000 }, async () => {
  const env = await environment({
    accounts: 'NAME=claude-a TYPE=claude\n', projects: project => `NAME=app ACCOUNT=claude-a PATH=${project}\n`,
    containers: { 'claude-app': 'running' }, bins: { claude: fakeClaude },
  });
  try {
    assert.deepEqual((await env.get('projects/app/models')).body.map(item => item.id), ['opus', 'sonnet', 'haiku']);
    const conversation = (await env.post('conversations', { projectId: 'app' })).body.id;
    await env.post('conversations/' + conversation + '/turns', { prompt: 'hello', model: 'opus' });
    let turn = await until(() => lastTurn(env, conversation), value => !['starting', 'running'].includes(value.status), 'first turn');
    assert.equal(turn.status, 'done', turn.error);
    assert.equal(turn.answer, 'echo:hello:opus');
    assert.equal(turn.sessionId, 'claude-session-1');

    await env.post('conversations/' + conversation + '/turns', { prompt: 'again' });
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'done', 'resumed turn');
    assert.equal(turn.answer, 'echo:again::resumed=claude-session-1');

    // Tool approval, across a service restart.
    await env.post('conversations/' + conversation + '/turns', { prompt: 'tool' });
    turn = await until(() => lastTurn(env, conversation), value => value.permission, 'permission');
    assert.equal(turn.permission.title, 'Bash');
    assert.match(turn.permission.details, /"command": "ls"/);
    await env.restart();
    assert.equal((await env.post('turns/' + turn.id + '/permission', { id: turn.permission.id, decision: 'allow' })).status, 200);
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'done', 'approved turn');
    assert.equal(turn.answer, 'ran');
    assert.deepEqual(turn.tools.map(tool => [tool.title, tool.status]), [['Bash', 'completed']]);

    await env.post('conversations/' + conversation + '/turns', { prompt: 'tool' });
    turn = await until(() => lastTurn(env, conversation), value => value.permission, 'second permission');
    await env.post('turns/' + turn.id + '/permission', { id: turn.permission.id, decision: 'deny' });
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'done', 'denied turn');
    assert.equal(turn.answer, 'denied:Operator denied this tool');

    // Native question.
    await env.post('conversations/' + conversation + '/turns', { prompt: 'ask' });
    turn = await until(() => lastTurn(env, conversation), value => value.permission?.questions, 'question');
    assert.deepEqual(turn.permission.questions[0].options.map(option => option.label), ['A', 'B']);
    assert.equal((await env.post('turns/' + turn.id + '/permission', { id: turn.permission.id, answers: { 'Pick one?': 'B' } })).status, 200);
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'done', 'answered turn');
    assert.equal(turn.answer, 'answer:{"Pick one?":"B"}');

    // Native interrupt.
    await env.post('conversations/' + conversation + '/turns', { prompt: 'slow' });
    turn = await until(() => lastTurn(env, conversation), value => value.answer === 'working' && value.controlReady, 'slow turn');
    await env.post('turns/' + turn.id + '/cancel');
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'cancelled', 'interrupted turn');
    assert.equal(turn.interrupted, true);
  } finally { await env.close(); }
});
