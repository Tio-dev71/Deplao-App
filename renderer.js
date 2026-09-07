const { ipcRenderer, shell, clipboard } = require('electron');
const { buildBulkGroupPlan, filterAndSortGroups, findAmbiguousGroupNames, getLeavePolicyWaitMs, LEAVE_GROUP_POLICY } = require('./modules/zalo-group-scan');
const { filterAndSortUsers } = require('./modules/zalo-user-management');
const {
  calculateStandardQuote,
  buildQuoteText,
  extractOrderCode,
  findGroupMapping,
  findScannedGroupByName,
  upsertGroupMapping,
} = require('./modules/crm-panel');

const profilesList = document.getElementById('profiles-list');
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const nameInput = document.getElementById('profile-name-input');
const proxyInput = document.getElementById('profile-proxy-input');
const platformInput = document.getElementById('profile-platform-input');
const avatarPreview = document.getElementById('avatar-preview');
const avatarImg = document.getElementById('avatar-img');
const avatarLetter = document.getElementById('avatar-letter');
const avatarInput = document.getElementById('avatar-input');

const overlayIds = [
  'dashboard-overlay',
  'workspace-overlay',
  'crm-overlay',
  'campaign-overlay',
  'ai-overlay',
  'quick-replies-overlay',
  'video-library-overlay',
  'zalo-groups-overlay',
  'zalo-users-overlay',
  'personal-messages-overlay',
  'group-messages-overlay',
  'remote-control-overlay',
  'modal-overlay',
  'update-overlay',
  'downloads-overlay',
];

// Các popup công cụ neo cạnh phải: Zalo vẫn thấy và vẫn dùng được bên trái popup.
const DOCKED_OVERLAY_IDS = new Set([
  'quick-replies-overlay',
  'video-library-overlay',
  'zalo-groups-overlay',
  'zalo-users-overlay',
  'personal-messages-overlay',
  'group-messages-overlay',
  'remote-control-overlay',
  'update-overlay',
  'downloads-overlay',
  'dashboard-overlay',
  'workspace-overlay',
  'crm-overlay',
  'campaign-overlay',
  'ai-overlay',
]);
const POPUP_WIDTH_KEY = 'nha-yen-popup-width';
const POPUP_DEFAULT_WIDTH = 560;

const defaultState = {
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

let workspaceState = ipcRenderer.sendSync('workspace-get-state') || { currentId: 'default', workspaces: [], data: defaultState };
let workspaceData = normalizeWorkspaceData(workspaceState.data);
let profiles = normalizeProfiles(workspaceData.profiles);
let activeProfileId = profiles[0]?.id || null;
let downloads = [];
const profileConnectionStates = new Map();
let updateState = { status: 'idle', progress: 0, message: '' };
let appLocked = false;
let hasLockPassword = false;
let isDarkMode = true;
let editingProfile = null;
let tempAvatarPath = null;
let activeZaloGroupScan = null;
let zaloGroupScanFailures = [];
let zaloGroupScanGroups = [];
let selectedZaloGroupIds = new Set();
let zaloGroupSelect50Ids = new Set();
let activeZaloUserScan = null;
let zaloUsers = [];
let selectedZaloUserIds = new Set();
let zaloUserSelect50Ids = new Set();
let zaloUserActionRunning = false;
let bulkMessageStopRequested = false;
let pendingQuickReplyImagePath = '';
let videoLibraryItems = [];
let videoLibraryRoot = '';
let selectedVideoLibraryId = '';
let editingVideoLibraryId = '';
let zaloGroupAction = { mode: null, running: false, stopRequested: false };
let editingContactId = null;
let selectedCampaignId = null;
let currentChatSnapshot = null;
let campaignTimers = {};
let currentCampaignTargetSource = 'recent';
const campaignTargetSelections = {
  crm: new Set(),
  recent: new Set(),
};
const subscriptionFeatures = { maxAccountsPerApp: null, unlimitedProxies: true };
let remoteHostPeer = null;
let remoteHostSignal = null;
let remoteHostStream = null;
let remoteHostChannel = null;
let remoteHostPointerChannel = null;
let quotePaperType = 'nhunu';
let currentResolvedGroup = null;
let crmConnected = false;
let crmAccounts = [];
let crmConversation = null;
let selectedDesignOrder = null;
let designStatusFilter = '';
let pancakeWarehouses = [];
let pancakeProducts = [];
let pancakeProductCache = null;
let pancakeItems = [];
let currentPancakeLink = null;
// Nut Tạo đơn tren topbar: popup ket qua co the o che do loi (mau do, khong cho sao chep)
// va co the kem nut Huy de don don thu 0d tao tu dong.
let pancakePopupMode = 'success';
let pancakeTestOrderCode = '';
let currentUtilityTab = 'quote';

function normalizeWorkspaceData(data = {}) {
  return {
    ...defaultState,
    ...data,
    profiles: Array.isArray(data.profiles) ? data.profiles : [],
    quickReplies: Array.isArray(data.quickReplies) ? data.quickReplies : [],
    crmContacts: Array.isArray(data.crmContacts) ? data.crmContacts : [],
    campaigns: Array.isArray(data.campaigns) ? data.campaigns : [],
    analyticsEvents: Array.isArray(data.analyticsEvents) ? data.analyticsEvents : [],
    recentChats: sanitizeRecentChats(data.recentChats),
    aiSettings: { ...defaultState.aiSettings, ...(data.aiSettings || {}) },
    groupMappings: Array.isArray(data.groupMappings) ? data.groupMappings : [],
    designOrders: Array.isArray(data.designOrders) ? data.designOrders : [],
    crmAccountMappings: data.crmAccountMappings && typeof data.crmAccountMappings === 'object' ? data.crmAccountMappings : {},
  };
}
function createProfileId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function createProfilePartition(id, platform = 'zalo') {
  const safePlatform = String(platform || 'zalo').replace(/[^a-z0-9_-]/gi, '').toLowerCase();
  return `persist:${safePlatform}_${id}`;
}

function normalizeProfiles(list) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return [];
  const usedIds = new Set();
  const usedPartitions = new Set();
  return arr.map((p) => {
    let avatarUrl = p.avatar;
    if (avatarUrl && !avatarUrl.startsWith('http') && !avatarUrl.startsWith('data:')) {
      avatarUrl = '';
    }
    let id = p.id || createProfileId();
    while (usedIds.has(id)) id = createProfileId();
    usedIds.add(id);

    const platform = p.platform || 'zalo';
    let partition = p.partition || createProfilePartition(id, platform);
    if (usedPartitions.has(partition)) {
      partition = createProfilePartition(`${id}_${Math.random().toString(36).slice(2, 8)}`, platform);
    }
    usedPartitions.add(partition);

    return { ...p, id, avatar: avatarUrl, platform, partition };
  });
}
function persistWorkspace() {
  workspaceData.profiles = profiles;
  workspaceData = normalizeWorkspaceData(workspaceData);
  workspaceState = ipcRenderer.sendSync('workspace-save-data', workspaceData);
  workspaceData = normalizeWorkspaceData(workspaceState.data);
  profiles = normalizeProfiles(workspaceData.profiles);
  if (!profiles.some((p) => p.id === activeProfileId)) activeProfileId = profiles[0]?.id || null;
}
function trackEvent(type, payload = {}) {
  workspaceData.analyticsEvents.unshift({ id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, type, payload, createdAt: Date.now() });
  workspaceData.analyticsEvents = workspaceData.analyticsEvents.slice(0, 120);
  persistWorkspace();
  renderDashboard();
}
function getSavedPopupWidth() {
  const saved = Number(localStorage.getItem(POPUP_WIDTH_KEY)) || POPUP_DEFAULT_WIDTH;
  return Math.max(380, Math.min(620, Math.round(saved)));
}
function applyPopupDockWidth(width, persist = false) {
  const safeWidth = Math.max(380, Math.min(620, Math.round(Number(width) || POPUP_DEFAULT_WIDTH)));
  document.documentElement.style.setProperty('--popup-width', `${safeWidth}px`);
  ipcRenderer.send('set-popup-width', safeWidth);
  if (persist) localStorage.setItem(POPUP_WIDTH_KEY, String(safeWidth));
  return safeWidth;
}
function releasePopupDock() {
  document.body.classList.remove('popup-docked');
  const resizer = document.getElementById('popup-resizer');
  if (resizer) resizer.hidden = true;
  ipcRenderer.send('set-popup-width', 0);
}
function openOverlay(id) {
  setUtilityPanelOpen(false);
  for (const overlayId of overlayIds) {
    if (overlayId !== id) {
      const other = document.getElementById(overlayId);
      if (other) other.style.display = 'none';
    }
  }
  if (id !== 'quick-replies-overlay') {
    const quickButton = document.getElementById('quick-replies-topbar');
    if (quickButton) { quickButton.classList.remove('active'); quickButton.setAttribute('aria-expanded', 'false'); }
  }
  if (id !== 'video-library-overlay') document.getElementById('send-video-topbar')?.classList.remove('active');
  const docked = DOCKED_OVERLAY_IDS.has(id);
  document.body.classList.toggle('popup-docked', docked);
  const resizer = document.getElementById('popup-resizer');
  if (resizer) resizer.hidden = !docked;
  if (docked) {
    // Không ẩn Zalo: chỉ thu hẹp BrowserView đúng bằng bề rộng popup.
    applyPopupDockWidth(getSavedPopupWidth());
    if (!appLocked) ipcRenderer.send('set-browserview-visibility', true);
  } else {
    ipcRenderer.send('set-popup-width', 0);
    ipcRenderer.send('set-browserview-visibility', false);
  }
  document.getElementById(id).style.display = 'flex';
}
function toggleToolOverlay(id) {
  const target = document.getElementById(id);
  if (!target) return false;
  const shouldOpen = target.style.display !== 'flex';
  if (shouldOpen) openOverlay(id); else closeOverlay(id);
  document.querySelectorAll('.nav-tool').forEach((button) => {
    button.classList.toggle('active', shouldOpen && TOOL_OVERLAY_BY_ACTION[button.dataset.toolAction] === id);
  });
  if (id === 'quick-replies-overlay') {
    const topbar = document.getElementById('quick-replies-topbar');
    if (topbar) { topbar.classList.toggle('active', shouldOpen); topbar.setAttribute('aria-expanded', String(shouldOpen)); }
  }
  return shouldOpen;
}
function closeOverlay(id) {
  document.getElementById(id).style.display = 'none';
  document.querySelectorAll('.nav-tool').forEach((button) => {
    if (TOOL_OVERLAY_BY_ACTION[button.dataset.toolAction] === id) button.classList.remove('active');
  });
  if (id === 'quick-replies-overlay') {
    const topbar = document.getElementById('quick-replies-topbar');
    if (topbar) { topbar.classList.remove('active'); topbar.setAttribute('aria-expanded', 'false'); }
  }
  if (id === 'video-library-overlay') document.getElementById('send-video-topbar')?.classList.remove('active');
  const stillOpen = overlayIds.some((overlayId) => document.getElementById(overlayId) && document.getElementById(overlayId).style.display === 'flex');
  const stillDocked = overlayIds.some((overlayId) => DOCKED_OVERLAY_IDS.has(overlayId)
    && document.getElementById(overlayId) && document.getElementById(overlayId).style.display === 'flex');
  if (!stillDocked) releasePopupDock();
  if (!stillOpen && !appLocked && !toolsLauncherOpen) ipcRenderer.send('set-browserview-visibility', true);
}
function closeAllToolOverlays() {
  overlayIds.forEach((id) => {
    const overlay = document.getElementById(id);
    if (overlay?.style.display === 'flex') closeOverlay(id);
  });
}
function escapeHtml(s) { return String(s || '').replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
// Doi duong dan tuyet doi thanh file:// de dung lam anh nen CSS.
function fileUrlFromPath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  if (!normalized) return '';
  return `file:///${encodeURI(normalized.replace(/^\/+/, ''))}`;
}

