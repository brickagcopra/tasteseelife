import { z } from 'zod';

/**
 * Activity-event HTTP DTOs (TS-101; PDD §17.2 user activity log,
 * PDD §17.3 site-wide activity monitoring).
 *
 * Two halves of the surface:
 *
 *   1. **Internal ingest** — every producer service (service-identity,
 *      service-subscription, service-provider, service-booking, ...)
 *      POSTs to `/api/v1/internal/activity/events` with a producer-
 *      assigned `eventId`, the target `userId`, the categorical `kind`,
 *      the `occurredAt` timestamp, and request metadata (ip, user-agent,
 *      device fingerprint, request id, trace id, small adjunct payload).
 *      The endpoint is shared-secret-pinned and lives behind a TS-151
 *      NetworkPolicy (in-cluster callers only). Idempotent on `eventId`
 *      — a retried submission replays into the existing row.
 *
 *   2. **Read** — two cursor-paginated reads:
 *      - `GET /api/v1/users/me/activity` — user-facing self-view. The
 *        actor sees only their own row stream.
 *      - `GET /api/v1/admin/users/:userId/activity` — admin search.
 *        Permission gating (`activity:read`) lands with the
 *        `PermissionGuard` lift (TS-052-followup-11).
 *
 * **Why this surface, not the audit-svc surface?** PDD §17.1 (admin
 * audit log — every admin mutation, before/after diff, hash chain) and
 * PDD §17.2 (user activity log — what the USER did or what happened to
 * the user's account) overlap in shape but differ in audience: audit is
 * for ops + SOC 2 + trust-safety; activity is for the user to see on a
 * self-service "Activity" page (PRD §6.1 family observer dashboard).
 * The activity stream is intentionally simpler — no hash chain, no
 * before/after diff, no per-resource serialization.
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
export const ACTIVITY_EVENT_ID_MAX_LENGTH = 128;

/**
 * User id cap. Soft FK into `identity.users.id` — CUID2 / UUID v7. 128
 * is defensive headroom.
 */
export const ACTIVITY_USER_ID_MAX_LENGTH = 128;

/**
 * User-Agent cap. UAs commonly land at 200–400 chars; 1024 covers the
 * pathological Edge / Chromium UA strings without enabling a bulk-
 * exfil bucket through the column.
 */
export const ACTIVITY_USER_AGENT_MAX_LENGTH = 1_024;

/**
 * Device-fingerprint cap. Producer-stamped opaque token (e.g. the
 * `userAgent` + `screenHeight` + `tz` hash from the auth surface);
 * bounded at 256 to defend against unbounded strings.
 */
export const ACTIVITY_DEVICE_FINGERPRINT_MAX_LENGTH = 256;

/**
 * Request-id / trace-id cap. UUID / W3C traceparent shapes land at
 * ≤56 chars; 128 is defensive headroom.
 */
export const ACTIVITY_REQUEST_ID_MAX_LENGTH = 128;
export const ACTIVITY_TRACE_ID_MAX_LENGTH = 128;

/**
 * Adjunct metadata cap (stringified-JSON byte ceiling). 8 KiB matches
 * the pragmatic upper bound on a small adjunct payload (e.g. the
 * `subscription_changed` event's `{from: 'tier_1', to: 'tier_2'}`
 * snippet, or the `suspicious_activity_flag` event's reason summary).
 * Much smaller than the audit-svc's 64 KiB cap because the activity
 * stream is for at-a-glance reads, not full state diffs.
 */
export const ACTIVITY_METADATA_PAYLOAD_MAX_BYTES = 8_192;

/**
 * Default + ceiling for list-endpoint `limit` query param.
 */
export const ACTIVITY_LIST_LIMIT_DEFAULT = 50;
export const ACTIVITY_LIST_LIMIT_MAX = 200;

/**
 * Cursor cap. Cursors are base64-encoded `(occurredAt, id)` pairs; 512
 * is comfortably above the realistic encoded size.
 */
export const ACTIVITY_LIST_CURSOR_MAX_LENGTH = 512;

// ─── Activity event kind enum ───────────────────────────────────────────

