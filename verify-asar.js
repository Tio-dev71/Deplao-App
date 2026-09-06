// Doc preload.js tu app.asar vua build de chac chan ban giao cho nguoi dung da het loi.
const asar = require('@electron/asar');
const path = require('path');

const asarPath = path.join('dist', 'win-unpacked', 'resources', 'app.asar');
const preload = asar.extractFile(asarPath, 'preload.js').toString('utf8');
const pkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'));

const code = preload.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const requires = [...code.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
const SAFE = new Set(['electron', 'events', 'timers', 'url']);
const bad = requires.filter((r) => !SAFE.has(r));

const checks = {
  version: pkg.version,
  requires: [...new Set(requires)],
  requireNgoaiSandbox: bad,
  coBridge: /contextBridge\.exposeInMainWorld\(\s*['"]messengerApp['"]/.test(preload),
  coListenerQuetNhom: /ipcRenderer\.on\(\s*['"]zalo-group-scan:start['"]/.test(preload),
  coListenerQuetNguoiDung: /ipcRenderer\.on\(\s*['"]zalo-user-scan:start['"]/.test(preload),
  triggerLaBackslash: /var trigger = String\.fromCharCode\(92\)/.test(preload),
  anPanelGocZalo: /^\s*setupQuickReplyPanelHider\(\);/m.test(preload),
  fontQuaGetSettings: /settings\s*&&\s*settings\.quicksandFontDataUrl/.test(preload),
  coModuleKhoMedia: (() => { try { return !!asar.extractFile(asarPath, 'modules/media-library.js').length; } catch { return false; } })(),
  coModuleAnhNenVideo: (() => { try { return !!asar.extractFile(asarPath, 'modules/video-thumbnail.js').length; } catch { return false; } })(),
  coModuleCryptoStore: (() => { try { return !!asar.extractFile(asarPath, 'modules/crypto-store.js').length; } catch { return false; } })(),
};

console.log(JSON.stringify(checks, null, 2));

const problems = [];
if (bad.length) problems.push('preload con require ngoai sandbox: ' + bad.join(', '));
for (const key of ['coBridge', 'coListenerQuetNhom', 'coListenerQuetNguoiDung', 'triggerLaBackslash',
  'anPanelGocZalo', 'fontQuaGetSettings', 'coModuleKhoMedia', 'coModuleAnhNenVideo', 'coModuleCryptoStore']) {
  if (!checks[key]) problems.push('thieu: ' + key);
}
if (problems.length) { console.log('KHONG DAT: ' + problems.join('; ')); process.exit(1); }
console.log('app.asar ' + pkg.version + ' DAT');
