'use strict';

// Unit test cho modules/crypto-store.js — lớp mã hoá at-rest bằng master password.
// Chỉ dùng in-memory + temp dir, không đụng dữ liệu thật của người dùng.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cs = require('../modules/crypto-store.js');

test('deriveKey: cùng password + salt cho ra cùng khoá 32 byte; salt khác -> khoá khác', () => {
  const salt = cs.generateSalt();
  const k1 = cs.deriveKey('master-secret', salt);
  const k2 = cs.deriveKey('master-secret', salt);
  const k3 = cs.deriveKey('master-secret', cs.generateSalt());
  assert.equal(k1.length, cs.KEY_LENGTH);
  assert.ok(Buffer.compare(k1, k2) === 0, 'PBKDF2 phải deterministic');
  assert.notEqual(k1.toString('base64'), k3.toString('base64'), 'salt khác phải ra khoá khác');
  assert.throws(() => cs.deriveKey('', salt), /thiếu mật khẩu/);
});

test('round-trip: encryptObject -> decryptObject trả đúng object ban đầu', () => {
  const key = cs.deriveKey('master-secret', cs.generateSalt());
  const obj = { a: 1, b: 'two', c: { nested: [1, 2, 3] }, d: 'tiếng Việt có dấu ế ộ ư' };
  const payload = cs.encryptObject(obj, key);
  assert.equal(payload.v, cs.PAYLOAD_VERSION);
  assert.equal(typeof payload.iv, 'string');
  assert.equal(typeof payload.tag, 'string');
  assert.equal(typeof payload.data, 'string');
  const back = cs.decryptObject(payload, key);
  assert.deepEqual(back, obj);
});

test('sai key: decryptObject throw (GCM auth tag fail)', () => {
  const key = cs.deriveKey('right', cs.generateSalt());
  const wrong = cs.deriveKey('wrong', cs.generateSalt());
  const payload = cs.encryptObject({ hello: 'world' }, key);
  assert.throws(() => cs.decryptObject(payload, wrong));
});

test('dữ liệu bị sửa (tag / data giả mạo): decryptObject throw', () => {
  const key = cs.deriveKey('right', cs.generateSalt());
  const payload = cs.encryptObject({ hello: 'world' }, key);
  const tamperTag = { ...payload, tag: Buffer.from(cs.PAYLOAD_VERSION ? require('crypto').randomBytes(16) : 0).toString('base64') };
  assert.throws(() => cs.decryptObject(tamperTag, key));
  // Sửa data -> tag không khớp.
  const bytes = Buffer.from(payload.data, 'base64');
  bytes[0] ^= 0xff;
  const tamperData = { ...payload, data: bytes.toString('base64') };
  assert.throws(() => cs.decryptObject(tamperData, key));
});

test('isEncryptedPayload / isEncryptedFileContent nhận diện đúng payload', () => {
  const key = cs.deriveKey('right', cs.generateSalt());
  const payload = cs.encryptObject({ x: 1 }, key);
  assert.equal(cs.isEncryptedPayload(payload), true);
  assert.equal(cs.isEncryptedPayload({ plain: 'json' }), false);
  assert.equal(cs.isEncryptedPayload(null), false);
  assert.equal(cs.isEncryptedPayload([1, 2, 3]), false);
  assert.equal(cs.isEncryptedFileContent(JSON.stringify(payload)), true);
  assert.equal(cs.isEncryptedFileContent(JSON.stringify({ plain: 'json' })), false);
  assert.equal(cs.isEncryptedFileContent('not json at all'), false);
});

test('readStoreFile / writeStoreFile: vòng plaintext <-> encrypted và trạng thái locked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-crypto-'));
  try {
    const file = path.join(dir, 'settings.json');
    const salt = cs.generateSalt();
    const key = cs.deriveKey('master-secret', salt);

    // missing khi chưa có file.
    assert.equal(cs.readStoreFile(file, key).status, 'missing');

    // ghi plaintext (không key) -> đọc lại plain.
    cs.writeStoreFile(file, { theme: 'light' }, null, null);
    const plainRead = cs.readStoreFile(file, key);
    assert.equal(plainRead.status, 'plain');
    assert.deepEqual(plainRead.data, { theme: 'light' });

    // ghi encrypted -> đĩa phải là ciphertext, đọc với đúng key trả encrypted.
    cs.writeStoreFile(file, { theme: 'dark', token: 'abc' }, key, salt);
    const rawOnDisk = fs.readFileSync(file, 'utf8');
    assert.equal(cs.isEncryptedFileContent(rawOnDisk), true, 'file trên đĩa phải là ciphertext');
    assert.doesNotMatch(rawOnDisk, /dark/, 'không được lọt plaintext ra đĩa');
    const encRead = cs.readStoreFile(file, key);
    assert.equal(encRead.status, 'encrypted');
    assert.deepEqual(encRead.data, { theme: 'dark', token: 'abc' });

    // không có key -> locked.
    assert.equal(cs.readStoreFile(file, null).status, 'locked');
    // sai key -> locked.
    const badKey = cs.deriveKey('wrong', salt);
    assert.equal(cs.readStoreFile(file, badKey).status, 'locked');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backupFile: giữ bản gốc trước khi migrate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-crypto-'));
  try {
    const file = path.join(dir, 'data.json');
    const backup = path.join(dir, 'backups', 'data.json.bak');
    fs.writeFileSync(file, JSON.stringify({ original: true }), 'utf8');
    assert.equal(cs.backupFile(file, backup), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(backup, 'utf8')), { original: true });
    assert.equal(cs.backupFile(path.join(dir, 'khong-ton-tai.json'), backup), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