/**
 * Categorical kind of activity event.
 *
 * Phase-1 kinds covering PDD §17.2's named categories:
 *
 *   Authentication & session
 *     - `login_success`            — successful login
 *     - `login_failure`            — failed login attempt
 *     - `logout`                   — explicit logout
 *     - `password_changed`         — password rotation
 *     - `mfa_enrolled`             — TOTP / SMS method added
 *     - `mfa_removed`              — method removed
 *
 *   Profile & payments
 *     - `profile_changed`          — name / email / etc edit
 *     - `payment_method_added`     — new card / ACH
 *     - `payment_method_removed`   — payment method deleted
 *
 *   Subscription & booking
 *     - `subscription_changed`     — plan switch / cancel / pause / resume
 *     - `booking_created`          — family books a visit
 *     - `booking_canceled`         — family / provider cancels
 *
 *   Role lifecycle (admin-staff users)
 *     - `role_granted`             — admin role assigned
 *     - `role_revoked`             — admin role removed
 *
 *   Trust & safety
 *     - `suspicious_activity_flag` — impossible travel, mass failures,
 *                                    rapid coupon attempts, etc.
 *
 * Future kinds land additively — never repurpose an existing value
 * (CLAUDE.md §5.3 backward-compatible evolution).
 */
export const ActivityEventKindSchema = z.enum([
  'login_success',
  'login_failure',
  'logout',
  'password_changed',
  'mfa_enrolled',
  'mfa_removed',
  'profile_changed',
  'payment_method_added',
  'payment_method_removed',
  'subscription_changed',
  'booking_created',
  'booking_canceled',
  'role_granted',
  'role_revoked',
  'suspicious_activity_flag',
]);
export type ActivityEventKind = z.infer<typeof ActivityEventKindSchema>;

// ─── Reused field schemas ───────────────────────────────────────────────

const EventIdSchema = z.string().min(1).max(ACTIVITY_EVENT_ID_MAX_LENGTH);
const UserIdSchema = z.string().min(1).max(ACTIVITY_USER_ID_MAX_LENGTH);
const UserAgentSchema = z.string().min(1).max(ACTIVITY_USER_AGENT_MAX_LENGTH);
const DeviceFingerprintSchema = z.string().min(1).max(ACTIVITY_DEVICE_FINGERPRINT_MAX_LENGTH);
const RequestIdSchema = z.string().min(1).max(ACTIVITY_REQUEST_ID_MAX_LENGTH);
const TraceIdSchema = z.string().min(1).max(ACTIVITY_TRACE_ID_MAX_LENGTH);

/**
 * IP-address shape — IPv4 dotted-quad or IPv6 colon-separated. The
 * column is `INET` so we let Postgres canonicalise; the wire layer
 * just validates "non-empty + bounded".
 */
const IpSchema = z.string().min(1).max(45); // 45 = max INET text length (IPv6 + ipv4-mapped)

/**
 * Adjunct metadata payload — arbitrary JSON keyed at the wire layer.
 * The stringified-byte cap is enforced by `superRefine` because Zod
 * can't express a payload-size cap natively.
 */
const MetadataSchema = z.unknown().refine(
  (value) => {
    if (value === undefined) return true;
    try {
      return JSON.stringify(value).length <= ACTIVITY_METADATA_PAYLOAD_MAX_BYTES;
    } catch {
      // Circular / non-serialisable → invalid by definition.
      return false;
    }
  },
  {
    message: `metadata payload exceeds ${ACTIVITY_METADATA_PAYLOAD_MAX_BYTES} bytes after JSON serialisation`,
  },
);

// ─── Internal ingest request ────────────────────────────────────────────

/**
 * `POST /api/v1/internal/activity/events` request body.
 *
 * Cross-service producers stamp every notable user-visible event with a
 * fresh `eventId` and POST the resulting envelope. The activity service
 * is idempotent on `eventId` — a retried submission replays into the
 * existing row.
 *
 * **`userId` is required.** Every activity event has a target user
 * (the activity stream is per-user). System-driven jobs that touch a
 * user's record (e.g. a scheduled subscription renewal) stamp the
 * affected user's id; jobs that don't target a user write to the
 * audit-svc, not here.
 *
 * **`metadata` is for small adjuncts.** Bounded at 8 KiB
 * stringified. Use the audit-svc for full state diffs.
 */
