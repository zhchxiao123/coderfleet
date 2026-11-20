// Shared desktop/mobile history window. Metadata is cheap; log bodies are loaded
// only for visible pages. Each row owns its cancellation and retry lifecycle.
const CHAT_HISTORY_PAGE_SIZE = 8;
const CHAT_HISTORY_INITIAL_COUNT = 3;

class ChatHistoryView {
  constructor({container, viewport, loadTurn, loadOlder, indexContainer, follow = () => false}) {
    this.container = container;
    this.viewport = viewport;
    this.loadTurn = loadTurn;
    this.loadOlder = loadOlder;
    this.follow = follow;
    this.tasks = new Map();
    this.rows = new Map();
    this.disposed = false;
    this.hasMore = false;
    this.olderPending = false;
    this.startId = null;
    this.button = document.createElement('button');
    this.button.className = 'chat-history-more';
    this.button.type = 'button';
    this.button.textContent = '加载更早消息';
    this.button.addEventListener('click', () => this.showOlder());
    container.appendChild(this.button);
    if (indexContainer) {
      this.index = document.createElement('nav');
      this.index.className = 'chat-history-index';
      this.index.setAttribute('aria-label','会话消息目录');
      indexContainer.appendChild(this.index);
    }
  }

  ordered() {
    return [...this.tasks.values()].sort((a,b) =>
      (Date.parse(a.created) || 0) - (Date.parse(b.created) || 0) || a.id.localeCompare(b.id));
  }

  update(tasks, hasMore = this.hasMore, replace = false) {
    if (this.disposed) return;
    if (replace) {
      const ids = new Set(tasks.map(task=>task.id));
      for (const [id,row] of this.rows) if (!ids.has(id)) {
        row.controller.abort();row.node.remove();this.rows.delete(id);
      }
      this.tasks.clear();
    }
    for (const task of tasks) this.tasks.set(task.id, task);
    this.hasMore = hasMore;
    const ordered = this.ordered();
    let start = ordered.findIndex(task => task.id === this.startId);
    if (start < 0) start = Math.max(0, ordered.length - CHAT_HISTORY_INITIAL_COUNT);
    this.startId = ordered[start]?.id || null;
    const visible = ordered.filter((task,i)=>task.status === 'running' || this.rows.has(task.id) || i>=ordered.length-CHAT_HISTORY_INITIAL_COUNT ||
      (!this.rows.size && i>=start && i<start+CHAT_HISTORY_INITIAL_COUNT));
    if (this.rows.size) this._mutate(() => this._mount(visible));
    else this._mount(visible);
    this._updateButton(start);
    this._updateIndex();
  }

  _updateButton(start = this.ordered().findIndex(task => task.id === this.startId)) {
    this.button.hidden = start <= 0 && !this.hasMore;
    this.button.disabled = this.olderPending;
    this.button.textContent = this.olderPending ? '正在加载…' : '加载更早消息';
  }

  async showOlder() {
    if (this.disposed || this.olderPending) return;
    this.olderPending = true;
    this.button.removeAttribute('title');
    this._updateButton();
    try {
      let ordered = this.ordered();
      let start = ordered.findIndex(task => task.id === this.startId);
      if (start < CHAT_HISTORY_PAGE_SIZE && this.hasMore && this.loadOlder) {
        const result = await this.loadOlder();
        if (this.disposed) return;
        for (const task of result.tasks) this.tasks.set(task.id, task);
        this.hasMore = result.hasMore;
        ordered = this.ordered();
        start = ordered.findIndex(task => task.id === this.startId);
      }
      start = Math.max(0, start - CHAT_HISTORY_PAGE_SIZE);
      this.startId = ordered[start]?.id || null;
      const end = ordered.findIndex(task=>task.id===this.startId);
      this._mutate(() => this._mount(ordered.slice(start,Math.max(start+CHAT_HISTORY_PAGE_SIZE,end)), true), false);
    } catch (error) {
      if (!this.disposed) {
        this.button.textContent = '加载失败，点击重试';
        this.button.title = String(error.message || error);
      }
    } finally {
      this.olderPending = false;
      if (!this.disposed) {
        const failed = this.button.title;
        this._updateButton();
        if (failed) this.button.textContent = '加载失败，点击重试';
      }
    }
  }

  _mount(tasks, older = false) {
    // Insert cheap shells in chronology before starting downloads, newest first.
    const pending = [];
    const ordered = this.ordered();
    for (const task of tasks) {
      let row = this.rows.get(task.id);
      if (row && row.status === task.status && row.finished === task.finished && !row.retryOnUpdate) continue;
      if (row) row.controller.abort();
      const node = document.createElement('div');
      node.className = 'history-turn';
      node.dataset.historyTask = task.id;
      const controller = new AbortController();
      const next = {task,status:task.status,finished:task.finished,node,controller,older,retries:row?.retryOnUpdate ? row.retries+1 : 0};
      if (row) row.node.replaceWith(node);
      else {
        const index = ordered.findIndex(item=>item.id===task.id);
        const following = ordered.slice(index + 1).map(item => this.rows.get(item.id)?.node).find(Boolean);
        this.container.insertBefore(node, following || null);
      }
      this.rows.set(task.id,next);
      pending.push(next);
    }
    for (const row of pending.reverse()) this._load(row);
    this._updateGaps();
    this._updateIndex();
  }

