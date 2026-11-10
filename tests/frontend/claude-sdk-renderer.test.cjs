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
    document: { createElement: () => new Element(), addEventListener() {}, getElementById, querySelectorAll:()=>[] }, console,
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
