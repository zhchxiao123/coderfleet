/* Shared desktop/mobile controls for the current SDK Task. */
const SDKTaskControls = {
  key(taskId, kind) { return `coderfleet-sdk-command:${taskId}:${kind}`; },
  pending(taskId, kind) {
    try { return JSON.parse(sessionStorage.getItem(this.key(taskId, kind)) || 'null'); }
    catch { return null; }
  },
  hasPending(taskId) { return !!(this.pending(taskId, 'message') || this.pending(taskId, 'interrupt')); },
  async execute(taskId, kind, text) {
    let command = this.pending(taskId, kind);
    if (command && command.text !== text) throw new Error('上次投递结果尚未确认，请先检查投递结果');
    if (!command) {
      command = { request_id: crypto.randomUUID(), ...(text === undefined ? {} : { text }) };
      sessionStorage.setItem(this.key(taskId, kind), JSON.stringify(command));
    }
    const response = await fetch(`${typeof API === 'undefined' ? '' : API}/api/tasks/${encodeURIComponent(taskId)}/${kind === 'message' ? 'messages' : 'interrupt'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) sessionStorage.removeItem(this.key(taskId, kind));
      throw new Error(result.detail || '投递未确认，请检查投递结果');
    }
    sessionStorage.removeItem(this.key(taskId, kind));
    return result;
  },
  async check(taskId, kind) {
    const command = this.pending(taskId, kind);
    if (!command) return null;
    const response = await fetch(`${typeof API === 'undefined' ? '' : API}/api/tasks/${encodeURIComponent(taskId)}/commands/${command.request_id}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || '查询失败');
    if (result.status === 'accepted' || result.status === 'rejected') sessionStorage.removeItem(this.key(taskId, kind));
    return { ...result, text: command.text };
  },
  mount(host, task, editor) {
    if (!host) return;
    const active = task?.status === 'running' && task.execution_backend === 'sdk' && task.sdk_control_ready;
    if (!task || (!active && !this.hasPending(task.id))) {
      host.replaceChildren(); host.dataset.taskId = ''; return;
    }
    const identity = `${task.id}:${!!active}`;
    if (host.dataset.taskId === identity) return;
    host.replaceChildren(); host.dataset.taskId = identity;
    const status = document.createElement('span');
    status.className = 'sdk-task-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    let receiptButton;
    const syncReceipt = () => { if (receiptButton) receiptButton.hidden = !this.hasPending(task.id); };
    const action = (kind, label, title, icon, handler) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = `sdk-task-btn sdk-task-btn--${kind}`; button.title = title;
      button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg><span>${label}</span>`;
      button.onclick = async () => {
        button.disabled = true;
        status.dataset.state = 'pending';
        try { await handler(); status.dataset.state = 'settled'; }
        catch (error) { status.textContent = error.message; status.dataset.state = 'error'; }
        finally { button.disabled = false; syncReceipt(); }
      };
      host.appendChild(button);
      return button;
    };
    if (active) action('message', '补充到当前任务', '将输入框的文字补充给当前运行的任务',
      '<path d="M21 10V6a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v14l4-4h5"/><path d="M16 15h6m-3-3v6"/>', async () => {
      const draft = editor.read();
      if (draft.hasAttachments) throw new Error('补充消息目前仅支持文字；附件请使用发送入口排队');
      if (!draft.text.trim()) throw new Error('请先输入补充消息');
      status.textContent = '正在投递…';
      await this.execute(task.id, 'message', draft.text);
      editor.clear(draft.text);
      status.textContent = '已送达当前任务，将按运行进度处理';
    });
    if (active) action('interrupt', '中断当前运行', '中断后可在当前会话继续',
      '<rect x="6" y="6" width="12" height="12" rx="2"/>', async () => {
      status.textContent = '正在中断…';
      await this.execute(task.id, 'interrupt');
      status.textContent = '已请求中断，会话可继续';
    });
    receiptButton = action('receipt', '检查投递结果', '检查上次未确认消息的投递状态',
      '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>', async () => {
      const results = await Promise.all(['message', 'interrupt'].map(kind => this.check(task.id, kind)));
      for (const result of results) {
        if (result?.status === 'accepted' && result.text !== undefined) editor.clear(result.text);
      }
      status.textContent = results.filter(Boolean).map(result =>
        result.status === 'accepted' ? '已送达当前任务' : result.status === 'rejected' ? result.error : '投递结果未知，请保留原请求重试').join('；') || '没有未确认的投递';
    });
    syncReceipt();
    host.appendChild(status);
  },
};
