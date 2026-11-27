'use strict';
// Accounts page: add (type, auth, proxy, environment), login terminal, delete.
(() => {
  const CF = window.CF;
  const { h } = CF;

  /** Rows of KEY / value inputs. Values are write-only: existing ones are never shown. */
  function envEditor(existingKeys = []) {
    const rows = h('div.env-rows');
    const add = (key = '', placeholder = '值') => {
      const keyInput = h('input.mono', { value: key, placeholder: 'ANTHROPIC_API_KEY', spellcheck: false });
      const valueInput = h('input.mono', { type: 'password', placeholder, autocomplete: 'off' });
      const row = h('div.env-row', keyInput, valueInput, h('button.icon-btn', { title: '移除', type: 'button', on: { click: () => {
        if (key) { valueInput.value = ''; row.dataset.removed = '1'; row.style.opacity = '0.4'; } else row.remove();
      } } }, CF.icon('x', 13)));
      rows.append(row);
    };
    for (const key of existingKeys) add(key, '已设置，留空保持不变');
    if (!existingKeys.length) add();
    return {
      node: h('div', rows, h('button.btn.ghost.small', { type: 'button', style: 'margin-top:6px', on: { click: () => add() } }, CF.icon('plus', 12), '添加变量')),
      values() {
        const values = {};
        for (const row of rows.children) {
          const [keyInput, valueInput] = row.querySelectorAll('input');
          const key = keyInput.value.trim();
          if (!key) continue;
          if (row.dataset.removed) values[key] = '';
          else if (valueInput.value) values[key] = valueInput.value;
        }
        return values;
      },
    };
  }

  const resetText = iso => {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return '';
    const zone = { timeZone: CF.timeZone.current() };
    const time = new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, ...zone });
    if (at - Date.now() < 20 * 3600_000) return time + ' 重置';
    return new Date(at).toLocaleDateString('zh-CN', { weekday: 'short', ...zone }) + ' ' + time + ' 重置';
  };
  const level = used => used >= 90 ? '.red' : used >= 75 ? '.amber' : '';
  const USAGE_ERRORS = {
    unauthorized: '登录已过期，重新登录后才能查额度', no_credentials: '还没有登录', rate_limited: '额度查询太频繁，稍后再试', network_error: '容器里连不上额度接口',
    no_running_container: '启动这个账号的一个项目后显示额度', probe_failed: '容器里的额度查询没有跑起来',
    token_stale: '下次对话时更新额度',
  };
  /** Trying again cannot help these: the account has to be started or signed in first. */
  const USAGE_NEEDS_ACTION = new Set(['unauthorized', 'no_credentials', 'no_running_container', 'token_stale']);
  const usageProblem = error => USAGE_ERRORS[error] || '额度没查到（' + (/^http_\d+$/.test(error) ? '额度接口返回 ' + error.slice(5) : error) + '）';
  /** What an account's usage is measured in: Antigravity's pools (one per model family), else the two windows. */
  const windows = usage => usage?.pools ? usage.pools.map(pool => [pool.label, pool])
    : [['5 小时', usage?.fiveHour], ['本周', usage?.sevenDay]].filter(([, value]) => value);

  /** The account's subscription usage as a line of meters; null for accounts that have none (API key and others). */
  function usageLine(account) {
    const usage = account.usage;
    if (!usage) return null;
    const shown = windows(usage);
    const problem = usage.error ? usageProblem(usage.error) : '';
    const retry = usage.error && !USAGE_NEEDS_ACTION.has(usage.error)
      ? h('button.btn.ghost.small', { on: { click: event => { event.stopPropagation(); void CF.busy(event.currentTarget, () => refreshUsage(account)); } } }, '重试') : null;
    if (!shown.length) return h('div.usage-line', h('span', problem || (usage.fetchedAt ? '这个账号没有返回额度' : '启动这个账号的一个项目后显示额度')), retry);
    return h('div.usage-line',
      shown.map(([label, value]) => h('span.usage' + level(value.used), { title: resetText(value.resetsAt) },
        h('span', label), h('span.usage-bar', h('i', { style: 'width:' + Math.round(value.used) + '%' })),
        h('strong', Math.round(value.used) + '%'), h('span.usage-reset', resetText(value.resetsAt)))),
      h('span.usage-age', problem ? problem + '，这是' + CF.relative(usage.fetchedAt) + '的数字' : CF.relative(usage.fetchedAt) + '更新'), retry);
  }

  async function refreshUsage(account) {
    try {
      await CF.api('POST', 'accounts/' + account.name + '/usage');
      await CF.app.refreshAccounts();
    } catch (error) { CF.fail(error); }
  }

  CF.accounts = {
    /**
     * A small pill for the chat top bar: the account's two windows, or, for an account with
     * pools, the one `model` draws on (the fullest one while the model is the CLI's default).
     */
    usagePill(name, model) {
      const usage = CF.state.accounts.find(item => item.name === name)?.usage;
      const all = windows(usage);
      if (!all.length) return null;
      const worst = Math.max(...all.map(([, value]) => value.used));
      const shown = !usage.pools ? all
        : [all.find(([, pool]) => model && model.startsWith(pool.id)) || all.find(([, pool]) => pool.used === worst)];
      return h('span.usage-pill' + level(Math.max(...shown.map(([, value]) => value.used))), {
        title: name + ' 的套餐额度\n' + all.map(([label, value]) => [label + ' 已用 ' + Math.round(value.used) + '%', resetText(value.resetsAt)].filter(Boolean).join('，')).join('\n'),
        on: { click: () => CF.app.go({ name: 'accounts' }) },
      }, shown.map(([label, value]) => label + ' ' + Math.round(value.used) + '%').join(' · '));
    },

    create() {
      const types = CF.state.overview?.accountTypes || [];
      let type = types.find(item => item.id === 'claude') || types[0];
      let auth = 'login';
      let proxy = 'relay';
      const name = h('input', { spellcheck: false, placeholder: 'claude-work' });
      let nameTouched = false;
      name.addEventListener('input', () => { nameTouched = true; });
      const env = envEditor();
      const envField = h('div.field', h('span', '环境变量'), h('div.hint'), env.node);
      const authField = h('div.field');
      const cards = h('div.type-grid');
      const segmented = (options, current, onChange) => {
        const group = h('div.segmented');
        for (const [value, label] of options) {
          group.append(h('button' + (value === current ? '.on' : ''), { type: 'button', on: { click: () => {
            for (const button of group.children) button.classList.remove('on');
            group.children[options.findIndex(([item]) => item === value)].classList.add('on');
            onChange(value);
          } } }, label));
        }
        return group;
      };
      const render = () => {
        cards.replaceChildren(...types.map(item => h('button.type-card' + (item.id === type.id ? '.on' : ''), { type: 'button', on: { click: () => {
          type = item;
          if (!type.envAuth) auth = 'login';
          if (!nameTouched) name.value = suggest();
          render();
        } } }, h('strong', item.label), h('small', item.chat ? '可在 App 里对话' : '可用终端'))));
        authField.replaceChildren(h('span', '认证方式'), type.envAuth
          ? segmented([['login', '登录账号'], ['env', 'API Key 等环境变量']], auth, value => { auth = value; render(); })
          : h('div.hint', type.label + ' 只支持登录账号。'));
        envField.hidden = auth !== 'env';
        envField.querySelector('.hint').textContent = type.envHint || '';
      };
      const suggest = () => {
        const used = new Set(CF.state.accounts.map(item => item.name));
        for (let index = 1; ; index += 1) { const candidate = type.id + (index === 1 ? '' : '-' + index); if (!used.has(candidate)) return candidate; }
      };
      name.value = suggest();
      const sheet = CF.sheet({ title: '添加账号', subtitle: '每个账号的登录数据只挂载到它自己的容器里。' }, () => [
        h('div.field', h('span', '类型'), cards),
        h('label.field', h('span', '名称', h('span.hint', ' 字母、数字和连字符')), name),
        authField, envField,
        h('div.field', h('span', '网络'), segmented([['relay', '经 relay（推荐）'], ['off', '直连']], proxy, value => { proxy = value; })),
      ]);
      render();
      const save = h('button.btn.primary', { on: { click: () => CF.busy(save, async () => {
        sheet.error('');
        try {
          await CF.api('POST', 'accounts', { name: name.value.trim(), type: type.id, auth, proxy, env: auth === 'env' ? env.values() : undefined });
          sheet.close();
          await CF.app.refreshAccounts();
          if (auth === 'login') CF.toast('账号已添加', { action: { label: '登录', run: () => CF.accounts.login(name.value.trim()) } });
        } catch (error) { sheet.error(error); }
      }) } }, '添加');
      sheet.foot(h('button.btn', { on: { click: () => sheet.close() } }, '取消'), save);
    },

    login(name) {
      void CF.openTerminal(name + ' · 登录', '在浏览器里完成授权，需要时把授权码粘贴到这里。完成后关闭即可。', (cols, rows) =>
        CF.api('POST', 'accounts/' + name + '/login', { cols, rows })).then(() => CF.app.refreshAccounts());
    },

    editEnv(account) {
      const env = envEditor(account.envKeys);
      const sheet = CF.sheet({ title: account.name + ' · 环境变量', subtitle: '已有的值不会显示。修改后重启该账号的项目生效。' }, () => env.node);
      const save = h('button.btn.primary', { on: { click: () => CF.busy(save, async () => {
        try {
          await CF.api('PUT', 'accounts/' + account.name + '/env', { values: env.values() });
          sheet.close();
          await CF.app.refreshAccounts();
        } catch (error) { sheet.error(error); }
      }) } }, '保存');
      sheet.foot(h('button.btn', { on: { click: () => sheet.close() } }, '取消'), save);
    },

    mount(container) {
      const { accounts } = CF.state;
      const row = account => {
        const menuButton = h('button.btn.ghost.icon.small', { title: '更多', on: { click: () => CF.menu(menuButton, [
          account.auth === 'env' ? { label: '编辑环境变量', icon: 'key', run: () => CF.accounts.editEnv(account) } : { label: '重新登录', icon: 'user', run: () => CF.accounts.login(account.name) },
          account.usage ? { label: '刷新额度', icon: 'spark', run: () => refreshUsage(account) } : null,
          '-',
          { label: '删除账号', icon: 'trash', danger: true, run: async () => {
            if (account.projects.length) { CF.toast('先删除使用这个账号的项目：' + account.projects.join('、'), { error: true }); return; }
            if (!await CF.confirm('删除账号 ' + account.name + '？', '只从配置里移除，登录数据会保留在工作区的 accounts 目录。', { danger: true, label: '删除' })) return;
            await CF.busy(null, async () => { await CF.api('DELETE', 'accounts/' + account.name); await CF.app.refreshAccounts(); });
          } },
        ].filter(Boolean)) } }, CF.icon('more', 15));
        const authText = account.auth === 'env'
          ? (account.envKeys.length ? '环境变量 · ' + account.envKeys.join('、') : '环境变量 · 未设置')
          : '登录账号';
        const needsSetup = account.auth === 'env' ? !account.envKeys.length : !account.hasLogin;
        return h('li.row',
          h('div.row-lead',
            h('span.row-avatar.' + account.type, account.typeLabel.slice(0, 1)),
            h('div.row-main',
              h('div.row-title', h('span.name', account.name), CF.typeBadge(account.type, account.typeLabel),
                needsSetup ? h('span.badge.amber', account.auth === 'env' ? '未配置' : '未登录') : null),
              h('div.row-sub', h('span', authText), h('span.sep'), h('span', account.proxy === 'off' ? '直连' : '经 relay'),
                h('span.sep'), h('span', account.projects.length ? '项目：' + account.projects.join('、') : '没有项目')),
              usageLine(account))),
          h('div.row-actions',
            account.auth === 'login'
              ? h('button.btn.small' + (account.hasLogin ? '' : '.soft'), { on: { click: () => CF.accounts.login(account.name) } }, CF.icon('user', 13), account.hasLogin ? '重新登录' : '登录')
              : h('button.btn.small', { on: { click: () => CF.accounts.editEnv(account) } }, CF.icon('key', 13), '变量'),
            menuButton));
      };
      container.replaceChildren(h('div.page', h('div.page-inner',
        h('div.page-head', h('div', h('div.eyebrow', accounts.length + ' 个账号'), h('h1', '账号'), h('p', '多个账号的额度一起用，凭据和网络互相隔离。')),
          h('button.btn.primary', { on: { click: () => CF.accounts.create() } }, CF.icon('plus', 14), '添加账号')),
        accounts.length
          ? h('div.card', h('div.card-head', h('h2', '全部账号')), h('ul.list', accounts.map(row)))
          : h('div.card', h('div.empty', h('div.glyph', CF.icon('user', 22)), h('h3', '还没有账号'),
            h('p', '添加 Claude Code、Codex 或 Antigravity 账号，然后登录。'),
            h('button.btn.primary', { on: { click: () => CF.accounts.create() } }, CF.icon('plus', 14), '添加账号'))),
      )));
    },
  };
})();
