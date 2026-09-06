// Kiem tra thuc te: preload co load duoc trong BrowserView sandbox giong main.js khong.
const { app, BrowserWindow, BrowserView, ipcMain } = require('electron');
const path = require('path');

const errors = [];

app.whenReady().then(async () => {
  // Gia lap dung handler that de sendSync co listener.
  ipcMain.on('get-settings', (event) => {
    event.returnValue = {
      isDarkMode: false, alwaysOnTop: false, blockSeen: false, blockTyping: false,
      zadarkShield: false, lockOnStartup: false, hasLockPassword: false,
      quickReplies: [{ keyword: 'xanh', message: 'test', imagePath: '' }],
      quicksandFontDataUrl: 'data:font/ttf;base64,AAAA',
    };
  });

  const win = new BrowserWindow({ show: false, width: 900, height: 600 });
  const view = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: 900, height: 600 });

  view.webContents.on('preload-error', (_e, p, err) => errors.push('preload-error: ' + err.message));
  view.webContents.on('console-message', (_e, level, message) => {
    if (/Unable to load preload|module not found|Uncaught/i.test(message)) errors.push('console: ' + message);
  });

  await view.webContents.loadURL('data:text/html,<body>probe</body>');
  await new Promise((r) => setTimeout(r, 900));

  const probe = await view.webContents.executeJavaScript(`(() => ({
    hasBridge: typeof window.messengerApp === 'object' && window.messengerApp !== null,
    bridgeKeys: window.messengerApp ? Object.keys(window.messengerApp).length : 0,
    hasPasteImage: !!(window.messengerApp && window.messengerApp.pasteQuickReplyImage),
    hasGroupScanEmit: !!(window.messengerApp && window.messengerApp.emitZaloGroupScanEvent),
    hasUserScanEmit: !!(window.messengerApp && window.messengerApp.emitZaloUserScanEvent),
  }))()`);

  console.log(JSON.stringify({ probe, errors }, null, 2));
  app.exit(errors.length === 0 && probe.hasBridge ? 0 : 1);
});
