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
  desktopCapturer,
  clipboard,
  safeStorage,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const QRCode = require('qrcode');
const { RemoteControlService, normalizeRemoteInput } = require('./modules/remote-control');
const {
  ScanStore,
  buildCancelExtractorScript,
  buildLeaveGroupScript,
  buildPageExtractorScript,
  getDailyLeaveUsageKey,
  LEAVE_GROUP_POLICY,
  saveTxtNoOverwrite,
} = require('./modules/zalo-group-scan');
const { UserScanStore, buildUserExtractorScript } = require('./modules/zalo-user-management');
const { buildUnfriendBridgeProbeScript, buildDirectUnfriendScript } = require('./modules/zalo-unfriend-bridge');
const { buildCompatibilityProbeScript } = require('./modules/zalo-compatibility');
const { isSupportedVideoPath, stageVideoWithDebugger } = require('./modules/video-staging');
const {
  MAX_LIBRARY_VIDEO_BYTES,
  mediaStoreLayout,
  ensureMediaStore,
  hashVideoFile,
  findDuplicateByHash,
  uniqueVideoFileName,
  planVideoAddition,
  readVideoLibraryRows,
  writeVideoLibraryRows,
  moveVideoToTrash,
  thumbnailFileName,
  videoLibraryPublicItem,
} = require('./modules/media-library');
const { generateVideoThumbnail, destroyThumbnailWindow } = require('./modules/video-thumbnail');
const {
  sniffImageFormat,
  isSupportedSourceFormat,
  planImageNormalization,
  summarizeNormalization,
} = require('./modules/quick-reply-image');
const { convertFileToPng, transcodeBufferToPng, destroyTranscoderWindow } = require('./modules/image-transcoder');
const { computeViewGeometry, clampPopupWidth } = require('./modules/popup-layout');
const cryptoStore = require('./modules/crypto-store');

function copyFileToWindowsClipboard(filePath) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ ok: false, message: 'Dán video từ clipboard hiện chỉ hỗ trợ Windows.' });
    const script = '& { param([string]$filePath) ' + [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$files = New-Object System.Collections.Specialized.StringCollection',
      '$files.Add($filePath) | Out-Null',
      '[System.Windows.Forms.Clipboard]::SetFileDropList($files)',
    ].join('; ') + ' }';
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script, filePath], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ ok: false, message: 'Không thể sao chép video vào clipboard trong thời gian cho phép.' }); }, 10000);
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => { clearTimeout(timer); resolve({ ok: false, message: `Không mở được clipboard Windows: ${error.message || error}` }); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true } : { ok: false, message: stderr.trim() || 'Windows không chấp nhận video vào clipboard.' });
    });
  });
}

async function focusZaloComposerAndPasteFile(view, filePath) {
  const focused = await view.webContents.executeJavaScript(`
    (() => {
      const selectors = ['#richInput', '.chat-input [contenteditable="true"]', '[data-id="chat-input"] [contenteditable="true"]', '[contenteditable="true"]'];
      const inputs = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
      const input = inputs.find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 80 && rect.height > 12 && rect.bottom > innerHeight * 0.65;
      });
      if (!input) return false;
      input.focus();
      return true;
    })()
  `);
  if (!focused) return { ok: false, message: 'Hãy mở một hội thoại Zalo có ô nhập tin nhắn rồi thử lại.' };
  const copied = await copyFileToWindowsClipboard(filePath);
  if (!copied.ok) return copied;
  view.webContents.focus();
  view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
  view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
  return { ok: true };
}

const ZALO_URL = 'https://chat.zalo.me';
const APP_ID = 'com.zalo.desktop';
const SIDEBAR_WIDTH = 68;
const TOPBAR_HEIGHT = 42;
const DEFAULT_UTILITY_PANEL_WIDTH = 560;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) app.quit();
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

// Mật khẩu master DO CHỦ CỬA HÀNG ĐẶT SẴN (một mật khẩu chung cho mọi máy).
// Nhân viên cài/cập nhật phải nhập đúng mật khẩu này mới được vào.
// Salt 16B base64 + hash PBKDF2 32B hex (sinh bằng deriveKey với PRESET_MASTER_SALT) —
// không lưu plaintext password trong mã nguồn.
const PRESET_MASTER_SALT = '0HbDkBZ+5lr8kwovdtoPsg==';
const PRESET_MASTER_HASH_HEX = '3727c5ed23d23df6301431240c186e5e055a09dcd65fba138353f3f9ab452d8b';
function matchesPresetMasterPassword(pwd) {
  try {
    const key = cryptoStore.deriveKey(String(pwd || ''), Buffer.from(PRESET_MASTER_SALT, 'base64'));
    return crypto.timingSafeEqual(key, Buffer.from(PRESET_MASTER_HASH_HEX, 'hex'));
  } catch { return false; }
}

// Mã hoá at-rest: một master password chung -> một masterKey duy nhất trong RAM.
// Salt được lưu plaintext trong secure-meta.json (không nhạy cảm) để derive được
// ngay cả khi settings.json đã là ciphertext.
const SECURE_META_PATH = path.join(app.getPath('userData'), 'secure-meta.json');
const SECURE_KEY_PATH = path.join(app.getPath('userData'), 'secure-key.bin');
let storeUnlocked = false;
let masterKey = null;      // Buffer 32B, chỉ sống trong RAM
let masterSalt = null;     // base64
const PENDING_SENSITIVE_IPC = new Set([
  'crm:login', 'crm:request', 'pancake:request',
  'zalo-group-scan:start', 'zalo-group-scan:cancel', 'zalo-user-scan:start', 'zalo-unfriend:start',
  'active-chat:send-text', 'active-chat:send-video',
]);

function readSecureMeta() {
  try {
    const raw = fs.readFileSync(SECURE_META_PATH, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj.salt === 'string' && obj.salt.length) return obj.salt;
  } catch {}
  return null;
}
function writeSecureMeta(saltB64) {
  try {
    fs.mkdirSync(path.dirname(SECURE_META_PATH), { recursive: true });
    fs.writeFileSync(SECURE_META_PATH, JSON.stringify({ v: 1, salt: saltB64 }), 'utf8');
  } catch {}
}
function ensureMasterSalt() {
  if (masterSalt) return masterSalt;
  masterSalt = readSecureMeta();
  if (masterSalt) return masterSalt;
  // Legacy: nếu settings.json còn plaintext và chứa salt cũ của lockPassword -> không tái sử dụng
  // (salt đó dùng cho 120k iter hash, không phải 150k encrypt). Sinh salt mới cho encrypt.
  const fresh = cryptoStore.generateSalt();
  masterSalt = fresh.toString('base64');
  writeSecureMeta(masterSalt);
  return masterSalt;
}
function getFileStoreKey() {
  return storeUnlocked && masterKey ? masterKey : null;
}
function getFileSalt() {
  if (!storeUnlocked || !masterSalt) return null;
  return masterSalt;
}
function needsMasterPasswordOverlay() {
  // Bắt buộc overlay nhập master password mỗi khi store chưa mở khoá.
  // Kể cả cài mới / data còn plaintext: nhân viên phải nhập ĐÚNG mật khẩu
  // đã set sẵn (matchesPresetMasterPassword) mới vào được.
  return !storeUnlocked;
}
function tryAutoUnlockFromDpapi() {
  // Đọc blob DPAPI nếu có, thử giải + mở khoá
  try {
    if (!fs.existsSync(SECURE_KEY_PATH)) return false;
    if (!safeStorage.isEncryptionAvailable || !safeStorage.isEncryptionAvailable()) return false;
    const blob = fs.readFileSync(SECURE_KEY_PATH);
    if (!blob.length) return false;
    const password = safeStorage.decryptString(blob);
    if (!password) return false;
    const salt = readSecureMeta();
    if (!salt) return false; // chưa có salt -> chưa từng mã hoá
    const key = cryptoStore.deriveKey(password, Buffer.from(salt, 'base64'));
    // Thử giải 1 file mã hoá để xác thực mật khẩu trước khi đặt storeUnlocked
    try {
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
      if (cryptoStore.isEncryptedFileContent(raw)) {
        const payload = JSON.parse(raw);
        cryptoStore.decryptObject(payload, key);
      }
    } catch (err) {
      // Sai mật khẩu hoặc tag lỗi -> DPAPI blob stale -> xoá để bắt nhập lại
      return false;
    }
    masterKey = key;
    masterSalt = salt;
    storeUnlocked = true;
    // Reload settings từ ciphertext ngay sau khi mở khoá
    try { settings = loadSettings(); } catch {}
    return true;
  } catch { return false; }
}
function rememberMasterPassword(password) {
  try {
    if (!safeStorage.isEncryptionAvailable || !safeStorage.isEncryptionAvailable()) return false;
    const blob = safeStorage.encryptString(String(password));
    fs.mkdirSync(path.dirname(SECURE_KEY_PATH), { recursive: true });
    fs.writeFileSync(SECURE_KEY_PATH, blob);
    return true;
  } catch { return false; }
}
function forgetMasterPassword() {
  try { fs.unlinkSync(SECURE_KEY_PATH); } catch {}
}

// Chuyển 1 file plaintext -> ciphertext bằng key vừa derive. Backup plaintext rồi ghi đè.
// Trả về số file đã migrate. Idempotent: bỏ qua file đã là ciphertext / missing.
function migrateStoreToEncrypted(key, salt) {
  if (!key || !salt) return 0;
  let migrated = 0;
  const files = [SETTINGS_PATH];
  try {
    const entries = fs.readdirSync(WORKSPACES_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) files.push(path.join(WORKSPACES_DIR, e.name, 'data.json'));
    }
  } catch {}
  for (const file of files) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const trimmed = (raw || '').trim();
    if (!trimmed) continue;
    if (cryptoStore.isEncryptedFileContent(trimmed)) continue; // đã mã hoá
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }      // không parse được -> bỏ
    cryptoStore.backupFile(file, path.join(BACKUP_DIR, `${Date.now()}-${path.basename(file)}`));
    cryptoStore.writeStoreFile(file, obj, key, salt);
    migrated++;
  }
  return migrated;
}

// Mở khoá store bằng master password. Xử cả 3 trường hợp:
//  (1) file đã ciphertext -> test-decrypt để xác thực.
//  (2) còn legacy lockPasswordHash (plaintext) -> verifyPassword mật khẩu cũ.
//  (3) plaintext, chưa legacy -> chấp nhận (renderer đã xác nhận tạo pass).
// Thành công thì đặt state, migrate plaintext->encrypted, reload settings, optional remember.
function applyUnlock(password, remember) {
  const pwd = String(password || '');
  if (!pwd) return { ok: false, message: 'Vui lòng nhập mật khẩu.' };
  const saltB64 = ensureMasterSalt();
  const key = cryptoStore.deriveKey(pwd, Buffer.from(saltB64, 'base64'));

  // (1) settings đã mã hoá -> xác thực bằng test-decrypt
  let settingsWasEncrypted = false;
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    if (cryptoStore.isEncryptedFileContent(raw)) {
      settingsWasEncrypted = true;
      cryptoStore.decryptObject(JSON.parse(raw), key); // throw nếu sai key
    }
  } catch (err) {
    if (settingsWasEncrypted) return { ok: false, message: 'Sai mật khẩu.' };
  }

  if (!settingsWasEncrypted) {
    // (2) Chưa mã hoá (cài mới, hoặc còn legacy lockPasswordHash plaintext):
    // bắt buộc nhập ĐÚNG mật khẩu master đã set sẵn (một mật khẩu chung cho mọi máy).
    // Data chưa được mã hoá nên không mất gì khi bỏ qua mật khẩu khoá cũ khác mật khẩu master.
    if (!matchesPresetMasterPassword(pwd)) return { ok: false, message: 'Sai mật khẩu.' };
  }

  // Thành công -> đặt state rồi migrate
  masterKey = key;
  masterSalt = saltB64;
  storeUnlocked = true;
  appLocked = false; // mở khoá store là bỏ luôn khoá màn hình
  try { settings = loadSettings(); } catch {}
  migrateStoreToEncrypted(masterKey, masterSalt);
  try { settings = loadSettings(); } catch {} // đọc lại bản đã mã hoá
  if (remember) rememberMasterPassword(pwd);
  return { ok: true };
}

function revealBrowserViewIfUnlocked() {
  if (!storeUnlocked) return;
  if (mainWindow && activeProfileId && browserViews[activeProfileId]) {
    try { mainWindow.setBrowserView(browserViews[activeProfileId]); updateBrowserViewBounds(); } catch {}
  }
}

function isSensitiveIpcLocked(channel) {
  if (storeUnlocked) return false;
  if (PENDING_SENSITIVE_IPC.has(channel)) return true;
  // check prefix handlers
  if (channel.startsWith('crm:') || channel.startsWith('pancake:') || channel.startsWith('zalo-')) return true;
  if (channel.startsWith('active-chat:')) return true;
  return false;
}

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
  leaveDailyUsage: {},
  unfriendDailyUsage: {},
  messageDailyUsage: {},
};

