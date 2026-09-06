const TEXT_FIELDS = ['groupId', 'name', 'desc', 'type', 'creatorId', 'avt', 'fullAvt'];
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const OPTIONAL_TEXT_FIELDS = new Set(['desc', 'type', 'creatorId', 'avt', 'fullAvt']);
const MAX_TEXT_LENGTH = 16_384;
const MAX_TOTAL_MEMBER = 10_000_000;
const LEAVE_GROUP_POLICY = Object.freeze({
  maxPerRun: 1_000,
  minDelayMs: 5_000,
  maxDelayMs: 10_000,
  pauseEvery: 5,
  minPauseMs: 60_000,
  maxPauseMs: 120_000,
  maxPerDay: 1_000,
});

function randomIntegerInclusive(minimum, maximum, random = Math.random) {
  const ratio = Math.max(0, Math.min(1, Number(random()) || 0));
  return Math.min(maximum, minimum + Math.floor(ratio * (maximum - minimum + 1)));
}

function getLeavePolicyWaitMs(processedCount, random = Math.random) {
  const isLongPause = Number(processedCount) > 0 && Number(processedCount) % LEAVE_GROUP_POLICY.pauseEvery === 0;
  return isLongPause
    ? randomIntegerInclusive(LEAVE_GROUP_POLICY.minPauseMs, LEAVE_GROUP_POLICY.maxPauseMs, random)
    : randomIntegerInclusive(LEAVE_GROUP_POLICY.minDelayMs, LEAVE_GROUP_POLICY.maxDelayMs, random);
}

