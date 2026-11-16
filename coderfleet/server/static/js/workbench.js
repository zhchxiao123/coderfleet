// One read-only work view shared by desktop and mobile. Navigation stays with each client.
window.FleetWorkView = (() => {
  const labels = {
    idle: '未开始', planned: '待规划', todo: '待执行', pending: '排队中', scheduled: '定时中',
    running: '执行中', done: '本轮完成', succeeded: '执行完成', review: '待验收',
    failed: '执行失败', partial: '部分失败', blocked: '受阻', killed: '已停止',
    cancelled: '已取消', parked: '已搁置', waiting_approval: '待审批',
  };
  const actions = { question: '去回答', permission: '去授权', approval: '去审批', review: '查看专题', blocked: '查看原因' };

  function targetFor(item, attention) {
    if (attention && ['question', 'permission'].includes(attention.kind) && attention.task_id) {
      return { kind: 'task', id: attention.task_id };
    }
    if (attention?.card_id && attention.board_id) {
      return { kind: 'board', id: attention.board_id, cardId: attention.card_id };
    }
    if (item.workflow_run_id) return { kind: 'workflow', id: item.workflow_run_id };
    if (item.conversation_id) return { kind: 'conversation', id: item.conversation_id };
    if (item.task_id) return { kind: 'task', id: item.task_id };
    if (item.board_id) return { kind: 'board', id: item.board_id, cardId: item.card_id };
    throw new Error('这条记录没有可打开的会话或运行，请刷新后检查原记录');
  }

  async function readTarget(target) {
    const paths = { conversation: 'conversations', task: 'tasks', workflow: 'workflow-runs', board: 'boards' };
    if (!paths[target.kind] || !target.id) throw new Error('工作引用无效');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const path = `/api/${paths[target.kind]}/${encodeURIComponent(target.id)}${target.kind === 'board' ? '/cards' : ''}`;
      const response = await fetch(path, { signal: controller.signal });
      const record = await response.json();
      if (!response.ok) throw new Error(record.detail || `原记录不可用（HTTP ${response.status}）`);
      if (target.kind === 'board') {
        if (target.cardId && !record.some(card => card.id === target.cardId)) throw new Error('专题已删除或归档，请刷新列表');
      } else if (record.archived || record.status === 'archived') throw new Error('原记录已归档，请从历史记录打开');
      return record;
    } finally { clearTimeout(timer); }
  }

  function create(root, options) {
    const inbox = options.inbox === true;
    const filters = inbox ? [['attention', '全部待处理'], ['review', '待验收'], ['blocked', '受阻']]
      : [['all', '全部工作'], ['attention', '待处理'], ['running', '执行中'], ['review', '待验收'], ['blocked', '受阻']];
    let view = filters[0][0], project = '', offset = 0, data = null;
    let sequence = 0, controller = null, pending = null, fingerprint = '', enabled = true;
    root.innerHTML = `
      <div class="wb-controls">
        <div class="wb-filters" role="group" aria-label="工作筛选">${filters.map(([key, label]) =>
          `<button type="button" class="wb-filter" data-wb-filter="${key}" aria-pressed="${key === view}">${label}<span data-wb-count="${key}">—</span></button>`).join('')}</div>
        <div class="wb-tools"><label class="wb-project-label">项目<select data-wb-project aria-label="筛选项目"><option value="">全部项目</option></select></label>
          <button class="wb-button wb-refresh" type="button" data-wb-refresh aria-label="刷新工作列表" title="刷新">↻</button></div>
      </div>
      <p class="wb-notice" data-wb-notice role="status" aria-live="polite"></p>
      <div class="wb-list" data-wb-list></div>
      <div class="wb-pagination"><span data-wb-range></span><div>
        <button type="button" class="wb-button" data-wb-prev>上一页</button>
        <button type="button" class="wb-button" data-wb-next>下一页</button></div></div>`;
    const list = root.querySelector('[data-wb-list]');
    const notice = root.querySelector('[data-wb-notice]');
    const projectSelect = root.querySelector('[data-wb-project]');

    function render(payload) {
      data = payload;
      root.querySelectorAll('[data-wb-count]').forEach(el => { el.textContent = payload.counts[el.dataset.wbCount] ?? 0; });
      root.querySelectorAll('[data-wb-filter]').forEach(el => { el.setAttribute('aria-pressed', String(el.dataset.wbFilter === view)); });
      const projects = ['<option value="">全部项目</option>', ...payload.projects.map(name => `<option value="${esc(name)}">${esc(name)}</option>`)].join('');
      if (projectSelect.innerHTML !== projects) projectSelect.innerHTML = projects;
      projectSelect.value = project;
      const signature = JSON.stringify([view, payload.items]);
      if (signature !== fingerprint) {
        fingerprint = signature;
        list.innerHTML = payload.items.length ? payload.items.map(item => {
          const pendingAttention = item.attention[0];
          const state = pendingAttention?.label || labels[item.status] || item.status;
          const color = item.attention.length ? (item.attention.some(a => a.kind === 'blocked') ? 'error' : 'attention') : item.status === 'running' ? 'running' : 'neutral';
          const kind = { conversation: '项目对话', task: '独立任务', workflow: '工作流', card: '专题' }[item.kind] || '工作';
          const action = item.conversation_id ? '继续对话' : item.workflow_run_id ? '查看工作流' : item.board_id ? '打开看板' : '查看对话';
          return `<article class="wb-work-card">
            <div class="wb-work-top"><div class="wb-work-heading"><span class="wb-kind">${kind}</span>
              <h3><button type="button" data-wb-item="${esc(item.id)}">${esc(item.title || '未命名对话')}</button></h3></div>
              <span class="wb-status ${color}"><i aria-hidden="true"></i>${esc(state)}</span></div>
            <p class="wb-work-meta">${esc(item.project_names.join(' / ') || '未配置项目')}${item.account ? ` · ${esc(item.account)}` : ''} · ${item.task_count} 次执行${item.queued_count ? ` · ${item.queued_count} 条排队` : ''}</p>
            ${item.attention.length ? `<div class="wb-attention-list">${item.attention.map((attention, index) =>
              `<div class="wb-attention"><div><strong>${esc(attention.label)}</strong><p>${esc(attention.detail)}</p></div>
              <button type="button" class="wb-button" data-wb-item="${esc(item.id)}" data-wb-attention="${index}">${actions[attention.kind] || '查看'}</button></div>`).join('')}</div>` : ''}
            <div class="wb-work-footer"><time>${esc(new Date(item.updated).toLocaleString())}</time>
              <button type="button" class="wb-open" data-wb-item="${esc(item.id)}">${action}<span aria-hidden="true"> ↗</span></button></div>
          </article>`;
        }).join('') : `<div class="wb-empty"><span class="wb-empty-icon" aria-hidden="true">${view !== 'all' ? '✓' : '◇'}</span>
          <h3>${({ attention: '当前没有需要处理的事项', review: '暂无待验收工作', blocked: '暂无受阻工作', running: '暂无执行中的工作' })[view] || '从一个项目对话开始'}</h3>
          <p>${view !== 'all' ? '新的进展与需要处理的事项会在这里更新。' : '选择项目即可直接问答或开发，无需先创建工作卡片。'}</p>
          <button type="button" class="wb-button primary" data-wb-chat>进入项目问答</button></div>`;
      }
      root.querySelector('[data-wb-range]').textContent = payload.total ? `${offset + 1}–${offset + payload.items.length} / ${payload.total}` : '0 项';
      root.querySelector('[data-wb-prev]').disabled = offset === 0;
      root.querySelector('[data-wb-next]').disabled = offset + payload.items.length >= payload.total;
    }

    function refresh(quiet = false) {
      if (quiet && pending) return pending;
      enabled = true;
      const request = ++sequence;
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      const timer = setTimeout(() => controller?.signal === signal && controller.abort(), 12000);
      root.setAttribute('aria-busy', 'true');
      if (!quiet) notice.textContent = '正在读取工作记录…';
      pending = (async () => {
        try {
          const query = new URLSearchParams({ project_name: project, view, offset: String(offset) });
          const response = await fetch(`/api/workbench?${query}`, { signal });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.detail || `HTTP ${response.status}`);
          if (!enabled || request !== sequence) return;
          render(payload);
          notice.textContent = `更新于 ${new Date(payload.generated_at).toLocaleTimeString()} · 项目问答保持直接可用`;
          options.onCounts?.(payload.counts);
        } catch (error) {
          if (!enabled || request !== sequence) return;
          notice.textContent = `更新失败：${error.name === 'AbortError' ? '请求超时，请重试' : error.message}${data ? '。当前显示上次读取的记录。' : ''}`;
        } finally {
          clearTimeout(timer);
          if (request === sequence) { pending = null; controller = null; root.setAttribute('aria-busy', 'false'); }
        }
      })();
      return pending;
    }

    root.addEventListener('click', async event => {
      const button = event.target.closest('button');
      if (!button || !root.contains(button)) return;
      if (button.hasAttribute('data-wb-filter')) { view = button.dataset.wbFilter; offset = 0; return refresh(); }
      if (button.hasAttribute('data-wb-refresh')) return refresh();
      if (button.hasAttribute('data-wb-prev')) { offset = Math.max(0, offset - (data?.limit || 50)); return refresh(); }
      if (button.hasAttribute('data-wb-next')) { offset += data?.limit || 50; return refresh(); }
      if (button.hasAttribute('data-wb-chat')) return options.onChat(project);
      if (!button.hasAttribute('data-wb-item')) return;
      const item = data?.items.find(row => row.id === button.dataset.wbItem);
      if (!item) return;
      button.disabled = true;
      try {
        const attention = button.hasAttribute('data-wb-attention') ? item.attention[Number(button.dataset.wbAttention)] : null;
        await options.onOpen(targetFor(item, attention));
      } catch (error) { if (enabled) notice.textContent = `打开失败：${error.message}`; }
      finally { button.disabled = false; }
    });
    projectSelect.addEventListener('change', () => { project = projectSelect.value; offset = 0; refresh(); });
    return {
      refresh,
      deactivate() { enabled = false; ++sequence; controller?.abort(); controller = null; pending = null; root.setAttribute('aria-busy', 'false'); },
    };
  }

  return { create, targetFor, readTarget };
})();
