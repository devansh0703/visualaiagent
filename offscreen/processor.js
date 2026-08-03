/**
 * offscreen/processor.js — runs inside the MV3 offscreen document.
 * Receives { type:'vaia:process_image', id, dataUrl, maxWidth, quality }
 * and replies with a downscaled JPEG data URL.
 */
let busy = false;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'vaia:crop_image') {
    cropImage(msg)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: String(err) }));
    return true; // async
  }
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

/**
 * Zoom-style region inspect: crop [x, y, w, h] out of a full screenshot and
 * return it at native resolution (the computer_20251124 `zoom` equivalent).
 */
async function cropImage({ id, dataUrl, x, y, w, h }) {
  const img = await loadImage(dataUrl);
  const rx = Math.max(0, Math.min(img.naturalWidth, Number(x) || 0));
  const ry = Math.max(0, Math.min(img.naturalHeight, Number(y) || 0));
  const rw = Math.min(img.naturalWidth - rx, Math.max(1, Number(w) || 0));
  const rh = Math.min(img.naturalHeight - ry, Math.max(1, Number(h) || 0));
  const canvas = document.createElement('canvas');
  canvas.width = rw;
  canvas.height = rh;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, rx, ry, rw, rh, 0, 0, rw, rh);
  return { id, dataUrl: canvas.toDataURL('image/jpeg', 90), width: rw, height: rh, region: { x: rx, y: ry, w: rw, h: rh }, mime: 'image/jpeg' };
}

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
  return { id, dataUrl: out, width: w, height: h, mime: 'image/jpeg', phash: diffHash(canvas) };
}

/**
 * 64-bit difference hash: downscale to 9x8 grayscale and compare horizontal
 * neighbours. Robust to encoding noise, sensitive to real layout changes.
 */
function diffHash(canvas) {
  const gw = 9;
  const gh = 8;
  const c = document.createElement('canvas');
  c.width = gw;
  c.height = gh;
  const ctx = c.getContext('2d');
  ctx.drawImage(canvas, 0, 0, gw, gh);
  const data = ctx.getImageData(0, 0, gw, gh).data;
  let bits = '';
  for (let y = 0; y < gh; y++) {
    const row = y * gw * 4;
    for (let x = 0; x < gw - 1; x++) {
      const a = data[row + x * 4] + data[row + x * 4 + 1] + data[row + x * 4 + 2];
      const b = data[row + (x + 1) * 4] + data[row + (x + 1) * 4 + 1] + data[row + (x + 1) * 4 + 2];
      bits += a > b ? '1' : '0';
    }
  }
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = dataUrl;
  });
}
