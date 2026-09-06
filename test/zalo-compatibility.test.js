const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCompatibilityProbeScript } = require('../modules/zalo-compatibility');

test('compatibility probe is read-only and never accesses session secrets or message content', () => {
  const script = buildCompatibilityProbeScript();
  assert.match(script, /FriendListManager/);
  assert.match(script, /groupManager/);
  assert.match(script, /identityAttributes/);
  assert.doesNotMatch(script, /document\.cookie|localStorage|sessionStorage|innerText|textContent/);
  assert.doesNotThrow(() => new Function(script));
});
