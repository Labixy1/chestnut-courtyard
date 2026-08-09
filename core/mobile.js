(function(){
  if(window.CozyMobile)return;
  const isMobile=()=>window.matchMedia('(max-width: 760px)').matches;
  const inPages=location.pathname.includes('/pages/');
  const root=inPages?'../':'';
  const page=(location.pathname.split('/').pop()||'index.html').replace('.html','');
  let installPrompt=null;

  function addStyles(){
    const style=document.createElement('style');
    style.textContent=`
      .cozy-mobile-nav,.cozy-mobile-sheet,.cozy-install-dialog{display:none}
      @media(max-width:760px){
        :root{--mobile-safe-bottom:env(safe-area-inset-bottom,0px);--mobile-nav-h:calc(62px + var(--mobile-safe-bottom))}
        body{padding-bottom:var(--mobile-nav-h);-webkit-tap-highlight-color:transparent}
        body[data-cozy-page="index"]{padding-bottom:0}
        body.has-global-butler .back,.back{display:none!important}
        body:not([data-cozy-page="index"]) .cozy-butler-launcher{display:none!important}
        .cozy-mobile-nav{position:fixed;left:0;right:0;bottom:0;z-index:70;height:var(--mobile-nav-h);display:grid;grid-template-columns:repeat(5,minmax(0,1fr));padding:5px 6px var(--mobile-safe-bottom);background:rgba(255,252,246,.96);border-top:1px solid rgba(91,74,58,.13);box-shadow:0 -10px 30px rgba(52,38,25,.12);backdrop-filter:blur(18px);font-family:"PingFang SC","Microsoft YaHei",sans-serif}
        .cozy-mobile-nav a,.cozy-mobile-nav button{min-width:0;height:52px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;border:0;background:transparent;color:#786858;text-decoration:none;font:10px inherit;cursor:pointer}
        .cozy-mobile-nav .mobile-nav-mark{width:22px;height:22px;display:grid;place-items:center;font-size:17px;line-height:1;color:#735d48}
        .cozy-mobile-nav .active{color:#4f6d4b;font-weight:700}.cozy-mobile-nav .active .mobile-nav-mark{color:#4f6d4b}
        .cozy-mobile-sheet{position:fixed;inset:0;z-index:110;align-items:flex-end;background:rgba(39,30,23,.38);backdrop-filter:blur(5px);font-family:"PingFang SC","Microsoft YaHei",sans-serif}
        .cozy-mobile-sheet.show{display:flex}.cozy-mobile-sheet-card{width:100%;max-height:min(78vh,660px);overflow:auto;padding:12px 18px calc(22px + var(--mobile-safe-bottom));border-radius:18px 18px 0 0;background:#fffaf1;color:#493b30;box-shadow:0 -24px 70px rgba(40,29,20,.26)}
        .cozy-mobile-sheet-head{display:flex;align-items:center;justify-content:space-between;padding:2px 0 14px}.cozy-mobile-sheet-head h2{font-size:17px}.cozy-mobile-sheet-head button{width:34px;height:34px;border:0;border-radius:50%;background:#f0e5d6;color:#786654;font-size:20px}
        .cozy-mobile-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.cozy-mobile-grid a,.cozy-mobile-grid button{min-height:74px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;border:1px solid rgba(100,75,51,.1);border-radius:8px;background:#fff;color:#604e3e;text-decoration:none;font:12px inherit}.cozy-mobile-grid span{font-size:22px;line-height:1}
        .cozy-mobile-cloud{display:flex;align-items:center;gap:8px;margin-top:14px;padding:12px 2px 2px;border-top:1px solid rgba(100,75,51,.1);font-size:11px;color:#8b7866}.cozy-mobile-cloud:before{content:"";width:8px;height:8px;border-radius:50%;background:#b8aa9c}.cozy-mobile-cloud.online:before{background:#78a87b;box-shadow:0 0 0 3px rgba(120,168,123,.12)}.cozy-mobile-cloud.failed:before{background:#c77b70}
        .cozy-install-dialog{position:fixed;inset:0;z-index:120;align-items:center;justify-content:center;padding:18px;background:rgba(39,30,23,.46);backdrop-filter:blur(6px);font-family:"PingFang SC","Microsoft YaHei",sans-serif}.cozy-install-dialog.show{display:flex}.cozy-install-card{width:min(360px,100%);padding:21px;border-radius:12px;background:#fffaf1;color:#493b30;box-shadow:0 24px 70px rgba(40,29,20,.3)}.cozy-install-card h2{font-size:18px;margin:0 0 8px}.cozy-install-card p{font-size:13px;line-height:1.75;color:#756353;margin:0}.cozy-install-card ol{padding-left:20px;margin:13px 0 0}.cozy-install-card li{font-size:13px;line-height:1.8;color:#665344}.cozy-install-card button{width:100%;height:40px;margin-top:16px;border:0;border-radius:8px;background:#765e48;color:#fff;font:13px inherit}
        body[data-cozy-page="index"] .cozy-mobile-nav{background:linear-gradient(180deg,rgba(39,33,27,.72),rgba(34,29,24,.9));border-top-color:rgba(255,255,255,.12);box-shadow:0 -12px 34px rgba(0,0,0,.2)}
        body[data-cozy-page="index"] .cozy-mobile-nav a,body[data-cozy-page="index"] .cozy-mobile-nav button{color:rgba(255,250,239,.74)}body[data-cozy-page="index"] .cozy-mobile-nav .mobile-nav-mark{color:#fff8e8}body[data-cozy-page="index"] .cozy-mobile-nav .active{color:#fff}
        body.mobile-sheet-open{overflow:hidden}
      }
    `;
    document.head.appendChild(style);
  }
  const item=(kind,label,mark,href,action)=>href
    ?`<a class="${page===kind?'active':''}" href="${root+href}"><span class="mobile-nav-mark">${mark}</span>${label}</a>`
    :`<button type="button" data-mobile-action="${action}"><span class="mobile-nav-mark">${mark}</span>${label}</button>`;

  function installUi(){
    document.body.dataset.cozyPage=page;
    const nav=document.createElement('nav');nav.className='cozy-mobile-nav';nav.setAttribute('aria-label','手机主导航');
    nav.innerHTML=item('index','小院','⌂','index.html')+
      item('notice','公告','▤',null,'notice')+
      item('blackboard','黑板','□',null,'blackboard')+
      item('orchard','成长田','♧','pages/orchard.html')+
      item('more','更多','•••',null,'more');
    const sheet=document.createElement('div');sheet.className='cozy-mobile-sheet';sheet.id='cozy-mobile-sheet';sheet.innerHTML=`<section class="cozy-mobile-sheet-card"><header class="cozy-mobile-sheet-head"><h2>我的小院</h2><button type="button" data-mobile-action="close" aria-label="关闭">×</button></header><div class="cozy-mobile-grid"><a href="${root}pages/heart_hollow.html"><span>♧</span>树洞</a><a href="${root}pages/travel.html"><span>◇</span>旅行</a><a href="${root}pages/bedroom.html"><span>⌂</span>卧室</a><button type="button" data-mobile-action="photos"><span>▧</span>照片墙</button><button type="button" data-mobile-action="toolbox"><span>▣</span>工具箱</button><a href="${root}pages/memory_nook.html"><span>◎</span>记忆档案</a><button type="button" data-mobile-action="butler"><span>◉</span>找阿栗</button><a href="${root}pages/private_wing.html"><span>◇</span>密阁</a><button type="button" data-mobile-action="install"><span>⇩</span>安装小院</button></div><div class="cozy-mobile-cloud" id="cozy-mobile-cloud">正在确认云端同步</div></section>`;
    const dialog=document.createElement('div');dialog.className='cozy-install-dialog';dialog.id='cozy-install-dialog';dialog.innerHTML='<section class="cozy-install-card"><h2>添加栗壳小院到主屏幕</h2><div id="cozy-install-copy"></div><button type="button" data-mobile-action="install-close">知道了</button></section>';
    document.body.append(nav,sheet,dialog);
    document.body.addEventListener('click',handleAction);
    sheet.addEventListener('click',event=>{if(event.target===sheet)closeSheet();});
    updateCloudStatus();
    openRequestedEntry();
  }
  function homeAction(name){
    if(page==='index'&&typeof window[name]==='function'){closeSheet();window[name]();return;}
    const targets={openNotice:'notice',openBlackboard:'blackboard',openPhotoWall:'photos',openToolbox:'toolbox'};
    location.href=root+'index.html?open='+targets[name];
  }
  function handleAction(event){
    const button=event.target.closest('[data-mobile-action]');if(!button)return;
    const action=button.dataset.mobileAction;
    if(action==='more')openSheet();
    if(action==='close')closeSheet();
    if(action==='notice')homeAction('openNotice');
    if(action==='blackboard')homeAction('openBlackboard');
    if(action==='photos')homeAction('openPhotoWall');
    if(action==='toolbox')homeAction('openToolbox');
    if(action==='butler'){closeSheet();window.CozyButler?.open();}
    if(action==='install')showInstall();
    if(action==='install-close')document.getElementById('cozy-install-dialog')?.classList.remove('show');
  }
  function openSheet(){document.getElementById('cozy-mobile-sheet')?.classList.add('show');document.body.classList.add('mobile-sheet-open');}
  function closeSheet(){document.getElementById('cozy-mobile-sheet')?.classList.remove('show');document.body.classList.remove('mobile-sheet-open');}
  function openRequestedEntry(){
    if(page!=='index')return;const value=new URLSearchParams(location.search).get('open');
    const actions={notice:'openNotice',blackboard:'openBlackboard',photos:'openPhotoWall',toolbox:'openToolbox'};
    if(actions[value])setTimeout(()=>window[actions[value]]?.(),180);
  }
  async function updateCloudStatus(){
    const node=document.getElementById('cozy-mobile-cloud');if(!node)return;
    if(location.protocol==='file:'){node.textContent='本地浏览 · 启动服务后同步云端';return;}
    try{const response=await fetch((window.CozyRuntime?.apiBase||'')+'/api/status',{headers:{accept:'application/json'}}),data=await response.json();if(!response.ok||!data.ok)throw new Error();node.className='cozy-mobile-cloud online';node.textContent=data.service==='cloud'?'私人云端已连接':'本地服务已连接，数据会同步';}
    catch(_error){node.className='cozy-mobile-cloud failed';node.textContent='云端暂未连接，本页内容仍可浏览';}
  }
  async function showInstall(){
    closeSheet();
    if(installPrompt){installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;return;}
    const copy=document.getElementById('cozy-install-copy'),ios=/iphone|ipad|ipod/i.test(navigator.userAgent),standalone=matchMedia('(display-mode: standalone)').matches||navigator.standalone;
    if(standalone)copy.innerHTML='<p>栗壳小院已经作为应用打开，不需要重复安装。</p>';
    else if(ios)copy.innerHTML='<ol><li>使用 Safari 打开私人小院。</li><li>点击底部的“分享”按钮。</li><li>向下找到“添加到主屏幕”。</li><li>点击右上角“添加”。</li></ol>';
    else copy.innerHTML='<p>打开浏览器菜单，选择“安装应用”或“添加到主屏幕”。</p>';
    document.getElementById('cozy-install-dialog')?.classList.add('show');
  }
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;});
  window.CozyMobile={openSheet,closeSheet,showInstall,updateCloudStatus};
  addStyles();
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',installUi);else installUi();
})();
