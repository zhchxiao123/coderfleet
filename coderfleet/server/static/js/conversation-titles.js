// Shared title metadata/requests. Rendering adapters retain their own chat state.
(function (root) {
  function statusLabel(title = {}) {
    if (title.source === 'manual') return '手动命名';
    if (title.status === 'pending') return '正在生成标题';
    if (title.status === 'waiting_context') return '等待明确的会话主题';
    if (title.status === 'retryable_error') return title.error === 'not_configured'
      ? '系统模型未配置，配置后自动重试' : '标题生成失败，可重新生成';
    if (title.source === 'auto') return '自动命名';
    return '已有标题';
  }
  function merge(conversations, updates) {
    let changed = false;
    const byId = new Map(conversations.map(conv => [conv.id, conv]));
    for (const update of updates) {
      const conv = byId.get(update.id);
      if (!conv || typeof update.name !== 'string' || !update.name.trim()) continue;
      if ((update.title?.revision || 0) < (conv.title?.revision || 0)) continue;
      if (conv.name !== update.name || JSON.stringify(conv.title) !== JSON.stringify(update.title)) {
        conv.name = update.name;
        conv.title = update.title || {source:'legacy',revision:0};
        changed = true;
      }
    }
    return changed;
  }
  async function refresh(conversations, priority = []) {
    const ids = [...new Set([...priority, ...conversations.filter(conv =>
      ['pending','retryable_error'].includes(conv.title?.status)).map(conv => conv.id),
      ...conversations.slice(0,10).map(conv => conv.id)])].filter(id => id && !id.startsWith('task-')).slice(0,50);
    if (!ids.length) return [];
    const query = ids.map(id => 'ids='+encodeURIComponent(id)).join('&');
    const controller = new AbortController(), timer = setTimeout(()=>controller.abort(),4000);
    try {
      const response = await fetch('/api/conversation-titles?'+query,{signal:controller.signal});
      if (!response.ok) throw new Error('标题状态加载失败');
      const rows = await response.json();
      if (!Array.isArray(rows)) throw new Error('标题状态响应无效');
      return rows;
    } finally { clearTimeout(timer); }
  }
  async function regenerate(conv) {
    const response = await fetch('/api/conversations/'+encodeURIComponent(conv.id)+'/title', {
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({expected_revision:conv.title?.revision || 0,expected_name:conv.name}),
    });
    if (!response.ok) {
      const value = await response.json().catch(()=>({}));
      throw new Error(typeof value.detail === 'string' ? value.detail : '标题生成请求失败');
    }
    return response.json();
  }
  function paint(conversations) {
    const byId = new Map(conversations.map(conv => [conv.id,conv]));
    for (const node of document.querySelectorAll('[data-conversation-title-id]')) {
      const conv = byId.get(node.dataset.conversationTitleId);
      if (!conv) continue;
      node.textContent = conv.name;
      node.title = conv.name+' · '+statusLabel(conv.title);
      const header = node.closest?.('.chat-main-title');
      if (header) header.title = conv.name;
    }
  }
  root.FleetTitles = {statusLabel,merge,refresh,regenerate,paint};
})(window);
