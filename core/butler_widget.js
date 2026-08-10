(function(){
  if(window.CozyButler) return;
  const RUNTIME=window.CozyRuntime||{mode:'dev',readOnly:false,apiBase:location.protocol==='file:'?'http://127.0.0.1:8766':''};
  const API_ORIGIN=RUNTIME.apiBase;
  const HISTORY_KEY=RUNTIME.mode==='preview'?'cozy_preview_butler_history':'cozy_global_butler_history';
  const SYNC_META_KEY='cozy_sync_shadow_v2';
  const RUNNING_TASK_TIMEOUT=3*60*1000;
  const STATE_KEYS=['cozy_blackboard_answers','cozy_blackboard_directions','cozy_blackboard_starred','cozy_orchard_seeds','cozy_orchard_topics','cozy_orchard_garden','cozy_orchard_backpack','cozy_orchard_growth_events','cozy_orchard_chat_sessions','cozy_notice_requests','cozy_notice_notes','cozy_trips','cozy_trip_reflections','cozy_heart_entries','cozy_heart_deleted_entries','cozy_hollow_buried_media','cozy_memory_events','cozy_global_butler_history','cozy_toolbox_local_items','cozy_notice_links','cozy_notice_chest','cozy_butler_watch_topics','cozy_butler_local_sources','cozy_photo_albums','cozy_courtyard_hidden_scenes'];
  let busy=false;
  let activeDictation=null;
  let syncQueue=Promise.resolve();
  function esc(v){return String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function isProfilePermissionError(value){return /Operation not permitted[\s\S]*user_profile\.yaml/i.test(String(value||''));}
  function isLegacyIntro(value){return String(value||'').trim().startsWith('当前能力：');}
  function friendlyText(value){
    const text=String(value||'');
    if(isProfilePermissionError(text))return '系统配置刚才没有读到，阿栗已经处理，不需要你重新操作。';
    return text.replace(/\/Users\/[^\s'"，。]+/g,'本地配置文件');
  }
  function history(){
    try{
      const raw=JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]'),items=Array.isArray(raw)?raw:[];
      const cleaned=items.filter((item,index)=>{
        if(isLegacyIntro(item.text)||isProfilePermissionError(item.text))return false;
        return !(item.role==='owner'&&isProfilePermissionError(items[index+1]?.text));
      });
      let changed=cleaned.length!==items.length;
      cleaned.forEach(item=>{if(item.status==='completed'&&(item.tools||[]).some(tool=>tool&&!tool.ok)){item.role='failed';item.status='failed';changed=true;}});
      if(changed)localStorage.setItem(HISTORY_KEY,JSON.stringify(cleaned));
      return cleaned;
    }catch(e){return [];}
  }
  function save(items){localStorage.setItem(HISTORY_KEY,JSON.stringify(items.slice(-40)));if(!RUNTIME.readOnly)persistLocal([HISTORY_KEY]);}
  function localValues(){const out={};STATE_KEYS.forEach(key=>{try{const raw=localStorage.getItem(key);if(raw!==null)out[key]=JSON.parse(raw);}catch(e){}});return out;}
  function stableStringify(value){
    if(Array.isArray(value))return '['+value.map(stableStringify).join(',')+']';
    if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stableStringify(value[key])).join(',')+'}';
    return JSON.stringify(value);
  }
  function syncRecordId(item){
    if(item===null||typeof item!=='object')return 'value:'+JSON.stringify(item);
    for(const key of ['id','key','url','link','source_url','questionId','question_id'])if(item[key]!==undefined&&item[key]!==null&&String(item[key]).trim())return key+':'+String(item[key]).trim();
    if(item.date||item.title)return 'dated:'+String(item.date||'')+'|'+String(item.title||'');
    return 'json:'+stableStringify(item);
  }
  function syncDescriptor(value){
    if(Array.isArray(value)){const records={};value.forEach(item=>{records[syncRecordId(item)]=stableStringify(item);});return{type:'array',hash:stableStringify(value),records};}
    if(value&&typeof value==='object'){const records={};Object.entries(value).forEach(([key,item])=>{records[key]=stableStringify(item);});return{type:'object',hash:stableStringify(value),records};}
    return{type:'value',hash:stableStringify(value),records:{}};
  }
  function syncMeta(){try{const value=JSON.parse(localStorage.getItem(SYNC_META_KEY)||'{}');return value&&typeof value==='object'?value:{};}catch(_error){return {};}}
  function buildSyncChange(value,shadow){
    const current=syncDescriptor(value),before=shadow||{type:current.type,records:{}};
    if(current.type==='array'){
      const upserts=value.filter(item=>before.records?.[syncRecordId(item)]!==stableStringify(item));
      const revive=upserts.map(syncRecordId).filter(id=>!Object.prototype.hasOwnProperty.call(before.records||{},id));
      const ids=new Set(value.map(syncRecordId)),deleted=Object.keys(before.records||{}).filter(id=>!ids.has(id));
      return{type:'array',upserts,deleted,revive};
    }
    if(current.type==='object'){
      const upserts={};Object.entries(value||{}).forEach(([key,item])=>{if(before.records?.[key]!==stableStringify(item))upserts[key]=item;});
      const revive=Object.keys(upserts).filter(key=>!Object.prototype.hasOwnProperty.call(before.records||{},key));
      const deleted=Object.keys(before.records||{}).filter(key=>!Object.prototype.hasOwnProperty.call(value||{},key));
      return{type:'object',upserts,deleted,revive};
    }
    return{type:'value',value};
  }
  async function runLocalSync(requestedKeys){
    if(RUNTIME.readOnly)return;
    try{
      const local=localValues(),before={};STATE_KEYS.forEach(key=>{before[key]=syncDescriptor(local[key]);});
      const data=await api('/api/local-state'),remoteState=data.state||{},remote=remoteState.values||{},meta=syncMeta();
      const initialized=!!remoteState.updated_at;
      const previousHistory=localStorage.getItem(HISTORY_KEY)||'';
      const keys=meta.initialized?(requestedKeys?.length?requestedKeys:STATE_KEYS):STATE_KEYS;
      let finalState=remoteState;
      if(!meta.initialized){
        const missing={};keys.forEach(key=>{if(!Object.prototype.hasOwnProperty.call(remote,key)&&Object.prototype.hasOwnProperty.call(local,key))missing[key]=local[key];});
        if(Object.keys(missing).length)finalState=(await api('/api/local-state',{values:missing},12000)).state||remoteState;
      }else{
        const changes={};keys.forEach(key=>{const current=before[key],shadow=meta.fields?.[key];if(current.hash!==shadow?.hash)changes[key]=buildSyncChange(local[key],shadow);});
        if(Object.keys(changes).length)finalState=(await api('/api/local-state',{changes},12000)).state||remoteState;
      }
      const finalValues=finalState.values||{};
      meta.initialized=true;meta.fields=meta.fields||{};meta.updated_at=finalState.updated_at||new Date().toISOString();
      keys.forEach(key=>{
        const currentRaw=localStorage.getItem(key),currentValue=currentRaw===null?undefined:(()=>{try{return JSON.parse(currentRaw);}catch(_error){return undefined;}})();
        if(syncDescriptor(currentValue).hash!==before[key].hash)return;
        if(Object.prototype.hasOwnProperty.call(finalValues,key)){localStorage.setItem(key,JSON.stringify(finalValues[key]));meta.fields[key]=syncDescriptor(finalValues[key]);}
        else if(!initialized&&Object.prototype.hasOwnProperty.call(local,key))meta.fields[key]=syncDescriptor(local[key]);
      });
      localStorage.setItem(SYNC_META_KEY,JSON.stringify(meta));
      if((localStorage.getItem(HISTORY_KEY)||'')!==previousHistory)render();
      window.dispatchEvent(new CustomEvent('cozy:state-synced'));
    }catch(e){}
  }
  function syncLocalState(keys){syncQueue=syncQueue.catch(()=>{}).then(()=>runLocalSync(keys));return syncQueue;}
  async function reconcileRunningTasks(){
    if(RUNTIME.readOnly)return;
    const items=history(),running=items.filter(item=>item.status==='running'||(item.status==='failed'&&String(item.text||'').startsWith('无法执行：任务没有在限定时间内')));if(!running.length)return;
    try{
      const data=await api('/api/tasks',undefined,10000),tasks=Array.isArray(data.tasks)?data.tasks:[];
      running.forEach(item=>{
        const started=Date.parse(item.date||''),ownerIndex=items.indexOf(item)-1,ownerText=ownerIndex>=0&&items[ownerIndex]?.role==='owner'?String(items[ownerIndex].text||''):'';
        const task=tasks.find(candidate=>ownerText&&String(candidate.instruction||'')===ownerText);
        if(task&&task.status==='completed'){item.role='butler';item.status='completed';item.text=task.message||'已经完成。';item.tools=task.tool_results||[];item.date=task.updated_at||new Date().toISOString();}
        else if(task&&task.status==='failed'){item.role='failed';item.status='failed';item.text='无法执行：'+(task.message||'系统修改没有完成。');item.tools=task.tool_results||[];item.date=task.updated_at||new Date().toISOString();}
        else if(!task&&Number.isFinite(started)&&Date.now()-started>RUNNING_TASK_TIMEOUT){item.role='failed';item.status='failed';item.text='无法执行：没有找到仍在运行的任务，已停止等待。';item.date=new Date().toISOString();}
      });
      save(items);render();
    }catch(_error){let changed=false;running.forEach(item=>{const started=Date.parse(item.date||'');if(item.status==='running'&&Number.isFinite(started)&&Date.now()-started>RUNNING_TASK_TIMEOUT){item.role='failed';item.status='failed';item.text='无法执行：任务没有在限定时间内完成，已停止等待。';item.date=new Date().toISOString();changed=true;}});if(changed)save(items);render();}
  }
  async function persistLocal(keys){
    if(RUNTIME.readOnly)return;
    return syncLocalState((keys||STATE_KEYS).filter(key=>STATE_KEYS.includes(key)));
  }
  function api(path,payload,timeout=900000){
    if(RUNTIME.readOnly&&payload!==undefined)return Promise.reject(new Error('当前是公开预览，只能浏览，数据不会写入'));
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
    const options=payload===undefined?{signal:controller.signal}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:controller.signal};
    if(path!=='/api/events')window.CozyLog?.event('api','request',{path,method:payload===undefined?'GET':'POST'});
    return fetch(API_ORIGIN+path,options).then(async response=>{let data={};try{data=await response.json();}catch(e){}if(!response.ok||!data.ok){if(path!=='/api/events')window.CozyLog?.event('api','failed',{path,status:response.status});throw new Error(data.error||data.reply||'阿栗执行失败');}if(path!=='/api/events')window.CozyLog?.event('api','completed',{path,status:response.status,task_id:data.task_id||data.task?.id||''});return data;}).finally(()=>clearTimeout(timer));
  }
  function createDictation(options){
    const input=options.input;
    let mode='idle',transport='',recognition=null,recorder=null,mediaStream=null,pollTimer=0,sessionId='',baseText='',runId=0;
    const tell=(next,message)=>{mode=next;options.onState?.(next,message||'');};
    const mergeText=spoken=>{
      const clean=String(spoken||'').trim();
      const joiner=baseText&&clean&&!/[\s\n]$/.test(baseText)?' ':'';
      input.value=baseText+joiner+clean;
      input.dispatchEvent(new Event('input',{bubbles:true}));
      options.onTranscript?.(clean,input.value);
    };
    const finish=(message,error=false)=>{
      clearTimeout(pollTimer);pollTimer=0;recognition=null;recorder=null;if(mediaStream){mediaStream.getTracks().forEach(track=>track.stop());mediaStream=null;}transport='';sessionId='';
      if(activeDictation===controller)activeDictation=null;
      tell(error?'error':'idle',message);
    };
    const phaseMessage=state=>{
      if(state.phase==='requesting_microphone')return '请允许栗壳小院使用麦克风';
      if(state.phase==='requesting_permission')return '请允许栗壳小院使用语音识别';
      if(state.phase==='stopping')return '正在整理最后一句';
      if(state.ready)return '正在听，点一下停止';
      return '正在准备麦克风';
    };
    async function pollNative(id){
      if(id!==runId||transport!=='native')return;
      try{
        const state=await api('/api/voice/status',undefined,6000);
        if(id!==runId||transport!=='native')return;
        if(sessionId&&state.session_id&&state.session_id!==sessionId)throw new Error('语音会话已被另一处接管');
        if(state.transcript!=null)mergeText(state.transcript);
        if(state.error){finish(state.error,true);return;}
        if(!state.active){finish(input.value.trim()?'语音已转成文字':'这次没有听到内容');return;}
        tell(state.ready?'listening':'starting',phaseMessage(state));
        pollTimer=setTimeout(()=>pollNative(id),280);
      }catch(error){finish(error.message||'语音连接中断',true);}
    }
    async function startRecorder(id){
      if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){finish('当前浏览器不支持语音输入，请换用 Safari 或 Chrome 最新版',true);return;}
      try{
        mediaStream=await navigator.mediaDevices.getUserMedia({audio:true});
        if(id!==runId){mediaStream.getTracks().forEach(track=>track.stop());return;}
        const chunks=[];transport='recorder';recorder=new MediaRecorder(mediaStream);
        recorder.ondataavailable=event=>{if(event.data?.size)chunks.push(event.data);};
        recorder.onerror=()=>{if(id===runId)finish('录音没有启动，请检查麦克风权限',true);};
        recorder.onstop=async()=>{
          if(id!==runId)return;
          try{
            const blob=new Blob(chunks,{type:recorder?.mimeType||'audio/webm'}),form=new FormData();
            form.append('file',blob,blob.type.includes('mp4')?'voice.m4a':'voice.webm');
            const response=await fetch(API_ORIGIN+'/api/voice/transcribe',{method:'POST',body:form}),data=await response.json().catch(()=>({}));
            if(!response.ok||!data.ok)throw new Error(data.error||'语音转文字失败');
            mergeText(data.transcript||'');finish(data.transcript?'语音已转成文字':'这次没有听到内容');
          }catch(error){finish(error.message||'语音转文字失败',true);}
        };
        recorder.start(250);tell('listening','正在听，点一下停止');
      }catch(error){finish(error?.name==='NotAllowedError'?'请允许浏览器使用麦克风':'麦克风没有启动，请稍后重试',true);}
    }
    function startBrowser(id){
      const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
      if(!SR){startRecorder(id);return;}
      transport='browser';recognition=new SR();recognition.lang='zh-CN';recognition.continuous=true;recognition.interimResults=true;
      recognition.onstart=()=>{if(id===runId)tell('listening','正在听，点一下停止');};
      recognition.onresult=event=>{let spoken='';for(let i=0;i<event.results.length;i+=1)spoken+=event.results[i][0].transcript;if(id===runId)mergeText(spoken);};
      recognition.onerror=event=>{if(id!==runId)return;const message=event.error==='not-allowed'?'请允许浏览器使用麦克风':'没有听清，请再试一次';finish(message,true);};
      recognition.onend=()=>{if(id===runId&&mode!=='idle'&&mode!=='error')finish(input.value.trim()?'语音已转成文字':'这次没有听到内容');};
      recognition.start();
    }
    async function start(){
      if(mode!=='idle'&&mode!=='error')return;
      if(activeDictation&&activeDictation!==controller){tell('error','另一处正在使用麦克风');return;}
      activeDictation=controller;baseText=input.value;runId+=1;const id=runId;tell('starting','正在准备麦克风');
      try{
        const state=await api('/api/voice/start',{},70000);
        if(id!==runId){await api('/api/voice/stop',{},8000).catch(()=>{});return;}
        transport='native';sessionId=state.session_id||'';pollNative(id);
      }catch(error){
        if(id!==runId)return;
        startBrowser(id);
      }
    }
    async function stop(){
      if(mode==='idle'||mode==='error')return;
      const id=runId;tell('stopping','正在整理最后一句');clearTimeout(pollTimer);
      if(transport==='browser'&&recognition){recognition.stop();return;}
      if(transport==='recorder'&&recorder){recorder.stop();return;}
      if(transport==='native'){
        try{const state=await api('/api/voice/stop',{},9000);if(id!==runId)return;if(state.transcript!=null)mergeText(state.transcript);finish(input.value.trim()?'语音已转成文字':'这次没有听到内容');}
        catch(error){finish(error.message||'停止语音失败',true);}
        return;
      }
      runId+=1;finish('已停止');
    }
    const controller={start,stop,toggle:()=>mode==='idle'||mode==='error'?start():stop(),isActive:()=>mode!=='idle'&&mode!=='error'};
    return controller;
  }
  function installStyles(){
    const prefix=location.pathname.includes('/pages/')?'../':'';
    const style=document.createElement('style');
    style.textContent=`
    .cozy-butler-launcher{position:fixed;left:16px;top:16px;z-index:90;width:46px;height:46px;border:0;border-radius:50%;padding:0;background:#fff8ec url("${prefix}assets/estate/butler_dog.webp") center/116% no-repeat;box-shadow:0 8px 24px rgba(51,35,22,.2);cursor:pointer}
    .cozy-butler-drawer{position:fixed;left:16px;top:16px;bottom:16px;z-index:100;width:min(390px,calc(100vw - 32px));display:none;grid-template-rows:auto 1fr auto;background:rgba(255,251,244,.97);color:#45372c;border:1px solid rgba(104,74,45,.18);border-radius:18px;box-shadow:0 24px 70px rgba(37,25,17,.3);overflow:hidden;backdrop-filter:blur(14px);font-family:"PingFang SC","Microsoft YaHei",sans-serif}.cozy-butler-drawer.open{display:grid}.cozy-butler-head{display:flex;align-items:center;gap:10px;padding:13px 14px;background:#f4e7d4;border-bottom:1px solid rgba(104,74,45,.12)}.cozy-butler-avatar{width:36px;height:36px;border-radius:50%;background:url("${prefix}assets/estate/butler_dog.webp") center/116% no-repeat;flex:0 0 auto}.cozy-butler-title{min-width:0;flex:1}.cozy-butler-title strong{display:block;font-size:14px}.cozy-butler-state{display:block;font-size:11px;color:#887361;margin-top:2px}.cozy-butler-close{width:34px;height:34px;border:0;border-radius:50%;background:rgba(255,255,255,.55);font-size:20px;color:#735f4d;cursor:pointer}
    .cozy-butler-messages{overflow:auto;padding:16px;display:flex;flex-direction:column;gap:10px}.cozy-butler-history-label{align-self:center;font-size:10px;color:#a08b77;margin:1px 0 2px}.cozy-butler-msg{max-width:88%;padding:10px 12px;border-radius:14px;font-size:13px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}.cozy-butler-msg.owner{align-self:flex-end;background:#7d6754;color:#fff}.cozy-butler-msg.butler{align-self:flex-start;background:#f3e7d5;border:1px solid rgba(104,74,45,.1)}.cozy-butler-msg.system{align-self:stretch;max-width:none;background:#fff6df;color:#79623e;font-size:12px}.cozy-butler-msg.running{align-self:stretch;max-width:none;background:#f8f0df;color:#806843;border:1px dashed rgba(149,113,64,.22)}.cozy-butler-msg.failed{align-self:stretch;max-width:none;background:#fff0ec;color:#925d52}.cozy-butler-msg.completed{border-left:3px solid #829260}.cozy-butler-result-state{display:flex;align-items:center;gap:6px;margin-bottom:5px;font-size:9px;font-weight:650;color:#718155}.cozy-butler-result-state.running{color:#8b7048}.cozy-butler-result-state.failed{color:#a35f52}.cozy-butler-result-state.running:before{content:"";width:8px;height:8px;border:2px solid rgba(128,104,67,.25);border-top-color:#8b7048;border-radius:50%;animation:cozySpin .8s linear infinite}.cozy-butler-result-state.completed:before{content:"✓"}.cozy-butler-result-state.failed:before{content:"×"}.cozy-butler-meta{margin-top:5px;font-size:9px;color:rgba(109,88,67,.55)}.cozy-butler-msg.owner .cozy-butler-meta{color:rgba(255,255,255,.58)}.cozy-butler-tools{margin-top:7px;padding-top:7px;border-top:1px solid rgba(104,74,45,.12);font-size:11px;color:#786653}.cozy-butler-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}.cozy-butler-actions button{border:1px solid rgba(118,88,57,.16);border-radius:8px;background:#fffaf0;color:#72583f;padding:6px 9px;font-family:inherit;font-size:10px;cursor:pointer}.cozy-butler-actions button.primary{background:#806448;color:#fff;border-color:#806448}@keyframes cozySpin{to{transform:rotate(360deg)}}
    .cozy-butler-compose{padding:12px;border-top:1px solid rgba(104,74,45,.12);background:#fffaf3}.cozy-butler-compose-inner{position:relative}.cozy-butler-compose textarea{width:100%;min-height:76px;max-height:160px;resize:vertical;border:1px solid rgba(104,74,45,.2);border-radius:13px;padding:10px 94px 10px 11px;background:#fff;font-family:inherit;font-size:12px;line-height:1.6;color:#45372c;outline:none}.cozy-butler-compose textarea::placeholder{font-size:12px;color:#9a8a7b}.cozy-butler-compose textarea:focus{border-color:#a98560;box-shadow:0 0 0 3px rgba(169,133,96,.12)}.cozy-butler-send,.cozy-butler-mic{position:absolute;bottom:9px;width:34px;height:34px;display:grid;place-items:center;padding:0;border:0;border-radius:50%;line-height:0;cursor:pointer;transition:background .16s ease,color .16s ease,transform .16s ease,box-shadow .16s ease}.cozy-butler-send{right:9px;background:#856a52;color:#fff}.cozy-butler-mic{right:51px;background:rgba(128,101,77,.1);color:#80654d}.cozy-butler-icon{display:block;width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}.cozy-butler-send .cozy-butler-icon{width:17px;height:17px;transform:translate(-.5px,.5px)}.cozy-butler-send:hover{background:#725740;box-shadow:0 4px 10px rgba(83,58,37,.18)}.cozy-butler-mic:hover{background:rgba(128,101,77,.17)}.cozy-butler-send:active,.cozy-butler-mic:active{transform:scale(.94)}.cozy-butler-mic.active{background:#9f584f;color:#fff;box-shadow:0 0 0 4px rgba(159,88,79,.12)}.cozy-butler-send:disabled,.cozy-butler-mic:disabled{opacity:.38;cursor:default}.cozy-butler-hint{font-size:10px;color:#9a8674;margin-top:6px;min-height:15px}body.has-global-butler #butler .who{cursor:pointer}body.has-global-butler #butler .who:focus-visible{outline:2px solid #fff2c8;outline-offset:4px}body.has-global-butler .back{left:76px;top:16px;height:46px;display:flex;align-items:center;padding-top:0;padding-bottom:0}#butler .butler-online-state{display:inline-flex;align-items:center;gap:4px;margin-left:6px;font-size:9px;font-weight:500;color:rgba(255,248,232,.74)}#butler .butler-online-state:before{content:"";width:6px;height:6px;border-radius:50%;background:#aaa092}#butler .butler-online-state.online:before{background:#78bb7d;box-shadow:0 0 0 2px rgba(120,187,125,.16)}#butler .butler-online-state.offline:before{background:#d07777}@media(max-width:520px){.cozy-butler-drawer{left:8px;right:8px;top:8px;bottom:8px;width:auto;border-radius:14px}.cozy-butler-compose textarea{font-size:16px}.cozy-butler-compose textarea::placeholder{font-size:13px}.cozy-butler-launcher{left:12px;top:12px}body.has-global-butler .back{left:68px;top:12px}}`;
    document.head.appendChild(style);
  }
  function install(){
    installStyles();document.body.classList.add('has-global-butler');
    const launcher=document.createElement('button');launcher.className='cozy-butler-launcher';launcher.type='button';launcher.setAttribute('aria-label','叫阿栗');launcher.title='叫阿栗';
    const drawer=document.createElement('aside');drawer.className='cozy-butler-drawer';drawer.setAttribute('aria-label','阿栗任务抽屉');drawer.innerHTML='<header class="cozy-butler-head"><span class="cozy-butler-avatar"></span><div class="cozy-butler-title"><strong>管家 · 阿栗</strong><span class="cozy-butler-state" id="cozy-butler-state">正在连接</span></div><button class="cozy-butler-close" type="button" aria-label="关闭">×</button></header><div class="cozy-butler-messages" id="cozy-butler-messages"></div><footer class="cozy-butler-compose"><div class="cozy-butler-compose-inner"><textarea id="cozy-butler-input" placeholder="告诉阿栗要做什么……"></textarea><button class="cozy-butler-mic" type="button" aria-label="语音输入" title="语音输入" aria-pressed="false"><svg class="cozy-butler-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" x2="12" y1="19" y2="22"></line><line x1="8" x2="16" y1="22" y2="22"></line></svg></button><button class="cozy-butler-send" type="button" aria-label="发送" title="发送"><svg class="cozy-butler-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"></path><path d="M22 2 11 13"></path></svg></button></div><div class="cozy-butler-hint" id="cozy-butler-hint"></div></footer>';
    document.body.append(launcher,drawer);
    const main=document.querySelector('#butler .who');
    if(main){launcher.style.display='none';main.tabIndex=0;main.setAttribute('role','button');main.setAttribute('aria-label','叫阿栗');main.addEventListener('click',open);main.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}});}
    launcher.addEventListener('click',open);drawer.querySelector('.cozy-butler-close').addEventListener('click',close);drawer.querySelector('.cozy-butler-send').addEventListener('click',send);drawer.querySelector('.cozy-butler-mic').addEventListener('click',toggleButlerVoice);drawer.querySelector('textarea').addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();send();}});
    if(RUNTIME.readOnly){
      const input=drawer.querySelector('textarea'),sendButton=drawer.querySelector('.cozy-butler-send'),micButton=drawer.querySelector('.cozy-butler-mic');
      input.placeholder='公开预览只展示功能，不保存或处理私人内容';input.disabled=true;sendButton.disabled=true;micButton.disabled=true;
      setHint('体验模式开放后，访客会获得独立的临时空间。');
    }
    render();refreshStatus();syncLocalState().finally(reconcileRunningTasks);if(!RUNTIME.readOnly)setInterval(syncLocalState,60000);
    window.addEventListener('cozy:demo-activation',refreshStatus);
  }
  function open(){document.querySelector('.cozy-butler-drawer')?.classList.add('open');refreshStatus();}
  function close(){if(butlerDictation?.isActive())butlerDictation.stop();document.querySelector('.cozy-butler-drawer')?.classList.remove('open');}
  function setState(v){const n=document.getElementById('cozy-butler-state');if(n)n.textContent=v;}
  function setHint(v){const n=document.getElementById('cozy-butler-hint');if(n)n.textContent=v||'';}
  let butlerDictation=null;
  function toggleButlerVoice(){
    if(busy)return;const input=document.getElementById('cozy-butler-input'),mic=document.querySelector('.cozy-butler-mic'),sendButton=document.querySelector('.cozy-butler-send');
    if(!butlerDictation)butlerDictation=createDictation({input,onState:(state,message)=>{const active=state==='starting'||state==='listening'||state==='stopping';mic?.classList.toggle('active',active);mic?.setAttribute('aria-pressed',String(active));mic?.setAttribute('aria-label',active?'停止语音输入':'语音输入');if(sendButton)sendButton.disabled=busy||active;setHint(message);if(state==='listening')setState('正在听');if(state==='idle')refreshStatus();if(state==='error'){setState('语音输入未启动');setTimeout(refreshStatus,1800);}}});
    butlerDictation.toggle();
  }
  function needsRefresh(tools){return (tools||[]).some(item=>item.ok&&['modify_system','build_skill'].includes(String(item.tool||item.name||'')));}
  function append(role,text,tools,meta={}){const box=document.getElementById('cozy-butler-messages');if(!box)return;const item=document.createElement('div');item.className='cozy-butler-msg '+role+(meta.status?' '+meta.status:'');const time=meta.date?new Date(meta.date).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'',stateLabel=meta.status==='running'?'正在执行':meta.status==='failed'?'执行失败':meta.status==='completed'?'已完成':'';item.innerHTML=(stateLabel?'<div class="cozy-butler-result-state '+meta.status+'">'+stateLabel+'</div>':'')+esc(friendlyText(text))+(tools&&tools.length?'<div class="cozy-butler-tools">'+tools.map(x=>esc(friendlyText((x.ok?'完成：':'未完成：')+(x.summary||x.tool)))).join('<br>')+'</div>':'')+(time?'<div class="cozy-butler-meta">'+esc(time)+'</div>':'')+(needsRefresh(tools)?'<div class="cozy-butler-actions"><button class="primary" onclick="location.reload()">刷新后生效</button></div>':'');box.appendChild(item);box.scrollTop=box.scrollHeight;}
  function shortGreeting(){const hour=new Date().getHours();if(hour<11)return '早上好，今天想先做什么？';if(hour<18)return '下午好，想让我先做什么？';return '晚上好，今天想从哪里开始？';}
  function render(){const box=document.getElementById('cozy-butler-messages');if(!box)return;box.innerHTML='';const items=history();if(!items.length){append('butler',shortGreeting());return;}const label=document.createElement('div');label.className='cozy-butler-history-label';label.textContent='最近 '+Math.min(items.length,40)+' 条记录';box.appendChild(label);items.slice(-40).forEach(item=>append(item.role,item.text,item.tools,item));}
  function setHomepageStatus(status,label){const badge=document.querySelector('#butler .butler-online-state');if(!badge)return;badge.className='butler-online-state '+status;badge.textContent=label;}
  function setComposeLocked(locked,message){const input=document.getElementById('cozy-butler-input'),send=document.querySelector('.cozy-butler-send'),mic=document.querySelector('.cozy-butler-mic');if(input){input.disabled=locked;input.placeholder=locked?(message||'阿栗暂未开放体验'):'告诉阿栗要做什么……';}if(send)send.disabled=locked;if(mic)mic.disabled=locked;}
  async function refreshStatus(){const launcher=document.querySelector('.cozy-butler-launcher');if(RUNTIME.readOnly){launcher?.classList.remove('online','steward');setHomepageStatus('','预览');setState('公开预览 · 不读取私人数据');return;}try{const data=await api('/api/status');if(data.demo&&!data.demo.active){launcher?.classList.remove('online','steward');setHomepageStatus('','待开放');setState('演示版 · 阿栗暂未激活');setComposeLocked(true,'主人开放体验后即可和阿栗聊天');return;}setComposeLocked(false);launcher?.classList.add('online');launcher?.classList.toggle('steward',!!data.steward_mode);setHomepageStatus('online',data.demo?'体验中':'在线');setState(data.demo?'演示体验已开放':(data.steward_mode?'掌院权限已开启 · 永久':'普通权限 · 已连接'));}catch(e){launcher?.classList.remove('online','steward');setHomepageStatus('offline','未连接');setState('服务未连接');}}
  async function send(){
    if(busy||butlerDictation?.isActive())return;const input=document.getElementById('cozy-butler-input'),button=document.querySelector('.cozy-butler-send'),mic=document.querySelector('.cozy-butler-mic'),text=(input?.value||'').trim();if(!text){setHint('先告诉阿栗一件事。');return;}
    busy=true;if(button)button.disabled=true;if(mic)mic.disabled=true;if(input)input.value='';const items=history(),startedAt=new Date().toISOString(),taskId='local_'+Date.now().toString(36);items.push({role:'owner',text,date:startedAt});items.push({role:'running',status:'running',taskId,text:'阿栗正在执行这件事，离开后回来也可以继续查看。',date:startedAt});save(items);render();setState('正在执行');setHint('任务已经记录，可以放心离开这个页面。');
    if(window.CozyMemory)CozyMemory.add({source:'butler',type:'owner_command',layer:'short',weight:2,content:text,summary:'交给阿栗：'+text.slice(0,100)});
    try{const data=await api('/api/assistant',{message:text,context:{page:location.pathname,title:document.title,conversation:items.filter(item=>item.role!=='running').slice(-8)}},RUNNING_TASK_TIMEOUT);const runningIndex=items.findIndex(item=>item.taskId===taskId);if(runningIndex>=0)items.splice(runningIndex,1);const tools=data.tool_results||[],failed=data.ok===false||tools.some(item=>!item.ok),status=failed?'failed':'completed';items.push({role:failed?'failed':'butler',status,text:data.reply,tools,date:new Date().toISOString()});save(items);render();if(tools.length)await syncLocalState();setState(failed?'执行失败':'执行成功');setHint(failed?'修改没有生效，失败原因和执行记录已保留。':(needsRefresh(tools)?'系统修改已完成，点击回复里的“刷新后生效”。':(tools.length?'执行结果已保存。':'已回复。')));window.dispatchEvent(new CustomEvent('cozy:butler-complete',{detail:data}));}
    catch(error){const runningIndex=items.findIndex(item=>item.taskId===taskId);if(runningIndex>=0)items.splice(runningIndex,1);const timedOut=error?.name==='AbortError';items.push({role:'failed',status:'failed',text:timedOut?'无法执行：任务超过 3 分钟仍未完成，已停止等待。':'无法执行：'+error.message,date:new Date().toISOString()});save(items);render();setState('执行失败');setHint('修改没有生效，失败原因已保留。');}
    finally{busy=false;if(button)button.disabled=false;if(mic)mic.disabled=false;setTimeout(refreshStatus,3500);}
  }
  window.CozyButler={open,close,send,refreshStatus,api,persistLocal,syncLocalState,createDictation};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();
