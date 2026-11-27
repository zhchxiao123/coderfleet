'use strict';
// 领航: one chat between the user and every conversation it follows. Above it, the conversations
// being followed, by project; in it, what 领航 settled (one faint line each), what it hands to the
// user (said as a message) and what the user tells it.
(() => {
  const CF = window.CF;
  const { h } = CF;
  const ACTIONS = { approve: '批准', answer: '回答', reply: '回复', accept: '收下并合并', stop: '让它停下', start: '开了新对话' };
  const HINTS = ['现在都在忙什么', '你现在能自己定什么'];
  let host = null;
  let parts = null;
  let shown = '';
  // What waits for the user stays the same node across redraws: options being picked, a quote left open.
  const cards = new Map();
  const opened = new Set();
  let watching = 0;
  // The project the page is narrowed to ('' for all), and whether the list above is folded.
  let only = '';
  let folded = false;

  const view = () => CF.state.lead;
  const clip = (text, size) => text.length > size ? text.slice(0, size) + '…' : text;
  const openConversation = item => {
    const found = CF.findConversation(item.conversationId);
    if (!found) { CF.toast('这个对话已经不在了', { error: true }); return; }
    CF.app.go({ name: 'chat', conversationId: found.id, projectId: found.projectId });
  };
  const link = (text, run) => h('button.lead-link', { on: { click: event => CF.busy(event.currentTarget, run) } }, text);
  const evidence = list => list.map(item => h('dd', h('code', item.command), h('pre', item.output || '（没有输出）')));

  // Each project keeps one colour on this page, so a line is placed at a glance.
  const COLOURS = ['#3b82f6', '#a855f7', '#14b8a6', '#f97316', '#ec4899', '#84cc16', '#eab308', '#64748b'];
  const dot = projectId => {
    const ids = [...new Set(CF.state.conversations.map(item => item.projectId))].sort();
    const node = h('span.lead-pd');
    node.style.background = COLOURS[Math.max(0, ids.indexOf(projectId)) % COLOURS.length];
    return node;
  };
  const ref = (item, name) => h('button.lead-ref', { title: item.projectId, on: { click: () => openConversation(item) } }, dot(item.projectId), name);
  /** 领航's own words: a conversation it names opens on a click. */
  const words = text => {
    const node = h('div.assistant', CF.markdown(text));
    for (const span of node.querySelectorAll('[data-conv]')) {
      const found = CF.findConversation(span.dataset.conv);
      if (found) span.replaceWith(ref({ conversationId: found.id, projectId: found.projectId }, span.textContent));
    }
    return node;
  };

  const DID = {
    approve: item => ['「', item.conversation, '」要做的操作我批了：' + clip(item.asked, 80)],
    answer: item => ['「', item.conversation, '」问的我答了：' + clip(item.said, 80)],
    reply: item => ['我回了「', item.conversation, '」：' + clip(item.said, 80)],
    accept: item => ['「', item.conversation, '」我收下了，让它合并'],
    stop: item => ['我让「', item.conversation, '」停下了'],
    start: item => ['开了新对话「', item.conversation, '」：' + clip(item.said, 80) + (item.attachments?.length ? '（带了 ' + item.attachments.length + ' 个附件）' : '')],
  };
  /** What 领航 settled by itself: one faint line. */
  function note(item, parts, extra = null) {
    return h('div.lead-note' + (item.undone ? '.undone' : ''), { dataset: { project: item.projectId } }, dot(item.projectId), h('span.project', item.projectId),
      h('span.what', parts[0], h('b', parts[1]), parts[2]), extra);
  }

  function didRow(item) {
    const open = opened.has(item.id);
    const node = note(item, (DID[item.action] || (entry => ['「', entry.conversation, '」' + entry.action]))(item), [
      item.undone ? h('span.lead-tag', '已撤回') : null,
      link(open ? '收起' : '依据', () => { open ? opened.delete(item.id) : opened.add(item.id); node.replaceWith(didRow(item)); }),
      link('打开对话', () => openConversation(item)),
      item.undo ? link('撤回', async () => { await CF.api('POST', 'lead/undo/' + item.id); await CF.lead.refresh(); }) : null,
      open ? h('dl.lead-more',
        item.asked ? [h('dt', '它问'), h('dd', item.asked)] : null,
        item.evidence.length ? [h('dt', '我进项目里看了'), evidence(item.evidence)] : null,
        item.said ? [h('dt', item.action === 'start' ? '我交代的' : '我回'), h('dd', item.said)] : null,
        item.attachments?.length ? [h('dt', '一起交过去的附件'), h('dd', attachmentList(item.attachments))] : null,
        item.reason ? [h('dt', '依据'), h('dd', item.reason)] : null) : null]);
    return node;
  }

  const LEADS = { approval: '要做一个操作，等批准：', question: '问你：', finished: '停下来等你：' };
  /** Something 领航 hands to the user: said as a message, answered by a tap or by a sentence in the box below. */
  function askNode(item) {
    // Written before the answer was kept apart from the question.
    const old = item.kind === 'finished' && item.quote === undefined;
    const quote = old ? item.asked : item.quote || '';
    const body = [
      h('p', ref(item, item.conversation), ' ', (LEADS[item.kind] || '') + (old ? item.why : item.asked)),
      !old && item.why ? h('p.mine', item.why) : null,
      item.lean ? h('p.mine', item.lean) : null,
      quote ? h('details', h('summary', '它的原话'), h('div.quote', CF.markdown(quote))) : null,
      item.evidence.length ? h('details', h('summary', '我看了项目里 ' + item.evidence.length + ' 处'), h('dl.lead-more', evidence(item.evidence))) : null,
    ];
    if (item.resolved) {
      return h('div.lead-say.closed', { dataset: { project: item.projectId } }, body,
        h('p.answered', item.resolved.by === 'user' ? '你说：' + item.resolved.answer : '已经在对话里处理了'));
    }
    const kept = cards.get(item.id);
    if (kept) return kept;
    const answer = (button, input) => CF.busy(button, async () => { await CF.api('POST', 'lead/asks/' + item.id, input); await CF.lead.refresh(); });
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
      }), h('div.quick', submit)];
    } else {
      controls = h('div.quick',
        // Its own view is carried out by telling it so, like any other sentence to it.
        item.free && item.lean ? h('button.option', { on: { click: event => CF.busy(event.currentTarget, () => CF.lead.say('「' + item.conversation + '」这件按你说的办')) } }, '按你说的办') : null,
        item.options.map(option => { const button = h('button.option', { on: { click: () => answer(button, { answer: option }) } }, option); return button; }));
    }
    const node = h('div.lead-say', { dataset: { project: item.projectId } }, body, controls);
    cards.set(item.id, node);
    return node;
  }

  /** Files the user gave 领航, as in a conversation: thumbnails for images, a chip for the rest. */
  const attachmentList = paths => paths?.length ? h('div.user-images', paths.map(path => CF.isImageUpload(path) ? CF.uploadThumb(null, path) : CF.fileChip(CF.uploadName(path), CF.uploadSize(path)))) : null;

  function itemNode(item) {
    if (item.type === 'user') return h('div.user-msg', attachmentList(item.attachments), item.text ? h('div.bubble', item.text) : null);
    if (item.type === 'lead') return words(item.text);
    if (item.type === 'note') return h('div.turn-note', item.text);
    if (item.type === 'did') return didRow(item);
    if (item.type === 'seen') return note(item, ['「', item.conversation, '」做完了，我看过，没有留事情给你']);
    if (item.type === 'ask') return askNode(item);
    return null;
  }

  /** The conversations 领航 follows, by project; a project's name on the right shows only what is its. */
  function watchPanel(state) {
    const list = state.watching;
    if (!state.enabled || !list) return null;
    const projects = [...new Set(list.map(item => item.projectId))];
    if (!projects.includes(only)) only = '';
    const count = status => list.filter(item => item.status === status).length;
    const waits = projectId => state.items.filter(item => item.type === 'ask' && !item.resolved && (!projectId || item.projectId === projectId)).length;
    const pick = projectId => { only = projectId; render(true); };
    const chip = (projectId, label) => h('button.lead-filter' + (only === projectId ? '.on' : ''), { on: { click: () => pick(projectId) } },
      projectId ? dot(projectId) : null, label, waits(projectId) ? h('b', String(waits(projectId))) : null);
    const mark = item => item.status === 'running' ? h('span.spinner') : h('span.dot' + (item.status === 'waiting' ? '.waiting' : item.status === 'failed' ? '.failed' : '.running'));
    return h('div.lead-watch' + (folded ? '.folded' : ''), h('div.box',
      h('div.head',
        h('button.title', { title: folded ? '展开' : '收起', on: { click: () => { folded = !folded; render(true); } } }, '正在跟的对话'),
        h('span.sum', [count('running') ? count('running') + ' 个在跑' : '', state.waiting ? state.waiting + ' 件等你' : '没有要你管的'].filter(Boolean).join(' · ')),
        projects.length > 1 ? h('span.filters', chip('', '全部'), projects.map(projectId => chip(projectId, projectId))) : null),
      folded ? null : h('div.rows',
        projects.filter(projectId => !only || projectId === only).map(projectId => {
          const rows = list.filter(item => item.projectId === projectId);
          return [h('div.group', dot(projectId), projectId, h('small', rows.length + ' 个对话')),
            rows.map(item => h('button.item', { on: { click: () => openConversation({ conversationId: item.id }) } },
              h('span.mark', mark(item)), h('span.name', item.name), h('span.account', item.account),
              h('span.state.' + item.status, item.note), h('span.when', item.at ? CF.relative(item.at) : '')))];
        }),
        h('div.rest', list.length ? (state.rest ? '其余 ' + state.rest + ' 个对话停着，有动静我会接。' : '') : '现在没有在跑或等你的对话，有动静我会接。'))));
  }

  function rulesSheet() {
    const state = view();
    CF.sheet({ title: '领航的规矩', subtitle: '它只做决定：改代码、提交、合并都是各个对话自己动手。想改规矩，直接跟它说。' }, () =>
      h('ul.lead-rules', state.rules.map(rule => h('li', rule.text, rule.fixed ? h('em', '固定，改不了') : null))));
  }

  function renderBar() {
    const state = view();
    const followed = (state.watching ?? []).length + (state.rest ?? 0);
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
    parts.updateSend();
    const text = JSON.stringify(state);
    if (!force && text === shown) return;
    shown = text;
    const { transcript, inner, notice, textarea, watch } = parts;
    watch.replaceChildren(watchPanel(state) ?? '');
    const atEnd = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
    for (const id of cards.keys()) if (!state.items.some(item => item.id === id && !item.resolved)) cards.delete(id);
    inner.replaceChildren(
      state.items.length ? null : h('div.lead-hello', h('span.glyph', CF.icon('spark', 22)), h('h2', '领航'),
        h('p', state.enabled ? '现在没有要你定的事。哪个对话停下来等你，我先看；我定不了的，会在这里跟你说。'
          : '你同时开着好几个对话的时候，它替你盯着：能定的小事它定，拿不准的、删除推送这类要紧的，它拿来问你。它自己不改代码。')),
      ...state.items.filter(item => !only || !item.projectId || item.projectId === only).map(itemNode),
      state.draft ? words(state.draft) : null,
      state.working !== null && !state.draft ? h('div.running-status', h('span.orb'),
        h('span.shimmer', state.step ? '领航' + state.step + '…' : '领航在看' + (state.working ? '「' + state.working + '」' : '') + '…')) : null);
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
      const watch = h('div.lead-watch-host');
      const textarea = h('textarea', { rows: 1, placeholder: '直接说就行：交代一件事，或者一句话回它问你的几件事…', 'aria-label': '给领航的话' });
      const sendButton = h('button.send', { title: '发送', disabled: true }, CF.icon('send', 16));
      const hint = h('span.hint', 'Enter 发送');
      const autosize = () => { textarea.style.height = 'auto'; textarea.style.height = Math.min(textarea.scrollHeight, 240) + 'px'; };
      // Files for 领航: kept by the backend; whatever it hands to a conversation goes along with them.
      const attach = CF.attachments({ projectId: null, upload: (name, file) => CF.transport.upload(CF.state.backendId, null, name, file),
        alive: () => host?.isConnected && parts?.textarea === textarea, onChange: () => updateSend() });
      // One button, as in a conversation: with an empty box while 领航 is on a run it stops that run.
      const updateSend = () => {
        const state = view();
        const run = state?.run ?? null;
        if (sendButton.dataset.stopping && sendButton.dataset.stopping !== run) delete sendButton.dataset.stopping;
        const content = Boolean(textarea.value.trim()) || attach.count() > 0;
        const stopping = Boolean(run) && !content;
        sendButton.classList.toggle('stop', stopping);
        sendButton.replaceChildren(stopping ? h('span.stop-mark') : CF.icon('send', 16));
        sendButton.disabled = stopping ? Boolean(sendButton.dataset.stopping) : !content || attach.uploading();
        sendButton.title = stopping ? (sendButton.dataset.stopping ? '正在停止…' : '停止（Esc）') : '发送（Enter）';
        sendButton.setAttribute('aria-label', sendButton.title);
        hint.textContent = sendButton.dataset.stopping ? '正在停止…'
          : stopping ? (state.working === '你的话' ? '领航正在回复' : '领航正在处理') + ' · Esc 停止，也可以继续输入'
          : run ? '发送会排在这一轮之后' : 'Enter 发送';
      };
      // Ends the run the page shows; the button waits as 正在停止… until the backend has moved on from it.
      const stop = async () => {
        const run = view()?.run;
        if (!run || sendButton.dataset.stopping) return;
        sendButton.dataset.stopping = run;
        updateSend();
        try { await CF.api('POST', 'lead/stop', { run }); await CF.lead.refresh(); }
        catch (error) { delete sendButton.dataset.stopping; CF.fail(error); }
        finally { updateSend(); }
      };
      const attachButton = h('button.composer-icon', { title: '添加附件', 'aria-label': '添加附件', on: { click: () => CF.menu(attachButton, [
        { icon: 'clip', label: '添加附件', hint: '图片、PDF 或任意文件，也可以粘贴或拖进来', run: attach.pick },
      ], { alignStart: true }) } }, CF.icon('plus', 16));
      const send = async said => {
        const text = (said ?? textarea.value).trim();
        // A hint chip says only its words; the box sends what is typed and attached.
        const attachments = said === undefined ? attach.paths() : [];
        if ((!text && !attachments.length) || sendButton.dataset.busy || (said === undefined && attach.uploading())) return;
        sendButton.dataset.busy = '1';
        try {
          await CF.lead.say(text, attachments);
          if (said === undefined) { textarea.value = ''; autosize(); attach.clear(); }
        } catch (error) { CF.fail(error); }
        finally { delete sendButton.dataset.busy; updateSend(); }
      };
      textarea.addEventListener('input', () => { autosize(); updateSend(); });
      textarea.addEventListener('paste', attach.paste);
      textarea.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); }
        else if (event.key === 'Escape' && view()?.run && !textarea.value) { event.preventDefault(); void stop(); }
      });
      sendButton.addEventListener('click', () => void (sendButton.classList.contains('stop') ? stop() : send()));
      host = h('div.chat.lead-chat', watch, transcript,
        h('div.composer-wrap', notice, h('div.composer', { on: attach.drop }, attach.row, textarea, attach.input,
          h('div.composer-bar', attachButton, HINTS.map(hint => h('button.lead-chip', { on: { click: () => void send(hint) } }, hint)), hint, sendButton))));
      parts = { transcript, inner, notice, textarea, watch, updateSend };
      container.replaceChildren(h('div.chat-row', host));
      shown = ''; cards.clear();
      render(true);
      transcript.scrollTop = transcript.scrollHeight;
      void CF.lead.refresh();
      textarea.focus();
    },

    /** Says something to 领航 as the user, maybe with files uploaded to it. */
    async say(text, attachments = []) {
      await CF.api('POST', 'lead/messages', { text, ...(attachments.length ? { attachments } : {}) });
      await CF.lead.refresh();
      if (parts?.transcript.isConnected) parts.transcript.scrollTop = parts.transcript.scrollHeight;
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
