// Tạo thumbnail PNG thật + đọc thời lượng video bằng chính Chromium.
// Cùng cách làm với image-transcoder: mở một cửa sổ ẩn, nạp video từ file://,
// tua tới một mốc nhỏ rồi vẽ khung hình ra OffscreenCanvas -> PNG.
// Không gọi mạng, không phụ thuộc ffmpeg.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const THUMBNAIL_TIMEOUT_MS = 20_000;
const THUMBNAIL_MAX_EDGE = 320;

let thumbnailWindow = null;
let thumbnailReady = null;
let thumbnailQueue = Promise.resolve();

function buildThumbnailScript(fileUrl, maxEdge) {
  return `(async () => {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = ${JSON.stringify(fileUrl)};

  const ready = new Promise((resolve, reject) => {
    video.onloadeddata = () => resolve();
    video.onerror = () => reject(new Error('Chromium không đọc được video này'));
  });
  await ready;

  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) throw new Error('Video không có khung hình để lấy ảnh nền');

  // Tua tới 1s (hoặc giữa video nếu ngắn hơn) để tránh khung đen đầu video.
  const seekTo = duration > 2 ? 1 : duration / 2;
  if (seekTo > 0) {
    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      video.onseeked = done;
      video.currentTime = seekTo;
      setTimeout(done, 3000);
    });
  }

  const scale = Math.min(1, ${maxEdge} / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const canvas = new OffscreenCanvas(targetWidth, targetHeight);
  const context = canvas.getContext('2d');
  context.drawImage(video, 0, 0, targetWidth, targetHeight);
  const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Không đọc được PNG vừa tạo'));
    reader.readAsDataURL(pngBlob);
  });

  video.src = '';
  return { dataUrl, duration, width, height };
})()`;
}

function ensureThumbnailWindow(BrowserWindow) {
  if (thumbnailWindow && !thumbnailWindow.isDestroyed()) return thumbnailReady;
  thumbnailWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      offscreen: true,
      // Cần đọc file:// của video trong kho media.
      webSecurity: false,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  thumbnailReady = thumbnailWindow.loadURL('about:blank');
  return thumbnailReady;
}

function destroyThumbnailWindow() {
  if (thumbnailWindow && !thumbnailWindow.isDestroyed()) thumbnailWindow.destroy();
  thumbnailWindow = null;
  thumbnailReady = null;
}

// Trả về { ok, thumbnailPath, duration, width, height } hoặc { ok:false, message }.
// Thất bại KHÔNG được làm hỏng việc thêm video: gọi bên ngoài vẫn tiếp tục, chỉ là không có ảnh nền.
function generateVideoThumbnail(BrowserWindow, videoPath, thumbnailPath, { maxEdge = THUMBNAIL_MAX_EDGE, timeoutMs = THUMBNAIL_TIMEOUT_MS } = {}) {
  const run = async () => {
    if (!fs.existsSync(videoPath)) return { ok: false, message: 'Video không còn tồn tại.' };
    try {
      await ensureThumbnailWindow(BrowserWindow);
      const script = buildThumbnailScript(pathToFileURL(videoPath).href, maxEdge);
      const result = await Promise.race([
        thumbnailWindow.webContents.executeJavaScript(script, true),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Quá thời gian tạo ảnh nền video')), timeoutMs)),
      ]);
      const dataUrl = String(result && result.dataUrl || '');
      const base64 = dataUrl.startsWith('data:image/png;base64,') ? dataUrl.slice('data:image/png;base64,'.length) : '';
      if (!base64) return { ok: false, message: 'Không tạo được ảnh nền PNG.' };
      fs.mkdirSync(path.dirname(thumbnailPath), { recursive: true });
      fs.writeFileSync(thumbnailPath, Buffer.from(base64, 'base64'));
      return {
        ok: true,
        thumbnailPath,
        duration: Number(result.duration) || 0,
        width: Number(result.width) || 0,
        height: Number(result.height) || 0,
      };
    } catch (error) {
      return { ok: false, message: error && error.message ? error.message : String(error) };
    }
  };
  // Nối tiếp để không mở nhiều video cùng lúc trong một cửa sổ.
  thumbnailQueue = thumbnailQueue.then(run, run);
  return thumbnailQueue;
}

module.exports = {
  THUMBNAIL_TIMEOUT_MS,
  THUMBNAIL_MAX_EDGE,
  buildThumbnailScript,
  generateVideoThumbnail,
  destroyThumbnailWindow,
};
