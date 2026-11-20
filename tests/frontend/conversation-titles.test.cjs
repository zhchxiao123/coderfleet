const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

function client(fetch = async()=>({ok:true,json:async()=>[]})) {
  const nodes = [];
  const context = {fetch,AbortController,setTimeout,clearTimeout,document:{querySelectorAll:()=>nodes}};
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('coderfleet/server/static/js/conversation-titles.js','utf8'),context);
  return {ui:context.FleetTitles,nodes};
}

test('late automatic title metadata cannot replace a newer manual name',()=>{
  const {ui} = client();
  const convs = [{id:'a',name:'人工名称',title:{source:'manual',revision:8,status:'ready'}}];
  assert.equal(ui.merge(convs,[{id:'a',name:'旧自动名称',title:{source:'auto',revision:6}}]),false);
  assert.equal(convs[0].name,'人工名称');
});

test('a title update paints only matching title spans while preserving the running chat',()=>{
  const {ui,nodes} = client();
  const header={title:'旧名称'};
  const first={dataset:{conversationTitleId:'a'},textContent:'旧名称',closest:()=>header};
  const other={dataset:{conversationTitleId:'b'},textContent:'其他会话'};
  nodes.push(first,other);
  ui.paint([{id:'a',name:'历史加载滚动修复',title:{source:'auto',status:'ready'}}]);
  assert.equal(first.textContent,'历史加载滚动修复');
  assert.equal(header.title,'历史加载滚动修复');
  assert.equal(other.textContent,'其他会话');
  assert.match(first.title,/自动命名/);
});

test('regeneration binds the exact selected conversation and known title revision',async()=>{
  let request;
  const {ui} = client(async(url,options)=>{request={url,options};return {ok:true,json:async()=>({id:'a'})};});
  await ui.regenerate({id:'a',name:'人工名称',title:{revision:8}});
  assert.equal(request.url,'/api/conversations/a/title');
  assert.deepEqual(JSON.parse(request.options.body),{expected_revision:8,expected_name:'人工名称'});
});

test('title polling stays bounded and prioritizes the open conversation',async()=>{
  let url;
  const {ui}=client(async value=>{url=value;return {ok:true,json:async()=>[]};});
  const convs=Array.from({length:100},(_,i)=>({id:'c'+i,title:{status:'pending'}}));
  await ui.refresh(convs,['active']);
  const ids=new URL(url,'http://test').searchParams.getAll('ids');
  assert.equal(ids.length,50);
  assert.equal(ids[0],'active');
});

test('a failed title read retains cached names and a failed regeneration is explicit',async()=>{
  const {ui}=client(async()=>({ok:false,json:async()=>({detail:'会话标题已改变'})}));
  const conv={id:'a',name:'保留原名'};
  await assert.rejects(ui.refresh([conv]),/加载失败/);
  await assert.rejects(ui.regenerate(conv),/已改变/);
  assert.equal(conv.name,'保留原名');
});

function desktopRename(fetch) {
  const inputs=[],alerts=[];
  const context={API:'',AbortController,setTimeout,clearTimeout,fetch,alert:message=>alerts.push(message),
    CSS:{escape:value=>value},document:{createElement(){
      const input={listeners:{},value:'',addEventListener(name,fn){this.listeners[name]=fn;},
        removeEventListener(name){delete this.listeners[name];},focus(){},select(){}};
      inputs.push(input);return input;
    }},chatConversationsList:[{id:'a',name:'旧名',title:{revision:0}}],conversationsCache:{a:'旧名'},
    syncChatConversationTitles(){},rerenderChatProjectList(){}};
  context.window=context;vm.createContext(context);
  vm.runInContext(fs.readFileSync('coderfleet/server/static/js/conversation-titles.js','utf8'),context);
  const source=fs.readFileSync('coderfleet/server/static/js/chat.js','utf8');
  vm.runInContext('let _isRenamingConversation=false;\n'+source.slice(source.indexOf('async function inlineRenameConversation'),source.indexOf('const CHAT_SORT_CYCLE')),context);
  const item={querySelector:()=>({textContent:'旧名',replaceWith(){}})};
  return {context,inputs,alerts,item};
}

