const test = require('node:test');
const assert = require('node:assert/strict');
const { isSupportedVideoPath, stageVideoWithDebugger } = require('../modules/video-staging');

test('video staging accepts approved formats and rejects unrelated files', () => {
  assert.equal(isSupportedVideoPath('clip.MP4'), true);
  assert.equal(isSupportedVideoPath('clip.webm'), true);
  assert.equal(isSupportedVideoPath('payload.exe'), false);
});

test('video staging selects the Zalo file input without issuing a send action', async () => {
  const commands = [];
  let attached = false;
  const debuggerClient = {
    isAttached: () => attached,
    attach: () => { attached = true; },
    detach: () => { attached = false; },
    sendCommand: async (name, params) => {
      commands.push({ name, params });
      if (name === 'Runtime.evaluate') return { result: { objectId: 'video-input' } };
      if (name === 'DOM.requestNode') return { nodeId: 42 };
      return {};
    },
  };

  const result = await stageVideoWithDebugger(debuggerClient, 'C:\\video\\demo.mp4');

  assert.deepEqual(result, { ok: true });
  assert.equal(attached, false);
  assert.deepEqual(commands.find((entry) => entry.name === 'DOM.setFileInputFiles').params, {
    files: ['C:\\video\\demo.mp4'],
    nodeId: 42,
  });
  assert.equal(commands.some((entry) => JSON.stringify(entry).includes('Enter')), false);
});

test('video staging detaches debugger after an attachment failure', async () => {
  let attached = false;
  const debuggerClient = {
    isAttached: () => attached,
    attach: () => { attached = true; },
    detach: () => { attached = false; },
    sendCommand: async (name) => {
      if (name === 'Runtime.evaluate') return { result: {} };
      return {};
    },
  };

  const result = await stageVideoWithDebugger(debuggerClient, 'C:\\video\\demo.mp4');

  assert.equal(result.ok, false);
  assert.match(result.message, /Không tìm thấy vùng đính kèm video/);
  assert.equal(attached, false);
});
