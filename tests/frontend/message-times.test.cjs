const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const crypto = require('node:crypto');

const directory = path.resolve(__dirname, '../../coderfleet/server/static/js');
class Element {
  constructor() {
    this.children = []; this.dataset = {}; this.style = {}; this.className = ''; this._html = '';
    this.classList = {add: (...names) => { this.className += ' '+names.join(' '); }, remove() {}};
    this.queries = new Map();
  }
  set innerHTML(value) { this._html = value; this.children = []; this.queries.clear(); }
  get innerHTML() { return this._html + this.children.map(child => child.innerHTML).join(''); }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  addEventListener() {}
  querySelector(selector) {
    if (!this.queries.has(selector)) this.queries.set(selector,new Element());
    return this.queries.get(selector);
  }
  querySelectorAll() { return []; }
}

function ui(timing = {}) {
  const nodes = new Map();
  const context = vm.createContext({
    document: {createElement:()=>new Element(),addEventListener(){},getElementById:id=>nodes.get(id)||null},
    window: {fetch:async()=>({ok:true})}, crypto: {subtle:{digest:async(_algorithm,bytes)=>crypto.createHash('sha256').update(bytes).digest()}}, TextEncoder, Headers, console,
    localStorage:{getItem:()=>null},sessionStorage:{getItem:()=>null},
  });
  vm.runInContext(fs.readFileSync(path.join(directory,'../vendor/marked.min.js'),'utf8'),context);
  for (const name of ['utils.js','renderer.js']) vm.runInContext(fs.readFileSync(path.join(directory,name),'utf8'),context);
  const Renderer = vm.runInContext('ChatLogRenderer',context);
  const container = new Element();
  const result = new Renderer(container,false,false,'project','task-one',timing);
  result.render('');
  return {context,nodes,container,result};
}

test('an AI reply shows its recorded timestamp rather than the time history is opened', () => {
  const {result} = ui();
  result.push(JSON.stringify({type:'assistant',timestamp:'2026-11-17T02:30:45Z',message:{
    id:'reply-one',content:[{type:'text',text:'A historical answer'}],
  }}));
  const time = result.lastBubbleEl.querySelector('.bubble-time-slot').innerHTML;
  assert.match(time,/datetime="2026-11-17T02:30:45.000Z"/);
  assert.match(time,/回复时间/);
  const markup = result.lastBubbleEl._html;
  assert.ok(markup.indexOf('message-footer') > markup.indexOf('bubble-content'));
  assert.ok(markup.indexOf('bubble-time-slot') > markup.indexOf('bubble-copy-btn'));
});

