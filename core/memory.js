(function(){
  const EVENT_KEY = 'cozy_memory_events';
  const SERVER_KEY = 'cozy_memory_server_cache';
  const API_ORIGIN = window.CozyRuntime?.apiBase ?? (location.protocol === 'file:' ? 'http://127.0.0.1:8766' : '');
  const READ_ONLY = !!window.CozyRuntime?.readOnly;

  function pad(n){ return String(n).padStart(2,'0'); }
  function stamp(){
    const d = new Date();
    return {
      date: d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()),
      time: pad(d.getHours())+':'+pad(d.getMinutes())
    };
  }
  function readJson(key, fallback){
    try{ return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
    catch(e){ return fallback; }
  }
  function writeJson(key, value){
    if(READ_ONLY)return;
    localStorage.setItem(key, JSON.stringify(value));
  }
  function clean(str){
    return String(str || '').replace(/\s+/g,' ').trim();
  }
  function short(str, max=90){
    const s = clean(str);
    return s.length > max ? s.slice(0,max) + '...' : s;
  }
  function add(event){
    const now = stamp();
    const item = Object.assign({
      id: 'mem_' + Date.now() + '_' + Math.random().toString(16).slice(2),
      date: now.date,
      time: now.time,
      source: 'unknown',
      type: 'note',
      layer: 'short',
      content: '',
      summary: '',
      weight: 1,
      private: true
    }, event || {});
    item.content = clean(item.content);
    item.summary = clean(item.summary || item.content);
    if(!READ_ONLY){
      const list = readJson(EVENT_KEY, []);
      list.unshift(item);
      writeJson(EVENT_KEY, list.slice(0,500));
      persist(item);
    }
    return item;
  }
  function forget(id){
    const key=String(id||'').trim();
    if(READ_ONLY||!key)return false;
    writeJson(EVENT_KEY,all().filter(item=>String(item.id||'')!==key));
    writeJson(SERVER_KEY,readJson(SERVER_KEY,[]).filter(item=>String(item.id||'')!==key));
    fetch(API_ORIGIN+'/api/memory/action',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'forget',id:key})
    }).catch(()=>{});
    return true;
  }
  function persist(item){
    if(READ_ONLY)return;
    fetch(API_ORIGIN + '/api/memory/event',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event:item})
    }).catch(()=>{});
  }
  async function hydrate(){
    if(READ_ONLY)return [];
    try{
      const response = await fetch(API_ORIGIN + '/api/memory');
      const data = await response.json();
      if(!response.ok || !data.ok) throw new Error('memory offline');
      const memory = data.memory || {};
      const items = [].concat(memory.long || [],memory.short || [],memory.sealed || []);
      writeJson(SERVER_KEY,items);
      const local = all().concat(legacyEvents());
      if(local.length){
        fetch(API_ORIGIN + '/api/memory/sync',{
          method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({events:local})
        }).catch(()=>{});
      }
      return items;
    }catch(error){ return readJson(SERVER_KEY,[]); }
  }
  function all(){
    return readJson(EVENT_KEY, []);
  }
  function legacyEvents(){
    const out = [];
    readJson('cozy_blackboard_answers', []).forEach((x,i)=>out.push({
      id:'legacy_blackboard_'+i,date:x.date || '',time:'',source:'blackboard',type:'blackboard_answer',layer:'long',
      content:x.answer || '',summary:'黑板答题：'+(x.title || '每日题目'),weight:2
    }));
    readJson('cozy_orchard_seeds', []).forEach((x,i)=>out.push({
      id:'legacy_orchard_'+i,date:x.date || '',time:'',source:'orchard',type:'growth_question',layer:'long',
      content:x.text || '',summary:'果园成长种子：'+short(x.text,42),weight:2
    }));
    readJson('cozy_notice_requests', []).forEach((x,i)=>out.push({
      id:'legacy_notice_request_'+i,date:x.date || '',time:'',source:'noticeboard',type:'notice_request',layer:'short',
      content:x.text || '',summary:'公告板留言：'+short(x.text,42),weight:1
    }));
    readJson('cozy_notice_links', []).forEach((x,i)=>out.push({
      id:'legacy_notice_link_'+i,date:x.date || '',time:'',source:'noticeboard',type:'read_later',layer:'short',
      content:x.title || x.url || '',summary:'待读资讯：'+short(x.title || x.url,42),weight:1
    }));
    const trips = readJson('cozy_trips', []);
    const reflections = readJson('cozy_trip_reflections', {});
    Object.keys(reflections).forEach((key,i)=>out.push({
      id:'legacy_trip_reflection_'+i,date:reflections[key].updatedAt || '',time:'',source:'travel',type:'travel_reflection',layer:'long',
      content:reflections[key].text || '',summary:'旅行感悟：'+short(reflections[key].summary || reflections[key].text,54),weight:2
    }));
    trips.forEach((x,i)=>out.push({
      id:'legacy_trip_'+i,date:x.start || x.date || '',time:'',source:'travel',type:'trip',layer:'short',
      content:x.place || '',summary:'旅行记录：'+(x.place || '未命名地点'),weight:1
    }));
    readJson('cozy_heart_entries', []).forEach((x,i)=>out.push({
      id:'legacy_heart_'+i,date:x.date || '',time:x.time || '',source:'heart_hollow',type:'heart_entry',layer:'short',
      content:x.transcript || '',summary:'树洞倾诉：'+short(x.transcript,48),weight:2
    }));
    return out;
  }
  function merged(){
    const map = new Map();
    all().concat(readJson(SERVER_KEY,[]),legacyEvents()).forEach(e=>{
      const id = e.id || [e.source,e.type,e.date,e.time,e.summary].join('|');
      if(!map.has(id)) map.set(id,e);
    });
    return Array.from(map.values()).sort((a,b)=>String((b.date||'')+(b.time||'')).localeCompare(String((a.date||'')+(a.time||''))));
  }
  function longTerm(events){
    const labels = {
      heart_hollow:'树洞', blackboard:'黑板', noticeboard:'公告板',
      orchard:'智慧果园', travel:'出发旅行', photo_wall:'照片墙'
    };
    const chosen = events.filter(e=>e.layer === 'long' || e.weight >= 2).slice(0,24);
    const grouped = {};
    chosen.forEach(e=>{
      const key = e.source || 'unknown';
      if(!grouped[key]) grouped[key] = [];
      grouped[key].push(e);
    });
    return Object.keys(grouped).map(key=>({
      source:key,
      title:(labels[key] || key) + '沉淀',
      summary:grouped[key].slice(0,3).map(e=>short(e.summary || e.content,46)).join('；'),
      count:grouped[key].length
    }));
  }
  window.CozyMemory = {add, forget, all, merged, longTerm, short, hydrate};
  hydrate();
})();
