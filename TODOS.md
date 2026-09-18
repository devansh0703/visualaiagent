# TODOS

## Distribution
- **Chrome Web Store listing** — **Priority:** P2
  Package a store zip (manifest, `_locales/`, `background/`, `content/`,
  `offscreen/`, `icons/`, `ui/`, `shared/`), write the privacy-policy page,
  and submit for review. The tag-driven release workflow already attaches a
  packaged zip to GitHub releases.

## Vision
- **NVIDIA model auto-discovery** — **Priority:** P3
  If NIM's `/models` response ever adds `input_modalities`, add `nvidia` to
  `DISCOVERABLE` in `background/vision.js` so `vision.autoModel` can pick the
  smallest vision model automatically (see the comment there).

## Completed
