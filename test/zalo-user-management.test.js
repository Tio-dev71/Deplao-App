const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeInteractionTime, normalizeZaloUsers, filterAndSortUsers, buildUnfriendPlan, UserScanStore, buildUserExtractorScript, buildUnfriendUserScript, buildUnfriendStepScript } = require('../modules/zalo-user-management');

test('normalizes and deduplicates Zalo users by userId without retaining session secrets', () => {
  const users = normalizeZaloUsers([
    { userId: '2', name: 'Bình', avatar: 'https://example.test/b.png', cookie: 'secret' },
    { userId: '1', name: 'Ánh', phone: '0900' },
    { userId: '2', name: 'Duplicate' },
  ]);
  assert.deepEqual(users.map((user) => user.userId), ['2', '1']);
  assert.equal(users[0].cookie, undefined);
});

test('user scan store binds results to one profile and deduplicates batches', () => {
  const store = new UserScanStore();
  store.start({ scanId: 's1', profileId: 'p1' });
  store.acceptBatch('s1', [{ userId: '1', name: 'An' }, { userId: '1', name: 'An mới' }, { userId: '2', name: 'Bình' }]);
  store.complete('s1');
  assert.equal(store.get('s1').profileId, 'p1');
  assert.deepEqual([...store.get('s1').users.keys()], ['1', '2']);
  assert.doesNotMatch(buildUserExtractorScript('s1'), /friendManager/);
  assert.match(buildUserExtractorScript('s1'), /FriendListManager/);
  assert.match(buildUserExtractorScript('s1'), /forceRequestGetFriendList/);
  assert.match(buildUserExtractorScript('s1'), /window\.fetch/);
  assert.match(buildUserExtractorScript('s1'), /XMLHttpRequest/);
  assert.match(buildUserExtractorScript('s1'), /JSON\.parse/);
  assert.doesNotMatch(buildUserExtractorScript('s1'), /cookie|localStorage|sessionStorage/i);
  assert.doesNotThrow(() => new Function(buildUserExtractorScript('s1')));
});

test('preserves ZaloPlus-compatible original and saved display names', () => {
  const [user] = normalizeZaloUsers([{ userId: '926491888752101038', zaloName: 'Thiệp Cưới', displayName: 'anh thảo' }]);
  assert.equal(user.name, 'anh thảo');
  assert.equal(user.zaloName, 'Thiệp Cưới');
  assert.equal(user.displayName, 'anh thảo');
});

test('filters user names accent-insensitively and sorts deterministically', () => {
  const users = normalizeZaloUsers([{ userId: '2', name: 'Bình' }, { userId: '1', name: 'Ánh' }]);
  assert.deepEqual(filterAndSortUsers(users, { query: 'anh', sort: 'name-asc' }).map((user) => user.userId), ['1']);
});

test('inactivity filtering excludes unknown timestamps to prevent accidental unfriend', () => {
  const now = Date.now();
  const users = normalizeZaloUsers([
    { userId: '1', name: 'Im lặng', lastInteractionAt: now - 100 * 86_400_000 },
    { userId: '2', name: 'Mới nói chuyện', lastInteractionAt: now - 5 * 86_400_000 },
    { userId: '3', name: 'Không rõ' },
  ]);
  assert.deepEqual(filterAndSortUsers(users, { inactivityDays: 90 }).map((user) => user.userId), ['1']);
  assert.equal(normalizeInteractionTime(Math.floor((now - 1000) / 1000)), Math.floor((now - 1000) / 1000) * 1000);
});

test('unfriend plan rejects unknown and protected users and requires exact confirmation', () => {
  const users = normalizeZaloUsers([{ userId: '1', name: 'An' }, { userId: '2', name: 'Bình' }]);
  assert.throws(() => buildUnfriendPlan(users, ['1'], new Set(), 'sai'), /HUY KET BAN/);
  assert.deepEqual(buildUnfriendPlan(users, ['1', '2', '3'], new Set(['2']), 'HUY KET BAN').map((user) => user.userId), ['1']);
});

test('unfriend action uses the recorded Contacts UI and never calls unstable friend managers', () => {
  const script = buildUnfriendUserScript({ userId: '12345678', name: 'Tên lưu', zaloName: 'Tên Zalo', displayName: 'Tên lưu' });
  assert.match(script, /verified:true/);
  assert.match(script, /Tên Zalo/);
  assert.match(script, /wantedNames/);
  assert.match(script, /danh sách bạn bè/);
  assert.match(script, /tìm bạn/);
  assert.match(script, /xóa bạn\|xoá bạn/);
  assert.match(script, /contacts-dom/);
  assert.match(script, /icon__action__more/);
  assert.match(script, /zl-modal__footer__button/);
  assert.match(script, /CONTACTS/);
  assert.match(script, /FRIEND_LIST/);
  assert.match(script, /SEARCH/);
  assert.match(script, /ROW/);
  assert.match(script, /MORE/);
  assert.match(script, /DELETE/);
  assert.match(script, /CONFIRM/);
  assert.match(script, /VERIFY/);
  assert.doesNotMatch(script, /FriendListManager|friendManager|forceRequestGetFriendList|removeFriend|deleteFriend/);
  assert.doesNotThrow(() => new Function(script));
});

test('unfriend stages are independent scripts with deterministic diagnostics', () => {
  const user = { userId: '12345678', name: 'Tên lưu', zaloName: 'Tên Zalo' };
  for (const stage of ['CONTACTS', 'FRIEND_LIST', 'SEARCH', 'MORE', 'DELETE', 'CONFIRM', 'REFRESH', 'VERIFY']) {
    const script = buildUnfriendStepScript(user, stage);
    assert.match(script, new RegExp(stage));
    assert.doesNotMatch(script, /FriendListManager|forceRequestGetFriendList|removeFriend|deleteFriend/);
    assert.doesNotMatch(script, /getBoundingClientRect|getComputedStyle|scrollIntoView|innerText/);
    assert.match(script, /isConnected/);
    assert.doesNotThrow(() => new Function(script));
  }
  const deleteScript = buildUnfriendStepScript(user, 'DELETE');
  assert.match(deleteScript, /querySelectorAll\('div,span,button,\[role="button"\],li'\)/);
  assert.match(deleteScript, /actions\.length!==1/);
  assert.doesNotMatch(deleteScript, /popover-v3|\[class\*="menu"\]/);
});
