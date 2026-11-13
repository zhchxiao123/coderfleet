const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

class Element {
  constructor() {
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.listeners = {};
    this.className = '';
    this._html = '';
    this.classList = {
      add: (...names) => { this.className += ' ' + names.join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name=>!names.includes(name)).join(' '); },
    };
  }
  set innerHTML(value) { this._html = value; this.children = []; }
  get innerHTML() { return this._html + this.children.map(child => child.innerHTML).join(''); }
  appendChild(child) {
    if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(item=>item!==child);
    child.parentNode=this; this.children.push(child); return child;
  }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  focus() {}
  querySelectorAll() { return []; }
  querySelector(selector) {
    if (selector === '.chat-log') return this.log || (this.log = new Element());
    this.queries ||= new Map();
    if (!this.queries.has(selector)) this.queries.set(selector,new Element());
    return this.queries.get(selector);
  }
}

function renderer(fetch = async () => ({ status: 200 })) {
  const elements = new Map();
  const frames = new Map();
  let frameId = 0;
  const getElementById = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { createElement: () => new Element(), addEventListener() {}, getElementById,
      querySelectorAll: selector => {
        const group = selector.match(/^input\[name="([^"]+)"\]:checked$/)?.[1];
        return group ? [...elements.values()].filter(element => element.name === group && element.checked)
          .sort((left, right) => left.id.localeCompare(right.id)) : [];
      } }, console,
    window: { fetch }, fetch, API:'', Headers, TextEncoder,
    requestAnimationFrame:callback=>{frames.set(++frameId,callback);return frameId;},
    cancelAnimationFrame:id=>frames.delete(id),
    localStorage: { getItem: () => '' },
  });
  const directory = path.resolve(__dirname, '../../coderfleet/server/static/js');
  vm.runInContext(fs.readFileSync(path.join(directory,'../vendor/marked.min.js'),'utf8'),context);
  for (const name of ['utils.js', 'renderer.js']) {
    vm.runInContext(fs.readFileSync(path.join(directory, name), 'utf8'), context);
  }
  const Renderer = vm.runInContext('ChatLogRenderer', context);
  const container = new Element();
  const result = new Renderer(container, true, false, 'project', 'task-one');
  result.renderExecuting();
  const flushFrames=()=>{const callbacks=[...frames.values()];frames.clear();for(const callback of callbacks)callback();};
  return { result, container, getElementById, flushFrames, frames, context };
}

test('SDK turn results do not finish the Task before its durable footer', () => {
  const { result, container } = renderer();
  result.push(JSON.stringify({ type: 'system', subtype: 'coderfleet_backend', execution_backend: 'sdk' }));
  result.push(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }));
  assert.equal(container.log.children.filter(child => child.className.includes('chat-footer')).length, 0);
  result.push(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }));
  assert.equal(container.log.children.filter(child => child.className.includes('chat-footer')).length, 0);
  result.push('finished: 2026-11-09 19:00:00 [killed]');
  const footers = container.log.children.filter(child => child.className.includes('chat-footer'));
  assert.equal(footers.length, 1);
  assert.match(footers[0].innerHTML, /任务已终止/);
});

test('legacy CLI results still render their completion footer', () => {
  const { result, container } = renderer();
  result.push(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }));
  assert.equal(container.log.children.filter(child => child.className.includes('chat-footer')).length, 1);
});

