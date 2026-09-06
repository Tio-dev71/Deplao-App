const test = require('node:test');
const assert = require('node:assert/strict');

test('CRM import normalizes shortcuts and allocates stable collision suffixes', async () => {
  const { allocateKeyword, normalizeKeyword } = await import('../scripts/import-crm-quick-replies.mjs');
  const occupied = new Set(['bill', 'bill-2']);
  assert.equal(normalizeKeyword(' /xin chao '), 'xin-chao');
  assert.equal(allocateKeyword('bill', occupied), 'bill-3');
  assert.equal(occupied.has('bill-3'), true);
});

test('CRM import keeps only valid HTTP attachment URLs', async () => {
  const { getAttachments } = await import('../scripts/import-crm-quick-replies.mjs');
  const attachments = getAttachments({
    contentRich: { attachments: ['https://cdn.test/a.jpg', 'file:///secret.jpg', 12] },
  });
  assert.deepEqual(attachments, ['https://cdn.test/a.jpg']);
});
