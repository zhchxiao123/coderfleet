'use strict';
// Settings: backend connections, workspace, image, proxy and container options.
(() => {
  const CF = window.CF;
  const { h } = CF;

  const LABELS = {
    PROXY_HOST: ['宿主机代理地址', '容器经 relay 转发到这个地址，一般是 host.docker.internal'],
    PROXY_HTTP_PORT: ['代理端口', '本机 Clash / V2Ray 等代理的 HTTP 端口'],
    CONTAINER_TIMEZONE: ['容器时区', '例如 Asia/Shanghai'],
    BUILD_PLATFORM: ['镜像平台', 'Apple 芯片用 linux/arm64，Intel 用 linux/amd64'],
    IMAGE_NAME: ['镜像名', ''],
    IMAGE_TAG: ['镜像标签', ''],
  };

  async function build(button) {
    const operation = await CF.busy(button, () => CF.api('POST', 'image/build'));
    if (operation) {
      CF.operationLog(operation, '构建镜像');
      void CF.trackOperation(operation, '构建镜像', () => undefined).then(() => CF.app.refreshOverview());
    }
  }

  async function init(button) {
    await CF.busy(button, async () => {
      await CF.api('POST', 'workspace/init');
      await CF.app.refreshOverview();
      CF.toast('工作区已准备好');
    });
  }

  CF.settings = {
    initBanner: () => h('div.banner', h('span.banner-icon', CF.icon('folder', 16)), h('div.text', h('strong', '工作区还没有初始化'), h('span', '会在 ' + (CF.state.overview?.workspace || '') + ' 创建配置和镜像构建文件。')),
      h('button.btn.primary.small', { on: { click: event => init(event.currentTarget) } }, '初始化')),
    imageBanner: () => h('div.banner', h('span.banner-icon', CF.icon('box', 16)), h('div.text', h('strong', '还没有容器镜像'), h('span', '第一次构建需要几分钟。')),
      h('button.btn.primary.small', { on: { click: event => build(event.currentTarget) } }, CF.icon('box', 13), '构建镜像')),

    async mount(container) {
      const { overview, profiles, backendId } = CF.state;
      const page = h('div.page-inner', h('div.page-head', h('div', h('div.eyebrow', '连接、工作区与容器'), h('h1', '设置'))));
      container.replaceChildren(h('div.page', page));
      const notice = CF.pythonNotice(overview);
      if (notice) page.append(notice);

      // Connections
      const current = profiles.find(item => item.id === backendId);
      let bundle = '';
      try { bundle = (await CF.transport.bundle?.())?.version || ''; } catch { /* no bundle in development */ }
      const name = h('input', { placeholder: '名称', maxLength: 100 });
      const url = h('input', { type: 'url', placeholder: 'https://coderfleet.example.com' });
      const token = h('input', { type: 'password', placeholder: '服务令牌', autocomplete: 'off' });
      const addRemote = h('button.btn', { on: { click: () => CF.busy(addRemote, async () => {
        const id = await CF.transport.addRemote({ name: name.value, url: url.value, token: token.value });
        name.value = url.value = token.value = '';
        await CF.app.loadProfiles(id);
      }) } }, '添加');
      const addSsh = h('button.btn.primary.small', { on: { click: async () => {
        const result = await CF.addSshBackend();
        if (result?.id) await CF.app.loadProfiles(result.id);
      } } }, CF.icon('plus', 13), '通过 SSH 添加');
      const local = overview?.backend;
      const describe = profile => profile.kind === 'local'
        ? '这台电脑 · Node 后端' + (profile.id === backendId && local ? ' ' + local.build + ' · 端口 ' + local.port : '') + ' · 由 App 启动'
        : profile.kind === 'ssh' ? 'SSH · ' + profile.host + (profile.version ? ' · 后端 ' + profile.version : '') : '服务地址 · ' + profile.url;
      const reinstall = async (profile, button) => {
        const jobId = await CF.busy(button, () => CF.transport.reinstallSsh(profile.id));
        if (!jobId) return;
        const result = await CF.followJob(jobId, (profile.version && bundle && profile.version !== bundle ? '升级' : '重新安装') + '远程后端', profile.host);
        if (result?.id) await CF.app.loadProfiles(result.id);
      };
      page.append(h('div.card',
        h('div.card-head', h('div', h('h2', '后端连接'), h('p', '这台电脑，或通过 SSH 管理的远程 Linux 机器。')), addSsh),
        h('ul.list', profiles.map(profile => h('li.row',
          h('div.row-lead',
            h('span.row-avatar', profile.kind === 'ssh' ? CF.icon('terminal', 16) : profile.kind === 'local' ? CF.icon('box', 16) : CF.icon('link', 16)),
            h('div.row-main', h('div.row-title', h('span.name', profile.name),
              profile.id === backendId ? h('span.badge' + (CF.state.connected ? '.green' : ''), CF.state.connected ? '已连接' : '当前') : null),
              h('div.row-sub', h('span.path', describe(profile))))),
          h('div.row-actions',
            profile.kind === 'ssh' && profile.version && bundle && profile.version !== bundle
              ? h('button.btn.small.accent', { on: { click: event => reinstall(profile, event.currentTarget) } }, '升级到 ' + bundle) : null,
            profile.id === backendId ? null : h('button.btn.small', { on: { click: () => CF.app.loadProfiles(profile.id) } }, '切换'),
            profile.kind === 'local' && profile.id === backendId && CF.transport.restartLocal ? h('button.btn.small', { title: '重启本机后端；容器里正在运行的对话不受影响', on: { click: event => CF.busy(event.currentTarget, async () => {
              await CF.transport.restartLocal(profile.id);
              await CF.app.loadProfiles(profile.id);
              CF.toast('后端已重启');
            }) } }, CF.icon('restart', 13), '重启') : null,
            (() => {
              const more = h('button.btn.ghost.icon.small', { title: '更多', on: { click: () => CF.menu(more, [
                profile.kind === 'ssh' ? { label: '重启 / 重新安装后端', icon: 'restart', run: () => reinstall(profile, more) } : null,
                profile.kind === 'local' && CF.transport.restartLocal ? { label: '重启后端', icon: 'restart', run: () => CF.busy(more, async () => {
                  // Turns run in containers, so they keep going; the new backend picks them up.
                  await CF.transport.restartLocal(profile.id);
                  await CF.app.loadProfiles(profile.id);
                  CF.toast('后端已重启');
                }) } : null,
                { label: '移除连接', icon: 'trash', danger: true, run: async () => {
                  if (!await CF.confirm('移除连接 ' + profile.name + '？', '只移除 App 里保存的连接；那台机器上的后端和数据都会保留。', { danger: true, label: '移除' })) return;
                  await CF.transport.remove(profile.id);
                  await CF.app.loadProfiles(profile.id === backendId ? '' : backendId);
                } },
              ].filter(Boolean)) } }, CF.icon('more', 15));
              return more;
            })())))),
        h('details', { style: 'padding:4px 20px 16px' },
          h('summary', { style: 'color:var(--text-2);font-size:13px;cursor:default;padding:6px 0' }, '已有服务地址和令牌'),
          h('div', { style: 'display:grid;grid-template-columns:1fr 1.6fr 1fr auto;gap:8px;margin-top:8px' }, name, url, token, addRemote),
          h('p', { style: 'color:var(--text-3);font-size:12px;margin:8px 0 0' }, '用于已经自行部署、通过 HTTPS 提供的后端。令牌保存在系统钥匙串里。'))));

      if (!current || !overview) return;

      // Workspace & image
      const image = overview.image;
      page.append(h('div.card',
        h('div.card-head', h('h2', '工作区与镜像'),
          h('div.btn-row',
            overview.initialized ? null : h('button.btn.small.primary', { on: { click: event => init(event.currentTarget) } }, '初始化工作区'),
            overview.initialized && overview.docker ? h('button.btn.small', { on: { click: event => build(event.currentTarget) } }, CF.icon('box', 13), image?.exists ? '重新构建镜像' : '构建镜像') : null)),
        h('div.card-body', h('dl.kv',
          h('dt', '工作区'), h('dd.mono', overview.workspace),
          h('dt', 'Docker'), h('dd', overview.docker ? '已连接 · ' + overview.docker : '未连接'),
          h('dt', '镜像'), h('dd', image ? [h('span.mono', image.name), ' · ', image.exists ? '已构建' : '未构建'] : '—'),
          h('dt', '最近操作'), h('dd', overview.operations.length
            ? h('div', { style: 'display:grid;gap:4px' }, overview.operations.slice(0, 5).map(operation => h('button.btn.ghost.small', {
              style: 'justify-content:flex-start', on: { click: () => CF.operationLog(operation, operation.target) },
            }, h('span.dot' + (operation.status === 'failed' ? '.failed' : operation.status === 'running' ? '.busy' : '.running')),
              { build: '构建', start: '启动', stop: '停止', restart: '重启', remove: '删除' }[operation.kind] + ' ' + operation.target, h('span', { style: 'color:var(--text-3)' }, CF.relative(operation.startedAt)))))
            : '无')))));

      // Proxy & containers
      if (!overview.initialized) return;
      let values;
      try { values = await CF.get('settings'); } catch (error) { CF.fail(error); return; }
      const inputs = {};
      const fields = Object.entries(LABELS).map(([key, [label, hint]]) => {
        inputs[key] = h('input', { value: values[key] ?? '', spellcheck: false });
        return h('label.field', h('span', label, hint ? h('span.hint', ' ' + hint) : null), inputs[key]);
      });
      const save = h('button.btn.primary.small', { on: { click: () => CF.busy(save, async () => {
        await CF.api('PUT', 'settings', Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value.trim()])));
        CF.toast('已保存，重启项目后生效');
        await CF.app.refreshOverview();
      }) } }, '保存');
      page.append(h('div.card',
        h('div.card-head', h('h2', '代理与容器'), save),
        h('div.card-body', h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:0 18px' }, fields))));
    },
  };
})();