// 0:07 / 1:42 / 1:02:03
function formatVideoDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function formatFileSize(bytes) {
  const value = Number(bytes) || 0;
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`;
}
async function loadVideoLibrary() {
  const result = await ipcRenderer.invoke('video-library:list');
  const status = document.getElementById('video-library-status');
  if (!result?.ok) { if (status) status.innerText = result?.message || 'Không đọc được thư viện video.'; return; }
  videoLibraryItems = result.items || [];
  videoLibraryRoot = result.mediaRoot || '';
  renderVideoLibrary();
}
// Hop xac nhan nam trong popup: khong dung hop thoai cua Windows (se chan va che Zalo).
let pendingVideoDeleteId = '';
function askDeleteVideo(item) {
  const box = document.getElementById('video-library-confirm');
  const text = document.getElementById('video-library-confirm-text');
  if (!box || !text) { void deleteVideoById(item.id); return; }
  pendingVideoDeleteId = item.id;
  text.innerText = `Xóa video “${item.name}” khỏi thư viện? Tệp được chuyển vào thùng rác của kho media.`;
  box.hidden = false;
  box.scrollIntoView({ block: 'nearest' });
}
async function deleteVideoById(id) {
  const status = document.getElementById('video-library-status');
  const result = await ipcRenderer.invoke('video-library:remove', id);
  if (result?.ok) {
    videoLibraryItems = result.items || [];
    if (selectedVideoLibraryId === id) selectedVideoLibraryId = '';
    renderVideoLibrary();
  } else if (status) {
    status.innerText = result?.message || 'Không xóa được video.';
  }
}

function renderVideoLibrary() {
  const list = document.getElementById('video-library-list');
  const status = document.getElementById('video-library-status');
  if (!list || !status) return;
  const visible = videoLibraryItems;
  status.innerText = `${videoLibraryItems.length} video · tối đa 20 MB/video · kho: ${videoLibraryRoot || 'dữ liệu Nhà Yến Zalo'}`;
  list.innerHTML = visible.length ? visible.map((item) => `<label class="video-library-row ${selectedVideoLibraryId === item.id ? 'selected' : ''}">
    <input type="radio" name="video-library-selection" value="${escapeHtml(item.id)}" ${selectedVideoLibraryId === item.id ? 'checked' : ''}>
    <button class="video-library-play icon-button ${item.thumbnailPath ? 'has-thumb' : ''}" type="button" title="Xem video" aria-label="Xem video" data-video-preview="${escapeHtml(item.id)}"${item.thumbnailPath ? ` style="background-image:url('${escapeHtml(fileUrlFromPath(item.thumbnailPath))}')"` : ''}>▶</button><span class="video-library-info">${editingVideoLibraryId === item.id
      ? `<span class="video-rename-editor"><input class="modal-input" data-video-name="${escapeHtml(item.id)}" value="${escapeHtml(item.name)}" aria-label="Tên video mới"><button class="icon-button save-icon" type="button" title="Lưu tên" aria-label="Lưu tên" data-video-rename-save="${escapeHtml(item.id)}">✓</button><button class="icon-button" type="button" title="Hủy" aria-label="Hủy đổi tên" data-video-rename-cancel="${escapeHtml(item.id)}">×</button></span>`
      : `<strong>${escapeHtml(item.name)}</strong>`}<span class="muted">${formatFileSize(item.size)}${item.duration ? ` · <span class="video-duration">${formatVideoDuration(item.duration)}</span>` : ''}${item.thumbnailError ? ' · <span class="qr-error">không tạo được ảnh nền</span>' : ''}</span></span>
    <button class="icon-button" type="button" title="Đổi tên" aria-label="Đổi tên video" data-video-rename="${escapeHtml(item.id)}">✎</button>
    <button class="icon-button danger-icon" type="button" title="Xóa" aria-label="Xóa video" data-video-remove="${escapeHtml(item.id)}">🗑</button>
  </label>`).join('') : '<div class="empty-state">Chưa có video phù hợp. Bấm “Thêm video”.</div>';
  list.querySelectorAll('input[name="video-library-selection"]').forEach((input) => input.onchange = () => { selectedVideoLibraryId = input.value; renderVideoLibrary(); });
  list.querySelectorAll('[data-video-remove]').forEach((button) => button.onclick = async (event) => {
    event.preventDefault(); event.stopPropagation();
    const id = button.getAttribute('data-video-remove'); const item = videoLibraryItems.find((entry) => entry.id === id);
    if (!item) return;
    askDeleteVideo(item);
  });
  list.querySelectorAll('[data-video-preview]').forEach((button) => button.onclick = async (event) => {
    event.preventDefault(); event.stopPropagation();
    const result = await ipcRenderer.invoke('video-library:preview', button.getAttribute('data-video-preview'));
    if (!result?.ok) status.innerText = result?.message || 'Không mở được video.';
  });
  list.querySelectorAll('[data-video-rename]').forEach((button) => button.onclick = (event) => {
    event.preventDefault(); event.stopPropagation();
    editingVideoLibraryId = button.getAttribute('data-video-rename'); renderVideoLibrary();
    const input = list.querySelector(`[data-video-name="${CSS.escape(editingVideoLibraryId)}"]`); input?.focus(); input?.select();
  });
  list.querySelectorAll('[data-video-rename-cancel]').forEach((button) => button.onclick = (event) => { event.preventDefault(); event.stopPropagation(); editingVideoLibraryId = ''; renderVideoLibrary(); });
  list.querySelectorAll('[data-video-rename-save]').forEach((button) => button.onclick = async (event) => {
    event.preventDefault(); event.stopPropagation();
    const id = button.getAttribute('data-video-rename-save'); const name = list.querySelector(`[data-video-name="${CSS.escape(id)}"]`)?.value || '';
    const result = await ipcRenderer.invoke('video-library:rename', { id, name });
    if (result?.ok) { videoLibraryItems = result.items || []; editingVideoLibraryId = ''; renderVideoLibrary(); }
    else status.innerText = result?.message || 'Không đổi được tên video.';
  });
  document.getElementById('video-library-stage').disabled = !selectedVideoLibraryId;
}
function platformIcon(platform) { return { zalo: 'Z', telegram: '✈', messenger: 'M', fanpage: '🚩', facebook: 'F', whatsapp: 'W', teams: 'T', gmail: 'G', custom: '🔗' }[platform || 'zalo'] || 'A'; }
function formatDate(ts) { return new Date(ts || Date.now()).toLocaleString('vi-VN'); }
function getActiveProfile() { return profiles.find((p) => p.id === activeProfileId) || profiles[0] || null; }
function getZaloProfiles() { return profiles.filter((profile) => (profile.platform || 'zalo') === 'zalo'); }
function getCurrentWorkspaceName() { return workspaceState.workspaces.find((w) => w.id === workspaceState.currentId)?.name || 'Workspace'; }
function statusLabel(status) { return ({ new: 'Mới', hot: 'Khách nóng', follow: 'Đang chăm sóc', bought: 'Đã mua', blacklist: 'Blacklist' }[status] || status || 'Mới'); }
function sanitizeRecentChats(list = []) {
  const blocked = ['tin nhắn', 'danh bạ', 'zalo cloud', 'công cụ', 'giao việc', 'lịch sử đồng bộ', 'cài đặt'];
  return (Array.isArray(list) ? list : [])
    .map((name) => String(name || '').normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim())
    .filter((name, index, arr) => {
      if (!name) return false;
      const lower = name.toLowerCase();
      if (blocked.some((keyword) => lower === keyword || lower.includes(keyword))) return false;
      return arr.indexOf(name) === index;
    });
}
function randomBetween(min, max) {
  const low = Number(min) || 1000;
  const high = Number(max) || low;
  return Math.floor(low + Math.random() * Math.max(high - low, 1));
}
let toolsLauncherOpen = false;
const TOOL_ACTION_HANDLERS = {
  crm: () => { renderCRMCurrentChat(); openOverlay('crm-overlay'); },
  campaigns: () => { renderCampaigns(); openOverlay('campaign-overlay'); },
  ai: () => { fillAISettings(); openOverlay('ai-overlay'); },
  'quick-replies': () => { renderQuickReplies(); toggleToolOverlay('quick-replies-overlay'); },
  'zalo-groups': () => { renderZaloProfileSelectors(); renderZaloGroupScan(); toggleToolOverlay('zalo-groups-overlay'); },
  'zalo-users': () => { renderZaloProfileSelectors(); renderZaloUsers(); toggleToolOverlay('zalo-users-overlay'); },
  'personal-messages': () => { renderBulkMessageSummary('personal'); toggleToolOverlay('personal-messages-overlay'); },
  'group-messages': () => { renderBulkMessageSummary('group'); toggleToolOverlay('group-messages-overlay'); },
  'remote-control': async () => { if (toggleToolOverlay('remote-control-overlay')) renderRemoteControl(await ipcRenderer.invoke('remote-control:state')); },
  update: () => { if (toggleToolOverlay('update-overlay')) { ipcRenderer.send('check-for-updates'); ipcRenderer.send('get-update-state'); } },
  lock: () => ipcRenderer.send('lock-app'),
  shield: () => ipcRenderer.send('toggle-zadark-shield'),
  'dark-mode': () => {
    isDarkMode = !isDarkMode;
    document.body.classList.toggle('dark-mode', isDarkMode);
    document.body.classList.toggle('light-mode', !isDarkMode);
    document.getElementById('icon-sun').style.display = isDarkMode ? 'none' : 'block';
    document.getElementById('icon-moon').style.display = isDarkMode ? 'block' : 'none';
    ipcRenderer.send('set-theme', isDarkMode);
  },
  'zoom-in': () => ipcRenderer.send('zoom-in'),
  'zoom-out': () => ipcRenderer.send('zoom-out'),
  fullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  pin: () => {
    document.getElementById('btn-pin').classList.toggle('active');
    ipcRenderer.send('toggle-always-on-top');
  },
  reload: () => ipcRenderer.send('reload-page'),
};
const TOOL_OVERLAY_BY_ACTION = {
  'zalo-users': 'zalo-users-overlay', 'zalo-groups': 'zalo-groups-overlay',
  'quick-replies': 'quick-replies-overlay', 'remote-control': 'remote-control-overlay', update: 'update-overlay',
  'personal-messages': 'personal-messages-overlay', 'group-messages': 'group-messages-overlay',
};

function renderZaloProfileSelectors() {
  const options = getZaloProfiles().map((profile) => `<option value="${escapeHtml(profile.id)}"${profile.id === activeProfileId ? ' selected' : ''}>${escapeHtml(profile.zaloDisplayName || profile.name)}${profileConnectionStates.get(profile.id) === 'connected' ? ' • Đã đăng nhập' : ''}</option>`).join('');
  for (const id of ['zalo-users-profile-select', 'zalo-groups-profile-select']) {
    const select = document.getElementById(id);
    if (select) select.innerHTML = options || '<option value="">Chưa có nick Zalo</option>';
  }
}

function formatMoney(value) {
  return `${Math.round(Number(value) || 0).toLocaleString('vi-VN')}đ`;
}
function parsePancakeNumber(value) {
  return Math.max(0, Number(String(value ?? '').replace(/[^0-9-]/g, '')) || 0);
}
function formatPancakeNumber(value) {
  return Math.round(Number(value) || 0).toLocaleString('en-US');
}
function formatPancakeMoney(value) {
  return `${formatPancakeNumber(value)}đ`;
}

function getCurrentGroupContext() {
  const profileId = currentChatSnapshot?.profileId || activeProfileId;
  const name = String(currentChatSnapshot?.name || '').trim();
  if (!profileId || !name) return { status: 'missing', profileId, name, group: null, mapping: null };
  if (crmConversation?.externalThreadId && crmConversation?.id) {
    const group = { groupId: String(crmConversation.externalThreadId), name };
    return { status: 'resolved', profileId, name, group, mapping: findGroupMapping(workspaceData.groupMappings, profileId, group.groupId) };
  }
  const scanned = activeZaloGroupScan?.profileId === profileId ? findScannedGroupByName(zaloGroupScanGroups, name) : { status: 'missing', matches: [] };
  if (scanned.status === 'unique') {
    const group = scanned.matches[0];
    return { status: 'resolved', profileId, name, group, mapping: findGroupMapping(workspaceData.groupMappings, profileId, group.groupId) };
  }
  if (scanned.status === 'ambiguous') return { status: 'ambiguous', profileId, name, group: null, mapping: null };
  const known = workspaceData.groupMappings.filter((entry) => entry.profileId === profileId && (entry.currentName === name || (entry.nameHistory || []).some((item) => item.name === name)));
  if (known.length === 1) return { status: 'resolved', profileId, name, group: { groupId: known[0].groupId, name }, mapping: known[0] };
  return { status: 'unscanned', profileId, name, group: null, mapping: null };
}

function renderUtilityContext() {
  const profile = getActiveProfile();
  const context = getCurrentGroupContext();
  currentResolvedGroup = context.status === 'resolved' ? context.group : null;
  const box = document.getElementById('utility-context');
  if (!box) return;
  if (!profile) box.innerHTML = 'Chưa có nick Zalo.';
  else if (!currentChatSnapshot?.name) box.innerHTML = `<b>${escapeHtml(profile.zaloDisplayName || profile.name)}</b> · mở một cuộc trò chuyện.`;
  else box.innerHTML = `<b>${escapeHtml(profile.zaloDisplayName || profile.name)}</b> · ${escapeHtml(currentChatSnapshot.name)}`;
}

function renderGroupMappingPanel(context = getCurrentGroupContext()) {
  const card = document.getElementById('group-mapping-card');
  const list = document.getElementById('mapping-list');
  if (!card) return;
  if (context.status === 'resolved') {
    const mapping = context.mapping;
    card.innerHTML = `<span class="mapping-state ${mapping ? 'linked' : ''}">${mapping ? 'Đã ánh xạ' : 'Đã xác định groupId'}</span><h4>${escapeHtml(context.name)}</h4><p>groupId: ${escapeHtml(context.group.groupId)}</p><p>${mapping?.orderCode ? `Mã đơn: ${escapeHtml(mapping.orderCode)}` : 'Chưa liên kết mã đơn.'}</p>`;
    document.getElementById('mapping-order-code').value = mapping?.orderCode || extractOrderCode(context.name);
  } else if (context.status === 'ambiguous') card.innerHTML = '<span class="mapping-state">Cần xác nhận</span><h4>Tên nhóm bị trùng</h4><p>Danh sách quét có nhiều nhóm cùng tên. Hãy đổi tên tạm thời hoặc mở từ danh sách có groupId.</p>';
  else card.innerHTML = `<span class="mapping-state">Chưa xác định</span><h4>${escapeHtml(context.name || 'Chưa mở nhóm')}</h4><p>Quét nhóm bằng đúng nick hiện tại rồi mở lại nhóm để lấy groupId.</p>`;
  if (list) list.innerHTML = workspaceData.groupMappings.length ? workspaceData.groupMappings.slice(0, 20).map((item) => `<div class="mapping-card"><h4>${escapeHtml(item.currentName || item.groupId)}</h4><p>${escapeHtml(item.orderCode || 'Chưa có mã đơn')} · ${escapeHtml(item.groupId)}</p></div>`).join('') : '<div class="empty-state">Chưa có nhóm nào được ánh xạ.</div>';
  document.getElementById('design-current-group').innerText = context.status === 'resolved' ? `${context.name} · ${context.mapping?.orderCode || 'chưa có mã đơn'}` : 'Chưa xác định groupId của nhóm đang mở.';
}

function renderQuote() {
  const quantity = Number(document.getElementById('quote-quantity')?.value) || 0;
  const emboss = !!document.getElementById('quote-emboss')?.checked;
  const positions = Number(document.getElementById('quote-emboss-positions')?.value) || 1;
  const result = calculateStandardQuote({ type: quotePaperType, quantity, emboss, embossPositions: positions });
  document.getElementById('quote-emboss').disabled = quotePaperType === 'gap3in1';
  document.getElementById('quote-emboss-fields').hidden = !result.embossEnabled;
  const show = (id, value) => { document.getElementById(id).innerText = result.valid ? value : '—'; };
  show('quote-unit-price', `${formatMoney(result.unitPrice)}/bộ`);
  show('quote-paper-cost', formatMoney(result.paperCost));
  show('quote-emboss-cost', result.embossEnabled ? formatMoney(result.embossCost) : '—');
  show('quote-total', formatMoney(result.total));
  show('quote-average', `${formatMoney(result.average)}/bộ`);
  document.getElementById('quote-insert').disabled = !result.valid;
  document.getElementById('quote-copy').disabled = !result.valid;
  return result;
}

function quoteOptions() {
  return {
    type: quotePaperType,
    quantity: Number(document.getElementById('quote-quantity').value) || 0,
    emboss: document.getElementById('quote-emboss').checked,
    embossPositions: Number(document.getElementById('quote-emboss-positions').value) || 1,
  };
}

async function refreshCurrentChatSnapshot() {
  const result = await ipcRenderer.invoke('active-chat:get-info', activeProfileId).catch(() => null);
  if (result?.ok && result.name) {
    currentChatSnapshot = result;
    renderCRMCurrentChat();
    renderUtilityContext();
  }
  return result;
}

async function setUtilityTab(tab) {
  currentUtilityTab = tab;
  document.querySelectorAll('[data-utility-tab]').forEach((button) => button.classList.toggle('active', button.dataset.utilityTab === tab));
  document.querySelectorAll('.utility-pane').forEach((pane) => pane.classList.toggle('active', pane.id === `utility-pane-${tab}`));
  const titles = { quote: 'Báo giá thiệp cưới', design: 'Đơn thiết kế', orders: 'Đơn Pancake' };
  document.getElementById('utility-panel-title').innerText = titles[tab] || 'Nghiệp vụ Nhà Yến';
  // Don Pancake khong dung CRM: an badge CRM + an nut Lam moi khi khong phai tab orders.
  const refreshCurrentButton = document.getElementById('pancake-refresh-current');
  refreshCurrentButton.hidden = tab !== 'orders';
  renderCrmConnection();
  if (tab !== 'quote') {
    const chat = await refreshCurrentChatSnapshot();
    if (tab === 'design' && chat?.ok) {
      const code = extractOrderCode(chat.name || '');
      if (code) document.getElementById('design-search').value = code;
    }
    renderUtilityContext();
  }
  // orders tab: Don Pancake chi can Pancake API, khong can CRM; design tab van can CRM
  if (tab === 'orders') void Promise.allSettled([refreshPancakeCurrent(), loadPancakeWarehouses(), loadPancakeOrders()]);
  if (crmConnected && tab === 'design') void Promise.allSettled([resolveCrmConversation({ quiet: true }), loadDesigners(), loadDesignOrders()]);
}

function setUtilityPanelOpen(open, tab = currentUtilityTab) {
  if (open) {
    closeAllToolOverlays();
    void setUtilityTab(tab);
  }
  const width = open ? getSavedPopupWidth() : 0;
  document.documentElement.style.setProperty('--utility-panel-width', `${width}px`);
  document.getElementById('crm-utility-panel').classList.toggle('collapsed', !open);
  const toggles = { quote: 'quote-panel-toggle', design: 'design-orders-topbar', orders: 'pancake-orders-topbar' };
  Object.entries(toggles).forEach(([name, id]) => {
    const button = document.getElementById(id);
    const active = open && name === tab;
    button?.classList.toggle('active', active);
    button?.setAttribute('aria-expanded', String(active));
  });
  ipcRenderer.send('set-utility-panel-width', width);
}

function toggleUtilityPanel(tab) {
  const open = !document.getElementById('crm-utility-panel').classList.contains('collapsed');
  setUtilityPanelOpen(!(open && currentUtilityTab === tab), tab);
}

async function crmRequest(path, method = 'GET', body) {
  const result = await ipcRenderer.invoke('crm:request', { path, method, body });
  if (!result?.ok) throw new Error(result?.message || 'Không gọi được Nhà Yến CRM.');
  return result.data;
}

// Goi thang Pancake POS API qua main process (giu API key o main, khong lo ra renderer).
async function pancakeRequest(path, method = 'GET', body) {
  const result = await ipcRenderer.invoke('pancake:request', { path, method, body });
  if (!result?.ok) throw new Error(result?.message || 'Không gọi được Pancake.');
  return result.data;
}

// Loc bo cac truong thua truoc khi POST truc tiep sang Pancake. Pancake tu suy ra
// variation_info tu catalog nen khong can gui; cac truong con lai (note_print,
// charged_by_qrpay, is_free_shipping, ...) Pancake van nhan nen giu nguyen.
function pancakeApiPayload(payload = {}) {
  return {
    ...payload,
    items: (payload.items || []).map((item) => {
      const { variation_info, ...itemRest } = item;
      // Pancake lay don gia tu variation_info.retail_price; neu bo het variation_info thi PUT/POST se ghi gia ve 0.
      // Chi giu lai retail_price (khong gui name/detail) de tranh loi tru day.
      if (variation_info && Object.prototype.hasOwnProperty.call(variation_info, 'retail_price')) {
        itemRest.variation_info = { retail_price: Number(variation_info.retail_price) || 0 };
      }
      return itemRest;
    }),
  };
}

function selectedCrmAccountId() {
  return document.getElementById('crm-account-select')?.value || workspaceData.crmAccountMappings[activeProfileId] || '';
}

function renderCrmConnection() {
  const box = document.getElementById('crm-connection-box');
  const toggle = document.getElementById('crm-connection-toggle');
  document.getElementById('crm-login-form').hidden = crmConnected;
  document.getElementById('crm-connected').hidden = !crmConnected;
  // Don Pancake khong phu thuoc CRM nen an badge CRM khi o tab orders
  toggle.hidden = !crmConnected || currentUtilityTab === 'quote' || currentUtilityTab === 'orders';
  toggle.setAttribute('aria-expanded', String(!box.hidden));
  if (crmConnected) box.hidden = true;
  else box.hidden = currentUtilityTab === 'quote' || currentUtilityTab === 'orders';
  if (!crmConnected) return;
  const select = document.getElementById('crm-account-select');
  const current = workspaceData.crmAccountMappings[activeProfileId] || '';
  select.innerHTML = '<option value="">Chọn nick CRM</option>' + crmAccounts.map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.displayName || account.phone || account.id)}</option>`).join('');
  let next = current;
  if (!next) {
    const activeName = String(getActiveProfile()?.zaloDisplayName || getActiveProfile()?.name || '').trim().toLocaleLowerCase('vi-VN');
    const matches = crmAccounts.filter((account) => String(account.displayName || '').trim().toLocaleLowerCase('vi-VN') === activeName);
    if (matches.length === 1) next = matches[0].id;
  }
  select.value = next;
}

function conversationRows(data) {
  if (Array.isArray(data)) return data;
  return data?.conversations || data?.items || data?.data || [];
}

async function resolveCrmConversation({ quiet = false } = {}) {
  crmConversation = null;
  if (!crmConnected) { if (!quiet) throw new Error('Hãy kết nối Nhà Yến CRM trước.'); return null; }
  const accountId = selectedCrmAccountId();
  const chatName = String(currentChatSnapshot?.name || '').trim();
  if (!accountId) { if (!quiet) throw new Error('Hãy chọn đúng nick CRM tương ứng.'); return null; }
  if (!chatName) { if (!quiet) throw new Error('Hãy mở một nhóm Zalo.'); return null; }
  const localContext = getCurrentGroupContext();
  const expectedGroupId = localContext.group?.groupId || '';
  let data;
  try { data = await crmRequest(`/zalo-accounts/${encodeURIComponent(accountId)}/groups`); }
  catch (error) { if (quiet) return null; throw error; }
  const rows = data.groups || [];
  const exactId = expectedGroupId ? rows.filter((row) => String(row.id || row.groupId || '') === String(expectedGroupId)) : [];
  const normalize = (value) => String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('vi-VN');
  const exactName = rows.filter((row) => normalize(row.name || row.groupName) === normalize(chatName));
  const matches = exactId.length ? exactId : exactName;
  if (matches.length !== 1) {
    if (!quiet) throw new Error(matches.length > 1 ? 'CRM có nhiều nhóm cùng tên. Cần quét groupId để xác định chính xác.' : 'Nhóm này chưa có trong CRM hoặc nick CRM chưa đúng.');
    return null;
  }
  const matchedGroup = matches[0];
  const groupId = String(matchedGroup.id || matchedGroup.groupId || expectedGroupId || '');
  let ensured;
  try { ensured = await crmRequest(`/zalo-accounts/${encodeURIComponent(accountId)}/groups/${encodeURIComponent(groupId)}/ensure-conversation`, 'POST', {}); }
  catch (error) { if (quiet) return null; throw error; }
  crmConversation = { id: ensured.conversationId, externalThreadId: groupId, groupName: matchedGroup.name || chatName };
  if (groupId) {
    const next = upsertGroupMapping(workspaceData.groupMappings, {
      profileId: activeProfileId, groupId, groupName: chatName,
      orderCode: extractOrderCode(chatName), crmConversationId: crmConversation.id,
    });
    workspaceData.groupMappings = next.entries;
    persistWorkspace();
    currentResolvedGroup = { groupId, name: chatName };
  }
  renderUtilityContext();
  return crmConversation;
}

async function refreshPancakeCurrent() {
  const box = document.getElementById('pancake-current');
  try {
    // Pancake-only: khong phu thuoc CRM. Bat ma don tu ten hoi thoai Zalo hien tai.
    const code = String(currentChatSnapshot?.name || '').trim().match(/^(D[A-Z0-9_-]{2,39})(?:\s|$)/i)?.[1] || '';
    if (code) {
      document.getElementById('pancake-search').value = code;
      await loadPancakeOrders({ autoSelectCode: code });
      // loadPancakeOrderDetail (neu khop) da cap nhat box sang "Da tai" + h4 ma don.
      // Neu khong khop, hien goi y kiem tra thu cong.
      if (!currentPancakeLink || String(currentPancakeLink.orderCode || '').toLocaleUpperCase('vi-VN') !== code.toLocaleUpperCase('vi-VN')) {
        const status = document.getElementById('crm-status');
        if (status) status.innerText = `Da bat ma ${code} — dang kiem tra Pancake…`;
      }
      return;
    }
    currentPancakeLink = null;
    document.getElementById('pancake-create').innerText = 'Lưu thay đổi';
    box.innerHTML = '<span class="mapping-state">Tìm thủ công</span><h4>Chưa nhận diện mã đơn</h4><p>Nhập mã đơn Pancake ở ô tìm kiếm phía trên hoặc đổi hội thoại rồi bấm Làm mới.</p>';
  } catch (error) { box.innerHTML = `<span class="mapping-state">Lỗi</span><h4>Không tải được đơn</h4><p>${escapeHtml(error.message)}</p>`; }
}

function applyPancakeOrder(order) {
  document.getElementById('pancake-customer').value = order.customer?.name || '';
  document.getElementById('pancake-customer-chip-name').innerText = order.customer?.name || 'Chưa xác định khách hàng';
  document.getElementById('pancake-phone').value = order.customer?.phone || '';
  document.getElementById('pancake-address').value = order.customer?.address || '';
  if (order.warehouseId) document.getElementById('pancake-warehouse').value = order.warehouseId;
  document.getElementById('pancake-shipping').value = String(order.shippingFee || 0);
  document.getElementById('pancake-discount').value = String(order.discount || 0);
  document.getElementById('pancake-deposit').value = String(order.qrPay || 0);
  document.getElementById('pancake-note').value = order.note || '';
  document.getElementById('pancake-print-note').value = order.printNote || '';
  pancakeItems = (order.items || []).map((item) => ({ ...item, quantity: Number(item.quantity) || 1, price: Number(item.price) || 0 }));
  renderPancakeItems();
  renderPancakeSummary();
}

async function loadPancakeWarehouses() {
  const data = await pancakeRequest('/shops/609730/warehouses');
  pancakeWarehouses = data.warehouses || data.data || [];
  const select = document.getElementById('pancake-warehouse');
  select.innerHTML = '<option value="">Chọn kho</option>' + pancakeWarehouses.map((warehouse) => `<option value="${escapeHtml(warehouse.id)}">${escapeHtml(warehouse.name)}</option>`).join('');
  const preferred = pancakeWarehouses.find((warehouse) => warehouse.allow_create_order) || pancakeWarehouses[0];
  if (preferred) select.value = preferred.id;
}

function renderPancakeItems() {
  const box = document.getElementById('pancake-items');
  box.innerHTML = pancakeItems.length ? pancakeItems.map((item, index) => `<div class="pancake-item-row"><strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong><input class="modal-input" aria-label="Số lượng" data-item-qty="${index}" type="text" inputmode="numeric" value="${formatPancakeNumber(item.quantity)}"><input class="modal-input" aria-label="Đơn giá" data-item-price="${index}" type="text" inputmode="numeric" value="${formatPancakeNumber(item.price)}"><span class="pancake-line-total">${formatPancakeMoney((Number(item.quantity)||0)*(Number(item.price)||0))}</span><button class="icon-button danger-icon" title="Xóa sản phẩm" aria-label="Xóa sản phẩm" data-item-remove="${index}" type="button">×</button></div>`).join('') : '<div class="utility-empty">Chưa có sản phẩm nào.</div>';
  box.querySelectorAll('[data-item-qty]').forEach((input) => { input.onchange = () => { const item = pancakeItems[Number(input.dataset.itemQty)]; item.quantity = Math.max(1, parsePancakeNumber(input.value) || 1); input.value = formatPancakeNumber(item.quantity); renderPancakeItems(); }; });
  box.querySelectorAll('[data-item-price]').forEach((input) => { input.onchange = () => { const item = pancakeItems[Number(input.dataset.itemPrice)]; item.price = parsePancakeNumber(input.value); input.value = formatPancakeNumber(item.price); renderPancakeItems(); }; });
  box.querySelectorAll('[data-item-remove]').forEach((button) => { button.onclick = () => { pancakeItems.splice(Number(button.dataset.itemRemove), 1); renderPancakeItems(); renderPancakeSummary(); }; });
  renderPancakeSummary();
}

function renderPancakeSummary() {
  const box = document.getElementById('pancake-summary');
  if (!box) return;
  const goods = pancakeItems.reduce((sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.price) || 0), 0);
  const shipping = Number(document.getElementById('pancake-shipping')?.value) || 0;
  const discount = Number(document.getElementById('pancake-discount')?.value) || 0;
  const deposit = Number(document.getElementById('pancake-deposit')?.value) || 0;
  const total = Math.max(0, goods + shipping - discount);
  const remaining = Math.max(0, total - deposit);
  box.innerHTML = `<div><span>Tiền hàng</span><b>${formatPancakeMoney(goods)}</b></div><div><span>Tổng đơn</span><b>${formatPancakeMoney(total)}</b></div><div><span>Đặt cọc</span><b>${formatPancakeMoney(deposit)}</b></div><div class="total"><span>Còn lại</span><b>${formatPancakeMoney(remaining)}</b></div>`;
}

// Tim san pham phia client: shop it san pham nen tai ca catalog mot lan, sau do loc bo dau
// tieng Viet khi go (go "thiep cuoi" khong dau van khop "Thiệp Cưới") — khong phu thuoc kieu match cua Pancake.
function stripDiacritics(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\u0111/g, 'd').replace(/\u0110/g, 'D');
}

async function loadPancakeProductCatalog() {
  if (pancakeProductCache) return pancakeProductCache;
  const pages = [];
  let page = 1;
  while (page <= 20) {
    const data = await pancakeRequest(`/shops/609730/products/variations?page=${page}&page_size=100`);
    const rows = data.data || data.products || data.items || (Array.isArray(data) ? data : []);
    pages.push(...rows);
    if (rows.length < 100) break;
    page += 1;
  }
  pancakeProductCache = pages;
  return pancakeProductCache;
}

