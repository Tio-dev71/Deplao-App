// Kho media dùng chung cho Nhà Yến Zalo.
// Nằm NGOÀI thư mục cài đặt để bản cập nhật không xóa video của người dùng,
// và không đóng gói vào app.asar. Mặc định:
//   %AppData%\Nhà Yến Zalo\media\{videos,thumbnails,trash,video-library.json}
// Người dùng có thể chuyển sang ổ khác (đường dẫn lưu trong settings).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const MAX_LIBRARY_VIDEO_BYTES = 20 * 1024 * 1024;
const SUPPORTED_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'];

// Bố cục thư mục kho, suy ra từ một gốc duy nhất để đổi chỗ được.
function mediaStoreLayout(mediaRoot) {
  const root = String(mediaRoot || '');
  return {
    root,
    videosDir: path.join(root, 'videos'),
    thumbnailsDir: path.join(root, 'thumbnails'),
    trashDir: path.join(root, 'trash'),
    libraryPath: path.join(root, 'video-library.json'),
  };
}

function ensureMediaStore(mediaRoot) {
  const layout = mediaStoreLayout(mediaRoot);
  for (const dir of [layout.root, layout.videosDir, layout.thumbnailsDir, layout.trashDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return layout;
}

function isSupportedVideoExtension(filePath) {
  return SUPPORTED_VIDEO_EXTENSIONS.includes(path.extname(String(filePath || '')).toLowerCase());
}

// Hash nội dung để nhận ra cùng một video dù tên khác nhau.
function hashVideoFile(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

// Trùng khi cùng hash; trả về bản ghi đã có để báo cho người dùng.
function findDuplicateByHash(rows, hash) {
  if (!hash) return null;
  return (Array.isArray(rows) ? rows : []).find((item) => item && item.hash === hash) || null;
}

// Tên tệp an toàn, không đè tệp cũ.
function uniqueVideoFileName(videosDir, originalName, exists = fs.existsSync) {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  const base = path.basename(String(originalName || ''), ext).replace(/[^a-z0-9 _.-]/gi, '_').slice(0, 80) || 'video';
  let candidate = `${base}${ext}`;
  let counter = 2;
  while (exists(path.join(videosDir, candidate))) candidate = `${base}-${counter++}${ext}`;
  return candidate;
}

// Kiểm tra một tệp có thêm vào kho được không, trước khi copy.
function planVideoAddition(sourcePath, rows, { maxBytes = MAX_LIBRARY_VIDEO_BYTES, statSync = fs.statSync } = {}) {
  const name = path.basename(String(sourcePath || ''));
  if (!isSupportedVideoExtension(sourcePath)) {
    return { ok: false, name, reason: 'unsupported', message: 'Định dạng video không hỗ trợ.' };
  }
  let size = 0;
  try {
    size = statSync(sourcePath).size;
  } catch {
    return { ok: false, name, reason: 'missing', message: 'Không đọc được tệp video.' };
  }
  if (size > maxBytes) {
    const limitMb = Math.round(maxBytes / (1024 * 1024));
    return { ok: false, name, reason: 'too-large', message: `Video vượt quá ${limitMb} MB.` };
  }
  return { ok: true, name, size };
}

// Đọc danh sách, loại bỏ bản ghi trỏ tới tệp đã mất.
function readVideoLibraryRows(layout, { existsSync = fs.existsSync, readFileSync = fs.readFileSync } = {}) {
  try {
    const parsed = JSON.parse(readFileSync(layout.libraryPath, 'utf8'));
    const rows = Array.isArray(parsed) ? parsed : [];
    return rows.filter((item) => item && item.id && item.fileName
      && existsSync(path.join(layout.videosDir, item.fileName)));
  } catch {
    return [];
  }
}

// Ghi nguyên tử để mất điện giữa lúc ghi không làm hỏng danh sách.
function writeVideoLibraryRows(layout, rows) {
  fs.mkdirSync(layout.root, { recursive: true });
  const tempPath = `${layout.libraryPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(rows, null, 2), 'utf8');
  fs.renameSync(tempPath, layout.libraryPath);
}

// Xóa = chuyển vào trash, để người dùng còn cứu lại được.
function moveVideoToTrash(layout, fileName, { now = Date.now } = {}) {
  const source = path.join(layout.videosDir, fileName);
  if (!fs.existsSync(source)) return { ok: true, trashed: false };
  fs.mkdirSync(layout.trashDir, { recursive: true });
  const target = path.join(layout.trashDir, `${now()}-${fileName}`);
  try {
    fs.renameSync(source, target);
  } catch {
    // Khác phân vùng thì rename không được, copy rồi xóa.
    fs.copyFileSync(source, target);
    fs.unlinkSync(source);
  }
  return { ok: true, trashed: true, trashPath: target };
}

function thumbnailFileName(id) {
  return `${String(id || '').replace(/[^a-z0-9-]/gi, '') || 'thumb'}.png`;
}

// Bản ghi gửi ra renderer: thêm đường dẫn tuyệt đối để hiển thị.
function videoLibraryPublicItem(layout, item) {
  const thumbName = item.thumbnail || thumbnailFileName(item.id);
  const thumbPath = path.join(layout.thumbnailsDir, thumbName);
  return {
    ...item,
    filePath: path.join(layout.videosDir, item.fileName),
    thumbnailPath: fs.existsSync(thumbPath) ? thumbPath : '',
  };
}

// Định dạng thời lượng cho giao diện: 0:07, 1:42, 1:02:03.
function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function formatFileSize(bytes) {
  const size = Math.max(0, Number(bytes) || 0);
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

module.exports = {
  MAX_LIBRARY_VIDEO_BYTES,
  SUPPORTED_VIDEO_EXTENSIONS,
  mediaStoreLayout,
  ensureMediaStore,
  isSupportedVideoExtension,
  hashVideoFile,
  findDuplicateByHash,
  uniqueVideoFileName,
  planVideoAddition,
  readVideoLibraryRows,
  writeVideoLibraryRows,
  moveVideoToTrash,
  thumbnailFileName,
  videoLibraryPublicItem,
  formatDuration,
  formatFileSize,
};
