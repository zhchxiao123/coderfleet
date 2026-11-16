let mobileWorkView = null;
let mobileWorkOpening = 0;

async function openMobileWork() {
  const dialog = document.getElementById('mobile-workbench');
  if (!mobileWorkView) {
    mobileWorkView = FleetWorkView.create(document.getElementById('mobile-workbench-content'), {
      onOpen: openMobileWorkTarget,
      onChat: project => {
        dialog.close();
        const selected = projects.find(item => item.name === project);
        if (selected) startNew(selected);
        else backToList();
      },
    });
    dialog.addEventListener('close', () => { ++mobileWorkOpening; mobileWorkView.deactivate(); });
  }
  if (!dialog.open) dialog.showModal();
  return mobileWorkView.refresh();
}

async function openMobileWorkTarget(target) {
  const request = ++mobileWorkOpening;
  const dialog = document.getElementById('mobile-workbench');
  let record = await FleetWorkView.readTarget(target);
  let scopedTasks = [];
  if (target.kind === 'task' && record.conversation_id) {
    record = await FleetWorkView.readTarget({ kind: 'conversation', id: record.conversation_id });
    target = { kind: 'conversation', id: record.id };
  }
  if (target.kind === 'conversation') {
    scopedTasks = await api(`/api/tasks?conversation_id=${encodeURIComponent(record.id)}&limit=200`);
  }
  if (request !== mobileWorkOpening || !dialog.open) return;
  if (target.kind === 'conversation') {
    convs = [...convs.filter(conv => conv.id !== record.id), record];
    const byId = new Map(tasks.map(task => [task.id, task]));
    scopedTasks.forEach(task => byId.set(task.id, task));
    tasks = [...byId.values()];
    await openConv(record.id);
    dialog.close();
  } else if (target.kind === 'task') {
    tasks = [...tasks.filter(task => task.id !== record.id), record];
    openOneOff(record.id);
    dialog.close();
  } else {
    const query = new URLSearchParams({ workbench: target.kind, target: target.id });
    if (target.cardId) query.set('card', target.cardId);
    location.href = `/?${query}`;
  }
}
