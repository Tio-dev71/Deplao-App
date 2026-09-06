const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanId,
  classifyUnfriendResponse,
  buildUnfriendBridgeProbeScript,
  buildDirectUnfriendScript,
} = require('../modules/zalo-unfriend-bridge');

test('direct unfriend bridge accepts only immutable numeric Zalo ids', () => {
  assert.equal(cleanId('12345678'), '12345678');
  assert.throws(() => cleanId('Tên người dùng'), /không hợp lệ/);
  assert.throws(() => cleanId('1;document.cookie'), /không hợp lệ/);
});

test('direct unfriend response requires an explicit successful server response', () => {
  assert.deepEqual(classifyUnfriendResponse({ status: 200, data: { error_code: 0 } }), { ok: true });
  assert.equal(classifyUnfriendResponse({ status: 200, data: { error_code: 114 } }).ok, false);
  assert.equal(classifyUnfriendResponse({ status: 500 }).ok, false);
  assert.equal(classifyUnfriendResponse({}).ok, false);
});

test('probe discovers the current Zalo remove-friend adapter without session export', () => {
  const script = buildUnfriendBridgeProbeScript();
  assert.match(script, /\/api\/friend\/remove\?/);
  assert.match(script, /remove\.\?friend/);
  assert.match(script, /webpackJsonp/);
  assert.match(script, /webpack-direct/);
  assert.doesNotMatch(script, /document\.cookie|localStorage|sessionStorage|authorization/i);
  assert.doesNotThrow(() => new Function(script));
});

test('direct action calls the in-session API and never clicks or focuses Zalo UI', () => {
  const script = buildDirectUnfriendScript('12345678');
  assert.match(script, /bridge\.owner\[bridge\.key\]\.call/);
  assert.match(script, /updateMultiFriend/);
  assert.match(script, /error_code/);
  assert.match(script, /15 giây/);
  assert.doesNotMatch(script, /\.click\(|MouseEvent|querySelector|FriendListManager|forceRequestGetFriendList/);
  assert.doesNotMatch(script, /document\.cookie|localStorage|sessionStorage|authorization/i);
  assert.doesNotThrow(() => new Function(script));
});
