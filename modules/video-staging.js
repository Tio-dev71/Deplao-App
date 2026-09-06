const path = require('path');

const SUPPORTED_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);

function isSupportedVideoPath(videoPath) {
  return SUPPORTED_VIDEO_EXTENSIONS.has(path.extname(String(videoPath || '')).toLowerCase());
}

const VIDEO_INPUT_EXPRESSION = `
  (function() {
    var inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    function score(input) {
      var accept = String(input.accept || '').toLowerCase();
      if (accept.includes('video/')) return 100;
      if (accept.includes('.mp4') || accept.includes('.mov') || accept.includes('.webm')) return 90;
      if (!accept || accept.includes('*/*')) return 20;
      return -1;
    }
    inputs.sort(function(a, b) { return score(b) - score(a); });
    return inputs.length && score(inputs[0]) >= 0 ? inputs[0] : null;
  })()
`;

const OPEN_ATTACHMENT_EXPRESSION = `
  (function() {
    function visible(el) {
      if (!el) return false;
      var rect = el.getBoundingClientRect();
      var style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }
    var composer = document.querySelector('#richInput, .chat-input [contenteditable="true"], [contenteditable="true"]');
    if (!composer || !visible(composer)) return { ok: false, message: 'Hãy mở một hội thoại Zalo trước.' };
    var terms = ['đính kèm', 'dinh kem', 'gửi file', 'gui file', 'video', 'hình ảnh', 'hinh anh', 'ảnh', 'file'];
    var candidates = Array.from(document.querySelectorAll('button,[role="button"],[aria-label],[title]'));
    var target = candidates.find(function(el) {
      if (!visible(el)) return false;
      var text = [el.getAttribute('aria-label'), el.getAttribute('title'), el.innerText, el.textContent]
        .filter(Boolean).join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      return terms.some(function(term) { return text.includes(term.normalize('NFD').replace(/[\u0300-\u036f]/g, '')); });
    });
    if (target) { target.click(); return { ok: true, clicked: true }; }
    return { ok: true, clicked: false };
  })()
`;

async function findFileInputNode(debuggerClient) {
  const flattened = await debuggerClient.sendCommand('DOM.getFlattenedDocument', { depth: -1, pierce: true });
  const candidates = [];
  for (const node of flattened?.nodes || []) {
    if (String(node.nodeName || '').toLowerCase() !== 'input') continue;
    const attrs = {};
    for (let index = 0; index < (node.attributes || []).length; index += 2) {
      attrs[String(node.attributes[index] || '').toLowerCase()] = String(node.attributes[index + 1] || '');
    }
    if (String(attrs.type || '').toLowerCase() !== 'file') continue;
    const accept = String(attrs.accept || '').toLowerCase();
    const score = accept.includes('video/') ? 100 : /\.mp4|\.mov|\.webm|video/.test(accept) ? 90 : (!accept || accept.includes('*/*')) ? 20 : -1;
    if (score >= 0) candidates.push({ nodeId: node.nodeId, score });
  }
  candidates.sort((left, right) => right.score - left.score);
  return candidates[0]?.nodeId || 0;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stageVideoWithDebugger(debuggerClient, videoPath, webContents = null) {
  const attachedHere = !debuggerClient.isAttached();
  try {
    if (attachedHere) debuggerClient.attach('1.3');
    await debuggerClient.sendCommand('DOM.enable');
    if (webContents && !webContents.isDestroyed()) {
      const opened = await webContents.executeJavaScript(OPEN_ATTACHMENT_EXPRESSION, true).catch(() => null);
      if (opened && opened.ok === false) return opened;
      if (opened?.clicked) await wait(450);
    }
    const flattenedNodeId = await findFileInputNode(debuggerClient).catch(() => 0);
    if (flattenedNodeId) {
      await debuggerClient.sendCommand('DOM.setFileInputFiles', { files: [videoPath], nodeId: flattenedNodeId });
      return { ok: true };
    }
    const evaluated = await debuggerClient.sendCommand('Runtime.evaluate', {
      expression: VIDEO_INPUT_EXPRESSION,
      objectGroup: 'nhayen-video-picker',
    });
    const objectId = evaluated?.result?.objectId;
    if (!objectId) return { ok: false, message: 'Không tìm thấy vùng đính kèm video. Hãy mở một hội thoại Zalo rồi thử lại.' };
    const requestedNode = await debuggerClient.sendCommand('DOM.requestNode', { objectId });
    if (!requestedNode?.nodeId) return { ok: false, message: 'Không truy cập được vùng đính kèm video của Zalo.' };
    await debuggerClient.sendCommand('DOM.setFileInputFiles', { files: [videoPath], nodeId: requestedNode.nodeId });
    await debuggerClient.sendCommand('Runtime.releaseObjectGroup', { objectGroup: 'nhayen-video-picker' }).catch(() => {});
    return { ok: true };
  } catch (error) {
    return { ok: false, message: `Không thể đính kèm video: ${error.message || String(error)}` };
  } finally {
    if (debuggerClient.isAttached()) {
      await debuggerClient.sendCommand('Runtime.releaseObjectGroup', { objectGroup: 'nhayen-video-picker' }).catch(() => {});
    }
    if (attachedHere && debuggerClient.isAttached()) debuggerClient.detach();
  }
}

module.exports = { isSupportedVideoPath, stageVideoWithDebugger };
