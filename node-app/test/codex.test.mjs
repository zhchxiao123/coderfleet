import assert from 'node:assert/strict';
import { test } from 'node:test';
import { environment, lastTurn, until } from './helpers.mjs';

// Fake Codex CLI emitting `codex exec --json` events.
const fakeCodex = `#!/usr/bin/env node
const args = process.argv.slice(2);
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let prompt = '';
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', async () => {
  prompt = prompt.trim();
  const resume = args[1] === 'resume' ? args[2] : '';
  send({ type: 'thread.started', thread_id: resume || 'thread-1' });
  send({ type: 'turn.started' });
  if (prompt === 'slow') {
    send({ type: 'item.completed', item: { id: 'm0', type: 'agent_message', text: 'working' } });
    process.on('SIGINT', () => process.exit(130));
    setInterval(() => undefined, 1000);
    return;
  }
  if (prompt === 'fail') { send({ type: 'turn.failed', error: { message: 'quota exceeded' } }); process.exit(1); }
  send({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls', status: 'in_progress' } });
  send({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls', aggregated_output: 'a.txt', exit_code: 0, status: 'completed' } });
  send({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'echo:' + prompt + ':' + args.join(' ') } });
  send({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
});
`;

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