test('delegated native questions can be answered and cancelled from the owning Task', async () => {
  const requests = [];
  const {result, getElementById} = renderer(async (url, options) => {
    requests.push({url, options});
    return {ok:true,json:async()=> options ? {ok:true} : {pending_intervention:{tool_call_id:'question-one',token:'token-one'}}};
  });
  const push = value => result.push(JSON.stringify(value));
  push({type:'system',subtype:'coderfleet_backend',execution_backend:'sdk'});
  push({type:'assistant',message:{content:[{type:'tool_use',id:'agent-one',name:'Agent',input:{prompt:'ask'}}]}});
  const question = id => ({type:'assistant',parent_tool_use_id:'agent-one',message:{content:[
    {type:'tool_use',id,name:'AskUserQuestion',input:{questions:[{question:'Choose target'}]}}]}});
  push(question('question-one'));
  const child = result.subagentRenderers['agent-one'].renderer;
  assert.equal(child.toolMap['question-one'].isLive,true);
  getElementById('askq-text-question-one-0').value = 'Mac';
  getElementById('askq-submit-btn-question-one').listeners.click({stopPropagation(){}});
  await new Promise(setImmediate);
  assert.equal(requests[1].url,'/api/tasks/task-one/answer');
  assert.deepEqual(JSON.parse(requests[1].options.body).answers,{'Choose target':'Mac'});
  push(question('question-two'));
  push({type:'system',subtype:'coderfleet_question_closed',tool_call_id:'question-two',status:'cancelled'});
  assert.equal(child.toolMap['question-two'].isLive,false);
  assert.match(getElementById('askq-submit-status-question-two').textContent,/已取消/);
  push(question('question-three'));
  result.deactivatePendingInterventions();
  assert.equal(child.toolMap['question-three'].isLive,false);
});

test('native single-choice questions allow a custom answer alongside model options', async () => {
  const requests = [];
  const { result, getElementById } = renderer(async (url, options) => {
    requests.push({url, options});
    return {ok:true,json:async()=> options ? {ok:true} : {pending_intervention:{tool_call_id:'custom-one',token:'token-one'}}};
  });
  result.push(JSON.stringify({type:'system',subtype:'coderfleet_backend',execution_backend:'sdk'}));
  result.push(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'custom-one',name:'AskUserQuestion',
    input:{questions:[{question:'Which target?',options:[{label:'Mac'},{label:'Linux'}]}]}}]}}));
  assert.match(result.toolMap['custom-one'].wrap.innerHTML,/askq-other-custom-one-0/,'Native options must retain a custom-answer control');
  const custom = getElementById('askq-text-custom-one-0');
  const other = getElementById('askq-other-custom-one-0');
  other.id='askq-other-custom-one-0'; other.name='askq-radio-custom-one-0';
  custom.value='Windows ARM';
  custom.listeners.input();
  assert.equal(other.checked,true,'Typing an answer selects Other');
  await result._submitIntervention('custom-one');
  assert.deepEqual(JSON.parse(requests[1].options.body).answers,{'Which target?':'Windows ARM'});
});

test('native multiple questions preserve single, multi-select, and custom answer shapes', async () => {
  const requests = [];
  const { result, getElementById } = renderer(async (url, options) => {
    requests.push({url, options});
    return {ok:true,json:async()=> options ? {ok:true} : {pending_intervention:{tool_call_id:'mixed-one',token:'token-one'}}};
  });
  result.push(JSON.stringify({type:'system',subtype:'coderfleet_backend',execution_backend:'sdk'}));
  result.push(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'mixed-one',name:'AskUserQuestion',
    input:{questions:[
      {question:'Which target?',options:[{label:'Mac'},{label:'Linux'}]},
      {question:'What to verify?',multiSelect:true,options:[{label:'Tests'},{label:'Docs'}]},
    ]}}]}}));
  assert.match(result.toolMap['mixed-one'].wrap.innerHTML,/askq-other-mixed-one-1/);
  const select = (id, index, value) => {
    const input=getElementById(id); input.id=id; input.name=`askq-radio-mixed-one-${index}`; input.value=value; input.checked=true;
  };
  select('askq-opt-mixed-one-0-0',0,'Mac');
  select('askq-opt-mixed-one-1-0',1,'Tests');
  select('askq-opt-mixed-one-1-1',1,'Docs');
  select('askq-other-mixed-one-1',1,'');
  getElementById('askq-text-mixed-one-1').value='Proxy path';
  await result._submitIntervention('mixed-one');
  assert.deepEqual(JSON.parse(requests[1].options.body).answers,{
    'Which target?':'Mac','What to verify?':['Tests','Docs','Proxy path'],
  });
});

