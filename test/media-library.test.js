// Kho media: bo cuc thu muc, chong trung bang hash, thung rac, dinh dang hien thi.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MAX_LIBRARY_VIDEO_BYTES,
  mediaStoreLayout,
  ensureMediaStore,
  hashVideoFile,
  findDuplicateByHash,
  uniqueVideoFileName,
  planVideoAddition,
  readVideoLibraryRows,
  writeVideoLibraryRows,
  moveVideoToTrash,
  thumbnailFileName,
  formatDuration,
  formatFileSize,
} = require('../modules/media-library');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nyz-media-'));
}

test('bo cuc kho media tach videos, thumbnails, trash va danh sach', () => {
  const layout = mediaStoreLayout('C:/kho/media');
  assert.strictEqual(layout.videosDir, path.join('C:/kho/media', 'videos'));
  assert.strictEqual(layout.thumbnailsDir, path.join('C:/kho/media', 'thumbnails'));
  assert.strictEqual(layout.trashDir, path.join('C:/kho/media', 'trash'));
  // Danh sach nam o goc kho, khong nam trong videos/ de doi cho de hon.
  assert.strictEqual(layout.libraryPath, path.join('C:/kho/media', 'video-library.json'));
});

test('ensureMediaStore tao du bon thu muc', () => {
  const root = tempRoot();
  const layout = ensureMediaStore(path.join(root, 'media'));
  for (const dir of [layout.root, layout.videosDir, layout.thumbnailsDir, layout.trashDir]) {
    assert.ok(fs.existsSync(dir), `thieu ${dir}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('cung noi dung thi nhan ra trung du ten khac nhau', () => {
  const root = tempRoot();
  const a = path.join(root, 'a.mp4');
  const b = path.join(root, 'ten-khac.mp4');
  fs.writeFileSync(a, 'noi dung video giong nhau');
  fs.writeFileSync(b, 'noi dung video giong nhau');

  const hashA = hashVideoFile(a);
  const hashB = hashVideoFile(b);
  assert.strictEqual(hashA, hashB);

  const rows = [{ id: '1', name: 'Video cu', fileName: 'a.mp4', hash: hashA }];
  const duplicate = findDuplicateByHash(rows, hashB);
  assert.ok(duplicate);
  assert.strictEqual(duplicate.name, 'Video cu');
  assert.strictEqual(findDuplicateByHash(rows, 'hash-khac'), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('planVideoAddition tu choi dinh dang la va tep qua lon', () => {
  const root = tempRoot();
  const big = path.join(root, 'to.mp4');
  fs.writeFileSync(big, Buffer.alloc(64));

  const wrongExt = planVideoAddition(path.join(root, 'tep.txt'), []);
  assert.strictEqual(wrongExt.ok, false);
  assert.strictEqual(wrongExt.reason, 'unsupported');

  const tooLarge = planVideoAddition(big, [], { maxBytes: 32 });
  assert.strictEqual(tooLarge.ok, false);
  assert.strictEqual(tooLarge.reason, 'too-large');
  assert.match(tooLarge.message, /MB/);

  const ok = planVideoAddition(big, [], { maxBytes: MAX_LIBRARY_VIDEO_BYTES });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.size, 64);
  fs.rmSync(root, { recursive: true, force: true });
});

test('ten tep khong de tep cu', () => {
  const root = tempRoot();
  const layout = ensureMediaStore(path.join(root, 'media'));
  fs.writeFileSync(path.join(layout.videosDir, 'clip.mp4'), 'x');
  const next = uniqueVideoFileName(layout.videosDir, 'clip.mp4');
  assert.strictEqual(next, 'clip-2.mp4');
  fs.rmSync(root, { recursive: true, force: true });
});

test('danh sach bo qua ban ghi tro toi tep da mat', () => {
  const root = tempRoot();
  const layout = ensureMediaStore(path.join(root, 'media'));
  fs.writeFileSync(path.join(layout.videosDir, 'con.mp4'), 'x');
  writeVideoLibraryRows(layout, [
    { id: '1', fileName: 'con.mp4', name: 'Con' },
    { id: '2', fileName: 'mat.mp4', name: 'Mat' },
  ]);
  const rows = readVideoLibraryRows(layout);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].id, '1');
  fs.rmSync(root, { recursive: true, force: true });
});

test('xoa video la chuyen vao thung rac, khong xoa han', () => {
  const root = tempRoot();
  const layout = ensureMediaStore(path.join(root, 'media'));
  fs.writeFileSync(path.join(layout.videosDir, 'xoa.mp4'), 'noi dung');
  const result = moveVideoToTrash(layout, 'xoa.mp4', { now: () => 1700000000000 });
  assert.strictEqual(result.trashed, true);
  assert.ok(!fs.existsSync(path.join(layout.videosDir, 'xoa.mp4')));
  const trashed = fs.readdirSync(layout.trashDir);
  assert.strictEqual(trashed.length, 1);
  assert.match(trashed[0], /xoa\.mp4$/);
  // Con doc lai duoc noi dung -> cuu lai duoc.
  assert.strictEqual(fs.readFileSync(path.join(layout.trashDir, trashed[0]), 'utf8'), 'noi dung');
  fs.rmSync(root, { recursive: true, force: true });
});

test('thumbnail luon la ten png an toan', () => {
  assert.strictEqual(thumbnailFileName('abc-123'), 'abc-123.png');
  assert.strictEqual(thumbnailFileName('../../hack'), 'hack.png');
  assert.strictEqual(thumbnailFileName(''), 'thumb.png');
});

test('dinh dang thoi luong va dung luong cho giao dien', () => {
  assert.strictEqual(formatDuration(7), '0:07');
  assert.strictEqual(formatDuration(102), '1:42');
  assert.strictEqual(formatDuration(3723), '1:02:03');
  assert.strictEqual(formatDuration(0), '0:00');
  assert.strictEqual(formatDuration(-5), '0:00');
  assert.match(formatFileSize(2 * 1024 * 1024), /2\.0 MB/);
  assert.match(formatFileSize(2048), /2 KB/);
});
