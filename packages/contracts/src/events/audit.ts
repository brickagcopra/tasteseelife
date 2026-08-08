import { z } from 'zod';

/**
 * Audit domain event (TS-271a-followup-1 / TS-272a-followup-1 /
 * TS-277a-followup-1; PDD §7.4 event catalog — `audit.action_recorded`
 * published by "(any service)", consumed by `audit-svc`; CLAUDE.md §3.6
 * append-only audit log + hash chain).
 *
 * **Why an event, not a direct HTTP call.** Every admin mutation must
 * leave an audit trail (CLAUDE.md §3.6). Producers append this event to
 * their outbox *inside the same Prisma transaction as the mutation*
 * (PDD §7.3 / CLAUDE.md §5.3 outbox pattern), so the audit record commits
 * atomically with the state change — it can never be lost to a transient
 * `service-audit` outage the way a best-effort post-commit HTTP call
 * could. The `outbox-relay` worker drains the row onto Redis Streams and
 * `service-audit`'s outbox consumer persists it via its append-only,
 * hash-chained `recordEvent` path (idempotent on `eventId`).
 *
 * The payload mirrors the `service-audit` ingest DTO
 * (`RecordAuditEventRequest`, `http/audit.schema.ts`) field-for-field —
 * minus `eventId` / `occurredAt`, which live on the common event envelope
 * — so the consumer maps it 1:1 onto `recordEvent`. The shapes are
 * deliberately re-declared here (not imported from the http module) so the
 * events module carries no intra-package dependency on the http module —
 * the same discipline the booking / search events follow.
 *
 * Event names are dot-notation, past tense (CLAUDE.md §2.2).
 */
export const AUDIT_ACTION_RECORDED = 'audit.action_recorded' as const;

// ─── Bounded length constants (mirror http/audit.schema.ts) ─────────────

/** Action name cap — `resource:action` permission-string shape (e.g. `ad_campaign:create`). */
export const AUDIT_EVENT_ACTION_MAX_LENGTH = 200;
/** Resource-kind cap — short slugs (`ad_campaign`, `ad_creative`, `ad_slot_schedule`). */
export const AUDIT_EVENT_RESOURCE_KIND_MAX_LENGTH = 100;
/** Resource id cap — CUID2 / UUID v7 / external-id shapes. */
export const AUDIT_EVENT_RESOURCE_ID_MAX_LENGTH = 256;
/** Actor role cap — role names land ≤40 chars in practice. */
export const AUDIT_EVENT_ACTOR_ROLE_MAX_LENGTH = 100;
/** Actor user-id cap — soft FK into `identity.users.id`. */
export const AUDIT_EVENT_ACTOR_USER_ID_MAX_LENGTH = 128;
/** Tenant-scope id cap — soft FK into a partner / household / org id. */
export const AUDIT_EVENT_TENANT_SCOPE_ID_MAX_LENGTH = 128;
/** User-Agent cap — covers the pathological Chromium/Edge UA strings. */
export const AUDIT_EVENT_USER_AGENT_MAX_LENGTH = 1_024;
/** Request-id / trace-id cap — UUID / W3C traceparent shapes. */
export const AUDIT_EVENT_REQUEST_ID_MAX_LENGTH = 128;
export const AUDIT_EVENT_TRACE_ID_MAX_LENGTH = 128;
/** Before / after JSON payload cap — stringified-byte ceiling (64 KiB). */
export const AUDIT_EVENT_JSON_PAYLOAD_MAX_BYTES = 65_536;
/** IPv4 dotted-quad or IPv6 colon-separated — 45 = max INET text length. */
const AUDIT_EVENT_IP_MAX_LENGTH = 45;

// ─── Actor tenant-scope enum ────────────────────────────────────────────

/**
 * Actor tenant-scope kind — mirrors the http audit DTO's
 * `ActorTenantScopeType`. `system` is the automated / job-driven case
 * (no human actor); admin-staff mutations are `global` / `tenant` /
 * `household`.
 */
export const AuditEventActorScopeTypeSchema = z.enum(['global', 'tenant', 'household', 'system']);
export type AuditEventActorScopeType = z.infer<typeof AuditEventActorScopeTypeSchema>;

// ─── Common event envelope ──────────────────────────────────────────────

