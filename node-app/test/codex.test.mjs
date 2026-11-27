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
    // The account's own picker list: hidden models left out, in Codex's order.
    assert.deepEqual((await env.get('projects/web/models')).body, [
      { id: 'gpt-a', label: 'GPT A', title: 'GPT A model' }, { id: 'gpt-b', label: 'GPT B', title: 'GPT B model' },
    ]);
    const conversation = (await env.post('conversations', { projectId: 'web' })).body.id;
    await env.post('conversations/' + conversation + '/turns', { prompt: 'hello' });
    let turn = await until(() => lastTurn(env, conversation), value => !['starting', 'running'].includes(value.status), 'first turn');
    assert.equal(turn.status, 'done', turn.error);
    assert.match(turn.answer, /^echo:hello:exec --experimental-json --sandbox danger-full-access --cd \S+ --skip-git-repo-check --config approval_policy="never"$/);
    assert.deepEqual(turn.tools.map(tool => [tool.title, tool.status, tool.detail]), [['Shell', 'completed', 'ls']]);
    assert.equal(turn.sessionId, 'thread-1');

    await env.post('conversations/' + conversation + '/turns', { prompt: 'again' });
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'done', 'resumed turn');
    assert.match(turn.answer, /^echo:again:exec --experimental-json .*--skip-git-repo-check .*resume thread-1$/);

    await env.post('conversations/' + conversation + '/turns', { prompt: 'fail' });
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'failed', 'failed turn');
    assert.equal(turn.error, 'quota exceeded');

    // Auto mode runs the same way; the chosen model is passed on; images are local_image inputs.
    const upload = (await env.post('projects/web/uploads', { name: 'a.jpg', data: Buffer.from('ffd8ffe0', 'hex').toString('base64') })).body;
    await env.post('conversations/' + conversation + '/turns', { prompt: 'pic', images: [upload.path], auto: true, model: 'gpt-a' });
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'done', 'auto turn');
    assert.match(turn.answer, /--sandbox danger-full-access/);
    assert.match(turn.answer, /approval_policy="never"/);
    assert.match(turn.answer, /--model gpt-a /);
    assert.match(turn.answer, new RegExp('--image \\S+/\\.coderfleet-uploads/' + upload.path.split('/').pop()));

    // Codex cannot take a message mid-turn: it waits and becomes the next turn.
    await env.post('conversations/' + conversation + '/turns', { prompt: 'slow' });
    turn = await until(() => lastTurn(env, conversation), value => value.answer === 'working' && value.controlReady, 'slow turn');
    const queued = (await env.post('conversations/' + conversation + '/turns', { prompt: 'next one' })).body;
    assert.equal(queued.delivered, 'queued');
    const pending = (await env.get('conversations/' + conversation + '/follow-ups')).body;
    assert.deepEqual(pending.map(item => item.text), ['next one']);
    await env.post('turns/' + turn.id + '/cancel');
    turn = await until(() => lastTurn(env, conversation), value => value.prompt === 'next one' && value.status === 'done', 'follow-up turn');
    assert.match(turn.answer, /^echo:next one:/);
    assert.deepEqual((await env.get('conversations/' + conversation + '/follow-ups')).body, []);
    // A queued message can be withdrawn before it is sent.
    await env.post('conversations/' + conversation + '/turns', { prompt: 'slow' });
    turn = await until(() => lastTurn(env, conversation), value => value.prompt === 'slow' && value.controlReady && value.status === 'running', 'second slow turn');
    const withdrawn = (await env.post('conversations/' + conversation + '/turns', { prompt: 'never mind' })).body.followUp;
    assert.equal((await env.delete('conversations/' + conversation + '/follow-ups/' + withdrawn.id)).status, 200);
    await env.post('turns/' + turn.id + '/cancel');
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'cancelled', 'cancelled turn');
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal((await lastTurn(env, conversation)).prompt, 'slow', 'the withdrawn message was not sent');
  } finally { await env.close(); }
});