function isWorkspaceDataFile(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  return /\/workspaces\/[^/]+\/data\.json$/.test(normalized);
}
function loadSettings() {
  // Khi store đã mở khoá: giải mã; khi chưa mở mà file đã là ciphertext: trả defaults (sẽ bắt nhập pass).
  // Giữ tương thích: file plaintext -> đọc thẳng.
  try {
    const key = getFileStoreKey();
    const res = cryptoStore.readStoreFile(SETTINGS_PATH, key);
    if (!res || res.status === 'missing') return { ...DEFAULT_SETTINGS };
    if (res.status === 'locked') return { ...DEFAULT_SETTINGS };
    const data = res.data && typeof res.data === 'object' ? res.data : {};
    return { ...DEFAULT_SETTINGS, ...data };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(data) {
  try {
    const key = getFileStoreKey();
    const salt = getFileSalt();
    if (key && salt) {
      cryptoStore.writeStoreFile(SETTINGS_PATH, data, key, salt);
    } else {
      // Chưa mã hoá (migration chưa xong) -> ghi plaintext để lần đầu encrypt sau
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
      if (cryptoStore.isEncryptedFileContent(raw)) {
        // File đã mã hoá nhưng ta đang ghi khi chưa unlock — không ghi đè để tránh mất data
        return;
      }
      fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2), 'utf8');
    }
  } catch (err) {}
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
  groupMappings: [],
  designOrders: [],
  crmAccountMappings: {},
};

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { }
}
function safeJsonRead(file, fallback) {
  try {
    // Chỉ mã hoá workspaces/*/data.json. Index và các file khác giữ plaintext.
    if (isWorkspaceDataFile(file)) {
      const key = getFileStoreKey();
      const res = cryptoStore.readStoreFile(file, key);
      if (!res || res.status === 'missing') return { ...fallback };
      if (res.status === 'locked') return { ...fallback };
      const data = res.data && typeof res.data === 'object' ? res.data : {};
      return { ...fallback, ...data };
    }
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch { return { ...fallback }; }
}
function safeJsonWrite(file, data) {
  ensureDir(path.dirname(file));
  try {
    if (isWorkspaceDataFile(file)) {
      const key = getFileStoreKey();
      const salt = getFileSalt();
      if (key && salt) {
        cryptoStore.writeStoreFile(file, data, key, salt);
        return;
      }
      // Chưa mã hoá nhưng file đã là ciphertext -> không ghi đè plaintext lên ciphertext
      try {
        const raw = fs.readFileSync(file, 'utf8');
        if (cryptoStore.isEncryptedFileContent(raw)) return;
      } catch {}
    }
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch {}
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
    groupMappings: Array.isArray(data.groupMappings) ? data.groupMappings : [],
    designOrders: Array.isArray(data.designOrders) ? data.designOrders : [],
    crmAccountMappings: data.crmAccountMappings && typeof data.crmAccountMappings === 'object' ? data.crmAccountMappings : {},
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

async function ensureQuickReplyReady(view, timeoutMs = 5000) {
  if (!view || view.webContents.isDestroyed()) return false;
  const replies = getWorkspaceState().data.quickReplies || [];
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { ipcMain.removeListener('quick-reply:ready', onReady); resolve(false); }, timeoutMs);
    const onReady = (event, payload = {}) => {
      if (event.sender !== view.webContents || payload.requestId !== requestId) return;
      clearTimeout(timer);
      ipcMain.removeListener('quick-reply:ready', onReady);
      resolve(!!payload.ok);
    };
    ipcMain.on('quick-reply:ready', onReady);
    view.webContents.send('quick-reply:ensure-ready', { requestId, replies });
  });
}

const QUICK_REPLY_IMAGE_DIR = path.join(app.getPath('userData'), 'quick-reply-images');
const BACKUP_DIR = path.join(app.getPath('userData'), 'backups', 'quick-replies');
const IMAGE_MIGRATION_FLAG_PATH = path.join(app.getPath('userData'), 'quick-reply-images', '.png-migration.json');

// Preload cua BrowserView chay trong sandbox nen khong the doc font tu dia.
// Main process doc mot lan roi gui kem theo 'get-settings'.
let quicksandFontDataUrlCache = null;
function getQuicksandFontDataUrl() {
  if (quicksandFontDataUrlCache !== null) return quicksandFontDataUrlCache;
  try {
    const fontBuffer = fs.readFileSync(path.join(__dirname, 'assets', 'fonts', 'Quicksand-VariableFont_wght.ttf'));
    quicksandFontDataUrlCache = `data:font/ttf;base64,${fontBuffer.toString('base64')}`;
  } catch (_) {
    // Giao dien van chay binh thuong voi sans-serif neu thieu font.
    quicksandFontDataUrlCache = '';
  }
  return quicksandFontDataUrlCache;
}
// Kho media nam NGOAI thu muc cai dat: ban cap nhat khong xoa video cua nguoi dung.
// Mac dinh %AppData%/Nha Yen Zalo/media, doi duoc qua settings.mediaRoot.
const DEFAULT_MEDIA_ROOT = path.join(app.getPath('userData'), 'media');

function currentMediaRoot() {
  const configured = String(settings.mediaRoot || '').trim();
  return configured || DEFAULT_MEDIA_ROOT;
}
function currentMediaLayout() {
  return mediaStoreLayout(currentMediaRoot());
}
function readVideoLibrary() {
  return readVideoLibraryRows(currentMediaLayout());
}
function writeVideoLibrary(rows) {
  writeVideoLibraryRows(currentMediaLayout(), rows);
}
function publicVideoItem(item) {
  return videoLibraryPublicItem(currentMediaLayout(), item);
}
function videoFilePath(fileName) {
  return path.join(currentMediaLayout().videosDir, fileName);
}

function backupStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Sao lưu dữ liệu tin nhắn nhanh (JSON + toàn bộ ảnh gốc) trước khi chuyển đổi.
async function backupQuickReplyData(reason = 'manual') {
  const index = loadWorkspaceIndex();
  const stamp = backupStamp();
  const jsonSource = getWorkspaceFile(index.currentId);
  const result = { ok: true, reason, stamp, jsonPath: '', imageDir: '', images: 0 };
  try {
    ensureDir(BACKUP_DIR);
    if (fs.existsSync(jsonSource)) {
      result.jsonPath = path.join(BACKUP_DIR, `${index.currentId}-${stamp}.json`);
      await fs.promises.copyFile(jsonSource, result.jsonPath);
    }
    if (fs.existsSync(QUICK_REPLY_IMAGE_DIR)) {
      result.imageDir = path.join(BACKUP_DIR, `images-${stamp}`);
      ensureDir(result.imageDir);
      const entries = await fs.promises.readdir(QUICK_REPLY_IMAGE_DIR, { withFileTypes: true });
      for (const entry of entries) {
        const from = path.join(QUICK_REPLY_IMAGE_DIR, entry.name);
        const to = path.join(result.imageDir, entry.name);
        if (entry.isDirectory()) {
          await fs.promises.cp(from, to, { recursive: true });
          result.images += (await fs.promises.readdir(from)).length;
          continue;
        }
        if (entry.name.startsWith('.')) continue;
        await fs.promises.copyFile(from, to);
        result.images += 1;
      }
    }
  } catch (err) {
    return { ok: false, reason, message: err.message || String(err) };
  }
  return result;
}

function readImageSignature(imagePath) {
  let handle = null;
  try {
    handle = fs.openSync(imagePath, 'r');
    const buffer = Buffer.alloc(16);
    const read = fs.readSync(handle, buffer, 0, 16, 0);
    return read > 0 ? buffer.subarray(0, read) : null;
  } catch {
    return null;
  } finally {
    if (handle !== null) { try { fs.closeSync(handle); } catch { } }
  }
}

// Chuẩn hóa mọi ảnh mẫu sang PNG thật: giải mã bằng Chromium rồi mã hóa lại,
// giữ lại file gốc và chỉ cập nhật imagePath sau khi ghi PNG thành công.
async function migrateQuickReplyImagesToPng(options = {}) {
  const state = getWorkspaceState();
  const replies = Array.isArray(state.data.quickReplies) ? state.data.quickReplies : [];
  const plan = planImageNormalization(replies, readImageSignature);
  const summary = summarizeNormalization(plan);
  if (!plan.conversions.length) return { ok: true, skipped: true, summary, converted: 0, failed: [] };

  const backup = options.backup === false ? { ok: true, skipped: true } : await backupQuickReplyData('png-migration');
  if (!backup.ok) return { ok: false, message: `Không sao lưu được trước khi chuyển ảnh: ${backup.message}`, summary };

  const failed = [];
  let converted = 0;
  const byId = new Map(replies.map((reply) => [String(reply.id || ''), reply]));
  for (const entry of plan.conversions) {
    try {
      const result = await convertFileToPng(BrowserWindow, entry.imagePath);
      const reply = byId.get(entry.id);
      if (reply && result.targetPath) {
        reply.imagePath = result.targetPath;
        reply.imageFormat = 'png';
        converted += 1;
      }
    } catch (err) {
      failed.push({ id: entry.id, keyword: entry.keyword, imagePath: entry.imagePath, message: err.message || String(err) });
    }
  }

  if (converted) {
    state.data.quickReplies = replies;
    persistWorkspaceState(state.data);
    broadcastQuickReplies(replies);
  }
  destroyTranscoderWindow();
  try { safeJsonWrite(IMAGE_MIGRATION_FLAG_PATH, { at: Date.now(), converted, failed: failed.length, backup }); } catch { }
  return { ok: failed.length === 0, summary, converted, failed, backup };
}

// Nhận ảnh mới từ người dùng: luôn kiểm định dạng thật rồi lưu thành PNG.
async function storeQuickReplyImageAsPng(sourcePath) {
  const buffer = await fs.promises.readFile(sourcePath);
  const format = sniffImageFormat(buffer);
  if (!isSupportedSourceFormat(format)) {
    return { ok: false, message: `Định dạng ảnh không được hỗ trợ (${format || 'không nhận dạng được'}). Hãy dùng PNG, JPG, WEBP, GIF hoặc BMP.` };
  }
  ensureDir(QUICK_REPLY_IMAGE_DIR);
  const imagePath = path.join(QUICK_REPLY_IMAGE_DIR, `${crypto.randomUUID()}.png`);
  if (format === 'png') {
    await fs.promises.writeFile(imagePath, buffer);
    return { ok: true, imagePath, fileName: path.basename(sourcePath), format, converted: false };
  }
  try {
    const png = await transcodeBufferToPng(BrowserWindow, buffer);
    await fs.promises.writeFile(imagePath, png.buffer);
    return { ok: true, imagePath, fileName: path.basename(sourcePath), format, converted: true, width: png.width, height: png.height };
  } catch (err) {
    return { ok: false, message: `Không chuyển được ảnh sang PNG: ${err.message || err}` };
  }
}

let mainWindow = null;
let updateNoticeWindow = null;
let tray = null;
// Lần đọc này thấy plaintext hoặc defaults (chưa mở khoá). Sau khi auto-unlock
// bằng DPAPI ở whenReady, settings sẽ được loadSettings() lại từ ciphertext.
let settings = loadSettings();
let isQuitting = false;
let remoteTunnelProcess = null;
let remotePublicUrl = '';
const remoteControl = new RemoteControlService({
  onAction: async (action) => sendToRenderer('remote-tool-action', action),
});
let unreadCount = 0;
const profileUnreadCounts = new Map();
let browserViews = {};
let activeProfileId = null;
let proxyCredentials = {};
// Khoá màn hình ngay từ đầu nếu dữ liệu đã mã hoá mà chưa mở khoá được bằng DPAPI
// (renderer hiện overlay bắt nhập master password, BrowserView tạm ẩn).
let appLocked = needsMasterPasswordOverlay();
let downloads = [];
let updateState = { status: 'idle', progress: 0, message: 'Sẵn sàng kiểm tra cập nhật.' };
let isBrowserViewVisible = true;
let utilityPanelWidth = 0;
// Bề rộng vùng đang bị popup công cụ chiếm; 0 nghĩa là không có popup nào neo phải.
let popupPanelWidth = 0;
let crmSession = { baseUrl: '', token: '', refreshToken: '', user: null };
const zaloGroupScans = new ScanStore();
const zaloUserScans = new UserScanStore();

function getProfileById(profileId) {
  return (getWorkspaceState().data.profiles || []).find((profile) => profile.id === profileId) || null;
}

function normalizeCrmBaseUrl(value) {
  const url = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('CRM chỉ hỗ trợ địa chỉ HTTP hoặc HTTPS.');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/i, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

async function crmFetch(pathname, options = {}, retry = true) {
  if (!crmSession.baseUrl || !crmSession.token) throw new Error('Chưa đăng nhập Nhà Yến CRM.');
  const pathValue = String(pathname || '');
  if (!/^\/(profile|zalo-accounts|conversations|orders|users)(\/|\?|$)/.test(pathValue)
    && !/^\/automation\/templates(\/|\?|$)/.test(pathValue)) throw new Error('Endpoint CRM không được phép.');
  const response = await fetch(`${crmSession.baseUrl}/api/v1${pathValue}`, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${crmSession.token}` },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (response.status === 401 && retry && crmSession.refreshToken) {
    const refresh = await fetch(`${crmSession.baseUrl}/api/v1/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: crmSession.refreshToken }) });
    if (refresh.ok) {
      const tokens = await refresh.json();
      crmSession.token = tokens.token || tokens.accessToken || '';
      crmSession.refreshToken = tokens.refreshToken || crmSession.refreshToken;
      return crmFetch(pathname, options, false);
    }
  }
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!response.ok) throw new Error(data.error?.message || data.error || data.message || `CRM trả lỗi ${response.status}`);
  return data;
}

// Pancake POS API: key chi nam o main process, renderer chi duoc goi qua kenh pancake:request.
const PANCAKE_BASE = 'https://pos.pages.fm/api/v1';
const PANCAKE_SHOP_ID = '609730';
const PANCAKE_API_KEY = 'fa7fc274ead84f3e8716f410e2b5ab26';

// Chi cho phep cac endpoint doc/ghi don hang cua shop, tranh bi loi dung goi di noi khac.
function pancakeFetch(pathname, options = {}) {
  const pathValue = String(pathname || '');
  if (!/^\/shops\/609730\/(orders|warehouses|products)(\/|\?|$)/.test(pathValue)) throw new Error('Endpoint Pancake không được phép.');
  const separator = pathValue.includes('?') ? '&' : '?';
  return fetch(`${PANCAKE_BASE}${pathValue}${separator}api_key=${PANCAKE_API_KEY}`, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }).then(async (response) => {
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
    if (!response.ok) throw new Error(data.error?.message || data.error || data.message || `Pancake trả lỗi ${response.status}`);
    return data;
  });
}

function isTrustedZaloScanEvent(event, scan) {
  const view = browserViews[scan.profileId];
  if (!view || event.sender !== view.webContents) return false;
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false;
  try { return new URL(event.senderFrame.url).hostname === 'chat.zalo.me'; }
  catch { return false; }
}

function cancelProfileScans(profileId) {
  for (const scan of zaloGroupScans.scans.values()) {
    if (scan.profileId !== profileId || !zaloGroupScans.isActive(scan)) continue;
    zaloGroupScans.cancel(scan.scanId);
    browserViews[profileId]?.webContents.send('zalo-group-scan:cancel', { scanId: scan.scanId, script: buildCancelExtractorScript(scan.scanId) });
    sendToRenderer('zalo-group-scan:update', { scanId: scan.scanId, status: 'cancelled' });
  }
}

