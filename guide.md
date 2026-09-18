# Visual AI Agent — Run Guide

Track any website's usage with the extension, pipe it into the local receiver,
and watch the analytics on the dashboard.

> Time to first dashboard: ~5 minutes. No API key required.

## 1. Prerequisites

- Node.js >= 22.5 (the receiver uses the built-in `node:sqlite`)
- Chrome >= 116
- Clone the repo, then:

```bash
npm install
```

## 2. Start the receiver (database + dashboard)

```bash
npm run server
```

- Dashboard: http://localhost:8787/
- Demo page (quick exercise page): http://localhost:8787/demo
- Change the port: `PORT=9000 npm run server`

Leave this terminal running.

## 3. Load the extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select this repo's root folder
4. The **Visual AI Agent** extension appears. It's now monitoring.

Keyboard shortcuts (can be remapped in `chrome://extensions/shortcuts`):

| Shortcut | Action |
|----------|--------|
| `Alt+Shift+P` | Pause / resume monitoring |
| `Alt+Shift+C` | Capture + analyze the current screen |
| `Alt+Shift+D` | Open the dashboard |

## 4. Point the extension at your database

Right-click the toolbar icon → **Options** → **Database** section:

- **Events endpoint**: `http://localhost:8787/api/events`
- Leave **Send events / Send screenshots / Send insights** checked (default)
- Click **Save settings**

Screenshots and insights are derived from this endpoint automatically
(`/api/screenshots`, `/api/insights`), so one field is all you need.

## 5. Browse a site, then open the analytics

1. Visit any website and use it normally (scroll, click, type, switch tabs).
   The extension logs activity and captures a screenshot every ~5s.
2. Press `Alt+Shift+D` or open http://localhost:8787/ and hit **REFRESH**.

Dashboard tabs:

| Tab | Shows |
|-----|-------|
| TODAY | Total events, time-on-sites, focus histogram, distraction budget |
| EVENTS | Live event log (clicks, scrolls, keypresses, errors, tab switches…) |
| INSIGHTS | Heuristic alerts (rage clicks, error spikes, form abandonment) |
| AGENT | AI agent runs: chat turns, page reports, task transcripts, ability runs |
| SESSIONS | Per-session duration, event counts, errors, rage clicks, focus % |
| SCREENSHOTS | Frames the extension captured, click to zoom |
| HEATMAP | Click/mouse-down density hotspots |

You can also check the raw counts directly: http://localhost:8787/api/stats
and export everything via **Export JSON / Export CSV** in the header.

## Optional: AI analysis

The extension works as pure telemetry out of the box. For the "visual AI" layer:

- **Mock provider (free, offline)** — open Options → **Vision**, pick provider
  `Mock / offline`, enable it. You can now chat with the agent and run
  abilities (page report, fill forms, click things, deep research) with no key.
- **Real model** — **NVIDIA NIM is the default provider**: paste your NVIDIA
  API key (`NVIDIA_API_KEY`, e.g. the one exported in your `~/.bashrc`) under
  Options → Vision → API key. Or pick OpenAI / Anthropic / Gemini / Groq /
  OpenRouter and paste their key (kept in `chrome.storage.local`, never logged
  or committed). Or use Ollama locally (no key).

## Privacy controls (Options → Privacy)

- Sensitive fields (passwords, cards, SSNs) are detected and redacted in typed
  values and screenshots automatically.
- Screenshots are **dropped on sensitive pages** by default.
- `denylistHosts` / `allowlistHosts` — never/only track certain sites.
- `dataRetentionDays` — auto-prune stored data.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Dashboard shows 0 events | Extension not configured: Options → Database → endpoint must be `http://localhost:8787/api/events`; then press `Alt+Shift+P` to ensure monitoring is running |
| No screenshots | The active tab must be visible (Chrome only captures visible tabs). `capture.onSignificantEvent` only fires after activity |
| Port already in use | `PORT=9000 npm run server`, then point the endpoint at `http://localhost:9000/api/events` |
| Nothing in AGENT/INSIGHTS tabs | These need AI: enable Vision in Options (Mock is fine) |
| `data/` looks big | That's the local SQLite DB + captured frames — it's gitignored and never pushed |

## Running the test suite

```bash
npm test                 # 140 unit tests
npm run test:integration # live provider tests (skips without NVIDIA_API_KEY
                         #   or GROQ_API_KEY)
npm run e2e              # headless-Chrome E2E: loads the extension, drives /demo,
                         # verifies events land in the database
```
