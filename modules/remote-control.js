const crypto = require("node:crypto");
const http = require("node:http");
const { WebSocketServer } = require("ws");

const ALLOWED_REMOTE_ACTIONS = new Set([
  "zalo-users",
  "zalo-groups",
  "personal-messages",
  "group-messages",
  "quick-replies",
  "remote-status",
]);

const SIGNAL_LIMITS = Object.freeze({ sdp: 96 * 1024, candidate: 16 * 1024 });

function validateSignalPayload(payload, role) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  if (
    payload.type === "offer" &&
    role === "host" &&
    typeof payload.sdp === "string" &&
    payload.sdp.length > 0 &&
    payload.sdp.length <= SIGNAL_LIMITS.sdp
  ) {
    return { type: "offer", sdp: payload.sdp };
  }
  if (
    payload.type === "answer" &&
    role === "controller" &&
    typeof payload.sdp === "string" &&
    payload.sdp.length > 0 &&
    payload.sdp.length <= SIGNAL_LIMITS.sdp
  ) {
    return { type: "answer", sdp: payload.sdp };
  }
  if (
    payload.type === "ice" &&
    payload.candidate &&
    typeof payload.candidate === "object"
  ) {
    const serialized = JSON.stringify(payload.candidate);
    if (serialized.length <= SIGNAL_LIMITS.candidate)
      return { type: "ice", candidate: payload.candidate };
  }
  if (payload.type === "quality" && role === "controller") {
    const bitrate = Math.round(Number(payload.bitrate));
    const frameRate = Math.round(Number(payload.frameRate));
    if (Number.isFinite(bitrate) && Number.isFinite(frameRate)) {
      return {
        type: "quality",
        bitrate: Math.max(150000, Math.min(8000000, bitrate)),
        frameRate: Math.max(8, Math.min(30, frameRate)),
      };
    }
  }
  return null;
}

function normalizeRemoteInput(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const x = Number(payload.x);
  const y = Number(payload.y);
  const hasPoint = Number.isFinite(x) && Number.isFinite(y);
  const point = hasPoint
    ? { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }
    : null;
  if (
    payload.kind === "mouse" &&
    point &&
    ["mouseDown", "mouseUp", "mouseMove"].includes(payload.type)
  ) {
    const normalized = { kind: "mouse", type: payload.type, ...point };
    if (payload.type !== "mouseMove")
      normalized.button = ["left", "right", "middle"].includes(payload.button)
        ? payload.button
        : "left";
    return normalized;
  }
  if (
    payload.kind === "wheel" &&
    point &&
    Number.isFinite(Number(payload.deltaY))
  ) {
    return {
      kind: "wheel",
      deltaY: Math.max(-500, Math.min(500, Number(payload.deltaY))),
      ...point,
    };
  }
  if (payload.kind === "text") {
    const text = String(payload.text || "")
      .slice(0, 4000)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
    return text ? { kind: "text", text } : null;
  }
  if (
    payload.kind === "key" &&
    ["ENTER", "BACKSPACE", "TAB", "ESCAPE", "DELETE"].includes(payload.key)
  )
    return { kind: "key", key: payload.key };
  return null;
}