  _updateGaps() {
    this.container.querySelectorAll('.chat-history-gap').forEach(node=>node.remove());
    const ordered = this.ordered();
    let previous = -1;
    for (let i=0;i<ordered.length;i++) {
      const row = this.rows.get(ordered[i].id);
      if (!row) continue;
      if (previous >= 0 && i-previous>1) {
        const begin = previous + 1;
        const gap = document.createElement('button');
        gap.className = 'chat-history-more chat-history-gap';
        gap.type = 'button';
        gap.textContent = `加载中间的 ${i-previous-1} 轮消息`;
        const end = i;
        gap.addEventListener('click',()=>this._mutate(()=>this._mount(ordered.slice(Math.max(begin,end-CHAT_HISTORY_PAGE_SIZE),end),true),false));
        this.container.insertBefore(gap,row.node);
      }
      previous = i;
    }
  }

  _updateIndex() {
    if (!this.index) return;
    const previousScroll = this.index.scrollTop;
    const atBottom = this.index.scrollTop + this.index.clientHeight >= this.index.scrollHeight - 8;
    this.index.replaceChildren();
    const ordered = this.ordered();
    const selected = new Set();
    for (let i=0;i<Math.min(80,ordered.length);i++) selected.add(Math.floor(i*(ordered.length-1)/Math.max(1,Math.min(80,ordered.length)-1)));
    for (const [i,task] of ordered.entries()) if (this.rows.has(task.id)) selected.add(i);
    for (const i of [...selected].sort((a,b)=>a-b)) {
      const task = ordered[i];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chat-history-tick';
      if (this.rows.has(task.id)) button.classList.add('is-loaded');
      button.title = task.prompt || '查看消息';
      const replies = this.rows.get(task.id)?.node.querySelectorAll('.ai-reply .bubble-content');
      const preview = replies?.[replies.length-1]?.textContent;
      if (preview) button.title += '\n' + preview.trim().slice(0,180);
      button.setAttribute('aria-label',`查看消息：${task.prompt || task.id}`);
      button.addEventListener('click',()=> {
        this._mutate(()=>this._mount(ordered.slice(i,i+CHAT_HISTORY_INITIAL_COUNT),true),false);
        this.startId = ordered.find(item=>this.rows.has(item.id))?.id || null;
        this._updateButton();
        this.rows.get(task.id)?.node.scrollIntoView({block:'start'});
      });
      this.index.appendChild(button);
    }
    this.index.scrollTop = atBottom ? this.index.scrollHeight : previousScroll;
  }

  async _load(row) {
    const isCurrent = () => !this.disposed && !row.controller.signal.aborted && this.rows.get(row.task.id) === row;
    try {
      const result = await this.loadTurn(row.task,row.node,{signal:row.controller.signal,isCurrent,
        mutate:callback=>{if(isCurrent()) this._mutate(callback,row.older ? false : this.follow());}});
      if (isCurrent()) {
        row.retryOnUpdate = !!result?.retryOnUpdate && row.retries < 3;
        if (result?.retryOnUpdate && row.retries >= 3) throw new Error('任务日志尚未收尾，请稍后重试');
        this._updateIndex();
      }
    } catch (error) {
      if (!isCurrent()) return;
      this._mutate(() => {
        const message = document.createElement('div');
        message.className = 'chat-history-error';
        const label = document.createElement('span');
        label.textContent = `这条回复加载失败：${error.message || error}`;
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = '重试';
        retry.addEventListener('click',() => {
          message.remove();
          row.node.innerHTML = '';
          this._load(row);
        });
        message.appendChild(label);
        message.appendChild(retry);
        row.node.appendChild(message);
      });
    }
  }

  _mutate(callback, follow = this.follow()) {
    const viewport = this.viewport;
    const top = viewport.getBoundingClientRect().top;
    const anchor = [...this.container.children].find(node => node.dataset?.historyTask && node.getBoundingClientRect().bottom > top);
    const before = anchor?.getBoundingClientRect().top;
    callback();
    if (follow) viewport.scrollTop = viewport.scrollHeight;
    else if (anchor?.isConnected) viewport.scrollTop += anchor.getBoundingClientRect().top - before;
  }

  dispose() {
    this.disposed = true;
    for (const row of this.rows.values()) { row.controller.abort(); row.node.remove(); }
    this.button.remove();
    this.index?.remove();
    this.rows.clear();
  }
}

// Existing task-list API returns the latest N rows. Growing its conversation-
// scoped prefix avoids global-list truncation and works with installed servers.
// Logs still load only eight at a time, irrespective of this metadata prefix.
function conversationHistorySource(conversationId, fetcher) {
  let limit = 0;
  let pending = null;
  const read = (refresh = false) => {
    if (pending) return pending;
    const next = refresh ? (limit || 200) : limit + 200;
    pending = (async () => {
      const response = await fetcher(`/api/tasks?conversation_id=${encodeURIComponent(conversationId)}&limit=${next}`);
      if (response.ok === false) throw new Error(`历史任务请求失败（HTTP ${response.status}）`);
      const tasks = await response.json();
      if (!Array.isArray(tasks)) throw new Error('历史任务响应无效');
      if (tasks.some(task => task.conversation_id !== conversationId)) throw new Error('历史任务所属会话不匹配');
      limit = next;
      return {tasks,hasMore:tasks.length >= next};
    })().finally(() => {pending = null;});
    return pending;
  };
  const source = () => read();
  source.refresh = () => read(true);
  return source;
}
