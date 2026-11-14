// Platform conversations combine frozen read-only evidence with explicit MCP connections.
const PlatformAgent = (() => {
  const pendingKey='cf-platform-pending-v1', draftKey='cf-platform-drafts-v2', selectedKey='cf-platform-selected-v2';
  const states={preparing:'正在准备资料…',submitted:'正在准备资料…',pending:'正在排队…',running:'正在整理资料…',ready:'已完成',partial:'部分覆盖',error:'生成失败',cancelled:'已停止'};
  const kinds={platform_reply:'平台回复',question:'用户要求',reply:'模型回复',supplement:'插话',context:'跨日背景',agent_question:'模型提问',human_answer:'人工作答',approval:'权限决定'};
  const el=id=>document.getElementById('platform-'+id);
  const active=value=>['preparing','submitted','pending','running'].includes(value);
  const dateTime=(value,zone)=>new Intl.DateTimeFormat('zh-CN',{timeZone:zone,dateStyle:'short',timeStyle:'medium'}).format(new Date(value));
  let initialized=false, connections={}, settings={}, selected='', messages=[], generation=0, listGeneration=0, timer=null, posting=false, opening=false;
  function stored(key,fallback){try{return JSON.parse(localStorage.getItem(key))||fallback;}catch{return fallback;}}
  function pending(){return stored(pendingKey,null);}
  function tell(text){el('message').textContent=text;}
  function scope(){return {date:el('date').value,timezone:el('timezone').value.trim(),projects:[...el('projects').selectedOptions].map(o=>o.value)};}
  function saveDraft(){if(!initialized||pending())return;const drafts=stored(draftKey,{});drafts[selected||'new']={...scope(),question:el('question').value};localStorage.setItem(draftKey,JSON.stringify(drafts));}
  function restoreScope(value){
    el('date').value=value.date;el('timezone').value=value.timezone||settings.timezone;
    const options=[...el('projects').options];
    for(const name of value.projects||[])if(!options.some(o=>o.value===name)){const option=new Option(name,name);el('projects').append(option);}
    for(const option of el('projects').options)option.selected=(value.projects||[]).includes(option.value);
  }
  function restoreDraft(){const draft=stored(draftKey,{})[selected||'new'];el('question').value=draft?.question||'';if(draft&&!selected)restoreScope(draft);}
  function clearSubmittedDraft(previous,kind='query'){const drafts=stored(draftKey,{});if(kind!=='daily')delete drafts[previous||'new'];localStorage.setItem(draftKey,JSON.stringify(drafts));el('question').value='';}
  async function api(path='',options={}){
    const response=await fetch(API+'/api/platform'+path,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});
    let value;try{value=await response.json();}catch{const error=new Error('服务返回异常，请查询原请求后重试');error.status=response.status;throw error;}
    if(!response.ok){const error=new Error(typeof value.detail==='string'?value.detail:JSON.stringify(value.detail));error.status=response.status;throw error;}
    return value;
  }
  function markdown(text) {
    // The historical content is untrusted. Strip raw HTML/attributes before insertion.
    const doc = new DOMParser().parseFromString(marked.parse(text||''),'text/html');
    const allowed = new Set(['P','BR','STRONG','EM','DEL','CODE','PRE','BLOCKQUOTE','UL','OL','LI','H1','H2','H3','H4','H5','H6','HR','TABLE','THEAD','TBODY','TR','TH','TD','A']);
    for (const node of [...doc.body.querySelectorAll('*')]) {
      if (!allowed.has(node.tagName)) { node.remove(); continue; }
      const href = node.tagName === 'A' ? node.getAttribute('href') : null;
      for (const attr of [...node.attributes]) node.removeAttribute(attr.name);
      if (href && /^https?:\/\//i.test(href)) { node.setAttribute('href',href); node.setAttribute('target','_blank'); node.setAttribute('rel','noopener noreferrer'); }
    }
    return doc.body.innerHTML;
  }
  function updateComposer(){
    el('question').style.height='auto';el('question').style.height=Math.min(el('question').scrollHeight,180)+'px';
    el('question').readOnly=!!pending()||opening;
    const last=messages.at(-1), running=last&&active(last.status), waiting=!!pending();
    for(const name of ['date','timezone','projects'])el(name).disabled=!!messages.length||waiting;
    const button=el('submit');button.type=running?'button':'submit';button.onclick=running?cancel:null;
    button.disabled=opening||posting||(!running&&!waiting&&!el('question').value.trim());
    button.title=button.getAttribute('aria-label')||'发送';
    button.setAttribute('aria-label',running?'停止生成':waiting?'重试原提交':'发送');button.title=button.getAttribute('aria-label');
    button.innerHTML=running?'<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 7-7 7 7M12 5v14"/></svg>';
    el('daily').disabled=posting||waiting||opening;
    const value=scope(),range=last?.manifest;el('scope-label').textContent=(range?.start_date&&range.start_date!==range.end_date?range.start_date+' ～ '+range.end_date:value.date)+' · '+(value.projects?.length?value.projects.length+' 个项目':'全部项目');
    el('context-note').textContent=waiting?'提交状态尚未确认，原消息已保留；确认后可继续输入':last?.manifest?'资料截止 '+dateTime(last.manifest.window.as_of,last.timezone)+' · 可直接追问其他日期范围或要求刷新资料':'回顾平台记录，或通过已接入的 MCP 查询和保存内容';
  }
  function scrollBottom(){el('scroll').scrollTop=el('scroll').scrollHeight;}
  function welcome(){
    const root=el('result');root.replaceChildren();const wrap=document.createElement('div');wrap.className='platform-welcome';
    const mark=document.createElement('div');mark.className='platform-welcome-mark';mark.textContent='CF';
    const title=document.createElement('h3');title.textContent='今天，想了解些什么？';
    const note=document.createElement('p');note.textContent='项目进展、待办和关键决策，都可以在这里聊；也可通过已接入的 MCP 查询资料、保存整理结果。';
    const suggestions=document.createElement('div');suggestions.className='platform-suggestions';
    for(const [label,question] of [['生成工作日报',''],['看看未完成事项','有哪些未完成的事项？'],['需要我确认什么','有哪些问题还需要我确认？']]){
      const button=document.createElement('button');button.type='button';button.textContent=label;
      button.onclick=()=>{if(question){el('question').value=question;saveDraft();updateComposer();el('question').focus();}else daily();};suggestions.append(button);
    }
    wrap.append(mark,title,note,suggestions);root.append(wrap);
  }
  function detailsFor(record){
    const details=document.createElement('details'),summary=document.createElement('summary'),coverage=record.coverage||{},manifest=record.manifest;
    summary.textContent=(record.sources.length||coverage.read?'来源 '+record.sources.length:'执行详情')+(coverage.retrieval?' · 按需读取 '+coverage.read+' 条':coverage.total!==undefined?' · 已读取 '+coverage.read+'/'+coverage.total:'')+(record.status==='partial'?' · 部分覆盖':'')+(coverage.inherited_citations?' · 沿用 '+coverage.inherited_citations+' 条历史引用':'');details.append(summary);
    const metadata=document.createElement('p');metadata.textContent=(manifest?.start_date&&manifest.start_date!==manifest.end_date?manifest.start_date+' ～ '+manifest.end_date:record.date)+' · '+record.timezone+(record.mcp_servers?.length?' · MCP：'+record.mcp_servers.join('、'):'')+(manifest?' · 截止 '+dateTime(manifest.window.as_of,record.timezone):'');details.append(metadata);
    const warnings=coverage.warnings||manifest?.coverage.warnings||[];
    if(warnings.length||coverage.estimated_timestamps){const note=document.createElement('p');note.textContent=[...warnings,coverage.estimated_timestamps?coverage.estimated_timestamps+' 条旧记录的时间为估计值':''].filter(Boolean).join('；');details.append(note);}
    const list=document.createElement('ol');list.className='platform-sources';
    for(const source of record.sources){
      const item=document.createElement('li'),button=document.createElement('button'),text=document.createElement('pre');button.type='button';text.hidden=true;
      button.textContent=source.project_name+' · '+(kinds[source.kind]||source.kind)+' · '+source.task_id;
      button.onclick=async()=>{try{if(text.hidden){const value=await api('/runs/'+record.id+'/sources/'+encodeURIComponent(source.id));text.textContent=dateTime(value.at,record.timezone)+(value.time_estimated?'（估计时间）':'')+'\n'+value.text;}text.hidden=!text.hidden;}catch(error){tell(error.message);}};
      item.append(button,text);list.append(item);
    }
    details.append(list);
    for(const call of record.tool_calls||[]){const note=document.createElement('p');note.textContent=call.name+' · '+({completed:'已执行',failed:'失败',pending:'缺少完成回执'}[call.status]||call.status);details.append(note);}
    if(record.task_id){
      const logs=document.createElement('details'),label=document.createElement('summary'),text=document.createElement('pre');label.textContent='执行日志';
      logs.ontoggle=async()=>{if(logs.open)try{const response=await fetch(API+'/api/tasks/'+encodeURIComponent(record.task_id)+'/logs?light=1');if(!response.ok)throw new Error('日志加载失败');text.textContent=await response.text();}catch(error){text.textContent=error.message;}};
      logs.append(label,text);details.append(logs);
    }
    return details;
  }
  function turn(record){
    const article=document.createElement('article');article.className='platform-turn';article.dataset.runId=record.id;
    const user=document.createElement('div'),question=document.createElement('p');user.className='platform-user';question.textContent=record.question||'生成 '+record.date+' 的工作日报';user.append(question);
    const assistant=document.createElement('div'),avatar=document.createElement('div'),answer=document.createElement('div');assistant.className='platform-assistant';avatar.className='platform-avatar';avatar.textContent='CF';avatar.setAttribute('aria-label','平台助手');answer.className='platform-answer';
    const process=PlatformProcess.view(record,active(record.status));if(process)answer.append(process);
    if(record.answer_markdown){const content=document.createElement('div');content.className='markdown-body';content.innerHTML=markdown(record.answer_markdown);answer.append(content);}
    else {const status=document.createElement('p');status.className='platform-turn-status';status.setAttribute('role','status');if(active(record.status)){const dot=document.createElement('span');dot.className='platform-activity-dot';dot.setAttribute('aria-hidden','true');status.append(dot);}const progress=record.progress;
      const label=active(record.status)&&Number.isInteger(progress?.read)&&Number.isInteger(progress?.total)?(progress.mode==='retrieval'?'已检索 '+progress.read+' 条资料 · 正在处理…':'已读取 '+progress.read+'/'+progress.total+' 条活动 · '+(progress.phase==='composing'?'正在整理回答…':'继续读取中…')):(states[record.status]||record.status);
      status.append(document.createTextNode(label));answer.append(status);}
    if(record.error){const error=document.createElement('p');error.textContent=record.error;answer.append(error);}
    if(!active(record.status))answer.append(detailsFor(record));
    assistant.append(avatar,answer);article.append(user,assistant);return article;
  }
  async function refreshRuns(){
    const token=++listGeneration,records=await api('/runs?summary=true');if(token!==listGeneration)return;
    const groups=new Map();for(const record of records)if(!groups.has(record.root_run_id||record.id))groups.set(record.root_run_id||record.id,record);
    el('runs').replaceChildren();
    for(const [root,latest] of groups){
      const first=records.find(record=>record.id===root)||latest,button=document.createElement('button'),caption=document.createElement('small');button.type='button';
      button.setAttribute('aria-current',String((messages[0]?.id||selected)===root));button.append(document.createTextNode((first.question||'工作日报').slice(0,38)));
      caption.textContent=latest.date+' · '+(states[latest.status]||latest.status);button.append(caption);button.onclick=()=>openThread(latest.id);el('runs').append(button);
    }
    if(!groups.size){const note=document.createElement('p');note.className='platform-muted';note.textContent='发送第一条消息，开始新的对话';el('runs').append(note);}
  }
  function schedulePoll(token){clearTimeout(timer);timer=setTimeout(()=>{if(currentPage==='digest'&&token===generation)poll(token);},1500);}
  async function poll(token){
    const identifier=selected;
    try{
      const record=await api('/runs/'+encodeURIComponent(identifier));if(token!==generation||selected!==identifier)return;
      const nearBottom=el('scroll').scrollHeight-el('scroll').scrollTop-el('scroll').clientHeight<120;
      messages[messages.length-1]=record;const node=el('result').lastElementChild;if(node)node.replaceWith(turn(record));
      updateComposer();if(nearBottom)scrollBottom();await refreshRuns();
      if(token!==generation||selected!==identifier)return;if(active(record.status))schedulePoll(token);
    }catch(error){if(token===generation){tell('连接暂时中断，正在重新查询这条消息的状态。');schedulePoll(token);}}
  }
  async function openThread(identifier,{submitted=false}={}){
    if(pending()&&!submitted){tell('上一条提交尚未确认，请先重试原消息或刷新查询。');return;}
    if(!submitted)saveDraft();PlatformProcess.release();const token=++generation;clearTimeout(timer);opening=true;updateComposer();
    try{
      const records=await api('/runs/'+encodeURIComponent(identifier)+'/thread');if(token!==generation)return;
      selected=identifier;messages=records;localStorage.setItem(selectedKey,identifier);el('agent').classList.remove('show-history');el('history-toggle').setAttribute('aria-expanded','false');
      restoreScope(records.at(-1));restoreDraft();el('result').replaceChildren(...records.map(turn));updateComposer();scrollBottom();await refreshRuns();
      if(token===generation&&active(records.at(-1).status))schedulePoll(token);
    }catch(error){if(token===generation){tell(error.message);if(messages.at(-1)?.id===identifier&&active(messages.at(-1).status))schedulePoll(token);}}
    finally{if(token===generation){opening=false;updateComposer();}}
  }
  function startNew(date){
    if(pending()){tell('上一条提交尚未确认，请先重试原消息或刷新查询。');return false;}
    saveDraft();PlatformProcess.release();++generation;opening=false;clearTimeout(timer);selected='';messages=[];localStorage.removeItem(selectedKey);restoreDraft();if(date)el('date').value=date;
    el('agent').classList.remove('show-history');el('history-toggle').setAttribute('aria-expanded','false');tell('');welcome();updateComposer();refreshRuns().catch(error=>tell(error.message));el('question').focus();return true;
  }
  function acknowledge(record){
    if(messages.at(-1)?.id===record.id)messages[messages.length-1]=record;
    else if(record.parent_run_id&&messages.at(-1)?.id===record.parent_run_id)messages.push(record);
    else messages=[record];
    selected=record.id;localStorage.setItem(selectedKey,record.id);restoreScope(record);
    el('result').replaceChildren(...messages.map(turn));updateComposer();scrollBottom();
  }
  async function submit(kind='query'){
    if(posting||opening)return;if(messages.length&&active(messages.at(-1).status)){tell('请等待当前回复结束后再发送。');return;}
    let value=pending();
    if(!value){
      const selectedScope=scope(),question=kind==='daily'?'':el('question').value.trim();if(kind==='query'&&!question)return;
      if(!selectedScope.date||!selectedScope.timezone){el('more').open=true;tell('请先填写日期和时区。');return;}
      value={...selectedScope,projects:selectedScope.projects.length?selectedScope.projects:null,kind,question,request_id:crypto.randomUUID()};if(selected)value.parent_run_id=selected;
      localStorage.setItem(pendingKey,JSON.stringify(value));
    }else{restoreScope(value);el('question').value=value.question;}
    const previous=selected;posting=true;tell('');updateComposer();
    try{
      const record=await api('/runs',{method:'POST',body:JSON.stringify(value)});acknowledge(record);localStorage.removeItem(pendingKey);el('more').open=false;clearSubmittedDraft(previous,value.kind);await openThread(record.id,{submitted:true});
    }catch(error){
      if(error.status>=400&&error.status<500)localStorage.removeItem(pendingKey);
      tell(error.message+(pending()?'；点击发送会使用原请求安全重试。':''));
      if(error.status===409)refreshRuns().catch(()=>{});
    }finally{posting=false;updateComposer();}
  }
  async function daily(){if(pending()||posting||opening)return;const clickedScope=scope();if(selected&&!startNew())return;restoreScope(clickedScope);await submit('daily');}
  async function cancel(){
    if(!selected||posting)return;posting=true;updateComposer();const identifier=selected,token=generation;
    try{await api('/runs/'+identifier+'/cancel',{method:'POST'});if(token===generation)await poll(token);}catch(error){tell(error.message);}finally{posting=false;updateComposer();}
  }
  function syncOptions(node,values){
    const chosen=new Set([...node.selectedOptions].map(option=>option.value));node.replaceChildren();
    for(const value of new Set([...values,...chosen])){const option=new Option(value+(values.includes(value)?'':'（已不在当前列表）'),value);option.selected=chosen.has(value);node.append(option);}
    if(!node.multiple&&!chosen.size)node.value='';
  }
  function syncConnections(){
    const node=el('mcp');node.replaceChildren();
    for(const item of connections[el('account').value]||[]){const option=new Option(item.name+(item.supported?'':'（暂不支持该连接方式）'),item.name);option.disabled=!item.supported;option.selected=settings.account===el('account').value&&(settings.mcp_servers||[]).includes(item.name);node.append(option);}
  }
  async function init(){
    try{
      const info=await api();settings=info.settings;connections=info.connections||{};
      if(!initialized){
        el('timezone').value=settings.timezone;el('date').value=new Intl.DateTimeFormat('en-CA',{timeZone:settings.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
        for(const project of info.projects)el('projects').append(new Option(project,project));for(const account of info.accounts)el('account').append(new Option(account,account));
        for(const [field,key] of [['account','account'],['model','model'],['image','image'],['turns','max_turns'],['budget','max_budget_usd'],['auto-time','auto_time']])el(field).value=settings[key];
        syncConnections();el('account').onchange=syncConnections;
        initialized=true;restoreDraft();welcome();
        el('form').onsubmit=event=>{event.preventDefault();submit();};el('daily').onclick=daily;
        el('question').oninput=()=>{saveDraft();updateComposer();};el('question').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();el('form').requestSubmit();}};
        for(const field of ['date','timezone','projects'])el(field).onchange=()=>{saveDraft();updateComposer();};
        el('new').onclick=()=>startNew();el('new-mobile').onclick=()=>startNew();
        el('history-toggle').onclick=()=>{const shown=el('agent').classList.toggle('show-history');el('history-toggle').setAttribute('aria-expanded',String(shown));};
        el('preview').onclick=async()=>{try{const value=scope(),preview=messages.at(-1)?.manifest||await api('/preview',{method:'POST',body:JSON.stringify({...value,projects:value.projects.length?value.projects:null,request_id:'preview'})});tell(preview.coverage.tasks+' 个任务 · '+preview.coverage.activities+' 条活动 · 截止 '+dateTime(preview.window.as_of,preview.timezone)+(preview.coverage.warnings.length?' · '+preview.coverage.warnings.length+' 条覆盖提醒':''));}catch(error){tell(error.message);}};
        el('settings-form').onsubmit=async event=>{event.preventDefault();try{settings=await api('/settings',{method:'PUT',body:JSON.stringify({account:el('account').value,mcp_servers:[...el('mcp').selectedOptions].map(option=>option.value),timezone:el('timezone').value.trim(),model:el('model').value.trim(),image:el('image').value.trim(),max_turns:Number(el('turns').value),max_budget_usd:Number(el('budget').value),auto_time:el('auto-time').value})});tell('助手设置已保存。');}catch(error){tell(error.message);}};
        const unfinished=pending();if(unfinished){restoreScope(unfinished);el('question').value=unfinished.question;try{const record=await api('/requests?request_id='+encodeURIComponent(unfinished.request_id));acknowledge(record);localStorage.removeItem(pendingKey);clearSubmittedDraft(unfinished.parent_run_id||'',unfinished.kind);await openThread(record.id,{submitted:true});}catch(error){tell(error.status===404?'上次消息提交尚未确认，可沿用原请求重试。':error.message);}}
        else{const previous=localStorage.getItem(selectedKey);if(previous)await openThread(previous);}
      }else if(selected&&!pending()){await openThread(selected);}
      syncOptions(el('projects'),info.projects);syncOptions(el('account'),info.accounts);el('auto-state').textContent='自动日报'+(info.automatic_enabled?'已开启':'未开启')+'。保存这些设置不会开启自动执行。';
      updateComposer();await refreshRuns();if(selected&&messages.length&&active(messages.at(-1).status))schedulePoll(generation);
    }catch(error){tell('平台助手加载失败：'+error.message);}
  }
  function deactivate(){if(initialized)saveDraft();++generation;opening=false;clearTimeout(timer);PlatformProcess.release();}
  return {init,markdown,startNew,deactivate};
})();
function initPlatformAgent(){return PlatformAgent.init();}
