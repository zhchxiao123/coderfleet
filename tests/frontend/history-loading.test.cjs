const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const staticDir = path.resolve(__dirname, '../../coderfleet/server/static');
const finishedLog = '======\nfinished: done\n';
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise,resolve};
}

class Element {
  constructor(){this.children=[];this.dataset={};this.style={};this.scrollTop=0;this.listeners={};this.className='';this.hidden=false;this.classList={add:name=>{this.className+=' '+name;}};}
  appendChild(el){return this.insertBefore(el,null);}
  insertBefore(el,next){el.remove?.();const index=this.children.indexOf(next);if(index<0)this.children.push(el);else this.children.splice(index,0,el);el.parentNode=this;return el;}
  replaceChildren(){for(const child of [...this.children])child.remove();}
  replaceWith(el){this.parentNode.insertBefore(el,this);this.remove();}
  remove(){if(this.parentNode){const siblings=this.parentNode.children;siblings.splice(siblings.indexOf(this),1);this.parentNode=null;}}
  get isConnected(){return !!this.parentNode;}
  get height(){return this.className.includes('history-turn')?100:0;}
  get scrollHeight(){return this.children.reduce((sum,child)=>sum+child.height,0);}
  querySelectorAll(selector){return this.children.flatMap(el=>[...(el.className?.split(' ').includes(selector.slice(1))?[el]:[]),...(el.querySelectorAll?.(selector)||[])]);}
  addEventListener(name,listener){(this.listeners[name] ||= []).push(listener);}
  setAttribute(name,value){this[name]=value;}
  removeAttribute(name){delete this[name];}
  scrollIntoView(){this.scrolled=true;}
  getBoundingClientRect(){
    if(!this.parentNode)return {top:0,bottom:600};
    const siblings=this.parentNode.children;
    const top=siblings.slice(0,siblings.indexOf(this)).reduce((sum,node)=>sum+node.height,0)-this.parentNode.scrollTop;
    return {top,bottom:top+this.height};
  }
}

