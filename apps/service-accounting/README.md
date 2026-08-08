# `@taste-and-see/service-accounting`

Accounting & Ledger bounded context (PDD §7.2 service #10, §11.2). The
financial source of truth for Taste & See.

## Scope

CLAUDE.md §6 names this service the financial source of truth — every
financially-relevant event in the platform maps to a balanced journal
entry here. The catalog half (TS-080) + the journal-posting service
(TS-081) are live:

- **Chart of accounts** — the SaaS-standard chart per PDD §11.2 +
  Appendix A. Hierarchical (`parent_id`) with assets, liabilities,
  equity, revenue, contra-revenue, and expense categories.
- **Journals + journal lines** — the double-entry shape. Immutable;
  reversals are explicit replacement journals.
- **Periods** — open/closed accounting periods with role-gated reopen.
- **Read-only catalog endpoint** — `GET /api/v1/accounts` returns the
  active chart for admin consoles + finance tooling.
- **Journal-posting endpoints** — `POST /api/v1/internal/journals`
  (system-driven, shared-secret pinned), `POST /api/v1/admin/journals/manual-adjustment`
  (finance override, AccessTokenGuard), and
  `POST /api/v1/admin/journals/:journalId/reverse` (reversal journal,
  flips the original's back-pointer in the same transaction).

The revenue-recognition driver (TS-082), booking-commission entries
(TS-083), coupon contra-revenue + refund reversals (TS-084), and
period close + reopen (TS-085) land as expand-only follow-ups against
the JournalPostingService.

## Local development

```powershell
# Install dependencies (from the repo root)
pnpm install

# Start postgres locally
pnpm infra:up

# Apply migrations
pnpm --filter @taste-and-see/service-accounting prisma:migrate:deploy

# Seed the SaaS-standard chart of accounts (idempotent)
pnpm --filter @taste-and-see/service-accounting seed:chart-of-accounts

# Start the service in watch mode (port 3015)
pnpm --filter @taste-and-see/service-accounting start:dev
```

## Health endpoints

- `GET /healthz` — liveness (process up + HTTP responsive).
- `GET /readyz` — readiness (Postgres pool healthy).

Both follow the kubelet liveness/readiness contract per PDD §20.2.

## Catalog endpoint

- `GET /api/v1/accounts` — read-only list of the active chart of
  accounts. Supports `?type=` (asset/liability/...) and `?parentId=` to
  narrow to a sub-tree. Used by admin tooling + the finance team's
  ledger view (TS-129).

## Journal-posting endpoints (TS-081)

- `POST /api/v1/internal/journals` — system-driven journal post.
  Shared-secret pinned via `x-accounting-internal-api-key` header (the
  TS-142 outbox relay reads `INTERNAL_POST_JOURNAL_API_KEY` from its
  env). Enforces balanced DR=CR + idempotent on `sourceEventId` at
  the DB layer; replays return the existing journal (exactly-once
  effective).
- `POST /api/v1/admin/journals/manual-adjustment` — explicit finance
  override (CLAUDE.md §6). Kind is locked to `manual_adjustment` at
  the contract layer; `reasonCode` is persisted in the journal's
  `context` jsonb. Permission-string gating arrives with the
  `packages/nest-auth` lift (TS-081-followup-1 / TS-052-followup-11).
- `POST /api/v1/admin/journals/:journalId/reverse` — reversal
  journal. Mirrors the original's lines with debit↔credit swapped;
  sets `reversedJournalId` on the new journal + `reversedByJournalId`
  on the original (the ONE allowed mutation on a posted journal — the
  back-pointer IS the audit record).

## What lives in `accounting` Postgres schema

```
chart_of_accounts(id, code, name, type, parent_id, normal_balance, currency, active, created_at, updated_at)
journals(id, kind, occurred_at, source_event_id, description, posted_at, reversed_by_journal_id, posted_by_user_id, period_id, ...)
journal_lines(id, journal_id, account_id, debit, credit, currency, memo)
periods(id, name, start_date, end_date, status, closed_at, closed_by_user_id, ...)
```

## Banned patterns reminder (CLAUDE.md §6, §17)

- **No float math for money.** Every column is `Decimal(12,2)`; the
  service uses `decimal.js`.
- **Journals are immutable.** No `UPDATE` / `DELETE` against
  `journals` or `journal_lines`. Reversals are new rows.
- **Period close requires `finance:adjust`.** Off-period adjustments
  require explicit reopen, audit-logged.
- **Subscription revenue is recognised over the service period.**
  Never at payment time (CLAUDE.md §17.17).

## Related tasks

- TS-080 — skeleton + chart of accounts.
- TS-081 — journal posting service with double-entry invariant (this task).
- TS-082 — subscription revenue recognition.
- TS-083 — booking commission journal entries.
- TS-084 — coupon contra-revenue + refund reversal entries.
- TS-085 — period close + reopen (retires the lazy-create period path).
