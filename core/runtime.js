(function(){
  if(window.CozyRuntime)return;
  const VALID_MODES=new Set(['owner','selfhost','interview','preview','dev']);
  const configured=Object.assign({},window.COZY_RUNTIME_CONFIG||{});
  const query=new URLSearchParams(location.search).get('cozy_mode');
  function autoMode(){
    if(location.protocol==='file:')return 'dev';
    if(['127.0.0.1','localhost','::1'].includes(location.hostname))return 'dev';
    return 'preview';
  }
  const requested=VALID_MODES.has(query)?query:configured.mode;
  const mode=VALID_MODES.has(requested)?requested:autoMode();
  const readOnly=mode==='preview'||configured.allowWrites===false;
  const source=configured.dataSource==='auto'?(mode==='dev'?'local':'bundle'):configured.dataSource;
  const apiBase=location.protocol==='file:'?'http://127.0.0.1:8766':String(configured.apiBase||'');
  const keyForPath=path=>String(path||'').split('/').pop().replace(/\.json$/,'');
  const clone=value=>JSON.parse(JSON.stringify(value));
  async function loadJson(path,fallback,key){
    const dataKey=key||keyForPath(path);
    const bundled=window.COZY&&window.COZY[dataKey];
    if(source==='bundle'||location.protocol==='file:')return clone(bundled===undefined?fallback:bundled);
    try{
      const response=await fetch(path,{headers:{'accept':'application/json'}});
      if(!response.ok)throw new Error('HTTP '+response.status);
      return await response.json();
    }catch(error){
      return clone(bundled===undefined?fallback:bundled);
    }
  }
  function assertWritable(){if(readOnly)throw new Error('当前是公开预览，只能浏览，数据不会写入');}
  window.CozyRuntime=Object.freeze({
    mode,readOnly,dataSource:source,apiBase,
    appName:String(configured.appName||'栗壳小院'),
    instanceId:String(configured.instanceId||mode),
    loadJson,assertWritable,
    capabilities:Object.freeze({
      ai:mode!=='preview',memory:mode!=='preview',upload:mode!=='preview',
      systemChange:mode==='owner'||mode==='dev'
    })
  });
  document.documentElement.dataset.cozyMode=mode;
  window.dispatchEvent(new CustomEvent('cozy:runtime-ready',{detail:window.CozyRuntime}));
})();
