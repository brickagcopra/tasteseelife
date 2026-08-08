import { z } from 'zod';

import { NotificationChannelKindSchema, NotificationLocaleSchema } from './notification.schema';

/**
 * Notification dispatch + preferences HTTP DTOs (TS-073; PDD §12.1 channel
 * inventory + §12.3 preferences + quiet hours + senior-mode defaults;
 * CLAUDE.md §12 senior consent + dignity).
 *
 * The TS-072 slice owns templates + render. This file owns:
 *
 *   1. **User preferences** — per-`(user, channel, category)` opt-in
 *      record with optional per-user quiet-hours window + IANA time-zone.
 *      The dispatch pipeline gates every send through these rows; the
 *      default falls fall back to a sane "transactional always allowed,
 *      marketing default off" policy.
 *
 *   2. **Internal dispatch** — every upstream service POSTs to
 *      `/api/v1/internal/notification/dispatch` with a recipient + the
 *      template code + the category + channel-specific recipient address.
 *      The orchestrator (a) resolves the template via the existing render
 *      surface; (b) checks the recipient's preferences + quiet hours;
 *      (c) hands off to the channel adapter (Postmark / Twilio / Firebase)
 *      or suppresses with a typed reason; (d) records a dispatch row.
 *      Idempotent on `idempotencyKey` to defend against upstream retries.
 *
 *   3. **Admin dispatch history** — cursor-paginated read of the dispatch
 *      log for the admin tooling (PRD §10.15).
 *
 * **TCPA / CAN-SPAM**: marketing categories require explicit opt-in; the
 * gate refuses to send unless `opt_in = true`. Transactional categories
 * default to opt-in unless the user has explicitly opted out (rare —
 * password resets and OTPs need to land).
 *
 * **Senior-mode**: the default quiet-hours window for a senior-flagged
 * user is 20:00–08:00 local for marketing kinds; transactional sends
 * bypass quiet hours (an OTP must arrive even at 02:00).
 *
 * **`.strict()` everywhere** — typo in a field name is a 400, not a
 * silently-dropped knob (CLAUDE.md §3.3).
 */

// ─── Bounded length constants ───────────────────────────────────────────

/** Soft-FK to identity.users.id — mirrors NOTIFICATION_AUTHOR_USER_ID_MAX_LENGTH. */
export const NOTIFICATION_USER_ID_MAX_LENGTH = 128;

/** IANA time-zone (`America/New_York`, `Europe/Berlin`). */
export const NOTIFICATION_TIME_ZONE_MAX_LENGTH = 64;

/**
 * Channel-specific recipient address — RFC 5321 caps email locally at 64
 * + global at 255; E.164 SMS at 15 digits + a `+`; FCM/APNs device tokens
 * land at 152–256 chars. 320 is a defensive cap that fits every channel.
 */
export const NOTIFICATION_RECIPIENT_ADDRESS_MAX_LENGTH = 320;

/** Per-send idempotency key (mirrors SUBSCRIPTION_IDEMPOTENCY_KEY shape). */
export const NOTIFICATION_DISPATCH_IDEMPOTENCY_KEY_MAX_LENGTH = 200;
export const NOTIFICATION_DISPATCH_IDEMPOTENCY_KEY_MIN_LENGTH = 16;

/** Free-text error / suppression detail. */
export const NOTIFICATION_DISPATCH_ERROR_DETAIL_MAX_LENGTH = 2_000;

/** Provider message id (Postmark / Twilio / FCM all stay ≤ 100 chars). */
export const NOTIFICATION_PROVIDER_MESSAGE_ID_MAX_LENGTH = 200;

/** Pagination caps for the admin dispatch list. */
export const NOTIFICATION_DISPATCH_LIST_LIMIT_DEFAULT = 50;
export const NOTIFICATION_DISPATCH_LIST_LIMIT_MAX = 200;

