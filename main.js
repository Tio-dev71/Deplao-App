// ============================================================
//  Ứng dụng 9Meta Desktop
//  Nhân: Chromium (Google Chrome)
//  Tác giả: Nguyễn Đình Thọ
// ============================================================

const {
  app,
  BrowserWindow,
  BrowserView,
  shell,
  session,
  Menu,
  MenuItem,
  Tray,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  dialog,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ZALO_URL = 'https://chat.zalo.me';
const APP_ID = 'com.zalo.desktop';
const SIDEBAR_WIDTH = 72;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) app.quit();
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_SETTINGS = {
  windowBounds: { width: 1200, height: 800 },
  startMinimized: false,
  autoLaunch: false,
  minimizeToTray: true,
  globalHotkey: 'Ctrl+Shift+M',
  currentTheme: 'default',
  isDarkMode: true,
  alwaysOnTop: false,
  blockSeen: false,
  blockTyping: false,
  zadarkShield: false,
  lockOnStartup: false,
  lockPasswordHash: '',
  lockSalt: '',
  quickReplies: [],
};

function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(data) {
  try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2), 'utf8'); } catch (err) { }
}

const WORKSPACES_DIR = path.join(app.getPath('userData'), 'workspaces');
const WORKSPACE_INDEX_PATH = path.join(WORKSPACES_DIR, 'index.json');
const DEFAULT_WORKSPACE_DATA = {
  profiles: [],
  quickReplies: [],
  crmContacts: [],
  campaigns: [],
  analyticsEvents: [],
  aiSettings: { endpoint: '', apiKey: '', model: 'gpt-4o-mini' },
};

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { }
}
function safeJsonRead(file, fallback) {
  try { return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return { ...fallback }; }
}
function safeJsonWrite(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}
function normalizeWorkspaceData(data = {}) {
  return {
    ...DEFAULT_WORKSPACE_DATA,
    ...data,
    profiles: Array.isArray(data.profiles) ? data.profiles : [],
    quickReplies: Array.isArray(data.quickReplies) ? data.quickReplies : [],
    crmContacts: Array.isArray(data.crmContacts) ? data.crmContacts : [],
    campaigns: Array.isArray(data.campaigns) ? data.campaigns : [],
    analyticsEvents: Array.isArray(data.analyticsEvents) ? data.analyticsEvents.slice(-500) : [],
    aiSettings: { ...DEFAULT_WORKSPACE_DATA.aiSettings, ...(data.aiSettings || {}) },
  };
}
function loadWorkspaceIndex() {
  ensureDir(WORKSPACES_DIR);
  let index = safeJsonRead(WORKSPACE_INDEX_PATH, { currentId: 'default', workspaces: [] });
  if (!Array.isArray(index.workspaces) || !index.workspaces.length) {
    index = { currentId: 'default', workspaces: [{ id: 'default', name: 'Workspace mặc định', createdAt: Date.now() }] };
    safeJsonWrite(WORKSPACE_INDEX_PATH, index);
  }
  if (!index.workspaces.some(w => w.id === index.currentId)) index.currentId = index.workspaces[0].id;
  return index;
}
function getWorkspaceFile(id) { return path.join(WORKSPACES_DIR, id, 'data.json'); }
function loadWorkspaceData(id) { return normalizeWorkspaceData(safeJsonRead(getWorkspaceFile(id), DEFAULT_WORKSPACE_DATA)); }
function saveWorkspaceData(id, data) { safeJsonWrite(getWorkspaceFile(id), normalizeWorkspaceData(data)); }
function getWorkspaceState() {
  const index = loadWorkspaceIndex();
  const data = loadWorkspaceData(index.currentId);
  if (!data.quickReplies.length && settings.quickReplies?.length) data.quickReplies = settings.quickReplies;
  return { ...index, data };
}
function persistWorkspaceState(data) {
  const index = loadWorkspaceIndex();
  saveWorkspaceData(index.currentId, data);
  settings.quickReplies = normalizeWorkspaceData(data).quickReplies;
  saveSettings(settings);
  return getWorkspaceState();
}
function broadcastQuickReplies(replies) {
  for (const id in browserViews) browserViews[id]?.webContents?.send('update-quick-replies', replies || []);
}

let mainWindow = null;
let tray = null;
let settings = loadSettings();
let isQuitting = false;
let unreadCount = 0;
let browserViews = {};
let activeProfileId = null;
let proxyCredentials = {};
let appLocked = false;
let downloads = [];
let updateState = { status: 'idle', progress: 0, message: 'Sẵn sàng kiểm tra cập nhật.' };
let isBrowserViewVisible = true;

function createBadgeIcon(count) {
  const size = 18;
  const text = count > 9 ? '9+' : String(count);
  const fontSize = count > 9 ? 9 : 11;
  const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#e74c3c"/><text x="${size / 2}" y="${size / 2 + fontSize / 3}" text-anchor="middle" fill="white" font-size="${fontSize}" font-weight="bold" font-family="Arial">${text}</text></svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}
function setUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  sendToRenderer('update-state', updateState);
}
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
  return { salt, hash };
}
function verifyPassword(password) {
  if (!settings.lockPasswordHash || !settings.lockSalt) return false;
  return hashPassword(password, settings.lockSalt).hash === settings.lockPasswordHash;
}

function createTray() {
  const iconPath = path.join(__dirname, 'icon.png');
  let trayIcon;
  try { trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }); } catch { trayIcon = nativeImage.createEmpty(); }
  tray = new Tray(trayIcon);
  updateTrayMenu();
  tray.setToolTip('9Meta');
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
    else { mainWindow.show(); mainWindow.focus(); }
  });
  tray.on('double-click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
}

