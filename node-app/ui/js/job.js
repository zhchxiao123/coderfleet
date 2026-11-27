'use strict';
// 做完为止: the card floating over the top-right of a conversation that works in its own
// branch — state, what changed, and the two endings (收下: it merges the branch / 丢弃).
(() => {
  const CF = window.CF;
  const { h } = CF;

  const STATES = {
    working: { label: '在做', dot: 'busy' },
    waiting: { label: '等你', dot: 'waiting' },
    review: { label: '待验收', dot: 'running' },
    accepted: { label: '已收下', dot: '' },
    discarded: { label: '已丢弃', dot: '' },
  };
  const closed = job => job.state === 'accepted' || job.state === 'discarded';
  const duration = ms => {
    const minutes = Math.max(0, Math.round(ms / 60_000));
    return minutes < 1 ? '不到 1 分钟' : minutes < 60 ? minutes + ' 分钟' : Math.floor(minutes / 60) + ' 小时 ' + (minutes % 60) + ' 分钟';
  };
  const elapsed = job => {
    const start = Date.parse(job.createdAt);
    if (job.state === 'working') return '已用 ' + duration(Date.now() - start);
    if (job.state === 'waiting') return '等了 ' + duration(Date.now() - Date.parse(job.updatedAt));
    if (job.state === 'review') return '用了 ' + duration(Date.parse(job.updatedAt) - start);
    return CF.relative(job.closedAt || job.updatedAt);
  };
  const target = job => job.baseBranch || '主目录';

  const parse = (mark, body) => {
    const [text, ...note] = body.split(/\s+(?:——|--|—)\s+/);
    return { text: text.trim(), state: !mark || mark === ' ' ? 'open' : /x/i.test(mark) ? 'done' : 'ask', note: note.join(' —— ').trim() };
  };
  const MARKS = { done: '✓', ask: '?', open: '' };
  const criterion = item => h('div.criterion.' + item.state,
    h('span.mark', { 'aria-label': item.state === 'done' ? '做到了' : item.state === 'ask' ? '要你定' : '还没做到' }, MARKS[item.state]),
    h('div', h('span', item.text), item.note ? h('small', item.note) : null));

  CF.job = {
    closed,
    /** What the top bar's button shows: the state and how much changed. */
    summary(job, changes) {
      const info = STATES[job.state] || STATES.working;
      return [info.dot ? h('span.dot.' + info.dot) : CF.icon('check', 14), job.phase === 'reviewing' ? '核对中' : job.state === 'working' && job.accepting ? '合并中' : info.label,
        changes?.files.length ? h('span.job-count', h('span.add', '+' + changes.added), ' ', h('span.del', '−' + changes.removed)) : null];
    },
    /** The sidebar dot of a conversation with a job; null for any other. */
    dot(state) {
      const info = STATES[state];
      return info?.dot ? h('span.dot.' + info.dot, { title: '做完为止 · ' + info.label }) : null;
    },
    /** In place of a user bubble: a turn the service started itself. */
    systemLine(turn) {
      if (turn.role === 'review') return h('div.job-divider', h('span', h('b', '核对'), '换 ' + turn.account + ' 的一个新会话逐条核对标准，它只读不改'));
      if (turn.role === 'accept') return h('div.job-divider', h('span', h('b', '你收下了'), '已经让它把改动合并回去；拿不准合并到哪个分支，它会先问你'));
      if (turn.role === 'review-feedback') return h('div.job-divider', h('span', h('b', '核对要改'), '意见已经交回给它'));
      return h('div.job-divider', h('span', h('b', '还没做完'), '第 ' + turn.checkRound + ' 轮：有标准没做到，已经让它接着做'));
    },
    /** The ```标准 block of a reply, shown as a checklist instead of code. */
    criteriaBlock(source) {
      const items = source.split('\n').map(line => /^\s*(?:[-*+]|\d+[.)])\s+(?:\[([ xX?？])\]\s*)?(.+)$/.exec(line)).filter(Boolean);
      return h('div.criteria-block', h('div.criteria-title', '做完的标准'), items.map(item => criterion(parse(item[1], item[2]))));
    },
    /** One line for the transcript: where the work happens, or how it ended. */
    line(job, end) {
      if (!end) {
        return h('div.job-divider', h('span', h('b', '已开工'), '在独立分支 ' + job.branch + ' 上做，不动 ' + target(job)
          + (job.dirtyAtStart ? '；主目录里没提交的改动没有带进去' : '')));
      }
      if (job.state === 'accepted') return h('div.job-divider', h('span', h('b', '已收下'), (job.mergedInto ? '合并进了 ' + job.mergedInto : '没有要合并的改动') + '，分支和工作目录已删除；对话可以接着聊'));
      if (job.state === 'discarded') return h('div.job-divider', h('span', h('b', '已丢弃'), '分支和工作目录已删除；对话可以接着聊'));
      return null;
    },

    /**
     * Mounts the card in `host` (the chat column). `hooks.changed(job)` runs when the job's
     * state changes; `hooks.summary(job, changes, open)` on every render, for the top bar's
     * button; `hooks.say(text)` sends a message in the conversation.
     */
    mount(host, conversationId, hooks) {
      const node = h('aside.job-card', { hidden: true, 'aria-label': '这件事的进度' });
      host.append(node);
      let job = null;
      let earlier = [];
      let changes = null;
      let changesAt = 0;
      let showFiles = false;
      let hidden = false;
      let signature = '';
      let busy = false;
      let alive = true;
      try { hidden = localStorage.getItem('cf.jobCardHidden') === '1'; } catch { /* storage unavailable */ }

      const act = async (action, button) => {
        if (action === 'discard' && !await CF.confirm('丢弃这次的改动？', '分支 ' + job.branch + ' 和它的工作目录会被删除，不能恢复。对话会保留。', { danger: true, label: '丢弃' })) return;
        busy = true;
        try {
          await CF.busy(button, () => CF.api('POST', 'conversations/' + conversationId + '/job/' + action));
        } catch { /* CF.busy has shown the error; the card shows why below */ }
        busy = false;
        changesAt = 0;
        await controller.refresh();
        void CF.app.refreshConversations();
      };

      // The card never sits on the conversation: it stays open only where the margin right of
      // the transcript has room for it. Otherwise it is folded into the 进度 button of the top
      // bar and opens from there for a look, closing again on a click anywhere else.
      let peek = false;
      const fits = () => {
        const column = host.querySelector('.transcript-inner, .welcome-chat .hero');
        if (!column?.isConnected) return true;
        const style = getComputedStyle(column);
        const edge = column.getBoundingClientRect().right - parseFloat(style.paddingRight || '0');
        return host.getBoundingClientRect().right - edge >= 292 + 22;
      };
      const shown = () => Boolean(job) && (fits() ? !hidden : peek);
      const outside = event => {
        if (!node.isConnected) { document.removeEventListener('mousedown', outside); window.removeEventListener('resize', resized); return; }
        if (!peek || node.contains(event.target) || event.target.closest?.('.job-button, dialog, .menu')) return;
        peek = false;
        render();
      };
      const resized = () => { peek = false; render(); };
      document.addEventListener('mousedown', outside);
      window.addEventListener('resize', resized);
      const render = () => {
        node.hidden = !shown();
        hooks.summary(job, changes, !node.hidden);
        if (!job) return;
        const info = STATES[job.state] || STATES.working;
        const count = changes ? changes.files.length : 0;
        const next = JSON.stringify([job, changes, showFiles, hidden, elapsed(job)]);
        if (next === signature || busy) return;
        signature = next;
        const accept = h('button.btn.primary.small', { on: { click: event => act('accept', event.currentTarget) } }, '收下');
        const discard = h('button.btn.small.danger-text', { on: { click: event => act('discard', event.currentTarget) } }, '丢弃');
        const files = changes && showFiles ? h('div.job-files',
          changes.files.slice(0, 40).map(file => h('div.job-file', { title: file.path },
            h('span.path' + (file.status === 'deleted' ? '.gone' : ''), file.path),
            file.status === 'added' ? h('span.tag', '新') : file.status === 'deleted' ? h('span.tag', '删') : null,
            h('span.add', '+' + file.added), h('span.del', '−' + file.removed))),
          changes.files.length > 40 ? h('div.job-more', '还有 ' + (changes.files.length - 40) + ' 个文件') : null) : null;
        const items = job.criteria || [];
        const met = items.filter(item => item.state === 'done').length;
        const criteriaNode = items.length
          ? h('div.job-criteria', h('div.job-label', '做完的标准', h('span.v', met + ' / ' + items.length)), items.map(criterion))
          : closed(job) ? null : h('div.job-criteria', h('div.job-label', '做完的标准'), h('div.job-hint', job.state === 'working' ? '它正在定…' : '它没有列出来'));
        const review = job.review;
        const VERDICTS = { pass: h('span.add', '通过'), changes: h('span.del', '要改'), unclear: '没给出结论', failed: '没跑成' };
        const reviewRow = job.phase === 'reviewing' || review ? h('div.job-row.static', { title: review?.error || '' },
          CF.icon('eye', 14), '核对', h('span.v', job.phase === 'reviewing' ? [h('span.spinner'), '逐条核对中…'] : VERDICTS[review.verdict] || review.verdict)) : null;
        node.replaceChildren(...[
          h('div.job-head',
            h('span.job-state', info.dot ? h('span.dot.' + info.dot) : null, job.state === 'working' && job.accepting ? '合并中' : info.label),
            h('code', { title: '分支 ' + job.branch }, job.branch),
            h('span.job-time', elapsed(job)),
            h('button.icon-btn.job-close', { title: '收起', on: { click: () => controller.toggle(false) } }, CF.icon('x', 12))),
          CF.findConversation(conversationId)?.schedule ? h('div.job-hint.job-origin', CF.icon('clock', 12), '定时开的：' + CF.findConversation(conversationId).schedule) : null,
          job.state === 'waiting' ? h('div.job-ask',
            h('strong', job.reason === 'stopped' ? '你把它停下了' : job.reason === 'question' ? '有事要你来定' : job.reason === 'checks' ? '改了 ' + (job.round || 3) + ' 轮，还有标准没做到' : job.reason === 'review' ? '改了 ' + (job.round || 3) + ' 轮，核对还是认为要改' : job.reason === 'merge' ? '收下了，还没有合并' : '这一轮出错了'),
            job.error ? h('p', job.error) : null,
            job.reason === 'merge' && job.mergeError ? h('p', job.mergeError) : null,
            h('span', job.reason === 'merge' ? '它在对话里说了原因。回它一句（比如合并到哪个分支），它就接着合并。' : job.reason === 'question' ? '看下面标 ? 的那条，在对话里回它一句，它就接着做。' : job.reason === 'checks' ? '告诉它该怎么办，或者改一下标准；也可以照现在的样子收下。' : job.reason === 'review' ? '核对意见在对话里。告诉它该怎么办；也可以照现在的样子收下。' : '在下面回一句话，它就接着做。')) : null,
          criteriaNode,
          h('button.job-row', { disabled: !count, 'aria-expanded': String(showFiles), on: { click: () => { showFiles = !showFiles; render(); } } },
            CF.icon('file', 14), closed(job) ? (job.state === 'accepted' ? '合并的变更' : '变更') : '变更',
            h('span.v', !changes ? '…' : !count ? '还没有改动' : [count + ' 个文件 ', h('span.add', '+' + changes.added), ' ', h('span.del', '−' + changes.removed)]),
            count ? h('span.chev', CF.icon('chevron', 11)) : null),
          files,
          reviewRow,
          job.state === 'review' ? [h('div.job-hint', '想再改或加标准，直接在下面说。收下后由它把改动合并回去，拿不准合并到哪会先问你。'), h('div.job-actions', accept, discard)] : null,
          job.state === 'waiting' ? h('div.job-actions', count && job.reason !== 'merge' ? accept : null, discard) : null,
        ].flat().filter(Boolean));
      };

      const controller = {
        get job() { return job; },
        /** The closed jobs this conversation had before the current one, oldest first. */
        get earlier() { return earlier; },
        toggle(show = !shown()) {
          if (fits()) {
            hidden = !show;
            try { localStorage.setItem('cf.jobCardHidden', hidden ? '1' : ''); } catch { /* storage unavailable */ }
          } else peek = show;
          render();
        },
        async refresh() {
          if (!alive || busy) return;
          let next;
          try {
            const found = await CF.get('conversations/' + conversationId + '/job');
            next = found.job;
            earlier = found.earlier || [];
          } catch { return; }
          if (!alive) return;
          // A closed job can be followed by a new one in the same conversation.
          const before = job && job.id + ' ' + job.state;
          const now = next && next.id + ' ' + next.state;
          if (job && next && job.id !== next.id) { changes = null; showFiles = false; }
          job = next;
          if (job && (!changes || before !== now || (job.state === 'working' && Date.now() - changesAt > 3000))) {
            changesAt = Date.now();
            try { changes = await CF.get('conversations/' + conversationId + '/job/changes'); } catch { /* the container may be stopped: keep the last */ }
            if (!alive) return;
          }
          render();
          if (before !== now) hooks.changed(job);
        },
        destroy() { alive = false; node.remove(); },
      };
      return controller;
    },
  };
})();
