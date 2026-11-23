import assert from 'node:assert/strict';
import { test } from 'node:test';
import { environment, lastTurn, until } from './helpers.mjs';
import { fakeCodex } from './fakes.mjs';

test('Codex turns run with codex exec in the container', { timeout: 120_000 }, async () => {
  const env = await environment({
    accounts: 'NAME=codex-a TYPE=codex\n', projects: project => `NAME=web ACCOUNT=codex-a PATH=${project}\n`,
    containers: { 'codex-web': 'running' }, bins: { codex: fakeCodex },
  });
  try {
    assert.deepEqual((await env.get('projects/web/models')).body, []);
    const conversation = (await env.post('conversations', { projectId: 'web' })).body.id;
    await env.post('conversations/' + conversation + '/turns', { prompt: 'hello' });
    let turn = await until(() => lastTurn(env, conversation), value => !['starting', 'running'].includes(value.status), 'first turn');
    assert.equal(turn.status, 'done', turn.error);
    assert.equal(turn.answer, 'echo:hello:exec --json --skip-git-repo-check --sandbox workspace-write');
    assert.deepEqual(turn.tools.map(tool => [tool.title, tool.status]), [['Shell', 'completed']]);
    assert.equal(turn.sessionId, 'thread-1');

    await env.post('conversations/' + conversation + '/turns', { prompt: 'again' });
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'done', 'resumed turn');
    assert.equal(turn.answer, 'echo:again:exec resume thread-1 --json --skip-git-repo-check');

    await env.post('conversations/' + conversation + '/turns', { prompt: 'fail' });
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'failed', 'failed turn');
    assert.equal(turn.error, 'quota exceeded');

    await env.post('conversations/' + conversation + '/turns', { prompt: 'slow' });
    turn = await until(() => lastTurn(env, conversation), value => value.answer === 'working' && value.controlReady, 'slow turn');
    await env.post('turns/' + turn.id + '/cancel');
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'cancelled', 'cancelled turn');
  } finally { await env.close(); }
});
