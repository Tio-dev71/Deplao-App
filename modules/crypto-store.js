'use strict';

// Mã hoá at-rest cho các file dữ liệu nhạy cảm của ứng dụng.
// Kiến trúc: một master password -> PBKDF2 thành một khoá AES-256 duy nhất (masterKey),
// giữ trong bộ nhớ sau khi mở khoá. Mỗi file mã hoá lưu {v, salt, iv, tag, data}.
// Salt được lưu riêng trong file plaintext secure-meta.json để giải được settings.json
// (bản thân settings không thể chứa salt của chính nó).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PBKDF2_ITERATIONS = 150_000;
const KEY_LENGTH = 32;
const DIGEST = 'sha256';
const ALGO = 'aes-256-gcm';
const PAYLOAD_VERSION = 1;

function generateSalt() {
  return crypto.randomBytes(16);
}

function deriveKey(password, salt) {
  if (!password) throw new Error('deriveKey: thiếu mật khẩu');
  const saltBuf = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt), 'base64');
  if (!saltBuf.length) throw new Error('deriveKey: thiếu salt');
  return crypto.pbkdf2Sync(String(password), saltBuf, PBKDF2_ITERATIONS, KEY_LENGTH, DIGEST);
}

// Trả về payload tự chứa (có salt) — dùng khi chỉ có mật khẩu, chưa có key cache.
function encryptObject(obj, key, salt) {
  if (!key || key.length !== KEY_LENGTH) throw new Error('encryptObject: khoá không hợp lệ');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const payload = {
    v: PAYLOAD_VERSION,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  };
  if (salt) payload.salt = Buffer.isBuffer(salt) ? salt.toString('base64') : String(salt);
  return payload;
}

function decryptObject(payload, key) {
  if (!payload || typeof payload !== 'object') throw new Error('decryptObject: payload không hợp lệ');
  if (payload.v !== PAYLOAD_VERSION) throw new Error('decryptObject: phiên bản không hỗ trợ');
  if (!key || key.length !== KEY_LENGTH) throw new Error('decryptObject: khoá không hợp lệ');
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

// Nhận diện một object đã ở dạng payload mã hoá.
function isEncryptedPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.v !== PAYLOAD_VERSION) return false;
  return typeof value.iv === 'string' && typeof value.tag === 'string' && typeof value.data === 'string';
}

// Đọc nội dung text -> có phải payload mã hoá không.
function isEncryptedFileContent(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return false;
  try { return isEncryptedPayload(JSON.parse(trimmed)); } catch { return false; }
}

// Đọc 1 file: phân biệt plaintext vs ciphertext.
//  - Không tồn tại / rỗng  -> { status: 'missing' }
//  - Plaintext JSON        -> { status: 'plain', data }
//  - Ciphertext, mở được   -> { status: 'encrypted', data }
//  - Ciphertext, cần pass  -> { status: 'locked' } (chưa có key hoặc sai key)
function readStoreFile(filePath, key) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return { status: 'missing' }; }
  const trimmed = (raw || '').trim();
  if (!trimmed) return { status: 'missing' };
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { return { status: 'plain', data: null, parseError: true }; }
  if (!isEncryptedPayload(parsed)) return { status: 'plain', data: parsed };
  if (!key) return { status: 'locked', reason: 'no-key' };
  try {
    return { status: 'encrypted', data: decryptObject(parsed, key) };
  } catch (err) {
    return { status: 'locked', reason: err.message || String(err) };
  }
}

// Ghi atomic: tmp -> rename. plaintext nếu không có key, ngược lại mã hoá.
function writeStoreFile(filePath, obj, key, salt) {
  const dir = path.dirname(filePath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const text = key
    ? JSON.stringify(encryptObject(obj, key, salt))
    : JSON.stringify(obj, null, 2);
  const tmp = `${filePath}.tmp.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

// Giữ 1 backup plaintext gần nhất (dùng khi migrate từ plaintext -> encrypted).
function backupFile(filePath, backupPath) {
  try {
    const raw = fs.readFileSync(filePath);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.writeFileSync(backupPath, raw);
    return true;
  } catch { return false; }
}

module.exports = {
  PBKDF2_ITERATIONS,
  KEY_LENGTH,
  DIGEST,
  ALGO,
  PAYLOAD_VERSION,
  generateSalt,
  deriveKey,
  encryptObject,
  decryptObject,
  isEncryptedPayload,
  isEncryptedFileContent,
  readStoreFile,
  writeStoreFile,
  backupFile,
};
