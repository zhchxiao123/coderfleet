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

  const TOOL_STATE = { completed: '', failed: '失败', running: '进行中', pending: '等待中', in_progress: '进行中' };
  const openFlows = new Set();

  /** Tool calls as one-line flow rows; finished groups of more than three fold into a summary row. */
  function toolFlow(turn) {
    if (!turn.tools.length) return null;
    const running = turn.tools.some(tool => !['completed', 'failed'].includes(tool.status));
    const failed = turn.tools.filter(tool => tool.status === 'failed').length;
    const row = tool => h('div.flow-row', CF.icon(tool.status === 'failed' ? 'x' : tool.status === 'completed' ? 'check' : 'tool', 13),
      h('span.label', tool.title), TOOL_STATE[tool.status] ? h('span' + (tool.status === 'failed' ? '.state-fail' : ''), TOOL_STATE[tool.status]) : null);
    if (running || turn.tools.length <= 3) return h('div.flow', turn.tools.map(row));
    const open = openFlows.has(turn.id);
    const flow = h('div.flow' + (open ? '.open' : ''));
    const summary = h('button.flow-row', { on: { click: () => {
      open ? openFlows.delete(turn.id) : openFlows.add(turn.id);
      flow.replaceWith(toolFlow(turn));
    } } }, CF.icon('tool', 13), h('span.label', '使用了 ' + turn.tools.length + ' 个工具'),
      failed ? h('span.state-fail', failed + ' 个失败') : null, h('span.chev', CF.icon('chevron', 11)));
    flow.append(summary, open ? h('div', { style: 'padding-left:20px' }, turn.tools.map(row)) : null);
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

  function turnNode(turn) {
    const assistant = h('div.assistant');
    if (turn.answer) assistant.append(CF.markdown(turn.answer));
    const node = h('div.turn',
      h('div.user-msg', h('div.bubble', turn.prompt)),
      toolFlow(turn),
      assistant,
      turn.permission ? approvalCard(turn) : null,
      isActive(turn) && !turn.permission ? h('div.running-status', h('span.orb'), h('span.shimmer', { dataset: { text: STATUS[turn.status] } }, STATUS[turn.status])) : null,
      turn.status === 'cancelled' ? h('div.turn-note', CF.icon('square', 12), '已中断') : null,
      turn.status === 'failed' ? h('div.turn-error', turn.error || '执行失败') : null,
    );
    return node;
  }

  const signature = turn => [turn.status, turn.answer.length, turn.permission?.id || '', turn.error || '',
    turn.tools.map(tool => tool.id + tool.status).join(',')].join('|');

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
