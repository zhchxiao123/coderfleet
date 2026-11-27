import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deviceAllowed } from '../dist/server.js';
import { interfaceAddresses, pairingLink, phoneUrl, privateHost } from '../dist/mobile.js';
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
    for (const [method, path] of [['GET', 'accounts'], ['GET', 'settings'], ['POST', 'projects/app/terminal'], ['GET', 'mobile'], ['POST', 'devices'], ['DELETE', 'projects/app'], ['POST', 'containers/stop']]) {
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

test('a phone asks for a page of conversations and the latest turns, then for more', { timeout: 120_000 }, async () => {
  const env = await environment({
    accounts: 'NAME=claude-a TYPE=claude\n', projects: project => `NAME=app ACCOUNT=claude-a PATH=${project}\n`,
    containers: { 'claude-app': 'running' }, bins: { claude: fakeClaude },
  });
  try {
    const ids = [];
    for (const name of ['alpha', 'beta', 'gamma']) ids.push((await env.post('conversations', { projectId: 'app', name })).body.id);
    const everything = (await env.get('conversations/changes')).body;
    assert.equal(everything.conversations.length, 3);
    assert.equal(everything.total, undefined, 'without a limit the answer is what it always was');

    const page = (await env.get('conversations/changes?limit=2')).body;
    assert.deepEqual([page.conversations.length, page.total], [2, 3]);
    assert.deepEqual(page.conversations.map(item => item.id), everything.conversations.slice(0, 2).map(item => item.id));
    const found = (await env.get('conversations/changes?limit=2&q=GAM')).body;
    assert.deepEqual([found.conversations.map(item => item.name), found.total], [['gamma'], 1]);
    // An unchanged page waits; a conversation that becomes active moves into it.
    assert.equal((await env.get('conversations/changes?limit=2&since=' + page.etag + '&wait=600')).body.unchanged, true);
    await env.put('conversations/' + everything.conversations[2].id, { name: 'renamed' });
    const moved = (await env.get('conversations/changes?limit=2&since=' + page.etag + '&wait=5000')).body;
    assert.deepEqual([moved.conversations[0].name, moved.conversations.length, moved.total], ['renamed', 2, 3]);

    const conversation = ids[0];
    for (const prompt of ['one', 'two', 'three']) {
      await env.post('conversations/' + conversation + '/turns', { prompt });
      await until(async () => (await env.get('conversations/' + conversation + '/turns')).body.at(-1), turn => turn?.prompt === prompt && turn.status === 'done', prompt);
    }
    const all = (await env.get('conversations/' + conversation + '/turns')).body.map(turn => turn.id);
    const feed = (await env.get('conversations/' + conversation + '/changes?last=2')).body;
    assert.deepEqual([feed.full, feed.earlier, feed.order, feed.turns.map(turn => turn.prompt)], [true, 1, all.slice(1), ['two', 'three']]);
    assert.equal((await env.get('conversations/' + conversation + '/changes?last=2&since=' + feed.etag + '&wait=600')).body.unchanged, true);
    const earlier = (await env.get('conversations/' + conversation + '/turns?before=' + feed.order[0] + '&limit=5')).body;
    assert.deepEqual([earlier.turns.map(turn => turn.prompt), earlier.earlier], [['one'], 0]);
    assert.deepEqual((await env.get('conversations/' + conversation + '/turns?before=' + all[2] + '&limit=1')).body.turns.map(turn => turn.prompt), ['two']);
    assert.equal((await env.get('conversations/' + conversation + '/turns?before=nope')).status, 404);
    assert.equal((await env.get('conversations/' + conversation + '/changes')).body.earlier, undefined);
    // The list tells what each conversation's latest answer ended on; one that never ran has nothing to tell.
    const answered = (await env.get('conversations/' + conversation + '/turns')).body.at(-1).answer;
    const listed = (await env.get('conversations/changes?limit=3')).body.conversations;
    assert.ok(answered && listed.find(item => item.id === conversation).preview === answered.replace(/\s+/g, ' ').trim().slice(0, 140), 'preview of the last answer');
    assert.equal(listed.find(item => item.id === ids[1]).preview, '');
    assert.equal((await env.get('conversations/changes')).body.conversations[0].preview, undefined);
  } finally { await env.close(); }
});

test('large answers are compressed for clients that accept it', async () => {
  const env = await environment({ accounts: 'NAME=claude-a TYPE=claude\n', projects: project => `NAME=app ACCOUNT=claude-a PATH=${project}\n` });
  try {
    for (let index = 0; index < 12; index += 1) await env.post('conversations', { projectId: 'app', name: 'conversation ' + index });
    const call = (path, encoding) => fetch('http://127.0.0.1:' + env.port + '/v1/' + path, { headers: { Authorization: 'Bearer synthetic-node-test-token-0000000', 'Accept-Encoding': encoding } });
    const packed = await call('conversations', 'gzip');
    assert.equal(packed.headers.get('content-encoding'), 'gzip');
    assert.equal((await packed.json()).length, 12);
    const plain = await call('conversations', 'identity');
    assert.equal(plain.headers.get('content-encoding'), null);
    assert.equal((await plain.json()).length, 12);
    assert.equal((await call('health', 'gzip')).headers.get('content-encoding'), null, 'small answers stay as they are');
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
  assert.equal(deviceAllowed('POST', 'translate'), true);
  assert.equal(deviceAllowed('GET', 'projects/app/uploads/0123456789abcdef-%E6%88%AA%E5%9B%BE.png'), true);
  assert.equal(deviceAllowed('GET', 'system-llm'), true);
  assert.equal(deviceAllowed('PUT', 'settings'), false);
  assert.equal(deviceAllowed('POST', 'projects/app/start'), false);
  assert.equal(deviceAllowed('GET', 'terminals/abc'), false);
});

test('interface addresses: only the ones a phone can reach', () => {
  const v4 = (address, netmask = '255.255.255.0') => [{ address, netmask, family: 'IPv4', internal: false }];
  // What a Mac running OrbStack reports: one Wi-Fi address among bridges, base addresses and a self-assigned one.
  const urls = interfaceAddresses(8877, {
    lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
    utun4: v4('100.101.102.103', '255.255.255.255'),
    en0: v4('192.168.2.24'),
    bridge100: v4('192.168.139.3'),
    bridge101: v4('192.168.215.0', '255.255.254.0'),
    en7: v4('10.0.4.0'),
    en9: v4('169.254.164.39', '255.255.0.0'),
    en5: [{ address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false }],
  }).map(item => [item.url, item.kind]);
  assert.deepEqual(urls, [['http://192.168.2.24:8877', 'lan'], ['http://100.101.102.103:8877', 'mesh']]);
});