/** Minute-of-day bounds for quiet-hours windows. */
export const NOTIFICATION_QUIET_HOURS_MINUTE_MIN = 0;
export const NOTIFICATION_QUIET_HOURS_MINUTE_MAX = 1439;

// ─── Enums ──────────────────────────────────────────────────────────────

/**
 * Notification category. Drives the preference gate + the quiet-hours
 * bypass logic.
 *
 *   - `transactional` — directly tied to a user action: OTP, password
 *     reset, booking confirmation, payment receipt, dispute resolution.
 *     Default opt-in. Bypasses quiet hours for the high-urgency subset
 *     (the dispatch caller flags `bypassQuietHours: true`).
 *
 *   - `marketing` — opt-in only (TCPA / CAN-SPAM). Honors quiet hours.
 *     Examples: newsletters, promotional offers, win-back nudges.
 *
 *   - `system` — operational notices: privacy policy updates,
 *     mandatory-reporter follow-ups, account-locked alerts. Default
 *     opt-in (user can't meaningfully opt out of a privacy update); does
 *     honor quiet hours unless urgent.
 */
export const NotificationCategorySchema = z.enum(['transactional', 'marketing', 'system']);
export type NotificationCategory = z.infer<typeof NotificationCategorySchema>;

/**
 * Dispatch lifecycle status. Recorded on the `notification_dispatches`
 * row.
 *
 *   - `queued`                       — orchestrator accepted; adapter
 *                                      call pending (Phase 1 is sync; the
 *                                      transient state exists for the
 *                                      Phase-2 BullMQ refactor).
 *   - `sent`                         — adapter returned ok + provider id.
 *   - `failed`                       — adapter returned error; the row
 *                                      carries the provider error code.
 *   - `suppressed_by_preference`     — user has opted out of the
 *                                      channel/category pair.
 *   - `suppressed_by_quiet_hours`    — call landed inside quiet-hours
 *                                      window and did not request bypass.
 *   - `suppressed_by_unsubscribed`   — user has globally unsubscribed
 *                                      (CAN-SPAM compliance gate).
 */
export const NotificationDispatchStatusSchema = z.enum([
  'queued',
  'sent',
  'failed',
  'suppressed_by_preference',
  'suppressed_by_quiet_hours',
  'suppressed_by_unsubscribed',
]);
export type NotificationDispatchStatus = z.infer<typeof NotificationDispatchStatusSchema>;

/**
 * Why was a dispatch suppressed? Set on the row when status is one of
 * the `suppressed_by_*` variants. Null otherwise.
 */
export const NotificationSuppressionReasonSchema = z.enum([
  'preference_opted_out',
  'quiet_hours',
  'globally_unsubscribed',
  'recipient_address_missing',
]);
export type NotificationSuppressionReason = z.infer<typeof NotificationSuppressionReasonSchema>;

// ─── Reused field schemas ───────────────────────────────────────────────

const UserIdSchema = z.string().min(1).max(NOTIFICATION_USER_ID_MAX_LENGTH);
const TimeZoneSchema = z.string().min(1).max(NOTIFICATION_TIME_ZONE_MAX_LENGTH);
const RecipientAddressSchema = z.string().min(1).max(NOTIFICATION_RECIPIENT_ADDRESS_MAX_LENGTH);
const ProviderMessageIdSchema = z.string().min(1).max(NOTIFICATION_PROVIDER_MESSAGE_ID_MAX_LENGTH);
const DispatchErrorDetailSchema = z
  .string()
  .min(1)
  .max(NOTIFICATION_DISPATCH_ERROR_DETAIL_MAX_LENGTH);
const IdempotencyKeySchema = z
  .string()
  .min(NOTIFICATION_DISPATCH_IDEMPOTENCY_KEY_MIN_LENGTH)
  .max(NOTIFICATION_DISPATCH_IDEMPOTENCY_KEY_MAX_LENGTH);

const MinuteOfDaySchema = z
  .number()
  .int()
  .min(NOTIFICATION_QUIET_HOURS_MINUTE_MIN)
  .max(NOTIFICATION_QUIET_HOURS_MINUTE_MAX);