function nativeChoice(result, getElementById, id) {
  result.push(JSON.stringify({type:'system',subtype:'coderfleet_backend',execution_backend:'sdk'}));
  result.push(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id,name:'AskUserQuestion',
    input:{questions:[{question:'Which target?',options:[{label:'Mac'},{label:'Linux'}]}]}}]}}));
  const input = getElementById(`askq-opt-${id}-0-0`);
  input.id=`askq-opt-${id}-0-0`; input.name=`askq-radio-${id}-0`; input.value='Mac'; input.checked=true;
  return input;
}

test('an unconfirmed native answer retries the captured body after the pending question clears', async () => {
  const requests=[];
  let posts=0;
  const {result, getElementById}=renderer(async(url,options)=>{
    requests.push({url,options});
    if (!options) return {ok:true,json:async()=>({pending_intervention:posts ? null : {tool_call_id:'retry-one',token:'retry-token'}})};
    if (++posts===1) throw new Error('answer response lost');
    return {ok:true,json:async()=>({ok:true})};
  });
  nativeChoice(result,getElementById,'retry-one');
  await result._submitIntervention('retry-one');
  await result._submitIntervention('retry-one');
  const sent=requests.filter(request=>request.options);
  assert.equal(sent.length,2,'The retry must reach the answer API even when pending_intervention is now null');
  assert.equal(sent[0].options.body,sent[1].options.body,'Retry identity and answer text are immutable');
  assert.equal(requests.filter(request=>!request.options).length,1,'A captured native answer does not depend on a stale pending lookup');
});

test('an unconfirmed native answer cannot be replaced with a different answer', async () => {
  const requests=[];
  const {result,getElementById}=renderer(async(url,options)=>{
    requests.push({url,options});
    if(options) throw new Error('answer response lost');
    return {ok:true,json:async()=>({pending_intervention:{tool_call_id:'immutable-one',token:'retry-token'}})};
  });
  const first=nativeChoice(result,getElementById,'immutable-one');
  await result._submitIntervention('immutable-one');
  first.checked=false;
  const second=getElementById('askq-opt-immutable-one-0-1');
  second.id='askq-opt-immutable-one-0-1';second.name=first.name;second.value='Linux';second.checked=true;
  await result._submitIntervention('immutable-one');
  assert.equal(requests.length,2,'Changing an uncertain answer must not issue another request');
  assert.match(getElementById('askq-submit-status-immutable-one').textContent,/尚未确认/);
});

test('a definitively rejected native answer can be corrected while the question stays open', async () => {
  const requests=[];
  let posts=0;
  const {result,getElementById}=renderer(async(url,options)=>{
    requests.push({url,options});
    if(!options) return {ok:true,json:async()=>({pending_intervention:{tool_call_id:'rejected-one',token:'retry-token'}})};
    const accepted=++posts>1;
    return {ok:accepted,status:accepted ? 200 : 409,json:async()=>accepted ? {ok:true} : {detail:'Answer was rejected'}};
  });
  const first=nativeChoice(result,getElementById,'rejected-one');
  await result._submitIntervention('rejected-one');
  first.checked=false;
  const second=getElementById('askq-opt-rejected-one-0-1');
  second.id='askq-opt-rejected-one-0-1';second.name=first.name;second.value='Linux';second.checked=true;
  await result._submitIntervention('rejected-one');
  const sent=requests.filter(request=>request.options);
  assert.equal(sent.length,2);
  assert.deepEqual(JSON.parse(sent[1].options.body).answers,{'Which target?':'Linux'});
  assert.equal(result.toolMap['rejected-one'].isLive,false);
});

