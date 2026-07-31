/**
 * offscreen/processor.js — runs inside the MV3 offscreen document.
 * Receives { type:'vaia:process_image', id, dataUrl, maxWidth, quality }
 * and replies with a downscaled JPEG data URL.
 */
let busy = false;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'vaia:process_image') return false;
  if (busy) {
    sendResponse({ error: 'busy' });
    return false;
  }
  busy = true;
  processImage(msg)
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ error: String(err) }))
    .finally(() => {
      busy = false;
    });
  return true; // async
});

async function processImage({ id, dataUrl, maxWidth, quality }) {
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, (maxWidth || 1280) / img.naturalWidth);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const out = canvas.toDataURL('image/jpeg', (quality || 60) / 100);
  return { id, dataUrl: out, width: w, height: h, mime: 'image/jpeg' };
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = dataUrl;
  });
}
