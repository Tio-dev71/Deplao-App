// Preload nay chay trong sandbox (Electron >= 20 bat sandbox mac dinh cho BrowserView),
// nen CHI duoc require('electron'). Moi require khac (fs, path, ...) se lam ca preload
// khong load duoc -> mat contextBridge va mat cac listener IPC quet nhom/nguoi dung.
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
  sendUnreadConversationCount: (count) => ipcRenderer.send('profile-unread-count', count),
  sendTextToActiveChat: (message) => ipcRenderer.invoke('active-chat-send-text', message),
  emitZaloGroupScanEvent: (payload) => ipcRenderer.send('zalo-group-scan:event', payload),
  emitZaloUserScanEvent: (payload) => ipcRenderer.send('zalo-user-scan:event', payload),
  pasteQuickReplyImage: (imagePath) => ipcRenderer.invoke('quick-reply:paste-image', imagePath),
});

// Neu main process chua kip dang ky listener thi sendSync tra ve undefined;
// dung object rong de preload khong bao gio chet giua duong (mat bridge + mat listener quet).
const settings = ipcRenderer.sendSync('get-settings') || {};
// Font Quicksand duoc main process doc tu dia va gui kem theo get-settings,
// vi preload sandbox khong the tu doc file.
const quicksandFontDataUrl = (settings && settings.quicksandFontDataUrl) || '';

