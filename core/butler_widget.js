(function(){
  if(window.CozyButler) return;
  const RUNTIME=window.CozyRuntime||{mode:'dev',readOnly:false,apiBase:location.protocol==='file:'?'http://127.0.0.1:8766':''};
  const API_ORIGIN=RUNTIME.apiBase;
  const HISTORY_KEY=RUNTIME.mode==='preview'?'cozy_preview_butler_history':'cozy_global_butler_history';
  const STATE_KEYS=['cozy_blackboard_answers','cozy_blackboard_directions','cozy_orchard_seeds','cozy_orchard_topics','cozy_orchard_garden','cozy_orchard_backpack','cozy_orchard_growth_events','cozy_notice_requests','cozy_trips','cozy_trip_reflections','cozy_heart_entries','cozy_hollow_buried_media','cozy_memory_events','cozy_global_butler_history','cozy_toolbox_local_items','cozy_notice_links','cozy_notice_chest','cozy_butler_watch_topics','cozy_butler_local_sources','cozy_photo_albums'];
  let busy=false;
  let activeDictation=null;
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
      if(cleaned.length!==items.length)localStorage.setItem(HISTORY_KEY,JSON.stringify(cleaned));
      return cleaned;
    }catch(e){return [];}
  }
  function save(items){localStorage.setItem(HISTORY_KEY,JSON.stringify(items.slice(-30)));}
  function localValues(){const out={};STATE_KEYS.forEach(key=>{try{out[key]=JSON.parse(localStorage.getItem(key)||'null');}catch(e){}});return out;}
  async function syncLocalState(){
    if(RUNTIME.readOnly)return;
    try{
      const data=await api('/api/local-state'),remoteState=data.state||{},remote=remoteState.values||{},local=localValues(),next={};
      const initialized=!!remoteState.updated_at;
      const previousHistory=localStorage.getItem(HISTORY_KEY)||'';
      STATE_KEYS.forEach(key=>{
        const hasRemote=Object.prototype.hasOwnProperty.call(remote,key);
        next[key]=initialized&&hasRemote?remote[key]:local[key];
        if(next[key]!=null)localStorage.setItem(key,JSON.stringify(next[key]));
      });
      const missing={};STATE_KEYS.forEach(key=>{if(!Object.prototype.hasOwnProperty.call(remote,key)&&next[key]!=null)missing[key]=next[key];});
      if(Object.keys(missing).length)await api('/api/local-state',{values:missing},12000);
      if((localStorage.getItem(HISTORY_KEY)||'')!==previousHistory)render();
      window.dispatchEvent(new CustomEvent('cozy:state-synced'));
    }catch(e){}
  }
  async function persistLocal(keys){
    if(RUNTIME.readOnly)return;
    const values={};(keys||STATE_KEYS).forEach(key=>{if(!STATE_KEYS.includes(key))return;try{const value=JSON.parse(localStorage.getItem(key)||'null');if(value!=null)values[key]=value;}catch(e){}});
    if(!Object.keys(values).length)return;
    try{await api('/api/local-state',{values},12000);}catch(e){}
  }
  function api(path,payload,timeout=900000){
    if(RUNTIME.readOnly&&payload!==undefined)return Promise.reject(new Error('当前是公开预览，只能浏览，数据不会写入'));
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
    const options=payload===undefined?{signal:controller.signal}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:controller.signal};
    if(path!=='/api/events')window.CozyLog?.event('api','request',{path,method:payload===undefined?'GET':'POST'});
    return fetch(API_ORIGIN+path,options).then(async response=>{let data={};try{data=await response.json();}catch(e){}if(!response.ok||!data.ok){if(path!=='/api/events')window.CozyLog?.event('api','failed',{path,status:response.status});throw new Error(data.error||'阿栗执行失败');}if(path!=='/api/events')window.CozyLog?.event('api','completed',{path,status:response.status,task_id:data.task_id||data.task?.id||''});return data;}).finally(()=>clearTimeout(timer));
  }
  function createDictation(options){
    const input=options.input;
    let mode='idle',transport='',recognition=null,pollTimer=0,sessionId='',baseText='',runId=0;
    const tell=(next,message)=>{mode=next;options.onState?.(next,message||'');};
    const mergeText=spoken=>{
      const clean=String(spoken||'').trim();
      const joiner=baseText&&clean&&!/[\s\n]$/.test(baseText)?' ':'';
      input.value=baseText+joiner+clean;
      input.dispatchEvent(new Event('input',{bubbles:true}));
      options.onTranscript?.(clean,input.value);
    };
    const finish=(message,error=false)=>{
      clearTimeout(pollTimer);pollTimer=0;recognition=null;transport='';sessionId='';
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
    function startBrowser(id){
      const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
      if(!SR){finish('语音输入需要先启动栗壳小院本地服务',true);return;}
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
    .cozy-butler-messages{overflow:auto;padding:16px;display:flex;flex-direction:column;gap:10px}.cozy-butler-msg{max-width:88%;padding:10px 12px;border-radius:14px;font-size:13px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}.cozy-butler-msg.owner{align-self:flex-end;background:#7d6754;color:#fff}.cozy-butler-msg.butler{align-self:flex-start;background:#f3e7d5;border:1px solid rgba(104,74,45,.1)}.cozy-butler-msg.system{align-self:stretch;max-width:none;background:#fff6df;color:#79623e;font-size:12px}.cozy-butler-tools{margin-top:7px;padding-top:7px;border-top:1px solid rgba(104,74,45,.12);font-size:11px;color:#786653}
    .cozy-butler-compose{padding:12px;border-top:1px solid rgba(104,74,45,.12);background:#fffaf3}.cozy-butler-compose-inner{position:relative}.cozy-butler-compose textarea{width:100%;min-height:76px;max-height:160px;resize:vertical;border:1px solid rgba(104,74,45,.2);border-radius:13px;padding:10px 94px 10px 11px;background:#fff;font:13px/1.55 inherit;color:#45372c;outline:none}.cozy-butler-compose textarea:focus{border-color:#a98560;box-shadow:0 0 0 3px rgba(169,133,96,.12)}.cozy-butler-send,.cozy-butler-mic{position:absolute;bottom:9px;width:34px;height:34px;display:grid;place-items:center;padding:0;border:0;border-radius:50%;line-height:0;cursor:pointer;transition:background .16s ease,color .16s ease,transform .16s ease,box-shadow .16s ease}.cozy-butler-send{right:9px;background:#856a52;color:#fff}.cozy-butler-mic{right:51px;background:rgba(128,101,77,.1);color:#80654d}.cozy-butler-icon{display:block;width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}.cozy-butler-send .cozy-butler-icon{width:17px;height:17px;transform:translate(-.5px,.5px)}.cozy-butler-send:hover{background:#725740;box-shadow:0 4px 10px rgba(83,58,37,.18)}.cozy-butler-mic:hover{background:rgba(128,101,77,.17)}.cozy-butler-send:active,.cozy-butler-mic:active{transform:scale(.94)}.cozy-butler-mic.active{background:#9f584f;color:#fff;box-shadow:0 0 0 4px rgba(159,88,79,.12)}.cozy-butler-send:disabled,.cozy-butler-mic:disabled{opacity:.38;cursor:default}.cozy-butler-hint{font-size:10px;color:#9a8674;margin-top:6px;min-height:15px}body.has-global-butler #butler .who{cursor:pointer}body.has-global-butler #butler .who:focus-visible{outline:2px solid #fff2c8;outline-offset:4px}body.has-global-butler .back{left:76px;top:16px;height:46px;display:flex;align-items:center;padding-top:0;padding-bottom:0}#butler .butler-online-state{display:inline-flex;align-items:center;gap:4px;margin-left:6px;font-size:9px;font-weight:500;color:rgba(255,248,232,.74)}#butler .butler-online-state:before{content:"";width:6px;height:6px;border-radius:50%;background:#aaa092}#butler .butler-online-state.online:before{background:#78bb7d;box-shadow:0 0 0 2px rgba(120,187,125,.16)}#butler .butler-online-state.offline:before{background:#d07777}@media(max-width:520px){.cozy-butler-drawer{left:8px;right:8px;top:8px;bottom:8px;width:auto;border-radius:14px}.cozy-butler-launcher{left:12px;top:12px}body.has-global-butler .back{left:68px;top:12px}}`;
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
    render();refreshStatus();syncLocalState();if(!RUNTIME.readOnly)setInterval(syncLocalState,60000);
  }
  function open(){document.querySelector('.cozy-butler-drawer')?.classList.add('open');document.getElementById('cozy-butler-input')?.focus();refreshStatus();}
  function close(){if(butlerDictation?.isActive())butlerDictation.stop();document.querySelector('.cozy-butler-drawer')?.classList.remove('open');}
  function setState(v){const n=document.getElementById('cozy-butler-state');if(n)n.textContent=v;}
  function setHint(v){const n=document.getElementById('cozy-butler-hint');if(n)n.textContent=v||'';}
  let butlerDictation=null;
  function toggleButlerVoice(){
    if(busy)return;const input=document.getElementById('cozy-butler-input'),mic=document.querySelector('.cozy-butler-mic'),sendButton=document.querySelector('.cozy-butler-send');
    if(!butlerDictation)butlerDictation=createDictation({input,onState:(state,message)=>{const active=state==='starting'||state==='listening'||state==='stopping';mic?.classList.toggle('active',active);mic?.setAttribute('aria-pressed',String(active));mic?.setAttribute('aria-label',active?'停止语音输入':'语音输入');if(sendButton)sendButton.disabled=busy||active;setHint(message);if(state==='listening')setState('正在听');if(state==='idle'){if(input.value.trim())input.focus();refreshStatus();}if(state==='error'){setState('语音输入未启动');setTimeout(refreshStatus,1800);}}});
    butlerDictation.toggle();
  }
  function append(role,text,tools){const box=document.getElementById('cozy-butler-messages');if(!box)return;const item=document.createElement('div');item.className='cozy-butler-msg '+role;item.innerHTML=esc(friendlyText(text))+(tools&&tools.length?'<div class="cozy-butler-tools">'+tools.map(x=>esc(friendlyText((x.ok?'完成：':'未完成：')+(x.summary||x.tool)))).join('<br>')+'</div>':'');box.appendChild(item);box.scrollTop=box.scrollHeight;}
  function shortGreeting(){const hour=new Date().getHours();if(hour<11)return '早上好，今天想先做什么？';if(hour<18)return '下午好，想让我先做什么？';return '晚上好，今天想从哪里开始？';}
  function render(){const box=document.getElementById('cozy-butler-messages');if(!box)return;box.innerHTML='';const items=history();if(!items.length)append('butler',shortGreeting());else items.slice(-12).forEach(item=>append(item.role,item.text,item.tools));}
  function setHomepageStatus(status,label){const badge=document.querySelector('#butler .butler-online-state');if(!badge)return;badge.className='butler-online-state '+status;badge.textContent=label;}
  async function refreshStatus(){const launcher=document.querySelector('.cozy-butler-launcher');if(RUNTIME.readOnly){launcher?.classList.remove('online','steward');setHomepageStatus('','预览');setState('公开预览 · 不读取私人数据');return;}try{const data=await api('/api/status');launcher?.classList.add('online');launcher?.classList.toggle('steward',!!data.steward_mode);setHomepageStatus('online','在线');setState(data.steward_mode?'掌院权限已开启 · 永久':'普通权限 · 已连接');}catch(e){launcher?.classList.remove('online','steward');setHomepageStatus('offline','未连接');setState('服务未连接');}}
  async function send(){
    if(busy||butlerDictation?.isActive())return;const input=document.getElementById('cozy-butler-input'),button=document.querySelector('.cozy-butler-send'),mic=document.querySelector('.cozy-butler-mic'),text=(input?.value||'').trim();if(!text){setHint('先告诉阿栗一件事。');return;}
    busy=true;if(button)button.disabled=true;if(mic)mic.disabled=true;if(input)input.value='';append('owner',text);setState('正在理解和执行');setHint('复杂系统修改会先快照，再验证。');const items=history();items.push({role:'owner',text,date:new Date().toISOString()});save(items);
    if(window.CozyMemory)CozyMemory.add({source:'butler',type:'owner_command',layer:'short',weight:2,content:text,summary:'交给阿栗：'+text.slice(0,100)});
    try{const data=await api('/api/assistant',{message:text,context:{page:location.pathname,title:document.title,conversation:items.slice(-8)}});append('butler',data.reply,data.tool_results||[]);items.push({role:'butler',text:data.reply,tools:data.tool_results||[],date:new Date().toISOString()});save(items);if(data.tool_results?.length)await syncLocalState();setState('已完成');setHint(data.tool_results?.length?'执行结果已记录，页面数据已同步。':'已回复。');window.dispatchEvent(new CustomEvent('cozy:butler-complete',{detail:data}));}
    catch(error){append('system','没有完成：'+error.message);items.push({role:'system',text:'没有完成：'+error.message,date:new Date().toISOString()});save(items);setState('执行失败');setHint('阿栗没有伪装成功，可以修改后重试。');}
    finally{busy=false;if(button)button.disabled=false;if(mic)mic.disabled=false;refreshStatus();}
  }
  window.CozyButler={open,close,send,refreshStatus,api,persistLocal,syncLocalState,createDictation};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();
