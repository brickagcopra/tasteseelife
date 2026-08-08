import { z } from 'zod';

/**
 * Audit-event HTTP DTOs (TS-100; PDD §17.1 admin audit log, PDD §17.2
 * user activity log, PDD §17.3 site-wide activity monitoring; CLAUDE.md
 * §3.6 append-only + hash chain; CLAUDE.md §17.7 mutating audit log
 * entries is an absolute prohibition).
 *
 * Two halves of the surface:
 *
 *   1. **Internal ingest** — every producer service (service-identity,
 *      service-subscription, service-provider, service-booking, ...)
 *      POSTs to `/api/v1/internal/audit/events` with a producer-assigned
 *      `eventId`, the actor + action + resource + before/after diff,
 *      and request metadata. The endpoint is shared-secret-pinned and
 *      lives behind a TS-151 NetworkPolicy (in-cluster callers only).
 *      Idempotent on `eventId` — a retried submission replays into the
 *      existing row.
 *
 *   2. **Admin read** — the admin tooling reads audit events two ways:
 *      by resource (`/by-resource?resourceKind=&resourceId=&cursor=&limit=`)
 *      and by actor (`/by-actor?actorUserId=&cursor=&limit=`). Both
 *      paginate by `(occurredAt, eventId)` cursor (CLAUDE.md §5.1
 *      cursor-based pagination for activity feeds).
 *
 * **`.strict()` everywhere** — unknown fields are a parse error so a
 * typo or a stray client field never silently round-trips
 * (CLAUDE.md §3.3).
 */

// ─── Bounded length constants ───────────────────────────────────────────

/**
 * Producer-assigned event id cap. CUID2 / UUID v7 land at ≤32 chars;
 * 128 leaves headroom for any future id shape without removing the
 * defence against unbounded strings.
 */
export const AUDIT_EVENT_ID_MAX_LENGTH = 128;

/**
 * Action name cap. Permission-string shape (`resource:action`) is
 * always short (≤64 chars in practice); 200 leaves room for namespaced
 * future actions (e.g. `accounting.period:close`).
 */
export const AUDIT_ACTION_MAX_LENGTH = 200;

/**
 * Resource-kind cap. Always short — `subscription`, `booking`,
 * `coupon`, etc. — but bounded so a stray string can't blow up the
 * downstream payload.
 */
export const AUDIT_RESOURCE_KIND_MAX_LENGTH = 100;

/**
 * Resource id cap. CUID2 / UUID v7 / Stripe id shapes all land
 * comfortably below 128; the cap is a defence against unbounded
 * strings, not a real-world limit.
 */
export const AUDIT_RESOURCE_ID_MAX_LENGTH = 256;

/**
 * Actor role cap. Free TEXT but bounded so an attacker can't push
 * megabytes through the column. Role names land at ≤40 chars in
 * practice.
 */
export const AUDIT_ACTOR_ROLE_MAX_LENGTH = 100;

/**
 * Actor user-id cap. Soft FK into `identity.users.id` — CUID2 / UUID
 * v7. 128 is defensive headroom.
 */
export const AUDIT_ACTOR_USER_ID_MAX_LENGTH = 128;

/**
 * Tenant-scope id cap. Soft FK into a partner / household / org id —
 * CUID2 shape today, 128 is defensive headroom.
 */
export const AUDIT_TENANT_SCOPE_ID_MAX_LENGTH = 128;

/**
 * User-Agent cap. UAs commonly land at 200–400 chars; 1024 covers the
 * pathological Edge / Chromium UA strings without enabling a bulk-
 * exfil bucket.
 */
export const AUDIT_USER_AGENT_MAX_LENGTH = 1_024;

/**
 * Request-id / trace-id cap. UUID / W3C traceparent shapes land at
 * ≤56 chars; 128 is defensive headroom.
 */
export const AUDIT_REQUEST_ID_MAX_LENGTH = 128;
export const AUDIT_TRACE_ID_MAX_LENGTH = 128;

/**
 * Before / after JSON payload cap. Stringified-JSON length ceiling.
 * 64 KiB matches the pragmatic upper bound on a diff payload: a typed
 * subscription / booking row stringifies to ≤8 KiB; the headroom
 * absorbs nested resource snapshots without enabling a bulk-exfil
 * bucket through the JSONB column.
 */
