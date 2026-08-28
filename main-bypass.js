// Temporary authentication bypass for local/tool access while the remote 9Meta API is unavailable.
// Remove this file and restore package.json "main" to "main.js" when authentication is re-enabled.

const { app } = require('electron');

app.on('browser-window-created', (_event, win) => {
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`
      (() => {
        try {
          // Prevent the renderer from reopening the remote-login gate during this session.
          if (typeof showAuth === 'function') {
            showAuth = () => {};
          }
          if (typeof checkSubscription === 'function') {
            checkSubscription = async () => true;
          }

          const authOverlay = document.getElementById('auth-overlay');
          const expiredOverlay = document.getElementById('expired-overlay');
          if (authOverlay) authOverlay.style.display = 'none';
          if (expiredOverlay) expiredOverlay.style.display = 'none';

          // Restore the embedded browser/tool view after the original auth check hid it.
          try {
            require('electron').ipcRenderer.send('set-browserview-visibility', true);
          } catch (_) {}
        } catch (error) {
          console.error('[9Meta temporary auth bypass]', error);
        }
      })();
    `).catch((error) => console.error('[9Meta temporary auth bypass injection]', error));
  });
});

require('./main.js');