test('an authoritative native question close cannot be overwritten by a delayed answer error', async () => {
  let rejectAnswer;
  const {result,getElementById}=renderer(async(_url,options)=>{
    if(options) return await new Promise((_resolve,reject)=>{rejectAnswer=reject;});
    return {ok:true,json:async()=>({pending_intervention:{tool_call_id:'closed-one',token:'retry-token'}})};
  });
  const input=nativeChoice(result,getElementById,'closed-one');
  const button=getElementById('askq-submit-btn-closed-one');
  result.toolMap['closed-one'].wrap.querySelectorAll=()=>[input,button];
  const submission=result._submitIntervention('closed-one');
  await new Promise(setImmediate);
  result.push(JSON.stringify({type:'system',subtype:'coderfleet_question_closed',tool_call_id:'closed-one',status:'answered'}));
  rejectAnswer(new Error('delayed connection loss'));
  await submission;
  assert.match(getElementById('askq-submit-status-closed-one').textContent,/已回答/);
  assert.equal(input.disabled,true,'Question inputs close with the authoritative event');
  assert.equal(button.disabled,true,'A late catch must not reopen the submit button');
});

test('Task completion disables all unanswered native question inputs', () => {
  const {result,getElementById}=renderer();
  const input=nativeChoice(result,getElementById,'ended-one');
  const button=getElementById('askq-submit-btn-ended-one');
  result.toolMap['ended-one'].wrap.querySelectorAll=()=>[input,button];
  result.deactivatePendingInterventions();
  assert.equal(input.disabled,true);
  assert.equal(button.disabled,true);
  assert.equal(result.toolMap['ended-one'].isLive,false);
});


test('SDK partial text is visible before the final block and settles into one reply', () => {
  const {result,container,flushFrames}=renderer();
  const push=event=>result.push(JSON.stringify(event));
  push({type:'system',subtype:'coderfleet_backend',execution_backend:'sdk'});
  push({type:'stream_event',event:{type:'message_start',message:{id:'message-one',model:'fixture'}}});
  push({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}});
  push({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'正在'}}});
  const reply=result.lastBubbleEl;
  assert.ok(reply,'A text delta must be visible before an AssistantMessage is complete');
  flushFrames();
  assert.match(reply.querySelector('.bubble-content').innerHTML,/正在/);
  push({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'回答'}}});
  flushFrames();
  assert.match(reply.querySelector('.bubble-content').innerHTML,/正在回答/);
  push({type:'assistant',message:{id:'message-one',model:'fixture',content:[{type:'text',text:'正在回答'}]}});
  push({type:'result',subtype:'success',result:'正在回答',is_error:false});
  assert.equal(result.lastBubbleEl,reply);
  assert.equal(container.log.children.filter(child=>child.className.includes('ai-reply')).length,1,'Partial, assistant and result must not create duplicate answers');
  assert.match(reply.querySelector('.bubble-content').innerHTML,/正在回答/);
});


test('native tool and plan approval cards submit scoped decisions and close authoritatively',async()=>{
  const requests=[];
  const {result,getElementById}=renderer(async(url,options)=>{
    requests.push({url,options});
    return {ok:true,json:async()=>options ? {ok:true} : {pending_intervention:{kind:'permission',tool_call_id:'permission-one',token:'permission-token'}}};
  });
  result.push(JSON.stringify({type:'system',subtype:'coderfleet_permission_pending',tool_call_id:'permission-one',tool_name:'ExitPlanMode',tool_input:{plan:'Implement after review'},deadline:'2099-01-01T00:00:00Z'}));
  assert.ok(result.permissionMap?.['permission-one'],'A native approval request must be actionable');
  assert.match(result.permissionMap['permission-one'].wrap.innerHTML,/批准计划/);
  getElementById('permission-allow-permission-one').listeners.click({stopPropagation(){}});
  await new Promise(setImmediate);
  assert.equal(requests[1].url,'/api/tasks/task-one/approval');
  assert.deepEqual(JSON.parse(requests[1].options.body),{tool_call_id:'permission-one',token:'permission-token',decision:'allow',message:''});
  result.push(JSON.stringify({type:'system',subtype:'coderfleet_permission_closed',tool_call_id:'permission-one',status:'approved'}));
  assert.equal(result.permissionMap['permission-one'].isLive,false);
  assert.match(getElementById('permission-status-permission-one').textContent,/已批准/);
});


