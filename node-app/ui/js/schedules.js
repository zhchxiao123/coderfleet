'use strict';
// 定时 page: things the backend starts by itself at set times, each run in a new conversation.
(() => {
  const CF = window.CF;
  const { h } = CF;
  const WEEKDAYS = [[1, '一'], [2, '二'], [3, '三'], [4, '四'], [5, '五'], [6, '六'], [0, '日']];
  const EXAMPLES = [
    { text: '每天早上看看昨天的提交有没有问题', rule: { kind: 'daily', time: '09:00' }, job: false },
    { text: '每周一升级依赖，测试都过了再交给我', rule: { kind: 'weekly', days: [1], time: '10:00' }, job: true },
    { text: '每隔 6 小时跑一遍测试，失败了告诉我原因', rule: { kind: 'every', hours: 6 }, job: false },
  ];
  let items = null;
  let host = null;
  let seen = '';

  const two = value => String(value).padStart(2, '0');
  /** A time on the backend's clock: 今天 09:00 · 明天 09:00 · 周三 03:00 · 12-01 09:00. */
  const when = iso => {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return '';
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const days = Math.floor((new Date(date.getFullYear(), date.getMonth(), date.getDate()) - start) / 86_400_000);
    const time = two(date.getHours()) + ':' + two(date.getMinutes());
    if (days === 0) return '今天 ' + time;
    if (days === 1) return '明天 ' + time;
    if (days === -1) return '昨天 ' + time;
    if (days > 1 && days < 7) return '周' + '日一二三四五六'[date.getDay()] + ' ' + time;
    return two(date.getMonth() + 1) + '-' + two(date.getDate()) + ' ' + time;
  };
  const projectName = id => CF.state.projects.find(project => project.id === id)?.name || id;
  const open = run => CF.app.go({ name: 'chat', conversationId: run.conversationId, projectId: CF.findConversation(run.conversationId)?.projectId });

  /** What became of a run: its words, a tone (bad / warn) and a dot. */
  const outcome = run => {
    if (run.result === 'skipped') return { text: '跳过了：上次还在做', tone: 'warn' };
    if (run.result === 'missed') return { text: '错过了，没有补', tone: 'warn' };
    if (run.result === 'starting') return { text: '正在开始…', dot: 'busy' };
    if (run.result === 'failed') return { text: '没开始：' + (run.note || '出错了'), tone: 'bad', dot: 'failed' };
    if (run.gone) return { text: '对话已删除' };
    if (run.job) {
      const label = { working: '在做', waiting: '等你', review: '待验收', accepted: '已收下', discarded: '已丢弃' }[run.job] || run.job;
      return { text: label, link: true, dot: { working: 'busy', waiting: 'waiting', review: 'running' }[run.job] || '', tone: run.job === 'waiting' ? 'warn' : '' };
    }
    if (run.status === 'done') return { text: '做完了', link: true, dot: 'running' };
    if (run.status === 'failed') return { text: '失败了', link: true, tone: 'bad', dot: 'failed' };
    if (run.status === 'cancelled') return { text: '被停下了', link: true };
    return { text: '在做', link: true, dot: 'busy' };
  };
  const runLine = run => {
    const info = outcome(run);
    return [
      h('span.dot' + (info.dot ? '.' + info.dot : '')),
      h('span.run-time', { title: CF.fullTime(run.at) }, when(run.at) + (run.manual ? ' · 手动' : '')),
      info.link
        ? h('button.run-link' + (info.tone ? '.' + info.tone : ''), { title: run.name || '', on: { click: event => { event.stopPropagation(); open(run); } } }, info.text)
        : h('span.run-text' + (info.tone ? '.' + info.tone : ''), { title: info.text }, info.text),
    ];
  };

  async function history(item) {
    let detail;
    try { detail = await CF.get('schedules/' + item.id); } catch (error) { CF.fail(error); return; }
    const sheet = CF.sheet({ title: '历次运行', subtitle: detail.label + ' · ' + projectName(detail.projectId) }, () => detail.runs.length
      ? h('div.run-list', detail.runs.map(run => {
        const row = h('div.run-row', runLine(run), run.name ? h('span.run-name', run.name) : null);
        row.querySelector('.run-link')?.addEventListener('click', () => sheet.close());
        return row;
      }))
      : h('div.sidebar-empty', '还没有跑过。'));
  }

  /** New (item absent, `preset` an example) or edit. */
  function edit(item, preset) {
    const source = item || preset || {};
    const projects = CF.pins.sort(CF.state.projects.filter(project => project.chat && project.active));
    if (!projects.length) { CF.toast('先新建一个能对话的项目', { action: { label: '去新建', run: () => CF.app.go({ name: 'projects' }) } }); return; }
    const rule = source.rule || { kind: 'daily', time: '09:00' };
    let kind = rule.kind;
    const days = new Set(rule.days || [1]);
    const project = h('select', projects.map(entry => h('option', { value: entry.id, selected: entry.id === (source.projectId || CF.state.lastChat?.projectId) }, entry.name + ' · ' + entry.typeLabel)));
    const prompt = h('textarea', { rows: 4, placeholder: '例如：看看昨天的提交有没有问题，有就列出来', value: source.prompt || source.text || '' });
    const time = h('input', { type: 'time', value: rule.time || '09:00', required: true });
    const hours = h('input', { type: 'number', min: 1, max: 168, step: 1, value: String(rule.hours || 6) });
    const job = h('input', { type: 'checkbox', checked: Boolean(source.job) });
    const jobHint = h('span.hint');
    const next = h('span.sheet-next');
    const dayChips = h('div.days', WEEKDAYS.map(([day, name]) => h('button' + (days.has(day) ? '.on' : ''), {
      type: 'button', 'aria-pressed': String(days.has(day)), title: '周' + name,
      on: { click: event => {
        if (days.has(day)) days.delete(day); else days.add(day);
        event.currentTarget.classList.toggle('on', days.has(day));
        event.currentTarget.setAttribute('aria-pressed', String(days.has(day)));
        preview();
      } },
    }, name)));
    const kinds = h('div.segmented', [['daily', '每天'], ['weekly', '每周'], ['every', '每隔几小时']].map(([value, label]) =>
      h('button', { type: 'button', dataset: { kind: value }, on: { click: () => { kind = value; layout(); preview(); } } }, label)));
    const timeField = h('label.field', h('span', '几点'), time);
    const dayField = h('div.field', h('span', '星期几'), dayChips);
    const hoursField = h('label.field', h('span', '每隔', h('span.hint', ' 小时，从保存时算起')), hours);
    const layout = () => {
      for (const button of kinds.children) button.classList.toggle('on', button.dataset.kind === kind);
      timeField.hidden = kind === 'every';
      dayField.hidden = kind !== 'weekly';
      hoursField.hidden = kind !== 'every';
    };
    const current = () => kind === 'daily' ? { kind, time: time.value } : kind === 'weekly' ? { kind, days: [...days], time: time.value } : { kind, hours: Number(hours.value) };
    // The backend says how the rule reads and when it next falls: one place knows the rules.
    let asked = 0;
    const preview = async () => {
      const mine = ++asked;
      let text;
      try { const result = await CF.api('POST', 'schedules/preview', { rule: current() }); text = result.label + '，下次：' + when(result.nextAt); }
      catch (error) { text = CF.errorText(error); }
      if (mine === asked) next.textContent = text;
    };
    const support = () => {
      jobHint.textContent = '';
      CF.get('projects/' + encodeURIComponent(project.value) + '/job-support').then(result => {
        job.disabled = !result.supported;
        if (!result.supported) job.checked = false;
        jobHint.textContent = result.supported ? '' : ' 这个项目用不了：' + result.reason;
      }).catch(() => undefined);
    };
    project.addEventListener('change', support);
    time.addEventListener('input', preview);
    hours.addEventListener('input', preview);
    const sheet = CF.sheet({ title: item ? '编辑定时' : '新建定时', subtitle: '到点自己开一个新对话去做，不用你在场。' }, () => [
      h('label.field', h('span', '项目'), project),
      h('label.field', h('span', '要做的事'), prompt),
      h('div.field', h('span', '什么时候'), kinds),
      dayField, timeField, hoursField,
      h('label.check', job, h('span', '做完为止', h('span.hint', ' 每次在自己的分支上做到标准都达成，再等你收下'), jobHint)),
      h('p.sheet-note', '时间按后端那台电脑的时钟。不勾「做完为止」时，它用工具不会停下来问你。'),
    ]);
    layout(); support(); void preview();
    const save = h('button.btn.primary', { on: { click: () => CF.busy(save, async () => {
      sheet.error('');
      const body = { projectId: project.value, prompt: prompt.value.trim(), rule: current(), job: job.checked };
      // An unchanged rule is not sent: sending it would count the next time from now again.
      if (item && JSON.stringify(item.rule) === JSON.stringify(body.rule)) delete body.rule;
      try {
        await (item ? CF.api('PUT', 'schedules/' + item.id, body) : CF.api('POST', 'schedules', body));
        sheet.close();
        await CF.schedules.refresh(true);
      } catch (error) { sheet.error(error); }
    }) } }, item ? '保存' : '创建');
    sheet.foot(next, h('button.btn', { on: { click: () => sheet.close() } }, '取消'), save);
    if (!item && !preset) prompt.focus();
  }

  function row(item) {
    const toggle = h('button.switch' + (item.enabled ? '.on' : ''), {
      role: 'switch', 'aria-checked': String(item.enabled), title: item.enabled ? '关掉' : '打开',
      on: { click: () => CF.busy(toggle, async () => {
        await CF.api('PUT', 'schedules/' + item.id, { enabled: !item.enabled });
        await CF.schedules.refresh(true);
      }) },
    }, h('span.knob'));
    const more = h('button.icon-btn', { title: '更多', 'aria-label': '更多操作', on: { click: () => CF.menu(more, [
      { label: '立即跑一次', icon: 'play', run: async () => {
        if (item.busy) { CF.toast('上一次还在做，等它结束再跑'); return; }
        CF.toast('正在开始…');
        try {
          const result = await CF.api('POST', 'schedules/' + item.id + '/run', {});
          await CF.app.refreshConversations();
          CF.app.go({ name: 'chat', conversationId: result.conversationId, projectId: item.projectId });
        } catch (error) { CF.fail(error); void CF.schedules.refresh(true); }
      } },
      { label: '编辑', icon: 'edit', run: () => edit(item) },
      { label: '历次运行', icon: 'clock', run: () => void history(item) },
      '-',
      { label: '删除', icon: 'trash', danger: true, run: async () => {
        if (!await CF.confirm('删除这个定时？', '以后不再自动开始。它已经开过的对话都会保留。', { danger: true, label: '删除' })) return;
        try { await CF.api('DELETE', 'schedules/' + item.id); } catch (error) { CF.fail(error); }
        await CF.schedules.refresh(true);
      } },
    ]) } }, CF.icon('more', 16));
    return h('div.schedule-row' + (item.enabled ? '' : '.off'),
      h('div.what', h('strong', { title: item.prompt }, item.prompt),
        h('small', projectName(item.projectId), item.job ? h('span.tag', '做完为止') : null)),
      h('div.when', h('strong', item.label), h('small', item.enabled ? '下次 ' + when(item.nextAt) : '已关')),
      h('div.last', item.last ? runLine(item.last) : h('span.run-text', '还没有跑过')),
      toggle, more);
  }

  function render() {
    if (!host?.isConnected) return;
    const create = h('button.btn.primary', { on: { click: () => edit() } }, CF.icon('plus', 14), '新建定时');
    const body = items === null ? h('div.empty', h('div.spinner', { style: 'margin:0 auto;width:20px;height:20px' }))
      : items.length ? [
        h('div.card.schedule-list',
          h('div.schedule-row.schedule-head', h('span', '要做的事'), h('span', '什么时候'), h('span', '最近一次'), h('span'), h('span')),
          items.map(row)),
        h('p.schedule-note', '后端没开着的时候到点不会跑；回来以后只补最近的一次，晚了超过一天就不补。上一次还没做完时，这一次会跳过。'),
      ]
        : h('div.card', h('div.empty',
          h('div.glyph', CF.icon('clock', 22)),
          h('h3', '还没有定时'),
          h('p', '把每天、每周都要做的事交给它：到点自己开一个新对话去做，做完你再来看。'),
          h('div.schedule-examples', EXAMPLES.map(example => h('button.btn.small', { on: { click: () => edit(null, example) } }, example.text))),
          h('div', { style: 'margin-top:18px' }, h('button.btn.primary', { on: { click: () => edit() } }, CF.icon('plus', 14), '新建定时'))));
    host.replaceChildren(h('div.page-inner',
      h('div.page-head', h('div', h('h1', '定时'), h('p', '到点自己开一个新对话去做。每次运行都在左边的对话列表里。')), items?.length ? create : null),
      body));
  }

  CF.schedules = {
    mount(container) {
      host = h('div.page');
      container.append(host);
      items = null; seen = '';
      render();
      void CF.schedules.refresh(true);
    },
    /** Reloads the list; redraws only when something changed, or when `force`d. */
    async refresh(force = false) {
      if (!host?.isConnected) return;
      let list;
      try { list = await CF.get('schedules'); } catch (error) { if (force) CF.fail(error); return; }
      const text = JSON.stringify(list);
      if (!force && text === seen) return;
      // An open ⋯ menu belongs to a row that a redraw would replace.
      if (!force && document.querySelector('.menu')) return;
      seen = text;
      items = list;
      render();
    },
  };
})();