// ─── Preferences ────────────────────────────────────────────────────────

/**
 * Quiet-hours window on a user preference row. Stored as minute-of-day
 * `[0, 1440)` integers paired with the user's IANA time-zone — so the
 * gate can reconstruct "is `now` between 20:00 and 08:00 in the user's
 * local time?" without ambiguity around DST shifts.
 *
 * The pair is either both set (a window is configured) or both null
 * (the user has no quiet-hours window — the gate falls back to the
 * senior-mode default if the user is senior-flagged).
 *
 * Wrap-around windows (start > end, e.g. 21:00–08:00 across midnight)
 * are explicitly supported and are the dominant case for senior-mode.
 */
export const QuietHoursWindowSchema = z
  .object({
    startMinuteOfDay: MinuteOfDaySchema,
    endMinuteOfDay: MinuteOfDaySchema,
    timeZone: TimeZoneSchema,
  })
  .strict()
  .refine((window) => window.startMinuteOfDay !== window.endMinuteOfDay, {
    message: 'quiet-hours window cannot be zero-width (start == end)',
  });
export type QuietHoursWindow = z.infer<typeof QuietHoursWindowSchema>;

/**
 * `PUT /api/v1/notification/preferences` upsert request. A user
 * configures preferences as a list of `(channel, category, optIn)` rows;
 * the optional `quietHours` window applies to the entire user (not
 * per-channel — quiet hours are an intrinsic property of "when does this
 * person want a phone notification").
 *
 * The service deletes any row not named in `entries` (full replace) so
 * the wire-shape is unambiguous. Idempotent via the `(user, channel,
 * category)` composite PK.
 */
export const PreferenceEntrySchema = z
  .object({
    channel: NotificationChannelKindSchema,
    category: NotificationCategorySchema,
    optIn: z.boolean(),
  })
  .strict();
export type PreferenceEntry = z.infer<typeof PreferenceEntrySchema>;

export const UpsertPreferencesRequestSchema = z
  .object({
    entries: z.array(PreferenceEntrySchema).max(64),
    quietHours: QuietHoursWindowSchema.nullable().optional(),
  })
  .strict();
export type UpsertPreferencesRequest = z.infer<typeof UpsertPreferencesRequestSchema>;

/**
 * Response shape returned by `GET /api/v1/notification/preferences/me`
 * and as the body of a successful upsert. Echoes the resolved
 * preferences including the senior-mode defaults that the service
 * synthesises for any unrecorded `(channel, category)` pair — so the UI
 * never has to re-derive defaults.
 */
export const ResolvedPreferenceEntrySchema = z
  .object({
    channel: NotificationChannelKindSchema,
    category: NotificationCategorySchema,
    optIn: z.boolean(),
    /** True when the row exists in the DB; false when it's a default. */
    explicit: z.boolean(),
  })
  .strict();
export type ResolvedPreferenceEntry = z.infer<typeof ResolvedPreferenceEntrySchema>;

export const UserPreferencesResponseSchema = z
  .object({
    userId: UserIdSchema,
    entries: z.array(ResolvedPreferenceEntrySchema),
    quietHours: QuietHoursWindowSchema.nullable(),
    seniorMode: z.boolean(),
    updatedAt: z.string().datetime().nullable(),
  })
  .strict();
export type UserPreferencesResponse = z.infer<typeof UserPreferencesResponseSchema>;

// ─── Dispatch (internal) ────────────────────────────────────────────────