test('multiple SDK text blocks do not duplicate the final aggregate reply',()=>{
  const {result,container}=renderer();
  result.push(JSON.stringify({type:'system',subtype:'coderfleet_backend',execution_backend:'sdk'}));
  for (const text of ['first block','second block']) result.push(JSON.stringify({type:'assistant',message:{id:'same-message',content:[{type:'text',text}]}}));
  result.push(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'first block\nsecond block'}));
  assert.equal(container.log.children.filter(child=>child.className.includes('ai-reply')).length,2,JSON.stringify({parts:result.lastSDKTextParts,id:result.lastSDKMessageId,text:result.lastSDKText,last:result.lastBubbleEl._bubbleText,backend:result.executionBackend}));
});

test('empty signed thinking blocks do not duplicate the later visible streamed thinking',()=>{
  const {result,container}=renderer();
  const push=event=>result.push(JSON.stringify(event));
  const stream=event=>push({type:'stream_event',event});
  push({type:'system',subtype:'coderfleet_backend',execution_backend:'sdk'});
  stream({type:'message_start',message:{id:'thought-message'}});
  stream({type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}});
  stream({type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'opaque'}});
  push({type:'assistant',message:{id:'thought-message',content:[{type:'thinking',thinking:'',signature:'opaque'}]}});
  stream({type:'content_block_stop',index:0});
  stream({type:'content_block_start',index:1,content_block:{type:'thinking',thinking:''}});
  stream({type:'content_block_delta',index:1,delta:{type:'thinking_delta',thinking:'检查 `image` 构建版本。'}});
  const thoughts=()=>container.log.children.filter(child=>child.className.includes('thought-reply'));
  assert.equal(thoughts().length,1,'Thinking must be visible during streaming');
  const node=thoughts()[0];
  push({type:'assistant',message:{id:'thought-message',content:[{type:'thinking',thinking:'检查 `image` 构建版本。'}]}});
  assert.equal(thoughts().length,1,'The final thinking block must update the existing stream node');
  assert.equal(node.dataset.streaming,'false');
  assert.match(node.querySelector('.think-bubble').innerHTML,/<code>image<\/code>/);
});

test('routine hook events stay out of the timeline while hook failures remain visible',()=>{
  const {result,container}=renderer();
  result.push(JSON.stringify({type:'system',subtype:'coderfleet_backend',execution_backend:'sdk'}));
  const initial=container.log.children.length;
  for (const subtype of ['hook_started','hook_progress','hook_response']) result.push(JSON.stringify({type:'system',subtype,hook_name:'SessionStart:resume',outcome:'success',exit_code:0}));
  assert.equal(container.log.children.length,initial);
  result.push(JSON.stringify({type:'system',subtype:'hook_response',hook_name:'SessionStart:resume',outcome:'error',exit_code:1}));
  assert.equal(container.log.children.length,initial+1);
  assert.match(container.log.children.at(-1).innerHTML,/Hook 执行失败/);
});