export const AUDIT_JSON_PAYLOAD_MAX_BYTES = 65_536;

/**
 * Default + ceiling for list-endpoint `limit` query param.
 */
export const AUDIT_LIST_LIMIT_DEFAULT = 50;
export const AUDIT_LIST_LIMIT_MAX = 200;

/**
 * Cursor cap. Cursors are base64-encoded `(occurredAt, eventId)` pairs;
 * 512 is comfortably above the realistic encoded size.
 */
export const AUDIT_LIST_CURSOR_MAX_LENGTH = 512;

// ─── Actor tenant-scope enum ────────────────────────────────────────────

/**
 * Actor tenant-scope kind. Mirrors the identity service's
 * `user_role_scope_type` enum but lives here at the wire layer so the
 * contract is self-contained.
 *
 *   - `global`    — acting platform-wide (e.g. super_admin)
 *   - `tenant`    — scoped to a partner / org
 *   - `household` — scoped to a household
 *   - `system`    — automated / job-driven mutation; no human actor
 */
export const ActorTenantScopeTypeSchema = z.enum(['global', 'tenant', 'household', 'system']);
export type ActorTenantScopeType = z.infer<typeof ActorTenantScopeTypeSchema>;

// ─── Reused field schemas ───────────────────────────────────────────────

const EventIdSchema = z.string().min(1).max(AUDIT_EVENT_ID_MAX_LENGTH);
const ActionSchema = z.string().min(1).max(AUDIT_ACTION_MAX_LENGTH);
const ResourceKindSchema = z.string().min(1).max(AUDIT_RESOURCE_KIND_MAX_LENGTH);
const ResourceIdSchema = z.string().min(1).max(AUDIT_RESOURCE_ID_MAX_LENGTH);
const ActorRoleSchema = z.string().min(1).max(AUDIT_ACTOR_ROLE_MAX_LENGTH);
const ActorUserIdSchema = z.string().min(1).max(AUDIT_ACTOR_USER_ID_MAX_LENGTH);
const TenantScopeIdSchema = z.string().min(1).max(AUDIT_TENANT_SCOPE_ID_MAX_LENGTH);
const UserAgentSchema = z.string().min(1).max(AUDIT_USER_AGENT_MAX_LENGTH);
const RequestIdSchema = z.string().min(1).max(AUDIT_REQUEST_ID_MAX_LENGTH);
const TraceIdSchema = z.string().min(1).max(AUDIT_TRACE_ID_MAX_LENGTH);

/**
 * IP-address shape — IPv4 dotted-quad or IPv6 colon-separated. The
 * column is `INET` so we let Postgres canonicalise; the wire layer
 * just validates "non-empty + bounded".
 */
const IpSchema = z.string().min(1).max(45); // 45 = max INET text length (IPv6 + ipv4-mapped)

/**
 * Diff payload — arbitrary JSON keyed at the wire layer. The
 * stringified-byte cap is enforced by `superRefine` because Zod can't
 * express a payload-size cap natively.
 */
const DiffJsonSchema = z.unknown().refine(
  (value) => {
    if (value === undefined) return true;
    try {
      return JSON.stringify(value).length <= AUDIT_JSON_PAYLOAD_MAX_BYTES;
    } catch {
      // Circular / non-serialisable → invalid by definition.
      return false;
    }
  },
  {
    message: `diff payload exceeds ${AUDIT_JSON_PAYLOAD_MAX_BYTES} bytes after JSON serialisation`,
  },
);

// ─── Internal ingest request ────────────────────────────────────────────

/**
 * `POST /api/v1/internal/audit/events` request body.
 *
 * Cross-service producers stamp every mutating action with a fresh
 * `eventId` and POST the resulting envelope. The audit service is
 * idempotent on `eventId` — a retried submission replays into the
 * existing row.
 *
 * **`actorUserId` / `actorRole` are nullable** to support system-
 * driven events (BullMQ jobs, scheduled workers). In that case
 * `actorTenantScopeType` must be `system`. The service-layer code
 * enforces this consistency.
 *
 * **`beforeJson` / `afterJson`** — a create event omits `beforeJson`;
 * a delete event omits `afterJson`. The contract layer doesn't enforce
 * this because some actions (e.g. an external-state-driven `update`)
 * don't have a meaningful before/after pair and stamp both as null.
 */
