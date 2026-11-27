import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { environment, lastTurn, until } from './helpers.mjs';
import { fakeAcpAgent, fakeCodex } from './fakes.mjs';

// Kimi answering with what its turn was given: the account's key and its own settings.
const fakeKimi = fakeAcpAgent.replace("chunk(name + ':' + params", "chunk(process.env.KIMI_MODEL_API_KEY + ':' + process.env.KIMI_CODE_HOME + ':' + params");
const execs = env => readFileSync(join(env.root, 'docker.log'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(call => call[0] === 'exec' && call.includes('-d'));

test('one project holds accounts of different types, each conversation with its own', { timeout: 120_000 }, async () => {
  const env = await environment({
    accounts: [
      'NAME=codex-a TYPE=codex', 'NAME=codex-b TYPE=codex', 'NAME=kimi-k TYPE=kimi AUTH=env ENV_FILE=./accounts/kimi-k/env',
      'NAME=google-a TYPE=antigravity', 'NAME=kimi-direct TYPE=kimi PROXY=off',
    ].join('\n') + '\n',
    projects: project => `NAME=web ACCOUNT=codex-a SECONDARY_ACCOUNTS=kimi-k PATH=${project}\n`,
    containers: { 'codex-web': 'running' }, bins: { codex: fakeCodex, kimi: fakeKimi },
  });
  try {
    await mkdir(join(env.workspace, 'accounts', 'kimi-k'), { recursive: true });
    await writeFile(join(env.workspace, 'accounts', 'kimi-k', 'env'), 'KIMI_MODEL_API_KEY=sk-kimi\n');
    const web = async () => (await env.get('projects')).body.find(item => item.id === 'web');
    let project = await web();
    assert.deepEqual([project.account, project.type, project.container, project.defaultAccount], ['codex-a', 'codex', 'codex-web', 'codex-a']);
    assert.deepEqual(project.accounts.map(item => [item.name, item.type, item.chat]), [['codex-a', 'codex', true], ['kimi-k', 'kimi', true]]);
    assert.deepEqual((await env.get('accounts')).body.filter(item => item.projects.length).map(item => item.name), ['codex-a', 'kimi-k']);
    // An account a project holds is not deleted from under it.
    assert.equal((await env.delete('accounts/kimi-k')).status, 400);

    assert.equal((await env.post('conversations', { projectId: 'web', account: 'google-a' })).status, 404);
    const kimi = (await env.post('conversations', { projectId: 'web', account: 'kimi-k' })).body;
    assert.deepEqual([kimi.account, kimi.type], ['kimi-k', 'kimi']);
    // The container was created before the project held this account: nothing runs until it is recreated.
    const early = await env.post('conversations/' + kimi.id + '/turns', { prompt: 'hello' });
    assert.equal(early.status, 409);
    assert.match(early.body.error, /重启这个项目后才能用/);
    await writeFile(join(env.root, 'mounts.json'), JSON.stringify({ 'codex-web': ['/workspace', '/home/byclaw/.codex', '/home/byclaw/.kimi-code'] }));
    assert.equal((await env.post('conversations/' + kimi.id + '/turns', { prompt: 'hello' })).status, 200);
    let turn = await until(() => lastTurn(env, kimi.id), value => !['starting', 'running'].includes(value.status), 'kimi turn');
    // The turn carries its own account's key and settings; the container has neither.
    assert.deepEqual([turn.status, turn.answer, turn.account, turn.type], ['done', 'sk-kimi:/home/byclaw/.kimi-code:hello:base', 'kimi-k', 'kimi']);
    const launch = execs(env).at(-1);
    assert.equal(launch[launch.indexOf('--env-file') + 1], join(env.workspace, 'accounts', 'kimi-k', 'env'));
    assert.ok(!launch.join(' ').includes('sk-kimi'));

    // A new conversation starts with the account used last; another one is chosen by name.
    project = await web();
    assert.equal(project.defaultAccount, 'kimi-k');
    assert.equal((await env.post('conversations', { projectId: 'web' })).body.account, 'kimi-k');
    const codex = (await env.post('conversations', { projectId: 'web', account: 'codex-a' })).body;
    await env.post('conversations/' + codex.id + '/turns', { prompt: 'hi' });
    turn = await until(() => lastTurn(env, codex.id), value => !['starting', 'running'].includes(value.status), 'codex turn');
    assert.deepEqual([turn.status, turn.account, turn.type], ['done', 'codex-a', 'codex']);
    assert.match(turn.answer, /^echo:hi:exec /);
    assert.ok(!execs(env).at(-1).includes('--env-file'));
    const listed = async id => (await env.get('conversations')).body.find(item => item.id === id);
    assert.deepEqual([(await listed(kimi.id)).account, (await listed(codex.id)).account], ['kimi-k', 'codex-a']);

    // The first account stays (the container is named after it), one account per type, one way out for all.
    for (const accounts of [['kimi-k'], ['kimi-k', 'codex-a'], ['codex-a', 'codex-b'], ['codex-a', 'kimi-direct'], ['codex-a', 'nobody'], []]) {
      assert.equal((await env.put('projects/web/accounts', { accounts })).status, 400, accounts.join('+'));
    }
    assert.equal((await env.put('projects/web/accounts', { accounts: ['codex-a', 'google-a'] })).status, 200);
    project = await web();
    assert.deepEqual([project.accounts.map(item => item.name), project.defaultAccount], [['codex-a', 'google-a'], 'codex-a']);
    // The conversation of the account taken out stays readable and takes no more messages.
    assert.equal((await listed(kimi.id)).account, '');
    assert.equal((await env.get('conversations/' + kimi.id + '/turns')).body.at(-1).answer, 'sk-kimi:/home/byclaw/.kimi-code:hello:base');
    const closed = await env.post('conversations/' + kimi.id + '/turns', { prompt: 'more' });
    assert.equal(closed.status, 409);
    assert.match(closed.body.error, /只能查看/);
    assert.equal((await env.delete('accounts/kimi-k')).status, 200);

    // A project can be created with several accounts at once.
    const created = await env.post('projects', { name: 'two', accounts: ['google-a', 'codex-b'], path: env.project, start: false });
    assert.equal(created.status, 201);
    const two = (await env.get('projects')).body.find(item => item.id === 'two');
    assert.deepEqual([two.account, two.container, two.accounts.map(item => item.name)], ['google-a', 'antigravity-two', ['google-a', 'codex-b']]);
    assert.equal((await env.post('projects', { name: 'bad', accounts: ['codex-a', 'codex-b'], path: env.project, start: false })).status, 400);
  } finally { await env.close(); }
});