test('background progress updates its owning card without appending timeline messages',()=>{
  const {result,container}=renderer();
  const push=event=>result.push(JSON.stringify(event));
  push({type:'system',subtype:'coderfleet_backend',execution_backend:'sdk'});
  push({type:'assistant',message:{content:[{type:'tool_use',id:'agent-one',name:'Agent',input:{description:'Build validation',run_in_background:true}}]}});
  const count=container.log.children.length;
  push({type:'system',subtype:'task_started',task_id:'native-background',tool_use_id:'agent-one'});
  for(let i=0;i<100;i++)push({type:'system',subtype:'task_progress',task_id:'native-background',description:'Working'});
  assert.equal(container.log.children.length,count,'Heartbeat-like progress must not create new timeline entries');
  assert.equal(result.toolMap['agent-one'].statusEl.textContent,'⏳');
  push({type:'system',subtype:'task_notification',task_id:'native-background',status:'completed',summary:'Validated'});
  assert.equal(result.toolMap['agent-one'].statusEl.textContent,'✓');
});

test('Markdown is rendered during text and thinking deltas, before an assistant result',()=>{
  for(const type of ['text','thinking']){
    const {result,container,flushFrames}=renderer();
    const push=event=>result.push(JSON.stringify({type:'stream_event',event}));
    push({type:'message_start',message:{id:'stream-md'}});
    push({type:'content_block_start',index:0,content_block:{type,[type]:''}});
    for(const chunk of ['# 标题\n\n**加','粗**\n\n- 第一项\n','- 第二项\n\n```js\nconst x = 1;']){
      push({type:'content_block_delta',index:0,delta:{type:type+'_delta',[type]:chunk}});
      flushFrames();
    }
    const node=type==='text'?result.lastBubbleEl:container.log.children.find(child=>child.className.includes('thought-reply'));
    const content=node.querySelector(type==='text'?'.bubble-content':'.think-bubble');
    assert.match(content.innerHTML,/<h1[^>]*>标题<\/h1>/);
    assert.match(content.innerHTML,/<strong>加粗<\/strong>/);
    assert.match(content.innerHTML,/<ul>[\s\S]*<li>第一项<\/li>/);
    assert.match(content.innerHTML,/<pre><code[^>]*>const x = 1;/,'An unfinished fence remains a code block while streaming');
    push({type:'content_block_delta',index:0,delta:{type:type+'_delta',[type]:'\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |'}});
    flushFrames();
    assert.match(content.innerHTML,/<table>/,'Completed table syntax renders before the final message');
    assert.equal(node.dataset.streaming,'true');
  }
});

test('stream rendering batches deltas per frame and a late frame cannot overwrite the final message',()=>{
  const {result,container,context,flushFrames,frames}=renderer();
  const markdown=context.renderMd;
  let renders=0;
  context.renderMd=text=>{renders++;return markdown(text);};
  const push=event=>result.push(JSON.stringify(event));
  push({type:'stream_event',event:{type:'message_start',message:{id:'batch-one'}}});
  push({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}});
  for(let i=0;i<1000;i++)push({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'word '}}});
  assert.equal(frames.size,1,'A burst schedules only one render frame');
  const before=renders;
  flushFrames();
  assert.equal(renders-before,1,'Parse Markdown once per frame, not once per token');
  push({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'**provisional'}}});
  push({type:'assistant',message:{id:'batch-one',content:[{type:'text',text:'**Final**'}]}});
  flushFrames();
  assert.match(result.lastBubbleEl.querySelector('.bubble-content').innerHTML,/<strong>Final<\/strong>/);
  assert.equal(container.log.children.filter(child=>child.className.includes('ai-reply')).length,1);
  assert.equal(result.lastBubbleEl.dataset.streaming,'false');
});

test('ending a stream flushes pending Markdown and cancels its scheduled frame',()=>{
  const {result,frames,flushFrames}=renderer();
  const push=event=>result.push(JSON.stringify({type:'stream_event',event}));
  push({type:'message_start',message:{id:'interrupted-md'}});
  push({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'**中断前内容**'}});
  assert.equal(frames.size,1);
  result.deactivatePendingInterventions();
  assert.equal(frames.size,0);
  assert.match(result.lastBubbleEl.querySelector('.bubble-content').innerHTML,/<strong>中断前内容<\/strong>/);
  flushFrames();
  assert.equal(result.lastBubbleEl.dataset.streaming,'false');
});

