const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function navigation() {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { style: {}, classList: { add() {}, remove() {}, toggle() {} }, textContent: '' });
    return nodes.get(id);
  };
  const context = vm.createContext({
    window: {}, localStorage: { getItem() { return null; } },
    document: { getElementById: node, querySelector: node, querySelectorAll: () => [] },
    loadConversations() {}, renderTopbarTabs() {}, closeBottomTerminal() {}, stopChatFollow() {},
    Workbench: { load() {}, deactivate() {} },
  });
  vm.runInContext("let currentPage='chat',activeTabId='conversation-conv-1',activeConversationId='conv-1',currentChatTaskId='task-1';", context);
  vm.runInContext(fs.readFileSync('coderfleet/server/static/js/nav.js', 'utf8'), context);
  return context;
}

test('visiting the inbox and returning to AI chat preserves the selected project conversation', () => {
  const context = navigation();
  context.showPage('inbox');
  context.showPage('chat');
  assert.equal(vm.runInContext('activeConversationId', context), 'conv-1');
  assert.equal(vm.runInContext('activeTabId', context), 'conversation-conv-1');
});

test('a native question targets its original Task instead of its parent workflow or a queued turn', () => {
  const sandbox = {};
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('coderfleet/server/static/js/workbench.js', 'utf8'), context);
  const target = context.FleetWorkView.targetFor({
    workflow_run_id: 'run-1', task_id: 'queued-task', conversation_id: '',
  }, { kind: 'question', task_id: 'asking-task' });
  assert.deepEqual(JSON.parse(JSON.stringify(target)), { kind: 'task', id: 'asking-task' });
  assert.throws(() => context.FleetWorkView.targetFor({}), /没有可打开/);
});

test('opening a different project conversation keeps each unsent draft with its own conversation', async () => {
  const input = { value: 'mobile draft' };
  const sandbox = {
    document: { getElementById: id => id === 'chat-input' ? input : null, addEventListener() {} },
    localStorage: { getItem: () => null }, sessionStorage: { setItem() {} },
    upsertConversationTab: id => id, renderTopbarTabs() {}, syncBottomTerminalProjectFromContext() {},
    fetch: async () => ({ json: async () => [] }),
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  for (const file of ['state.js', 'chat.js']) vm.runInContext(fs.readFileSync('coderfleet/server/static/js/' + file, 'utf8'), context);
  context.rerenderChatProjectList = () => {};
  context.renderImagePreviews = () => {};
  context.renderChatWorkspace = async () => {};
  vm.runInContext("activeConversationId='mobile';chatConversationsList=[{id:'mobile'},{id:'server'}];", context);
  await context.selectConversation('server');
  assert.equal(input.value, '');
  input.value = 'server draft';
  await context.selectConversation('mobile');
  assert.equal(input.value, 'mobile draft');
});

test('opening automation in runs mode makes the actual run panel visible', async () => {
  const context = navigation();
  vm.runInContext("let wfActiveTab='runs';", context);
  vm.runInContext(fs.readFileSync('coderfleet/server/static/js/workflows.js', 'utf8'), context);
  context.loadWorkflows = async () => {};
  context.document.getElementById('wf-panel-runs').style.display = 'none';
  context.document.getElementById('wf-panel-templates').style.display = '';
  await context.showPage('workflows');
  assert.equal(context.document.getElementById('wf-panel-runs').style.display, '');
  assert.equal(context.document.getElementById('wf-panel-templates').style.display, 'none');
});

test('a workflow awaiting approval is labeled as awaiting approval in the run list', () => {
  const context = navigation();
  vm.runInContext("let wfRunsFilter='all',activePipelineId=null;", context);
  vm.runInContext(fs.readFileSync('coderfleet/server/static/js/workflows.js', 'utf8'), context);
  context.esc = value => String(value);
  context.fmtTime = () => 'now';
  context.renderPipelineList([{ id: 'run-1', name: '审批', status: 'waiting_approval', node_executions: [] }], []);
  const html = context.document.getElementById('pipeline-list').innerHTML;
  assert.ok(html.includes('待审批'));
  assert.ok(!html.includes('待执行'));
});

test('mobile work navigation also preserves each conversation draft', async () => {
  const nodes = new Map(['ta', 'chat-ttl', 'chat-sub'].map(id => [id, { value: '', textContent: '' }]));
  const sandbox = {
    document: { getElementById: id => nodes.get(id) || null, addEventListener() {}, documentElement: { clientHeight: 844, style: { setProperty() {} } } },
    window: { innerHeight: 844, addEventListener() {} },
    localStorage: { getItem: () => null }, sessionStorage: { getItem: () => null },
  };
  const context = vm.createContext(sandbox);
  const scripts = [...fs.readFileSync('coderfleet/server/static/mobile.html', 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)];
  vm.runInContext(scripts.find(match => match[1].includes('let projects  = []'))[1], context);
  context.renderImagePreviews = () => {};
  context.showChat = () => {};
  context.syncMessages = () => {};
  vm.runInContext("convs=[{id:'mobile'},{id:'server'}];activeConv={id:'mobile'};", context);
  nodes.get('ta').value = 'mobile draft';
  await context.openConv('server');
  assert.equal(nodes.get('ta').value, '');
  nodes.get('ta').value = 'server draft';
  await context.openConv('mobile');
  assert.equal(nodes.get('ta').value, 'mobile draft');
});

test('deleted work targets fail explicitly without reading a different record', async () => {
  const calls = [];
  const sandbox = { AbortController, setTimeout, clearTimeout,
    fetch: async url => { calls.push(url); return { ok: false, status: 404, json: async () => ({ detail: '原任务已删除' }) }; },
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('coderfleet/server/static/js/workbench.js', 'utf8'), context);
  await assert.rejects(context.FleetWorkView.readTarget({ kind: 'task', id: 'deleted-task' }), /原任务已删除/);
  assert.deepEqual(calls, ['/api/tasks/deleted-task']);
});

test('a late open from the work page cannot pull the user out of a newer inbox view', async () => {
  let finishRead;
  const opened = [];
  const sandbox = {
    currentPage: 'work', chatConversationsList: [],
    document: { getElementById: () => ({}) },
    FleetWorkView: {
      readTarget: () => new Promise(resolve => { finishRead = resolve; }),
      create: () => ({ refresh() {}, deactivate() {} }),
    },
    selectConversation: async () => {},
    showPage: page => { opened.push(page); sandbox.currentPage = page; },
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('coderfleet/server/static/js/workbench-desktop.js', 'utf8'), context);
  context.Workbench.load('work');
  const opening = context.Workbench.open({ kind: 'conversation', id: 'old' });
  sandbox.currentPage = 'inbox';
  context.Workbench.load('inbox');
  finishRead({ id: 'old' });
  await opening;
  assert.deepEqual(opened, []);
});
