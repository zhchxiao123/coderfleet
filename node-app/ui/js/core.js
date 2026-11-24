'use strict';
// Shared renderer helpers: DOM building, backend calls, icons, toasts, menus
// and sheets. Everything hangs off window.CF; the scripts load in order.
(() => {
  const CF = window.CF = {};
  // replaceChildren/append turn null into the text "null"; views pass optional parts, so skip them.
  for (const method of ['replaceChildren', 'append']) {
    const original = Element.prototype[method];
    Element.prototype[method] = function (...nodes) { return original.apply(this, nodes.filter(node => node !== null && node !== undefined && node !== false)); };
  }
  const transport = window.coderFleet;
  CF.transport = transport;
  CF.state = {
    backendId: '', profiles: [], overview: null, projects: [], accounts: [], conversations: [],
    view: { name: 'loading' }, connected: false,
  };

  /** h('div.class#id', { attrs, on: { click } }, ...children) */
  CF.h = (tag, props, ...children) => {
    const [name, ...rest] = tag.split(/(?=[.#])/);
    const element = document.createElement(name || 'div');
    for (const part of rest) {
      if (part.startsWith('.')) element.classList.add(part.slice(1));
      else element.id = part.slice(1);
    }
    if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) children.unshift(props);
    else if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'on') for (const [event, handler] of Object.entries(value)) element.addEventListener(event, handler);
        else if (key === 'class') element.className = value;
        else if (key === 'dataset') Object.assign(element.dataset, value);
        else if (key in element && key !== 'list' && key !== 'form') element[key] = value;
        else element.setAttribute(key, value === true ? '' : value);
      }
    }
    for (const child of children.flat(Infinity)) {
      if (child === undefined || child === null || child === false) continue;
      element.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return element;
  };
  const h = CF.h;

  const ICONS = {
    plus: '<path d="M8 3v10M3 8h10"/>',
    image: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1.1"/><path d="M13.5 10.5 10.5 7.5 4 13"/>',
    bolt: '<path d="M9 2 3.5 9H8l-1 5 5.5-7H8z"/>',
    chat: '<path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H7l-3 2.5V11h0A1.5 1.5 0 0 1 3 9.5z"/>',
    folder: '<path d="M2.5 4.5A1.5 1.5 0 0 1 4 3h2.4l1.4 1.5H12A1.5 1.5 0 0 1 13.5 6v5.5A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5z"/>',
    user: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5c.6-2.4 2.6-3.8 5-3.8s4.4 1.4 5 3.8"/>',
    gear: '<circle cx="8" cy="8" r="2"/><path d="M8 1.8v1.7M8 12.5v1.7M14.2 8h-1.7M3.5 8H1.8M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2M12.4 12.4l-1.2-1.2M4.8 4.8 3.6 3.6"/>',
    play: '<path d="M5 3.5v9l7.5-4.5z"/>',
    stop: '<rect x="4" y="4" width="8" height="8" rx="1.5"/>',
    restart: '<path d="M3 8a5 5 0 1 0 1.6-3.7M3 3v2.6h2.6"/>',
    terminal: '<rect x="2" y="3" width="12" height="10" rx="1.8"/><path d="m5 6.5 2 1.5-2 1.5M8.5 10H11"/>',
    more: '<circle cx="4" cy="8" r=".9"/><circle cx="8" cy="8" r=".9"/><circle cx="12" cy="8" r=".9"/>',
    trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
    send: '<path d="M8 13V3.5M3.8 7.5 8 3.3l4.2 4.2"/>',
    square: '<rect x="4.5" y="4.5" width="7" height="7" rx="1.2"/>',
    check: '<path d="m3.5 8.5 3 3 6-7"/>',
    x: '<path d="m4 4 8 8M12 4l-8 8"/>',
    chevron: '<path d="m6 4 4 4-4 4"/>',
    down: '<path d="m4 6 4 4 4-4"/>',
    key: '<circle cx="5.5" cy="10.5" r="2.5"/><path d="m7.3 8.7 5.2-5.2M10.5 5.5l1.5 1.5"/>',
    shield: '<path d="M8 2 3 4v4c0 3 2.2 5.2 5 6 2.8-.8 5-3 5-6V4z"/>',
    box: '<path d="m8 2 5.5 3v6L8 14l-5.5-3V5zM2.5 5 8 8l5.5-3M8 8v6"/>',
    tool: '<path d="M10.5 2.5a3 3 0 0 0-2.9 3.8L3 10.9 5.1 13l4.6-4.6a3 3 0 0 0 3.8-2.9l-1.7 1.7-2-.6-.6-2z"/>',
    question: '<circle cx="8" cy="8" r="5.5"/><path d="M6.4 6.3a1.7 1.7 0 1 1 2.3 1.6c-.5.2-.7.6-.7 1.1M8 11h0"/>',
    block: '<circle cx="8" cy="8" r="5"/><path d="m4.5 11.5 7-7"/>',
    dash: '<path d="M4.5 8h7"/>',
    compose: '<path d="M8.5 3H4.5A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13h7a1.5 1.5 0 0 0 1.5-1.5V7.5"/><path d="m7 9 .5-2L12 2.5a1.4 1.4 0 0 1 2 2L9.5 9 7.5 9.5z"/>',
    search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>',
    spark: '<path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3M4.2 4.2l1.6 1.6M10.2 10.2l1.6 1.6M11.8 4.2l-1.6 1.6M5.8 10.2l-1.6 1.6"/>',
    link: '<path d="M6.5 9.5 9.5 6.5M7 4.5 8.2 3.3a2.5 2.5 0 0 1 3.5 3.5L10.5 8M9 11.5l-1.2 1.2a2.5 2.5 0 0 1-3.5-3.5L5.5 8"/>',
  };
  CF.icon = (name, size = 16) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', size); svg.setAttribute('height', size);
    svg.setAttribute('fill', name === 'play' || name === 'more' ? 'currentColor' : 'none');
    svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICONS[name] || '';
    return svg;
  };

  CF.errorText = error => String(error && error.message || error || '')
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  /** A backend call on the selected backend. */
  CF.api = (method, path, body) => transport.request(CF.state.backendId, method, '/v1/' + path, body);
  CF.get = path => CF.api('GET', path);

  CF.toast = (text, { error = false, action, timeout = 3800 } = {}) => {
    const node = h('div.toast' + (error ? '.error' : ''), { role: 'status' }, h('span', text));
    if (action) node.append(h('button', { on: { click: () => { action.run(); node.remove(); } } }, action.label));
    document.getElementById('toasts').append(node);
    setTimeout(() => node.remove(), timeout);
  };
  CF.fail = error => CF.toast(CF.errorText(error), { error: true, timeout: 6000 });

  /** Runs an async action while disabling `button`. */
  CF.busy = async (button, action) => {
    if (button) button.disabled = true;
    try { return await action(); }
    catch (error) { CF.fail(error); return undefined; }
    finally { if (button) button.disabled = false; }
  };

  let openMenu;
  CF.menu = (anchor, items) => {
    openMenu?.remove();
    const menu = h('div.menu', { role: 'menu' });
    for (const item of items) {
      if (item === '-') { menu.append(h('hr')); continue; }
      menu.append(h('button' + (item.danger ? '.danger' : ''), { role: 'menuitem', on: { click: () => { menu.remove(); item.run(); } } },
        item.icon ? CF.icon(item.icon, 14) : null, item.label));
    }
    document.body.append(menu);
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth;
    menu.style.top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8)) + 'px';
    menu.style.left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) + 'px';
    openMenu = menu;
    setTimeout(() => document.addEventListener('click', function close(event) {
      if (!menu.contains(event.target)) { menu.remove(); document.removeEventListener('click', close); }
    }), 0);
  };

  /** Project uploads as data URLs, fetched once each (the backend sends them as base64). */
  const uploadCache = new Map();
  CF.uploadUrl = (projectId, path) => {
    const key = projectId + ':' + path;
    if (!uploadCache.has(key)) {
      const file = String(path).split('/').pop();
      uploadCache.set(key, CF.get('projects/' + encodeURIComponent(projectId) + '/uploads/' + file)
        .then(image => 'data:' + image.mime + ';base64,' + image.data)
        .catch(error => { uploadCache.delete(key); throw error; }));
    }
    return uploadCache.get(key);
  };
  CF.seedUpload = (projectId, path, url) => uploadCache.set(projectId + ':' + path, Promise.resolve(url));

  /** A thumbnail of a project upload; clicking opens it full size. */
  CF.uploadThumb = (projectId, path, extra) => {
    const img = h('img', { alt: '', loading: 'lazy' });
    const node = h('button.thumb', { title: '查看图片', on: { click: async () => {
      const url = await CF.uploadUrl(projectId, path);
      const sheet = CF.sheet({ title: '图片', wide: true }, () => h('img.preview-full', { src: url, alt: '' }));
      sheet.foot();
    } } }, img, extra);
    CF.uploadUrl(projectId, path).then(url => { img.src = url; }).catch(() => node.classList.add('broken'));
    return node;
  };

  /**
   * Warning shown while the original Python service runs on the same workspace:
   * both would pick up the same tasks, so the desktop App asks to stop it.
   */
  CF.pythonNotice = overview => {
    const python = overview?.python;
    if (!python) return null;
    const command = python.pid ? 'coderfleet server --stop' : '';
    const copy = command ? h('button.btn.small', { on: { click: async event => {
      await navigator.clipboard.writeText(command);
      event.currentTarget.textContent = '已复制';
    } } }, '复制命令') : null;
    return h('div.banner.python-notice',
      h('span.banner-icon', CF.icon('box', 16)),
      h('div.text',
        h('strong', '原来的 Python 服务也在用这个工作区'),
        h('span', '桌面版只用 Node 后端。两个同时运行会争抢同一批任务（Python 服务重启时会接管这里正在运行的对话），建议停掉它'
          + (command ? '：' : '：在运行 coderfleet server 的终端里按 Ctrl+C。')),
        command ? h('code', command) : null),
      copy);
  };

  /**
   * A searchable list popover (project pickers and the like). Opens above the
   * anchor when there is more room there. Arrow keys move, Enter picks, Esc closes.
   * items: [{ id, label, hint?, dot?, selected?, muted? }]
   */
  CF.picker = (anchor, { items, placeholder = '搜索…', empty = '没有匹配项', footer, onPick }) => {
    openMenu?.remove();
    const input = h('input', { placeholder, 'aria-label': placeholder });
    const list = h('div.picker-list', { role: 'listbox' });
    const pop = h('div.menu.picker', h('label.picker-search', CF.icon('search', 13), input), list, footer ? h('div.picker-foot', footer) : null);
    let shown = [];
    let index = 0;
    const close = () => { pop.remove(); document.removeEventListener('mousedown', outside, true); if (openMenu === pop) openMenu = null; };
    const pick = item => { close(); onPick(item); };
    const draw = () => {
      const query = input.value.trim().toLowerCase();
      shown = items.filter(item => !query || (item.label + ' ' + (item.hint || '')).toLowerCase().includes(query));
      index = Math.max(0, Math.min(index, shown.length - 1));
      list.replaceChildren(...(shown.length ? shown.map((item, position) => h('button.picker-item' + (position === index ? '.active' : '') + (item.selected ? '.selected' : '') + (item.muted ? '.muted' : ''), {
        role: 'option', 'aria-selected': String(Boolean(item.selected)),
        on: { click: () => pick(item), mousemove: () => { if (index !== position) { index = position; draw(); } } },
      }, h('span.dot' + (item.dot ? '.' + item.dot : '')), h('span.name', item.label), item.hint ? h('span.hint', item.hint) : null,
        item.selected ? CF.icon('check', 13) : null)) : [h('div.picker-empty', empty)]));
      list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    };
    input.addEventListener('input', () => { index = 0; draw(); });
    input.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') { index = Math.min(index + 1, shown.length - 1); draw(); event.preventDefault(); }
      else if (event.key === 'ArrowUp') { index = Math.max(index - 1, 0); draw(); event.preventDefault(); }
      else if (event.key === 'Enter' && shown[index]) { pick(shown[index]); event.preventDefault(); }
      else if (event.key === 'Escape') { close(); anchor.focus?.(); }
    });
    const outside = event => { if (!pop.contains(event.target) && !anchor.contains(event.target)) close(); };
    index = Math.max(0, items.findIndex(item => item.selected));
    draw();
    document.body.append(pop);
    const rect = anchor.getBoundingClientRect();
    const above = rect.top > window.innerHeight - rect.bottom;
    const room = (above ? rect.top : window.innerHeight - rect.bottom) - 16;
    pop.style.maxHeight = Math.max(180, Math.min(420, room)) + 'px';
    pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
    if (above) pop.style.bottom = (window.innerHeight - rect.top + 6) + 'px'; else pop.style.top = (rect.bottom + 6) + 'px';
    openMenu = pop;
    setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
    input.focus();
    return { close };
  };

  /**
   * A modal sheet. `build(sheet)` returns the body; the sheet exposes
   * `close()`, `error(text)` and `foot(...buttons)`.
   */
  CF.sheet = ({ title, subtitle, wide = false, onClose }, build) => {
    const errorLine = h('div.sheet-error', { role: 'alert' });
    const foot = h('div.sheet-foot');
    const dialog = h('dialog.sheet' + (wide ? '.wide' : ''), { 'aria-label': title });
    const sheet = {
      dialog,
      close: () => { dialog.close(); },
      error: text => { errorLine.textContent = text ? CF.errorText(text) : ''; },
      foot: (...buttons) => { foot.replaceChildren(...buttons); foot.hidden = !buttons.length; },
    };
    const body = h('div.sheet-body', build(sheet));
    dialog.append(
      h('div.sheet-head', h('h2', title), h('button.icon-btn', { title: '关闭', on: { click: () => dialog.close() } }, CF.icon('x', 14))),
      subtitle ? h('div.sheet-sub', subtitle) : null, body, errorLine, foot,
    );
    if (!foot.children.length) foot.hidden = true;
    dialog.addEventListener('close', () => { dialog.remove(); onClose?.(); });
    document.body.append(dialog);
    dialog.showModal();
    return sheet;
  };

  CF.confirm = (title, text, { danger = false, label = '确定' } = {}) => new Promise(resolve => {
    let answered = false;
    const sheet = CF.sheet({ title, onClose: () => { if (!answered) resolve(false); } }, () => h('p', { style: 'margin:0;color:var(--text-2)' }, text));
    sheet.foot(
      h('button.btn', { on: { click: () => sheet.close() } }, '取消'),
      h('button.btn.primary' + (danger ? '.danger' : ''), { on: { click: () => { answered = true; resolve(true); sheet.close(); } } }, label),
    );
  });

  /** Follows a backend operation (image build, container start…) in a log sheet. */
  CF.operationLog = (operation, title) => {
    const log = h('pre.log');
    const status = h('span.badge');
    let stopped = false;
    const sheet = CF.sheet({ title, wide: true, onClose: () => { stopped = true; } }, () => [h('div', { style: 'margin-bottom:10px' }, status), log]);
    sheet.foot(h('button.btn', { on: { click: () => sheet.close() } }, '关闭'));
    const poll = async () => {
      if (stopped) return;
      try {
        const current = await CF.get('operations/' + operation.id);
        const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
        log.textContent = current.output || '…';
        if (atBottom) log.scrollTop = log.scrollHeight;
        status.replaceChildren(current.status === 'running' ? h('span.spinner') : h('span.dot' + (current.status === 'failed' ? '.failed' : '.running')),
          { running: '进行中', succeeded: '已完成', failed: '失败' }[current.status]);
        if (current.status === 'running') setTimeout(poll, 700);
      } catch (error) { sheet.error(error); }
    };
    void poll();
  };

  /** Waits for an operation and reports it with a toast that can open the log. */
  CF.trackOperation = async (operation, label, refresh) => {
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 800));
      let current;
      try { current = await CF.get('operations/' + operation.id); } catch { return; }
      refresh?.();
      if (current.status === 'running') continue;
      const action = { label: '日志', run: () => CF.operationLog(operation, label) };
      if (current.status === 'succeeded') CF.toast(label + '：完成', { action });
      else CF.toast(label + '：失败', { error: true, action, timeout: 8000 });
      refresh?.();
      return current;
    }
  };

  /** A path short enough for a row: the last segments, with the full path as tooltip text. */
  CF.shortPath = path => {
    const parts = String(path || '').split('/').filter(Boolean);
    return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : String(path || '');
  };
  /** Container paths read relative to the project. */
  CF.projectPath = path => String(path || '').replace(/^\/workspace\//, '');

  CF.typeBadge = (type, label) => h('span.badge.type-' + type, label || type);
  CF.stateDot = state => h('span.dot' + (state === 'running' ? '.running' : state === 'restarting' ? '.busy' : ''));
  CF.stateText = state => ({ running: '运行中', exited: '已停止', created: '未启动', restarting: '重启中', paused: '已暂停', missing: '未创建', dead: '异常' }[state] || state || '未知');

  CF.relative = iso => {
    const delta = (Date.now() - Date.parse(iso)) / 1000;
    if (!Number.isFinite(delta)) return '';
    if (delta < 60) return '刚刚';
    if (delta < 3600) return Math.floor(delta / 60) + ' 分钟前';
    if (delta < 86400) return Math.floor(delta / 3600) + ' 小时前';
    if (delta < 86400 * 7) return Math.floor(delta / 86400) + ' 天前';
    return new Date(iso).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  };

  /** Interactive terminal sheet bound to a backend terminal session. */
  CF.openTerminal = async (title, subtitle, start) => {
    const host = h('div.terminal-host');
    let closed = false;
    let terminalId = '';
    const sheet = CF.sheet({
      title, subtitle, wide: true,
      onClose: () => { closed = true; if (terminalId) void CF.api('DELETE', 'terminals/' + terminalId).catch(() => undefined); },
    }, () => host);
    sheet.foot(h('button.btn', { on: { click: () => sheet.close() } }, '完成'));
    const term = new window.Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', fontSize: 12.5, lineHeight: 1.15, cursorBlink: true,
      theme: { background: '#0f1115', foreground: '#dfe4ee', cursor: '#dfe4ee', selectionBackground: 'rgba(141,160,255,0.35)' },
    });
    term.open(host);
    // Size the grid from a measured character cell so the terminal fills its frame.
    const probe = h('span', { style: 'position:absolute;visibility:hidden;white-space:pre;font:12.5px/1.15 ui-monospace,"SF Mono",Menlo,monospace' }, 'W'.repeat(50));
    host.append(probe);
    const cell = { width: probe.getBoundingClientRect().width / 50, height: probe.getBoundingClientRect().height };
    probe.remove();
    const style = getComputedStyle(host);
    const innerWidth = host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 12;
    const innerHeight = host.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const cols = Math.max(40, Math.floor(innerWidth / cell.width));
    const rows = Math.max(10, Math.floor(innerHeight / Math.ceil(cell.height)));
    term.resize(cols, rows);
    term.focus();
    try { terminalId = (await start(cols, rows)).terminalId; }
    catch (error) { sheet.error(error); return; }
    const encoder = new TextEncoder();
    const toBase64 = bytes => btoa(String.fromCharCode(...bytes));
    let pending = Promise.resolve();
    term.onData(data => {
      pending = pending.then(() => CF.api('POST', 'terminals/' + terminalId + '/input', { data: toBase64(encoder.encode(data)) })).catch(() => undefined);
    });
    let offset = 0;
    while (!closed) {
      let chunk;
      try { chunk = await CF.get('terminals/' + terminalId + '?offset=' + offset + '&wait=12000'); }
      catch (error) { if (!closed) sheet.error(error); return; }
      if (chunk.data) term.write(Uint8Array.from(atob(chunk.data), c => c.charCodeAt(0)));
      offset = chunk.offset;
      if (chunk.exited) { term.write('\r\n\x1b[2m[已结束]\x1b[0m\r\n'); return; }
    }
  };
})();

