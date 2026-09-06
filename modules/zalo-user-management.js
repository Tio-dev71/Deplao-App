function cleanText(value, maxLength = 500) {
  return String(value ?? '').normalize('NFC').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeInteractionTime(value) {
  if (value === null || value === undefined || value === '') return 0;
  let timestamp = typeof value === 'string' && !/^\d+$/.test(value) ? Date.parse(value) : Number(value);
  if (!Number.isFinite(timestamp)) return 0;
  if (timestamp > 0 && timestamp < 10_000_000_000) timestamp *= 1000;
  const minimum = Date.UTC(2000, 0, 1);
  const maximum = Date.now() + 86_400_000;
  return timestamp >= minimum && timestamp <= maximum ? Math.trunc(timestamp) : 0;
}

function normalizeZaloUsers(input) {
  const seen = new Set();
  const output = [];
  for (const raw of Array.isArray(input) ? input : []) {
    const userId = cleanText(raw?.userId, 128);
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    output.push({
      userId,
      name: cleanText(raw?.name ?? raw?.displayName ?? raw?.zaloName, 200) || userId,
      zaloName: cleanText(raw?.zaloName ?? raw?.name, 200),
      displayName: cleanText(raw?.displayName ?? raw?.alias ?? raw?.name ?? raw?.zaloName, 200),
      avatar: /^https?:\/\//i.test(String(raw?.avatar || '')) ? String(raw.avatar).slice(0, 2048) : '',
      phone: cleanText(raw?.phone, 32),
      source: cleanText(raw?.source, 32) || 'friend',
      lastInteractionAt: normalizeInteractionTime(raw?.lastInteractionAt ?? raw?.lastMessageTime ?? raw?.lastMsgTime ?? raw?.lastActivityAt),
    });
  }
  return output;
}

function searchable(value) {
  return cleanText(value).toLocaleLowerCase('vi').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
}

function filterAndSortUsers(users, options = {}) {
  const terms = searchable(options.query).split(' ').filter(Boolean);
  const inactivityDays = Math.max(0, Number(options.inactivityDays) || 0);
  const cutoff = inactivityDays ? Date.now() - inactivityDays * 86_400_000 : 0;
  const filtered = normalizeZaloUsers(users).filter((user) => {
    const haystack = searchable(`${user.name} ${user.phone} ${user.userId}`);
    if (!terms.every((term) => haystack.includes(term))) return false;
    if (inactivityDays && (!user.lastInteractionAt || user.lastInteractionAt > cutoff)) return false;
    return true;
  });
  const collator = new Intl.Collator('vi', { numeric: true, sensitivity: 'base' });
  const direction = options.sort === 'name-desc' ? -1 : 1;
  return filtered.sort((a, b) => direction * (collator.compare(a.name, b.name) || a.userId.localeCompare(b.userId)));
}

function buildUnfriendPlan(users, selectedIds, protectedIds, confirmation) {
  if (confirmation !== 'HUY KET BAN') throw new Error('Nhập HUY KET BAN để xác nhận.');
  const selected = new Set((Array.isArray(selectedIds) ? selectedIds : []).map(String));
  const protectedSet = protectedIds instanceof Set ? protectedIds : new Set(protectedIds || []);
  return normalizeZaloUsers(users).filter((user) => selected.has(user.userId) && !protectedSet.has(user.userId));
}

class UserScanStore {
  constructor() { this.scans = new Map(); }
  start({ scanId, profileId }) {
    const scan = { scanId: String(scanId), profileId: String(profileId), status: 'scanning', users: new Map(), error: '' };
    this.scans.set(scan.scanId, scan); return scan;
  }
  get(scanId) { const scan = this.scans.get(String(scanId)); if (!scan) throw new Error('Phiên quét người dùng không tồn tại.'); return scan; }
  acceptBatch(scanId, input) {
    const scan = this.get(scanId); if (scan.status !== 'scanning') return false;
    for (const user of normalizeZaloUsers(input)) scan.users.set(user.userId, user);
    return true;
  }
  complete(scanId) { const scan = this.get(scanId); if (scan.status === 'scanning') scan.status = 'completed'; return scan; }
  fail(scanId, message) { const scan = this.get(scanId); scan.status = 'incompatible'; scan.error = cleanText(message, 500); return scan; }
}

function buildUserExtractorScript(scanId) {
  const encoded = JSON.stringify(String(scanId));
  return `(() => {
    const scanId=${encoded}, emit=(event)=>window.messengerApp.emitZaloUserScanEvent({...event,scanId});
    if(location.hostname!=='chat.zalo.me'){emit({type:'error',message:'Profile chưa ở chat.zalo.me.'});return;}
    if(typeof window.__NYZaloUserScanCleanup==='function')window.__NYZaloUserScanCleanup();
    const found=new Map(),restores=[],started=Date.now(),MAX_NODES=12000;
    let emitted=0,observer,timer;
    const text=(value,max=200)=>String(value??'').normalize('NFC').replace(/[\\u0000-\\u001F\\u007F]/g,' ').replace(/\\s+/g,' ').trim().slice(0,max);
    const looksLikeUser=(item)=>{
      if(!item||typeof item!=='object'||Array.isArray(item))return false;
      const id=item.userId??item.user_id??item.uid??item.id;
      if(!/^[0-9]{8,25}$/.test(String(id??'')))return false;
      const hasUserShape=['zaloName','displayName','avatar','avatarUrl','phoneNumber','isFriend','friendStatus','relation'].some((key)=>key in item);
      const groupShape=('groupId' in item)||('totalMember' in item)||('memberIds' in item)||('members' in item&&Array.isArray(item.members));
      return hasUserShape&&!groupShape;
    };
    const add=(item)=>{
      if(!looksLikeUser(item))return;
      const userId=text(item.userId??item.user_id??item.uid??item.id,128);
      const zaloName=text(item.zaloName??item.username??item.name??item.displayName);
      const displayName=text(item.displayName??item.alias??item.remarkName??item.savedName??item.name??zaloName);
      const previous=found.get(userId)||{};
      const rawTime=item.lastInteractionAt??item.lastMessageTime??item.lastMsgTime??item.lastMessage?.timestamp??item.lastMessage?.ts??item.lastActivityAt;
      let lastInteractionAt=typeof rawTime==='string'&&!/^\\d+$/.test(rawTime)?Date.parse(rawTime):Number(rawTime);
      if(Number.isFinite(lastInteractionAt)&&lastInteractionAt>0&&lastInteractionAt<10000000000)lastInteractionAt*=1000;
      if(!Number.isFinite(lastInteractionAt)||lastInteractionAt<Date.UTC(2000,0,1)||lastInteractionAt>Date.now()+86400000)lastInteractionAt=Number(previous.lastInteractionAt)||0;
      found.set(userId,{userId,name:displayName||zaloName||userId,zaloName:zaloName||previous.zaloName||'',displayName:displayName||previous.displayName||'',avatar:text(item.avatar??item.avatarUrl??item.avatar240??previous.avatar??'',2048),phone:text(item.phoneNumber??item.phone??previous.phone??'',32),source:'friend',lastInteractionAt});
    };
    const inspect=(root)=>{
      if(!root||typeof root!=='object')return;
      const queue=[root],seen=new WeakSet();let count=0;
      while(queue.length&&count++<MAX_NODES){
        const value=queue.shift();
        if(!value||typeof value!=='object'||seen.has(value))continue;
        seen.add(value);add(value);
        let children;try{children=Array.isArray(value)?value:Object.values(value)}catch{continue;}
        for(const child of children)if(child&&typeof child==='object')queue.push(child);
      }
      flush();
    };
    const flush=()=>{
      const users=Array.from(found.values());
      if(users.length<=emitted)return;
      for(let offset=emitted;offset<users.length;offset+=50)emit({type:'batch',users:users.slice(offset,offset+50),processed:Math.min(offset+50,users.length),total:users.length});
      emitted=users.length;
    };
    const inspectText=(body)=>{try{if(typeof body==='string'&&body.length<12000000)inspect(JSON.parse(body))}catch{}};
    const originalParse=JSON.parse;
    JSON.parse=function(...args){const result=originalParse.apply(this,args);try{queueMicrotask(()=>inspect(result))}catch{}return result;};
    restores.push(()=>{JSON.parse=originalParse;});
    const originalFetch=window.fetch;
    if(typeof originalFetch==='function'){
      window.fetch=async function(...args){const response=await originalFetch.apply(this,args);try{response.clone().text().then(inspectText).catch(()=>{})}catch{}return response;};
      restores.push(()=>{window.fetch=originalFetch;});
    }
    const originalOpen=XMLHttpRequest.prototype.open,originalSend=XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open=function(...args){this.__nyZaloScanUrl=String(args[1]||'');return originalOpen.apply(this,args);};
    XMLHttpRequest.prototype.send=function(...args){this.addEventListener('load',()=>{try{if(this.responseType===''||this.responseType==='text')inspectText(this.responseText);else if(this.responseType==='json')inspect(this.response)}catch{}},{once:true});return originalSend.apply(this,args);};
    restores.push(()=>{XMLHttpRequest.prototype.open=originalOpen;XMLHttpRequest.prototype.send=originalSend;});
    const inspectElement=(element)=>{
      if(!element||typeof element!=='object')return;
      try{for(const key of Object.keys(element))if(key.startsWith('__reactProps$')||key.startsWith('__reactFiber$'))inspect(element[key])}catch{}
    };
    observer=new MutationObserver((mutations)=>{for(const mutation of mutations){inspectElement(mutation.target);for(const node of mutation.addedNodes||[])inspectElement(node)}});
    observer.observe(document.documentElement,{subtree:true,childList:true});
    const openContacts=()=>{
      const candidates=Array.from(document.querySelectorAll('button,[role="button"],[aria-label],[title],nav div')).slice(0,1500);
      const target=candidates.find((el)=>/^(danh bạ|contacts?)$/i.test(text(el.getAttribute('aria-label')||el.getAttribute('title')||el.textContent,80)));
      if(target){target.click();return true;}
      const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let node;
      while((node=walker.nextNode()))if(/^danh bạ$/i.test(text(node.nodeValue,80))){const clickable=node.parentElement?.closest('button,[role="button"],a,div');if(clickable){clickable.click();return true;}}
      return false;
    };
    const cleanup=()=>{clearTimeout(timer);try{observer.disconnect()}catch{}for(const restore of restores.reverse())try{restore()}catch{}if(window.__NYZaloUserScanCleanup===cleanup)delete window.__NYZaloUserScanCleanup;};
    window.__NYZaloUserScanCleanup=cleanup;
    const scanBuiltInManager=async()=>{
      const manager=window.FriendListManager;
      const method=manager&&['forceRequestGetFriendList','getFriendsList','getFriendList','getFriends'].find((name)=>typeof manager[name]==='function');
      if(!method)return false;
      try{
        const result=await manager[method]();
        const source=Array.isArray(result)?result:(Array.isArray(result?.data)?result.data:[]);
        inspect(source);
        if(!found.size)return false;
        cleanup();flush();emit({type:'complete',total:found.size});return true;
      }catch{return false;}
    };
    for(const key of ['__INITIAL_STATE__','__PRELOADED_STATE__','store','reduxStore','zaloStore'])try{inspect(window[key]?.getState?.()??window[key])}catch{}
    timer=setTimeout(()=>{cleanup();flush();if(found.size)emit({type:'complete',total:found.size});else emit({type:'incompatible',message:'Chưa nhận được dữ liệu danh bạ. Hãy mở mục Danh bạ trên Zalo Web rồi bấm Quét người dùng lại.'});},12000);
    scanBuiltInManager().then((completed)=>{if(completed)return;openContacts();setTimeout(openContacts,1200);setTimeout(()=>document.querySelectorAll('[class*="contact"],[class*="friend"],[data-id]').forEach(inspectElement),2600);});
  })()`;
}

function buildUnfriendUserScript(user) {
  const safeUserId = JSON.stringify(String(user?.userId || ''));
  const safeName = JSON.stringify(String(user?.name || ''));
  const safeSearchName = JSON.stringify(String(user?.zaloName || user?.displayName || user?.name || ''));
  const safeNames = JSON.stringify(Array.from(new Set([user?.name, user?.zaloName, user?.displayName].map((value) => String(value || '').trim()).filter(Boolean))).slice(0, 5));
  return `(async()=>{
    const userId=${safeUserId},wanted=${safeName},searchName=${safeSearchName};
    const wait=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
    const text=(value)=>String(value||'').normalize('NFC').replace(/[\\u200B-\\u200D\\uFEFF]/g,'').replace(/\\s+/g,' ').trim();
    const wantedNames=${safeNames}.map(text).filter(Boolean);
    const nameMatches=(value)=>{const normalized=text(value);return wantedNames.includes(normalized)};
    const containsName=(value)=>{const normalized=text(value);return wantedNames.some((name)=>normalized===name||normalized.startsWith(name+' ')||normalized.startsWith(name+'\\n'))};
    const usable=(el)=>!!(el&&el.isConnected&&!el.disabled&&el.getAttribute?.('aria-disabled')!=='true');
    const click=(el)=>{if(!usable(el))return false;el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));el.click();return true};
    const fail=(stage,message)=>({ok:false,stage,message:'['+stage+'] '+message});
    const findByLabel=(pattern)=>Array.from(document.querySelectorAll('button,[role="button"],a,[aria-label],[title],li,div')).filter(visible).filter((el)=>pattern.test(text(el.getAttribute('aria-label')||el.getAttribute('title')||el.innerText||el.textContent))).sort((a,b)=>a.getBoundingClientRect().width*a.getBoundingClientRect().height-b.getBoundingClientRect().width*b.getBoundingClientRect().height)[0];
    let friendListTitle=findByLabel(/^danh sách bạn bè$/i);
    if(!friendListTitle){
      const contacts=findByLabel(/^danh bạ$/i);
      if(!contacts||!click(contacts))return fail('CONTACTS','Không mở được mục Danh bạ của Zalo.');
      await wait(700);friendListTitle=findByLabel(/^danh sách bạn bè$/i);
    }
    if(!friendListTitle||!click(friendListTitle))return fail('FRIEND_LIST','Không mở được Danh sách bạn bè.');
    await wait(800);
    const search=Array.from(document.querySelectorAll('input')).filter(visible).find((el)=>/tìm bạn/i.test(text(el.placeholder||el.getAttribute('aria-label'))));
    if(!search)return fail('SEARCH','Không tìm thấy ô Tìm bạn trong Danh sách bạn bè.');
    search.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(search,searchName||wanted);search.dispatchEvent(new Event('input',{bubbles:true}));
    await wait(900);
    const nameElements=Array.from(document.querySelectorAll('span,div,p,strong')).filter(visible).filter((el)=>nameMatches(el.innerText||el.textContent)).sort((a,b)=>a.children.length-b.children.length);
    let row=null,more=null;
    for(const nameElement of nameElements){
      let candidate=nameElement;
      for(let depth=0;candidate&&depth<7;depth++,candidate=candidate.parentElement){
        const rect=candidate.getBoundingClientRect();
        if(rect.width<250||rect.height<35||rect.height>180)continue;
        const controls=Array.from(candidate.querySelectorAll('.icon__action__more,button,[role="button"],[aria-label],[title]')).filter(visible);
        const explicit=controls.find((el)=>/(thêm|tùy chọn|tuỳ chọn|more|menu)/i.test(text(el.getAttribute('aria-label')||el.getAttribute('title'))));
        const rightmost=controls.sort((a,b)=>b.getBoundingClientRect().right-a.getBoundingClientRect().right)[0];
        if(explicit||rightmost){row=candidate;more=explicit||rightmost;break;}
      }
      if(row)break;
    }
    if(!row)return fail('ROW','Không tìm thấy đúng dòng bạn bè theo tên đã quét.');
    if(!more){const rowRect=row.getBoundingClientRect();more=document.elementFromPoint(rowRect.right-24,rowRect.top+rowRect.height/2)?.closest('button,[role="button"],[aria-label],[title],div')}
    if(!more||!click(more))return fail('MORE','Không mở được menu ba chấm của người dùng.');
    await wait(450);
    const deleteAction=Array.from(document.querySelectorAll('button,[role="button"],li,[class*="menu"] div,.popover-v3 div')).filter(visible).filter((el)=>/^(xóa bạn|xoá bạn)$/i.test(text(el.innerText||el.textContent))).sort((a,b)=>a.children.length-b.children.length)[0];
    if(!deleteAction||!click(deleteAction))return fail('DELETE','Menu người dùng không có lệnh Xóa bạn.');
    await wait(450);
    const dialogs=Array.from(document.querySelectorAll('.zl-modal,[role="dialog"],[class*="modal"],[class*="dialog"]')).filter(visible);
    const dialog=dialogs.find((el)=>{const value=text(el.innerText||el.textContent);return /xóa.+khỏi danh sách bạn bè/i.test(value)&&wantedNames.some((name)=>value.includes(name))});
    if(!dialog)return fail('CONFIRM','Không thấy hộp xác nhận xóa đúng người dùng.');
    const confirm=Array.from(dialog.querySelectorAll('.zl-modal__footer__button,button,[role="button"]')).filter(visible).filter((el)=>/^(xóa|xoá)$/i.test(text(el.innerText||el.textContent))).sort((a,b)=>a.children.length-b.children.length)[0];
    if(!confirm||!click(confirm))return fail('CONFIRM','Không bấm được nút Xóa trong hộp xác nhận.');
    await wait(1400);
    const exactResultExists=()=>Array.from(document.querySelectorAll('[role="grid"][aria-label="grid"] span,[role="grid"][aria-label="grid"] div,[role="grid"][aria-label="grid"] p,[role="grid"][aria-label="grid"] strong')).filter(visible).some((el)=>el.children.length===0&&nameMatches(el.innerText||el.textContent));
    if(!exactResultExists())return {ok:true,verified:true,method:'contacts-dom',stage:'DONE'};
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(search,'');search.dispatchEvent(new Event('input',{bubbles:true}));
    await wait(300);
    setter.call(search,searchName||wanted);search.dispatchEvent(new Event('input',{bubbles:true}));
    await wait(1000);
    if(!exactResultExists())return {ok:true,verified:true,method:'contacts-dom-refresh',stage:'DONE'};
    return fail('VERIFY','Đã bấm Xóa nhưng người dùng vẫn còn trong kết quả Danh sách bạn bè.');
  })()`;
}

function buildUnfriendStepScript(user, stage) {
  const safeStage = JSON.stringify(String(stage || ''));
  const safeName = JSON.stringify(String(user?.name || ''));
  const safeSearchName = JSON.stringify(String(user?.zaloName || user?.displayName || user?.name || ''));
  const safeNames = JSON.stringify(Array.from(new Set([user?.name, user?.zaloName, user?.displayName].map((value) => String(value || '').trim()).filter(Boolean))).slice(0, 5));
  return `(()=>{
    const stage=${safeStage},wanted=${safeName},searchName=${safeSearchName};
    const text=(value)=>String(value||'').normalize('NFC').replace(/[\\u200B-\\u200D\\uFEFF]/g,'').replace(/\\s+/g,' ').trim();
    const wantedNames=${safeNames}.map(text).filter(Boolean);
    const nameMatches=(value)=>wantedNames.includes(text(value));
    const usable=(el)=>!!(el&&el.isConnected&&!el.disabled&&el.getAttribute?.('aria-disabled')!=='true');
    const click=(el)=>{if(!usable(el))return false;el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));el.click();return true};
    const ok=(extra={})=>({ok:true,stage,...extra});
    const fail=(message)=>({ok:false,stage,message:'['+stage+'] '+message});
    const exactLeaf=(root,pattern)=>Array.from((root||document).querySelectorAll('span,div,p,strong')).find((el)=>el.children.length===0&&usable(el)&&pattern.test(text(el.textContent)));
    const findControl=(pattern)=>Array.from(document.querySelectorAll('[title],[aria-label],[data-translate-title],button,[role="button"],a')).find((el)=>usable(el)&&pattern.test(text(el.getAttribute('title')||el.getAttribute('aria-label')||el.textContent)))||exactLeaf(document,pattern);
    if(stage==='CONTACTS'){
      if(findControl(/^danh sách bạn bè$/i))return ok({alreadyOpen:true});
      const contacts=findControl(/^danh bạ$/i);
      return contacts&&click(contacts)?ok():fail('Không mở được mục Danh bạ của Zalo.');
    }
    if(stage==='FRIEND_LIST'){
      const control=findControl(/^danh sách bạn bè$/i);
      return control&&click(control)?ok():fail('Không mở được Danh sách bạn bè.');
    }
    const search=Array.from(document.querySelectorAll('input')).find((el)=>usable(el)&&/tìm bạn/i.test(text(el.placeholder||el.getAttribute('aria-label'))));
    if(stage==='SEARCH'){
      if(!search)return fail('Không tìm thấy ô Tìm bạn.');
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      search.focus();setter.call(search,searchName||wanted);search.dispatchEvent(new Event('input',{bubbles:true}));
      return ok();
    }
    if(stage==='MORE'){
      const leaves=Array.from(document.querySelectorAll('span,div,p,strong')).filter((el)=>el.children.length===0&&usable(el)&&nameMatches(el.textContent));
      for(const leaf of leaves){
        let row=leaf;
        for(let depth=0;row&&depth<7;depth++,row=row.parentElement){
          const controls=Array.from(row.querySelectorAll('.icon__action__more,[aria-label],[title],button,[role="button"]')).filter(usable);
          const more=controls.find((el)=>el.matches('.icon__action__more'))||controls.find((el)=>/(thêm|tùy chọn|tuỳ chọn|more|menu)/i.test(text(el.getAttribute('aria-label')||el.getAttribute('title'))));
          if(more&&click(more))return ok();
        }
      }
      return fail('Không tìm thấy dòng hoặc menu ba chấm của đúng người dùng.');
    }
    if(stage==='DELETE'){
      const actions=Array.from(document.querySelectorAll('div,span,button,[role="button"],li')).filter((el)=>usable(el)&&el.children.length===0&&/^(xóa bạn|xoá bạn)$/i.test(text(el.textContent)));
      if(actions.length!==1)return fail(actions.length?'Có nhiều mục Xóa bạn, đã dừng để tránh chọn nhầm.':'Menu người dùng chưa xuất hiện mục Xóa bạn.');
      return click(actions[0])?ok():fail('Không click được mục Xóa bạn.');
    }
    if(stage==='CONFIRM'){
      const dialogs=Array.from(document.querySelectorAll('.zl-modal,[role="dialog"],[class*="modal"],[class*="dialog"]')).filter(usable);
      const dialog=dialogs.find((el)=>{const value=text(el.textContent);return /xóa.+khỏi danh sách bạn bè/i.test(value)&&wantedNames.some((name)=>value.includes(name))});
      if(!dialog)return fail('Không thấy hộp xác nhận xóa đúng người dùng.');
      const confirm=Array.from(dialog.querySelectorAll('.zl-modal__footer__button,button,[role="button"]')).filter((el)=>usable(el)&&/^(xóa|xoá)$/i.test(text(el.textContent))).sort((a,b)=>a.children.length-b.children.length)[0];
      return confirm&&click(confirm)?ok():fail('Không bấm được nút Xóa trong hộp xác nhận.');
    }
    if(stage==='REFRESH'){
      if(!search)return fail('Không còn ô Tìm bạn để xác minh.');
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      setter.call(search,'');search.dispatchEvent(new Event('input',{bubbles:true}));
      setter.call(search,searchName||wanted);search.dispatchEvent(new Event('input',{bubbles:true}));
      return ok();
    }
    if(stage==='VERIFY'){
      const grids=Array.from(document.querySelectorAll('[role="grid"]')).filter(usable);
      const roots=grids.length?grids:[document];
      const remains=roots.some((root)=>Array.from(root.querySelectorAll('span,div,p,strong')).some((el)=>el.children.length===0&&usable(el)&&nameMatches(el.textContent)));
      return remains?fail('Người dùng vẫn còn trong kết quả Danh sách bạn bè.'):ok({verified:true,method:'contacts-stepped'});
    }
    return fail('Bước thao tác không hợp lệ.');
  })()`;
}

module.exports = { normalizeInteractionTime, normalizeZaloUsers, filterAndSortUsers, buildUnfriendPlan, UserScanStore, buildUserExtractorScript, buildUnfriendUserScript, buildUnfriendStepScript };