export const RecordAuditEventRequestSchema = z
  .object({
    eventId: EventIdSchema,
    occurredAt: z.string().datetime(),
    actorUserId: ActorUserIdSchema.nullable().optional(),
    actorRole: ActorRoleSchema.nullable().optional(),
    actorTenantScopeType: ActorTenantScopeTypeSchema,
    actorTenantScopeId: TenantScopeIdSchema.nullable().optional(),
    action: ActionSchema,
    resourceKind: ResourceKindSchema,
    resourceId: ResourceIdSchema,
    beforeJson: DiffJsonSchema.nullable().optional(),
    afterJson: DiffJsonSchema.nullable().optional(),
    ip: IpSchema.nullable().optional(),
    userAgent: UserAgentSchema.nullable().optional(),
    requestId: RequestIdSchema.nullable().optional(),
    traceId: TraceIdSchema.nullable().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    // System-scoped events have no human actor; non-system scopes
    // require one. This is the only cross-field invariant on the
    // ingest shape.
    if (body.actorTenantScopeType === 'system') {
      // System events MAY supply an actorUserId if the upstream wants
      // to identify the system component, but it isn't required.
      return;
    }
    if (body.actorUserId === undefined || body.actorUserId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'actorUserId is required when actorTenantScopeType is not `system`',
        path: ['actorUserId'],
      });
    }
  });
export type RecordAuditEventRequest = z.infer<typeof RecordAuditEventRequestSchema>;

// ─── Audit event response shape ─────────────────────────────────────────

/**
 * Audit event response shape — projected from the persisted row. The
 * `chainPrevHash` / `chainHash` fields are returned so an admin caller
 * can verify the integrity of a returned slice client-side without a
 * separate fetch. The full chain-verification surface is captured as
 * TS-100-followup-2 (verifyChain admin endpoint).
 */
export const AuditEventResponseSchema = z
  .object({
    id: z.string().min(1),
    eventId: EventIdSchema,
    occurredAt: z.string().datetime(),
    actorUserId: z.string().min(1).nullable(),
    actorRole: z.string().min(1).nullable(),
    actorTenantScopeType: ActorTenantScopeTypeSchema,
    actorTenantScopeId: z.string().min(1).nullable(),
    action: ActionSchema,
    resourceKind: ResourceKindSchema,
    resourceId: ResourceIdSchema,
    beforeJson: z.unknown().nullable(),
    afterJson: z.unknown().nullable(),
    ip: z.string().min(1).nullable(),
    userAgent: z.string().min(1).nullable(),
    requestId: z.string().min(1).nullable(),
    traceId: z.string().min(1).nullable(),
    chainPrevHash: z.string().length(64).nullable(),
    chainHash: z.string().length(64),
    createdAt: z.string().datetime(),
  })
  .strict();
export type AuditEventResponse = z.infer<typeof AuditEventResponseSchema>;

/**
 * `POST /api/v1/internal/audit/events` response shape.
 *
 *   - `outcome: 'recorded'`  — a new event was persisted.
 *   - `outcome: 'replayed'`  — the eventId was already on file; the
 *                              existing row is returned unchanged.
 */
export const RecordAuditEventResponseSchema = z
  .object({
    outcome: z.enum(['recorded', 'replayed']),
    event: AuditEventResponseSchema,
  })
  .strict();
export type RecordAuditEventResponse = z.infer<typeof RecordAuditEventResponseSchema>;

// ─── List endpoints: query + response ───────────────────────────────────

const CursorSchema = z.string().min(1).max(AUDIT_LIST_CURSOR_MAX_LENGTH);
const LimitSchema = z.coerce
  .number()
  .int()
  .positive()
  .max(AUDIT_LIST_LIMIT_MAX)
  .default(AUDIT_LIST_LIMIT_DEFAULT);

/**
 * `GET /api/v1/admin/audit/events/by-resource` query string.
 */
export const ListAuditEventsByResourceQuerySchema = z
  .object({
    resourceKind: ResourceKindSchema,
    resourceId: ResourceIdSchema,
    cursor: CursorSchema.optional(),
    limit: LimitSchema,
  })
  .strict();
