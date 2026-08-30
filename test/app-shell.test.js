const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('app shell is rebranded as Nhà Yến Zalo and exposes the approved vertical tools in order', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const actions = Array.from(html.matchAll(/class="tool-btn nav-tool"[^>]+data-tool-action="([^"]+)"/g), (match) => match[1]);

  assert.equal(pkg.build.productName, 'Nhà Yến Zalo');
  assert.match(html, /<title>Nhà Yến Zalo<\/title>/);
  assert.deepEqual(actions, [
    'zalo-users',
    'zalo-groups',
    'quick-replies',
    'update',
    'remote-control',
  ]);
  assert.match(html, /id="btn-add-profile"[^>]+aria-label="Thêm nick Zalo"/);
  assert.match(html, /id="zalo-users-profile-select"/);
  assert.match(html, /id="zalo-groups-profile-select"/);
  assert.doesNotMatch(html, /data-tool-action="dashboard"|data-tool-action="workspaces"/);
  assert.doesNotMatch(html, /CRM mini|AI Rewrite|Bảng công cụ 9Meta/);
});

test('tool overlays are mutually exclusive and clicking the active tool closes it', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  assert.match(renderer, /function toggleToolOverlay\(id\)/);
  assert.match(renderer, /for \(const overlayId of overlayIds\)/);
  assert.match(renderer, /classList\.toggle\('active'/);
});

test('profile add button visibly renders a blue plus and dropdowns prefer verified Zalo identity', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  assert.match(html, /#btn-add-profile svg\s*\{[^}]*stroke:\s*#1767d9/s);
  assert.match(renderer, /profile\.zaloDisplayName\s*\|\|\s*profile\.name/);
  assert.match(renderer, /profile\.zaloDisplayName\s*=\s*payload\.name/);
  const profileExtractor = preload.slice(preload.indexOf('function extractProfileInfo()'), preload.indexOf('setInterval(extractProfileInfo'));
  assert.doesNotMatch(profileExtractor, /header-title|title-name/);
});

test('remote capture binds to the Electron main window media source instead of matching browser titles', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(main, /mainWindow\.getMediaSourceId\(\)/);
  assert.doesNotMatch(main, /sources\.find\(\(entry\) => \/Nhà Yến Zalo/);
});

test('personal and group message tools expose runnable bulk-send controls instead of placeholders', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  assert.match(html, /id="personal-message-run"/);
  assert.match(html, /id="group-message-run"/);
  assert.doesNotMatch(html, /Danh sách gửi cá nhân độc lập đang được chuẩn bị|Danh sách gửi nhóm độc lập đang được chuẩn bị/);
  assert.match(renderer, /function runIndependentBulkMessage\(kind\)/);
  assert.match(renderer, /userScanId:\s*activeZaloUserScan\.scanId/);
});

test('user management owns send and unfriend actions without duplicate rail buttons', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.doesNotMatch(html, /class="tool-btn nav-tool"[^>]+data-tool-action="(?:personal-messages|group-messages)"/);
  assert.match(html, /id="zalo-users-send-open"/);
  assert.match(html, /id="zalo-users-unfriend-open"/);
  assert.match(renderer, /zalo-user-action:unfriend/);
  assert.match(main, /ipcMain\.handle\('zalo-user-action:unfriend'/);
});

test('bulk messaging requires consent and enforces the approved daily cap', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(html, /id="personal-message-consent"/);
  assert.match(html, /id="group-message-consent"/);
  assert.match(html, /id="zalo-groups-message-consent"/);
  assert.match(renderer, /randomBetween\(120_000, 300_000\)/);
  assert.match(main, /messagesUsedToday >= 200/);
  assert.match(main, /consentConfirmed !== true/);
});

test('bulk send resolves scanned targets by immutable id before display name', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  assert.match(main, /safeTargetId/);
  assert.match(main, /var idMatch = null/);
  assert.match(main, /foundBy: idMatch === targetEl \? 'id' : \(exactMatch === targetEl \? 'exact' : 'fuzzy'\)/);
  assert.match(main, /safeTargetNames/);
  assert.match(main, /safeSearchName/);
  assert.match(main, /const trustedSelection/);
  assert.match(renderer, /targetNames:\s*\[item\.name, item\.zaloName, item\.displayName\]/);
  assert.match(renderer, /result\?\.ok[\s\S]*randomBetween\(2_000, 5_000\)/);
});

test('long overlays keep their close control visible and support an independent scrolling body', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /\.panel-head\s*\{[^}]*position:\s*sticky/s);
  assert.match(html, /\.panel-box\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(html, /\.panel-body\s*\{[^}]*overflow-y:\s*auto/s);
});

test('shell uses one white rail, anchors tools at the bottom, and exposes a persisted 12-24px font control', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(html, /id="profile-rail"/);
  assert.doesNotMatch(html, /id="tool-rail"/);
  assert.doesNotMatch(html, /id="brand-badge"/);
  assert.match(html, /\.sidebar-nav\s*\{[^}]*margin-top:\s*auto/s);
  assert.match(html, /id="app-more-menu"/);
  assert.match(html, /id="font-size-range"[^>]+min="12"[^>]+max="24"/);
  assert.match(renderer, /localStorage\.setItem\('nha-yen-font-size'/);
  assert.match(renderer, /set-font-scale/);
  assert.match(main, /titleBarStyle:\s*'hidden'/);
  assert.match(main, /color:\s*'#ffffff'/);
});

