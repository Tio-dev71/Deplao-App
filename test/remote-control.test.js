const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');

const { RemoteControlService, ALLOWED_REMOTE_ACTIONS, normalizeRemoteInput, validateSignalPayload } = require('../modules/remote-control');

test('remote input validation clamps coordinates and rejects unsupported input', () => {
  assert.deepEqual(normalizeRemoteInput({ kind: 'mouse', type: 'mouseMove', x: 2, y: -1, button: 'bad' }), { kind: 'mouse', type: 'mouseMove', x: 1, y: 0 });
  assert.deepEqual(normalizeRemoteInput({ kind: 'wheel', x: 0.5, y: 0.25, deltaY: 9000 }), { kind: 'wheel', deltaY: 500, x: 0.5, y: 0.25 });
  assert.deepEqual(normalizeRemoteInput({ kind: 'text', text: 'xin\u0000 chào' }), { kind: 'text', text: 'xin chào' });
  assert.equal(normalizeRemoteInput({ kind: 'mouse', type: 'mouseMove', x: 'no', y: 0 }), null);
  assert.equal(normalizeRemoteInput({ kind: 'key', key: 'F12' }), null);
});

test('signaling validation enforces peer roles and adaptive quality limits', () => {
  assert.deepEqual(validateSignalPayload({ type: 'offer', sdp: 'v=0' }, 'host'), { type: 'offer', sdp: 'v=0' });
  assert.equal(validateSignalPayload({ type: 'offer', sdp: 'v=0' }, 'controller'), null);
  assert.equal(validateSignalPayload({ type: 'answer', sdp: 'v=0' }, 'host'), null);
  assert.deepEqual(validateSignalPayload({ type: 'quality', bitrate: 99999999, frameRate: 90 }, 'controller'), { type: 'quality', bitrate: 8000000, frameRate: 30 });
});

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end(options.body || '');
  });
}

test('remote control accepts only a random bearer token and whitelisted app actions', async () => {
  const calls = [];
  const service = new RemoteControlService({ onAction: (action) => calls.push(action) });
  const state = await service.start({ host: '127.0.0.1', port: 0 });
  assert.ok(state.token.length >= 32);
  assert.deepEqual([...ALLOWED_REMOTE_ACTIONS].sort(), ['group-messages', 'personal-messages', 'quick-replies', 'remote-status', 'zalo-groups', 'zalo-users'].sort());

  const denied = await request(`${state.localUrl}/api/action`, { method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: '{"action":"zalo-groups"}' });
  assert.equal(denied.status, 401);
  const forbidden = await request(`${state.localUrl}/api/action`, { method: 'POST', headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' }, body: '{"action":"shell"}' });
  assert.equal(forbidden.status, 403);
  const allowed = await request(`${state.localUrl}/api/action`, { method: 'POST', headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' }, body: '{"action":"zalo-groups"}' });
  assert.equal(allowed.status, 200);
  assert.deepEqual(calls, ['zalo-groups']);
  await service.stop();
});

test('stopping remote invalidates the token and closes the listening server', async () => {
  const service = new RemoteControlService({ onAction: () => {} });
  const state = await service.start({ host: '127.0.0.1', port: 0 });
  await service.stop();
  await assert.rejects(request(`${state.localUrl}/api/status`));
  assert.equal(service.getState().running, false);
  assert.equal(service.getState().token, '');
});

test('LAN remote page exposes full-screen control and separate reliable and pointer channels', async () => {
  const service = new RemoteControlService({ onAction: () => {} });
  const state = await service.start({ host: '127.0.0.1', port: 0 });
  const page = await request(`${state.localUrl}/?token=${encodeURIComponent(state.token)}`);
  assert.equal(page.status, 200);
  assert.match(page.body, /requestFullscreen/);
  assert.match(page.body, /channel\.label===['"]pointer['"]/);
  assert.match(page.body, /bufferedAmount/);
  assert.match(page.body, /Điều khiển Nhà Yến Zalo/);
  assert.doesNotMatch(page.body, /stun:|turn:/);
  await service.stop();
});

test('signaling websocket rejects invalid tokens and relays only between one host and one controller', async () => {
  const service = new RemoteControlService({ onAction: () => {} });
  const state = await service.start({ host: '127.0.0.1', port: 0 });
  const wsBase = state.localUrl.replace('http://', 'ws://');
  const denied = new WebSocket(`${wsBase}/signal?token=wrong&role=controller`);
  const deniedCode = await new Promise((resolve) => denied.on('close', resolve));
  assert.equal(deniedCode, 1008);

  const host = new WebSocket(`${wsBase}/signal?token=${state.token}&role=host`);
  const controller = new WebSocket(`${wsBase}/signal?token=${state.token}&role=controller`);
  await Promise.all([host, controller].map((socket) => new Promise((resolve) => socket.once('open', resolve))));
  const message = new Promise((resolve) => host.once('message', (data) => resolve(JSON.parse(String(data)))));
  controller.send(JSON.stringify({ type: 'answer', sdp: 'safe-sdp' }));
  assert.deepEqual(await message, { type: 'answer', sdp: 'safe-sdp' });
  host.close(); controller.close();
  await service.stop();
});
