function buildCompatibilityProbeScript() {
  return `(()=>{
    const methodNames=(value)=>{if(!value)return[];const names=new Set();let current=value;for(let depth=0;current&&depth<3;depth+=1,current=Object.getPrototypeOf(current)){for(const name of Object.getOwnPropertyNames(current)){try{if(typeof value[name]==='function')names.add(name)}catch{}}}return Array.from(names).filter((name)=>name!=='constructor').sort().slice(0,120)};
    const managerNames=['FriendListManager','friendManager','FriendManager','groupManager','conversationManager','chatManager','messageManager'];
    const managers={};for(const name of managerNames){const value=window[name];managers[name]={available:!!value,type:typeof value,methods:methodNames(value)}}
    const selectors={searchInput:'#contact-search-input',composer:'#richInput, #chatInput, [contenteditable="true"][role="textbox"]',conversationRows:'.msg-item, [data-id], .group-board-item',sendButton:'[data-translate-title="STR_SEND"], button[class*="send"], [aria-label="Gửi"]',dialogs:'[role="dialog"]'};
    const dom={};for(const [name,selector] of Object.entries(selectors)){let rows=[];try{rows=Array.from(document.querySelectorAll(selector))}catch{}dom[name]={count:rows.length,visible:rows.filter((el)=>{const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'}).length}}
    const identityAttributes=new Set();for(const el of Array.from(document.querySelectorAll('[data-id],[data-uid],[data-user-id],[data-group-id]')).slice(0,500)){for(const attribute of el.getAttributeNames())if(/^data-(id|uid|user-id|group-id|conversation-id|thread-id)$/.test(attribute))identityAttributes.add(attribute)}
    return {schemaVersion:1,capturedAt:new Date().toISOString(),host:location.hostname,path:location.pathname,readyState:document.readyState,managers,dom,identityAttributes:Array.from(identityAttributes).sort(),webpack:{webpackJsonp:!!window.webpackJsonp,webpackChunk:!!window.webpackChunk_zalo_web}};
  })()`;
}

module.exports = { buildCompatibilityProbeScript };
