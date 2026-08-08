# worker-certification-renewal (TS-256)

Scheduled worker that handles **Cooking Academy certification renewals**
(PRD §9.3; PDD §12.2, §15.2): it reminds holders before expiry and flips
lapsed certifications to `expired`.

## What it does

Once a day (configurable hour, UTC), the worker:

1. Walks the at-risk certification population page-by-page via
   `GET /api/v1/internal/academy/certifications/renewals` (service-academy)
   — the ACTIVE certifications already past expiry OR within the horizon
   (default 90 days).
2. For each candidate, classifies against the clock:
   - **lapsed** (expiry ≤ now) → `POST …/certifications/:id/expire`
     (service-academy) flips `active → expired`. This is the
     "course.completed reversal" trigger point (PRD §9.3).
   - **reminder** (expiry maps to a 90 / 60 / 30 / 7-day milestone) →
     resolve the holder's email via
     `POST /api/v1/internal/identity/recipient-contacts` (service-identity)
     and dispatch the `academy-certification-renewal` email via
     `POST /api/v1/internal/notification/dispatch` (service-notification).
   - **skip** (between milestones, or beyond the window) → no action.

Each reminder carries a deterministic idempotency key
(`cert-renewal:{certificationId}:{milestoneDays}`) so each milestone sends
exactly once even though the worker scans daily; each `expire` is
idempotent.

## Scheduling

A lightweight `setTimeout` loop (mirroring the TS-235 wellness-summary
`SummaryScheduler` / `worker-outbox-relay`'s `RelayScheduler`) wakes every
`CERTIFICATION_RENEWAL_SCHEDULER_TICK_MS` (default 1h) and fires the batch
once per UTC day when the configured hour is reached. BullMQ adoption is
deferred (the codebase has no BullMQ precedent yet).

## Notes

- No datastore. Pure cross-service HTTP aggregator. `/healthz` + `/readyz`
  return ok once booted.
- Best-effort: a failing page / certification / recipient is logged +
  skipped; a lapse recorded before a later hop still stands.
- The `academy-certification-renewal` notification template must be seeded
  (`pnpm -F @taste-and-see/service-notification seed:templates`) before the
  worker can send; an un-seeded template makes every dispatch 404.
- Live email delivery depends on service-notification's email channel
  adapter (TS-073-followup-1, Postmark) — until then dispatches render +
  record but don't physically send.
- The downstream **provider-tier demotion** on lapse is the deferred
  TS-256-followup-1 (service-academy has no outbox yet; the provider-svc
  sync is TS-255-followup-4 / TS-052-followup-4).