test('top bar opens a quote-only utility panel that is closed by default', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(html, /id="crm-utility-panel"/);
  assert.match(html, /id="quote-panel-toggle"[^>]*>Báo giá<\/button>/);
  assert.match(html, /id="crm-utility-panel" class="collapsed"/);
  assert.doesNotMatch(html, /data-utility-tab="orders"|data-utility-tab="design"|Quản lý đơn|Đơn thiết kế|id="crm-login"/);
  assert.doesNotMatch(html, /Thiệp cao cấp|QuoteVip/);
  assert.match(renderer, /active-chat-insert-text/);
  assert.match(renderer, /quote-panel-toggle/);
  assert.match(main, /let utilityPanelWidth = 0/);
  assert.match(main, /bounds\.width - SIDEBAR_WIDTH - utilityPanelWidth/);
});

test('completed scans leave recipients unselected by default', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  assert.doesNotMatch(renderer, /new Set\(zaloUsers\.map/);
  assert.doesNotMatch(renderer, /new Set\(zaloGroupScanGroups\.map/);
});

test('font menu never hides the embedded Zalo BrowserView', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const start = renderer.indexOf('appMoreButton.onclick');
  const end = renderer.indexOf('applyFontSize(getSavedFontSize()', start);
  const fontMenuCode = renderer.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(fontMenuCode, /set-browserview-visibility/);
});

test('user and group result lists always expose stable vertical scrollbars', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /\.group-results\s*\{[^}]*overflow-y:\s*scroll[^}]*scrollbar-gutter:\s*stable/s);
  assert.match(html, /#zalo-users-results\s*\{[^}]*flex:\s*1 1 0/s);
  assert.match(html, /#zalo-groups-results\s*\{[^}]*height:\s*clamp/s);
});

test('user management exposes safe inactivity filtering and a compatibility probe', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  assert.match(html, /id="zalo-users-inactivity"/);
  assert.match(html, /id="zalo-users-probe"/);
  assert.match(html, /Không rõ.+tự động bị loại/);
  assert.match(renderer, /zalo-compatibility:probe/);
  assert.match(renderer, /getVisibleZaloUsers\(\)\.filter/);
});

test('quick replies support named shortcuts and optional images without auto-sending', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(html, /id="quick-reply-keyword"/);
  assert.match(html, /id="quick-reply-image"/);
  assert.match(html, /id="quick-replies-topbar"[^>]*>Tin nhắn nhanh<\/button>/);
  assert.match(renderer, /normalizeQuickReplyKeyword/);
  assert.match(renderer, /imagePath:\s*pendingQuickReplyImagePath/);
  assert.match(preload, /applyQuickReply/);
  assert.match(preload, /pasteQuickReplyImage/);
  const shortcutCode = preload.slice(preload.indexOf('function setupQuickReplyShortcuts'), preload.indexOf('setTimeout(setupQuickReplyShortcuts'));
  assert.doesNotMatch(shortcutCode, /sendBtn\.click|new KeyboardEvent\('keydown'.+Enter/s);
  assert.match(main, /ipcMain\.handle\('quick-reply:paste-image'/);
});

test('topbar video picker stages a video in the active Zalo conversation without sending it', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const videoStaging = fs.readFileSync(path.join(root, 'modules', 'video-staging.js'), 'utf8');
  assert.match(html, /id="send-video-topbar"[^>]*>Gửi video<\/button>/);
  assert.match(renderer, /ipcRenderer\.invoke\('active-chat:choose-video'/);
  assert.match(main, /ipcMain\.handle\('active-chat:choose-video'/);
  assert.match(videoStaging, /DOM\.setFileInputFiles/);
  const handler = main.slice(
    main.indexOf("ipcMain.handle('active-chat:choose-video'"),
    main.indexOf("ipcMain.handle('active-chat-insert-text'"),
  );
  assert.doesNotMatch(handler, /keyCode:\s*'Enter'|\.click\(\).*send/i);
  assert.match(handler, /chưa được gửi/i);
});

test('unfriend recorder captures only UI action structure and saves a privacy-safe report', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(html, /id="zalo-users-record"/);
  assert.match(renderer, /zalo-unfriend-recorder:start/);
  assert.match(renderer, /zalo-unfriend-recorder:stop/);
  assert.match(main, /ipcMain\.handle\('zalo-unfriend-recorder:start'/);
  assert.match(main, /profileHash/);
  assert.match(main, /placeholder/);
  assert.match(main, /inputLength/);
  assert.match(main, /popover-v3/);
  assert.match(main, /zl-modal__footer__button/);
  const recorder = main.slice(main.indexOf("ipcMain.handle('zalo-unfriend-recorder:start'"), main.indexOf("ipcMain.handle('zalo-user-action:unfriend'"));
  assert.doesNotMatch(recorder, /document\.cookie|localStorage|sessionStorage/);
});

test('unfriend batch keeps the concrete final failure visible', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  assert.match(renderer, /const failureMessages = \[\]/);
  assert.match(renderer, /Lỗi cuối:/);
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(main, /\['CONTACTS', 700\].*\['FRIEND_LIST', 800\].*\['SEARCH', 900\].*\['MORE', 150\].*\['DELETE', 150\].*\['CONFIRM', 1400\].*\['VERIFY', 0\]/s);
  assert.match(main, /Zalo không phản hồi trong 6 giây/);
  assert.match(renderer, /openOverlay\(id\)[\s\S]*set-browserview-visibility', false/);
  assert.match(main, /mainWindow\.setBrowserView\(view\)[\s\S]*view\.webContents\.focus\(\)/);
  assert.match(main, /restoreHiddenBrowserView[\s\S]*mainWindow\.setBrowserView\(null\)/);
  assert.match(renderer, /invokeWithRendererTimeout\('zalo-user-action:unfriend'/);
  assert.match(renderer, /\[IPC\] Main process không trả kết quả trong 30 giây/);
  assert.match(main, /runStepUntil[\s\S]*timeoutMs = 3_000[\s\S]*stage === 'DELETE' \|\| stage === 'CONFIRM'/);
});