/**
 * `POST /api/v1/internal/notification/dispatch` request body.
 *
 * Upstream services that want to send a notification POST this shape
 * with the shared-secret header. The orchestrator resolves
 * `(templateCode, locale)` against the existing template registry,
 * runs the preference + quiet-hours gate, and routes to the channel
 * adapter.
 *
 * `recipientUserId` is the soft-FK into `identity.users.id`. It drives
 * the preference lookup. If the user record has a different verified
 * channel address (e.g. a senior's email lives on the family payer's
 * `users` row), the caller passes the explicit `recipientAddress` to
 * override — the orchestrator never reaches into a sibling service for
 * this.
 *
 * `variables` is the Handlebars substitution payload passed through to
 * the render endpoint.
 *
 * `bypassQuietHours` lets the caller declare "this is urgent enough to
 * land at 02:00" — currently honored only when `category =
 * 'transactional'`. The orchestrator refuses the bypass for marketing
 * and system categories.
 */
export const RenderVariableValueSchema = z.union([
  z.string().max(8_192),
  z.number().finite(),
  z.boolean(),
]);

export const DispatchNotificationRequestSchema = z
  .object({
    recipientUserId: UserIdSchema,
    channel: NotificationChannelKindSchema,
    category: NotificationCategorySchema,
    templateCode: z.string().min(1).max(100),
    locale: NotificationLocaleSchema,
    recipientAddress: RecipientAddressSchema,
    variables: z.record(z.string().min(1).max(80), RenderVariableValueSchema).optional(),
    bypassQuietHours: z.boolean().default(false),
    idempotencyKey: IdempotencyKeySchema,
    /** Optional caller-supplied trace id for cross-service correlation. */
    sourceEventId: z.string().min(1).max(200).optional(),
  })
  .strict();
export type DispatchNotificationRequest = z.infer<typeof DispatchNotificationRequestSchema>;

/**
 * Returned dispatch row. The discriminator is `status` — the suppressed
 * variants carry a `suppressionReason`; the `failed` variant carries
 * `errorMessage`; the `sent` variant carries a `providerMessageId`.
 */
export const DispatchResponseSchema = z
  .object({
    id: z.string().min(1).max(64),
    recipientUserId: UserIdSchema,
    channel: NotificationChannelKindSchema,
    category: NotificationCategorySchema,
    templateCode: z.string().min(1).max(100),
    locale: NotificationLocaleSchema,
    templateVersionId: z.string().min(1).max(64).nullable(),
    recipientAddress: RecipientAddressSchema,
    status: NotificationDispatchStatusSchema,
    suppressionReason: NotificationSuppressionReasonSchema.nullable(),
    providerMessageId: ProviderMessageIdSchema.nullable(),
    errorMessage: DispatchErrorDetailSchema.nullable(),
    idempotencyKey: IdempotencyKeySchema,
    sourceEventId: z.string().min(1).max(200).nullable(),
    occurredAt: z.string().datetime(),
    sentAt: z.string().datetime().nullable(),
    /** True if this is a replay of an already-recorded idempotency key. */
    replayed: z.boolean(),
  })
  .strict();
export type DispatchResponse = z.infer<typeof DispatchResponseSchema>;

/**
 * `GET /api/v1/admin/notification/dispatches` query string. Cursor-paged
 * across the dispatch log with optional channel + category + status
 * filters.
 */
const ListLimitSchema = z.coerce
  .number()
  .int()
  .positive()
  .max(NOTIFICATION_DISPATCH_LIST_LIMIT_MAX)
  .default(NOTIFICATION_DISPATCH_LIST_LIMIT_DEFAULT);

const ListCursorSchema = z.string().min(1).max(512);

export const ListDispatchesQuerySchema = z
  .object({
    recipientUserId: UserIdSchema.optional(),
    channel: NotificationChannelKindSchema.optional(),
    category: NotificationCategorySchema.optional(),
    status: NotificationDispatchStatusSchema.optional(),
    cursor: ListCursorSchema.optional(),
    limit: ListLimitSchema,
  })
  .strict();
export type ListDispatchesQuery = z.infer<typeof ListDispatchesQuerySchema>;

export const DispatchesListResponseSchema = z
  .object({
    dispatches: z.array(DispatchResponseSchema),
    nextCursor: ListCursorSchema.nullable(),
  })
  .strict();
export type DispatchesListResponse = z.infer<typeof DispatchesListResponseSchema>;