test('a streamed SDK reply gains its matching persisted clock without creating a second bubble', async () => {
  const {result} = ui();
  const push = event => result.push(JSON.stringify(event));
  push({type:'stream_event',event:{type:'message_start',message:{id:'stream-one'}}});
  push({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Answer'}}});
  const original = result.lastBubbleEl;
  const line = JSON.stringify({type:'assistant',message:{id:'stream-one',content:[{type:'text',text:'Answer'}]}});
  result.push(line);
  push({type:'system',subtype:'coderfleet_event_clock',at:'2026-11-18T18:15:12Z',event_hash:crypto.createHash('sha256').update(line).digest('hex')});
  await new Promise(setImmediate);
  assert.equal(result.lastBubbleEl,original);
  assert.match(original.querySelector('.bubble-time-slot').innerHTML,/datetime="2026-11-18T18:15:12.000Z"/);
});

test('legacy logs use the recorded Task completion only for the final reply and label the fallback', () => {
  const {result} = ui({finished:'2026-11-16T06:00:00Z'});
  result.push(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Earlier reply'}]}}));
  const earlier = result.lastBubbleEl;
  result.push(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Final reply'}]}}));
  assert.equal(earlier.querySelector('.bubble-time-slot').innerHTML,'');
  const finalTime = result.lastBubbleEl.querySelector('.bubble-time-slot').innerHTML;
  assert.match(finalTime,/datetime="2026-11-16T06:00:00.000Z"/);
  assert.match(finalTime,/本轮完成/);
});

test('desktop history and immediate sends show the server-recorded send time', () => {
  const {context,nodes} = ui();
  for (const file of ['state.js','chat.js']) vm.runInContext(fs.readFileSync(path.join(directory,file),'utf8'),context);
  Object.assign(context,{renderTaskFileAttachments:()=>'',renderTaskExecutionMetadata:()=>'',
    _syncChatSendButton(){},renderQueuePanel(){},scrollToBottomAndResume(){},startChatFollow(){}});
  const task = {id:'task-one',prompt:'Historical instruction',type:'claude',status:'failed',created:'2026-11-18T17:04:05Z'};
  const history = new Element();
  context._renderChatTaskTurn(history,task,'');
  assert.match(history.children[0].innerHTML,/datetime="2026-11-18T17:04:05.000Z"/);
  assert.match(history.children[0].innerHTML,/发送时间/);
  assert.match(history.children[0].innerHTML,/<div class="message-footer user-message-footer">\s*<time[\s\S]*<button class="user-copy-btn"/);
  assert.doesNotMatch(history.children[0].innerHTML,/user-bubble-title/);
  const content = new Element(); nodes.set('chat-content',content);
  vm.runInContext('tasksCache='+JSON.stringify([task]),context);
  context._appendOptimisticUserMessage('Historical instruction',[],task.id,false,'claude');
  assert.match(content.children[0].innerHTML,/datetime="2026-11-18T17:04:05.000Z"/);
});

test('mobile user bubbles show the same recorded send time', () => {
  const {context} = ui();
  context.window.addEventListener = () => {};
  context.window.innerHeight = 844;
  context.document.documentElement = {clientHeight:844,style:{setProperty(){}}};
  const scripts = [...fs.readFileSync(path.join(directory,'../mobile.html'),'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)];
  vm.runInContext(scripts.find(match=>match[1].includes('let projects  = []'))[1],context);
  Object.assign(context,{renderTaskImages:()=>'',renderTaskExecutionMetadata:()=>'',taskActionsHtml:()=>''});
  const pair = context.makeMsgPair({id:'mobile-task',prompt:'Mobile instruction',created:'2026-11-18T17:06:30Z'});
  assert.match(pair.innerHTML,/datetime="2026-11-18T17:06:30.000Z"/);
  assert.match(pair.innerHTML,/发送时间/);
  assert.match(pair.innerHTML,/<div class="message-footer user-message-footer">\s*<time[\s\S]*<button class="user-copy-btn"/);
});

test('message footers use short local calendar labels and keep exact time in the tooltip', () => {
  const {context} = ui();
  const now = new Date(2026,10,18,12);
  const render = date => context.renderMessageTime(date.toISOString(),'发送时间','',now);
  assert.match(render(new Date(2026,10,18,0,3)),/>00:03<\/time>/);
  assert.match(render(new Date(2026,10,17,19,28)),/>昨天 19:28<\/time>/);
  assert.match(render(new Date(2026,10,16,19,28)),/>星期一 19:28<\/time>/);
  assert.match(render(new Date(2026,10,1,9,5)),/>11\/01 09:05<\/time>/);
  assert.match(render(new Date(2025,10,18,9,5)),/>2025\/11\/18 09:05<\/time>/);
  assert.match(render(new Date(2026,10,19,9,5)),/>11\/19 09:05<\/time>/);
  assert.match(render(new Date(2026,10,18,0,3)),/title="发送时间 · 2026\/11\/18 [^"]*00:03:00/);
});

test('copying from the user footer finds only its own message on desktop and mobile', () => {
  const {context} = ui();
  const copied = [];
  context.copyTextToClipboard = (text,button) => copied.push({text,button});
  for (const text of ['Desktop message','Mobile message']) {
    const button = {closest:selector=>{
      assert.match(selector,/user-message-stack/);
      assert.match(selector,/user-msg-stack/);
      return {querySelector:selector=>{
        assert.match(selector,/user-bubble-content/);
        assert.match(selector,/user-bubble-text/);
        return {textContent:text};
      }};
    }};
    context.copyUserBubble(button);
    assert.deepEqual(copied.at(-1),{text,button});
  }
  context.copyUserBubble({closest:()=>null});
  assert.equal(copied.length,2);
});

test('invalid or mismatched clocks never fabricate a timestamp', async () => {
  const {result,context} = ui({finished:'not-a-date'});
  const line = JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Untimed reply'}]}});
  result.push(line);
  result.push(JSON.stringify({type:'system',subtype:'coderfleet_event_clock',at:'2026-11-18T18:00:00Z',event_hash:'0'.repeat(64)}));
  await new Promise(setImmediate);
  assert.equal(result.lastBubbleEl.querySelector('.bubble-time-slot').innerHTML,'');
  assert.equal(context.renderMessageTime('invalid timestamp','回复时间'),'');
});

test('a late clock from an old render cannot change the refreshed history', async () => {
  const {result,context} = ui();
  let finishHash;
  context.crypto.subtle.digest = () => new Promise(resolve => { finishHash = resolve; });
  const line = JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Old reply'}]}});
  result.push(line);
  const old = result.lastBubbleEl;
  result.push(JSON.stringify({type:'system',subtype:'coderfleet_event_clock',at:'2026-11-18T18:00:00Z',event_hash:crypto.createHash('sha256').update(line).digest('hex')}));
  result.render('');
  result.push(JSON.stringify({type:'assistant',timestamp:'2026-11-18T19:00:00Z',message:{content:[{type:'text',text:'Refreshed reply'}]}}));
  finishHash(crypto.createHash('sha256').update(line).digest());
  await new Promise(setImmediate);
  assert.equal(old.querySelector('.bubble-time-slot').innerHTML,'');
  assert.match(result.lastBubbleEl.querySelector('.bubble-time-slot').innerHTML,/2026-11-18T19:00:00.000Z/);
});

test('a live supplementary message has its own persisted reception time', async () => {
  const {result,container} = ui();
  const line = JSON.stringify({type:'system',subtype:'coderfleet_message_accepted',text:'Supplement'});
  result.push(line);
  result.push(JSON.stringify({type:'system',subtype:'coderfleet_event_clock',at:'2026-11-18T17:10:00Z',event_hash:crypto.createHash('sha256').update(line).digest('hex')}));
  await new Promise(setImmediate);
  const notice = container.querySelector('.chat-log').children[0];
  assert.match(notice.querySelector('.bubble-time-slot').innerHTML,/datetime="2026-11-18T17:10:00.000Z"/);
  assert.match(notice.querySelector('.bubble-time-slot').innerHTML,/接收时间/);
});

test('browsers without Web Crypto retain clearly labeled Task completion time', async () => {
  const {result,context} = ui({finished:'2026-11-18T17:20:00Z'});
  context.crypto = undefined;
  const line = JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Legacy browser reply'}]}});
  result.push(line);
  result.push(JSON.stringify({type:'system',subtype:'coderfleet_event_clock',at:'2026-11-18T17:15:00Z',event_hash:crypto.createHash('sha256').update(line).digest('hex')}));
  await new Promise(setImmediate);
  assert.match(result.lastBubbleEl.querySelector('.bubble-time-slot').innerHTML,/2026-11-18T17:20:00.000Z/);
  assert.match(result.lastBubbleEl.querySelector('.bubble-time-slot').innerHTML,/本轮完成/);
});
