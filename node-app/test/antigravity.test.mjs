import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ControlMailbox } from '../dist/control.js';
import { environment, lastTurn, until } from './helpers.mjs';
import { fakeAgy } from './fakes.mjs';

const agyEnvironment = options => environment({
  accounts: 'NAME=google-a TYPE=antigravity\nNAME=codex-a TYPE=codex\nNAME=kimi-a TYPE=kimi\n',
  projects: project => `NAME=agy ACCOUNT=google-a PATH=${project}\nNAME=other ACCOUNT=kimi-a PATH=${project}\n`,
  bins: { agy: fakeAgy }, containers: { 'antigravity-agy': 'running' }, ...options,
});

test('Antigravity turns run in the persistent project container and survive a service restart', async () => {
  const env = await agyEnvironment();
  try {
    const projects = (await env.get('projects')).body;
    assert.deepEqual(projects.map(item => [item.id, item.chat, item.state]), [['agy', true, 'running'], ['other', true, 'missing']]);
    assert.deepEqual((await env.get('projects/agy/models')).body, [{ id: 'flash', label: 'Gemini Flash' }]);
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
    assert.equal(turn.tools[0].status, 'waiting');
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
    assert.equal(turn.tools[0].status, 'denied');

    // Auto mode approves without asking.
    await env.post('conversations/' + conversation + '/turns', { prompt: 'approve', model: '', auto: true });
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'done' || value.permission, 'auto turn');
    assert.equal(turn.permission, undefined);
    assert.equal(turn.answer, 'written');
    // Without image support in the agent, images are listed as paths in the prompt.
    const upload = (await env.post('projects/' + (await env.get('conversations')).body.find(item => item.id === conversation).projectId + '/uploads',
      { name: 'b.webp', data: Buffer.from('RIFF').toString('base64') })).body;
    await env.post('conversations/' + conversation + '/turns', { prompt: 'look', model: '', images: [upload.path] });
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'done', 'image turn');
    assert.match(turn.answer, new RegExp('^echo:look\\n\\n\\[Attached images:\\n\\S+/\\.coderfleet-uploads/' + upload.path.split('/').pop() + '\\]'));

    // Cancel a running turn, then continue the conversation.
    await env.post('conversations/' + conversation + '/turns', { prompt: 'slow', model: '' });
    turn = await until(() => lastTurn(env, conversation), value => value.answer === 'working', 'slow turn');
    // ACP agents take no message mid-turn: it waits and runs after this turn.
    assert.equal((await env.post('conversations/' + conversation + '/turns', { prompt: 'overlap', model: '' })).body.delivered, 'queued');
    const slowId = turn.id;
    assert.equal((await env.post('turns/' + turn.id + '/cancel')).status, 200);
    turn = await until(async () => (await env.get('conversations/' + conversation + '/turns')).body.find(item => item.id === slowId), value => value.status === 'cancelled', 'cancelled turn');
    assert.equal(turn.interrupted, true);
    turn = await until(() => lastTurn(env, conversation), value => value.prompt === 'overlap' && value.status === 'done', 'queued turn');
    assert.equal(turn.answer, 'echo:overlap:base:resumed=native-1');
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

test('the control mailbox carries a command to the worker and its reply back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coderfleet-control-test-'));
  try {
    const token = 'a'.repeat(64);
    const directory = join(root, 'task.control');
    const worker = new ControlMailbox(directory, 'task-1', token);
    const service = new ControlMailbox(directory, 'task-1', token);
    worker.publish('accepting');
    service.submit('from-service', 'approval', { tool_call_id: 'x', decision: 'allow' });
    const [command] = worker.pending();
    assert.equal(command.id, 'from-service');
    assert.deepEqual(command.payload, { tool_call_id: 'x', decision: 'allow' });
    worker.acknowledge(command.id, { ok: true });
    assert.deepEqual([service.reply('from-service').status, worker.pending().length], ['accepted', 0]);
    assert.equal(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).generation, worker.generation);
    // Another run's capability cannot read this run's channel.
    assert.throws(() => new ControlMailbox(directory, 'task-1', 'b'.repeat(64)).state(), /another Task run/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
