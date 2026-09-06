// Preload cua BrowserView Zalo chay trong sandbox (Electron >= 20 bat sandbox mac dinh).
// Trong sandbox, preload CHI require duoc 'electron' va vai module built-in duoc phep.
// Neu them require('fs') / require('path') thi CA preload khong load duoc, keo theo:
//   - mat contextBridge 'messengerApp'  -> Tin nhan nhanh khong hoat dong
//   - mat ipcRenderer.on('zalo-group-scan:start' / 'zalo-user-scan:start')
//     -> quet Nhom Zalo / Nguoi dung Zalo dung o "Da doc 0 trang - tim thay 0 ID"
// Day chinh la loi da lam vo 3 tinh nang o ban 2.5.21. Test nay chan tai pham.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PRELOAD_PATH = path.join(__dirname, '..', 'preload.js');
const preloadSource = fs.readFileSync(PRELOAD_PATH, 'utf8');

// Module duoc phep require trong preload sandbox.
const SANDBOX_SAFE_MODULES = new Set(['electron', 'events', 'timers', 'url']);

function stripCommentsAndStrings(source) {
  // Bo comment de khong bat require() nam trong comment hoac trong script inject.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

test('preload.js chi require module an toan trong sandbox', () => {
  const code = stripCommentsAndStrings(preloadSource);
  const requires = [...code.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);

  assert.ok(requires.length > 0, 'phai co it nhat require("electron")');
  assert.ok(requires.includes('electron'), 'preload phai require("electron")');

  const forbidden = requires.filter((name) => !SANDBOX_SAFE_MODULES.has(name));
  assert.deepStrictEqual(
    forbidden,
    [],
    `preload.js khong duoc require module ngoai sandbox: ${forbidden.join(', ')}. ` +
    'Hay lay du lieu qua IPC tu main process thay vi doc file trong preload.'
  );
});

test('preload.js khong doc file tu dia', () => {
  const code = stripCommentsAndStrings(preloadSource);
  for (const banned of ['readFileSync', 'readFile(', 'existsSync', 'writeFileSync']) {
    assert.ok(
      !code.includes(banned),
      `preload sandbox khong dung duoc fs.${banned} - chuyen sang IPC tu main process`
    );
  }
});

test('preload.js van expose bridge messengerApp va listener quet', () => {
  assert.match(preloadSource, /contextBridge\.exposeInMainWorld\(\s*['"]messengerApp['"]/);
  assert.match(preloadSource, /ipcRenderer\.on\(\s*['"]zalo-group-scan:start['"]/);
  assert.match(preloadSource, /ipcRenderer\.on\(\s*['"]zalo-user-scan:start['"]/);
  assert.match(preloadSource, /ipcRenderer\.on\(\s*['"]update-quick-replies['"]/);
});

test('font Quicksand duoc cap qua get-settings tu main process', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(mainSource, /quicksandFontDataUrl:\s*getQuicksandFontDataUrl\(\)/);
  assert.match(mainSource, /function getQuicksandFontDataUrl\(\)/);
  assert.match(preloadSource, /settings\s*&&\s*settings\.quicksandFontDataUrl/);
});
