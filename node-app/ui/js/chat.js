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

  function toolGlyph(status) {
    if (status === 'running') return h('span.spinner.tool-spinner');
    if (status === 'waiting') return h('span.tool-glyph.waiting', h('span.dot.waiting'));
    const icon = { completed: 'check', failed: 'x', denied: 'block', interrupted: 'square', unknown: 'dash' }[status] || 'tool';
    return h('span.tool-glyph.' + (TOOL_STATES[status]?.className || 'completed'), CF.icon(icon, 12));
  }

  function toolRow(tool) {
    const state = TOOL_STATES[tool.status] || TOOL_STATES.running;
    return h('div.flow-row.tool-' + state.className, { title: tool.detail ? tool.title + ' · ' + tool.detail : tool.title },
      toolGlyph(tool.status), h('span.label', tool.title),
      tool.detail ? h('span.detail', tool.detail) : null,
      tool.status === 'completed' ? null : h('span.tool-state', state.label));
  }

  /** Tool calls as one-line flow rows; a settled group of more than three folds into a summary row. */
  function toolFlow(turn, tools = turn.tools, key = turn.id) {
    if (!tools.length) return null;
    const settled = tools.every(tool => SETTLED.has(tool.status));
    if (!settled || tools.length <= 3) return h('div.flow', tools.map(toolRow));
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
    if (open) flow.append(h('div.flow-children', tools.map(toolRow)));
    return flow;
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
    return h('div.approval',
      h('div.approval-head', h('span.glyph', CF.icon('shield', 15)), h('div', h('strong', permission.title), h('small', '需要你确认这一步操作'))),
      permission.details && permission.details !== '{}' ? h('pre', permission.details) : null,
      h('div.approval-actions', deny, allow));
  }

  /** Text and tool groups in the order they happened (older records: tools, then text). */
  function body(turn) {
    const blocks = turn.blocks?.length ? turn.blocks
      : [...turn.tools.map(tool => ({ kind: 'tool', id: tool.id })), ...(turn.answer ? [{ kind: 'text', text: turn.answer }] : [])];
    const byId = new Map(turn.tools.map(tool => [tool.id, tool]));
    const nodes = [];
    let group = [];
    const flush = () => {
      if (group.length) nodes.push(toolFlow(turn, group, turn.id + ':' + nodes.length));
      group = [];
    };
    for (const block of blocks) {
      if (block.kind === 'tool') { const tool = byId.get(block.id); if (tool) group.push(tool); continue; }
      flush();
      if (block.text.trim()) nodes.push(h('div.assistant', CF.markdown(block.text)));
    }
    flush();
    return nodes;
  }

  function turnNode(turn) {
    const node = h('div.turn',
      h('div.user-msg', h('div.bubble', turn.prompt)),
      body(turn),
      turn.permission ? approvalCard(turn) : null,
      isActive(turn) && !turn.permission ? h('div.running-status', h('span.orb'), h('span.shimmer', { dataset: { text: STATUS[turn.status] } }, STATUS[turn.status])) : null,
      turn.status === 'cancelled' ? h('div.turn-note', CF.icon('square', 12), '已中断') : null,
      turn.status === 'failed' ? h('div.turn-error', turn.error || '执行失败') : null,
    );
    return node;
  }

  const signature = turn => [turn.status, turn.answer.length, turn.permission?.id || '', turn.error || '',
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

  CF.chat = {
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
      const textarea = h('textarea', { rows: 1, placeholder: '描述你想做的事，Enter 发送，Shift+Enter 换行', 'aria-label': '消息' });
      const modelSelect = h('select', { 'aria-label': '模型', hidden: true });
      const sendButton = h('button.send', { title: '发送' }, CF.icon('send', 16));
      const title = h('div.title');
      const meta = h('div.meta');
      const welcome = h('div.welcome-chat', h('div.hero', h('div.brand-mark', 'C'), h('h2'), h('p', '对话在项目容器里运行，可以读写这个项目的文件。')));
      session = { key, conversationId: conversation?.id || '', projectId, turns: [], timer: 0, textarea, sending: false };
      const current = session;
      textarea.value = drafts.get(key) || '';

      const autosize = () => { textarea.style.height = 'auto'; textarea.style.height = Math.min(textarea.scrollHeight, 240) + 'px'; };
      const activeTurn = () => current.turns.find(isActive);
      const updateComposer = () => {
        const running = activeTurn();
        const info = project();
        const containerReady = info?.state === 'running';
        sendButton.replaceChildren(CF.icon(running ? 'square' : 'send', 16));
        sendButton.classList.toggle('stop', Boolean(running));
        sendButton.title = running ? '中断' : '发送';
        sendButton.disabled = current.sending || (!running && (!textarea.value.trim() || !containerReady));
        modelSelect.disabled = Boolean(running);
      };
      const renderHeader = () => {
        const info = project();
        const name = CF.state.conversations.find(item => item.id === current.conversationId)?.name;
        title.textContent = name || '新对话';
        meta.replaceChildren(
          info ? h('span', info.name) : null,
          info ? CF.typeBadge(info.type, info.typeLabel) : null,
          info ? h('span', { style: 'display:inline-flex;align-items:center;gap:5px' }, CF.stateDot(info.state), CF.stateText(info.state)) : null,
        );
        welcome.querySelector('h2').textContent = info ? '在 ' + info.name + ' 里做点什么？' : '新对话';
        const ready = info?.state === 'running';
        notice.replaceChildren(ready || !info ? '' : h('div.banner',
          h('span.banner-icon', CF.icon('box', 16)), h('div.text', h('strong', '项目容器没有运行'), h('span', '启动后才能对话。')),
          h('button.btn.primary.small', { on: { click: event => CF.projects.start(info.id, event.currentTarget) } }, CF.icon('play', 12), '启动')));
        updateComposer();
      };
      const renderTurns = () => {
        if (!current.turns.length) { if (!welcome.isConnected) transcript.replaceWith(welcome); return; }
        if (welcome.isConnected) welcome.replaceWith(transcript);
        const atBottom = transcript.scrollTop + transcript.clientHeight >= transcript.scrollHeight - 40;
        for (const turn of current.turns) {
          const existing = nodes.get(turn.id);
          const sig = signature(turn);
          if (existing && existing.sig === sig) continue;
          const node = turnNode(turn);
          if (existing) existing.node.replaceWith(node); else inner.append(node);
          nodes.set(turn.id, { node, sig });
        }
        if (atBottom) transcript.scrollTop = transcript.scrollHeight;
        updateComposer();
      };
      current.refresh = async () => {
        if (!current.conversationId || session !== current) return;
        clearTimeout(current.timer);
        try {
          current.turns = await CF.get('conversations/' + current.conversationId + '/turns');
          if (session !== current) return;
          renderTurns();
          const running = activeTurn();
          if (!running && current.wasRunning) { void CF.app.refreshConversations(); void CF.app.refreshProjects(); }
          current.wasRunning = Boolean(running);
        } catch (error) { if (session === current) CF.fail(error); }
        if (session === current) current.timer = setTimeout(current.refresh, activeTurn() ? 600 : 4000);
      };

      const send = async () => {
        const running = activeTurn();
        if (running) {
          await CF.busy(sendButton, () => CF.api('POST', 'turns/' + running.id + '/cancel'));
          return current.refresh();
        }
        const prompt = textarea.value.trim();
        if (!prompt || current.sending) return;
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
          }
          await CF.api('POST', 'conversations/' + current.conversationId + '/turns', { prompt, model: modelSelect.value });
          textarea.value = '';
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
      });
      sendButton.addEventListener('click', () => void send());

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
        { label: '打开项目终端', icon: 'terminal', run: () => CF.projects.terminal(projectId) },
        { label: '查看项目', icon: 'folder', run: () => CF.app.go({ name: 'projects' }) },
      ].filter(Boolean)) } }, CF.icon('more', 16));

      container.replaceChildren(
        h('div.topbar', title, meta, h('div.spacer'), more),
        h('div.chat', current.conversationId ? transcript : welcome,
          h('div.composer-wrap', notice, h('div.composer', textarea,
            h('div.composer-bar', modelSelect, h('span.hint', ''), sendButton)))),
      );
      renderHeader();
      autosize();
      void loadModels(projectId, modelSelect);
      void current.refresh();
      textarea.focus();
      current.renderHeader = renderHeader;
    },

    /** Called after projects or conversations reload. */
    sync() { session?.renderHeader?.(); },
  };
})();
