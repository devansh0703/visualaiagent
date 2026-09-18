# Changelog

All notable changes to this project are documented in this file.
Format based on Keep a Changelog; versions follow semver.

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
