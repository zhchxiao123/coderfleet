'use strict';

const transport = window.coderFleet;
const byId = id => document.getElementById(id);
const backend = byId('backend');
const project = byId('project');
const model = byId('model');
const compose = byId('compose');
const prompt = byId('prompt');
const settings = byId('settings');
const transcript = byId('transcript');
const labels = { starting: '启动中', running: '运行中', done: '完成', failed: '失败', cancelled: '已中断', blocked: '等待清理' };
let scope = { backendId: '', projectId: '', conversationId: '' };
let conversations = [];
let active = null;
let sending = false;
let pollTimer;
let contents = '';
const inFlight = new Set();
const drafts = new Map();
const draftKey = context => context.backendId + ':' + (context.conversationId || context.projectId);

function error(error, target = 'error') {
  byId(target).textContent = error ? String(error.message || error).replace(/^Error invoking remote method '[^']+': Error: /, '') : '';
}

function request(context, method, path, body) {
  return transport.request(context.backendId, method, '/v1' + path, body);
}

function option(value, title) { return new Option(title, value); }

function switchScope(next) {
  if (scope.conversationId) drafts.set(draftKey(scope), prompt.value);
  scope = next;
  prompt.value = next.conversationId ? drafts.get(draftKey(next)) || '' : '';
  clearTimeout(pollTimer);
  active = null;
  contents = '';
  transcript.replaceChildren();
  updateControls();
}

function updateControls() {
  const canSend = Boolean(scope.conversationId) && !active && !sending;
  prompt.disabled = !scope.conversationId;
  model.disabled = !scope.projectId || Boolean(active);
  byId('send').disabled = !canSend;
  byId('cancel').hidden = !active || active.status === 'blocked';
  byId('cancel').disabled = Boolean(active && inFlight.has(active.id + ':cancel'));
}

async function loadProfiles(preferred) {
  const profiles = await transport.list();
  const chosen = profiles.find(item => item.id === preferred) || profiles[0];
  backend.replaceChildren(option('', '选择后端'), ...profiles.map(item => option(item.id, item.name)));
  backend.value = chosen?.id || '';
  await selectBackend(backend.value);
}

async function selectBackend(backendId) {
  switchScope({ backendId, projectId: '', conversationId: '' });
  const here = scope;
  localStorage.setItem('coderfleet-backend', backendId);
  conversations = [];
  byId('conversations').replaceChildren();
  project.replaceChildren();
  project.disabled = true;
  byId('create').disabled = true;
  byId('title').textContent = '项目聊天';
  byId('subtitle').textContent = backendId ? '正在连接后端…' : '先点右上角「管理后端」，再选「打开本机配置」。';
  byId('connection').textContent = backendId ? '连接中' : '未连接';
  error(null);
  if (!backendId) return;
  try {
    await transport.connect(backendId);
    const [projects, list] = await Promise.all([request(here, 'GET', '/projects'), request(here, 'GET', '/conversations')]);
    if (scope !== here) return;
    project.replaceChildren(...projects.map(item => option(item.id, item.name)));
    conversations = list;
    project.disabled = false;
    byId('connection').textContent = '已连接';
    selectProject(project.value);
  } catch (failure) {
    if (scope !== here) return;
    byId('connection').textContent = '连接失败';
    error(failure);
  }
}

function listConversations() {
  byId('conversations').replaceChildren(...conversations.filter(item => item.projectId === scope.projectId).map(item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = item.name;
    button.setAttribute('aria-current', String(item.id === scope.conversationId));
    button.addEventListener('click', () => selectConversation(item.id));
    return button;
  }));
}

function selectProject(projectId) {
  switchScope({ backendId: scope.backendId, projectId, conversationId: '' });
  byId('create').disabled = !projectId;
  model.replaceChildren(option('', '当前模型'));
  listConversations();
  const first = conversations.find(item => item.projectId === projectId);
  if (first) selectConversation(first.id);
  else {
    byId('title').textContent = project.selectedOptions[0]?.text || '项目聊天';
    byId('subtitle').textContent = '创建会话以向 Antigravity 发送消息。';
  }
  const { backendId } = scope;
  if (!projectId) return;
  void request(scope, 'GET', '/projects/' + projectId + '/models').then(items => {
    if (scope.backendId !== backendId || scope.projectId !== projectId) return;
    model.replaceChildren(option('', '当前模型'), ...items.map(item => option(item.id, item.label)));
  }).catch(() => {
    if (scope.backendId === backendId && scope.projectId === projectId) model.options[0].text = '当前模型 · 列表不可用';
  });
}

function selectConversation(id) {
  switchScope({ ...scope, conversationId: id });
  const here = scope;
  const conversation = conversations.find(item => item.id === id);
  byId('title').textContent = conversation?.name || '项目聊天';
  byId('subtitle').textContent = (project.selectedOptions[0]?.text || '') + ' · Antigravity';
  listConversations();
  void refresh(here);
}

