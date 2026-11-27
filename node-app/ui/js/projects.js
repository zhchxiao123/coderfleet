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

  /** Start, stop or restart every container; rows show it as their own operation while it runs. */
  const ALL = {
    start: { label: '启动', title: '启动全部容器？', text: () => '会启动所有已启用项目的容器和 relay，已经在运行的不受影响。' },
    stop: { label: '停止', title: '停止全部容器？', danger: true,
      text: active => (active ? '有 ' + active + ' 个对话正在进行，会被中断。' : '') + '所有项目容器和 relay 都会停下，容器保留，里面装过的软件还在。' },
    restart: { label: '重启', title: '重启全部容器？', danger: true,
      text: active => (active ? '有 ' + active + ' 个对话正在进行，会被中断。' : '') + '所有容器先停下再启动，环境变量和挂载目录的修改随之生效。' },
  };
  const all = async (action, button) => {
    const { label, title, text, danger = false } = ALL[action];
    const active = CF.state.conversations.filter(item => ['starting', 'running'].includes(item.status)).length;
    if (!await CF.confirm(title, text(active), { danger, label: '全部' + label })) return;
    const operation = await CF.busy(button, () => CF.api('POST', 'containers/' + action));
    if (!operation) return;
    const affected = { start: item => item.active && item.state !== 'running', stop: item => item.state === 'running', restart: item => item.active || item.state === 'running' }[action];
    const ids = CF.state.projects.filter(item => item.runtime === 'container' && affected(item)).map(item => item.id);
    for (const id of ids) pending.set(id, label);
    CF.app.renderCurrent();
    await CF.trackOperation(operation, '全部容器 · ' + label, () => void CF.app.refreshProjects());
    for (const id of ids) pending.delete(id);
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

    /**
     * The accounts of one project, as a checklist: one of each type, all with the same proxy
     * setting (the backend holds the same rules). `chosen` is in the order they were picked,
     * the first being the account the project is built on; `locked` cannot be unpicked.
     */
    accountChoice(accounts, chosen, locked = '') {
      const list = h('div.account-choice');
      const render = () => {
        const picked = chosen.map(name => accounts.find(item => item.name === name)).filter(Boolean);
        list.replaceChildren(...accounts.map(item => {
          const on = chosen.includes(item.name);
          const why = on ? (item.name === locked ? '项目建在这个账号上' : '')
            : picked.some(other => other.type === item.type) ? '每种账号只能选一个'
              : picked.some(other => other.proxy !== item.proxy) ? '代理设置和已选的账号不一样' : '';
          const box = h('input', { type: 'checkbox', checked: on, disabled: Boolean(why), on: { change: () => {
            if (box.checked) chosen.push(item.name); else chosen.splice(chosen.indexOf(item.name), 1);
            render();
          } } });
          return h('label.check' + (why && !on ? '.off' : ''), { title: why }, box, CF.typeBadge(item.type, item.typeLabel), h('span.name', item.name),
            why ? h('span.hint', why) : null);
        }));
      };
      render();
      return list;
    },

    create() {
      const accounts = CF.state.accounts.filter(item => item.runtime === 'container');
      if (!accounts.length) {
        CF.toast('先添加一个账号', { action: { label: '去添加', run: () => { CF.app.go({ name: 'accounts' }); CF.accounts.create(); } } });
        return;
      }
      const name = h('input', { placeholder: '例如 my-app', autofocus: true, spellcheck: false });
      const chosen = [accounts[0].name];
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
        h('div.field', h('span', '账号', accounts.length > 1 ? h('span.hint', ' 可以选几个不同类型的，对话时再挑') : null), CF.projects.accountChoice(accounts, chosen)),
        h('div.field', h('span', '项目目录'), h('div.input-row', path, pick)),
        h('label.check', start, '创建后立即启动容器'),
      ]);
      const save = h('button.btn.primary', { on: { click: () => CF.busy(save, async () => {
        sheet.error('');
        try {
          const result = await CF.api('POST', 'projects', { name: name.value.trim(), accounts: chosen, path: path.value.trim(), start: start.checked });
          sheet.close();
          await CF.app.refreshProjects();
          if (result.operation) void track(result.name, '启动', result.operation);
        } catch (error) { sheet.error(error); }
      }) } }, '创建');
      sheet.foot(h('button.btn', { on: { click: () => sheet.close() } }, '取消'), save);
    },

    /**
     * Edits the project's environment variables (projects/<name>/env, shared with the
     * old Web UI). They reach the container when it is recreated, so a running
     * project can be restarted straight from here.
     */
    async env(project) {
      let values;
      try { values = (await CF.get('projects/' + encodeURIComponent(project.id) + '/env')).vars; } catch (error) { CF.fail(error); return; }
      const secret = key => /KEY|TOKEN|SECRET|PASSWORD/i.test(key);
      const rows = h('div.env-rows');
      const addRow = (key = '', value = '') => {
        const keyInput = h('input.mono', { value: key, placeholder: 'NAME', spellcheck: false, autocomplete: 'off' });
        const valueInput = h('input.mono', { value, placeholder: '值', spellcheck: false, autocomplete: 'off', type: secret(key) ? 'password' : 'text' });
        keyInput.addEventListener('input', () => { if (secret(keyInput.value)) valueInput.type = 'password'; });
        const reveal = h('button.icon-btn', { title: '显示/隐藏', on: { click: () => { valueInput.type = valueInput.type === 'password' ? 'text' : 'password'; } } }, CF.icon('eye', 13));
        const row = h('div.env-row', keyInput, valueInput, reveal,
          h('button.icon-btn', { title: '删除', on: { click: () => { row.remove(); if (!rows.children.length) addRow(); } } }, CF.icon('x', 13)));
        rows.append(row);
        return keyInput;
      };
      for (const [key, value] of Object.entries(values)) addRow(key, value);
      if (!Object.keys(values).length) addRow();
      const running = project.state === 'running';
      const sheet = CF.sheet({ title: project.name + ' · 环境变量', subtitle: '容器里的环境变量，优先于账号的同名变量。保存后重启项目才生效；和原 Web 界面共用同一份配置。', wide: true }, () => [
        h('div.env-head', h('span', '变量名'), h('span', '值')), rows,
        h('button.btn.ghost.small', { on: { click: () => addRow().focus() } }, CF.icon('plus', 13), '添加变量'),
      ]);
      const collect = () => {
        const vars = {};
        for (const row of rows.querySelectorAll('.env-row')) {
          const [keyInput, valueInput] = row.querySelectorAll('input');
          const key = keyInput.value.trim();
          if (!key && !valueInput.value) continue;
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('变量名只能用字母、数字和下划线，且不能以数字开头：' + (key || '（空）'));
          if (key in vars) throw new Error('变量名重复：' + key);
          vars[key] = valueInput.value;
        }
        return vars;
      };
      const save = async restart => {
        let vars;
        try { vars = collect(); } catch (error) { sheet.error(error.message); return; }
        await CF.api('PUT', 'projects/' + encodeURIComponent(project.id) + '/env', { vars });
        sheet.close();
        if (!restart) { CF.toast(running ? '已保存，重启项目后生效' : '已保存，启动项目时生效'); return; }
        const operation = await CF.api('POST', 'projects/' + project.id + '/restart');
        if (operation) void track(project.id, '重启', operation);
      };
      const saveOnly = h('button.btn', { on: { click: () => CF.busy(saveOnly, () => save(false)) } }, '保存');
      const saveRestart = running ? h('button.btn.primary', { on: { click: () => CF.busy(saveRestart, () => save(true)) } }, '保存并重启') : null;
      sheet.foot(h('button.btn.ghost', { on: { click: () => sheet.close() } }, '取消'), saveOnly, saveRestart);
      if (!running) saveOnly.classList.add('primary');
    },

    /**
     * Which accounts the project holds (SECONDARY_ACCOUNTS in projects.conf). An added account
     * is in the container once it is recreated; conversations of a removed one stay, to read.
     */
    accounts(project) {
      const chosen = project.accounts.map(item => item.name);
      const running = project.state === 'running';
      const sheet = CF.sheet({ title: project.name + ' · 账号', subtitle: '每种账号选一个，开始对话时挑用哪个。新加的账号要重启项目后才能用；去掉的账号，它的对话还能看，不能再发消息。' }, () => [
        CF.projects.accountChoice(CF.state.accounts.filter(item => item.runtime === 'container'), chosen, project.account),
      ]);
      const save = async restart => {
        sheet.error('');
        try { await CF.api('PUT', 'projects/' + project.id + '/accounts', { accounts: chosen }); } catch (error) { sheet.error(error); return; }
        sheet.close();
        await Promise.all([CF.app.refreshProjects(), CF.app.refreshConversations()]);
        if (!restart) { CF.toast(running ? '已保存，重启项目后生效' : '已保存，启动项目时生效'); return; }
        const operation = await CF.api('POST', 'projects/' + project.id + '/restart');
        if (operation) void track(project.id, '重启', operation);
      };
      const saveOnly = h('button.btn', { on: { click: () => CF.busy(saveOnly, () => save(false)) } }, '保存');
      const saveRestart = running ? h('button.btn.primary', { on: { click: () => CF.busy(saveRestart, () => save(true)) } }, '保存并重启') : null;
      sheet.foot(h('button.btn.ghost', { on: { click: () => sheet.close() } }, '取消'), saveOnly, saveRestart);
      if (!running) saveOnly.classList.add('primary');
    },

    /**
     * Lets the project's tasks run the machine helper's listed commands on the
     * backend's machine, or takes that away (HELPER_ACCESS in projects.conf).
     */
    async helper(project) {
      const on = project.helper === 'command';
      if (!on && !await CF.confirm('允许 ' + project.name + ' 的任务操作这台机器？',
        '任务可以通过机器助手运行你在规则里列出的命令，目录限制在项目目录里；规则要求确认的命令会先问你。对之后开始的任务生效。', { label: '允许' })) return;
      try { await CF.api('PUT', 'projects/' + project.id + '/helper', { access: on ? 'off' : 'command' }); }
      catch (error) { CF.fail(error); return; }
      await CF.app.refreshProjects();
      CF.toast(on ? '已关闭，正在运行的任务也用不了了' : '已允许。机器助手在「通用」里安装和启动');
    },

    /**
     * Edits the extra host directories in the project's container (EXTRA_MOUNTS in
     * projects.conf, shared with the old Web UI). Like the environment, they reach the
     * container when it is recreated.
     */
    mounts(project) {
      const rows = h('div.env-rows');
      const addRow = (spec = '') => {
        const parts = spec.split(':');
        const host = h('input.mono', { value: parts[0] || '', placeholder: '这台机器上的目录', spellcheck: false, autocomplete: 'off' });
        const target = h('input.mono', { value: parts[1] || '', placeholder: '容器里的路径，例如 /data', spellcheck: false, autocomplete: 'off' });
        const readOnly = h('input', { type: 'checkbox', checked: parts[2] === 'ro' });
        const pick = CF.transport.pickDirectory && CF.app.isLocal() ? h('button.icon-btn', { title: '选择目录…', on: { click: async () => {
          const chosen = await CF.transport.pickDirectory();
          if (!chosen) return;
          host.value = chosen;
          if (!target.value) target.value = '/' + chosen.split(/[\\/]/).filter(Boolean).pop();
        } } }, CF.icon('folder', 13)) : h('span');
        const row = h('div.env-row.mount-row', host, target, h('label.check', { title: '容器里只能读，不能改' }, readOnly, '只读'), pick,
          h('button.icon-btn', { title: '删除', on: { click: () => { row.remove(); if (!rows.children.length) addRow(); } } }, CF.icon('x', 13)));
        rows.append(row);
        return host;
      };
      for (const spec of project.mounts || []) addRow(spec);
      if (!rows.children.length) addRow();
      const running = project.state === 'running';
      const sheet = CF.sheet({ title: project.name + ' · 挂载目录', subtitle: '把这台机器上的其他目录也放进项目容器。项目目录本身已经在 /workspace。保存后重启项目才生效。', wide: true }, () => [
        h('div.env-head.mount-head', h('span', '机器上的目录'), h('span', '容器里的路径')), rows,
        h('button.btn.ghost.small', { on: { click: () => addRow().focus() } }, CF.icon('plus', 13), '添加目录'),
      ]);
      const collect = () => [...rows.querySelectorAll('.env-row')].flatMap(row => {
        const [host, target, readOnly] = [...row.querySelectorAll('input')];
        const from = host.value.trim(); const to = target.value.trim();
        if (!from && !to) return [];
        if (!from || !to) throw new Error('每一行都要填机器上的目录和容器里的路径');
        return [from + ':' + to + (readOnly.checked ? ':ro' : '')];
      });
      const save = async restart => {
        sheet.error('');
        let mounts;
        try { mounts = collect(); } catch (error) { sheet.error(error.message); return; }
        try { await CF.api('PUT', 'projects/' + project.id + '/mounts', { mounts }); } catch (error) { sheet.error(error); return; }
        sheet.close();
        await CF.app.refreshProjects();
        if (!restart) { CF.toast(running ? '已保存，重启项目后生效' : '已保存，启动项目时生效'); return; }
        const operation = await CF.api('POST', 'projects/' + project.id + '/restart');
        if (operation) void track(project.id, '重启', operation);
      };
      const saveOnly = h('button.btn', { on: { click: () => CF.busy(saveOnly, () => save(false)) } }, '保存');
      const saveRestart = running ? h('button.btn.primary', { on: { click: () => CF.busy(saveRestart, () => save(true)) } }, '保存并重启') : null;
      sheet.foot(h('button.btn.ghost', { on: { click: () => sheet.close() } }, '取消'), saveOnly, saveRestart);
      if (!running) saveOnly.classList.add('primary');
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
          project.accounts ? { label: '账号…', icon: 'user', run: () => CF.projects.accounts(project) } : null,
          { label: '环境变量…', icon: 'key', run: () => CF.projects.env(project) },
          { label: '挂载目录…', icon: 'folder', run: () => CF.projects.mounts(project) },
          { label: project.helper === 'command' ? '关闭机器操作' : '允许机器操作…', icon: 'terminal', run: () => CF.projects.helper(project) },
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
              h('div.row-title', h('span.name', project.name), CF.pins.has(project.id) ? h('span.pin-mark', { title: '已置顶' }, CF.icon('pin', 12)) : null, ...(project.accounts || [project]).map(item => CF.typeBadge(item.type, item.typeLabel)), project.active ? null : h('span.badge', '已停用')),
              h('div.row-sub', h('span', busy ? busy + '中…' : CF.stateText(project.state)), h('span.sep'), h('span', { title: (project.accounts || []).map(item => item.name).join('、') }, project.accounts?.length > 1 ? project.accounts.length + ' 个账号' : project.account),
                h('span.sep'), h('span.path', { title: project.path }, CF.shortPath(project.path))))),
          h('div.row-actions',
            running ? h('button.btn.small.icon', { title: '终端', 'aria-label': '终端', on: { click: () => CF.projects.terminal(project.id) } }, CF.icon('terminal', 14)) : null,
            primary, menuButton));
      };

      const running = projects.filter(item => item.state === 'running').length;
      const containers = projects.filter(item => item.runtime === 'container');
      const startable = containers.some(item => item.active && item.state !== 'running');
      const allButton = containers.length ? h('button.btn.small', { disabled: pending.size > 0 || (!startable && !running), on: { click: () => CF.menu(allButton, [
        startable ? { label: '全部启动', icon: 'play', run: () => all('start', allButton) } : null,
        running ? { label: '全部重启', icon: 'restart', run: () => all('restart', allButton) } : null,
        running ? { label: '全部停止', icon: 'stop', danger: true, run: () => all('stop', allButton) } : null,
      ]) } }, CF.icon('box', 13), '全部容器') : null;
      const active = CF.state.conversations.filter(item => ['starting', 'running'].includes(item.status)).length;
      const waiting = CF.state.conversations.filter(item => item.attention).length;
      const stat = (icon, tone, label, value, total, sub) => h('div.stat',
        h('div.stat-head', h('span.stat-icon' + (tone ? '.' + tone : ''), CF.icon(icon, 13)), label),
        h('div.stat-value', String(value), total === undefined ? null : h('small', '/ ' + total)), h('div.stat-sub', sub));
      container.replaceChildren(h('div.page', h('div.page-inner',
        h('div.page-head', h('div', h('div.eyebrow', CF.today() + ' · ' + running + ' 个容器运行中'),
          h('h1', '项目')),
          h('button.btn.primary', { on: { click: () => CF.projects.create() } }, CF.icon('plus', 14), '新建项目')),
        CF.pythonNotice(CF.state.overview), banners,
        h('div.stats',
          stat('box', 'green', '运行中', running, projects.length, '个项目容器'),
          stat('user', '', '账号', CF.state.accounts.length, undefined, CF.state.accounts.filter(item => item.auth === 'env' || item.hasLogin).length + ' 个已登录或已配置密钥'),
          stat('chat', 'neutral', '进行中', active, undefined, '个对话'),
          stat('shield', 'amber', '等你确认', waiting, undefined, waiting ? '去对话里处理' : '没有待办')),
        projects.length
          ? h('div.card', h('div.card-head', h('div', h('h2', '全部项目'), h('p', '每个项目在自己账号的容器里运行，网络只经 relay 出去。')), allButton), h('ul.list', CF.pins.sort(projects).map(row)))
          : h('div.card', h('div.empty', h('div.glyph', CF.icon('folder', 22)), h('h3', '还没有项目'),
            h('p', '选一个本地目录作为项目，用某个账号在容器里打开它。'),
            h('button.btn.primary', { on: { click: () => CF.projects.create() } }, CF.icon('plus', 14), '新建项目'))),
      )));
    },
  };
})();