function historyView(loadTurn,extra={}) {
  const context=vm.createContext({console,AbortController,document:{createElement:()=>new Element()}});
  vm.runInContext(fs.readFileSync(path.join(staticDir,'js/chat-history.js'),'utf8'),context);
  const View=vm.runInContext('ChatHistoryView',context);
  const container=new Element();
  const view=new View({container,viewport:container,loadTurn,...extra});
  return {view,container,context};
}
function historyTasks(count) {
  return Array.from({length:count},(_,i)=>({id:'task-'+i,status:'done',conversation_id:'chat',created:new Date(1700000000000+i*1000).toISOString()}));
}
function mobileNavigation(api) {
  const nodes=new Map(['ta','chat-ttl','chat-sub'].map(id=>[id,Object.assign(new Element(),{value:''})]));
  const alerts=[];
  const context=vm.createContext({console,alert:message=>alerts.push(message),
    document:{getElementById:id=>nodes.get(id)||null,documentElement:{clientHeight:844,style:{setProperty(){}}}},
    window:{innerHeight:844,addEventListener(){}},localStorage:{getItem:()=>''},sessionStorage:{getItem:()=>''},
    fetch:async()=>({ok:true,json:async()=>[]}),
  });
  vm.runInContext(fs.readFileSync(path.join(staticDir,'js/chat-history.js'),'utf8'),context);
  const scripts=[...fs.readFileSync(path.join(staticDir,'mobile.html'),'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)];
  vm.runInContext(scripts.find(match=>match[1].includes('let projects  = []'))[1],context);
  Object.assign(context,{api,renderImagePreviews(){},showChat(){},syncMessages(){},updateSendState(){}});
  return {context,nodes,alerts};
}

function desktop(fetchImpl) {
  const context = vm.createContext({console,Headers,TextEncoder,AbortController,DOMException,setTimeout,clearTimeout,
    document:{addEventListener(){}},window:{fetch:fetchImpl},fetch:fetchImpl,
    localStorage:{getItem:()=>''},
  });
  for (const name of ['utils.js','log-cache.js','chat-history.js','chat.js']) vm.runInContext(fs.readFileSync(path.join(staticDir,'js',name),'utf8'),context);
  Object.assign(context,{logCacheGet:async()=>null,logCacheSet(){},logCacheDelete:async()=>{}});
  return context;
}

test('concurrent readers share one completed-log request', async () => {
  const gate = deferred();
  let requests = 0;
  const context = desktop(async()=>{requests++;await gate.promise;return {ok:true,text:async()=>finishedLog};});
  const task = {id:'same-task',status:'done'};
  const reads = Array.from({length:4},()=>context._fetchTaskLogCached(task));
  await new Promise(setImmediate);
  gate.resolve();
  await Promise.all(reads);
  assert.equal(requests,1);
});

test('a failed history request is reported and can be retried', async () => {
  let requests = 0;
  const context = desktop(async()=>++requests===1
    ? {ok:false,status:503,text:async()=>'upstream unavailable'}
    : {ok:true,text:async()=>finishedLog});
  const task = {id:'retry-task',status:'done'};
  await assert.rejects(context._fetchTaskLogCached(task),/503/);
  assert.equal(await context._fetchTaskLogCached(task),finishedLog);
});

test('opening a 1000-turn mobile conversation only mounts and requests the recent window', () => {
  const body = new Element();
  const nodes = new Map([['chat-body',body],['chat-empty',{style:{}}],['chat-top-spacer',{style:{}}]]);
  const context = vm.createContext({console,Headers,TextEncoder,AbortController,
    document:{createElement:()=>new Element(),getElementById:id=>nodes.get(id)||null,addEventListener(){},
      documentElement:{clientHeight:844,style:{setProperty(){}}}},
    window:{addEventListener(){},innerHeight:844},localStorage:{getItem:()=>''},sessionStorage:{getItem:()=>''},
  });
  vm.runInContext(fs.readFileSync(path.join(staticDir,'js/chat-history.js'),'utf8'),context);
  const scripts = [...fs.readFileSync(path.join(staticDir,'mobile.html'),'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)];
  vm.runInContext(scripts.find(match=>match[1].includes('let projects  = []'))[1],context);
  const requested = [];
  Object.assign(context,{updateSendState(){},_mobileUpdateScrollBtn(){},
    loadAiContent:task=>requested.push(task.id),makeMsgPair:task=>({id:`mp-${task.id}`,className:'msg-pair',dataset:{status:task.status}}),
  });
  vm.runInContext(`activeConv={id:'long-chat'};tasks=Array.from({length:1000},(_,i)=>({id:'task-'+i,conversation_id:'long-chat',status:'done',created:new Date(1700000000000+i*1000).toISOString()}));`,context);
  const start = performance.now();
  context.syncMessages(true);
  const pairs = body.querySelectorAll('.msg-pair');
  console.log(JSON.stringify({scenario:'mobile-1000-turn-open',mounted:pairs.length,requests:requested.length,elapsedMs:Math.round(performance.now()-start)}));
  assert.ok(pairs.length<=3,`mounted ${pairs.length} complete turns`);
  assert.ok(requested.length<=3,`requested ${requested.length} logs`);
  assert.ok(requested.includes('task-999'),'the latest reply must be in the first window');
});

test('latest replies render independently of a slow earlier log', async()=> {
  const old=deferred();
  const started=[],rendered=[];
  const {view}=historyView(async(task,_host,scope)=>{
    started.push(task.id);
    if(task.id==='task-7')await old.promise;
    scope.mutate(()=>rendered.push(task.id));
  });
  view.update(historyTasks(10));
  await new Promise(setImmediate);
  assert.deepEqual(started,['task-9','task-8','task-7']);
  assert.deepEqual(rendered,['task-9','task-8']);
  old.resolve();
  await new Promise(setImmediate);
  assert.equal(rendered.length,3);
});

test('older pages add eight turns while preserving the visible scroll anchor',async()=> {
  const {view,container}=historyView(async()=>{});
  view.update(historyTasks(30));
  const latest=view.rows.get('task-29').node;
  container.scrollTop=200;
  const before=latest.getBoundingClientRect().top;
  await view.showOlder();
  assert.equal(view.rows.size,11);
  assert.equal(latest.getBoundingClientRect().top,before);
  assert.equal(container.scrollTop,1000);
});

test('index jumps mount a small target window and heartbeat never fills the skipped gap',async()=> {
  const indexContainer=new Element();
  const {view}=historyView(async()=>{},{indexContainer});
  const tasks=historyTasks(1000);
  view.update(tasks);
  const index=indexContainer.children[0];
  assert.ok(index.children.length<=83);
  index.children[0].listeners.click[0]();
  assert.equal(view.rows.size,6);
  assert.equal(view.rows.get('task-0').node.scrolled,true);
  view.update(tasks);
  assert.equal(view.rows.size,6);
});

test('a disposed history cancels readers and late replies cannot change the page',async()=> {
  const gate=deferred(),scopes=[];
  let painted=0;
  const {view,container}=historyView(async(_task,_host,scope)=>{
    scopes.push(scope);await gate.promise;scope.mutate(()=>painted++);
  });
  view.update(historyTasks(10));
  view.dispose();
  assert.ok(scopes.every(scope=>scope.signal.aborted));
  gate.resolve();
  await new Promise(setImmediate);
  assert.equal(painted,0);
  assert.equal(container.children.length,0);
});

test('heartbeat preserves existing rows and only replaces a changed Task lifecycle',async()=> {
  const scopes=[];
  const {view}=historyView(async(task,_host,scope)=>scopes.push({id:task.id,scope}));
  const tasks=historyTasks(4);tasks[3].status='running';
  view.update(tasks);
  const previous=view.rows.get('task-3');
  view.update(tasks.map(task=>({...task})));
  assert.equal(view.rows.get('task-3'),previous);
  assert.equal(scopes.length,3);
  view.update(tasks.map(task=>({...task,status:'done'})));
  assert.notEqual(view.rows.get('task-3'),previous);
  assert.equal(previous.controller.signal.aborted,true);
  assert.equal(scopes.length,4);
});

test('conversation metadata grows past the old 200-task cap and retries do not skip a prefix',async()=> {
  const {context}=historyView(async()=>{});
  const tasks=historyTasks(450).reverse(),urls=[];
  let fail=true;
  const source=context.conversationHistorySource('chat',async url=>{
    urls.push(url);
    const limit=Number(new URL(url,'http://localhost').searchParams.get('limit'));
    if(limit===400&&fail){fail=false;return {ok:false,status:503};}
    return {ok:true,json:async()=>tasks.slice(0,limit)};
  });
  assert.equal((await source.refresh()).tasks.length,200);
  await assert.rejects(source(),/503/);
  assert.equal((await source()).tasks.length,400);
  const last=await source();
  assert.equal(last.tasks.length,450);
  assert.equal(last.hasMore,false);
  assert.deepEqual(urls.map(url=>Number(new URL(url,'http://localhost').searchParams.get('limit'))),[200,400,400,600]);
  const wrong=context.conversationHistorySource('other',async()=>({json:async()=>tasks}));
  await assert.rejects(wrong(),/所属会话/);
});

test('the log scheduler bounds simultaneous network requests to three',async()=> {
  let active=0,peak=0;
  const gates=[];
  const context=desktop(async()=> {
    active++;peak=Math.max(peak,active);
    const gate=deferred();gates.push(gate);await gate.promise;active--;
    return {ok:true,text:async()=>finishedLog};
  });
  const reads=historyTasks(10).map(task=>context._fetchTaskLogCached(task));
  for(let wave=0;wave<4;wave++) {
    await new Promise(setImmediate);
    for(const gate of gates.splice(0))gate.resolve();
  }
  await Promise.all(reads);
  assert.equal(peak,3);
});

test('cancelling one shared reader leaves its other consumer intact',async()=> {
  const gate=deferred();let underlying;
  const context=desktop(async(_url,{signal})=>{underlying=signal;await gate.promise;return {ok:true,text:async()=>finishedLog};});
  const first=new AbortController(),second=new AbortController();
  const task={id:'shared',status:'done'};
  const a=context._fetchTaskLogCached(task,{signal:first.signal});
  const b=context._fetchTaskLogCached(task,{signal:second.signal});
  const rejected=assert.rejects(a,{name:'AbortError'});
  await new Promise(setImmediate);
  first.abort();
  assert.equal(underlying.aborted,false);
  gate.resolve();
  assert.equal(await b,finishedLog);
  await rejected;
});

test('cancelling the last consumer aborts the network and permits a fresh retry',async()=> {
  let requests=0,underlying;
  const context=desktop(async(_url,{signal})=>{
    requests++;underlying=signal;
    if(requests===1)await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError'))));
    return {ok:true,text:async()=>finishedLog};
  });
  const controller=new AbortController();
  const task={id:'cancelled',status:'done'};
  const pending=context._fetchTaskLogCached(task,{signal:controller.signal});
  const rejected=assert.rejects(pending,{name:'AbortError'});
  await new Promise(setImmediate);
  controller.abort();
  assert.equal(underlying.aborted,true);
  await rejected;
  assert.equal(await context._fetchTaskLogCached(task),finishedLog);
  assert.equal(requests,2);
});

test('incomplete persisted logs are discarded and incomplete downloads stay out of cache',async()=> {
  let deleted=0,saved=0,requests=0;
  const context=desktop(async()=>({ok:true,text:async()=>{requests++;return '======\nnot finished';}}));
  context.logCacheGet=async()=> 'truncated legacy log';
  context.logCacheDelete=async()=>{deleted++;};
  context.logCacheSet=()=>{saved++;};
  const task={id:'partial',status:'done'};
  await context._fetchTaskLogCached(task);
  await context._fetchTaskLogCached(task);
  assert.equal(deleted,2);
  assert.equal(requests,2);
  assert.equal(saved,0);
});

test('memory cache respects its byte budget and evicts the least recently read entry',()=> {
  const context=desktop(async()=>{});
  const text='x'.repeat(3*1024*1024);
  context._rememberTaskLog('old',text);
  context._rememberTaskLog('keep',text);
  context._rememberTaskLog('old',text);
  context._rememberTaskLog('new',text);
  assert.deepEqual(Array.from(vm.runInContext('_finishedLogCache.keys()',context)),['old','new']);
});

test('an unavailable IndexedDB cannot indefinitely block a network history read',async()=> {
  const context=desktop(async()=>({ok:true,text:async()=>finishedLog}));
  const timers=[];
  context.window.indexedDB=context.indexedDB={open:()=>({})};
  context.setTimeout=callback=>{timers.push(callback);return timers.length;};
  context.clearTimeout=()=>{};
  // Use the real persistent-cache function, with an open request that never fires.
  vm.runInContext('logCacheGet = '+fs.readFileSync(path.join(staticDir,'js/log-cache.js'),'utf8').match(/async function logCacheGet\(taskId\) \{[\s\S]*?\n\}/)[0],context);
  const pending=context._fetchTaskLogCached({id:'idb-stalled',status:'done'});
  assert.equal(timers.length,1);
  timers[0]();
  assert.equal(await pending,finishedLog);
});

test('a cancelled queued download is never sent after a network slot becomes free',async()=> {
  const gates=[],started=[];
  const context=desktop(async url=> {
    started.push(url);const gate=deferred();gates.push(gate);await gate.promise;
    return {ok:true,text:async()=>finishedLog};
  });
  const reads=historyTasks(3).map(task=>context._fetchTaskLogCached(task));
  await new Promise(setImmediate);
  const controller=new AbortController();
  const queued=context._fetchTaskLogCached({id:'never-download',status:'done'},{signal:controller.signal});
  const rejected=assert.rejects(queued,{name:'AbortError'});
  await new Promise(setImmediate);
  controller.abort();
  for(const gate of gates)gate.resolve();
  await Promise.all(reads);
  await rejected;
  assert.equal(started.length,3);
});

test('failed rows retry independently without rebuilding their neighbouring replies',async()=> {
  let attempts=0;
  const {view}=historyView(async task=>{if(task.id==='task-2'&&attempts++===0)throw new Error('503');});
  view.update(historyTasks(3));
  await new Promise(setImmediate);
  const neighbour=view.rows.get('task-1').node;
  const failed=view.rows.get('task-2').node;
  const error=failed.querySelectorAll('.chat-history-error')[0];
  assert.ok(error);
  error.children[1].listeners.click[0]();
  await new Promise(setImmediate);
  assert.equal(attempts,2);
  assert.equal(view.rows.get('task-1').node,neighbour);
});

test('a late mobile raw-log response cannot start a stream after leaving its conversation',async()=> {
  const gate=deferred();let current=true,streams=0,resets=0;
  const context=vm.createContext({console,TextEncoder,
    ChatLogRenderer:class{_resetSDKRendering(){resets++;}},
    _fetchTaskLogCached:()=>gate.promise,EventSource:class{constructor(){streams++;}},
  });
  const html=fs.readFileSync(path.join(staticDir,'mobile.html'),'utf8');
  const code=html.slice(html.indexOf('async function streamAiContent('),html.indexOf('// ── Send'));
  vm.runInContext('let liveStream=null;\n'+code,context);
  const controller=new AbortController();
  const pending=context.streamAiContent({id:'old-task'},new Element(),{signal:controller.signal,isCurrent:()=>current});
  current=false;controller.abort();gate.resolve('old raw history');
  await pending;
  assert.equal(streams,0);
  assert.equal(resets,1);
});

test('an in-place heartbeat status mutation still replaces the running renderer',()=> {
  const {view}=historyView(async()=>{});
  const tasks=historyTasks(3);tasks[2].status='running';
  view.update(tasks);
  const running=view.rows.get('task-2');
  tasks[2].status='done';
  view.update(tasks);
  assert.notEqual(view.rows.get('task-2'),running);
  assert.equal(running.controller.signal.aborted,true);
});

test('terminal logs still being finalized retry on heartbeats with a bounded automatic budget',async()=> {
  let reads=0;
  const {view}=historyView(async()=>{reads++;return {retryOnUpdate:true};});
  const tasks=historyTasks(1);
  view.update(tasks);
  await new Promise(setImmediate);
  for(let tick=0;tick<6;tick++){
    view.update(tasks);
    await new Promise(setImmediate);
  }
  assert.equal(reads,4);
  assert.equal(view.rows.get('task-0').retryOnUpdate,false);
  assert.equal(view.rows.get('task-0').node.querySelectorAll('.chat-history-error').length,1);
});

test('updating directory previews does not reset an older directory scroll position',async()=> {
  const parent=new Element();
  const {view}=historyView(async()=>{},{indexContainer:parent});
  const index=parent.children[0];
  index.clientHeight=100;
  Object.defineProperty(index,'scrollHeight',{get:()=>index.children.length*8});
  view.update(historyTasks(100));
  await new Promise(setImmediate);
  index.scrollTop=40;
  view.update(historyTasks(101));
  await new Promise(setImmediate);
  assert.equal(index.scrollTop,40);
});

test('queued newer turns never push the active Task outside the mounted window',()=> {
  const started=[];
  const {view}=historyView(async task=>started.push(task.id));
  const tasks=historyTasks(20);
  tasks[16].status='running';
  for(const task of tasks.slice(17))task.status='pending';
  view.update(tasks);
  assert.equal(view.rows.size,4);
  assert.ok(started.includes('task-16'));
});

test('a later recorded Task completion refreshes the legacy timestamp fallback',()=> {
  const {view}=historyView(async()=>{});
  const tasks=historyTasks(1);
  view.update(tasks);
  const original=view.rows.get('task-0');
  tasks[0].finished='2026-11-18T08:00:00Z';
  view.update(tasks);
  assert.notEqual(view.rows.get('task-0'),original);
});

test('mobile search opens an exact conversation before the global list has loaded',async()=> {
  const calls=[];
  const {context,nodes}=mobileNavigation(async url=>{calls.push(url);return {id:'older-chat',name:'Older chat'};});
  await context.openConv('older-chat');
  assert.deepEqual(calls,['/api/conversations/older-chat']);
  assert.equal(nodes.get('chat-ttl').textContent,'Older chat');
  assert.equal(vm.runInContext('activeConv.id',context),'older-chat');
});

test('mobile search retrieves an old Task outside the global recent-task prefix',async()=> {
  const calls=[];
  const {context,nodes}=mobileNavigation(async url=>{calls.push(url);return {id:'older-task',prompt:'Old instruction'};});
  await context.openOneOff('older-task');
  assert.deepEqual(calls,['/api/tasks/older-task']);
  assert.equal(nodes.get('chat-ttl').textContent,'Old instruction');
  assert.equal(vm.runInContext('activeConv.id',context),'task-older-task');
});

test('a late uncached-conversation response cannot replace a newer selection',async()=> {
  const gate=deferred();
  const {context,nodes}=mobileNavigation(()=>gate.promise);
  const older=context.openConv('older-chat');
  vm.runInContext("convs=[{id:'newer-chat',name:'Newer chat'}]",context);
  await context.openConv('newer-chat');
  gate.resolve({id:'older-chat',name:'Older chat'});
  await older;
  assert.equal(vm.runInContext('activeConv.id',context),'newer-chat');
  assert.equal(nodes.get('chat-ttl').textContent,'Newer chat');
});

test('missing mobile history fails explicitly without opening a different Task',async()=> {
  const {context,alerts}=mobileNavigation(async()=>{throw new Error('404 not found');});
  vm.runInContext("tasks=[{id:'unrelated',prompt:'Other task'}]",context);
  await context.openOneOff('deleted-task');
  assert.equal(vm.runInContext('activeConv',context),null);
  assert.match(alerts[0],/404/);
});
