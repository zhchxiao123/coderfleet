// Platform assistant: a single, scoped entry separate from project conversations.
const PlatformAgent = (() => {
  let initialized = false, settings = {}, selected = '', timer = null, generation = 0;
  const pendingKey = 'cf-platform-pending-v1';
  const labels = {preparing:'准备数据',submitted:'已提交',pending:'排队中',running:'生成中',ready:'已完成',partial:'部分覆盖',error:'失败',cancelled:'已取消'};
  const kindLabels={question:'用户要求',reply:'模型回复',supplement:'插话',context:'跨日背景',agent_question:'模型提问',human_answer:'人工作答',approval:'权限决定'};
  const dateTime=(value,zone)=>new Intl.DateTimeFormat('zh-CN',{timeZone:zone,dateStyle:'short',timeStyle:'medium'}).format(new Date(value));
  const active = value => ['preparing','submitted','pending','running'].includes(value);
  const el = id => document.getElementById('platform-'+id);
  const message = text => { el('message').textContent = text; };
  async function api(path = '', options = {}) {
    const response = await fetch(API+'/api/platform'+path, {...options, headers:{'Content-Type':'application/json',...(options.headers||{})}});
    const value = await response.json();
    if (!response.ok) { const error = new Error(typeof value.detail === 'string' ? value.detail : JSON.stringify(value.detail)); error.status = response.status; throw error; }
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
  function body() {
    return {date:el('date').value,timezone:el('timezone').value.trim(),projects:[...el('projects').selectedOptions].map(option=>option.value),
      question:el('question').value.trim(),kind:el('question').value.trim()?'query':'daily'};
  }
  function request() { const value=body(); if (!value.projects.length) value.projects=null; return value; }
  function pending() { try { return JSON.parse(localStorage.getItem(pendingKey)||'null'); } catch { return null; } }
  function applyRequest(value) {
    el('date').value=value.date; el('timezone').value=value.timezone||settings.timezone;
    el('question').value=value.question;
    for (const option of el('projects').options) option.selected=(value.projects||[]).includes(option.value);
    updateSubmit();
  }
  function updateSubmit() { el('submit').textContent=pending()?'重试原提交':el('question').value.trim()?'查询当天记录':'生成日报'; }
  async function refreshRuns() {
    const records = await api('/runs');
    el('runs').replaceChildren();
    for (const record of records) {
      const button=document.createElement('button'); button.type='button'; button.setAttribute('aria-current',String(record.id===selected));
      button.textContent=record.date+' · '+(record.kind==='daily'?'日报':'查询')+' · '+(labels[record.status]||record.status);
      button.onclick=()=>select(record.id); el('runs').append(button);
    }
    if (!records.length) el('runs').textContent='暂无历史记录';
  }
  async function select(identifier) {
    selected=identifier; const token=++generation; clearTimeout(timer);
    try {
      const record=await api('/runs/'+encodeURIComponent(identifier));
      if (token!==generation) return;
      render(record); await refreshRuns();
      if (token!==generation || selected!==identifier) return;
      if (active(record.status)) timer=setTimeout(()=>{ if(currentPage==='digest') select(identifier); },2000);
    } catch(error) { if(token===generation) message(error.message); }
  }
  function render(record) {
    const root=el('result'); root.replaceChildren();
    const title=document.createElement('h3'); title.textContent=record.date+' · '+(record.kind==='daily'?'工作日报':'平台查询'); root.append(title);
    const state=document.createElement('p'); state.textContent=(labels[record.status]||record.status)+' · '+record.timezone; root.append(state);
    if(record.question) {const question=document.createElement('p');question.textContent=record.question;root.append(question);}
    const manifest=record.manifest, coverage=record.coverage||{};
    if(manifest) {
      const meta=document.createElement('p');meta.className='platform-muted';
      meta.textContent=manifest.coverage.tasks+' 个任务 · '+manifest.coverage.activities+' 条活动 · 截止 '+dateTime(manifest.window.as_of,record.timezone)+
        (coverage.total!==undefined?' · 工具已读取 '+coverage.read+'/'+coverage.total+' 条':'');root.append(meta);
    }
    const warnings=coverage.warnings||(manifest&&manifest.coverage.warnings)||[];
    if(warnings.length || coverage.estimated_timestamps) {
      const details=document.createElement('details'),summary=document.createElement('summary'),text=document.createElement('p');
      summary.textContent='数据覆盖说明';text.textContent=[...warnings,coverage.estimated_timestamps?coverage.estimated_timestamps+' 条历史活动时间为估计值':''].filter(Boolean).join('\n');details.append(summary,text);root.append(details);
    }
    if(record.error) {const error=document.createElement('p');error.textContent=record.error;root.append(error);}
    if(record.answer_markdown) {const answer=document.createElement('div');answer.className='markdown-body';answer.innerHTML=markdown(record.answer_markdown);root.append(answer);}
    if(record.sources.length) {
      const details=document.createElement('details'),summary=document.createElement('summary'),list=document.createElement('ol');
      summary.textContent='查看报告来源（'+record.sources.length+'）';list.className='platform-sources';
      for(const source of record.sources) {
        const item=document.createElement('li'),button=document.createElement('button'),content=document.createElement('pre');
        button.type='button';button.textContent=source.project_name+' · '+(kindLabels[source.kind]||source.kind)+' · '+source.task_id;content.hidden=true;
        button.onclick=async()=>{try {if(content.hidden){const row=await api('/runs/'+record.id+'/sources/'+encodeURIComponent(source.id));content.textContent=dateTime(row.at,record.timezone)+(row.time_estimated?'（估计时间）':'')+'\n'+row.text;}content.hidden=!content.hidden;}catch(error){message(error.message);}};
        item.append(button,content);list.append(item);
      } details.append(summary,list);root.append(details);
    }
    if(active(record.status)) {const cancel=document.createElement('button');cancel.type='button';cancel.className='btn';cancel.textContent='取消本次生成';cancel.onclick=async()=>{cancel.disabled=true;try{await api('/runs/'+record.id+'/cancel',{method:'POST'});await select(record.id);}catch(error){message(error.message);cancel.disabled=false;}};root.append(cancel);}
    if(record.task_id) {
      const details=document.createElement('details'),summary=document.createElement('summary'),log=document.createElement('pre');summary.textContent='执行日志';
      details.ontoggle=async()=>{if(details.open)try{const response=await fetch(API+'/api/tasks/'+encodeURIComponent(record.task_id)+'/logs?light=1');if(!response.ok)throw new Error('日志加载失败');log.textContent=await response.text();}catch(error){log.textContent=error.message;}};
      details.append(summary,log);root.append(details);
    }
  }
  async function submit(event) {
    event.preventDefault(); el('submit').disabled=true;
    let value=pending();
    if(value && JSON.stringify({...value,request_id:undefined})!==JSON.stringify({...request(),request_id:undefined})) {
      applyRequest(value);message('上一次提交结果尚未确认，已恢复原内容。再次点击会使用原请求 ID 安全重试。');el('submit').disabled=false;return;
    }
    if(!value) {value={...request(),request_id:crypto.randomUUID()};localStorage.setItem(pendingKey,JSON.stringify(value));}
    updateSubmit();message('正在准备所选日期的数据…');
    try {
      const record=await api('/runs',{method:'POST',body:JSON.stringify(value)});
      localStorage.removeItem(pendingKey);updateSubmit();message('已提交。报告的范围和截止时间会随快照保存。');await select(record.id);
    } catch(error) {
      if(error.status && error.status<500) localStorage.removeItem(pendingKey);
      updateSubmit();message(error.message+'；若连接结果不确定，重试会沿用原请求 ID。');
    } finally {el('submit').disabled=false;}
  }
  function syncOptions(node, values) {
    const chosen=new Set([...node.selectedOptions].map(option=>option.value));
    node.replaceChildren();
    for(const value of new Set([...values,...chosen])) {
      const option=document.createElement('option');option.value=value;
      option.textContent=value+(values.includes(value)?'':'（已不在当前列表）');option.selected=chosen.has(value);node.append(option);
    }
    if(!node.multiple && !chosen.size) node.value='';
  }
  async function init() {
    try {
      const info=await api(); settings=info.settings;
      if(!initialized) {
        initialized=true;
        el('timezone').value=settings.timezone;
        el('date').value=new Intl.DateTimeFormat('en-CA',{timeZone:settings.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
        for(const project of info.projects) {const option=document.createElement('option');option.value=project;option.textContent=project;el('projects').append(option);}
        for(const account of info.accounts) {const option=document.createElement('option');option.value=account;option.textContent=account;el('account').append(option);}
        for(const [field,key] of [['account','account'],['model','model'],['image','image'],['turns','max_turns'],['budget','max_budget_usd'],['auto-time','auto_time']]) el(field).value=settings[key];
        el('auto-state').textContent='自动日报'+(info.automatic_enabled?'已开启':'未开启')+'。日期按以上时区计算；保存设置不会开启定时执行。';
        el('question').oninput=updateSubmit; el('form').onsubmit=submit;
        el('preview').onclick=async()=>{try{const preview=await api('/preview',{method:'POST',body:JSON.stringify({...request(),request_id:'preview'})});message(preview.coverage.tasks+' 个任务，'+preview.coverage.activities+' 条活动，'+preview.projects.length+' 个项目；截止 '+preview.window.as_of+(preview.coverage.warnings.length?'；'+preview.coverage.warnings.length+' 条覆盖提醒':''));}catch(error){message(error.message);}};
        el('settings-form').onsubmit=async event=>{event.preventDefault();try {settings=await api('/settings',{method:'PUT',body:JSON.stringify({account:el('account').value,timezone:el('timezone').value.trim(),model:el('model').value.trim(),image:el('image').value.trim(),max_turns:Number(el('turns').value),max_budget_usd:Number(el('budget').value),auto_time:el('auto-time').value})});message('助手设置已保存。');}catch(error){message(error.message);}};
        const unfinished=pending(); if(unfinished) {applyRequest(unfinished);try {const record=await api('/requests?request_id='+encodeURIComponent(unfinished.request_id));localStorage.removeItem(pendingKey);selected=record.id;}catch(error){message(error.status===404?'上次提交未确认，可使用原内容重试。':error.message);}}
        updateSubmit();
      }
      syncOptions(el('projects'),info.projects);syncOptions(el('account'),info.accounts);
      el('auto-state').textContent='自动日报'+(info.automatic_enabled?'已开启':'未开启')+'。日期按以上时区计算；保存设置不会开启定时执行。';
      await refreshRuns();if(selected) await select(selected);
    } catch(error) {message('平台助手加载失败：'+error.message);}
  }
  return {init,markdown};
})();
function initPlatformAgent(){return PlatformAgent.init();}
