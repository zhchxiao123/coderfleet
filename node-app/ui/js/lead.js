'use strict';
// 领航: one chat between the user and every conversation it follows. It shows what 领航 decided
// (with what it looked at), the cards it hands over, and takes what the user tells it.
(() => {
  const CF = window.CF;
  const { h } = CF;
  const ACTIONS = { approve: '批准', answer: '回答', reply: '回复', accept: '收下并合并', stop: '让它停下', start: '开了新对话' };
  const HINTS = ['现在都在忙什么', '你现在能自己定什么'];
  let host = null;
  let parts = null;
  let shown = '';
  // Cards the user may be typing into stay the same nodes across redraws.
  const cards = new Map();
  const opened = new Set();
  let watching = 0;

  const view = () => CF.state.lead;
  const clip = (text, size) => text.length > size ? text.slice(0, size) + '…' : text;
  const openConversation = item => {
    const found = CF.findConversation(item.conversationId);
    if (!found) { CF.toast('这个对话已经不在了', { error: true }); return; }
    CF.app.go({ name: 'chat', conversationId: found.id, projectId: found.projectId });
  };
  const link = (text, run) => h('button.lead-link', { on: { click: event => CF.busy(event.currentTarget, run) } }, text);
  const evidence = list => list.map(item => h('dd', h('code', item.command), h('pre', item.output || '（没有输出）')));

  function didRow(item) {
    const open = opened.has(item.id);
    const node = h('div.lead-did' + (item.undone ? '.undone' : ''),
      h('span.mark', CF.icon(item.action === 'stop' ? 'square' : 'check', 12)),
      h('div.body',
        h('span.kind', ACTIONS[item.action] || item.action), h('span.conv', item.conversation), ' ',
        h('span.what', clip(item.action === 'approve' ? item.asked : item.said || item.asked, 80)),
        item.undone ? h('span.lead-tag', '已撤回') : null,
        link(open ? '收起' : '依据', () => { open ? opened.delete(item.id) : opened.add(item.id); node.replaceWith(didRow(item)); }),
        link('打开对话', () => openConversation(item)),
        item.undo ? link('撤回', async () => { await CF.api('POST', 'lead/undo/' + item.id); await CF.lead.refresh(); }) : null,
        open ? h('dl.lead-more',
          item.asked ? [h('dt', '它问'), h('dd', item.asked)] : null,
          item.evidence.length ? [h('dt', '我进项目里看了'), evidence(item.evidence)] : null,
          item.said ? [h('dt', item.action === 'start' ? '我交代的' : '我回'), h('dd', item.said)] : null,
          item.reason ? [h('dt', '依据'), h('dd', item.reason)] : null) : null));
    return node;
  }

  function askCard(item) {
    const head = h('div.from', item.conversation + ' · ' + item.projectId, link('打开对话', () => openConversation(item)));
    const lines = [
      h('div.q', item.asked),
      item.why ? h('div.why', '为什么问你：' + item.why) : null,
      item.lean ? h('div.lean', '我的倾向：' + item.lean) : null,
      item.evidence.length ? h('details.lead-seen', h('summary', '我进项目里看了 ' + item.evidence.length + ' 处'), h('dl.lead-more', evidence(item.evidence))) : null,
    ];
    if (item.resolved) {
      return h('div.lead-ask.closed', head, lines,
        h('div.answer', item.resolved.by === 'user' ? '你说：' + item.resolved.answer : '已经在对话里处理了'));
    }
    const kept = cards.get(item.id);
    if (kept) return kept;
    const answer = (button, body) => CF.busy(button, async () => { await CF.api('POST', 'lead/asks/' + item.id, body); await CF.lead.refresh(); });
    let controls;
    if (item.questions?.length) {
      const answers = new Map();
      const submit = h('button.btn.primary.small', { disabled: true, on: { click: () => answer(submit, { answers: Object.fromEntries(answers) }) } }, '提交回答');
      controls = [item.questions.map(question => {
        const picked = new Set();
        const buttons = question.options.map(option => h('button.option', { title: option.description || '', dataset: { label: option.label }, on: { click: () => {
          if (!question.multiSelect) picked.clear();
          picked.has(option.label) ? picked.delete(option.label) : picked.add(option.label);
          for (const button of buttons) button.classList.toggle('on', picked.has(button.dataset.label));
          if (picked.size) answers.set(question.question, [...picked].join(', ')); else answers.delete(question.question);
          submit.disabled = answers.size !== item.questions.length;
        } } }, option.label));
        return h('div.question', h('p', question.question), h('div.options', buttons));
      }), h('div.replies', submit)];
    } else {
      const input = item.free ? h('input', { placeholder: '或者直接写一句回它', 'aria-label': '回答', on: { keydown: event => {
        if (event.key === 'Enter' && !event.isComposing && input.value.trim()) void answer(input, { answer: input.value.trim() });
      } } }) : null;
      controls = h('div.replies', item.options.map((option, index) => {
        const button = h('button.btn.small' + (index ? '' : '.primary'), { on: { click: () => answer(button, { answer: option }) } }, option);
        return button;
      }), input);
    }
    const card = h('div.lead-ask', head, lines, controls);
    cards.set(item.id, card);
    return card;
  }

  function itemNode(item) {
    if (item.type === 'user') return h('div.user-msg', h('div.bubble', item.text));
    if (item.type === 'lead') return h('div.assistant', CF.markdown(item.text));
    if (item.type === 'note') return h('div.turn-note', item.text);
    if (item.type === 'did') return didRow(item);
    if (item.type === 'ask') return askCard(item);
    return null;
  }

  function rulesSheet() {
    const state = view();
    CF.sheet({ title: '领航的规矩', subtitle: '它只做决定：改代码、提交、合并都是各个对话自己动手。想改规矩，直接跟它说。' }, () =>
      h('ul.lead-rules', state.rules.map(rule => h('li', rule.text, rule.fixed ? h('em', '固定，改不了') : null))));
  }

  function renderBar() {
    const state = view();
    const followed = CF.state.conversations.filter(item => item.lead && (item.attention || ['starting', 'running'].includes(item.status) || ['working', 'waiting', 'review'].includes(item.job))).length;
    const toggle = h('button.switch' + (state.enabled ? '.on' : ''), { role: 'switch', 'aria-checked': String(state.enabled),
      title: state.enabled ? '停下：之后的批准和问题都直接找你' : '开始替你跟对话', disabled: !state.configured || null,
      on: { click: () => CF.busy(toggle, async () => {
        CF.state.lead = await CF.api('PUT', 'lead/settings', { enabled: !state.enabled });
        await CF.app.refreshConversations();
        render(true);
      }) } }, h('span.knob'));
    CF.app.setBar(h('div.topbar',
      h('div.title', '领航'),
      h('div.meta', state.enabled ? '在替你跟 ' + followed + ' 个对话' + (state.waiting ? ' · ' + state.waiting + ' 件等你' : ' · 没有要你管的') : '还没开始',
        h('span.lead-pill', '只做决定，不干活')),
      h('div.spacer'),
      h('button.btn.ghost.small', { on: { click: rulesSheet } }, '规矩'),
      h('span.lead-switch', state.enabled ? '在跟' : '已停', toggle)));
  }

  function render(force = false) {
    if (!host?.isConnected) return;
    const state = view();
    if (!state) { host.replaceChildren(h('div.empty', h('h3', '这个后端还没有领航'), h('p', '把后端升级到和 App 一样的版本就有了。'))); return; }
    renderBar();
    const text = JSON.stringify(state);
    if (!force && text === shown) return;
    shown = text;
    const { transcript, inner, notice, textarea } = parts;
    const atEnd = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
    for (const id of cards.keys()) if (!state.items.some(item => item.id === id && !item.resolved)) cards.delete(id);
    // A card being typed into is moved, not rebuilt: give it back the caret.
    const typing = inner.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' ? document.activeElement : null;
    inner.replaceChildren(
      state.items.length ? null : h('div.lead-hello', h('span.glyph', CF.icon('spark', 22)), h('h2', '领航'),
        h('p', '你同时开着好几个对话的时候，它替你盯着：能定的小事它定，拿不准的、删除推送这类要紧的，它拿来问你。它自己不改代码。')),
      ...state.items.map(itemNode),
      state.draft ? h('div.assistant', CF.markdown(state.draft)) : null,
      state.working !== null && !state.draft ? h('div.running-status', h('span.orb'),
        h('span.shimmer', state.step ? '领航' + state.step + '…' : '领航在看' + (state.working ? '「' + state.working + '」' : '') + '…')) : null);
    if (typing?.isConnected) typing.focus();
    if (atEnd) transcript.scrollTop = transcript.scrollHeight;
    notice.replaceChildren(!state.configured
      ? h('div.banner', h('span.banner-icon', CF.icon('spark', 16)), h('div.text', h('strong', '领航要用系统模型来判断'), h('span', '先在 通用 里填好系统模型。')),
        h('button.btn.small', { on: { click: () => CF.app.go({ name: 'settings' }) } }, '去填'))
      : !state.enabled ? h('div.banner', h('span.banner-icon', CF.icon('spark', 16)),
        h('div.text', h('strong', '领航还没开始'), h('span', '开始以后，对话里的批准和问题先到它这里；每个对话右上角可以改成「我自己来」。')),
        h('button.btn.primary.small', { on: { click: event => CF.busy(event.currentTarget, async () => {
          CF.state.lead = await CF.api('PUT', 'lead/settings', { enabled: true });
          await CF.app.refreshConversations();
          render(true);
        }) } }, '开始')) : null);
    textarea.disabled = !state.configured;
  }

  CF.lead = {
    mount(container) {
      const inner = h('div.transcript-inner');
      const transcript = h('div.transcript', inner);
      const notice = h('div.chat-notice');
      const textarea = h('textarea', { rows: 1, placeholder: '交代一件事，或者回它的问题…', 'aria-label': '给领航的话' });
      const sendButton = h('button.send', { title: '发送', disabled: true }, CF.icon('send', 16));
      const autosize = () => { textarea.style.height = 'auto'; textarea.style.height = Math.min(textarea.scrollHeight, 240) + 'px'; };
      const send = async words => {
        const text = (words ?? textarea.value).trim();
        if (!text || sendButton.dataset.busy) return;
        sendButton.dataset.busy = '1';
        try {
          await CF.api('POST', 'lead/messages', { text });
          if (words === undefined) { textarea.value = ''; autosize(); sendButton.disabled = true; }
          await CF.lead.refresh();
          transcript.scrollTop = transcript.scrollHeight;
        } catch (error) { CF.fail(error); }
        finally { delete sendButton.dataset.busy; }
      };
      textarea.addEventListener('input', () => { autosize(); sendButton.disabled = !textarea.value.trim(); });
      textarea.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); }
      });
      sendButton.addEventListener('click', () => void send());
      host = h('div.chat.lead-chat', transcript,
        h('div.composer-wrap', notice, h('div.composer', textarea,
          h('div.composer-bar', HINTS.map(hint => h('button.lead-chip', { on: { click: () => void send(hint) } }, hint)), h('span.hint', 'Enter 发送'), sendButton))));
      parts = { transcript, inner, notice, textarea };
      container.replaceChildren(h('div.chat-row', host));
      shown = ''; cards.clear();
      render(true);
      transcript.scrollTop = transcript.scrollHeight;
      void CF.lead.refresh();
      textarea.focus();
    },

    /** Reads 领航's state now (after the user did something). */
    async refresh() {
      try { CF.state.lead = await CF.get('lead'); } catch { return; }
      CF.app.rerender();
      CF.chat.sync();
      render();
    },

    /** Follows 领航 on the connected backend until another one is connected: the sidebar's count, and the open thread. */
    async watch() {
      const round = watching += 1;
      const backend = CF.state.backendId;
      const current = () => round === watching && backend === CF.state.backendId;
      CF.state.lead = null;
      let etag = '';
      while (current()) {
        try {
          const changes = await CF.get('lead/changes?since=' + encodeURIComponent(etag) + '&wait=' + (etag ? 20000 : 0));
          if (!current()) return;
          if (changes.unchanged) continue;
          etag = changes.etag;
          const before = CF.state.lead;
          CF.state.lead = changes;
          if (!before || before.waiting !== changes.waiting || before.enabled !== changes.enabled || before.configured !== changes.configured) { CF.app.rerender(); CF.chat.sync(); }
          render();
        } catch {
          // A backend from before 领航 has no such route; a lost connection comes back by itself.
          await new Promise(resolve => setTimeout(resolve, 15000));
        }
      }
    },
  };
})();
