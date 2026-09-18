# Chrome Web Store Listing — Visual AI Agent

Everything a CWS submission needs, pre-assembled. Version and dates should be
refreshed on each store upload.

## Store metadata

- **Name:** Visual AI Agent — Screen Intelligence
- **Version:** 1.1.0 (keep in lockstep with manifest.json and package.json)
- **Category:** Developer Tools (alternative: Productivity)
- **Language:** English

**Short description (132 chars max):**

> Monitors browsing activity and screen, analyzes it with vision AI, and streams telemetry to your own local dashboard.

**Detailed description:**

> Visual AI Agent (VAIA) is a local-first screen-intelligence tool: it records
> what you do in the browser (pages, clicks, scrolls, typing events, errors),
> captures the visible tab, analyzes screenshots with the vision model YOU
> choose (NVIDIA NIM by default, plus OpenAI, Anthropic, Gemini, Groq,
> OpenRouter, Ollama, or a fully offline mock), and streams everything to a
> receiver and analytics dashboard that run on YOUR machine.
>
> • Attention analytics — time per site, focus score, distraction budget
> • Insight detectors — rage clicks, error spikes, form abandonment, rapid navigation
> • Agent abilities — 73 skills: page reports, form filling, UI validation, deep research with citations, memory, scheduled tasks, MCP tool servers
> • Chat — a multi-turn chatbot that can see the current tab
> • Privacy by design — sensitive fields masked, screenshots dropped on sensitive pages, host allow/denylists, retention pruning, and optional token auth on the receiver
>
> Your data never reaches the extension's publisher. Everything stays on your
> machine or on servers you explicitly point the extension at.

## Justifications (paste into the CWS permission review form)

**tabCapture / activeTab / tabs + host permissions (`<all_urls>`):**

> The core feature is screen analysis: the extension captures the visible tab
> on a user-configured interval or on user action, re-encodes the frame in an
> offscreen document, and (only when the user enables a vision provider)
> sends it to that provider for analysis. `<all_urls>` is required so the
> activity recorder and DOM-analysis helpers work on every site the user
> browses; the user can restrict this with the built-in allowlist/denylist.

**scripting:**

> Used to inject the content-script recorder (content/content.js) and
> DOM-analysis helpers (content/element-tools.js, content/privacy-scan.js)
> that detect clicks, scrolling, form fields, and sensitive inputs. The same
> injection powers the agent abilities (read page, fill forms, run checks).

**webNavigation:**

> Page-load and navigation detection drive sessions, time-on-site attention
> accounting, and the focus trend in the dashboard.

**alarms:**

> Schedules periodic captures, telemetry flushes, data-retention pruning, and
> user-scheduled agent tasks.

**notifications:**

> Shows desktop notifications produced by the agent (e.g. scheduled task
> results) at the user's request.

**downloads:**

> Saves files when the user invokes the agent's download ability.

**storage / unlimitedStorage:**

> Stores settings and the local offline archive of events and frames
> (IndexedDB). Frames accumulate between flushes; the archive is bounded by
> the user's dataRetentionDays setting.

**Remote code disclosure:** No remote code is executed. All extension code is
shipped in the package; the only remote calls are API requests to the
user-configured receiver and the user-selected vision provider.

**Single purpose:** local-first browser activity + screen telemetry with
user-configured AI analysis and a self-hosted analytics dashboard.

## Submission checklist

1. Zip the extension files only (the release workflow does this on `v*` tags):
   `manifest.json _locales/ background/ content/ offscreen/ icons/ ui/ shared/`
2. Publish `privacy-policy.html` (GitHub Pages is fine) and paste its URL into
   the CWS "Privacy policy" field.
3. Data-use disclosures: "personally identifiable information" = NO if you do
   not configure a user id; screenshots = check "Website content" handling and
   declare it is not sold and not used for unrelated purposes.
4. Store images: 128×128 icon (icons/icon128.png), 440×280 small tile, and at
   least one 1280×800 screenshot (use demo/dash-*.png as the source).
5. Distribute outside the store with the release zip (load unpacked).
