(function(){
  if(window.CozyMobile)return;
  const isMobile=()=>window.matchMedia('(max-width: 760px)').matches;
  const inPages=location.pathname.includes('/pages/');
  const root=inPages?'../':'';
  const page=(location.pathname.split('/').pop()||'index.html').replace('.html','');
  let installPrompt=null;
  let navBeforeSheet=page==='index'?'index':(page==='orchard'?'orchard':'more');
  const icons={
    home:'<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/>',
    notice:'<path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    blackboard:'<path d="M4 3h16v13H4z"/><path d="m8 21 4-5 4 5M2 3h20"/>',
    growth:'<path d="M7 20h10M12 20v-8"/><path d="M12 13c-4 0-7-2.5-7-6 4 0 7 2.5 7 6ZM12 16c4 0 7-2.5 7-6-4 0-7 2.5-7 6Z"/>',
    more:'<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
    tree:'<path d="m12 3-4 6h3l-5 7h12l-5-7h3z"/><path d="M12 16v5"/>',
    travel:'<path d="M22 2 9 15"/><path d="m22 2-7 20-4-9-9-4z"/>',
    bedroom:'<path d="M3 19v-8h18v8M3 16h18"/><path d="M7 11V7h5a3 3 0 0 1 3 3v1M3 19v2M21 19v2"/>',
    photos:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
    toolbox:'<path d="M14.7 6.3a4 4 0 0 0-5-5l2.1 2.1-8.4 8.4-2.1-2.1a4 4 0 0 0 5 5l8.4-8.4Z"/><path d="m13 13 8 8"/>',
    memory:'<path d="M12 2a5 5 0 0 0-5 5v1a4 4 0 0 0-2 7 4 4 0 0 0 5 5h2"/><path d="M12 2a5 5 0 0 1 5 5v1a4 4 0 0 1 2 7 4 4 0 0 1-5 5h-2M12 2v20M8 9h4M12 15h4"/>',
    butler:'<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/><path d="M8 9h8M8 13h5"/>',
    private:'<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
    install:'<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>',
    close:'<path d="m6 6 12 12M18 6 6 18"/>'
  };
  const icon=name=>`<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;

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
        .cozy-mobile-nav a,.cozy-mobile-nav button{position:relative;min-width:0;height:52px;padding:4px 2px 3px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;border:0;border-radius:8px;background:transparent;color:#786858;text-decoration:none;font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;font-size:11px;font-weight:500;line-height:1.15;cursor:pointer;transition:color .18s ease,background .18s ease}
        .cozy-mobile-nav .mobile-nav-mark{width:22px;height:22px;display:grid;place-items:center;color:currentColor}.cozy-mobile-nav svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
        .cozy-mobile-nav .active{color:#426343;font-weight:700;background:rgba(102,139,99,.13)}.cozy-mobile-nav .active:after{content:"";position:absolute;left:50%;bottom:1px;width:18px;height:2px;border-radius:2px;background:#668963;transform:translateX(-50%)}
        .cozy-mobile-sheet{position:fixed;inset:0;z-index:110;align-items:flex-end;background:rgba(39,30,23,.38);backdrop-filter:blur(5px);font-family:"PingFang SC","Microsoft YaHei",sans-serif}
        .cozy-mobile-sheet.show{display:flex}.cozy-mobile-sheet-card{width:100%;max-height:min(78vh,660px);overflow:auto;padding:12px 18px calc(22px + var(--mobile-safe-bottom));border-radius:18px 18px 0 0;background:#fffaf1;color:#493b30;box-shadow:0 -24px 70px rgba(40,29,20,.26)}
        .cozy-mobile-sheet-head{display:flex;align-items:center;justify-content:space-between;padding:2px 0 14px}.cozy-mobile-sheet-head h2{font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;font-size:17px;font-weight:700}.cozy-mobile-sheet-head button{width:34px;height:34px;padding:0;display:grid;place-items:center;border:0;border-radius:50%;background:#f0e5d6;color:#786654}.cozy-mobile-sheet-head button svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
        .cozy-mobile-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.cozy-mobile-grid a,.cozy-mobile-grid button{position:relative;min-height:74px;padding:9px 5px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;border:1px solid rgba(100,75,51,.12);border-radius:8px;background:rgba(255,255,255,.88);color:#665647;text-decoration:none;font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;font-size:12px;font-weight:500;line-height:1.2;cursor:pointer;transition:border-color .18s ease,background .18s ease,color .18s ease,box-shadow .18s ease}.cozy-mobile-grid a:active,.cozy-mobile-grid button:active{background:#f4eee4}.cozy-mobile-grid .active{border-color:rgba(91,126,88,.5);background:#edf3e9;color:#426343;font-weight:700;box-shadow:inset 0 0 0 1px rgba(91,126,88,.12)}.cozy-mobile-grid .active:after{content:"";position:absolute;left:50%;bottom:6px;width:16px;height:2px;border-radius:2px;background:#668963;transform:translateX(-50%)}.mobile-grid-icon{width:24px;height:24px;display:grid;place-items:center}.mobile-grid-icon svg{width:23px;height:23px;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}.mobile-grid-label{font:inherit}
        .cozy-mobile-cloud{display:flex;align-items:center;gap:8px;margin-top:14px;padding:12px 2px 2px;border-top:1px solid rgba(100,75,51,.1);font-size:11px;color:#8b7866}.cozy-mobile-cloud:before{content:"";width:8px;height:8px;border-radius:50%;background:#b8aa9c}.cozy-mobile-cloud.online:before{background:#78a87b;box-shadow:0 0 0 3px rgba(120,168,123,.12)}.cozy-mobile-cloud.failed:before{background:#c77b70}
        .cozy-install-dialog{position:fixed;inset:0;z-index:120;align-items:center;justify-content:center;padding:18px;background:rgba(39,30,23,.46);backdrop-filter:blur(6px);font-family:"PingFang SC","Microsoft YaHei",sans-serif}.cozy-install-dialog.show{display:flex}.cozy-install-card{width:min(360px,100%);padding:21px;border-radius:12px;background:#fffaf1;color:#493b30;box-shadow:0 24px 70px rgba(40,29,20,.3)}.cozy-install-card h2{font-size:18px;margin:0 0 8px}.cozy-install-card p{font-size:13px;line-height:1.75;color:#756353;margin:0}.cozy-install-card ol{padding-left:20px;margin:13px 0 0}.cozy-install-card li{font-size:13px;line-height:1.8;color:#665344}.cozy-install-card button{width:100%;height:40px;margin-top:16px;border:0;border-radius:8px;background:#765e48;color:#fff;font-family:inherit;font-size:13px}
        body.mobile-sheet-open{overflow:hidden}
      }
    `;
    document.head.appendChild(style);
  }
  const extraPages=new Set(['heart_hollow','travel','bedroom','memory_nook','private_wing']);
  const item=(kind,label,iconName,href,action)=>{
    const active=page===kind||(kind==='more'&&extraPages.has(page));
    const content=`<span class="mobile-nav-mark">${icon(iconName)}</span><span>${label}</span>`;
    return href?`<a class="${active?'active':''}" href="${root+href}">${content}</a>`:`<button class="${active?'active':''}" type="button" data-mobile-action="${action}">${content}</button>`;
  };
  const gridItem=(kind,label,iconName,href,action)=>{
    const active=page===kind;
    const content=`<span class="mobile-grid-icon">${icon(iconName)}</span><span class="mobile-grid-label">${label}</span>`;
    return href?`<a class="${active?'active':''}" href="${root+href}">${content}</a>`:`<button type="button" data-mobile-action="${action}">${content}</button>`;
  };

  function installUi(){
    document.body.dataset.cozyPage=page;
    const nav=document.createElement('nav');nav.className='cozy-mobile-nav';nav.setAttribute('aria-label','手机主导航');
    nav.innerHTML=item('index','小院','home','index.html')+
      item('notice','公告','notice',null,'notice')+
      item('blackboard','黑板','blackboard',null,'blackboard')+
      item('orchard','成长田','growth','pages/orchard.html')+
      item('more','更多','more',null,'more');
    const sheet=document.createElement('div');sheet.className='cozy-mobile-sheet';sheet.id='cozy-mobile-sheet';sheet.innerHTML=`<section class="cozy-mobile-sheet-card"><header class="cozy-mobile-sheet-head"><h2>我的小院</h2><button type="button" data-mobile-action="close" aria-label="关闭">${icon('close')}</button></header><div class="cozy-mobile-grid">${gridItem('heart_hollow','树洞','tree','pages/heart_hollow.html')}${gridItem('travel','旅行','travel','pages/travel.html')}${gridItem('bedroom','卧室','bedroom','pages/bedroom.html')}${gridItem('photos','照片墙','photos',null,'photos')}${gridItem('toolbox','工具箱','toolbox',null,'toolbox')}${gridItem('butler','找阿栗','butler',null,'butler')}${gridItem('private_wing','密阁','private','pages/private_wing.html')}${gridItem('install','保存到主屏幕','install',null,'install')}</div><div class="cozy-mobile-cloud" id="cozy-mobile-cloud">正在确认云端同步</div></section>`;
    const dialog=document.createElement('div');dialog.className='cozy-install-dialog';dialog.id='cozy-install-dialog';dialog.innerHTML='<section class="cozy-install-card"><h2>保存到主屏幕</h2><div id="cozy-install-copy"></div><button type="button" data-mobile-action="install-close">知道了</button></section>';
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
    if(action==='notice'){setNavActive('notice');homeAction('openNotice');}
    if(action==='blackboard'){setNavActive('blackboard');homeAction('openBlackboard');}
    if(action==='photos'){homeAction('openPhotoWall');setNavActive('more');}
    if(action==='toolbox'){homeAction('openToolbox');setNavActive('more');}
    if(action==='butler'){closeSheet();setNavActive('more');window.CozyButler?.open();}
    if(action==='install'){setNavActive('more');showInstall();}
    if(action==='install-close')document.getElementById('cozy-install-dialog')?.classList.remove('show');
  }
  function setNavActive(action,remember=true){document.querySelectorAll('.cozy-mobile-nav .active').forEach(node=>node.classList.remove('active'));const target=action==='index'?document.querySelector('.cozy-mobile-nav a[href$="index.html"]'):action==='orchard'?document.querySelector('.cozy-mobile-nav a[href$="orchard.html"]'):document.querySelector(`.cozy-mobile-nav [data-mobile-action="${action}"]`);target?.classList.add('active');if(remember)navBeforeSheet=action;}
  function openSheet(){const current=document.querySelector('.cozy-mobile-nav .active');navBeforeSheet=current?.dataset.mobileAction||(current?.getAttribute('href')?.includes('orchard')?'orchard':'index');setNavActive('more',false);document.getElementById('cozy-mobile-sheet')?.classList.add('show');document.body.classList.add('mobile-sheet-open');}
  function closeSheet(){document.getElementById('cozy-mobile-sheet')?.classList.remove('show');document.body.classList.remove('mobile-sheet-open');if(navBeforeSheet!=='more')setNavActive(navBeforeSheet);}
  function openRequestedEntry(){
    if(page!=='index')return;const value=new URLSearchParams(location.search).get('open');
    const actions={notice:'openNotice',blackboard:'openBlackboard',photos:'openPhotoWall',toolbox:'openToolbox'};
    if(actions[value])setTimeout(()=>{setNavActive(value==='notice'||value==='blackboard'?value:'more');window[actions[value]]?.();},180);
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
    if(standalone)copy.innerHTML='<p>阿栗已经作为应用打开，不需要重复安装。</p>';
    else if(ios)copy.innerHTML='<ol><li>使用 Safari 打开私人小院。</li><li>点击底部的“分享”按钮。</li><li>向下找到“添加到主屏幕”。</li><li>点击右上角“添加”。</li></ol>';
    else copy.innerHTML='<p>打开浏览器菜单，选择“安装应用”或“添加到主屏幕”。</p>';
    document.getElementById('cozy-install-dialog')?.classList.add('show');
  }
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;});
  window.CozyMobile={openSheet,closeSheet,showInstall,updateCloudStatus,activate:setNavActive};
  addStyles();
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',installUi);else installUi();
})();
