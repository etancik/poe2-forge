# Repository workflow

- Treat this repository as the only source of truth for the installed
  `calculator-backed-build-optimizer` skill. Never edit the installed copy
  first.
- Work on a local review branch. Leave changes uncommitted unless the user asks
  Codex to commit them.
- Do not load character roadmaps, historical Codex task folders, or generated
  build artifacts as development context.
- Keep reusable logic in scripts and tests; keep `SKILL.md` concise and route
  subsystem details to one-level references.
- Preserve saved builds. Calculator inspection and search are non-mutating;
  applying a reviewed build change requires separate user approval.
- Before handoff, run `npm test`, `npm run audit`, the skill validator, and a
  current-runtime smoke test when calculator entry points changed.
- Show the user `git diff --stat`, relevant diffs, and test results. Publish to
  the installed skill only after review approval with
  `node scripts/sync-installed-skill.js --apply ...`.
- Never commit, push, or open a PR unless the user explicitly requests it.