function htmlPage(token) {
  const safeToken = JSON.stringify(token).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Nhà Yến Zalo Remote</title><style>*{box-sizing:border-box}body{margin:0;background:#111827;color:#eef2ff;font:14px system-ui;overflow:hidden}.bar{height:48px;display:flex;align-items:center;gap:10px;padding:0 14px;background:#fff;color:#172033}.logo{width:30px;height:30px;border-radius:7px;background:#1767d9;color:#fff;display:grid;place-items:center;font-weight:800}.status{margin-left:auto;color:#667085}.stage{height:calc(100vh - 102px);display:grid;place-items:center;background:#0b1020}video{display:block;max-width:100%;max-height:100%;width:100%;height:100%;object-fit:contain;outline:none;cursor:default}.controls{height:54px;display:flex;gap:8px;align-items:center;padding:8px;background:#fff;border-top:1px solid #dce2ea}input{flex:1;min-width:120px;height:38px;border:1px solid #cfd7e3;border-radius:8px;padding:0 10px}button{height:38px;border:1px solid #cfd7e3;border-radius:8px;background:#fff;color:#25324a;padding:0 14px;font-weight:650}button.primary{background:#1767d9;color:#fff;border-color:#1767d9}</style></head><body><header class="bar"><div class="logo">NY</div><strong>Nhà Yến Zalo Remote</strong><span id="s" class="status">Đang kết nối…</span></header><main class="stage"><video id="v" autoplay playsinline tabindex="0"></video></main><footer class="controls"><input id="text" placeholder="Nhập tiếng Việt rồi gửi"><button id="send" class="primary">Gửi chữ</button><button data-key="ENTER">Enter</button><button data-key="BACKSPACE">⌫</button></footer><script>const token=${safeToken},s=document.getElementById('s'),v=document.getElementById('v');let pc,dc,qualityTimer,bitrate=2500000,frameRate=30;const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/signal?token='+encodeURIComponent(token)+'&role=controller');function send(o){if(dc&&dc.readyState==='open')dc.send(JSON.stringify(o))}async function tune(){if(!pc||ws.readyState!==WebSocket.OPEN)return;let received=0,lost=0;(await pc.getStats()).forEach(r=>{if(r.type==='inbound-rtp'&&r.kind==='video'){received+=r.packetsReceived||0;lost+=r.packetsLost||0}});const loss=lost/Math.max(1,received+lost);if(loss>.08){bitrate=Math.max(350000,Math.round(bitrate*.7));frameRate=Math.max(12,frameRate-6)}else if(loss<.02){bitrate=Math.min(5000000,Math.round(bitrate*1.15));frameRate=Math.min(30,frameRate+2)}ws.send(JSON.stringify({type:'quality',bitrate,frameRate}))}ws.onmessage=async e=>{const m=JSON.parse(e.data);if(m.type==='offer'){if(pc)pc.close();clearInterval(qualityTimer);pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.cloudflare.com:3478'}]});pc.ontrack=e=>{v.srcObject=e.streams[0];s.textContent='Đã kết nối';qualityTimer=setInterval(tune,3000)};pc.ondatachannel=e=>{dc=e.channel;dc.onopen=()=>s.textContent='Điều khiển sẵn sàng';dc.onclose=()=>s.textContent='Mất kênh điều khiển'};pc.onicecandidate=e=>e.candidate&&ws.send(JSON.stringify({type:'ice',candidate:e.candidate}));await pc.setRemoteDescription(m);const a=await pc.createAnswer();await pc.setLocalDescription(a);ws.send(JSON.stringify({type:'answer',sdp:a.sdp}))}else if(m.type==='ice'&&pc)try{await pc.addIceCandidate(m.candidate)}catch{}};ws.onclose=()=>{clearInterval(qualityTimer);s.textContent='Mất kết nối'};function point(e){const r=v.getBoundingClientRect(),vw=v.videoWidth||r.width,vh=v.videoHeight||r.height,scale=Math.min(r.width/vw,r.height/vh),w=vw*scale,h=vh*scale,left=r.left+(r.width-w)/2,top=r.top+(r.height-h)/2;return{x:Math.max(0,Math.min(1,(e.clientX-left)/w)),y:Math.max(0,Math.min(1,(e.clientY-top)/h))}}let down=false,last=0;v.onpointerdown=e=>{down=true;v.setPointerCapture(e.pointerId);send({kind:'mouse',type:'mouseDown',button:e.button===2?'right':'left',...point(e)})};v.onpointerup=e=>{down=false;send({kind:'mouse',type:'mouseUp',button:e.button===2?'right':'left',...point(e)})};v.onpointermove=e=>{const now=performance.now();if(now-last<25)return;last=now;send({kind:'mouse',type:'mouseMove',button:down?'left':'none',...point(e)})};v.oncontextmenu=e=>e.preventDefault();v.onwheel=e=>{e.preventDefault();send({kind:'wheel',deltaY:Math.max(-500,Math.min(500,e.deltaY)),...point(e)})};document.getElementById('send').onclick=()=>{const i=document.getElementById('text');if(i.value){send({kind:'text',text:i.value});i.value=''}};document.getElementById('text').onkeydown=e=>{if(e.key==='Enter')document.getElementById('send').click()};document.querySelectorAll('[data-key]').forEach(b=>b.onclick=()=>send({kind:'key',key:b.dataset.key}));</script></body></html>`;
}

function lanRemotePage(token) {
  return htmlPage(token)
    .replace('Nhà Yến Zalo Remote</strong>', 'Điều khiển Nhà Yến Zalo</strong><button id="fullscreen" type="button">Toàn màn hình</button>')
    .replace('let pc,dc,qualityTimer', 'let pc,dc,pointerDc,qualityTimer')
    .replace("function send(o){if(dc&&dc.readyState==='open')dc.send(JSON.stringify(o))}", "function send(o){const fast=o.kind==='mouse'&&o.type==='mouseMove'||o.kind==='wheel',channel=fast?pointerDc:dc;if(channel&&channel.readyState==='open'&&(!fast||channel.bufferedAmount<16384))channel.send(JSON.stringify(o))}")
    .replace("pc.ondatachannel=e=>{dc=e.channel;dc.onopen=()=>s.textContent='Điều khiển sẵn sàng';dc.onclose=()=>s.textContent='Mất kênh điều khiển'}", "pc.ondatachannel=e=>{const channel=e.channel;if(channel.label==='pointer')pointerDc=channel;else dc=channel;channel.onopen=()=>s.textContent='Điều khiển sẵn sàng';channel.onclose=()=>s.textContent='Mất kênh điều khiển'}")
    .replaceAll("{iceServers:[{urls:'stun:stun.cloudflare.com:3478'}]}", "{iceServers:[]}")
    .replace('</script></body>', "document.getElementById('fullscreen').onclick=()=>document.documentElement.requestFullscreen?.();</script></body>");
}

class RemoteControlService {
  constructor({ onAction }) {
    this.onAction = onAction;
    this.server = null;
    this.token = "";
    this.localUrl = "";
    this.signalServer = null;
    this.hostSocket = null;
    this.controllerSocket = null;
  }

  getState() {
    return {
      running: !!this.server?.listening,
      token: this.token,
      localUrl: this.localUrl,
    };
  }

  async start({ host = "127.0.0.1", port = 0 } = {}) {
    if (this.server?.listening) return this.getState();
    this.token = crypto.randomBytes(32).toString("base64url");
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.signalServer = new WebSocketServer({
      noServer: true,
      maxPayload: 128 * 1024,
    });
    this.server.on("upgrade", (req, socket, head) =>
      this.handleUpgrade(req, socket, head),
    );
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, resolve);
    });
    const address = this.server.address();
    this.localUrl = `http://${host}:${address.port}`;
    return this.getState();
  }

  async stop() {
    const server = this.server;
    this.server = null;
    this.token = "";
    this.localUrl = "";
    for (const socket of [this.hostSocket, this.controllerSocket]) {
      try {
        socket?.close(1001, "Remote stopped");
      } catch {}
    }
    this.hostSocket = null;
    this.controllerSocket = null;
    this.signalServer?.close();
    this.signalServer = null;
    if (server) await new Promise((resolve) => server.close(resolve));
    return this.getState();
  }

  authorized(req) {
    const value = String(req.headers.authorization || "");
    const supplied = value.startsWith("Bearer ") ? value.slice(7) : "";
    if (!supplied || !this.token || supplied.length !== this.token.length)
      return false;
    return crypto.timingSafeEqual(
      Buffer.from(supplied),
      Buffer.from(this.token),
    );
  }

  tokenMatches(supplied) {
    if (!supplied || !this.token || supplied.length !== this.token.length)
      return false;
    return crypto.timingSafeEqual(
      Buffer.from(supplied),
      Buffer.from(this.token),
    );
  }

  handleUpgrade(req, socket, head) {
    let parsed;
    try {
      parsed = new URL(req.url, "http://localhost");
    } catch {
      return socket.destroy();
    }
    const role = parsed.searchParams.get("role");
    const token = parsed.searchParams.get("token") || "";
    if (
      parsed.pathname !== "/signal" ||
      !this.tokenMatches(token) ||
      !["host", "controller"].includes(role)
    ) {
      this.signalServer.handleUpgrade(req, socket, head, (ws) =>
        ws.close(1008, "Unauthorized"),
      );
      return;
    }
    if (
      (role === "host" && this.hostSocket) ||
      (role === "controller" && this.controllerSocket)
    ) {
      this.signalServer.handleUpgrade(req, socket, head, (ws) =>
        ws.close(1013, "Session already connected"),
      );
      return;
    }
    this.signalServer.handleUpgrade(req, socket, head, (ws) => {
      if (role === "host") this.hostSocket = ws;
      else this.controllerSocket = ws;
      ws.on("message", (data, isBinary) => {
        if (isBinary || data.length > 128 * 1024)
          return ws.close(1009, "Message too large");
        let payload;
        try {
          payload = JSON.parse(String(data));
        } catch {
          return;
        }
        payload = validateSignalPayload(payload, role);
        if (!payload) return;
        const peer = role === "host" ? this.controllerSocket : this.hostSocket;
        if (peer?.readyState === 1) peer.send(JSON.stringify(payload));
      });
      ws.on("close", () => {
        if (role === "host" && this.hostSocket === ws) this.hostSocket = null;
        if (role === "controller" && this.controllerSocket === ws)
          this.controllerSocket = null;
      });
      const peer = role === "host" ? this.controllerSocket : this.hostSocket;
      if (peer?.readyState === 1) peer.send(JSON.stringify({ type: "ready" }));
      ws.send(JSON.stringify({ type: "ready" }));
    });
  }

  handle(req, res) {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-store");
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    );
    if (req.method === "GET" && req.url?.startsWith("/?token=")) {
      const supplied =
        new URL(req.url, "http://localhost").searchParams.get("token") || "";
      if (!this.tokenMatches(supplied))
        return this.json(res, 401, { ok: false });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(lanRemotePage(this.token));
    }
    if (req.method === "GET" && req.url === "/api/status") {
      if (!this.authorized(req)) return this.json(res, 401, { ok: false });
      return this.json(res, 200, { ok: true, running: true });
    }
    if (req.method === "POST" && req.url === "/api/action") {
      if (!this.authorized(req)) return this.json(res, 401, { ok: false });
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 4096) req.destroy();
      });
      return req.on("end", async () => {
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          return this.json(res, 400, { ok: false });
        }
        if (!ALLOWED_REMOTE_ACTIONS.has(payload.action))
          return this.json(res, 403, { ok: false });
        try {
          await this.onAction(payload.action);
          return this.json(res, 200, { ok: true });
        } catch {
          return this.json(res, 500, { ok: false });
        }
      });
    }
    return this.json(res, 404, { ok: false });
  }

  json(res, status, payload) {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(payload));
  }
}

module.exports = {
  RemoteControlService,
  ALLOWED_REMOTE_ACTIONS,
  normalizeRemoteInput,
  validateSignalPayload,
};