export type ListAuditEventsByResourceQuery = z.infer<typeof ListAuditEventsByResourceQuerySchema>;

/**
 * `GET /api/v1/admin/audit/events/by-actor` query string.
 */
export const ListAuditEventsByActorQuerySchema = z
  .object({
    actorUserId: ActorUserIdSchema,
    cursor: CursorSchema.optional(),
    limit: LimitSchema,
  })
  .strict();
export type ListAuditEventsByActorQuery = z.infer<typeof ListAuditEventsByActorQuerySchema>;

/**
 * Max number of resource kinds one `by-resource-kind` query may name.
 * The dominant caller (the RBAC History view, TS-295) names three
 * (`rbac_role`, `rbac_assignment`, `rbac_approval`); 5 leaves headroom
 * without letting a caller turn the endpoint into a full-table sweep.
 */
export const AUDIT_LIST_RESOURCE_KINDS_MAX = 5;

/**
 * `GET /api/v1/admin/audit/events/by-resource-kind` query string
 * (TS-295). A KIND-WIDE listing — "every event for these resource
 * kinds" — powering cross-resource history views (the RBAC History
 * page lists role + assignment + approval changes in one stream). The
 * per-resource trail stays on `by-resource`.
 *
 *   - `resourceKinds` — CSV of 1..5 kinds (each bounded like
 *     `resourceKind`). CSV keeps the wire shape a plain string; the
 *     service splits.
 *   - `action` — optional EXACT action-string filter (drives the
 *     action filter chips; served by the `(action, occurred_at)` index
 *     when selective).
 *   - `actorUserId` — optional exact actor filter.
 *   - `order` — `desc` (default, newest first) or `asc`; both are a
 *     directional scan of `audit_events_kind_occurred_idx`.
 */
export const ListAuditEventsByResourceKindQuerySchema = z
  .object({
    resourceKinds: z
      .string()
      .min(1)
      .max((AUDIT_RESOURCE_KIND_MAX_LENGTH + 1) * AUDIT_LIST_RESOURCE_KINDS_MAX)
      .superRefine((csv, ctx) => {
        const kinds = csv.split(',');
        if (kinds.length > AUDIT_LIST_RESOURCE_KINDS_MAX) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `at most ${AUDIT_LIST_RESOURCE_KINDS_MAX} resource kinds per query`,
          });
          return;
        }
        for (const kind of kinds) {
          const trimmed = kind.trim();
          if (trimmed.length === 0 || trimmed.length > AUDIT_RESOURCE_KIND_MAX_LENGTH) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `every resource kind must be 1..${AUDIT_RESOURCE_KIND_MAX_LENGTH} chars (offending segment: "${kind}")`,
            });
            return;
          }
        }
      }),
    action: ActionSchema.optional(),
    actorUserId: ActorUserIdSchema.optional(),
    order: z.enum(['desc', 'asc']).default('desc'),
    cursor: CursorSchema.optional(),
    limit: LimitSchema,
  })
  .strict();
export type ListAuditEventsByResourceKindQuery = z.infer<
  typeof ListAuditEventsByResourceKindQuerySchema
>;

/**
 * Split + trim a validated `resourceKinds` CSV into its kinds,
 * de-duplicated, order preserved. Shared by the service and the
 * gateway proxy so both sides split identically.
 */
export function parseResourceKindsCsv(csv: string): readonly string[] {
  const seen = new Set<string>();
  const kinds: string[] = [];
  for (const segment of csv.split(',')) {
    const kind = segment.trim();
    if (kind.length > 0 && !seen.has(kind)) {
      seen.add(kind);
      kinds.push(kind);
    }
  }
  return kinds;
}

/**
 * Cursor-paginated list response. `nextCursor` is null when the
 * caller has reached the end of the result set.
 */
export const AuditEventsListResponseSchema = z
  .object({
    events: z.array(AuditEventResponseSchema),
    nextCursor: z.string().min(1).max(AUDIT_LIST_CURSOR_MAX_LENGTH).nullable(),
  })
  .strict();
export type AuditEventsListResponse = z.infer<typeof AuditEventsListResponseSchema>;
