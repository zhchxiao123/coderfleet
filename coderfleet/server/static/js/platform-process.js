// Reuse the ordinary chat renderer and authenticated Task SSE stream.
const PlatformProcess = (() => {
  const runs=new Map();
  function release(){
    for(const state of runs.values()){state.closed=true;clearTimeout(state.timer);state.source?.close();state.renderer._resetSDKRendering();}
    runs.clear();
  }
  function filter(state,line){
    let value;try{value=JSON.parse(line);}catch{return null;}
    if(value.type==='result'||value.subtype==='coderfleet_event_clock'||value.subtype==='coderfleet_platform_progress')return null;
    if(value.type==='stream_event'){
      const event=value.event||{};
      if(event.type==='content_block_start'&&event.content_block?.name==='StructuredOutput')state.hidden.add(event.index);
      if(state.hidden.has(event.index)){if(event.type==='content_block_stop')state.hidden.delete(event.index);return null;}
      if(event.type==='message_start')state.hidden.clear();
    }
    if(value.type==='assistant'&&Array.isArray(value.message?.content)){
      value.message={...value.message,content:value.message.content.filter(block=>!(block.type==='tool_use'&&block.name==='StructuredOutput'))};
      if(!value.message.content.length)return null;
    }
    return JSON.stringify(value);
  }
  function deduplicate(state){
    if(state.answer&&state.renderer.lastSDKText?.trim()===state.answer.trim())state.renderer.lastBubbleEl?.remove();
  }
  function start(state){
    if(state.started||state.closed||state.complete||currentPage!=='digest')return;clearTimeout(state.timer);if(state.replay)state.renderer.render('','claude');state.started=true;state.replay=true;
    const source=new EventSource(sseUrl(API+'/api/tasks/'+encodeURIComponent(state.taskId)+'/logs/stream?tail=1000000'));
    state.source=source;
    source.onmessage=event=>{
      if(state.closed)return;
      if(event.data==='[DONE]'){state.complete=true;source.close();state.source=null;state.renderer.isRunning=false;state.renderer.deactivatePendingInterventions();deduplicate(state);return;}
      const line=filter(state,event.data);if(line)state.renderer.push(line);deduplicate(state);
    };
    source.onerror=()=>{source.close();state.source=null;state.started=false;if(state.closed||state.complete)return;state.timer=setTimeout(()=>{if(state.wrap.open||state.renderer.isRunning)start(state);},1000);};
  }
  function view(record,running){
    if(!record.task_id||currentPage!=='digest')return null;
    let state=runs.get(record.id);
    if(!state){
      const wrap=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('div');
      wrap.className='platform-process';summary.textContent='执行过程';body.className='platform-process-body';wrap.append(summary,body);wrap.open=running;
      const renderer=new ChatLogRenderer(body,running,false,null,record.task_id);renderer.renderPending();
      state={wrap,renderer,taskId:record.task_id,source:null,hidden:new Set(),started:false,answer:''};runs.set(record.id,state);
      wrap.ontoggle=()=>{if(wrap.open)start(state);};
    }
    state.answer=record.answer_markdown;state.renderer.isRunning=running;
    if(running||state.wrap.open)start(state);deduplicate(state);return state.wrap;
  }
  return {view,release};
})();
