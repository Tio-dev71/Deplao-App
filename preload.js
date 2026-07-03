const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('messengerApp', {
  onNotificationClick: () => ipcRenderer.send('notification-click'),
  toggleDarkMode: () => ipcRenderer.send('toggle-dark-mode'),
  toggleAlwaysOnTop: () => ipcRenderer.send('toggle-always-on-top'),
  reloadPage: () => ipcRenderer.send('reload-page'),
  zoomIn: () => ipcRenderer.send('zoom-in'),
  zoomOut: () => ipcRenderer.send('zoom-out'),
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  getSettings: () => ipcRenderer.sendSync('get-settings'),
  sendProfileInfo: (info) => ipcRenderer.send('profile-info-extracted', info),
  sendCurrentChatInfo: (info) => ipcRenderer.send('current-chat-info-extracted', info),
  sendRecentChats: (chats) => ipcRenderer.send('recent-chats-extracted', chats),
  sendTextToActiveChat: (message) => ipcRenderer.invoke('active-chat-send-text', message),
});

const settings = ipcRenderer.sendSync('get-settings');

function runInjection(currentSettings) {
  const injectionScript = `
    window.__DepLaoBlockSeen = ${currentSettings.blockSeen || false};
    window.__DepLaoBlockTyping = ${currentSettings.blockTyping || false};
    window.__DepLaoZaDarkShield = ${currentSettings.zadarkShield || false};

    (function() {
      if (window.__DepLaoInjected) return;
      window.__DepLaoInjected = true;
      var host = window.location.hostname || '';
      var isZalo = host === 'chat.zalo.me' || host.includes('zalo.me');
      var isMessenger = host.includes('messenger.com') || host.includes('facebook.com');
      var isWhatsApp = host.includes('whatsapp.com');
      var isTelegram = host.includes('telegram.org') || host.includes('web.telegram.org');
      var platform = isZalo ? 'Zalo' : isMessenger ? 'Messenger' : isWhatsApp ? 'WhatsApp' : isTelegram ? 'Telegram' : 'Unknown';
      if (platform === 'Unknown') return;

      function shouldBlockSeen(url) {
        if (!window.__DepLaoBlockSeen) return false;
        if (isZalo) return (url.includes('/api/message/read') || url.includes('/api/message/seen')) && !url.includes('read_status');
        if (isMessenger) return url.includes('change_read_status') || url.includes('mark_read') || url.includes('read_receipt') || url.includes('/ajax/mercury/mark_seen');
        if (isWhatsApp) return url.includes('/read') || url.includes('receipt');
        if (isTelegram) return url.includes('readHistory') || url.includes('messages.read') || url.includes('readMentions');
        return false;
      }
      function shouldBlockTyping(url) {
        if (!window.__DepLaoBlockTyping) return false;
        if (isZalo) return url.includes('/api/message/typing');
        if (isMessenger) return url.includes('typ.php') || url.includes('typing_indicator') || url.includes('send_typing_indicator');
        if (isWhatsApp) return url.includes('chatstate') || url.includes('composing') || url.includes('typing');
        if (isTelegram) return url.includes('setTyping') || url.includes('sendMessageTypingAction') || url.includes('typing');
        return false;
      }
      function shouldDropPayload(data) {
        if (typeof data !== 'string') return false;
        if (isZalo) {
          if (window.__DepLaoBlockSeen && (data.includes('"cmd":97') || data.includes('"action":"read"'))) return true;
          if (window.__DepLaoBlockTyping && (data.includes('"cmd":121') || data.includes('"cmd":122') || data.includes('"action":"typing"'))) return true;
        }
        if (isMessenger) {
          if (window.__DepLaoBlockSeen && (data.includes('"type":"read"') || data.includes('mark_read') || data.includes('read_receipt'))) return true;
          if (window.__DepLaoBlockTyping && (data.includes('"type":"typ"') || data.includes('typing') || data.includes('composing'))) return true;
        }
        if (isWhatsApp) {
          if (window.__DepLaoBlockSeen && (data.includes('"read"') || data.includes('"receipt"') || data.includes('"ack"'))) return true;
          if (window.__DepLaoBlockTyping && (data.includes('"composing"') || data.includes('"chatstate"') || data.includes('"paused"'))) return true;
        }
        if (isTelegram) {
          if (window.__DepLaoBlockSeen && (data.includes('readHistory') || data.includes('messages.read'))) return true;
          if (window.__DepLaoBlockTyping && (data.includes('sendMessageTypingAction') || data.includes('setTyping'))) return true;
        }
        return false;
      }

      var originalFetch = window.fetch;
      window.fetch = function() {
        var args = arguments;
        var url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : '');
        if (shouldBlockSeen(url) || shouldBlockTyping(url)) return Promise.resolve(new Response(JSON.stringify({error:0,msg:'Blocked by DepLao'}), { status: 200 }));
        return originalFetch.apply(this, args);
      };
      var originalXHROpen = XMLHttpRequest.prototype.open;
      var originalXHRSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url) { this._url = typeof url === 'string' ? url : (url ? url.toString() : ''); return originalXHROpen.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function() {
        var url = this._url || '';
        if (shouldBlockSeen(url) || shouldBlockTyping(url)) {
          Object.defineProperty(this, 'readyState', {get:function(){return 4;}});
          Object.defineProperty(this, 'status', {get:function(){return 200;}});
          Object.defineProperty(this, 'responseText', {get:function(){return '{"error":0}';}});
          if (this.onreadystatechange) this.onreadystatechange();
          if (this.onload) this.onload();
          return;
        }
        return originalXHRSend.apply(this, arguments);
      };
      var originalWSSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function(data) {
        if (shouldDropPayload(data)) return;
        return originalWSSend.call(this, data);
      };

      function applyZaDarkShield() {
        if (!window.__DepLaoZaDarkShield) return;
        try {
          Object.defineProperty(navigator, 'webdriver', { get: function() { return false; }, configurable: true });
        } catch(e) {}
        try {
          var style = document.getElementById('dep-lao-zadark-style');
          if (!style) {
            style = document.createElement('style');
            style.id = 'dep-lao-zadark-style';
            style.textContent = 'html{color-scheme:dark;} body{scrollbar-color:#3b82f6 #111827;} ::selection{background:#2563eb!important;color:#fff!important;}';
            document.documentElement.appendChild(style);
          }
        } catch(e) {}
      }
      applyZaDarkShield();
      setInterval(applyZaDarkShield, 3000);

      var originalWindowOpen = window.open;
      window.open = function(url, target, features) {
        var win = originalWindowOpen.call(window, url, target, features);
        if (!win) return { closed:false, focus:function(){}, close:function(){} };
        return win;
      };

      // Quick Reply Shortcut System - intercepts /1, /2, etc.
      window.__DepLaoQuickReplies = ${JSON.stringify(settings.quickReplies || [])};

      function setupQuickReplyShortcuts() {
        if (window.__DepLaoShortcutsReady) return;
        window.__DepLaoShortcutsReady = true;

        document.addEventListener('keydown', function(e) {
          if (e.key !== 'Enter') return;
          var replies = window.__DepLaoQuickReplies;
          if (!replies || !replies.length) return;

          var targetInput = e.target;
          if (!targetInput) return;

          var isEditable = targetInput.isContentEditable || targetInput.tagName === 'TEXTAREA' || targetInput.tagName === 'INPUT' || targetInput.getAttribute('contenteditable') === 'true' || targetInput.getAttribute('role') === 'textbox';
          if (!isEditable) return;

          var text = (targetInput.value !== undefined ? targetInput.value : (targetInput.innerText || targetInput.textContent || '')).trim();
          var match = text.match(/^\\/([0-9]+)$/);
          if (!match) return;

          var idx = parseInt(match[1], 10) - 1;
          if (idx < 0 || idx >= replies.length) return;

          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();

          // Clear the input and insert the template message
          targetInput.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, replies[idx].message);
          if (targetInput.value !== undefined) {
            targetInput.dispatchEvent(new Event('input', { bubbles: true }));
          }

          // Trigger send after a short delay
          setTimeout(function() {
            var sendBtn = document.querySelector('[data-translate-title="STR_SEND"]') || document.querySelector('button[class*="send"]') || document.querySelector('.chat-input__send-btn') || document.querySelector('[aria-label="Gửi"]') || document.querySelector('[aria-label="Send"]');
            if (sendBtn) {
              sendBtn.click();
            } else {
              // Simulate Enter key to send
              var enterEvent = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
              targetInput.dispatchEvent(enterEvent);
            }
          }, 100);
        }, true);

        // Also show a small hint when user types /
        document.addEventListener('input', function(e) {
          var replies = window.__DepLaoQuickReplies;
          if (!replies || !replies.length) return;
          var targetInput = e.target;
          if (!targetInput) return;

          var isEditable = targetInput.isContentEditable || targetInput.tagName === 'TEXTAREA' || targetInput.tagName === 'INPUT' || targetInput.getAttribute('contenteditable') === 'true' || targetInput.getAttribute('role') === 'textbox';
          if (!isEditable) return;

          var text = (targetInput.value !== undefined ? targetInput.value : (targetInput.innerText || targetInput.textContent || '')).trim();
          var existingHint = document.getElementById('dep-lao-shortcut-hint');

          if (text.match(/^\\/[0-9]*$/)) {
            if (!existingHint) {
              existingHint = document.createElement('div');
              existingHint.id = 'dep-lao-shortcut-hint';
              existingHint.style.cssText = 'position:absolute;bottom:100%;left:16px;right:16px;background:rgba(20,22,30,.95);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:10px 0;z-index:999;max-height:240px;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,.5);';
              var inputContainer = targetInput.closest('[class*="chat-input"]') || targetInput.closest('[role="presentation"]') || targetInput.parentElement;
              if (inputContainer) { inputContainer.style.position = 'relative'; inputContainer.appendChild(existingHint); }
            }
            existingHint.innerHTML = '';
            replies.forEach(function(r, i) {
              var item = document.createElement('div');
              var shortcut = '/' + (i + 1);
              var isActive = text === shortcut;
              item.style.cssText = 'padding:8px 16px;cursor:pointer;display:flex;align-items:center;gap:10px;transition:background .15s;' + (isActive ? 'background:rgba(10,132,255,.2);' : '');
              item.innerHTML = '<span style="background:rgba(10,132,255,.3);color:#65b7ff;padding:3px 8px;border-radius:8px;font-size:12px;font-weight:700;font-family:monospace;flex-shrink:0;">' + shortcut + '</span><span style="font-size:13px;color:rgba(255,255,255,.85);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (r.message.length > 60 ? r.message.substring(0, 60) + '...' : r.message) + '</span>';
              item.onmouseenter = function() { item.style.background = 'rgba(255,255,255,.08)'; };
              item.onmouseleave = function() { item.style.background = isActive ? 'rgba(10,132,255,.2)' : ''; };
              item.onclick = function(ev) {
                ev.preventDefault(); ev.stopPropagation();
                targetInput.focus();
                document.execCommand('selectAll', false, null);
                document.execCommand('insertText', false, r.message);
                if (targetInput.value !== undefined) targetInput.dispatchEvent(new Event('input', { bubbles: true }));
                if (existingHint) existingHint.remove();
              };
              existingHint.appendChild(item);
            });
            existingHint.style.display = 'block';
          } else {
            if (existingHint) existingHint.style.display = 'none';
          }
        }, true);
      }
      setTimeout(setupQuickReplyShortcuts, 3000);

      // Auto extract recent chats
      function extractRecentChats() {
        if (!isZalo) return;
        var chats = [];
        try {
          var items = document.querySelectorAll('.msg-item, [data-id], .group-board-item');
          items.forEach(function(item) {
            var nameEl = item.querySelector('.conv-item-title__name, .item-title__name, .item-title, .truncate');
            if (nameEl) {
               var name = (nameEl.innerText || '').replace(/\s+/g, ' ').trim();
               if (name && !chats.includes(name)) {
                  chats.push(name);
               }
            }
          });
          if (chats.length > 0) {
            window.messengerApp.sendRecentChats(chats);
          }
        } catch (e) {}
      }
      setInterval(extractRecentChats, 6000);


      // Auto extract profile name & avatar
      function extractCurrentChatInfo() {
        var info = { name: '', platform: platform.toLowerCase() };
        try {
          if (isZalo) {
            var chatNameEl = document.querySelector('.header-title') || document.querySelector('.title-name');
            if (chatNameEl) info.name = (chatNameEl.innerText || '').replace(/\s+/g, ' ').trim();
          } else if (isMessenger) {
            var chatNameEl = document.querySelector('span[dir="auto"]');
            if (document.title && document.title.includes('Messenger')) {
               var t = document.title.replace('| Messenger', '').trim();
               if (t !== 'Messenger' && t !== 'Facebook') info.name = t;
            }
          } else if (isWhatsApp) {
            var chatNameEl = document.querySelector('#main header span[dir="auto"]');
            if (chatNameEl) info.name = chatNameEl.innerText.trim();
          } else if (isTelegram) {
            var chatNameEl = document.querySelector('.MiddleHeader .chat-title, .middle-header .peer-title');
            if (chatNameEl) info.name = chatNameEl.innerText.trim();
          }
        } catch (e) {}
        if (info.name) {
          try { window.messengerApp.sendCurrentChatInfo(info); } catch (e) {}
        }
      }
      setInterval(extractCurrentChatInfo, 3000);

      function extractProfileInfo() {
        var info = { name: '', avatar: '' };
        try {
          if (isZalo) {
            try { require('fs').writeFileSync('/Users/tiodev/Desktop/ZaloPre/zalo_dom.html', document.documentElement.outerHTML); } catch (e) {}
            var nameEl = document.querySelector('.str-name') || document.querySelector('.header-title');
            var avatarEl = document.querySelector('.nav__tabs__avatar img, .zavatar-img, .zavatar img, .avatar-img');
            if (!avatarEl) {
              var imgs = Array.from(document.querySelectorAll('img'));
              avatarEl = imgs.find(img => img.src && (img.src.includes('ava') || img.src.includes('zavatar')));
              if (!avatarEl && imgs.length > 0) avatarEl = imgs[0];
            }
            if (nameEl) info.name = (nameEl.innerText || '').replace(/\s+/g, ' ').trim();
            if (avatarEl) info.avatar = avatarEl.src;
          } else if (isMessenger) {
            var titleEl = document.querySelector('title');
            if (titleEl && titleEl.innerText) {
              var t = titleEl.innerText;
              if (t.includes('(')) t = t.substring(t.indexOf(')') + 1);
              info.name = t.replace('Messenger', '').trim();
            }
            var avatarEl = document.querySelector('img[role="img"]') || document.querySelector('image[preserveAspectRatio="xMidYMid slice"]');
            if (avatarEl) info.avatar = avatarEl.src || avatarEl.getAttribute('xlink:href');
          } else if (isWhatsApp) {
            var nameEl = document.querySelector('h1.tvf2evcx') || document.querySelector('header span[dir="auto"]');
            var avatarEl = document.querySelector('header img');
            if (nameEl) info.name = nameEl.innerText.trim();
            if (avatarEl) info.avatar = avatarEl.src;
          } else if (isTelegram) {
            var nameEl = document.querySelector('.peer-title');
            var avatarEl = document.querySelector('.Avatar img');
            if (nameEl) info.name = nameEl.innerText.trim();
            if (avatarEl) info.avatar = avatarEl.src;
          } else if (host.includes('facebook.com')) {
            var nameEl = document.querySelector('h1') || document.querySelector('title');
            var avatarEl = document.querySelector('img[referrerpolicy="origin-when-cross-origin"]');
            if (nameEl) {
              var t = nameEl.innerText || '';
              if (t.includes('(')) t = t.substring(t.indexOf(')') + 1);
              info.name = t.replace('Facebook', '').trim();
            }
            if (avatarEl) info.avatar = avatarEl.src;
          }
        } catch (e) { console.error('Extracted error', e); }
        if (info.name || info.avatar) {
          try { window.messengerApp.sendProfileInfo(info); } catch (e) { console.error('sendProfileInfo error', e); }
        }
      }
      setInterval(extractProfileInfo, 5000);

      console.log('[DepLao] Shield ready:', platform, window.__DepLaoBlockSeen, window.__DepLaoBlockTyping, window.__DepLaoZaDarkShield);
    })();
  `;
  webFrame.executeJavaScript(injectionScript);
}

runInjection(settings);

ipcRenderer.on('update-block-settings', (event, newSettings) => {
  webFrame.executeJavaScript(`
    window.__DepLaoBlockSeen = ${!!newSettings.blockSeen};
    window.__DepLaoBlockTyping = ${!!newSettings.blockTyping};
    window.__DepLaoZaDarkShield = ${!!newSettings.zadarkShield};
    var style = document.getElementById('dep-lao-zadark-style');
    if (!window.__DepLaoZaDarkShield && style) style.remove();
    console.log('[DepLao] Cập nhật bảo mật:', window.__DepLaoBlockSeen, window.__DepLaoBlockTyping, window.__DepLaoZaDarkShield);
  `);
});

ipcRenderer.on('update-quick-replies', (event, replies) => {
  webFrame.executeJavaScript(`
    window.__DepLaoQuickReplies = ${JSON.stringify(replies)};
    console.log('[DepLao] Cập nhật tin nhắn mẫu:', window.__DepLaoQuickReplies.length, 'mẫu');
  `);
});