async function searchPancakeProducts() {
  const query = document.getElementById('pancake-product-search').value.trim();
  const box = document.getElementById('pancake-product-results');
  if (!query) { box.innerHTML = ''; box.hidden = true; return; }
  let catalog;
  try { catalog = await loadPancakeProductCatalog(); }
  catch (error) { box.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`; box.hidden = false; return; }
  const normalize = (value) => stripDiacritics(value).toLowerCase().split(/\s+/).filter(Boolean);
  const queryTokens = normalize(query);
  const queryNorm = queryTokens.join(' ');
  const matches = catalog.filter((product) => {
    const haystack = [product.product?.name, product.product?.keyword, product.keyword, product.display_id, product.name].map((value) => normalize(value).join(' ')).join(' ');
    return queryTokens.every((token) => haystack.includes(token));
  });
  // Uu tien "Thiep Cuoi" len dau khi go "thiep cuoi": khop chinh xac -> bat dau bang -> chua o giua.
  // Khong doi API, chi doi thu tu hien thi trong dropdown (giong anh yeu cau o anh 2).
  const scored = matches.map((product, originalIndex) => {
    const nameNorm = normalize(product.product?.name || product.display_id || product.name).join(' ');
    let score = 2;
    if (nameNorm === queryNorm) score = 0;
    else if (nameNorm.startsWith(queryNorm)) score = 1;
    return { product, score, originalIndex };
  }).sort((a, b) => a.score - b.score || a.originalIndex - b.originalIndex);
  pancakeProducts = scored.map((entry) => entry.product).slice(0, 30);
  box.innerHTML = pancakeProducts.length ? pancakeProducts.map((product, index) => `<button class="crm-order-row" data-product-index="${index}" type="button"><strong>${escapeHtml(product.product?.name || product.display_id || product.name)}</strong><span>${formatPancakeMoney(product.retail_price || product.price || 0)}</span></button>`).join('') : '<div class="empty-state">Không tìm thấy sản phẩm.</div>';
  box.hidden = false;
  box.querySelectorAll('[data-product-index]').forEach((button) => { button.onclick = () => {
    const product = pancakeProducts[Number(button.dataset.productIndex)];
    const existing = pancakeItems.find((item) => item.variation_id === product.id);
    if (existing) existing.quantity += 1;
    else pancakeItems.push({ variation_id: product.id, product_id: product.product_id, name: product.product?.name || product.display_id || product.name, detail: (product.fields || []).map((field) => `${field.name}: ${field.value}`).join(', '), price: Number(product.retail_price || product.price) || 0, quantity: 1 });
    box.innerHTML = ''; box.hidden = true; document.getElementById('pancake-product-search').value = ''; renderPancakeItems();
  }; });
}

function pancakeOrderPayload() {
  const warehouseId = document.getElementById('pancake-warehouse').value;
  const name = document.getElementById('pancake-customer').value.trim();
  const phone = document.getElementById('pancake-phone').value.trim();
  const address = document.getElementById('pancake-address').value.trim();
  if (!warehouseId) throw new Error('Hãy chọn kho Pancake.');
  if (!pancakeItems.length) throw new Error('Hãy chọn ít nhất một sản phẩm.');
  return {
    warehouse_id: warehouseId, bill_full_name: name, bill_phone_number: phone,
    shipping_address: { address, full_address: address, full_name: name, phone_number: phone },
    items: pancakeItems.map((item) => ({ variation_id: item.variation_id, product_id: item.product_id, quantity: item.quantity, variation_info: { name: item.name, detail: item.detail, retail_price: item.price } })),
    shipping_fee: Number(document.getElementById('pancake-shipping').value) || 0,
    total_discount: Number(document.getElementById('pancake-discount').value) || 0,
    charged_by_qrpay: Number(document.getElementById('pancake-deposit').value) || 0,
    note: document.getElementById('pancake-note').value.trim(),
    note_print: document.getElementById('pancake-print-note').value.trim(),
    is_free_shipping: false,
  };
}

// Doi don hang dang Pancake POS thanh dang ma applyPancakeOrder hieu (ten truong CRM).
function normalizePancakeOrder(raw = {}) {
  const items = (raw.items || []).map((item) => ({
    variation_id: item.variation_id,
    product_id: item.product_id,
    name: item.variation_info?.name || '',
    detail: item.variation_info?.detail || '',
    price: Number(item.variation_info?.retail_price) || 0,
    quantity: Number(item.quantity) || 1,
  }));
  return {
    orderCode: raw.id || raw.display_id || '',
    pancakeOrderId: raw.id || '',
    statusName: raw.status_name || String(raw.status ?? ''),
    warehouseId: raw.warehouse_id || '',
    customer: {
      name: raw.bill_full_name || raw.shipping_address?.full_name || '',
      phone: raw.bill_phone_number || raw.shipping_address?.phone_number || '',
      address: raw.shipping_address?.full_address || raw.shipping_address?.address || '',
    },
    shippingFee: Number(raw.shipping_fee) || 0,
    discount: Number(raw.total_discount) || 0,
    qrPay: Number(raw.charged_by_qrpay) || 0,
    note: raw.note || '',
    printNote: raw.note_print || '',
    items,
  };
}

async function loadPancakeOrderDetail(orderCode) {
  const data = await pancakeRequest(`/shops/609730/orders/${encodeURIComponent(orderCode)}`);
  const order = normalizePancakeOrder(data.order || data.data || data);
  currentPancakeLink = { orderCode: order.orderCode || orderCode, pancakeOrderId: order.pancakeOrderId || orderCode, syncStatus: order.statusName || 'Đã tải' };
  applyPancakeOrder(order);
  document.getElementById('pancake-current').innerHTML = `<span class="mapping-state linked">Đã tải</span><h4>${escapeHtml(currentPancakeLink.orderCode)}</h4><p>${escapeHtml(currentPancakeLink.syncStatus)}</p>`;
  document.getElementById('pancake-create').innerText = 'Lưu thay đổi';
}

async function loadPancakeOrders({ autoSelectCode = '' } = {}) {
  const list = document.getElementById('pancake-list');
  try {
    const search = document.getElementById('pancake-search').value.trim();
    const data = await pancakeRequest(`/shops/609730/orders?search=${encodeURIComponent(search)}&page_size=30`);
    const rows = data.orders || data.items || data.data || (Array.isArray(data) ? data : []);
    list.innerHTML = rows.length ? rows.map((order, index) => `<button class="crm-order-row" data-pancake-order="${index}" type="button"><strong>${escapeHtml(order.orderCode || order.id || order.display_id)}</strong><span>${escapeHtml(order.customerName || order.bill_full_name || '')} · ${escapeHtml(order.statusName || order.status_name || '')}</span></button>`).join('') : '<div class="utility-empty">Không có đơn Pancake phù hợp.</div>';
    list.querySelectorAll('[data-pancake-order]').forEach((button) => { button.onclick = () => {
      const order = rows[Number(button.dataset.pancakeOrder)];
      const code = order.orderCode || order.id || order.display_id;
      void loadPancakeOrderDetail(code).catch((error) => { document.getElementById('crm-status').innerText = error.message; });
    }; });
    if (autoSelectCode) {
      const normalized = String(autoSelectCode).toLocaleUpperCase('vi-VN');
      const exact = rows.find((order) => String(order.orderCode || order.id || order.display_id).toLocaleUpperCase('vi-VN') === normalized);
      if (exact) await loadPancakeOrderDetail(exact.orderCode || exact.id || exact.display_id);
    }
  } catch (error) { list.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`; }
}

function fillDesignForm(order = null) {
  selectedDesignOrder = order;
  document.getElementById('design-list-view').hidden = true;
  document.getElementById('design-editor').hidden = false;
  document.getElementById('design-current-group').innerText = order ? `Chỉnh sửa ${order.orderCode || 'đơn thiết kế'}` : 'Tạo đơn thiết kế';
  document.getElementById('design-code').value = order?.orderCode || extractOrderCode(currentChatSnapshot?.name || '');
  document.getElementById('design-status').value = order?.status || 'demo';
  document.getElementById('design-files').value = String(order?.fileCount || 0);
  document.getElementById('design-deadline').value = order?.deadline ? String(order.deadline).slice(0, 10) : '';
  document.getElementById('design-designer').value = order?.designerId || order?.designer?.id || '';
  document.getElementById('design-note').value = order?.notes || '';
  document.getElementById('design-save').innerText = order ? 'Cập nhật đơn thiết kế' : 'Tạo đơn thiết kế';
}

function showDesignListView() {
  selectedDesignOrder = null;
  document.getElementById('design-editor').hidden = true;
  document.getElementById('design-list-view').hidden = false;
}

async function loadDesigners() {
  try {
    const data = await crmRequest('/users?role=designer&limit=100');
    const rows = data.users || (Array.isArray(data) ? data : []);
    document.getElementById('design-designer').innerHTML = '<option value="">Chưa phân công</option>' + rows.map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.fullName)}</option>`).join('');
    document.getElementById('design-filter-designer').innerHTML = '<option value="">Tất cả Designer</option>' + rows.map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.fullName)}</option>`).join('');
  } catch { /* quyền xem designer có thể bị giới hạn */ }
}

