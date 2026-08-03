# VAIA — Demo

Visual AI Agent demo assets. Captured from the E2E run
(`npm run e2e`) against the local receiver server (`npm run server`),
with the extension loaded in headless Chrome.

## Dashboard (neobrutalist UI)

| file | shows |
|------|-------|
| `dash-today.png` | Today tab — stat blocks, ranked time-on-sites, focus histogram, distraction budget meter |
| `dash-events.png` | Events tab — neobrutalist event log table with type chips |
| `dash-insights.png` | Insights tab — color-coded insight cards |
| `dash-agent.png` | Agent tab — chat turns, ability runs, page reports, task transcripts |
| `dash-sessions.png` | Sessions tab — session list with duration, events, errors, rage clicks, focus % |
| `dash-screenshots.png` | Screenshots tab — captured frames grid served at `/shots/<file>` |
| `dash-heatmap.png` | Heatmap tab — click/mouse-down density hotspots from the last 500 points |

## Captured activity

`*.jpg` — raw screenshots the extension captured during the demo session
(demo page, rage clicks, capture requests). Served live by the server at
`/shots/<file>` and browsable in the dashboard's Screenshots tab.

## How to see it live

```bash
npm install
npm run server
# open http://localhost:8791/  (or the port printed on startup)
```

Then load the extension from this repo (`Load unpacked` in
`chrome://extensions`) and visit `http://localhost:8791/demo`.

## Regenerating

The E2E test wipes `data/telemetry.db` and rebuilds it from scratch on every
run. To refresh the dashboard screenshots with a self-contained (non-E2E)
seed, run:

```bash
npm install
npm run demo:capture
```

This starts a fresh receiver on port 8792, seeds realistic telemetry
(sessions, attention timeline, heatmap clicks, screenshots, heuristic +
agent insights), screenshots all seven dashboard tabs, and writes
`demo/dash-*.png`.
