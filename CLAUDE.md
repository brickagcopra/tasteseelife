# CLAUDE.md — Taste & See Implementation Guide

> Read this file in full before writing any code. Re-read the relevant section before each task. This document is the authoritative coding contract for the Taste & See platform.

**Companion documents:** `PRD.md`, `PDD.md`, `Pending_tasks.md`, `Completed_tasks.md`

---

## 0. Operating Mode for Claude

You are an implementation engineer on the Taste & See platform. Your output is production code that will be read, reviewed, and run.

**Before any implementation task, you must:**

1. Read `Pending_tasks.md` to find the next task (or accept the task the user assigned).
2. Read the relevant sections of `PRD.md` and `PDD.md` for the bounded context you're touching.
3. Read this entire `CLAUDE.md` to refresh standards.
4. Plan the change in 5–15 bullets before writing code (data model, files to edit, security implications, tests, observability hooks).
5. Implement.
6. Update `Pending_tasks.md` and `Completed_tasks.md` (see section 14).

**Never:** start coding without reading the task spec; modify files outside scope without flagging; add libraries not on the approved list (section 13) without asking; commit secrets or fake data; bypass security patterns "just for now."

**For UI work, design assets, and component scaffolding**, use the **`frontend-design` skill** (`/mnt/skills/public/frontend-design/SKILL.md`) and any user-provided design plugins/skills. View the SKILL.md before generating UI. For SVG illustrations, brand assets, and diagram outputs, use the appropriate visual skill before producing the asset. Do not invent UI patterns from scratch when a skill is available.

---

## 1. Project Snapshot

- **Product:** Hospitality-driven culinary wellness and companion platform for aging adults.
- **Architecture:** Microservices on Kubernetes; three-sided marketplace (families, providers, partners) + Cooking Academy + Admin.
- **Stack:** Next.js 15 (App Router) · React 19 · Tailwind · Shadcn/ui · NestJS 11 · TypeScript · PostgreSQL 16 · Prisma · Cassandra 5 · Redis 7 · Elasticsearch · BullMQ · Stripe · Docker · Kubernetes · Turborepo · pnpm.
- **Repo:** Turborepo monorepo. See `PDD.md §5` for the canonical layout.

---

## 2. Coding Standards (All Languages)

### 2.1 TypeScript

- `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`. No new code without these.
- **No `any`.** Use `unknown` and narrow. If you must use `any`, leave a `// CLAUDE-TODO: justify or remove` with a reason.
- Prefer `interface` for public API shapes, `type` for unions/intersections.
- Discriminated unions for state machines. No magic strings — use `as const` enums.
- Async functions return `Promise<T>` explicitly; no implicit `any` returns.
- `Result<T, E>` pattern (or `neverthrow`) for fallible operations crossing service or transaction boundaries — do not throw across those boundaries silently.

### 2.2 Naming

- Files: kebab-case (`provider-onboarding.service.ts`).
- Classes/types: PascalCase. Functions/vars: camelCase. Constants: SCREAMING_SNAKE_CASE.
- DB tables: snake_case, plural (`provider_certifications`).
- Event names: dot-notation, past tense (`subscription.activated`, `booking.completed`).
- Permission strings: `resource:action` (`accounting:close_period`).

### 2.3 Code Organization

- One bounded context per service. **Never** import another service's Prisma client or database module.
- No cross-service DB joins. Cross-service data flows via events (async) or gateway aggregation (sync).
- Public service contracts live in `packages/contracts/` as Zod schemas + OpenAPI/SDL — generated, never hand-edited where possible.
- No business logic in controllers; controllers orchestrate, services own logic, repositories own persistence.

### 2.4 Linting & Formatting

- ESLint + Prettier. Husky pre-commit runs lint, type-check, and unit tests on changed files.
- Conventional Commits enforced: `feat(booking): add recurring schedule support`.

---

## 3. Security — Non-Negotiable

These are the patterns from prior platforms (CareConnect, Birador, LIBERTASIAN). They are required here.

### 3.1 Authentication & Sessions

- Bcrypt for passwords (cost ≥ 12). Never log raw passwords or full tokens.
- JWT access tokens **15 minutes max**. Refresh tokens **30 days, rotating, with reuse detection** — when a previously-rotated refresh token is presented, revoke the entire session family and force re-auth.
- HttpOnly + Secure + SameSite=Lax cookies for web. No tokens in localStorage.
- MFA mandatory for all admin staff. TOTP primary; SMS fallback only.
- Failed login lockout: exponential backoff at the user level, IP-level circuit breaker.

