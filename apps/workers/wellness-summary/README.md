# worker-wellness-summary (TS-235)

Scheduled worker that emails a **monthly wellness summary** to each family
member + senior in every active household (PRD §6.9; PDD §12.2).

## What it does

Once a month (configurable day-of-month + hour, UTC), the worker:

1. Walks the active household population page-by-page via
   `GET /api/v1/internal/wellness-summary/households` (service-household).
2. Resolves recipient emails via
   `POST /api/v1/internal/identity/recipient-contacts` (service-identity).
3. Fetches each senior's prior-30-day observation roll-up via
   `GET /api/v1/internal/bookings/.../wellness-observation-summary`
   (service-booking, reusing the TS-231 trend math).
4. Dispatches one rendered `wellness-summary-monthly` email per
   `(senior × active recipient)` via
   `POST /api/v1/internal/notification/dispatch` (service-notification).

Each dispatch carries a deterministic idempotency key
(`wellness-summary:{period}:{seniorId}:{recipientUserId}`) so a re-run of
the same month collapses against the original send rather than
double-emailing.

## Consent (CLAUDE.md §12)

Observation **detail** is gated on the senior's TS-238 `notes` consent:
the `primary_payer` / `senior_user` always see detail; a `family_observer`
sees it only when the senior shared `notes`. When withheld, the recipient
still gets the visit count + a gentle note.

## Scheduling

A lightweight `setTimeout` loop (mirroring `worker-outbox-relay`'s
`RelayScheduler`) wakes every `WELLNESS_SUMMARY_SCHEDULER_TICK_MS` (default
1h) and fires the batch once per month when the configured window is
reached. BullMQ adoption is deferred (TS-235-followup) — the codebase has
no BullMQ precedent yet.

## Notes

- No datastore. Pure cross-service HTTP aggregator. `/healthz` + `/readyz`
  return ok once booted.
- Best-effort: a failing household / senior / recipient is logged + skipped,
  never aborts the run.
- The `wellness-summary-monthly` notification template must be seeded
  (`pnpm -F @taste-and-see/service-notification seed:templates`) before the
  worker can send; an un-seeded template makes every dispatch 404 (logged).
- Live email delivery depends on service-notification's email channel
  adapter (TS-073-followup-1, Postmark) — until then dispatches render +
  record but don't physically send.