(() => {
  const CF = window.CF;
  const { h } = CF;

  /** Shows a backend job's log until it finishes; resolves to its result or undefined. */
  CF.followJob = (jobId, title, subtitle) => new Promise(resolve => {
    const log = h('pre.log', '…');
    const status = h('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:10px;font-weight:600' }, h('span.spinner'), '进行中');
    let closed = false;
    let outcome;
    const sheet = CF.sheet({ title, subtitle, wide: true, onClose: () => { closed = true; resolve(outcome); } }, () => [status, log]);
    const done = h('button.btn', { on: { click: () => sheet.close() } }, '关闭');
    sheet.foot(done);
    const poll = async () => {
      if (closed) return;
      let job;
      try { job = await CF.transport.job(jobId); } catch (error) { sheet.error(error); return; }
      const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
      log.textContent = job.log || '…';
      if (atBottom) log.scrollTop = log.scrollHeight;
      if (job.status === 'running') { setTimeout(poll, 500); return; }
      status.replaceChildren(h('span.dot' + (job.status === 'failed' ? '.failed' : '.running')), job.status === 'failed' ? '失败' : '完成');
      if (job.status === 'failed') { sheet.error(job.error); return; }
      outcome = job.result;
      done.className = 'btn primary';
      done.textContent = '开始使用';
    };
    void poll();
  });

  /** Form for adding (or reinstalling) a remote Docker host over SSH. */
  CF.addSshBackend = () => new Promise(resolve => {
    const name = h('input', { placeholder: '例如 构建服务器', maxLength: 100 });
    const host = h('input', { placeholder: 'user@192.168.1.20 或 ~/.ssh/config 里的别名', spellcheck: false });
    const port = h('input', { placeholder: '22', inputMode: 'numeric', style: 'width:90px' });
    const identity = h('input', { placeholder: '默认使用 ~/.ssh 里的密钥和 ssh-agent', spellcheck: false });
    const pick = CF.transport.pickFile ? h('button.btn', { type: 'button', on: { click: async () => {
      const chosen = await CF.transport.pickFile();
      if (chosen) identity.value = chosen;
    } } }, '选择…') : null;
    let started = false;
    const sheet = CF.sheet({
      title: '通过 SSH 添加远程机器',
      subtitle: 'App 会把后端装到这台 Linux 机器上并作为服务运行，再通过 SSH 隧道连接，不需要对外开放端口。',
      onClose: () => { if (!started) resolve(undefined); },
    }, () => [
      h('label.field', h('span', '名称'), name),
      h('div.field', h('span', 'SSH 主机', h('span.hint', ' 需要已配置密钥登录')), h('div.input-row', host, port)),
      h('div.field', h('span', '密钥文件', h('span.hint', ' 可选')), h('div.input-row', identity, pick)),
      h('p', { style: 'margin:4px 0 0;color:var(--text-3);font-size:12.5px' }, '要求：Linux x86_64 或 arm64，已安装 Docker，且登录用户可以使用 Docker。'),
    ]);
    const submit = h('button.btn.primary', { on: { click: () => CF.busy(submit, async () => {
      sheet.error('');
      try {
        const jobId = await CF.transport.addSsh({ name: name.value, host: host.value, port: port.value, identityFile: identity.value });
        started = true;
        sheet.close();
        resolve(await CF.followJob(jobId, '安装远程后端', host.value.trim()));
      } catch (error) { sheet.error(error); }
    }) } }, '连接并安装');
    sheet.foot(h('button.btn', { on: { click: () => sheet.close() } }, '取消'), submit);
    host.focus();
  });
})();
