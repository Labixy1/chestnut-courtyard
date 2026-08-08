(function(){
  if(window.CozyLog)return;
  const KEY='cozy_event_queue_v1';
  const API_ORIGIN=window.CozyRuntime?.apiBase ?? (location.protocol==='file:'?'http://127.0.0.1:8766':'');
  const READ_ONLY=!!window.CozyRuntime?.readOnly;
  let flushing=false;
  function read(){try{const data=JSON.parse(localStorage.getItem(KEY)||'[]');return Array.isArray(data)?data:[];}catch(e){return [];}}
  function write(items){if(READ_ONLY)return;try{localStorage.setItem(KEY,JSON.stringify(items.slice(-500)));}catch(e){}}
  function cleanDetail(detail){
    const out={};Object.entries(detail||{}).slice(0,20).forEach(([key,value])=>{
      if(/content|transcript|message|prompt|api.?key|token/i.test(key))return;
      if(value==null||typeof value==='function')return;
      out[key]=typeof value==='object'?JSON.stringify(value).slice(0,500):String(value).slice(0,500);
    });return out;
  }
  function event(context,action,detail={}){
    const item={id:'evt_'+Date.now().toString(36)+Math.random().toString(36).slice(2,8),ts:new Date().toISOString(),context:String(context||'page').slice(0,60),action:String(action||'event').slice(0,100),page:location.pathname||location.href,status:String(detail.status||'').slice(0,40),task_id:String(detail.task_id||'').slice(0,100),sensitivity:detail.sensitivity==='sealed'?'sealed':'personal',detail:cleanDetail(detail)};
    if(READ_ONLY)return item;
    const items=read();items.push(item);write(items);flush();return item;
  }
  async function flush(){
    if(READ_ONLY)return;
    if(flushing)return;const items=read();if(!items.length)return;flushing=true;
    try{
      const response=await fetch(API_ORIGIN+'/api/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({events:items.slice(0,100)}),keepalive:true});
      const data=await response.json().catch(()=>({}));if(!response.ok||!data.ok)throw new Error('ledger unavailable');
      write(read().filter(item=>!new Set((data.items||[]).map(saved=>saved.id)).has(item.id)));
    }catch(e){}finally{flushing=false;}
  }
  window.CozyLog={event,flush,pending:()=>read().length};
  window.addEventListener('online',flush);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')flush();});
  setTimeout(flush,500);
})();