function createBadgeIcon(count) {
  const size = 18;
  const text = count > 99 ? '99+' : String(count);
  const fontSize = count > 99 ? 7 : (count > 9 ? 9 : 11);
  const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#e74c3c"/><text x="${size / 2}" y="${size / 2 + fontSize / 3}" text-anchor="middle" fill="white" font-size="${fontSize}" font-weight="bold" font-family="Quicksand, sans-serif">${text}</text></svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function getLanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '127.0.0.1';
}

async function stopRemoteControl() {
  if (remoteTunnelProcess) {
    remoteTunnelProcess.kill();
    remoteTunnelProcess = null;
  }
  remotePublicUrl = '';
  await remoteControl.stop();
  sendToRenderer('remote-control-state', { running: false });
}

function startQuickTunnel(targetUrl) {
  return new Promise((resolve, reject) => {
    const packageRoot = path.dirname(require.resolve('cloudflared/package.json'));
    let binary = path.join(packageRoot, 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
    if (app.isPackaged) binary = binary.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
    const child = spawn(binary, ['tunnel', '--url', targetUrl, '--no-autoupdate'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    remoteTunnelProcess = child;
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) { settled = true; child.kill(); reject(new Error('Không tạo được tunnel trong thời gian cho phép.')); }
    }, 20000);
    const inspect = (chunk) => {
      const match = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeout);
        remotePublicUrl = match[0];
        resolve(match[0]);
      }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('error', (error) => { if (!settled) { settled = true; clearTimeout(timeout); reject(error); } });
    child.once('exit', () => { remoteTunnelProcess = null; remotePublicUrl = ''; });
  });
}
function setUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  sendToRenderer('update-state', updateState);
  if (updateNoticeWindow && !updateNoticeWindow.isDestroyed()) updateNoticeWindow.webContents.send('update-notice-state', updateState);
  if (updateState.status === 'available' || updateState.status === 'downloaded') showUpdateNotice();
}

function normalizeQuickReplyShortcut(value) {
  return String(value || '').trim().replace(/^[\\/]+/, '').replace(/\s+/g, '-').slice(0, 40);
}

function crmTemplateImageUrl(template) {
  let rich = template?.contentRich;
  if (typeof rich === 'string') { try { rich = JSON.parse(rich); } catch { rich = null; } }
  const candidates = Array.isArray(rich?.attachments) && rich.attachments.length
    ? rich.attachments
    : (Array.isArray(template?.tagIds) ? template.tagIds : []);
  const first = candidates.find((item) => typeof item === 'string' && item.trim());
  return first ? String(first).trim() : '';
}

async function storeCrmQuickReplyImageAsPng(sourceUrl) {
  const url = new URL(sourceUrl, `${crmSession.baseUrl}/`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL ảnh CRM không hợp lệ.');
  const headers = {};
  if (url.origin === new URL(crmSession.baseUrl).origin) headers.Authorization = `Bearer ${crmSession.token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`Không tải được ảnh CRM (${response.status}).`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 15 * 1024 * 1024) throw new Error('Ảnh CRM vượt quá 15 MB.');
  const format = sniffImageFormat(buffer);
  if (!isSupportedSourceFormat(format)) throw new Error(`Ảnh CRM không đúng định dạng hỗ trợ (${format || 'không nhận dạng được'}).`);
  ensureDir(QUICK_REPLY_IMAGE_DIR);
  const imagePath = path.join(QUICK_REPLY_IMAGE_DIR, `${crypto.randomUUID()}.png`);
  if (format === 'png') await fs.promises.writeFile(imagePath, buffer);
  else {
    const png = await transcodeBufferToPng(BrowserWindow, buffer);
    await fs.promises.writeFile(imagePath, png.buffer);
  }
  return imagePath;
}

async function syncQuickRepliesFromCrm() {
  const payload = await crmFetch('/automation/templates');
  const templates = Array.isArray(payload) ? payload : (payload.templates || []);
  const state = getWorkspaceState();
  const replies = Array.isArray(state.data.quickReplies) ? [...state.data.quickReplies] : [];
  const byCrmId = new Map(replies.map((reply, index) => [String(reply.crmTemplateId || ''), index]).filter(([id]) => id));
  const used = new Set(replies.map((reply) => normalizeQuickReplyShortcut(reply.keyword).toLocaleLowerCase('vi')).filter(Boolean));
  let added = 0; let updated = 0; let unchanged = 0; let images = 0; let imageErrors = 0;
  for (const template of templates) {
    const crmTemplateId = String(template?.id || '');
    if (!crmTemplateId) continue;
    let existingIndex = byCrmId.get(crmTemplateId);
    let keyword = normalizeQuickReplyShortcut(template.shortcut || template.name || `crm-${crmTemplateId.slice(0, 8)}`);
    if (!keyword) keyword = `crm-${crmTemplateId.slice(0, 8)}`;
    const richText = typeof template.contentRich === 'object' && template.contentRich?.text;
    const message = String(richText || template.content || '').trim();
    if (existingIndex === undefined) {
      const exactIndex = replies.findIndex((reply) => !reply.crmTemplateId
        && normalizeQuickReplyShortcut(reply.keyword).toLocaleLowerCase('vi') === keyword.toLocaleLowerCase('vi')
        && String(reply.message || '').trim() === message);
      if (exactIndex >= 0) existingIndex = exactIndex;
    }
    const existing = existingIndex === undefined ? null : replies[existingIndex];
    if (!existing) {
      const base = keyword; let suffix = 2;
      while (used.has(keyword.toLocaleLowerCase('vi'))) keyword = `${base}-crm-${suffix++}`.slice(0, 40);
    }
    used.add(keyword.toLocaleLowerCase('vi'));
    const attachmentUrl = crmTemplateImageUrl(template);
    let imagePath = existing?.imagePath || '';
    let crmImageError = '';
    if (attachmentUrl && (!existing?.imagePath || existing.crmAttachmentUrl !== attachmentUrl || !fs.existsSync(existing.imagePath))) {
      try { imagePath = await storeCrmQuickReplyImageAsPng(attachmentUrl); images += 1; }
      catch (error) { imageErrors += 1; crmImageError = error.message || String(error); }
    }
    const next = {
      ...(existing || {}),
      id: existing?.id || `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      keyword,
      message,
      imagePath,
      imageFormat: imagePath ? 'png' : '',
      crmTemplateId,
      crmUpdatedAt: String(template.updatedAt || ''),
      crmAttachmentUrl: attachmentUrl,
      crmImageError,
    };
    if (existingIndex === undefined) { replies.push(next); byCrmId.set(crmTemplateId, replies.length - 1); added += 1; }
    else if (JSON.stringify(existing) !== JSON.stringify(next)) { replies[existingIndex] = next; updated += 1; }
    else unchanged += 1;
  }
  state.data.quickReplies = replies;
  persistWorkspaceState(state.data);
  broadcastQuickReplies(replies);
  return { total: replies.length, crmTotal: templates.length, added, updated, unchanged, images, imageErrors };
}
function showUpdateNotice() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (updateNoticeWindow && !updateNoticeWindow.isDestroyed()) {
    updateNoticeWindow.show(); updateNoticeWindow.focus(); updateNoticeWindow.webContents.send('update-notice-state', updateState); return;
  }
  updateNoticeWindow = new BrowserWindow({ width:440, height:480, parent:mainWindow, modal:false, show:false, resizable:false, minimizable:false, maximizable:false, fullscreenable:false, autoHideMenuBar:true, title:'Bản cập nhật Nhà Yến Zalo', backgroundColor:'#ffffff', webPreferences:{ nodeIntegration:true, contextIsolation:false, spellcheck:false } });
  updateNoticeWindow.loadFile('update-notice.html');
  updateNoticeWindow.once('ready-to-show', () => { if (updateNoticeWindow && !updateNoticeWindow.isDestroyed()) { updateNoticeWindow.show(); updateNoticeWindow.webContents.send('update-notice-state', updateState); } });
  updateNoticeWindow.on('closed', () => { updateNoticeWindow = null; });
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
  tray.setToolTip('Nhà Yến Zalo');
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
    { label: '💬 Mở Nhà Yến Zalo', click: () => { mainWindow.show(); mainWindow.focus(); } },
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
    const rawNotes = Array.isArray(info.releaseNotes)
      ? info.releaseNotes.map((entry) => entry?.note || entry?.version || '').filter(Boolean).join('\n')
      : String(info.releaseNotes || '');
    setUpdateState({
      status: 'available', progress: 0, version: info.version, currentVersion: app.getVersion(),
      releaseNotes: rawNotes.trim() || 'Phiên bản mới có các cải tiến về độ ổn định và trải nghiệm sử dụng.',
      message: `Có bản cập nhật mới v${info.version}.`,
    });
    isManualUpdateCheck = false;
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
  // Giữ ứng dụng đang mở vẫn nhận được popup khi một bản mới vừa được phát hành.
  const updatePoll = setInterval(() => {
    if (!isQuitting && updateState.status !== 'downloading' && updateState.status !== 'downloaded') {
      autoUpdater.checkForUpdates().catch(() => { });
    }
  }, 15 * 60 * 1000);
  updatePoll.unref?.();
}
let isManualUpdateCheck = false;
function checkForUpdates(manual = false) { isManualUpdateCheck = manual; autoUpdater.checkForUpdates().catch(err => setUpdateState({ status: 'error', message: (err.message || err.toString()).split('\n')[0] })); }
function toggleAutoLaunch(enable) { settings.autoLaunch = enable; saveSettings(settings); app.setLoginItemSettings({ openAtLogin: enable, path: app.getPath('exe') }); }

