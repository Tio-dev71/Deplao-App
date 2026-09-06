const PAPER_TIERS = {
  standard: [
    { min: 50, max: 149, price: 8000 },
    { min: 150, max: 399, price: 3900 },
    { min: 400, max: 799, price: 2700 },
    { min: 800, max: Infinity, price: 2500 },
  ],
  nhunu: [
    { min: 50, max: 149, price: 8000 },
    { min: 150, max: 399, price: 3900 },
    { min: 400, max: 799, price: 3400 },
    { min: 800, max: Infinity, price: 2900 },
  ],
  gap3in1: [
    { min: 50, max: 149, price: 10000 },
    { min: 150, max: 399, price: 4500 },
    { min: 400, max: 799, price: 4000 },
    { min: 800, max: 1299, price: 3800 },
    { min: 1300, max: Infinity, price: 3500 },
  ],
};

const SHIPPING_TIERS = [
  { min: 50, max: 149, label: '35.000đ – 40.000đ' },
  { min: 150, max: 399, label: '45.000đ – 50.000đ' },
  { min: 400, max: 799, label: '60.000đ – 90.000đ' },
  { min: 800, max: Infinity, label: '100.000đ – 150.000đ' },
];

function clean(value) {
  return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

function mappingKey(profileId, groupId) {
  const profile = clean(profileId);
  const group = clean(groupId);
  if (!profile || !group) throw new Error('Thiếu profileId hoặc groupId.');
  return `${profile}:${group}`;
}

function extractOrderCode(groupName) {
  const name = clean(groupName);
  const match = name.match(/^#?([A-Za-z][A-Za-z0-9_-]{2,39})(?:\s|$)/);
  return match ? match[1] : '';
}

function upsertGroupMapping(list, input, now = Date.now()) {
  const entries = Array.isArray(list) ? list.map((entry) => ({ ...entry })) : [];
  const key = mappingKey(input.profileId, input.groupId);
  const currentName = clean(input.groupName);
  const index = entries.findIndex((entry) => entry.key === key);
  const previous = index >= 0 ? entries[index] : null;
  const history = Array.isArray(previous?.nameHistory) ? previous.nameHistory.slice() : [];
  if (previous?.currentName && currentName && previous.currentName !== currentName && !history.some((item) => item.name === previous.currentName)) {
    history.unshift({ name: previous.currentName, changedAt: now });
  }
  const next = {
    ...(previous || {}),
    key,
    profileId: clean(input.profileId),
    groupId: clean(input.groupId),
    currentName: currentName || previous?.currentName || '',
    orderCode: clean(input.orderCode) || previous?.orderCode || extractOrderCode(currentName),
    crmConversationId: clean(input.crmConversationId) || previous?.crmConversationId || '',
    crmOrderId: clean(input.crmOrderId) || previous?.crmOrderId || '',
    nameHistory: history.slice(0, 20),
    updatedAt: now,
    createdAt: previous?.createdAt || now,
  };
  if (index >= 0) entries[index] = next;
  else entries.unshift(next);
  return { entries, mapping: next };
}

function findGroupMapping(list, profileId, groupId) {
  let key;
  try { key = mappingKey(profileId, groupId); } catch { return null; }
  return (Array.isArray(list) ? list : []).find((entry) => entry.key === key) || null;
}

function findScannedGroupByName(groups, name) {
  const target = clean(name).toLocaleLowerCase('vi-VN');
  if (!target) return { status: 'missing', matches: [] };
  const matches = (Array.isArray(groups) ? groups : []).filter((group) => clean(group.name).toLocaleLowerCase('vi-VN') === target);
  return { status: matches.length === 1 ? 'unique' : matches.length > 1 ? 'ambiguous' : 'missing', matches };
}

function money(value) {
  return `${Math.round(Number(value) || 0).toLocaleString('vi-VN')}đ`;
}

function calculateStandardQuote({ type = 'nhunu', quantity = 0, emboss = false, embossPositions = 1 } = {}) {
  const qty = Math.max(0, Number(quantity) || 0);
  const safeType = PAPER_TIERS[type] ? type : 'nhunu';
  const tier = PAPER_TIERS[safeType].find((item) => qty >= item.min && qty <= item.max);
  const valid = qty >= 50 && !!tier;
  const positions = Math.max(1, Number(embossPositions) || 1);
  const embossEnabled = safeType !== 'gap3in1' && !!emboss;
  const paperCost = valid ? qty * tier.price : 0;
  const embossCost = valid && embossEnabled ? qty * positions * 1000 + positions * 200000 + (qty < 300 ? 300000 : 0) : 0;
  const total = paperCost + embossCost;
  const shipping = valid ? SHIPPING_TIERS.find((item) => qty >= item.min && qty <= item.max)?.label || '—' : '—';
  return {
    valid, type: safeType, quantity: qty, unitPrice: tier?.price || 0, paperCost, embossCost, total,
    average: valid ? Math.round(total / qty) : 0, shipping, positions, embossEnabled,
  };
}

function buildQuoteText(options = {}) {
  const result = calculateStandardQuote(options);
  if (!result.valid) return '';
  const typeLabel = result.type === 'standard' ? 'GIẤY TIÊU CHUẨN KHÔNG MÙI' : result.type === 'gap3in1' ? 'GIẤY ÁNH NHŨ GẬP 3IN1' : 'GIẤY ÁNH NHŨ LẤP LÁNH NƯỚC HOA THƠM';
  const lines = [
    'CÔNG TY TNHH IN ẤN NHÀ YẾN',
    result.type === 'gap3in1' ? 'BÁO GIÁ THIỆP CƯỚI GẬP 3IN1 NHÀ YẾN' : 'BÁO GIÁ THIỆP CƯỚI NHÀ YẾN',
    `Số lượng: ${result.quantity} thiệp`, '', `** ${typeLabel}`,
    `* Đơn giá: ${money(result.unitPrice)} x ${result.quantity} bộ = ${money(result.paperCost)}`,
  ];
  if (result.embossEnabled) {
    lines.push(`* Ép kim/dập nổi: ${result.positions} vị trí`);
    lines.push(`* Chi phí ép kim và khuôn: ${money(result.embossCost)}`);
  }
  lines.push(`Tổng chi phí: ${money(result.total)}`);
  lines.push(`Giá thành: ${money(result.average)}/thiệp`);
  lines.push(`Phí ship Viettel Post dự kiến: ${result.shipping}`);
  lines.push('', 'Lưu ý: Hoá đơn chưa bao gồm phí ship.');
  lines.push('Dạ mình chưa hiểu phần nào nhắn em tư vấn chi tiết hơn nha, em cảm ơn ạ.');
  return lines.join('\n');
}

module.exports = {
  PAPER_TIERS,
  SHIPPING_TIERS,
  mappingKey,
  extractOrderCode,
  upsertGroupMapping,
  findGroupMapping,
  findScannedGroupByName,
  calculateStandardQuote,
  buildQuoteText,
};
