import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationEvents, notificationText, watchConversations } from '../dist/notifications.js';
import { environment, lastTurn, until } from './helpers.mjs';
import { fakeClaude } from './fakes.mjs';

const item = (id, values = {}) => ({ id, projectId: 'web', name: 'name ' + id, status: 'done', attention: false, turns: 1, ...values });

test('a turn that ends or a question that comes up is an event; nothing else is', () => {
  const events = conversationEvents(
    [item('a', { status: 'running' }), item('b', { status: 'running' }), item('c'), item('d', { status: 'running' }), item('e'), item('f', { status: 'running' })],
    [item('a'), item('b', { status: 'failed' }), item('c', { turns: 2 }), item('d', { attention: true, status: 'running' }), item('e'), item('f', { status: 'cancelled' }), item('new')],
  );
  assert.deepEqual(events.map(event => event.conversation.id + ':' + event.kind), ['a:done', 'b:failed', 'c:done', 'd:attention']);
  assert.deepEqual(notificationText(events[1]), { title: 'name b', body: 'web · 失败了' });
});

test('the watcher notifies about a real backend: approval, then the finished turn', { timeout: 120_000 }, async () => {
  const env = await environment({
    accounts: 'NAME=claude-a TYPE=claude\n', projects: project => `NAME=app ACCOUNT=claude-a PATH=${project}\n`,
    containers: { 'claude-app': 'running' }, bins: { claude: fakeClaude },
  });
  const controller = new AbortController();
  const events = [];
  try {
    const conversation = (await env.post('conversations', { projectId: 'app' })).body.id;
    let polls = 0;
    const watching = watchConversations({
      signal: controller.signal, wait: 1_000,
      changes: async (since, wait) => { polls++; return (await env.get('conversations/changes?since=' + since + '&wait=' + wait)).body; },
      onEvent: event => events.push(event.kind + ':' + event.conversation.id),
    });
    await until(async () => polls, count => count >= 2, 'baseline');
    await env.post('conversations/' + conversation + '/turns', { prompt: 'tool' });
    const turn = await until(() => lastTurn(env, conversation), value => value.permission, 'permission');
    await until(async () => events, list => list.length === 1, 'attention event');
    await env.post('turns/' + turn.id + '/permission', { id: turn.permission.id, decision: 'allow' });
    await until(async () => events, list => list.length === 2, 'done event');
    assert.deepEqual(events, ['attention:' + conversation, 'done:' + conversation]);
    controller.abort();
    await watching;
  } finally {
    controller.abort();
    await env.close();
  }
});
