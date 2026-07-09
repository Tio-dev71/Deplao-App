const { ipcRenderer, shell, clipboard } = require('electron');

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
  'modal-overlay',
  'update-overlay',
  'downloads-overlay',
];

const defaultState = {
  profiles: [],
  quickReplies: [],
  crmContacts: [],
  campaigns: [],
  analyticsEvents: [],
  aiSettings: { endpoint: '', apiKey: '', model: 'gpt-4o-mini' },
};

let workspaceState = ipcRenderer.sendSync('workspace-get-state') || { currentId: 'default', workspaces: [], data: defaultState };
let workspaceData = normalizeWorkspaceData(workspaceState.data);
let profiles = normalizeProfiles(workspaceData.profiles);
let activeProfileId = profiles[0]?.id || null;
let downloads = [];
let updateState = { status: 'idle', progress: 0, message: '' };
let appLocked = false;
let hasLockPassword = false;
let isDarkMode = true;
let editingProfile = null;
let tempAvatarPath = null;
let editingContactId = null;
let selectedCampaignId = null;
let currentChatSnapshot = null;
let campaignTimers = {};
let currentCampaignTargetSource = 'recent';
const campaignTargetSelections = {
  crm: new Set(),
  recent: new Set(),
};

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
  };
}
function normalizeProfiles(list) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) {
    return [{ id: String(Date.now()), name: 'Nick 1', partition: `persist:nick_${Date.now()}`, platform: 'zalo' }];
  }
  return arr.map((p) => {
    let avatarUrl = p.avatar;
    if (avatarUrl && !avatarUrl.startsWith('http') && !avatarUrl.startsWith('data:')) {
      avatarUrl = '';
    }
    return { ...p, avatar: avatarUrl, platform: p.platform || 'zalo', partition: p.partition || `persist:nick_${p.id}` };
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
function openOverlay(id) {
  ipcRenderer.send('set-browserview-visibility', false);
  document.getElementById(id).style.display = 'flex';
}
function closeOverlay(id) {
  document.getElementById(id).style.display = 'none';
  const stillOpen = overlayIds.some((overlayId) => document.getElementById(overlayId) && document.getElementById(overlayId).style.display === 'flex');
  if (!stillOpen && !appLocked && !toolsLauncherOpen) ipcRenderer.send('set-browserview-visibility', true);
}
function escapeHtml(s) { return String(s || '').replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
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
  dashboard: () => { renderDashboard(); openOverlay('dashboard-overlay'); },
  workspaces: () => { renderWorkspaces(); openOverlay('workspace-overlay'); },
  crm: () => { renderCRMCurrentChat(); openOverlay('crm-overlay'); },
  campaigns: () => { renderCampaigns(); openOverlay('campaign-overlay'); },
  ai: () => { fillAISettings(); openOverlay('ai-overlay'); },
  'quick-replies': () => { renderQuickReplies(); openOverlay('quick-replies-overlay'); },
  update: () => { openOverlay('update-overlay'); ipcRenderer.send('check-for-updates'); ipcRenderer.send('get-update-state'); },
  lock: () => ipcRenderer.send('lock-app'),
  shield: () => ipcRenderer.send('toggle-zadark-shield'),
  'dark-mode': () => {
    isDarkMode = !isDarkMode;
    document.body.className = isDarkMode ? 'dark-mode' : 'light-mode';
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
  handler();
}
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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
    btn.title = `${p.name} (${p.platform || 'zalo'})`;
    const span = document.createElement('span');
    span.innerText = p.avatar ? '' : platformIcon(p.platform);
    if (p.avatar) {
      const img = document.createElement('img');
      img.src = p.avatar.startsWith('http') || p.avatar.startsWith('data:') ? p.avatar : `file://${String(p.avatar).replace(/\\/g, '/')}`;
      img.style.cssText = 'width:100%;height:100%;border-radius:inherit;object-fit:cover;position:absolute;inset:0;';
      btn.appendChild(img);
    } else btn.appendChild(span);
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
  renderSidebar();
  const profile = getActiveProfile();
  if (profile) ipcRenderer.send('switch-profile', profile);
  renderCRMCurrentChat();
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

function renderQuickReplies() {
  const quickReplies = workspaceData.quickReplies || [];
  const list = document.getElementById('quick-replies-list');
  if (!quickReplies.length) {
    list.innerHTML = '<div class="empty-state">Chưa có tin nhắn mẫu nào.</div>';
    return;
  }
  list.innerHTML = quickReplies.map((reply, index) => `
    <div class="download-item">
      <div class="row"><div class="title-sm">/${index + 1}</div><div><button class="modal-btn cancel" data-edit="${index}">Sửa</button><button class="modal-btn warn" data-delete="${index}">Xóa</button></div></div>
      <div class="muted mt-12">${escapeHtml(reply.message)}</div>
    </div>`).join('');
  list.querySelectorAll('[data-edit]').forEach((button) => {
    button.onclick = () => {
      const index = Number(button.getAttribute('data-edit'));
      const next = prompt('Sửa quick reply', workspaceData.quickReplies[index].message);
      if (next && next.trim()) {
        workspaceData.quickReplies[index].message = next.trim();
        persistWorkspace();
        trackEvent('quick_reply_updated', { index });
        renderQuickReplies();
      }
    };
  });
  list.querySelectorAll('[data-delete]').forEach((button) => {
    button.onclick = () => {
      const index = Number(button.getAttribute('data-delete'));
      workspaceData.quickReplies.splice(index, 1);
      persistWorkspace();
      trackEvent('quick_reply_deleted', { index });
      renderQuickReplies();
    };
  });
}
function addQuickReplyFromInput() {
  const input = document.getElementById('quick-reply-input');
  const message = input.value.trim();
  if (!message) return;
  workspaceData.quickReplies.push({ message });
  persistWorkspace();
  trackEvent('quick_reply_created', { length: workspaceData.quickReplies.length });
  input.value = '';
  renderQuickReplies();
  renderDashboard();
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
  document.getElementById('update-download').style.display = updateState.status === 'available' ? 'inline-flex' : 'none';
  document.getElementById('update-install').style.display = updateState.status === 'downloaded' ? 'inline-flex' : 'none';
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
document.getElementById('btn-add-profile').onclick = () => openModal();
document.getElementById('modal-cancel').onclick = () => closeOverlay('modal-overlay');
document.getElementById('modal-delete').onclick = () => {
  if (!editingProfile) return;
  if (profiles.length <= 1) return alert('Phải có ít nhất 1 tài khoản.');
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
    editingProfile.name = name;
    editingProfile.proxy = proxyInput.value.trim();
    editingProfile.platform = platformInput.value;
    editingProfile.avatar = tempAvatarPath;
    editingProfile.customUrl = platformInput.value === 'custom' ? customUrl : '';
    ipcRenderer.send('update-profile-settings', editingProfile);
    trackEvent('profile_updated', { id: editingProfile.id });
  } else {
    const id = String(Date.now());
    profiles.push({ id, name, avatar: tempAvatarPath, partition: `persist:nick_${id}`, platform: platformInput.value, proxy: proxyInput.value.trim(), customUrl: platformInput.value === 'custom' ? customUrl : '' });
    activeProfileId = id;
    trackEvent('profile_created', { id });
  }
  persistWorkspace();
  closeOverlay('modal-overlay');
  renderAll();
  if (activeProfileId) switchProfile(activeProfileId);
};

document.getElementById('btn-tools-launcher').onclick = () => setLauncherOpen(!toolsLauncherOpen);
document.getElementById('tools-close').onclick = () => setLauncherOpen(false);
document.querySelectorAll('[data-tools-close="true"]').forEach((el) => {
  el.onclick = () => setLauncherOpen(false);
});
document.querySelectorAll('[data-tool-action]').forEach((el) => {
  el.onclick = () => runToolAction(el.dataset.toolAction, true);
});
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
document.getElementById('lock-submit').onclick = () => {
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
ipcRenderer.on('update-state', (_, state) => { updateState = state; renderUpdate(); if (state.status === 'available' || state.status === 'downloaded') openOverlay('update-overlay'); });
ipcRenderer.on('lock-state', (_, state) => {
  hasLockPassword = !!state.hasPassword;
  document.getElementById('btn-shield').classList.toggle('active', !!state.zadarkShield);
  if (state.locked) showLockOverlay(!hasLockPassword);
});
ipcRenderer.on('unlock-result', (_, result) => { 
  if (result.ok) { 
    if (result.removed) { hasLockPassword = false; alert('Đã gỡ mật khẩu khóa ứng dụng thành công!'); }
    else hasLockPassword = true; 
    hideLockOverlay(); 
  } else alert(result.message || 'Sai mật khẩu.'); 
});
ipcRenderer.on('update-profile-badge', (_, { id, count }) => {
  const badge = document.getElementById(`badge-${id}`);
  if (badge) {
    badge.innerText = count > 9 ? '9+' : count;
    badge.style.display = count > 0 ? 'flex' : 'none';
  }
});
ipcRenderer.on('update-profile-info', (_, payload) => {
  const profile = profiles.find((entry) => entry.id === payload.id);
  if (!profile) return;
  let changed = false;
  if (payload.name && profile.name.startsWith('Tài khoản')) { profile.name = payload.name; changed = true; }
  if (payload.avatarUrl && !profile.avatar) { profile.avatar = payload.avatarUrl; changed = true; }
  if (changed) {
    persistWorkspace();
    renderSidebar();
  }
});
ipcRenderer.on('current-chat-info', (_, info) => {
  currentChatSnapshot = info;
  renderCRMCurrentChat();
});

const settings = ipcRenderer.sendSync('get-settings');
isDarkMode = settings.isDarkMode;
hasLockPassword = !!settings.hasLockPassword;
document.body.className = isDarkMode ? 'dark-mode' : 'light-mode';
const sunIcon = document.getElementById('icon-sun');
const moonIcon = document.getElementById('icon-moon');
if (sunIcon) sunIcon.style.display = isDarkMode ? 'none' : 'block';
if (moonIcon) moonIcon.style.display = isDarkMode ? 'block' : 'none';
document.getElementById('btn-pin').classList.toggle('active', !!settings.alwaysOnTop);
const shieldButton = document.getElementById('btn-shield');
if (shieldButton) shieldButton.classList.toggle('active', !!settings.zadarkShield);

const API_BASE_URL = localStorage.getItem('API_URL') || 'https://api.tiodev.io.vn/v1';
const APP_VERSION = require('./package.json').version;
function getOrCreateDeviceId() {
  const existing = localStorage.getItem('device_id');
  if (existing) return existing;
  const created = `desktop_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  localStorage.setItem('device_id', created);
  return created;
}
function clearAuthSession() {
  localStorage.removeItem('access_token');
  accessToken = null;
}
let accessToken = localStorage.getItem('access_token') || null;
const authOverlay = document.getElementById('auth-overlay');
const expiredOverlay = document.getElementById('expired-overlay');
const authSubmit = document.getElementById('auth-submit');
const authError = document.getElementById('auth-error');
function showAuth() { ipcRenderer.send('set-browserview-visibility', false); authOverlay.style.display = 'flex'; expiredOverlay.style.display = 'none'; }
function showExpired(message, upgradeUrl) {
  ipcRenderer.send('set-browserview-visibility', false);
  expiredOverlay.style.display = 'flex';
  authOverlay.style.display = 'none';
  if (message) document.getElementById('expired-message').innerText = message;
  if (upgradeUrl) document.getElementById('expired-upgrade').onclick = () => shell.openExternal(upgradeUrl);
}
function unlockAppFromAuth() {
  authOverlay.style.display = 'none';
  expiredOverlay.style.display = 'none';
  if (!appLocked) ipcRenderer.send('set-browserview-visibility', true);
  if (activeProfileId) switchProfile(activeProfileId);
}
authSubmit.onclick = async () => {
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  if (!email || !password) {
    authError.innerText = 'Vui lòng nhập đầy đủ thông tin.';
    authError.style.display = 'block';
    return;
  }
  authSubmit.innerText = 'Đang đăng nhập...';
  authSubmit.disabled = true;
  authError.style.display = 'none';
  try {
    const res = await fetch(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        deviceId: getOrCreateDeviceId(),
        appVersion: APP_VERSION,
        os: process.platform,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Đăng nhập thất bại');
    accessToken = data.accessToken;
    localStorage.setItem('access_token', accessToken);
    await checkSubscription();
  } catch (err) {
    authError.innerText = err.message;
    authError.style.display = 'block';
  } finally {
    authSubmit.innerText = 'Đăng nhập';
    authSubmit.disabled = false;
  }
};
document.getElementById('expired-logout').onclick = () => { clearAuthSession(); expiredOverlay.style.display = 'none'; showAuth(); };
document.getElementById('btn-logout').onclick = () => { 
  if (confirm('Bạn có chắc chắn muốn đăng xuất tài khoản 9Meta?')) {
    clearAuthSession(); 
    showAuth(); 
  }
};
async function checkSubscription() {
  if (!accessToken) {
    showAuth();
    return false;
  }
  try {
    const res = await fetch(`${API_BASE_URL}/me/subscription`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 401 || res.status === 403) {
      clearAuthSession();
      showAuth();
      return false;
    }
    if (!res.ok) {
      throw new Error(`subscription_http_${res.status}`);
    }
    const data = await res.json();
    if (!data || data.isActive === false) {
      showExpired('Gói đăng ký của bạn đã hết hạn. Vui lòng thanh toán gia hạn để tiếp tục sử dụng.', data?.upgradeUrl || 'https://tiodev.io.vn/pricing');
      return false;
    }
    unlockAppFromAuth();
    return true;
  } catch (err) {
    console.error('Lỗi kiểm tra bản quyền:', err);
    showExpired('Không thể xác minh bản quyền lúc này. Vui lòng kiểm tra kết nối mạng hoặc đăng nhập lại để tiếp tục sử dụng.', 'https://tiodev.io.vn/pricing');
    return false;
  }
}

migrateLegacyProfiles();
renderAll();
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
if (!settings.lockOnStartup) checkSubscription();
setInterval(() => { if (accessToken && !appLocked) checkSubscription(); }, 15 * 60 * 1000);
