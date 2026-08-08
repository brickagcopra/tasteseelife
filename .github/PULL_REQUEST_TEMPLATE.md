<!--
  Taste & See — pull request template.
  Mirrors the Definition of Done in CLAUDE.md §18 plus the standard PR
  metadata called for in CLAUDE.md §11. Delete sections that don't apply,
  but keep the headers so reviewers can grep the PR for the same shape
  every time.
-->

## Summary

<!-- One or two sentences. What changed, and why? Link the TS-NNN task. -->

## Linked tasks

- TS-NNN — <!-- short title -->

## Schema deltas

<!--
  If this PR touches a Prisma schema, describe the data shape change in
  plain English, list affected tables, and link the migration file. State
  the rollback plan (forward-compat: expand → migrate → contract). If no
  migrations: write "None."

  PRs that modify any file under `**/prisma/migrations/**` MUST have the
  `migration-review` label applied by a migration reviewer before merge.
  The "Migration review label gate" CI job enforces this — see
  `.github/workflows/migration-review-label.yml` and CLAUDE.md §4.4, §11.
-->

## Performance & security notes

<!--
  Call out any:
  - new query path (paste an EXPLAIN ANALYZE for non-trivial reads)
  - new outbound call (timeouts? retries? idempotency?)
  - new write endpoint (idempotency key wired? rate limited?)
  - PII / sensitive data flow (encryption? audit log?)
  Otherwise: "No new perf/security surface."
-->

## Rollout plan

<!--
  Feature flag name (if any), default state, rollout cohorts, kill-switch
  path. Migrations: forward-deploy → backfill → contract. Otherwise:
  "Standard deploy."
-->

## Definition of Done — CLAUDE.md §18

- [ ] Code implements the acceptance criteria from `Pending_tasks.md`
- [ ] All CLAUDE.md standards followed (§2 coding, §3 security, §4 DB, §5 API)
- [ ] Unit + integration tests written and passing locally
- [ ] Type-check, lint, and security scan pass (CI green)
- [ ] Migrations are reversible and reviewed (or N/A)
- [ ] Observability hooks added (log + metric + trace) (or N/A)
- [ ] No banned patterns or absolute-prohibition violations (CLAUDE.md §17)
- [ ] `Pending_tasks.md` and `Completed_tasks.md` updated