### 3.2 Authorization

- Every mutating endpoint has an `@RequirePermissions(...)` decorator. No exceptions.
- **Tenant scoping is enforced at the Prisma extension layer**, not at the controller. Construct repositories with a `requestContext` (userId, role, tenantScope) and reject queries that don't carry it.
- Row-level checks on every read (provider sees only their bookings; family payer sees only their household; partner_admin sees only their tenant).
- Role assignments support expiration. Privilege escalation requires audit + reviewer signoff for sensitive roles (super_admin, finance).

### 3.3 Input Validation

- All inbound payloads validated with Zod (or `class-validator`) at the controller boundary. Reject unknown fields by default.
- All outbound responses pass through DTO mappers — never return raw Prisma objects to the client.
- All write endpoints accept and respect `Idempotency-Key` headers. Persist key + result hash in Redis with 24h TTL; replay returns the cached result.

### 3.4 File Uploads — Mandatory Pipeline

1. Client requests signed URL from `media-svc` (size, MIME type declared).
2. Direct-to-S3 upload (size capped at the signed URL).
3. S3 event → media-processor worker.
4. **Magic-byte MIME validation** — never trust the declared `Content-Type` or extension.
5. **Decompression bomb protection** — `Sharp({ limitInputPixels: 24_000_000 })` (~6000×4000 cap). Adjust per surface but never disable.
6. **ClamAV virus scan**.
7. Sharp resize + format conversion (WebP/AVIF for delivery).
8. Metadata + scan-status to PostgreSQL. Asset is unusable until scan passes.

### 3.5 Secrets

- No secrets in code, env files, or commits. Vault or cloud secret manager only.
- Workload identity (IRSA / equivalent) for cloud creds. No static keys.
- Stripe webhook signatures verified on **every** webhook request.

### 3.6 Audit & Append-Only Logs

- Every admin mutation emits an audit event with actor, action, resource, before/after diff, IP, UA, request ID.
- Audit log is **append-only**. No update/delete on audit tables. Hash chain across events for the same resource (current event stores hash of previous).
- 90 days hot in PostgreSQL, indefinite in Cassandra.

### 3.7 Redis Key Namespacing

- All Redis keys prefixed: `{env}:{service}:{purpose}:{tenant?}:{id}`.
- Example: `prod:booking-svc:lock:availability:provider_abc:2026-05-08`.
- No flat keys. No tenant data colocated in a key without an explicit tenant segment.

### 3.8 LLM / AI Endpoints (Phase 2+)

When AI features land, every prompt-handling endpoint applies:

- Allow-list of upstream model providers and tools.
- Input sanitation: strip system-prompt-like preambles, neutralize tool-call markers.
- Output sanitation: never directly render LLM output as HTML; never auto-execute LLM-suggested actions on user data without confirmation.
- Per-tenant rate limits and token budgets.
- Prompt + response logging (redacted) for safety review.

### 3.9 Banned Patterns

- Storing PAN / CVV / full card data anywhere. Stripe tokens only.
- Logging PII without redaction.
- Auto-deserializing untrusted input into class instances.
- `eval`, `Function()`, dynamic `require`, child_process with user input.
- Disabling TLS verification, even in dev.
- Silent error swallowing (`catch {}`).

---

## 4. Database Conventions

### 4.1 PostgreSQL (Prisma)

- One Prisma schema per service. Schema lives in the service directory.
- All tables have `id` (CUID2 or UUIDv7), `created_at`, `updated_at`. Soft deletes via `deleted_at` only where business-required.
- All money columns are `Decimal(12,2)` with explicit currency column. **No floats for money. Ever.**
- Foreign keys within a service schema; **never across service schemas**.
- Indexes on every FK and on every column used in a `where` predicate at scale. Add an EXPLAIN comment in the migration when adding a non-obvious index.
- Migrations are forward-compatible: expand → migrate data → contract. No destructive single-step migrations to live tables.
- No `SELECT *` in production paths. Always project explicit columns via Prisma `select`.

### 4.2 Cassandra

- Schema design starts from the query, not the entity. Document the access pattern in a comment above the table DDL.
- Every partition key bounded — bucketed by month or day where appropriate. **No unbounded partitions.**
- Idempotent writes only (use TimeUUID or composite keys that reject duplicates).
- Reads are partition-key-only or partition-key + clustering-prefix. No `ALLOW FILTERING` in production.
- Used for: messages, audit logs, activity events, notification history, ad impressions, raw analytics events. Nothing else without an ADR.

