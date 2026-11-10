const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const jsDir = path.resolve(__dirname, '../../coderfleet/server/static/js');

function loadUi(fetchImpl) {
  const elements = new Map();
  const getElementById = id => {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', value: '', checked: false, style: {}, disabled: false });
    return elements.get(id);
  };
  const context = vm.createContext({
    console, Headers, setTimeout: () => 0, clearTimeout() {},
    window: { fetch: fetchImpl }, fetch: fetchImpl,
    document: { getElementById, addEventListener() {}, querySelector: () => null },
    localStorage: { getItem: () => '' },
    globalAccountsCache: [], accountTypesCache: [{ id: 'claude' }, { id: 'codex' }],
    conversationsCache: {}, currentPage: '', alert() {},
    taskRowsCache: [], taskPage: 1, TASK_PAGE_SIZE: 20,
  });
  for (const file of ['utils.js', 'accounts.js', 'tasks.js']) {
    vm.runInContext(fs.readFileSync(path.join(jsDir, file), 'utf8'), context, { filename: file });
  }
  return { context, element: getElementById };
}

test('creating a Claude account sends the selected SDK backend through the account API', async () => {
  let created;
  const { context, element } = loadUi(async (url, opts = {}) => {
    if (opts.method === 'POST') created = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => opts.method === 'POST' ? { ok: true } : [] };
  });
  for (const [field, value] of Object.entries({ name: 'alice', type: 'claude', auth: 'login', proxy: 'relay', runtime: 'container', 'claude-backend': 'sdk' })) {
    element('create-account-' + field).value = value;
  }
  await context.saveNewAccount();
  assert.equal(created.claude_backend, 'sdk');
  assert.equal(created.type, 'claude');
});

test('existing account settings read and write SDK and clear it when changing type', async () => {
  let saved;
  const account = { name: 'alice', type: 'claude', claude_backend: 'sdk', auth: 'login', proxy: 'relay' };
  const { context, element } = loadUi(async (url, opts = {}) => {
    if (opts.method === 'PUT') saved = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => url.endsWith('/env') ? { vars: {} } : [account] };
  });
  await context.loadAccountSettings('alice');
  assert.match(element('acct-panel-settings').innerHTML, /value="sdk" selected/);
  for (const [field, value] of Object.entries({ type: 'claude', auth: 'login', proxy: 'relay', runtime: 'container', 'claude-backend': 'sdk' })) {
    element('settings-' + field).value = value;
  }
  await context.saveAccountSettings('alice');
  assert.equal(saved.claude_backend, 'sdk');
  element('settings-type').value = 'codex';
  context.toggleClaudeBackendControls('settings');
  assert.equal(element('settings-claude-backend').value, 'cli');
  assert.equal(element('settings-backend-row').style.display, 'none');
  await context.saveAccountSettings('alice');
  assert.equal(saved.claude_backend, 'cli');
});

test('SDK environment check reports versions and actionable errors as text', async () => {
  const { context, element } = loadUi(async url => {
    assert.equal(url, '/api/accounts/alice/claude-sdk-status');
    return { ok: true, status: 200, json: async () => ({
      ready: false, sdk_version: '0.2.180', cli_version: '2.1.321', python_path: '/opt/sdk/python',
      error: 'Missing <script>dependency</script>',
    }) };
  });
  const button = { disabled: false };
  await context.checkAccountSdkStatus('alice', button);
  assert.equal(button.disabled, false);
  assert.match(element('settings-sdk-status').textContent, /未就绪/);
  assert.match(element('settings-sdk-status').textContent, /0\.2\.180/);
  assert.match(element('settings-sdk-status').textContent, /2\.1\.321/);
  assert.match(element('settings-sdk-status').textContent, /Missing <script>dependency<\/script>/);
  assert.equal(element('settings-sdk-status').innerHTML, '');
});

test('Task list shows actual SDK versions and defaults historical Claude records to CLI', () => {
  const { context, element } = loadUi(async () => ({ status: 200 }));
  const task = { id: 'task-1', status: 'done', type: 'claude', account: 'alice', project: '/srv/app', prompt: 'hello',
    created: '2026-11-09T00:00:00Z', execution_backend: 'sdk', sdk_version: '0.2.180', cli_version: '2.1.321' };
  context.taskRowsCache = [task];
  context.renderTasks([task]);
  assert.match(element('task-tbody').innerHTML, /SDK 0\.2\.180 · CLI 2\.1\.321/);
  context.taskRowsCache = [{ ...task, execution_backend: undefined, sdk_version: undefined, cli_version: undefined }];
  context.renderTasks(context.taskRowsCache);
  assert.match(element('task-tbody').innerHTML, /task-execution-meta[^>]*>CLI</);
  context.taskRowsCache = [{ ...task, sdk_version: '<img onerror=bad>' }];
  context.renderTasks(context.taskRowsCache);
  assert.ok(element('task-tbody').innerHTML.includes('&lt;img onerror=bad&gt;'));
  assert.ok(!element('task-tbody').innerHTML.includes('<img onerror=bad>'));
});

test('newly captured Task versions update visible metadata without rebuilding the conversation', () => {
  const { context } = loadUi(async () => ({ status: 200 }));
  const own = { dataset: { taskExecution: 'task-1' }, textContent: 'SDK' };
  const other = { dataset: { taskExecution: 'task-2' }, textContent: 'CLI' };
  context.updateTaskExecutionMetadata([
    { id: 'task-1', type: 'claude', execution_backend: 'sdk', sdk_version: '0.2.180', cli_version: '2.1.321' },
  ], { querySelectorAll: () => [own, other] });
  assert.equal(own.textContent, 'SDK 0.2.180 · CLI 2.1.321');
  assert.equal(other.textContent, 'CLI');
});
