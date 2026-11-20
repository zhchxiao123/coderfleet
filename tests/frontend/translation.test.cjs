const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const vm=require('node:vm');

class Element {
  constructor(){this.innerHTML='';this.style={};this.dataset={};this.isConnected=true;this.queries=new Map();const names=new Set();this.classList={add:(...items)=>items.forEach(item=>names.add(item)),remove:(...items)=>items.forEach(item=>names.delete(item)),contains:item=>names.has(item)};}
  querySelector(selector){if(!this.queries.has(selector))this.queries.set(selector,new Element());return this.queries.get(selector);}
}
function ui(fetch){
  const context=vm.createContext({console,Headers,TextEncoder,AbortController,fetch,
    window:{fetch},localStorage:{getItem:()=>null},document:{addEventListener(){}},setTimeout:()=>0,clearTimeout(){},
  });
  const directory=path.resolve(__dirname,'../../coderfleet/server/static');
  vm.runInContext(fs.readFileSync(path.join(directory,'vendor/marked.min.js'),'utf8'),context);
  for(const name of ['utils.js','renderer.js'])vm.runInContext(fs.readFileSync(path.join(directory,'js',name),'utf8'),context);
  context.showToast=()=>{};
  const Renderer=vm.runInContext('ChatLogRenderer',context);
  const renderer=new Renderer(null);
  const node=new Element();
  const content=node.querySelector('.bubble-content'),button=node.querySelector('.bubble-translate-btn');
  const paint=text=>renderer._renderStreamMarkdown({node,type:'text',text});
  return {context,content,button,paint};
}
const response=text=>({ok:true,json:async()=>({translated:'译文：'+text})});

test('long translations render their final paragraph and can toggle back to the whole original',async()=>{
  let requests=0;
  const {context,content,button,paint}=ui(async(_url,options)=>{requests++;return response(JSON.parse(options.body).text);});
  const text='A long paragraph.\n\n'.repeat(2000)+'FINAL_SENTENCE_3821';
  paint(text);
  const original=content.innerHTML;
  await context.toggleBubbleTranslation(button,content,text);
  assert.match(content.innerHTML,/FINAL_SENTENCE_3821/);
  await context.toggleBubbleTranslation(button,content,text);
  assert.equal(content.innerHTML,original);
  await context.toggleBubbleTranslation(button,content,text);
  assert.equal(requests,1);
});

test('growing streamed text invalidates an earlier short translation',async()=>{
  const requests=[];
  const {context,content,button,paint}=ui(async(_url,options)=>{const text=JSON.parse(options.body).text;requests.push(text);return response(text);});
  paint('An initial English paragraph.');
  await context.toggleBubbleTranslation(button,content,'An initial English paragraph.');
  const full='An initial English paragraph. The newly completed final paragraph.';
  paint(full);
  await context.toggleBubbleTranslation(button,content,full);
  assert.equal(requests.length,2);
  assert.match(content.innerHTML,/译文/);
  assert.match(content.innerHTML,/completed final paragraph/);
});

test('a late short translation cannot overwrite a newer complete translation',async()=>{
  let finishOld;
  const {context,content,button,paint}=ui(async(_url,options)=>{
    const text=JSON.parse(options.body).text;
    if(text==='Initial English text.')return new Promise(resolve=>{finishOld=()=>resolve(response(text));});
    return response(text);
  });
  paint('Initial English text.');
  const old=context.toggleBubbleTranslation(button,content,'Initial English text.');
  const full='Initial English text. This is the final sentence.';
  paint(full);
  await context.toggleBubbleTranslation(button,content,full);
  finishOld();await old;
  assert.match(content.innerHTML,/final sentence/);
  assert.match(content.innerHTML,/译文/);
});

test('settling the same streamed source preserves the selected translation',async()=>{
  const {context,content,button,paint}=ui(async(_url,options)=>response(JSON.parse(options.body).text));
  const text='A complete English answer.';
  paint(text);await context.toggleBubbleTranslation(button,content,text);
  const translated=content.innerHTML;
  paint(text);
  assert.equal(content.innerHTML,translated);
  assert.equal(button.classList.contains('active'),true);
});

test('an empty successful translation cannot erase the original reply',async()=>{
  const {context,content,button,paint}=ui(async()=>({ok:true,json:async()=>({translated:''})}));
  paint('The complete original text.');
  const original=content.innerHTML;
  await context.toggleBubbleTranslation(button,content,'The complete original text.');
  assert.equal(content.innerHTML,original);
  assert.equal(button.classList.contains('failed'),true);
});

test('duplicate clicks share the pending translation request',async()=>{
  let finish,requests=0;
  const {context,content,button,paint}=ui(async()=>{requests++;return new Promise(resolve=>{finish=()=>resolve(response('The complete reply.'));});});
  paint('The complete reply.');
  const first=context.toggleBubbleTranslation(button,content,'The complete reply.');
  await context.toggleBubbleTranslation(button,content,'The complete reply.');
  assert.equal(requests,1);
  finish();await first;
  assert.match(content.innerHTML,/译文/);
});

test('a failed long translation preserves the original and a retry requests the entire text',async()=>{
  const requests=[];
  const {context,content,button,paint}=ui(async(_url,options)=>{
    const text=JSON.parse(options.body).text;requests.push(text);
    return requests.length===1?{ok:false,status:502,json:async()=>({detail:'输出未完成，请重试'})}:response(text);
  });
  const full='The complete long response. '.repeat(300)+'FINAL_57213';
  paint(full);const original=content.innerHTML;
  await context.toggleBubbleTranslation(button,content,full);
  assert.equal(content.innerHTML,original);
  await context.toggleBubbleTranslation(button,content,full);
  assert.deepEqual(requests,[full,full]);
  assert.match(content.innerHTML,/FINAL_57213/);
  assert.equal(button.classList.contains('failed'),false);
});

test('a stale failed request cannot clear the newer request loading state',async()=>{
  let failOld,finishNew;
  const {context,content,button,paint}=ui(async(_url,options)=>{
    const text=JSON.parse(options.body).text;
    return text==='Initial English text.'?new Promise((_resolve,reject)=>{failOld=()=>reject(new Error('old failure'));}):new Promise(resolve=>{finishNew=()=>resolve(response(text));});
  });
  paint('Initial English text.');
  const old=context.toggleBubbleTranslation(button,content,'Initial English text.');
  const full='Initial English text. This is the complete final paragraph.';
  paint(full);const latest=context.toggleBubbleTranslation(button,content,full);
  failOld();await old;
  assert.equal(button.classList.contains('loading'),true);
  assert.equal(button.classList.contains('failed'),false);
  finishNew();await latest;
  assert.match(content.innerHTML,/complete final paragraph/);
});