test('the actual desktop rename handler ignores an older successful response after a newer server title',async()=>{
  let release;
  const {context,inputs,item}=desktopRename(async()=>({ok:true,json:()=>new Promise(resolve=>{
    release=()=>resolve({id:'a',name:'较早的人工名',title:{source:'manual',revision:1}});
  })}));
  await context.inlineRenameConversation('a',item);
  assert.equal(inputs[0].maxLength,200);
  inputs[0].value='较早的人工名';
  inputs[0].listeners.keydown({key:'Enter',preventDefault(){}});
  await new Promise(setImmediate);
  context.FleetTitles.merge(context.chatConversationsList,[{id:'a',name:'另一端的新名称',title:{source:'manual',revision:2}}]);
  release();await new Promise(setImmediate);
  assert.equal(context.chatConversationsList[0].name,'另一端的新名称');
  assert.equal(context.conversationsCache.a,'另一端的新名称');
});

test('desktop rename errors retain the editable draft and explain the failure',async()=>{
  const {context,inputs,alerts,item}=desktopRename(async()=>({ok:false,json:async()=>({detail:'名称超过限制'})}));
  await context.inlineRenameConversation('a',item);
  inputs[0].value='仍可修改的名称';
  inputs[0].listeners.keydown({key:'Enter',preventDefault(){}});
  await new Promise(setImmediate);
  assert.equal(inputs[0].value,'仍可修改的名称');
  assert.equal(inputs[0].disabled,false);
  assert.match(alerts[0],/名称超过限制/);
  assert.equal(context.chatConversationsList[0].name,'旧名');
});

function mobileActions() {
  const nodes=new Map();
  function node(id){
    if(!nodes.has(id))nodes.set(id,{hidden:false,disabled:false,value:'',textContent:'',focus(){},select(){},
      classList:{open:false,add(){this.open=true;},remove(){this.open=false;}}});
    return nodes.get(id);
  }
  let release;
  const payload={id:'a',name:'返回的名称',title:{status:'ready',source:'manual',revision:2}};
  const context={AbortController,setTimeout,clearTimeout,document:{getElementById:node},
    renderList(){},isListVisible:()=>true,alert:message=>{throw new Error(message);},
    api:async(_path,options)=>options?.method==='PATCH'?new Promise(resolve=>{release=()=>resolve(payload);}):[],
    fetch:async()=>({ok:true,json:()=>new Promise(resolve=>{release=()=>resolve(payload);})})};
  context.window=context;vm.createContext(context);
  vm.runInContext(fs.readFileSync('coderfleet/server/static/js/conversation-titles.js','utf8'),context);
  const source=fs.readFileSync('coderfleet/server/static/mobile.html','utf8');
  const actions=source.slice(source.indexOf('function showItemActions'),source.indexOf('async function archiveActionTarget'));
  const refresh=source.slice(source.indexOf('async function bgRefresh()'),source.indexOf('async function checkHealth()'));
  vm.runInContext('let actionTarget=null,activeConv=null,convs=[{id:"a",name:"旧名",title:{revision:0}}],tasks=[];\n'+actions+'\n'+refresh,context);
  return {context,node,release:()=>release()};
}

for(const action of ['save','regenerate']) test(`a late mobile ${action} response preserves a newly opened editor for the same conversation`,async()=>{
  const {context,node,release}=mobileActions();
  context.showItemActions('conversation','a');
  context.editMobileTitle();node('action-title-input').value='第一次的名字';
  const pending=action==='save'?context.saveMobileTitle():context.regenerateMobileTitle();
  await new Promise(setImmediate);
  context.closeActionSheet();context.showItemActions('conversation','a');context.editMobileTitle();
  node('action-title-input').value='新编辑器尚未提交的名字';
  release();await pending;
  assert.equal(node('action-sheet').classList.open,true);
  assert.equal(node('action-title-input').value,'新编辑器尚未提交的名字');
  assert.equal(node('action-title-editor').hidden,false);
});

test('mobile background refresh updates the open title menu without resetting its editor',async()=>{
  const {context,node}=mobileActions();
  vm.runInContext('convs[0].title={status:"pending",revision:1};activeConv=convs[0];',context);
  context.showItemActions('conversation','a');context.editMobileTitle();
  node('action-title-input').value='正在编辑';
  assert.equal(node('action-retitle-btn').disabled,true);
  context.api=async path=>path==='/api/conversations'?[{id:'a',name:'已生成的新标题',title:{status:'ready',source:'auto',revision:3}}]:[];
  await context.bgRefresh();
  assert.equal(node('chat-ttl').textContent,'已生成的新标题');
  assert.equal(node('action-retitle-btn').disabled,false);
  assert.equal(node('action-title-status').textContent,'自动命名');
  assert.equal(node('action-title-input').value,'正在编辑');
});
