import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ControlMailbox } from '../dist/control.js';
import { environment, lastTurn, until } from './helpers.mjs';

// Fake Antigravity CLI speaking ACP over stdio.
const fakeAgy = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const [command] = process.argv.slice(2);
if (command === '--version') { console.log('1.5.15'); process.exit(0); }
if (command === 'models') { console.log('flash\\tGemini Flash'); process.exit(0); }
if (command !== 'acp') process.exit(2);
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
let sessionId = ''; let model = 'base'; let promptId; let resumed = '';
const chunk = text => send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
const options = { configOptions: [{ type: 'select', category: 'mode', id: 'mode', currentValue: 'auto' }, { type: 'select', category: 'model', id: 'model', currentValue: 'base' }] };
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, result } = JSON.parse(line);
  if (method === 'initialize') send({ id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } } });
  else if (method === 'session/new') { sessionId = 'native-1'; send({ id, result: { sessionId, ...options } }); }
  else if (method === 'session/resume') { sessionId = resumed = params.sessionId; send({ id, result: options }); }
  else if (method === 'session/set_config_option') { if (params.configId === 'model') model = params.value; send({ id, result: {} }); }
  else if (method === 'session/prompt') {
    promptId = id;
    const text = params.prompt[0].text;
    if (text === 'approve') {
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write file', status: 'pending' } } });
      send({ id: 'ask', method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 't1', title: 'Write file', rawInput: { path: 'a.txt' } }, options: [{ kind: 'allow_once', optionId: 'yes' }, { kind: 'reject_once', optionId: 'no' }] } });
    } else if (text === 'slow') chunk('working');
    else { chunk('echo:' + text + ':' + model + (resumed ? ':resumed=' + resumed : '')); send({ id, result: { stopReason: 'end_turn' } }); }
  } else if (id === 'ask') {
    const allowed = result.outcome.optionId === 'yes';
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: allowed ? 'completed' : 'failed' } } });
    chunk(allowed ? 'written' : 'refused');
    send({ id: promptId, result: { stopReason: 'end_turn' } });
  } else if (method === 'session/cancel') send({ id: promptId, result: { stopReason: 'cancelled' } });
  else if (method === 'session/close') send({ id, result: {} });
}
`;

const agyEnvironment = options => environment({
  accounts: 'NAME=google-a TYPE=antigravity\nNAME=codex-a TYPE=codex\nNAME=kimi-a TYPE=kimi\n',
  projects: project => `NAME=agy ACCOUNT=google-a PATH=${project}\nNAME=other ACCOUNT=kimi-a PATH=${project}\n`,
  bins: { agy: fakeAgy }, containers: { 'antigravity-agy': 'running' }, ...options,
});

test('Antigravity turns run in the persistent project container and survive a service restart', async () => {
  const env = await agyEnvironment();
  try {
    const projects = (await env.get('projects')).body;
    assert.deepEqual(projects.map(item => [item.id, item.chat, item.state]), [['agy', true, 'running'], ['other', false, 'missing']]);
    assert.deepEqual((await env.get('projects/agy/models')).body, [{ id: 'flash', label: 'Gemini Flash' }]);
    assert.equal((await env.post('conversations', { projectId: 'other' })).status, 404);
    const conversation = (await env.post('conversations', { projectId: 'agy' })).body.id;

    // First turn: new native session with the selected model.
    assert.equal((await env.post('conversations/' + conversation + '/turns', { prompt: 'hello', model: 'flash' })).status, 200);
    let turn = await until(() => lastTurn(env, conversation), value => value.status === 'done', 'first turn');
    assert.equal(turn.answer, 'echo:hello:flash');
    assert.equal(turn.sessionId, 'native-1');
    assert.equal(turn.controlToken, undefined);
    const files = await readdir(join(env.project, '.coderfleet-tasks'));
    assert.ok(files.some(name => /^node-workers-[0-9a-f]{16}$/.test(name)));
    assert.ok(files.includes(turn.id + '.sdk.json') && files.includes(turn.id + '.exit'));
    assert.equal((await env.get('conversations')).body[0].name, 'hello');

    // Second turn resumes the saved native session.
    await env.post('conversations/' + conversation + '/turns', { prompt: 'again', model: '' });
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'done', 'resumed turn');
    assert.equal(turn.answer, 'echo:again:base:resumed=native-1');

    // Approval survives a service restart while the worker keeps running in the container.
    await env.post('conversations/' + conversation + '/turns', { prompt: 'approve', model: '' });
    turn = await until(() => lastTurn(env, conversation), value => value.permission, 'permission');
    assert.equal(turn.permission.title, 'Write file');
    assert.equal(turn.tools[0].status, 'running');
    await env.restart();
    assert.equal((await env.post('turns/' + turn.id + '/permission', { id: 'wrong', decision: 'allow' })).status, 409);
    assert.equal((await env.post('turns/' + turn.id + '/permission', { id: turn.permission.id, decision: 'allow' })).status, 200);
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'done', 'approved turn');
    assert.equal(turn.answer, 'written');
    assert.equal(turn.tools[0].status, 'completed');
    assert.equal(turn.permission, undefined);

    // Deny.
    await env.post('conversations/' + conversation + '/turns', { prompt: 'approve', model: '' });
    turn = await until(() => lastTurn(env, conversation), value => value.permission, 'second permission');
    await env.post('turns/' + turn.id + '/permission', { id: turn.permission.id, decision: 'deny' });
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'done', 'denied turn');
    assert.equal(turn.answer, 'refused');
    assert.equal(turn.tools[0].status, 'failed');

    // Cancel a running turn, then continue the conversation.
    await env.post('conversations/' + conversation + '/turns', { prompt: 'slow', model: '' });
    turn = await until(() => lastTurn(env, conversation), value => value.answer === 'working', 'slow turn');
    assert.equal((await env.post('conversations/' + conversation + '/turns', { prompt: 'overlap', model: '' })).status, 409);
    assert.equal((await env.post('turns/' + turn.id + '/cancel')).status, 200);
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'cancelled', 'cancelled turn');
    assert.equal(turn.interrupted, true);
    await env.post('conversations/' + conversation + '/turns', { prompt: 'after', model: '' });
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'done', 'turn after cancel');
    assert.equal(turn.answer, 'echo:after:base:resumed=native-1');

    // A stopped container is reported before anything is dispatched.
    assert.equal((await env.post('projects/agy/stop')).status, 200);
    await until(() => env.get('projects'), value => value.body[0].state === 'exited', 'stopped container');
    const refused = await env.post('conversations/' + conversation + '/turns', { prompt: 'late', model: '' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /not running/);
  } finally { await env.close(); }
});

test('a relay account refuses a container attached to a non-internal network', async () => {
  const env = await agyEnvironment({ network: 'bridge' });
  try {
    const created = (await env.post('conversations', { projectId: 'agy' })).body;
    const response = await env.post('conversations/' + created.id + '/turns', { prompt: 'hello' });
    assert.equal(response.status, 409);
    assert.match(response.body.error, /non-internal network bridge/);
    assert.deepEqual(await readdir(env.project), []);
  } finally { await env.close(); }
});

test('the control mailbox is interchangeable with the Python implementation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coderfleet-control-test-'));
  try {
    const token = 'a'.repeat(64);
    const directory = join(root, 'task.control');
    const node = new ControlMailbox(directory, 'task-1', token);
    node.publish('accepting');
    const script = resolve(fileURLToPath(new URL('../../coderfleet/data/scripts/coderfleet_sdk_control.py', import.meta.url)));
    const python = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('control', sys.argv[1]); module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
box = module.ControlMailbox(__import__('pathlib').Path(sys.argv[2]), 'task-1', sys.argv[3])
box.submit('from-python', 'approval', {'tool_call_id': 'x', 'decision': 'allow'})
print(json.dumps(box.reply('from-node')))
`;
    node.acknowledge('from-node', { ok: true });
    const output = execFileSync('python3', ['-I', '-c', python, script, directory, token], { encoding: 'utf8' });
    assert.equal(JSON.parse(output).status, 'accepted');
    const [command] = node.pending();
    assert.equal(command.id, 'from-python');
    assert.deepEqual(command.payload, { tool_call_id: 'x', decision: 'allow' });
    assert.equal(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).generation, node.generation);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
