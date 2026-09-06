function cleanId(value) {
  const userId = String(value || '').trim();
  if (!/^\d{8,25}$/.test(userId)) throw new Error('userId Zalo không hợp lệ.');
  return userId;
}

function classifyUnfriendResponse(response) {
  const status = Number(response?.status || response?.statusCode || 0);
  const errorCode = response?.data?.error_code ?? response?.error_code ?? response?.code;
  const numericErrorCode = errorCode === undefined || errorCode === null || errorCode === '' ? null : Number(errorCode);
  if (status && (status < 200 || status >= 300)) return { ok: false, message: `Zalo trả HTTP ${status}.` };
  if (numericErrorCode !== null && Number.isFinite(numericErrorCode) && numericErrorCode !== 0) {
    const detail = String(response?.data?.error_message || response?.error_message || '').trim();
    return { ok: false, message: `Zalo từ chối lệnh (mã ${numericErrorCode})${detail ? `: ${detail}` : '.'}` };
  }
  if (numericErrorCode === 0) return { ok: true };
  if (status >= 200 && status < 300 && response?.data && typeof response.data === 'object') return { ok: true };
  return { ok: false, message: 'Phản hồi Zalo không có xác nhận thành công rõ ràng.' };
}

function webpackBootstrapSource() {
  return `
    const getWebpackRequire=()=>{
      if(window.__NYWebpackRequire?.c)return window.__NYWebpackRequire;
      let req=null;
      if(Array.isArray(window.webpackJsonp)){
        const id='ny_bridge_'+Date.now()+'_'+Math.random().toString(36).slice(2);
        try{window.webpackJsonp.push([[id],{[id]:(module,exports,webpackRequire)=>{req=webpackRequire}},[[id]]])}catch{}
      }
      if(!req&&typeof window.webpackJsonp==='function'){
        const id=900000000+Math.floor(Math.random()*999999);
        try{window.webpackJsonp([],{[id]:(module,exports,webpackRequire)=>{req=webpackRequire}},[id])}catch{}
      }
      if(req?.c)window.__NYWebpackRequire=req;
      return req;
    };
    const findBridge=(req)=>{
      const isDirectRemoveMethod=(key,fn)=>{
        if(typeof fn!=='function'||!/remove.?friend/i.test(String(key||'')))return false;
        let source='';try{source=Function.prototype.toString.call(fn)}catch{}
        return source.includes('/api/friend/remove?')&&/\\bfid\\s*:/.test(source);
      };
      const cached=window.__NYZaloDirectUnfriendBridge;
      if(cached?.owner&&isDirectRemoveMethod(cached.key,cached.owner[cached.key]))return cached;
      delete window.__NYZaloDirectUnfriendBridge;
      const seen=new WeakSet();let found=null;
      const walk=(value,moduleId,path,depth)=>{
        if(found||!value||(typeof value!=='object'&&typeof value!=='function')||seen.has(value)||depth>3)return;
        seen.add(value);let keys=[];try{keys=Object.getOwnPropertyNames(value).slice(0,180)}catch{return}
        for(const key of keys){
          if(found||['caller','callee','arguments','prototype','constructor'].includes(key))continue;
          let child;try{child=value[key]}catch{continue}
          const childPath=path?path+'.'+key:key;
          if(typeof child==='function'){
            let source='';try{source=Function.prototype.toString.call(child)}catch{}
            if(isDirectRemoveMethod(key,child)){
              found={owner:value,key,moduleId:String(moduleId),path:childPath};break;
            }
          }
          if(depth<3&&(typeof child==='object'||typeof child==='function'))walk(child,moduleId,childPath,depth+1);
        }
      };
      for(const [moduleId,module] of Object.entries(req?.c||{})){walk(module?.exports,moduleId,'',0);if(found)break}
      if(found)window.__NYZaloDirectUnfriendBridge=found;
      return found;
    };
    const findFriendStorage=(req)=>{
      const cached=window.__NYZaloFriendStorage;
      if(cached&&typeof cached.updateMultiFriend==='function')return cached;
      const seen=new WeakSet();let found=null;
      const walk=(value,depth)=>{
        if(found||!value||(typeof value!=='object'&&typeof value!=='function')||seen.has(value)||depth>3)return;
        seen.add(value);
        if(typeof value.updateMultiFriend==='function'&&typeof value.getFriends==='function'){found=value;return}
        let keys=[];try{keys=Object.getOwnPropertyNames(value).slice(0,160)}catch{return}
        for(const key of keys){if(['caller','callee','arguments','prototype','constructor'].includes(key))continue;let child;try{child=value[key]}catch{continue}if(typeof child==='object'||typeof child==='function')walk(child,depth+1);if(found)break}
      };
      for(const module of Object.values(req?.c||{})){walk(module?.exports,0);if(found)break}
      if(found)window.__NYZaloFriendStorage=found;
      return found;
    };
  `;
}

