import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deviceAllowed } from '../dist/server.js';
import { pairingLink, phoneUrl, privateHost } from '../dist/mobile.js';
import { environment, until } from './helpers.mjs';
import { fakeClaude } from './fakes.mjs';

test('a paired phone gets a chat-only token that can be revoked', { timeout: 120_000 }, async () => {
  const env = await environment({
    accounts: 'NAME=claude-a TYPE=claude\n', projects: project => `NAME=app ACCOUNT=claude-a PATH=${project}\n`,
    containers: { 'claude-app': 'running' }, bins: { claude: fakeClaude },
  });
  try {
    // No address yet: pairing explains what to set up.
    assert.equal((await env.post('devices', { name: 'iPhone' })).status, 409);
    const saved = await env.put('mobile', { addresses: [{ url: 'https://cf.example.com/' }, { url: 'http://10.147.17.5:8877' }] });
    assert.deepEqual(saved.body.extra.map(item => [item.url, item.kind]), [['https://cf.example.com', 'public'], ['http://10.147.17.5:8877', 'mesh']]);
    assert.equal((await env.put('mobile', { addresses: [{ url: 'http://cf.example.com' }] })).status, 400, 'public http is refused');

    const paired = (await env.post('devices', { name: 'iPhone', backendName: '本机' })).body;
    const link = new URL(paired.link);
    assert.equal(link.protocol, 'coderfleet:');
    assert.deepEqual(link.searchParams.getAll('url'), ['https://cf.example.com', 'http://10.147.17.5:8877']);
    const phone = link.searchParams.get('token');
    assert.match(phone, /^cfd_/);

    // The phone can chat...
    assert.equal((await env.as(phone, 'GET', 'device')).body.name, 'iPhone');
    const conversation = (await env.as(phone, 'POST', 'conversations', { projectId: 'app' })).body.id;
    assert.equal((await env.as(phone, 'POST', 'conversations/' + conversation + '/turns', { prompt: 'hello' })).status, 200);
    await until(async () => (await env.as(phone, 'GET', 'conversations/' + conversation + '/turns')).body.at(-1), turn => turn?.status === 'done', 'phone turn');
    // ...but not manage the computer.
    for (const [method, path] of [['GET', 'accounts'], ['GET', 'settings'], ['POST', 'projects/app/terminal'], ['GET', 'mobile'], ['POST', 'devices'], ['DELETE', 'projects/app']]) {
      assert.equal((await env.as(phone, method, path, {})).status, 403, method + ' ' + path);
    }
    // The desktop sees when and from where it was used, and revokes it.
    const listed = (await env.get('mobile')).body.devices;
    assert.equal(listed[0].name, 'iPhone');
    assert.ok(listed[0].lastUsedAt);
    assert.equal((await env.delete('devices/' + listed[0].id)).status, 200);
    assert.equal((await env.as(phone, 'GET', 'conversations')).status, 401);
  } finally { await env.close(); }
});

test('repeated wrong tokens are slowed down; the right token still works', async () => {
  const env = await environment();
  try {
    const statuses = [];
    for (let index = 0; index < 6; index += 1) statuses.push((await env.as('cfd_wrong', 'GET', 'health')).status);
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
    assert.equal((await env.get('health')).status, 200, 'the owner is never locked out');
    assert.equal((await env.as('cfd_wrong', 'GET', 'health')).status, 401, 'a valid request clears the address');
  } finally { await env.close(); }
});

test('change feeds answer at once on a change and wait otherwise', { timeout: 120_000 }, async () => {
  const env = await environment({
    accounts: 'NAME=claude-a TYPE=claude\n', projects: project => `NAME=app ACCOUNT=claude-a PATH=${project}\n`,
    containers: { 'claude-app': 'running' }, bins: { claude: fakeClaude },
  });
  try {
    const list = (await env.get('conversations/changes')).body;
    assert.deepEqual(list.conversations, []);
    let started = Date.now();
    assert.equal((await env.get('conversations/changes?since=' + list.etag + '&wait=600')).body.unchanged, true);
    assert.ok(Date.now() - started >= 500, 'an unchanged list waits');

    const conversation = (await env.post('conversations', { projectId: 'app' })).body.id;
    const listed = (await env.get('conversations/changes?since=' + list.etag + '&wait=5000')).body;
    assert.deepEqual(listed.conversations.map(item => item.id), [conversation]);

    let feed = (await env.get('conversations/' + conversation + '/changes')).body;
    assert.deepEqual([feed.full, feed.turns, feed.order], [true, [], []]);
    await env.post('conversations/' + conversation + '/turns', { prompt: 'first' });
    await until(async () => (await env.get('conversations/' + conversation + '/turns')).body.at(-1), turn => turn?.status === 'done', 'first turn');
    feed = (await env.get('conversations/' + conversation + '/changes?since=' + feed.etag + '&wait=5000')).body;
    assert.equal(feed.full, false);
    assert.equal(feed.order.length, 1);
    const firstId = feed.order[0];
    // Wait for the record to settle, then only the new turn comes back.
    const settled = (await env.get('conversations/' + conversation + '/changes?since=' + feed.etag + '&wait=1500')).body;
    const since = settled.unchanged ? feed.etag : settled.etag;
    await env.post('conversations/' + conversation + '/turns', { prompt: 'second' });
    const next = (await env.get('conversations/' + conversation + '/changes?since=' + since + '&wait=5000')).body;
    assert.equal(next.order.length, 2);
    assert.ok(next.turns.every(turn => turn.id !== firstId), 'the unchanged first turn is not sent again');
    started = Date.now();
    const unknown = (await env.get('conversations/' + conversation + '/changes?since=unknown&wait=5000')).body;
    assert.equal(unknown.full, true, 'an unknown etag gets everything');
    assert.ok(Date.now() - started < 2000);
  } finally { await env.close(); }
});

test('phone addresses: https anywhere, http only to private and mesh hosts', () => {
  assert.equal(phoneUrl('https://cf.example.com/'), 'https://cf.example.com');
  assert.equal(phoneUrl('http://192.168.1.20:8877'), 'http://192.168.1.20:8877');
  assert.equal(phoneUrl('http://100.101.5.6:8877'), 'http://100.101.5.6:8877');
  assert.equal(phoneUrl('http://mac.tail1234.ts.net:8877'), 'http://mac.tail1234.ts.net:8877');
  for (const bad of ['http://8.8.8.8:8877', 'http://cf.example.com', 'https://a.com/path', 'https://user:pw@a.com', 'ftp://a.com']) {
    assert.throws(() => phoneUrl(bad), undefined, bad);
  }
  assert.equal(privateHost('172.20.0.1'), true);
  assert.equal(privateHost('172.32.0.1'), false);
  assert.equal(privateHost('100.128.0.1'), false);
  assert.equal(new URL(pairingLink('本机', 'cfd_x', [{ url: 'https://a.com', kind: 'public', label: '' }])).searchParams.get('name'), '本机');
  assert.equal(deviceAllowed('GET', 'conversations/abc/changes'), true);
  assert.equal(deviceAllowed('POST', 'projects/app/start'), false);
  assert.equal(deviceAllowed('GET', 'terminals/abc'), false);
});
