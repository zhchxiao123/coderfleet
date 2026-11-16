window.Workbench = (() => {
  const views = new Map();
  let opening = 0;
  let activeView = '';

  async function open(target) {
    const request = ++opening;
    let record = await FleetWorkView.readTarget(target);
    if (target.kind === 'task' && record.conversation_id) {
      record = await FleetWorkView.readTarget({ kind: 'conversation', id: record.conversation_id });
      target = { kind: 'conversation', id: record.id };
    }
    if (request !== opening) return;
    if (target.kind === 'conversation' || target.kind === 'task') {
      const loading = showPage('chat');
      const navigating = opening;
      await loading;
      if (currentPage !== 'chat' || opening !== navigating) return;
      if (target.kind === 'conversation') {
        chatConversationsList = [...chatConversationsList.filter(conv => conv.id !== record.id), record];
        await selectConversation(record.id);
      } else {
        tasksCache = [...tasksCache.filter(task => task.id !== record.id), record];
        await selectConversation(`task-${record.id}`);
      }
    } else if (target.kind === 'workflow') {
      wfActiveTab = 'runs';
      const loading = showPage('workflows');
      const navigating = opening;
      await loading;
      if (currentPage === 'workflows' && opening === navigating) await openPipeline(target.id);
    } else if (target.kind === 'board') {
      activeBoardId = target.id;
      localStorage.setItem('coderfleet.activeBoardId', target.id);
      const loading = showPage('boards');
      const navigating = opening;
      await loading;
      if (currentPage !== 'boards' || opening !== navigating) return;
      if (target.cardId) {
        const card = [...document.querySelectorAll('[data-board-card]')].find(el => el.dataset.boardCard === target.cardId);
        card?.scrollIntoView({ block: 'center' });
        card?.focus({ preventScroll: true });
      }
    }
  }

  function load(name = currentPage, quiet = false) {
    if (activeView !== name) { activeView = name; ++opening; }
    for (const [key, view] of views) if (key !== name) view.deactivate();
    const root = document.getElementById(`workbench-${name}`);
    if (!root) return;
    if (!views.has(name)) views.set(name, FleetWorkView.create(root, {
      inbox: name === 'inbox', onOpen: open,
      onChat: project => project ? startNewChat({ projectName: project }) : showPage('chat'),
      onCounts: counts => {
        const badge = document.getElementById('workbench-attention-count');
        if (badge) { badge.textContent = counts.attention; badge.hidden = !counts.attention; }
      },
    }));
    return views.get(name).refresh(quiet);
  }

  function deactivate() {
    ++opening;
    activeView = '';
    for (const view of views.values()) view.deactivate();
  }

  async function openFromUrl() {
    const query = new URLSearchParams(location.search);
    const page = query.get('workbench');
    if (page === 'work' || page === 'inbox') return showPage(page);
    if (['workflow', 'board'].includes(page) && query.get('target')) {
      try { await open({ kind: page, id: query.get('target'), cardId: query.get('card') || '' }); }
      catch (error) { alert('无法打开指定工作：' + error.message); }
    }
  }
  return { load, deactivate, open, openFromUrl };
})();
