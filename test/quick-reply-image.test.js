const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  sniffImageFormat,
  imageMimeType,
  isRealPng,
  isSupportedSourceFormat,
  buildPngTargetPath,
  planImageNormalization,
  summarizeNormalization,
} = require('../modules/quick-reply-image');

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const webpBuffer = () => Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBP')]);

test('image format is detected from magic bytes, never from the file extension', () => {
  assert.equal(sniffImageFormat(PNG_HEADER), 'png');
  assert.equal(sniffImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
  assert.equal(sniffImageFormat(webpBuffer()), 'webp');
  assert.equal(sniffImageFormat(Buffer.from([0x47, 0x49, 0x46, 0x38])), 'gif');
  assert.equal(sniffImageFormat(Buffer.from([0x42, 0x4d, 0x00])), 'bmp');
  assert.equal(sniffImageFormat(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')])), null);
  assert.equal(sniffImageFormat(Buffer.alloc(2)), null);
  assert.equal(sniffImageFormat(null), null);
  assert.equal(isRealPng(webpBuffer()), false);
  assert.equal(isRealPng(PNG_HEADER), true);
  assert.equal(imageMimeType('webp'), 'image/webp');
  assert.equal(imageMimeType('jpeg'), 'image/jpeg');
});

test('a webp wearing a .png extension is still planned for real re-encoding', () => {
  const replies = [
    { id: '1', keyword: 'baogia', imagePath: 'C:/store/wearing-png.png' },
    { id: '2', keyword: 'chao', imagePath: 'C:/store/genuine.png' },
    { id: '3', keyword: 'mat', imagePath: 'C:/store/deleted.jpg' },
    { id: '4', keyword: 'chuchu', imagePath: '   ' },
    { id: '5', keyword: 'tiff', imagePath: 'C:/store/weird.tiff' },
  ];
  const readSignature = (imagePath) => {
    if (imagePath.endsWith('wearing-png.png')) return webpBuffer();
    if (imagePath.endsWith('genuine.png')) return PNG_HEADER;
    if (imagePath.endsWith('weird.tiff')) return Buffer.from([0x49, 0x49, 0x2a, 0x00]);
    return null;
  };

  const plan = planImageNormalization(replies, readSignature);
  assert.deepEqual(plan.conversions.map((entry) => [entry.keyword, entry.format]), [['baogia', 'webp']]);
  assert.deepEqual(plan.alreadyPng.map((entry) => entry.keyword), ['chao']);
  assert.deepEqual(plan.missing.map((entry) => entry.keyword), ['mat']);
  assert.deepEqual(plan.unsupported.map((entry) => entry.keyword), ['tiff']);
  assert.deepEqual(summarizeNormalization(plan), { total: 4, converted: 1, alreadyPng: 1, missing: 1, unsupported: 1 });
});

test('plan survives unreadable files instead of throwing', () => {
  const plan = planImageNormalization([{ id: '1', imagePath: 'C:/locked.webp' }], () => { throw new Error('EACCES'); });
  assert.equal(plan.missing.length, 1);
  assert.equal(plan.conversions.length, 0);
});

test('png target never overwrites the source file it was decoded from', () => {
  assert.equal(buildPngTargetPath('/store/a.webp', () => false), path.resolve('/store/a.png'));
  const renamed = buildPngTargetPath('/store/a.png', () => false);
  assert.notEqual(renamed, path.resolve('/store/a.png'));
  assert.match(renamed, /a-png\.png$/);
  let probes = 0;
  const collide = () => { probes += 1; return probes === 1; };
  assert.match(buildPngTargetPath('/store/a.png', collide), /a-png-2\.png$/);
});

test('only formats Chromium can decode are accepted as conversion sources', () => {
  for (const format of ['png', 'jpeg', 'webp', 'gif', 'bmp']) assert.equal(isSupportedSourceFormat(format), true, format);
  for (const format of ['tiff', 'svg', '', null, undefined]) assert.equal(isSupportedSourceFormat(format), false, String(format));
});
