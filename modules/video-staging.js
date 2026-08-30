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

async function stageVideoWithDebugger(debuggerClient, videoPath) {
  const attachedHere = !debuggerClient.isAttached();
  try {
    if (attachedHere) debuggerClient.attach('1.3');
    await debuggerClient.sendCommand('DOM.enable');
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