function buildUnfriendBridgeProbeScript() {
  return `(()=>{${webpackBootstrapSource()}
    if(location.hostname!=='chat.zalo.me')return {ok:false,message:'Nick chưa ở trang chat.zalo.me.'};
    const req=getWebpackRequire();
    if(!req?.c)return {ok:false,message:'Không truy cập được runtime của phiên Zalo Web.'};
    const bridge=findBridge(req),storage=findFriendStorage(req);
    if(!bridge)return {ok:false,message:'Phiên Zalo Web này chưa có adapter /api/friend/remove tương thích.'};
    return {ok:true,method:'webpack-direct',moduleId:bridge.moduleId,path:bridge.path,localFriendSync:!!storage};
  })()`;
}

function buildDirectUnfriendScript(userId) {
  const encodedUserId = JSON.stringify(cleanId(userId));
  return `(async()=>{${webpackBootstrapSource()}
    const userId=${encodedUserId};
    if(location.hostname!=='chat.zalo.me')return {ok:false,message:'Nick chưa ở trang chat.zalo.me.'};
    const req=getWebpackRequire();
    if(!req?.c)return {ok:false,message:'Không truy cập được runtime của phiên Zalo Web.'};
    const bridge=findBridge(req);
    if(!bridge)return {ok:false,message:'Không tìm thấy adapter hủy kết bạn trực tiếp của phiên Zalo.'};
    let response;
    try{
      response=await Promise.race([
        Promise.resolve(bridge.owner[bridge.key].call(bridge.owner,userId)),
        new Promise((_,reject)=>setTimeout(()=>reject(new Error('Zalo không trả phản hồi API trong 15 giây.')),15000)),
      ]);
    }catch(error){return {ok:false,stage:'DIRECT_API',message:error?.message||String(error)}}
    const status=Number(response?.status||response?.statusCode||0);
    const rawCode=response?.data?.error_code??response?.error_code??response?.code;
    const errorCode=rawCode===undefined||rawCode===null||rawCode===''?null:Number(rawCode);
    if(status&&(status<200||status>=300))return {ok:false,stage:'DIRECT_API',message:'Zalo trả HTTP '+status+'.'};
    if(errorCode!==null&&Number.isFinite(errorCode)&&errorCode!==0){const detail=String(response?.data?.error_message||response?.error_message||'').trim();return {ok:false,stage:'DIRECT_API',message:'Zalo từ chối lệnh (mã '+errorCode+')'+(detail?': '+detail:'.')}}
    const confirmed=errorCode===0||(status>=200&&status<300&&response?.data&&typeof response.data==='object');
    if(!confirmed)return {ok:false,stage:'DIRECT_API',message:'Phản hồi Zalo không có xác nhận thành công rõ ràng.'};
    let localUpdated=false;
    try{
      const storage=findFriendStorage(req);
      if(storage){await storage.updateMultiFriend([{userId,isFr:0}],['isFr']);localUpdated=true}
    }catch{}
    return {ok:true,verified:true,method:'webpack-direct',moduleId:bridge.moduleId,localUpdated};
  })()`;
}

module.exports = { cleanId, classifyUnfriendResponse, buildUnfriendBridgeProbeScript, buildDirectUnfriendScript };
