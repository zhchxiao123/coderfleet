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
    status.setAttribute('role', 'status');
    const action = (label, handler) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'task-action-btn'; button.textContent = label;
      button.onclick = async () => {
        button.disabled = true;
        try { await handler(); } catch (error) { status.textContent = error.message; }
        finally { button.disabled = false; }
      };
      host.appendChild(button);
    };
    if (active) action('补充到当前任务', async () => {
      const draft = editor.read();
      if (draft.hasAttachments) throw new Error('补充消息目前仅支持文字；附件请使用发送入口排队');
      if (!draft.text.trim()) throw new Error('请先输入补充消息');
      status.textContent = '正在投递…';
      await this.execute(task.id, 'message', draft.text);
      editor.clear(draft.text);
      status.textContent = 'SDK 已接收补充消息，将按运行状态处理';
    });
    if (active) action('中断当前运行', async () => {
      status.textContent = '正在中断…';
      await this.execute(task.id, 'interrupt');
      status.textContent = '已请求原生中断，会话可继续';
    });
    action('检查投递结果', async () => {
      const results = await Promise.all(['message', 'interrupt'].map(kind => this.check(task.id, kind)));
      for (const result of results) {
        if (result?.status === 'accepted' && result.text !== undefined) editor.clear(result.text);
      }
      status.textContent = results.filter(Boolean).map(result =>
        result.status === 'accepted' ? 'SDK 已接收' : result.status === 'rejected' ? result.error : '投递结果未知，请保留原请求重试').join('；') || '没有未确认的投递';
    });
    host.appendChild(status);
  },
};