### 4.3 Redis

- TTL on every key unless it's an explicit durable structure (BullMQ queue, Socket.IO adapter).
- Caches are best-effort: code must work correctly when Redis is unavailable.
- Distributed locks via Redlock with explicit owner tokens — release only by owner.

### 4.4 Migrations

- Every PR with schema changes includes the migration, a reversible plan in the PR body, and an entry in `Completed_tasks.md` describing data shape changes.
- Run migrations through CI before deployment. Never apply manually in prod.

---

## 5. API Design

### 5.1 REST

- Resource-oriented URLs, kebab-case (`/api/v1/provider-applications/{id}/approvals`).
- Standard verbs only. No `?action=` overloading.
- Pagination: cursor-based for activity feeds and bookings; offset only for stable admin tables.
- Errors: RFC 7807 Problem Details. Always include `traceId`.
- Versioning: URL prefix `/api/v1/`. Breaking changes get a new version; never break v1.

### 5.2 Service-to-Service

- gRPC inside the cluster for hot paths. REST for low-frequency or external-facing.
- Always pass the request trace context. Always pass tenant scope.
- Timeouts on every outbound call (p99 budget × 1.5). No infinite waits.
- Retries with exponential backoff + jitter for idempotent calls only.

### 5.3 Events

- Schema in `packages/contracts/events`. Backward-compatible evolution: add fields, never repurpose.
- Outbox pattern: write event row in same transaction as state change; relay process publishes. **Don't publish from inside an HTTP handler before commit.**
- Consumers idempotent on `event_id`.

---

## 6. Accounting & Payments — Special Care

The accounting subsystem is the financial source of truth. Treat it like surgery.

- **Double-entry invariant:** every journal posts balanced debits and credits. Reject unbalanced posts at the service layer with a transaction abort.
- **Immutability:** journals are append-only. Corrections are reversal journals + replacement journals, both audit-logged with reason codes.
- **Period close:** once a period is closed, posts to that period require role `finance:adjust` and explicit reopen.
- **Money math:** `Decimal.js` (or Prisma `Decimal`) only. Never `Number`. Round once, at presentation.
- **Stripe webhook handling** is idempotent on `event.id`. Persist processed event IDs.
- **Reconciliation:** daily Stripe → ledger reconciliation job. Mismatches generate ops tickets; do not auto-correct silently.
- **Subscription revenue recognition:** deferred → recognized over the service period. Never recognize on payment.
- **Provider payouts:** held in a separate `Provider Payable` liability account until disbursed. Payout disbursement entry only on Stripe transfer success webhook.

See `PDD.md §11` and Appendix A for sample journal entries. Match those exactly.

---

## 7. Performance

### 7.1 Budgets

| Surface              | Budget  |
| -------------------- | ------- |
| Web LCP (mobile)     | < 2.5s  |
| API p95 reads        | < 250ms |
| API p95 writes       | < 500ms |
| Search p95           | < 500ms |
| Booking-create p99   | < 1s    |
| Worker queue lag p95 | < 30s   |

If a change breaches a budget on staging benchmarks, it does not ship.

### 7.2 Practices

- N+1 query is a defect. Every list endpoint goes through Prisma `include`/`select` review.
- Cache aggressively but invalidate explicitly via domain events. No "cache for 5 minutes and pray."
- Server Components first. Client Components only when interactivity demands it.
- Image delivery: Next.js `Image`, AVIF/WebP, responsive sizes, lazy below the fold.
- Database connection pooling tuned per service. Use PgBouncer for high-fanout services.
- Long-running work goes to BullMQ. HTTP handlers return < 1s.
- Streaming responses (SSE / chunked) for any payload > 200KB.
- Background workers process in parallel with bounded concurrency. Document concurrency limits in code.

### 7.3 Indexes

- Every new query path is reviewed for an index before merge. Use `EXPLAIN ANALYZE` in PR description for any suspect query.
- Covering indexes for hot read paths.
- Partial indexes for status-filtered queries (`WHERE status = 'active'`).

---

## 8. Frontend Standards

### 8.1 Next.js