function updateTrayMenu() {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
    { label: '💬 Mở 9Meta', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { label: '🔒 Khóa ứng dụng', click: lockApp },
    { type: 'separator' },
    { label: '🔄 Tải lại trang', click: () => activeProfileId && browserViews[activeProfileId]?.webContents.reload() },
    { label: '🚀 Khởi động cùng Windows', type: 'checkbox', checked: settings.autoLaunch, click: (item) => toggleAutoLaunch(item.checked) },
    { label: '📌 Thu nhỏ xuống Tray khi đóng', type: 'checkbox', checked: settings.minimizeToTray, click: (item) => { settings.minimizeToTray = item.checked; saveSettings(settings); } },
    { type: 'separator' },
    {
      label: '🛡️ Bảo mật', submenu: [
        { label: 'Chặn hiển thị "Đã xem"', type: 'checkbox', checked: settings.blockSeen, click: (item) => toggleBlockSeen(item.checked) },
        { label: 'Chặn hiển thị "Đang nhập"', type: 'checkbox', checked: settings.blockTyping, click: (item) => toggleBlockTyping(item.checked) },
        { label: 'ZaDark Shield', type: 'checkbox', checked: settings.zadarkShield, click: (item) => toggleZadarkShield(item.checked) },
        { label: 'Khóa khi mở ứng dụng', type: 'checkbox', checked: settings.lockOnStartup, click: (item) => { settings.lockOnStartup = item.checked; saveSettings(settings); } },
      ]
    },
    { type: 'separator' },
    { label: '⬇️ Kiểm tra cập nhật', click: () => checkForUpdates(true) },
    { type: 'separator' },
    { label: '❌ Thoát hoàn toàn', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
}

function broadcastBlockSettings() {
  const newSettings = { blockSeen: settings.blockSeen, blockTyping: settings.blockTyping, zadarkShield: settings.zadarkShield };
  for (const id in browserViews) browserViews[id]?.webContents?.send('update-block-settings', newSettings);
  sendToRenderer('lock-state', { locked: appLocked, hasPassword: !!settings.lockPasswordHash, zadarkShield: settings.zadarkShield });
}
function toggleBlockSeen(enable) { settings.blockSeen = enable; saveSettings(settings); broadcastBlockSettings(); }
function toggleBlockTyping(enable) { settings.blockTyping = enable; saveSettings(settings); broadcastBlockSettings(); }
function toggleZadarkShield(enable) { settings.zadarkShield = enable; saveSettings(settings); broadcastBlockSettings(); updateTrayMenu(); }

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.logger = require('electron').app.isPackaged ? null : console;
  autoUpdater.on('checking-for-update', () => {
    console.log('[AutoUpdater] Checking for update...');
    setUpdateState({ status: 'checking', progress: 0, message: 'Đang kiểm tra cập nhật...' });
  });
  autoUpdater.on('update-available', (info) => {
    console.log('[AutoUpdater] Update available:', info.version);
    setUpdateState({ status: 'available', progress: 0, info, message: `Có bản cập nhật mới v${info.version}.` });
    // Native dialog fallback for manual check
    if (isManualUpdateCheck && mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Cập nhật mới',
        message: `Có bản cập nhật mới v${info.version}!`,
        detail: 'Bạn có muốn tải và cài đặt ngay?',
        buttons: ['Tải xuống', 'Để sau'],
        defaultId: 0,
      }).then(({ response }) => {
        if (response === 0) {
          autoUpdater.downloadUpdate().catch(err => {
            dialog.showErrorBox('Lỗi cập nhật', err.message || 'Không thể tải cập nhật.');
          });
          setUpdateState({ status: 'downloading', progress: 0, message: 'Đang tải cập nhật...' });
        }
      });
      isManualUpdateCheck = false;
    }
  });
  autoUpdater.on('update-not-available', (info) => {
    console.log('[AutoUpdater] No update available. Current:', info.version);
    setUpdateState({ status: 'idle', progress: 0, message: 'Bạn đang sử dụng phiên bản mới nhất.' });
    if (isManualUpdateCheck && mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Cập nhật',
        message: 'Bạn đang sử dụng phiên bản mới nhất.',
        detail: `Phiên bản hiện tại: v${app.getVersion()}`,
        buttons: ['OK'],
      });
    }
    isManualUpdateCheck = false;
  });
  autoUpdater.on('download-progress', (p) => setUpdateState({ status: 'downloading', progress: Math.round(p.percent || 0), message: `Đang tải cập nhật... ${Math.round(p.percent || 0)}%` }));
  autoUpdater.on('update-downloaded', () => {
    console.log('[AutoUpdater] Update downloaded, ready to install.');
    setUpdateState({ status: 'downloaded', progress: 100, message: 'Đã tải xong. Sẵn sàng cài đặt và khởi động lại.' });
    if (mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Cập nhật sẵn sàng',
        message: 'Đã tải xong bản cập nhật.',
        detail: 'Khởi động lại ứng dụng để cài đặt?',
        buttons: ['Khởi động lại', 'Để sau'],
        defaultId: 0,
      }).then(({ response }) => {
        if (response === 0) { isQuitting = true; autoUpdater.quitAndInstall(); }
      });
    }
  });
  autoUpdater.on('error', (err) => {
    console.error('[AutoUpdater] Error:', err);
    const msg = err == null ? 'Lỗi cập nhật không xác định.' : (err.message || err.toString()).split('\n')[0];
    setUpdateState({ status: 'error', message: msg });
    if (isManualUpdateCheck && mainWindow) {
      dialog.showErrorBox('Lỗi cập nhật', msg);
    }
    isManualUpdateCheck = false;
  });
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => { }), 5000);
}
let isManualUpdateCheck = false;
function checkForUpdates(manual = false) { isManualUpdateCheck = manual; autoUpdater.checkForUpdates().catch(err => setUpdateState({ status: 'error', message: (err.message || err.toString()).split('\n')[0] })); }
function toggleAutoLaunch(enable) { settings.autoLaunch = enable; saveSettings(settings); app.setLoginItemSettings({ openAtLogin: enable, path: app.getPath('exe') }); }

