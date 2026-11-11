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
    this.classList = { add: (...names) => { this.className += ' ' + names.join(' '); } };
  }
  set innerHTML(value) { this._html = value; this.children = []; }
  get innerHTML() { return this._html + this.children.map(child => child.innerHTML).join(''); }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  focus() {}
  querySelectorAll() { return []; }
  querySelector(selector) {
    if (selector === '.chat-log') return this.log || (this.log = new Element());
    return new Element();
  }
}

function renderer(fetch = async () => ({ status: 200 })) {
  const elements = new Map();
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
    localStorage: { getItem: () => '' },
  });
  const directory = path.resolve(__dirname, '../../coderfleet/server/static/js');
  for (const name of ['utils.js', 'renderer.js']) {
    vm.runInContext(fs.readFileSync(path.join(directory, name), 'utf8'), context);
  }
  const Renderer = vm.runInContext('ChatLogRenderer', context);
  const container = new Element();
  const result = new Renderer(container, true, false, 'project', 'task-one');
  result.renderExecuting();
  return { result, container, getElementById };
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
