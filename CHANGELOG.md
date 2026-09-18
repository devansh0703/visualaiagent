# Changelog

All notable changes to this project are documented in this file.
Format based on Keep a Changelog; versions follow semver.

## [1.1.0] - 2026-09-19

The industrial-hardening release: the receiver can now be locked down, the
quality of vision output is measured (not assumed), and the store submission
kit exists.

### Added
- **Receiver token auth**: start the receiver with `VAIA_TOKEN=<secret>` and
  every `/api/*` and `/shots/*` request requires that token — via `x-api-key`
  (what the extension already sends), `Authorization: Bearer`, or `?token=`
  for `<img>`/download links. Timing-safe comparison, `401 + WWW-Authenticate`
  on rejection, `/health` reports `authRequired` so clients can adapt.
  `/health`, `/` and `/demo` stay open so the dashboard can prompt.
- **`VAIA_DATA_DIR`**: move the SQLite DB and screenshots out of the repo.
- **Dashboard auth flow**: prompts for the token once, remembers it in
  localStorage, sends `x-api-key` on every call, and re-prompts (throttled to
  once a minute) if the token is rejected. Screenshots, exports, and the
  heatmap now download through blob URLs so the token never appears in a URL,
  an `<img src>`, or a new tab.
- **Vision-quality eval harness** (`npm run evals`, `npm run evals:live`):
  an offline schema eval guarding the screen-report contract, plus live
  grounded image evals (solid-color PNGs with known ground truth) that assert
  the default model answers correctly — with no model fallbacks hiding a
  quality failure.
- **Chrome Web Store kit**: `privacy-policy.html` and `store/listing.md` with
  store copy and per-permission justifications.
- 4 unit tests covering the auth gate (transports, 401 shape, open shells,
  persistence behind auth); suite is now 144 tests.

### Changed
- Removed `meta/llama-3.2-90b-vision-instruct` from the NVIDIA fallback chain:
  it hangs indefinitely on some NIM accounts (measured: zero bytes in 150s
  while 11b answers in under 10s), so a fallback attempt would stall captures.
  It remains user-selectable.
- README and run guide document the auth setup and the eval harness.

### Fixed
- Test portability: the db-queue module mock no longer registers under a
  hardcoded home-directory path (worked on one machine, broke CI and fresh
  clones).

## [1.0.0] - 2026-09-18

First stable release: the full pipeline — tracking, capture, vision analysis,
agent abilities, receiver, and dashboard — verified end to end by 140 unit
tests, live provider integration tests, and a headless-Chrome E2E suite.

### Added
- **NVIDIA NIM vision provider** (`integrate.api.nvidia.com`, OpenAI-wire
  compatible) with `meta/llama-3.2-11b-vision-instruct` default and a 90b
  fallback, selectable in Options → Vision and wired through provider
  registration, default models, and the provider fallback chain.
- **Live integration tests for both NVIDIA NIM and Groq** — each skips
  cleanly without its API key, so CI can run them safely.
- **GitHub Actions CI** running unit, integration (key-optional), and E2E
  suites on every push and pull request to `main`.
- **Run guide** (`guide.md`): five minutes from clone to dashboard, no API key
  required.
- **UI documentation** covering popup, options, dashboard, and receiver, with
  dashboard tab screenshots embedded in the README.
- Unit test for the new default provider registration and model ordering.

### Changed
- **NVIDIA NIM is now the default vision provider** (was OpenAI); existing
  configs keep their saved provider.
- README and run guide updated for the 7-provider lineup, 140-test suite,
  and NVIDIA/Groq integration-key instructions.

### Fixed
- Groq default/fallback model corrected from `qwen/qwen3.6-27b` (not in
  Groq's live catalog; would 404 with autoModel off) to
  `qwen/qwen3.8-27b`.
- `package.json` version sync: `package-lock.json` now matches 1.0.0.

### Removed
- Dead `npm run icons` script pointing at the deleted `tools/gen-icons.mjs`.
- Stray `api.json` NVIDIA sample snippet from the repository root.
