/**
 * pixels.js — coarse perceptual fingerprint of a screenshot, computed in the
 * service worker. Supports the `visual_check` ability's "before → act →
 * verify" loop (the visual-debugging equivalent of Claude Computer Use's
 * resize/repro/patch/verify workflow).
 *
 * The signature is an 8×8 grid of per-cell average luminance. It is deliberately
 * tiny, deterministic and dependency-free. When image decoding isn't available
 * (unit tests, some workers), imageSignature() returns null and callers degrade
 * gracefully instead of throwing.
 */
export const GRID = 8;

export async function imageSignature(dataUrl) {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return null;
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(GRID, GRID);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, GRID, GRID);
    const data = ctx.getImageData(0, 0, GRID, GRID).data;
    const cells = [];
    for (let i = 0; i < GRID * GRID; i++) {
      cells.push(Math.round((data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3));
    }
    if (bmp.close) bmp.close();
    return { cells, hash: cells.join(','), w: bmp.width, h: bmp.height };
  } catch {
    return null;
  }
}

export function pixelDiff(a, b) {
  const n = Math.min(a.cells.length, b.cells.length);
  let sum = 0;
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a.cells[i] - b.cells[i]);
    sum += d;
    if (d > 24) changed++;
  }
  return { score: n ? Math.round((sum / (n * 255)) * 10000) / 10000 : 0, changedCells: changed, cells: n };
}

/** Human description of where the image changed (3×3 zones). */
export function changedZones(a, b) {
  const rowZone = (row) => (row < Math.floor(GRID / 3) ? 'top' : row >= Math.ceil((2 * GRID) / 3) ? 'bottom' : 'center');
  const colZone = (col) => (col < Math.floor(GRID / 3) ? 'left' : col >= Math.ceil((2 * GRID) / 3) ? 'right' : 'center');
  const out = new Set();
  for (let i = 0; i < a.cells.length && i < b.cells.length; i++) {
    if (Math.abs(a.cells[i] - b.cells[i]) > 24) {
      const row = Math.floor(i / GRID);
      const col = i % GRID;
      const rz = rowZone(row);
      const cz = colZone(col);
      out.add(rz === 'center' && cz === 'center' ? 'center' : `${rz === 'center' ? '' : rz + '-'}${cz}`);
    }
  }
  return [...out];
}