function updateBrowserViewBounds() {
  if (!mainWindow || !activeProfileId || !browserViews[activeProfileId]) return;
  const bounds = mainWindow.getContentBounds();
  const view = browserViews[activeProfileId];
  view.setBounds({ x: SIDEBAR_WIDTH, y: 0, width: Math.max(bounds.width - SIDEBAR_WIDTH, 0), height: Math.max(bounds.height, 0) });
  view.setAutoResize({ width: true, height: true });
}
function isInternalUrl(url) {
  return ['chat.zalo.me', 'id.zalo.me', 'messenger.com', 'facebook.com', 'web.whatsapp.com', 'whatsapp.com', 'teams.microsoft.com', 'microsoft.com', 'live.com', 'office.com', 'google.com', 'gmail.com', 'web.telegram.org', 'telegram.org', 't.me'].some(d => url.includes(d));
}
function setupWebContents(contents, profileId) {
  contents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank' || url.startsWith('blob:') || url.startsWith('file:')) return { action: 'allow' };
    if (isInternalUrl(url)) return { action: 'allow' };
    let finalUrl = url;
    if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://') && !finalUrl.startsWith('mailto:')) finalUrl = 'https://' + finalUrl;
    shell.openExternal(finalUrl).catch(err => console.error('[Main] Lỗi mở external link:', finalUrl, err));
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (isInternalUrl(url)) return;
    event.preventDefault();
    let finalUrl = url;
    if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://') && !finalUrl.startsWith('mailto:')) finalUrl = 'https://' + finalUrl;
    shell.openExternal(finalUrl).catch(err => console.error('[Main] Lỗi mở external link:', finalUrl, err));
  });
  contents.on('context-menu', (event, params) => {
    const menu = new Menu();
    if (params.selectionText) menu.append(new MenuItem({ label: '📋 Sao chép', role: 'copy' }));
    if (params.isEditable) {
      menu.append(new MenuItem({ label: '📋 Dán', role: 'paste' }));
      menu.append(new MenuItem({ label: '✂️ Cắt', role: 'cut' }));
      menu.append(new MenuItem({ label: '📝 Chọn tất cả', role: 'selectAll' }));
    }
    if (params.linkURL) {
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ label: '🔗 Mở liên kết', click: () => shell.openExternal(params.linkURL) }));
      menu.append(new MenuItem({ label: '📋 Sao chép liên kết', click: () => require('electron').clipboard.writeText(params.linkURL) }));
    }
    if (params.mediaType === 'image') {
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ label: '💾 Lưu ảnh', click: () => contents.downloadURL(params.srcURL) }));
    }
    menu.append(new MenuItem({ type: 'separator' }));
    menu.append(new MenuItem({ label: '🔄 Tải lại trang', click: () => contents.reload() }));
    menu.append(new MenuItem({ label: '◀️ Quay lại', enabled: contents.canGoBack(), click: () => contents.goBack() }));
    if (menu.items.length > 0) menu.popup({ window: mainWindow });
  });
  contents.on('did-finish-load', () => {
    try {
      const currentUrl = contents.getURL();
      const host = new URL(currentUrl).hostname || '';
      const platformClass = host.includes('telegram.org')
        ? 'platform-telegram'
        : host.includes('messenger.com') || host.includes('facebook.com')
          ? 'platform-meta'
          : host.includes('zalo.me')
            ? 'platform-zalo'
            : host.includes('whatsapp.com')
              ? 'platform-whatsapp'
              : 'platform-generic';
      contents.insertCSS(`html, body { --nine-meta-platform: ${platformClass}; } html { color-scheme: dark; } body { min-height: 100vh; } html.${platformClass}, body.${platformClass} {}`);
      contents.executeJavaScript(`document.documentElement.classList.add('${platformClass}'); document.body && document.body.classList.add('${platformClass}');`, true).catch(() => { });
      contents.insertCSS(fs.readFileSync(path.join(__dirname, 'custom_style.css'), 'utf8'));
    } catch (e) { }
  });
  if (app.isPackaged) {
    contents.on('before-input-event', (event, input) => { if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) event.preventDefault(); });
    contents.on('devtools-opened', () => contents.closeDevTools());
  } else {
    contents.on('before-input-event', (event, input) => { if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) contents.toggleDevTools(); });
  }
}

function setupDownloads(sess) {
  if (sess.__depLaoDownloadsHooked) return;
  sess.__depLaoDownloadsHooked = true;
  sess.on('will-download', (event, item) => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const filename = item.getFilename();
    const record = { id, filename, url: item.getURL(), savePath: item.getSavePath(), receivedBytes: 0, totalBytes: item.getTotalBytes(), status: 'downloading', statusText: 'Đang tải' };
    downloads.push(record);
    sendToRenderer('download-updated', record);
    item.on('updated', (event, state) => {
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
      record.savePath = item.getSavePath();
      record.status = state === 'interrupted' ? 'interrupted' : 'downloading';
      record.statusText = state === 'interrupted' ? 'Tạm dừng/lỗi kết nối' : 'Đang tải';
      sendToRenderer('download-updated', { ...record });
    });
    item.once('done', (event, state) => {
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
      record.savePath = item.getSavePath();
      record.status = state === 'completed' ? 'completed' : state;
      record.statusText = state === 'completed' ? 'Đã tải xong' : `Kết thúc: ${state}`;
      sendToRenderer('download-updated', { ...record });
    });
  });
}

