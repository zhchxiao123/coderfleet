// The 机器助手 card in Settings: the separate program that lets tasks run listed
// commands on this machine. Install, start, stop and upgrade it here; which
// project may use it is set on the project (更多 → 机器操作).
(() => {
  const { h } = CF;

  const ACTIONS = { allow: '直接运行', confirm: '先问我', deny: '不允许' };

  /** The rules, as lines: what runs directly, what asks first. The file itself is edited by hand or with `helper policy`. */
  async function rules() {
    const holder = h('div', h('div.empty-note', '正在读取…'));
    const sheet = CF.sheet({ title: '机器助手 · 规则', subtitle: '没有列出的命令一律不运行。', wide: true }, () => holder);
    let answer;
    try { answer = await CF.get('helper/policy'); } catch (error) { holder.replaceChildren(); sheet.error(error); return; }
    const list = answer.policy?.rules || [];
    holder.replaceChildren(
      answer.error ? h('div.empty-note', '规则文件有错，所有命令都会被拒绝：' + answer.error) : list.length
        ? h('dl.kv', list.flatMap(rule => [h('dt.mono', [rule.program, ...(rule.args_any || [])].join(' ')), h('dd', ACTIONS[rule.action] || rule.action)]))
        : h('div.empty-note', '还没有规则，所以现在什么都不能运行。'),
      h('div.hint', '规则文件：' + (answer.file || '') + '。命令行里用 helper policy set <程序> allow|confirm|deny 添加。'));
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
      h('p', '让容器里的任务在这台机器上运行你列出的命令（比如烧录、读串口）。默认每个项目都是关的。'))), body);
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
