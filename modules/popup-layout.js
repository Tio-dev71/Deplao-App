// Hình học popup không-che-Zalo.
// BrowserView (Zalo) là lớp native nằm đè lên HTML, nên popup chỉ hiện được ở vùng
// mà BrowserView KHÔNG phủ. Vì BrowserView là một hình chữ nhật duy nhất, popup phải
// "neo" vào một cạnh để phần còn lại của Zalo vẫn là hình chữ nhật hợp lệ.
const MIN_VIEW_WIDTH = 360;

// Trả về { viewX, viewWidth } của Zalo sau khi trừ các cột đã bị popup/bảng phụ chiếm.
function computeViewGeometry({ contentWidth, sidebarWidth, utilityWidth = 0, popupWidth = 0, minViewWidth = MIN_VIEW_WIDTH } = {}) {
  const width = Number(contentWidth) || 0;
  const sidebar = Math.max(0, Number(sidebarWidth) || 0);
  const available = Math.max(0, width - sidebar);
  let reserved = Math.max(0, Number(utilityWidth) || 0) + Math.max(0, Number(popupWidth) || 0);
  const keepAtLeast = Math.min(available, Math.max(0, Number(minViewWidth) || 0));
  if (available - reserved < keepAtLeast) reserved = Math.max(0, available - keepAtLeast);
  const viewWidth = Math.max(0, available - reserved);
  return { viewX: sidebar, viewWidth, reserved, popupOffsetX: sidebar + viewWidth };
}

// Kéo rộng/Hẹp popup bằng chuột, giới hạn để Zalo không bị ép biến mất.
function clampPopupWidth(requested, { contentWidth, sidebarWidth, utilityWidth = 0, minViewWidth = MIN_VIEW_WIDTH, maxPopupWidth = 620 } = {}) {
  const available = Math.max(0, (Number(contentWidth) || 0) - (Number(sidebarWidth) || 0));
  const keepAtLeast = Math.min(available, Math.max(0, Number(minViewWidth) || 0));
  const ceiling = Math.min(Math.max(0, Number(maxPopupWidth) || 0), Math.max(0, available - keepAtLeast - (Number(utilityWidth) || 0)));
  return Math.max(0, Math.min(Math.round(Number(requested) || 0), ceiling));
}

module.exports = { computeViewGeometry, clampPopupWidth, MIN_VIEW_WIDTH };