function createWindow() {
  const { windowBounds } = settings;
  mainWindow = new BrowserWindow({
    width: windowBounds.width || 1200, height: windowBounds.height || 800, x: windowBounds.x, y: windowBounds.y,
    minWidth: 400, minHeight: 300, title: '9Meta', icon: path.join(__dirname, 'icon.png'),
    backgroundColor: settings.isDarkMode ? '#242526' : '#ffffff', show: !settings.startMinimized, autoHideMenuBar: true, titleBarOverlay: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, spellcheck: false },
  });

  app.on('session-created', (sess) => {
    setupDownloads(sess);
    sess.cookies.on('changed', (event, cookie, cause, removed) => {
      const domainMatch = cookie.domain && ['zalo.me', 'messenger.com', 'facebook.com', 'whatsapp.com', 'telegram.org'].some(d => cookie.domain.includes(d));
      if (!removed && cookie.session && domainMatch) {
        const prefix = cookie.domain.startsWith('.') ? 'www' : '';
        sess.cookies.set({ url: `https://${prefix}${cookie.domain}${cookie.path}`, name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, expirationDate: Math.floor(Date.now() / 1000) + 31536000 }).catch(() => { });
      }
    });
    sess.webRequest.onBeforeRequest({ urls: ['*://*.zalo.me/*', '*://*.zadn.vn/*'] }, (details, callback) => {
      let cancel = false; const method = (details.method || '').toUpperCase();
      if (method === 'GET') return callback({ cancel: false });
      const syncSafePatterns = ['/sync', '/conversation', '/api/message/list', '/api/message/get', '/api/group'];
      if (syncSafePatterns.some(p => details.url.includes(p))) return callback({ cancel: false });
      if (settings.blockSeen && (details.url.includes('/api/message/read') || details.url.includes('/api/message/seen')) && !details.url.includes('read_status')) cancel = true;
      if (settings.blockTyping && details.url.includes('/api/message/typing')) cancel = true;
      callback({ cancel });
    });
    sess.webRequest.onBeforeRequest({ urls: ['*://*.messenger.com/*', '*://*.facebook.com/*'] }, (details, callback) => {
      let cancel = false; const method = (details.method || '').toUpperCase();
      if (method === 'GET') return callback({ cancel: false });
      if (settings.blockSeen && (details.url.includes('change_read_status') || details.url.includes('mark_read') || details.url.includes('read_receipt') || details.url.includes('/ajax/mercury/mark_seen'))) cancel = true;
      if (settings.blockTyping && (details.url.includes('typ.php') || details.url.includes('typing_indicator') || details.url.includes('send_typing_indicator'))) cancel = true;
      callback({ cancel });
    });
    sess.webRequest.onBeforeRequest({ urls: ['*://*.whatsapp.com/*', '*://web.whatsapp.com/*', '*://web.telegram.org/*', '*://*.telegram.org/*'] }, (details, callback) => {
      let cancel = false; const method = (details.method || '').toUpperCase();
      if (method === 'GET') return callback({ cancel: false });
      if (settings.blockSeen && (details.url.includes('/read') || details.url.includes('receipt'))) cancel = true;
      if (settings.blockTyping && (details.url.includes('chatstate') || details.url.includes('composing') || details.url.includes('typing'))) cancel = true;
      callback({ cancel });
    });
    sess.setPermissionRequestHandler((webContents, permission, callback) => {
      const url = webContents.getURL();
      const isAllowed = isInternalUrl(url) || url.includes('fbcdn.net') || url.includes('gstatic.com') || url.includes('googleusercontent.com');
      const allowedPermissions = [
        'notifications',
        'media',
        'mediaKeySystem',
        'microphone',
        'camera',
        'clipboard-read',
        'clipboard-sanitized-write',
        'fileSystem',
        'file-system-access',
        'fileSystemAccess',
      ];
      callback(!!isAllowed && allowedPermissions.includes(permission));
    });
    sess.setPermissionCheckHandler((webContents, permission) => {
      const url = webContents?.getURL() || '';
      if (!isInternalUrl(url)) return false;
      if (!permission) return true;
      return [
        'notifications',
        'media',
        'mediaKeySystem',
        'microphone',
        'camera',
        'clipboard-read',
        'clipboard-sanitized-write',
        'fileSystem',
        'file-system-access',
        'fileSystemAccess',
      ].includes(permission);
    });
  });

  mainWindow.loadFile('index.html');
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (app.isPackaged && (input.key === 'F12' || (input.control && input.shift && input.key === 'I'))) event.preventDefault();
    else if (!app.isPackaged && (input.key === 'F12' || (input.control && input.shift && input.key === 'I'))) mainWindow.webContents.toggleDevTools();
  });
  mainWindow.on('focus', () => mainWindow.flashFrame(false));
  mainWindow.on('resize', updateBrowserViewBounds);
  mainWindow.on('maximize', updateBrowserViewBounds);
  mainWindow.on('unmaximize', updateBrowserViewBounds);
  mainWindow.on('close', (event) => {
    if (!isQuitting && settings.minimizeToTray) { event.preventDefault(); mainWindow.hide(); return; }
    settings.windowBounds = mainWindow.getBounds(); saveSettings(settings);
  });

  ipcMain.on('switch-profile', (event, profile) => {
    if (appLocked) return;
    activeProfileId = profile.id;
    if (!browserViews[profile.id]) {
      const view = new BrowserView({ webPreferences: { partition: profile.partition, preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
      browserViews[profile.id] = view;
      setupWebContents(view.webContents, profile.id);
      const sess = session.fromPartition(profile.partition);
      setupDownloads(sess);
      if (profile.proxy) {
        let proxyRules = profile.proxy; const parts = profile.proxy.trim().split(':');
        if (parts.length === 4) { proxyRules = `http://${parts[0]}:${parts[1]}`; proxyCredentials[`${parts[0]}:${parts[1]}`] = { username: parts[2], password: parts[3] }; }
        else if (parts.length === 2 && !profile.proxy.includes('://')) proxyRules = `http://${parts[0]}:${parts[1]}`;
        sess.setProxy({ proxyRules });
      } else sess.setProxy({ proxyRules: 'direct://' });
      let url = ZALO_URL; let ua = USER_AGENT;
      if (profile.platform === 'messenger') url = 'https://www.messenger.com/';
      else if (profile.platform === 'fanpage') url = 'https://www.facebook.com/latest/inbox/';
      else if (profile.platform === 'whatsapp') url = 'https://web.whatsapp.com/';
      else if (profile.platform === 'teams') url = 'https://teams.microsoft.com/';
      else if (profile.platform === 'gmail') url = 'https://mail.google.com/';
      else if (profile.platform === 'telegram') url = 'https://web.telegram.org/a/';
      view.webContents.loadURL(url, { userAgent: ua });
    }
    if (isBrowserViewVisible) {
      mainWindow.setBrowserView(browserViews[profile.id]); updateBrowserViewBounds();
    }
  });
  ipcMain.on('update-profile-settings', (event, profile) => {
    const sess = session.fromPartition(profile.partition);
    if (profile.proxy) {
      let proxyRules = profile.proxy; const parts = profile.proxy.trim().split(':');
      if (parts.length === 4) { proxyRules = `http://${parts[0]}:${parts[1]}`; proxyCredentials[`${parts[0]}:${parts[1]}`] = { username: parts[2], password: parts[3] }; }
      else if (parts.length === 2 && !profile.proxy.includes('://')) proxyRules = `http://${parts[0]}:${parts[1]}`;
      sess.setProxy({ proxyRules });
    } else sess.setProxy({ proxyRules: 'direct://' });
  });
  ipcMain.on('set-browserview-visibility', (event, visible) => {
    if (!mainWindow) return;
    isBrowserViewVisible = visible;
    if (visible && !appLocked && activeProfileId && browserViews[activeProfileId]) {
      mainWindow.setBrowserView(browserViews[activeProfileId]); updateBrowserViewBounds();
    } else mainWindow.setBrowserView(null);
  });
  ipcMain.on('delete-profile', (event, id) => { if (browserViews[id]) { browserViews[id].webContents.destroy(); delete browserViews[id]; } });

  ipcMain.on('profile-info-extracted', (event, info) => {
    let senderId = null;
    for (const [id, view] of Object.entries(browserViews)) {
      if (view.webContents === event.sender) { senderId = id; break; }
    }
    if (senderId) sendToRenderer('update-profile-info', { id: senderId, name: info.name, avatarUrl: info.avatar });
  });
  ipcMain.on('current-chat-info-extracted', (event, info) => {
    let senderId = null;
    for (const [id, view] of Object.entries(browserViews)) {
      if (view.webContents === event.sender) { senderId = id; break; }
    }
    if (senderId) sendToRenderer('current-chat-info', { ...info, profileId: senderId });
  });
  ipcMain.on('recent-chats-extracted', (event, chats) => {
    let senderId = null;
    for (const [id, view] of Object.entries(browserViews)) {
      if (view.webContents === event.sender) { senderId = id; break; }
    }
    if (senderId) sendToRenderer('recent-chats', { chats, profileId: senderId });
  });

  ipcMain.on('update-badge', (event, count) => { if (count !== unreadCount) { const hadNewMessages = count > unreadCount; unreadCount = count; updateBadge(unreadCount); if (hadNewMessages && !mainWindow.isFocused()) mainWindow.flashFrame(true); } });
  ipcMain.on('set-theme', (event, isDark) => { settings.isDarkMode = isDark; saveSettings(settings); nativeTheme.themeSource = isDark ? 'dark' : 'light'; });
  ipcMain.on('toggle-always-on-top', () => { settings.alwaysOnTop = !settings.alwaysOnTop; mainWindow.setAlwaysOnTop(settings.alwaysOnTop); saveSettings(settings); });
  ipcMain.on('toggle-fullscreen', () => { mainWindow.setFullScreen(!mainWindow.isFullScreen()); setTimeout(updateBrowserViewBounds, 100); });
  ipcMain.on('zoom-in', () => { const wc = activeProfileId && browserViews[activeProfileId]?.webContents; if (wc) wc.setZoomLevel(wc.getZoomLevel() + 0.5); });
  ipcMain.on('zoom-out', () => { const wc = activeProfileId && browserViews[activeProfileId]?.webContents; if (wc) wc.setZoomLevel(wc.getZoomLevel() - 0.5); });
  ipcMain.on('reload-page', () => activeProfileId && browserViews[activeProfileId]?.webContents.reload());
  ipcMain.on('get-settings', (event) => {
    const ws = getWorkspaceState();
    event.returnValue = { isDarkMode: settings.isDarkMode, alwaysOnTop: settings.alwaysOnTop, blockSeen: settings.blockSeen, blockTyping: settings.blockTyping, zadarkShield: settings.zadarkShield, lockOnStartup: settings.lockOnStartup, hasLockPassword: !!settings.lockPasswordHash, quickReplies: ws.data.quickReplies || [] };
  });
  ipcMain.on('workspace-get-state', (event) => { event.returnValue = getWorkspaceState(); });
  ipcMain.on('workspace-save-data', (event, data) => {
    const state = persistWorkspaceState(data || {});
    broadcastQuickReplies(state.data.quickReplies);
    event.returnValue = state;
  });
  ipcMain.on('workspace-create', (event, name) => {
    const index = loadWorkspaceIndex();
    const id = `ws_${Date.now()}`;
    index.workspaces.push({ id, name: String(name || 'Workspace mới').trim() || 'Workspace mới', createdAt: Date.now() });
    index.currentId = id;
    safeJsonWrite(WORKSPACE_INDEX_PATH, index);
    saveWorkspaceData(id, DEFAULT_WORKSPACE_DATA);
    event.returnValue = getWorkspaceState();
  });
  ipcMain.on('workspace-switch', (event, id) => {
    const index = loadWorkspaceIndex();
    if (index.workspaces.some(w => w.id === id)) {
      index.currentId = id;
      safeJsonWrite(WORKSPACE_INDEX_PATH, index);
    }
    const state = getWorkspaceState();
    broadcastQuickReplies(state.data.quickReplies);
    event.returnValue = state;
  });
  ipcMain.on('get-quick-replies', (event) => { event.returnValue = getWorkspaceState().data.quickReplies || settings.quickReplies || []; });
  ipcMain.on('save-quick-replies', (event, replies) => {
    const state = getWorkspaceState();
    state.data.quickReplies = replies || [];
    persistWorkspaceState(state.data);
    broadcastQuickReplies(state.data.quickReplies);
  });
  ipcMain.handle('ai-rewrite', async (event, payload = {}) => {
    const { endpoint, apiKey, model, text, mode } = payload;
    if (!endpoint || !apiKey) return { ok: false, message: 'Chưa cấu hình AI endpoint/API key.' };
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: model || 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'Bạn là trợ lý viết tin nhắn bán hàng tiếng Việt. Trả về duy nhất nội dung tin nhắn đã viết lại.' },
            { role: 'user', content: `Hãy ${mode || 'viết lại'} tin nhắn sau:\n${text || ''}` },
          ],
          temperature: 0.7,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || data.message || 'AI request failed');
      return { ok: true, text: data.choices?.[0]?.message?.content?.trim() || data.text || '' };
    } catch (err) { return { ok: false, message: err.message || String(err) }; }
  });
  ipcMain.handle('active-chat-send-text', async (event, message = '', options = {}) => {
    const requestedProfileId = options.profileId || activeProfileId;
    const view = requestedProfileId && browserViews[requestedProfileId];
    if (options.platform && options.platform !== 'zalo') return { ok: false, message: 'Bulk send chỉ áp dụng cho Zalo.' };
    if (!view || !message) return { ok: false, message: 'Chưa có tab Zalo active hoặc nội dung trống.' };
    try {
      const currentUrl = view.webContents.getURL() || '';
      if (!currentUrl.includes('zalo.me')) return { ok: false, message: 'Tab hiện tại không phải Zalo.' };
      const safeMessage = JSON.stringify(String(message));
      const focusResult = await view.webContents.executeJavaScript(`
        (function() {
          function isVisible(el) {
            if (!el) return false;
            var rect = el.getBoundingClientRect && el.getBoundingClientRect();
            var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
            return !!rect && rect.width > 0 && rect.height > 0 && (!style || (style.visibility !== 'hidden' && style.display !== 'none'));
          }
          function findInput() {
            var selectors = [
              '#richInput',
              '#chatInput',
              '[id*="input_line_"]',
              '#chatView [contenteditable="true"]',
              '.chat-input [contenteditable="true"]',
              '[contenteditable="true"][placeholder*="Nhập"]',
              '[contenteditable="true"][placeholder*="nhắn"]'
            ];
            for (var i = 0; i < selectors.length; i++) {
              var found = document.querySelector(selectors[i]);
              if (found) return found;
            }
            return null;
          }
          var input = findInput();
          if (!input) return { ok: false, message: 'Không tìm thấy ô nhập chat Zalo.' };
          input.focus();
          document.execCommand('selectAll', false, null);
          return { ok: true };
        })();
      `);
      if (!focusResult || !focusResult.ok) return focusResult;

      view.webContents.insertText(String(message));
      await new Promise(resolve => setTimeout(resolve, 50));

      const sendResult = await view.webContents.executeJavaScript(`
        (function() {
          function isVisible(el) {
            if (!el) return false;
            var rect = el.getBoundingClientRect && el.getBoundingClientRect();
            var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
            return !!rect && rect.width > 0 && rect.height > 0 && (!style || (style.visibility !== 'hidden' && style.display !== 'none'));
          }
          function findSendButton() {
            var selectors = ['[data-translate-title="STR_SEND"]', 'button[class*="send"]', '.chat-input__send-btn', '[aria-label="Gửi"]', '[aria-label="Send"]'];
            for (var i = 0; i < selectors.length; i++) {
              var btn = Array.from(document.querySelectorAll(selectors[i])).find(isVisible);
              if (btn) return btn;
            }
            return null;
          }
          var btn = findSendButton();
          if (btn) { btn.click(); return { ok: true }; }
          return { ok: false };
        })();
      `);
      if (!sendResult || !sendResult.ok) {
        view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        view.webContents.sendInputEvent({ type: 'char', keyCode: 'Enter' });
        view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      }
      return { ok: true, message: 'Đã gửi lệnh chèn/gửi vào tab Zalo.' };
    } catch (err) { return { ok: false, message: err.message || String(err) }; }
  });
  ipcMain.handle('zalo-switch-and-send', async (event, chatName, message, options = {}) => {
    const requestedProfileId = options.profileId || activeProfileId;
    const view = requestedProfileId && browserViews[requestedProfileId];
    if (!view || !message || !chatName) return { ok: false, message: 'Thiếu thông tin người nhận, tin nhắn, hoặc tab Zalo.' };
    try {
      const safeName = JSON.stringify(String(chatName || ''));
      const safeMessage = JSON.stringify(String(message));
      const result = await view.webContents.executeJavaScript(`
        (function() {
          function normalizeText(value) {
            return String(value || '')
              .normalize('NFC')
              .replace(/[\u200B-\u200D\uFEFF]/g, '')
              .replace(/\\s+/g, ' ')
              .trim();
          }
          function getVisibleText(el) {
            return normalizeText((el && (el.innerText || el.textContent)) || '');
          }
          function clickElement(el) {
            try {
              if (!el) return false;
              if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
              var clickTarget = el.querySelector('.conv-item-title__name, .item-title__name, .truncate') || el;
              var mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window });
              var mouseup = new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window });
              var click = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
              clickTarget.dispatchEvent(mousedown);
              clickTarget.dispatchEvent(mouseup);
              clickTarget.dispatchEvent(click);
              clickTarget.click();
              el.click();
              return true;
            } catch (e) { return false; }
          }
          var wantedName = normalizeText(${safeName});
          var items = Array.from(document.querySelectorAll('.msg-item, [data-id], .group-board-item'));
          var exactMatch = null;
          var fuzzyMatch = null;
          for (var i = 0; i < items.length; i++) {
            var item = items[i];
            var nameEl = item.querySelector('.conv-item-title__name, .item-title__name, .item-title, .truncate');
            var itemName = getVisibleText(nameEl);
            var itemText = getVisibleText(item);
            if (!itemName && !itemText) continue;
            if (!exactMatch && itemName === wantedName) exactMatch = item;
            if (!fuzzyMatch && itemName && (itemText.includes(wantedName) || wantedName.includes(itemName))) fuzzyMatch = item;
          }
          var targetEl = exactMatch || fuzzyMatch;
          if (targetEl) {
            clickElement(targetEl);
            return { found: true, matched: getVisibleText(targetEl) };
          }
          return { found: false };
        })();
      `);

      if (!result || (!result.found && result.ok === false)) {
        return result || { ok: false, message: 'Failed to switch chat.' };
      }

      if (result && !result.found) {
        // Fallback to Search
        const searchBoxReady = await view.webContents.executeJavaScript(`
          (function() {
            var searchInput = document.getElementById('contact-search-input') || document.querySelector('input[placeholder*="Tìm kiếm"]');
            if (searchInput) {
              searchInput.focus();
              document.execCommand('selectAll', false, null);
              return true;
            }
            return false;
          })();
        `);
        if (!searchBoxReady) return { ok: false, message: 'Không tìm thấy cuộc hội thoại và không mở được ô tìm kiếm: ' + String(chatName) };

        view.webContents.insertText(String(chatName));
        
        let searchClick = false;
        for (let s = 0; s < 3; s++) {
          await new Promise(r => setTimeout(r, 1000));
          searchClick = await view.webContents.executeJavaScript(`
            (function() {
              function normalizeText(value) {
                return String(value || '').normalize('NFC').replace(/[\\u200B-\\u200D\\uFEFF]/g, '').replace(/\\s+/g, ' ').trim();
              }
              var wantedName = normalizeText(${safeName});
              var items = Array.from(document.querySelectorAll('.global-search-result .msg-item, #contact-search-result .msg-item, .ReactVirtualized__Grid .msg-item, [id*="search"] .msg-item'));
              if (!items.length) items = Array.from(document.querySelectorAll('.msg-item'));
              var exactMatch = null, fuzzyMatch = null;
              for (var i = 0; i < items.length; i++) {
                var item = items[i];
                var nameEl = item.querySelector('.conv-item-title__name, .item-title__name, .item-title, .truncate');
                var itemName = normalizeText((nameEl && (nameEl.innerText || nameEl.textContent)) || '');
                if (itemName === wantedName) exactMatch = item;
                if (!fuzzyMatch && itemName && itemName.includes(wantedName)) fuzzyMatch = item;
              }
              var target = exactMatch || fuzzyMatch;
              if (target) {
                var clickTarget = target.querySelector('.conv-item-title__name, .item-title__name, .truncate') || target;
                if (target.scrollIntoView) target.scrollIntoView({ block: 'center' });
                clickTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                clickTarget.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                clickTarget.click();
                target.click();
                return true;
              }
              return false;
            })();
          `);
          if (searchClick) break;
        }
        if (!searchClick) return { ok: false, message: 'Không tìm thấy kết quả tìm kiếm cho: ' + String(chatName) };
      }

      for (let attempt = 0; attempt < 12; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, attempt < 3 ? 500 : 800));
        const ready = await view.webContents.executeJavaScript(`
          (function() {
            function normalizeText(value) {
              return String(value || '').normalize('NFC').replace(/[\\u200B-\\u200D\\uFEFF]/g, '').replace(/\\s+/g, ' ').trim();
            }
            
            function findInput() {
              var selectors = [
                '#richInput',
                '#chatInput',
                '[id*="input_line_"]',
                '#chatView [contenteditable="true"]',
                '.chat-input [contenteditable="true"]',
                '[contenteditable="true"][placeholder*="Nhập"]',
                '[contenteditable="true"][placeholder*="nhắn"]'
              ];
              for (var i = 0; i < selectors.length; i++) {
                var found = document.querySelector(selectors[i]);
                if (found) return found;
              }
              return null;
            }
            
            var wantedName = normalizeText(${safeName});
            function isMatch(txt) {
              if (!txt || !wantedName) return false;
              return txt === wantedName || txt.includes(wantedName) || (wantedName.includes(txt) && txt.length > 3);
            }

            var headerEl = null;
            var headerText = '';

            var headerSelectors = [
              '#chatView header [class*="title"]', 
              '#chatView header [class*="name"]', 
              '#chatView .header-title', 
              '#chatView .title-name', 
              '#chatView .conv-title', 
              '#chatView header span', 
              '[data-id="div_Main_Header"] [class*="title"]',
              '#chatView [class*="title"]',
              '#chatView [class*="name"]'
            ];
            
            for (var i = 0; i < headerSelectors.length; i++) {
              headerEl = document.querySelector(headerSelectors[i]);
              if (headerEl) {
                headerText = normalizeText(headerEl.innerText || headerEl.textContent);
                if (isMatch(headerText)) break;
              }
            }
            
            var input = findInput();
            return { 
              ok: !!input, 
              headerText: headerText, 
              matched: isMatch(headerText),
              debugHeader: headerText,
              debugWanted: wantedName
            };
          })();
        `);
        if (ready && ready.ok && ready.matched) break;
        if (attempt === 11) {
          console.log('Zalo Campaign send failed. Target: ' + String(chatName) + ', Ready payload:', ready);
          return { ok: false, message: `Đã click hội thoại nhưng chưa mở được ô chat cho: ${String(chatName).trim()}` };
        }
      }

      const focusResult = await view.webContents.executeJavaScript(`
        (function() {
          function isVisible(el) {
            if (!el) return false;
            var rect = el.getBoundingClientRect && el.getBoundingClientRect();
            var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
            return !!rect && rect.width > 0 && rect.height > 0 && (!style || (style.visibility !== 'hidden' && style.display !== 'none'));
          }
          function findInput() {
            var selectors = [
              '#richInput',
              '#chatInput',
              '[id*="input_line_"]',
              '.chat-input [contenteditable="true"]',
              '[contenteditable="true"][role="textbox"]',
              '[contenteditable="true"]',
              '[role="textbox"]',
              'textarea'
            ];
            for (var i = 0; i < selectors.length; i++) {
              var found = Array.from(document.querySelectorAll(selectors[i])).find(isVisible);
              if (found) return found;
            }
            return null;
          }
          var input = findInput();
          if (!input) return { ok: false, message: 'Không tìm thấy ô nhập chat Zalo sau khi chuyển.' };
          input.focus();
          document.execCommand('selectAll', false, null);
          return { ok: true };
        })();
      `);
      if (!focusResult || !focusResult.ok) return focusResult;

      view.webContents.insertText(String(message));
      await new Promise(resolve => setTimeout(resolve, 50));

      const sendResult = await view.webContents.executeJavaScript(`
        (function() {
          function isVisible(el) {
            if (!el) return false;
            var rect = el.getBoundingClientRect && el.getBoundingClientRect();
            var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
            return !!rect && rect.width > 0 && rect.height > 0 && (!style || (style.visibility !== 'hidden' && style.display !== 'none'));
          }
          function findSendButton() {
            var selectors = ['[data-translate-title="STR_SEND"]', 'button[class*="send"]', '.chat-input__send-btn', '[aria-label="Gửi"]', '[aria-label="Send"]'];
            for (var i = 0; i < selectors.length; i++) {
              var btn = Array.from(document.querySelectorAll(selectors[i])).find(isVisible);
              if (btn) return btn;
            }
            return null;
          }
          var btn = findSendButton();
          if (btn) { btn.click(); return { ok: true }; }
          return { ok: false };
        })();
      `);
      if (!sendResult || !sendResult.ok) {
        view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        view.webContents.sendInputEvent({ type: 'char', keyCode: 'Enter' });
        view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      }
      return { ok: true, message: 'Đã gửi lệnh chèn/gửi vào Zalo.' };
    } catch (err) { return { ok: false, message: err.message || String(err) }; }
  });
  ipcMain.on('renderer-ready', () => sendToRenderer('lock-state', { locked: settings.lockOnStartup || appLocked, hasPassword: !!settings.lockPasswordHash, zadarkShield: settings.zadarkShield }));
  ipcMain.on('check-for-updates', () => checkForUpdates(true));
  ipcMain.on('download-update', () => autoUpdater.downloadUpdate().catch(err => setUpdateState({ status: 'error', message: (err.message || err.toString()).split('\n')[0] })));
  ipcMain.on('install-update', () => { isQuitting = true; autoUpdater.quitAndInstall(); });
  ipcMain.on('get-update-state', () => sendToRenderer('update-state', updateState));
  ipcMain.on('get-downloads', () => sendToRenderer('downloads-list', downloads));
  ipcMain.on('open-download', (event, id) => { const d = downloads.find(x => x.id === id); if (d?.savePath) shell.openPath(d.savePath); });
  ipcMain.on('show-download-in-folder', (event, id) => { const d = downloads.find(x => x.id === id); if (d?.savePath) shell.showItemInFolder(d.savePath); });
  ipcMain.on('remove-download', (event, id) => { downloads = downloads.filter(x => x.id !== id); sendToRenderer('downloads-list', downloads); });
  ipcMain.on('toggle-zadark-shield', () => toggleZadarkShield(!settings.zadarkShield));
  ipcMain.on('lock-app', lockApp);
  ipcMain.on('set-lock-password', (event, password) => { const result = hashPassword(password); settings.lockSalt = result.salt; settings.lockPasswordHash = result.hash; settings.lockOnStartup = true; saveSettings(settings); unlockApp(true); updateTrayMenu(); });
  ipcMain.on('unlock-app', (event, password) => unlockApp(verifyPassword(password)));
  ipcMain.on('remove-lock-password', (event, password) => {
    if (verifyPassword(password)) {
      settings.lockSalt = null;
      settings.lockPasswordHash = null;
      settings.lockOnStartup = false;
      saveSettings(settings);
      unlockApp(true, true);
      updateTrayMenu();
    } else {
      sendToRenderer('unlock-result', { ok: false, message: 'Sai mật khẩu hiện tại.' });
    }
  });
}

