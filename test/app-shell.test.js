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

test('top bar opens mutually exclusive quote, design and Pancake panels that are closed by default', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(html, /id="crm-utility-panel"/);
  assert.match(html, /id="pancake-topbar-create"[^>]*>Tạo đơn<\/button>/);
  assert.match(html, /id="quick-replies-topbar"[^>]*>Tin nhắn nhanh<\/button>/);
  assert.match(html, /id="send-video-topbar"[^>]*>Gửi video<\/button>/);
  assert.match(html, /id="quote-panel-toggle"[^>]*>Báo giá<\/button>/);
  assert.match(html, /id="design-orders-topbar"[^>]*>Đơn thiết kế<\/button>/);
  assert.match(html, /id="pancake-orders-topbar"[^>]*>Pancake<\/button>/);
  // Topbar 7 nut theo thu tu: Tao don | Tin nhan nhanh | Gui video | Don thiet ke | Pancake | Bao gia | Aa
  const topbarOrder = ['pancake-topbar-create', 'quick-replies-topbar', 'send-video-topbar', 'design-orders-topbar', 'pancake-orders-topbar', 'quote-panel-toggle', 'app-more-button'];
  let lastIdx = -1;
  for (const id of topbarOrder) { const idx = html.indexOf(`id="${id}"`); assert.ok(idx > lastIdx, `${id} phai dung sau nut truoc do`); lastIdx = idx; }
  // Tat ca nut chinh dung mau xanh #1767d9
  assert.match(html, /\.topbar-primary \{[^}]*background: #1767d9/);
  assert.match(html, /class="topbar-primary"/);
  assert.match(html, /id="crm-utility-panel" class="collapsed"/);
  assert.match(html, /id="utility-pane-design"/);
  assert.match(html, /id="utility-pane-orders"/);
  assert.match(html, /id="crm-login"/);
  assert.doesNotMatch(html, /Thiệp cao cấp|QuoteVip/);
  assert.match(renderer, /active-chat-insert-text/);
  assert.match(renderer, /quote-panel-toggle/);
  assert.match(renderer, /toggleUtilityPanel\('design'\)/);
  assert.match(renderer, /toggleUtilityPanel\('orders'\)/);
  assert.match(main, /let utilityPanelWidth = 0/);
  assert.match(main, /computeViewGeometry\(\{[\s\S]*utilityWidth:\s*utilityPanelWidth[\s\S]*popupWidth:\s*popupPanelWidth/);
});

test('Pancake panel keeps warehouse selection and only auto-detects D-prefixed conversations', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  assert.match(html, /id="pancake-warehouse"/);
  assert.match(html, /id="pancake-search"[^>]+placeholder="Mã đơn hoặc khách hàng"/);
  assert.match(html, /id="pancake-topbar-create"[^>]*>Tạo đơn<\/button>/);
  assert.doesNotMatch(html, /id="pancake-direct-create"/);
  assert.match(html, /id="pancake-create"[^>]*>Lưu thay đổi<\/button>/);
  assert.match(renderer, /match\(\/\^\(D\[A-Z0-9_-\]/);
  assert.match(renderer, /loadPancakeOrderDetail/);
  assert.match(renderer, /allow_create_order/);
});

test('managed video library exposes compact preview, rename and delete actions without search', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.doesNotMatch(html, /id="video-library-search"/);
  assert.match(renderer, /data-video-preview/);
  assert.match(renderer, /data-video-rename/);
  assert.match(renderer, /data-video-remove/);
  assert.match(main, /video-library:rename/);
  assert.match(main, /video-library:preview/);
});

test('CRM panels do not abort renderer startup when optional mapping controls are absent', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  assert.match(renderer, /const mappingSaveButton = document\.getElementById\('mapping-save'\)/);
  assert.match(renderer, /if \(mappingSaveButton\) mappingSaveButton\.onclick/);
  assert.match(renderer, /const crmUserName = document\.getElementById\('crm-user-name'\)/);
  assert.match(renderer, /if \(crmUserName\) crmUserName\.innerText/);
});

test('available updates open a dedicated Deplao-style notice above the embedded BrowserView', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const notice = fs.readFileSync(path.join(root, 'update-notice.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(html, /id="update-release-notes"/);
  assert.match(html, />Để sau<\/button>/);
  assert.match(html, /id="update-download"[^>]*>Cập nhật ngay<\/button>/);
  assert.doesNotMatch(renderer, /state\.status === 'available'.*openOverlay\('update-overlay'\)/);
  assert.match(main, /function showUpdateNotice\(\)/);
  assert.match(main, /parent:mainWindow, modal:false/);
  assert.match(notice, />Để sau<\/button>/);
  assert.match(notice, />Cập nhật ngay<\/button>/);
  assert.match(main, /releaseNotes: rawNotes\.trim\(\)/);
});

test('all five business panels use the same professional 560px dock width', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  assert.match(html, /--popup-width:\s*560px/);
  assert.match(renderer, /const POPUP_DEFAULT_WIDTH = 560/);
  assert.match(renderer, /const width = open \? getSavedPopupWidth\(\) : 0/);
});

test('editing an existing design order never requires a connected Zalo account', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const handler = renderer.slice(renderer.indexOf("document.getElementById('design-save').onclick"), renderer.indexOf("document.getElementById('utility-panel-hide').onclick"));
  assert.match(handler, /if \(!selectedDesignOrder\)/);
  assert.match(handler, /resolveCrmConversation\(\{ quiet: true \}\)\.catch/);
  assert.match(handler, /selectedDesignOrder \? `\/orders\//);
  assert.doesNotMatch(handler, /alert\(/);
});

test('completed scans leave recipients unselected by default', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  assert.doesNotMatch(renderer, /new Set\(zaloUsers\.map/);
  assert.doesNotMatch(renderer, /new Set\(zaloGroupScanGroups\.map/);
});

test('profile badges count unread conversations up to 99+ and group scans can be minimized', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(preload, /sendUnreadConversationCount/);
  assert.match(preload, /extractUnreadConversationCount/);
  assert.match(main, /ipcMain\.on\('profile-unread-count'/);
  assert.match(renderer, /count > 99 \? '99\+'/);
  assert.match(html, /id="zalo-groups-minimize"/);
  assert.match(html, /id="zalo-groups-running-badge"/);
  assert.match(renderer, /setZaloGroupTaskRunning/);
  const switchHandler = main.slice(main.indexOf("ipcMain.on('switch-profile'"), main.indexOf("ipcMain.on('update-profile-settings'"));
  assert.doesNotMatch(switchHandler, /cancelProfileScans/);
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
  // Nut probe-compat da duoc go trong v2.5.30: index.html + renderer khong con phan tu nay,
  // main-process van giu handler de tuong thich cu (khong kiem tra main.js o day).
  assert.doesNotMatch(html, /id="zalo-users-probe"/);
  assert.doesNotMatch(renderer, /zalo-users-probe/);
  assert.match(html, /Không rõ.+tự động bị loại/);
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
  assert.match(renderer, /const imagePath = pendingQuickReplyImagePath \|\| ''/);
  assert.match(preload, /applyQuickReply/);
  assert.match(preload, /pasteQuickReplyImage/);
  const shortcutCode = preload.slice(preload.indexOf('function setupQuickReplyShortcuts'), preload.indexOf('setTimeout(setupQuickReplyShortcuts'));
  assert.doesNotMatch(shortcutCode, /sendBtn\.click|new KeyboardEvent\('keydown'.+Enter/s);
  assert.match(main, /ipcMain\.handle\('quick-reply:paste-image'/);
});

test('legacy direct video picker remains safe and topbar opens the managed library', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const videoStaging = fs.readFileSync(path.join(root, 'modules', 'video-staging.js'), 'utf8');
  assert.match(html, /id="send-video-topbar"[^>]*>Gửi video<\/button>/);
  assert.match(renderer, /toggleToolOverlay\('video-library-overlay'\)/);
  assert.match(main, /ipcMain\.handle\('active-chat:choose-video'/);
  assert.match(videoStaging, /DOM\.setFileInputFiles/);
  const handler = main.slice(
    main.indexOf("ipcMain.handle('active-chat:choose-video'"),
    main.indexOf("ipcMain.handle('active-chat-insert-text'"),
  );
  assert.doesNotMatch(handler, /keyCode:\s*'Enter'|\.click\(\).*send/i);
  assert.match(handler, /chưa được gửi/i);
});

test('video library persists managed files and stages a selected item without sending', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(html, /id="video-library-overlay"/);
  assert.match(html, /id="video-library-add"/);
  assert.match(html, /id="video-library-stage"/);
  assert.match(renderer, /video-library:list/);
  assert.match(renderer, /video-library:stage/);
  assert.match(main, /mediaStoreLayout|ensureMediaStore/);
  const mediaLibrary = fs.readFileSync(path.join(root, 'modules', 'media-library.js'), 'utf8');
  assert.match(mediaLibrary, /MAX_LIBRARY_VIDEO_BYTES = 20 \* 1024 \* 1024/);
  assert.match(main, /ipcMain\.handle\('video-library:add'/);
  const handler = main.slice(main.indexOf("ipcMain.handle('video-library:stage'"), main.indexOf("ipcMain.handle('active-chat-insert-text'"));
  assert.match(handler, /focusZaloComposerAndPasteFile/);
  assert.doesNotMatch(handler, /stageVideoWithDebugger/);
  assert.doesNotMatch(handler, /keyCode:\s*'Enter'/);
  assert.match(main, /Clipboard\]::SetFileDropList/);
  assert.match(main, /keyCode:\s*'V'.*modifiers:\s*\['control'\]/);
});

test('utility panes are mutually exclusive and design refreshes the active Zalo chat before searching', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(html, /\.utility-pane:not\(\.active\)\s*\{\s*display:\s*none\s*!important/);
  assert.match(html, /\.design-panel\.active\s*\{\s*display:flex/);
  assert.doesNotMatch(html, /\.design-panel\s*\{[^}]*display:flex/);
  assert.match(main, /ipcMain\.handle\('active-chat:get-info'/);
  assert.match(renderer, /refreshCurrentChatSnapshot/);
  assert.match(renderer, /ipcRenderer\.invoke\('active-chat:get-info'/);
  assert.match(renderer, /document\.getElementById\('design-search'\)\.value = code/);
});

test('Pancake and design panels use compact single-panel workflows', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  assert.match(html, /id="design-list-view"/);
  assert.match(html, /id="design-back"/);
  assert.match(renderer, /function showDesignListView/);
  assert.match(renderer, /document\.getElementById\('design-list-view'\)\.hidden = true/);
  assert.match(html, /class="pancake-notes"/);
  assert.match(html, /Ghi chú khác \(ít sử dụng\)/);
  assert.match(html, /\.utility-summary \.total b[^}]*font-size:14px[^}]*color:#1d4ed8/);
  assert.match(html, /#pancake-items[^}]*max-height:none[^}]*overflow-y:auto/);
});

test('v2.5.34 quick replies: full list without pager, 80-char content preview, Sửa | Xoá | Chèn text buttons, removed helper controls', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  // Khong con dropdown phan trang, nut kiem tra anh va nut dong bo CRM.
  assert.doesNotMatch(html, /id="quick-replies-page-size"/);
  assert.doesNotMatch(html, /id="quick-reply-check-images"/);
  assert.doesNotMatch(html, /id="quick-reply-sync-crm"/);
  // Renderer khong con tham chieu toi cac element da go (nếu còn sẽ null lỗi lúc tải).
  assert.doesNotMatch(renderer, /getElementById\('quick-replies-page-size'\)/);
  assert.doesNotMatch(renderer, /getElementById\('quick-reply-sync-crm'\)/);
  assert.doesNotMatch(renderer, /getElementById\('quick-reply-check-images'\)/);
  // Cot noi dung chi hien 80 ky tu dau, full text trong title.
  assert.match(renderer, /full\.slice\(0, 80\)/);
  assert.match(renderer, /title="\$\{escapeHtml\(full\)\}"/);
  // Khong con phan trang trong renderQuickReplies.
  assert.doesNotMatch(renderer, /quick-replies-page-prev/);
  assert.doesNotMatch(renderer, /quick-replies-page-next/);
  // 3 nut dang text: Sửa | Xoá | Chèn; Chèn nằm ngoài cùng bên phải và gọi quick-reply:test-template (không tự gửi).
  assert.match(renderer, /data-qr-edit/);
  assert.doesNotMatch(renderer, /data-qr-test/);
  assert.match(renderer, /data-qr-insert="\$\{entry\.__index\}">Chèn<\/button>/);
  assert.match(renderer, /querySelectorAll\('\[data-qr-insert\]'\)/);
  assert.match(renderer, /ipcRenderer\.invoke\('quick-reply:test-template'/);
});

test('v2.5.34 Pancake panel rename, blue total, and Lấy mã đơn label', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /id="pancake-orders-topbar"[^>]*>Pancake<\/button>/);
  assert.match(html, /id="pancake-orders-topbar"[^>]*title="Mở Pancake"/);
  assert.doesNotMatch(html, /id="pancake-orders-topbar"[^>]*>Đơn Pancake<\/button>/);
  assert.match(html, /id="pancake-refresh-current"[^>]*>Lấy mã đơn<\/button>/);
  assert.doesNotMatch(html, /id="pancake-refresh-current"[^>]*>Làm mới<\/button>/);
  // Toàn bộ text đỏ (thành tiền) chuyển xanh dương #1d4ed8.
  assert.match(html, /\.pancake-line-total \{[^}]*color:#1d4ed8/);
  assert.match(html, /\.pancake-panel \.utility-summary \.total \{[^}]*color:#1d4ed8/);
  assert.match(html, /\.pancake-panel \.utility-summary \.total b \{[^}]*color:#1d4ed8/);
  assert.doesNotMatch(html, /\.pancake-line-total[^}]*color:#e02020/);
});

test('v2.5.34 at-rest encryption: master password unlock, encrypted settings/data, sensitive IPC gated by storeUnlocked', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const cryptoStore = fs2.readFileSync(path2.join(root, 'modules', 'crypto-store.js'), 'utf8');
  const main = fs2.readFileSync(path2.join(root, 'main.js'), 'utf8');
  const renderer = fs2.readFileSync(path2.join(root, 'renderer.js'), 'utf8');
  // Module mã hoá: PBKDF2 150k + AES-256-GCM, payload tự chứa, ghi atomic tmp→rename.
  assert.match(cryptoStore, /PBKDF2_ITERATIONS = 150_000/);
  assert.match(cryptoStore, /ALGO = 'aes-256-gcm'/);
  assert.match(cryptoStore, /function isEncryptedPayload\(/);
  assert.match(cryptoStore, /function readStoreFile\(/);
  assert.match(cryptoStore, /fs\.renameSync\(tmp, filePath\)/);
  // main.js giữ masterKey trong RAM, IPC secure:unlock/remember/forget/status và guard locked.
  assert.match(main, /ipcMain\.handle\('secure:unlock'/);
  assert.match(main, /ipcMain\.handle\('secure:remember'/);
  assert.match(main, /ipcMain\.handle\('secure:forget'/);
  assert.match(main, /ipcMain\.handle\('secure:status'/);
  assert.match(main, /locked:\s*true/);
  // Renderer có overlay bắt buộc khi nhận need-master-password.
  assert.match(renderer, /ipcRenderer\.on\('need-master-password'/);
  assert.match(renderer, /showSecureOverlay/);
});

test('v2.5.34 preset master password: nhân viên phải nhập đúng mật khẩu chủ đã set sẵn, plaintext không lộ trong mã nguồn', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  // Salt + hash PBKDF2 phải có trong main.js; KHÔNG được chứa plaintext password.
  assert.match(main, /const PRESET_MASTER_SALT = '/);
  assert.match(main, /const PRESET_MASTER_HASH_HEX = '[0-9a-f]{64}';/);
  assert.doesNotMatch(main, /Nhayen2027@/);
  assert.match(main, /matchesPresetMasterPassword\(pwd\)/);
  // Overlay hiện ra mỗi khi store chưa mở khoá (kể cả cài mới còn plaintext).
  assert.match(main, /function needsMasterPasswordOverlay\(\)\s*{[\s\S]*?return !storeUnlocked;/);
  // Overlay chỉ còn chế độ NHẬP mật khẩu, không còn chế độ tạo mật khẩu tự do.
  assert.doesNotMatch(main, /secureCreateMode|secureLegacyLock/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'renderer.js'), 'utf8'), /secureCreateMode|secureLegacyLock/);
  // Chạy thật hàm kiểm tra: đúng pass -> true, sai pass -> false.
  const block = main.match(/const PRESET_MASTER_SALT[\s\S]*?function matchesPresetMasterPassword\(pwd\) \{[\s\S]*?\n\}/);
  assert.ok(block, 'không trích được khối matchesPresetMasterPassword từ main.js');
  const cryptoMod = require('node:crypto');
  const cryptoStoreMod = require(path.join(root, 'modules', 'crypto-store.js'));
  const { matchesPresetMasterPassword } = new Function('crypto', 'cryptoStore', `${block[0]}; return { matchesPresetMasterPassword };`)(cryptoMod, cryptoStoreMod);
  assert.equal(matchesPresetMasterPassword('Nhayen2027@'), true, 'mật khẩu đúng phải được chấp nhận');
  assert.equal(matchesPresetMasterPassword('sai-mat-khau'), false);
  assert.equal(matchesPresetMasterPassword(''), false);
});

test('the app bundles Quicksand and uses one typography system including Pancake', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(html, /@font-face\s*{[^}]*font-family:\s*'Quicksand'[^}]*Quicksand-VariableFont_wght\.ttf/s);
  assert.match(html, /--app-font-family:\s*'Quicksand',\s*sans-serif/);
  assert.match(html, /font-family:\s*var\(--app-font-family\)/);
  assert.match(html, /\.pancake-panel \*\s*{\s*font-family:inherit/);
  assert.match(html, /\.pancake-item-row input[^}]*font-size:\s*var\(--ui-font-size\)/);
  assert.ok(pkg.build.files.includes('assets/fonts/Quicksand-VariableFont_wght.ttf'));
});

test('Pancake actions stay in a dedicated footer and reset never deletes persisted orders', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  assert.match(html, /class="pancake-scroll"/);
  assert.match(html, /class="pancake-actionbar"/);
  assert.match(html, /id="pancake-reset"[^>]*>Thiết lập lại/);
  assert.doesNotMatch(html, /class="pancake-actionbar"[^>]*[\s\S]{0,400}id="pancake-direct-create"/);
  assert.match(html, /id="pancake-create"[^>]*>Lưu thay đổi<\/button>/);
  assert.match(renderer, /Dữ liệu đã lưu trên CRM\/Pancake sẽ không bị xóa/);
  assert.match(renderer, /Lưu thay đổi/);
});

test('Đơn Pancake tab is CRM-independent and offers a refresh handle for the order code', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  // Nút Lấy mã đơn ngay cạnh Đóng, an mặc định (chi hien o tab Pancake).
  assert.match(html, /id="pancake-refresh-current"[^>]*hidden[^>]*>Lấy mã đơn<\/button>/);
  assert.match(html, /id="pancake-refresh-current"[\s\S]*id="utility-panel-hide"/);
  // refreshPancakeCurrent bat ma don tu ten hoi thoai, khong go CRM (resolveCrmConversation/crmRequest).
  const refreshFn = renderer.slice(
    renderer.indexOf('async function refreshPancakeCurrent'),
    renderer.indexOf('async function refreshPancakeCurrent') + 1400,
  );
  assert.ok(refreshFn.length > 0);
  assert.match(refreshFn, /currentChatSnapshot\?\.name/);
  assert.match(refreshFn, /loadPancakeOrders\(\{ autoSelectCode: code \}\)/);
  assert.doesNotMatch(refreshFn, /resolveCrmConversation|crmRequest/);
  // Nut Làm moi re-quet hoi thoai roi bat lai ma don.
  const refreshClick = renderer.slice(
    renderer.indexOf("getElementById('pancake-refresh-current').onclick"),
    renderer.indexOf("getElementById('pancake-refresh-current').onclick") + 320,
  );
  assert.match(refreshClick, /await refreshCurrentChatSnapshot\(\)/);
  assert.match(refreshClick, /await refreshPancakeCurrent\(\)/);
  // setUtilityTab chi bat nut Làm moi o tab orders.
  const tabFn = renderer.slice(
    renderer.indexOf('function setUtilityTab'),
    renderer.indexOf('function setUtilityTab') + 1600,
  );
  assert.match(tabFn, /refreshCurrentButton\.hidden = tab !== 'orders'/);
  // renderCrmConnection an ca badge luon hop dang nhap CRM o tab orders.
  assert.match(renderer, /toggle\.hidden = !crmConnected \|\| currentUtilityTab === 'quote' \|\| currentUtilityTab === 'orders'/);
  assert.match(renderer, /box\.hidden = currentUtilityTab === 'quote' \|\| currentUtilityTab === 'orders'/);
});

test('Lưu thay đổi ghi len don Pancake dang mo va bao loi khi chua tai don', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const createClick = renderer.slice(
    renderer.indexOf("getElementById('pancake-create').onclick"),
    renderer.indexOf("getElementById('pancake-create').onclick") + 900,
  );
  assert.match(createClick, /Chưa tải đơn Pancake nào để lưu/);
  assert.match(createClick, /pancakeRequest\(`\/shops\/609730\/orders\/\$\{encodeURIComponent\(orderCode\)\}`, 'PUT'/);
  assert.match(createClick, /pancakeApiPayload\(payload\)/);
  assert.doesNotMatch(createClick, /crmRequest/);
});

test('linked order code is emphasized and the product block dominates the layout', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  // Ma don siet them: 24px (was 26px), line-height 1.1, padding 2px 6px.
  assert.match(html, /#pancake-current \.mapping-state\.linked ~ h4 \{ font-size:24px; color:#1767d9;/);
  assert.match(html, /#pancake-current \{ flex:0 0 auto; padding:2px 6px; \}/);
  // San pham chiem toan bo khoang con lai; ma don + khach hang + thanh toan ep theo noi dung.
  assert.match(html, /#pancake-products-block \{ position:relative; flex:1 1 auto; min-height:0; display:flex; flex-direction:column; \}/);
  assert.match(html, /#pancake-items \{[^}]*max-height:none[^}]*overflow-y:auto/);
  assert.match(html, /#pancake-customer-block \{ flex:0 0 auto; padding:2px 6px; \}/);
  assert.match(html, /#pancake-payment-block \{ flex:0 0 auto; padding:4px 6px; \}/);
  // Khach hang siet them: input 24px (was 28px), gap 2px, chip 20px/10px.
  assert.match(html, /#pancake-customer-block \.utility-form-grid \{ gap:2px; \}/);
  assert.match(html, /#pancake-customer-block \.modal-input, \.pancake-panel #pancake-customer-block \.modal-select \{ min-height:24px;/);
  assert.match(html, /#pancake-customer-block \.pancake-customer-chip span \{ width:20px; height:20px; font-size:10px; \}/);
  // San pham thang hang: row + header CUNG padding 4px 6px va gap 4px, cac cell cao dong deu 28px.
  assert.match(html, /\.pancake-item-row \{[^}]*gap: 4px; padding: 4px 6px;/);
  assert.match(html, /\.pancake-product-columns \{[^}]*gap:4px;[^}]*padding:4px 6px;[^}]*font-size:12px;/);
  assert.match(html, /\.pancake-item-row \{[^}]*align-items: center;/);
  assert.match(html, /\.pancake-item-row input \{[^}]*height:28px;/);
  // Scroll gap 2px.
  assert.match(html, /\.pancake-scroll \{[^}]*gap:2px;/);
});

test('Pancake product search loads the catalog once and strips Vietnamese diacritics', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  // Loc bo dau client: go "thiep cuoi" khong dau van khop "Thiệp Cưới".
  assert.match(renderer, /function stripDiacritics\(value\)/);
  assert.match(renderer, /\.normalize\('NFD'\)\.replace\(/);
  assert.match(renderer, /\.replace\(\/\\u0111\/g, 'd'\)\.replace\(\/\\u0110\/g, 'D'\)/);
  assert.match(renderer, /function loadPancakeProductCatalog\(\)/);
  // Cache mot lan, khong goi API moi khi go.
  assert.match(renderer, /if \(pancakeProductCache\) return pancakeProductCache;/);
  // Ket qua tim dang overlay, de dang khong day danh sach san pham.
  assert.match(html, /#pancake-product-results \{ position:absolute; left:9px; right:9px; z-index:30;/);
  assert.match(html, /id="pancake-product-results" class="utility-search-results" hidden/);
  // An overlay khi click ra ngoai.
  assert.match(renderer, /getElementById\('pancake-product-search'\)\.addEventListener\('blur'/);
});

test('Nha Yen quick replies own the backslash trigger and hide the native Zalo panel', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(html, /Gõ <code>\\từkhóa<\/code> trong ô chat Zalo để chèn mẫu\. Sau đó nhấn enter sẽ hiện ra tin nhắn nhanh/);
  assert.match(html, /style="color:#111;"/);
  assert.match(renderer, /quick-replies-search'\)\.addEventListener\('input'/);
  assert.match(preload, /var trigger = String\.fromCharCode\(92\)/);
  assert.match(preload, /normalizeSearch/);
  assert.match(preload, /findComposerFromTarget\(e\.target\)/);
  assert.match(preload, /ArrowDown/);
  assert.match(preload, /e\.key === 'Enter' \|\| e\.key === 'Tab'/);
  assert.match(preload, /applyQuickReply\(targetInput, entry\.reply, text\)/);
  assert.match(main, /ensureQuickReplyReady\(view\)/);
  assert.match(preload, /^\s*setupQuickReplyPanelHider\(\);/m);
  // Tu dong dien khi go \keyword khop chinh xac 1 ket qua
  assert.match(preload, /var autoFillTimer = null/);
  assert.match(preload, /var ranked = replies\.map/);
  assert.match(preload, /normalizeSearch\(ranked\[0\]\.keyword\) === query/);
  assert.match(preload, /autoFillTimer = setTimeout\(function\(\) \{/);
  assert.match(preload, /450\)/);
  // Khop theo dau keyword (startsWith) thay vi chua o giua (includes)
  assert.match(preload, /normalizeSearch\(entry\.keyword\)\.startsWith\(query\)/);
  // Timer tu dien chi bi huy khi phim thay doi noi dung/trang thai goi y; phim dieu huong giu timer song sot
  assert.match(preload, /var cancelsAutoFill = /);
  assert.match(preload, /if \(autoFillTimer && cancelsAutoFill\)/);
  // Kiem tra lai noi dung o nhap truoc khi tu dien de tranh dien nham
  assert.match(preload, /liveToken !== expectedToken/);
});

test('popup Da tao ma don neo duoi nut Tao don tren topbar va co nut Sao chep', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  assert.match(html, /id="pancake-created-popup"[^>]*role="status"/);
  assert.match(html, /id="pancake-created-label"/);
  assert.match(html, /id="pancake-created-code"/);
  assert.match(html, /id="pancake-created-copy"[^>]*>Sao chép<\/button>/);
  assert.match(html, /id="pancake-created-cancel"[^>]*hidden>Hủy<\/button>/);
  assert.match(html, /id="pancake-created-close"/);
  // Popup nam GON TRONG dai topbar (top:1px + cao 36px => y 5..41 < 42) vi BrowserView Zalo la lop
  // native phu tu y=42 tro xuong; neo sat ben trai nut Tao don bang right:calc(100% + 10px).
  assert.match(html, /#pancake-created-popup \{ position:absolute; top:1px; right:calc\(100% \+ 10px\);/);
  assert.match(html, /#pancake-created-popup \{[^}]*padding:4px 10px;/);
  assert.match(html, /#pancake-created-popup \{[^}]*-webkit-app-region:no-drag;/);
  // Cua so hep: ghim popup vao mep trai (tru toa do offsetParent) de khong tran ra ngoai man hinh
  assert.match(renderer, /if \(popup\.getBoundingClientRect\(\)\.left < 8\) \{/);
  assert.match(renderer, /popup\.style\.left = `\$\{8 - popup\.offsetParent\.getBoundingClientRect\(\)\.left\}px`/);
  assert.match(html, /#pancake-created-popup\.show \{ display:flex; \}/);
  assert.match(html, /#pancake-created-popup \.created-code \{ color:#1767d9; font-size:22px;/);
  // Che do loi: label + ma don mau do, an nut sao chep; nut Huy chi danh cho don thu 0d
  assert.match(html, /#pancake-created-popup\[data-mode="error"\] \.created-code \{ color:#dc2626/);
  assert.match(html, /#pancake-created-cancel:hover:not\(:disabled\)/);
  // Renderer mo popup + copy clipboard + dong khi bam X hoac ra ngoai
  assert.match(renderer, /getElementById\('pancake-topbar-create'\)\.onclick/);
  assert.match(renderer, /function showPancakeCreatePopup\(/);
  assert.match(renderer, /getElementById\('pancake-created-code'\)\.innerText = text/);
  assert.match(renderer, /popup\.classList\.add\('show'\)/);
  assert.match(renderer, /clipboard\.writeText\(code\)/);
  assert.match(renderer, /getElementById\('pancake-created-close'\)\.onclick/);
  assert.match(renderer, /document\.addEventListener\('mousedown'/);
});

test('quick replies can sync the complete CRM template set and normalize images to PNG', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(renderer, /quick-reply:sync-crm/);
  assert.match(main, /crmFetch\('\/automation\/templates'\)/);
  assert.match(main, /storeCrmQuickReplyImageAsPng/);
  assert.match(main, /transcodeBufferToPng\(BrowserWindow, buffer\)/);
  assert.match(main, /ipcMain\.handle\('quick-reply:sync-crm'/);
});

test('group scan executes through the proven preload webFrame bridge', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const handler = main.slice(main.indexOf("ipcMain.handle('zalo-group-scan:start'"), main.indexOf("ipcMain.handle('zalo-user-scan:start'"));
  assert.match(handler, /webContents\.send\('zalo-group-scan:start'/);
  assert.match(preload, /ipcRenderer\.on\('zalo-group-scan:start'/);
  assert.match(preload, /webFrame\.executeJavaScript\(script\)/);
  assert.match(renderer, /invokeWithRendererTimeout\('zalo-group-scan:start'/);
});

test('Pancake product grid shares aligned columns and comma number formatting', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  assert.match(html, /\.pancake-item-row[^}]*68px 96px 110px 34px/);
  assert.match(html, /\.pancake-product-columns[^}]*68px 96px 110px 34px/);
  assert.match(renderer, /function formatPancakeNumber/);
  assert.match(renderer, /toLocaleString\('en-US'\)/);
  assert.match(renderer, /formatPancakeMoney/);
});

test('profile unread badge can visibly float outside the clipped avatar', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  assert.match(html, /\.profile-btn\s*\{[^}]*overflow:\s*visible/s);
  assert.match(html, /\.profile-avatar-clip[^}]*overflow:hidden/);
  assert.match(html, /\.badge\s*\{[^}]*z-index:\s*4/s);
  assert.match(renderer, /avatarClip\.className = 'profile-avatar-clip'/);
});

test('the updater polls while the app remains open so future releases can surface immediately', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(main, /setInterval\(\(\) => \{/);
  assert.match(main, /15 \* 60 \* 1000/);
  assert.match(main, /autoUpdater\.checkForUpdates\(\)/);
  assert.match(main, /updatePoll\.unref/);
});

test('unfriend bridge is discovered inside the active Zalo session without exporting secrets', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  // Nút zalo-users-record da duoc go trong v2.5.30 (index.html + renderer), handler main van giu.
  assert.doesNotMatch(html, /id="zalo-users-record"/);
  assert.doesNotMatch(html, /Kiểm tra cầu nối/);
  assert.doesNotMatch(renderer, /zalo-users-record/);
  assert.match(main, /ipcMain\.handle\('zalo-unfriend-bridge:probe'/);
  assert.match(main, /buildDirectUnfriendScript/);
  const handler = main.slice(main.indexOf("ipcMain.handle('zalo-user-action:unfriend'"), main.indexOf("ipcMain.handle('zalo-group-scan:cancel'"));
  assert.doesNotMatch(handler, /buildUnfriendStepScript|setBrowserView\(view\)|webContents\.focus/);
});

test('unfriend batch keeps the concrete final failure visible', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  assert.match(renderer, /const failureMessages = \[\]/);
  assert.match(renderer, /Lỗi cuối:/);
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(renderer, /openOverlay\(id\)[\s\S]*set-browserview-visibility', false/);
  assert.match(renderer, /invokeWithRendererTimeout\('zalo-user-action:unfriend'/);
  assert.match(renderer, /\[IPC\] Main process không trả kết quả trong 30 giây/);
  assert.match(main, /executeJavaScript\(buildDirectUnfriendScript\(user\.userId\)/);
  assert.match(html, /id="zalo-users-minimize"/);
  assert.match(html, /id="zalo-users-running-badge"/);
  assert.match(renderer, /setZaloUserTaskRunning\(true/);
  assert.match(renderer, /closeOverlay\('zalo-users-overlay'\)/);
});

test('topbar shows the app version as a small black badge next to the brand and opens the update tool', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const brand = html.match(/<span class="topbar-brand">[\s\S]*?<\/span>/)[0];
  const versionCss = html.match(/\.topbar-version \{[\s\S]*?\}/)[0];

  assert.match(brand, /Zalo<button id="app-version-badge"/);
  assert.match(brand, /class="topbar-version"[^>]*data-tool-action="update"/);
  assert.match(versionCss, /font-size: 12px/);
  assert.match(versionCss, /color: #000/);
  assert.match(versionCss, /-webkit-app-region: no-drag/);
  assert.match(renderer, /function renderAppVersionBadge\(\)/);
  assert.match(renderer, /require\('\.\/package\.json'\)\.version/);
  assert.ok(renderer.includes('badge.textContent = version ? `v${version}` : ' + "''"));
});

test('quick replies run in the Zalo main world through the proven webFrame bridge', () => {
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(preload, /webFrame\.executeJavaScript\(injectionScript\)/);
  assert.match(preload, /setTimeout\(setupQuickReplyShortcuts, 3000\)/);
  assert.match(preload, /token\.charCodeAt\(0\) === 92/);
  assert.match(main, /window\.__DepLaoRunQuickReply/);
  assert.match(main, /quick-reply:ready/);
});

test('connected CRM panels collapse credentials into a compact header chip', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  assert.match(html, /id="crm-connection-toggle"[^>]*>CRM ✓</);
  assert.match(renderer, /box\.hidden = true/);
  assert.doesNotMatch(html, /👥 Xuất danh sách nhóm Zalo/);
});

test('v2.5.30 panel titles, scan button labels, and removed helper buttons', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  // panel title doi thanh "Nhóm Zalo"
  assert.match(html, /<h3 class="panel-title">Nhóm Zalo<\/h3>/);
  assert.doesNotMatch(html, /<h3 class="panel-title">Xuất danh sách nhóm Zalo<\/h3>/);
  // "Quét nhóm" va "Quét người dùng" doi thanh "Quét"
  assert.match(html, /id="zalo-groups-start"[^>]*>Quét<\/button>/);
  assert.match(html, /id="zalo-users-scan"[^>]*>Quét<\/button>/);
  assert.doesNotMatch(html, /id="zalo-groups-start"[^>]*>Quét nhóm</);
  assert.doesNotMatch(html, /id="zalo-users-scan"[^>]*>Quét người dùng</);
  // nut "Lưu TXT" da an khoi panel nhóm; ham saveZaloGroupScan van giu lai
  assert.doesNotMatch(html, /id="zalo-groups-save"/);
  assert.doesNotMatch(renderer, /getElementById\('zalo-groups-save'\)/);
  assert.match(renderer, /async function saveZaloGroupScan\(\)/);
  // nut "Chọn 50" o ca 2 panel
  assert.match(html, /id="zalo-groups-select-50"[^>]*>Chọn 50<\/button>/);
  assert.match(html, /id="zalo-users-select-50"[^>]*>Chọn 50<\/button>/);
  assert.match(renderer, /function toggleZaloGroupSelect50\(\)/);
  assert.match(renderer, /function toggleZaloUserSelect50\(\)/);
  assert.match(renderer, /document\.getElementById\('zalo-groups-select-50'\)\.onclick = toggleZaloGroupSelect50/);
  assert.match(renderer, /document\.getElementById\('zalo-users-select-50'\)\.onclick = toggleZaloUserSelect50/);
});

test('v2.5.30 Tạo đơn button auto-selects warehouse, creates 0đ placeholder if empty, shows result popup', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  assert.match(renderer, /function showPancakeCreatePopup\(mode, text, \{ cancelCode = '' \} = \{\}\)/);
  assert.match(renderer, /pancakeWarehouses\.find\(\(warehouse\) => warehouse\.allow_create_order\)/);
  assert.match(renderer, /Đơn tạm 0đ \(tự tạo để lấy mã\)/);
  assert.match(renderer, /\{ status: 6 \}/);
  // Loi Tao don (topbar) duoc render tren popup, khong im lang duoi crm-status
  assert.match(renderer, /showPancakeCreatePopup\('error'/);
  assert.match(renderer, /getElementById\('pancake-topbar-create'\)\.onclick = async/);
  // Handler Tạo đơn tren topbar khong duoc ghi error.message truc tiep vao crm-status (danh cho save handler khac)
  const topbarSlice = renderer.slice(renderer.indexOf("getElementById('pancake-topbar-create')"));
  assert.doesNotMatch(topbarSlice.slice(0, topbarSlice.indexOf("getElementById('pancake-created-copy')")), /document\.getElementById\('crm-status'\)\.innerText = error\.message/);
});

test('v2.5.33 Nhóm Zalo panel-body scroll, docked height 100%, sticky header opaque, theme toggle preserves popup-docked', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  // 1) tall-panel class (specificity 0,2,0) thay ID (1,0,1) de docked height:100% (0,3,1) thang
  assert.match(html, /id="zalo-groups-overlay"[\s\S]*?class="panel-box wide tall-panel"/);
  assert.match(html, /id="zalo-users-overlay"[\s\S]*?class="panel-box wide tall-panel"/);
  assert.match(html, /\.panel-box\.tall-panel\s*\{[^}]*height:\s*min\(90vh,\s*900px\)/s);
  assert.doesNotMatch(html, /#zalo-groups-overlay\s+\.panel-box\s*\{[^}]*height:\s*min\(90vh/s);
  assert.doesNotMatch(html, /#zalo-users-overlay\s+\.panel-box\s*\{[^}]*height:\s*min\(90vh/s);
  assert.match(html, /body\.popup-docked \.overlay \.panel-box[^}]*height:\s*100%/s);
  // 2) Nhom Zalo co panel-body boc toan bo noi dung sau panel-head (va dong dung truoc panel-box)
  const groupsSlice = html.slice(html.indexOf('id="zalo-groups-overlay"'), html.indexOf('id="dashboard-overlay"'));
  assert.match(groupsSlice, /<div class="panel-head">[\s\S]*?<\/div>\s*<div class="panel-body">/s);
  assert.ok(groupsSlice.indexOf('<div class="panel-body">') < groupsSlice.indexOf('id="zalo-groups-profile-select"'));
  assert.ok(groupsSlice.indexOf('<div class="panel-body">') < groupsSlice.indexOf('id="zalo-groups-start"'));
  assert.ok(groupsSlice.indexOf('id="zalo-groups-start"') < groupsSlice.lastIndexOf('</div>'));
  // tail phai la: row-close -> panel-body-close -> panel-box-close -> overlay-close
  assert.match(groupsSlice, /id="zalo-groups-start"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/s);
  // 3) Sticky header khong dung background:inherit (ke thua gradient nua trong suot) -> phai duc theo theme
  assert.doesNotMatch(html, /\.panel-head\s*\{[^}]*background:\s*inherit/s);
  assert.match(html, /\.panel-head\s*\{\s*background:\s*#16213b\s*;/s);
  assert.match(html, /body\.light-mode \.panel-head\s*\{\s*background:\s*#fff\s*;/s);
  assert.match(html, /\.panel-head\s*\{[^}]*border-radius:\s*12px 12px 0 0/s);
  // 4) Doi theme khong ghi de class popup-docked (classList thay vi className)
  assert.doesNotMatch(renderer, /document\.body\.className\s*=/);
  assert.match(renderer, /document\.body\.classList\.toggle\('dark-mode'/);
  assert.match(renderer, /document\.body\.classList\.toggle\('light-mode'/);
  assert.match(renderer, /document\.body\.classList\.remove\('dark-mode'\)/);
  assert.match(renderer, /document\.body\.classList\.add\('light-mode'\)/);
});

test('v2.5.39 Zalo stability: backgroundThrottling off, bounded auto-reload on failure, cache clean keeps login', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  // P0: BrowserView cua Zalo khong bi Chromium giam timer khi an (nhan tin den khong duoc cham)
  assert.match(main, /new BrowserView\(\{ webPreferences: \{[^}]*backgroundThrottling: false/);
  // P1a: tu tai lai khi loi — chi main frame, bo qua ERR_ABORTED (-3), gioi han 3 lan, cach 5 giay, reset khi tai xong
  assert.match(main, /did-fail-load', \(event, errorCode, errorDescription, validatedURL, isMainFrame\)/);
  assert.match(main, /if \(!isMainFrame \|\| errorCode === -3\) return;/);
  assert.match(main, /const MAX_AUTO_RELOAD = 3;/);
  assert.match(main, /setTimeout\(\(\) => \{ if \(!contents\.isDestroyed\(\)\) contents\.reload\(\); \}, 5000\)/);
  assert.match(main, /render-process-gone', \(event, details\)/);
  assert.match(main, /details\.reason === 'clean-exit' \|\| details\.reason === 'killed'/);
  assert.match(main, /contents\.on\('unresponsive'/);
  assert.match(main, /autoReloadAttempts = 0; \/\/ trang da tai xong/);
  // P1b: don cache giu dang nhap — chi xoa HTTP cache, code cache, CacheStorage, ServiceWorker
  assert.match(main, /ipcMain\.handle\('profile-clear-cache'/);
  assert.match(main, /await sess\.clearCache\(\)/);
  assert.match(main, /await sess\.clearCodeCaches\(\{\}\)/);
  assert.match(main, /await sess\.clearStorageData\(\{ storages: \['cachestorage', 'serviceworkers'\] \}\)/);
  // khong duoc xoa cookies / localStorage / IndexedDB — mat tin nhan + mat dang nhap
  assert.doesNotMatch(main, /clearStorageData\(\{ storages: \[[^\]]*'cookies'/);
  assert.doesNotMatch(main, /clearStorageData\(\{ storages: \[[^\]]*'indexdb'/);
  assert.doesNotMatch(main, /clearStorageData\(\{ storages: \[[^\]]*'localstorage'/);
  // UI: nut "Dọn cache (giữ đăng nhập)" trong modal chinh sua tai khoan
  assert.match(html, /id="modal-clear-cache"[^>]*>Dọn cache \(giữ đăng nhập\)<\/button>/);
  assert.match(renderer, /getElementById\('modal-clear-cache'\)\.onclick/);
  assert.match(renderer, /ipcRenderer\.invoke\('profile-clear-cache', editingProfile\.id\)/);
  assert.match(renderer, /getElementById\('modal-clear-cache'\)\.style\.display = profileToEdit \? 'inline-flex' : 'none'/);
});

test('v2.5.40 conversation diag: đếm hội thoại Zalo sau khi tải, chỉ cảnh báo khi ở chat.zalo.me, không đọc dữ liệu đăng nhập', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  // Ham chan doan duoc goi sau did-finish-load cho Zalo
  assert.match(main, /scheduleConversationDiag\(contents, profileId\)/);
  assert.match(main, /function scheduleConversationDiag\(contents, profileId\)/);
  // Cho 6s de Zalo render list roi moi dem
  assert.match(main, /\}, 6000\);/);
  // Chi chay khi dang o chat.zalo.me (bo qua man hinh dang nhap id.zalo.me de count=0 khong bi bao oan)
  assert.match(main, /if \(!url\.includes\('chat\.zalo\.me'\)\) return;/);
  // Do cache bang getCacheSize tren dung partition cua profile
  assert.match(main, /getCacheSize\(\)/);
  assert.match(main, /session\.fromPartition\(p\.partition\)/);
  // Chan doan khong duoc doc cookies / localStorage / IndexedDB cua Zalo (chi phan code, bo qua comment)
  const diagFn = main.slice(main.indexOf('function scheduleConversationDiag'), main.indexOf('function setupDownloads'));
  const diagCode = diagFn.slice(diagFn.indexOf('setTimeout'));
  assert.doesNotMatch(diagCode, /cookies\./);
  assert.doesNotMatch(diagCode, /localStorage\.getItem|localStorage\.setItem/);
  assert.doesNotMatch(diagCode, /\.getStorageData\s*\(/);
  // Gui canh bao cho renderer
  assert.match(main, /sendToRenderer\('zalo-conversation-diag'/);
  // Renderer: chi bao khi dung nick dang mo, chan spam 60s, khong dung khi khong phai profile dang hoat dong
  assert.match(renderer, /ipcRenderer\.on\('zalo-conversation-diag'/);
  assert.match(renderer, /payload\.profileId !== activeProfileId\) return;/);
  assert.match(renderer, /zalo-diag-.*payload\.profileId/);
  assert.match(renderer, /< 60000\) return;/);
  assert.match(renderer, /Dọn cache \(giữ đăng nhập\)/);
});
