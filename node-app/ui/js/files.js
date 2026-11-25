'use strict';
// The project's files beside a conversation (the Python Web UI's 文件 panel):
// folders one level at a time with a path bar, text and image previews, and
// saving a copy or copying the path to mention it in a message.
(() => {
  const CF = window.CF;
  const h = CF.h;
  const COLORS = {
    js: '#d4b106', mjs: '#d4b106', cjs: '#d4b106', ts: '#3178c6', tsx: '#3178c6', jsx: '#3aa8c9', py: '#3572a5', css: '#663399', html: '#e34c26',
    json: '#b59a00', md: '#4a90d9', sh: '#4caf50', yaml: '#cb171e', yml: '#cb171e', toml: '#9c4221', go: '#00acd7', rs: '#ce422b', java: '#b07219', dart: '#0175c2',
    png: '#9b59b6', jpg: '#9b59b6', jpeg: '#9b59b6', gif: '#9b59b6', webp: '#9b59b6', svg: '#e67e22',
  };
  const size = value => value == null ? '' : value < 1024 ? value + ' B' : value < 1048576 ? (value / 1024).toFixed(value < 10240 ? 1 : 0) + ' KB' : (value / 1048576).toFixed(1) + ' MB';
  const query = (projectId, kind, path) => 'projects/' + encodeURIComponent(projectId) + '/files' + kind + '?path=' + encodeURIComponent(path);

  /** Remembers the folder per project while the App runs. */
  const folders = new Map();

  async function save(projectId, path) {
    const file = await CF.get(query(projectId, '/raw', path));
    const bytes = Uint8Array.from(atob(file.data), char => char.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes]));
    const link = h('a', { href: url, download: file.name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  function preview(projectId, entry) {
    const body = h('div.file-preview', h('div.empty-note', '正在读取…'));
    const sheet = CF.sheet({ title: entry.name, subtitle: entry.path + (entry.size != null ? ' · ' + size(entry.size) : ''), wide: true }, () => body);
    const saveButton = h('button.btn', { on: { click: () => CF.busy(saveButton, () => save(projectId, entry.path)) } }, '保存到本机');
    const copyButton = h('button.btn', { on: { click: async () => {
      await navigator.clipboard.writeText('/workspace/' + entry.path);
      CF.toast('已复制路径，可以粘贴到消息里');
    } } }, '复制路径');
    sheet.foot(copyButton, saveButton);
    CF.get(query(projectId, '/preview', entry.path)).then(result => {
      if (result.kind === 'image') body.replaceChildren(h('img.preview-full', { src: 'data:' + result.mime + ';base64,' + result.data, alt: '' }));
      else if (result.kind === 'binary') body.replaceChildren(h('div.empty-note', '这是二进制文件，不能预览。可以保存到本机后打开。'));
      else {
        const markdown = /\.(md|markdown)$/i.test(entry.name);
        body.replaceChildren(
          markdown ? h('div.markdown.file-markdown', CF.markdown(result.content)) : h('pre.file-text', result.content),
          result.truncated ? h('div.empty-note', '只显示了前 512 KB。') : null);
      }
    }).catch(error => body.replaceChildren(h('div.empty-note', '读取失败：' + CF.errorText(error))));
  }

  /** The panel for `projectId`; `onClose` hides it. */
  function panel(projectId, onClose) {
    const crumbs = h('div.files-crumbs');
    const list = h('div.files-list');
    const filterInput = h('input', { type: 'search', placeholder: '筛选当前文件夹', 'aria-label': '筛选文件' });
    let entries = [];
    let path = folders.get(projectId) || '';

    const render = () => {
      const needle = filterInput.value.trim().toLowerCase();
      const shown = needle ? entries.filter(entry => entry.name.toLowerCase().includes(needle)) : entries;
      list.replaceChildren(
        path ? h('button.file-row.up', { on: { click: () => open(path.split('/').slice(0, -1).join('/')) } }, CF.icon('chevron', 12), h('span.name', '上一级')) : null,
        ...shown.map(entry => {
          const extension = /\.([A-Za-z0-9]+)$/.exec(entry.name)?.[1]?.toLowerCase() || '';
          return h('button.file-row' + (entry.isDir ? '.dir' : ''), {
            title: entry.path, on: { click: () => entry.isDir ? open(entry.path) : preview(projectId, entry) },
          }, h('span.file-glyph', { style: entry.isDir ? '' : 'color:' + (COLORS[extension] || 'var(--text-3)') }, CF.icon(entry.isDir ? 'folder' : 'file', 14)),
          h('span.name', entry.name), entry.isDir ? CF.icon('chevron', 11) : h('span.size', size(entry.size)));
        }),
        !shown.length ? h('div.empty-note', needle ? '没有匹配的文件。' : '空文件夹。') : null);
    };

    const open = async next => {
      path = next;
      folders.set(projectId, path);
      filterInput.value = '';
      const parts = path ? path.split('/') : [];
      crumbs.replaceChildren(
        path ? h('button.crumb', { title: '项目根目录', on: { click: () => open('') } }, '根目录') : h('span.crumb.current', '根目录'),
        ...parts.flatMap((part, index) => [h('span.sep', '/'), index === parts.length - 1
          ? h('span.crumb.current', part)
          : h('button.crumb', { on: { click: () => open(parts.slice(0, index + 1).join('/')) } }, part)]));
      list.replaceChildren(h('div.empty-note', '正在读取…'));
      try {
        entries = await CF.get(query(projectId, '', path));
        if (path === next) render();
      } catch (error) {
        if (path && /不存在|不是目录/.test(CF.errorText(error))) { void open(''); return; }
        list.replaceChildren(h('div.empty-note', '读取失败：' + CF.errorText(error)));
      }
    };
    filterInput.addEventListener('input', render);

    const node = h('aside.files-panel', { 'aria-label': '项目文件' },
      h('div.files-head', h('strong', '文件'), h('span.project', CF.state.projects.find(item => item.id === projectId)?.name || projectId),
        h('button.icon-btn', { title: '刷新', on: { click: () => open(path) } }, CF.icon('restart', 13)),
        h('button.icon-btn', { title: '关闭', on: { click: onClose } }, CF.icon('x', 13))),
      crumbs, h('label.files-filter', CF.icon('search', 13), filterInput), list);
    void open(path);
    return node;
  }

  CF.files = { panel, preview, save };
})();