function runInjection(currentSettings) {
  const injectionScript = `
    window.__DepLaoBlockSeen = ${currentSettings.blockSeen || false};
    window.__DepLaoBlockTyping = ${currentSettings.blockTyping || false};
    window.__DepLaoZaDarkShield = ${currentSettings.zadarkShield || false};

    (function() {
      if (window.__DepLaoInjected && typeof window.__DepLaoRunQuickReply === 'function') return;
      window.__DepLaoInjected = true;
      var host = window.location.hostname || '';
      var isZalo = host === 'chat.zalo.me' || host.includes('zalo.me');
      var isMessenger = host.includes('messenger.com') || host.includes('facebook.com');
      var isWhatsApp = host.includes('whatsapp.com');
      var isTelegram = host.includes('telegram.org') || host.includes('web.telegram.org');
      var platform = isZalo ? 'Zalo' : isMessenger ? 'Messenger' : isWhatsApp ? 'WhatsApp' : isTelegram ? 'Telegram' : 'Unknown';
      if (platform === 'Unknown') return;

      var nhaYenFontFamily = 'Quicksand, sans-serif';
      var nhaYenFontDataUrl = ${JSON.stringify(quicksandFontDataUrl)};
      if (nhaYenFontDataUrl && window.FontFace && document.fonts) {
        try {
          var nhaYenFont = new FontFace('Quicksand', 'url(' + nhaYenFontDataUrl + ')', { weight: '300 700', style: 'normal' });
          nhaYenFont.load().then(function(loadedFont) { document.fonts.add(loadedFont); }).catch(function() {});
        } catch (_) {}
      }

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

      // Quick Reply Shortcut System - Nhà Yến dùng dấu / và ẩn panel gốc của Zalo Web.
      window.__DepLaoQuickReplies = ${JSON.stringify(currentSettings.quickReplies || [])};

      var QUICK_REPLY_IMAGE_TIMEOUT_MS = 12000;
      var QUICK_REPLY_POLL_MS = 150;

      function findComposerInput() {
        var selectors = ['#richInput', '.chat-input [contenteditable="true"]', '[contenteditable="true"]', 'textarea'];
        for (var i = 0; i < selectors.length; i++) {
          var nodes = document.querySelectorAll(selectors[i]);
          for (var j = 0; j < nodes.length; j++) {
            var rect = nodes[j].getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) return nodes[j];
          }
        }
        return null;
      }

      function findComposerFromTarget(target) {
        var node = target && target.nodeType === Node.TEXT_NODE ? target.parentElement : target;
        if (!node || !node.closest) return null;
        var editable = node.closest('#richInput, .chat-input [contenteditable="true"], [contenteditable="true"], textarea');
        if (!editable) return null;
        var rect = editable.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        var composer = findComposerInput();
        return composer && (editable === composer || editable.contains(composer) || composer.contains(editable)) ? composer : editable;
      }

      // Vùng soạn tin là nơi duy nhất được quyền chứa ảnh đính kèm đang chờ gửi.
      function composerRoot() {
        var selectors = ['[class*="chat-input"]', '[class*="chatInput"]', 'footer'];
        for (var i = 0; i < selectors.length; i++) {
          var nodes = document.querySelectorAll(selectors[i]);
          for (var j = nodes.length - 1; j >= 0; j--) {
            var rect = nodes[j].getBoundingClientRect();
            if (rect.width > 120 && rect.height > 60) return nodes[j];
          }
        }
        return document.body;
      }

      // Ảnh "sắp gửi" luôn là blob:/data: URL do Zalo vừa tạo, không phải ảnh tin nhắn cũ.
      function composerPendingImageNodes(root) {
        var hits = [];
        var nodes = root.querySelectorAll('img, [style*="background-image"]');
        for (var i = 0; i < nodes.length; i++) {
          var el = nodes[i];
          var src = String(el.currentSrc || el.src || '');
          var style = String(el.getAttribute && el.getAttribute('style') || '');
          var isPending = src.indexOf('blob:') === 0 || src.indexOf('data:image') === 0 || style.indexOf('blob:') > -1;
          if (!isPending) continue;
          var rect = el.getBoundingClientRect();
          if (rect.width < 20 || rect.height < 20) continue;
          hits.push(el);
        }
        if (!hits.length) {
          var items = root.querySelectorAll('[class*="attachment" i]');
          for (var k = 0; k < items.length; k++) {
            var itemRect = items[k].getBoundingClientRect();
            if (itemRect.width < 20 || itemRect.height < 20) continue;
            if (items[k].closest('#richInput')) continue;
            hits.push(items[k]);
          }
        }
        return hits;
      }

      // Chờ Zalo thực sự vẽ ảnh preview trong ô soạn tin; không đoán bằng thời gian cố định.
      function waitForComposerImage(previousCount, timeoutMs) {
        return new Promise(function(resolve) {
          var deadline = Date.now() + timeoutMs;
          var observer = null;
          var timer = null;

          function finish(ok) {
            if (observer) { try { observer.disconnect(); } catch (e) {} observer = null; }
            if (timer) { clearInterval(timer); timer = null; }
            resolve(ok);
          }
          function check() {
            if (composerPendingImageNodes(composerRoot()).length > previousCount) { finish(true); return; }
            if (Date.now() >= deadline) finish(false);
          }

          try {
            observer = new MutationObserver(function() { check(); });
            observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style', 'class'] });
          } catch (e) {}
          timer = setInterval(check, QUICK_REPLY_POLL_MS);
          check();
        });
      }

      function clearComposerNotice() {
        var box = document.getElementById('dep-lao-quick-reply-notice');
        if (box) box.remove();
      }

      function showQuickReplyNotice(message) {
        var box = document.getElementById('dep-lao-quick-reply-notice');
        if (!box) {
          box = document.createElement('div');
          box.id = 'dep-lao-quick-reply-notice';
          box.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:120px;z-index:2147483000;max-width:70%;padding:10px 16px;border-radius:12px;background:rgba(20,22,30,.96);color:#ffd9d9;font-size:13px;line-height:1.4;box-shadow:0 12px 32px rgba(0,0,0,.45);pointer-events:none;transition:opacity .25s;font-family:' + nhaYenFontFamily + ';';
          document.body.appendChild(box);
        }
        box.textContent = message;
        box.style.opacity = '1';
        clearTimeout(box.__depLaoTimer);
        box.__depLaoTimer = setTimeout(clearComposerNotice, 7000);
      }

      function composerTextValue(input) {
        return String(input.value !== undefined && input.value !== '' ? input.value : (input.innerText || input.textContent || ''));
      }

      // Chỉ khoanh vùng chọn trong chính ô soạn tin: selectAll cả trang làm người dùng
      // tưởng Ctrl+A lan sang nơi khác và execCommand chèn chữ cũng dễ thất bại.
      function selectAllComposerText(targetInput) {
        targetInput.focus();
        var selection = window.getSelection && window.getSelection();
        var range = document.createRange();
        try { range.selectNodeContents(targetInput); } catch (err) { range.selectNode(targetInput); }
        if (selection) { selection.removeAllRanges(); selection.addRange(range); }
      }

      function clearComposerText(targetInput) {
        targetInput.focus();
        selectAllComposerText(targetInput);
        document.execCommand('delete', false, null);
        if (targetInput.value !== undefined) targetInput.value = '';
        targetInput.dispatchEvent(new Event('input', { bubbles: true }));
      }

      // Luồng gõ \keyword trong ô chat: focus đã sẵn trong ô soạn nên execCommand
      // vẫn đáng tin ở đây; chỉ luồng nút "Chèn" (focus nằm ngoài tab Zalo) mới cần
      // nhờ main process dán chữ bằng webContents.insertText.
      function insertComposerTextInPage(targetInput, text) {
        targetInput.focus();
        if (targetInput.value !== undefined) {
          targetInput.value = text;
          targetInput.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
        var ok = false;
        try { ok = document.execCommand('insertText', false, text); } catch (err) { ok = false; }
        if (!ok) targetInput.innerText = text;
        targetInput.dispatchEvent(new Event('input', { bubbles: true }));
        return String(composerTextValue(targetInput)).trim().length > 0;
      }

      // Che panel tin nhắn nhanh gốc của Zalo (chỉ trong vùng soạn tin) để không đấu với danh sách của Nhà Yến.
      function hideZaloQuickReplyPanel() {
        var candidates = document.querySelectorAll('[class*="quick-reply" i], [class*="quickReply" i], [class*="command-list" i], [class*="cmd-list" i]');
        for (var i = 0; i < candidates.length; i++) {
          var el = candidates[i];
          if (el.id && String(el.id).indexOf('dep-lao') === 0) continue;
          var anchor = el.closest('[class*="chat-input" i], [class*="chatInput" i], footer');
          if (!anchor) continue;
          if (el.style.display === 'none') continue;
          el.style.setProperty('display', 'none', 'important');
          el.setAttribute('data-dep-lao-hidden', 'zalo-quick-reply');
        }
      }

      function setupQuickReplyPanelHider() {
        if (window.__DepLaoQuickReplyHiderReady) return;
        window.__DepLaoQuickReplyHiderReady = true;
        hideZaloQuickReplyPanel();
        setInterval(hideZaloQuickReplyPanel, 700);
      }

      async function applyQuickReply(targetInput, reply, typedText, viaMain) {
        if (!targetInput || !reply || window.__DepLaoApplyingQuickReply) {
          return { ok: false, message: 'Đang có mẫu khác chờ chèn. Thử lại sau giây lát.' };
        }
        window.__DepLaoApplyingQuickReply = true;
        var keyword = String(reply.keyword || '').trim();
        try {
          var currentText = String(typedText !== undefined ? typedText : composerTextValue(targetInput));
          var trigger = String.fromCharCode(92);
          var triggerIndex = currentText.lastIndexOf(trigger);
          var finalMessage = (triggerIndex >= 0 ? currentText.slice(0, triggerIndex) : '') + String(reply.message || '');
          var imagePath = String(reply.imagePath || '').trim();
          if (imagePath) {
            var before = composerPendingImageNodes(composerRoot()).length;
            var paste = null;
            try { paste = await window.messengerApp.pasteQuickReplyImage(imagePath); }
            catch (err) { paste = { ok: false, message: String((err && err.message) || err) }; }
            if (!paste || !paste.ok) {
              showQuickReplyNotice('Mẫu ' + trigger + keyword + ' không chèn được ảnh: ' + ((paste && paste.message) || 'lỗi không rõ') + '. Tin nhắn chưa được điền.');
              return { ok: false, stage: 'paste', message: (paste && paste.message) || 'Không dán được ảnh.' };
            }
            var appeared = await waitForComposerImage(before, QUICK_REPLY_IMAGE_TIMEOUT_MS);
            if (!appeared) {
              showQuickReplyNotice('Zalo chưa hiển thị ảnh của mẫu ' + trigger + keyword + ' sau ' + Math.round(QUICK_REPLY_IMAGE_TIMEOUT_MS / 1000) + ' giây. Ảnh và tin nhắn chưa được điền.');
              return { ok: false, stage: 'preview', message: 'Zalo không hiển thị preview ảnh trong ô soạn tin.' };
            }
          }
          clearComposerNotice();
          clearComposerText(targetInput);
          // Nút "Chèn" nằm ngoài ô soạn (focus ngoài tab Zalo) → giao cho main process dán bằng webContents.insertText.
          // Luồng gõ \keyword ngay trong ô soạn → dán in-page cho mượt, không round-trip thêm.
          if (viaMain) return { ok: true, doneByMain: true, finalMessage: finalMessage, keyword: keyword };
          insertComposerTextInPage(targetInput, finalMessage);
          return { ok: true, keyword: keyword };
        } catch (err) {
          return { ok: false, message: String((err && err.message) || err) };
        } finally {
          setTimeout(function() { window.__DepLaoApplyingQuickReply = false; }, 100);
        }
      }

      // Chốt bước chèn chữ sau khi main process đã dán chữ bằng webContents.insertText
      window.__DepLaoFinalizeQuickReply = function(result) {
        if (result && result.doneByMain) {
          var box = document.getElementById('dep-lao-quick-reply-notice');
          if (box) box.remove();
        }
        return result;
      };

      // Nút "Chèn" trong bảng quản lý dùng đúng luồng này trên tab Zalo đang mở.
      window.__DepLaoRunQuickReply = function(reply) {
        var input = findComposerInput();
        if (!input) return Promise.resolve({ ok: false, message: 'Không tìm thấy ô soạn tin Zalo. Hãy mở một cuộc trò chuyện.' });
        if (!String(composerTextValue(input)).trim()) input.focus();
        return applyQuickReply(input, reply || {}, undefined, true);
      };

      // Ẩn panel Tin nhắn nhanh gốc của Zalo để chỉ còn danh sách của Nhà Yến (chỉ ẩn bằng CSS, không vá sâu vào Zalo).
      setupQuickReplyPanelHider();

      function setupQuickReplyShortcuts() {
        if (window.__DepLaoShortcutsReady) return;
        window.__DepLaoShortcutsReady = true;

        var activeHintIndex = 0;
        var autoFillTimer = null;
        document.addEventListener('keydown', function(e) {
          var hint = document.getElementById('dep-lao-shortcut-hint');
          // Chi huy timer tu dong dien khi phim nay thay doi trang thai goi y hoac noi dung o nhap;
          // phim dieu huong (Home/End/mui ten) khong lam thay doi text nen giu timer song sot.
          var cancelsAutoFill = e.key === 'Escape' || (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) || e.key === 'Enter' || e.key === 'Tab' || e.key === 'Backspace' || e.key === 'Delete';
          if (autoFillTimer && cancelsAutoFill) { clearTimeout(autoFillTimer); autoFillTimer = null; }
          if (!hint || hint.style.display === 'none' || !hint.children.length) return;
          var items = Array.from(hint.children);
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault(); e.stopPropagation();
            activeHintIndex = (activeHintIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items.forEach(function(item, index) { item.style.background = index === activeHintIndex ? 'rgba(10,132,255,.2)' : ''; });
            items[activeHintIndex].scrollIntoView({ block: 'nearest' });
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault(); e.stopPropagation(); items[activeHintIndex].click();
          } else if (e.key === 'Escape') {
            e.preventDefault(); hint.style.display = 'none';
          }
        }, true);

        // Gợi ý riêng của Nhà Yến dùng dấu \, kể cả khi event phát từ phần tử con của contenteditable.
        document.addEventListener('input', function(e) {
          if (window.__DepLaoApplyingQuickReply) return;
          if (autoFillTimer) { clearTimeout(autoFillTimer); autoFillTimer = null; }
          var replies = window.__DepLaoQuickReplies;
          if (!replies || !replies.length) return;
          var targetInput = findComposerFromTarget(e.target);
          if (!targetInput) return;
          var text = composerTextValue(targetInput);
          var existingHint = document.getElementById('dep-lao-shortcut-hint');
          var trigger = String.fromCharCode(92);
          var token = String(text).replace(/[​-‍﻿]/g, '').trim();
          var validToken = token.charCodeAt(0) === 92;
          for (var tokenIndex = 1; validToken && tokenIndex < token.length; tokenIndex++) {
            var tokenCode = token.charCodeAt(tokenIndex);
            if (tokenCode === 9 || tokenCode === 10 || tokenCode === 13 || tokenCode === 32 || tokenCode === 160 || tokenCode === 92) validToken = false;
          }
          var normalizeSearch = function(value) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('vi'); };
          var query = normalizeSearch(token.slice(1));
          if (validToken) {
            if (!existingHint) {
              existingHint = document.createElement('div');
              existingHint.id = 'dep-lao-shortcut-hint';
              existingHint.style.cssText = 'position:absolute;bottom:100%;left:16px;right:16px;background:rgba(20,22,30,.95);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:10px 0;z-index:999;max-height:240px;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,.5);font-family:' + nhaYenFontFamily + ';font-size:13px;';
              var inputContainer = targetInput.closest('[class*="chat-input"]') || targetInput.closest('[role="presentation"]') || targetInput.parentElement;
              if (inputContainer) { inputContainer.style.position = 'relative'; inputContainer.appendChild(existingHint); }
            }
            existingHint.innerHTML = '';
            activeHintIndex = 0;
            var ranked = replies.map(function(reply, index) { return { reply: reply, keyword: String(reply.keyword || (index + 1)), order: index }; })
              .filter(function(entry) { return normalizeSearch(entry.keyword).startsWith(query); })
              .sort(function(a, b) { var ap = normalizeSearch(a.keyword).indexOf(query) === 0; var bp = normalizeSearch(b.keyword).indexOf(query) === 0; return Number(bp) - Number(ap) || a.order - b.order; });
            ranked.forEach(function(entry, index) {
                var item = document.createElement('div');
                var shortcut = trigger + entry.keyword;
                item.style.cssText = 'padding:8px 16px;cursor:pointer;display:flex;align-items:center;gap:10px;transition:background .15s;' + (index === 0 ? 'background:rgba(10,132,255,.2);' : '');
                item.innerHTML = '<span style="background:rgba(10,132,255,.3);color:#65b7ff;padding:3px 8px;border-radius:8px;font-size:13px;font-weight:700;font-family:inherit;flex-shrink:0;">' + shortcut + '</span><span style="font-size:13px;color:rgba(255,255,255,.85);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (entry.reply.message.length > 60 ? entry.reply.message.substring(0, 60) + '...' : entry.reply.message) + '</span>';
                item.onmouseenter = function() { item.style.background = 'rgba(255,255,255,.08)'; };
                item.onmouseleave = function() { item.style.background = index === activeHintIndex ? 'rgba(10,132,255,.2)' : ''; };
                item.onclick = function(ev) { ev.preventDefault(); ev.stopPropagation(); existingHint.remove(); applyQuickReply(targetInput, entry.reply, text); };
                existingHint.appendChild(item);
              });
            existingHint.style.display = existingHint.children.length ? 'block' : 'none';
            // Tu dong dien khi chi co dung 1 ket qua khop chinh xac voi keyword
            if (ranked.length === 1 && query && normalizeSearch(ranked[0].keyword) === query) {
              (function(entry, expectedToken) {
                autoFillTimer = setTimeout(function() {
                  autoFillTimer = null;
                  if (window.__DepLaoApplyingQuickReply) return;
                  // Kiem tra lai noi dung o nhap de khong dien nham khi text da thay doi
                  var liveText = composerTextValue(targetInput);
                  var liveToken = String(liveText).replace(/[​-‍﻿]/g, '').trim();
                  if (liveToken !== expectedToken) return;
                  var hint2 = document.getElementById('dep-lao-shortcut-hint');
                  if (hint2) hint2.remove();
                  applyQuickReply(targetInput, entry.reply, liveText);
                }, 450);
              })(ranked[0], token);
            }
            return;
          }
          if (existingHint) existingHint.style.display = 'none';
        }, true);
      }
      // Chạy trong main world của Zalo giống cơ chế ổn định trước đây.
      setTimeout(setupQuickReplyShortcuts, 3000);

      // Auto extract recent chats
      function extractRecentChats() {
        if (!isZalo) return;
        var chats = [];
        try {
          function normalizeChatText(value) {
            return String(value || '')
              .normalize('NFC')
              .replace(/[\u200B-\u200D\uFEFF]/g, '')
              .replace(/\s+/g, ' ')
              .trim();
          }
          function isBlockedChatName(name) {
            var blocked = ['tin nhắn', 'danh bạ', 'zalo cloud', 'công cụ', 'giao việc', 'lịch sử đồng bộ', 'cài đặt'];
            var lower = normalizeChatText(name).toLowerCase();
            return blocked.some(function(keyword) { return lower === keyword || lower.includes(keyword); });
          }
          var items = document.querySelectorAll('.msg-item, [data-id], .group-board-item');
          items.forEach(function(item) {
            var nameEl = item.querySelector('.conv-item-title__name, .item-title__name, .item-title, .truncate');
            var looksLikeChat = item.querySelector('img, .avatar, .zavatar, .conv-item-title__name, .item-title__name');
            if (nameEl && looksLikeChat) {
               var name = normalizeChatText(nameEl.innerText || nameEl.textContent || '');
               if (name && !chats.includes(name) && !isBlockedChatName(name)) {
                  chats.push(name);
               }
            }
          });
          window.messengerApp.sendRecentChats(chats);
        } catch (e) {}
      }
      setInterval(extractRecentChats, 6000);

      // Đếm số HỘI THOẠI có ít nhất một tin chưa đọc, không cộng tổng số tin.
      function extractUnreadConversationCount() {
        if (!isZalo) return;
        try {
          var rows = Array.from(document.querySelectorAll('.msg-item, [class*="conv-item" i], [data-id]'));
          var seen = new Set();
          var count = 0;
          rows.forEach(function(row) {
            if (!row || !row.querySelector) return;
            var badge = row.querySelector('[class*="unread" i], [class*="badge" i], [class*="notify" i], [data-unread="true"]');
            if (!badge) return;
            var rect = badge.getBoundingClientRect && badge.getBoundingClientRect();
            var style = window.getComputedStyle ? window.getComputedStyle(badge) : null;
            if (!rect || rect.width <= 0 || rect.height <= 0 || (style && (style.display === 'none' || style.visibility === 'hidden'))) return;
            var text = String(badge.textContent || '').trim();
            var className = String(badge.className || '');
            if (!text && !/unread|notify/i.test(className) && badge.getAttribute('data-unread') !== 'true') return;
            var key = row.getAttribute('data-id') || row.getAttribute('id') || String(rows.indexOf(row));
            if (!seen.has(key)) { seen.add(key); count += 1; }
          });
          window.messengerApp.sendUnreadConversationCount(count);
        } catch (e) {}
      }
      setInterval(extractUnreadConversationCount, 3000);
      setTimeout(extractUnreadConversationCount, 1200);


      // Auto extract profile name & avatar
      function extractCurrentChatInfo() {
        var info = { name: '', platform: platform.toLowerCase() };
        try {
          if (isZalo) {
            var candidates = Array.from(document.querySelectorAll('.header-title, .title-name, [class*="chat-header"] [class*="title"]'));
            candidates = candidates.filter(function(el) {
              var rect = el.getBoundingClientRect();
              var text = (el.innerText || '').replace(/\s+/g, ' ').trim();
              return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.top < 170 && rect.left > 180 && text && !/^(Thông tin nhóm|Thành viên nhóm)$/i.test(text);
            }).sort(function(a, b) { return a.getBoundingClientRect().left - b.getBoundingClientRect().left; });
            var chatNameEl = candidates[0] || null;
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
            var nameEl = document.querySelector('#app-navigation .str-name, #app-navigation [class*="profile-name"], .nav__tabs__profile-name');
            var avatarEl = document.querySelector('#app-navigation .zavatar img, #app-navigation [class*="avatar"] img, .nav__tabs__avatar img, .zavatar-img');
            if (!avatarEl) {
              var imgs = Array.from(document.querySelectorAll('img'));
              avatarEl = imgs.find(function(img) {
                var rect = img.getBoundingClientRect();
                var src = String(img.currentSrc || img.src || '');
                return src && !/logo|icon|banner|ads?/i.test(src) && rect.left >= 0 && rect.left < 90 && rect.top >= 20 && rect.top < 180 && rect.width >= 28 && rect.width <= 72 && Math.abs(rect.width - rect.height) < 10;
              });
            }
            if (nameEl) info.name = (nameEl.innerText || '').replace(/\s+/g, ' ').trim();
            if (avatarEl) info.avatar = avatarEl.currentSrc || avatarEl.src;
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
          info.kind = 'account-navigation';
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

ipcRenderer.on('zalo-group-scan:start', (event, { scanId, script }) => {
  webFrame.executeJavaScript(script).catch((error) => {
    ipcRenderer.send('zalo-group-scan:event', { scanId, type: 'error', message: error.message || String(error) });
  });
});

ipcRenderer.on('zalo-group-scan:cancel', (event, { script }) => {
  webFrame.executeJavaScript(script).catch(() => {});
});

ipcRenderer.on('zalo-user-scan:start', (event, { scanId, script }) => {
  webFrame.executeJavaScript(script).catch((error) => ipcRenderer.send('zalo-user-scan:event', { scanId, type: 'error', message: error.message || String(error) }));
});

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

ipcRenderer.on('quick-reply:ensure-ready', (event, payload) => {
  const request = Array.isArray(payload) ? { replies: payload } : (payload || {});
  runInjection({ ...settings, quickReplies: request.replies || [] });
  webFrame.executeJavaScript(`typeof window.__DepLaoRunQuickReply === 'function'`)
    .then((ready) => ipcRenderer.send('quick-reply:ready', { requestId: request.requestId || '', ok: !!ready }))
    .catch(() => ipcRenderer.send('quick-reply:ready', { requestId: request.requestId || '', ok: false }));
});
