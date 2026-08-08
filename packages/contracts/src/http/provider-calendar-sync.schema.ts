import { z } from 'zod';

/**
 * Provider external-calendar-sync contracts (TS-206).
 *
 * The provider-portal surface for connecting an external calendar
 * (Google first; iCloud + Outlook follow as siblings — TS-206-
 * followup-2) so the provider's external commitments pull into a
 * read-only busy mirror (`provider_availability_external`) that the
 * availability projection unions with the TS-203 recurring windows +
 * date exclusions.
 *
 * Endpoints (service-provider, TS-206 core):
 *
 *   POST   /api/v1/providers/:providerId/calendar/google/connect
 *            → `{ authorizationUrl }` — the Google consent URL the
 *              browser is sent to. The `state` query param on that URL
 *              is an HMAC-signed, TTL-bounded token binding the
 *              providerId + actor (CSRF + identity).
 *
 *   GET    /api/v1/providers/calendar/google/callback?state&code[&error]
 *            → 302 redirect back to the provider portal. Unauthenticated
 *              (Google redirects the browser); the signed `state` is the
 *              identity + CSRF boundary.
 *
 *   GET    /api/v1/providers/me/calendar-connection
 *            → `{ connection: ProviderCalendarConnectionRecord | null }`.
 *
 *   POST   /api/v1/providers/:providerId/calendar/sync
 *            → `{ providerId, externalBusyCount, lastSyncedAt }` — manual
 *              re-pull of the free/busy window. The periodic background
 *              re-sync is TS-206-followup-3.
 *
 *   DELETE /api/v1/providers/:providerId/calendar/google
 *            → `{ providerId, disconnected, removedExternalBusyCount }` —
 *              revokes the token, drops the connection + the busy mirror.
 *
 * **No event content ever crosses this contract.** The busy mirror
 * carries only opaque `[startsAt, endsAt)` intervals — never titles,
 * attendees, locations, or descriptions (the OAuth scope is
 * free/busy-only; see ADR-0003). `.strict()` everywhere rejects unknown
 * fields at the boundary (CLAUDE.md §3.3).
 */

// ─── Bounded length / range constants ───────────────────────────────────

/** Soft FK length cap (providerId). Matches every other provider-domain id cap. */
export const PROVIDER_CALENDAR_ID_MAX_LENGTH = 64;

/**
 * Cap on the connected-account email length. RFC 5321 caps an address at
 * 254 octets; 320 is the historical local(64)+@+domain(255) ceiling we
 * use as a generous bound at the boundary.
 */
export const PROVIDER_CALENDAR_EMAIL_MAX_LENGTH = 320;

/** Cap on the persisted last-sync error message. */
export const PROVIDER_CALENDAR_SYNC_ERROR_MAX_LENGTH = 512;

/**
 * Cap on the number of external busy intervals mirrored per provider in
 * one sync window. A two-week free/busy pull for even a heavily-booked
 * professional calendar sits well under this; the cap bounds the mirror
 * table + the availability-union work and is the contract-level guard
 * against a pathological calendar.
 */
export const PROVIDER_CALENDAR_EXTERNAL_BUSY_MAX = 500;

// ─── Enums ──────────────────────────────────────────────────────────────

/**
 * External calendar provider. Phase-1 ships `google` only; `icloud`
 * (CalDAV) + `outlook` (Microsoft Graph) are appended — never reordered
 * — by TS-206-followup-2 so the enum stays additive.
 */
export const PROVIDER_CALENDAR_PROVIDER_VALUES = ['google'] as const;
export const ProviderCalendarProviderSchema = z.enum(PROVIDER_CALENDAR_PROVIDER_VALUES);
export type ProviderCalendarProvider = z.infer<typeof ProviderCalendarProviderSchema>;

/**
 * Connection health.
 *
 *   `connected` — the refresh token is held + the last sync succeeded.
 *   `error`     — the last sync failed (e.g. Google rejected the refresh
 *                 token — the provider revoked access on Google's side,
 *                 or the grant expired). The provider must reconnect;
 *                 the reconsent prompt is TS-206-followup-5.
 *
 * A disconnected provider has NO connection row at all (the DELETE drops
 * it), so there is no `disconnected` status — `{ connection: null }` is
 * the "not connected" shape.
 */
export const PROVIDER_CALENDAR_CONNECTION_STATUS_VALUES = ['connected', 'error'] as const;
export const ProviderCalendarConnectionStatusSchema = z.enum(
  PROVIDER_CALENDAR_CONNECTION_STATUS_VALUES,
);
export type ProviderCalendarConnectionStatus = z.infer<
  typeof ProviderCalendarConnectionStatusSchema
>;

// ─── Field schemas ──────────────────────────────────────────────────────

const IdSchema = z.string().min(1).max(PROVIDER_CALENDAR_ID_MAX_LENGTH);

