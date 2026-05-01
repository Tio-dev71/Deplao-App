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
});

// Lấy cài đặt từ main process
const settings = ipcRenderer.sendSync('get-settings');

// Inject script vào trang web (Zalo) để chặn các API báo đã xem / đang nhập
const injectionScript = `
  window.__DepLaoBlockSeen = ${settings.blockSeen || false};
  window.__DepLaoBlockTyping = ${settings.blockTyping || false};

  (function() {
    // Chỉ kích hoạt bộ chặn nếu đang ở trang Zalo
    if (!window.location.hostname.includes('zalo.me') && !window.location.hostname.includes('zadn.vn')) {
      console.log("[DepLao] Không phải trang Zalo. Tắt bộ chặn.");
      return;
    }

    // 1. Chặn Fetch API
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : '');
      if (window.__DepLaoBlockSeen && (url.includes('/api/message/read') || url.includes('/api/message/seen') || url.includes('read_status'))) {
        return new Response(JSON.stringify({error: 0, msg: "Blocked by DepLao"}), { status: 200 });
      }
      if (window.__DepLaoBlockTyping && (url.includes('/api/message/typing') || url.includes('typ.php'))) {
        return new Response(JSON.stringify({error: 0, msg: "Blocked by DepLao"}), { status: 200 });
      }
      return originalFetch.apply(this, args);
    };

    // 2. Chặn XMLHttpRequest (XHR)
    const originalXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function() {
      const xhr = new originalXHR();
      const originalOpen = xhr.open;
      xhr.open = function(method, url, ...rest) {
        this._url = url;
        return originalOpen.call(this, method, url, ...rest);
      };
      const originalSend = xhr.send;
      xhr.send = function(...args) {
        if (window.__DepLaoBlockSeen && this._url && (this._url.includes('/api/message/read') || this._url.includes('/api/message/seen') || this._url.includes('read_status'))) {
           Object.defineProperty(this, 'readyState', {get: () => 4});
           Object.defineProperty(this, 'status', {get: () => 200});
           Object.defineProperty(this, 'responseText', {get: () => '{"error":0}'});
           if (this.onreadystatechange) this.onreadystatechange();
           if (this.onload) this.onload();
           return;
        }
        if (window.__DepLaoBlockTyping && this._url && (this._url.includes('/api/message/typing') || this._url.includes('typ.php'))) {
           Object.defineProperty(this, 'readyState', {get: () => 4});
           Object.defineProperty(this, 'status', {get: () => 200});
           Object.defineProperty(this, 'responseText', {get: () => '{"error":0}'});
           if (this.onreadystatechange) this.onreadystatechange();
           if (this.onload) this.onload();
           return;
        }
        return originalSend.apply(this, args);
      };
      return xhr;
    };

    // 3. Chặn WebSocket
    const originalWebSocket = window.WebSocket;
    window.WebSocket = function(url, protocols) {
      const ws = new originalWebSocket(url, protocols);
      const originalSend = ws.send;
      ws.send = function(data) {
        let shouldDrop = false;
        try {
          if (typeof data === 'string') {
            if (window.__DepLaoBlockSeen && (data.includes('"cmd":97') || data.includes('"action":"read"') || data.includes('"seen"'))) {
              shouldDrop = true;
            }
            if (window.__DepLaoBlockTyping && (data.includes('"cmd":121') || data.includes('"cmd":122') || data.includes('"action":"typing"'))) {
              shouldDrop = true;
            }
          }
        } catch (e) {
          console.error('DepLao WS Intercept Error:', e);
        }
        
        if (shouldDrop) {
          console.log("[DepLao] Đã chặn packet WebSocket gửi trạng thái:", data);
          return;
        }
        return originalSend.call(this, data);
      };
      return ws;
    };
    
    console.log("[DepLao] Đã khởi tạo bộ chặn Zalo. Block Seen:", window.__DepLaoBlockSeen, ", Block Typing:", window.__DepLaoBlockTyping);
  })();
`;

webFrame.executeJavaScript(injectionScript);

ipcRenderer.on('update-block-settings', (event, newSettings) => {
  webFrame.executeJavaScript(`
    window.__DepLaoBlockSeen = ${newSettings.blockSeen};
    window.__DepLaoBlockTyping = ${newSettings.blockTyping};
    console.log("[DepLao] Đã cập nhật cài đặt chặn. Block Seen:", window.__DepLaoBlockSeen, ", Block Typing:", window.__DepLaoBlockTyping);
  `);
});

