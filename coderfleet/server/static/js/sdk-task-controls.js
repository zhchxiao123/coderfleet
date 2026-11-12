/* Shared desktop/mobile controls for the current SDK Task. */
const SDKTaskControls = {
  key(taskId, kind) { return `coderfleet-sdk-command:${taskId}:${kind}`; },
  pending(taskId, kind) {
    try { return JSON.parse(sessionStorage.getItem(this.key(taskId, kind)) || 'null'); }
    catch { return null; }
  },
  requestKinds(taskId, category) {
    const kinds = [],prefix = this.key(taskId,category);
    for (let index=0;index<sessionStorage.length;index++) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(prefix)) kinds.push(key.slice(this.key(taskId,'').length));
    }
    return kinds;
  },
  pendingKinds(taskId) { return ['message','interrupt',...this.requestKinds(taskId,'control-')]; },
  hasPendingDelivery(taskId) { return ['message','interrupt'].some(kind=>!!this.pending(taskId,kind)); },
  hasPending(taskId) { return this.pendingKinds(taskId).some(kind=>!!this.pending(taskId,kind)); },
  canInteract(task) { return task?.status === 'running' && task.execution_backend === 'sdk' && task.sdk_control_ready; },
  primaryAction(task, draft, { queued = false, scheduled = false } = {}) {
    if (draft.uploading) return 'uploading';
    const nativeAttachments = draft.nativeAttachments && task?.sdk_capabilities?.includes('multimodal_input');
    const hasInput = !!draft.text.trim() || draft.hasAttachments;
    if (task && this.hasPendingDelivery(task.id) && (task.status !== 'running' || queued || scheduled || (draft.hasAttachments && !nativeAttachments))) return 'check';
    if (hasInput && (queued || scheduled)) return 'queue';
    if (hasInput && draft.hasAttachments && !nativeAttachments) return 'queue';
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
  async execute(taskId, kind, text, images = []) {
    let command = this.pending(taskId, kind);
    if (command && (command.text !== text || JSON.stringify(command.images || []) !== JSON.stringify(images))) throw new Error('上次投递结果尚未确认，请先检查投递结果');
    if (!command) {
      command = { request_id: crypto.randomUUID(), ...(text === undefined ? {} : { text }),...(images.length ? {images} : {}) };
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
    return { ...result, text: command.text, images:command.images || [] };
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
        const results = await Promise.all(this.pendingKinds(task.id).map(action => this.check(task.id, action)));
        for (const result of results) if (result?.status === 'accepted' && result.text !== undefined) editor.clear(result.text,result.images);
        show(results.filter(Boolean).map(result => result.status === 'accepted' ? '已送达当前任务' :
          result.status === 'rejected' ? result.error : '投递结果未知，请保留原请求重试').join('；') || '没有未确认的投递');
      } else {
        const draft = editor.read();
        if (kind === 'message' && draft.images?.length && draft.nativeAttachments && !task.sdk_capabilities?.includes('multimodal_input')) throw new Error('当前 worker 不支持附件插话，请排队发送');
        if (kind === 'message' && (draft.uploading || (draft.hasAttachments && !draft.nativeAttachments) || (!draft.text.trim() && !draft.images?.length))) throw new Error('当前补充消息仅支持已输入的文字，请等待附件上传或选择排队发送');
        show(kind === 'message' ? '正在投递…' : '正在中断…');
        await this.execute(task.id, kind, kind === 'message' ? draft.text : undefined,kind === 'message' && draft.nativeAttachments ? draft.images || [] : []);
        if (kind === 'message') editor.clear(draft.text,draft.nativeAttachments ? draft.images : []);
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
  async executeControl(taskId,operation,args) {
    return this.executeOperation(taskId,operation,args,'control','sdk-control');
  },
  async executeOperation(taskId,operation,args,prefix,route) {
    const kind = prefix + '-' + operation;
    let request = this.pending(taskId,kind);
    if (request && JSON.stringify(request.arguments) !== JSON.stringify(args)) throw new Error('上次操作结果尚未确认，请先检查投递结果');
    if (!request) {
      request = {request_id:crypto.randomUUID(),operation,arguments:args};
      sessionStorage.setItem(this.key(taskId,kind),JSON.stringify(request));
    }
    const response = await fetch(`${typeof API === 'undefined' ? '' : API}/api/tasks/${encodeURIComponent(taskId)}/${route}`, {
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) sessionStorage.removeItem(this.key(taskId,kind));
      throw new Error(result.detail || '操作结果未确认，请检查原请求');
    }
    sessionStorage.removeItem(this.key(taskId,kind));
    return result;
  },
  sessionPanel(taskId) {
    const details = document.createElement('details'); details.className = 'sdk-runtime-panel sdk-session-panel';
    const summary = document.createElement('summary'); summary.textContent = '原生会话与文件恢复'; details.appendChild(summary);
    const body = document.createElement('div'); body.className = 'sdk-runtime-body'; details.appendChild(body);
    let loaded = false;
    const load = async()=>{
      if (!details.open) { loaded=false; return; }
      if (loaded) return;
      loaded = true;
      try {
        const base = typeof API === 'undefined' ? '' : API;
        const [r,c] = await Promise.all([fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}`),fetch(`${base}/api/sdk/capabilities`)]);
        if (!r.ok || !c.ok) throw new Error('读取原生会话能力失败');
        const task = await r.json(),capabilities = await c.json();
        const priorOperation=body.querySelector('[aria-label="原生会话操作"]')?.value;
        const priorArgs=body.querySelector('[aria-label="会话操作参数 JSON"]')?.value;
        body.replaceChildren();
        const refresh=document.createElement('button'); refresh.type='button'; refresh.className='sdk-task-btn'; refresh.textContent='刷新会话信息';
        refresh.onclick=()=>{loaded=false;load();}; body.appendChild(refresh);
        const select = document.createElement('select'); select.setAttribute('aria-label','原生会话操作'); body.appendChild(select);
        const labels = {info:'会话信息',list:'本项目会话',messages:'会话消息',subagents:'子 Agent 列表',subagent_messages:'子 Agent 消息',
          rename:'修改原生标题',tag:'修改原生标签',fork:'原生分叉并新建会话',delete:'删除已归档原生记录',import_store:'导入外部存储'};
        for (const name of Object.keys(capabilities.sessions)) {
          const option = document.createElement('option'); option.value=name; option.textContent=labels[name] || name; select.appendChild(option);
        }
        select.value = priorOperation || 'info';
        const args = document.createElement('textarea'); args.rows=3; args.setAttribute('aria-label','会话操作参数 JSON'); body.appendChild(args);
        const hint = document.createElement('pre'); hint.className='sdk-runtime-output'; body.appendChild(hint);
        const draw = ()=>{
          args.value = select.value === 'delete' ? JSON.stringify({confirm_session_id:task.native_session_id},null,2) : '{}';
          hint.textContent = '参数：' + JSON.stringify(capabilities.sessions[select.value].properties,null,2);
        }; select.addEventListener('change',draw); draw();
        if (priorArgs !== undefined) args.value=priorArgs;
        const submit = document.createElement('button'); submit.type='button'; submit.className='sdk-task-btn'; submit.textContent='执行会话操作'; body.appendChild(submit);
        const output = document.createElement('pre'); output.className='sdk-runtime-output'; output.setAttribute('role','status'); body.appendChild(output);
        const uncertain=this.requestKinds(taskId,'session-').map(kind=>this.pending(taskId,kind)).filter(Boolean);
        if(uncertain.length) output.textContent='未确认的原生操作（请保留原 ID 与参数）：\n'+JSON.stringify(uncertain,null,2);
        submit.onclick = async()=>{
          if (submit.disabled) return;
          if (['delete','fork','import_store'].includes(select.value) && !confirm(select.value === 'delete' ? '永久删除原生记录及子 Agent 记录？文件修改不会恢复。' : '执行所选原生会话操作？')) return;
          submit.disabled=true;
          try {
            const result = await this.executeOperation(taskId,select.value,JSON.parse(args.value),'session','sdk-session');
            output.textContent = JSON.stringify(result,null,2);
          } catch(error) { output.textContent=error.message+'\n'+JSON.stringify(this.pending(taskId,'session-'+select.value) || {},null,2); }
          finally { submit.disabled=false; }
        };
        if (task.sdk_checkpoints?.length) {
          const checkpoints = document.createElement('select'); checkpoints.setAttribute('aria-label','文件检查点');
          for(const id of task.sdk_checkpoints) { const option=document.createElement('option'); option.value=id; option.textContent=id; checkpoints.appendChild(option); }
          checkpoints.value=task.sdk_checkpoints[0]; body.appendChild(checkpoints);
          const recover=document.createElement('button'); recover.type='button'; recover.className='sdk-task-btn'; recover.textContent='创建文件恢复任务'; body.appendChild(recover);
          recover.onclick=async()=>{
            if(recover.disabled || !confirm('将创建恢复 Task，恢复检查点跟踪的文件。Bash、子 Agent 和外部副作用不在保证范围；对话历史不回退。')) return;
            recover.disabled=true;
            const key=this.key(taskId,'rewind');
            try {
              let request=JSON.parse(sessionStorage.getItem(key) || 'null');
              if(request && request.user_message_id !== checkpoints.value) throw new Error('上次恢复提交结果未知，请保留原检查点重试');
              if(!request) { request={request_id:crypto.randomUUID(),user_message_id:checkpoints.value}; sessionStorage.setItem(key,JSON.stringify(request)); }
              const response=await fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}/sdk-rewind`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
              const result=await response.json();
              if(!response.ok) { if(response.status>=400 && response.status<500) sessionStorage.removeItem(key); throw new Error(result.detail || '恢复提交结果未知'); }
              sessionStorage.removeItem(key); output.textContent='恢复 Task：'+result.id+'（可在任务列表查看）';
            } catch(error) { output.textContent=error.message; }
            finally { recover.disabled=false; }
          };
        }
      } catch(error) { loaded=false; body.textContent=error.message; }
    };
    details.addEventListener('toggle',load);
    return details;
  },
  mountOptions(host, scope) {
    if (!host || host.dataset.scope === scope) return;
    host.dataset.scope = scope; host.replaceChildren();
    const details = document.createElement('details'); details.className = 'sdk-runtime-panel';
    const summary = document.createElement('summary'); summary.textContent = 'SDK 参数'; details.appendChild(summary);
    const body = document.createElement('div'); body.className = 'sdk-runtime-body'; details.appendChild(body);
    const note = document.createElement('p'); note.textContent = '留空继承会话参数，{} 恢复默认；显式 permission_mode 优先于全自动选项。仅适用于 SDK 账号；Python 扩展在账号环境中执行。'; body.appendChild(note);
    const input = document.createElement('textarea'); input.rows = 7; input.setAttribute('aria-label','SDK 参数 JSON');
    try { input.value = localStorage.getItem('coderfleet-sdk-options:' + scope) || ''; } catch { input.value = ''; }
    input.addEventListener('input',()=>{ try { localStorage.setItem('coderfleet-sdk-options:' + scope,input.value); } catch {} });
    body.appendChild(input); host._sdkOptions = input;
    const attachmentLabel=document.createElement('label');
    const nativeAttachments=document.createElement('input'); nativeAttachments.type='checkbox'; nativeAttachments.id='sdk-native-attachments';
    attachmentLabel.appendChild(nativeAttachments); attachmentLabel.appendChild(document.createTextNode('附件随当前任务插话（不勾选时排队发送）')); body.appendChild(attachmentLabel);
    const help = document.createElement('pre'); help.className = 'sdk-runtime-output'; body.appendChild(help);
    details.addEventListener('toggle',async()=>{
      if (!details.open || help.textContent) return;
      try {
        const r = await fetch(`${typeof API === 'undefined' ? '' : API}/api/sdk/capabilities`);
        if (!r.ok) throw new Error('读取参数说明失败');
        const data = await r.json();
        help.textContent = '可用参数：' + Object.keys(data.options.properties).join('、') +
          '\n示例：' + JSON.stringify({max_turns:12,max_budget_usd:2,thinking:{type:'adaptive'},effort:'high'},null,2);
      } catch (error) { help.textContent = error.message; }
    });
    host.appendChild(details);
  },
  readOptions() {
    const input = document.getElementById('sdk-options')?._sdkOptions;
    if (!input) return {};
    if (!input.value.trim()) return null;
    const value = JSON.parse(input.value);
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('SDK 参数必须为 JSON 对象');
    return value;
  },
  runtimePanel(task) {
    const details = document.createElement('details');
    details.className = 'sdk-runtime-panel';
    const summary = document.createElement('summary'); summary.textContent = '运行设置'; details.appendChild(summary);
    const body = document.createElement('div'); body.className = 'sdk-runtime-body'; details.appendChild(body);
    let loaded = false;
    details.addEventListener('toggle',async()=>{
      if (!details.open || loaded) return;
      loaded = true;
      try {
        const response = await fetch(`${typeof API === 'undefined' ? '' : API}/api/sdk/capabilities`);
        if (!response.ok) throw new Error('读取运行能力失败');
        const capabilities = await response.json();
        const select = document.createElement('select'); select.setAttribute('aria-label','运行操作');
        for (const [name,schema] of Object.entries(capabilities.controls)) {
          const option = document.createElement('option'); option.value = name; option.textContent = schema.title; select.appendChild(option);
        }
        body.replaceChildren(); body.appendChild(select);
        const fields = document.createElement('div'); fields.className = 'sdk-runtime-fields'; body.appendChild(fields);
        const submit = document.createElement('button'); submit.type = 'button'; submit.className = 'sdk-task-btn'; submit.textContent = '执行操作'; body.appendChild(submit);
        const output = document.createElement('pre'); output.className = 'sdk-runtime-output'; output.setAttribute('role','status'); body.appendChild(output);
        const inputs = new Map();
        const draw = () => {
          fields.replaceChildren(); inputs.clear();
          for (const [name,schema] of Object.entries(capabilities.controls[select.value].properties)) {
            const label = document.createElement('label'); label.textContent = schema.title;
            const input = document.createElement(schema.enum ? 'select' : 'input');
            if (schema.enum) for (const value of schema.enum) {
              const option = document.createElement('option'); option.value = value; option.textContent = value; input.appendChild(option);
            } else input.type = schema.type === 'boolean' ? 'checkbox' : 'text';
            if (name === 'model') input.value = task.model || '';
            if (name === 'mode') input.value = task.sdk_permission_mode || 'acceptEdits';
            if (schema.type === 'boolean') input.checked = true;
            label.appendChild(input); fields.appendChild(label); inputs.set(name,{input,schema});
          }
        };
        select.addEventListener('change',draw); select.value = Object.keys(capabilities.controls)[0]; draw();
        submit.onclick = async()=>{
          if (submit.disabled) return;
          const schema = capabilities.controls[select.value];
          if (schema.confirm && !confirm(schema.confirm)) return;
          const args = {};
          for (const [name,{input,schema}] of inputs) args[name] = schema.type === 'boolean' ? input.checked :
            input.value.trim() || (Array.isArray(schema.type) && schema.type.includes('null') ? null : '');
          submit.disabled = true; output.textContent = '正在请求…';
          try {
            const result = await this.executeControl(task.id,select.value,args);
            output.textContent = JSON.stringify(result.result?.value ?? '操作已确认',null,2);
          } catch (error) { output.textContent = error.message; }
          finally { submit.disabled = false; }
        };
      } catch (error) { loaded = false; body.textContent = error.message; }
    });
    return details;
  },
  mount(host, task, editor) {
    if (!host) return;
    const active = task?.status === 'running' && task.execution_backend === 'sdk' && task.sdk_control_ready;
    if (!task || (!active && !this.hasPending(task.id))) {
      host.replaceChildren(); host.dataset.taskId = ''; host.hidden = true; return;
    }
    const identity = `${task.id}:${!!active}:${(task.sdk_capabilities || []).join(',')}`;
    if (host.dataset.taskId === identity) {
      host._sdkReceipt.hidden = !this.hasPending(task.id);
      host.hidden = !host._sdkStatus.textContent && host._sdkReceipt.hidden && !host._sdkRuntime;
      return;
    }
    host.replaceChildren(); host.dataset.taskId = identity; host._sdkRuntime = null;
    const status = document.createElement('span');
    status.className = 'sdk-task-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    let receiptButton;
    const syncReceipt = () => {
      if (receiptButton) receiptButton.hidden = !this.hasPending(task.id);
      host.hidden = !status.textContent && receiptButton.hidden && !host._sdkRuntime;
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
      const results = await Promise.all(this.pendingKinds(task.id).map(kind => this.check(task.id, kind)));
      for (const result of results) {
        if (result?.status === 'accepted' && result.text !== undefined) editor.clear(result.text,result.images);
      }
      status.textContent = results.filter(Boolean).map(result =>
        result.status === 'accepted' ? '已送达当前任务' : result.status === 'rejected' ? result.error : '投递结果未知，请保留原请求重试').join('；') || '没有未确认的投递';
    });
    host._sdkStatus = status;
    host._sdkReceipt = receiptButton;
    host.appendChild(status);
    if (active && task.sdk_capabilities?.includes('control')) {
      host._sdkRuntime = this.runtimePanel(task);
      host.appendChild(host._sdkRuntime);
    }
    syncReceipt();
  },
};