function lockApp() { appLocked = true; if (mainWindow) mainWindow.setBrowserView(null); sendToRenderer('lock-state', { locked: true, hasPassword: !!settings.lockPasswordHash, zadarkShield: settings.zadarkShield }); }
function unlockApp(ok, removed = false) { if (ok) { appLocked = false; sendToRenderer('unlock-result', { ok: true, removed }); if (mainWindow && activeProfileId && browserViews[activeProfileId]) { mainWindow.setBrowserView(browserViews[activeProfileId]); updateBrowserViewBounds(); } } else sendToRenderer('unlock-result', { ok: false, message: 'Sai mật khẩu.' }); }

function updateBadge(count) {
  if (!mainWindow) return;
  if (process.platform === 'win32') {
    if (count > 0) { try { mainWindow.setOverlayIcon(createBadgeIcon(count), `${count} tin nhắn chưa đọc`); } catch { mainWindow.setOverlayIcon(null, ''); } }
    else mainWindow.setOverlayIcon(null, '');
  }
  if (tray) tray.setToolTip(count > 0 ? `9Meta — ${count} tin nhắn chưa đọc` : '9Meta');
}
function registerGlobalShortcuts() {
  const hotkey = settings.globalHotkey || 'Ctrl+Shift+M';
  try { globalShortcut.register(hotkey, () => { if (!mainWindow) return; if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide(); else { mainWindow.show(); mainWindow.focus(); } }); } catch (err) { }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  nativeTheme.themeSource = settings.isDarkMode ? 'dark' : 'light';
  createWindow();
  createTray();
  registerGlobalShortcuts();
  setupAutoUpdater();
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('login', (event, webContents, details, authInfo, callback) => {
  if (authInfo.isProxy) {
    const hostPort = `${authInfo.host}:${authInfo.port}`;
    if (proxyCredentials[hostPort]) { event.preventDefault(); callback(proxyCredentials[hostPort].username, proxyCredentials[hostPort].password); }
  }
});
app.on('before-quit', () => { isQuitting = true; if (mainWindow) { settings.windowBounds = mainWindow.getBounds(); saveSettings(settings); } });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
