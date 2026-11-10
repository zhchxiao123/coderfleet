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
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
}

function desktop() {
  const nodes = new Map(['chat-input','chat-send-btn','sdk-task-controls','chat-schedule-checkbox','chat-queue-mode'].map(id=>[id,new Element()]));
  const calls = [];
  const storage = new Map();
  const context = vm.createContext({
    document:{getElementById:id=>nodes.get(id)||null,createElement:()=>new Element(),addEventListener(){}},
    localStorage:{getItem:()=>null},sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    crypto:require('node:crypto'),Event:class {}, API:'',console,setTimeout,clearTimeout,alert(){},confirmDialog:async()=>false,
    fetch:async(url,options)=>{calls.push({url,body:options?.body?JSON.parse(options.body):null});return{ok:true,json:async()=>url==='/api/tasks'?{id:'queued-task',status:'pending',type:'claude'}:{status:'accepted'}};},
  });
  for (const file of ['state.js','sdk-task-controls.js','chat.js']) vm.runInContext(fs.readFileSync('coderfleet/server/static/js/'+file,'utf8'),context,{filename:file});
  vm.runInContext(`activeConversationId='conv-one';currentChatTaskId='task-one';tasksCache=[{id:'task-one',conversation_id:'conv-one',status:'running',execution_backend:'sdk',sdk_control_ready:true}];`,context);
  vm.runInContext(`selectConversation=async()=>{};loadConversations=()=>{};loadTasks=()=>{};loadProjectsDashboard=()=>{};renderImagePreviews=()=>{};`,context);
  return {context,nodes,calls};
}

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
  const nodes = new Map(['ta','btn-send','sdk-task-controls','auto-mode','schedule-mode','mobile-queue-mode'].map(id=>[id,new Element()]));
  const calls = [];
  const storage = new Map();
  const context = vm.createContext({
    document:{getElementById:id=>nodes.get(id)||null,createElement:()=>new Element(),documentElement:{clientHeight:800,style:{setProperty(){}}}},
    window:{innerHeight:800,addEventListener(){},scrollTo(){}},
    localStorage:{getItem:()=>null},sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    crypto:require('node:crypto'),console,alert(){},
    fetch:async(url,options)=>{calls.push({url,body:options?.body?JSON.parse(options.body):null});return{ok:true,json:async()=>({status:'accepted'})};},
  });
  vm.runInContext(fs.readFileSync('coderfleet/server/static/js/sdk-task-controls.js','utf8'),context);
  const html = fs.readFileSync('coderfleet/server/static/mobile.html','utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]);
  vm.runInContext(scripts.find(script=>script.includes('let projects  = []')),context,{filename:'mobile.html'});
  vm.runInContext(`activeConv={id:'conv-one'};tasks=[{id:'task-one',conversation_id:'conv-one',status:'running',execution_backend:'sdk',sdk_control_ready:true}];`,context);
  return {context,nodes,calls};
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
