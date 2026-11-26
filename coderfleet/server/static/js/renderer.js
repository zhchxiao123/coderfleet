// ══════════════════════════════════════════════════════════════
//  ChatLogRenderer — 把 JSONL 日志渲染成对话
// ══════════════════════════════════════════════════════════════
class ChatLogRenderer {
  // MCP 全名，Claude 侧看到的 Intervention 工具（issue #69 Slice 1 的 ask_user_question
  // 桥接工具）——跟 CC 原生的 'AskUserQuestion' 是两个不同的 tool_use.name，但共用同一套
  // 问答卡片渲染（_toolUseAskUserQuestion），区别只在于：这个工具的卡片在任务运行中、
  // 还没等到 tool_result 时会渲染成可提交的实时表单；SDK 原生提问也走相同表单。
  static INTERVENTION_TOOL_NAME = 'mcp__coderfleet__ask_user_question';
  static COMMAND_STATES = {
    queued:{label:'指令排队中',rank:0},started:{label:'指令执行中',rank:1},
    completed:{label:'指令处理已结束',rank:2},cancelled:{label:'指令已取消',rank:2},
    discarded:{label:'指令未执行',rank:2},refused:{label:'指令未被接受',rank:2},
  };

  constructor(container, isRunning = false, foldProcess = false, projectName = null, taskId = null, taskTiming = {}) {
    this.container = container;   // #log-content div
    this.taskId = taskId;       // 提交 Intervention 答案时要 POST 去哪个任务
    this.taskTiming = taskTiming || {};
    this.inner = null;        // .chat-log div
    this.permissionMap = {};
    this.toolMap = {};          // tool_use_id → { headerEl, badgeEl, outputEl, exitEl, toolName, input, wrap }
    this.subagentRenderers = {}; // Task/Agent 工具的 tool_use_id → { renderer, toggleRowEl, revealed }
    // TaskCreate/TaskUpdate/TaskList（agent 编排用的任务队列，跟上面注释里派生子agent
    // 的 Task/Agent 工具是两码事）的累加快照：CC 分配的数字 id(string) → {subject, status, activeForm}。
    // 单次 TaskCreate/TaskUpdate 调用只改动其中一条，但每次渲染都展示整份看板的当前状态。
    this.taskBoard = new Map();
    this.taskBoardEl = null; this.taskBoardIconEl = null; this.taskBoardLabelEl = null; this.taskBoardCountEl = null; this.taskBoardListEl = null;
    this._buf = '';          // SSE 行缓冲
    this._jsonLineBuffer = ''; // 跨行 JSON 事件缓冲
    this._footerRendered = false;
    this.executionBackend = 'cli'; this.interrupted = false;
    this._resetSDKRendering();
    this._isPending = false;   // renderPending() 后首次 push() 时清除占位 pill
    this.isRunning = isRunning;   // 是否正在运行
    this.foldProcess = foldProcess; // 是否折叠最新步骤
    this.projectName = projectName; // 所属项目名，用于 CF_SEND 文件下载链接

    // 折叠辅助字段
    this.processWrapper = null;
    this.processBody = null;
    this.toolCount = 0;
    this.idPrefix = Math.random().toString(36).slice(2, 8);
    this.lastBubbleEl = null;   // 保存最后一条 AI 回复节点的引用

    // Hermes plain-text parser state
    this.accountType = '';
    this._hermesState = 'init';   // init | in_response
    this._hermesResponseBuf = [];
    this._hermesDuration = '';
    this._hermesMessages = '';
    this._hermesSessionId = '';

    // Grok streaming-json parser state（支持 thought/text 交替出现）
    this._grokCurrentType    = null;   // 'thought' | 'text' | null —— 当前正在输出的段落类型
    this._grokCurrentBuf     = '';    // 当前段落的已累积文本
    this._grokCurrentEl      = null;  // 当前段落的内容 DOM 元素
    this._grokCurrentTextRef = null;  // {value} 引用，供文本气泡的复制按钮闭包使用
    this._grokRafPending     = false; // requestAnimationFrame 节流标志
    this._grokSegCount       = 0;     // 段落序号，保证元素 ID 唯一
  }

  _resetSDKRendering() {
    this._timeGeneration = (this._timeGeneration || 0) + 1;
    this._pendingMessageClock = null;
    if (this.streamFrame != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.streamFrame);
    for (const child of Object.values(this.subagentRenderers || {})) child.renderer._resetSDKRendering();
    this.backgroundTasks = new Map();
    this.nativeCommands = new Map();
    this.streamMessageId = ''; this.streamBlocks = new Map(); this.streamDirty = new Set(); this.streamFrame = null;
    this.lastSDKText = null; this.lastSDKMessageId = ''; this.lastSDKTextParts = [];
    this.sdkInputs = new Map();
    this.sdkTurnInputs = new Set(); this.sdkTurnTarget = null;
  }

  _ensureProcessWrapper() {
    if (this.processWrapper) return;

    this.processWrapper = document.createElement('div');
    this.processWrapper.className = 'timeline-node intermediate-process-wrapper';

    this.processWrapper.innerHTML = `
  <button type="button" class="intermediate-process-header" aria-expanded="false">
    <div class="process-title-area">
      <span class="process-icon" aria-hidden="true">›</span>
      <span class="process-title-text">${this.isRunning ? '正在处理' : '执行详情'}</span>
      <span class="process-stats-badge" id="ps-${this.idPrefix}" style="display:none">0 条记录</span>
    </div>
    <span class="process-toggle-btn" id="pb-${this.idPrefix}">执行详情</span>
  </button>
  <div class="intermediate-process-body collapsed" id="pbody-${this.idPrefix}"></div>
`;

    this.inner.appendChild(this.processWrapper);
    this.processBody = this.processWrapper.querySelector(`#pbody-${this.idPrefix}`);
    this.processBody.classList.add('collapsed');

    const header = this.processWrapper.querySelector('.intermediate-process-header');
    const toggleBtn = this.processWrapper.querySelector(`#pb-${this.idPrefix}`);
    header.addEventListener('click', () => {
      const isCollapsed = this.processBody.classList.toggle('collapsed');
      toggleBtn.textContent = isCollapsed ? '执行详情' : '收起详情';
      header.setAttribute('aria-expanded',String(!isCollapsed));
    });
  }

  _processStage(label, attention = false) {
    if (!attention && this.isRunning && this._hasPendingAction()) label = '等待您的回答或授权';
    if (this.foldProcess) {
      this._ensureProcessWrapper();
      this.processWrapper.querySelector('.process-title-text').textContent = label;
      if (attention && this.isRunning) {
        this.processBody.classList.remove('collapsed');
        this.processWrapper.querySelector('.intermediate-process-header').setAttribute('aria-expanded','true');
        this.processWrapper.querySelector(`#pb-${this.idPrefix}`).textContent = '收起详情';
      }
    }
    if (attention && this.isRunning) this.onNeedsAttention?.();
  }

  _hasPendingAction() {
    return Object.values(this.toolMap).some(entry=>entry.isLive) ||
      Object.values(this.permissionMap).some(entry=>entry.isLive) ||
      Object.values(this.subagentRenderers).some(child=>child.renderer._hasPendingAction());
  }

  _refreshWaitingStage() {
    if (this.isRunning) this._processStage('继续处理中');
    this.onAttentionResolved?.();
  }

  _appendToProcess(el) {
    this._ensureProcessWrapper();
    this.processBody.appendChild(el);
    this.toolCount++;
    const badge = this.processWrapper.querySelector(`#ps-${this.idPrefix}`);
    if (badge) {
      badge.style.display = '';
      badge.textContent = `${this.toolCount} 条记录`;
    }
  }

  _appendNode(el) {
    if (this.foldProcess && !el.classList.contains('is-error')) {
      this._appendToProcess(el);
    } else {
      this.inner.appendChild(el);
    }
  }

  renderPending() {
    this.container.innerHTML = '<div class="chat-log timeline"></div>';
    this.inner = this.container.querySelector('.chat-log');
    const el = document.createElement('div');
    el.className = 'chat-sys-event timeline-node is-muted';
    el.innerHTML = `
      <span class="chat-sys-pill" style="background: rgba(148, 163, 184, 0.08); border-color: rgba(148, 163, 184, 0.22); color: #cbd5e1;">
        <span style="display: inline-block; animation: spin 2s linear infinite; margin-right: 6px;">⏳</span> 任务排队中，等待空闲账号...
      </span>
    `;
    this.inner.appendChild(el);
    this._isPending = true;
  }

  // 账号空闲时的乐观占位：SSE 首条数据到来后自动被 _isPending 机制清除
  renderExecuting() {
    this.container.innerHTML = '<div class="chat-log timeline"></div>';
    this.inner = this.container.querySelector('.chat-log');
    const el = document.createElement('div');
    el.className = 'chat-sys-event timeline-node is-muted';
    el.innerHTML = `
      <span class="chat-sys-pill" style="background: rgba(13,148,136,0.06); border-color: rgba(13,148,136,0.22); color: var(--accent,#0d9488);">
        <span style="display: inline-block; animation: spin 1.2s linear infinite; margin-right: 6px;">⚙️</span> AI 正在执行...
      </span>
    `;
    this.inner.appendChild(el);
    this._isPending = true;
  }

  renderScheduled(executeAt) {
    this.container.innerHTML = '<div class="chat-log timeline"></div>';
    this.inner = this.container.querySelector('.chat-log');
    const displayTime = executeAt ? executeAt.replace('T', ' ') : '';
    const el = document.createElement('div');
    el.className = 'chat-sys-event timeline-node is-muted';
    el.innerHTML = `
      <span class="chat-sys-pill" style="background: rgba(245, 158, 11, 0.08); border-color: rgba(245, 158, 11, 0.22); color: #f59e0b;">
        <span style="margin-right: 6px;">⏰</span> 已定时：将在 ${esc(displayTime)} 自动发送
      </span>
    `;
    this.inner.appendChild(el);
  }

  // ── 全量渲染 ─────────────────────────────────────────────
  render(text, accountType = '') {
    this.accountType = accountType || this.accountType;
    this.container.innerHTML = '<div class="chat-log timeline"></div>';
    this.inner = this.container.querySelector('.chat-log');
    this.toolMap = {};
    this._resetSDKRendering();
    this.subagentRenderers = {};
    this.taskBoard = new Map();
    this.taskBoardEl = null; this.taskBoardIconEl = null; this.taskBoardLabelEl = null; this.taskBoardCountEl = null; this.taskBoardListEl = null;
    this._buf = '';
    this._jsonLineBuffer = '';
    this._footerRendered = false;
    this.executionBackend = 'cli'; this.interrupted = false;
    this.processWrapper = null;
    this.processBody = null;
    this.toolCount = 0;
    this.lastBubbleEl = null;
    this._hermesState = 'init';
    this._hermesResponseBuf = [];
    this._hermesDuration = '';
    this._hermesMessages = '';
    this._hermesSessionId = '';
    this._grokCurrentType    = null;
    this._grokCurrentBuf     = '';
    this._grokCurrentEl      = null;
    this._grokCurrentTextRef = null;
    this._grokRafPending     = false;
    this._grokSegCount       = 0;

    const lines = text.split('\n');
    let state = 'before';   // before | header | body | footer
    let headerLines = [];
    let bodyLines = [];
    let footerLines = [];

    const nextNonEmptyLine = (start) => {
      for (let i = start; i < lines.length; i++) {
        const candidate = lines[i].trim();
        if (candidate) return candidate;
      }
      return '';
    };
    const isFooterSeparator = (line, idx) => {
      if (!line.startsWith('======')) return false;
      const next = nextNonEmptyLine(idx + 1);
      return next.startsWith('finished:') || next.startsWith('usage status:');
    };

    for (let idx = 0; idx < lines.length; idx++) {
      const raw = lines[idx];
      const line = raw.trimEnd();
      if (state === 'before') {
        if (line.startsWith('=== CoderFleet Task Log ===') || line.startsWith('=== AICM Task Log ===')) { state = 'header'; headerLines = [line]; }
        continue;
      }
      if (state === 'header') {
        if (line.startsWith('======')) { state = 'body'; this._renderHeader(headerLines); continue; }
        headerLines.push(line);
        continue;
      }
      if (state === 'body') {
        if (isFooterSeparator(line, idx)) { this._renderBody(bodyLines); state = 'footer'; continue; }
        bodyLines.push(raw);
        continue;
      }
      if (state === 'footer') {
        if (line.trim()) footerLines.push(line);
      }
    }

    if (state === 'body') this._renderBody(bodyLines);
    if (footerLines.length) this._renderFooter(footerLines.join(' '));
  }

  _renderBody(lines) {
    if (!lines.length) return;
    if (this.accountType === 'hermes' || this.accountType === 'grok' || this.accountType === 'kimi') {
      for (const raw of lines) {
        const line = raw.trim();
        if (line) this._processLine(line);
      }
      this._flushJsonLineBuffer();
      return;
    }
    this._processJsonBodyText(lines.join('\n'));
  }

  _processJsonBodyText(text) {
    let rawLine = '';
    let jsonStart = -1;
    let depth = 0;
    let inString = false;
    let escape = false;

    const flushRawLine = () => {
      const line = rawLine.trim();
      rawLine = '';
      if (line) this._rawLine(line);
    };

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (jsonStart < 0) {
        if (ch === '{') {
          flushRawLine();
          jsonStart = i;
          depth = 1;
          inString = false;
          escape = false;
        } else if (ch === '\n') {
          flushRawLine();
        } else {
          rawLine += ch;
        }
        continue;
      }

      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;

      if (depth === 0) {
        const candidate = text.slice(jsonStart, i + 1);
        try {
          this._event(JSON.parse(candidate), candidate);
        } catch {
          this._rawLine(candidate);
        }
        jsonStart = -1;
      }
    }

