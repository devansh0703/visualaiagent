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
run, so these assets age out — re-run `npm run e2e` and re-capture
`dash-*.png` to refresh them.
