const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

class Element {
  constructor(tagName = '') { this.tagName = tagName; this.dataset = {}; this.children = []; this.hidden = false; this.value = ''; this.listeners = {}; }
  setAttribute(name,value) { this[name] = value; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren() { this.children = []; }
  addEventListener(name,listener) { this.listeners[name] = listener; }
  focus() { this.focused = true; }
  contains(node) { return this === node || this.children.some(child=>child.contains(node)); }
}

function controls(fetch) {
  const storage = new Map();
  const context = vm.createContext({fetch, crypto:require('node:crypto'), document:{createElement:tag=>new Element(tag),createTextNode:text=>Object.assign(new Element(),{textContent:text}),addEventListener(){}},
    localStorage:{getItem:()=>null,setItem(){}},
    sessionStorage:{get length(){return storage.size;},key:index=>[...storage.keys()][index],getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}});
  vm.runInContext(fs.readFileSync('coderfleet/server/static/js/sdk-task-controls.js','utf8'), context);
  return vm.runInContext('SDKTaskControls', context);
}

test('advanced options have one closed entry and keep current versus next-task settings separate',()=>{
  const ui=controls(async()=>{throw new Error('A closed menu must not fetch capabilities');});
  const host=new Element();
  const tasks=[{id:'task-one',status:'running',execution_backend:'sdk',sdk_control_ready:true,sdk_capabilities:['control']},
    {id:'older-task',status:'done',execution_backend:'sdk'}];
  ui.mountOptions(host,'conversation',tasks);
  assert.equal(host.children.length,1);
  const menu=host.children[0];
  assert.equal(menu.open || false,false);
  assert.equal(menu.children[0].textContent,'更多');
  assert.equal(host._sdkTaskPanels.children.filter(node=>node.tagName==='details').length,2);
  assert.equal(host._sdkTaskSelect.value,'task-one');
  host._sdkOptions.value='{"max_turns":5}';
  menu.open=true;
  ui.mountOptions(host,'conversation',tasks);
  assert.equal(host.children[0],menu,'Heartbeats must preserve the open menu and edits');
  assert.equal(host._sdkOptions.value,'{"max_turns":5}');
  const next={...tasks[0],id:'next-task'};
  tasks[0].status='done';tasks.push(next);
  ui.mountOptions(host,'conversation',tasks);
  assert.equal(host._sdkTaskSelect.value,'next-task','The default context follows the new running Task');
  host._sdkTaskSelect.value='older-task';host._sdkTaskSelect.listeners.change();
  assert.equal(host._sdkTaskPanels.children.filter(node=>node.tagName==='details').length,1,'Finished tasks expose records, not live controls');
  ui.mountOptions(host,'conversation',tasks);
  assert.equal(host._sdkTaskSelect.value,'older-task','An explicit history selection survives heartbeats');
  menu.listeners.keydown({key:'Escape',stopPropagation(){}});
  assert.equal(menu.open,false);
  assert.equal(menu.children[0].focused,true);
  ui.mountOptions(host,'another-conversation',[]);
  assert.notEqual(host.children[0],menu);
  assert.equal(host._sdkTaskPanels.children.length,0,'Navigation revokes the old Task panels');
});

test('a ready SDK task does not add advanced buttons above the composer',()=>{
  const ui=controls(async()=>{}),host=new Element();
  ui.mount(host,{id:'task-one',status:'running',execution_backend:'sdk',sdk_control_ready:true,sdk_capabilities:['control']},{clear(){}});
  assert.equal(host.hidden,true,'Only delivery feedback should occupy the inline control area');
  assert.equal(host.children.some(node=>node.tagName==='details'),false);
});

test('unknown delivery retains the original request ID across retries', async () => {
  const sent = [];
  const ui = controls(async (_url, options) => {
    sent.push(JSON.parse(options.body));
    if (sent.length === 1) throw new Error('connection closed');
    return {ok:true,json:async()=>({status:'accepted'})};
  });
  await assert.rejects(ui.execute('task-one','message','keep this draft'));
  await assert.rejects(ui.execute('task-one','message','different draft'), /尚未确认/);
  assert.equal(sent.length,1);
  await ui.execute('task-one','message','keep this draft');
  assert.equal(sent[0].request_id,sent[1].request_id);
  assert.equal(ui.pending('task-one','message'),null);
});

test('receipt queries confirm delivery without sending the message again', async () => {
  let calls = 0;
  const ui = controls(async (url, options) => {
    calls++;
    if (options) throw new Error('response lost');
    assert.match(url,/\/commands\//);
    return {ok:true,json:async()=>({status:'accepted'})};
  });
  await assert.rejects(ui.execute('task-one','message','draft'));
  const result = await ui.check('task-one','message');
  assert.equal(result.status,'accepted');
  assert.equal(result.text,'draft');
  assert.equal(calls,2);
});

test('composer actions reveal receipt checks only while delivery is unconfirmed', async () => {
  let attempts = 0;
  let text = 'supplement';
  const ui = controls(async () => {
    if (++attempts === 1) throw new Error('connection lost');
    return {ok:true,json:async()=>({status:'accepted'})};
  });
  const host = new Element();
  const task = {id:'task-one',status:'running',execution_backend:'sdk',sdk_control_ready:true};
  const editor = {
    read:()=>({text,hasAttachments:false}), clear:value=>{ if (text === value) text=''; },
  };
  ui.mount(host, task, editor);
  const [receipt, status] = host.children;
  assert.equal(receipt.hidden,true);
  await ui.perform(host, task, 'message', editor);
  assert.equal(receipt.hidden,false);
  assert.equal(text,'supplement');
  assert.equal(status.dataset.state,'error');
  await ui.perform(host, task, 'message', editor);
  assert.equal(receipt.hidden,true);
  assert.equal(text,'');
  assert.match(status.textContent,/已送达当前任务/);
});

test('runtime controls preserve uncertain input and query receipts without replay',async()=>{
  let calls=0; const requests=[];
  const ui=controls(async(url,options)=>{
    if(!options) return {ok:true,json:async()=>({status:'accepted'})};
    requests.push(JSON.parse(options.body));
    assert.match(url,/sdk-control$/);
    if(++calls===1) throw new Error('response lost');
    return {ok:true,json:async()=>({status:'accepted',result:{value:{totalTokens:42}}})};
  });
  await assert.rejects(ui.executeControl('one','set_model',{model:'sonnet'}));
  await assert.rejects(ui.executeControl('one','set_model',{model:'opus'}),/尚未确认/);
  await ui.executeControl('one','set_model',{model:'sonnet'});
  assert.equal(requests[0].request_id,requests[1].request_id);
  assert.equal(ui.pending('one','control-set_model'),null);
});

test('native attachments are opt-in and old workers retain queue behavior',()=>{
  const ui=controls();
  const task={id:'one',status:'running',execution_backend:'sdk',sdk_control_ready:true};
  const draft={text:'',hasAttachments:true,nativeAttachments:true,images:['/workspace/.coderfleet-uploads/one.png']};
  assert.equal(ui.primaryAction(task,draft),'queue');
  task.sdk_capabilities=['multimodal_input'];
  assert.equal(ui.primaryAction(task,draft),'message');
  assert.equal(ui.primaryAction(task,{...draft,nativeAttachments:false}),'queue');
});

test('attachment delivery retries preserve exact filenames and do not resend changed input',async()=>{
  const requests=[]; const ui=controls(async(_url,options)=>{
    requests.push(JSON.parse(options.body));
    if(requests.length===1) throw new Error('response lost');
    return {ok:true,json:async()=>({status:'accepted'})};
  });
  const images=['/workspace/.coderfleet-uploads/one.png'];
  await assert.rejects(ui.execute('one','message','',images));
  await assert.rejects(ui.execute('one','message','',[]),/尚未确认/);
  await ui.execute('one','message','',images);
  assert.deepEqual(requests[0],requests[1]);
});


test('unknown runtime settings do not block a new message after the old Task ends',async()=>{
  const ui=controls(async()=>{throw new Error('response lost');});
  await assert.rejects(ui.executeControl('one','set_model',{model:'sonnet'}));
  const task={id:'one',status:'done',execution_backend:'sdk',sdk_control_ready:false};
  assert.equal(ui.hasPending('one'),true);
  assert.equal(ui.hasPendingDelivery('one'),false);
  assert.equal(ui.primaryAction(task,{text:'next instruction',hasAttachments:false}),'queue');
});