test('background failures stay visible and launcher tool results cannot reset lifecycle state',()=>{
  const {result,container}=renderer();
  const push=event=>result.push(JSON.stringify(event));
  push({type:'assistant',message:{content:[{type:'tool_use',id:'agent-two',name:'Agent',input:{run_in_background:true}}]}});
  push({type:'system',subtype:'task_started',task_id:'native-two',tool_use_id:'agent-two'});
  const entry=result.toolMap['agent-two'];
  const response=()=>push({type:'user',message:{content:[{type:'tool_result',tool_use_id:'agent-two',content:'Agent launched in background.'}]}});
  response();
  assert.equal(entry.statusEl.textContent,'⏳','Launching the agent is not completion');
  push({type:'system',subtype:'task_notification',task_id:'native-two',status:'failed',summary:'Build failed'});
  response();
  assert.equal(entry.statusEl.textContent,'✗');
  assert.match(entry.exitEl.textContent,/Build failed/);
  assert.equal(entry.wrap.dataset.backgroundTaskId,'native-two','Native IDs remain discoverable in the owning card');
  push({type:'system',subtype:'task_started',task_id:'native-two',tool_use_id:'agent-two'});
  assert.equal(entry.statusEl.textContent,'✗','A late start cannot reopen a finished task');
  const count=container.log.children.length;
  for(let i=0;i<3;i++)push({type:'system',subtype:'task_notification',task_id:'orphan',status:'failed',summary:'Detached task failed'});
  assert.equal(container.log.children.length,count+1,'An unowned failure is surfaced once');
  push({type:'system',subtype:'task_started',task_id:'native-three',tool_use_id:'agent-two'});
  push({type:'system',subtype:'task_notification',task_id:'native-three',status:'stopped'});
  assert.equal(entry.statusEl.textContent,'■');
});

test('full reload, pending startup, and log-header resets cancel paints and discard prior SDK state',()=>{
  for(const reset of ['reload','pending','header']){
    const {result,frames,flushFrames}=renderer();
    result.push(JSON.stringify({type:'stream_event',event:{type:'message_start',message:{id:'old-message'}}}));
    result.push(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'**old**'}}}));
    result.push(JSON.stringify({type:'system',subtype:'task_started',task_id:'old-native',tool_use_id:'old-tool'}));
    assert.equal(frames.size,1);
    if(reset==='reload')result.render('');
    if(reset==='pending'){result.renderExecuting();result.push(JSON.stringify({type:'system',subtype:'coderfleet_backend',execution_backend:'sdk'}));}
    if(reset==='header'){result.inner.querySelector=()=>null;result.push('=== CoderFleet Task Log ===');}
    assert.equal(frames.size,0,reset);
    assert.equal(result.streamBlocks.size,0,reset);
    assert.equal(result.backgroundTasks.size,0,reset);
    flushFrames();
  }
});

test('native task_updated terminal patches finish the card without a notification',()=>{
  for(const [status,icon] of [['completed','✓'],['failed','✗'],['killed','■']]){
    const {result}=renderer();
    const push=event=>result.push(JSON.stringify(event));
    push({type:'assistant',message:{content:[{type:'tool_use',id:'updated-agent',name:'Agent',input:{run_in_background:true}}]}});
    push({type:'system',subtype:'task_started',task_id:'updated-native',tool_use_id:'updated-agent'});
    push({type:'system',subtype:'task_updated',task_id:'updated-native',patch:{status}});
    assert.equal(result.toolMap['updated-agent'].statusEl.textContent,icon,status);
    push({type:'system',subtype:'task_updated',task_id:'updated-native',patch:{status:'running'}});
    assert.equal(result.toolMap['updated-agent'].statusEl.textContent,icon,'Late nonterminal updates do not reopen a finished task');
  }
});
