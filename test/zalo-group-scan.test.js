const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const fsSync = require('node:fs');

const {
  ScanStore,
  buildPageExtractorScript,
  buildBulkGroupPlan,
  buildLeaveGroupScript,
  filterAndSortGroups,
  findAmbiguousGroupNames,
  getDailyLeaveUsageKey,
  getLeavePolicyWaitMs,
  LEAVE_GROUP_POLICY,
  normalizeGroupDto,
  saveTxtNoOverwrite,
  serializeGroups,
} = require('../modules/zalo-group-scan');

test('leave policy allows 1000 daily, waits 5-10 seconds, and pauses 1-2 minutes every fifth group', () => {
  assert.deepEqual(LEAVE_GROUP_POLICY, {
    maxPerRun: 1_000,
    minDelayMs: 5_000,
    maxDelayMs: 10_000,
    pauseEvery: 5,
    minPauseMs: 60_000,
    maxPauseMs: 120_000,
    maxPerDay: 1_000,
  });
  assert.equal(getLeavePolicyWaitMs(1, () => 0), 5_000);
  assert.equal(getLeavePolicyWaitMs(1, () => 1), 10_000);
  assert.equal(getLeavePolicyWaitMs(5, () => 0), 60_000);
  assert.equal(getLeavePolicyWaitMs(10, () => 1), 120_000);
  assert.equal(getDailyLeaveUsageKey('profile-1', new Date(2026, 7, 27, 23, 59)), '2026-08-27:profile-1');
});

test('builds a bulk action plan only from known selected groups and caps each run at 50', () => {
  const groups = [
    { groupId: '1', name: 'Nhóm 1', totalMember: 2 },
    { groupId: '2', name: 'Nhóm 2', totalMember: 3 },
  ];
  assert.deepEqual(buildBulkGroupPlan(groups, ['2', 'missing']), [{ groupId: '2', name: 'Nhóm 2' }]);
  assert.throws(() => buildBulkGroupPlan(
    Array.from({ length: 51 }, (_, index) => ({ groupId: String(index), name: `Nhóm ${index}` })),
    Array.from({ length: 51 }, (_, index) => String(index)),
  ), /50/);
});

test('leave-group script is scoped to one group and never reads session secrets', () => {
  const script = buildLeaveGroupScript('group-123');
  assert.match(script, /group-123/);
  assert.match(script, /groupManager/);
  assert.match(script, /webpackJsonp/);
  assert.match(script, /api\\\/group\\\/leave/);
  assert.doesNotMatch(script, /document\.cookie|localStorage|sessionStorage/);
});

test('detects duplicate names that cannot be targeted safely by name-based sending', () => {
  const groups = [
    { groupId: '1', name: 'Nhóm Demo' },
    { groupId: '2', name: ' nhóm   demo ' },
    { groupId: '3', name: 'Nhóm khác' },
  ];
  assert.deepEqual(findAmbiguousGroupNames(groups, ['1', '3']), ['Nhóm Demo']);
});

