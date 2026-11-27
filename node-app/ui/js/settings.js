'use strict';
// Settings: backend connections, workspace, image, proxy and container options.
(() => {
  const CF = window.CF;
  const { h } = CF;

  const LABELS = {
    PROXY_HOST: ['宿主机代理地址', '容器经 relay 转发到这个地址，一般是 host.docker.internal'],
    PROXY_HTTP_PORT: ['代理端口', '本机 Clash / V2Ray 等代理的 HTTP 端口'],
    CONTAINER_TIMEZONE: ['容器时区', '例如 Asia/Shanghai'],
    BUILD_PLATFORM: ['镜像平台', '下载镜像时自动设置；自己构建时 Apple 芯片用 linux/arm64'],
    IMAGE_NAME: ['镜像名', ''],
    IMAGE_TAG: ['镜像标签', ''],
    IMAGE_SOURCE: ['镜像下载地址', '下载慢时可以换成镜像站的地址'],
  };

  /** Starts a build, or shows the running one: the build continues in the background either way. */
  async function build(button) {
    const operation = await CF.busy(button, () => CF.api('POST', 'image/build'));
    if (!operation) return;
    CF.operationLog(operation, '构建镜像');
    CF.activity.refresh();
  }

  /** Downloads the published image instead of building it; also continues in the background. */
  async function pull(button) {
    const operation = await CF.busy(button, () => CF.api('POST', 'image/pull'));
    if (!operation) return;
    CF.operationLog(operation, '下载镜像');
    CF.activity.refresh();
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
    imageBanner: () => h('div.banner', h('span.banner-icon', CF.icon('box', 16)), h('div.text', h('strong', '还没有容器镜像'), h('span', '下载现成的最省事；也可以在这台机器上自己构建。')),
      h('div.btn-row', h('button.btn.ghost.small', { on: { click: event => build(event.currentTarget) } }, '自己构建'),
        h('button.btn.primary.small', { on: { click: event => pull(event.currentTarget) } }, CF.icon('box', 13), '下载镜像'))),

    async mount(container) {
      const { overview, profiles, backendId } = CF.state;
      const page = h('div.page-inner', h('div.page-head', h('div', h('div.eyebrow', '连接、手机、显示'), h('h1', '通用'))));
      container.replaceChildren(h('div.page', page));
      const notice = CF.pythonNotice(overview);
      if (notice) page.append(notice);

      // Connections
      const current = profiles.find(item => item.id === backendId);
      let bundle = '';
      let appVersion = '';
      try { const info = await CF.transport.bundle?.(); bundle = info?.version || ''; appVersion = info?.app || ''; } catch { /* no bundle in development */ }
      // An SSH backend installed by an older App lacks what this App expects (background tasks, the machine helper…).
      const older = profile => profile.kind === 'ssh' && profile.version && appVersion
        && profile.version.localeCompare(appVersion, undefined, { numeric: true }) < 0;
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
              profile.id === backendId ? h('span.badge' + (CF.state.connected ? '.green' : ''), CF.state.connected ? '已连接' : '当前') : null,
              older(profile) ? h('span.badge.amber', { title: '后端比 App（' + appVersion + '）旧，后台任务、机器助手等新功能在它上面用不了；升级后端后恢复' }, '比 App 旧') : null),
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

      // Display: the time zone times are shown in (this computer only).
      const zoneLabel = () => (CF.timeZone.chosen() ? CF.timeZone.chosen() : '跟随系统（' + CF.timeZone.system() + '）') + ' · ' + CF.timeZone.offset(CF.timeZone.current());
      const zoneButton = h('button.btn.small.zone-button', { on: { click: () => {
        const chosen = CF.timeZone.chosen();
        const items = [
          { id: '', label: '跟随系统', hint: CF.timeZone.system() + ' · ' + CF.timeZone.offset(CF.timeZone.system()), selected: !chosen },
          ...CF.timeZone.all().map(zone => ({ id: zone, label: zone, hint: CF.timeZone.offset(zone), selected: zone === chosen })),
        ];
        CF.picker(zoneButton, { items, placeholder: '搜索时区，例如 Shanghai、New_York', empty: '没有这个时区', onPick: item => {
          CF.timeZone.set(item.id);
          zoneButton.replaceChildren(zoneLabel());
          CF.app.rerender();
          CF.chat.redraw();
          CF.toast('时间按 ' + (item.id || '系统时区') + ' 显示');
        } });
      } } }, zoneLabel());
      page.append(h('div.card',
        h('div.card-head', h('div', h('h2', '显示'), h('p', '只影响这台电脑上 App 里显示的时间；容器里的时区在最下面「高级」里设置。'))),
        h('div.card-body', h('dl.kv', h('dt', '时区'), h('dd', zoneButton), ...(CF.transport?.testNotification ? [
          h('dt', '通知'),
          h('dd', h('button.btn.small', { on: { click: async () => {
            let result;
            try { result = await CF.transport.testNotification(); } catch (error) { CF.fail(error); return; }
            if (result.ok) CF.toast('已发出，没看到的话请到系统设置的「通知」里允许 CoderFleet');
            else CF.toast('通知没有发出：' + result.error, { error: true, timeout: 8000 });
          } } }, '发一条测试通知')),
        ] : [])))));

      if (!current || !overview) return;

      // Phones
      page.append(CF.mobileCard(current));

      // The settings file exists once the workspace is initialized.
      let values;
      if (overview.initialized) { try { values = await CF.get('settings'); } catch (error) { CF.fail(error); } }

      // Translation & titles
      if (values) {
        const LLM = {
          SYSTEM_LLM_PROVIDER: ['接口类型', 'anthropic 或 openai（OpenAI 兼容接口也选 openai）'],
          SYSTEM_LLM_MODEL: ['模型', '例如 claude-haiku-4-5'],
          SYSTEM_LLM_API_KEY: ['API Key', '只保存在工作区的 config.conf，不会再显示'],
          SYSTEM_LLM_BASE_URL: ['Base URL（可选）', '私有网关或兼容接口的地址'],
          SYSTEM_LLM_PROXY: ['出站代理（可选）', '例如 http://127.0.0.1:10808'],
        };
        const llmInputs = {};
        const llmFields = Object.entries(LLM).map(([key, [label, hint]]) => {
          llmInputs[key] = key === 'SYSTEM_LLM_PROVIDER'
            ? h('select', ['anthropic', 'openai'].map(value => h('option', { value, selected: values[key] === value }, value)))
            : h('input', { value: values[key] ?? '', spellcheck: false, type: key === 'SYSTEM_LLM_API_KEY' ? 'password' : 'text', autocomplete: 'off' });
          return h('label.field', h('span', label, hint ? h('span.hint', ' ' + hint) : null), llmInputs[key]);
        });
        const saveLlm = h('button.btn.primary.small', { on: { click: () => CF.busy(saveLlm, async () => {
          await CF.api('PUT', 'settings', Object.fromEntries(Object.entries(llmInputs).map(([key, input]) => [key, input.value.trim()])));
          CF.chat.translationChanged();
          CF.toast('已保存：新对话会自动起标题，回答下面会出现「翻译」');
        }) } }, '保存');
        page.append(h('div.card',
          h('div.card-head', h('div', h('h2', '翻译与命名'), h('p', '用来把回答翻译成中文、给对话自动起标题。用这里配置的模型，不占用项目账号的额度；和原服务共用同一份设置。')), saveLlm),
          h('div.card-body', h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:0 18px' }, llmFields))));
      }

      // Machine helper: managed by the backend on its own machine.
      page.append(CF.helperCard());

      // Advanced: what is set up once and then left alone. Open while something there still needs doing.
      const advanced = h('details.advanced', { open: !overview.initialized || !overview.docker || !overview.image?.exists },
        h('summary', h('strong', '高级'), h('span', '工作区、Docker、容器镜像和代理，一般不用改')));
      page.append(advanced);

      // Workspace & image
      let image = overview.image;
      // These parts follow background operations live; the rest of the page (and what is typed in it) stays.
      const buildButton = overview.initialized && overview.docker ? h('button.btn.small', { on: { click: event => build(event.currentTarget) } }) : null;
      const pullButton = buildButton ? h('button.btn.small', { on: { click: event => pull(event.currentTarget) } }) : null;
      const imageValue = h('dd');
      // The name and tag are edited in the card below; here only whether it is there (and the name, before there are settings).
      const drawImage = () => imageValue.replaceChildren(...(image ? [...(overview.initialized ? [] : [h('span.mono', image.name), ' · ']), image.exists ? '已就绪' : '还没有'] : ['—']));
      let lastBuild = '';
      // A download sets the image platform: the field below must not keep (and later save) the old one.
      let syncPlatform = () => undefined;
      const drawOperations = operations => {
        if (!page.isConnected && lastBuild) return false;
        const building = operations.find(item => item.kind === 'build' && item.status === 'running');
        const pulling = operations.find(item => item.kind === 'pull' && item.status === 'running');
        if (buildButton) buildButton.replaceChildren(...(building
          ? [h('span.spinner'), '构建中 · ' + CF.operationProgress(building)]
          : [image?.exists ? '重新构建' : '自己构建']));
        if (pullButton) pullButton.replaceChildren(...(pulling
          ? [h('span.spinner'), '下载中 · ' + CF.operationProgress(pulling)]
          : [CF.icon('box', 13), image?.exists ? '重新下载镜像' : '下载镜像']));
        // A build or download just finished: read the image state (and the platform it set) again.
        const latest = operations.find(item => item.kind === 'build' || item.kind === 'pull');
        const key = latest ? latest.id + latest.status : '';
        if (lastBuild && key !== lastBuild && latest?.status !== 'running') {
          void CF.get('overview').then(next => { CF.state.overview = next; image = next.image; drawImage(); }).catch(() => undefined);
          if (latest?.kind === 'pull') syncPlatform();
        }
        lastBuild = key || 'none';
        return true;
      };
      drawImage();
      drawOperations(CF.activity.list().length ? CF.activity.list() : overview.operations);
      const unsubscribe = CF.activity.subscribe(operations => { if (!drawOperations(operations)) unsubscribe(); });
      advanced.append(h('div.card',
        h('div.card-head', h('h2', '工作区与镜像'),
          h('div.btn-row',
            overview.initialized ? null : h('button.btn.small.primary', { on: { click: event => init(event.currentTarget) } }, '初始化工作区'),
            buildButton, pullButton)),
        h('div.card-body', h('dl.kv',
          h('dt', '工作区'), h('dd.mono', overview.workspace),
          h('dt', 'Docker'), h('dd', overview.docker ? '已连接 · ' + overview.docker : '未连接'),
          h('dt', '镜像'), imageValue))));

      // Proxy & containers
      if (!values) return;
      const inputs = {};
      const fields = Object.entries(LABELS).map(([key, [label, hint]]) => {
        inputs[key] = h('input', { value: values[key] ?? '', spellcheck: false });
        return h('label.field', h('span', label, hint ? h('span.hint', ' ' + hint) : null), inputs[key]);
      });
      syncPlatform = () => void CF.get('settings').then(next => { inputs.BUILD_PLATFORM.value = next.BUILD_PLATFORM; }).catch(() => undefined);
      const save = h('button.btn.primary.small', { on: { click: () => CF.busy(save, async () => {
        await CF.api('PUT', 'settings', Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value.trim()])));
        CF.toast('已保存，重启项目后生效');
        await CF.app.refreshOverview();
      }) } }, '保存');
      advanced.append(h('div.card',
        h('div.card-head', h('h2', '代理与容器'), save),
        h('div.card-body', h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:0 18px' }, fields))));
    },
  };
})();