function getDailyLeaveUsageKey(profileId, date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}:${String(profileId || '')}`;
}

function normalizeText(value, field) {
  if (value === null || value === undefined) {
    if (OPTIONAL_TEXT_FIELDS.has(field)) return '';
    throw new TypeError(`${field} is required`);
  }
  if (typeof value === 'object' || typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`${field} must be a primitive value`);
  }
  const normalized = String(value)
    .replace(/[|\t\r\n\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
  if (!normalized && !OPTIONAL_TEXT_FIELDS.has(field)) throw new TypeError(`${field} is required`);
  return normalized;
}

function normalizeGroupDto(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('group DTO must be an object');
  const result = {};
  for (const field of TEXT_FIELDS) result[field] = normalizeText(input[field], field);
  if (!Number.isInteger(input.totalMember) || input.totalMember < 0 || input.totalMember > MAX_TOTAL_MEMBER) {
    throw new TypeError('totalMember must be an integer between 0 and 10000000');
  }
  result.totalMember = input.totalMember;
  result.createdTime = Number.isFinite(Number(input.createdTime)) ? Number(input.createdTime) : 0;
  result.sourceIndex = Number.isInteger(input.sourceIndex) && input.sourceIndex >= 0 ? input.sourceIndex : 0;
  return result;
}

function compareUtf16Ordinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLocaleLowerCase('vi')
    .replace(/\s+/g, ' ')
    .trim();
}

function filterAndSortGroups(groups, { query = '', sort = 'name-asc' } = {}) {
  const terms = normalizeSearchText(query).split(' ').filter(Boolean);
  const result = (Array.isArray(groups) ? groups : []).filter((group) => {
    const name = normalizeSearchText(group?.name);
    return terms.every((term) => name.includes(term));
  });
  const nameCollator = new Intl.Collator('vi', { numeric: true, sensitivity: 'base' });
  const tieBreak = (a, b) => compareUtf16Ordinal(String(a.groupId || ''), String(b.groupId || ''));
  const numeric = (field, direction = 1) => (a, b) => {
    const difference = (Number(a?.[field]) || 0) - (Number(b?.[field]) || 0);
    return difference ? difference * direction : tieBreak(a, b);
  };
  const comparators = {
    'name-asc': (a, b) => nameCollator.compare(String(a.name || ''), String(b.name || '')) || tieBreak(a, b),
    'name-desc': (a, b) => nameCollator.compare(String(b.name || ''), String(a.name || '')) || tieBreak(a, b),
    'members-asc': numeric('totalMember'),
    'members-desc': numeric('totalMember', -1),
    'created-asc': numeric('createdTime'),
    'created-desc': numeric('createdTime', -1),
    source: numeric('sourceIndex'),
  };
  return result.sort(comparators[sort] || comparators['name-asc']);
}

function buildBulkGroupPlan(groups, selectedIds, limit = 50) {
  const wanted = new Set((Array.isArray(selectedIds) ? selectedIds : []).map(String));
  const plan = (Array.isArray(groups) ? groups : [])
    .filter((group) => wanted.has(String(group?.groupId || '')))
    .map((group) => ({ groupId: String(group.groupId), name: String(group.name || '').trim() }))
    .filter((group) => group.groupId && group.name);
  if (!plan.length) throw new Error('Hãy chọn ít nhất một nhóm.');
  if (plan.length > limit) throw new Error(`Mỗi lượt chỉ xử lý tối đa ${limit} nhóm.`);
  return plan;
}

function findAmbiguousGroupNames(groups, selectedIds) {
  const wanted = new Set((Array.isArray(selectedIds) ? selectedIds : []).map(String));
  const names = new Map();
  for (const group of Array.isArray(groups) ? groups : []) {
    const normalizedName = normalizeSearchText(group?.name);
    if (!normalizedName) continue;
    const entry = names.get(normalizedName) || { count: 0, selectedLabel: null };
    entry.count += 1;
    if (wanted.has(String(group?.groupId || '')) && !entry.selectedLabel) {
      entry.selectedLabel = String(group.name || '').trim();
    }
    names.set(normalizedName, entry);
  }
  return Array.from(names.values())
    .filter((entry) => entry.count > 1 && entry.selectedLabel)
    .map((entry) => entry.selectedLabel)
    .sort(compareUtf16Ordinal);
}

function buildLeaveGroupScript(groupId) {
  const encodedGroupId = JSON.stringify(String(groupId));
  return `(async function() {
    if (window.location.hostname !== 'chat.zalo.me') return { ok: false, message: 'Profile không ở Zalo Web.' };
    var manager = window.groupManager;
    if (!manager) return { ok: false, incompatible: true, message: 'Zalo Web chưa cung cấp groupManager.' };
    var groupId = ${encodedGroupId};
    var group = typeof manager.getGroupByIdSync === 'function' ? manager.getGroupByIdSync(groupId) : null;
    if (!group) return { ok: false, message: 'Nhóm không còn tồn tại trong phiên Zalo hiện tại.' };
    try {
      if (!window.__9MetaWebpackRequire) {
        if (!window.webpackJsonp || typeof window.webpackJsonp.push !== 'function') {
          return { ok: false, incompatible: true, message: 'Không tìm thấy bộ nạp module của Zalo Web.' };
        }
        var probeId = '__9meta_leave_probe_' + Date.now();
        var probeModules = {};
        probeModules[probeId] = function(module, exports, require) { window.__9MetaWebpackRequire = require; };
        window.webpackJsonp.push([[probeId], probeModules, [[probeId]]]);
      }
      var require = window.__9MetaWebpackRequire;
      var leaveApi = null;
      var modules = require && require.c ? require.c : {};
      for (var moduleId in modules) {
        var exported = modules[moduleId] && modules[moduleId].exports;
        var candidates = [exported, exported && exported.default];
        for (var index = 0; index < candidates.length; index += 1) {
          var candidate = candidates[index];
          if (!candidate || typeof candidate.leaveGroup !== 'function') continue;
          var source = Function.prototype.toString.call(candidate.leaveGroup);
          if (/\\/api\\/group\\/leave/.test(source)) { leaveApi = candidate; break; }
        }
        if (leaveApi) break;
      }
      if (!leaveApi) {
        return { ok: false, incompatible: true, message: 'Không tìm thấy API rời nhóm đã xác minh trong phiên Zalo Web.' };
      }
      var result = await leaveApi.leaveGroup(groupId);
      if (result && (result.error || result.error_code || result.errorCode)) {
        return { ok: false, message: String(result.message || result.error || result.error_code || result.errorCode) };
      }
      return { ok: true, method: 'verified-webpack-leave-api' };
    } catch (error) {
      return { ok: false, message: error && error.message ? error.message : String(error) };
    }
  })()`;
}

function normalizeAndDedupe(groups) {
  const unique = new Map();
  for (const group of groups || []) {
    const normalized = normalizeGroupDto(group);
    unique.set(normalized.groupId, normalized);
  }
  return Array.from(unique.values()).sort((a, b) => compareUtf16Ordinal(a.groupId, b.groupId));
}

function serializeGroups(groups) {
  const lines = normalizeAndDedupe(groups).map((group) => [
    group.groupId,
    group.name,
    group.desc,
    group.type,
    group.creatorId,
    group.avt,
    group.fullAvt,
    String(group.totalMember),
    'False',
  ].join('|'));
  return lines.length ? `${lines.join('\r\n')}\r\n` : '';
}

function buildPageExtractorScript(scanId) {
  const encodedScanId = JSON.stringify(String(scanId));
  return `(() => {
    const scanId = ${encodedScanId};
    const emit = (event) => window.messengerApp.emitZaloGroupScanEvent({ ...event, scanId });
    if (window.location.hostname !== 'chat.zalo.me') {
      emit({ type: 'incompatible', message: 'Profile chưa ở trang chat.zalo.me.' });
      return;
    }
    window.__9MetaZaloGroupScans = window.__9MetaZaloGroupScans || Object.create(null);
    const control = { cancelled: false, isCancelled() { return this.cancelled; } };
    window.__9MetaZaloGroupScans[scanId] = control;
    const builtInAdapter = window.groupManager && typeof window.groupManager.getGroupsList === 'function' ? {
      async scan({ control, onProgress, onDiscoveryComplete, onBatch }) {
        const sourceGroups = await window.groupManager.getGroupsList();
        if (!Array.isArray(sourceGroups)) throw new Error('groupManager không trả về danh sách nhóm.');
        const unique = new Map();
        let duplicateCount = 0;
        for (const group of sourceGroups) {
          const groupId = group && (group.userId || group.groupId || group.globalId);
          if (!groupId) continue;
          if (unique.has(String(groupId))) duplicateCount += 1;
          unique.set(String(groupId), group);
        }
        const groups = Array.from(unique.values());
        onProgress({ pages: 1, discovered: sourceGroups.length });
        onDiscoveryComplete({ totalUnique: groups.length, duplicateCount });
        for (let offset = 0; offset < groups.length; offset += 20) {
          if (control.isCancelled()) return;
          const dtos = groups.slice(offset, offset + 20).map((group, index) => ({
            groupId: group.userId || group.groupId || group.globalId,
            name: group.displayName || group.name || '',
            desc: group.desc,
            type: group.type,
            creatorId: group.creatorId,
            avt: group.avatar,
            fullAvt: group.bgavatar || group.avatar,
            totalMember: group.totalMember,
            createdTime: group.createdTime || group.createTime || 0,
            sourceIndex: offset + index,
          }));
          onBatch(dtos);
          onProgress({ pages: 1, discovered: sourceGroups.length, totalUnique: groups.length, processed: Math.min(offset + dtos.length, groups.length) });
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      },
    } : null;
    const adapter = window.__9MetaZaloGroupAdapter || builtInAdapter;
    if (!adapter || typeof adapter.scan !== 'function') {
      emit({ type: 'incompatible', message: 'Zalo Web chưa cung cấp groupManager cho phiên này.' });
      delete window.__9MetaZaloGroupScans[scanId];
      return;
    }
    Promise.resolve(adapter.scan({
      control,
      onProgress: (progress) => emit({ type: 'progress', progress }),
      onDiscoveryComplete: (summary) => emit({ type: 'discovery-complete', summary }),
      onBatch: (dtos) => emit({ type: 'batch', dtos }),
      onFailure: (failure) => emit({ type: 'failure', failure }),
    })).then(() => {
      if (!control.cancelled) emit({ type: 'complete' });
    }).catch((error) => {
      if (!control.cancelled) emit({ type: 'error', message: String(error && error.message || error || 'Lỗi extractor') });
    }).finally(() => {
      delete window.__9MetaZaloGroupScans[scanId];
    });
  })()`;
}

function buildCancelExtractorScript(scanId) {
  const encodedScanId = JSON.stringify(String(scanId));
  return `(() => {
    const scans = window.__9MetaZaloGroupScans;
    const control = scans && scans[${encodedScanId}];
    if (control) control.cancelled = true;
  })()`;
}

async function saveTxtNoOverwrite(destination, groups) {
  const directory = path.dirname(destination);
  const tempPath = path.join(directory, `.${path.basename(destination)}.tmp-${crypto.randomBytes(8).toString('hex')}`);
  let tempCreated = false;
  try {
    const handle = await fsPromises.open(tempPath, 'wx');
    tempCreated = true;
    try {
      await handle.writeFile(serializeGroups(groups), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fsPromises.link(tempPath, destination);
    } catch (error) {
      if (error.code === 'EEXIST') throw error;
      await fsPromises.copyFile(tempPath, destination, fs.constants.COPYFILE_EXCL);
    }
  } finally {
    if (tempCreated) await fsPromises.unlink(tempPath).catch(() => {});
  }
  return destination;
}

class ScanStore {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.scans = new Map();
  }

  start({ scanId, profileId, partition }) {
    if (!scanId || !profileId || !partition) throw new TypeError('scanId, profileId and partition are required');
    if (this.scans.has(scanId)) throw new Error('scanId already exists');
    const scan = {
      scanId,
      profileId,
      partition,
      status: 'discovering',
      groups: new Map(),
      failures: new Map(),
      totalUnique: null,
      duplicateCount: 0,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.scans.set(scanId, scan);
    return scan;
  }

  get(scanId) {
    const scan = this.scans.get(scanId);
    if (!scan) throw new Error('scan not found');
    return scan;
  }

  isActive(scan) {
    return scan.status === 'discovering' || scan.status === 'fetching' || scan.status === 'failed';
  }

  acceptBatch(scanId, dtos) {
    const scan = this.get(scanId);
    if (!this.isActive(scan)) return false;
    for (const dto of dtos || []) {
      const group = normalizeGroupDto(dto);
      scan.groups.set(group.groupId, group);
    }
    scan.updatedAt = this.now();
    return true;
  }

  finishDiscovery(scanId, { totalUnique, duplicateCount = 0 }) {
    const scan = this.get(scanId);
    if (scan.status !== 'discovering') throw new Error('scan is not discovering');
    if (!Number.isInteger(totalUnique) || totalUnique < 0) throw new TypeError('totalUnique must be a non-negative integer');
    scan.totalUnique = totalUnique;
    scan.duplicateCount = duplicateCount;
    scan.status = 'fetching';
    scan.updatedAt = this.now();
    return scan;
  }

  fail(scanId, { groupId, reason }) {
    const scan = this.get(scanId);
    if (!this.isActive(scan)) return false;
    scan.failures.set(String(groupId), String(reason || 'unknown error'));
    scan.status = 'failed';
    scan.updatedAt = this.now();
    return true;
  }

  resolveFailure(scanId, groupId) {
    const scan = this.get(scanId);
    scan.failures.delete(String(groupId));
    if (scan.status === 'failed' && scan.failures.size === 0) scan.status = 'fetching';
    scan.updatedAt = this.now();
    return scan;
  }

  complete(scanId) {
    const scan = this.get(scanId);
    if (scan.totalUnique === null) throw new Error('discovery is not finished');
    if (scan.failures.size) throw new Error('scan has failures');
    if (scan.groups.size !== scan.totalUnique) throw new Error('scan is incomplete');
    scan.status = 'completed';
    scan.updatedAt = this.now();
    return scan;
  }

  cancel(scanId) {
    const scan = this.get(scanId);
    if (!this.isActive(scan)) return false;
    scan.status = 'cancelled';
    scan.updatedAt = this.now();
    return true;
  }

  markError(scanId, message) {
    const scan = this.get(scanId);
    if (!this.isActive(scan)) return false;
    scan.status = 'incompatible';
    scan.error = String(message || 'Không tương thích');
    scan.updatedAt = this.now();
    return true;
  }

  remove(scanId) {
    return this.scans.delete(scanId);
  }
}

module.exports = {
  LEAVE_GROUP_POLICY,
  ScanStore,
  buildCancelExtractorScript,
  buildBulkGroupPlan,
  buildLeaveGroupScript,
  buildPageExtractorScript,
  compareUtf16Ordinal,
  filterAndSortGroups,
  findAmbiguousGroupNames,
  getDailyLeaveUsageKey,
  getLeavePolicyWaitMs,
  normalizeAndDedupe,
  normalizeGroupDto,
  saveTxtNoOverwrite,
  serializeGroups,
};
