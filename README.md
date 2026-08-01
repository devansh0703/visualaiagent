# Visual AI Agent (VAIA)

A Manifest V3 Chrome extension that **watches the browser screen and every user
interaction, analyzes it with a vision AI model, and streams structured
telemetry to your own database** (SQLite, Postgres, ClickHouse — anything with
an HTTP endpoint).

It combines the strengths of existing visual AI agents (OpenAI Operator,
Anthropic computer use, Gemini, browser-use, Microsoft Clarity, Hotjar) into a
single, local-first, privacy-respecting extension you fully control.

---

## Features

### Full activity tracking
- Mouse: move, down/up, click/double/right-click, drag, wheel, touch
- Keyboard: key up/down (keystrokes redacted), text input (values masked on
  sensitive fields), paste/copy/cut
- Page lifecycle: views, navigation, tab events, file downloads, form submits
- Errors: unhandled errors & rejections, console errors, network failures
- SPA-safe: URL-change detection without reloads

### Computer-vision screen intelligence
- Captures the visible tab, re-encodes it through an offscreen document, and
  sends it to a vision model for scene analysis (what's on screen, likely user
  intent, UI issues)
- Providers: **OpenAI**, **Anthropic**, **Gemini**, **OpenRouter**, **Ollama**
  (local), plus an offline **mock** provider for development
- Capture triggers: periodic, on significant events (click/nav/error), manual

### Insights (heuristic + LLM)
- Rage clicks, dead clicks, rapid navigation, error spikes, form abandonment
- End-of-session LLM summaries
- Live heatmap overlay (clicks / mouse movement) rendered in the page

### Local-first database sync
- Every event is stored in IndexedDB first — the DB is an offline outbound
  queue, so nothing is lost when offline
- Batched POSTs with retry, exponential backoff, and per-record dedup
- Events, screenshots, and insights each flush to configurable endpoints

### Privacy by design
- Sensitive-field masking, keystroke redaction, URL query-stripping
- Deny/allow host lists; screenshots dropped on sensitive pages
- Retention cleanup, "clear data", full JSON export
- Everything is self-hosted — telemetry never touches a third-party cloud

---

## Install (dev)

1. `npm install` (only needed for E2E tests / icon generation)
2. `npm run icons` to generate icon PNGs
3. Open `chrome://extensions`, enable **Developer mode**, **Load unpacked**,
   select this folder
4. Optionally start the bundled receiver: `npm run server` (serves
   `http://localhost:8787`, writes to `data/telemetry.db`)

Open the popup, set your **database endpoint** and **vision provider keys** in
Options, and load any page — the dashboard (`VAIA Dashboard` button) shows the
live feed, sessions, frame replay, insights, and heatmaps.

## Configuration

See `shared/config.js` for defaults. Key sections (editable in Options):

| Key | Purpose |
| --- | --- |
| `enabled` | Master tracking switch |
| `tracking.*` | Toggle mouse/keyboard/scroll/navigation/errors |
| `capture.enabled` | Screen capture on/off; interval, quality, maxWidth |
| `capture.storeLocal` | Keep frames locally for replay (default on) |
| `vision.provider` | `openai` / `anthropic` / `gemini` / `openrouter` / `ollama` / `mock` |
| `vision.apiKey` | Provider key (stored in `chrome.storage.local`) |
| `db.endpoint` | Receiver URL for events (e.g. `http://localhost:8787/api/events`) |
| `db.sendEvents` / `sendScreenshots` / `sendInsights` | Per-channel sync toggles |
| `db.flushIntervalMs` | Auto-flush interval (default 5s) |
| `privacy.redactKeystrokeValues` | Drop typed values entirely (default on) |
| `hosts.denylist` / `allowlist` | Skip sensitive hosts / restrict tracking |

## Receiver API

The bundled `server/server.mjs` (Node 24 `node:sqlite`) implements the wire
format used by the extension:

| Endpoint | Method | Body |
| --- | --- | --- |
| `/api/events` | POST | `{ kind:'events', deviceId, userId, events:[...] }` |
| `/api/screenshots` | POST | `{ kind:'screenshots', screenshots:[...] }` |
| `/api/insights` | POST | `{ kind:'insights', insights:[...] }` |
| `/api/sessions` | POST | `{ kind:'sessions', sessions:[...] }` |
| `/api/events\|screenshots\|insights\|sessions` | GET | read back (limit/type/from/to) |
| `/api/stats` | GET | aggregated counts + event-type distribution |
| `/api/heatmap` | GET | click coordinates |
| `/demo` | GET | a small page for exercising the extension |
| `/health` | GET | liveness |

Any server that accepts these POSTs works — the schema is intentionally flat
and JSON-serializable.

## Architecture

```
content/content.js          activity tracker + heatmap overlay
content/element-tools.js    DOM attribution, xpath/css fingerprinting, a11y
content/privacy-scan.js     sensitive-field detection (WeakSet-cached)
background/service-worker.js orchestrator: routing, sessions, tabs, flushing
background/capture.js       capture pipeline (offscreen re-encode)
background/vision.js        6 vision providers + offline mock
background/insights.js      heuristic detectors + LLM summaries
background/db.js            IndexedDB outbound queue, retry/backoff/dedup
background/idb.js           IndexedDB store layer (also offline archive)
offscreen/processor.js      screenshot downscale/re-encode (BLOBS reason)
ui/popup|options|dashboard  control panel, settings, live telemetry UI
server/server.mjs           reference receiver (node:sqlite)
shared/                     config + protocol constants + utils
```

Content scripts are classic scripts (no ES imports); background/UI are ES
modules. Tracking is local-first: content → port → SW → IndexedDB → batched
HTTP.

## Testing

```bash
npm test      # 36 unit tests (config, utils, element-tools, session, insights, vision, db)
npm run e2e   # loads the real extension in headless Chrome (puppeteer-core +
              #   system Chrome), drives the /demo page, and verifies tracking,
              #   redaction, capture, vision, and the full receiver round-trip
```

E2E uses Chrome 137+ `Extensions.loadUnpacked` via puppeteer's
`installExtension()` because branded Chrome builds removed `--load-extension`.

## Privacy notes

- Typed values are masked on password/credit-card fields by default
- Captures and keystrokes are never sent to third parties; the receiver is
  yours
- The mock vision provider lets you run entirely offline
