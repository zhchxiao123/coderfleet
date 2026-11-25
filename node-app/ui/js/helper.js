// The 机器助手 card in Settings: the separate program that lets tasks run listed
// commands on this machine. Install, start, stop and upgrade it here; which
// project may use it is set on the project (更多 → 机器操作).
(() => {
  const { h } = CF;

  const ACTIONS = { allow: '直接运行', confirm: '先问我', deny: '不允许' };

  const PROGRAM = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;
  const choice = (value, change) => {
    const select = h('select', { on: { change: () => change(select.value, select) } },
      Object.entries(ACTIONS).map(([key, label]) => h('option', { value: key }, label)));
    select.value = value;
    return select;
  };

  /**
   * The rules: everything runs unless it is switched off here. Each change is
   * saved as it is made; only the list is redrawn, so what is being typed in the
   * form below it stays.
   */
  async function rules() {
    const holder = h('div', h('div.empty-note', '正在读取…'));
    const sheet = CF.sheet({ title: '机器助手 · 规则', subtitle: '默认什么命令都能运行；不想让它用的，在这里关掉。', wide: true }, () => holder);
    let answer;
    try { answer = await CF.get('helper/policy'); } catch (error) { holder.replaceChildren(); sheet.error(error); return; }
    if (answer.error) { holder.replaceChildren(h('div.empty-note', '规则文件有错，所有命令都会被拒绝：' + answer.error), h('div.hint', '文件：' + (answer.file || ''))); return; }

    const list = h('div.rule-list');
    const rest = choice('allow', (value, node) => change({ unlisted: value }, node));
    const folders = h('textarea', { rows: 4, spellcheck: false });
    /** Sends one change; the answer is the whole rules file as it now is. */
    const change = async (body, node) => {
      sheet.error('');
      if (node) node.disabled = true;
      try { show((await CF.api('POST', 'helper/policy', body)).policy); return true; }
      catch (error) { sheet.error(error); show(shown); return false; }
      finally { if (node) node.disabled = false; }
    };
    let shown;
    const show = policy => {
      shown = policy;
      rest.value = policy.unlisted;
      list.replaceChildren(...(policy.rules.length ? policy.rules.map(rule => {
        const key = { program: rule.program, ...(rule.args_any ? { args_any: rule.args_any } : {}) };
        return h('div.rule', h('div.rule-name', h('span.mono', rule.program), rule.args_any ? h('span.hint', ' 带 ' + rule.args_any.join('、') + ' 时') : null),
          choice(rule.action, (value, node) => change({ set: { ...key, action: value } }, node)),
          h('button.icon-btn', { title: '删除这条', on: { click: event => change({ remove: key }, event.currentTarget) } }, CF.icon('x', 14)));
      }) : [h('div.empty-note', '还没有单独设置的命令。')]));
    };

    const program = h('input', { placeholder: '程序名，例如 rm', spellcheck: false });
    const words = h('input', { placeholder: '只在带这些词时（可不填，用空格分开）', spellcheck: false });
    const action = choice('deny', () => undefined);
    const add = h('button.btn.small.primary', { on: { click: async () => {
      const name = program.value.trim();
      if (!PROGRAM.test(name)) { sheet.error('程序名只写名字本身，不带路径和空格，例如 rm。'); program.focus(); return; }
      const narrowed = words.value.trim().split(/\s+/).filter(Boolean);
      if (await change({ set: { program: name, action: action.value, ...(narrowed.length ? { args_any: narrowed } : {}) } }, add)) { program.value = ''; words.value = ''; }
    } } }, '添加');
    const saveFolders = h('button.btn.small', { on: { click: async () => {
      const lines = folders.value.split('\n').map(line => line.trim()).filter(Boolean);
      if (!lines.length || lines.some(line => !line.startsWith('/'))) { sheet.error('每行写一个目录的完整路径，以 / 开头。'); return; }
      if (await change({ path: lines }, saveFolders)) { folders.value = shown.path.join('\n'); CF.toast('已保存'); }
    } } }, '保存');

    show(answer.policy);
    folders.value = answer.policy.path.join('\n');
    holder.replaceChildren(
      h('label.field', h('span', '没有单独设置的命令'), rest),
      h('div.field', h('span', '单独设置的命令'), list, h('div.rule-add', program, words, action, add)),
      h('details.rule-more', h('summary', '去哪些目录找程序'),
        h('div.field', h('span.hint', '每行一个目录。任务只写程序名，机器助手按顺序在这些目录里找。'), folders, h('div', saveFolders))),
      h('p.sheet-note', 'sudo、烧写 efuse 这几类操作不管怎么设置都不会运行。'));
  }

  /** The latest calls, newest first. */
  async function audit() {
    const holder = h('div', h('div.empty-note', '正在读取…'));
    const sheet = CF.sheet({ title: '机器助手 · 最近的操作', wide: true }, () => holder);
    let answer;
    try { answer = await CF.get('helper/audit?n=50'); } catch (error) { holder.replaceChildren(); sheet.error(error); return; }
    const records = (answer.records || []).slice().reverse();
    holder.replaceChildren(records.length ? h('dl.kv', records.flatMap(item => [
      h('dt', CF.relative(item.time)),
      h('dd', h('span.mono', item.args?.argv ? item.args.argv.join(' ') : item.tool), ' · ' + (item.label || item.task) + ' · '
        + (item.verdict === 'deny' ? '没有运行' : item.exit_code === undefined ? '已放行' : '退出码 ' + item.exit_code)),
    ])) : h('div.empty-note', '还没有操作。'));
  }

  CF.helperCard = () => {
    const body = h('div.card-body', h('div.empty-note', '正在读取…'));
    const card = h('div.card', h('div.card-head', h('div', h('h2', '机器助手'),
      h('p', '让容器里的任务在这台机器上运行命令（比如编译、烧录、读串口）。哪个项目能用，在项目的「更多」里打开。'))), body);
    const act = (button, path, done) => CF.busy(button, async () => {
      const result = await CF.api('POST', 'helper/' + path);
      if (path === 'restart-relay') { CF.operationLog(result, '重启 relay'); CF.activity.refresh(); return; }
      render(result);
      CF.toast(done);
    });
    const button = (label, path, done, primary) => {
      const node = h('button.btn.small' + (primary ? '.primary' : ''), { on: { click: () => act(node, path, done) } }, label);
      return node;
    };
    const render = status => {
      const state = !status.installed ? '没有安装' : !status.running ? '已安装，没有运行'
        : !status.compatible ? '在运行，但版本太旧，任务用不了' : '在运行 · ' + status.version;
      const actions = !status.installed ? [button('安装并启动', 'install', '机器助手已安装', true)]
        : !status.running ? [button('启动', 'start', '机器助手已启动', true), ...(status.upgrade ? [button('升级到 ' + status.bundled, 'upgrade', '已升级')] : [])]
        : [...(status.upgrade ? [button('升级到 ' + status.bundled, 'upgrade', '已升级', true)] : []), button('停止', 'stop', '机器助手已停止')];
      body.replaceChildren(h('dl.kv',
        h('dt', '状态'), h('dd', state, ' ', ...actions),
        ...(status.policyError ? [h('dt', '规则'), h('dd', '规则文件有错，所有命令都会被拒绝：' + status.policyError)] : []),
        ...(status.running && status.relay === 'missing' ? [h('dt', '容器连接'),
          h('dd', 'relay 还没有转发到机器助手，容器里的任务连不上。 ', button('重启 relay', 'restart-relay', ''))] : []),
        ...(status.running && status.relay === 'stopped' ? [h('dt', '容器连接'), h('dd', 'relay 没有在运行，启动一个走 relay 的项目后就有了。')] : []),
        ...(status.installed ? [h('dt', '查看'), h('dd',
          h('button.btn.ghost.small', { disabled: !status.running, on: { click: rules } }, '规则'),
          h('button.btn.ghost.small', { disabled: !status.running, on: { click: audit } }, '最近的操作'))] : [])));
    };
    CF.get('helper').then(render, error => body.replaceChildren(h('div.empty-note', '读取失败：' + CF.errorText(error))));
    return card;
  };
})();
