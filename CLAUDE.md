# Visual AI Agent (VAIA)

Manifest V3 Chrome extension + local receiver. Pure Node ESM, no build step, no runtime deps.

- `npm test` — 139+ unit tests (`node --test`)
- `npm run test:integration` — live provider test (skips without a key)
- `npm run e2e` — headless Chrome E2E (needs puppeteer-core + system Chrome)
- `npm run server` — receiver + dashboard on :8787

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