// ─── Record (response) shape ────────────────────────────────────────────

/**
 * The materialised calendar-connection shape for one provider. Carries
 * **no** secret material — the refresh token lives only in the encrypted
 * DB column and never crosses this contract.
 *
 *   - `connectedAccountEmail` — the Google account the provider linked.
 *     Low-sensitivity (the provider's own address); nullable because the
 *     `openid email` claim may be absent on a re-grant.
 *   - `externalBusyCount` — number of busy intervals currently mirrored.
 *   - `lastSyncedAt` — last successful free/busy pull (nullable until the
 *     first sync lands).
 *   - `lastSyncError` — last failure message when `status === 'error'`;
 *     null when healthy.
 */
export const ProviderCalendarConnectionRecordSchema = z
  .object({
    providerId: IdSchema,
    calendarProvider: ProviderCalendarProviderSchema,
    status: ProviderCalendarConnectionStatusSchema,
    connectedAccountEmail: z.string().min(1).max(PROVIDER_CALENDAR_EMAIL_MAX_LENGTH).nullable(),
    externalBusyCount: z.number().int().nonnegative().max(PROVIDER_CALENDAR_EXTERNAL_BUSY_MAX),
    lastSyncedAt: z.string().datetime().nullable(),
    lastSyncError: z.string().min(1).max(PROVIDER_CALENDAR_SYNC_ERROR_MAX_LENGTH).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ProviderCalendarConnectionRecord = z.infer<
  typeof ProviderCalendarConnectionRecordSchema
>;

// ─── Endpoint response shapes ───────────────────────────────────────────

/**
 * Response body for `POST .../calendar/google/connect`. Returns the
 * Google consent URL the client navigates the browser to. `url()` so a
 * client never has to guess the shape.
 */
export const StartProviderCalendarConnectionResponseSchema = z
  .object({
    authorizationUrl: z.string().url(),
  })
  .strict();
export type StartProviderCalendarConnectionResponse = z.infer<
  typeof StartProviderCalendarConnectionResponseSchema
>;

/**
 * Response body for `GET /api/v1/providers/me/calendar-connection`.
 * `{ connection: null }` when the provider has not linked a calendar (or
 * has no provider row yet); `{ connection: ... }` once linked. The null
 * branch lets the portal render the "Connect your calendar" empty state
 * without a 404 round-trip.
 */
export const ProviderCalendarConnectionSnapshotResponseSchema = z
  .object({
    connection: ProviderCalendarConnectionRecordSchema.nullable(),
  })
  .strict();
export type ProviderCalendarConnectionSnapshotResponse = z.infer<
  typeof ProviderCalendarConnectionSnapshotResponseSchema
>;

/**
 * Response body for `POST .../calendar/sync`. Reports the post-sync busy
 * count + the timestamp so the portal can render "Last synced …".
 */
export const SyncProviderCalendarResponseSchema = z
  .object({
    providerId: IdSchema,
    externalBusyCount: z.number().int().nonnegative().max(PROVIDER_CALENDAR_EXTERNAL_BUSY_MAX),
    lastSyncedAt: z.string().datetime(),
  })
  .strict();
export type SyncProviderCalendarResponse = z.infer<typeof SyncProviderCalendarResponseSchema>;

/**
 * Response body for `DELETE .../calendar/google`. Idempotent — a delete
 * on an already-disconnected provider returns `disconnected: false` with
 * `removedExternalBusyCount: 0`.
 */
export const DisconnectProviderCalendarResponseSchema = z
  .object({
    providerId: IdSchema,
    disconnected: z.boolean(),
    removedExternalBusyCount: z
      .number()
      .int()
      .nonnegative()
      .max(PROVIDER_CALENDAR_EXTERNAL_BUSY_MAX),
  })
  .strict();
export type DisconnectProviderCalendarResponse = z.infer<
  typeof DisconnectProviderCalendarResponseSchema
>;

// ─── OAuth callback query shape ─────────────────────────────────────────

/**
 * Query params on the Google OAuth redirect (`GET
 * .../calendar/google/callback`). Google sends either `code` (consent
 * granted) or `error` (consent denied / failed). `state` is always
 * present and carries our HMAC-signed identity+CSRF token.
 *
 * Validated leniently at the boundary (caps only) — the signed-state
 * verification in the service is the real gate. The callback is a
 * browser redirect, so it answers with a 302, never a JSON error body.
 */
export const ProviderCalendarOAuthCallbackQuerySchema = z
  .object({
    state: z.string().min(1).max(2048),
    code: z.string().min(1).max(2048).optional(),
    error: z.string().min(1).max(256).optional(),
  })
  .strict();
export type ProviderCalendarOAuthCallbackQuery = z.infer<
  typeof ProviderCalendarOAuthCallbackQuerySchema
>;