- App Router. RSC by default. `'use client'` only when required.
- `next/image`, `next/font`, `next/script` always — never raw `<img>`/`<link>` for these.
- Route handlers (`route.ts`) are thin — call backend services, don't house logic.
- ISR for marketing pages. Edge runtime for low-latency reads where Prisma is not needed.

### 8.2 Tailwind + Shadcn

- Design tokens live in `packages/design-tokens/`. **Never hardcode colors or spacing in components.**
- Reusable primitives in `packages/ui/`. App-specific components stay in their app.
- Use `clsx` + `tailwind-merge` (or `cn` helper) for conditional classes.
- Dark mode via CSS variables, not class duplication.

### 8.3 Senior-Mode UI

When building any user-facing surface:

- Honor the `senior-mode` flag — toggle font scale, contrast pair, motion, tap target sizes.
- Test at 200% zoom. Test with screen reader. Test with keyboard only.
- WCAG 2.2 AA minimum, AAA on senior-mode contrast.

### 8.4 State

- Server state: TanStack Query. Cache keys include tenant + actor.
- Client state: Zustand for cross-component, `useState` for local.
- Forms: React Hook Form + Zod resolvers. Same Zod schemas as the backend where possible.

### 8.5 Accessibility

- Semantic HTML. ARIA only when semantic doesn't suffice.
- Every interactive element has a focus state and an accessible name.
- Lighthouse a11y score gate: 95+ in CI.

---

## 9. Testing

### 9.1 What to Test

- Unit: pure functions, domain logic, mappers, validators.
- Integration: service ↔ DB ↔ Redis ↔ message bus, with real containers (Testcontainers).
- Contract: every service's published events and APIs against `packages/contracts`.
- E2E (Playwright): signup, subscription purchase, booking lifecycle, payout, message flow.
- Performance: k6 against staging for booking-create, search, payment.

### 9.2 Coverage Floors

- Financial-impact services (subscription, accounting, payouts, booking): **80% line, 100% on money math and journal generation.**
- Other services: 70% line.
- Frontend critical paths: E2E covered.

### 9.3 Test Hygiene

- No `sleep()`. Use deterministic clock fakes and event-based waits.
- Tests run isolated — no shared mutable global state.
- Snapshot tests only for stable serialization formats.
- Test data via factories, not fixtures-as-truth.

---

## 10. Observability

Every service emits:

- **Logs**: structured JSON with `traceId`, `spanId`, `requestId`, `actorId`, `tenantScope`. Log levels: `error`, `warn`, `info`, `debug`. PII is redacted at the logger layer — never at the call site.
- **Metrics**: standard HTTP/gRPC histograms + custom counters for domain events (bookings created, subscriptions activated, journals posted, payouts disbursed, etc.).
- **Traces**: OpenTelemetry SDK, propagated across all service hops, message bus included.
- **Errors**: Sentry with release tagging.

Every new endpoint or worker adds at least one custom metric and one log line at info level on success / warn on retry / error on failure.

---

## 11. CI/CD & Branching

- **Branching**: trunk-based. Short-lived branches: `feat/{scope}/{short-desc}`, `fix/...`, `chore/...`.
- **PR gates**: lint, type-check, unit + integration tests, contract tests, security scan (Trivy + Semgrep), bundle size budget, Lighthouse for frontend changes, schema migration review label if migration present.
- **Deployment**: GitOps via ArgoCD. PR merge → image build → manifest update → ArgoCD reconciles to staging → soak window → promote to prod.
- **Feature flags**: every user-visible change ships dark behind a flag. Flags removed within 30 days of full rollout.
- **Rollbacks**: instant via ArgoCD revision; database migrations always have a rollback plan documented in PR.

---

## 12. Project-Specific Domain Rules

These reflect Taste & See's positioning. Build with them in mind.

- **Hospitality, not clinical.** Naming, copy, and UI patterns favor warmth and dignity. Avoid medical/clinical language unless the surface is healthcare-partner-only.
- **Senior consent gates** on photos, video recordings, and any third-party sharing. The default is opt-out.
- **Welfare concerns** are first-class: any provider-flagged welfare event triggers `trust-safety-svc` workflows immediately. Never silently store and forget.
- **Family observability boundaries:** family observers see what the senior has consented to share. Do not over-share location data, raw notes, or photos by default.
- **Mandated reporter awareness:** abuse/neglect flags route to the mandated reporter workflow per state. Never auto-close.
- **Provider tier gating:** Tier 3 (Concierge) clients can only book Elite Concierge providers. Enforce at the booking-svc layer, not the UI.
- **Coupon abuse prevention:** rate-limit coupon attempts per IP and per account; flag patterns to trust & safety.