/**
 * Common event envelope — every event carries `eventId` (consumer dedup
 * key per CLAUDE.md §5.3) and `occurredAt` (producer wall-clock
 * timestamp). Same shape as the booking / search / subscription events.
 */
const AuditEventEnvelopeSchema = z.object({
  eventId: z.string().min(1).max(128),
  occurredAt: z.string().datetime(),
});

/**
 * Before / after diff payload — arbitrary JSON, capped at
 * {@link AUDIT_EVENT_JSON_PAYLOAD_MAX_BYTES} after serialisation
 * (`superRefine` because Zod can't express a payload-byte cap natively).
 * Null when the action has no meaningful before (create) or after
 * (delete) snapshot.
 */
const AuditDiffJsonSchema = z.unknown().refine(
  (value) => {
    if (value === undefined || value === null) return true;
    try {
      return JSON.stringify(value).length <= AUDIT_EVENT_JSON_PAYLOAD_MAX_BYTES;
    } catch {
      // Circular / non-serialisable → invalid by definition.
      return false;
    }
  },
  {
    message: `diff payload exceeds ${AUDIT_EVENT_JSON_PAYLOAD_MAX_BYTES} bytes after JSON serialisation`,
  },
);

/**
 * `audit.action_recorded` — emitted by any service that mutates an
 * admin-owned resource. Consumer: `service-audit` (persists append-only
 * with a per-resource hash chain).
 *
 *   - `actorUserId` / `actorRole` — the verified-token actor. Null only
 *     for `system`-scoped events (no human actor); the `superRefine`
 *     enforces "actorUserId present unless scope is `system`", matching
 *     the http ingest invariant.
 *   - `actorTenantScopeType` / `actorTenantScopeId` — the request scope
 *     the actor acted in (`global` for platform-wide admin staff).
 *   - `action` — `resource:verb` (e.g. `ad_campaign:create`).
 *   - `resourceKind` / `resourceId` — what was mutated.
 *   - `beforeJson` / `afterJson` — DTO-projected snapshots, never raw
 *     Prisma rows (CLAUDE.md §3.3). Null for the absent side of a
 *     create / delete.
 *   - `ip` / `userAgent` / `requestId` / `traceId` — request metadata,
 *     null when unavailable.
 */
export const AuditActionRecordedSchema = AuditEventEnvelopeSchema.extend({
  actorUserId: z.string().min(1).max(AUDIT_EVENT_ACTOR_USER_ID_MAX_LENGTH).nullable(),
  actorRole: z.string().min(1).max(AUDIT_EVENT_ACTOR_ROLE_MAX_LENGTH).nullable(),
  actorTenantScopeType: AuditEventActorScopeTypeSchema,
  actorTenantScopeId: z.string().min(1).max(AUDIT_EVENT_TENANT_SCOPE_ID_MAX_LENGTH).nullable(),
  action: z.string().min(1).max(AUDIT_EVENT_ACTION_MAX_LENGTH),
  resourceKind: z.string().min(1).max(AUDIT_EVENT_RESOURCE_KIND_MAX_LENGTH),
  resourceId: z.string().min(1).max(AUDIT_EVENT_RESOURCE_ID_MAX_LENGTH),
  beforeJson: AuditDiffJsonSchema.nullable(),
  afterJson: AuditDiffJsonSchema.nullable(),
  ip: z.string().min(1).max(AUDIT_EVENT_IP_MAX_LENGTH).nullable(),
  userAgent: z.string().min(1).max(AUDIT_EVENT_USER_AGENT_MAX_LENGTH).nullable(),
  requestId: z.string().min(1).max(AUDIT_EVENT_REQUEST_ID_MAX_LENGTH).nullable(),
  traceId: z.string().min(1).max(AUDIT_EVENT_TRACE_ID_MAX_LENGTH).nullable(),
})
  .strict()
  .superRefine((body, ctx) => {
    // System-scoped events have no required human actor; every other
    // scope must name the actor. Matches the http ingest invariant so a
    // round-trip through the bus and into `recordEvent` never trips the
    // service-audit validation.
    if (body.actorTenantScopeType === 'system') return;
    if (body.actorUserId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'actorUserId is required when actorTenantScopeType is not `system`',
        path: ['actorUserId'],
      });
    }
  });
export type AuditActionRecorded = z.infer<typeof AuditActionRecordedSchema>;
