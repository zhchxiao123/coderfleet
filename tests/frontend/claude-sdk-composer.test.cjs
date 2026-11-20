const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

class Element {
  constructor() {
    this.dataset = {}; this.children = []; this.value = ''; this.style = {}; this.checked = false; this.listeners = {};
    this.classList = {add(){},remove(){}};
  }
  setAttribute(name,value) { this[name] = value; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren() { this.children = []; }
  dispatchEvent() {}
  focus() {}
  querySelectorAll() { return []; }
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
}

function desktop() {
  const nodes = new Map(['chat-input','chat-send-btn','sdk-task-controls','sdk-options','chat-schedule-checkbox','chat-queue-mode'].map(id=>[id,new Element()]));
  const calls = [];
  const storage = new Map();
  const context = vm.createContext({
    document:{getElementById:id=>nodes.get(id)||null,createElement:()=>new Element(),createTextNode:text=>Object.assign(new Element(),{textContent:text}),addEventListener(){}},
    localStorage:{getItem:()=>null},sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    crypto:require('node:crypto'),Event:class {}, API:'',esc:value=>String(value),console,setTimeout,clearTimeout,alert(){},confirmDialog:async()=>false,
    fetch:async(url,options)=>{calls.push({url,body:options?.body?JSON.parse(options.body):null});return{ok:true,json:async()=>url==='/api/tasks'?{id:'queued-task',status:'pending',type:'claude'}:{status:'accepted'}};},
  });
  for (const file of ['state.js','sdk-task-controls.js','chat-history.js','chat.js']) vm.runInContext(fs.readFileSync('coderfleet/server/static/js/'+file,'utf8'),context,{filename:file});
  vm.runInContext(`activeConversationId='conv-one';currentChatTaskId='task-one';tasksCache=[{id:'task-one',conversation_id:'conv-one',status:'running',execution_backend:'sdk',sdk_control_ready:true}];`,context);
  const loadConversations = context.loadConversations;
  const selectConversation = context.selectConversation;
  vm.runInContext(`selectConversation=async()=>{};loadConversations=()=>{};loadTasks=()=>{};loadProjectsDashboard=()=>{};renderImagePreviews=()=>{};`,context);
  return {context,nodes,calls,loadConversations,selectConversation};
}

test('topbar conversation switches isolate drafts and discard attachments from the previous chat', async () => {
  const {context,nodes,selectConversation} = desktop();
  context.document.querySelectorAll = () => [];
  context.document.querySelector = () => new Element();
  context.window = {addEventListener() {}};
  for (const id of ['topbar-tabs','page-chat','page-title']) nodes.set(id,new Element());
  vm.runInContext(fs.readFileSync('coderfleet/server/static/js/terminal.js','utf8'),context);
  context.renderTopbarTabs = () => {};
  context.upsertConversationTab = id => 'conversation-'+id;
  context.rerenderChatProjectList = () => {};
  context.renderChatWorkspace = async () => {};
  context.syncBottomTerminalProjectFromContext = () => {};
  vm.runInContext("chatConversationsList=[{id:'conv-one'},{id:'conv-two'}];pendingImages=[{container_path:'/private/project-one.png'}]",context);
  nodes.get('chat-input').value='project one draft';
  context.switchTab('conversation-conv-two');
  assert.equal(nodes.get('chat-input').value,'');
  assert.equal(vm.runInContext('pendingImages.length',context),0);
  nodes.get('chat-input').value='project two draft';
  await selectConversation('conv-one');
  assert.equal(nodes.get('chat-input').value,'project one draft');
  context.switchTab('conversation-conv-two');
  assert.equal(nodes.get('chat-input').value,'project two draft');
});

test('the root chat Tab opens the new-chat draft without restoring the previous session over it', async () => {
  const {context,nodes,loadConversations,selectConversation} = desktop();
  context.document.querySelectorAll = () => [];
  context.document.querySelector = () => new Element();
  context.window = {addEventListener() {}};
  for (const id of ['topbar-tabs','page-chat','page-title','chat-history-list']) nodes.set(id,new Element());
  vm.runInContext(fs.readFileSync('coderfleet/server/static/js/terminal.js','utf8'),context);
  Object.assign(context, {
    loadConversations, renderTopbarTabs() {}, syncConversationTabLabels() {}, renderConversations() {},
    renderEmptyChatState() {}, syncBottomTerminalProjectFromContext() {},
    renderChatWorkspace:async()=>{}, rerenderChatProjectList() {}, upsertConversationTab:id=>id,
    fetch:async()=>({ok:true,json:async()=>[]}),
  });
  context.sessionStorage.setItem('coderfleet.activeConvId','conv-one');
  nodes.get('chat-input').value='keep this conversation draft';
  await context.switchTab('chat');
  assert.equal(vm.runInContext('activeConversationId',context),null);
  assert.equal(nodes.get('chat-input').value,'');
  vm.runInContext("chatConversationsList=[{id:'conv-one'}]",context);
  await selectConversation('conv-one');
  assert.equal(nodes.get('chat-input').value,'keep this conversation draft');
});

test('desktop supplementary send uses the actual desktop upload state', async () => {
  const {context,nodes,calls} = desktop();
  nodes.get('chat-input').value = '补充要求';
  vm.runInContext('_syncChatSendButton(currentChatTaskId,false)',context);
  await nodes.get('chat-send-btn').onclick();
  assert.equal(calls.length,1,nodes.get('sdk-task-controls').children.at(-1).textContent);
  assert.equal(calls[0].url,'/api/tasks/task-one/messages');
  assert.equal(calls[0].body.text,'补充要求');
  assert.equal(nodes.get('chat-input').value,'');
});

test('sending a restored project draft consumes it before the project starts another chat', async () => {
  const {context,nodes,calls} = desktop();
  Object.assign(context, {
    showPage() {}, renderEmptyChatState() {}, syncBottomTerminalProjectFromContext() {},
    upsertConversationTab: id => 'conversation-'+id, renderTopbarTabs() {}, _autoTitleConversation() {},
    _appendOptimisticUserMessage: () => true,
    fetch: async (url,options) => {
      calls.push({url,body:JSON.parse(options.body)});
      return {ok:true,json:async()=>({id:'first-task',conversation_id:'new-conv',status:'pending'})};
    },
  });
  vm.runInContext("activeConversationId=null;chatNewSessionProject='P';currentChatTaskId=null;tasksCache=[];chatDrafts.set('new:P','restored project draft')",context);
  nodes.get('chat-input').value='restored project draft';
  await context.sendChatMessage();
  assert.equal(calls[0].url,'/api/tasks');
  assert.equal(nodes.get('chat-input').value,'');
  context.startNewChat({projectName:'P'});
  assert.equal(nodes.get('chat-input').value,'');
});

test('explicit queue selection and attachments retain the queued Task path', async () => {
  for (const attachment of [false,true]) {
    const {context,nodes,calls} = desktop();
    nodes.get('chat-input').value = '下一轮';
    if (attachment) vm.runInContext(`pendingImages=[{container_path:'/workspace/image.png'}]`,context);
    else nodes.get('chat-queue-mode').checked = true;
    vm.runInContext('_syncChatSendButton(currentChatTaskId,false)',context);
    await nodes.get('chat-send-btn').onclick();
    assert.deepEqual(calls.map(call=>call.url),['/api/tasks']);
    assert.equal(calls[0].body.conversation_id,'conv-one');
    if (attachment) assert.deepEqual(calls[0].body.images,['/workspace/image.png']);
  }
});

test('uploading and SDK initialization never silently fall back to queued sends', async () => {
  for (const setup of ['chatUploadingImages=1','tasksCache[0].sdk_control_ready=false']) {
    const {context,nodes,calls} = desktop();
    nodes.get('chat-input').value = '保留输入';
    vm.runInContext(setup+';_syncChatSendButton(currentChatTaskId,false)',context);
    assert.equal(nodes.get('chat-send-btn').disabled,true);
    await vm.runInContext('sendChatMessage()',context); // Enter uses the same dispatcher.
    assert.equal(calls.length,0);
    assert.equal(nodes.get('chat-input').value,'保留输入');
  }
});

test('a failed primary send preserves the draft and retries the same request ID', async () => {
  const {context,nodes,calls} = desktop();
  let attempt = 0;
  context.fetch = async (url,options) => {
    calls.push({url,body:JSON.parse(options.body)});
    if (++attempt===1) throw new Error('connection lost');
    return {ok:true,json:async()=>({status:'accepted'})};
  };
  nodes.get('chat-input').value = '重试同一条';
  vm.runInContext('_syncChatSendButton(currentChatTaskId,false)',context);
  await nodes.get('chat-send-btn').onclick();
  assert.equal(nodes.get('chat-input').value,'重试同一条');
  assert.equal(nodes.get('sdk-task-controls').children[0].hidden,false);
  await nodes.get('chat-send-btn').onclick();
  assert.equal(calls[0].body.request_id,calls[1].body.request_id);
  assert.equal(nodes.get('chat-input').value,'');
});

test('an unconfirmed send after Task exit is checked instead of replayed as a new Task', async () => {
  const {context,nodes,calls} = desktop();
  context.fetch = async (url,options) => {
    calls.push({url,body:options?.body?JSON.parse(options.body):null});
    if (options) throw new Error('response lost');
    return {ok:true,json:async()=>({status:'unconfirmed'})};
  };
  nodes.get('chat-input').value = '结果未知';
  vm.runInContext('_syncChatSendButton(currentChatTaskId,false)',context);
  await nodes.get('chat-send-btn').onclick();
  vm.runInContext(`tasksCache[0].status='done';tasksCache[0].sdk_control_ready=false;tasksCache.push({id:'next-running',conversation_id:'conv-one',status:'running',execution_backend:'sdk',sdk_control_ready:true});currentChatTaskId='next-running';_syncChatSendButton(currentChatTaskId,false)`,context);
  await nodes.get('chat-send-btn').onclick();
  assert.equal(calls.length,2);
  assert.match(calls[1].url,/\/commands\//);
  assert.equal(calls.some(call=>call.url==='/api/tasks'),false);
  assert.equal(nodes.get('chat-input').value,'结果未知');
});

function mobile() {
  const nodes = new Map(['ta','btn-send','sdk-task-controls','sdk-options','auto-mode','schedule-mode','mobile-queue-mode'].map(id=>[id,new Element()]));
  const calls = [];
  const storage = new Map();
  const context = vm.createContext({
    document:{getElementById:id=>nodes.get(id)||null,createElement:()=>new Element(),createTextNode:text=>Object.assign(new Element(),{textContent:text}),addEventListener(){},documentElement:{clientHeight:800,style:{setProperty(){}}}},
    window:{innerHeight:800,addEventListener(){},scrollTo(){}},
    localStorage:{getItem:()=>null},sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    crypto:require('node:crypto'),console,alert(){},
    fetch:async(url,options)=>{calls.push({url,body:options?.body?JSON.parse(options.body):null});return{ok:true,json:async()=>({status:'accepted'})};},
  });
  vm.runInContext(fs.readFileSync('coderfleet/server/static/js/sdk-task-controls.js','utf8'),context);
  vm.runInContext(fs.readFileSync('coderfleet/server/static/js/chat-history.js','utf8'),context);
  const html = fs.readFileSync('coderfleet/server/static/mobile.html','utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]);
  vm.runInContext(scripts.find(script=>script.includes('let projects  = []')),context,{filename:'mobile.html'});
  vm.runInContext(`activeConv={id:'conv-one'};tasks=[{id:'task-one',conversation_id:'conv-one',status:'running',execution_backend:'sdk',sdk_control_ready:true}];`,context);
  return {context,nodes,calls};
}

for (const surface of ['desktop','mobile']) {
  test(`${surface} only consumes a cached live-message draft after an accepted receipt, even after switching chat`, async () => {
    for (const accepted of [false,true]) {
      const {context,nodes,selectConversation} = surface === 'desktop' ? desktop() : mobile();
      let receipt;
      context.fetch = (url,options) => options?.method === 'POST'
        ? new Promise(resolve => { receipt = () => resolve({ok:accepted,status:503,json:async()=>accepted?{status:'accepted'}:{detail:'unconfirmed'}}); })
        : Promise.resolve({ok:true,json:async()=>[]});
      const input = nodes.get(surface === 'desktop' ? 'chat-input' : 'ta');
      input.value='live draft';
      context.renderImagePreviews = () => {};
      let open;
      if (surface === 'desktop') {
        Object.assign(context,{upsertConversationTab:id=>id,renderTopbarTabs(){},rerenderChatProjectList(){},renderChatWorkspace:async()=>{},syncBottomTerminalProjectFromContext(){}});
        vm.runInContext("chatConversationsList=[{id:'conv-one'},{id:'conv-two'}]",context);
        open = selectConversation;
      } else {
        for (const id of ['chat-ttl','chat-sub']) nodes.set(id,new Element());
        context.showChat = () => {};
        context.syncMessages = () => {};
        vm.runInContext("convs=[{id:'conv-one'},{id:'conv-two'}]",context);
        open = context.openConv;
      }
      const send = surface === 'desktop' ? context.sendChatMessage() : context.send();
      await new Promise(setImmediate);
      await open('conv-two');
      input.value='other chat draft';
      receipt();
      await send;
      assert.equal(input.value,'other chat draft');
      await open('conv-one');
      assert.equal(input.value,accepted?'':'live draft');
    }
  });
}

test('mobile primary button sends live text, then becomes the native interrupt button', async () => {
  const {context,nodes,calls} = mobile();
  nodes.get('ta').value = '手机补充';
  vm.runInContext('updateSendState()',context);
  await nodes.get('btn-send').onclick();
  assert.equal(calls[0].url,'/api/tasks/task-one/messages');
  assert.equal(nodes.get('ta').value,'');
  await nodes.get('btn-send').onclick();
  assert.equal(calls[1].url,'/api/tasks/task-one/interrupt');
});

test('the primary desktop send button delivers text to the running SDK Task', async () => {
  const {context,nodes,calls} = desktop();
  nodes.get('chat-input').value = '主按钮补充';
  vm.runInContext('_syncChatSendButton(currentChatTaskId,true)',context);
  assert.equal(nodes.get('chat-send-btn').disabled,false,'Live input is independent of the queued Task cap');
  await nodes.get('chat-send-btn').onclick();
  assert.deepEqual(calls.map(call=>call.url),['/api/tasks/task-one/messages']);
  assert.equal(nodes.get('chat-input').value,'');
});

test('the empty desktop send button requests native interrupt without force-killing', async () => {
  const {context,nodes,calls} = desktop();
  vm.runInContext('_syncChatSendButton(currentChatTaskId,false)',context);
  await nodes.get('chat-send-btn').onclick();
  assert.deepEqual(calls.map(call=>call.url),['/api/tasks/task-one/interrupt']);
});

test('queue preference does not hide interrupt when the draft is empty', async () => {
  const {context,nodes,calls} = desktop();
  nodes.get('chat-queue-mode').checked = true;
  vm.runInContext('_syncChatSendButton(currentChatTaskId,false)',context);
  assert.equal(nodes.get('chat-send-btn').disabled,false);
  await nodes.get('chat-send-btn').onclick();
  assert.equal(calls[0].url,'/api/tasks/task-one/interrupt');
});

test('mobile SDK initialization and uploads retain text without sending', async () => {
  for (const setup of ['uploadingImages=1','tasks[0].sdk_control_ready=false']) {
    const {context,nodes,calls} = mobile();
    nodes.get('ta').value='手机草稿';
    vm.runInContext(setup+';updateSendState()',context);
    assert.equal(nodes.get('btn-send').disabled,true);
    await vm.runInContext('send()',context);
    assert.equal(calls.length,0);
    assert.equal(nodes.get('ta').value,'手机草稿');
  }
});

test('mobile explicit queue creates a Task and resets the per-message queue choice', async () => {
  const {context,nodes,calls} = mobile();
  context.fetch = async (url,options) => {
    calls.push({url,body:JSON.parse(options.body)});
    return {ok:true,json:async()=>({id:'next-task',conversation_id:'conv-one',status:'pending'})};
  };
  vm.runInContext('syncMessages=()=>{}',context);
  nodes.get('ta').value='手机下一轮';
  nodes.get('mobile-queue-mode').checked=true;
  vm.runInContext('updateSendState()',context);
  await nodes.get('btn-send').onclick();
  assert.equal(calls[0].url,'/api/tasks');
  assert.equal(nodes.get('ta').value,'');
  assert.equal(nodes.get('mobile-queue-mode').checked,false);
});

test('mobile keyboard send uses the same live-message dispatcher', async () => {
  const {context,nodes,calls} = mobile();
  nodes.get('ta').value='键盘补充';
  vm.runInContext('onKey({key:"Enter",shiftKey:false,preventDefault(){}})',context);
  await new Promise(setImmediate);
  assert.equal(calls[0].url,'/api/tasks/task-one/messages');
  assert.equal(nodes.get('ta').value,'');
});

test('typing enables the primary button when no Task is running', () => {
  const {context,nodes} = desktop();
  vm.runInContext(`currentChatTaskId=null;tasksCache[0].status='done';_syncChatSendButton(null,false);bindChatTextareaEvents(document.getElementById('chat-input'))`,context);
  assert.equal(nodes.get('chat-send-btn').disabled,true);
  nodes.get('chat-input').value='新的任务';
  nodes.get('chat-input').listeners.input[0]();
  assert.equal(nodes.get('chat-send-btn').disabled,false);
});


test('desktop heartbeat updates connecting to interrupt while logs are streaming, without reloading the workspace', async () => {
  const {context,nodes,loadConversations} = desktop();
  vm.runInContext('tasksCache[0].sdk_control_ready=false;chatFollowMode=true;_syncChatSendButton(currentChatTaskId,false)',context);
  assert.equal(nodes.get('chat-send-btn').dataset.action,'connecting');
  nodes.get('chat-input').value='';
  const timers=[];
  context.window={addEventListener(){}};
  context.setInterval=(callback,delay)=>timers.push({callback,delay});
  const initializers=['updateThemeIcon','initSidebarState','initChatSidebarState','initTopbarTabs','initBottomTerminalDrawer','initChatSortBtn','checkHealth','refreshGlobalCaches','loadAccountOptions','resizeBottomTerminal','disconnectAllBottomTerminals'];
  for (const name of initializers) context[name]=()=>{};
  context.getApiKey=()=>true;
  vm.runInContext(fs.readFileSync('coderfleet/server/static/js/app.js','utf8'),context,{filename:'app.js'});
  context.loadConversations=loadConversations;
  for (const name of ['updateTaskExecutionMetadata','syncConversationTabLabels','renderTopbarTabs','renderConversations']) context[name]=()=>{};
  let workspaceReloads=0;
  context.selectConversation=async()=>{workspaceReloads++;};
  context.fetch=async url=>({ok:true,json:async()=> {
    if (url==='/api/tasks/heartbeat') return [{id:'task-one',conversation_id:'conv-one',status:'running',sdk_control_ready:true}];
    if (url==='/api/tasks?limit=1000') return [{id:'task-one',conversation_id:'conv-one',status:'running',execution_backend:'sdk',sdk_control_ready:true}];
    return [];
  }});
  const poll=context.pollChatHeartbeat;
  let heartbeatWork;
  context.pollChatHeartbeat=()=>{heartbeatWork=poll();return heartbeatWork;};
  timers.find(timer=>timer.delay===5000).callback();
  assert.ok(heartbeatWork,'The active log stream must not suppress task state polling');
  await heartbeatWork;
  await new Promise(setImmediate);
  assert.equal(nodes.get('chat-send-btn').dataset.action,'interrupt');
  assert.equal(nodes.get('chat-send-btn').disabled,false);
  assert.equal(workspaceReloads,0,'Readiness updates must retain the existing editor and question forms');
});


test('an unknown delivery cannot be replayed as a queued or scheduled Task after exit', async () => {
  for (const mode of ['chat-queue-mode','chat-schedule-checkbox']) {
    const {context,nodes,calls} = desktop();
    context.fetch=async (url,options)=> {
      calls.push({url,body:options?.body?JSON.parse(options.body):null});
      if (options && url.endsWith('/messages')) throw new Error('response lost');
      return {ok:true,json:async()=>({status:'unconfirmed'})};
    };
    nodes.get('chat-input').value='结果未知';
    vm.runInContext('_syncChatSendButton(currentChatTaskId,false)',context);
    await nodes.get('chat-send-btn').onclick();
    vm.runInContext("tasksCache[0].status='done';currentChatTaskId=null",context);
    nodes.get(mode).checked=true;
    vm.runInContext('_syncChatSendButton(null,false)',context);
    assert.equal(nodes.get('chat-send-btn').dataset.action,'check');
    await nodes.get('chat-send-btn').onclick();
    assert.equal(calls.some(call=>call.url==='/api/tasks'),false);
    assert.match(calls.at(-1).url,/\/commands\//);
    assert.equal(nodes.get('chat-input').value,'结果未知');
  }
});

test('mobile new-chat navigation clears the previous Task action and queue preference', async () => {
  const {context,nodes,calls} = mobile();
  for (const id of ['proj-sheet','chat-ttl','chat-sub','chat-body','chat-empty','v-chat']) nodes.set(id,new Element());
  context.bindMobileChatScroll=()=>{};
  nodes.get('mobile-queue-mode').checked=true;
  vm.runInContext("updateSendState();startNew({name:'Other project'})",context);
  assert.equal(nodes.get('btn-send').dataset.action,'empty');
  assert.equal(nodes.get('btn-send').disabled,true);
  assert.equal(nodes.get('mobile-queue-mode').checked,false);
  await nodes.get('btn-send').onclick();
  assert.deepEqual(calls,[],'A click in a new chat must never interrupt the previous Task');
});

test('a stale desktop Task ID cannot dispatch an action outside the active conversation', async () => {
  const {context,nodes,calls} = desktop();
  vm.runInContext("activeConversationId='other-conversation';_syncChatSendButton(currentChatTaskId,false)",context);
  assert.equal(nodes.get('chat-send-btn').dataset.action,'empty');
  await nodes.get('chat-send-btn').onclick();
  assert.deepEqual(calls,[]);
});


test('pending to running heartbeat starts the workspace once and preserves the editor on readiness-only updates', async () => {
  const {context,nodes,loadConversations} = desktop();
  context.loadConversations=loadConversations;
  for (const name of ['updateTaskExecutionMetadata','syncConversationTabLabels','renderTopbarTabs','renderConversations']) context[name]=()=>{};
  let reloads=0;
  context.selectConversation=async()=>{reloads++;};
  vm.runInContext("tasksCache[0].status='pending';tasksCache[0].sdk_control_ready=false;currentChatTaskId=null",context);
  nodes.get('chat-input').value='草稿保留';
  context.fetch=async url=>({ok:true,json:async()=>url.includes('/api/tasks') ?
    [{id:'task-one',conversation_id:'conv-one',status:'running',execution_backend:'sdk',sdk_control_ready:true}] : []});
  await vm.runInContext('pollChatHeartbeat()',context);
  assert.equal(reloads,1,'A pending Task starting must open its log stream');
  assert.equal(nodes.get('chat-input').value,'草稿保留');
  assert.equal(nodes.get('chat-send-btn').dataset.action,'message');
});

test('switching conversations rejects a captured interrupt while the next workspace is loading', async () => {
  const {context,nodes,calls,selectConversation} = desktop();
  context.selectConversation=selectConversation;
  for (const name of ['upsertConversationTab','renderTopbarTabs','rerenderChatProjectList','renderChatWorkspace','syncBottomTerminalProjectFromContext']) context[name]=()=>{};
  vm.runInContext("chatConversationsList=[{id:'other-conversation'}];_syncChatSendButton(currentChatTaskId,false)",context);
  const staleClick=nodes.get('chat-send-btn').onclick;
  let release;
  context.fetch=async()=>({ok:true,json:async()=>await new Promise(resolve=>{release=resolve;})});
  const selection=vm.runInContext("selectConversation('other-conversation')",context);
  await new Promise(setImmediate);
  await staleClick();
  assert.deepEqual(calls,[],'Navigation must revoke the previous Task capability before the new fetch completes');
  release([]);
  await selection;
});


test('a transient full-list failure cannot erase the heartbeat-confirmed running SDK Task', async () => {
  const {context,nodes,loadConversations} = desktop();
  context.loadConversations=loadConversations;
  for (const name of ['updateTaskExecutionMetadata','syncConversationTabLabels','renderTopbarTabs','renderConversations']) context[name]=()=>{};
  nodes.set('chat-history-list',new Element());
  vm.runInContext('tasksCache[0].sdk_control_ready=false;_syncChatSendButton(currentChatTaskId,false)',context);
  context.fetch=async url=>{
    if(url==='/api/tasks?limit=1000') throw new Error('temporary connection loss');
    return {ok:true,json:async()=>url==='/api/tasks/heartbeat' ?
      [{id:'task-one',conversation_id:'conv-one',status:'running',sdk_control_ready:true}] : []};
  };
  await vm.runInContext('pollChatHeartbeat()',context);
  assert.equal(nodes.get('chat-send-btn').dataset.action,'interrupt');
  nodes.get('chat-input').value='仍然补充给当前任务';
  vm.runInContext('_syncChatSendButton(currentChatTaskId,false)',context);
  assert.equal(nodes.get('chat-send-btn').dataset.action,'message');
});


test('a delayed startup heartbeat cannot rebuild a different conversation after navigation', async () => {
  const {context,loadConversations}=desktop();
  context.loadConversations=loadConversations;
  for(const name of ['updateTaskExecutionMetadata','syncConversationTabLabels','renderTopbarTabs','renderConversations']) context[name]=()=>{};
  vm.runInContext("tasksCache[0].status='pending';currentChatTaskId=null",context);
  const reloads=[];
  context.selectConversation=async id=>reloads.push(id);
  let release;
  context.fetch=async url=>({ok:true,json:async()=>{
    if(url==='/api/tasks/heartbeat') return [{id:'task-one',conversation_id:'conv-one',status:'running',sdk_control_ready:true}];
    if(url==='/api/tasks?limit=1000') return await new Promise(resolve=>{release=resolve;});
    return [];
  }});
  const polling=vm.runInContext('pollChatHeartbeat()',context);
  await new Promise(setImmediate);
  vm.runInContext("activeConversationId='other-conversation';currentChatTaskId=null",context);
  release([{id:'task-one',conversation_id:'conv-one',status:'running',execution_backend:'sdk',sdk_control_ready:true}]);
  await polling;
  assert.deepEqual(reloads,[],'A startup refresh belongs only to the conversation that observed it');
});


function workspaceHarness() {
  const result=desktop();
  const {context,nodes,selectConversation}=result;
  for(const id of ['chat-workspace','chat-content','chat-status-text']) nodes.set(id,new Element());
  context.ChatLogRenderer=class {};
  context.fmtTime=()=>'';
  context.getChatAccount=async()=>null;
  for(const name of ['buildChatUsagePillHtml','_gitBranchBadgeForConversation','restoreFilePanelIfOpen',
    'bindChatTextareaEvents','renderQueuePanel','upsertConversationTab','renderTopbarTabs',
    'rerenderChatProjectList','syncBottomTerminalProjectFromContext']) context[name]=()=>'';
  context.selectConversation=selectConversation;
  context.fetch=async()=>({ok:true,json:async()=>[]});
  vm.runInContext("tasksCache=[];pendingImages=[{container_path:'/workspace/next-draft.png'}]",context);
  return result;
}

test('same-conversation startup and finish refreshes preserve visible draft attachments',async()=>{
  const {context}=workspaceHarness();
  let previewRefreshes=0;
  context.renderImagePreviews=()=>{previewRefreshes++;};
  await vm.runInContext("renderChatWorkspace({id:'conv-one',project_name:'project'})",context);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(pendingImages)',context)),
    [{container_path:'/workspace/next-draft.png'}]);
  assert.equal(previewRefreshes,1,'Retained attachments must also remain visible in the new editor');
});

test('explicit navigation clears draft attachments from the previous conversation',async()=>{
  const {context}=workspaceHarness();
  vm.runInContext("chatConversationsList=[{id:'other-conversation',project_name:'other-project'}]",context);
  await vm.runInContext("selectConversation('other-conversation')",context);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(pendingImages)',context)),[]);
});

for (const [name,make,refresh] of [['desktop',desktop,'_syncChatSendButton(currentChatTaskId,false)'],['mobile',mobile,'updateSendState()']]) {
  test(`${name} more menu includes completed own tasks and excludes other conversations`,()=>{
    const {context,nodes}=make();
    vm.runInContext(`${name==='desktop'?'tasksCache':'tasks'}.push(
      {id:'older-task',conversation_id:'conv-one',status:'done',execution_backend:'sdk'},
      {id:'foreign-task',conversation_id:'another-conversation',status:'running',execution_backend:'sdk'});${refresh}`,context);
    const host=nodes.get('sdk-options');
    assert.equal(host.children.length,1);
    assert.deepEqual([...host._sdkOptionTasks.keys()].sort(),['older-task','task-one']);
    vm.runInContext(name==='desktop' ? "activeConversationId='another-conversation';currentChatTaskId=null" : "activeConv={id:'another-conversation'}",context);
    vm.runInContext(refresh,context);
    assert.deepEqual([...host._sdkOptionTasks.keys()],['foreign-task']);
    assert.equal(host.children[0].open || false,false,'Navigation closes old controls');
  });
}