function updateBrowserViewBounds() {
  if (!mainWindow || !activeProfileId || !browserViews[activeProfileId]) return;
  const bounds = mainWindow.getContentBounds();
  const view = browserViews[activeProfileId];
  const geometry = computeViewGeometry({
    contentWidth: bounds.width,
    sidebarWidth: SIDEBAR_WIDTH,
    utilityWidth: utilityPanelWidth,
    popupWidth: popupPanelWidth,
  });
  view.setBounds({
    x: geometry.viewX,
    y: TOPBAR_HEIGHT,
    width: geometry.viewWidth,
    height: Math.max(bounds.height - TOPBAR_HEIGHT, 0),
  });
  view.setAutoResize({ width: true, height: true });
  sendToRenderer('popup-geometry', { popupOffsetX: geometry.popupOffsetX, popupWidth: popupPanelWidth, viewWidth: geometry.viewWidth });
}
function isInternalUrl(url) {
  return ['chat.zalo.me', 'id.zalo.me', 'messenger.com', 'facebook.com', 'web.whatsapp.com', 'whatsapp.com', 'teams.microsoft.com', 'microsoft.com', 'live.com', 'office.com', 'google.com', 'gmail.com', 'web.telegram.org', 'telegram.org', 't.me'].some(d => url.includes(d));
}
function getProfilePlatform(profileId) {
  try {
    const ws = getWorkspaceState();
    const profile = (ws.data.profiles || []).find(p => p.id === profileId);
    return profile?.platform || 'zalo';
  } catch { return 'zalo'; }
}
function setupWebContents(contents, profileId) {
  contents.on('did-start-loading', () => sendToRenderer('profile-connection-state', { id: profileId, state: 'loading' }));
  contents.on('did-stop-loading', () => sendToRenderer('profile-connection-state', { id: profileId, state: 'online' }));
  contents.on('did-fail-load', () => sendToRenderer('profile-connection-state', { id: profileId, state: 'error' }));
  contents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank' || url.startsWith('blob:') || url.startsWith('file:')) return { action: 'allow' };
    if (isInternalUrl(url)) return { action: 'allow' };
    let finalUrl = url;
    if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://') && !finalUrl.startsWith('mailto:')) finalUrl = 'https://' + finalUrl;
    shell.openExternal(finalUrl).catch(err => console.error('[Main] Lỗi mở external link:', finalUrl, err));
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    // Allow free navigation for custom platform profiles
    let ownerProfileId = null;
    for (const [id, view] of Object.entries(browserViews)) {
      if (view && view.webContents === contents) { ownerProfileId = id; break; }
    }
    if (ownerProfileId && getProfilePlatform(ownerProfileId) === 'custom') return;
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
      if (platformClass === 'platform-zalo') {
        contents.send('quick-reply:ensure-ready', { replies: getWorkspaceState().data.quickReplies || [] });
      }
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
    minWidth: 960, minHeight: 640, title: 'Nhà Yến Zalo', icon: path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: '#ffffff', show: !settings.startMinimized, autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#ffffff', symbolColor: '#334155', height: TOPBAR_HEIGHT },
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
    if (appLocked || !storeUnlocked) return;
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
      else if (profile.platform === 'facebook') url = 'https://www.facebook.com/';
      else if (profile.platform === 'whatsapp') url = 'https://web.whatsapp.com/';
      else if (profile.platform === 'teams') url = 'https://teams.microsoft.com/';
      else if (profile.platform === 'gmail') url = 'https://mail.google.com/';
      else if (profile.platform === 'telegram') url = 'https://web.telegram.org/a/';
      else if (profile.platform === 'custom' && profile.customUrl) url = profile.customUrl;
      view.webContents.loadURL(url, { userAgent: ua });
    }
    if (isBrowserViewVisible) {
      mainWindow.setBrowserView(browserViews[profile.id]); updateBrowserViewBounds();
    }
  });
  ipcMain.on('update-profile-settings', (event, profile) => {
    cancelProfileScans(profile.id);
    if (browserViews[profile.id]) {
      if (activeProfileId === profile.id && mainWindow) mainWindow.setBrowserView(null);
      browserViews[profile.id].webContents.destroy();
      delete browserViews[profile.id];
    }
    const sess = session.fromPartition(profile.partition);
    setupDownloads(sess);
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
  ipcMain.on('set-popup-width', (event, requestedWidth) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    const bounds = mainWindow.getContentBounds();
    popupPanelWidth = Number(requestedWidth) > 0
      ? clampPopupWidth(requestedWidth, { contentWidth: bounds.width, sidebarWidth: SIDEBAR_WIDTH, utilityWidth: utilityPanelWidth })
      : 0;
    updateBrowserViewBounds();
  });
  ipcMain.on('set-utility-panel-width', (event, requestedWidth) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    const next = Number(requestedWidth);
    utilityPanelWidth = Number.isFinite(next) ? Math.max(0, Math.min(620, Math.round(next))) : DEFAULT_UTILITY_PANEL_WIDTH;
    updateBrowserViewBounds();
  });
  ipcMain.handle('crm:login', async (event, payload = {}) => {
    if (!storeUnlocked) return { ok: false, locked: true, message: 'Vui lòng mở khoá dữ liệu trước.' };
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    try {
      const baseUrl = normalizeCrmBaseUrl(payload.baseUrl || 'http://localhost:3000');
      const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: String(payload.identifier || '').trim(), password: String(payload.password || '') }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message || data.error || data.message || 'Đăng nhập CRM thất bại.');
      crmSession = {
        baseUrl,
        token: data.token || data.accessToken || '',
        refreshToken: data.refreshToken || '',
        user: data.user || null,
      };
      if (!crmSession.token) throw new Error('CRM không trả access token.');
      if (!crmSession.user) crmSession.user = await crmFetch('/profile');
      const accounts = await crmFetch('/zalo-accounts');
      return { ok: true, baseUrl, user: crmSession.user, accounts: Array.isArray(accounts) ? accounts : accounts.accounts || [] };
    } catch (error) {
      crmSession = { baseUrl: '', token: '', refreshToken: '', user: null };
      return { ok: false, message: error.message || String(error) };
    }
  });
  ipcMain.handle('crm:logout', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false };
    crmSession = { baseUrl: '', token: '', refreshToken: '', user: null };
    return { ok: true };
  });
  ipcMain.handle('crm:request', async (event, payload = {}) => {
    if (!storeUnlocked) return { ok: false, locked: true, message: 'Vui lòng mở khoá dữ liệu trước.' };
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    try { return { ok: true, data: await crmFetch(payload.path, { method: payload.method, body: payload.body }) }; }
    catch (error) { return { ok: false, message: error.message || String(error) }; }
  });
  ipcMain.handle('pancake:request', async (event, payload = {}) => {
    if (!storeUnlocked) return { ok: false, locked: true, message: 'Vui lòng mở khoá dữ liệu trước.' };
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    try { return { ok: true, data: await pancakeFetch(payload.path, { method: payload.method, body: payload.body }) }; }
    catch (error) { return { ok: false, message: error.message || String(error) }; }
  });
  ipcMain.on('delete-profile', (event, id) => { cancelProfileScans(id); profileUnreadCounts.delete(id); if (browserViews[id]) { browserViews[id].webContents.destroy(); delete browserViews[id]; } });

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
  ipcMain.handle('active-chat:get-info', async (event, requestedProfileId) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    const profileId = requestedProfileId || activeProfileId;
    const view = profileId && browserViews[profileId];
    if (!view || !(view.webContents.getURL() || '').includes('zalo.me')) return { ok: false, message: 'Hãy chọn nick Zalo trước.' };
    try {
      const result = await view.webContents.executeJavaScript(`
        (() => {
          const visible = (el) => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.top < 180;
          };
          const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
          const invalid = /^(Thông tin nhóm|Thành viên nhóm|Danh sách bạn bè|Zalo)$/i;
          const selectors = [
            '#chatView .header-title', '#chatView .title-name',
            '[data-id="div_Main_Header"] .title-name', '[data-id="div_Main_Header"] [class*="title"]',
            '.chat-info__header .title', '.header-title', '.title-name',
            '[class*="chat-header"] [class*="title"]'
          ];
          const candidates = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
            .filter(visible)
            .map((element) => ({ text: clean(element.innerText), rect: element.getBoundingClientRect() }))
            .filter((item) => item.text && !invalid.test(item.text) && item.text.length <= 160)
            .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
          return candidates[0] ? { ok: true, name: candidates[0].text } : { ok: false, message: 'Chưa nhận diện được tên hội thoại đang mở.' };
        })()
      `);
      return result?.ok ? { ...result, profileId, platform: 'zalo' } : result;
    } catch (error) { return { ok: false, message: error.message || String(error) }; }
  });
  ipcMain.on('recent-chats-extracted', (event, chats) => {
    let senderId = null;
    for (const [id, view] of Object.entries(browserViews)) {
      if (view.webContents === event.sender) { senderId = id; break; }
    }
    if (senderId) sendToRenderer('recent-chats', { chats, profileId: senderId });
  });
  ipcMain.on('profile-unread-count', (event, rawCount) => {
    let senderId = null;
    for (const [id, view] of Object.entries(browserViews)) {
      if (view.webContents === event.sender) { senderId = id; break; }
    }
    if (!senderId) return;
    const count = Math.max(0, Math.min(9999, Math.trunc(Number(rawCount) || 0)));
    profileUnreadCounts.set(senderId, count);
    sendToRenderer('update-profile-badge', { id: senderId, count });
    const total = Array.from(profileUnreadCounts.values()).reduce((sum, value) => sum + value, 0);
    if (total !== unreadCount) {
      const hadNewMessages = total > unreadCount;
      unreadCount = total;
      updateBadge(unreadCount);
      if (hadNewMessages && mainWindow && !mainWindow.isFocused()) mainWindow.flashFrame(true);
    }
  });
  ipcMain.handle('remote-control:start', async (event, options = {}) => {
    try {
      await stopRemoteControl();
      const state = await remoteControl.start({ host: '0.0.0.0', port: 0 });
      const port = Number(new URL(state.localUrl).port);
      const lanBaseUrl = `http://${getLanAddress()}:${port}`;
      let baseUrl = lanBaseUrl;
      if (options.useTunnel) baseUrl = await startQuickTunnel(`http://127.0.0.1:${port}`);
      const accessUrl = `${baseUrl}/?token=${encodeURIComponent(state.token)}`;
      const qrDataUrl = await QRCode.toDataURL(accessUrl, { width: 320, margin: 1, errorCorrectionLevel: 'M' });
      const payload = { running: true, reach: options.useTunnel ? 'Internet (tunnel)' : 'Mạng nội bộ (LAN)', accessUrl, qrDataUrl };
      sendToRenderer('remote-control-state', payload);
      return { ok: true, ...payload };
    } catch (error) {
      await stopRemoteControl();
      return { ok: false, message: error.message || String(error) };
    }
  });
  ipcMain.handle('remote-control:stop', async () => {
    await stopRemoteControl();
    return { ok: true, running: false };
  });
  ipcMain.handle('remote-control:state', async () => {
    const state = remoteControl.getState();
    if (!state.running) return { running: false };
    const port = Number(new URL(state.localUrl).port);
    const baseUrl = remotePublicUrl || `http://${getLanAddress()}:${port}`;
    const accessUrl = `${baseUrl}/?token=${encodeURIComponent(state.token)}`;
    return { running: true, reach: remotePublicUrl ? 'Internet (tunnel)' : 'Mạng nội bộ (LAN)', accessUrl, qrDataUrl: await QRCode.toDataURL(accessUrl, { width: 320, margin: 1 }) };
  });
  ipcMain.handle('remote-control:capture-source', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    const id = mainWindow.getMediaSourceId();
    return id ? { id, name: 'Nhà Yến Zalo.exe' } : null;
  });
  ipcMain.on('remote-input-event', (event, payload = {}) => {
    if (!remoteControl.getState().running || !mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
    payload = normalizeRemoteInput(payload);
    if (!payload) return;
    const view = activeProfileId && browserViews[activeProfileId];
    const x = Math.round((payload.x ?? 0) * mainWindow.getContentBounds().width);
    const y = Math.round((payload.y ?? 0) * mainWindow.getContentBounds().height);
    const targetsBrowser = !!view && x >= SIDEBAR_WIDTH && y >= TOPBAR_HEIGHT;
    const target = targetsBrowser ? view.webContents : mainWindow.webContents;
    if (!target || target.isDestroyed()) return;
    if (payload.kind === 'mouse' && ['mouseDown', 'mouseUp', 'mouseMove'].includes(payload.type)) {
      const inputEvent = {
        type: payload.type,
        x: targetsBrowser ? x - SIDEBAR_WIDTH : x,
        y: targetsBrowser ? y - TOPBAR_HEIGHT : y,
      };
      if (payload.type !== 'mouseMove') {
        inputEvent.button = ['left', 'right', 'middle'].includes(payload.button) ? payload.button : 'left';
        inputEvent.clickCount = 1;
      }
      target.sendInputEvent(inputEvent);
    } else if (payload.kind === 'wheel' && Number.isFinite(Number(payload.deltaY))) {
      target.sendInputEvent({ type: 'mouseWheel', x: targetsBrowser ? x - SIDEBAR_WIDTH : x, y: targetsBrowser ? y - TOPBAR_HEIGHT : y, deltaX: 0, deltaY: Math.max(-500, Math.min(500, Number(payload.deltaY))) });
    } else if (payload.kind === 'text' && targetsBrowser) {
      const text = String(payload.text || '').slice(0, 4000).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
      if (text) target.insertText(text);
    } else if (payload.kind === 'key' && targetsBrowser) {
      const keyMap = { ENTER: 'Enter', BACKSPACE: 'Backspace', TAB: 'Tab', ESCAPE: 'Escape', DELETE: 'Delete' };
      const keyCode = keyMap[payload.key];
      if (keyCode) {
        target.sendInputEvent({ type: 'keyDown', keyCode });
        target.sendInputEvent({ type: 'keyUp', keyCode });
      }
    }
  });

  ipcMain.handle('zalo-group-scan:start', async (event, requestedProfileId) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    if (!storeUnlocked) return { ok: false, locked: true, message: 'Vui lòng mở khoá dữ liệu trước.' };
    const profileId = requestedProfileId || activeProfileId;
    const profile = profileId && getProfileById(profileId);
    const view = profileId && browserViews[profileId];
    if (!profile || profile.platform !== 'zalo' || !view) return { ok: false, message: 'Hãy chọn một profile Zalo đang mở.' };
    try {
      if (new URL(view.webContents.getURL()).hostname !== 'chat.zalo.me') return { ok: false, message: 'Profile Zalo chưa đăng nhập vào chat.zalo.me.' };
    } catch { return { ok: false, message: 'Không đọc được trang Zalo hiện tại.' }; }
    cancelProfileScans(profileId);
    const scanId = crypto.randomUUID();
    zaloGroupScans.start({ scanId, profileId: profile.id, partition: profile.partition });
    try {
      view.webContents.send('zalo-group-scan:start', { scanId, script: buildPageExtractorScript(scanId) });
    } catch (error) {
      zaloGroupScans.markError(scanId, error.message || String(error));
      return { ok: false, message: `Không khởi động được bộ quét nhóm: ${error.message || error}` };
    }
    sendToRenderer('zalo-group-scan:update', { scanId, profileId: profile.id, status: 'discovering', pages: 0, discovered: 0, processed: 0, failed: 0 });
    return { ok: true, scanId, profileId: profile.id };
  });

  ipcMain.handle('zalo-user-scan:start', async (event, requestedProfileId) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    if (!storeUnlocked) return { ok: false, locked: true, message: 'Vui lòng mở khoá dữ liệu trước.' };
    const profile = requestedProfileId && getProfileById(requestedProfileId);
    const view = requestedProfileId && browserViews[requestedProfileId];
    if (!profile || profile.platform !== 'zalo' || !view) return { ok: false, message: 'Hãy chọn một nick Zalo đang mở.' };
    try { if (new URL(view.webContents.getURL()).hostname !== 'chat.zalo.me') return { ok: false, message: 'Nick chưa đăng nhập chat.zalo.me.' }; }
    catch { return { ok: false, message: 'Không đọc được trang Zalo.' }; }
    const scanId = crypto.randomUUID();
    zaloUserScans.start({ scanId, profileId: profile.id });
    view.webContents.send('zalo-user-scan:start', { scanId, script: buildUserExtractorScript(scanId) });
    return { ok: true, scanId, profileId: profile.id };
  });
  ipcMain.on('zalo-user-scan:event', (event, payload = {}) => {
    let scan; try { scan = zaloUserScans.get(payload.scanId); } catch { return; }
    const view = browserViews[scan.profileId];
    if (!view || event.sender !== view.webContents || scan.status !== 'scanning') return;
    if (payload.type === 'batch') {
      zaloUserScans.acceptBatch(scan.scanId, payload.users);
      sendToRenderer('zalo-user-scan:update', { scanId: scan.scanId, status: 'scanning', processed: scan.users.size, total: payload.total || 0 });
    } else if (payload.type === 'complete') {
      zaloUserScans.complete(scan.scanId);
      sendToRenderer('zalo-user-scan:update', { scanId: scan.scanId, status: 'completed', processed: scan.users.size, total: scan.users.size });
    } else if (payload.type === 'error' || payload.type === 'incompatible') {
      zaloUserScans.fail(scan.scanId, payload.message);
      sendToRenderer('zalo-user-scan:update', { scanId: scan.scanId, status: 'incompatible', message: scan.error });
    }
  });
  ipcMain.handle('zalo-user-scan:list', async (event, scanId) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    let scan; try { scan = zaloUserScans.get(scanId); } catch (error) { return { ok: false, message: error.message }; }
    return { ok: true, profileId: scan.profileId, status: scan.status, users: Array.from(scan.users.values()), message: scan.error };
  });
  ipcMain.handle('zalo-compatibility:probe', async (event, requestedProfileId) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    const view = requestedProfileId && browserViews[requestedProfileId];
    if (!view || view.webContents.isDestroyed()) return { ok: false, message: 'Nick Zalo chưa mở.' };
    try {
      if (new URL(view.webContents.getURL()).hostname !== 'chat.zalo.me') return { ok: false, message: 'Nick chưa ở trang chat.zalo.me.' };
      const report = await view.webContents.executeJavaScript(buildCompatibilityProbeScript(), true);
      return { ok: true, profileId: requestedProfileId, appVersion: app.getVersion(), report };
    } catch (error) { return { ok: false, message: error.message || String(error) }; }
  });
  ipcMain.handle('zalo-compatibility:save', async (event, payload) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || !payload?.report) return { ok: false, message: 'Báo cáo không hợp lệ.' };
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Lưu báo cáo tương thích Zalo',
      defaultPath: `Nha-Yen-Zalo-compatibility-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const safePayload = { appVersion: String(payload.appVersion || app.getVersion()), profileId: String(payload.profileId || ''), report: payload.report };
    await fs.promises.writeFile(result.filePath, `${JSON.stringify(safePayload, null, 2)}\n`, 'utf8');
    return { ok: true, filePath: result.filePath };
  });
  ipcMain.handle('zalo-unfriend-recorder:start', async (event, requestedProfileId) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    const view = requestedProfileId && browserViews[requestedProfileId];
    if (!view || !(view.webContents.getURL() || '').includes('chat.zalo.me')) return { ok: false, message: 'Nick Zalo chưa sẵn sàng.' };
    const result = await view.webContents.executeJavaScript(`(() => {
      if (window.__NYUnfriendRecorder?.cleanup) window.__NYUnfriendRecorder.cleanup();
      const startedAt = Date.now(), steps = []; let inputTimer = null;
      const clean = (value, limit = 120) => String(value || '').normalize('NFC').replace(/[\\u0000-\\u001f\\u007f]/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, limit);
      const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
      const describe = (el, includeLabel = true) => { if (!el) return null; const attrs = {}; for (const name of ['role','aria-label','title','data-translate-title','placeholder','type']) { const value = clean(el.getAttribute?.(name)); if (value) attrs[name] = value; } const isInput = /^(input|textarea)$/i.test(el.tagName || ''); return { tag: String(el.tagName || '').toLowerCase(), ...(includeLabel && !isInput ? { label: clean(el.innerText || el.textContent) } : {}), attrs, classNames: Array.from(el.classList || []).filter((name) => /menu|popover|modal|profile|header|avatar|button|dialog|more|action|input/i.test(name)).slice(0, 8) }; };
      const snapshot = () => Array.from(document.querySelectorAll('.zl-modal,.popover-v3,[role="dialog"],[role="menu"],[class*="menu"],[class*="popover"],[class*="profile-card"],[class*="user-profile"]')).filter(visible).slice(0, 12).map((scope) => ({ scope: describe(scope, false), actions: Array.from(scope.querySelectorAll('button,[role="button"],li,[aria-label],[title],.zl-modal__footer__button,div')).filter((el) => visible(el) && (el.matches('button,[role="button"],li,[aria-label],[title],.zl-modal__footer__button') || (el.children.length === 0 && clean(el.innerText || el.textContent, 90).length > 0))).slice(0, 40).map((el) => describe(el, true)) }));
      const onClick = (event) => { let target = event.target?.closest?.('input,textarea,.icon__action__more,.zl-modal__footer__button,button,[role="button"],li,[aria-label],[title],img,[class*="avatar"]'); if (!target) { const menuScope = event.target?.closest?.('.popover-v3,[role="menu"],[class*="menu"],[class*="popover"]'); if (menuScope && clean(event.target?.innerText || event.target?.textContent, 90)) target = event.target; } if (!target) return; steps.push({ type: 'click', elapsedMs: Date.now() - startedAt, target: describe(target, true), ancestry: [target?.parentElement,target?.parentElement?.parentElement,target?.parentElement?.parentElement?.parentElement].map((el) => describe(el, false)).filter(Boolean) }); setTimeout(() => { const step = steps[steps.length - 1]; if (step) step.after = snapshot(); }, 350); };
      const onFocus = (event) => { const target = event.target; if (!target?.matches?.('input,textarea,[contenteditable="true"]')) return; steps.push({ type: 'focus', elapsedMs: Date.now() - startedAt, target: describe(target, false) }); };
      const onInput = (event) => { const target = event.target; if (!target?.matches?.('input,textarea,[contenteditable="true"]')) return; clearTimeout(inputTimer); inputTimer = setTimeout(() => { const value = target.value !== undefined ? target.value : target.textContent; steps.push({ type: 'input', elapsedMs: Date.now() - startedAt, target: describe(target, false), inputLength: String(value || '').length }); }, 180); };
      document.addEventListener('click', onClick, true);
      document.addEventListener('focusin', onFocus, true); document.addEventListener('input', onInput, true);
      window.__NYUnfriendRecorder = { startedAt, steps, cleanup: () => { clearTimeout(inputTimer); document.removeEventListener('click', onClick, true); document.removeEventListener('focusin', onFocus, true); document.removeEventListener('input', onInput, true); } };
      return { ok: true };
    })()`, true);
    return result || { ok: false, message: 'Không khởi động được bộ ghi.' };
  });
  ipcMain.handle('zalo-unfriend-recorder:stop', async (event, requestedProfileId) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    const view = requestedProfileId && browserViews[requestedProfileId];
    if (!view) return { ok: false, message: 'Nick Zalo không còn mở.' };
    const captured = await view.webContents.executeJavaScript(`(() => { const recorder = window.__NYUnfriendRecorder; if (!recorder) return null; recorder.cleanup(); delete window.__NYUnfriendRecorder; return { durationMs: Date.now() - recorder.startedAt, steps: recorder.steps }; })()`, true);
    if (!captured?.steps?.length) return { ok: false, message: 'Chưa ghi nhận được thao tác nào.' };
    const result = await dialog.showSaveDialog(mainWindow, { title: 'Lưu báo cáo thao tác hủy kết bạn', defaultPath: `Nha-Yen-Zalo-unfriend-actions-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const report = { appVersion: app.getVersion(), capturedAt: new Date().toISOString(), profileHash: crypto.createHash('sha256').update(String(requestedProfileId)).digest('hex').slice(0, 16), privacy: 'Không chứa cookie, token hoặc nội dung trò chuyện.', ...captured };
    await fs.promises.writeFile(result.filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return { ok: true, filePath: result.filePath, steps: captured.steps.length };
  });
  ipcMain.handle('zalo-unfriend-bridge:probe', async (event, requestedProfileId) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    const view = requestedProfileId && browserViews[requestedProfileId];
    if (!view || view.webContents.isDestroyed()) return { ok: false, message: 'Nick Zalo chưa mở.' };
    try {
      return await view.webContents.executeJavaScript(buildUnfriendBridgeProbeScript(), true);
    } catch (error) { return { ok: false, message: error.message || String(error) }; }
  });
  ipcMain.handle('zalo-user-action:unfriend', async (event, scanId, userId) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    let scan;
    try { scan = zaloUserScans.get(scanId); } catch { return { ok: false, message: 'Phiên quét người dùng không tồn tại.' }; }
    const user = scan.users.get(String(userId || ''));
    const view = browserViews[scan.profileId];
    if (!user || !view) return { ok: false, message: 'Người dùng hoặc nick Zalo không còn khả dụng.' };
    const usageKey = getDailyLeaveUsageKey(scan.profileId);
    const dailyUsage = settings.unfriendDailyUsage && typeof settings.unfriendDailyUsage === 'object' ? settings.unfriendDailyUsage : {};
    const usedToday = Math.max(0, Number(dailyUsage[usageKey]) || 0);
    if (usedToday >= 1_000) return { ok: false, message: 'Nick đã đạt giới hạn 1.000 lượt hủy kết bạn trong ngày.' };
    try {
      const result = await view.webContents.executeJavaScript(buildDirectUnfriendScript(user.userId), true);
      if (result?.ok) {
        settings.unfriendDailyUsage = { ...dailyUsage, [usageKey]: usedToday + 1 };
        saveSettings(settings);
        return { ...result, message: 'Zalo đã xác nhận hủy kết bạn.', remainingToday: 999 - usedToday };
      }
      return result || { ok: false, message: 'Zalo không phản hồi lệnh hủy kết bạn.' };
    } catch (error) { return { ok: false, message: error.message || String(error) }; }
  });

  ipcMain.handle('zalo-group-scan:cancel', async (event, scanId) => {
    let scan;
    try { scan = zaloGroupScans.get(scanId); } catch { return { ok: false, message: 'Phiên quét không tồn tại.' }; }
    if (!zaloGroupScans.cancel(scanId)) return { ok: false, message: 'Phiên quét đã kết thúc.' };
    browserViews[scan.profileId]?.webContents.send('zalo-group-scan:cancel', { scanId, script: buildCancelExtractorScript(scanId) });
    sendToRenderer('zalo-group-scan:update', { scanId, status: 'cancelled' });
    return { ok: true };
  });

  ipcMain.handle('zalo-group-scan:list', async (event, scanId) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    let scan;
    try { scan = zaloGroupScans.get(scanId); } catch { return { ok: false, message: 'Phiên quét không tồn tại.' }; }
    if (scan.status !== 'completed') return { ok: false, message: 'Danh sách chỉ khả dụng sau khi quét hoàn tất.' };
    return { ok: true, groups: Array.from(scan.groups.values()).map((group) => ({ ...group })) };
  });

  ipcMain.handle('zalo-group-action:leave', async (event, scanId, groupId) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    let scan;
    try { scan = zaloGroupScans.get(scanId); } catch { return { ok: false, message: 'Phiên quét không tồn tại.' }; }
    if (scan.status !== 'completed' || activeProfileId !== scan.profileId) {
      return { ok: false, message: 'Profile đã thay đổi hoặc phiên quét không còn hợp lệ.' };
    }
    const id = String(groupId || '');
    if (!scan.groups.has(id)) return { ok: false, message: 'Nhóm không thuộc danh sách đã quét.' };
    const usageKey = getDailyLeaveUsageKey(scan.profileId);
    const dailyUsage = settings.leaveDailyUsage && typeof settings.leaveDailyUsage === 'object' ? settings.leaveDailyUsage : {};
    const usedToday = Math.max(0, Number(dailyUsage[usageKey]) || 0);
    if (usedToday >= LEAVE_GROUP_POLICY.maxPerDay) {
      return { ok: false, message: `Profile đã đạt giới hạn ${LEAVE_GROUP_POLICY.maxPerDay} nhóm trong ngày.` };
    }
    const view = browserViews[scan.profileId];
    if (!view || view.webContents.isDestroyed()) return { ok: false, message: 'Tab Zalo của profile đã đóng.' };
    try {
      const result = await view.webContents.executeJavaScript(buildLeaveGroupScript(id));
      if (result?.ok) {
        scan.groups.delete(id);
        const dayPrefix = `${usageKey.split(':', 1)[0]}:`;
        settings.leaveDailyUsage = Object.fromEntries(
          Object.entries(dailyUsage).filter(([key]) => key.startsWith(dayPrefix)),
        );
        settings.leaveDailyUsage[usageKey] = usedToday + 1;
        saveSettings(settings);
      }
      return result || { ok: false, message: 'Zalo Web không trả về kết quả.' };
    } catch (error) {
      return { ok: false, message: error.message || String(error) };
    }
  });

  ipcMain.on('zalo-group-scan:event', (event, payload = {}) => {
    let scan;
    try { scan = zaloGroupScans.get(payload.scanId); } catch { return; }
    if (!isTrustedZaloScanEvent(event, scan) || !zaloGroupScans.isActive(scan)) return;
    try {
      if (payload.type === 'progress') {
        sendToRenderer('zalo-group-scan:update', { scanId: scan.scanId, status: scan.status, ...(payload.progress || {}) });
      } else if (payload.type === 'discovery-complete') {
        zaloGroupScans.finishDiscovery(scan.scanId, payload.summary || {});
        sendToRenderer('zalo-group-scan:update', { scanId: scan.scanId, status: 'fetching', totalUnique: scan.totalUnique, duplicateCount: scan.duplicateCount });
      } else if (payload.type === 'batch') {
        zaloGroupScans.acceptBatch(scan.scanId, Array.isArray(payload.dtos) ? payload.dtos : []);
        sendToRenderer('zalo-group-scan:update', { scanId: scan.scanId, status: scan.status, processed: scan.groups.size, failed: scan.failures.size });
      } else if (payload.type === 'failure') {
        zaloGroupScans.fail(scan.scanId, payload.failure || {});
        sendToRenderer('zalo-group-scan:update', { scanId: scan.scanId, status: 'failed', failed: scan.failures.size, failure: payload.failure || null });
      } else if (payload.type === 'complete') {
        if (scan.failures.size) {
          scan.status = 'failed';
          sendToRenderer('zalo-group-scan:update', { scanId: scan.scanId, status: 'failed', processed: scan.groups.size, failed: scan.failures.size });
        } else {
          zaloGroupScans.complete(scan.scanId);
          sendToRenderer('zalo-group-scan:update', { scanId: scan.scanId, status: 'completed', processed: scan.groups.size, failed: 0 });
        }
      } else if (payload.type === 'incompatible' || payload.type === 'error') {
        zaloGroupScans.markError(scan.scanId, payload.message);
        sendToRenderer('zalo-group-scan:update', { scanId: scan.scanId, status: 'incompatible', message: scan.error });
      }
    } catch (error) {
      zaloGroupScans.markError(scan.scanId, error.message);
      sendToRenderer('zalo-group-scan:update', { scanId: scan.scanId, status: 'incompatible', message: error.message });
    }
  });

  ipcMain.handle('zalo-group-scan:save', async (event, scanId, selectedIds = null) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    let scan;
    try { scan = zaloGroupScans.get(scanId); } catch { return { ok: false, message: 'Phiên quét không tồn tại.' }; }
    if (scan.status !== 'completed') return { ok: false, message: 'Chỉ lưu được khi quét hoàn tất và không còn lỗi.' };
      const requestedIds = Array.isArray(selectedIds) ? new Set(selectedIds.map(String)) : null;
      const groupsToSave = requestedIds
        ? Array.from(scan.groups.values()).filter((group) => requestedIds.has(group.groupId))
        : Array.from(scan.groups.values());
      if (!groupsToSave.length) return { ok: false, message: 'Hãy chọn ít nhất một nhóm để lưu.' };
      const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Lưu danh sách nhóm Zalo',
      defaultPath: `zalo-groups-${new Date().toISOString().slice(0, 10)}.txt`,
      filters: [{ name: 'Text file', extensions: ['txt'] }],
      properties: ['createDirectory'],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
        await saveTxtNoOverwrite(result.filePath, groupsToSave);
        return { ok: true, filePath: result.filePath, count: groupsToSave.length };
    } catch (error) {
      if (error.code === 'EEXIST') return { ok: false, message: 'File đã tồn tại. Hãy chọn một tên mới để tránh ghi đè.' };
      return { ok: false, message: `Không lưu được file: ${error.message}` };
    }
  });

  ipcMain.on('update-badge', (event, count) => { if (count !== unreadCount) { const hadNewMessages = count > unreadCount; unreadCount = count; updateBadge(unreadCount); if (hadNewMessages && !mainWindow.isFocused()) mainWindow.flashFrame(true); } });
  ipcMain.on('set-theme', (event, isDark) => { settings.isDarkMode = isDark; saveSettings(settings); nativeTheme.themeSource = isDark ? 'dark' : 'light'; });
  ipcMain.on('toggle-always-on-top', () => { settings.alwaysOnTop = !settings.alwaysOnTop; mainWindow.setAlwaysOnTop(settings.alwaysOnTop); saveSettings(settings); });
  ipcMain.on('toggle-fullscreen', () => { mainWindow.setFullScreen(!mainWindow.isFullScreen()); setTimeout(updateBrowserViewBounds, 100); });
  ipcMain.on('zoom-in', () => { const wc = activeProfileId && browserViews[activeProfileId]?.webContents; if (wc) wc.setZoomLevel(wc.getZoomLevel() + 0.5); });
  ipcMain.on('zoom-out', () => { const wc = activeProfileId && browserViews[activeProfileId]?.webContents; if (wc) wc.setZoomLevel(wc.getZoomLevel() - 0.5); });
  ipcMain.on('set-font-scale', (event, fontSize) => {
    const safeFontSize = Math.max(12, Math.min(24, Number(fontSize) || 16));
    const wc = activeProfileId && browserViews[activeProfileId]?.webContents;
    if (wc && !wc.isDestroyed()) wc.setZoomFactor(safeFontSize / 16);
  });
  ipcMain.on('reload-page', () => activeProfileId && browserViews[activeProfileId]?.webContents.reload());
  ipcMain.on('get-settings', (event) => {
    if (!storeUnlocked) {
      event.returnValue = { locked: true, isDarkMode: false, quickReplies: [], quicksandFontDataUrl: getQuicksandFontDataUrl() };
      return;
    }
    const ws = getWorkspaceState();
    event.returnValue = { isDarkMode: settings.isDarkMode, alwaysOnTop: settings.alwaysOnTop, blockSeen: settings.blockSeen, blockTyping: settings.blockTyping, zadarkShield: settings.zadarkShield, lockOnStartup: settings.lockOnStartup, hasLockPassword: !!settings.lockPasswordHash, quickReplies: ws.data.quickReplies || [], quicksandFontDataUrl: getQuicksandFontDataUrl() };
  });
  ipcMain.on('workspace-get-state', (event) => { event.returnValue = getWorkspaceState(); });
  ipcMain.on('workspace-save-data', (event, data) => {
    if (!storeUnlocked) return;
    const state = persistWorkspaceState(data || {});
    broadcastQuickReplies(state.data.quickReplies);
    event.returnValue = state;
  });
  ipcMain.on('workspace-create', (event, name) => {
    if (!storeUnlocked) return;
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
  ipcMain.handle('quick-reply:choose-image', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    const selected = await dialog.showOpenDialog(mainWindow, { title: 'Chọn ảnh cho tin nhắn nhanh', properties: ['openFile'], filters: [{ name: 'Ảnh', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] });
    if (selected.canceled || !selected.filePaths[0]) return { ok: false, canceled: true };
    const sourcePath = path.resolve(selected.filePaths[0]);
    if (!fs.existsSync(sourcePath)) return { ok: false, message: 'Ảnh đã chọn không còn tồn tại.' };
    return storeQuickReplyImageAsPng(sourcePath);
  });
  ipcMain.handle('quick-reply:normalize-images', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    return migrateQuickReplyImagesToPng();
  });
  ipcMain.handle('quick-reply:inspect-images', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    const replies = getWorkspaceState().data.quickReplies || [];
    const plan = planImageNormalization(replies, readImageSignature);
    return {
      ok: true,
      summary: summarizeNormalization(plan),
      missing: plan.missing.map((entry) => ({ id: entry.id, keyword: entry.keyword })),
      unsupported: plan.unsupported.map((entry) => ({ id: entry.id, keyword: entry.keyword, format: entry.format })),
      pending: plan.conversions.map((entry) => ({ id: entry.id, keyword: entry.keyword, format: entry.format })),
    };
  });
  ipcMain.handle('quick-reply:backup', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    return backupQuickReplyData('manual');
  });
  ipcMain.handle('quick-reply:export-csv', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    const replies = getWorkspaceState().data.quickReplies || [];
    const target = await dialog.showSaveDialog(mainWindow, {
      title: 'Xuất tin nhắn nhanh ra CSV',
      defaultPath: `tin-nhan-nhan-${backupStamp().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (target.canceled || !target.filePath) return { ok: false, canceled: true };
    const escapeCell = (value) => {
      const text = String(value || '').replace(/\r\n?/g, '\n');
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = ['keyword,message,image'];
    for (const reply of replies) {
      lines.push([
        escapeCell(reply.keyword),
        escapeCell(String(reply.message || '').replace(/\r\n?/g, '\n')),
        escapeCell(reply.imagePath ? path.basename(String(reply.imagePath)) : ''),
      ].join(','));
    }
    // BOM để Excel mở đúng tiếng Việt có dấu.
    await fs.promises.writeFile(target.filePath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8')]));
    return { ok: true, filePath: target.filePath, count: replies.length };
  });
  ipcMain.handle('quick-reply:import-csv', async (event, csvPath) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    const resolved = path.resolve(String(csvPath || ''));
    if (!resolved.toLowerCase().endsWith('.csv') || !fs.existsSync(resolved)) return { ok: false, message: 'File CSV không tồn tại.' };
    let text = await fs.promises.readFile(resolved, 'utf8');
    text = text.replace(/^﻿/, '');
    const rows = parseCsvRows(text);
    if (!rows.length) return { ok: false, message: 'File CSV rỗng hoặc không đọc được.' };
    const header = rows[0].map((cell) => String(cell).trim().toLowerCase());
    const keywordColumn = header.findIndex((cell) => ['keyword', 'tu khoa', 'từ khóa', 'ky tu tat', 'ký tự tắt'].includes(cell));
    const messageColumn = header.findIndex((cell) => ['message', 'noi dung', 'nội dung', 'content'].includes(cell));
    const imageColumn = header.findIndex((cell) => ['image', 'anh', 'ảnh', 'image', 'hinh'].includes(cell));
    const hasHeader = keywordColumn >= 0 || messageColumn >= 0;
    const body = hasHeader ? rows.slice(1) : rows;
    const keywordAt = hasHeader ? keywordColumn : 0;
    const messageAt = hasHeader ? messageColumn : 1;
    const imageAt = hasHeader ? imageColumn : 2;

    const state = getWorkspaceState();
    const replies = Array.isArray(state.data.quickReplies) ? state.data.quickReplies : [];
    const imageDir = QUICK_REPLY_IMAGE_DIR;
    const imageIndex = new Map();
    try {
      for (const fileName of await fs.promises.readdir(imageDir)) imageIndex.set(fileName.toLowerCase(), path.join(imageDir, fileName));
      for (const dirName of await fs.promises.readdir(imageDir, { withFileTypes: true })) {
        if (!dirName.isDirectory()) continue;
        const sub = path.join(imageDir, dirName.name);
        for (const fileName of await fs.promises.readdir(sub)) imageIndex.set(fileName.toLowerCase(), path.join(sub, fileName));
      }
    } catch { }

    const takenKeywords = new Set(replies.map((reply) => normalizeKeywordForImport(reply.keyword)));
    let added = 0;
    let reused = 0;
    let skipped = 0;
    const missingImages = [];
    for (const row of body) {
      const keyword = normalizeKeywordForImport(row[keywordAt] || '');
      const message = String(row[messageAt] || '').trim();
      if (!keyword || !message) { skipped += 1; continue; }
      if (takenKeywords.has(keyword)) { skipped += 1; continue; }
      const wanted = String(row[imageAt] || '').trim();
      let imagePath = '';
      if (wanted) {
        const match = imageIndex.get(path.basename(wanted).toLowerCase());
        if (match) {
          imagePath = match;
          reused += 1;
        } else {
          missingImages.push({ keyword, fileName: path.basename(wanted) });
        }
      }
      replies.push({ id: `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`, keyword, message, imagePath });
      takenKeywords.add(keyword);
      added += 1;
    }
    state.data.quickReplies = replies;
    persistWorkspaceState(state.data);
    broadcastQuickReplies(replies);
    const plan = planImageNormalization(replies, readImageSignature);
    return {
      ok: true,
      added,
      reused,
      skipped,
      total: replies.length,
      missingImages,
      pendingNormalize: plan.conversions.length,
      missingImageFiles: plan.missing.length,
    };
  });
  ipcMain.handle('quick-reply:sync-crm', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    try { return { ok: true, ...(await syncQuickRepliesFromCrm()) }; }
    catch (error) { return { ok: false, message: error.message || String(error) }; }
  });

  // Nút "Chèn": bảo đảm tiện ích đã bắt tay với tab Zalo rồi mới điền mẫu, không gửi tin.
  // Chữ được dán bằng webContents.insertText (giống panel Báo giá) cho chắc chắn,
  // vì execCommand('insertText') trên ô soạn contenteditable của Zalo hay thất bại.
  ipcMain.handle('quick-reply:test-template', async (event, replyId) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    const view = activeProfileId && browserViews[activeProfileId];
    if (!view) return { ok: false, message: 'Hãy chọn một tài khoản Zalo trước.' };
    if (!(view.webContents.getURL() || '').includes('zalo.me')) return { ok: false, message: 'Tab hiện tại không phải Zalo.' };
    const reply = (getWorkspaceState().data.quickReplies || []).find((entry) => String(entry.id || '') === String(replyId || ''));
    if (!reply) return { ok: false, message: 'Không tìm thấy mẫu tin nhắn.' };
    try {
      const ready = await ensureQuickReplyReady(view);
      if (!ready) return { ok: false, message: 'Không thể nạp tiện ích Tin nhắn nhanh vào tab Zalo. Hãy tải lại tab rồi thử lại.' };
      const payload = JSON.stringify({ id: String(reply.id || ''), keyword: String(reply.keyword || ''), message: String(reply.message || ''), imagePath: String(reply.imagePath || '') });
      const result = await view.webContents.executeJavaScript(
        `(window.__DepLaoRunQuickReply ? window.__DepLaoRunQuickReply(${payload}) : Promise.resolve({ ok: false, message: 'Tab Zalo chưa nạp xong tiện ích tin nhắn nhanh.' }))`,
        true,
      );
      if (!result?.ok) return result || { ok: false, message: 'Không nhận được phản hồi từ tab Zalo.' };
      if (result.doneByMain) {
        view.webContents.focus();
        view.webContents.insertText(String(result.finalMessage || ''));
        const keyword = String(result.keyword || '');
        await view.webContents.executeJavaScript(
          `(window.__DepLaoFinalizeQuickReply ? window.__DepLaoFinalizeQuickReply(${JSON.stringify(result)}) : null)`,
        ).catch(() => {});
        return { ok: true, message: `Đã điền mẫu \\${keyword}. Nhấn Enter trong Zalo để gửi.` };
      }
      view.webContents.focus();
      return result;
    } catch (err) {
      return { ok: false, message: `Không chạy được mẫu: ${err.message || err}` };
    }
  });
  ipcMain.handle('quick-reply:paste-image', async (event, imagePath) => {
    const view = Object.values(browserViews).find((entry) => entry?.webContents === event.sender);
    if (!view) return { ok: false, message: 'Tab Zalo không hợp lệ.' };
    const allowedPaths = new Set((getWorkspaceState().data.quickReplies || []).map((reply) => path.resolve(String(reply.imagePath || ''))).filter(Boolean));
    const resolvedPath = path.resolve(String(imagePath || ''));
    if (!allowedPaths.has(resolvedPath)) return { ok: false, message: 'Ảnh mẫu không thuộc danh sách tin nhắn nhanh.' };
    if (!fs.existsSync(resolvedPath)) return { ok: false, message: `Ảnh mẫu không còn tồn tại: ${path.basename(resolvedPath)}` };
    let buffer;
    try {
      buffer = await fs.promises.readFile(resolvedPath);
    } catch (err) {
      return { ok: false, message: `Không đọc được ảnh mẫu: ${err.message || err}` };
    }
    const format = sniffImageFormat(buffer);
    if (!isSupportedSourceFormat(format)) {
      return { ok: false, message: `Ảnh mẫu có định dạng không hỗ trợ (${format || 'không nhận dạng được'}). Hãy chọn lại ảnh cho mẫu này.` };
    }
    let image = nativeImage.createFromBuffer(buffer);
    // nativeImage không giải mã được WebP/GIF: nhờ Chromium chuyển sang PNG thật rồi mới dán.
    if (image.isEmpty()) {
      try {
        const png = await transcodeBufferToPng(BrowserWindow, buffer);
        image = nativeImage.createFromBuffer(png.buffer);
      } catch (err) {
        return { ok: false, message: `Không giải mã được ảnh mẫu (${format}): ${err.message || err}` };
      }
    }
    if (image.isEmpty()) return { ok: false, message: 'Ảnh mẫu bị lỗi, không dán được vào Zalo.' };
    clipboard.writeImage(image);
    event.sender.focus();
    event.sender.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
    event.sender.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
    return { ok: true, format };
  });
  ipcMain.handle('active-chat:choose-video', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    if (!storeUnlocked) return { ok: false, locked: true, message: 'Vui lòng mở khoá dữ liệu trước.' };
    const view = activeProfileId && browserViews[activeProfileId];
    if (!view) return { ok: false, message: 'Hãy chọn một tài khoản Zalo trước.' };
    if (!(view.webContents.getURL() || '').includes('zalo.me')) return { ok: false, message: 'Tab hiện tại không phải Zalo.' };

    const selected = await dialog.showOpenDialog(mainWindow, {
      title: 'Chọn video để đính vào hội thoại',
      properties: ['openFile'],
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'] }],
    });
    if (selected.canceled || !selected.filePaths[0]) return { ok: false, canceled: true };
    const videoPath = path.resolve(selected.filePaths[0]);
    if (!isSupportedVideoPath(videoPath)) return { ok: false, message: 'Định dạng video không được hỗ trợ.' };
    if (!fs.existsSync(videoPath)) return { ok: false, message: 'Video đã chọn không còn tồn tại.' };

    const staged = await stageVideoWithDebugger(view.webContents.debugger, videoPath, view.webContents);
    if (!staged.ok) return staged;
    view.webContents.focus();
    return { ok: true, message: 'Đã đưa video vào hội thoại. Video chưa được gửi; nhấn Enter khi anh muốn gửi.' };
  });
  ipcMain.handle('video-library:list', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    const layout = ensureMediaStore(currentMediaRoot());
    return { ok: true, directory: layout.videosDir, mediaRoot: layout.root, items: readVideoLibrary().map(publicVideoItem) };
  });
  ipcMain.handle('video-library:add', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    const selected = await dialog.showOpenDialog(mainWindow, { title: 'Thêm video vào thư viện Nhà Yến Zalo', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'] }] });
    if (selected.canceled) return { ok: false, canceled: true };
    const layout = ensureMediaStore(currentMediaRoot());
    const rows = readVideoLibrary(); const added = []; const rejected = []; const duplicates = [];
    for (const sourcePath of selected.filePaths) {
      try {
        const plan = planVideoAddition(sourcePath, rows, { maxBytes: MAX_LIBRARY_VIDEO_BYTES });
        if (!plan.ok) { rejected.push({ name: plan.name, message: plan.message }); continue; }

        // Cung noi dung thi khong luu thanh hai ban.
        const hash = hashVideoFile(sourcePath);
        const existing = findDuplicateByHash(rows, hash);
        if (existing) { duplicates.push({ name: plan.name, existingName: existing.name }); continue; }

        const fileName = uniqueVideoFileName(layout.videosDir, path.basename(sourcePath));
        fs.copyFileSync(sourcePath, path.join(layout.videosDir, fileName));
        const item = {
          id: crypto.randomUUID(),
          name: path.basename(sourcePath, path.extname(sourcePath)),
          fileName,
          size: plan.size,
          hash,
          createdAt: Date.now(),
          duration: 0,
        };

        // Anh nen that (PNG) + thoi luong. That bai thi van giu video, chi la khong co anh nen.
        try {
          const thumbName = thumbnailFileName(item.id);
          const thumb = await generateVideoThumbnail(
            BrowserWindow,
            path.join(layout.videosDir, fileName),
            path.join(layout.thumbnailsDir, thumbName),
          );
          if (thumb.ok) {
            item.thumbnail = thumbName;
            item.duration = thumb.duration;
            item.width = thumb.width;
            item.height = thumb.height;
          } else {
            item.thumbnailError = thumb.message || 'Không tạo được ảnh nền.';
          }
        } catch (thumbError) {
          item.thumbnailError = thumbError && thumbError.message ? thumbError.message : String(thumbError);
        }

        rows.push(item); added.push(publicVideoItem(item));
      } catch (error) { rejected.push({ name: path.basename(sourcePath), message: error.message || String(error) }); }
    }
    writeVideoLibrary(rows);
    return { ok: true, added, rejected, duplicates, items: rows.map(publicVideoItem) };
  });
  ipcMain.handle('video-library:remove', async (event, id) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    const rows = readVideoLibrary(); const item = rows.find((entry) => entry.id === String(id));
    if (!item) return { ok: false, message: 'Video không còn trong thư viện.' };
    const layout = ensureMediaStore(currentMediaRoot());
    try {
      moveVideoToTrash(layout, item.fileName);
      const thumbPath = path.join(layout.thumbnailsDir, item.thumbnail || thumbnailFileName(item.id));
      if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
    } catch (error) {
      if (error.code !== 'ENOENT') return { ok: false, message: error.message || String(error) };
    }
    const next = rows.filter((entry) => entry.id !== item.id); writeVideoLibrary(next);
    return { ok: true, items: next.map(publicVideoItem) };
  });
  ipcMain.handle('video-library:rename', async (event, payload = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    const id = String(payload.id || '');
    const name = String(payload.name || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim().slice(0, 100);
    if (!name) return { ok: false, message: 'Tên video không được để trống.' };
    const rows = readVideoLibrary(); const item = rows.find((entry) => entry.id === id);
    if (!item) return { ok: false, message: 'Video không còn trong thư viện.' };
    item.name = name; writeVideoLibrary(rows);
    return { ok: true, items: rows.map(publicVideoItem) };
  });
  ipcMain.handle('video-library:preview', async (event, id) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    const item = readVideoLibrary().find((entry) => entry.id === String(id));
    if (!item) return { ok: false, message: 'Video không còn trong thư viện.' };
    const previewPath = videoFilePath(item.fileName);
    if (!fs.existsSync(previewPath)) return { ok: false, message: 'Video không còn tồn tại.' };
    const error = await shell.openPath(previewPath);
    return error ? { ok: false, message: error } : { ok: true };
  });
  ipcMain.handle('video-library:open-folder', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false };
    const layout = ensureMediaStore(currentMediaRoot());
    const error = await shell.openPath(layout.videosDir);
    return error ? { ok: false, message: error } : { ok: true };
  });
  // Doi cho kho media sang o dia khac. Copy sang roi moi tro settings, khong xoa ban cu
  // de neu copy loi thi du lieu van con nguyen.
  ipcMain.handle('video-library:set-root', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Chọn thư mục lưu video Nhà Yến Zalo',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
    const nextRoot = path.join(picked.filePaths[0], 'Nha Yen Zalo media');
    const previous = currentMediaLayout();
    try {
      const target = ensureMediaStore(nextRoot);
      // Chuyen video + anh nen + danh sach sang cho moi.
      for (const [fromDir, toDir] of [[previous.videosDir, target.videosDir], [previous.thumbnailsDir, target.thumbnailsDir]]) {
        if (!fs.existsSync(fromDir)) continue;
        for (const name of fs.readdirSync(fromDir)) {
          const from = path.join(fromDir, name);
          if (!fs.statSync(from).isFile()) continue;
          fs.copyFileSync(from, path.join(toDir, name));
        }
      }
      if (fs.existsSync(previous.libraryPath)) fs.copyFileSync(previous.libraryPath, target.libraryPath);
      settings.mediaRoot = nextRoot;
      saveSettings(settings);
      const layout = currentMediaLayout();
      return { ok: true, mediaRoot: layout.root, directory: layout.videosDir, items: readVideoLibrary().map(publicVideoItem) };
    } catch (error) {
      return { ok: false, message: error && error.message ? error.message : String(error) };
    }
  });
  ipcMain.handle('video-library:stage', async (event, id) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    const item = readVideoLibrary().find((entry) => entry.id === String(id));
    if (!item) return { ok: false, message: 'Video không còn trong thư viện.' };
    const view = activeProfileId && browserViews[activeProfileId];
    if (!view || !(view.webContents.getURL() || '').includes('zalo.me')) return { ok: false, message: 'Hãy chọn nick và mở một hội thoại Zalo trước.' };
    const videoPath = videoFilePath(item.fileName);
    if (!fs.existsSync(videoPath)) return { ok: false, message: 'Video không còn tồn tại.' };
    const pasted = await focusZaloComposerAndPasteFile(view, videoPath);
    if (!pasted.ok) return pasted;
    return { ok: true, message: `Đã dán “${item.name}” vào hội thoại. Video chưa được gửi; hãy kiểm tra bản xem trước rồi nhấn Enter.` };
  });
  ipcMain.handle('active-chat-insert-text', async (event, message = '', options = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, message: 'Nguồn yêu cầu không hợp lệ.' };
    if (!storeUnlocked) return { ok: false, locked: true, message: 'Vui lòng mở khoá dữ liệu trước.' };
    const requestedProfileId = options.profileId || activeProfileId;
    const view = requestedProfileId && browserViews[requestedProfileId];
    if (!view || !String(message).trim()) return { ok: false, message: 'Chưa có tab Zalo active hoặc nội dung trống.' };
    try {
      if (!(view.webContents.getURL() || '').includes('zalo.me')) return { ok: false, message: 'Tab hiện tại không phải Zalo.' };
      const focusResult = await view.webContents.executeJavaScript(`
        (function() {
          var selectors = ['#richInput', '.chat-input [contenteditable="true"]', '[contenteditable="true"]'];
          for (var i = 0; i < selectors.length; i++) {
            var input = document.querySelector(selectors[i]);
            if (!input) continue;
            var rect = input.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            input.focus();
            return { ok: true };
          }
          return { ok: false, message: 'Không tìm thấy ô soạn tin Zalo.' };
        })();
      `);
      if (!focusResult?.ok) return focusResult;
      view.webContents.focus();
      view.webContents.insertText(String(message));
      return { ok: true, message: 'Đã chèn báo giá. Nội dung chưa được gửi.' };
    } catch (error) { return { ok: false, message: error.message || String(error) }; }
  });
  ipcMain.handle('active-chat-send-text', async (event, message = '', options = {}) => {
    if (!storeUnlocked) return { ok: false, locked: true, message: 'Vui lòng mở khoá dữ liệu trước.' };
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
              '.chat-input [contenteditable="true"]',
              '[contenteditable="true"]'
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

      if (view.webContents.focus) view.webContents.focus();
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
    const isManagedBulkSend = !!(options.scanId || options.userScanId);
    const messageUsageKey = getDailyLeaveUsageKey(requestedProfileId);
    const messageDailyUsage = settings.messageDailyUsage && typeof settings.messageDailyUsage === 'object' ? settings.messageDailyUsage : {};
    const messagesUsedToday = Math.max(0, Number(messageDailyUsage[messageUsageKey]) || 0);
    if (isManagedBulkSend && options.consentConfirmed !== true) return { ok: false, message: 'Cần xác nhận danh sách đã đồng ý nhận tin.' };
    if (isManagedBulkSend && messagesUsedToday >= 200) return { ok: false, message: 'Nick đã đạt giới hạn 200 tin nhắn hàng loạt trong ngày.' };
    if (options.scanId) {
      let scan;
      try { scan = zaloGroupScans.get(options.scanId); } catch { return { ok: false, message: 'Phiên quét không tồn tại.' }; }
      const scannedGroup = scan.groups.get(String(options.groupId || ''));
      if (scan.status !== 'completed' || scan.profileId !== requestedProfileId) {
        return { ok: false, message: 'Profile đã thay đổi hoặc phiên quét không còn hợp lệ.' };
      }
      if (!scannedGroup || scannedGroup.name !== String(chatName)) return { ok: false, message: 'Nhóm không thuộc danh sách đã quét.' };
    } else if (options.userScanId) {
      let scan;
      try { scan = zaloUserScans.get(options.userScanId); } catch { return { ok: false, message: 'Phiên quét người dùng không tồn tại.' }; }
      const scannedUser = scan.users.get(String(options.userId || ''));
      if (!['scanning', 'completed'].includes(scan.status) || scan.profileId !== requestedProfileId) return { ok: false, message: 'Nick gửi không khớp phiên quét người dùng.' };
      if (!scannedUser || scannedUser.name !== String(chatName)) return { ok: false, message: 'Người nhận không thuộc danh sách đã quét.' };
    }
    try {
      const safeName = JSON.stringify(String(chatName || ''));
      const targetNames = Array.from(new Set([chatName, ...(Array.isArray(options.targetNames) ? options.targetNames : [])].map((value) => String(value || '').trim()).filter(Boolean))).slice(0, 5);
      const safeTargetNames = JSON.stringify(targetNames);
      const safeSearchName = JSON.stringify(String(options.searchName || chatName || ''));
      const safeTargetId = JSON.stringify(String(options.groupId || options.userId || ''));
      const safeMessage = JSON.stringify(String(message));
      const requireExactName = options.requireExactName === true;
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
          var wantedNames = ${safeTargetNames}.map(normalizeText).filter(Boolean);
          var wantedName = wantedNames[0] || normalizeText(${safeName});
          var wantedId = String(${safeTargetId});
          var items = Array.from(document.querySelectorAll('.msg-item, [data-id], .group-board-item'));
          var idMatch = null;
          var exactMatch = null;
          var fuzzyMatch = null;
          for (var i = 0; i < items.length; i++) {
            var item = items[i];
            var nameEl = item.querySelector('.conv-item-title__name, .item-title__name, .item-title, .truncate');
            var itemName = getVisibleText(nameEl);
            var itemText = getVisibleText(item);
            var identifiers = [item.id, item.getAttribute('data-id'), item.getAttribute('data-uid'), item.getAttribute('data-user-id'), item.getAttribute('data-group-id'), item.dataset && item.dataset.id, item.dataset && item.dataset.uid].filter(Boolean).map(String);
            if (!idMatch && wantedId && identifiers.includes(wantedId)) idMatch = item;
            if (!itemName && !itemText) continue;
            if (!exactMatch && wantedNames.includes(itemName)) exactMatch = item;
            if (!fuzzyMatch && itemName && wantedNames.some(function(name) { return itemText.includes(name) || name.includes(itemName); })) fuzzyMatch = item;
          }
          var targetEl = idMatch || exactMatch || fuzzyMatch;
          if (targetEl) {
            clickElement(targetEl);
            return { found: true, foundBy: idMatch === targetEl ? 'id' : (exactMatch === targetEl ? 'exact' : 'fuzzy'), matched: getVisibleText(targetEl) };
          }
          return { found: false };
        })();
      `);
      const selectedById = result?.foundBy === 'id';
      let searchClick = null;

      if (!result || (!result.found && result.ok === false)) {
        return result || { ok: false, message: 'Failed to switch chat.' };
      }

      if (result && !result.found) {
        // Fallback to Search
        // Fallback to Search
        const searchBoxReady = await view.webContents.executeJavaScript(`
          (async function() {
            var input = document.querySelector('#contact-search-input');
            if (input) {
              input.focus();
              var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              var wantedId = String(${safeTargetId});
              nativeInputValueSetter.call(input, wantedId || ${safeSearchName});
              input.dispatchEvent(new Event('input', { bubbles: true }));
              if (wantedId) {
                await new Promise(function(resolve) { setTimeout(resolve, 900); });
                var rows = Array.from(document.querySelectorAll('.global-search-result .msg-item, #contact-search-result .msg-item, .search-res-item, .msg-item'));
                var idFound = rows.some(function(item) {
                  return [item.id, item.getAttribute('data-id'), item.getAttribute('data-uid'), item.getAttribute('data-user-id'), item.getAttribute('data-group-id')].filter(Boolean).map(String).includes(wantedId);
                });
                if (!idFound) {
                  nativeInputValueSetter.call(input, ${safeSearchName});
                  input.dispatchEvent(new Event('input', { bubbles: true }));
                }
              }
              return true;
            }
            return false;
          })();
        `);
        if (!searchBoxReady) return { ok: false, message: 'Không tìm thấy ô tìm kiếm trên Zalo.' };

        for (let s = 0; s < 3; s++) {
          await new Promise(r => setTimeout(r, 1000));
          searchClick = await view.webContents.executeJavaScript(`
            (function() {
              function normalizeText(value) {
                return String(value || '').normalize('NFC').replace(/[\\u200B-\\u200D\\uFEFF]/g, '').replace(/\\s+/g, ' ').trim();
              }
              var wantedNames = ${safeTargetNames}.map(normalizeText).filter(Boolean);
              var wantedName = wantedNames[0] || normalizeText(${safeName});
              var wantedId = String(${safeTargetId});
              var items = Array.from(document.querySelectorAll('.global-search-result .msg-item, #contact-search-result .msg-item, .ReactVirtualized__Grid .msg-item, [id*="search"] .msg-item, .search-res-item'));
              if (!items.length) items = Array.from(document.querySelectorAll('.msg-item'));
              var idMatch = null, exactMatch = null, fuzzyMatch = null;
              for (var i = 0; i < items.length; i++) {
                var item = items[i];
                var nameEl = item.querySelector('.conv-item-title__name, .item-title__name, .item-title, .truncate') || item;
                var itemName = normalizeText((nameEl && (nameEl.innerText || nameEl.textContent)) || '');
                var identifiers = [item.id, item.getAttribute('data-id'), item.getAttribute('data-uid'), item.getAttribute('data-user-id'), item.getAttribute('data-group-id'), item.dataset && item.dataset.id, item.dataset && item.dataset.uid].filter(Boolean).map(String);
                if (!idMatch && wantedId && identifiers.includes(wantedId)) idMatch = item;
                if (wantedNames.includes(itemName)) exactMatch = item;
                if (!fuzzyMatch && itemName && wantedNames.some(function(name) { return itemName.includes(name) || name.includes(itemName); })) fuzzyMatch = item;
              }
               var target = idMatch || exactMatch || (${requireExactName ? 'false' : 'true'} ? fuzzyMatch : null);
              if (target) {
                if (target.scrollIntoView) target.scrollIntoView({ block: 'center' });
                var rect = target.getBoundingClientRect();
                var x = rect.left + rect.width / 2;
                var y = rect.top + rect.height / 2;
                var opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
                target.dispatchEvent(new MouseEvent('mousedown', opts));
                target.dispatchEvent(new MouseEvent('mouseup', opts));
                target.click();
                return { clicked: true, foundBy: idMatch === target ? 'id' : (exactMatch === target ? 'exact' : 'fuzzy') };
              }
              return { clicked: false };
            })();
          `);
          if (searchClick && searchClick.clicked) break;
        }
        if (!searchClick || !searchClick.clicked) return { ok: false, message: 'Không tìm thấy kết quả tìm kiếm cho: ' + String(chatName) };
      }

      const trustedSelection = selectedById || result?.foundBy === 'exact' || searchClick?.foundBy === 'id' || searchClick?.foundBy === 'exact';

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
                '[data-id="div_Main_ChatInput"] [contenteditable="true"]',
                '.chat-input [contenteditable="true"]',
                '[contenteditable="true"][role="textbox"]'
              ];
              for (var i = 0; i < selectors.length; i++) {
                var found = document.querySelector(selectors[i]);
                if (found) return found;
              }
              return null;
            }
            
            var wantedNames = ${safeTargetNames}.map(normalizeText).filter(Boolean);
            var wantedName = wantedNames[0] || normalizeText(${safeName});
            var strictMatch = ${requireExactName};
            function isMatch(txt) {
              if (!txt || !wantedName) return false;
              return wantedNames.some(function(name) { return strictMatch ? txt === name : (txt === name || txt.includes(name) || (name.includes(txt) && txt.length > 3)); });
            }

            var headerText = '';
            var input = findInput();
            
            var headerPaths = [];
            if (input) {
              var headerSelectors = [
                '.chat-info__header .title',
                '.chat-info__header .truncate',
                '.chat-info__header',
                '#chatView .title-name',
                '#chatView .header-title',
                'header .title',
                '[data-id="div_Main_Header"] .title'
              ];
              
              var foundMatch = false;
              for (var s = 0; s < headerSelectors.length; s++) {
                var els = Array.from(document.querySelectorAll(headerSelectors[s]));
                for (var i = 0; i < els.length; i++) {
                  var txt = normalizeText(els[i].innerText || els[i].textContent);
                  if (txt && isMatch(txt)) {
                     headerText = txt;
                     foundMatch = true;
                     break;
                  }
                }
                if (foundMatch) break;
              }

              // Fallback to document title
              if (!headerText && document.title && isMatch(normalizeText(document.title))) {
                 headerText = wantedName;
              }
            }

            return { 
              ok: !!input, 
              headerText: headerText, 
              matched: ${trustedSelection ? 'true' : (requireExactName ? 'foundMatch' : '!!input')},
              debugHeader: headerText ? 'MATCHED HEADER' : 'NO HEADER MATCH (BYPASSED)',
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

      if (view.webContents.focus) view.webContents.focus();
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
          function findInput() {
            var selectors = ['#richInput', '#chatInput', '[id*="input_line_"]', '.chat-input [contenteditable="true"]', '[contenteditable="true"][role="textbox"]', '[role="textbox"]', 'textarea'];
            for (var i = 0; i < selectors.length; i++) {
              var input = Array.from(document.querySelectorAll(selectors[i])).find(isVisible);
              if (input) return input;
            }
            return null;
          }
          function findSendButton(input) {
            var selectors = ['[data-translate-title="STR_SEND"]', 'button[class*="send"]', '.chat-input__send-btn', '[aria-label="Gửi"]', '[aria-label="Send"]'];
            var scope = input && input.closest('.chat-input, [class*="chat-input"], [data-id="div_Main_ChatInput"], footer');
            if (!scope && input) scope = input.parentElement;
            if (!scope) return null;
            for (var i = 0; i < selectors.length; i++) {
              var btn = Array.from(scope.querySelectorAll(selectors[i])).find(isVisible);
              if (btn) return btn;
            }
            return null;
          }
          var input = findInput();
          var btn = findSendButton(input);
          if (btn) { btn.click(); return { ok: true }; }
          return { ok: false };
        })();
      `);
      if (!sendResult || !sendResult.ok) {
        view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        view.webContents.sendInputEvent({ type: 'char', keyCode: 'Enter' });
        view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      }
      let sendConfirmed = false;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
        sendConfirmed = await view.webContents.executeJavaScript(`
          (function() {
            function isVisible(el) {
              if (!el) return false;
              var rect = el.getBoundingClientRect && el.getBoundingClientRect();
              var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
              return !!rect && rect.width > 0 && rect.height > 0 && (!style || (style.visibility !== 'hidden' && style.display !== 'none'));
            }
            var selectors = ['#richInput', '#chatInput', '[id*="input_line_"]', '.chat-input [contenteditable="true"]', '[contenteditable="true"][role="textbox"]', '[role="textbox"]', 'textarea'];
            for (var i = 0; i < selectors.length; i++) {
              var input = Array.from(document.querySelectorAll(selectors[i])).find(isVisible);
              if (!input) continue;
              var value = input.isContentEditable ? input.textContent : input.value;
              return String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim() === '';
            }
            return false;
          })();
        `);
        if (sendConfirmed) break;
      }
      if (!sendConfirmed) return { ok: false, message: 'Tin nhắn chưa được Zalo xác nhận gửi.' };
      if (isManagedBulkSend) {
        settings.messageDailyUsage = { ...messageDailyUsage, [messageUsageKey]: messagesUsedToday + 1 };
        saveSettings(settings);
      }
      return { ok: true, message: 'Zalo đã nhận lệnh gửi và làm trống ô soạn.', remainingToday: isManagedBulkSend ? 199 - messagesUsedToday : undefined };
    } catch (err) { return { ok: false, message: err.message || String(err) }; }
  });
  ipcMain.on('renderer-ready', () => {
    const lockInfo = {
      locked: settings.lockOnStartup || appLocked,
      hasPassword: !!settings.lockPasswordHash,
      zadarkShield: settings.zadarkShield,
    };
    sendToRenderer('lock-state', lockInfo);
    // Overlay bắt buộc khi dữ liệu đã mã hoá mà chưa mở khoá (kể cả chưa có legacy lock).
    if (needsMasterPasswordOverlay()) {
      sendToRenderer('need-master-password', { hasLegacyLock: !!settings.lockPasswordHash });
    }
  });
  ipcMain.on('check-for-updates', () => checkForUpdates(true));
  ipcMain.on('download-update', () => autoUpdater.downloadUpdate().catch(err => setUpdateState({ status: 'error', message: (err.message || err.toString()).split('\n')[0] })));
  ipcMain.on('install-update', () => { isQuitting = true; autoUpdater.quitAndInstall(); });
  ipcMain.on('get-update-state', () => sendToRenderer('update-state', updateState));
  ipcMain.on('update-notice:ready', (event) => event.sender.send('update-notice-state', updateState));
  ipcMain.on('update-notice:defer', () => updateNoticeWindow?.close());
  ipcMain.on('update-notice:download', () => autoUpdater.downloadUpdate().catch(err => setUpdateState({ status: 'error', message: (err.message || err.toString()).split('\n')[0] })));
  ipcMain.on('update-notice:install', () => { isQuitting = true; autoUpdater.quitAndInstall(); });
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

  // ---- Mã hoá at-rest: luồng master password ----
  // Renderer gọi khi người dùng nhập/tạo master password ở overlay.
  ipcMain.handle('secure:unlock', (event, payload) => {
    const password = typeof payload === 'string' ? payload : (payload && payload.password);
    const remember = !!(payload && payload.remember);
    const result = applyUnlock(password, remember);
    if (result.ok) {
      revealBrowserViewIfUnlocked();
      sendToRenderer('store-unlocked', {});
    }
    return result;
  });
  // Ghi nhớ / bỏ ghi nhớ máy này (DPAPI) — chỉ hợp lệ khi đã mở khoá.
  ipcMain.handle('secure:remember', (event, password) => {
    if (!storeUnlocked) return { ok: false, message: 'Chưa mở khoá dữ liệu.' };
    const ok = rememberMasterPassword(typeof password === 'string' ? password : '');
    return { ok };
  });
  ipcMain.handle('secure:forget', () => {
    forgetMasterPassword();
    return { ok: true };
  });
  // Trạng thái mở khoá cho renderer khởi tạo overlay.
  ipcMain.handle('secure:status', () => ({
    unlocked: storeUnlocked,
    needsPassword: needsMasterPasswordOverlay(),
    hasLegacyLock: !!settings.lockPasswordHash,
    remembered: fs.existsSync(SECURE_KEY_PATH),
  }));
}

function lockApp() { appLocked = true; if (mainWindow) mainWindow.setBrowserView(null); sendToRenderer('lock-state', { locked: true, hasPassword: !!settings.lockPasswordHash, zadarkShield: settings.zadarkShield }); }
function unlockApp(ok, removed = false) { if (ok) { appLocked = false; sendToRenderer('unlock-result', { ok: true, removed }); if (mainWindow && activeProfileId && browserViews[activeProfileId]) { mainWindow.setBrowserView(browserViews[activeProfileId]); updateBrowserViewBounds(); } } else sendToRenderer('unlock-result', { ok: false, message: 'Sai mật khẩu.' }); }

function updateBadge(count) {
  if (!mainWindow) return;
  if (process.platform === 'win32') {
    if (count > 0) { try { mainWindow.setOverlayIcon(createBadgeIcon(count), `${count} tin nhắn chưa đọc`); } catch { mainWindow.setOverlayIcon(null, ''); } }
    else mainWindow.setOverlayIcon(null, '');
  }
  if (tray) tray.setToolTip(count > 0 ? `Nhà Yến Zalo — ${count} tin nhắn chưa đọc` : 'Nhà Yến Zalo');
}
function registerGlobalShortcuts() {
  const hotkey = settings.globalHotkey || 'Ctrl+Shift+M';
  try { globalShortcut.register(hotkey, () => { if (!mainWindow) return; if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide(); else { mainWindow.show(); mainWindow.focus(); } }); } catch (err) { }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  // Mở khoá không cần nhập lại nếu máy này đã được "Ghi nhớ" (DPAPI).
  if (tryAutoUnlockFromDpapi()) appLocked = false;
  nativeTheme.themeSource = settings.isDarkMode ? 'dark' : 'light';
  createWindow();
  createTray();
  registerGlobalShortcuts();
  setupAutoUpdater();
  // Chuẩn hóa ảnh mẫu sang PNG thật một lần, sau khi cửa sổ chính đã sẵn sàng.
  void migrateQuickReplyImagesToPng()
    .then((result) => {
      if (result.skipped) return;
      const failed = result.failed?.length || 0;
      sendToRenderer('quick-reply-images-normalized', { converted: result.converted, failed, summary: result.summary });
      console.log(`[quick-reply] chuẩn hóa PNG: ${result.converted} ảnh, lỗi ${failed}`);
    })
    .catch((err) => console.error('[quick-reply] chuẩn hóa PNG thất bại:', err));
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('login', (event, webContents, details, authInfo, callback) => {
  if (authInfo.isProxy) {
    const hostPort = `${authInfo.host}:${authInfo.port}`;
    if (proxyCredentials[hostPort]) { event.preventDefault(); callback(proxyCredentials[hostPort].username, proxyCredentials[hostPort].password); }
  }
});
app.on('before-quit', () => { isQuitting = true; void stopRemoteControl(); if (mainWindow) { settings.windowBounds = mainWindow.getBounds(); saveSettings(settings); } });
app.on('will-quit', () => { globalShortcut.unregisterAll(); destroyThumbnailWindow(); destroyTranscoderWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
