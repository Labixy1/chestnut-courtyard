(function(){
  if(!('serviceWorker' in navigator)||!/^https?:$/.test(location.protocol))return;
  const prefix=location.pathname.includes('/pages/')?'../':'';
  window.addEventListener('load',()=>{
    navigator.serviceWorker.register(prefix+'sw.js?v=13',{scope:prefix,updateViaCache:'none'}).then(registration=>registration.update()).catch(()=>{});
  });
})();
