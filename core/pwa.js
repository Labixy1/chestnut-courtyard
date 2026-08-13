(function(){
  if(!('serviceWorker' in navigator)||!/^https?:$/.test(location.protocol))return;
  const prefix=location.pathname.includes('/pages/')?'../':'';
  let refreshing=false;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{
    if(refreshing)return;
    refreshing=true;
    location.reload();
  });
  window.addEventListener('load',()=>{
    navigator.serviceWorker.register(prefix+'sw.js?v=23',{scope:prefix,updateViaCache:'none'}).then(registration=>registration.update()).catch(()=>{});
  });
})();
