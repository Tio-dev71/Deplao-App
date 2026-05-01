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
      if (window.__DepLaoBlockSeen && (url.includes('/api/message/read') || url.includes('/api/message/seen'))) {
        return new Response(JSON.stringify({error: 0, msg: "Blocked by DepLao"}), { status: 200 });
      }
      if (window.__DepLaoBlockTyping && (url.includes('/api/message/typing') || url.includes('typ.php'))) {
        return new Response(JSON.stringify({error: 0, msg: "Blocked by DepLao"}), { status: 200 });
      }
      return originalFetch.apply(this, args);
    };

    // 2. Chặn XMLHttpRequest (XHR) an toàn hơn bằng cách override prototype
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this._url = typeof url === 'string' ? url : (url ? url.toString() : '');
      return originalXHROpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function(...args) {
      const url = this._url || '';
      
      if (window.__DepLaoBlockSeen && (url.includes('/api/message/read') || url.includes('/api/message/seen'))) {
         Object.defineProperty(this, 'readyState', {get: () => 4});
         Object.defineProperty(this, 'status', {get: () => 200});
         Object.defineProperty(this, 'responseText', {get: () => '{"error":0}'});
         if (this.onreadystatechange) this.onreadystatechange();
         if (this.onload) this.onload();
         return;
      }
      
      if (window.__DepLaoBlockTyping && (url.includes('/api/message/typing') || url.includes('typ.php'))) {
         Object.defineProperty(this, 'readyState', {get: () => 4});
         Object.defineProperty(this, 'status', {get: () => 200});
         Object.defineProperty(this, 'responseText', {get: () => '{"error":0}'});
         if (this.onreadystatechange) this.onreadystatechange();
         if (this.onload) this.onload();
         return;
      }
      
      return originalXHRSend.apply(this, args);
    };

    // 3. Chặn WebSocket an toàn hơn bằng cách override prototype
    const originalWSSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      let shouldDrop = false;
      try {
        if (typeof data === 'string') {
          // Bỏ qua check '"seen"' chung chung vì có thể chặn nhầm payload đồng bộ
          if (window.__DepLaoBlockSeen && (data.includes('"cmd":97') || data.includes('"action":"read"'))) {
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
      return originalWSSend.call(this, data);
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

