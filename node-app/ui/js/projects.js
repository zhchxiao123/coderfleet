'use strict';
// Projects page: container state and lifecycle, shells, new project sheet.
(() => {
  const CF = window.CF;
  const { h } = CF;
  const pending = new Map(); // project → operation label while it runs

  const track = async (id, label, operation) => {
    pending.set(id, label);
    CF.app.renderCurrent();
    await CF.trackOperation(operation, id + ' · ' + label, () => void CF.app.refreshProjects());
    pending.delete(id);
    await CF.app.refreshProjects();
  };

  CF.projects = {
    async start(id, button) {
      const operation = await CF.busy(button, () => CF.api('POST', 'projects/' + id + '/start'));
      if (operation) await track(id, '启动', operation);
    },

    terminal(id) {
      const project = CF.state.projects.find(item => item.id === id);
      void CF.openTerminal((project?.name || id) + ' · 终端', '容器里的 /workspace 就是项目目录。', (cols, rows) =>
        CF.api('POST', 'projects/' + id + '/terminal', { cols, rows }));
    },

    create() {
      const accounts = CF.state.accounts.filter(item => item.runtime === 'container');
      if (!accounts.length) {
        CF.toast('先添加一个账号', { action: { label: '去添加', run: () => { CF.app.go({ name: 'accounts' }); CF.accounts.create(); } } });
        return;
      }
      const name = h('input', { placeholder: '例如 my-app', autofocus: true, spellcheck: false });
      const account = h('select', accounts.map(item => h('option', { value: item.name }, item.name + ' · ' + item.typeLabel)));
      const path = h('input', { placeholder: '/Users/you/code/my-app', spellcheck: false });
      const start = h('input', { type: 'checkbox', checked: true });
      const pick = CF.transport.pickDirectory && CF.app.isLocal() ? h('button.btn', { type: 'button', on: { click: async () => {
        const chosen = await CF.transport.pickDirectory();
        if (chosen) {
          path.value = chosen;
          if (!name.value) name.value = chosen.split(/[\\/]/).filter(Boolean).pop().replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
        }
      } } }, '选择…') : null;
      const sheet = CF.sheet({ title: '新建项目', subtitle: '项目目录会挂载到账号容器的 /workspace。' }, () => [
        h('label.field', h('span', '项目名', h('span.hint', ' 字母、数字和连字符')), name),
        h('label.field', h('span', '账号'), account),
        h('div.field', h('span', '项目目录'), h('div.input-row', path, pick)),
        h('label.check', start, '创建后立即启动容器'),
      ]);
      const save = h('button.btn.primary', { on: { click: () => CF.busy(save, async () => {
        sheet.error('');
        try {
          const result = await CF.api('POST', 'projects', { name: name.value.trim(), account: account.value, path: path.value.trim(), start: start.checked });
          sheet.close();
          await CF.app.refreshProjects();
          if (result.operation) void track(result.name, '启动', result.operation);
        } catch (error) { sheet.error(error); }
      }) } }, '创建');
      sheet.foot(h('button.btn', { on: { click: () => sheet.close() } }, '取消'), save);
    },

    mount(container) {
      const { projects, overview } = CF.state;
      const banners = [];
      if (overview && !overview.docker) banners.push(h('div.banner', h('span.banner-icon', CF.icon('box', 16)), h('div.text', h('strong', '连不上 Docker'), h('span', '请先启动 Docker Desktop 或 OrbStack。'))));
      else if (overview && !overview.initialized) banners.push(CF.settings.initBanner());
      else if (overview?.image && !overview.image.exists) banners.push(CF.settings.imageBanner());

      const row = project => {
        const busy = pending.get(project.id);
        const running = project.state === 'running';
        const act = (path, label) => async event => {
          const operation = await CF.busy(event.currentTarget, () => CF.api('POST', 'projects/' + project.id + '/' + path));
          if (operation) void track(project.id, label, operation);
        };
        const menuButton = h('button.btn.ghost.icon.small', { title: '更多', on: { click: () => CF.menu(menuButton, [
          project.chat ? { label: CF.pins.has(project.id) ? '取消置顶' : '置顶项目', icon: 'pin', run: () => CF.togglePin(project.id) } : null,
          running ? { label: '停止容器', icon: 'stop', run: () => act('stop', '停止')({ currentTarget: menuButton }) } : null,
          running ? { label: '重启容器', icon: 'restart', run: () => act('restart', '重启')({ currentTarget: menuButton }) } : null,
          running ? { label: '打开终端', icon: 'terminal', run: () => CF.projects.terminal(project.id) } : null,
          { label: project.active ? '停用项目' : '启用项目', run: () => CF.busy(null, async () => {
            await CF.api('POST', 'projects/' + project.id + '/' + (project.active ? 'disable' : 'enable'));
            await CF.app.refreshProjects();
          }) },
          '-',
          { label: '删除项目', icon: 'trash', danger: true, run: async () => {
            if (!await CF.confirm('删除项目 ' + project.name + '？', '会删除它的容器并从配置里移除。项目目录和账号数据都会保留。', { danger: true, label: '删除' })) return;
            const operation = await CF.busy(null, () => CF.api('DELETE', 'projects/' + project.id));
            if (operation) void track(project.id, '删除', operation);
          } },
        ].filter(Boolean)) } }, CF.icon('more', 15));
        // One contextual action: talk when the container runs, otherwise start it.
        const primary = busy ? h('button.btn.small', { disabled: true }, h('span.spinner'), busy + '中')
          : running && project.chat ? h('button.btn.small', { on: { click: () => CF.app.go({ name: 'chat', projectId: project.id }) } }, CF.icon('chat', 13), '对话')
            : running ? null
              : h('button.btn.small.soft', { disabled: !project.active, on: { click: act('start', '启动') } }, CF.icon('play', 11), '启动');
        return h('li.row',
          h('div.row-lead',
            h('span.row-avatar.' + project.type, project.name.slice(0, 1).toUpperCase(),
              h('span.status' + (busy ? '.busy' : running ? '.running' : ''), { title: CF.stateText(project.state) })),
            h('div.row-main',
              h('div.row-title', h('span.name', project.name), CF.pins.has(project.id) ? h('span.pin-mark', { title: '已置顶' }, CF.icon('pin', 12)) : null, CF.typeBadge(project.type, project.typeLabel), project.active ? null : h('span.badge', '已停用')),
              h('div.row-sub', h('span', busy ? busy + '中…' : CF.stateText(project.state)), h('span.sep'), h('span', project.account),
                h('span.sep'), h('span.path', { title: project.path }, CF.shortPath(project.path))))),
          h('div.row-actions',
            running ? h('button.btn.small.icon', { title: '终端', 'aria-label': '终端', on: { click: () => CF.projects.terminal(project.id) } }, CF.icon('terminal', 14)) : null,
            primary, menuButton));
      };

      const running = projects.filter(item => item.state === 'running').length;
      const active = CF.state.conversations.filter(item => ['starting', 'running'].includes(item.status)).length;
      const waiting = CF.state.conversations.filter(item => item.attention).length;
      const stat = (icon, tone, label, value, total, sub) => h('div.stat',
        h('div.stat-head', h('span.stat-icon' + (tone ? '.' + tone : ''), CF.icon(icon, 13)), label),
        h('div.stat-value', String(value), total === undefined ? null : h('small', '/ ' + total)), h('div.stat-sub', sub));
      container.replaceChildren(h('div.page', h('div.page-inner',
        h('div.page-head', h('div', h('div.eyebrow', new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }) + ' · ' + running + ' 个容器运行中'),
          h('h1', '项目')),
          h('button.btn.primary', { on: { click: () => CF.projects.create() } }, CF.icon('plus', 14), '新建项目')),
        CF.pythonNotice(CF.state.overview), banners,
        h('div.stats',
          stat('box', 'green', '运行中', running, projects.length, '个项目容器'),
          stat('user', '', '账号', CF.state.accounts.length, undefined, CF.state.accounts.filter(item => item.auth === 'env' || item.hasLogin).length + ' 个已登录或已配置密钥'),
          stat('chat', 'neutral', '进行中', active, undefined, '个对话'),
          stat('shield', 'amber', '等你确认', waiting, undefined, waiting ? '去对话里处理' : '没有待办')),
        projects.length
          ? h('div.card', h('div.card-head', h('div', h('h2', '全部项目'), h('p', '每个项目在自己账号的容器里运行，网络只经 relay 出去。'))), h('ul.list', CF.pins.sort(projects).map(row)))
          : h('div.card', h('div.empty', h('div.glyph', CF.icon('folder', 22)), h('h3', '还没有项目'),
            h('p', '选一个本地目录作为项目，用某个账号在容器里打开它。'),
            h('button.btn.primary', { on: { click: () => CF.projects.create() } }, CF.icon('plus', 14), '新建项目'))),
      )));
    },
  };
})();
