import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { environment, lastTurn, until } from './helpers.mjs';
import { fakeCodex } from './fakes.mjs';

test('conversations are archived, restored and deleted like in the Python service', { timeout: 120_000 }, async () => {
  const env = await environment({
    accounts: 'NAME=codex-a TYPE=codex\n', projects: project => `NAME=web ACCOUNT=codex-a PATH=${project}\n`,
    containers: { 'codex-web': 'running' }, bins: { codex: fakeCodex },
  });
  try {
    const id = (await env.post('conversations', { projectId: 'web' })).body.id;
    await env.post('conversations/' + id + '/turns', { prompt: 'hello' });
    const turn = await until(() => lastTurn(env, id), value => value.status === 'done', 'turn');
    const file = join(env.workspace, 'conversations', id + '.json');
    const listed = async archived => (await env.get('conversations' + (archived ? '?archived=1' : ''))).body.map(item => item.id);

    assert.equal((await env.put('conversations/' + id, { archived: true })).status, 200);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).status, 'archived');
    assert.deepEqual(await listed(false), []);
    assert.deepEqual(await listed(true), [id]);
    // Still readable, and writing in it brings it back.
    assert.equal((await env.get('conversations/' + id + '/turns')).body.length, 1);
    await env.post('conversations/' + id + '/turns', { prompt: 'again' });
    await until(() => lastTurn(env, id), value => value.prompt === 'again' && value.status === 'done', 'second turn');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).status, 'active');
    assert.deepEqual(await listed(false), [id]);

    await env.put('conversations/' + id, { archived: true });
    await env.put('conversations/' + id, { archived: false });
    assert.deepEqual(await listed(false), [id]);

    // Deleting removes the record; the task records stay (as in Python).
    assert.equal((await env.del('conversations/' + id)).status, 200);
    assert.equal(existsSync(file), false);
    assert.ok(existsSync(join(env.workspace, 'tasks', turn.id + '.json')));
    assert.deepEqual(await listed(false), []);
    assert.equal((await env.del('conversations/' + id)).status, 404);
  } finally {
    await env.close();
  }
});
