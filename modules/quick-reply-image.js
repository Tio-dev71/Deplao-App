const path = require('path');

// Nhận dạng định dạng ảnh bằng magic bytes, không tin phần mở rộng file.
const SIGNATURES = [
  { format: 'png', mimeType: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { format: 'jpeg', mimeType: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { format: 'gif', mimeType: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { format: 'bmp', mimeType: 'image/bmp', bytes: [0x42, 0x4d] },
];

function startsWith(buffer, bytes) {
  if (!buffer || buffer.length < bytes.length) return false;
  for (let index = 0; index < bytes.length; index += 1) {
    if (buffer[index] !== bytes[index]) return false;
  }
  return true;
}

function isWebp(buffer) {
  // RIFF....WEBP
  return Boolean(buffer)
    && buffer.length >= 12
    && startsWith(buffer, [0x52, 0x49, 0x46, 0x46])
    && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50;
}

function sniffImageFormat(buffer) {
  if (!buffer || !buffer.length) return null;
  if (isWebp(buffer)) return 'webp';
  const matched = SIGNATURES.find((entry) => startsWith(buffer, entry.bytes));
  return matched ? matched.format : null;
}

function imageMimeType(format) {
  if (format === 'webp') return 'image/webp';
  const matched = SIGNATURES.find((entry) => entry.format === format);
  return matched ? matched.mimeType : '';
}

function isRealPng(buffer) {
  return sniffImageFormat(buffer) === 'png';
}

const SUPPORTED_SOURCE_FORMATS = new Set(['png', 'jpeg', 'webp', 'gif', 'bmp']);

function isSupportedSourceFormat(format) {
  return SUPPORTED_SOURCE_FORMATS.has(String(format || ''));
}

// Giữ nguyên tên file (uuid) và chỉ đổi đuôi sang .png; nếu đã là .png thì thêm hậu tố
// để không ghi đè file nguồn khi nó chỉ đội tên .png nhưng nội dung là webp.
function buildPngTargetPath(currentPath, exists = () => false) {
  const resolved = path.resolve(String(currentPath || ''));
  const dir = path.dirname(resolved);
  const base = path.basename(resolved, path.extname(resolved));
  let candidate = path.join(dir, `${base}.png`);
  if (candidate !== resolved && !exists(candidate)) return candidate;
  let counter = 1;
  do {
    candidate = path.join(dir, `${base}-png${counter > 1 ? `-${counter}` : ''}.png`);
    counter += 1;
  } while (candidate === resolved || exists(candidate));
  return candidate;
}

// Lập kế hoạch chuẩn hóa dựa trên nội dung thật của từng file.
// readSignature(imagePath) -> Buffer|null (null nếu file không tồn tại/không đọc được)
function planImageNormalization(replies, readSignature) {
  const plan = { conversions: [], alreadyPng: [], missing: [], unsupported: [] };
  for (const reply of Array.isArray(replies) ? replies : []) {
    const imagePath = String(reply?.imagePath || '').trim();
    if (!imagePath) continue;
    const entry = { id: String(reply.id || ''), keyword: String(reply.keyword || ''), imagePath };
    let signature = null;
    try {
      signature = readSignature(imagePath);
    } catch {
      signature = null;
    }
    if (!signature || !signature.length) {
      plan.missing.push(entry);
      continue;
    }
    const format = sniffImageFormat(signature);
    if (format === 'png') {
      plan.alreadyPng.push({ ...entry, format });
      continue;
    }
    if (!isSupportedSourceFormat(format)) {
      plan.unsupported.push({ ...entry, format: format || 'unknown' });
      continue;
    }
    plan.conversions.push({ ...entry, format, mimeType: imageMimeType(format) });
  }
  return plan;
}

function summarizeNormalization(plan) {
  return {
    total: plan.conversions.length + plan.alreadyPng.length + plan.missing.length + plan.unsupported.length,
    converted: plan.conversions.length,
    alreadyPng: plan.alreadyPng.length,
    missing: plan.missing.length,
    unsupported: plan.unsupported.length,
  };
}

module.exports = {
  sniffImageFormat,
  imageMimeType,
  isRealPng,
  isSupportedSourceFormat,
  buildPngTargetPath,
  planImageNormalization,
  summarizeNormalization,
  SUPPORTED_SOURCE_FORMATS,
};