test('bulk group sending avoids duplicate search text, requires exact chat name, and verifies composer cleared', () => {
  const mainSource = fsSync.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.doesNotMatch(mainSource, /insertText\(String\(chatName\)\)/);
  assert.match(mainSource, /wantedNames\.some\(function\(name\) \{ return strictMatch \? txt === name/);
  assert.match(mainSource, /trustedSelection/);
  assert.match(mainSource, /Tin nhắn chưa được Zalo xác nhận gửi/);
});

test('filters group names case- and accent-insensitively with all search terms', () => {
  const groups = [
    { groupId: '1', name: 'D240826 - Đang giao', totalMember: 7, sourceIndex: 0 },
    { groupId: '2', name: 'D240827 - Đăng ký', totalMember: 5, sourceIndex: 1 },
    { groupId: '3', name: 'D240828 - đang giao cover', totalMember: 8, sourceIndex: 2 },
  ];

  assert.deepEqual(
    filterAndSortGroups(groups, { query: 'DANG   giao', sort: 'source' }).map((group) => group.groupId),
    ['1', '3'],
  );
});

test('sorts names naturally and supports member, creation, and source ordering', () => {
  const groups = [
    { groupId: 'a', name: 'Nhóm D10', totalMember: 3, createdTime: 30, sourceIndex: 0 },
    { groupId: 'b', name: 'Nhóm D2', totalMember: 8, createdTime: 10, sourceIndex: 1 },
    { groupId: 'c', name: 'Nhóm D1', totalMember: 5, createdTime: 20, sourceIndex: 2 },
  ];

  assert.deepEqual(filterAndSortGroups(groups, { sort: 'name-asc' }).map((g) => g.groupId), ['c', 'b', 'a']);
  assert.deepEqual(filterAndSortGroups(groups, { sort: 'name-desc' }).map((g) => g.groupId), ['a', 'b', 'c']);
  assert.deepEqual(filterAndSortGroups(groups, { sort: 'members-desc' }).map((g) => g.groupId), ['b', 'c', 'a']);
  assert.deepEqual(filterAndSortGroups(groups, { sort: 'created-asc' }).map((g) => g.groupId), ['b', 'c', 'a']);
  assert.deepEqual(filterAndSortGroups(groups, { sort: 'source' }).map((g) => g.groupId), ['a', 'b', 'c']);
});

test('normalizes text without allowing delimiters or line breaks to create columns', () => {
  const group = normalizeGroupDto({
    groupId: '  g|1\n',
    name: ' Nhà\tYến | CRM ',
    desc: null,
    type: 2,
    creatorId: 'owner',
    avt: 'https://a.test/a.png',
    fullAvt: undefined,
    totalMember: 25,
  });

  assert.deepEqual(group, {
    groupId: 'g 1',
    name: 'Nhà Yến CRM',
    desc: '',
    type: '2',
    creatorId: 'owner',
    avt: 'https://a.test/a.png',
    fullAvt: '',
    totalMember: 25,
    createdTime: 0,
    sourceIndex: 0,
  });
});

test('rejects malformed required fields and non-primitive text fields', () => {
  assert.throws(() => normalizeGroupDto({ groupId: '', name: 'A', totalMember: 1 }), /groupId/);
  assert.throws(() => normalizeGroupDto({ groupId: '1', name: {}, totalMember: 1 }), /name/);
  assert.throws(() => normalizeGroupDto({ groupId: '1', name: 'A', totalMember: -1 }), /totalMember/);
});

test('serializes unique groups in deterministic UTF-16 order with CRLF and literal False', () => {
  const text = serializeGroups([
    { groupId: 'b', name: 'B', totalMember: 2 },
    { groupId: 'a', name: 'Old', totalMember: 1 },
    { groupId: 'a', name: 'Newest', totalMember: 3 },
  ]);

  assert.equal(
    text,
    'a|Newest||||||3|False\r\nb|B||||||2|False\r\n',
  );
});

test('scan store binds a scan to one profile and ignores late batches after cancellation', () => {
  const store = new ScanStore({ now: () => 1000 });
  const scan = store.start({ scanId: 'scan-1', profileId: 'profile-1', partition: 'persist:zalo_1' });

  assert.equal(scan.status, 'discovering');
  store.acceptBatch('scan-1', [{ groupId: '1', name: 'A', totalMember: 10 }]);
  store.cancel('scan-1');

  assert.equal(store.acceptBatch('scan-1', [{ groupId: '2', name: 'B', totalMember: 20 }]), false);
  assert.equal(store.get('scan-1').groups.size, 1);
  assert.equal(store.get('scan-1').status, 'cancelled');
});

test('scan cannot complete while discovery is open or failures remain', () => {
  const store = new ScanStore();
  store.start({ scanId: 'scan-2', profileId: 'profile-1', partition: 'persist:zalo_1' });

  assert.throws(() => store.complete('scan-2'), /discovery/);
  store.finishDiscovery('scan-2', { totalUnique: 2, duplicateCount: 0 });
  store.acceptBatch('scan-2', [{ groupId: '1', name: 'A', totalMember: 10 }]);
  store.fail('scan-2', { groupId: '2', reason: 'timeout' });
  assert.throws(() => store.complete('scan-2'), /failures/);

  store.acceptBatch('scan-2', [{ groupId: '2', name: 'B', totalMember: 20 }]);
  store.resolveFailure('scan-2', '2');
  assert.equal(store.complete('scan-2').status, 'completed');
});

test('saves TXT atomically without overwriting an existing destination', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), '9meta-zalo-groups-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'groups.txt');

  await saveTxtNoOverwrite(destination, [{ groupId: '1', name: 'Nhóm 1', totalMember: 5 }]);
  assert.equal(await fs.readFile(destination, 'utf8'), '1|Nhóm 1||||||5|False\r\n');

  await assert.rejects(
    saveTxtNoOverwrite(destination, [{ groupId: '2', name: 'Nhóm 2', totalMember: 6 }]),
    (error) => error && error.code === 'EEXIST',
  );
  assert.equal(await fs.readFile(destination, 'utf8'), '1|Nhóm 1||||||5|False\r\n');
});

test('page extractor delegates network work to the in-page adapter without exporting session secrets', () => {
  const script = buildPageExtractorScript('scan-123');
  assert.match(script, /__9MetaZaloGroupAdapter/);
  assert.match(script, /scan-123/);
  assert.doesNotMatch(script, /document\.cookie|localStorage|sessionStorage/);
});

test('scan store records a terminal compatibility error and rejects late data', () => {
  const store = new ScanStore();
  store.start({ scanId: 'scan-3', profileId: 'profile-1', partition: 'persist:zalo_1' });
  store.markError('scan-3', 'Không tìm thấy adapter');

  assert.equal(store.get('scan-3').status, 'incompatible');
  assert.equal(store.get('scan-3').error, 'Không tìm thấy adapter');
  assert.equal(store.acceptBatch('scan-3', [{ groupId: '1', name: 'A', totalMember: 1 }]), false);
});