async function loadDesignOrders() {
  const list = document.getElementById('design-list');
  list.innerHTML = '<div class="utility-empty">Đang tải đơn thiết kế…</div>';
  try {
    const search = document.getElementById('design-search').value.trim() || extractOrderCode(currentChatSnapshot?.name || '');
    const params = new URLSearchParams({ limit: '50', offset: '0' });
    if (search) params.set('search', search);
    if (designStatusFilter) params.set('status', designStatusFilter);
    const designerId = document.getElementById('design-filter-designer')?.value || '';
    const dateFrom = document.getElementById('design-date-from')?.value || '';
    const dateTo = document.getElementById('design-date-to')?.value || '';
    if (designerId) params.set('designerId', designerId);
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    const data = await crmRequest(`/orders?${params.toString()}`);
    const rows = data.orders || data.items || [];
    const statusLabels = { demo: 'Chưa demo', designing: 'Thiết kế', approved: 'Chốt in', cancelled: 'Huỷ' };
    list.innerHTML = rows.length ? rows.map((order, index) => `<button class="design-order-card ${selectedDesignOrder?.id === order.id ? 'selected' : ''}" data-design-index="${index}" type="button"><span class="design-card-top"><strong class="design-code">${escapeHtml(order.orderCode)}</strong><span class="design-status ${escapeHtml(order.status || '')}">${escapeHtml(statusLabels[order.status] || order.status || 'Chưa demo')}</span></span><span class="design-card-bottom"><b>${escapeHtml(order.designer?.fullName || 'Chưa gán')}</b><span>📅 ${escapeHtml(order.deadline ? new Date(order.deadline).toLocaleDateString('vi-VN') : '—')}</span><span>📎 ${Number(order.fileCount) || 0} files</span></span></button>`).join('') : '<div class="utility-empty">Không có đơn hàng nào.</div>';
    list.querySelectorAll('[data-design-index]').forEach((button) => { button.onclick = () => fillDesignForm(rows[Number(button.dataset.designIndex)]); });
  } catch (error) { list.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`; }
}

function getVisibleZaloUsers() {
  return filterAndSortUsers(zaloUsers, {
    query: document.getElementById('zalo-users-search')?.value || '',
    sort: document.getElementById('zalo-users-sort')?.value || 'name-asc',
    inactivityDays: document.getElementById('zalo-users-inactivity')?.value || 0,
  });
}
function formatLastInteraction(timestamp) {
  if (!timestamp) return 'Tương tác: Không rõ';
  const days = Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
  return `Tương tác cuối: ${new Date(timestamp).toLocaleDateString('vi-VN')} • ${days} ngày trước`;
}
function renderZaloUsers(update = null) {
  const visible = getVisibleZaloUsers();
  const progress = document.getElementById('zalo-users-progress');
  if (progress) progress.innerText = update?.message || (activeZaloUserScan ? `${update?.status === 'completed' ? 'Hoàn tất' : 'Đang quét'} • ${update?.processed ?? zaloUsers.length}/${update?.total || '?'}` : 'Chọn nick rồi quét danh sách bạn bè.');
  const results = document.getElementById('zalo-users-results');
  if (results) results.innerHTML = visible.length ? visible.map((user) => `<label class="group-result-row"><input type="checkbox" data-user-id="${escapeHtml(user.userId)}" ${selectedZaloUserIds.has(user.userId) ? 'checked' : ''}><span><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.userId)} · ${escapeHtml(formatLastInteraction(user.lastInteractionAt))}</small></span></label>`).join('') : '<div class="empty-state">Không có người dùng đủ điều kiện lọc.</div>';
  const disabled = selectedZaloUserIds.size === 0 || zaloUserActionRunning;
  if (document.getElementById('zalo-users-send-open')) document.getElementById('zalo-users-send-open').disabled = disabled;
  if (document.getElementById('zalo-users-unfriend-open')) document.getElementById('zalo-users-unfriend-open').disabled = disabled;
  // Nut Chọn 50 quay ve trang thai chon khi 50 nguoi da chon khong con hien thi.
  const select50 = document.getElementById('zalo-users-select-50');
  if (select50) {
    if (zaloUserSelect50Ids.size && !visible.some((user) => zaloUserSelect50Ids.has(user.userId))) zaloUserSelect50Ids = new Set();
    select50.innerText = zaloUserSelect50Ids.size ? 'Bỏ 50' : 'Chọn 50';
  }
}
// Nút "Chọn 50": bam lan 1 chon 50 nguoi dung dang hien thi dau tien (duoi 50 thi chon het),
// bam lan 2 bo chon dung 50 nguoi do; cac chon tay ben ngoai giu nguyen.
function toggleZaloUserSelect50() {
  const button = document.getElementById('zalo-users-select-50');
  if (zaloUserSelect50Ids.size) {
    for (const userId of zaloUserSelect50Ids) selectedZaloUserIds.delete(userId);
    zaloUserSelect50Ids = new Set();
    button.innerText = 'Chọn 50';
  } else {
    zaloUserSelect50Ids = new Set(getVisibleZaloUsers().slice(0, 50).map((user) => user.userId));
    for (const userId of zaloUserSelect50Ids) selectedZaloUserIds.add(userId);
    button.innerText = zaloUserSelect50Ids.size ? 'Bỏ 50' : 'Chọn 50';
  }
  renderZaloUsers();
}
function setZaloUserTaskRunning(running, label = '') {
  zaloUserActionRunning = running;
  const badge = document.getElementById('zalo-users-running-badge');
  if (badge) {
    badge.style.display = running ? 'flex' : 'none';
    badge.innerText = running ? '…' : '';
    badge.title = label || (running ? 'Tác vụ người dùng Zalo đang chạy' : '');
  }
  const minimize = document.getElementById('zalo-users-minimize');
  if (minimize) minimize.innerText = running ? 'Hạ xuống · vẫn chạy' : 'Hạ xuống';
  document.querySelector('[data-tool-action="zalo-users"]')?.classList.toggle('task-running', running);
}
async function startZaloUserScan() {
  const profileId = document.getElementById('zalo-users-profile-select').value;
  document.getElementById('zalo-users-progress').innerText = 'Đang chuẩn bị Zalo…';
  const result = await invokeWithRendererTimeout('zalo-user-scan:start', [profileId], 20_000);
  if (!result?.ok) return alert(result?.message || 'Không bắt đầu được phiên quét người dùng.');
  activeZaloUserScan = { scanId: result.scanId, profileId: result.profileId, status: 'scanning' };
  zaloUsers = []; selectedZaloUserIds = new Set(); zaloUserSelect50Ids = new Set(); renderZaloUsers({ status: 'scanning', processed: 0, total: 0 });
}
function renderBulkMessageSummary(kind) {
  const selected = kind === 'personal' ? zaloUsers.filter((user) => selectedZaloUserIds.has(user.userId)) : zaloGroupScanGroups.filter((group) => selectedZaloGroupIds.has(group.groupId));
  const profileId = kind === 'personal' ? activeZaloUserScan?.profileId : activeZaloGroupScan?.profileId;
  const profile = profiles.find((item) => item.id === profileId);
  const target = document.getElementById(`${kind}-message-summary`);
  if (target) target.innerText = `${profile?.zaloDisplayName || profile?.name || 'Chưa chọn nick'} • đã chọn ${selected.length} ${kind === 'personal' ? 'người dùng' : 'nhóm'}`;
}
function appendBulkMessageLog(kind, text, ok) {
  const row = document.createElement('div'); row.className = ok ? 'log-ok' : 'log-error'; row.innerText = text;
  document.getElementById(`${kind}-message-log`).appendChild(row);
}
async function runIndependentBulkMessage(kind) {
  const isPersonal = kind === 'personal';
  const items = isPersonal ? zaloUsers.filter((user) => selectedZaloUserIds.has(user.userId)) : zaloGroupScanGroups.filter((group) => selectedZaloGroupIds.has(group.groupId));
  const profileId = isPersonal ? activeZaloUserScan?.profileId : activeZaloGroupScan?.profileId;
  const message = document.getElementById(`${kind}-message-text`).value.trim();
  if (!profileId || !items.length || !message) return alert('Hãy chọn nick, người nhận và nhập nội dung.');
  if (!document.getElementById(`${kind}-message-consent`).checked) return alert('Hãy xác nhận danh sách đã đồng ý nhận tin.');
  const delayPrefix = isPersonal ? 'personal-delay' : 'group-message-delay';
  const min = Math.max(8, Number(document.getElementById(`${delayPrefix}-min`).value) || 8);
  const max = Math.max(min, Number(document.getElementById(`${delayPrefix}-max`).value) || 20);
  bulkMessageStopRequested = false;
  document.getElementById(`${kind}-message-run`).disabled = true; document.getElementById(`${kind}-message-stop`).disabled = false;
  document.getElementById(`${kind}-message-log`).innerHTML = '';
  for (let index = 0; index < items.length && !bulkMessageStopRequested; index += 1) {
    const item = items[index];
    const result = await ipcRenderer.invoke('zalo-switch-and-send', item.name, message, {
      profileId, requireExactName: true,
      consentConfirmed: true,
      ...(isPersonal ? {
        userId: item.userId,
        userScanId: activeZaloUserScan.scanId,
        searchName: item.zaloName || item.displayName || item.name,
        targetNames: [item.name, item.zaloName, item.displayName].filter(Boolean),
      } : { groupId: item.groupId, scanId: activeZaloGroupScan.scanId }),
    });
    appendBulkMessageLog(kind, `${item.name}: ${result?.ok ? 'Đã gửi' : result?.message || 'Lỗi'}`, !!result?.ok);
    if (index < items.length - 1 && !bulkMessageStopRequested) {
      const waitMs = result?.ok
        ? ((index + 1) % 5 === 0 ? randomBetween(120_000, 300_000) : randomBetween(min * 1000, max * 1000))
        : randomBetween(2_000, 5_000);
      appendBulkMessageLog(kind, `Tạm nghỉ ${Math.ceil(waitMs / 1000)} giây`, true);
      await wait(waitMs);
    }
  }
  document.getElementById(`${kind}-message-run`).disabled = false; document.getElementById(`${kind}-message-stop`).disabled = true;
}

function renderZaloGroupScan(update = null) {
  const profile = getActiveProfile();
  const status = update?.status || activeZaloGroupScan?.status || 'idle';
  const labels = { idle: 'Chưa chạy', discovering: 'Đang tìm nhóm', fetching: 'Đang lấy chi tiết', failed: 'Có nhóm lỗi', completed: 'Hoàn tất', cancelled: 'Đã dừng', incompatible: 'Không tương thích' };
  document.getElementById('zalo-groups-profile').innerText = profile
    ? `${profile.name} • ${profile.platform === 'zalo' ? 'Zalo' : 'Không phải profile Zalo'}`
    : 'Chưa có profile.';
  document.getElementById('zalo-groups-status').innerText = labels[status] || status;
  const pages = Number(update?.pages || activeZaloGroupScan?.pages || 0);
  const discovered = Number(update?.discovered || activeZaloGroupScan?.discovered || 0);
  const total = update?.totalUnique ?? activeZaloGroupScan?.totalUnique;
  const processed = Number(update?.processed ?? activeZaloGroupScan?.processed ?? 0);
  document.getElementById('zalo-groups-progress').innerText = total === null || total === undefined
    ? `Đã đọc ${pages} trang • tìm thấy ${discovered} ID`
    : `Đã xử lý ${processed}/${total} nhóm • lỗi ${zaloGroupScanFailures.length}`;
  document.getElementById('zalo-groups-errors').innerHTML = zaloGroupScanFailures.length
    ? zaloGroupScanFailures.map((item) => `<div class="list-item"><strong>${escapeHtml(item.groupId || 'Không rõ ID')}</strong><span class="muted">${escapeHtml(item.reason || item.message || 'Lỗi')}</span></div>`).join('')
    : (status === 'incompatible' && update?.message
      ? `<div class="empty-state">${escapeHtml(update.message)}</div>`
      : '<div class="empty-state">Chưa có lỗi.</div>');
  const running = status === 'discovering' || status === 'fetching';
  setZaloGroupTaskRunning(running, running ? `${labels[status] || status} · ${processed}/${total ?? '?'}` : '', { processed, total, pages, discovered, status });
  document.getElementById('zalo-groups-start').disabled = running || !profile || profile.platform !== 'zalo';
  document.getElementById('zalo-groups-cancel').disabled = !running;
  document.getElementById('zalo-groups-browser').hidden = status !== 'completed';
  if (status === 'completed') renderZaloGroupBrowser();
}

// Nút "Chọn 50": bam lan 1 chon 50 nhom dang hien thi dau tien (duoi 50 thi chon het),
// bam lan 2 bo chon dung 50 nhom do; cac nhom chon tay ben ngoai giu nguyen.
function toggleZaloGroupSelect50() {
  const button = document.getElementById('zalo-groups-select-50');
  if (zaloGroupSelect50Ids.size) {
    for (const groupId of zaloGroupSelect50Ids) selectedZaloGroupIds.delete(groupId);
    zaloGroupSelect50Ids = new Set();
    button.innerText = 'Chọn 50';
  } else {
    zaloGroupSelect50Ids = new Set(getVisibleZaloGroups().slice(0, 50).map((group) => group.groupId));
    for (const groupId of zaloGroupSelect50Ids) selectedZaloGroupIds.add(groupId);
    button.innerText = zaloGroupSelect50Ids.size ? 'Bỏ 50' : 'Chọn 50';
  }
  renderZaloGroupBrowser();
}

// Badge tien do tren nut Nhóm Zalo: uu tien dang 420/799, khi chua biet tong thi hien so ID da tim.
function formatScanProgressBadge(progress) {
  if (!progress) return '…';
  const total = Number(progress.total);
  const processed = Number(progress.processed) || 0;
  if (Number.isFinite(total) && total > 0) return `${processed}/${total}`;
  const discovered = Number(progress.discovered) || 0;
  if (discovered > 0) return String(discovered);
  return '…';
}

function setZaloGroupTaskRunning(running, label = '', progress = null) {
  const badge = document.getElementById('zalo-groups-running-badge');
  if (badge) {
    const badgeText = running ? formatScanProgressBadge(progress) : '';
    badge.style.display = running ? 'flex' : 'none';
    badge.innerText = badgeText;
    badge.classList.toggle('badge-progress', badgeText.length > 3);
    badge.title = label || 'Tác vụ nhóm Zalo đang chạy';
  }
  const minimize = document.getElementById('zalo-groups-minimize');
  if (minimize) minimize.innerText = running ? 'Hạ xuống · vẫn chạy' : 'Hạ xuống';
  document.querySelector('[data-tool-action="zalo-groups"]')?.classList.toggle('task-running', running);
}

function getVisibleZaloGroups() {
  return filterAndSortGroups(zaloGroupScanGroups, {
    query: document.getElementById('zalo-groups-search').value,
    sort: document.getElementById('zalo-groups-sort').value,
  });
}

function renderZaloGroupBrowser() {
  const visibleGroups = getVisibleZaloGroups();
  const selectedVisible = visibleGroups.filter((group) => selectedZaloGroupIds.has(group.groupId)).length;
  const selectVisible = document.getElementById('zalo-groups-select-visible');
  selectVisible.checked = visibleGroups.length > 0 && selectedVisible === visibleGroups.length;
  selectVisible.indeterminate = selectedVisible > 0 && selectedVisible < visibleGroups.length;
  // Nut Chọn 50 quay ve trang thai chon khi 50 nhom da chon khong con hien thi (loc/sort khac, du lieu moi).
  const select50 = document.getElementById('zalo-groups-select-50');
  if (select50) {
    if (zaloGroupSelect50Ids.size && !visibleGroups.some((group) => zaloGroupSelect50Ids.has(group.groupId))) zaloGroupSelect50Ids = new Set();
    select50.innerText = zaloGroupSelect50Ids.size ? 'Bỏ 50' : 'Chọn 50';
  }
  document.getElementById('zalo-groups-result-count').innerText = `Đã lọc ${visibleGroups.length}/${zaloGroupScanGroups.length} • đã chọn ${selectedZaloGroupIds.size}`;
  document.getElementById('zalo-groups-results').innerHTML = visibleGroups.length
    ? visibleGroups.map((group) => `<label class="group-result-row" role="listitem" title="${escapeHtml(group.name)}">
        <input type="checkbox" data-group-id="${escapeHtml(group.groupId)}" ${selectedZaloGroupIds.has(group.groupId) ? 'checked' : ''}>
        <span class="group-result-name">${escapeHtml(group.name)}</span>
        <span class="muted">${Number(group.totalMember) || 0} thành viên</span>
      </label>`).join('')
    : '<div class="empty-state">Không có tên nhóm phù hợp với từ khóa.</div>';
}

function getSelectedZaloGroupPlan(limit = 50) {
  return buildBulkGroupPlan(getVisibleZaloGroups(), Array.from(selectedZaloGroupIds), limit);
}

function openZaloGroupAction(mode) {
  let plan;
  try { plan = getSelectedZaloGroupPlan(mode === 'leave' ? LEAVE_GROUP_POLICY.maxPerRun : 50); } catch (error) { return alert(error.message); }
  if (mode === 'send') {
    const ambiguousNames = findAmbiguousGroupNames(zaloGroupScanGroups, plan.map((group) => group.groupId));
    if (ambiguousNames.length) {
      return alert(`Không thể gửi an toàn vì có nhóm trùng tên: ${ambiguousNames.join(', ')}. Hãy đổi tên nhóm hoặc bỏ chọn các nhóm này.`);
    }
  }
  zaloGroupAction = { mode, running: false, stopRequested: false };
  document.getElementById('zalo-groups-action-panel').hidden = false;
  document.getElementById('zalo-groups-action-title').innerText = mode === 'send' ? 'Gửi tin nhắn hàng loạt' : 'Rời nhóm hàng loạt';
  document.getElementById('zalo-groups-action-summary').innerText = mode === 'leave'
    ? `${plan.length} nhóm sẽ được xử lý. Nghỉ 5–10 giây, nghỉ 1–2 phút sau mỗi 5 nhóm, tối đa 1.000 lượt/ngày.`
    : `${plan.length} nhóm sẽ được xử lý. Nghỉ 8–20 giây, nghỉ 2–5 phút sau mỗi 5 nhóm, tối đa 200 tin/ngày.`;
  document.getElementById('zalo-groups-send-config').hidden = mode !== 'send';
  document.getElementById('zalo-groups-leave-config').hidden = mode !== 'leave';
  document.getElementById('zalo-groups-action-run').className = `modal-btn ${mode === 'leave' ? 'warn' : 'save'}`;
  document.getElementById('zalo-groups-action-run').innerText = mode === 'send' ? 'Bắt đầu gửi' : 'Xác nhận rời nhóm';
  document.getElementById('zalo-groups-action-progress').innerText = 'Chưa chạy.';
  document.getElementById('zalo-groups-action-log').innerHTML = '';
  document.getElementById(mode === 'send' ? 'zalo-groups-message' : 'zalo-groups-action-run').focus();
}

function appendZaloGroupActionLog(group, ok, message) {
  const row = document.createElement('div');
  row.className = 'list-item';
  row.innerHTML = `<strong>${escapeHtml(group.name)}</strong><span class="muted">${ok ? 'Thành công' : `Lỗi: ${escapeHtml(message || 'Không rõ')}`}</span>`;
  document.getElementById('zalo-groups-action-log').appendChild(row);
}

async function waitForZaloGroupAction(milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (!zaloGroupAction.stopRequested && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
  }
}

async function runZaloGroupAction() {
  if (zaloGroupAction.running) return;
  let plan;
  const mode = zaloGroupAction.mode;
  try { plan = getSelectedZaloGroupPlan(mode === 'leave' ? LEAVE_GROUP_POLICY.maxPerRun : 50); } catch (error) { return alert(error.message); }
  const profileId = activeZaloGroupScan?.profileId;
  const message = document.getElementById('zalo-groups-message').value.trim();
  if (mode === 'send' && !message) return alert('Hãy nhập nội dung tin nhắn.');
  if (mode === 'send' && !document.getElementById('zalo-groups-message-consent').checked) return alert('Hãy xác nhận các nhóm đã đồng ý nhận tin.');
  if (mode === 'leave' && !confirm('Bạn chắc chắn muốn rời khỏi ' + plan.length + ' nhóm đã chọn? Thao tác này không thể hoàn tác.')) return;
  const minSeconds = Math.max(3, Math.min(120, Number(document.getElementById('zalo-groups-delay-min').value) || 5));
  const maxSeconds = Math.max(minSeconds, Math.min(120, Number(document.getElementById('zalo-groups-delay-max').value) || 12));
  zaloGroupAction.running = true;
  zaloGroupAction.stopRequested = false;
  document.getElementById('zalo-groups-action-run').disabled = true;
  document.getElementById('zalo-groups-action-stop').disabled = false;
  document.getElementById('zalo-groups-action-close').disabled = true;
  document.getElementById('zalo-groups-start').disabled = true;
  document.getElementById('zalo-groups-send-open').disabled = true;
  document.getElementById('zalo-groups-leave-open').disabled = true;
  let succeeded = 0;
  let failed = 0;
  const failureMessages = [];
  for (let index = 0; index < plan.length; index += 1) {
    if (zaloGroupAction.stopRequested) break;
    if (getActiveProfile()?.id !== profileId) {
      appendZaloGroupActionLog(plan[index], false, 'Profile đã thay đổi');
      failed += 1;
      break;
    }
    const group = plan[index];
    document.getElementById('zalo-groups-action-progress').innerText = `Đang xử lý ${index + 1}/${plan.length}: ${group.name}`;
    let result;
    try {
      result = mode === 'send'
        ? await ipcRenderer.invoke('zalo-switch-and-send', group.name, message, {
          profileId,
          requireExactName: true,
          consentConfirmed: true,
          scanId: activeZaloGroupScan.scanId,
          groupId: group.groupId,
        })
        : await ipcRenderer.invoke('zalo-group-action:leave', activeZaloGroupScan.scanId, group.groupId);
    } catch (error) {
      result = { ok: false, message: error.message || String(error) };
    }
    if (result?.ok) {
      succeeded += 1;
      if (mode === 'leave') {
        selectedZaloGroupIds.delete(group.groupId);
        zaloGroupSelect50Ids.delete(group.groupId);
        zaloGroupScanGroups = zaloGroupScanGroups.filter((item) => item.groupId !== group.groupId);
      }
    } else failed += 1;
    appendZaloGroupActionLog(group, !!result?.ok, result?.message);
    if (index < plan.length - 1 && !zaloGroupAction.stopRequested) {
      const waitMs = mode === 'send'
        ? (result?.ok
          ? ((index + 1) % 5 === 0 ? randomBetween(120_000, 300_000) : randomBetween(Math.max(8, minSeconds) * 1000, Math.max(8, maxSeconds) * 1000))
          : randomBetween(2_000, 5_000))
        : getLeavePolicyWaitMs(index + 1);
      document.getElementById('zalo-groups-action-progress').innerText = `Đã xong ${index + 1}/${plan.length} • chờ ${Math.ceil(waitMs / 1000)} giây`;
      await waitForZaloGroupAction(waitMs);
    }
  }
  const stopped = zaloGroupAction.stopRequested;
  zaloGroupAction.running = false;
  document.getElementById('zalo-groups-action-run').disabled = false;
  document.getElementById('zalo-groups-action-stop').disabled = true;
  document.getElementById('zalo-groups-action-close').disabled = false;
  document.getElementById('zalo-groups-send-open').disabled = false;
  document.getElementById('zalo-groups-leave-open').disabled = false;
  renderZaloGroupScan(activeZaloGroupScan);
  document.getElementById('zalo-groups-action-progress').innerText = `${stopped ? 'Đã dừng' : 'Hoàn tất'} • thành công ${succeeded} • lỗi ${failed}`;
  if (mode === 'leave') renderZaloGroupBrowser();
}

async function loadCompletedZaloGroups() {
  if (!activeZaloGroupScan?.scanId) return;
  const result = await ipcRenderer.invoke('zalo-group-scan:list', activeZaloGroupScan.scanId);
  if (!result?.ok) return alert(result?.message || 'Không đọc được danh sách nhóm đã quét.');
  zaloGroupScanGroups = Array.isArray(result.groups) ? result.groups : [];
  selectedZaloGroupIds = new Set();
  zaloGroupSelect50Ids = new Set();
  renderZaloGroupBrowser();
  renderUtilityContext();
}

async function startZaloGroupScan() {
  if (zaloGroupAction.running) return alert('Hãy dừng tác vụ nhóm đang chạy trước khi quét lại.');
  zaloGroupScanFailures = [];
  zaloGroupScanGroups = [];
  selectedZaloGroupIds = new Set();
  document.getElementById('zalo-groups-action-panel').hidden = true;
  const profileId = document.getElementById('zalo-groups-profile-select').value;
  const button = document.getElementById('zalo-groups-start');
  if (button) button.disabled = true;
  document.getElementById('zalo-groups-status').innerText = 'Đang chuẩn bị Zalo…';
  document.getElementById('zalo-groups-progress').innerText = 'Đang chờ mô-đun nhóm của phiên Zalo hiện tại (tối đa 15 giây).';
  try {
    const result = await invokeWithRendererTimeout('zalo-group-scan:start', [profileId], 20_000);
    if (!result?.ok) return alert(result?.message || 'Không bắt đầu được phiên quét.');
    activeZaloGroupScan = { scanId: result.scanId, profileId: result.profileId, status: 'discovering', pages: 0, discovered: 0, processed: 0, totalUnique: null };
    renderZaloGroupScan(activeZaloGroupScan);
  } catch (error) {
    alert(`Không bắt đầu được phiên quét nhóm: ${error.message || error}`);
  } finally {
    if (button) button.disabled = false;
  }
}

async function cancelZaloGroupScan() {
  if (!activeZaloGroupScan?.scanId) return;
  await ipcRenderer.invoke('zalo-group-scan:cancel', activeZaloGroupScan.scanId);
}

async function saveZaloGroupScan() {
  if (!activeZaloGroupScan?.scanId) return;
  const result = await ipcRenderer.invoke('zalo-group-scan:save', activeZaloGroupScan.scanId, Array.from(selectedZaloGroupIds));
  if (result?.canceled) return;
  if (!result?.ok) return alert(result?.message || 'Không lưu được file.');
  alert(`Đã lưu ${result.count} nhóm vào ${result.filePath}`);
}
function setLauncherOpen(open) {
  toolsLauncherOpen = !!open;
  const overlay = document.getElementById('tools-overlay');
  const trigger = document.getElementById('btn-tools-launcher');
  if (!overlay || !trigger) return;
  overlay.classList.toggle('open', toolsLauncherOpen);
  overlay.setAttribute('aria-hidden', toolsLauncherOpen ? 'false' : 'true');
  trigger.classList.toggle('active', toolsLauncherOpen);

  if (toolsLauncherOpen) {
    ipcRenderer.send('set-browserview-visibility', false);
  } else {
    const stillOpen = overlayIds.some((overlayId) => document.getElementById(overlayId) && document.getElementById(overlayId).style.display === 'flex');
    if (!stillOpen && !appLocked) ipcRenderer.send('set-browserview-visibility', true);
  }
}
function runToolAction(action, autoClose = true) {
  const handler = TOOL_ACTION_HANDLERS[action];
  if (!handler) return;
  if (autoClose) setLauncherOpen(false);
  document.querySelectorAll('.nav-tool').forEach((button) => button.classList.toggle('active', button.dataset.toolAction === action));
  handler();
}
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function invokeWithRendererTimeout(channel, args = [], timeoutMs = 30_000) {
  let timer;
  try {
    return await Promise.race([
      ipcRenderer.invoke(channel, ...args),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, timeout: true, message: '[IPC] Main process không trả kết quả trong 30 giây.' }), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

function migrateLegacyProfiles() {
  if (workspaceData.profiles.length) return;
  try {
    const saved = localStorage.getItem('mp_profiles');
    if (saved) {
      const legacyProfiles = JSON.parse(saved);
      if (Array.isArray(legacyProfiles) && legacyProfiles.length) {
        profiles = normalizeProfiles(legacyProfiles);
        workspaceData.profiles = profiles;
      }
    }
  } catch (e) { }
  if (!workspaceData.quickReplies.length) {
    try {
      const settings = ipcRenderer.sendSync('get-settings');
      workspaceData.quickReplies = settings.quickReplies || [];
    } catch (e) { }
  }
  persistWorkspace();
}

function renderSidebar() {
  profilesList.innerHTML = '';
  profiles.forEach((p) => {
    const btn = document.createElement('div');
    btn.className = `profile-btn ${p.id === activeProfileId ? 'active' : ''}`;
    btn.dataset.connectionState = profileConnectionStates.get(p.id) || 'loading';
    btn.title = `${p.name} (${p.platform || 'zalo'})`;
    const avatarClip = document.createElement('span');
    avatarClip.className = 'profile-avatar-clip';
    const span = document.createElement('span');
    span.innerText = p.avatar ? '' : String(p.name || 'Z').trim().charAt(0).toUpperCase();
    if (p.avatar) {
      const img = document.createElement('img');
      img.src = p.avatar.startsWith('http') || p.avatar.startsWith('data:') ? p.avatar : `file://${String(p.avatar).replace(/\\/g, '/')}`;
      avatarClip.appendChild(img);
    } else avatarClip.appendChild(span);
    btn.appendChild(avatarClip);
    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.id = `badge-${p.id}`;
    badge.innerText = '0';
    btn.appendChild(badge);
    btn.onclick = () => !appLocked && switchProfile(p.id);
    btn.oncontextmenu = (e) => { e.preventDefault(); if (!appLocked) openModal(p); };
    profilesList.appendChild(btn);
  });
}
function switchProfile(id) {
  activeProfileId = id;
  crmConversation = null;
  for (const overlayId of overlayIds) {
    const overlay = document.getElementById(overlayId);
    if (overlay) overlay.style.display = 'none';
  }
  document.querySelectorAll('.nav-tool').forEach((button) => button.classList.remove('active'));
  document.getElementById('quick-replies-topbar')?.classList.remove('active');
  document.getElementById('send-video-topbar')?.classList.remove('active');
  releasePopupDock();
  renderSidebar();
  const profile = getActiveProfile();
  if (profile) {
    ipcRenderer.send('switch-profile', profile);
    setTimeout(() => ipcRenderer.send('set-font-scale', getSavedFontSize()), 150);
  }
  renderCRMCurrentChat();
  renderUtilityContext();
  renderCampaigns();
  if (document.getElementById('campaign-target-list')) document.getElementById('campaign-target-list').innerHTML = '<div class="muted">Đã đổi profile, vui lòng tải lại danh sách...</div>';
}
function openModal(profileToEdit = null) {
  editingProfile = profileToEdit;
  tempAvatarPath = profileToEdit ? profileToEdit.avatar : null;
  modalTitle.innerText = profileToEdit ? 'Chỉnh sửa tài khoản' : 'Thêm tài khoản';
  nameInput.value = profileToEdit ? profileToEdit.name : '';
  proxyInput.value = profileToEdit?.proxy || '';
  platformInput.value = profileToEdit?.platform || 'zalo';
  const customUrlInput = document.getElementById('profile-custom-url-input');
  customUrlInput.value = profileToEdit?.customUrl || '';
  customUrlInput.style.display = (profileToEdit?.platform === 'custom') ? 'block' : 'none';
  document.getElementById('modal-delete').style.display = profileToEdit ? 'inline-flex' : 'none';
  document.getElementById('modal-clear-cache').style.display = profileToEdit ? 'inline-flex' : 'none';
  updateAvatarPreview();
  openOverlay('modal-overlay');
  nameInput.focus();
}
function updateAvatarPreview() {
  if (tempAvatarPath) {
    avatarImg.src = tempAvatarPath.startsWith('http') || tempAvatarPath.startsWith('data:') ? tempAvatarPath : `file://${String(tempAvatarPath).replace(/\\/g, '/')}`;
    avatarImg.style.display = 'block';
    avatarLetter.style.display = 'none';
  } else {
    avatarImg.style.display = 'none';
    avatarLetter.style.display = 'block';
    avatarLetter.innerText = platformIcon(platformInput.value || 'zalo');
  }
}

function renderDashboard() {
  const contacts = workspaceData.crmContacts || [];
  const campaigns = workspaceData.campaigns || [];
  const quickReplies = workspaceData.quickReplies || [];
  const events = workspaceData.analyticsEvents || [];
  const running = campaigns.filter((c) => c.status === 'running').length;
  const completed = campaigns.filter((c) => c.status === 'done').length;
  document.getElementById('dashboard-stats').innerHTML = [
    { label: 'Profiles', value: profiles.length, foot: 'Tài khoản trong workspace' },
    { label: 'CRM Contacts', value: contacts.length, foot: 'Tổng khách hàng cục bộ' },
    { label: 'Campaigns', value: campaigns.length, foot: `${running} chạy • ${completed} hoàn tất` },
    { label: 'Quick Replies', value: quickReplies.length, foot: 'Mẫu phản hồi nhanh' },
    { label: 'Downloads', value: downloads.length, foot: 'Lịch sử tải xuống' },
    { label: 'Events', value: events.length, foot: 'Analytics nội bộ' },
  ].map((item) => `<div class="metric-card"><div class="metric-label">${item.label}</div><div class="metric-value">${item.value}</div><div class="metric-foot">${item.foot}</div></div>`).join('');
  document.getElementById('dashboard-current-workspace').innerText = getCurrentWorkspaceName();
  document.getElementById('dashboard-workspace-summary').innerHTML = `Workspace <strong>${escapeHtml(getCurrentWorkspaceName())}</strong> đang chứa <strong>${profiles.length}</strong> profile, <strong>${contacts.length}</strong> contact và <strong>${quickReplies.length}</strong> quick replies.`;
  const sentCount = campaigns.reduce((sum, c) => sum + ((c.logs || []).filter((log) => log.status === 'sent').length), 0);
  const failCount = campaigns.reduce((sum, c) => sum + ((c.logs || []).filter((log) => log.status === 'failed').length), 0);
  document.getElementById('dashboard-kpis').innerHTML = `
    <span class="chip success">${sentCount} lượt gửi OK</span>
    <span class="chip hot">${running} campaign chạy</span>
    <span class="chip danger">${failCount} lượt lỗi</span>
    <span class="chip">${events.filter((e) => e.type === 'ai_rewrite').length} AI rewrite</span>`;
  const activityList = document.getElementById('activity-list');
  const latest = events.slice(0, 12);
  if (!latest.length) activityList.innerHTML = '<div class="empty-state">Chưa có activity nào.</div>';
  else activityList.innerHTML = latest.map((event) => `<div class="activity-item"><div class="row"><div class="title-sm">${escapeHtml(event.type)}</div><div class="muted">${formatDate(event.createdAt)}</div></div><div class="muted">${escapeHtml(JSON.stringify(event.payload || {}))}</div></div>`).join('');
}

function renderWorkspaces() {
  const list = document.getElementById('workspace-list');
  if (!workspaceState.workspaces.length) {
    list.innerHTML = '<div class="empty-state">Chưa có workspace.</div>';
    return;
  }
  list.innerHTML = workspaceState.workspaces.map((workspace) => `
    <div class="workspace-item">
      <div class="row"><div><div class="title-lg">${escapeHtml(workspace.name)}</div><div class="muted">${workspace.id} • ${formatDate(workspace.createdAt)}</div></div><button class="modal-btn ${workspace.id === workspaceState.currentId ? 'save' : 'cancel'}" data-workspace="${workspace.id}">${workspace.id === workspaceState.currentId ? 'Đang dùng' : 'Chuyển'}</button></div>
    </div>`).join('');
  list.querySelectorAll('[data-workspace]').forEach((btn) => {
    btn.onclick = () => {
      const id = btn.getAttribute('data-workspace');
      if (id === workspaceState.currentId) return;
      workspaceState = ipcRenderer.sendSync('workspace-switch', id);
      workspaceData = normalizeWorkspaceData(workspaceState.data);
      profiles = normalizeProfiles(workspaceData.profiles);
      activeProfileId = profiles[0]?.id || null;
      closeOverlay('workspace-overlay');
      renderAll();
      if (activeProfileId) switchProfile(activeProfileId);
      trackEvent('workspace_switch', { workspaceId: id });
    };
  });
}