async function refresh(context) {
  if (scope !== context) return;
  clearTimeout(pollTimer);
  try {
    const items = await request(context, 'GET', '/conversations/' + context.conversationId + '/turns');
    if (scope !== context) return;
    active = items.find(item => ['starting', 'running', 'blocked'].includes(item.status));
    const serialized = JSON.stringify(items);
    if (contents !== serialized) {
      contents = serialized;
      renderTranscript(items, context);
    }
    updateControls();
  } catch (failure) {
    if (scope === context) error(failure);
  }
  if (scope === context) pollTimer = setTimeout(() => void refresh(context), active ? 400 : 1800);
}

function element(tag, className, value) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = value;
  return node;
}

function renderTranscript(items, context) {
  const follow = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 70;
  const nodes = items.map(item => {
    const section = document.createElement('article');
    section.className = 'turn';
    section.append(element('p', 'user', item.prompt));
    section.append(element('p', 'meta', [item.model, labels[item.status]].filter(Boolean).join(' · ')));
    for (const tool of item.tools) section.append(element('p', 'tool', tool.title + ' · ' + tool.status));
    if (item.answer) section.append(element('p', 'answer', item.answer));
    if (item.permission) {
      const permission = item.permission;
      const card = document.createElement('section');
      card.className = 'permission';
      card.append(element('strong', '', permission.title), element('pre', '', permission.details));
      for (const [decision, title] of [['allow', '允许本次'], ['deny', '拒绝']]) {
        if (decision === 'allow' && !permission.allow) continue;
        const button = element('button', '', title);
        button.type = 'button';
        button.disabled = inFlight.has(permission.id);
        button.addEventListener('click', () => void control(context, item.id, 'permission', permission.id, { id: permission.id, decision }));
        card.append(button);
      }
      section.append(card);
    }
    if (item.error) section.append(element('p', 'error', item.error));
    return section;
  });
  transcript.replaceChildren(...nodes);
  if (follow) transcript.scrollTop = transcript.scrollHeight;
}

async function control(context, turnId, action, key, data) {
  if (inFlight.has(key)) return;
  inFlight.add(key);
  updateControls();
  error(null);
  let accepted = false;
  try {
    await request(context, 'POST', '/turns/' + turnId + '/' + action, data);
    accepted = true;
  } catch (failure) {
    if (scope === context) error(failure);
  } finally {
    if (!accepted) inFlight.delete(key);
    if (scope === context) {
      contents = '';
      void refresh(context);
    }
  }
}

backend.addEventListener('change', () => void selectBackend(backend.value));
project.addEventListener('change', () => selectProject(project.value));
byId('create').addEventListener('click', async () => {
  const here = scope;
  const button = byId('create');
  button.disabled = true;
  try {
    const item = await request(here, 'POST', '/conversations', { projectId: here.projectId });
    if (scope !== here) return;
    conversations = [item, ...conversations];
    selectConversation(item.id);
  } catch (failure) { if (scope === here) error(failure); }
  finally { if (scope.backendId === here.backendId && scope.projectId === here.projectId) button.disabled = false; }
});

compose.addEventListener('submit', async event => {
  event.preventDefault();
  if (sending || active || !scope.conversationId || !prompt.value.trim()) return;
  const here = scope;
  const draft = prompt.value;
  sending = true;
  updateControls();
  error(null);
  try {
    const submitted = await request(here, 'POST', '/conversations/' + here.conversationId + '/turns', { prompt: draft, model: model.value });
    if (drafts.get(draftKey(here)) === draft) drafts.delete(draftKey(here));
    if (scope === here) {
      active = submitted;
      if (prompt.value === draft) prompt.value = '';
      void refresh(here);
    }
  } catch (failure) { if (scope === here) error(failure); }
  finally { sending = false; updateControls(); }
});

byId('cancel').addEventListener('click', () => {
  if (active) void control(scope, active.id, 'cancel', active.id + ':cancel');
});
byId('manage').addEventListener('click', () => settings.showModal());
byId('dismiss').addEventListener('click', () => settings.close());
byId('local').addEventListener('click', async () => {
  try {
    const id = await transport.addLocal();
    if (id) { settings.close(); await loadProfiles(id); }
  } catch (failure) { error(failure, 'settings-error'); }
});
byId('remove').addEventListener('click', async () => {
  try { await transport.remove(backend.value); await loadProfiles(); }
  catch (failure) { error(failure, 'settings-error'); }
});
byId('remote').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const id = await transport.addRemote(Object.fromEntries(new FormData(form)));
    form.reset();
    settings.close();
    await loadProfiles(id);
  } catch (failure) { error(failure, 'settings-error'); }
});

void loadProfiles(localStorage.getItem('coderfleet-backend')).catch(error);
