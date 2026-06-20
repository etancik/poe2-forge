# Persistent Character Roadmaps

Store each character under a user-selected directory outside the repository,
for example `roadmaps/<character>/`. Keep that root ignored by Git.

Layout:

```text
index.md
character.yaml
decisions/active/<stable-id>.md
decisions/archive/<stable-id>.md
baselines/<date>-<build-hash>.json
```

Read `character.yaml` and decision frontmatter first. Read full decision text
only for the current topic. Use `scripts/roadmap-manager.js summary` for a
compact machine-readable view.

Decision frontmatter fields:

```yaml
id: stable-id
status: now
updated: 2026-06-19
scope: holistic
tags: ["gear", "survival"]
dependencies: []
baseline: 2026-06-19-abcdef12
verified_with: <runtime-version>
```

Body headings are `Trigger`, `Decision`, `Evidence`, `Constraints`, and
optional `Revalidation`. Statuses are `now`, `planned`, `watch`, `completed`,
`rejected`, and `superseded`. Keep completed/rejected/superseded decisions in
`decisions/archive`.

Keep the roadmap small: target at most 4-6 active decisions per character.
Merge decisions that share one trigger or purchase path. Delete completed,
rejected, superseded, or one-off experiment files once their lasting
conclusion is integrated into an active decision or preserved in an external
audit artifact. The roadmap is a decision surface, not a permanent experiment
log.

Run `roadmap-manager.js validate` after manual changes and
`roadmap-manager.js index` to regenerate `index.md`.

Suggest a baseline refresh when the build hash, runtime, game/tree version, or
relevant configuration changes, or when relevant evidence is older than 14
days. Revalidate only affected decisions unless a broader audit is approved.

Record future archetype direction early enough to prevent locally optimal
choices from forcing a complete later respec. Transition milestones must stay
playable and identify passive, gear, mechanic, and verification dependencies.
