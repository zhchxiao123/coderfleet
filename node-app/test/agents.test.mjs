import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fakeAcpAgent, fakeHermes, fakeOpencode, fakePiSdk } from './fakes.mjs';
import { environment, lastTurn, until } from './helpers.mjs';

const settled = value => !['starting', 'running'].includes(value.status);

/** A workspace with one project for `type`, its container running, and `bins` on the container PATH. */
function agentEnvironment(type, bins) {
  return environment({
    accounts: `NAME=${type}-a TYPE=${type}\n`, projects: project => `NAME=app ACCOUNT=${type}-a PATH=${project}\n`,
    containers: { [type + '-app']: 'running' }, bins,
  });
}

async function turn(env, conversation, prompt, model = '') {
  assert.equal((await env.post('conversations/' + conversation + '/turns', { prompt, model })).status, 200);
  return until(() => lastTurn(env, conversation), settled, prompt);
}

for (const type of ['kimi', 'grok']) {
  test(type + ' conversations run through the ACP worker', { timeout: 120_000 }, async () => {
    const env = await agentEnvironment(type, { [type]: fakeAcpAgent });
    try {
      const conversation = (await env.post('conversations', { projectId: 'app' })).body.id;
      let result = await turn(env, conversation, 'hello', 'turbo');
      assert.equal(result.status, 'done', result.error);
      assert.equal(result.answer, type + ':hello:turbo');
      assert.equal(result.sessionId, type + '-session');
      result = await turn(env, conversation, 'again');
      assert.equal(result.answer, type + ':again:base:resumed=' + type + '-session');
      await env.post('conversations/' + conversation + '/turns', { prompt: 'approve' });
      result = await until(() => lastTurn(env, conversation), value => value.permission, 'permission');
      assert.deepEqual(result.tools.map(tool => [tool.title, tool.status, tool.detail]), [['Shell', 'waiting', 'make']]);
      await env.post('turns/' + result.id + '/permission', { id: result.permission.id, decision: 'allow' });
      result = await until(() => lastTurn(env, conversation), settled, 'approved');
      assert.equal(result.answer, 'built');
      assert.equal(result.tools[0].status, 'completed');
    } finally { await env.close(); }
  });
}

test('OpenCode conversations run through the OpenCode SDK and a server in the container', { timeout: 120_000 }, async () => {
  const env = await agentEnvironment('opencode', { opencode: fakeOpencode });
  try {
    const conversation = (await env.post('conversations', { projectId: 'app' })).body.id;
    let result = await turn(env, conversation, 'hello', 'opencode/big-pickle');
    assert.equal(result.status, 'done', result.error);
    assert.equal(result.answer, 'opencode:hello:opencode/big-pickle:ses_1', 'streamed delta plus the missing rest, without the user text');
    assert.equal(result.sessionId, 'ses_1');
    result = await turn(env, conversation, 'again');
    assert.equal(result.answer, 'opencode:again:default:ses_1');

    await env.post('conversations/' + conversation + '/turns', { prompt: 'approve' });
    result = await until(() => lastTurn(env, conversation), value => value.permission, 'permission');
    assert.equal(result.permission.title, 'bash');
    assert.deepEqual(result.tools.map(tool => [tool.title, tool.status, tool.detail]), [['bash', 'waiting', 'make']]);
    await env.post('turns/' + result.id + '/permission', { id: result.permission.id, decision: 'deny' });
    result = await until(() => lastTurn(env, conversation), settled, 'denied');
    assert.equal(result.tools[0].status, 'denied');

    await env.post('conversations/' + conversation + '/turns', { prompt: 'slow' });
    result = await until(() => lastTurn(env, conversation), value => value.answer === 'working', 'slow');
    await env.post('turns/' + result.id + '/cancel');
    result = await until(() => lastTurn(env, conversation), settled, 'cancelled');
    assert.equal(result.status, 'cancelled');
  } finally { await env.close(); }
});

test('Pi conversations run in-process through the Pi SDK', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coderfleet-pi-'));
  writeFileSync(join(dir, 'pi.mjs'), fakePiSdk);
  Object.assign(process.env, { CODERFLEET_PI_SDK: join(dir, 'pi.mjs'), FAKE_PI_STORE: join(dir, 'sessions') });
  const env = await agentEnvironment('pi', {});
  try {
    const conversation = (await env.post('conversations', { projectId: 'app' })).body.id;
    let result = await turn(env, conversation, 'hello');
    assert.equal(result.status, 'done', result.error);
    assert.equal(result.answer, 'echo:hello');
    assert.deepEqual(result.tools.map(tool => [tool.title, tool.status, tool.detail]), [['bash', 'completed', 'ls']]);
    const session = result.sessionId;
    result = await turn(env, conversation, 'again');
    assert.equal(result.answer, 'echo:again:resumed=' + session);
    result = await turn(env, conversation, 'fail');
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'no API key');
    await env.post('conversations/' + conversation + '/turns', { prompt: 'slow' });
    result = await until(() => lastTurn(env, conversation), value => value.answer === 'working' && value.controlReady, 'slow');
    await env.post('turns/' + result.id + '/cancel');
    result = await until(() => lastTurn(env, conversation), settled, 'cancelled');
    assert.equal(result.status, 'cancelled');
  } finally {
    delete process.env.CODERFLEET_PI_SDK;
    await env.close();
  }
});

test('Hermes conversations use stream-json, or plain text on an older CLI', { timeout: 120_000 }, async () => {
  const env = await agentEnvironment('hermes', { hermes: fakeHermes });
  try {
    const conversation = (await env.post('conversations', { projectId: 'app' })).body.id;
    let result = await turn(env, conversation, 'tools');
    assert.equal(result.status, 'done', result.error);
    assert.equal(result.answer, 'echo:tools');
    assert.deepEqual(result.tools.map(tool => [tool.title, tool.status, tool.detail]), [['terminal', 'completed', 'ls'], ['terminal', 'failed', 'false']]);
    assert.equal(result.sessionId, 'hermes-session');
    result = await turn(env, conversation, 'again');
    assert.equal(result.answer, 'echo:again:resumed=hermes-session');
    result = await turn(env, conversation, 'fail');
    assert.equal(result.error, 'provider quota exceeded');

    process.env.FAKE_HERMES_PLAIN = '1';
    const plain = (await env.post('conversations', { projectId: 'app' })).body.id;
    result = await turn(env, plain, 'hello');
    assert.equal(result.status, 'done', result.error);
    assert.equal(result.answer, 'echo:hello\n');
    assert.equal(result.sessionId, 'hermes-session');
  } finally {
    delete process.env.FAKE_HERMES_PLAIN;
    await env.close();
  }
});