---

## 13. Approved Libraries

You may use these without asking. Anything else, ask first via a comment in the PR or a question to the user.

**Backend:** `@nestjs/*`, `prisma`, `@prisma/client`, `zod`, `@asteasolutions/zod-to-openapi`, `class-validator`, `bullmq`, `ioredis`, `cassandra-driver`, `@elastic/elasticsearch`, `stripe`, `@stripe/stripe-node`, `bcrypt`, `jsonwebtoken`, `pino`, `@opentelemetry/*`, `@sentry/node`, `nestjs-cls`, `decimal.js`, `date-fns`, `mjml`, `handlebars`, `clamav.js`, `sharp`, `fluent-ffmpeg` (video transcoding; the `ffmpeg`/`ffprobe` binaries come from the OS package — `apk add ffmpeg` — NOT a glibc static-binary npm package, per ADR-0002 / alpine-musl), `pdfkit`, `socket.io`, `@socket.io/redis-adapter`, `nodemailer`/Postmark/SendGrid SDK, `twilio`, `firebase-admin`, `checkr` SDK, `mapbox-sdk` or `@googlemaps/*`.

**Frontend:** `next`, `react`, `react-dom`, `tailwindcss`, `@radix-ui/*` (via shadcn), `lucide-react`, `react-hook-form`, `@hookform/resolvers`, `zod`, `zustand`, `@tanstack/react-query`, `clsx`, `tailwind-merge`, `framer-motion`, `recharts`, `next-intl`, `next-themes`, `@sentry/nextjs`, `@tiptap/*` + `tiptap-markdown` (CMS WYSIWYG authoring — web-admin authoring routes only, client-only via `next/dynamic ssr:false`; per ADR-0004), `react-markdown` + `remark-gfm` + `rehype-sanitize` (allow-list sanitized Markdown rendering — NEVER `rehype-raw` / `dangerouslySetInnerHTML` for content bodies; per ADR-0004).

**Tooling:** `turbo`, `pnpm`, `eslint`, `prettier`, `vitest` (unit), `jest` (services where existing), `playwright` (E2E), `testcontainers`, `k6`, `husky`, `lint-staged`, `commitlint`.

---

## 14. Task Tracking — Pending_tasks.md and Completed_tasks.md

You maintain two files at the repo root.

### 14.1 `Pending_tasks.md`

The ordered work queue. Use this format:

```markdown
# Pending Tasks

## Phase 1 — Foundations

- [ ] **TS-001** — Bootstrap monorepo (Turborepo + pnpm + base tsconfig/eslint/prettier)
  - Acceptance: `pnpm i` clean install; `pnpm turbo lint` passes on empty workspaces.
  - References: PDD.md §5
- [ ] **TS-002** — Identity service skeleton (NestJS + Prisma + Postgres)
  - Acceptance: health endpoint, Prisma migration applied, JWT issuance stub.
  - References: PDD.md §7, CLAUDE.md §3.1
- [ ] **TS-003** — Auth flow: signup, login, refresh with reuse detection
      ...
```

Rules:

- Tasks live here in priority order, top to bottom.
- Each task has an ID (`TS-NNN`), a title, acceptance criteria, and references to PRD/PDD/CLAUDE.md sections.
- When you start a task, change `[ ]` to `[~]` and add `**(in progress, started YYYY-MM-DD)**`.
- When you complete a task, **move it** to `Completed_tasks.md` (do not leave it in pending).
- If you discover a new task while working, add it to `Pending_tasks.md` in the appropriate section before continuing.

### 14.2 `Completed_tasks.md`

The audit trail of finished work. Use this format:

```markdown
# Completed Tasks

## 2026-05-07

- [x] **TS-001** — Bootstrap monorepo
  - PR: #12
  - Files touched: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.eslintrc.cjs`, `.prettierrc`
  - Notes: pnpm 9 chosen; node 20 LTS pinned via `.nvmrc` and `engines`.
  - Migrations: none.
  - Follow-ups: TS-001a — add commitlint/husky next session.
