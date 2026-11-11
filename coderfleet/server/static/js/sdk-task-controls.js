/* Shared desktop/mobile controls for the current SDK Task. */
const SDKTaskControls = {
  key(taskId, kind) { return `coderfleet-sdk-command:${taskId}:${kind}`; },
  pending(taskId, kind) {
    try { return JSON.parse(sessionStorage.getItem(this.key(taskId, kind)) || 'null'); }
    catch { return null; }
  },
  hasPending(taskId) { return !!(this.pending(taskId, 'message') || this.pending(taskId, 'interrupt')); },
  canInteract(task) { return task?.status === 'running' && task.execution_backend === 'sdk' && task.sdk_control_ready; },
  primaryAction(task, draft, { queued = false, scheduled = false } = {}) {
    if (draft.uploading) return 'uploading';
    const hasInput = !!draft.text.trim() || draft.hasAttachments;
    if (task && this.hasPending(task.id) && (task.status !== 'running' || queued || scheduled || draft.hasAttachments)) return 'check';
    if (hasInput && (queued || scheduled)) return 'queue';
    if (hasInput && draft.hasAttachments) return 'queue';
    if (task?.status === 'running' && task.execution_backend === 'sdk') {
      if (!task.sdk_control_ready) return 'connecting';
      return hasInput ? 'message' : 'interrupt';
    }
    return hasInput ? 'queue' : task?.status === 'running' ? 'stop' : 'empty';
  },
  renderPrimary(button, action, { compact = false, queueFull = false } = {}) {
    if (button.dataset.busy === '1') return;
    button.classList.remove('chat-send-btn-loading');
    const titles = { message:'补充到当前任务', interrupt:'中断当前运行，会话可继续',
      queue:'发送新任务，运行中时排队', stop:'强制终止当前任务', empty:'发送消息',
      connecting:'当前 SDK 任务尚未就绪；可以选择排队发送', uploading:'正在上传附件，请稍候', check:'检查上次未确认的投递' };
    const stop = action === 'interrupt' || action === 'stop';
    button.dataset.action = action;
    button.title = action === 'queue' && queueFull ? '队列已满，请等待或删除排队任务' : titles[action];
    button.setAttribute('aria-label', stop ? (action === 'interrupt' ? '中断当前运行' : '强制终止当前任务') : button.title);
    button.disabled = ['empty','connecting','uploading'].includes(action) || (action === 'queue' && queueFull);
    if (stop) button.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
    else if (action === 'check') button.textContent = compact ? '查' : '查投递';
    else if (action === 'connecting' || action === 'uploading') button.textContent = compact ? '…' : action === 'uploading' ? '上传中' : '连接中';
    else if (compact) button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z"/></svg>';
    else button.textContent = '发送';
  },
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
  async perform(host, task, kind, editor) {
    this.mount(host, task, editor);
    const status = host?._sdkStatus;
    const show = (text, error = false) => {
      if (!status) return;
      host.hidden = false;
      status.textContent = text;
      status.dataset.state = error ? 'error' : 'settled';
    };
    try {
      if (kind === 'check') {
        const results = await Promise.all(['message','interrupt'].map(action => this.check(task.id, action)));
        for (const result of results) if (result?.status === 'accepted' && result.text !== undefined) editor.clear(result.text);
        show(results.filter(Boolean).map(result => result.status === 'accepted' ? '已送达当前任务' :
          result.status === 'rejected' ? result.error : '投递结果未知，请保留原请求重试').join('；') || '没有未确认的投递');
      } else {
        const draft = editor.read();
        if (kind === 'message' && (draft.uploading || draft.hasAttachments || !draft.text.trim())) throw new Error('当前补充消息仅支持已输入的文字，请等待附件上传或选择排队发送');
        show(kind === 'message' ? '正在投递…' : '正在中断…');
        await this.execute(task.id, kind, kind === 'message' ? draft.text : undefined);
        if (kind === 'message') editor.clear(draft.text);
        show(kind === 'message' ? '已送达当前任务，将按运行进度处理' : '已请求中断，会话可继续');
      }
      return true;
    } catch (error) {
      show(error.message, true);
      return false;
    } finally {
      this.mount(host, task, editor);
    }
  },
  mount(host, task, editor) {
    if (!host) return;
    const active = task?.status === 'running' && task.execution_backend === 'sdk' && task.sdk_control_ready;
    if (!task || (!active && !this.hasPending(task.id))) {
      host.replaceChildren(); host.dataset.taskId = ''; host.hidden = true; return;
    }
    const identity = `${task.id}:${!!active}`;
    if (host.dataset.taskId === identity) {
      host._sdkReceipt.hidden = !this.hasPending(task.id);
      host.hidden = !host._sdkStatus.textContent && host._sdkReceipt.hidden;
      return;
    }
    host.replaceChildren(); host.dataset.taskId = identity;
    const status = document.createElement('span');
    status.className = 'sdk-task-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    let receiptButton;
    const syncReceipt = () => {
      if (receiptButton) receiptButton.hidden = !this.hasPending(task.id);
      host.hidden = !status.textContent && receiptButton.hidden;
    };
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
    receiptButton = action('receipt', '检查投递结果', '检查上次未确认消息的投递状态',
      '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>', async () => {
      const results = await Promise.all(['message', 'interrupt'].map(kind => this.check(task.id, kind)));
      for (const result of results) {
        if (result?.status === 'accepted' && result.text !== undefined) editor.clear(result.text);
      }
      status.textContent = results.filter(Boolean).map(result =>
        result.status === 'accepted' ? '已送达当前任务' : result.status === 'rejected' ? result.error : '投递结果未知，请保留原请求重试').join('；') || '没有未确认的投递';
    });
    host._sdkStatus = status;
    host._sdkReceipt = receiptButton;
    syncReceipt();
    host.appendChild(status);
  },
};
