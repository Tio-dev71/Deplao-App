const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mappingKey, extractOrderCode, upsertGroupMapping, findGroupMapping,
  findScannedGroupByName, calculateStandardQuote, buildQuoteText,
} = require('../modules/crm-panel');

test('group mapping is keyed by profile and immutable group id, not display name', () => {
  const first = upsertGroupMapping([], { profileId: 'nick-1', groupId: 'group-9', groupName: 'D250817 - demo' }, 100);
  const renamed = upsertGroupMapping(first.entries, { profileId: 'nick-1', groupId: 'group-9', groupName: 'D250817 - đang thiết kế' }, 200);
  assert.equal(mappingKey('nick-1', 'group-9'), 'nick-1:group-9');
  assert.equal(renamed.entries.length, 1);
  assert.equal(renamed.mapping.orderCode, 'D250817');
  assert.equal(renamed.mapping.nameHistory[0].name, 'D250817 - demo');
  assert.equal(findGroupMapping(renamed.entries, 'nick-1', 'group-9').currentName, 'D250817 - đang thiết kế');
});

test('name matching is only a bootstrap aid and reports duplicates', () => {
  assert.equal(findScannedGroupByName([{ groupId: '1', name: 'File thiết kế' }], 'File thiết kế').status, 'unique');
  assert.equal(findScannedGroupByName([{ groupId: '1', name: 'A' }, { groupId: '2', name: 'A' }], 'A').status, 'ambiguous');
  assert.equal(extractOrderCode('D250817 - chốt in'), 'D250817');
});

test('standard quote calculator follows the CRM pricing tiers and hides premium quote concerns', () => {
  const quote = calculateStandardQuote({ type: 'nhunu', quantity: 400, emboss: true, embossPositions: 2 });
  assert.equal(quote.unitPrice, 3400);
  assert.equal(quote.paperCost, 1360000);
  assert.equal(quote.embossCost, 1200000);
  assert.equal(quote.total, 2560000);
  assert.match(buildQuoteText({ type: 'nhunu', quantity: 400 }), /BÁO GIÁ THIỆP CƯỚI NHÀ YẾN/);
  assert.equal(buildQuoteText({ quantity: 49 }), '');
});