function renderCurrentChatSummary() {
  const box = document.getElementById('crm-current-chat');
  if (!currentChatSnapshot) {
    box.innerHTML = 'Chưa có dữ liệu tab hiện tại.';
    return;
  }
  box.innerHTML = `<div class="title-sm">${escapeHtml(currentChatSnapshot.name || 'Không rõ tên')}</div><div class="muted">Platform: ${escapeHtml(currentChatSnapshot.platform || '')}</div><div class="muted">Profile: ${escapeHtml(getActiveProfile()?.name || '')}</div>`;
}
function renderCRMList() {
  const query = document.getElementById('crm-search').value.trim().toLowerCase();
  const activeProfile = getActiveProfile();
  const contacts = (workspaceData.crmContacts || []).filter((contact) => !activeProfile || contact.profileId === activeProfile.id);
  const filtered = contacts.filter((contact) => [contact.name, contact.phone, (contact.tags || []).join(',')].join(' ').toLowerCase().includes(query));
  const list = document.getElementById('crm-contact-list');
  if (!filtered.length) {
    list.innerHTML = '<div class="empty-state">Chưa có contact cho profile này.</div>';
    return;
  }
  list.innerHTML = filtered.map((contact) => `
    <div class="contact-item" data-contact="${contact.id}">
      <div class="row"><div><div class="title-sm">${escapeHtml(contact.name || 'Chưa đặt tên')}</div><div class="muted">${escapeHtml(contact.phone || 'Chưa có số điện thoại')}</div></div><span class="chip ${contact.status === 'hot' ? 'hot' : contact.status === 'blacklist' ? 'danger' : contact.status === 'bought' ? 'success' : ''}">${escapeHtml(statusLabel(contact.status))}</span></div>
      <div class="tag-list mt-12">${(contact.tags || []).map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`).join('')}</div>
      <div class="muted mt-12">${escapeHtml(contact.note || '')}</div>
    </div>`).join('');
  list.querySelectorAll('[data-contact]').forEach((item) => {
    item.onclick = () => {
      const contact = workspaceData.crmContacts.find((entry) => entry.id === item.getAttribute('data-contact'));
      if (contact) fillContactForm(contact);
    };
  });
}
function fillContactForm(contact) {
  editingContactId = contact?.id || null;
  document.getElementById('crm-name').value = contact?.name || '';
  document.getElementById('crm-phone').value = contact?.phone || '';
  document.getElementById('crm-status').value = contact?.status || 'new';
  document.getElementById('crm-tags').value = (contact?.tags || []).join(', ');
  document.getElementById('crm-note').value = contact?.note || '';
  document.getElementById('crm-selected-label').innerText = contact ? `Đang sửa: ${contact.name}` : 'Đang tạo contact mới';
}
function renderCRMCurrentChat() {
  renderCurrentChatSummary();
  renderCRMList();
  const zaloCount = getZaloProfiles().length;
  const activeZaloContacts = (workspaceData.crmContacts || []).filter((contact) => contact.profileId === getActiveProfile()?.id && (getActiveProfile()?.platform || 'zalo') === 'zalo').length;
  document.getElementById('campaign-target-count').innerText = `${zaloCount} Zalo account • ${activeZaloContacts} CRM target`;
}
function saveContact() {
  const activeProfile = getActiveProfile();
  if (!activeProfile) return alert('Chưa có profile nào.');
  const name = document.getElementById('crm-name').value.trim();
  if (!name) return alert('Vui lòng nhập tên contact.');
  const payload = {
    id: editingContactId || `crm_${Date.now()}`,
    profileId: activeProfile.id,
    name,
    phone: document.getElementById('crm-phone').value.trim(),
    status: document.getElementById('crm-status').value,
    tags: document.getElementById('crm-tags').value.split(',').map((item) => item.trim()).filter(Boolean),
    note: document.getElementById('crm-note').value.trim(),
    platform: activeProfile.platform,
    updatedAt: Date.now(),
  };
  if (editingContactId) workspaceData.crmContacts = workspaceData.crmContacts.map((entry) => entry.id === editingContactId ? payload : entry);
  else workspaceData.crmContacts.unshift({ ...payload, createdAt: Date.now() });
  persistWorkspace();
  trackEvent(editingContactId ? 'crm_contact_updated' : 'crm_contact_created', { id: payload.id, profileId: activeProfile.id });
  fillContactForm(null);
  renderCRMCurrentChat();
  renderDashboard();
}
function deleteContact() {
  if (!editingContactId) return;
  if (!confirm('Xóa contact này?')) return;
  workspaceData.crmContacts = workspaceData.crmContacts.filter((entry) => entry.id !== editingContactId);
  persistWorkspace();
  trackEvent('crm_contact_deleted', { id: editingContactId });
  fillContactForm(null);
  renderCRMCurrentChat();
}

function renderCampaigns() {
  const list = document.getElementById('campaign-list');
  const activeProfile = getActiveProfile();
  const campaigns = (workspaceData.campaigns || []).filter((campaign) => campaign.platform === 'zalo' || (!campaign.platform && (!activeProfile || campaign.profileId === activeProfile.id)));
  if (!campaigns.length) {
    list.innerHTML = '<div class="empty-state">Chưa có campaign nào.</div>';
    return;
  }
  list.innerHTML = campaigns.map((campaign) => {
    const sent = (campaign.logs || []).filter((log) => log.status === 'sent').length;
    const failed = (campaign.logs || []).filter((log) => log.status === 'failed').length;
    const total = campaign.targets?.length || 0;
    return `
      <div class="campaign-item" data-campaign="${campaign.id}">
        <div class="row"><div><div class="title-sm">${escapeHtml(campaign.name)}</div><div class="muted">${sent}/${total} sent • ${failed} fail</div></div><span class="pill ${escapeHtml(campaign.status || 'draft')}">${escapeHtml(campaign.status || 'draft')}</span></div>
        <div class="muted mt-12">${escapeHtml(campaign.message || '')}</div>
        <div class="row mt-12"><button class="modal-btn cancel" data-action="select">Chọn</button><button class="modal-btn cancel" data-action="pause">Pause</button><button class="modal-btn cancel" data-action="stop">Stop</button><button class="modal-btn warn" data-action="delete">Xóa</button></div>
      </div>`;
  }).join('');
  list.querySelectorAll('[data-campaign]').forEach((item) => {
    const id = item.getAttribute('data-campaign');
    item.querySelector('[data-action="select"]').onclick = () => { selectedCampaignId = id; alert('Đã chọn campaign để chạy.'); };
    item.querySelector('[data-action="pause"]').onclick = () => pauseCampaign(id);
    item.querySelector('[data-action="stop"]').onclick = () => stopCampaign(id);
    item.querySelector('[data-action="delete"]').onclick = () => deleteCampaign(id);
  });
}
function deleteCampaign(campaignId) {
  if (confirm('Bạn có chắc chắn muốn xóa campaign này?')) {
    if (campaignTimers[campaignId]) clearTimeout(campaignTimers[campaignId]);
    workspaceData.campaigns = workspaceData.campaigns.filter((c) => c.id !== campaignId);
    if (selectedCampaignId === campaignId) selectedCampaignId = null;
    persistWorkspace();
    trackEvent('campaign_deleted', { id: campaignId });
    renderCampaigns();
  }
}
function renderCampaignTargets(source = currentCampaignTargetSource) {
  const list = document.getElementById('campaign-target-list');
  const activeProfile = getActiveProfile();
  if (!activeProfile || !list) return;
  currentCampaignTargetSource = source;

  const selectedSet = campaignTargetSelections[source] || new Set();
  let targets = [];
  if (source === 'crm') {
    targets = workspaceData.crmContacts
      .filter((c) => c.profileId === activeProfile.id)
      .map((contact) => ({ value: contact.name, label: `${contact.name} (${contact.phone})` }));
  } else if (source === 'recent') {
    const recentTargets = sanitizeRecentChats(workspaceData.recentChats);
    workspaceData.recentChats = recentTargets;
    targets = recentTargets.map((name) => ({ value: name, label: name }));
  }

  if (!targets.length) {
    list.innerHTML = source === 'crm'
      ? '<div class="muted">Chưa có CRM contact cho profile này.</div>'
      : '<div class="muted">Chưa tải được hội thoại gần đây. Hãy vào tab Zalo để extension quét.</div>';
    return;
  }

  list.innerHTML = targets.map((target) => {
    const checked = selectedSet.has(target.value) ? 'checked' : '';
    return `<label style="display:flex; align-items:center; gap:10px; padding:6px; cursor:pointer;"><input type="checkbox" name="camp_target" value="${escapeHtml(target.value)}" ${checked}> <span style="font-size:13px;">${escapeHtml(target.label)}</span></label>`;
  }).join('');

  list.querySelectorAll('input[name="camp_target"]').forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) selectedSet.add(input.value);
      else selectedSet.delete(input.value);
    });
  });
}

function createCampaign() {
  const activeProfile = getActiveProfile();
  if (!activeProfile) return alert('Chưa có profile.');
  if ((activeProfile.platform || 'zalo') !== 'zalo') return alert('Tính năng gửi hàng loạt chỉ áp dụng cho tài khoản Zalo. Hãy chọn một profile Zalo trước.');
  const zaloProfiles = getZaloProfiles();
  if (!zaloProfiles.length) return alert('Workspace chưa có tài khoản Zalo nào.');
  const mode = document.getElementById('campaign-mode').value;
  const selectedTargets = Array.from(document.querySelectorAll('input[name="camp_target"]:checked')).map(el => ({ id: el.value, name: el.value, phone: '' }));
  
  if (mode !== 'zalo_accounts' && !selectedTargets.length) {
    return alert('Vui lòng chọn ít nhất 1 người nhận từ danh sách!');
  }
  
  const name = document.getElementById('campaign-name').value.trim();
  const message = document.getElementById('campaign-message').value.trim();
  if (!name || !message) return alert('Vui lòng nhập tên chiến dịch và nội dung.');
  const batchSize = Number(document.getElementById('campaign-batch-size').value || 20);
  const campaign = {
    id: `camp_${Date.now()}`,
    platform: 'zalo',
    profileId: activeProfile.id,
    profileIds: mode === 'zalo_accounts' ? zaloProfiles.map((profile) => profile.id) : [activeProfile.id],
    name,
    message,
    delayMin: Number(document.getElementById('campaign-delay-min').value || 2500),
    delayMax: Number(document.getElementById('campaign-delay-max').value || 6500),
    batchSize,
    mode,
    status: 'draft',
    createdAt: Date.now(),
    targets: mode === 'zalo_accounts' ? [] : selectedTargets.slice(0, batchSize),
    accountLogs: [],
    logs: [],
  };
  workspaceData.campaigns.unshift(campaign);
  selectedCampaignId = campaign.id;
  persistWorkspace();
  trackEvent('campaign_created', { id: campaign.id, targets: campaign.targets.length });
  renderCampaigns();
  renderDashboard();
}
function updateCampaign(campaignId, patch) {
  workspaceData.campaigns = workspaceData.campaigns.map((campaign) => campaign.id === campaignId ? { ...campaign, ...patch } : campaign);
  persistWorkspace();
  renderCampaigns();
  renderDashboard();
}
async function runCampaign(campaignId) {
  const campaign = workspaceData.campaigns.find((entry) => entry.id === campaignId);
  if (!campaign) return alert('Không tìm thấy campaign.');
  if (campaign.platform && campaign.platform !== 'zalo') return alert('Campaign này không phải campaign Zalo.');
  campaign.status = 'running';
  persistWorkspace();
  renderCampaigns();
  trackEvent('zalo_campaign_started', { id: campaignId, mode: campaign.mode });
  if (campaign.mode === 'zalo_accounts') return runZaloAccountsCampaign(campaignId);
  for (const target of campaign.targets) {
    const latest = workspaceData.campaigns.find((entry) => entry.id === campaignId);
    if (!latest || latest.status === 'stopped') break;
    if (latest.status === 'paused') {
      campaignTimers[campaignId] = setTimeout(() => runCampaign(campaignId), 1200);
      return;
    }
    const alreadySent = (latest.logs || []).find(l => l.targetId === target.id && l.status === 'sent');
    if (alreadySent) continue;
    
    await wait(randomBetween(latest.delayMin, latest.delayMax));
    try {
      const result = latest.mode === 'auto'
        ? await ipcRenderer.invoke('zalo-switch-and-send', target.name, latest.message, { profileId: latest.profileId })
        : { ok: true, assisted: true, message: 'Assist mode: đã lưu log, bạn tự mở đúng hội thoại để gửi.' };
      const refreshed = workspaceData.campaigns.find((entry) => entry.id === campaignId);
      refreshed.logs.push({ id: `${Date.now()}-${target.id}`, targetId: target.id, targetName: target.name, status: result.ok ? 'sent' : 'failed', detail: result.message || '', createdAt: Date.now() });
      persistWorkspace();
      trackEvent(result.ok ? 'zalo_campaign_sent' : 'zalo_campaign_failed', { campaignId, targetId: target.id });
      renderCampaigns();
    } catch (err) {
      const refreshed = workspaceData.campaigns.find((entry) => entry.id === campaignId);
      refreshed.logs.push({ id: `${Date.now()}-${target.id}`, targetId: target.id, targetName: target.name, status: 'failed', detail: err.message || String(err), createdAt: Date.now() });
      persistWorkspace();
      trackEvent('zalo_campaign_failed', { campaignId, targetId: target.id });
    }
  }
  updateCampaign(campaignId, { status: 'done' });
  trackEvent('zalo_campaign_done', { id: campaignId });
}
async function runZaloAccountsCampaign(campaignId) {
  const campaign = workspaceData.campaigns.find((entry) => entry.id === campaignId);
  const zaloProfiles = getZaloProfiles().filter((profile) => (campaign.profileIds || []).includes(profile.id));
  if (!zaloProfiles.length) return updateCampaign(campaignId, { status: 'failed' });
  for (const profile of zaloProfiles) {
    const latest = workspaceData.campaigns.find((entry) => entry.id === campaignId);
    if (!latest || latest.status === 'stopped') break;
    if (latest.status === 'paused') {
      campaignTimers[campaignId] = setTimeout(() => runZaloAccountsCampaign(campaignId), 1200);
      return;
    }
    activeProfileId = profile.id;
    switchProfile(profile.id);
    await wait(1800);
    await wait(randomBetween(latest.delayMin, latest.delayMax));
    const message = latest.message.replace(/\{account\}/g, profile.name || 'Zalo');
    const result = await ipcRenderer.invoke('active-chat-send-text', message, { platform: 'zalo', profileId: profile.id });
    const refreshed = workspaceData.campaigns.find((entry) => entry.id === campaignId);
    refreshed.accountLogs = refreshed.accountLogs || [];
    refreshed.accountLogs.push({ id: `${Date.now()}-${profile.id}`, profileId: profile.id, profileName: profile.name, status: result.ok ? 'sent' : 'failed', detail: result.message || '', createdAt: Date.now() });
    persistWorkspace();
    trackEvent(result.ok ? 'zalo_account_campaign_sent' : 'zalo_account_campaign_failed', { campaignId, profileId: profile.id });
    renderCampaigns();
  }
  updateCampaign(campaignId, { status: 'done' });
  trackEvent('zalo_accounts_campaign_done', { id: campaignId });
}
function pauseCampaign(campaignId) { updateCampaign(campaignId, { status: 'paused' }); trackEvent('campaign_paused', { id: campaignId }); }
function stopCampaign(campaignId) {
  if (campaignTimers[campaignId]) clearTimeout(campaignTimers[campaignId]);
  updateCampaign(campaignId, { status: 'stopped' });
  trackEvent('campaign_stopped', { id: campaignId });
}

const quickReplyTableView = { search: '', page: 1, pageSize: 25 };
const quickReplyEditor = { editingId: null, imagePath: '', imageStatus: '', pendingDeleteId: null };
const quickReplyBrokenImages = new Set();

function normalizeQuickReplyKeyword(value) {
  return String(value || '').trim().replace(/^[\\/]+/, '').replace(/\s+/g, '-').slice(0, 40);
}
function quickReplyFileUrl(imagePath) {
  const clean = String(imagePath || '').replace(/\\/g, '/');
  if (!clean) return '';
  return `file:///${clean.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`;
}
function quickReplyEntries() {
  return (workspaceData.quickReplies || []).map((reply, index) => ({
    ...reply,
    __index: index,
    __keyword: normalizeQuickReplyKeyword(reply.keyword) || String(index + 1),
  }));
}
function filterQuickReplies(entries) {
  const needle = quickReplyTableView.search.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) => entry.__keyword.toLowerCase().includes(needle) || String(entry.message || '').toLowerCase().includes(needle));
}
function renderQuickReplies() {
  const rows = document.getElementById('quick-replies-rows');
  const status = document.getElementById('quick-replies-status');
  const pager = document.getElementById('quick-replies-pager');
  if (!rows || !status || !pager) return renderQuickReplyFallback();
  const entries = quickReplyEntries();
  const visible = filterQuickReplies(entries);
  const broken = entries.filter((entry) => entry.imagePath && quickReplyBrokenImages.has(entry.__index)).length;

  status.innerText = entries.length
    ? `Tổng ${entries.length} mẫu · đang hiện ${visible.length}${broken ? ` · ${broken} ảnh lỗi cần chọn lại` : ''}. Dữ liệu dùng chung cho mọi nick Zalo.`
    : 'Chưa có mẫu tin nhắn. Bấm “Thêm mẫu” hoặc “Nhập CSV”.';
  pager.hidden = true;
  pager.innerHTML = '';

  rows.innerHTML = visible.length
    ? visible.map((entry) => {
      const isBroken = entry.imagePath && quickReplyBrokenImages.has(entry.__index);
      const imageCell = !entry.imagePath
        ? '<span class="muted">Không</span>'
        : isBroken
          ? '<span class="qr-thumb-missing">Ảnh lỗi</span>'
          : `<img class="qr-thumb" loading="lazy" src="${quickReplyFileUrl(entry.imagePath)}" alt="Ảnh mẫu" data-preview-index="${entry.__index}">`;
      const full = String(entry.message || '');
      const short = full.length > 80 ? `${full.slice(0, 80)}…` : full;
      return `<tr class="${isBroken ? 'qr-row-warning' : ''}">
        <td>${entry.__index + 1}</td>
        <td><span class="qr-keyword">&#92;${escapeHtml(entry.__keyword)}</span></td>
        <td>${imageCell}</td>
        <td class="qr-content" title="${escapeHtml(full)}">${escapeHtml(short)}</td>
        <td><div class="row-actions">
          <button class="modal-btn cancel" type="button" title="Sửa" aria-label="Sửa mẫu" data-qr-edit="${entry.__index}">Sửa</button>
          <button class="modal-btn warn" type="button" title="Xoá" aria-label="Xoá mẫu" data-qr-delete="${entry.__index}">Xoá</button>
          <button class="modal-btn" type="button" title="Chèn vào hội thoại đang mở" aria-label="Chèn mẫu" data-qr-insert="${entry.__index}">Chèn</button>
        </div></td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="5" class="muted">Không có mẫu nào khớp từ khóa tìm.</td></tr>';

  rows.querySelectorAll('[data-qr-edit]').forEach((button) => {
    button.onclick = () => openQuickReplyEditor(Number(button.getAttribute('data-qr-edit')));
  });
  rows.querySelectorAll('[data-qr-insert]').forEach((button) => {
    button.onclick = () => testQuickReply(Number(button.getAttribute('data-qr-insert')), button);
  });
  rows.querySelectorAll('[data-qr-delete]').forEach((button) => {
    button.onclick = () => askDeleteQuickReply(Number(button.getAttribute('data-qr-delete')));
  });
  rows.querySelectorAll('[data-preview-index]').forEach((image) => {
    image.onerror = () => {
      const index = Number(image.getAttribute('data-preview-index'));
      quickReplyBrokenImages.add(index);
      renderQuickReplies();
    };
  });
}
// Dự phòng cho giao diện cũ để không vỡ khi thiếu bảng mới.
function renderQuickReplyFallback() {
  const list = document.getElementById('quick-replies-list');
  if (!list) return;
  const quickReplies = workspaceData.quickReplies || [];
  if (!quickReplies.length) {
    list.innerHTML = '<div class="empty-state">Chưa có tin nhắn mẫu nào.</div>';
    return;
  }
  list.innerHTML = quickReplies.map((reply, index) => `
    <div class="download-item">
      <div class="row"><div class="title-sm">&#92;${escapeHtml(reply.keyword || String(index + 1))}</div></div>
      <div class="muted mt-12">${escapeHtml(reply.message)}${reply.imagePath ? '<br>Có ảnh đính kèm' : ''}</div>
    </div>`).join('');
}
function setQuickReplyEditorError(message) {
  const box = document.getElementById('quick-reply-editor-error');
  if (!box) return;
  box.hidden = !message;
  box.innerText = message || '';
}
function resetQuickReplyEditor() {
  quickReplyEditor.editingId = null;
  quickReplyEditor.imagePath = '';
  pendingQuickReplyImagePath = '';
  const keyword = document.getElementById('quick-reply-keyword');
  const input = document.getElementById('quick-reply-input');
  const title = document.getElementById('quick-reply-editor-title');
  const save = document.getElementById('quick-reply-add');
  if (keyword) keyword.value = '';
  if (input) input.value = '';
  if (title) title.innerText = 'Thêm mẫu tin nhắn';
  if (save) save.innerText = 'Lưu mẫu';
  setQuickReplyImageStatus('Không kèm ảnh.', null);
  setQuickReplyEditorError('');
}
function setQuickReplyImageStatus(text, imagePath) {
  const status = document.getElementById('quick-reply-image-status');
  if (status) status.innerText = text;
  const preview = document.getElementById('quick-reply-image-preview');
  const thumb = document.getElementById('quick-reply-image-thumb');
  if (preview && thumb) {
    const show = Boolean(imagePath);
    preview.hidden = !show;
    if (show) {
      thumb.src = quickReplyFileUrl(imagePath);
      thumb.onerror = () => { preview.hidden = true; };
    }
  }
}
function openQuickReplyEditor(index = null) {
  const editor = document.getElementById('quick-reply-editor');
  if (!editor) return;
  editor.hidden = false;
  const confirm = document.getElementById('quick-reply-confirm');
  if (confirm) confirm.hidden = true;
  const entries = workspaceData.quickReplies || [];
  if (index === null) {
    resetQuickReplyEditor();
  } else {
    const reply = entries[Number(index)];
    if (!reply) return;
    quickReplyEditor.editingId = String(index);
    quickReplyEditor.imagePath = String(reply.imagePath || '');
    pendingQuickReplyImagePath = quickReplyEditor.imagePath;
    document.getElementById('quick-reply-keyword').value = String(reply.keyword || '');
    document.getElementById('quick-reply-input').value = String(reply.message || '');
    document.getElementById('quick-reply-editor-title').innerText = `Sửa mẫu \\${reply.keyword || Number(index) + 1}`;
    document.getElementById('quick-reply-add').innerText = 'Cập nhật mẫu';
    setQuickReplyImageStatus(reply.imagePath ? `Đang dùng ảnh: ${String(reply.imagePath).split(/[\\/]/).pop()}` : 'Không kèm ảnh.', reply.imagePath || null);
  }
  const keyword = document.getElementById('quick-reply-keyword');
  if (keyword) keyword.focus();
}
function quickReplyKeywordTaken(keyword, exceptIndex) {
  return (workspaceData.quickReplies || []).some((reply, index) => index !== exceptIndex && normalizeQuickReplyKeyword(reply.keyword) === keyword);
}
async function testQuickReply(index, button) {
  const reply = (workspaceData.quickReplies || [])[Number(index)];
  if (!reply) return;
  const status = document.getElementById('quick-replies-status');
  if (button) button.disabled = true;
  try {
    const result = await ipcRenderer.invoke('quick-reply:test-template', reply.id ?? '');
    if (status) status.innerText = result?.ok
      ? (result.message || `Đã điền mẫu \\${reply.keyword} vào ô soạn tin. Ảnh đã hiển thị; tin nhắn chưa gửi.`)
      : `Xem mẫu thất bại: ${(result && result.message) || 'không rõ lỗi'}`;
  } finally {
    if (button) button.disabled = false;
  }
}
function askDeleteQuickReply(index) {
  const reply = (workspaceData.quickReplies || [])[Number(index)];
  if (!reply) return;
  quickReplyEditor.pendingDeleteId = Number(index);
  const box = document.getElementById('quick-reply-confirm');
  const text = document.getElementById('quick-reply-confirm-text');
  if (!box || !text) {
    if (!confirm(`Xóa mẫu \\${reply.keyword || index + 1}?`)) return;
    deleteQuickReplyAt(index);
    return;
  }
  text.innerText = `Xóa mẫu \\${reply.keyword || index + 1}? Nội dung và liên kết ảnh sẽ mất khỏi danh sách.`;
  box.hidden = false;
  box.scrollIntoView({ block: 'nearest' });
}
function deleteQuickReplyAt(index) {
  workspaceData.quickReplies.splice(Number(index), 1);
  persistWorkspace();
  trackEvent('quick_reply_deleted', { index });
  quickReplyBrokenImages.clear();
  resetQuickReplyEditor();
  const confirmBox = document.getElementById('quick-reply-confirm');
  if (confirmBox) confirmBox.hidden = true;
  quickReplyEditor.pendingDeleteId = null;
  renderQuickReplies();
  inspectQuickReplyImages();
}
function saveQuickReplyFromEditor() {
  const input = document.getElementById('quick-reply-input');
  const keywordInput = document.getElementById('quick-reply-keyword');
  if (!input || !keywordInput) return addQuickReplyFromInput();
  const message = input.value.trim();
  const keyword = normalizeQuickReplyKeyword(keywordInput.value);
  if (!keyword) return setQuickReplyEditorError('Hãy nhập ký tự tắt, ví dụ baogia.');
  if (!message) return setQuickReplyEditorError('Hãy nhập nội dung tin nhắn mẫu.');
  const entries = workspaceData.quickReplies || [];
  const editingIndex = quickReplyEditor.editingId === null ? null : Number(quickReplyEditor.editingId);
  if (quickReplyKeywordTaken(keyword, editingIndex)) return setQuickReplyEditorError(`Ký tự tắt \\${keyword} đã tồn tại. Hãy dùng ký tự khác.`);
  const imagePath = pendingQuickReplyImagePath || '';
  if (editingIndex === null) {
    entries.push({ id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, keyword, message, imagePath });
    trackEvent('quick_reply_created', { length: entries.length });
  } else {
    entries[editingIndex] = { ...(entries[editingIndex] || {}), keyword, message, imagePath };
    trackEvent('quick_reply_updated', { index: editingIndex });
  }
  workspaceData.quickReplies = entries;
  persistWorkspace();
  resetQuickReplyEditor();
  const editor = document.getElementById('quick-reply-editor');
  if (editor) editor.hidden = true;
  renderQuickReplies();
  renderDashboard();
  inspectQuickReplyImages();
}
function addQuickReplyFromInput() {
  return saveQuickReplyFromEditor();
}
async function chooseQuickReplyImage() {
  const result = await ipcRenderer.invoke('quick-reply:choose-image');
  if (result?.canceled) return;
  const status = document.getElementById('quick-reply-image-status');
  if (!result?.ok) {
    if (status) status.innerText = `Lỗi chọn ảnh: ${(result && result.message) || 'không xác định'}`;
    return;
  }
  pendingQuickReplyImagePath = result.imagePath;
  quickReplyEditor.imagePath = result.imagePath;
  const note = result.converted ? `Ảnh ${result.format.toUpperCase()} đã được chuyển thành PNG thật.` : 'Ảnh PNG hợp lệ.';
  if (status) status.innerText = `Đã chọn ảnh: ${result.fileName} · ${note}`;
  setQuickReplyImageStatus(`Đã chọn ảnh: ${result.fileName} · ${note}`, result.imagePath);
}
async function inspectQuickReplyImages() {
  const result = await ipcRenderer.invoke('quick-reply:inspect-images');
  if (!result?.ok) return result;
  quickReplyBrokenImages.clear();
  const entries = workspaceData.quickReplies || [];
  const byId = new Map(entries.map((reply, index) => [String(reply.id ?? ''), index]));
  for (const item of [...(result.missing || []), ...(result.unsupported || [])]) {
    const index = item.id != null && byId.has(String(item.id)) ? byId.get(String(item.id)) : entries.findIndex((reply) => normalizeQuickReplyKeyword(reply.keyword) === normalizeQuickReplyKeyword(item.keyword));
    if (index >= 0) quickReplyBrokenImages.add(index);
  }
  const status = document.getElementById('quick-replies-status');
  const pending = (result.pending || []).length;
  if (status) {
    if (result.summary?.missing || result.summary?.unsupported) {
      status.innerText = `Có ${result.summary.missing || 0} ảnh mất và ${result.summary.unsupported || 0} ảnh sai định dạng. Chọn lại ảnh cho các mẫu đó.`;
    } else if (pending) {
      status.innerText = `Còn ${pending} ảnh chưa phải PNG thật. Nhà Yến Zalo sẽ tự chuyển khi khởi động hoặc bấm “Kiểm tra ảnh” → Chuyển đổi.`;
    }
  }
  renderQuickReplies();
  return result;
}
async function normalizeQuickReplyImagesFromButton(button) {
  const status = document.getElementById('quick-replies-status');
  if (button) button.disabled = true;
  try {
    if (status) status.innerText = 'Đang sao lưu và chuyển ảnh sang PNG thật...';
    const result = await ipcRenderer.invoke('quick-reply:normalize-images');
    if (result?.ok === false) {
      if (status) status.innerText = `Chuyển ảnh thất bại: ${result.message || 'không rõ lỗi'}`;
      return;
    }
    workspaceState = ipcRenderer.sendSync('workspace-get-state') || workspaceState;
    workspaceData = normalizeWorkspaceData(workspaceState.data);
    if (status) {
      status.innerText = result?.skipped
        ? 'Toàn bộ ảnh đã là PNG thật hoặc mẫu không có ảnh.'
        : `Đã chuyển ${result.converted || 0} ảnh sang PNG thật.${result.failed?.length ? ` Lỗi ${result.failed.length} ảnh.` : ''} Bản sao lưu nằm trong thư mục dữ liệu.`;
    }
    renderQuickReplies();
  } finally {
    if (button) button.disabled = false;
  }
}

async function syncQuickRepliesFromCrm(button = null) {
  const status = document.getElementById('quick-replies-status');
  if (button) button.disabled = true;
  try {
    if (status) status.innerText = 'Đang đồng bộ toàn bộ Tin nhắn nhanh từ Nhà Yến CRM…';
    const result = await ipcRenderer.invoke('quick-reply:sync-crm');
    if (!result?.ok) {
      if (status) status.innerText = `Không đồng bộ được CRM: ${result?.message || 'lỗi không xác định'}`;
      return result;
    }
    workspaceState = ipcRenderer.sendSync('workspace-get-state') || workspaceState;
    workspaceData = normalizeWorkspaceData(workspaceState.data);
    quickReplyBrokenImages.clear();
    renderQuickReplies();
    if (status) status.innerText = `Đã đồng bộ ${result.crmTotal} mẫu CRM: thêm ${result.added}, cập nhật ${result.updated}, tải ${result.images} ảnh PNG${result.imageErrors ? `, lỗi ${result.imageErrors} ảnh` : ''}. Tổng trong app: ${result.total}.`;
    return result;
  } finally {
    if (button) button.disabled = false;
  }
}

function renderDownloads() {
  const list = document.getElementById('downloads-list');
  if (!list) return;
  if (!downloads.length) {
    list.innerHTML = '<p class="download-meta">Chưa có file tải xuống.</p>';
    return;
  }
  list.innerHTML = downloads.slice().reverse().map((d) => {
    const pct = d.totalBytes ? Math.round((d.receivedBytes / d.totalBytes) * 100) : (d.status === 'completed' ? 100 : 0);
    return `<div class="download-item"><div class="title-sm">${escapeHtml(d.filename || 'download')}</div><div class="download-meta">${escapeHtml(d.statusText || d.status || '')} ${pct ? `• ${pct}%` : ''}</div><div class="progress mt-12"><span style="width:${pct}%"></span></div><div class="row mt-12"><button class="modal-btn cancel" data-folder="${d.id}">Thư mục</button><div><button class="modal-btn cancel" data-open="${d.id}">Mở</button><button class="modal-btn warn" data-remove="${d.id}">Xóa</button></div></div></div>`;
  }).join('');
  list.querySelectorAll('[data-open]').forEach((btn) => btn.onclick = () => ipcRenderer.send('open-download', btn.getAttribute('data-open')));
  list.querySelectorAll('[data-folder]').forEach((btn) => btn.onclick = () => ipcRenderer.send('show-download-in-folder', btn.getAttribute('data-folder')));
  list.querySelectorAll('[data-remove]').forEach((btn) => btn.onclick = () => {
    ipcRenderer.send('remove-download', btn.getAttribute('data-remove'));
    downloads = downloads.filter((item) => item.id !== btn.getAttribute('data-remove'));
    renderDownloads();
  });
}
function renderUpdate() {
  document.getElementById('update-status').innerText = updateState.message || 'Sẵn sàng kiểm tra cập nhật.';
  document.getElementById('update-progress').style.width = `${updateState.progress || 0}%`;
  const versionLine = document.getElementById('update-version-line');
  const notes = document.getElementById('update-release-notes');
  if (versionLine) versionLine.innerHTML = updateState.version
    ? `Phiên bản ${escapeHtml(updateState.currentVersion || '')} → <strong>${escapeHtml(updateState.version)}</strong>`
    : '';
  if (notes) notes.innerText = updateState.releaseNotes || '';
  document.getElementById('update-download').style.display = updateState.status === 'available' ? 'inline-flex' : 'none';
  document.getElementById('update-install').style.display = updateState.status === 'downloaded' ? 'inline-flex' : 'none';
  document.getElementById('update-check').style.display = ['available', 'downloading', 'downloaded'].includes(updateState.status) ? 'none' : 'inline-flex';
}

function fillAISettings() {
  document.getElementById('ai-endpoint').value = workspaceData.aiSettings.endpoint || localStorage.getItem('AI_ENDPOINT') || '';
  document.getElementById('ai-api-key').value = workspaceData.aiSettings.apiKey || localStorage.getItem('AI_API_KEY') || '';
  document.getElementById('ai-model').value = workspaceData.aiSettings.model || 'gpt-4o-mini';
}
function saveAISettings() {
  workspaceData.aiSettings = {
    endpoint: document.getElementById('ai-endpoint').value.trim(),
    apiKey: document.getElementById('ai-api-key').value.trim(),
    model: document.getElementById('ai-model').value.trim() || 'gpt-4o-mini',
  };
  localStorage.setItem('AI_ENDPOINT', workspaceData.aiSettings.endpoint);
  localStorage.setItem('AI_API_KEY', workspaceData.aiSettings.apiKey);
  persistWorkspace();
  trackEvent('ai_settings_saved', { endpoint: workspaceData.aiSettings.endpoint });
  document.getElementById('ai-status').innerText = 'Đã lưu cấu hình';
}
async function runAIRewrite() {
  saveAISettings();
  const text = document.getElementById('ai-input').value.trim();
  if (!text) return alert('Nhập nội dung cần rewrite trước.');
  document.getElementById('ai-status').innerText = 'Đang xử lý...';
  const result = await ipcRenderer.invoke('ai-rewrite', {
    endpoint: workspaceData.aiSettings.endpoint,
    apiKey: workspaceData.aiSettings.apiKey,
    model: workspaceData.aiSettings.model,
    text,
    mode: document.getElementById('ai-mode').value,
  });
  if (!result.ok) {
    document.getElementById('ai-status').innerText = result.message || 'Lỗi';
    return;
  }
  document.getElementById('ai-output').value = result.text || '';
  document.getElementById('ai-status').innerText = 'Hoàn tất';
  trackEvent('ai_rewrite', { mode: document.getElementById('ai-mode').value });
}

function renderAll() {
  renderSidebar();
  renderDashboard();
  renderWorkspaces();
  renderCRMCurrentChat();
  renderCampaigns();
  renderQuickReplies();
  renderDownloads();
  renderUpdate();
  fillAISettings();
}

avatarPreview.onclick = () => avatarInput.click();
avatarInput.onchange = (e) => {
  if (e.target.files && e.target.files[0]) {
    const file = e.target.files[0];
    const reader = new FileReader();
    reader.onload = (ev) => {
      tempAvatarPath = ev.target.result;
      updateAvatarPreview();
    };
    reader.readAsDataURL(file);
  }
};
platformInput.addEventListener('change', () => {
  updateAvatarPreview();
  const customUrlInput = document.getElementById('profile-custom-url-input');
  customUrlInput.style.display = (platformInput.value === 'custom') ? 'block' : 'none';
});
nameInput.addEventListener('input', updateAvatarPreview);

document.querySelectorAll('[data-close]').forEach((button) => { button.onclick = () => closeOverlay(button.getAttribute('data-close')); });
document.querySelectorAll('.overlay').forEach((overlay) => {
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) closeOverlay(overlay.id); });
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const open = overlayIds.find((id) => document.getElementById(id)?.style.display === 'flex');
  if (open) closeOverlay(open);
});
document.getElementById('btn-add-profile').onclick = () => openModal();
document.getElementById('modal-cancel').onclick = () => closeOverlay('modal-overlay');
document.getElementById('modal-clear-cache').onclick = async () => {
  if (!editingProfile) return;
  const btn = document.getElementById('modal-clear-cache');
  const prev = btn.textContent;
  try {
    btn.textContent = 'Đang dọn...';
    btn.disabled = true;
    const result = await ipcRenderer.invoke('profile-clear-cache', editingProfile.id);
    if (!result || !result.ok) return alert(result?.message || 'Không dọn được cache. Thử đóng rồi mở lại Zalo.');
    alert('Đã dọn cache cho tài khoản này (giữ đăng nhập). Trang sẽ tự tải lại.');
    closeOverlay('modal-overlay');
  } catch (e) {
    alert(e.message || String(e));
  } finally {
    btn.textContent = prev;
    btn.disabled = false;
  }
};
document.getElementById('modal-delete').onclick = () => {
  if (!editingProfile) return;
  if (!confirm(`Xóa tài khoản ${editingProfile.name}?`)) return;
  profiles = profiles.filter((profile) => profile.id !== editingProfile.id);
  ipcRenderer.send('delete-profile', editingProfile.id);
  activeProfileId = profiles[0]?.id || null;
  persistWorkspace();
  trackEvent('profile_deleted', { id: editingProfile.id });
  closeOverlay('modal-overlay');
  renderAll();
  if (activeProfileId) switchProfile(activeProfileId);
};
document.getElementById('modal-save').onclick = () => {
  const name = nameInput.value.trim() || `Tài khoản ${profiles.length + 1}`;
  const customUrl = document.getElementById('profile-custom-url-input').value.trim();
  if (platformInput.value === 'custom' && !customUrl) return alert('Vui lòng nhập URL cho Custom Link.');
  if (editingProfile) {
    const nextPlatform = platformInput.value;
    const previousPlatform = editingProfile.platform || 'zalo';
    editingProfile.name = name;
    editingProfile.proxy = proxyInput.value.trim();
    editingProfile.platform = nextPlatform;
    editingProfile.avatar = tempAvatarPath;
    editingProfile.customUrl = nextPlatform === 'custom' ? customUrl : '';
    if (previousPlatform !== nextPlatform) {
      editingProfile.partition = createProfilePartition(editingProfile.id, nextPlatform);
    }
    ipcRenderer.send('update-profile-settings', editingProfile);
    trackEvent('profile_updated', { id: editingProfile.id });
  } else {
    const id = createProfileId();
    const platform = platformInput.value;
    profiles.push({ id, name, avatar: tempAvatarPath, partition: createProfilePartition(id, platform), platform, proxy: proxyInput.value.trim(), customUrl: platform === 'custom' ? customUrl : '' });
    activeProfileId = id;
    trackEvent('profile_created', { id });
  }
  persistWorkspace();
  closeOverlay('modal-overlay');
  renderAll();
  if (activeProfileId) switchProfile(activeProfileId);
};

const legacyToolsLauncher = document.getElementById('btn-tools-launcher');
if (legacyToolsLauncher) legacyToolsLauncher.onclick = () => setLauncherOpen(!toolsLauncherOpen);
document.getElementById('tools-close').onclick = () => setLauncherOpen(false);
document.querySelectorAll('[data-tools-close="true"]').forEach((el) => {
  el.onclick = () => setLauncherOpen(false);
});
document.querySelectorAll('[data-tool-action]').forEach((el) => {
  el.onclick = () => runToolAction(el.dataset.toolAction, true);
});

function renderAppVersionBadge() {
  const badge = document.getElementById('app-version-badge');
  if (!badge) return;
  const version = String(require('./package.json').version || '').trim();
  badge.textContent = version ? `v${version}` : '';
  badge.hidden = !version;
}

renderAppVersionBadge();

function getSavedFontSize() {
  return Math.max(12, Math.min(24, Number(localStorage.getItem('nha-yen-font-size')) || 16));
}

function applyFontSize(fontSize, persist = false) {
  const safeFontSize = Math.max(12, Math.min(24, Number(fontSize) || 16));
  document.documentElement.style.setProperty('--app-font-size', `${safeFontSize}px`);
  document.getElementById('font-size-range').value = String(safeFontSize);
  document.getElementById('font-size-value').value = `${safeFontSize}px`;
  ipcRenderer.send('set-font-scale', safeFontSize);
  if (persist) localStorage.setItem('nha-yen-font-size', String(safeFontSize));
}

function setupPopupResizer() {
  const resizer = document.getElementById('popup-resizer');
  if (!resizer) return;
  let startX = 0;
  let startWidth = 0;
  const onMove = (event) => {
    applyPopupDockWidth(startWidth + (startX - event.clientX), false);
  };
  const onUp = (event) => {
    resizer.classList.remove('dragging');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    applyPopupDockWidth(startWidth + (startX - event.clientX), true);
  };
  resizer.addEventListener('pointerdown', (event) => {
    if (!document.body.classList.contains('popup-docked')) return;
    event.preventDefault();
    startX = event.clientX;
    startWidth = getSavedPopupWidth();
    resizer.classList.add('dragging');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
  resizer.addEventListener('dblclick', () => applyPopupDockWidth(POPUP_DEFAULT_WIDTH, true));
}
setupPopupResizer();

// Kéo thanh tiêu đề để dời cạnh trong của popup neo.
// Popup neo chiếm nguyên cột phải (full height) vì BrowserView của Zalo là một hình
// chữ nhật native đè lên HTML: dời popup vào giữa màn hình sẽ bị Zalo che mất.
// Nên hướng kéo duy nhất giữ được "Zalo vẫn thấy và vẫn dùng được" là kéo ngang.
function setupPopupHeaderDrag() {
  let dragging = false;
  let startX = 0;
  let startWidth = 0;
  const onMove = (event) => {
    if (!dragging) return;
    applyPopupDockWidth(startWidth + (startX - event.clientX), false);
  };
  const onUp = (event) => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('popup-dragging');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    applyPopupDockWidth(startWidth + (startX - event.clientX), true);
  };
  document.addEventListener('pointerdown', (event) => {
    if (!document.body.classList.contains('popup-docked')) return;
    const head = event.target.closest?.('.panel-head');
    if (!head || !head.closest('.overlay')) return;
    // Bấm vào nút/ô nhập trong tiêu đề thì vẫn là bấm, không phải kéo.
    if (event.target.closest('button, a, input, select, textarea, [role="button"]')) return;
    dragging = true;
    startX = event.clientX;
    startWidth = getSavedPopupWidth();
    document.body.classList.add('popup-dragging');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
  // Nháy đúp tiêu đề: về bề rộng mặc định.
  document.addEventListener('dblclick', (event) => {
    if (!document.body.classList.contains('popup-docked')) return;
    const head = event.target.closest?.('.panel-head');
    if (!head || !head.closest('.overlay')) return;
    if (event.target.closest('button, a, input, select, textarea')) return;
    applyPopupDockWidth(POPUP_DEFAULT_WIDTH, true);
  });
}
setupPopupHeaderDrag();
// Chỉ đặt biến CSS lúc mở; vùng Zalo chỉ bị thu khi thật sự có popup neo (openOverlay).
document.documentElement.style.setProperty('--popup-width', `${getSavedPopupWidth()}px`);

const appMoreButton = document.getElementById('app-more-button');
const appMoreMenu = document.getElementById('app-more-menu');
const fontSizeRange = document.getElementById('font-size-range');
appMoreButton.onclick = () => {
  const shouldOpen = appMoreMenu.hidden;
  appMoreMenu.hidden = !shouldOpen;
  appMoreButton.setAttribute('aria-expanded', String(shouldOpen));
  const utilityOpen = !document.getElementById('crm-utility-panel').classList.contains('collapsed');
  const utilityWidth = utilityOpen ? Math.max(330, Math.min(520, Number(localStorage.getItem('nha-yen-utility-width')) || 390)) : 0;
  ipcRenderer.send('set-utility-panel-width', shouldOpen ? Math.max(290, utilityWidth) : utilityWidth);
  if (shouldOpen) fontSizeRange.focus();
};
fontSizeRange.oninput = (event) => applyFontSize(event.target.value, false);
fontSizeRange.onchange = (event) => applyFontSize(event.target.value, true);
document.addEventListener('pointerdown', (event) => {
  if (!appMoreMenu.hidden && !event.target.closest('.topbar-actions')) {
    appMoreMenu.hidden = true;
    appMoreButton.setAttribute('aria-expanded', 'false');
    const utilityOpen = !document.getElementById('crm-utility-panel').classList.contains('collapsed');
    ipcRenderer.send('set-utility-panel-width', utilityOpen ? Math.max(330, Math.min(520, Number(localStorage.getItem('nha-yen-utility-width')) || 390)) : 0);
  }
});
applyFontSize(getSavedFontSize(), false);

function renderRemoteControl(state = {}) {
  document.getElementById('remote-off-state').hidden = !!state.running;
  document.getElementById('remote-on-state').hidden = !state.running;
  document.getElementById('remote-error').innerText = state.message || '';
  if (state.running) {
    document.getElementById('remote-reach').innerText = state.reach || 'Đang hoạt động';
    document.getElementById('remote-url').value = state.accessUrl || '';
    document.getElementById('remote-qr').src = state.qrDataUrl || '';
    startRemoteHost(state.accessUrl).catch((error) => {
      document.getElementById('remote-error').innerText = `Không phát được màn hình: ${error.message || error}`;
    });
  } else {
    stopRemoteHost();
  }
}

function stopRemoteHost() {
  try { remoteHostChannel?.close(); } catch {}
  try { remoteHostPointerChannel?.close(); } catch {}
  try { remoteHostPeer?.close(); } catch {}
  try { remoteHostSignal?.close(); } catch {}
  for (const track of remoteHostStream?.getTracks?.() || []) track.stop();
  remoteHostChannel = null;
  remoteHostPointerChannel = null;
  remoteHostPeer = null;
  remoteHostSignal = null;
  remoteHostStream = null;
}

async function startRemoteHost(accessUrl) {
  if (!accessUrl || (remoteHostSignal && remoteHostSignal.readyState <= 1)) return;
  stopRemoteHost();
  const url = new URL(accessUrl);
  const token = url.searchParams.get('token');
  if (!token) throw new Error('Thiếu token Remote.');
  const source = await ipcRenderer.invoke('remote-control:capture-source');
  if (!source) throw new Error('Không tìm thấy cửa sổ Nhà Yến Zalo.');
  remoteHostStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30 } },
  });
  const track = remoteHostStream.getVideoTracks()[0];
  if (track) track.contentHint = 'detail';
  const signalUrl = `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}/signal?token=${encodeURIComponent(token)}&role=host`;
  remoteHostSignal = new WebSocket(signalUrl);
  remoteHostSignal.onmessage = async (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'ready') await createRemoteOffer();
    else if (message.type === 'answer' && remoteHostPeer) await remoteHostPeer.setRemoteDescription({ type: 'answer', sdp: message.sdp });
    else if (message.type === 'ice' && remoteHostPeer && message.candidate) {
      try { await remoteHostPeer.addIceCandidate(message.candidate); } catch {}
    } else if (message.type === 'quality' && remoteHostPeer) {
      const sender = remoteHostPeer.getSenders().find((entry) => entry.track?.kind === 'video');
      if (sender) {
        const parameters = sender.getParameters();
        if (!parameters.encodings?.length) parameters.encodings = [{}];
        parameters.encodings[0].maxBitrate = Math.max(150000, Math.min(8000000, Number(message.bitrate) || 2500000));
        parameters.encodings[0].maxFramerate = Math.max(8, Math.min(30, Number(message.frameRate) || 30));
        try { await sender.setParameters(parameters); } catch {}
      }
    }
  };
  remoteHostSignal.onclose = () => {
    if (remoteHostSignal?.readyState === WebSocket.CLOSED) document.getElementById('remote-error').innerText = 'Kênh signaling đã ngắt.';
  };
}

async function createRemoteOffer() {
  if (!remoteHostSignal || remoteHostSignal.readyState !== WebSocket.OPEN || !remoteHostStream) return;
  if (remoteHostPeer && remoteHostPeer.connectionState !== 'closed') remoteHostPeer.close();
  remoteHostPeer = new RTCPeerConnection({ iceServers: [] });
  remoteHostStream.getTracks().forEach((track) => remoteHostPeer.addTrack(track, remoteHostStream));
  remoteHostChannel = remoteHostPeer.createDataChannel('control', { ordered: true });
  remoteHostPointerChannel = remoteHostPeer.createDataChannel('pointer', { ordered: false, maxRetransmits: 0 });
  const forwardRemoteInput = (event) => {
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    ipcRenderer.send('remote-input-event', payload);
  };
  remoteHostChannel.onmessage = forwardRemoteInput;
  remoteHostPointerChannel.onmessage = forwardRemoteInput;
  remoteHostPeer.onicecandidate = (event) => {
    if (event.candidate && remoteHostSignal?.readyState === WebSocket.OPEN) remoteHostSignal.send(JSON.stringify({ type: 'ice', candidate: event.candidate }));
  };
  const offer = await remoteHostPeer.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
  await remoteHostPeer.setLocalDescription(offer);
  remoteHostSignal.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }));
}

document.getElementById('remote-start').onclick = async () => {
  const button = document.getElementById('remote-start');
  button.disabled = true;
  button.innerText = 'Đang bật…';
  const result = await ipcRenderer.invoke('remote-control:start', { useTunnel: false });
  button.disabled = false;
  button.innerText = 'Bật Remote LAN';
  renderRemoteControl(result);
};
document.getElementById('remote-stop').onclick = async () => renderRemoteControl(await ipcRenderer.invoke('remote-control:stop'));
document.getElementById('remote-copy').onclick = () => {
  clipboard.writeText(document.getElementById('remote-url').value || '');
  document.getElementById('remote-copy').innerText = 'Đã sao chép';
  setTimeout(() => { document.getElementById('remote-copy').innerText = 'Sao chép'; }, 1200);
};
document.getElementById('zalo-groups-start').onclick = startZaloGroupScan;
document.getElementById('zalo-groups-profile-select').onchange = () => {
  activeZaloGroupScan = null; zaloGroupScanGroups = []; selectedZaloGroupIds = new Set(); zaloGroupSelect50Ids = new Set(); renderZaloGroupScan();
};
document.getElementById('zalo-users-profile-select').onchange = () => {};
document.getElementById('zalo-users-scan').onclick = startZaloUserScan;
document.getElementById('zalo-users-search').oninput = renderZaloUsers;
document.getElementById('zalo-users-sort').onchange = renderZaloUsers;
document.getElementById('zalo-users-inactivity').onchange = () => {
  selectedZaloUserIds = new Set();
  zaloUserSelect50Ids = new Set();
  document.getElementById('zalo-users-select-all').checked = false;
  renderZaloUsers();
};
document.getElementById('zalo-users-results').onchange = (event) => {
  const id = event.target?.dataset?.userId; if (!id) return;
  if (event.target.checked) selectedZaloUserIds.add(id); else selectedZaloUserIds.delete(id); renderZaloUsers();
};
document.getElementById('zalo-users-select-all').onchange = (event) => {
  for (const user of getVisibleZaloUsers()) event.target.checked ? selectedZaloUserIds.add(user.userId) : selectedZaloUserIds.delete(user.userId);
  renderZaloUsers();
};
// Nut Chọn 50 o ca hai panel Zalo: bam lan 1 chon 50 muc dang hien thi dau tien, bam lan 2 bo dung 50 muc do.
document.getElementById('zalo-users-select-50').onclick = toggleZaloUserSelect50;
document.getElementById('zalo-groups-select-50').onclick = toggleZaloGroupSelect50;
document.getElementById('zalo-users-send-open').onclick = () => { closeOverlay('zalo-users-overlay'); renderBulkMessageSummary('personal'); openOverlay('personal-messages-overlay'); };
document.getElementById('zalo-users-minimize').onclick = () => closeOverlay('zalo-users-overlay');
document.getElementById('zalo-groups-minimize').onclick = () => closeOverlay('zalo-groups-overlay');
document.getElementById('zalo-users-unfriend-open').onclick = async () => {
  const button = document.getElementById('zalo-users-unfriend-open');
  const status = document.getElementById('zalo-users-action-status');
  const selected = getVisibleZaloUsers().filter((user) => selectedZaloUserIds.has(user.userId));
  if (!activeZaloUserScan?.scanId || !selected.length) return;
  const batch = selected.slice(0, 1_000);
  const suffix = selected.length > batch.length ? `\nHạn mức ngày là 1.000 người; lượt này sẽ xử lý 1.000/${selected.length}.` : '';
  if (!confirm(`Hủy kết bạn với ${batch.length} người đã chọn?${suffix}\n\nỨng dụng gọi trực tiếp theo userId trong đúng phiên Zalo; anh có thể hạ popup để tiếp tục nhắn khách.`)) return;
  setZaloUserTaskRunning(true, `Đang hủy 0/${batch.length}`);
  button.disabled = true;
  document.getElementById('zalo-users-send-open').disabled = true;
  document.getElementById('zalo-users-scan').disabled = true;
  let succeeded = 0;
  let failed = 0;
  const failureMessages = [];
  for (let index = 0; index < batch.length; index += 1) {
    const user = batch[index];
    button.innerText = `Đang hủy ${index + 1}/${batch.length}`;
    setZaloUserTaskRunning(true, `Đang hủy ${index + 1}/${batch.length}: ${user.name}`);
    status.innerText = `Đang xử lý ${user.name}…`;
    const result = await invokeWithRendererTimeout('zalo-user-action:unfriend', [activeZaloUserScan.scanId, user.userId], 25_000);
    if (result?.ok) {
      succeeded += 1;
      selectedZaloUserIds.delete(user.userId);
      zaloUserSelect50Ids.delete(user.userId);
      zaloUsers = zaloUsers.filter((item) => item.userId !== user.userId);
    } else {
      failed += 1;
      const detail = `${user.name}: ${result?.message || 'Không hủy được kết bạn.'}`;
      failureMessages.push(detail);
      status.innerText = detail;
    }
    renderZaloUsers();
    if (index < batch.length - 1) {
      const waitMs = result?.ok
        ? ((index + 1) % 5 === 0 ? randomBetween(60_000, 120_000) : randomBetween(5_000, 10_000))
        : randomBetween(2_000, 5_000);
      status.innerText = `Đã xử lý ${index + 1}/${batch.length} • tạm nghỉ ${Math.ceil(waitMs / 1000)} giây`;
      await wait(waitMs);
    }
  }
  button.innerText = 'Hủy kết bạn';
  setZaloUserTaskRunning(false);
  document.getElementById('zalo-users-scan').disabled = false;
  status.innerText = `Hoàn tất: ${succeeded} thành công, ${failed} lỗi.${failureMessages.length ? ` Lỗi cuối: ${failureMessages[failureMessages.length - 1]}` : ''}`;
  renderZaloUsers();
};
document.getElementById('personal-message-run').onclick = () => runIndependentBulkMessage('personal');
document.getElementById('group-message-run').onclick = () => runIndependentBulkMessage('group');
document.getElementById('personal-message-stop').onclick = document.getElementById('group-message-stop').onclick = () => { bulkMessageStopRequested = true; };
document.getElementById('zalo-groups-cancel').onclick = cancelZaloGroupScan;
document.getElementById('zalo-groups-search').oninput = renderZaloGroupBrowser;
document.getElementById('zalo-groups-sort').onchange = renderZaloGroupBrowser;
document.getElementById('zalo-groups-clear-filter').onclick = () => {
  document.getElementById('zalo-groups-search').value = '';
  renderZaloGroupBrowser();
  document.getElementById('zalo-groups-search').focus();
};
document.getElementById('zalo-groups-select-visible').onchange = (event) => {
  for (const group of getVisibleZaloGroups()) {
    if (event.target.checked) selectedZaloGroupIds.add(group.groupId);
    else selectedZaloGroupIds.delete(group.groupId);
  }
  renderZaloGroupBrowser();
};
document.getElementById('zalo-groups-results').onchange = (event) => {
  const groupId = event.target?.dataset?.groupId;
  if (!groupId) return;
  if (event.target.checked) selectedZaloGroupIds.add(groupId);
  else selectedZaloGroupIds.delete(groupId);
  renderZaloGroupBrowser();
};
document.getElementById('zalo-groups-send-open').onclick = () => openZaloGroupAction('send');
document.getElementById('zalo-groups-leave-open').onclick = () => openZaloGroupAction('leave');
document.getElementById('zalo-groups-action-run').onclick = runZaloGroupAction;
document.getElementById('zalo-groups-action-stop').onclick = () => {
  zaloGroupAction.stopRequested = true;
  document.getElementById('zalo-groups-action-stop').disabled = true;
  document.getElementById('zalo-groups-action-progress').innerText = 'Đang dừng sau nhóm hiện tại…';
};
document.getElementById('zalo-groups-action-close').onclick = () => {
  if (!zaloGroupAction.running) document.getElementById('zalo-groups-action-panel').hidden = true;
};
document.getElementById('workspace-create-btn').onclick = () => {
  const input = document.getElementById('workspace-name-input');
  const name = input.value.trim() || 'Workspace mới';
  workspaceState = ipcRenderer.sendSync('workspace-create', name);
  workspaceData = normalizeWorkspaceData(workspaceState.data);
  profiles = normalizeProfiles(workspaceData.profiles);
  activeProfileId = profiles[0]?.id || null;
  input.value = '';
  trackEvent('workspace_created', { name });
  closeOverlay('workspace-overlay');
  renderAll();
  if (activeProfileId) switchProfile(activeProfileId);
};

document.getElementById('crm-search').addEventListener('input', renderCRMList);
document.getElementById('crm-fill-current').onclick = () => {
  if (!currentChatSnapshot) return alert('Chưa lấy được snapshot tab hiện tại.');
  fillContactForm({ name: currentChatSnapshot.name || '', phone: '', status: 'new', tags: [currentChatSnapshot.platform || ''], note: `Imported từ ${currentChatSnapshot.platform || 'chat'}` });
};
document.getElementById('crm-save').onclick = saveContact;
document.getElementById('crm-delete').onclick = deleteContact;

document.getElementById('campaign-create').onclick = createCampaign;
document.getElementById('campaign-run-active').onclick = () => {
  if (!selectedCampaignId) return alert('Hãy chọn campaign trước.');
  runCampaign(selectedCampaignId);
};

document.getElementById('quick-reply-add').onclick = addQuickReplyFromInput;
document.getElementById('quick-reply-image').onclick = chooseQuickReplyImage;
document.getElementById('quick-replies-search').addEventListener('input', (event) => {
  quickReplyTableView.search = event.target.value || '';
  renderQuickReplies();
});
document.getElementById('quick-reply-create').onclick = () => openQuickReplyEditor(null);
document.getElementById('quick-reply-editor-cancel').onclick = () => { document.getElementById('quick-reply-editor').hidden = true; resetQuickReplyEditor(); };
document.getElementById('quick-reply-image-remove').onclick = () => { pendingQuickReplyImagePath = ''; quickReplyEditor.imagePath = ''; setQuickReplyImageStatus('Không kèm ảnh.', null); };
document.getElementById('quick-reply-confirm-yes').onclick = () => { if (quickReplyEditor.pendingDeleteId !== null) deleteQuickReplyAt(quickReplyEditor.pendingDeleteId); };
document.getElementById('quick-reply-confirm-no').onclick = () => { quickReplyEditor.pendingDeleteId = null; document.getElementById('quick-reply-confirm').hidden = true; };
document.getElementById('quick-reply-test').onclick = (event) => {
  const index = quickReplyEditor.editingId === null ? -1 : Number(quickReplyEditor.editingId);
  if (index < 0) return setQuickReplyEditorError('Hãy lưu mẫu trước khi bấm Xem.');
  return testQuickReply(index, event.currentTarget);
};
document.getElementById('quick-reply-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    addQuickReplyFromInput();
  }
});

document.getElementById('ai-save-settings').onclick = saveAISettings;
document.getElementById('ai-run').onclick = runAIRewrite;
document.getElementById('ai-copy').onclick = () => {
  clipboard.writeText(document.getElementById('ai-output').value || '');
  document.getElementById('ai-status').innerText = 'Đã copy';
};
document.getElementById('ai-save-quick-reply').onclick = () => {
  const text = document.getElementById('ai-output').value.trim();
  if (!text) return;
  workspaceData.quickReplies.push({ message: text });
  persistWorkspace();
  trackEvent('quick_reply_created_from_ai', {});
  renderQuickReplies();
  document.getElementById('ai-status').innerText = 'Đã lưu vào quick replies';
};

document.getElementById('update-check').onclick = () => ipcRenderer.send('check-for-updates');
document.getElementById('update-download').onclick = () => ipcRenderer.send('download-update');
document.getElementById('update-install').onclick = () => ipcRenderer.send('install-update');

function showLockOverlay(setupMode = false) {
  appLocked = true;
  openOverlay('lock-overlay');
  document.getElementById('lock-password-confirm').style.display = setupMode ? 'block' : 'none';
  document.getElementById('lock-remove').style.display = (!setupMode && hasLockPassword) ? 'block' : 'none';
  document.getElementById('lock-hint').innerText = setupMode ? 'Tạo mật khẩu khóa ứng dụng.' : 'Nhập mật khẩu để mở khóa.';
  document.getElementById('lock-submit').innerText = setupMode ? 'Tạo khóa' : 'Mở khóa';
  document.getElementById('lock-password').value = '';
  document.getElementById('lock-password-confirm').value = '';
}
function hideLockOverlay() {
  appLocked = false;
  closeOverlay('lock-overlay');
}

// ---- Overlay bắt buộc: nhập master password (đã set sẵn) + mã hoá at-rest ----
let storeUnlocked = true; // giả định đã mở; main gửi need-master-password nếu chưa
function setSecureRememberVisible(visible) {
  const el = document.getElementById('secure-remember-row');
  if (el) el.style.display = visible ? 'block' : 'none';
}
function showSecureOverlay() {
  storeUnlocked = false;
  appLocked = true;
  openOverlay('lock-overlay');
  document.getElementById('lock-password-confirm').style.display = 'none';
  document.getElementById('lock-remove').style.display = 'none';
  document.getElementById('lock-password').value = '';
  document.getElementById('lock-password-confirm').value = '';
  setSecureRememberVisible(true);
  const hint = document.getElementById('lock-hint');
  const submit = document.getElementById('lock-submit');
  hint.innerText = 'Nhập mật khẩu bảo vệ dữ liệu để mở khoá.';
  submit.innerText = 'Mở khoá';
  setTimeout(() => { const el = document.getElementById('lock-password'); if (el) el.focus(); }, 50);
}
function hideSecureOverlay() {
  storeUnlocked = true;
  appLocked = false;
  closeOverlay('lock-overlay');
}
async function submitSecurePassword() {
  const password = document.getElementById('lock-password').value;
  if (!password) return alert('Vui lòng nhập mật khẩu.');
  const rememberEl = document.getElementById('secure-remember');
  const remember = !!(rememberEl && rememberEl.checked);
  const submit = document.getElementById('lock-submit');
  if (submit) submit.disabled = true;
  try {
    const result = await ipcRenderer.invoke('secure:unlock', { password, remember });
    if (result && result.ok) {
      hideSecureOverlay();
    } else {
      alert((result && result.message) || 'Sai mật khẩu.');
    }
  } catch (err) {
    alert('Lỗi mở khoá: ' + (err && err.message ? err.message : err));
  } finally {
    if (submit) submit.disabled = false;
  }
}

document.getElementById('lock-submit').onclick = () => {
  if (!storeUnlocked) return submitSecurePassword();
  const password = document.getElementById('lock-password').value;
  const confirmPassword = document.getElementById('lock-password-confirm').value;
  if (!hasLockPassword) {
    if (!password || password !== confirmPassword) return alert('Mật khẩu không khớp.');
    ipcRenderer.send('set-lock-password', password);
  } else ipcRenderer.send('unlock-app', password);
};
document.getElementById('lock-remove').onclick = () => {
  const password = document.getElementById('lock-password').value;
  if (!password) return alert('Vui lòng nhập mật khẩu hiện tại để gỡ khóa.');
  ipcRenderer.send('remove-lock-password', password);
};
document.getElementById('lock-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('lock-submit').click(); });
document.getElementById('lock-password-confirm').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('lock-submit').click(); });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !appMoreMenu.hidden) {
    appMoreMenu.hidden = true;
    appMoreButton.setAttribute('aria-expanded', 'false');
    const utilityOpen = !document.getElementById('crm-utility-panel').classList.contains('collapsed');
    ipcRenderer.send('set-utility-panel-width', utilityOpen ? Math.max(330, Math.min(520, Number(localStorage.getItem('nha-yen-utility-width')) || 390)) : 0);
    return;
  }
  if (e.key === 'Escape' && toolsLauncherOpen) {
    e.preventDefault();
    setLauncherOpen(false);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
    e.preventDefault();
    ipcRenderer.send('lock-app');
  }
});

ipcRenderer.on('downloads-list', (_, list) => { downloads = list || []; renderDownloads(); });
ipcRenderer.on('download-updated', (_, item) => { downloads = downloads.filter((entry) => entry.id !== item.id).concat(item); renderDownloads(); renderDashboard(); });
ipcRenderer.on('update-state', (_, state) => { updateState = state; renderUpdate(); });
ipcRenderer.on('lock-state', (_, state) => {
  hasLockPassword = !!state.hasPassword;
  document.getElementById('btn-shield').classList.toggle('active', !!state.zadarkShield);
  if (state.locked) showLockOverlay(!hasLockPassword);
});
ipcRenderer.on('need-master-password', () => {
  showSecureOverlay();
});
ipcRenderer.on('store-unlocked', () => {
  hideSecureOverlay();
});
ipcRenderer.on('unlock-result', (_, result) => { 
  if (result.ok) { 
    if (result.removed) { hasLockPassword = false; alert('Đã gỡ mật khẩu khóa ứng dụng thành công!'); }
    else hasLockPassword = true; 
    hideLockOverlay(); 
  } else alert(result.message || 'Sai mật khẩu.'); 
});
ipcRenderer.on('zalo-group-scan:update', (_, update) => {
  if (activeZaloGroupScan?.scanId && update.scanId !== activeZaloGroupScan.scanId) return;
  activeZaloGroupScan = { ...(activeZaloGroupScan || {}), ...update };
  if (update.failure) {
    const key = String(update.failure.groupId || '');
    zaloGroupScanFailures = zaloGroupScanFailures.filter((item) => String(item.groupId || '') !== key);
    zaloGroupScanFailures.push(update.failure);
  }
  renderZaloGroupScan(update);
  if (update.status === 'completed') loadCompletedZaloGroups();
});

ipcRenderer.on('update-profile-badge', (_, { id, count }) => {
  const badge = document.getElementById(`badge-${id}`);
  if (badge) {
    badge.innerText = count > 99 ? '99+' : count;
    badge.style.display = count > 0 ? 'flex' : 'none';
  }
});
ipcRenderer.on('update-profile-info', (_, payload) => {
  const profile = profiles.find((entry) => entry.id === payload.id);
  if (!profile) return;
  let changed = false;
  if (payload.name && profile.zaloDisplayName !== payload.name) { profile.zaloDisplayName = payload.name; changed = true; }
  if (payload.avatarUrl && /^https?:\/\//i.test(payload.avatarUrl) && profile.avatar !== payload.avatarUrl) { profile.avatar = payload.avatarUrl; changed = true; }
  if (changed) {
    persistWorkspace();
    renderSidebar();
  }
});
ipcRenderer.on('current-chat-info', (_, info) => {
  currentChatSnapshot = info;
  renderCRMCurrentChat();
  renderUtilityContext();
  const panelOpen = !document.getElementById('crm-utility-panel').classList.contains('collapsed');
  if (panelOpen && currentUtilityTab === 'design') {
    const code = extractOrderCode(info?.name || '');
    if (code && document.getElementById('design-search').value !== code) {
      document.getElementById('design-search').value = code;
      void loadDesignOrders();
    }
  }
});
ipcRenderer.on('profile-connection-state', (_, payload) => {
  profileConnectionStates.set(payload.id, payload.state);
  renderSidebar();
});
// Chẩn đoán "không thấy hội thoại" — chỉ báo khi đúng nick đang mở, kèm hướng dẫn dọn cache.
ipcRenderer.on('zalo-conversation-diag', (_, payload) => {
  if (payload.profileId !== activeProfileId) return;
  const mb = payload.cacheBytes > 0 ? Math.round(payload.cacheBytes / 1048576) : null;
  const cacheLine = mb === null ? '' : `\nDung lượng cache Zalo hiện tại: ${mb} MB`;
  const already = localStorage.getItem(`zalo-diag-${payload.profileId}`);
  if (already && (Date.now() - Number(already)) < 60000) return; // chặn spam trong 60s
  localStorage.setItem(`zalo-diag-${payload.profileId}`, String(Date.now()));
  alert(`Nhà Yến Zalo không đếm được hội thoại nào trên nick này (trang đã tải xong).${cacheLine}\n\nHãy thử:\n1. Chỉnh sửa tài khoản → bấm "Dọn cache (giữ đăng nhập)".\n2. Hoặc chuột phải vào vùng Zalo → "Tải lại trang".\n\nNếu vẫn không thấy, có thể đang ở màn hình đăng nhập hoặc Zalo đổi giao diện — hãy báo lại kèm ảnh chụp.`);
});
ipcRenderer.on('remote-control-state', (_, state) => renderRemoteControl(state));
ipcRenderer.on('zalo-user-scan:update', async (_, update) => {
  if (!activeZaloUserScan || update.scanId !== activeZaloUserScan.scanId) return;
  activeZaloUserScan = { ...activeZaloUserScan, ...update };
  if (update.status === 'completed') {
    const result = await ipcRenderer.invoke('zalo-user-scan:list', update.scanId);
    if (result?.ok) { zaloUsers = result.users || []; selectedZaloUserIds = new Set(); }
  }
  renderZaloUsers(update);
});
ipcRenderer.on('remote-tool-action', (_, action) => {
  if (TOOL_ACTION_HANDLERS[action]) runToolAction(action, false);
});

const settings = ipcRenderer.sendSync('get-settings');
isDarkMode = settings.isDarkMode;
hasLockPassword = !!settings.hasLockPassword;
document.body.classList.remove('dark-mode');
document.body.classList.add('light-mode');
const sunIcon = document.getElementById('icon-sun');
const moonIcon = document.getElementById('icon-moon');
if (sunIcon) sunIcon.style.display = isDarkMode ? 'none' : 'block';
if (moonIcon) moonIcon.style.display = isDarkMode ? 'block' : 'none';
document.getElementById('btn-pin').classList.toggle('active', !!settings.alwaysOnTop);
const shieldButton = document.getElementById('btn-shield');
if (shieldButton) shieldButton.classList.toggle('active', !!settings.zadarkShield);

document.querySelectorAll('[data-paper-type]').forEach((button) => {
  button.onclick = () => {
    quotePaperType = button.dataset.paperType;
    document.querySelectorAll('[data-paper-type]').forEach((item) => item.classList.toggle('active', item === button));
    if (quotePaperType === 'gap3in1') document.getElementById('quote-emboss').checked = false;
    renderQuote();
  };
});
['quote-quantity', 'quote-emboss', 'quote-emboss-positions'].forEach((id) => document.getElementById(id).addEventListener('input', renderQuote));
document.getElementById('quote-copy').onclick = () => {
  const text = buildQuoteText(quoteOptions());
  if (!text) return;
  clipboard.writeText(text);
  document.getElementById('quote-status').innerText = 'Đã copy báo giá.';
};
document.getElementById('quote-insert').onclick = async () => {
  const text = buildQuoteText(quoteOptions());
  const result = await ipcRenderer.invoke('active-chat-insert-text', text, { profileId: activeProfileId });
  document.getElementById('quote-status').innerText = result?.message || (result?.ok ? 'Đã chèn báo giá.' : 'Không chèn được báo giá.');
};
if (document.getElementById('crm-base-url')) {
document.getElementById('crm-connection-toggle').onclick = () => {
  const box = document.getElementById('crm-connection-box');
  box.hidden = !box.hidden;
  document.getElementById('crm-connection-toggle').setAttribute('aria-expanded', String(!box.hidden));
};
document.getElementById('crm-base-url').value = localStorage.getItem('nha-yen-crm-url') || 'https://nhayencrm.com';
document.getElementById('crm-login').onclick = async () => {
  const status = document.getElementById('crm-status');
  status.innerText = 'Đang kết nối CRM…';
  const result = await ipcRenderer.invoke('crm:login', {
    baseUrl: document.getElementById('crm-base-url').value,
    identifier: document.getElementById('crm-identifier').value,
    password: document.getElementById('crm-password').value,
  });
  if (!result?.ok) { status.innerText = result?.message || 'Không kết nối được CRM.'; return; }
  crmConnected = true; crmAccounts = result.accounts || [];
  localStorage.setItem('nha-yen-crm-url', result.baseUrl);
  const crmUserName = document.getElementById('crm-user-name');
  if (crmUserName) crmUserName.innerText = result.user?.fullName || result.user?.email || 'Đã kết nối CRM';
  document.getElementById('crm-password').value = '';
  status.innerText = 'Kết nối CRM thành công.';
  renderCrmConnection();
  await Promise.allSettled([resolveCrmConversation({ quiet: true }), loadDesigners(), loadDesignOrders(), loadPancakeWarehouses(), loadPancakeOrders(), syncQuickRepliesFromCrm()]);
};
document.getElementById('crm-logout').onclick = async () => { await ipcRenderer.invoke('crm:logout'); crmConnected = false; crmAccounts = []; crmConversation = null; renderCrmConnection(); renderUtilityContext(); };
document.getElementById('crm-account-select').onchange = async (event) => {
  workspaceData.crmAccountMappings[activeProfileId] = event.target.value;
  persistWorkspace(); crmConversation = null;
  await Promise.allSettled([resolveCrmConversation({ quiet: true }), loadDesignOrders(), loadPancakeOrders()]);
};
const mappingSaveButton = document.getElementById('mapping-save');
if (mappingSaveButton) mappingSaveButton.onclick = async () => {
  try {
    const conversation = await resolveCrmConversation();
    const orderCode = document.getElementById('mapping-order-code').value.trim();
    const context = getCurrentGroupContext();
    const next = upsertGroupMapping(workspaceData.groupMappings, { profileId: context.profileId, groupId: context.group.groupId, groupName: context.name, orderCode, crmConversationId: conversation.id });
    workspaceData.groupMappings = next.entries; persistWorkspace(); renderUtilityContext();
    await Promise.allSettled([refreshPancakeCurrent(), loadDesignOrders()]);
  } catch (error) { alert(error.message); }
};
document.getElementById('pancake-refresh').onclick = () => loadPancakeOrders();
// Nut "Lam moi" o dau panel: doi sang hoi thoai nhom khac roi bam de bat lai ma don tu ten hoi thoai.
document.getElementById('pancake-refresh-current').onclick = async () => {
  await refreshCurrentChatSnapshot();
  renderUtilityContext();
  await refreshPancakeCurrent();
};
document.getElementById('pancake-search').addEventListener('change', () => loadPancakeOrders());
document.getElementById('pancake-search').addEventListener('keydown', (event) => { if (event.key === 'Enter') void loadPancakeOrders(); });
let pancakeProductTimer = null;
document.getElementById('pancake-product-search').addEventListener('input', () => { clearTimeout(pancakeProductTimer); pancakeProductTimer = setTimeout(searchPancakeProducts, 250); });
// Ket qua tim dang overlay: an khi click ra ngoai (tre de nut ket qua kip duoc click).
document.getElementById('pancake-product-search').addEventListener('blur', () => {
  setTimeout(() => {
    const active = document.activeElement;
    if (active && active.closest('#pancake-product-results')) return;
    document.getElementById('pancake-product-results').hidden = true;
  }, 150);
});
['pancake-shipping', 'pancake-discount', 'pancake-deposit'].forEach((id) => document.getElementById(id).addEventListener('input', renderPancakeSummary));
document.getElementById('pancake-create').onclick = async () => {
  const button = document.getElementById('pancake-create');
  try {
    button.disabled = true;
    button.innerText = 'Đang lưu…';
    const orderCode = currentPancakeLink?.orderCode || currentPancakeLink?.pancakeOrderId;
    if (!orderCode) throw new Error('Chưa tải đơn Pancake nào để lưu. Hãy tìm hoặc tạo đơn trước.');
    const payload = pancakeOrderPayload();
    await pancakeRequest(`/shops/609730/orders/${encodeURIComponent(orderCode)}`, 'PUT', pancakeApiPayload(payload));
    document.getElementById('crm-status').innerText = `Đã lưu thay đổi ${orderCode}`;
    await loadPancakeOrderDetail(orderCode).catch(() => {});
    await loadPancakeOrders().catch(() => {});
  } catch (error) { document.getElementById('crm-status').innerText = error.message; }
  finally { button.disabled = false; button.innerText = 'Lưu thay đổi'; }
};
// Hien ket qua nut Tạo đơn tren popup: success (xanh, cho sao chep ma) hoac error
// (do, khong cho sao chep). Don thu 0d tao tu dong co them nut Huy ngay tren popup.
function showPancakeCreatePopup(mode, text, { cancelCode = '' } = {}) {
  pancakePopupMode = mode;
  pancakeTestOrderCode = cancelCode;
  const popup = document.getElementById('pancake-created-popup');
  popup.dataset.mode = mode;
  document.getElementById('pancake-created-label').innerText = mode === 'error' ? 'Không tạo được đơn' : 'Đã tạo mã đơn';
  document.getElementById('pancake-created-code').innerText = text;
  document.getElementById('pancake-created-copy').hidden = mode === 'error';
  document.getElementById('pancake-created-cancel').hidden = !cancelCode;
  popup.classList.add('show');
  // Cua so hep (minWidth 960): popup neo ben trai nut Tao don co the tran ra ngoai mep man hinh.
  // offsetParent la .topbar-actions nen phai tru toa do cua no de ghim dung 8px tinh theo cua so.
  popup.style.left = '';
  popup.style.right = '';
  if (popup.getBoundingClientRect().left < 8) {
    popup.style.left = `${8 - popup.offsetParent.getBoundingClientRect().left}px`;
    popup.style.right = 'auto';
  }
}
// Nút "Tạo đơn" trên topbar: anh chi can lay ma don nen moi thu tu dong — kho tu chon
// (uu tien kho cho tao don), chua co san pham thi them dong tam 0d de Pancake van cap ma.
// Luon hien popup ket qua (ma don de sao chep, hoac loi) thay vi im lang.
document.getElementById('pancake-topbar-create').onclick = async () => {
  const button = document.getElementById('pancake-topbar-create');
  try {
    button.disabled = true;
    button.innerText = 'Đang tạo…';
    if (!pancakeWarehouses.length) await loadPancakeWarehouses();
    const select = document.getElementById('pancake-warehouse');
    if (!select.value) {
      const preferred = pancakeWarehouses.find((warehouse) => warehouse.allow_create_order) || pancakeWarehouses[0];
      if (preferred) select.value = preferred.id;
    }
    let testOrderCode = '';
    if (!pancakeItems.length) {
      button.innerText = 'Đang tạo đơn tạm 0đ…';
      let catalog = [];
      try { catalog = await loadPancakeProductCatalog(); } catch { /* fallback duoi se lo */ }
      const first = catalog[0];
      if (first) {
        pancakeItems = [{
          variation_id: first.id, product_id: first.product_id || first.product?.id,
          name: 'Đơn tạm 0đ (tự tạo để lấy mã)', detail: '', price: 0, quantity: 1,
        }];
      } else {
        throw new Error('Chưa có sản phẩm trong Pancake và cũng không có sẵn dòng nào để tạo đơn tạm.');
      }
      testOrderCode = 'auto';
    }
    const payload = pancakeApiPayload(pancakeOrderPayload());
    const result = await pancakeRequest('/shops/609730/orders', 'POST', payload);
    const order = result.data || result.order || result;
    const code = String(order.orderCode || order.display_id || order.id || '');
    document.getElementById('crm-status').innerText = `Đã tạo đơn ${code}`;
    showPancakeCreatePopup('success', code, { cancelCode: testOrderCode ? code : '' });
    // Chi reload don vua tao khi la don anh nhap tay; don tam 0d khong ghi de form dang nhap.
    if (!testOrderCode) {
      await loadPancakeOrderDetail(code).catch(() => {});
      await loadPancakeOrders().catch(() => {});
    }
  } catch (error) {
    showPancakeCreatePopup('error', error.message || 'Không tạo được đơn.');
  }
  finally { button.disabled = false; button.innerText = 'Tạo đơn'; }
};
// Popup "Da tao ma don": nut sao chep ma don vao clipboard
document.getElementById('pancake-created-copy').onclick = () => {
  if (pancakePopupMode === 'error') return;
  const code = document.getElementById('pancake-created-code').innerText;
  clipboard.writeText(code);
  const btn = document.getElementById('pancake-created-copy');
  btn.innerText = 'Đã copy!';
  setTimeout(() => { btn.innerText = 'Sao chép'; }, 1200);
};
// Popup: nut Huy chi xuat hien cho don thu 0d — chuyen don sang trang thai "canceled"
// (da kiem thu truc tiep tren API Pancake: PUT /orders/{ma} voi status: 6) roi dong popup.
document.getElementById('pancake-created-cancel').onclick = async () => {
  const btn = document.getElementById('pancake-created-cancel');
  const code = pancakeTestOrderCode || document.getElementById('pancake-created-code').innerText;
  try {
    btn.disabled = true;
    btn.innerText = 'Đang hủy…';
    await pancakeRequest(`/shops/609730/orders/${encodeURIComponent(code)}`, 'PUT', { status: 6 });
    document.getElementById('pancake-created-popup').classList.remove('show');
    pancakeTestOrderCode = '';
    pancakeItems = [];
    renderPancakeItems();
  } catch (error) { btn.innerText = 'Hủy thất bại'; btn.disabled = false; }
};
// Popup "Da tao ma don": dong popup khi bam X hoac bam ra ngoai
document.getElementById('pancake-created-close').onclick = () => {
  document.getElementById('pancake-created-popup').classList.remove('show');
};
document.addEventListener('mousedown', (e) => {
  const popup = document.getElementById('pancake-created-popup');
  if (!popup.classList.contains('show')) return;
  if (popup.contains(e.target)) return;
  popup.classList.remove('show');
});
document.getElementById('pancake-reset').onclick = async () => {
  if (!confirm('Thiết lập lại các thay đổi đang nhập? Dữ liệu đã lưu trên CRM/Pancake sẽ không bị xóa.')) return;
  if (currentPancakeLink?.orderCode || currentPancakeLink?.pancakeOrderId) {
    const code = currentPancakeLink.orderCode || currentPancakeLink.pancakeOrderId;
    try { await loadPancakeOrderDetail(code); document.getElementById('crm-status').innerText = 'Đã khôi phục dữ liệu đơn đã lưu.'; }
    catch (error) { document.getElementById('crm-status').innerText = error.message; }
    return;
  }
  ['pancake-customer', 'pancake-phone', 'pancake-address', 'pancake-note', 'pancake-print-note'].forEach((id) => { document.getElementById(id).value = ''; });
  ['pancake-shipping', 'pancake-discount', 'pancake-deposit'].forEach((id) => { document.getElementById(id).value = '0'; });
  document.getElementById('pancake-customer-chip-name').innerText = 'Chưa xác định khách hàng';
  pancakeItems = [];
  renderPancakeItems();
  document.getElementById('pancake-create').innerText = 'Lưu thay đổi';
};
const designRefreshButton = document.getElementById('design-refresh');
if (designRefreshButton) designRefreshButton.onclick = loadDesignOrders;
let designSearchTimer = null;
document.getElementById('design-search').addEventListener('input', () => { clearTimeout(designSearchTimer); designSearchTimer = setTimeout(loadDesignOrders, 300); });
document.getElementById('design-new').onclick = () => fillDesignForm(null);
document.getElementById('design-back').onclick = showDesignListView;
document.querySelectorAll('.design-chip').forEach((button) => button.onclick = () => {
  designStatusFilter = button.dataset.status || '';
  document.querySelectorAll('.design-chip').forEach((chip) => chip.classList.toggle('active', chip === button));
  void loadDesignOrders();
});
['design-filter-designer', 'design-date-from', 'design-date-to'].forEach((id) => document.getElementById(id).addEventListener('change', loadDesignOrders));
document.getElementById('design-save').onclick = async () => {
  const button = document.getElementById('design-save');
  const message = document.getElementById('design-status-message');
  try {
    button.disabled = true; message.innerText = 'Đang lưu đơn thiết kế…';
    const payload = {
      orderCode: document.getElementById('design-code').value.trim(),
      status: document.getElementById('design-status').value,
      fileCount: Number(document.getElementById('design-files').value) || 0,
      deadline: document.getElementById('design-deadline').value || null,
      designerId: document.getElementById('design-designer').value || null,
      notes: document.getElementById('design-note').value.trim(),
    };
    if (!payload.orderCode) throw new Error('Hãy nhập mã đơn thiết kế.');
    // Cập nhật đơn có sẵn hoàn toàn độc lập với trạng thái kết nối Zalo.
    // Khi tạo mới, ánh xạ hội thoại là dữ liệu bổ sung; mất kết nối không được chặn tạo đơn.
    if (!selectedDesignOrder) {
      const conversation = crmConversation || await resolveCrmConversation({ quiet: true }).catch(() => null);
      if (conversation?.id) payload.conversationId = conversation.id;
    }
    await crmRequest(selectedDesignOrder ? `/orders/${encodeURIComponent(selectedDesignOrder.id)}` : '/orders', selectedDesignOrder ? 'PUT' : 'POST', payload);
    message.innerText = selectedDesignOrder ? 'Đã cập nhật đơn thiết kế.' : (payload.conversationId ? 'Đã tạo và liên kết đơn thiết kế.' : 'Đã tạo đơn; hội thoại chưa được liên kết.');
    showDesignListView(); await loadDesignOrders();
  } catch (error) { message.innerText = error.message; }
  finally { button.disabled = false; }
};
}
document.getElementById('utility-panel-hide').onclick = () => setUtilityPanelOpen(false);
document.getElementById('quote-panel-toggle').onclick = () => toggleUtilityPanel('quote');
document.getElementById('design-orders-topbar').onclick = () => toggleUtilityPanel('design');
document.getElementById('pancake-orders-topbar').onclick = () => toggleUtilityPanel('orders');
document.getElementById('quick-replies-topbar').onclick = () => {
  setUtilityPanelOpen(false);
  renderQuickReplies();
  toggleToolOverlay('quick-replies-overlay');
};
document.getElementById('send-video-topbar').onclick = async () => {
  setUtilityPanelOpen(false);
  const opened = toggleToolOverlay('video-library-overlay');
  document.getElementById('send-video-topbar').classList.toggle('active', opened);
  if (opened) await loadVideoLibrary();
};
document.getElementById('video-library-add').onclick = async () => {
  const status = document.getElementById('video-library-status');
  const button = document.getElementById('video-library-add');
  button.disabled = true;
  const previousLabel = button.innerText;
  button.innerText = 'Đang thêm…';
  try {
    const result = await ipcRenderer.invoke('video-library:add');
    if (result?.ok) {
      videoLibraryItems = result.items || [];
      if (result.mediaRoot) videoLibraryRoot = result.mediaRoot;
      renderVideoLibrary();
    }
    const notes = [];
    if (result?.rejected?.length) notes.push(`Không thêm được: ${result.rejected.map((item) => `${item.name} (${item.message})`).join(', ')}`);
    // Trung noi dung thi bo qua, noi ro video da co trong kho.
    if (result?.duplicates?.length) notes.push(`Đã có trong kho: ${result.duplicates.map((item) => `${item.name} → “${item.existingName}”`).join(', ')}`);
    if (notes.length && status) status.innerText = notes.join(' · ');
  } finally {
    button.disabled = false;
    button.innerText = previousLabel;
  }
};
document.getElementById('video-library-folder').onclick = () => ipcRenderer.invoke('video-library:open-folder');
document.getElementById('video-library-set-root').onclick = async () => {
  const status = document.getElementById('video-library-status');
  const result = await ipcRenderer.invoke('video-library:set-root');
  if (result?.canceled) return;
  if (result?.ok) {
    videoLibraryItems = result.items || [];
    videoLibraryRoot = result.mediaRoot || '';
    renderVideoLibrary();
  } else if (status) {
    status.innerText = result?.message || 'Không đổi được thư mục kho video.';
  }
};
document.getElementById('video-library-minimize').onclick = () => closeOverlay('video-library-overlay');
document.getElementById('video-library-confirm-no').onclick = () => {
  pendingVideoDeleteId = '';
  document.getElementById('video-library-confirm').hidden = true;
};
document.getElementById('video-library-confirm-yes').onclick = async () => {
  const id = pendingVideoDeleteId;
  pendingVideoDeleteId = '';
  document.getElementById('video-library-confirm').hidden = true;
  if (id) await deleteVideoById(id);
};
document.getElementById('video-library-stage').onclick = async () => {
  const button = document.getElementById('video-library-stage'); const status = document.getElementById('video-library-status');
  button.disabled = true; status.innerText = 'Đang đưa video vào hội thoại…';
  const result = await ipcRenderer.invoke('video-library:stage', selectedVideoLibraryId);
  status.innerText = result?.message || (result?.ok ? 'Đã đưa video vào hội thoại.' : 'Không thể đính kèm video.');
  button.disabled = !selectedVideoLibraryId;
};



migrateLegacyProfiles();
renderAll();
renderQuote();
renderUtilityContext();
setUtilityPanelOpen(false);
if (activeProfileId) switchProfile(activeProfileId);
ipcRenderer.send('renderer-ready');
ipcRenderer.send('get-downloads');

ipcRenderer.on('recent-chats', (event, info) => {
  if (info.profileId === activeProfileId) {
    workspaceData.recentChats = sanitizeRecentChats(info.chats);
    if (currentCampaignTargetSource === 'recent') {
      renderCampaignTargets('recent');
    }
  }
});

if (settings.lockOnStartup) showLockOverlay(!hasLockPassword);
