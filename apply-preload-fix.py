"""Ap lai toan bo sua chua cho preload.js.

Chay lai an toan nhieu lan (idempotent). Dung khi preload.js bi ghi de
tro lai ban loi (co require('fs') o dau file).

  python apply-preload-fix.py
"""
import io
import sys

p = 'preload.js'
s = io.open(p, encoding='utf-8', newline='').read()
changed = []

# --- 1) Bo require('fs')/require('path') - nguyen nhan lam ca preload chet trong sandbox.
broken_head = """const { contextBridge, ipcRenderer, webFrame } = require('electron');
const fs = require('fs');
const path = require('path');

let quicksandFontDataUrl = '';
try {
  const quicksandFont = fs.readFileSync(path.join(__dirname, 'assets', 'fonts', 'Quicksand-VariableFont_wght.ttf'));
  quicksandFontDataUrl = `data:font/ttf;base64,${quicksandFont.toString('base64')}`;
} catch (_) {
  // The app shell still falls back to sans-serif if the packaged font is unavailable.
}
"""
fixed_head = """// Preload nay chay trong sandbox (Electron >= 20 bat sandbox mac dinh cho BrowserView),
// nen CHI duoc require('electron'). Moi require khac (fs, path, ...) se lam ca preload
// khong load duoc -> mat contextBridge va mat cac listener IPC quet nhom/nguoi dung.
const { contextBridge, ipcRenderer, webFrame } = require('electron');
"""
if broken_head in s:
    s = s.replace(broken_head, fixed_head, 1)
    changed.append('bo require fs/path')

# --- 2) Font lay qua get-settings, khong doc dia.
old_settings = "const settings = ipcRenderer.sendSync('get-settings');\n"
new_settings = """// Neu main process chua kip dang ky listener thi sendSync tra ve undefined;
// dung object rong de preload khong bao gio chet giua duong (mat bridge + mat listener quet).
const settings = ipcRenderer.sendSync('get-settings') || {};
// Font Quicksand duoc main process doc tu dia va gui kem theo get-settings,
// vi preload sandbox khong the tu doc file.
const quicksandFontDataUrl = (settings && settings.quicksandFontDataUrl) || '';
"""
if old_settings in s and 'settings.quicksandFontDataUrl' not in s:
    s = s.replace(old_settings, new_settings, 1)
    changed.append('font qua get-settings')

# --- 3) Trigger la backslash theo chot moi cua anh chu (go \tu-khoa).
if "var trigger = '/'" in s:
    s = s.replace("var trigger = '/';", "var trigger = String.fromCharCode(92);")
    changed.append('trigger backslash')
if "token.charCodeAt(0) === 47" in s:
    s = s.replace("var validToken = token.charCodeAt(0) === 47;", "var validToken = token.charCodeAt(0) === 92;")
    s = s.replace("tokenCode === 160 || tokenCode === 47", "tokenCode === 160 || tokenCode === 92")
    changed.append('validToken 92')
old_comment = "      // Không ẩn Tin nhắn nhanh gốc: dấu / tiếp tục do Zalo Web xử lý.\n"
new_comment = ("      // Ẩn panel Tin nhắn nhanh gốc của Zalo để chỉ còn danh sách của Nhà Yến"
               " (chỉ ẩn bằng CSS, không vá sâu vào Zalo).\n      setupQuickReplyPanelHider();\n")
if old_comment in s:
    s = s.replace(old_comment, new_comment, 1)
    changed.append('bat hider')

# --- 5) Comment mo ta trigger cho khop.
s = s.replace(
    "      // Quick Reply Shortcut System - Nhà Yến dùng dấu gạch chéo ngược; dấu / dành cho Zalo Web.",
    "      // Quick Reply Shortcut System - Nhà Yến dùng dấu \ và ẩn panel gốc của Zalo Web.")

io.open(p, 'w', encoding='utf-8', newline='').write(s)

# --- Kiem tra lai ---
final = io.open(p, encoding='utf-8').read()
problems = []
import re
requires = re.findall(r"\brequire\(\s*['\"]([^'\"]+)['\"]\s*\)", re.sub(r'^[ \t]*//.*$', '', final, flags=re.M))
bad = [r for r in requires if r not in ('electron', 'events', 'timers', 'url')]
if bad:
    problems.append('con require ngoai sandbox: ' + ', '.join(bad))
if "var trigger = '/'" in final:
    problems.append('trigger chua la backslash')
if not re.search(r'^\s*setupQuickReplyPanelHider\(\);', final, re.M):
    problems.append('chua bat hider')

print('da sua:', ', '.join(changed) if changed else '(khong co gi can sua)')
if problems:
    print('CON LOI:', '; '.join(problems))
    sys.exit(1)
print('preload.js OK')