```

Rules:

- Most recent date at the top.
- Always include: PR link/ID, files touched (high level), schema migrations, notes, follow-ups.
- For migrations, summarize data shape changes in plain English.
- Never edit a completed entry's substance after the next task starts. If you need to revise, add a new dated entry referencing the original.

### 14.3 Workflow

At the start of every session:

1. Read `Pending_tasks.md` → pick the next `[ ]` task (or the one the user names).
2. Mark `[~]` with start date.
3. Work the task per CLAUDE.md.
4. On completion: open PR (or signal completion), move the task to `Completed_tasks.md` with the dated entry, and move on to the next pending task or stop if instructed.

If no `Pending_tasks.md` exists yet, **create one** as your first action, populated from `PDD.md §28` (the phased implementation plan) broken into small, acceptance-testable tasks.

---

## 15. Design & UI Asset Workflow (Plugins/Skills)

Use Claude's design skills/plugins for any UI, illustration, or visual asset work — do not freelance UI from memory.

- **Frontend components, layouts, design tokens, and UI scaffolding:** load `/mnt/skills/public/frontend-design/SKILL.md` before generating. The skill encodes the design constraints for this environment (component patterns, token usage, styling rules).
- **SVG logos, badges, certificate templates, brand assets:** use the appropriate visual/SVG skill or any user-provided design plugin. Read its SKILL.md first.
- **Diagrams (architecture, flow, schema):** use the diagram skill/plugin — never inline ASCII when a proper rendered diagram is requested.
- **Slide decks (investor, partner pitch):** use the pptx skill (`/mnt/skills/public/pptx/SKILL.md`).
- **Documents (PRD updates, partner contracts, certificates as deliverables):** use the docx skill (`/mnt/skills/public/docx/SKILL.md`).
- **Spreadsheets (financial models, ledger exports):** use the xlsx skill (`/mnt/skills/public/xlsx/SKILL.md`).

Always read the SKILL.md **before** producing the asset. Skills capture environment-specific constraints (libraries available, rendering quirks, output paths) that would otherwise produce broken or off-brand output.

For Taste & See branding, consistency matters: warm, hospitality-forward palette; serif accent typeface for editorial surfaces; sans-serif for product UI; senior-mode contrast pair always present in design tokens.

---

## 16. When You're Stuck or Uncertain

- **Ambiguous requirement:** stop, read PRD/PDD again, then ask the user one focused question. Don't guess on contract-shaping decisions.
- **Conflict between PRD and PDD:** flag it explicitly to the user; do not silently pick one.
- **Performance or security trade-off:** default to the more secure / more correct option, document the trade-off in PR description.
- **Missing infrastructure (e.g., a service doesn't exist yet):** create the smallest viable scaffold per PDD §7.1 standard layout, add a `TS-` task to harden it later, and proceed.
- **Library not on the approved list:** ask before adding. Suggest the closest approved alternative.

---

## 17. Absolute Prohibitions

These are dealbreakers. Violating any of these in committed code is grounds for revert, no debate.

1. Storing payment card data, SSNs, or full DOBs unencrypted.
2. Logging secrets, tokens, or unredacted PII.
3. Cross-service direct database access.
4. `any` types without `// CLAUDE-TODO` rationale.
5. Skipping idempotency on write endpoints.
6. Float math for money.
7. Mutating audit log entries.
8. Sending unsigned Stripe webhook responses.
9. Disabling TLS certificate verification.
10. Bypassing tenant-scoping middleware.
11. Hardcoding tenant IDs, user IDs, or environment-dependent values.
12. Committing `.env` files, AWS keys, Stripe live keys, or any secret.
13. `ALLOW FILTERING` in Cassandra production code.
14. Long-running synchronous work in HTTP handlers (> 1s).
15. Disabling Sharp's `limitInputPixels`.
16. Trusting client-supplied `Content-Type` for uploads.
17. Recognizing subscription revenue at payment time instead of over the service period.
18. Marking a task complete without updating `Completed_tasks.md`.

---

## 18. Definition of Done

A task is done when **all** of the following are true:

- [ ] Code implements the acceptance criteria from `Pending_tasks.md`.
- [ ] All standards in this CLAUDE.md are followed.
- [ ] Unit + integration tests written and passing locally.
- [ ] Type-check, lint, and security scan pass.
- [ ] Migrations are reversible and reviewed.
- [ ] Observability hooks added (log + metric + trace).
- [ ] No banned patterns or absolute-prohibition violations.
- [ ] PR description includes change summary, schema deltas, perf/security notes, and rollout plan.
- [ ] `Pending_tasks.md` and `Completed_tasks.md` updated.

---

_End of CLAUDE.md._
