// Giải mã ảnh bằng chính Chromium rồi mã hóa lại thành PNG thật.
// nativeImage của Electron không đọc được WebP nên phải nhờ renderer:
// atob -> Blob -> createImageBitmap -> OffscreenCanvas -> convertToBlob('image/png').
const path = require('path');
const fs = require('fs');
const {
  sniffImageFormat,
  imageMimeType,
  isSupportedSourceFormat,
  buildPngTargetPath,
} = require('./quick-reply-image');

const TRANSCODE_TIMEOUT_MS = 20_000;

let transcoderWindow = null;
let transcoderReady = null;
let transcodeQueue = Promise.resolve();

// Script chạy trong renderer: không fetch, không mạng, chỉ decode trong bộ nhớ.
function buildTranscodeScript(base64, mimeType) {
  return `(async () => {
  const binary = atob(${JSON.stringify(base64)});
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const blob = new Blob([bytes], { type: ${JSON.stringify(mimeType)} });
  const bitmap = await createImageBitmap(blob);
  const width = bitmap.width;
  const height = bitmap.height;
  if (!width || !height) throw new Error('Ảnh giải mã ra kích thước 0');
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Không đọc được PNG vừa mã hóa'));
    reader.readAsDataURL(pngBlob);
  });
  return { width, height, base64: dataUrl.slice(dataUrl.indexOf(',') + 1) };
})()`;
}

function getTranscoderWindow(BrowserWindow) {
  if (transcoderWindow && !transcoderWindow.isDestroyed()) return transcoderReady.then(() => transcoderWindow);
  transcoderWindow = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  transcoderWindow.on('closed', () => { transcoderWindow = null; transcoderReady = null; });
  transcoderReady = transcoderWindow.loadURL('about:blank');
  return transcoderReady.then(() => transcoderWindow);
}

function destroyTranscoderWindow() {
  if (transcoderWindow && !transcoderWindow.isDestroyed()) transcoderWindow.destroy();
  transcoderWindow = null;
  transcoderReady = null;
}

// Nhận Buffer bất kỳ định dạng Chromium đọc được -> trả về Buffer PNG thật.
function transcodeBufferToPng(BrowserWindow, buffer) {
  const format = sniffImageFormat(buffer);
  if (!isSupportedSourceFormat(format)) {
    return Promise.reject(new Error(`Định dạng ảnh không hỗ trợ: ${format || 'không nhận dạng được'}`));
  }
  const run = async () => {
    const win = await getTranscoderWindow(BrowserWindow);
    const script = buildTranscodeScript(buffer.toString('base64'), imageMimeType(format));
    const result = await Promise.race([
      win.webContents.executeJavaScript(script, true),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Hết thời gian chuyển ảnh sang PNG')), TRANSCODE_TIMEOUT_MS)),
    ]);
    const png = Buffer.from(String(result?.base64 || ''), 'base64');
    if (!png.length || sniffImageFormat(png) !== 'png') throw new Error('Kết quả chuyển đổi không phải PNG');
    return { buffer: png, width: Number(result?.width) || 0, height: Number(result?.height) || 0, sourceFormat: format };
  };
  // Nối tiếp từng ảnh để một cửa sổ ẩn không bị bơm hàng chục MB base64 cùng lúc.
  const chained = transcodeQueue.then(run, run);
  transcodeQueue = chained.catch(() => {});
  return chained;
}

// Ghi PNG ra đích an toàn: không bao giờ ghi đè chính file nguồn vừa giải mã.
async function convertFileToPng(BrowserWindow, sourcePath, options = {}) {
  const buffer = await fs.promises.readFile(sourcePath);
  const format = sniffImageFormat(buffer);
  if (format === 'png' && options.skipIfAlreadyPng !== false) {
    return { changed: false, format, targetPath: path.resolve(sourcePath) };
  }
  const { buffer: png, width, height } = await transcodeBufferToPng(BrowserWindow, buffer);
  const targetPath = options.targetPath
    ? path.resolve(options.targetPath)
    : buildPngTargetPath(sourcePath, (candidate) => fs.existsSync(candidate));
  await fs.promises.writeFile(targetPath, png);
  return { changed: true, format, targetPath, width, height, bytes: png.length };
}

module.exports = {
  buildTranscodeScript,
  transcodeBufferToPng,
  convertFileToPng,
  destroyTranscoderWindow,
  TRANSCODE_TIMEOUT_MS,
};
