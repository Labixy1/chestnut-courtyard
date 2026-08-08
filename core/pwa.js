(function(){
  if(!('serviceWorker' in navigator)||!/^https?:$/.test(location.protocol))return;
  const prefix=location.pathname.includes('/pages/')?'../':'';
  window.addEventListener('load',()=>navigator.serviceWorker.register(prefix+'sw.js',{scope:prefix}).catch(()=>{}));
})();