export const RecordActivityEventRequestSchema = z
  .object({
    eventId: EventIdSchema,
    userId: UserIdSchema,
    kind: ActivityEventKindSchema,
    occurredAt: z.string().datetime(),
    ip: IpSchema.nullable().optional(),
    userAgent: UserAgentSchema.nullable().optional(),
    deviceFingerprint: DeviceFingerprintSchema.nullable().optional(),
    requestId: RequestIdSchema.nullable().optional(),
    traceId: TraceIdSchema.nullable().optional(),
    metadata: MetadataSchema.nullable().optional(),
  })
  .strict();
export type RecordActivityEventRequest = z.infer<typeof RecordActivityEventRequestSchema>;

// ─── Activity event response shape ──────────────────────────────────────

/**
 * Activity event response shape — projected from the persisted row.
 * Returned by every read endpoint (self-view, admin view).
 */
export const ActivityEventResponseSchema = z
  .object({
    id: z.string().min(1),
    eventId: EventIdSchema,
    userId: UserIdSchema,
    kind: ActivityEventKindSchema,
    occurredAt: z.string().datetime(),
    ip: z.string().min(1).nullable(),
    userAgent: z.string().min(1).nullable(),
    deviceFingerprint: z.string().min(1).nullable(),
    requestId: z.string().min(1).nullable(),
    traceId: z.string().min(1).nullable(),
    metadata: z.unknown().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type ActivityEventResponse = z.infer<typeof ActivityEventResponseSchema>;

/**
 * `POST /api/v1/internal/activity/events` response shape.
 *
 *   - `outcome: 'recorded'`  — a new event was persisted.
 *   - `outcome: 'replayed'`  — the eventId was already on file; the
 *                              existing row is returned unchanged.
 */
export const RecordActivityEventResponseSchema = z
  .object({
    outcome: z.enum(['recorded', 'replayed']),
    event: ActivityEventResponseSchema,
  })
  .strict();
export type RecordActivityEventResponse = z.infer<typeof RecordActivityEventResponseSchema>;

// ─── List endpoints: query + response ───────────────────────────────────

const CursorSchema = z.string().min(1).max(ACTIVITY_LIST_CURSOR_MAX_LENGTH);
const LimitSchema = z.coerce
  .number()
  .int()
  .positive()
  .max(ACTIVITY_LIST_LIMIT_MAX)
  .default(ACTIVITY_LIST_LIMIT_DEFAULT);

/**
 * `GET /api/v1/users/me/activity` query string.
 *
 * The actor's `userId` comes from the access token; no `userId` query
 * param is accepted on this endpoint (would be a row-level-access
 * smell). Optional `kind` filter narrows the stream to a single
 * category.
 */
export const ListMyActivityQuerySchema = z
  .object({
    kind: ActivityEventKindSchema.optional(),
    cursor: CursorSchema.optional(),
    limit: LimitSchema,
  })
  .strict();
export type ListMyActivityQuery = z.infer<typeof ListMyActivityQuerySchema>;

/**
 * `GET /api/v1/admin/users/:userId/activity` query string. The `userId`
 * lives on the route path; this query shape covers only the filter +
 * pagination params.
 */
export const ListUserActivityQuerySchema = z
  .object({
    kind: ActivityEventKindSchema.optional(),
    cursor: CursorSchema.optional(),
    limit: LimitSchema,
  })
  .strict();
export type ListUserActivityQuery = z.infer<typeof ListUserActivityQuerySchema>;

/**
 * Cursor-paginated list response. `nextCursor` is null when the
 * caller has reached the end of the result set.
 */
export const ActivityEventsListResponseSchema = z
  .object({
    events: z.array(ActivityEventResponseSchema),
    nextCursor: z.string().min(1).max(ACTIVITY_LIST_CURSOR_MAX_LENGTH).nullable(),
  })
  .strict();
export type ActivityEventsListResponse = z.infer<typeof ActivityEventsListResponseSchema>;
