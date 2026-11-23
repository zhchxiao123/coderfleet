import assert from 'node:assert/strict';
import { test } from 'node:test';
import { environment, lastTurn, until } from './helpers.mjs';
import { fakeClaude } from './fakes.mjs';

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
    assert.deepEqual(turn.tools.map(tool => [tool.title, tool.status, tool.detail]), [['Bash', 'completed', 'ls']]);

    await env.post('conversations/' + conversation + '/turns', { prompt: 'tool' });
    turn = await until(() => lastTurn(env, conversation), value => value.permission, 'second permission');
    await env.post('turns/' + turn.id + '/permission', { id: turn.permission.id, decision: 'deny' });
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'done', 'denied turn');
    assert.equal(turn.answer, 'denied:Operator denied this tool');
    assert.deepEqual(turn.tools.map(tool => tool.status), ['denied']);

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