    flushRawLine();
    if (jsonStart >= 0) {
      this._rawLine(text.slice(jsonStart).trim());
    }
  }

  // ── 增量推送（SSE 每行调用一次）─────────────────────────
  push(line) {
    if (!line.trim()) return;

    // 首次收到实际内容时清除 renderPending() 留下的占位 pill。
    // 场景：账号空闲时任务瞬间启动，tail=0 的 SSE 跳过了日志头，直接推后续内容。
    if (this._isPending) {
      this._isPending = false;
      if (this.inner) this.inner.innerHTML = '';
      this.toolMap = {};
      this._resetSDKRendering();
      this.subagentRenderers = {};
      this.taskBoard = new Map();
      this.taskBoardEl = null; this.taskBoardIconEl = null; this.taskBoardLabelEl = null; this.taskBoardCountEl = null; this.taskBoardListEl = null;
      this._jsonLineBuffer = '';
      this._footerRendered = false;
      this.executionBackend = 'cli'; this.interrupted = false;
      this.processWrapper = null;
      this.processBody = null;
      this.toolCount = 0;
      this.lastBubbleEl = null;
    }

    if (line.startsWith('=== CoderFleet Task Log ===') || line.startsWith('=== AICM Task Log ===')) {
      if (this.inner && this.inner.querySelector('.chat-meta-block')) {
        return;
      }
      if (this.inner) {
        this.inner.innerHTML = '';
      }
      this.toolMap = {};
      this._resetSDKRendering();
      this.subagentRenderers = {};
      this.taskBoard = new Map();
      this.taskBoardEl = null; this.taskBoardIconEl = null; this.taskBoardLabelEl = null; this.taskBoardCountEl = null; this.taskBoardListEl = null;
      this._jsonLineBuffer = '';
      this._footerRendered = false;
      this.executionBackend = 'cli'; this.interrupted = false;
      this.processWrapper = null;
      this.processBody = null;
      this.toolCount = 0;
      this.lastBubbleEl = null;

      this._isCollectingHeader = true;
      this._headerLines = [line];
      return;
    }

    if (this._isCollectingHeader) {
      if (line.startsWith('======')) {
        this._isCollectingHeader = false;
        this._renderHeader(this._headerLines);
      } else {
        this._headerLines.push(line);
      }
      return;
    }

    // 跳过已渲染的头尾标记（初次全量加载后 SSE 会重复推）
    if (line.startsWith('=== CoderFleet') || line.startsWith('=== AICM') || line.startsWith('======')) return;
    if (line.startsWith('id:') || line.startsWith('account:') ||
      line.startsWith('project:') || line.startsWith('started:') ||
      line.startsWith('prompt:') || line.startsWith('container')) return;
    if (line.startsWith('finished:')) {
      this._flushJsonLineBuffer();
      if (!this._footerRendered) this._renderFooter(line);
      return;
    }
    this._processLine(line.trim());
  }

  // ── 私有：单行处理 ────────────────────────────────────────
  _processLine(line) {
    if (this.accountType === 'hermes') { this._hermesLine(line); return; }
    if (this.accountType === 'grok')   { this._grokLine(line);   return; }
    if (this.accountType === 'kimi')   { this._kimiLine(line);   return; }
    if (!line.startsWith('{') && !this._jsonLineBuffer) { this._rawLine(line); return; }
    this._jsonLineBuffer = this._jsonLineBuffer ? (this._jsonLineBuffer + line) : line;
    let d;
    try { d = JSON.parse(this._jsonLineBuffer); } catch { return; }
    const rawEvent = this._jsonLineBuffer;
    this._jsonLineBuffer = '';
    this._event(d, rawEvent);
  }

  _flushJsonLineBuffer() {
    if (!this._jsonLineBuffer) return;
    const pending = this._jsonLineBuffer;
    this._jsonLineBuffer = '';
    this._rawLine(pending);
  }

  // ── 私有：事件分发 ────────────────────────────────────────
  _event(d, rawEvent = '') {
    if (d.type === 'system' && d.subtype === 'coderfleet_event_clock') return this._applyMessageClock(d);
    const previous = this._messageEvent;
    const record = {timestamp:d.timestamp ?? d.message?.timestamp ?? d.part?.time?.end ?? d.part?.time?.created,
      targets:[],rawEvent,order:this._messageOrder = (this._messageOrder || 0) + 1};
    this._messageEvent = record;
    try {
      const result = this._dispatchEvent(d);
      this._trackSDKInput(d);
      return result;
    }
    finally {
      this._pendingMessageClock = rawEvent && record.targets.length ? record : null;
      this._messageEvent = previous;
    }
  }

  _paintMessageTime(node, value, label, order = 0, source = 'event') {
    const html = renderMessageTime(value, label, source === 'task' ? '本轮完成 · ' : '');
    if (!html || Number(node.dataset.messageTimeOrder || 0) > order) return;
    node.querySelector('.bubble-time-slot').innerHTML = html;
    node.dataset.messageTimeSource = source;
    node.dataset.messageTimeOrder = String(order);
  }

  _applyMessageClock(clock) {
    const record = this._pendingMessageClock;
    this._pendingMessageClock = null;
    if (!record || renderMessageTime(record.timestamp, '') || !renderMessageTime(clock.at, '') ||
        !/^[a-f0-9]{64}$/.test(clock.event_hash || '') || typeof crypto === 'undefined' || !crypto.subtle) return;
    const generation = this._timeGeneration;
    // The clock follows its original event. Verify its raw-byte hash before using
    // it; async completion must not update an old render or a newer message time.
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(record.rawEvent)).then(bytes => {
      const hash = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
      if (hash !== clock.event_hash || generation !== this._timeGeneration) return;
      for (const {node,label} of record.targets) this._paintMessageTime(node, clock.at, label, record.order);
    }).catch(() => { /* Keep recorded Task timing when Web Crypto is unavailable. */ });
  }

  _recordMessageTime(node, label = '回复时间') {
    if (!node) return;
    if (this._messageEvent) this._messageEvent.targets.push({node,label});
    this._paintMessageTime(node, this._messageEvent?.timestamp, label, this._messageEvent?.order);
  }

  _prepareReplyTime(node) {
    if (this.lastBubbleEl?.dataset.messageTimeSource === 'task') {
      this.lastBubbleEl.querySelector('.bubble-time-slot').innerHTML = '';
    }
    this._paintMessageTime(node, this.taskTiming.finished, '本轮完成时间（未记录单条回复时间）', 0, 'task');
    this._recordMessageTime(node);
  }

  _inputEntry(identity) {
    if (!this.sdkInputs.has(identity)) this.sdkInputs.set(identity,{state:'delivered',node:null,target:null});
    return this.sdkInputs.get(identity);
  }

  _paintSDKInput(entry) {
    if (!entry.node) return;
    const button = entry.node.querySelector('.sdk-input-status');
    button.textContent = {delivered:'已投递',consumed:'已纳入本轮',completed:'本轮完成',
      interrupted:'本轮已中断',failed:'本轮失败',unknown:
        `${entry.taskOutcome === 'killed' ? '任务已中断' : entry.taskOutcome === 'failed' ? '任务失败' : '任务结束'} · 归属未确认`}[entry.state];
    button.disabled = !entry.target;
    button.title = entry.target ? '定位对应回复' : '等待 SDK 返回对应消息的处理结果';
    entry.node.dataset.deliveryState = entry.state;
  }

  _sdkMessageAccepted(event) {
    if (event.task_id && this.taskId && event.task_id !== this.taskId) return;
    // Historical workers have a durable request ID but no native UUID. Keep
    // these messages visible without guessing which reply consumed them.
    const identity = event.user_message_uuid || `legacy:${event.request_id}`;
    const entry = this._inputEntry(identity);
    if (entry.node) return;
    const node = document.createElement('div');
    node.className = 'sdk-supplement-message timeline-node';
    node.dataset.inputUuid = identity;
    node.innerHTML = `<div class="sdk-supplement-stack">
      <div class="user-bubble"><div class="user-bubble-content">${esc(event.text || '')}</div>
        ${event.attachment_count ? `<small>${esc(event.attachment_count)} 个附件</small>` : ''}</div>
      <div class="message-footer user-message-footer"><span class="bubble-time-slot"></span>
        <button type="button" class="sdk-input-status"></button></div></div>`;
    entry.node = node;
    node.querySelector('.sdk-input-status').addEventListener('click',()=>{
      if (!entry.target) return;
      // A previous reply may now be inside execution details.
      if (this.processBody?.contains(entry.target)) {
        this.processBody.classList.remove('collapsed');
        this.processWrapper.querySelector('.intermediate-process-header').setAttribute('aria-expanded','true');
        this.processWrapper.querySelector(`#pb-${this.idPrefix}`).textContent = '收起详情';
      }
      entry.target.scrollIntoView?.({behavior:'smooth',block:'center'});
    });
    this._recordMessageTime(node,'补充消息接收时间');
    this.inner.appendChild(node);
    this._paintSDKInput(entry);
  }

  _trackSDKInput(event) {
    if (this.executionBackend !== 'sdk' || event.parent_tool_use_id || event.coderfleet_synthetic ||
        !['assistant','stream_event','result'].includes(event.type)) return;
    const identities = [event.user_message_uuid,...(Array.isArray(event.user_message_uuids) ? event.user_message_uuids.slice(0,64) : [])]
      .filter(value=>typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value));
    // Native attribution is sparse: only the first event after it changes
    // carries UUIDs. Keep that context through tool calls/deltas, bounded by
    // the root result, never by a global "last reply" or accepted input order.
    for (const identity of identities) this.sdkTurnInputs.add(identity);
    let target = this._messageEvent?.targets.filter(item=>item.node.classList.contains('ai-reply')).at(-1)?.node;
    if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') {
      target = this.streamBlocks.get(`${this.streamMessageId}:${event.event.index ?? 0}`)?.node;
    }
    if (target) this.sdkTurnTarget = target;
    for (const identity of this.sdkTurnInputs) {
      const entry = this._inputEntry(identity);
      if (this.sdkTurnTarget) entry.target = this.sdkTurnTarget;
      if (event.type === 'result') {
        entry.state = event.terminal_reason?.startsWith('aborted') || this.interrupted ? 'interrupted' :
          event.is_error || event.subtype !== 'success' ? 'failed' : 'completed';
      } else if (entry.state === 'delivered') entry.state = 'consumed';
      this._paintSDKInput(entry);
    }
    if (event.type === 'result') { this.sdkTurnInputs.clear(); this.sdkTurnTarget = null; }
  }

  _finishSDKInputs(status) {
    for (const entry of this.sdkInputs.values()) {
      if (['delivered','consumed'].includes(entry.state)) {
        entry.state = 'unknown'; entry.taskOutcome = status;
        this._paintSDKInput(entry);
      }
    }
  }

  _dispatchEvent(d) {
    // Claude 的 Task/Agent 子agent事件带 parent_tool_use_id，指向发起它的
    // tool_use.id——这类事件属于子agent自己的会话，不进主时间线，转发给
    // 对应工具卡片内嵌的子会话渲染器（后者是一个完整的 ChatLogRenderer 实例，
    // 复用同一套气泡/工具卡/diff/问答渲染逻辑，天然支持递归嵌套）。
    if (d.parent_tool_use_id) {
      const sub = this.subagentRenderers[d.parent_tool_use_id];
      if (sub) {
        sub.renderer._event(d);
        if (!sub.revealed) { sub.revealed = true; sub.toggleRowEl.style.display = ''; }
        return;
      }
    }
    switch (d.type) {
      // Claude
      case 'system': return this._claudeSys(d);
      case 'stream_event': return this._claudeStream(d.event);
      case 'assistant': return this._claudeAssistant(d.message);
      case 'user': return this._claudeUser(d.message);
      case 'result': return this._claudeResult(d);
      case 'command_lifecycle': return this._nativeCommandLifecycle(d);
      case 'rate_limit_event': return this._claudeRateLimit(d);
      case 'tool_progress': return; // Routine elapsed-time/heartbeat telemetry; tool outcomes retain failures.
      // Codex
      case 'thread.started': return this._pill('会话开始', d.thread_id ? '#' + String(d.thread_id).slice(0, 8) : '');
      case 'turn.started': return; // 太噪，静默
      case 'turn.ended': return;
      case 'thread.ended': return this._codexEnd(d);
      case 'message': return this._codexMessage(d);
      case 'tool_call': return this._codexToolCall(d);
      case 'tool_result': return this._codexToolResult(d);
      // OpenCode 的 reasoning 事件把文本包在 d.part.text 里（跟它的 text 事件一样），
      // Codex 的是扁平 d.text/d.thinking——按顺序试探两种取值即可共用一个 case。
      case 'reasoning': return this._thinking(d.part?.text || d.text || d.thinking || '');
      case 'item.started': return this._codexItemStarted(d.item);
      case 'item.updated': return this._codexItemUpdated(d.item);
      case 'item.completed': return this._codexItemCompleted(d.item);
      // Codex/OpenCode 共用：CLI 级终止错误（限流、鉴权失败、进程崩溃等）。
      // 之前没有这个 case，会掉进 default 变成一坨原始 JSON。
      case 'turn.failed': return this._agentError(d);
      case 'error': return this._agentError(d);
      // OpenCode
      case 'step_start': return this._opencodeStepStart(d);
      case 'tool_use': return this._opencodeToolUse(d);
      case 'text': return this._opencodeText(d);
      case 'step_finish': return this._opencodeStepFinish(d);
      // Pi Agent
      case 'session': return this._piSession(d);
      case 'agent_start': return; // 太噪，静默
      case 'turn_start': return;
      case 'turn_end': return;
      case 'message_start': return;
      case 'message_update': return; // 只在 message_end 渲染完整内容，不逐 delta 渲染
      case 'message_end': return this._piMessageEnd(d);
      case 'tool_execution_start': return this._piToolStart(d);
      case 'tool_execution_update': return; // 太噪，静默；完成时 tool_execution_end 给出完整结果
      case 'tool_execution_end': return this._piToolEnd(d);
      case 'agent_end': return this._piAgentEnd(d);
      case 'agent_settled': return;
      default:
        return this._rawLine(JSON.stringify(d));
    }
  }

  // ── Header 块 ─────────────────────────────────────────────
  _renderHeader(lines) {
    const el = document.createElement('div');
    el.className = 'chat-meta-block';
    el.classList.add('timeline-node', 'is-muted');
    const html = lines
      .filter(l => !l.startsWith('===') && l.includes(':'))
      .map(l => {
        const i = l.indexOf(':');
        const key = l.slice(0, i).trim();
        let val = l.slice(i + 1).trim();
        if (key === 'prompt') {
          val = val.replace(/\\n/g, '\n');
        }
        return `<div class="meta-row"><span class="meta-key">${esc(key)}:</span> <span class="meta-val">${esc(val)}</span></div>`;
      }).join('');
    el.innerHTML = html;
    this._appendNode(el);
  }

  // ── Claude: system ────────────────────────────────────────
  _nativeCommandLifecycle(event) {
    if (typeof event.command_uuid !== 'string' || !event.command_uuid || event.command_uuid.length > 128 ||
        typeof event.state !== 'string' || !event.state || event.state.length > 64) return;
    const key = JSON.stringify([event.session_id || '',event.command_uuid]);
    let command = this.nativeCommands.get(key);
    if (!command) {
      const node = document.createElement('div');
      node.className = 'chat-sys-event timeline-node is-muted native-command-status';
      node.dataset.commandUuid = event.command_uuid;
      node.innerHTML = '<span class="chat-sys-pill"></span>';
      command = {node,state:''};
      this.nativeCommands.set(key,command);
      this._appendNode(node);
    }
    const previous = ChatLogRenderer.COMMAND_STATES[command.state];
    const next = ChatLogRenderer.COMMAND_STATES[event.state];
    if (previous?.rank === 2 || (next && previous && next.rank < previous.rank)) return;
    command.state = event.state;
    command.node.dataset.commandState = event.state;
    command.node.querySelector('.chat-sys-pill').textContent = next?.label || `指令状态：${event.state}`;
    command.node.title = `${event.command_uuid} · 指令结束不代表回复成功，以回复结果为准`;
    if (this.isRunning && !this._footerRendered && ['queued','started'].includes(event.state)) {
      this._processStage(event.state === 'queued' ? '指令排队中' : '正在处理');
    }
  }

  _claudeSys(d) {
    if (d.subtype === 'command_lifecycle') return this._nativeCommandLifecycle(d);
    if (d.subtype === 'coderfleet_backend') {
      this.executionBackend = d.execution_backend;
      return;
    }
    if (d.subtype === 'mirror_error') { this._pill('会话镜像写入失败','本地记录仍保留，请检查外部存储'); return; }
    if (d.subtype === 'coderfleet_control_ready' || d.subtype === 'coderfleet_question_pending' || d.subtype === 'coderfleet_checkpoint') return;
    if (d.subtype === 'coderfleet_control_applied') { this._pill('运行设置已更新',d.operation || ''); return; }
    if (d.subtype === 'coderfleet_control_unconfirmed') { this._pill('运行操作结果未确认','请检查投递回执'); return; }
    if (d.subtype === 'coderfleet_files_rewound') { this._pill('文件已恢复',d.user_message_id || ''); return; }
    if (['hook_started','hook_progress'].includes(d.subtype)) return;
    if (d.subtype === 'hook_response') {
      if (d.outcome === 'error' || d.exit_code > 0) this._pill('Hook 执行失败',d.hook_name || '');
      return;
    }
    if (d.subtype === 'task_progress') return this._backgroundTaskEvent(d);
    if (d.subtype === 'coderfleet_workflow_profile') {
      this._pill(d.preset === 'research' ? '只读资料研究' : '只读项目审计',
        `最多 ${d.max_concurrent_agents} 个并发 · SDK 预算 $${d.max_budget_usd} · ${d.timeout_seconds}s`);
      return;
    }
    if (d.subtype === 'coderfleet_workflow_tool_denied') {
      this._pill('只读工作流已阻止操作',d.tool_name || '未授权工具');
      this._processStage('已阻止超出只读范围的操作',true);
      return;
    }
    if (d.subtype === 'coderfleet_permission_pending') return this._permissionPending(d);
    if (d.subtype === 'coderfleet_permission_closed') return this._closePermission(d.tool_call_id,d.status);
    if (d.subtype === 'coderfleet_message_accepted') return this._sdkMessageAccepted(d);
    if (d.subtype === 'coderfleet_interrupted') { this.interrupted = true; this._pill('已中断', '原生会话可继续'); return; }
    if (d.subtype === 'coderfleet_question_closed') {
      const owner = this._questionRenderer(d.tool_call_id);
      const e = owner?.toolMap[d.tool_call_id];
      if (e) {
        e.isLive = false;
        e.answerAttempt = null;
        owner._disableAskqInputs(d.tool_call_id);
        owner._setAskqSubmitStatus(d.tool_call_id,
          d.status === 'answered' ? '✓ 已回答' : d.status === 'timed_out' ? '等待回答已超时' : '提问已取消', d.status !== 'answered');
        owner._refreshWaitingStage();
      }
      return;
    }
    if (d.subtype === 'init') {
      const model = (d.model || '').replace(/^claude-/, '');
      const n = (d.tools || []).length;
      this._pill('Claude 就绪', model + (n ? ` · ${n} 工具` : ''));
      return;
    }
    if (['task_started','task_notification','task_updated'].includes(d.subtype) && d.task_id) this._backgroundTaskEvent(d);
  }

  _backgroundTaskEvent(event) {
    if (typeof event.task_id !== 'string' || !event.task_id) return;
    const previous = this.backgroundTasks.get(event.task_id) || {};
    const settled = ['completed','failed','stopped'].includes(previous.status);
    if (settled && event.subtype === 'task_progress') return;
    const reported = event.subtype === 'task_updated' ? event.patch?.status || event.status : event.status;
    const status = settled ? previous.status : ['task_started','task_progress'].includes(event.subtype) ? previous.status || 'running' : reported === 'killed' ? 'stopped' : reported || previous.status;
    if (!['running','completed','failed','stopped'].includes(status)) return;
    const usage = {...previous.usage};
    for (const key of ['tool_uses','total_tokens','duration_ms']) {
      const value = (event.usage || event.patch?.usage || {})[key];
      if (Number.isFinite(value) && value >= 0) usage[key] = Math.max(usage[key] || 0,value);
    }
    const task = {toolUseId:event.tool_use_id || previous.toolUseId,status,usage,
      taskType:event.task_type || previous.taskType,
      description:event.description || event.patch?.description || previous.description || '',
      summary:event.summary || previous.summary || ''};
    this.backgroundTasks.set(event.task_id,task);
    const entry = task.toolUseId && this.toolMap[task.toolUseId];
    if (entry) this._renderBackgroundTask(entry,event.task_id,task);
    else if (status === 'failed' && previous.status !== 'failed') this._pill('后台任务失败',String(task.summary || event.task_id).slice(0,500));
  }

  _renderBackgroundTask(entry, taskId, task) {
    entry.backgroundTask = {id:taskId,...task};
    const workflow = ['workflow','local_workflow'].includes(task.taskType) || entry.name === 'Workflow';
    const label = workflow ? {running:'工作流运行中',completed:'工作流已完成',failed:'工作流失败',stopped:'工作流已停止'}[task.status] :
      {running:'后台运行中',completed:'后台任务已完成',failed:'后台任务失败',stopped:'后台任务已停止'}[task.status];
    entry.statusEl.textContent = {running:'⏳',completed:'✓',failed:'✗',stopped:'■'}[task.status];
    entry.statusEl.title = `${label} · ${taskId}`;
    entry.badgeEl.className = `tool-badge ${task.status === 'running' ? 'pending' : task.status === 'failed' ? 'fail' : 'ok'}`;
    entry.wrap.dataset.backgroundTaskId = taskId;
    if (workflow) entry.wrap.dataset.nativeTaskType = 'workflow';
    if (entry.exitEl) {
      entry.exitEl.style.display = '';
      entry.exitEl.className = `tool-exit ${task.status === 'failed' ? 'fail-exit' : 'ok-exit'}`;
      const usage = task.usage || {};
      const metrics = [usage.tool_uses != null ? `${usage.tool_uses} 次工具调用` : '',
        usage.total_tokens != null ? `${usage.total_tokens} tokens` : '',
        usage.duration_ms != null ? `${Math.floor(usage.duration_ms/1000)}s` : ''].filter(Boolean);
      entry.exitEl.textContent = `${label} · ${taskId}${metrics.length ? '\n'+metrics.join(' · ') : ''}`+
        ((task.summary || task.description) ? '\n'+String(task.summary || task.description).slice(0,500) : '');
    }
    if (task.status === 'failed' && entry.bodyEl) {
      this._processStage('后台任务失败',true);
      entry.bodyEl.classList.remove('collapsed');
      if (entry.btnEl) entry.btnEl.textContent = '收起';
    }
  }

  // ── Claude: rate_limit_event ───────────────────────────────
  // 每次请求都会带一份 rate_limit_info，status 绝大多数时候是 'allowed'——
  // 正常状态不值得打断时间线；只在真的接近/触发限额时才提示一下。
  _claudeRateLimit(d) {
    const info = d.rate_limit_info || {};
    if (!info.status || info.status === 'allowed') return;
    const label = info.rateLimitType ? `${info.rateLimitType} 限额` : '速率限制';
    this._pill(`⚠ ${label}`, info.status);
  }

  _claudeStream(event) {
    if (!event) return;
    if (event.type === 'message_stop') { this._flushStreamMarkdown(); return; }
    if (event.type === 'message_start') {
      this.streamMessageId = event.message?.id || `stream-${this.streamBlocks.size}`;
      this.streamModel = event.message?.model;
      // Completed entries only support matching a late complete block.
      while (this.streamBlocks.size > 128) this.streamBlocks.delete(this.streamBlocks.keys().next().value);
      return;
    }
    const key = `${this.streamMessageId}:${event.index ?? 0}`;
    if (event.type === 'content_block_start') {
      const block = event.content_block || {};
      if (['text','thinking'].includes(block.type)) this.streamBlocks.set(key, {
        messageId:this.streamMessageId, type:block.type, text:block.text || block.thinking || '', node:null, settled:false,
      });
      return;
    }
    if (event.type !== 'content_block_delta') return;
    const delta = event.delta || {};
    if (!['text_delta','thinking_delta'].includes(delta.type)) return;
    let block = this.streamBlocks.get(key);
    if (!block) {
      block = {messageId:this.streamMessageId,type:delta.type === 'text_delta' ? 'text' : 'thinking',text:'',node:null,settled:false};
      this.streamBlocks.set(key,block);
    }
    block.text += delta.text || delta.thinking || '';
    if (!block.node) block.node = block.type === 'text' ? this._bubble('',this.streamModel) : this._thinking(block.text);
    if (!block.node) return;
    block.node.dataset.streaming = 'true';
    if (block.type === 'text') block.node._bubbleText = block.text;
    this.streamDirty.add(block);
    if (this.streamFrame !== null) return;
    if (typeof requestAnimationFrame !== 'function') { this._flushStreamMarkdown(); return; }
    this.streamFrame = requestAnimationFrame(()=>{
      this.streamFrame = null;
      this._flushStreamMarkdown();
    });
  }

  _renderStreamMarkdown(block) {
    if (block.type === 'text') {
      const button = block.node.querySelector('.bubble-translate-btn');
      renderBubbleTranslationSource(block.node.querySelector('.bubble-content'),button,block.text,renderMd(this._injectDownloadCards(block.text)));
      button.style.display = isMostlyNonChinese(block.text) ? '' : 'none';
    } else block.node.querySelector('.think-bubble').innerHTML = renderMd(block.text);
  }

  _flushStreamMarkdown() {
    for (const block of this.streamDirty) if (block.node && !block.settled) this._renderStreamMarkdown(block);
    this.streamDirty.clear();
  }

  _settleStream(message, block) {
    const candidates = [...this.streamBlocks.values()].filter(item => item.node && !item.settled && item.type === block.type &&
      (!message.id || item.messageId === message.id));
    const text = block.text || block.thinking || '';
    const entry = candidates.find(item => item.text === text) || candidates.find(item => text.startsWith(item.text)) || candidates[0];
    if (!entry) return false;
    entry.settled = true;
    entry.text = block.text || block.thinking || '';
    entry.node.dataset.streaming = 'false';
    if (block.type === 'text') entry.node._bubbleText = entry.text;
    this.streamDirty.delete(entry);
    this._renderStreamMarkdown(entry);
    if (block.type === 'text') this._recordMessageTime(entry.node);
    return true;
  }

  // ── Claude: assistant ─────────────────────────────────────
  _claudeAssistant(msg) {
    if (!msg?.content) return;
    if (!msg.id || msg.id !== this.lastSDKMessageId) { this.lastSDKTextParts = []; this.lastSDKMessageId = msg.id || ''; }
    for (const b of msg.content) {
      if (b.type === 'text' && b.text?.trim()) {
        if (!this._settleStream(msg,b)) this._bubble(b.text,msg.model);
        if (this.executionBackend === 'sdk') { this.lastSDKTextParts.push(b.text); this.lastSDKText = this.lastSDKTextParts.join('\n'); }
      } else if (b.type === 'thinking' && b.thinking) {
        if (!this._settleStream(msg,b)) this._thinking(b.thinking);
      }
      else if (b.type === 'tool_use') this._toolUse(b);
    }
  }

  // ── Claude: user (tool results) ───────────────────────────
  _claudeUser(msg) {
    if (!msg?.content) return;
    for (const b of msg.content) {
      if (b.type === 'tool_result') {
        let text = '';
        let images = [];
        if (typeof b.content === 'string') text = b.content;
        else if (Array.isArray(b.content)) {
          // Read 命中图片文件时，content 里混着一个没有 .text 的 image block——
          // 原先直接 join 会把它拼成空字符串,图片就悄悄消失了。
          text = b.content.filter(c => c.type !== 'image').map(c => c.text || '').join('\n');
          images = b.content.filter(c => c.type === 'image' && c.source);
        }
        this._fillTool(b.tool_use_id, text, b.is_error, images);
      }
    }
  }

  // ── Claude: result ────────────────────────────────────────
  _claudeResult(d) {
    if (d.structured_output !== undefined) this._bubble("```json\n" + JSON.stringify(d.structured_output,null,2) + "\n```");
    // 1. 如果最终成功且有答复内容，先渲染为 AI 气泡
    if (!d.is_error && d.result && d.result.trim() && !(this.executionBackend === 'sdk' && [this.lastSDKText,(this.lastSDKTextParts || []).join(''),(this.lastSDKTextParts || []).join('\n\n')].includes(d.result))) {
      this._bubble(d.result);
    }

    // 2. 提取并渲染 Token 用量与费用统计
    const usage = d.usage || {};
    const input = d.input_tokens ?? usage.input_tokens;
    const output = d.output_tokens ?? usage.output_tokens;
    const cacheRead = usage.cache_read_input_tokens;
    const cost = d.cost_usd ?? d.total_cost_usd;
    const turns = d.num_turns;

    const items = [];
    if (input != null) items.push(`输入 <span>${input.toLocaleString()}</span> tok`);
    if (output != null) items.push(`输出 <span>${output.toLocaleString()}</span> tok`);
    if (cacheRead != null && cacheRead > 0) {
      items.push(`缓存读取 <span>${cacheRead.toLocaleString()}</span> tok`);
    }
    if (cost != null) items.push(`费用 <span>$${cost.toFixed(4)}</span>`);
    if (turns != null) items.push(`轮次 <span>${turns}</span>`);

    if (items.length) {
      const el = document.createElement('div');
      el.className = 'chat-usage timeline-node is-muted';
      el.innerHTML = items.map(i => `<div class="usage-item">${i}</div>`).join('');
      this._appendNode(el);
    }

    // 3. 如果是错误，渲染异常阻断横幅
    if (d.is_error && d.result) {
      const el = document.createElement('div');
      el.className = 'chat-sys-event timeline-node is-error';
      el.innerHTML = `<span class="chat-sys-pill" style="background:#2a0e0e; color:#f87171; border-color:#5a1e1e; font-weight:600;">异常阻断 · ${esc(d.result)}</span>`;
      this._appendNode(el);
    }

    // SDK result ends a turn; only the scheduler's durable footer ends its Task.
    const ok = d.subtype === 'success' && !d.is_error;
    if (this.executionBackend !== 'sdk' && !this._footerRendered) {
      this._renderFooter(ok ? 'done' : 'failed');
    }
  }

  // ── Codex ─────────────────────────────────────────────────
  _codexMessage(d) {
    if (d.role === 'assistant') {
      const t = typeof d.content === 'string' ? d.content :
        (Array.isArray(d.content) ? d.content.map(b => b.text || '').join('') : '');
      if (t.trim()) this._bubble(t);
    }
  }

  _codexToolCall(d) {
    this._toolUse({
      id: d.id || ('cx-' + Math.random().toString(36).slice(2, 8)),
      name: d.name || 'tool',
      input: d.arguments || d.input || {},
    });
  }

  _codexToolResult(d) {
    const text = typeof d.result === 'string' ? d.result :
      (Array.isArray(d.result) ? d.result.map(c => c.text || '').join('\n') : JSON.stringify(d.result));
    this._fillTool(d.tool_call_id, text, d.is_error);
  }

  _codexEnd(d) {
    if (!this._footerRendered) this._renderFooter(d.result ? 'done' : 'failed');
  }

  // ── Kimi Code ──────────────────────────────────────────────
  _kimiLine(line) {
    if (!line.startsWith('{')) return;
    let d;
    try { d = JSON.parse(line); } catch { this._rawLine(line); return; }

    if (d.role === 'assistant') {
      if (d.content?.trim()) this._bubble(d.content);
      for (const tc of (d.tool_calls || [])) {
        const fn = tc.function || {};
        let input = fn.arguments || {};
        if (typeof input === 'string') {
          try { input = JSON.parse(input); } catch { input = { arguments: input }; }
        }
        this._toolUse({
          id: tc.id || ('kimi-' + Math.random().toString(36).slice(2, 8)),
          name: fn.name || 'tool',
          input,
        });
      }
      return;
    }

    if (d.role === 'tool') {
      this._fillTool(d.tool_call_id, d.content || '', false);
      return;
    }

    if (d.role === 'meta' && d.type === 'session.resume_hint') {
      const sid = d.session_id ? String(d.session_id).slice(0, 12) : '';
      this._pill('Kimi 会话', sid ? `#${sid}` : '');
    }
  }

  _codexItemStarted(item) {
    if (!item) return;
    if (item.type === 'command_execution') {
      const id = item.id;
      const cmd = item.command || '';
      let displayCmd = cmd;
      if (cmd.startsWith('/bin/bash -lc "') && cmd.endsWith('"')) {
        displayCmd = cmd.substring(15, cmd.length - 1).replace(/\\"/g, '"');
      } else if (cmd.startsWith('/bin/bash -lc \'') && cmd.endsWith('\'')) {
        displayCmd = cmd.substring(15, cmd.length - 1);
      }
      this._toolUse({
        id: id,
        name: 'Bash',
        input: { command: displayCmd }
      });
    } else if (item.type === 'todo_list') {
      this._codexTodoList(item);
    } else if (this._isCodexGenericToolItem(item)) {
      this._toolUse({
        id: item.id,
        name: this._codexToolItemName(item),
        input: this._codexToolItemInput(item),
      });
    }
  }

  // item.updated 目前只有 Codex 的 todo_list（计划工具)会在 completed 之前
  // 多次推送进度快照——其余 item 类型没有这个生命周期阶段。
  _codexItemUpdated(item) {
    if (!item || item.type !== 'todo_list') return;
    this._codexTodoList(item);
  }

  _codexItemCompleted(item) {
    if (!item) return;
    if (item.type === 'command_execution') {
      const id = item.id;
      if (!this.toolMap[id]) {
        this._codexItemStarted(item);
      }
      const exitCode = item.exit_code;
      const isError = exitCode != null && exitCode !== 0;
      this._fillTool(id, item.aggregated_output || '', isError);
    } else if (item.type === 'agent_message') {
      if (item.text?.trim()) {
        this._bubble(item.text);
      }
    } else if (item.type === 'file_change') {
      const changes = item.changes || [];
      for (const ch of changes) {
        const path = ch.path || '';
        const kind = ch.kind || 'update';

        let opClass = 'edit';
        let opLabel = 'UPDATE';
        if (kind === 'add' || kind === 'create') {
          opClass = 'create';
          opLabel = 'CREATE';
        } else if (kind === 'delete' || kind === 'remove') {
          opClass = 'delete';
          opLabel = 'DELETE';
        }

        const el = document.createElement('div');
        el.className = 'chat-file-card timeline-node';
        let cleanPath = path;
        if (path.startsWith('/workspace/')) {
          cleanPath = path.substring(11);
        }
        el.innerHTML = `
      <span class="file-op-badge ${opClass}">${opLabel}</span>
      <span class="file-path">${esc(cleanPath)}</span>
    `;
        this._appendNode(el);
      }
    } else if (item.type === 'todo_list') {
      this._codexTodoList(item);
      const failed = item.status === 'cancelled' || item.status === 'error' || item.status === 'failed';
      this._fillTool(item.id, '', failed);
    } else if (this._isCodexGenericToolItem(item)) {
      const id = item.id;
      if (!this.toolMap[id]) this._codexItemStarted(item);
      const isSuccess = item.status !== 'cancelled' && item.status !== 'error' && item.status !== 'failed';
      this._fillTool(id, this._codexToolItemResultText(item, isSuccess), !isSuccess);
    }
  }

  // ── Codex: 计划工具（todo_list）── 跟 Claude 的 TodoWrite 是同一个概念，
  // 但生命周期不同：TodoWrite 每次调用都是全新的 tool_use id，todo_list 是
  // 同一个 item.id 反复经历 started → updated(0次或多次) → completed，所以
  // 复用 TodoWrite 的卡片外观，但首次创建后走原地更新而不是重新建卡。
  _codexTodoList(item) {
    const todos = this._codexTodoItemsToTodoWriteShape(item);
    const id = item.id;
    if (!this.toolMap[id]) {
      this._toolUseTodoWrite({ id, name: 'TodoWrite', input: { todos } });
      return;
    }
    this._updateTodoWriteBody(id, todos);
  }

  // Codex 的 todo 条目只有 { text, completed } 布尔态，没有 Claude
  // TodoWrite 的三态 status——按跟 lobehub 同样的规则合成：第一条未完成的
  // 算"进行中"，其余未完成的算"待办"，点亮同一套进度 UI。
  _codexTodoItemsToTodoWriteShape(item) {
    const raw = Array.isArray(item.items) ? item.items : [];
    let assignedProcessing = false;
    return raw
      .map(t => ({ completed: !!t?.completed, content: (t?.text || '').trim() }))
      .filter(t => t.content)
      .map(t => {
        if (t.completed) return { content: t.content, status: 'completed', activeForm: t.content };
        if (!assignedProcessing) {
          assignedProcessing = true;
          return { content: t.content, status: 'in_progress', activeForm: t.content };
        }
        return { content: t.content, status: 'pending', activeForm: t.content };
      });
  }

  _updateTodoWriteBody(id, todos) {
    const e = this.toolMap[id];
    if (!e || !e.isTodoWrite || !e.bodyEl) return;
    const total = todos.length;
    const completed = todos.filter(t => t.status === 'completed').length;
    const inProgress = todos.find(t => t.status === 'in_progress');
    const allDone = total > 0 && completed === total;
    const headerIcon = inProgress ? '▶' : (allDone ? '✓' : '☰');
    const headerLabel = inProgress ? '当前步骤' : (allDone ? '全部完成' : '待办事项');
    const headerDetailText = inProgress ? (inProgress.activeForm || inProgress.content || '') : '';
    const headerEl = e.bodyEl.querySelector('.todo-header');
    const listEl = e.bodyEl.querySelector('.todo-list');
    if (headerEl) headerEl.innerHTML = `
    <span class="todo-header-icon">${headerIcon}</span>
    <span class="todo-header-label">${esc(headerLabel)}${headerDetailText ? `: <span class="todo-header-detail">${esc(headerDetailText)}</span>` : ''}</span>
    <span class="todo-header-count">${completed}/${total}</span>`;
    if (listEl) listEl.innerHTML = todos.map(t => this._renderTaskRowHtml(t.content, t.status, t.activeForm)).join('');
  }

  // ── Codex: 除 command_execution/todo_list/file_change/agent_message 外的
  // item 类型（MCP 工具调用、网络搜索、多agent协作 spawn_agent/wait）——
  // 之前这些类型完全没有分支，item.started/completed 直接被忽略，UI 上连
  // 一条记录都不会出现。走通用工具卡片路径，不需要为每种都定制展示。
  _isCodexGenericToolItem(item) {
    return item.type === 'mcp_tool_call' || item.type === 'web_search' || item.type === 'collab_tool_call';
  }

  _codexToolItemName(item) {
    if (item.type === 'web_search') return 'WebSearch';
    if (item.type === 'mcp_tool_call') return item.tool || 'MCP';
    return item.tool || 'Collab';
  }

  _codexToolItemInput(item) {
    if (item.type === 'web_search') {
      const action = item.action;
      const query = (typeof item.query === 'string' && item.query.trim())
        ? item.query.trim()
        : (action && typeof action === 'object' ? (action.query || (Array.isArray(action.queries) ? action.queries[0] : '')) : '');
      return { query: query || '' };
    }
    if (item.type === 'mcp_tool_call') {
      return { server: item.server, tool: item.tool, arguments: item.arguments };
    }
    return { tool: item.tool, prompt: item.prompt, agents: item.receiver_thread_ids };
  }

  _codexToolItemResultText(item, isSuccess) {
    if (item.type === 'web_search') return isSuccess ? '已完成网络搜索。' : '网络搜索失败。';
    if (item.type === 'mcp_tool_call') return this._codexMcpResultText(item, isSuccess);
    if (item.type === 'collab_tool_call') return this._codexCollabResultText(item, isSuccess);
    return '';
  }

  // MCP 结果的信封形状不固定（{Ok:...}/{Err:...}/{ok:...}/裸值），尽量拆出
  // 人可读的文本，拆不出来就退回 JSON 字符串，不留空白。
  _codexMcpResultUnwrap(v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('Ok' in v) return v.Ok;
      if ('Err' in v) return v.Err;
      if ('ok' in v) return v.ok;
    }
    return v;
  }

  _codexMcpResultText(item, isSuccess) {
    if (!isSuccess) {
      // item.error may be absent even on failure — MCP tool failures are as
      // often reported via an {Err:...} envelope on item.result as via a
      // dedicated item.error field, so fall back to unwrapping the same way
      // the success path does rather than reporting a content-free message.
      const err = item.error || this._codexMcpResultUnwrap(item.result);
      if (err && typeof err === 'object') return err.message || err.error || JSON.stringify(err);
      if (typeof err === 'string' && err) return err;
      return 'MCP 工具调用失败。';
    }
    const contentItemText = c => {
      if (typeof c === 'string') return c;
      if (c && typeof c === 'object') return c.text || c.content || JSON.stringify(c);
      return String(c ?? '');
    };
    const result = this._codexMcpResultUnwrap(item.result);
    if (Array.isArray(result)) return result.map(contentItemText).filter(Boolean).join('\n\n');
    if (result && typeof result === 'object') {
      if (Array.isArray(result.content)) return result.content.map(contentItemText).filter(Boolean).join('\n\n');
      if (result.text || result.output) return result.text || result.output;
    }
    return typeof result === 'string' ? result : JSON.stringify(result ?? '');
  }

  _codexCollabResultText(item, isSuccess) {
    const tool = item.tool || 'collaboration';
    if (!isSuccess) return `${tool} ${item.status === 'cancelled' ? '已取消' : '失败'}。`;
    const states = Object.values(item.agents_states || {});
    const agentCount = (item.receiver_thread_ids || []).length || states.length;
    if (tool === 'spawn_agent') {
      return agentCount > 0 ? `已派生 ${agentCount} 个子agent。` : '已派生子agent。';
    }
    if (tool === 'wait') {
      const done = states.find(s => s.status === 'completed' && s.message);
      if (done) return `等待完成：${done.message}`;
      return agentCount > 0 ? `${agentCount} 个子agent已完成等待。` : '等待完成。';
    }
    return `${tool} 已完成。`;
  }

  // ── Codex/OpenCode: CLI 级终止错误（限流、鉴权失败、进程崩溃）─────────
  // 之前没有专门处理，会掉进 default 的 JSON 转储；这里只做展示，不重放
  // lobehub 那套带时区数学的精确重试时间解析——原始错误文本本身通常已经
  // 带了"try again at HH:MM"这类可读信息，直接展示比重新解析更不容易出错。
  _agentError(d) {
    const message =
      (typeof d.message === 'string' && d.message) ||
      (d.error && typeof d.error === 'object' && (d.error.message || d.error.type)) ||
      (typeof d.error === 'string' && d.error) ||
      (typeof d.result === 'string' && d.result) ||
      'Agent 执行出错';

    const isRateLimit = /usage limit|purchase more credits|rate limit/i.test(message);
    const isAuth = /not authenticated|unauthorized|invalid.*(credential|token|key)|authentication/i.test(message)
      || d.error?.name === 'ProviderAuthError' || d.error?.data?.statusCode === 401;

    const label = isRateLimit ? '⚠ 触发限流' : (isAuth ? '⚠ 需要重新登录' : '✗ 执行出错');
    this._pill(label, message);

    if (!this._footerRendered) this._renderFooter('failed');
  }

  // ── Pi Agent ──────────────────────────────────────────────
  _piSession(d) {
    const sid = d.id ? String(d.id).slice(0, 8) : '';
    this._pill('Pi 会话开始', sid ? `#${sid}` : '');
  }

  _piMessageEnd(d) {
    const msg = d.message || {};
    if (msg.role !== 'assistant') return;
    for (const b of (msg.content || [])) {
      if (b.type === 'thinking' && b.thinking) this._thinking(b.thinking);
      else if (b.type === 'text' && b.text?.trim()) this._bubble(b.text, msg.model);
    }
    this._piUsage(msg.usage);
  }

  _piToolStart(d) {
    this._toolUse({
      id: d.toolCallId || ('pi-' + Math.random().toString(36).slice(2, 8)),
      name: d.toolName || 'tool',
      input: d.args || {},
    });
  }

  _piToolEnd(d) {
    const content = d.result?.content;
    const text = Array.isArray(content)
      ? content.map(c => c.text || '').join('\n')
      : (typeof d.result === 'string' ? d.result : '');
    this._fillTool(d.toolCallId, text, !!d.isError);
  }

  _piUsage(usage) {
    if (!usage) return;
    const cost = usage.cost || {};
    const items = [];
    if (usage.input != null) items.push(`输入 <span>${usage.input.toLocaleString()}</span> tok`);
    if (usage.output != null) items.push(`输出 <span>${usage.output.toLocaleString()}</span> tok`);
    if (usage.cacheRead) items.push(`缓存读取 <span>${usage.cacheRead.toLocaleString()}</span> tok`);
    if (usage.cacheWrite) items.push(`缓存写入 <span>${usage.cacheWrite.toLocaleString()}</span> tok`);
    if (cost.total) items.push(`费用 <span>$${Number(cost.total).toFixed(4)}</span>`);

    if (items.length) {
      const el = document.createElement('div');
      el.className = 'chat-usage timeline-node is-muted';
      el.innerHTML = items.map(i => `<div class="usage-item">${i}</div>`).join('');
      this._appendNode(el);
    }
  }

  _piAgentEnd(d) {
    // willRetry === true means pi is about to retry the turn — not actually
    // done yet, a further agent_end will follow. Leave the footer to that one
    // (or to CoderFleet's own wrapper-appended `finished:` line as fallback).
    if (d.willRetry) return;
    if (!this._footerRendered) this._renderFooter('done');
  }

  // ── OpenCode ──────────────────────────────────────────────
  _opencodeStepStart(d) {
    const session = d.sessionID ? '#' + String(d.sessionID).slice(0, 8) : '';
    this._pill('OpenCode 开始', session);
  }

  _opencodeText(d) {
    const part = d.part || {};
    const text = part.text || d.text || '';
    if (!text.trim()) return;

    const thoughtMatch = text.match(/^THOUGHT:\s*([\s\S]*?)\n\nRESPONSE:\s*([\s\S]*)$/);
    if (thoughtMatch) {
      this._thinking(thoughtMatch[1].trim());
      const response = this._cleanOpenCodeResponse(thoughtMatch[2]);
      if (response) this._bubble(response, 'OpenCode');
      return;
    }

    const response = this._cleanOpenCodeResponse(text);
    if (response) this._bubble(response, 'OpenCode');
  }

  _opencodeToolUse(d) {
    const part = d.part || {};
    const state = part.state || {};
    const id = part.callID || part.id || ('oc-' + Math.random().toString(36).slice(2, 8));
    const name = this._opencodeToolName(part.tool || state.tool || 'tool');
    const input = this._normalizeOpenCodeToolInput(name, state.input || {});
    const metadata = state.metadata || {};
    const output = state.output ?? metadata.output ?? '';
    const exitCode = metadata.exit;
    const isComplete = state.status === 'completed' || state.status === 'error' || state.status === 'failed';
    const isError = state.status === 'error' || state.status === 'failed' || (exitCode != null && exitCode !== 0);

    if (!this.toolMap[id]) {
      this._toolUse({ id, name, input });
    }
    if (isComplete) {
      this._fillTool(id, output, isError);
    }
  }

  _opencodeToolName(name) {
    const n = String(name || '').toLowerCase();
    if (n === 'bash' || n === 'shell') return 'Bash';
    if (n === 'write') return 'Write';
    if (n === 'read') return 'Read';
    if (n === 'edit') return 'Edit';
    if (n === 'grep') return 'Grep';
    if (n === 'glob') return 'Glob';
    if (n === 'webfetch' || n === 'web_fetch') return 'WebFetch';
    if (n === 'websearch' || n === 'web_search') return 'WebSearch';
    return name ? String(name) : 'tool';
  }

  _normalizeOpenCodeToolInput(name, input) {
    if (!input) return {};
    const normalized = { ...input };

    if (normalized.file_path == null) {
      normalized.file_path = input.filePath || input.filepath || input.path || '';
    }
    if (normalized.old_string == null && input.oldString != null) {
      normalized.old_string = input.oldString;
    }
    if (normalized.new_string == null && input.newString != null) {
      normalized.new_string = input.newString;
    }
    if (normalized.url == null && input.href != null) {
      normalized.url = input.href;
    }
    if (normalized.query == null && input.search != null) {
      normalized.query = input.search;
    }

    return normalized;
  }

  _cleanOpenCodeResponse(text) {
    return String(text || '')
      .replace(/<step>[\s\S]*?<\/step>/g, '')
      .trim();
  }

  _opencodeStepFinish(d) {
    const part = d.part || {};
    const tokens = part.tokens || {};
    const cache = tokens.cache || {};
    const items = [];
    if (tokens.input != null) items.push(`输入 <span>${tokens.input.toLocaleString()}</span> tok`);
    if (tokens.output != null) items.push(`输出 <span>${tokens.output.toLocaleString()}</span> tok`);
    if (tokens.reasoning != null && tokens.reasoning > 0) items.push(`推理 <span>${tokens.reasoning.toLocaleString()}</span> tok`);
    if (cache.read != null && cache.read > 0) items.push(`缓存读取 <span>${cache.read.toLocaleString()}</span> tok`);
    if (cache.write != null && cache.write > 0) items.push(`缓存写入 <span>${cache.write.toLocaleString()}</span> tok`);
    if (tokens.total != null) items.push(`总计 <span>${tokens.total.toLocaleString()}</span> tok`);
    if (part.cost != null) items.push(`费用 <span>$${Number(part.cost).toFixed(4)}</span>`);

    if (items.length) {
      const el = document.createElement('div');
      el.className = 'chat-usage timeline-node is-muted';
      el.innerHTML = items.map(i => `<div class="usage-item">${i}</div>`).join('');
      this._appendNode(el);
    }

    if (!this._footerRendered) {
      this._renderFooter(part.reason === 'error' ? 'failed' : 'done');
    }
  }

  // ── 文件下载标记检测：<!-- CF_SEND: path --> ─────────────
  _injectDownloadCards(text) {
    if (!this.projectName) return text;
    return text.replace(/<!--\s*CF_SEND:\s*([^>]+?)\s*-->/g, (_, rawPath) => {
      const filePath = rawPath.trim();
      const filename = filePath.split('/').pop() || filePath;
      const rawUrl = `/api/projects/${encodeURIComponent(this.projectName)}/download?path=${encodeURIComponent(filePath)}`;
      const url = typeof authedUrl === 'function' ? authedUrl(rawUrl) : rawUrl;
      return (
        `\n<div class="cf-download-card">` +
          `<div class="cf-dl-icon">` +
            `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
              `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9,15 12,18 15,15"/>` +
            `</svg>` +
          `</div>` +
          `<div class="cf-dl-info">` +
            `<span class="cf-dl-name">${esc(filename)}</span>` +
            `<span class="cf-dl-path">${esc(filePath)}</span>` +
          `</div>` +
          `<a class="cf-dl-btn" href="${esc(url)}" download="${esc(filename)}">下载</a>` +
        `</div>\n`
      );
    });
  }

  // ── AI 文字气泡 ───────────────────────────────────────────
  _bubble(text, model) {
    if (this.isRunning) this._processStage('正在回复');
    const label = model
      ? model.replace(/^claude-/, '').split('-').slice(0, 2).join('-')
      : 'AI';
    const displayText = this._injectDownloadCards(text);
    const showTranslate = isMostlyNonChinese(text);
    const el = document.createElement('div');
    el.className = 'chat-bubble-wrap ai-reply';
    el.classList.add('timeline-node');
    el.innerHTML = `
  <div class="bubble-body">
    <div class="bubble">
      <div class="bubble-label-row">
        <div class="bubble-label">${esc(label)}</div>
      </div>
      <div class="bubble-content">${renderMd(displayText)}</div>
    </div>
    <div class="message-footer ai-message-footer">
      <div class="bubble-actions">
        <button class="bubble-copy-btn" title="复制" aria-label="复制回复">${copyBtnSVG()}</button>
        <button class="bubble-translate-btn" title="翻译" aria-label="翻译回复">${translateBtnSVG()}</button>
      </div>
      <span class="bubble-time-slot"></span>
    </div>
  </div>`;

    el._bubbleText = text;
    this._prepareReplyTime(el);
    el.querySelector('.bubble-copy-btn').addEventListener('click', () => {
      copyTextToClipboard(el._bubbleText, el.querySelector('.bubble-copy-btn'));
    });

    const tbtn = el.querySelector('.bubble-translate-btn');
    if (tbtn) {
      tbtn.style.display = showTranslate ? '' : 'none';
      tbtn.addEventListener('click', () => {
        toggleBubbleTranslation(tbtn, el.querySelector('.bubble-content'), el._bubbleText);
      });
    }

    // 如果之前有渲染过 AI 回复，说明之前的回复并非最后一条，需要移入折叠包中
    if (this.lastBubbleEl) {
      if (this.foldProcess) {
        this._appendToProcess(this.lastBubbleEl);
      } else {
        this.inner.appendChild(this.lastBubbleEl);
      }
    }

    this.inner.appendChild(el);
    this.lastBubbleEl = el;
    return el;
  }

  // Only the final reply of a completed turn receives the fork action.
  addTurnForkAction(onFork) {
    const reply = this.lastBubbleEl;
    const actions = reply?.querySelector('.bubble-actions');
    if (!actions || actions.querySelector('.bubble-fork-btn')) return;
    actions.classList.add('bubble-turn-actions');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'bubble-fork-btn';
    button.title = '从这里分叉';
    button.setAttribute('aria-label', '从这里分叉');
    button.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12h6c4 0 4-7 10-7M15 5h5v5M10 12c4 0 4 7 10 7M15 19h5v-5"/></svg>';
    button.addEventListener('click', () => { if (!button.disabled) onFork(button); });
    actions.appendChild(button);
  }

  // ── 思考气泡 ──────────────────────────────────────────────
  _thinking(text) {
    if (this.isRunning) this._processStage('思考中');
    if (!text?.trim()) return;
    const el = document.createElement('div');
    el.className = 'chat-bubble-wrap thought-reply';
    el.classList.add('timeline-node', 'is-muted');
    el.innerHTML = `
  <div class="bubble-body">
    <div class="bubble-label think-label">思考过程</div>
    <div class="bubble think-bubble">${renderMd(text)}</div>
  </div>`;
    this._appendNode(el);
    return el;
  }

  // ── 工具调用卡片 ──────────────────────────────────────────
  _toolUse(block) {
    const { id, name, input } = block;
    if (name === 'AskUserQuestion' || name === ChatLogRenderer.INTERVENTION_TOOL_NAME) {
      this._toolUseAskUserQuestion(block, name === ChatLogRenderer.INTERVENTION_TOOL_NAME || this.executionBackend === 'sdk');
      return;
    }
    if (name === 'TodoWrite') { this._toolUseTodoWrite(block); return; }
    if (name === 'TaskUpdate') { this._toolUseTaskUpdate(block); return; }
    if (name === 'TaskList') { this._toolUseTaskList(block); return; }
    const summary = formatToolSummary(name, input);
    if (this.isRunning) this._processStage(`正在执行 · ${name}`);
    const icon = toolIcon(name);
    // Edit 工具：old_string/new_string 用逐行 diff 展示，比截断后的纯文本预览
    // 更能一眼看出改了什么;其余工具沿用原来的 JSON/命令预览。
    const isDiff = name === 'Edit' && input && (input.old_string != null || input.new_string != null);
    const detail = isDiff ? '' : formatToolInput(name, input);
    const hasInput = isDiff || (detail && detail !== summary);

    const wrap = document.createElement('div');
    wrap.className = 'chat-tool-wrap';
    wrap.classList.add('timeline-node');
    wrap.dataset.toolId = id;

    const inputBody = isDiff
      ? `<div class="tool-input tool-diff">${renderInlineDiff(input.old_string, input.new_string)}</div>`
      : (hasInput ? `<div class="tool-input">${esc(detail)}</div>` : '');
    // 折叠区里输入/输出紧挨着堆叠，展开后不加标签容易分不清哪段是哪段——
    // 尤其是 Bash 类工具，命令预览和执行结果长得都差不多。
    const inputHtml = inputBody
      ? `<div class="tool-section-label">${isDiff ? '改动' : '输入'}</div>${inputBody}`
      : '';

    // Task/Agent：这是 CC 派生子agent的工具，子agent自己的 assistant/user 轮次会
    // 带 parent_tool_use_id 指回这里，用一个嵌套的 ChatLogRenderer 承接（见 _event）。
    // 面板默认隐藏，第一条子agent事件到达时才现身——不是每次 Task 调用都真的分叉出
    // 独立会话，没内容的话不该有一个空面板杵在那儿。
    const isSubagentSpawn = name === 'Task' || name === 'Agent' || name === 'Workflow';
    const threadLabel = name === 'Workflow' ? '工作流执行过程' : '子agent 会话';
    const subagentHtml = isSubagentSpawn ? `
    <div class="subagent-toggle-row" id="sar-${id}" style="display:none">
      <button class="subagent-toggle-btn" id="sabtn-${id}">▸ ${threadLabel}</button>
    </div>
    <div class="subagent-thread collapsed" id="sathread-${id}"><div class="chat-log timeline"></div></div>` : '';

    // ExitWorktree 且 action:'remove' + discard_changes:true 是真正的破坏性操作
    // （移除 worktree 且不保留改动），单独标一个红色警示徽章，不要淹没在其余
    // 工具卡片同样的视觉权重里。
    const isDiscardRisk = name === 'ExitWorktree' && input?.action === 'remove' && input?.discard_changes === true;
    const riskBadgeHtml = isDiscardRisk ? `<span class="tool-risk-badge">⚠ 丢弃改动</span>` : '';

    const card = document.createElement('div');
    card.className = 'chat-tool-card';
    card.innerHTML = `
  <div class="chat-tool-header">
    <span class="tool-status" id="ts-${id}">⏳</span>
    <span class="tool-badge pending" id="tb-${id}">${esc(icon)} ${esc(name)}</span>
    <span class="tool-cmd" title="${esc(summary)}">${esc(summary)}</span>
    ${riskBadgeHtml}
    <button class="tool-toggle" id="tt-${id}">展开</button>
  </div>
  <div class="tool-body collapsed" id="tbody-${id}">
    ${inputHtml}
    <div class="tool-section-label" id="tol-${id}" style="display:none">输出</div>
    <div class="tool-output" id="to-${id}" style="display:none"></div>
    <div class="tool-exit"   id="te-${id}" style="display:none"></div>
    ${subagentHtml}
  </div>`;

    wrap.appendChild(card);
    this._appendNode(wrap);

    // Toggle 逻辑
    const header = card.querySelector('.chat-tool-header');
    const body = document.getElementById(`tbody-${id}`);
    const btn = document.getElementById(`tt-${id}`);
    header.addEventListener('click', () => {
      const collapsed = body.classList.toggle('collapsed');
      btn.textContent = collapsed ? '展开' : '收起';
    });
    btn.addEventListener('click', e => { e.stopPropagation(); header.click(); });

    if (isSubagentSpawn) {
      const toggleRowEl = document.getElementById(`sar-${id}`);
      const subBtn = document.getElementById(`sabtn-${id}`);
      const subThread = document.getElementById(`sathread-${id}`);
      subBtn.addEventListener('click', e => {
        e.stopPropagation();
        const collapsed = subThread.classList.toggle('collapsed');
        subBtn.textContent = (collapsed ? '▸ ' : '▾ ')+threadLabel;
      });
      const subRenderer = new ChatLogRenderer(subThread, this.isRunning, false, this.projectName, this.taskId);
      subRenderer.onNeedsAttention = ()=>{
        this._processStage('等待您的回答或授权',true);
        body.classList.remove('collapsed');
        subThread.classList.remove('collapsed');
        btn.textContent = '收起'; subBtn.textContent = '▾ '+threadLabel;
      };
      subRenderer.onAttentionResolved = ()=>this._refreshWaitingStage();
      subRenderer.executionBackend = this.executionBackend;
      subRenderer.inner = subThread.querySelector('.chat-log');
      this.subagentRenderers[id] = { renderer: subRenderer, toggleRowEl, revealed: false };
    }

    this.toolMap[id] = {
      statusEl: document.getElementById(`ts-${id}`),
      badgeEl: document.getElementById(`tb-${id}`),
      outputEl: document.getElementById(`to-${id}`),
      outputLabelEl: document.getElementById(`tol-${id}`),
      exitEl: document.getElementById(`te-${id}`),
      bodyEl: body,
      btnEl: btn,
      wrap, name, input,
    };
    for (const [taskId,task] of this.backgroundTasks) {
      if (task.toolUseId === id) this._renderBackgroundTask(this.toolMap[id],taskId,task);
    }
  }

  // ── AskUserQuestion：问答卡片 ──────────────────────────────
  // 交互式提问工具，input 是 1-4 道题（question/header/options/multiSelect）；
  // tool_result 到达前先渲染"等待作答"占位，到达后按题目匹配已选项打勾，
  // 匹配不上（纯文本/自由回复）就整卡底部加一行"回复"，而不是硬套成 JSON 转储。
  // isIntervention includes MCP questions and SDK-native questions. CLI-native
  // questions remain read-only; submitting always checks the current Task token.
  _toolUseAskUserQuestion(block, isIntervention = false) {
    const { id, name, input } = block;
    const questions = normalizeAskUserQuestions(input);
    const multiple = questions.length > 1;
    // Intervention 走 MCP 全名（丑），卡片上显示统一成跟原生一样的名字，用户不需要
    // 关心背后是哪条工具调用协议。
    const displayName = name === ChatLogRenderer.INTERVENTION_TOOL_NAME ? 'AskUserQuestion' : name;
    const icon = toolIcon(displayName);
    const summary = questions.length === 1 ? questions[0].question : `${questions.length} 个问题`;
    // 只用 isIntervention + isRunning（还没等到这条 tool_use 的 tool_result）判断是否
    // 实时可答，不额外去读 Task.pending_intervention——后端一个 Task 同一时间只会有
    // 一条未完成的 Intervention（scheduler.py 的 Future 机制保证这点），所以"这条卡片
    // 对应的 tool_result 还没来"跟"这条 Intervention 还在 pending"是等价的，不用为
    // 了在渲染这一刻确认这件事再多打一次 GET。真正要紧的校验（token 对不对、这条
    // 问题是不是已经被别处答过/超时）留到点提交按钮那一刻再问后端，那才是答案真正
    // 要生效的时刻。
    const isLive = isIntervention && this.isRunning;

    const wrap = document.createElement('div');
    wrap.className = 'chat-tool-wrap';
    wrap.classList.add('timeline-node');
    wrap.dataset.toolId = id;

    const qBlocks = questions.map((q, i) => `
  <div class="askq-block">
    ${multiple ? `<span class="askq-ordinal">Q${i + 1}</span>` : ''}
    <div class="askq-body">
      <div class="askq-title-row">
        <span class="askq-question">${esc(q.question)}</span>
        ${multiple && q.header ? `<span class="askq-header-chip">${esc(q.header)}</span>` : ''}
      </div>
      <div class="askq-answer" id="askq-ans-${id}-${i}">${
        isLive ? this._buildLiveAskqInputs(id, i, q) : `<span class="askq-unanswered">等待作答…</span>`
      }</div>
    </div>
  </div>`).join('');

    const submitRowHtml = isLive ? `
  <div class="askq-submit-row" id="askq-submit-row-${id}">
    <button class="askq-submit-btn" id="askq-submit-btn-${id}">提交回答</button>
    <span class="askq-submit-status" id="askq-submit-status-${id}"></span>
  </div>` : '';

    const card = document.createElement('div');
    card.className = 'chat-tool-card';
    card.innerHTML = `
  <div class="chat-tool-header">
    <span class="tool-status" id="ts-${id}">⏳</span>
    <span class="tool-badge pending" id="tb-${id}">${esc(icon)} ${esc(displayName)}</span>
    <span class="tool-cmd" title="${esc(summary)}">${esc(summary)}</span>
    <button class="tool-toggle" id="tt-${id}">收起</button>
  </div>
  <div class="tool-body" id="tbody-${id}">
    <div class="tool-input tool-askq" id="tiq-${id}">${qBlocks}</div>
    ${submitRowHtml}
    <div class="tool-exit" id="te-${id}" style="display:none"></div>
  </div>`;

    wrap.appendChild(card);
    this._appendNode(wrap);

    const header = card.querySelector('.chat-tool-header');
    const body = document.getElementById(`tbody-${id}`);
    const btn = document.getElementById(`tt-${id}`);
    header.addEventListener('click', () => {
      const collapsed = body.classList.toggle('collapsed');
      btn.textContent = collapsed ? '展开' : '收起';
    });
    btn.addEventListener('click', e => { e.stopPropagation(); header.click(); });

    this.toolMap[id] = {
      statusEl: document.getElementById(`ts-${id}`),
      badgeEl: document.getElementById(`tb-${id}`),
      outputEl: null,
      outputLabelEl: null,
      exitEl: document.getElementById(`te-${id}`),
      bodyEl: body,
      btnEl: btn,
      wrap, name: displayName, input,
      askQuestions: questions,
      isLive,
      nativeQuestion: name === 'AskUserQuestion' && this.executionBackend === 'sdk',
    };

    if (isLive) {
      this._processStage('等待您的回答',true);
      questions.forEach((q, i) => {
        if (!q.options?.length) return;
        const other = document.getElementById(`askq-other-${id}-${i}`);
        const text = document.getElementById(`askq-text-${id}-${i}`);
        text.addEventListener('input', () => { other.checked = !!text.value.trim(); });
        other.addEventListener('change', () => { if (other.checked) text.focus(); });
      });
      const submitBtn = document.getElementById(`askq-submit-btn-${id}`);
      submitBtn.addEventListener('click', e => {
        e.stopPropagation();
        this._submitIntervention(id);
      });
    }
  }

  // 有选项的问题也保留“其他”回答；多选时可把自由输入和已有选项一起提交。
  _buildLiveAskqInputs(id, i, q) {
    const groupName = `askq-radio-${id}-${i}`;
    if (q.options && q.options.length) {
      const inputType = q.multiSelect ? 'checkbox' : 'radio';
      return `<div class="askq-live-options" id="askq-opts-${id}-${i}">${
        q.options.map((o, j) => `
    <label class="askq-live-option">
      <input type="${inputType}" name="${groupName}" value="${esc(o.label)}" id="askq-opt-${id}-${i}-${j}">
      <span class="askq-live-option-label">${esc(o.label)}</span>
      ${o.description ? `<span class="askq-live-option-desc">${esc(o.description)}</span>` : ''}
    </label>`).join('')
      }
    <label class="askq-live-option">
      <input type="${inputType}" name="${groupName}" value="" id="askq-other-${id}-${i}">
      <span class="askq-live-option-label">其他</span>
    </label>
    <input type="text" class="askq-live-text" id="askq-text-${id}-${i}" aria-label="其他回答：${esc(q.question)}" placeholder="输入其他回答…">
  </div>`;
    }
    return `<input type="text" class="askq-live-text" id="askq-text-${id}-${i}" placeholder="输入回答…">`;
  }

  // 从实时表单里读出每道题的答案，{question文本: label 或 [label,...] 或自由文本}。
  _collectAskqAnswers(id, questions) {
    const answers = {};
    questions.forEach((q, i) => {
      if (q.options && q.options.length) {
        const other = document.getElementById(`askq-other-${id}-${i}`);
        const customText = (document.getElementById(`askq-text-${id}-${i}`)?.value || '').trim();
        const checked = [...document.querySelectorAll(`input[name="askq-radio-${id}-${i}"]:checked`)]
          .map(el => el === other ? customText : el.value).filter(Boolean);
        if (!checked.length) return;
        answers[q.question] = q.multiSelect ? checked : checked[0];
      } else {
        const val = (document.getElementById(`askq-text-${id}-${i}`)?.value || '').trim();
        if (val) answers[q.question] = val;
      }
    });
    return answers;
  }

  // 这是 ChatLogRenderer 目前唯一会主动发网络请求的地方——它本来是纯粹的
  // JSONL→DOM 渲染器，不碰 fetch。这里破例是因为桌面 chat.js 和移动端 mobile.html
  // 各自维护一份完全独立的会话/任务管理代码，只共享这一个渲染器类；如果把提交逻辑
  // 挪去调用方，就要在两边各写一份、各自处理错误态，等于把同一件事拆成两份易失联
  // 的实现。放在渲染器这一层，靠构造函数传入的 this.taskId 就能自给自足，桌面和
  // 移动端零改动地共享同一套提交/失败/重试逻辑。
  async _submitIntervention(id) {
    const e = this.toolMap[id];
    if (!e || !e.isLive) return;
    const answers = this._collectAskqAnswers(id, e.askQuestions || []);
    if (Object.keys(answers).length === 0) {
      this._setAskqSubmitStatus(id, '请至少回答一个问题', true);
      return;
    }
    const answerIdentity = JSON.stringify(answers);
    if (e.answerAttempt && e.answerAttempt.answers !== answerIdentity) {
      this._setAskqSubmitStatus(id, '上次回答结果尚未确认，请保留原回答并重试', true);
      return;
    }

    const submitBtn = document.getElementById(`askq-submit-btn-${id}`);
    if (submitBtn) submitBtn.disabled = true;
    this._setAskqSubmitStatus(id, '提交中…', false);

    let definitiveFailure = false;
    try {
      if (!this.taskId) throw new Error('缺少 task id，无法提交');
      let body = e.answerAttempt?.body;
      if (!body) {
        const detailResp = await fetch(`${API}/api/tasks/${this.taskId}`);
        if (!detailResp.ok) throw new Error(`获取任务详情失败（HTTP ${detailResp.status}）`);
        const detail = await detailResp.json();
        const pending = detail.pending_intervention;
        if (!pending || pending.tool_call_id !== id) {
          throw new Error('这个问题已经不再等待回答了（可能已被回答或已超时）');
        }
        body = JSON.stringify({ tool_call_id: id, token: pending.token, answers });
        if (e.nativeQuestion) e.answerAttempt = {body, answers:answerIdentity};
      }

      const answerResp = await fetch(`${API}/api/tasks/${this.taskId}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!answerResp.ok) {
        definitiveFailure = answerResp.status >= 400 && answerResp.status < 500;
        const detailErr = await answerResp.json().catch(() => ({}));
        throw new Error(detailErr.detail || `提交失败（HTTP ${answerResp.status}）`);
      }

      e.answerAttempt = null;
      if (!e.isLive) return; // A streamed close/Task end already owns the final status.
      e.isLive = false;
      this._setAskqSubmitStatus(id, '✓ 已提交，等待任务处理…', false);
      this._disableAskqInputs(id);
      this._refreshWaitingStage();
    } catch (err) {
      if (definitiveFailure) e.answerAttempt = null;
      if (!e.isLive) return; // Never reopen a question after its authoritative close.
      this._setAskqSubmitStatus(id, `✗ ${err.message || '提交失败'}`, true);
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  _permissionPending(event) {
    const owner = this._questionRenderer(event.tool_call_id);
    if (owner && owner !== this) return owner._permissionPending(event);
    const id = event.tool_call_id;
    if (!id || this.permissionMap[id]) return;
    const wrap = document.createElement('div');
    wrap.className = 'askq-wrap sdk-permission-card timeline-node';
    const plan = event.tool_name === 'ExitPlanMode';
    wrap.innerHTML = `<div class="askq-title">${plan ? '计划等待批准' : '工具等待授权'} · ${esc(event.tool_name || '')}</div>
      <pre class="tool-input-code">${esc(JSON.stringify(event.tool_input || {},null,2))}</pre>
      ${event.decision_reason ? `<p>${esc(event.decision_reason)}</p>` : ''}
      <details><summary>修改参数或填写拒绝理由</summary>
        <textarea id="permission-input-${esc(id)}" class="askq-live-text" aria-label="修改工具参数 JSON" placeholder="留空使用原参数"></textarea>
        <input id="permission-reason-${esc(id)}" class="askq-live-text" aria-label="拒绝理由" placeholder="拒绝理由（可选）"></details>
      <div class="askq-submit-row"><button class="askq-submit-btn" id="permission-allow-${esc(id)}">${plan ? '批准计划并允许编辑' : '允许本次'}</button>
        <button class="askq-submit-btn" id="permission-deny-${esc(id)}">拒绝</button>
        <span id="permission-status-${esc(id)}" role="status">${this.isRunning ? '等待您的决定' : '请求已结束'}</span></div>`;
    this.permissionMap[id] = {wrap,isLive:this.isRunning,attempt:null};
    this._appendNode(wrap);
    if (this.isRunning) this._processStage('等待您的授权',true);
    for (const [label,decision] of [['allow','allow'],['deny','deny']]) {
      const button = document.getElementById(`permission-${label}-${id}`);
      if (button) {
        button.disabled = !this.isRunning;
        button.addEventListener('click', event => { event.stopPropagation(); this._submitPermission(id,decision); });
      }
    }
  }

  _permissionOwner(id) {
    if (this.permissionMap[id]) return this;
    for (const sub of Object.values(this.subagentRenderers)) {
      const owner = sub.renderer._permissionOwner(id);
      if (owner) return owner;
    }
    return null;
  }

  _closePermission(id,status) {
    const owner = this._permissionOwner(id);
    if (!owner) return;
    const entry = owner.permissionMap[id];
    entry.isLive = false; entry.attempt = null;
    entry.wrap.querySelectorAll('input, textarea, button').forEach(input => { input.disabled = true; });
    for (const label of ['allow','deny']) {
      const button = document.getElementById(`permission-${label}-${id}`);
      if (button) button.disabled = true;
    }
    const text = document.getElementById(`permission-status-${id}`);
    if (text) text.textContent = {approved:'✓ 已批准',denied:'已拒绝',timed_out:'授权已超时',cancelled:'授权已取消'}[status] || '请求已结束';
    owner._refreshWaitingStage();
  }

  async _submitPermission(id,decision) {
    const entry = this.permissionMap[id];
    if (!entry?.isLive || entry.busy) return;
    entry.busy = true;
    const status = document.getElementById(`permission-status-${id}`);
    let definitive = false;
    try {
      const input = (document.getElementById(`permission-input-${id}`)?.value || '').trim();
      const selection = {decision,message:(document.getElementById(`permission-reason-${id}`)?.value || '').trim()};
      if (input) {
        selection.updated_input = JSON.parse(input);
        if (!selection.updated_input || Array.isArray(selection.updated_input) || typeof selection.updated_input !== 'object') throw new Error('工具参数必须是 JSON 对象');
      }
      const identity = JSON.stringify(selection);
      if (entry.attempt && entry.attempt.identity !== identity) throw new Error('上次决定尚未确认，请先重试原决定');
      let body = entry.attempt?.body;
      if (!body) {
        const detail = await fetch(`${API}/api/tasks/${encodeURIComponent(this.taskId)}`);
        if (!detail.ok) throw new Error('读取授权状态失败');
        const pending = (await detail.json()).pending_intervention;
        if (!entry.isLive) return;
        if (pending?.kind !== 'permission' || pending.tool_call_id !== id) throw new Error('当前工具已经不在等待授权');
        body = JSON.stringify({tool_call_id:id,token:pending.token,...selection});
        entry.attempt = {identity,body};
      }
      if (status) status.textContent = '正在提交决定…';
      const response = await fetch(`${API}/api/tasks/${encodeURIComponent(this.taskId)}/approval`, {
        method:'POST',headers:{'Content-Type':'application/json'},body,
      });
      if (!response.ok) {
        definitive = response.status >= 400 && response.status < 500;
        throw new Error((await response.json().catch(()=>({}))).detail || '授权结果未确认，请重试原决定');
      }
      if (entry.isLive) this._closePermission(id,decision === 'allow' ? 'approved' : 'denied');
    } catch (error) {
      if (definitive) entry.attempt = null;
      if (entry.isLive && status) status.textContent = error.message;
    } finally { entry.busy = false; }
  }

  _disableAskqInputs(id) {
    const wrap = this.toolMap[id]?.wrap;
    if (wrap) wrap.querySelectorAll('input, .askq-submit-btn').forEach(el => { el.disabled = true; });
  }

  _setAskqSubmitStatus(id, text, isError) {
    const statusEl = document.getElementById(`askq-submit-status-${id}`);
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = `askq-submit-status${isError ? ' is-error' : ''}`;
  }

  // 任务日志流结束（[DONE]）时调用：还留着未作答实时表单的卡片，禁用输入并提示任务已
  // 结束——不能让它们继续看着像"还能点"，其实这个任务已经没有 CLI 进程在等这个答案了。
  deactivatePendingInterventions() {
    if (this.streamFrame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.streamFrame);
    this.streamFrame = null;
    for (const entry of this.streamBlocks.values()) if (entry.node && !entry.settled) {
      this._settleStream({id:entry.messageId},{type:entry.type,text:entry.text,thinking:entry.text});
    }
    this.streamDirty.clear();
    for (const [id,entry] of Object.entries(this.permissionMap)) if (entry.isLive) this._closePermission(id,'cancelled');
    for (const child of Object.values(this.subagentRenderers)) child.renderer.deactivatePendingInterventions();
    for (const [id, e] of Object.entries(this.toolMap)) {
      if (!e.isLive) continue;
      e.isLive = false;
      this._disableAskqInputs(id);
      this._setAskqSubmitStatus(id, '任务已结束，未作答', true);
    }
  }

  _questionRenderer(id) {
    if (this.toolMap[id]) return this;
    for (const child of Object.values(this.subagentRenderers)) {
      const owner = child.renderer._questionRenderer(id);
      if (owner) return owner;
    }
    return null;
  }

  _fillAskUserAnswers(id, e, text) {
    const questions = e.askQuestions || [];
    const raw = (text || '').trim();
    let answers = null;

    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const src = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.answers
          && typeof parsed.answers === 'object') ? parsed.answers : parsed;
        if (src && typeof src === 'object' && !Array.isArray(src)) answers = src;
      } catch { /* 非 JSON：走自由回复分支 */ }
    }

    // Intervention（issue #69）超时的哨兵答案——不是"用户打了这段自由文本"，是
    // Slice 1 后端在没等到回答时塞进 tool_result 的固定形状。混进下面通用的
    // JSON-parse/自由文本兜底逻辑会被当成自由回复整段原样显示（连着 JSON 大括号
    // 一起冒出来，看着像用户真答了这么一句话），所以在那之前单独拦一下。
    const isTimeout = !!answers && answers.timed_out === true;

    const matchedAny = !isTimeout && !!answers && questions.some(
      q => Object.prototype.hasOwnProperty.call(answers, q.question)
    );

    questions.forEach((q, i) => {
      const slot = document.getElementById(`askq-ans-${id}-${i}`);
      if (!slot) return;
      if (isTimeout) {
        slot.innerHTML = `<span class="askq-unanswered">⏱ 未在时限内回应</span>`;
      } else if (matchedAny) {
        const val = answers[q.question];
        const labels = Array.isArray(val) ? val : (val != null ? [val] : []);
        slot.innerHTML = labels.length
          ? labels.map(label => {
            const opt = (q.options || []).find(o => o.label === label);
            const desc = (opt && opt.description && opt.description !== label)
              ? `<div class="askq-desc">${esc(opt.description)}</div>` : '';
            return `<div class="askq-answer-line"><span class="askq-check">✓</span><div><div class="askq-answer-text">${esc(label)}</div>${desc}</div></div>`;
          }).join('')
          : `<span class="askq-unanswered">未作答</span>`;
      } else if (!raw) {
        slot.innerHTML = `<span class="askq-unanswered">未作答</span>`;
      } else {
        slot.innerHTML = '';
      }
    });

    if (!isTimeout && !matchedAny && raw) {
      const wrap = document.getElementById(`tiq-${id}`);
      if (wrap) {
        const fr = document.createElement('div');
        fr.className = 'askq-freeform';
        fr.innerHTML = `<span class="askq-check">✎</span><span class="askq-answer-text">${esc(raw)}</span>`;
        wrap.appendChild(fr);
      }
    }

    return isTimeout;
  }

  // 待办/任务面板的单行渲染，TodoWrite 和下面的 TaskCreate/Update/List 任务看板共用——
  // 两者的条目形状不同（{content,status,activeForm} vs {subject,status,activeForm}），
  // 调用方各自把"非 in_progress 状态下要显示的文字"传进 text 参数。
  _renderTaskRowHtml(text, status, activeForm) {
    if (status === 'in_progress') {
      return `<div class="todo-row todo-row-active"><span class="todo-row-icon">▶</span><span class="todo-row-text todo-active">${esc(activeForm || text || '')}</span></div>`;
    }
    if (status === 'deleted') {
      return `<div class="todo-row"><span class="todo-check">✗</span><span class="todo-row-text todo-done">${esc(text || '')}</span></div>`;
    }
    const done = status === 'completed';
    return `<div class="todo-row"><span class="todo-check${done ? ' done' : ''}">${done ? '✓' : '○'}</span><span class="todo-row-text${done ? ' todo-done' : ''}">${esc(text || '')}</span></div>`;
  }

  // ── TodoWrite：待办清单卡片 ────────────────────────────────
  // input.todos = [{content, status, activeForm}]，status 是 pending/in_progress/completed。
  // tool_result 只是一句确认文本（"Todos have been modified successfully"之类），没有信息量，
  // 卡片本身就是从 tool_use.input 里的最新清单状态渲染完的，不需要等 tool_result 再填充。
  _toolUseTodoWrite(block) {
    const { id, name, input } = block;
    const todos = Array.isArray(input?.todos) ? input.todos : [];
    const total = todos.length;
    const completed = todos.filter(t => t?.status === 'completed').length;
    const inProgress = todos.find(t => t?.status === 'in_progress');
    const allDone = total > 0 && completed === total;

    const icon = toolIcon(name);
    const summary = inProgress
      ? (inProgress.activeForm || inProgress.content || '')
      : (allDone ? '全部完成' : `${total} 项待办`);

    const headerIcon = inProgress ? '▶' : (allDone ? '✓' : '☰');
    const headerLabel = inProgress ? '当前步骤' : (allDone ? '全部完成' : '待办事项');
    const headerDetailText = inProgress ? (inProgress.activeForm || inProgress.content || '') : '';

    const rows = todos.map(t => this._renderTaskRowHtml(t?.content, t?.status, t?.activeForm)).join('');

    const wrap = document.createElement('div');
    wrap.className = 'chat-tool-wrap';
    wrap.classList.add('timeline-node');
    wrap.dataset.toolId = id;

    const card = document.createElement('div');
    card.className = 'chat-tool-card';
    card.innerHTML = `
  <div class="chat-tool-header">
    <span class="tool-status" id="ts-${id}">⏳</span>
    <span class="tool-badge pending" id="tb-${id}">${esc(icon)} ${esc(name)}</span>
    <span class="tool-cmd" title="${esc(summary)}">${esc(summary)}</span>
    <button class="tool-toggle" id="tt-${id}">收起</button>
  </div>
  <div class="tool-body" id="tbody-${id}">
    <div class="todo-header">
      <span class="todo-header-icon">${headerIcon}</span>
      <span class="todo-header-label">${esc(headerLabel)}${headerDetailText ? `: <span class="todo-header-detail">${esc(headerDetailText)}</span>` : ''}</span>
      <span class="todo-header-count">${completed}/${total}</span>
    </div>
    <div class="todo-list">${rows}</div>
  </div>`;

    wrap.appendChild(card);
    this._appendNode(wrap);

    const header = card.querySelector('.chat-tool-header');
    const body = document.getElementById(`tbody-${id}`);
    const btn = document.getElementById(`tt-${id}`);
    header.addEventListener('click', () => {
      const collapsed = body.classList.toggle('collapsed');
      btn.textContent = collapsed ? '展开' : '收起';
    });
    btn.addEventListener('click', e => { e.stopPropagation(); header.click(); });

    this.toolMap[id] = {
      statusEl: document.getElementById(`ts-${id}`),
      badgeEl: document.getElementById(`tb-${id}`),
      outputEl: null,
      outputLabelEl: null,
      exitEl: null,
      bodyEl: body,
      btnEl: btn,
      wrap, name, input,
      isTodoWrite: true,
    };
  }

  // ── 任务看板：全局唯一的 sticky 面板，原地更新而不是每次追加新卡片 ─────
  // 之前每次 TaskUpdate 都整块重画一遍清单——8 项任务、更新十几次，时间线里
  // 就是同一份清单被复制十几遍，只有标题那一行不一样。现在改成：整个会话只建
  // 一个看板 DOM 节点（第一次出现 Task* 事件时创建），position:sticky 贴在
  // 聊天区顶部，之后所有 TaskCreate/TaskUpdate/TaskList 都只原地改这一个节点
  // 的内容；每次 TaskUpdate/TaskList 在时间线原本发生的位置只留一行 _pill()
  // 叙事标记（"已完成: xxx"），不再带完整清单。
  //
  // 不用 _appendNode 挂载——要是恰好处于 foldProcess 的"任务执行过程"折叠区里，
  // 会被 display:none 隐藏掉，直接违背"这块面板要一直看得见"的初衷。
  _ensureTaskBoardEl() {
    if (this.taskBoardEl) return;
    const idp = this.idPrefix;
    const wrap = document.createElement('div');
    wrap.className = 'task-board-sticky is-muted';
    wrap.innerHTML = `
  <div class="todo-header task-board-header">
    <span class="todo-header-icon" id="tbrd-icon-${idp}">☰</span>
    <span class="todo-header-label" id="tbrd-label-${idp}">任务看板</span>
    <span class="todo-header-count" id="tbrd-count-${idp}">0/0</span>
    <button class="tool-toggle" id="tbrd-toggle-${idp}">收起</button>
  </div>
  <div class="todo-list" id="tbrd-list-${idp}"></div>`;

    this.inner.appendChild(wrap);
    this.taskBoardEl = wrap;
    this.taskBoardIconEl = document.getElementById(`tbrd-icon-${idp}`);
    this.taskBoardLabelEl = document.getElementById(`tbrd-label-${idp}`);
    this.taskBoardCountEl = document.getElementById(`tbrd-count-${idp}`);
    this.taskBoardListEl = document.getElementById(`tbrd-list-${idp}`);

    const listEl = this.taskBoardListEl;
    const toggleBtn = document.getElementById(`tbrd-toggle-${idp}`);
    toggleBtn.addEventListener('click', () => {
      const collapsed = listEl.classList.toggle('collapsed');
      toggleBtn.textContent = collapsed ? '展开' : '收起';
    });
  }

  // headerOverride 为 null 时展示标准聚合头（当前步骤 / 全部完成 / 任务看板 +
  // 完成数/总数）；传 {icon, label, detail} 时展示"这一次操作做了什么"。
  _updateTaskBoardEl(headerOverride) {
    this._ensureTaskBoardEl();

    const items = [...this.taskBoard.entries()]
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([taskId, t]) => ({ id: taskId, ...t }));

    const total = items.length;
    const completed = items.filter(t => t.status === 'completed').length;
    const inProgress = items.find(t => t.status === 'in_progress');
    const allDone = total > 0 && completed === total;

    const headerIcon = headerOverride ? headerOverride.icon : (inProgress ? '▶' : (allDone ? '✓' : '☰'));
    const headerLabel = headerOverride
      ? (headerOverride.detail ? `${headerOverride.label}: ${headerOverride.detail}` : headerOverride.label)
      : (inProgress ? `当前步骤: ${inProgress.activeForm || inProgress.subject || ''}` : (allDone ? '全部完成' : '任务看板'));

    this.taskBoardIconEl.textContent = headerIcon;
    this.taskBoardLabelEl.textContent = headerLabel;
    this.taskBoardCountEl.textContent = `${completed}/${total}`;
    this.taskBoardListEl.innerHTML = items.length
      ? items.map(t => this._renderTaskRowHtml(t.subject, t.status, t.activeForm)).join('')
      : `<div class="todo-row"><span class="todo-row-text" style="opacity:.6">(暂无任务)</span></div>`;
  }

  // ── TaskUpdate：更新看板状态 + 留一行叙事小药丸 ─────────────────
  // input = {taskId, status?, subject?, activeForm?, ...}。status:'deleted' 直接从
  // this.taskBoard 里摘掉（看板的完成数/总数跟着变，不是留一行加删除线摆着）；
  // 其余状态合并进已有条目（没有就新建一条）。
  _toolUseTaskUpdate(block) {
    const { input } = block;
    const taskId = input?.taskId != null ? String(input.taskId) : null;
    let subjectForHeader = input?.subject || '';

    if (taskId) {
      const existing = this.taskBoard.get(taskId) || {};
      if (!subjectForHeader) subjectForHeader = existing.subject || '';
      if (input.status === 'deleted') {
        this.taskBoard.delete(taskId);
      } else {
        const next = { ...existing };
        if (input.subject != null) next.subject = input.subject;
        if (input.activeForm != null) next.activeForm = input.activeForm;
        if (input.status != null) next.status = input.status;
        this.taskBoard.set(taskId, next);
      }
    }

    const STATUS_META = {
      completed:   { icon: '✓', verb: '已完成' },
      deleted:     { icon: '✗', verb: '已删除' },
      in_progress: { icon: '▶', verb: '已开始' },
      pending:     { icon: '↺', verb: '已重置' },
    };
    const meta = STATUS_META[input?.status] || { icon: '☰', verb: '更新任务' };

    this._pill(meta.verb, subjectForHeader);
    this._updateTaskBoardEl({ icon: meta.icon, label: meta.verb, detail: subjectForHeader });
  }

  // ── TaskList：不改动看板状态，只是把当前快照重新展示一遍 ───────
  _toolUseTaskList(block) {
    this._pill('任务列表已同步', '');
    this._updateTaskBoardEl(null);
  }

  // 单条工具输出直接塞进 textContent 的字符上限：少数工具（Bash 里 cat 大文件、Read 整份
  // 长文件等）会把几十上百 KB 原样写进 tool_result，历史回放时这些内容大多数还在折叠区里
  // 没人看，却仍然要整体构建成 DOM——手机端一次打开会话要拼好几个这样的任务，主线程明显卡顿。
  // 超限后先截断显示，点「显示完整输出」再补上剩余部分。
  static TOOL_OUTPUT_TRUNCATE_LEN = 8000;
  static RAW_LINE_PREVIEW_LEN = 2000;

  // 这些工具的结果几乎总是"要看的东西"（改了什么/建了什么/计划是什么），
  // 不管长短都直接展开，不再套用行数/字符数的通用启发式。
  // TodoWrite/AskUserQuestion 不在这张表里——它们各自走专门的渲染方法
  // （_toolUseTodoWrite/_toolUseAskUserQuestion），从不经过这条通用展开逻辑。
  static ALWAYS_EXPAND_TOOLS = new Set(['Edit', 'Write', 'Task']);

  // Read 命中图片文件时 tool_result 带的是 base64 image block 而非文本，
  // 原来直接当文本处理会渲染出一片空白——这里换成缩略图，点击可在新标签打开原图。
  _setToolOutputImages(el, images) {
    el.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'tool-output-images';
    for (const img of images) {
      const src = img.source || {};
      let url = '';
      if (src.type === 'base64' && src.data) url = `data:${src.media_type || 'image/png'};base64,${src.data}`;
      else if (src.type === 'url' && src.url) url = src.url;
      if (!url) continue;
      const el2 = document.createElement('img');
      el2.className = 'tool-output-img';
      el2.src = url;
      el2.loading = 'lazy';
      el2.addEventListener('click', ev => { ev.stopPropagation(); window.open(url, '_blank'); });
      wrap.appendChild(el2);
    }
    el.appendChild(wrap);
  }

  // ansiToHtml（utils.js）把 Bash 类工具输出里的 ANSI 颜色码渲染成带色 <span>；
  // 没有转义码的普通文本原样走 esc() 转义，跟原来 textContent 视觉上没有差别，
  // 所以这里对所有工具的输出统一用它，不需要按工具名区分。
  _setToolOutputText(el, out, ok) {
    if (!out) { el.textContent = ok ? '(无输出)' : '(执行失败)'; return; }
    if (out.length <= ChatLogRenderer.TOOL_OUTPUT_TRUNCATE_LEN) { el.innerHTML = ansiToHtml(out); return; }

    el.innerHTML = ansiToHtml(out.slice(0, ChatLogRenderer.TOOL_OUTPUT_TRUNCATE_LEN));
    const remaining = out.length - ChatLogRenderer.TOOL_OUTPUT_TRUNCATE_LEN;
    const more = document.createElement('button');
    more.className = 'tool-output-more';
    more.textContent = `… 显示完整输出（还有 ${remaining.toLocaleString()} 字符）`;
    more.addEventListener('click', ev => {
      ev.stopPropagation();
      el.innerHTML = ansiToHtml(out);
      more.remove();
    });
    el.after(more);
  }

  // ── 填充工具结果 ──────────────────────────────────────────
  _fillTool(id, text, isError, images) {
    const e = this.toolMap[id];
    if (!e) return;

    const ok = !isError;
    if (isError) this._processStage(`工具执行失败 · ${e.name}`,true);
    e.statusEl.textContent = ok ? '✓' : '✗';
    e.badgeEl.className = `tool-badge ${ok ? 'ok' : 'fail'}`;
    e.badgeEl.textContent = `${toolIcon(e.name)} ${e.name}`;

    if (e.name === 'AskUserQuestion' && e.askQuestions) {
      const isTimeout = this._fillAskUserAnswers(id, e, text);
      e.isLive = false;
      const submitRow = document.getElementById(`askq-submit-row-${id}`);
      if (submitRow) submitRow.style.display = 'none';
      e.exitEl.style.display = '';
      e.exitEl.className = `tool-exit ${isTimeout ? 'fail-exit' : (ok ? 'ok-exit' : 'fail-exit')}`;
      e.exitEl.textContent = isTimeout ? '⏱  超时未回应' : (ok ? '✓  已作答' : '✗  未作答');
      this._refreshWaitingStage();
      return;
    }

    // TodoWrite 的卡片已经从 tool_use.input 渲染完整——tool_result 只是一句确认
    // 文本，没有 outputEl/exitEl 可填（toolMap 条目里两者都是 null），到这就结束。
    // TaskUpdate/TaskList 现在走独立的 sticky 看板（_updateTaskBoardEl），压根不
    // 在 toolMap 里注册条目，所以它们的 tool_result 到这里 `e` 早已是 undefined，
    // 在方法开头就已经 return 了，不需要在这里再判断一次。
    if (e.isTodoWrite) return;

    // TaskCreate 的 tool_result 是 CC 自己确认成功创建的文本："Task #<N> created
    // successfully: <subject>"——数字 id 只有这时候才揭晓（tool_use.input 里没有，
    // 是 CC 分配的），要靠正则从这句话里抠出来才能把它登记进任务看板供后续
    // TaskUpdate/TaskList 引用。TaskCreate 本身仍然走通用卡片正常展示这行输出，
    // 不提前 return——这里只是顺带把状态记下来，并同步一下 sticky 看板
    // （如果这是会话里第一个 Task* 事件，看板这时候才第一次出现）。
    if (e.name === 'TaskCreate' && ok) {
      const m = /Task #(\d+) created successfully/.exec(text || '');
      if (m) {
        this.taskBoard.set(m[1], {
          subject: e.input?.subject || '',
          activeForm: e.input?.activeForm || '',
          status: 'pending',
        });
        this._updateTaskBoardEl(null);
      }
    }

    // Read 工具的文本结果是 CLI 自带的 `cat -n` 式行号（"␣␣␣1\t内容"），对着行号
    // 读代码没有意义，展示前统一剥掉。
    const rawOut = e.name === 'Read' ? stripReadLineNumbers(text || '') : (text || '');
    const out = rawOut.trim();
    const hasImages = !!(images && images.length);
    if (e.outputLabelEl) e.outputLabelEl.style.display = '';
    e.outputEl.style.display = '';
    e.outputEl.className = `tool-output${ok ? '' : ' is-error'}`;
    if (hasImages) {
      this._setToolOutputImages(e.outputEl, images);
      if (out) {
        const textEl = document.createElement('div');
        e.outputEl.appendChild(textEl);
        this._setToolOutputText(textEl, out, ok);
      }
    } else if (e.name === 'Skill' && out) {
      // Skill 工具的产出本来就是给人看的说明文字，通常带 markdown 格式
      // （列表/代码块/加粗），按 markdown 渲染比转义成一大段纯文本可读得多。
      e.outputEl.classList.add('tool-output-md');
      e.outputEl.innerHTML = renderMd(out);
    } else {
      this._setToolOutputText(e.outputEl, out, ok);
    }

    e.exitEl.style.display = '';
    e.exitEl.className = `tool-exit ${ok ? 'ok-exit' : 'fail-exit'}`;
    e.exitEl.textContent = ok ? '✓  exit 0' : '✗  error';

    // 自动展开：要么工具本身总是值得一看，要么命中了图片，要么输出足够短
    const lineCount = out.split('\n').length;
    const shouldExpand = ChatLogRenderer.ALWAYS_EXPAND_TOOLS.has(e.name) ||
      (e.name === 'Read' && hasImages) ||
      (lineCount <= 6 && out.length <= 400);
    if (shouldExpand) {
      e.bodyEl.classList.remove('collapsed');
      e.btnEl.textContent = '收起';
    }

    // 文件操作：追加变更徽章。Write/Edit 的卡片头部本来就显示着同一个 file_path
    // （Edit 现在还带完整 diff 正文），这里再补一张"EDIT xxx.js"卡纯属重复。
    // NotebookEdit 没有专门的 summary/input 格式化（走的是默认 JSON 预览），
    // 头部看不出干净的路径，这里的徽章是它唯一的清晰路径展示，所以保留。
    if (e.name === 'NotebookEdit' && ok) {
      // NotebookEdit 的真实字段是 notebook_path，不是 file_path/path——之前这行
      // 一直取不到值，徽章从未真正显示过。
      const fp = e.input?.notebook_path || e.input?.file_path || e.input?.path || '';
      if (fp) {
        const fc = document.createElement('div');
        fc.className = 'chat-file-card timeline-node';
        fc.innerHTML = `<span class="file-op-badge edit">EDIT</span><span class="file-path">${esc(fp)}</span>`;
        e.wrap.after(fc);
      }
    }
    if (e.backgroundTask) this._renderBackgroundTask(e,e.backgroundTask.id,e.backgroundTask);
  }

  // ── Footer ────────────────────────────────────────────────
  _renderFooter(text) {
    if (this._footerRendered) return;
    this._footerRendered = true;
    this.isRunning = false;
    this.deactivatePendingInterventions();
    let status = 'done', label = '✓ 任务完成';
    if (typeof text === 'string') {
      if (text.includes('killed')) { status = 'killed'; label = this.interrupted ? '⊘ 已中断，会话可继续' : '⊘ 任务已终止'; }
      else if (text.includes('failed') || text.includes('error')) {
        status = 'failed';
        const m = text.match(/\[([^\]]+)\]/);
        label = '✗ 任务失败' + (m ? '  · ' + m[1] : '');
      }
    }
    const el = document.createElement('div');
    el.className = 'chat-footer';
    this._finishSDKInputs(status);
    for (const command of this.nativeCommands.values()) {
      if (ChatLogRenderer.COMMAND_STATES[command.state]?.rank === 2) continue;
      command.node.dataset.commandTaskOutcome = status;
      command.node.querySelector('.chat-sys-pill').textContent =
        ({killed:'任务已中断',failed:'任务失败',done:'任务已结束'}[status])+' · 指令终态未确认';
    }
    this._processStage(status === 'done' ? '处理完成' : status === 'killed' ? '已中断，可继续对话' : '任务失败');
    el.classList.add('timeline-node', status === 'failed' ? 'is-error' : 'is-muted');
    el.innerHTML = `<span class="footer-pill ${status}">${esc(label)}</span>`;
    this._appendNode(el);
  }

  // ── 系统药丸 ──────────────────────────────────────────────
  _pill(label, detail, timeLabel = '') {
    const el = document.createElement('div');
    el.className = 'chat-sys-event';
    el.classList.add('timeline-node', 'is-muted');
    el.innerHTML = `<span class="chat-sys-pill">${esc(label)}${detail ? ` <span class="pill-detail">· ${esc(detail)}</span>` : ''}</span>${timeLabel ? '<span class="bubble-time-slot"></span>' : ''}`;
    if (timeLabel) this._recordMessageTime(el, timeLabel);
    this._appendNode(el);
  }

  // ── Grok streaming-json 解析器 ────────────────────────────
  //
  // 每行格式之一：
  //   {"type":"thought","data":"<token>"}   → 思考过程（流式拼接）
  //   {"type":"text","data":"<token>"}      → 回复正文（流式拼接）
  //   {"type":"end","stopReason":"...","sessionId":"...","requestId":"..."}
  //
  // 非 JSON 行（如 printf 写入的 grok_session_id=... 标记行）静默忽略。

  _grokLine(line) {
    if (!line.startsWith('{')) return;   // grok_session_id= 标记行等，跳过
    let d;
    try { d = JSON.parse(line); } catch { return; }
    switch (d.type) {
      case 'thought': this._grokToken('thought', d.data || ''); break;
      case 'text':    this._grokToken('text',    d.data || ''); break;
      case 'end':     this._grokEnd(d);                         break;
      // 其他未知 type：静默忽略
    }
  }

  // 核心：处理单个 token，自动检测类型切换并开新段落
  _grokToken(type, token) {
    // ── 类型切换：刷新上一段，重置状态 ──
    if (this._grokCurrentType !== type) {
      this._grokFlushCurrent();
      this._grokCurrentType    = type;
      this._grokCurrentBuf     = '';
      this._grokCurrentEl      = null;
      this._grokCurrentTextRef = null;
      this._grokSegCount++;
    }

    this._grokCurrentBuf += token;

    // ── 本段第一个 token：创建对应气泡元素 ──
    if (!this._grokCurrentEl) {
      const segId = `gk${this.idPrefix}${this._grokSegCount}`;
      if (type === 'thought') {
        const el = document.createElement('div');
        el.className = 'chat-bubble-wrap thought-reply timeline-node is-muted';
        el.innerHTML = `
  <div class="bubble-body">
    <div class="bubble-label think-label">思考过程</div>
    <div class="bubble think-bubble" id="${segId}"></div>
  </div>`;
        this._appendNode(el);
        this._grokCurrentEl = el.querySelector(`#${segId}`);
      } else {
        // text：需要复制按钮持有当前段文本的引用
        const textRef = { value: '' };
        this._grokCurrentTextRef = textRef;
        const el = document.createElement('div');
        el.className = 'chat-bubble-wrap ai-reply timeline-node';
        el.innerHTML = `
  <div class="bubble-body">
    <div class="bubble">
      <div class="bubble-label-row">
        <div class="bubble-label">Grok</div>
      </div>
      <div class="bubble-content" id="${segId}"></div>
    </div>
    <div class="message-footer ai-message-footer">
      <div class="bubble-actions">
        <button class="bubble-copy-btn" title="复制" aria-label="复制回复">${copyBtnSVG()}</button>
      </div>
      <span class="bubble-time-slot"></span>
    </div>
  </div>`;
        this._prepareReplyTime(el);
        el.querySelector('.bubble-copy-btn').addEventListener('click', () => {
          copyTextToClipboard(textRef.value, el.querySelector('.bubble-copy-btn'));
        });
        // 把上一条文本气泡移入折叠区（如有）
        if (this.lastBubbleEl) {
          if (this.foldProcess) {
            this._appendToProcess(this.lastBubbleEl);
          } else {
            this.inner.appendChild(this.lastBubbleEl);
          }
        }
        this.inner.appendChild(el);
        this.lastBubbleEl = el;
        this._grokCurrentEl = el.querySelector(`#${segId}`);
      }
    }

    // 同步更新复制按钮的文本引用
    if (this._grokCurrentTextRef) {
      this._grokCurrentTextRef.value = this._grokCurrentBuf;
    }

    this._grokScheduleRender();
  }

  // RAF 节流：每帧最多调用一次 renderMd，实时 markdown 渲染不卡顿
  _grokScheduleRender() {
    if (this._grokRafPending) return;
    this._grokRafPending = true;
    requestAnimationFrame(() => {
      this._grokRafPending = false;
      if (this._grokCurrentEl && this._grokCurrentBuf) {
        this._grokCurrentEl.innerHTML = renderMd(this._grokCurrentBuf);
      }
    });
  }

  // 同步刷新当前段（类型切换 / end 事件时调用）
  _grokFlushCurrent() {
    if (this._grokCurrentEl && this._grokCurrentBuf) {
      this._grokCurrentEl.innerHTML = renderMd(this._grokCurrentBuf);
      if (this._grokCurrentTextRef) {
        this._grokCurrentTextRef.value = this._grokCurrentBuf;
      }
    }
  }

  _grokEnd(d) {
    // 清掉待处理的 RAF，同步完成最后一段渲染
    this._grokRafPending = false;
    this._grokFlushCurrent();

    // 用量 / 会话信息行
    const items = [];
    if (d.stopReason) items.push(`停止原因 <span>${esc(d.stopReason)}</span>`);
    const sessionId = d.sessionId || d.session_id || d.sessionID;
    if (sessionId) {
      const sid = String(sessionId);
      items.push(`Session <span title="${esc(sid)}">#${esc(sid.slice(0, 8))}</span>`);
    }
    if (items.length) {
      const el = document.createElement('div');
      el.className = 'chat-usage timeline-node is-muted';
      el.innerHTML = items.map(i => `<div class="usage-item">${i}</div>`).join('');
      this._appendNode(el);
    }

    if (!this._footerRendered) this._renderFooter('done');
  }

  // ── Hermes 纯文本解析器 ───────────────────────────────────
  // line 到达此处时已被 trimEnd() + trim()，空行已被调用方过滤
  _hermesLine(line) {
    // 判断是否为纯分隔线（仅含 ─ U+2500）
    const isBorder = line.length > 4 && /^─+$/.test(line);

    if (this._hermesState === 'in_response') {
      if (isBorder) {
        // 遇到关闭边框，输出 AI 气泡
        const response = this._hermesResponseBuf.join('\n').trim();
        if (response) this._bubble(response, 'Hermes');
        this._hermesResponseBuf = [];
        this._hermesState = 'init';
      } else if (line.includes('⚕ Hermes')) {
        // 连续第二条回复头（多轮）：先刷出当前
        const prev = this._hermesResponseBuf.join('\n').trim();
        if (prev) this._bubble(prev, 'Hermes');
        this._hermesResponseBuf = [];
      } else {
        this._hermesResponseBuf.push(line);
      }
      return;
    }

    // init 状态
    if (isBorder) return;
    if (line.startsWith('Query:')) return;          // header 里已有 prompt 字段，不重复
    if (line === 'Initializing agent...') {
      this._pill('Hermes', '初始化中');
      return;
    }
    if (line.includes('⚕ Hermes')) {
      this._hermesState = 'in_response';
      this._hermesResponseBuf = [];
      return;
    }
    if (line.startsWith('Resume this session with:')) return;
    if (line.startsWith('hermes --resume')) return;
    if (line.startsWith('Session:')) {
      this._hermesSessionId = line.replace(/^Session:\s*/, '');
      return;
    }
    if (line.startsWith('Duration:')) {
      this._hermesDuration = line.replace(/^Duration:\s*/, '');
      return;
    }
    if (line.startsWith('Messages:')) {
      this._hermesMessages = line.replace(/^Messages:\s*/, '');
      this._hermesFlushUsage();
      return;
    }
    // 其余未知行静默忽略（避免红色 raw 样式污染）
  }

  _hermesFlushUsage() {
    const items = [];
    if (this._hermesDuration) items.push(`耗时 <span>${esc(this._hermesDuration)}</span>`);
    if (this._hermesMessages) items.push(`消息 <span>${esc(this._hermesMessages)}</span>`);
    if (this._hermesSessionId) {
      const sid = this._hermesSessionId;
      items.push(`Session <span title="${esc(sid)}">${esc(sid.slice(0, 20))}</span>`);
    }
    if (!items.length) return;
    const el = document.createElement('div');
    el.className = 'chat-usage timeline-node is-muted';
    el.innerHTML = items.map(i => `<div class="usage-item">${i}</div>`).join('');
    this._appendNode(el);
    // 重置，避免多轮重复输出
    this._hermesDuration = '';
    this._hermesMessages = '';
    this._hermesSessionId = '';
  }

  // ── 原始/错误行 ───────────────────────────────────────────
  _rawLine(line) {
    if (!line.trim()) return;
    const el = document.createElement('div');
    el.className = 'chat-raw-line';
    el.classList.add('timeline-node', 'is-error');
    // 损坏的图片事件可能只剩 Base64 尾巴；原始日志仍保留在服务端，
    // 时间线只展示有限预览，避免编码数据撑满页面或拖慢 DOM 渲染。
    const preview = line.slice(0, ChatLogRenderer.RAW_LINE_PREVIEW_LEN)
      .replace(/[A-Za-z0-9+/]{256,}={0,2}/g, '[较长的编码数据已省略]');
    el.textContent = preview + (line.length > ChatLogRenderer.RAW_LINE_PREVIEW_LEN
      ? '\n… 原始输出过长，已截断' : '');
    this._appendNode(el);
  }
}
