import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { meaningful, redact, validateTitle } from '../dist/titles.js';
import { environment, lastTurn, until } from './helpers.mjs';
import { fakeClaude } from './fakes.mjs';

test('title rules follow the Python service', () => {
  assert.equal(meaningful('继续'), false);
  assert.equal(meaningful('hi!'), false);
  assert.equal(meaningful('修复登录'), true);
  assert.equal(validateTitle('标题：修复登录页样式'), '修复登录页样式');
  assert.equal(validateTitle('__DEFER__'), '');
  assert.equal(validateTitle('你好'), '');
  assert.throws(() => validateTitle('a\nb'));
  assert.throws(() => validateTitle('Fixing things…'));
  assert.equal(redact('key sk-ant-abcdefghijklmnop and mysecretvalue', ['mysecretvalue']), 'key [REDACTED] and [REDACTED]');
});

test('a new conversation is named once by the system model; a manual name is never replaced', { timeout: 120_000 }, async () => {
  const requests = [];
  const llm = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw);
      requests.push(body);
      const data = JSON.parse(body.messages[0].content);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '标题：' + data.original_goal.slice(0, 7) + '方案' }] }));
    });
  });
  await new Promise(resolve => llm.listen(0, '127.0.0.1', resolve));
  const env = await environment({
    accounts: 'NAME=claude-a TYPE=claude\n', projects: project => `NAME=app ACCOUNT=claude-a PATH=${project}\n`,
    containers: { 'claude-app': 'running' }, bins: { claude: fakeClaude },
  });
  try {
    appendFileSync(join(env.workspace, 'config.conf'), 'SYSTEM_LLM_API_KEY=sk-ant-test-secret-000\nSYSTEM_LLM_MODEL=m\nSYSTEM_LLM_BASE_URL=http://127.0.0.1:' + llm.address().port + '\n');
    const conversation = (await env.post('conversations', { projectId: 'app' })).body.id;
    await env.post('conversations/' + conversation + '/turns', { prompt: '设计数据库迁移 api_key=abcdefghijklmnop' });
    await until(() => lastTurn(env, conversation), value => value.status === 'done', 'turn');
    const named = await until(async () => (await env.get('conversations')).body.find(item => item.id === conversation), value => value.name.endsWith('方案'), 'auto title');
    assert.equal(named.name, '设计数据库迁移方案');
    const record = JSON.parse(readFileSync(join(env.workspace, 'conversations', conversation + '.json'), 'utf8'));
    assert.equal(record.title.source, 'auto');
    assert.equal(record.title.status, 'ready');
    assert.ok(!JSON.stringify(requests).includes('abcdefghijklmnop'), 'secrets are redacted before reaching the model');
    // Later turns do not rename it again.
    const calls = requests.length;
    await env.post('conversations/' + conversation + '/turns', { prompt: '再补充回滚步骤' });
    await until(() => lastTurn(env, conversation), value => value.prompt === '再补充回滚步骤' && value.status === 'done', 'second turn');
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(requests.length, calls);

    // A conversation the user renamed keeps its name.
    const manual = (await env.post('conversations', { projectId: 'app' })).body.id;
    await env.post('conversations/' + manual + '/turns', { prompt: 'slow' });
    await env.put('conversations/' + manual, { name: '我自己起的名字' });
    await until(() => lastTurn(env, manual), value => value.controlReady, 'slow turn');
    await env.post('turns/' + (await lastTurn(env, manual)).id + '/cancel');
    await until(() => lastTurn(env, manual), value => value.status === 'cancelled', 'cancelled');
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal((await env.get('conversations')).body.find(item => item.id === manual).name, '我自己起的名字');
    // 重新生成标题 names it on request.
    assert.equal((await env.post('conversations/' + manual + '/title')).status, 200);
    const regenerated = await until(async () => (await env.get('conversations')).body.find(item => item.id === manual), value => value.name !== '我自己起的名字', 'regenerated title');
    assert.equal(regenerated.name, 'slow方案');
    assert.equal(meaningful('设计数据库迁移'), true);
  } finally { await env.close(); llm.close(); }
});
