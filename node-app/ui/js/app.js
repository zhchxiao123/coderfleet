'use strict';
// App shell: backend connection, sidebar, routing and periodic refresh.
(() => {
  const CF = window.CF;
  const { h } = CF;
  const sidebar = document.getElementById('sidebar');
  const main = document.getElementById('main');
  const expanded = new Set();
  if (CF.transport?.platform) document.body.classList.add('platform-' + CF.transport.platform);

  const remember = view => {
    try { localStorage.setItem('cf.view', JSON.stringify(view)); } catch { /* storage unavailable */ }
  };
  const restore = () => {
    try { return JSON.parse(localStorage.getItem('cf.view') || 'null'); } catch { return null; }
  };

  CF.app = {
    /** Leaves the settings screen for the conversation that was open before. */
    closeSettings() {
      const last = CF.state.lastChat;
      if (last && (!last.conversationId || CF.state.conversations.some(item => item.id === last.conversationId))) CF.app.go(last);
      else { const target = CF.chat.defaultProject(); if (target) CF.app.go({ name: 'chat', projectId: target.id }); }
    },
    /** Redraws the sidebar and the current page (after a local change such as a pin). */
    rerender() { renderSidebar(); if (['projects'].includes(CF.state.view.name)) renderMain(); },
    isLocal: () => CF.state.profiles.find(item => item.id === CF.state.backendId)?.kind === 'local',

    go(view) {
      if (CF.state.view.name === 'chat' && view.name !== 'chat') CF.chat.stop();
      CF.state.view = view;
      remember(view);
      renderSidebar();
      renderMain();
    },

    renderCurrent() {
      renderSidebar();
      if (['projects', 'accounts'].includes(CF.state.view.name)) renderMain();
      else if (CF.state.view.name === 'chat') CF.chat.sync();
    },

    async refreshProjects() {
      try { CF.state.projects = await CF.get('projects'); } catch (error) { return connectionLost(error); }
      CF.app.renderCurrent();
    },
    async refreshAccounts() {
      try { CF.state.accounts = await CF.get('accounts'); } catch (error) { return connectionLost(error); }
      CF.app.renderCurrent();
    },
    /** Archived conversations, for the sidebar's 已归档 section. */
    async refreshArchived() {
      try { CF.state.archived = await CF.get('conversations?archived=1'); } catch { return; }
      renderSidebar();
    },
    async refreshConversations() {
      void CF.app.refreshArchived();
      try { CF.state.conversations = await CF.get('conversations'); } catch (error) { return connectionLost(error); }
      renderSidebar();
      CF.chat.sync();
    },
    async refreshOverview() {
      try { CF.state.overview = await CF.get('overview'); } catch (error) { return connectionLost(error); }
      if (['projects', 'settings'].includes(CF.state.view.name)) renderMain();
    },

    async loadProfiles(preferred) {
      CF.state.profiles = await CF.transport.list();
      const saved = preferred || localStorage.getItem('cf.backend') || '';
      const chosen = CF.state.profiles.find(item => item.id === saved) || CF.state.profiles[0];
      if (!chosen) { CF.state.backendId = ''; return showWelcome(); }
      await connect(chosen.id);
    },
  };

  function connectionLost(error) {
    if (!CF.state.connected) return;
    CF.state.connected = false;
    CF.fail(error);
    renderSidebar();
  }

  async function connect(id) {
    CF.chat.stop();
    CF.state.backendId = id;
    CF.state.connected = false;
    localStorage.setItem('cf.backend', id);
    sidebar.hidden = false;
    document.getElementById('app').classList.remove('no-sidebar');
    renderSidebar();
    main.replaceChildren(h('div.welcome', h('div.welcome-card', h('div.spinner', { style: 'margin:0 auto 14px;width:20px;height:20px' }), h('p', '正在连接后端…'))));
    try {
      await CF.transport.connect(id);
      const [overview, projects, accounts, conversations] = await Promise.all(['overview', 'projects', 'accounts', 'conversations'].map(path => CF.get(path)));
      Object.assign(CF.state, { overview, projects, accounts, conversations, connected: true });
      CF.activity.refresh();
    } catch (error) {
      const profile = CF.state.profiles.find(item => item.id === id);
      const [summary, ...details] = CF.errorText(error).split('\n\n');
      const retry = h('button.btn.primary', { on: { click: () => connect(id) } }, '重试');
      const restart = profile?.kind === 'local' && CF.transport.restartLocal ? h('button.btn', { on: { click: () => CF.busy(restart, async () => {
        await CF.transport.restartLocal(id);
        await connect(id);
      }) } }, CF.icon('restart', 14), '重启本机后端') : null;
      main.replaceChildren(h('div.welcome', h('div.welcome-card',
        h('div.brand-mark', { style: 'background:var(--amber-soft);color:var(--amber)' }, '!'),
        h('h1', '连不上「' + (profile?.name || '后端') + '」'),
        h('p', summary),
        details.length ? h('pre.log', { style: 'height:auto;max-height:180px;text-align:left;margin:-10px 0 20px' }, details.join('\n\n')) : null,
        h('div.welcome-actions', retry, restart,
          h('button.btn.ghost', { on: { click: () => CF.app.go({ name: 'settings' }) } }, '管理连接')),
        profile?.kind === 'local' ? h('p', { style: 'margin:16px 0 0;font-size:12px;color:var(--text-3)' }, '本机后端的日志在 App 数据目录的 backend.log。') : null)));
      renderSidebar();
      return;
    }
    const saved = restore();
    const valid = saved && (saved.name !== 'chat'
      || CF.state.conversations.some(item => item.id === saved.conversationId)
      || (!saved.conversationId && CF.state.projects.some(item => item.id === saved.projectId && item.chat)));
    let view = valid ? saved : null;
    if (!view) {
      const latest = CF.state.conversations[0];
      view = latest ? { name: 'chat', conversationId: latest.id, projectId: latest.projectId }
        : { name: CF.state.overview.initialized && CF.state.accounts.length ? 'projects' : CF.state.accounts.length ? 'projects' : 'accounts' };
      if (!CF.state.overview.initialized) view = { name: 'projects' };
    }
    CF.app.go(view);
  }

  function showWelcome() {
    sidebar.hidden = true;
    document.getElementById('app').classList.add('no-sidebar');
    const remote = h('div.welcome-remote', { hidden: true });
    const name = h('input', { placeholder: '名称，例如 Linux 工作机' });
    const url = h('input', { type: 'url', placeholder: 'https:// 或 http://127.0.0.1:端口' });
    const token = h('input', { type: 'password', placeholder: '服务令牌', autocomplete: 'off' });
    const save = h('button.btn.primary', { on: { click: () => CF.busy(save, async () => {
      const id = await CF.transport.addRemote({ name: name.value, url: url.value, token: token.value });
      await CF.app.loadProfiles(id);
    }) } }, '连接');
    remote.append(h('label.field', h('span', '名称'), name), h('label.field', h('span', '地址'), url), h('label.field', h('span', '令牌'), token), save);
    const local = h('button.btn.primary', { on: { click: () => CF.busy(local, async () => {
      const id = await CF.transport.setupLocal();
      await CF.app.loadProfiles(id);
    }) } }, '使用这台电脑');
    main.replaceChildren(h('div.welcome', h('div.welcome-card',
      CF.brandMark(),
      h('h1', '欢迎使用 CoderFleet'),
      h('p', '把多个 AI 编程账号放进各自的容器里，一起用它们的额度。'),
      h('div.welcome-actions', local,
        h('button.btn', { on: { click: async () => {
          const result = await CF.addSshBackend();
          if (result?.id) await CF.app.loadProfiles(result.id);
        } } }, CF.icon('terminal', 15), '通过 SSH 连接远程机器'),
        h('button.btn.ghost.small', { on: { click: () => { remote.hidden = !remote.hidden; } } }, '使用服务地址和令牌')),
      remote)));
  }

  let filter = '';
  const collapsed = new Set();
  const search = h('input', { placeholder: '搜索对话…', spellcheck: false, 'aria-label': '搜索对话', on: { input: () => { filter = search.value.trim().toLowerCase(); renderConversations(); } } });
  const conversationsHost = h('div');
  // Background operations (image builds, container starts): a progress row above the backend row.
  const activityHost = h('div.activity-host');
  const renderActivity = () => {
    const running = CF.activity.running();
    if (!running.length) { activityHost.replaceChildren(); return; }
    const first = running[0];
    const percent = first.step ? Math.round(first.step.current / first.step.total * 100) : null;
    const row = h('button.activity-row', {
      title: running.map(item => CF.operationLabel(item) + ' · ' + CF.operationProgress(item)).join('\n'),
      on: { click: () => {
        if (running.length === 1) { CF.operationLog(first, CF.operationLabel(first)); return; }
        CF.menu(row, running.map(item => ({ label: CF.operationLabel(item), hint: CF.operationProgress(item) + (item.lastLine ? ' · ' + item.lastLine : ''), icon: 'box',
          run: () => CF.operationLog(item, CF.operationLabel(item)) })), { matchWidth: true });
      } },
    }, h('span.spinner'),
      h('span.activity-text', h('strong', running.length > 1 ? running.length + ' 个后台任务' : CF.operationLabel(first)),
        h('small', running.length > 1 ? running.map(CF.operationLabel).join('、') : CF.operationProgress(first) + (first.lastLine ? ' · ' + first.lastLine : ''))),
      percent === null ? null : h('span.activity-bar', h('span', { style: 'width:' + percent + '%' })));
    activityHost.replaceChildren(row);
  };
  CF.activity.subscribe(renderActivity);
  // The sidebar can be hidden (⌘\ / Ctrl+\), remembered across launches.
  const appNode = document.getElementById('app');
  const setSidebar = open => {
    appNode.classList.toggle('sidebar-hidden', !open);
    try { localStorage.setItem('cf.sidebarHidden', open ? '' : '1'); } catch { /* storage unavailable */ }
  };
  const sidebarOpen = () => !appNode.classList.contains('sidebar-hidden');
  try { if (localStorage.getItem('cf.sidebarHidden') === '1') appNode.classList.add('sidebar-hidden'); } catch { /* storage unavailable */ }
  // Shown at the top left while the sidebar is hidden: reopen it, or start a new chat.
  const reveal = h('div.sidebar-reveal',
    h('button.icon-btn', { title: '显示侧边栏（' + (CF.transport?.platform === 'darwin' ? '⌘' : 'Ctrl+') + '\\）', on: { click: () => setSidebar(true) } }, CF.icon('sidebar', 16)),
    h('button.icon-btn', { title: '新对话', on: { click: () => sidebar.querySelector('.new-chat')?.click() } }, CF.icon('compose', 16)));
  appNode.append(reveal);
  CF.app.toggleSidebar = () => setSidebar(!sidebarOpen());
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (!sidebarOpen()) setSidebar(true);
      search.focus(); search.select();
    }
    if ((event.metaKey || event.ctrlKey) && event.key === '\\') { event.preventDefault(); CF.app.toggleSidebar(); }
    if ((event.metaKey || event.ctrlKey) && event.key === ',') { event.preventDefault(); CF.app.go({ name: 'settings' }); }
    if (event.key === 'Escape' && CF.state.view.name !== 'chat' && !document.querySelector('dialog[open], .menu')
      && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) CF.app.closeSettings();
  });

  function conversationMeta(item) {
    if (item.attention) return h('span.dot.waiting', { title: '等你确认' });
    if (item.status === 'queued') return h('span.dot', { title: '在原服务里排队' });
    if (['starting', 'running'].includes(item.status)) return h('span.dot.busy', { title: '进行中' });
    if (item.status === 'failed') return h('span.dot.failed', { title: '失败' });
    return h('span.meta', { title: CF.fullTime(item.updatedAt) }, CF.shortTime(item.updatedAt));
  }

  const DAY = 86_400_000;
  /** Projects the user opened or folded by hand (the defaults depend on pinning and age). */
  const opened = new Set();

  function conversationButton(item, extra = '', sub = null) {
    const { view } = CF.state;
    // ⋯ on hover (and right-click): rename, archive, delete.
    const more = h('span.conv-actions', { role: 'button', tabIndex: 0, title: '更多', 'aria-label': '对话操作',
      on: { click: event => { event.stopPropagation(); CF.menu(more, CF.conversationMenu(item)); } } }, CF.icon('more', 14));
    const node = h('button.conv-item' + extra + (view.name === 'chat' && view.conversationId === item.id ? '.selected' : ''), {
      title: item.name + ' · ' + CF.fullTime(item.updatedAt), on: {
        click: () => CF.app.go({ name: 'chat', conversationId: item.id, projectId: item.projectId }),
        contextmenu: event => { event.preventDefault(); CF.menu(node, CF.conversationMenu(item)); },
      },
    }, sub ? h('span.lines', h('span.title', item.name), h('span.sub', sub)) : h('span.title', item.name), conversationMeta(item), more);
    return node;
  }

  /**
   * The sidebar (A+B): 进行中 and 最近 (today and yesterday, at most 5) follow
   * time; below, projects: pinned ones open, ones used in the last 30 days one
   * row each (open on click), older ones folded into 更早的项目. Search shows all.
   */
  function renderConversations() {
    const { view, projects, conversations, connected } = CF.state;
    const chatProjects = CF.pins.sort(projects.filter(item => item.chat && item.active));
    const visible = conversations.filter(item => chatProjects.some(project => project.id === item.projectId));
    const projectName = id => projects.find(project => project.id === id)?.name || id;
    const lastUsed = new Map();
    for (const item of visible) {
      const time = Date.parse(item.updatedAt) || 0;
      if (time > (lastUsed.get(item.projectId) ?? 0)) lastUsed.set(item.projectId, time);
    }
    const selectedProject = view.name === 'chat' ? view.projectId : '';

    const group = (project, kind) => {
      const all = conversations.filter(item => item.projectId === project.id);
      const items = filter ? all.filter(item => item.name.toLowerCase().includes(filter)) : all;
      if (filter && !items.length) return null;
      const pinned = CF.pins.has(project.id);
      const openByDefault = pinned || project.id === selectedProject;
      const folded = !filter && (collapsed.has(project.id) || (!openByDefault && !opened.has(project.id)));
      const showAll = expanded.has(project.id) || Boolean(filter);
      const shown = showAll ? items : items.slice(0, 6);
      const add = h('button.icon-btn.add', { title: '在 ' + project.name + ' 新建对话', on: { click: event => { event.stopPropagation(); CF.app.go({ name: 'chat', projectId: project.id }); } } }, CF.icon('plus', 14));
      const menuItems = () => [
        { label: pinned ? '取消置顶' : '置顶项目', icon: 'pin', run: () => CF.togglePin(project.id) },
        { label: '新对话', icon: 'compose', run: () => CF.app.go({ name: 'chat', projectId: project.id }) },
        { label: '查看项目', icon: 'folder', run: () => CF.app.go({ name: 'projects' }) },
      ];
      const more = h('button.icon-btn.add.group-more', { title: '更多', on: { click: event => { event.stopPropagation(); CF.menu(more, menuItems()); } } }, CF.icon('more', 14));
      const used = lastUsed.get(project.id);
      const head = h('div.project-group-head' + (pinned ? '.pinned' : ''), {
        role: 'button', tabIndex: 0, 'aria-expanded': String(!folded),
        title: project.name + ' · ' + project.typeLabel + ' · ' + CF.stateText(project.state) + (pinned ? ' · 已置顶' : '') + (used ? ' · 最近使用 ' + CF.fullTime(new Date(used).toISOString()) : ''),
        on: {
          click: () => {
            if (folded) { collapsed.delete(project.id); opened.add(project.id); } else { collapsed.add(project.id); opened.delete(project.id); }
            renderConversations();
          },
          contextmenu: event => { event.preventDefault(); CF.menu(head, menuItems()); },
        },
      }, h('span.chev', CF.icon('down', 12)), h('span.name', project.name),
        pinned ? h('span.pin-mark', { title: '已置顶' }, CF.icon('pin', 11)) : null,
        project.state === 'running' ? null : h('span.dot', { title: CF.stateText(project.state) }),
        folded && used ? h('span.count', CF.shortTime(new Date(used).toISOString())) : null, more, add);
      const newItem = view.name === 'chat' && !view.conversationId && view.projectId === project.id
        ? h('button.conv-item.selected', h('span.title', '新对话')) : null;
      return h('div.project-group' + (folded ? '.collapsed' : '') + (kind === 'older' ? '.older' : ''), head, folded ? null : h('div.conv-list',
        newItem,
        shown.map(item => conversationButton(item)),
        !items.length && !newItem ? h('button.conv-more', { on: { click: () => CF.app.go({ name: 'chat', projectId: project.id }) } }, '开始第一个对话') : null,
        items.length > 6 && !filter ? h('button.conv-more', { on: { click: () => { showAll ? expanded.delete(project.id) : expanded.add(project.id); renderConversations(); } } }, showAll ? '收起' : '全部 ' + items.length + ' 个对话') : null));
    };

    const section = (key, label, body, count, foldedByDefault = false) => {
      const stored = localStorage.getItem('cf.folded.' + key);
      const folded = stored === null ? foldedByDefault : stored === '1';
      return h('div.recent-group' + (folded ? '.collapsed' : ''),
        h('div.project-group-head.recent-head', {
          role: 'button', tabIndex: 0, 'aria-expanded': String(!folded),
          on: { click: () => {
            localStorage.setItem('cf.folded.' + key, folded ? '0' : '1');
            if (key === 'archived' && folded) void CF.app.refreshArchived();
            renderConversations();
          } },
        }, h('span.chev', CF.icon('down', 12)), h('span.name', label), count !== undefined ? h('span.count', String(count)) : null),
        folded ? null : body());
    };

    let top = [];
    if (!filter) {
      const active = visible.filter(item => item.attention || ['starting', 'running'].includes(item.status));
      const since = new Date(); since.setHours(0, 0, 0, 0);
      const yesterday = since.getTime() - DAY;
      const recent = visible.filter(item => !active.includes(item) && (Date.parse(item.updatedAt) || 0) >= yesterday).slice(0, 5);
      if (active.length) top.push(section('active', '进行中', () => h('div.conv-list', active.map(item => conversationButton(item, '.recent', projectName(item.projectId))))));
      if (recent.length) top.push(section('recent', '最近', () => h('div.conv-list', recent.map(item => conversationButton(item, '.recent', projectName(item.projectId))))));
    }

    const cutoff = Date.now() - 30 * DAY;
    const isOlder = project => !filter && !CF.pins.has(project.id) && project.id !== selectedProject && (lastUsed.get(project.id) ?? 0) < cutoff;
    const current = chatProjects.filter(project => !isOlder(project))
      .sort((a, b) => Number(CF.pins.has(b.id)) - Number(CF.pins.has(a.id)) || (lastUsed.get(b.id) ?? 0) - (lastUsed.get(a.id) ?? 0));
    const older = chatProjects.filter(isOlder).sort((a, b) => (lastUsed.get(b.id) ?? 0) - (lastUsed.get(a.id) ?? 0));
    const groups = current.map(project => group(project, 'current')).filter(Boolean);
    const olderGroup = older.length
      ? section('older', '更早的项目', () => h('div.older-projects', older.map(project => group(project, 'older'))), older.length, true) : null;

    // 已归档: folded at the bottom; loaded when opened.
    const archivedOpen = localStorage.getItem('cf.folded.archived') === '0';
    const archived = CF.state.archived.filter(item => !filter || item.name.toLowerCase().includes(filter));
    const archivedGroup = archivedOpen || filter
      ? (archived.length || !filter ? section('archived', '已归档', () => h('div.conv-list', archived.length
        ? archived.map(item => conversationButton(item, '.recent', projectName(item.projectId)))
        : h('div.sidebar-empty.small', '没有归档的对话。')), archived.length || undefined, true) : null)
      : section('archived', '已归档', () => null, undefined, true);
    conversationsHost.replaceChildren(groups.length || olderGroup
      ? h('div', top, groups.length && top.length ? h('div.sidebar-label', '项目') : null, groups, olderGroup, archivedGroup)
      : h('div.sidebar-empty', filter ? '没有匹配的对话。' : connected ? '添加 Claude、Codex 或 Antigravity 项目后，在这里开始对话。' : '连接后端后显示对话。'));
  }

  function renderSidebar() {
    if (!CF.state.backendId) return;
    const { view, profiles, backendId, projects, accounts, conversations, connected } = CF.state;
    const current = profiles.find(item => item.id === backendId);
    const running = projects.filter(item => item.state === 'running').length;
    const waiting = conversations.filter(item => item.attention);
    const attention = waiting.length ? h('button.attention-row', {
      title: waiting.map(item => item.name).join('\n'),
      on: { click: () => {
        // Cycle through waiting conversations.
        const index = waiting.findIndex(item => item.id === view.conversationId);
        const next = waiting[(index + 1) % waiting.length];
        CF.app.go({ name: 'chat', conversationId: next.id, projectId: next.projectId });
      } },
    }, h('span.dot.waiting'), h('strong', waiting.length + ' 个等你确认'), h('span.name', waiting[0].name), CF.icon('chevron', 12)) : null;
    // New chat opens straight away in the current or last-used project;
    // the project is switched from the chip in the composer.
    const newChat = h('button.new-chat', { title: '新对话', on: { click: () => {
      const target = CF.chat.defaultProject(view.projectId);
      if (!target) { CF.app.go({ name: 'projects' }); CF.toast('先新建一个项目'); return; }
      CF.app.go({ name: 'chat', projectId: target.id });
    } } }, CF.icon('compose', 15), h('span.label', '新对话'));
    const kindText = profile => profile.kind === 'local' ? '这台电脑' : profile.kind === 'ssh' ? 'SSH · ' + profile.host : '远端';
    const backendButton = h('button.backend-row', { title: '切换后端', on: { click: () => CF.menu(backendButton, [
      ...profiles.map(profile => ({ label: profile.name, hint: kindText(profile), avatar: (profile.name || '?').slice(0, 1), checked: profile.id === backendId,
        run: () => { if (profile.id !== backendId) void connect(profile.id); } })),
      '-',
      { label: '通过 SSH 添加后端…', icon: 'plus', run: async () => { const result = await CF.addSshBackend(); if (result?.id) await CF.app.loadProfiles(result.id); } },
      '-',
      { label: '项目', trail: connected ? String(projects.length) : '', icon: 'folder', run: () => CF.app.go({ name: 'projects' }) },
      { label: '账号', trail: connected ? String(accounts.length) : '', icon: 'user', run: () => CF.app.go({ name: 'accounts' }) },
      { label: '设置', trail: CF.transport?.platform === 'darwin' ? '⌘,' : 'Ctrl+,', icon: 'gear', run: () => CF.app.go({ name: 'settings' }) },
    ], { matchWidth: true }) } }, h('span.backend-avatar', (current?.name || '?').slice(0, 1)),
      h('span.names', h('strong', current?.name || '未连接'), h('small', connected ? (current?.kind === 'local' ? '这台电脑' : current?.kind === 'ssh' ? '远程 · ' + current.host : '远端') + ' · ' + running + ' 个容器运行中' : '未连接')),
      CF.icon('down', 13));
    renderConversations();
    // Re-rendering must not interrupt typing in the search field.
    const typing = document.activeElement === search ? [search.selectionStart, search.selectionEnd] : null;
    // The list is rebuilt on every change (selection, status dots): keep where the user scrolled to.
    const scrollTop = sidebar.querySelector('.sidebar-scroll')?.scrollTop ?? 0;
    sidebar.replaceChildren(
      h('div.sidebar-top',
        h('div.workspace-head', CF.brandMark(), h('div.names', h('strong', 'CoderFleet')),
          h('button.icon-btn.sidebar-toggle', { title: '隐藏侧边栏（' + (CF.transport?.platform === 'darwin' ? '⌘' : 'Ctrl+') + '\\）', on: { click: () => CF.app.toggleSidebar() } }, CF.icon('sidebar', 16))),
        newChat,
        h('label.search', CF.icon('search', 14), search, h('span.kbd', CF.transport?.platform === 'darwin' ? '⌘K' : 'Ctrl K'))),
      attention,
      h('div.sidebar-scroll',
        conversationsHost),
      h('div.sidebar-foot', activityHost, backendButton),
    );
    const scroller = sidebar.querySelector('.sidebar-scroll');
    if (scroller) scroller.scrollTop = scrollTop;
    if (typing) { search.focus(); search.setSelectionRange(typing[0], typing[1]); }
  }

  // 项目, 账号 and the rest are tabs of one 设置 screen, opened from the backend menu (or ⌘,).
  const SETTINGS_TABS = [['projects', '项目', 'folder'], ['accounts', '账号', 'user'], ['settings', '通用', 'gear']];
  const settingsBar = active => h('div.settings-bar',
    h('button.btn.ghost.small.settings-back', { title: '返回对话（Esc）', on: { click: () => CF.app.closeSettings() } }, CF.icon('chevron', 13), '返回'),
    h('div.settings-tabs', { role: 'tablist' }, SETTINGS_TABS.map(([name, label, icon]) => h('button.settings-tab' + (name === active ? '.selected' : ''), {
      role: 'tab', 'aria-selected': String(name === active), on: { click: () => CF.app.go({ name }) },
    }, CF.icon(icon, 14), label))));

  function renderMain() {
    const { view, connected } = CF.state;
    if (!connected && view.name !== 'settings') return;
    if (view.name === 'chat') CF.state.lastChat = view;
    const container = h('div.view');
    main.replaceChildren(...(view.name === 'chat' ? [] : [settingsBar(view.name)]), container);
    if (view.name === 'chat') CF.chat.mount(container, view);
    else if (view.name === 'projects') CF.projects.mount(container);
    else if (view.name === 'accounts') CF.accounts.mount(container);
    else if (view.name === 'settings') void CF.settings.mount(container);
  }

  // Container states and conversation status dots stay current while the App is visible.
  setInterval(() => {
    if (document.hidden || !CF.state.connected) return;
    void CF.get('projects').then(projects => {
      const changed = JSON.stringify(projects) !== JSON.stringify(CF.state.projects);
      CF.state.projects = projects;
      if (changed) CF.app.renderCurrent();
    }).catch(() => undefined);
    void CF.get('conversations').then(conversations => {
      if (JSON.stringify(conversations) === JSON.stringify(CF.state.conversations)) return;
      CF.state.conversations = conversations;
      renderSidebar();
      CF.chat.sync();
    }).catch(() => undefined);
  }, 5000);

  if (!CF.transport) {
    main.textContent = 'CoderFleet must run inside the desktop App.';
    return;
  }
  void CF.app.loadProfiles().catch(error => {
    main.replaceChildren(h('div.welcome', h('div.welcome-card', h('h1', '启动失败'), h('p', CF.errorText(error)))));
  });
})();
