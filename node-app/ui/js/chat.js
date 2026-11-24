'use strict';
// Conversation view: transcript, approvals and native questions, composer.
(() => {
  const CF = window.CF;
  const { h } = CF;
  const drafts = new Map();
  const models = new Map();
  let session = null; // the mounted conversation view

  const STATUS = { starting: '正在启动', running: '正在处理' };
  const isActive = turn => turn.status === 'starting' || turn.status === 'running';

  // Tool call states and how each one reads in a flow row.
  const TOOL_STATES = {
    running: { label: '运行中', className: 'running' },
    waiting: { label: '等你确认', className: 'waiting' },
    completed: { label: '完成', className: 'completed' },
    failed: { label: '失败', className: 'failed' },
    denied: { label: '已拒绝', className: 'denied' },
    interrupted: { label: '已中断', className: 'interrupted' },
    unknown: { label: '没有返回结果', className: 'interrupted' },
  };
  const SETTLED = new Set(['completed', 'failed', 'denied', 'interrupted', 'unknown']);
  const openFlows = new Set();
  // Translations shown in place of a text block: turnId:blockIndex → { showing, text?, pending? }.
  const translations = new Map();
  // Whether the backend has a system LLM for translation, per backend.
  const translateReady = new Map();
  // Turns being translated: turnId → { done, total } or { error }.
  const translating = new Map();

  function toolGlyph(status) {
    if (status === 'running') return h('span.spinner.tool-spinner');
    if (status === 'waiting') return h('span.tool-glyph.waiting', h('span.dot.waiting'));
    const icon = { completed: 'check', failed: 'x', denied: 'block', interrupted: 'square', unknown: 'dash' }[status] || 'tool';
    return h('span.tool-glyph.' + (TOOL_STATES[status]?.className || 'completed'), CF.icon(icon, 12));
  }

  const openTools = new Set();
  // Agent calls whose finished sub-steps are unfolded: turnId:toolId.
  const openChildren = new Set();
  const toolDetails = new Map(); // turnId:toolId → { status, data } once fetched

  /** The input of a tool call, shown the way a person checks it. */
  function toolInput(input) {
    const raw = input && typeof input.rawInput === 'object' && input.rawInput ? input.rawInput : input || {};
    const file = raw.file_path || raw.filePath || raw.path || raw.notebook_path;
    const fileLine = typeof file === 'string' ? h('div.file', CF.icon('folder', 12), CF.projectPath(file)) : null;
    const command = Array.isArray(raw.command) ? raw.command.join(' ') : raw.command || raw.cmd;
    if (typeof command === 'string' && command) return h('pre.command', command);
    if (typeof raw.old_string === 'string' || typeof raw.new_string === 'string') {
      const lines = (value, kind) => String(value || '').split('\n').map(line => h('div.' + kind, line || ' '));
      return [fileLine, h('div.diff', lines(raw.old_string, 'del'), lines(raw.new_string, 'add'))];
    }
    if (typeof raw.content === 'string' && fileLine) return [fileLine, h('div.diff', raw.content.split('\n').map(line => h('div.add', line || ' ')))];
    // The path is already shown above; the rest of the input as JSON.
    const rest = Object.fromEntries(Object.entries(raw).filter(([key]) => !(fileLine && ['file_path', 'filePath', 'path', 'notebook_path'].includes(key))));
    if (!Object.keys(rest).length) return fileLine;
    return [fileLine, h('pre', JSON.stringify(rest, null, 2))];
  }

  function toolPanel(turn, tool) {
    const key = turn.id + ':' + tool.id;
    const panel = h('div.tool-panel', h('div.section', h('div.empty-note', '正在读取…')));
    const show = data => {
      const input = toolInput(data.input);
      const output = typeof data.output === 'string' ? data.output : JSON.stringify(data.output, null, 2);
      const empty = tool.status === 'running' ? '还在运行，结束后显示输出。'
        : tool.status === 'waiting' ? '等你确认后才会运行。'
          : tool.status === 'denied' ? '已拒绝，没有运行。' : '没有输出。';
      // Images the tool returned (e.g. Read of a picture); clicking opens one full size.
      const images = (data.images || []).map(image => {
        const url = 'data:' + image.mime + ';base64,' + image.data;
        return h('button.tool-image', { title: '查看大图', on: { click: () => CF.sheet({ title: tool.title + ' · 图片', wide: true }, () => h('img.preview-full', { src: url, alt: '' })) } },
          h('img', { src: url, alt: '' }));
      });
      panel.replaceChildren(
        input ? h('div.section', h('div.label', '输入'), input) : null,
        h('div.section', h('div.label', tool.status === 'failed' ? '错误' : '输出'),
          images.length ? h('div.tool-images', images) : null,
          output ? h('pre' + (tool.status === 'failed' ? '.error' : ''), output) : images.length ? null : h('div.empty-note', empty)));
    };
    const cached = toolDetails.get(key);
    if (cached && cached.status === tool.status) show(cached.data);
    else {
      CF.api('GET', 'turns/' + turn.id + '/tools/' + encodeURIComponent(tool.id)).then(data => {
        toolDetails.set(key, { status: tool.status, data });
        show(data);
      }).catch(error => panel.replaceChildren(h('div.section', h('div.empty-note', '读取失败：' + (error?.message || error)))));
    }
    return panel;
  }

  function toolRow(turn, tool) {
    const state = TOOL_STATES[tool.status] || TOOL_STATES.running;
    const detail = CF.projectPath(tool.detail);
    const key = turn.id + ':' + tool.id;
    const open = openTools.has(key);
    const node = h('div.tool' + (open ? '.open' : ''));
    const row = h('button.flow-row.tool-toggle.tool-' + state.className, {
      title: tool.detail ? tool.title + ' · ' + tool.detail : tool.title, 'aria-expanded': String(open),
      on: { click: () => {
        open ? openTools.delete(key) : openTools.add(key);
        node.replaceWith(toolRow(turn, tool));
      } },
    }, toolGlyph(tool.status), h('span.label', tool.title),
      detail ? h('span.detail', detail) : null,
      tool.status === 'completed' ? null : h('span.tool-state', state.label),
      h('span.chev', CF.icon('chevron', 11)));
    node.append(row);
    if (open) node.append(toolPanel(turn, tool));
    // An Agent call's own steps, indented under it: the latest few while it runs, folded once it is done.
    const children = turn.tools.filter(item => item.parent === tool.id);
    if (children.length) {
      const unfolded = openChildren.has(key);
      const running = tool.status === 'running' || tool.status === 'waiting';
      const failed = children.filter(item => item.status === 'failed').length;
      const shown = unfolded ? children : running ? children.slice(-5) : [];
      const toggle = h('button.flow-row.children-toggle', { 'aria-expanded': String(unfolded), on: { click: () => {
        unfolded ? openChildren.delete(key) : openChildren.add(key);
        node.replaceWith(toolRow(turn, tool));
      } } }, h('span.label', unfolded ? '收起子步骤'
        : running ? (children.length > shown.length ? '前面还有 ' + (children.length - shown.length) + ' 步' : '')
          : children.length + ' 个子步骤' + (failed ? ' · ' + failed + ' 个失败' : '')), CF.icon('chevron', 11));
      const label = toggle.querySelector('.label').textContent;
      node.append(h('div.tool-children', label ? toggle : null, shown.map(item => toolRow(turn, item))));
    }
    return node;
  }

  /** Tool calls as one-line flow rows; a settled group of more than three folds into a summary row. */
  function toolFlow(turn, tools = turn.tools, key = turn.id) {
    if (!tools.length) return null;
    const settled = tools.every(tool => SETTLED.has(tool.status));
    if (!settled || tools.length <= 3) return h('div.flow', tools.map(tool => toolRow(turn, tool)));
    const counts = {};
    for (const tool of tools) counts[tool.status] = (counts[tool.status] || 0) + 1;
    const extra = ['failed', 'denied', 'interrupted', 'unknown'].filter(status => counts[status])
      .map(status => h('span.tool-state.tool-' + TOOL_STATES[status].className, counts[status] + ' 个' + TOOL_STATES[status].label));
    const open = openFlows.has(key);
    const flow = h('div.flow' + (open ? '.open' : ''));
    const summary = h('button.flow-row', { 'aria-expanded': String(open), on: { click: () => {
      open ? openFlows.delete(key) : openFlows.add(key);
      flow.replaceWith(toolFlow(turn, tools, key));
    } } }, toolGlyph(counts.failed ? 'failed' : 'completed'), h('span.label', '使用了 ' + tools.length + ' 个工具'), extra,
      h('span.chev', CF.icon('chevron', 11)));
    flow.append(summary);
    if (open) flow.append(h('div.flow-children', tools.map(tool => toolRow(turn, tool))));
    return flow;
  }

  /** Reads a tool input the way a person checks it: the command, the edit as a diff, or the file written. */
  function describeApproval(permission) {
    let input = {};
    try { input = JSON.parse(permission.details || '{}'); } catch { /* not JSON */ }
    const raw = input.rawInput && typeof input.rawInput === 'object' ? input.rawInput : input;
    const file = raw.file_path || raw.filePath || raw.path || raw.notebook_path;
    const fileLine = file ? h('div.file', CF.icon('folder', 12), CF.projectPath(file)) : null;
    const rawDetails = permission.details && permission.details !== '{}'
      ? h('details.raw', h('summary', '查看原始参数'), h('pre', permission.details)) : null;
    const command = Array.isArray(raw.command) ? raw.command.join(' ') : raw.command || raw.cmd;
    if (typeof command === 'string' && command) {
      return { summary: '要运行一条命令', body: [h('div.detail', h('pre.command', command)), raw.description ? h('div.detail', h('small', { style: 'color:var(--text-3)' }, raw.description)) : null] };
    }
    if (typeof raw.old_string === 'string' || typeof raw.new_string === 'string') {
      const lines = (text, kind) => String(text || '').split('\n').map(line => h('div.' + kind, line || ' '));
      return { summary: '要修改文件', body: [h('div.detail', fileLine, h('div.diff', lines(raw.old_string, 'del'), lines(raw.new_string, 'add')))] };
    }
    if (typeof raw.content === 'string' && file) {
      const preview = raw.content.split('\n').slice(0, 14).join('\n') + (raw.content.split('\n').length > 14 ? '\n…' : '');
      return { summary: '要写入文件', body: [h('div.detail', fileLine, h('div.diff', preview.split('\n').map(line => h('div.add', line || ' '))))] };
    }
    return { summary: file ? CF.projectPath(file) : '需要你确认这一步操作', body: [rawDetails] };
  }

  function approvalCard(turn) {
    const permission = turn.permission;
    const decide = async (button, body) => CF.busy(button, async () => {
      await CF.api('POST', 'turns/' + turn.id + '/permission', { id: permission.id, ...body });
      await session?.refresh();
    });
    if (permission.questions) {
      const answers = new Map();
      const blocks = permission.questions.map(question => {
        const picked = new Set();
        const other = h('input', { placeholder: '其他回答（可选）', on: { input: () => sync() } });
        const buttons = question.options.map(option => h('button.option', {
          title: option.description || '',
          on: { click: event => {
            if (!question.multiSelect) picked.clear();
            picked.has(option.label) ? picked.delete(option.label) : picked.add(option.label);
            for (const button of buttons) button.classList.toggle('on', picked.has(button.dataset.label));
            sync();
            event.currentTarget.blur();
          } },
          dataset: { label: option.label },
        }, option.label));
        const sync = () => {
          const values = [...picked];
          if (other.value.trim()) values.push(other.value.trim());
          if (values.length) answers.set(question.question, values.join(', ')); else answers.delete(question.question);
          submit.disabled = answers.size !== permission.questions.length;
        };
        return h('div.question', h('p', question.question), h('div.options', buttons), other);
      });
      const submit = h('button.btn.primary.small', { disabled: true, on: { click: () => decide(submit, { answers: Object.fromEntries(answers) }) } }, '提交回答');
      return h('div.approval',
        h('div.approval-head', h('span.glyph', CF.icon('question', 15)), h('div', h('strong', '需要你回答'), h('small', '回答后会继续执行'))),
        blocks, h('div.approval-actions', submit));
    }
    const allow = h('button.btn.primary.small', { disabled: !permission.allow, on: { click: () => decide(allow, { decision: 'allow' }) } }, CF.icon('check', 13), '允许');
    const deny = h('button.btn.small', { on: { click: () => decide(deny, { decision: 'deny' }) } }, '拒绝');
    const { summary, body } = describeApproval(permission);
    return h('div.approval',
      h('div.approval-head', h('span.glyph', CF.icon('shield', 15)), h('div', h('strong', permission.title), h('small', summary))),
      body,
      h('div.approval-actions', deny, allow));
  }

  /** Text and tool groups in the order they happened (older records: tools, then text). */
  function body(turn) {
    const blocks = turn.blocks?.length ? turn.blocks
      : [...turn.tools.filter(tool => !tool.parent).map(tool => ({ kind: 'tool', id: tool.id })), ...(turn.answer ? [{ kind: 'text', text: turn.answer }] : [])];
    const byId = new Map(turn.tools.map(tool => [tool.id, tool]));
    const nodes = [];
    let group = [];
    const flush = () => {
      if (group.length) nodes.push(toolFlow(turn, group, turn.id + ':' + nodes.length));
      group = [];
    };
    blocks.forEach((block, index) => {
      if (block.kind === 'tool') { const tool = byId.get(block.id); if (tool) group.push(tool); return; }
      flush();
      if (block.kind === 'user') { nodes.push(userBubble(turn.projectId, block.text, block.images, '插话')); return; }
      if (!block.text.trim()) return;
      const state = translations.get(turn.id + ':' + index);
      nodes.push(state?.showing && state.text !== undefined
        ? h('div.assistant.translated', CF.markdown(state.text))
        : h('div.assistant', { dataset: { block: String(index) } }, CF.markdown(block.text)));
    });
    flush();
    return nodes;
  }

  /** A user message: its images above the text, like mainstream chat apps. */
  function userBubble(projectId, text, images, label) {
    return h('div.user-msg',
      label ? h('div.user-label', label) : null,
      images?.length ? h('div.user-images', images.map(path => CF.isImageUpload(path) ? CF.uploadThumb(projectId, path) : CF.fileChip(CF.uploadName(path), CF.uploadSize(path)))) : null,
      text ? h('div.bubble', text) : null);
  }

  /** Text blocks of a turn as [index, text]; translation works block by block. */
  const textBlocks = turn => (turn.blocks?.length ? turn.blocks : turn.answer ? [{ kind: 'text', text: turn.answer }] : [])
    .map((block, index) => [index, block]).filter(([, block]) => block.kind === 'text' && block.text.trim()).map(([index, block]) => [index, block.text]);

  /** Shows or hides the translation of every text block of a turn. */
  async function toggleTranslation(turn, button) {
    const parts = textBlocks(turn);
    const keys = parts.map(([index]) => turn.id + ':' + index);
    const showing = keys.some(key => translations.get(key)?.showing);
    if (showing) { for (const key of keys) { const state = translations.get(key); if (state) state.showing = false; } session?.rerender(turn.id); return; }
    if (keys.every(key => translations.get(key)?.text !== undefined)) {
      for (const key of keys) translations.get(key).showing = true;
      session?.rerender(turn.id);
      return;
    }
    if (translating.get(turn.id)?.total) return;
    const missing = parts.filter(([index]) => translations.get(turn.id + ':' + index)?.text === undefined);
    const progress = { done: parts.length - missing.length, total: parts.length };
    translating.set(turn.id, progress);
    session?.rerender(turn.id);
    try {
      await Promise.all(missing.map(async ([index, text]) => {
        const result = await CF.api('POST', 'translate', { text, target: '简体中文' });
        translations.set(turn.id + ':' + index, { showing: false, text: result.translated });
        progress.done += 1;
        session?.rerender(turn.id);
      }));
      for (const [index] of parts) translations.get(turn.id + ':' + index).showing = true;
      translating.delete(turn.id);
    } catch (error) {
      translating.set(turn.id, { error: translateError(CF.errorText(error)) });
    }
    session?.rerender(turn.id);
  }

  async function forkAt(turn, button) {
    const created = await CF.busy(button, () => CF.api('POST', 'conversations/' + turn.conversationId + '/fork', { turnId: turn.id }));
    if (!created) return;
    await CF.app.refreshConversations();
    CF.app.go({ name: 'chat', conversationId: created.id, projectId: created.projectId });
    CF.toast('已从这里分叉：新对话接着这轮回答继续，项目文件是共享的');
  }

  /** Time and actions under a finished answer: copy, translate, fork (Claude). */
  function turnActions(turn) {
    if (isActive(turn) || turn.status === 'queued') return null;
    const text = textBlocks(turn).map(([, value]) => value).join('\n\n');
    const translated = textBlocks(turn).some(([index]) => translations.get(turn.id + ':' + index)?.showing);
    const time = turn.finishedAt || turn.createdAt;
    const action = (icon, label, run, extra = '') => {
      const button = h('button.turn-action' + extra, { title: label, 'aria-label': label, on: { click: event => void run(event.currentTarget) } }, CF.icon(icon, 13));
      return button;
    };
    return h('div.turn-actions',
      h('span.turn-time', { title: CF.fullTime(time) }, CF.shortTime(time)),
      text ? action('copy', '复制', async button => {
        await navigator.clipboard.writeText(text);
        button.replaceChildren(CF.icon('check', 13));
        setTimeout(() => button.replaceChildren(CF.icon('copy', 13)), 1200);
      }) : null,
      text && translateReady.get(CF.state.backendId)
        ? (translating.get(turn.id)?.total
          ? h('span.turn-action.busy', { title: '正在翻译' }, h('span.spinner'), '翻译中…')
          : action('translate', translated ? '显示原文' : '翻译成中文', button => toggleTranslation(turn, button), translated ? '.on' : ''))
        : null,
      turn.type === 'claude' && turn.status === 'done' && !turn.inherited && turn.sessionId
        ? action('fork', '从这里分叉', button => forkAt(turn, button)) : null);
  }

  /** A translation failure in plain words; the provider's text only when nothing better fits. */
  function translateError(raw) {
    const status = Number(/上游返回 (\d{3})/.exec(raw)?.[1] || 0);
    if (status === 401 || status === 403) return 'API Key 无效或没有权限，请到 设置 → 翻译与命名 检查';
    if (status === 404) return '找不到这个模型或接口地址，请到 设置 → 翻译与命名 检查模型和 Base URL';
    if (status === 429) return '模型的调用次数或额度用完了，稍后再试';
    if (status >= 500) return '模型服务暂时出错（' + status + '），稍后再试';
    if (/超时/.test(raw)) return '连接模型超时，检查网络或出站代理';
    if (/请求上游失败|ECONNREFUSED|ENOTFOUND|代理/.test(raw)) return '连不上模型服务，检查 Base URL 或出站代理';
    return raw.length > 160 ? raw.slice(0, 160) + '…' : raw;
  }

  /** While a turn is translated (or after it failed): one line above the answer. */
  function translationStatus(turn) {
    const state = translating.get(turn.id);
    if (!state) return null;
    if (state.error) {
      return h('div.translate-status.failed', CF.icon('x', 12), h('span', '翻译失败：' + state.error),
        h('button.btn.ghost.small', { on: { click: () => { translating.delete(turn.id); void toggleTranslation(turn); } } }, '重试'),
        h('button.icon-btn', { title: '关闭', on: { click: () => { translating.delete(turn.id); session?.rerender(turn.id); } } }, CF.icon('x', 12)));
    }
    return h('div.translate-status', h('span.spinner'),
      h('span.shimmer', '正在翻译成中文' + (state.total > 1 ? '（' + state.done + '/' + state.total + ' 段）' : '') + '…'));
  }

  function turnNode(turn) {
    const node = h('div.turn' + (turn.inherited ? '.inherited' : ''),
      userBubble(turn.projectId, turn.prompt, turn.images),
      translationStatus(turn),
      body(turn),
      turnActions(turn),
      turn.permission ? approvalCard(turn) : null,
      isActive(turn) && !turn.permission ? h('div.running-status', h('span.orb'), h('span.shimmer', { dataset: { text: STATUS[turn.status] } }, STATUS[turn.status])) : null,
      turn.status === 'cancelled' ? h('div.turn-note', CF.icon('square', 12), '已中断') : null,
      turn.status === 'queued' ? h('div.turn-note', CF.icon('dash', 12), '在原服务里排队，还没有运行') : null,
      turn.status === 'failed' ? h('div.turn-error', turn.error || '执行失败') : null,
    );
    return node;
  }

  const signature = turn => [turn.status, turn.answer.length, turn.permission?.id || '', turn.error || '', (turn.blocks || []).length,
    textBlocks(turn).map(([index]) => translations.get(turn.id + ':' + index)?.showing ? 1 : 0).join(''), translateReady.get(CF.state.backendId) ? 1 : 0,
    JSON.stringify(translating.get(turn.id) ?? null),
    turn.tools.map(tool => tool.id + tool.status + (tool.detail || '')).join(',')].join('|');

  function project() {
    return CF.state.projects.find(item => item.id === session?.projectId);
  }

  async function loadModels(projectId, select) {
    let list = models.get(projectId);
    if (!list) {
      try { list = await CF.get('projects/' + projectId + '/models'); } catch { list = []; }
      models.set(projectId, list);
    }
    const current = select.value;
    select.replaceChildren(h('option', { value: '' }, '默认模型'), ...list.map(item => h('option', { value: item.id }, item.label)));
    select.value = list.some(item => item.id === current) ? current : '';
    select.hidden = !list.length;
  }

  const lastKey = () => 'cf.lastProject:' + CF.state.backendId;
  const chatProjects = () => CF.state.projects.filter(item => item.chat && item.active);

  /** The project chip of a new conversation: a searchable list of chat projects, running ones first. */
  function projectChip(projectId) {
    const info = CF.state.projects.find(item => item.id === projectId);
    const chip = h('button.project-chip', { title: '选择项目', on: { click: () => {
      const order = item => (item.state === 'running' ? 0 : 1);
      const items = CF.pins.sort(chatProjects().slice().sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name, undefined, { numeric: true }))).map(item => ({
        id: item.id, label: item.name, selected: item.id === projectId, muted: item.state !== 'running',
        hint: (CF.pins.has(item.id) ? '置顶 · ' : '') + item.typeLabel + (item.state === 'running' ? '' : ' · ' + CF.stateText(item.state)),
        dot: item.state === 'running' ? 'running' : '',
      }));
      CF.picker(chip, { items, placeholder: '搜索项目', empty: '没有匹配的项目', onPick: item => CF.app.go({ name: 'chat', projectId: item.id }) });
    } } }, CF.icon('folder', 13), h('span.name', info ? info.name : '选择项目'), CF.icon('down', 11));
    return chip;
  }

  CF.chat = {
    /** Draws every turn again (after a display setting such as the time zone changed). */
    redraw() { if (session) for (const turn of session.turns) session.rerender?.(turn.id); },

    /** After the translation model changes in Settings. */
    translationChanged() { translateReady.clear(); },

    /** The project a new conversation starts in: the given one, the last used, or the first running. */
    defaultProject(preferred) {
      const list = chatProjects();
      let last = null;
      try { last = localStorage.getItem(lastKey()); } catch { /* storage unavailable */ }
      return list.find(item => item.id === preferred) || list.find(item => item.id === last)
        || list.find(item => item.state === 'running') || list[0] || null;
    },

    stop() { if (session) { clearTimeout(session.timer); drafts.set(session.key, session.textarea.value); session = null; } },

    /** view: { conversationId?, projectId } */
    mount(container, view) {
      CF.chat.stop();
      const conversation = CF.state.conversations.find(item => item.id === view.conversationId);
      const projectId = conversation?.projectId || view.projectId;
      const key = conversation ? conversation.id : 'new:' + projectId;
      const nodes = new Map();
      const inner = h('div.transcript-inner');
      const transcript = h('div.transcript', inner);
      const notice = h('div.chat-notice');
      const textarea = h('textarea', { rows: 1, placeholder: '描述你想做的事', 'aria-label': '消息' });
      const modelSelect = h('select', { 'aria-label': '模型', hidden: true });
      const sendButton = h('button.send', { title: '发送' }, CF.icon('send', 16));
      const hint = h('span.hint');
      // Images: picked, pasted or dropped; uploaded into the project right away.
      const attachRow = h('div.attach-row', { hidden: true });
      const fileInput = h('input', { type: 'file', multiple: true, hidden: true });
      const attachButton = h('button.composer-icon', { title: '添加附件：图片、PDF 或任意文件（也可以粘贴或拖进来）', on: { click: () => fileInput.click() } }, CF.icon('clip', 16));
      // Auto mode: tools run without asking (Python `auto`), remembered per project.
      const autoKey = 'cf.auto:' + CF.state.backendId + ':' + projectId;
      const autoButton = h('button.auto-toggle', {
        title: '自动模式：工具直接执行，不再逐个确认。Claude 跳过权限确认，Codex 不再限制在工作区，其他账号自动批准。',
        on: { click: () => {
          const next = autoButton.getAttribute('aria-pressed') !== 'true';
          try { localStorage.setItem(autoKey, next ? '1' : ''); } catch { /* storage unavailable */ }
          setAuto(next);
          CF.toast(next ? '自动模式已开：之后发的消息里，工具不再逐个确认' : '已关闭自动模式');
        } },
      }, CF.icon('bolt', 13), h('span', '自动'));
      const setAuto = on => { autoButton.setAttribute('aria-pressed', String(on)); autoButton.classList.toggle('on', on); };
      let savedAuto = '';
      try { savedAuto = localStorage.getItem(autoKey) || ''; } catch { /* storage unavailable */ }
      setAuto(Boolean(savedAuto));
      const followHost = h('div.follow-ups');
      // Only a new conversation can still change its project.
      const chip = conversation ? null : projectChip(projectId);
      const title = h('div.title');
      const meta = h('div.meta');
      const welcome = h('div.welcome-chat', h('div.hero', CF.brandMark(), h('h2'), h('p', '对话在项目容器里运行，可以读写这个项目的文件。')));
      session = { key, conversationId: conversation?.id || '', projectId, turns: [], followUps: [], attachments: [], timer: 0, textarea, sending: false };
      if (projectId) { try { localStorage.setItem(lastKey(), projectId); } catch { /* storage unavailable */ } }
      const current = session;
      textarea.value = drafts.get(key) || '';

      const autosize = () => { textarea.style.height = 'auto'; textarea.style.height = Math.min(textarea.scrollHeight, 240) + 'px'; };
      const activeTurn = () => current.turns.find(isActive);
      const canInject = turn => Boolean(turn?.controlReady && turn.capabilities?.includes('message') && !turn.stopping);
      const updateComposer = () => {
        const running = activeTurn();
        const info = project();
        const containerReady = info?.state === 'running';
        const uploading = current.attachments.some(item => !item.path);
        const content = Boolean(textarea.value.trim()) || current.attachments.length > 0;
        // One button: with something typed it sends (into the running answer, or queued after it);
        // with an empty box while an answer runs it stops.
        const stopping = Boolean(running) && !content;
        sendButton.classList.toggle('stop', stopping);
        sendButton.replaceChildren(stopping ? h('span.stop-mark') : CF.icon('send', 16));
        sendButton.disabled = stopping ? Boolean(running.stopping) : current.sending || current.readOnly || !content || uploading || !containerReady;
        sendButton.title = stopping ? (running.stopping ? '正在停止…' : '中断（Esc）') : running ? (canInject(running) ? '发送（插入当前回答）' : '发送（这轮结束后发出）') : '发送';
        sendButton.setAttribute('aria-label', sendButton.title);
        hint.textContent = running?.stopping ? '正在停止…' : running && !content ? '正在回答 · Esc 停止，也可以继续输入'
          : running ? (canInject(running) ? '发送会插入这一轮回答' : '发送会排在这轮回答之后')
          : 'Enter 发送 · Shift+Enter 换行';
        modelSelect.disabled = Boolean(running);
      };
      const renderHeader = () => {
        const info = project();
        const name = CF.state.conversations.find(item => item.id === current.conversationId)?.name;
        title.textContent = name || '新对话';
        meta.replaceChildren(
          info ? h('span', info.name) : null,
          info ? CF.typeBadge(info.type, info.typeLabel) : null,
          // The container only needs mentioning when it is not running.
          info && info.state !== 'running' ? h('span.container-warn', h('span.dot.waiting'), '容器' + CF.stateText(info.state)) : null,
        );
        textarea.placeholder = info ? '给 ' + info.name + ' 发消息' : '描述你想做的事';
        welcome.querySelector('h2').textContent = info ? '在 ' + info.name + ' 里做点什么？' : '新对话';
        const ready = info?.state === 'running';
        const record = CF.state.conversations.find(item => item.id === current.conversationId);
        current.readOnly = Boolean(record?.type && info && record.type !== info.type);
        textarea.disabled = current.readOnly;
        if (current.readOnly) {
          notice.replaceChildren(h('div.banner', h('span.banner-icon', CF.icon('chat', 16)),
            h('div.text', h('strong', '这是 ' + record.type + ' 账号的历史对话'), h('span', '项目现在绑定的是 ' + info.typeLabel + '，这段对话只能查看。'))));
          updateComposer();
          return;
        }
        notice.replaceChildren(ready || !info ? '' : h('div.banner',
          h('span.banner-icon', CF.icon('box', 16)), h('div.text', h('strong', '项目容器没有运行'), h('span', '启动后才能对话。')),
          h('button.btn.primary.small', { on: { click: event => CF.projects.start(info.id, event.currentTarget) } }, CF.icon('play', 12), '启动')));
        updateComposer();
      };
      // A fork starts with the source's history, read-only, under a banner that links back.
      const forkBanner = () => {
        const record = CF.state.conversations.find(item => item.id === current.conversationId);
        if (!record?.forkedFrom) return null;
        const source = CF.state.conversations.find(item => item.id === record.forkedFrom.conversationId);
        return h('div.fork-banner', CF.icon('fork', 14),
          h('span', '分叉的对话 · 下面先是分叉点之前的历史（只读）；项目文件是共享的，不会回滚代码。'),
          source ? h('button.btn.ghost.small', { on: { click: () => CF.app.go({ name: 'chat', conversationId: source.id, projectId: source.projectId }) } }, '查看原对话') : null);
      };
      let bannerNode = null;
      let dividerNode = null;
      // The conversation map at the left edge (like Codex): one dash per turn, the one in view
      // darker; hover shows the question and the start of the reply; click jumps there.
      const rail = h('nav.turn-rail', { 'aria-label': '对话导航' });
      const peek = h('div.turn-peek', { hidden: true });
      const bookmarkKey = () => 'cf.bookmarks:' + CF.state.backendId + ':' + current.conversationId;
      const bookmarks = () => { try { return new Set(JSON.parse(localStorage.getItem(bookmarkKey()) || '[]')); } catch { return new Set(); } };
      const toggleBookmark = id => {
        const marks = bookmarks();
        marks.has(id) ? marks.delete(id) : marks.add(id);
        try { localStorage.setItem(bookmarkKey(), JSON.stringify([...marks])); } catch { /* storage unavailable */ }
        renderRail();
      };
      let railCurrent = '';
      let jumpUntil = 0;
      // A jump from the map marks its turn current, even when the view cannot scroll it to the top.
      const jumpTo = id => {
        const node = nodes.get(id)?.node;
        if (!node) return;
        jumpUntil = Date.now() + 1200;
        railCurrent = id;
        for (const dash of rail.querySelectorAll('.rail-dash')) dash.classList.toggle('current', dash.dataset.turn === id);
        node.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      let peekTurn = '';
      let peekTimer = 0;
      // Reply text without Markdown markup: code blocks, heading/quote/list markers, emphasis, table bars.
      const plain = value => String(value || '').replace(/```[\s\S]*?```/g, ' ').replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
        .replace(/\*\*|__|`|\|/g, ' ').replace(/^\s*-{3,}\s*$/gm, ' ').replace(/\s+/g, ' ').trim();
      const showPeek = (turn, dash) => {
        clearTimeout(peekTimer);
        peekTurn = turn.id;
        const marked = bookmarks().has(turn.id);
        const reply = plain(turn.answer) || (isActive(turn) ? '正在回答…' : turn.error ? '失败：' + turn.error : '没有文字回复');
        peek.replaceChildren(
          h('div.peek-head', h('span.peek-title', plain(turn.prompt) || '（图片或附件）'),
            h('button.icon-btn.peek-mark' + (marked ? '.on' : ''), { title: marked ? '取消书签' : '加书签', on: { click: event => { event.stopPropagation(); toggleBookmark(turn.id); showPeek(turn, rail.querySelector('[data-turn="' + turn.id + '"]')); } } }, CF.icon('bookmark', 14))),
          h('div.peek-body', reply.slice(0, 400)));
        peek.hidden = false;
        const railBox = rail.getBoundingClientRect();
        const box = dash.getBoundingClientRect();
        peek.style.top = Math.max(8, Math.min(box.top + box.height / 2 - railBox.top - peek.offsetHeight / 2, window.innerHeight - railBox.top - peek.offsetHeight - 8)) + 'px';
      };
      const hidePeek = () => { peekTimer = setTimeout(() => { peek.hidden = true; peekTurn = ''; }, 120); };
      peek.addEventListener('mouseenter', () => clearTimeout(peekTimer));
      peek.addEventListener('mouseleave', hidePeek);
      peek.addEventListener('click', () => jumpTo(peekTurn));
      const renderRail = () => {
        const turns = current.turns;
        rail.hidden = turns.length < 2;
        if (rail.hidden) { peek.hidden = true; return; }
        const marks = bookmarks();
        rail.replaceChildren(...turns.map(turn => h('button.rail-dash' + (turn.id === railCurrent ? '.current' : '') + (marks.has(turn.id) ? '.marked' : '') + (isActive(turn) ? '.live' : ''), {
          dataset: { turn: turn.id }, 'aria-label': plain(turn.prompt).slice(0, 60),
          on: {
            mouseenter: event => showPeek(turn, event.currentTarget), mouseleave: hidePeek, focus: event => showPeek(turn, event.currentTarget), blur: hidePeek,
            click: () => jumpTo(turn.id),
          },
        }, h('span'))), peek);
      };
      // The turn whose top is nearest above the middle of the view is "current".
      const trackCurrent = () => {
        if (Date.now() < jumpUntil) return;
        const top = transcript.getBoundingClientRect().top + transcript.clientHeight * 0.35;
        let found = current.turns[0]?.id || '';
        for (const turn of current.turns) {
          const node = nodes.get(turn.id)?.node;
          if (node && node.getBoundingClientRect().top <= top) found = turn.id;
        }
        if (found !== railCurrent) {
          railCurrent = found;
          for (const dash of rail.querySelectorAll('.rail-dash')) dash.classList.toggle('current', dash.dataset.turn === found);
        }
      };
      transcript.addEventListener('scroll', () => requestAnimationFrame(trackCurrent), { passive: true });

      const renderTurns = () => {
        if (!current.turns.length) { if (!welcome.isConnected) transcript.replaceWith(welcome); return; }
        if (welcome.isConnected) welcome.replaceWith(transcript);
        if (!bannerNode) { bannerNode = forkBanner(); if (bannerNode) inner.prepend(bannerNode); }
        const atBottom = transcript.scrollTop + transcript.clientHeight >= transcript.scrollHeight - 40;
        for (const turn of current.turns) {
          const existing = nodes.get(turn.id);
          const sig = signature(turn);
          if (existing && existing.sig === sig) continue;
          const node = turnNode(turn);
          if (existing) existing.node.replaceWith(node); else inner.append(node);
          nodes.set(turn.id, { node, sig });
          // Where the inherited history ends and the fork's own turns begin.
          if (!existing && turn.inherited && !dividerNode) { dividerNode = h('div.fork-divider', h('span', '以上是分叉前的历史')); }
          if (dividerNode && turn.inherited) node.after(dividerNode);
        }
        if (atBottom) transcript.scrollTop = transcript.scrollHeight;
        updateComposer();
        renderRail();
        trackCurrent();
      };
      const renderAttachments = () => {
        attachRow.hidden = !current.attachments.length;
        attachRow.replaceChildren(...current.attachments.map(item => h('div.attach' + (item.path ? '' : '.uploading') + (item.image ? '' : '.file'), { title: item.name },
          item.image ? h('img', { src: item.url, alt: item.name }) : CF.fileChip(item.name, item.size),
          item.path ? null : h('span.spinner'),
          h('button.remove', { title: '移除', on: { click: () => {
            current.attachments = current.attachments.filter(other => other !== item);
            renderAttachments();
          } } }, CF.icon('x', 11)))));
        updateComposer();
      };
      const IMAGES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
      // Any file up to 20 MB, uploaded into the project right away (images also get a preview).
      const addFiles = files => {
        for (const file of files) {
          if (!file.size) { CF.toast((file.name || '这个文件') + ' 是空的'); continue; }
          if (file.size > 20 * 1024 * 1024) { CF.toast(file.name + ' 超过 20 MB'); continue; }
          if (current.attachments.length >= 20) { CF.toast('一次最多 20 个附件'); break; }
          const image = IMAGES.includes(file.type);
          const name = file.name || (image ? 'image.' + file.type.split('/')[1].replace('jpeg', 'jpg') : 'file');
          const item = { name, size: file.size, image, url: '', path: '' };
          current.attachments.push(item);
          const reader = new FileReader();
          reader.onload = async () => {
            item.url = String(reader.result);
            renderAttachments();
            try {
              const saved = await CF.api('POST', 'projects/' + encodeURIComponent(projectId) + '/uploads', { name, data: item.url.split(',')[1] });
              item.path = saved.path;
              CF.rememberUpload(saved.path, name, file.size);
              if (image) CF.seedUpload(projectId, saved.path, item.url);
            } catch (error) {
              current.attachments = current.attachments.filter(other => other !== item);
              CF.fail(error);
            }
            if (session === current) renderAttachments();
          };
          reader.readAsDataURL(file);
        }
        renderAttachments();
      };
      fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });
      textarea.addEventListener('paste', event => {
        const files = [...(event.clipboardData?.files || [])];
        if (files.length) { event.preventDefault(); addFiles(files); }
      });
      const renderFollowUps = () => {
        followHost.replaceChildren(...current.followUps.map(item => h('div.follow-up',
          h('span.badge', '排队中'),
          h('span.text', item.text || '图片'),
          item.images.length ? h('span.count', CF.icon('image', 12), String(item.images.length)) : null,
          h('button.icon-btn', { title: '不发了', on: { click: async () => {
            try { await CF.api('DELETE', 'conversations/' + current.conversationId + '/follow-ups/' + item.id); }
            catch (error) { CF.fail(error); }
            await current.refresh();
          } } }, CF.icon('x', 12)))));
      };

      current.rerender = turnId => {
        const turn = current.turns.find(item => item.id === turnId);
        const existing = nodes.get(turnId);
        if (!turn || !existing) return;
        const node = turnNode(turn);
        existing.node.replaceWith(node);
        nodes.set(turnId, { node, sig: signature(turn) });
      };
      current.refresh = async () => {
        if (!current.conversationId || session !== current) return;
        clearTimeout(current.timer);
        try {
          const [turns, followUps] = await Promise.all([
            CF.get('conversations/' + current.conversationId + '/turns'),
            CF.get('conversations/' + current.conversationId + '/follow-ups').catch(() => []),
          ]);
          if (session !== current) return;
          current.turns = turns;
          current.followUps = followUps;
          renderTurns();
          renderFollowUps();
          const running = activeTurn();
          if (!running && current.wasRunning) { void CF.app.refreshConversations(); void CF.app.refreshProjects(); }
          current.wasRunning = Boolean(running);
        } catch (error) { if (session === current) CF.fail(error); }
        if (session === current) current.timer = setTimeout(current.refresh, activeTurn() || current.followUps.length ? 600 : 4000);
      };

      const stop = async () => {
        const running = activeTurn();
        if (!running) return;
        await CF.busy(sendButton, () => CF.api('POST', 'turns/' + running.id + '/cancel'));
        await current.refresh();
      };
      // Sends while idle (a new turn) or while a turn runs: Claude takes it into the
      // running turn; other agents get it as the next turn.
      const send = async () => {
        const prompt = textarea.value.trim();
        if (sendButton.disabled || current.sending || (!prompt && !current.attachments.length)) return;
        const images = current.attachments.map(item => item.path);
        current.sending = true;
        updateComposer();
        try {
          if (!current.conversationId) {
            const created = await CF.api('POST', 'conversations', { projectId });
            current.conversationId = created.id;
            drafts.delete(key);
            CF.state.conversations.unshift({ ...created, updatedAt: created.createdAt, status: 'starting', turns: 0 });
            CF.state.view = { name: 'chat', conversationId: created.id, projectId };
            current.key = created.id;
            chip?.remove();
          }
          const result = await CF.api('POST', 'conversations/' + current.conversationId + '/turns',
            { prompt, images, model: modelSelect.value, auto: autoButton.getAttribute('aria-pressed') === 'true' });
          if (result?.delivered === 'queued') CF.toast('已排队，这一轮结束后自动发出');
          textarea.value = '';
          current.attachments = [];
          renderAttachments();
          drafts.delete(current.key);
          autosize();
          await CF.app.refreshConversations();
          renderHeader();
          await current.refresh();
          transcript.scrollTop = transcript.scrollHeight;
        } catch (error) { CF.fail(error); }
        finally { current.sending = false; updateComposer(); }
      };

      textarea.addEventListener('input', () => { autosize(); updateComposer(); });
      textarea.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); }
        else if (event.key === 'Escape' && activeTurn() && !textarea.value) { event.preventDefault(); void stop(); }
      });
      sendButton.addEventListener('click', () => void (sendButton.classList.contains('stop') ? stop() : send()));

      const rename = async () => {
        const target = CF.state.conversations.find(item => item.id === current.conversationId);
        if (!target) return;
        const input = h('input', { value: target.name, maxLength: 100 });
        const sheet = CF.sheet({ title: '重命名对话' }, () => input);
        const save = h('button.btn.primary', { on: { click: () => CF.busy(save, async () => {
          await CF.api('PUT', 'conversations/' + target.id, { name: input.value });
          sheet.close();
          await CF.app.refreshConversations();
          renderHeader();
        }) } }, '保存');
        sheet.foot(h('button.btn', { on: { click: () => sheet.close() } }, '取消'), save);
        input.select();
      };
      const more = h('button.btn.ghost.icon', { title: '更多', on: { click: () => CF.menu(more, [
        current.conversationId ? { label: '重命名', run: rename } : null,
        current.conversationId ? { label: '重新生成标题', icon: 'spark', run: async () => {
          try { await CF.api('POST', 'conversations/' + current.conversationId + '/title'); CF.toast('正在生成标题…'); }
          catch (error) { CF.fail(error); }
        } } : null,
        { label: '打开项目终端', icon: 'terminal', run: () => CF.projects.terminal(projectId) },
        { label: '查看项目', icon: 'folder', run: () => CF.app.go({ name: 'projects' }) },
      ].filter(Boolean)) } }, CF.icon('more', 16));

      const topbar = h('div.topbar', title, meta, h('div.spacer'), more);
      transcript.addEventListener('scroll', () => topbar.classList.toggle('scrolled', transcript.scrollTop > 4), { passive: true });
      container.replaceChildren(
        topbar,
        h('div.chat', rail, current.conversationId ? transcript : welcome,
          h('div.composer-wrap', notice, followHost, h('div.composer', {
            on: {
              dragover: event => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); event.currentTarget.classList.add('dragging'); } },
              dragleave: event => event.currentTarget.classList.remove('dragging'),
              drop: event => { event.preventDefault(); event.currentTarget.classList.remove('dragging'); addFiles([...event.dataTransfer.files]); },
            },
          }, attachRow, textarea, fileInput,
            h('div.composer-bar', attachButton, chip, modelSelect, autoButton, hint, sendButton)))),
      );
      renderHeader();
      autosize();
      void loadModels(projectId, modelSelect);
      // Translation needs the backend's system LLM; ask once per backend.
      if (!translateReady.has(CF.state.backendId)) {
        const backend = CF.state.backendId;
        CF.get('system-llm').then(status => {
          translateReady.set(backend, Boolean(status.configured));
          if (status.configured && session === current) for (const turn of current.turns) current.rerender(turn.id);
        }).catch(() => undefined);
      }
      void current.refresh();
      textarea.focus();
      current.renderHeader = renderHeader;
    },

    /** Called after projects or conversations reload. */
    sync() { session?.renderHeader?.(); },
  };
})();
