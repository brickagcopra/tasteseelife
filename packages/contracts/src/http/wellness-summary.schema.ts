import { z } from 'zod';

import { UserStatusSchema } from './auth.schema';
import { MySeniorStatusSchema } from './my-seniors.schema';
import type { NotificationCategory } from './notification-dispatch.schema';
import type {
  NotificationChannelKind,
  NotificationLocale,
  NotificationVariableEntry,
} from './notification.schema';
import {
  WELLNESS_TREND_SCORE_MAX,
  WELLNESS_TREND_SCORE_MIN,
  WELLNESS_TREND_SENIOR_ID_MAX_LENGTH,
  WellnessTrendMetricSchema,
  WellnessTrendWindowDaysSchema,
} from './wellness-trends.schema';

/**
 * Internal contract surfaces for the monthly wellness-summary worker
 * (TS-235; PRD §6.4, §6.9; PDD §12.2).
 *
 * The worker is a cross-service aggregator. It has no DB of its own — it
 * joins three internal reads and dispatches one notification per
 * recipient:
 *
 *   1. service-household → `InternalWellnessSummaryHouseholdsResponse`
 *      The cursor-paginated batch of active households, each carrying
 *      its active seniors (id, name, status, the senior's `notes`
 *      consent flag) + its active recipients (userId + membership role).
 *
 *   2. service-identity → `InternalRecipientContactsResponse`
 *      Resolves a batch of recipient userIds to their email + account
 *      status (the household batch has no emails — those live in
 *      `identity.users`).
 *
 *   3. service-booking → `InternalSeniorWellnessObservationSummaryResponse`
 *      The prior-N-day observation summary per senior (latest + mean of
 *      each wellness scale + the visit count), reusing the TS-231
 *      `WellnessTrendsService` math.
 *
 * Every shape here is INTERNAL — consumed only by the worker over a
 * shared-secret-pinned in-cluster call, never by a browser. They are
 * registered in the OpenAPI artifact for drift detection + partner-doc
 * completeness, same as the TS-208 visit-prep internal snapshot.
 *
 * Consent (CLAUDE.md §12). The household batch carries each senior's
 * `notesConsent` flag so the worker can gate observation DETAIL in the
 * email: the `primary_payer` / `senior_user` recipients always receive
 * detail (they manage the account / are the senior); a `family_observer`
 * receives detail only when the senior shared `notes`. The gate lives in
 * the worker's variable builder — these contracts only carry the inputs.
 */

// ─── Shared bounds ──────────────────────────────────────────────────────

/** Soft-FK id ceiling shared across the surfaces (matches CUID length). */
export const WELLNESS_SUMMARY_ID_MAX_LENGTH = WELLNESS_TREND_SENIOR_ID_MAX_LENGTH;

/** Senior display name ceiling (mirrors `my-seniors` NAME_MAX_LENGTH). */
export const WELLNESS_SUMMARY_NAME_MAX_LENGTH = 200;

/** Email address ceiling — fits every channel's address (mirrors dispatch). */
export const WELLNESS_SUMMARY_EMAIL_MAX_LENGTH = 320;

/** Default + max page size for the household batch read. */
export const WELLNESS_SUMMARY_HOUSEHOLD_PAGE_LIMIT_DEFAULT = 100;
export const WELLNESS_SUMMARY_HOUSEHOLD_PAGE_LIMIT_MAX = 500;

/** Max userIds resolvable in one identity recipient-contacts batch. */
export const WELLNESS_SUMMARY_RECIPIENT_BATCH_MAX = 500;

/** Opaque cursor ceiling for the household batch keyset pagination. */
const HOUSEHOLD_CURSOR_MAX_LENGTH = 512;

const IdSchema = z.string().min(1).max(WELLNESS_SUMMARY_ID_MAX_LENGTH);

// ─── service-household → households batch ───────────────────────────────

/**
 * Recipient membership role inside a household. Mirrors the
 * `household.household_member_role` enum — drives the consent gate (only
 * `family_observer` recipients are masked when the senior hasn't shared
 * `notes`).
 */
export const WellnessSummaryRecipientRoleSchema = z.enum([
  'primary_payer',
  'family_observer',
  'senior_user',
]);
export type WellnessSummaryRecipientRole = z.infer<typeof WellnessSummaryRecipientRoleSchema>;

/**
 * One active senior in a household. `notesConsent` is the senior's
 * TS-238 `notes` consent flag (default false = opt-out); the worker uses
 * it to gate observation detail for family-observer recipients.
 */
export const WellnessSummarySeniorSchema = z
  .object({
    seniorId: IdSchema,
    firstName: z.string().min(1).max(WELLNESS_SUMMARY_NAME_MAX_LENGTH),
    status: MySeniorStatusSchema,
    notesConsent: z.boolean(),
  })
  .strict();
export type WellnessSummarySenior = z.infer<typeof WellnessSummarySeniorSchema>;

/**
 * One active household member to notify. `userId` is the soft-FK into
 * `identity.users.id`; the worker resolves the email via the identity
 * recipient-contacts batch. The senior end-user (`senior_user`) is
 * included only when they hold an active membership row with a login.
 */
export const WellnessSummaryRecipientSchema = z
  .object({
    userId: IdSchema,
    role: WellnessSummaryRecipientRoleSchema,
  })
  .strict();
export type WellnessSummaryRecipient = z.infer<typeof WellnessSummaryRecipientSchema>;

/**
 * One household in the batch. Only ACTIVE households with at least one
 * active senior AND at least one active recipient are returned — a
 * household with nobody to notify, or no senior to summarise, is
 * skipped server-side so the worker never iterates an empty unit.
 */
export const WellnessSummaryHouseholdSchema = z
  .object({
    householdId: IdSchema,
    seniors: z.array(WellnessSummarySeniorSchema).min(1),
    recipients: z.array(WellnessSummaryRecipientSchema).min(1),
  })
  .strict();
export type WellnessSummaryHousehold = z.infer<typeof WellnessSummaryHouseholdSchema>;

/**
 * Query string for `GET /api/v1/internal/wellness-summary/households`.
 * Keyset cursor pagination ordered by `householdId` so the worker can
 * walk the entire population in bounded pages.
 */
export const InternalWellnessSummaryHouseholdsQuerySchema = z
  .object({
    cursor: z.string().min(1).max(HOUSEHOLD_CURSOR_MAX_LENGTH).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(WELLNESS_SUMMARY_HOUSEHOLD_PAGE_LIMIT_MAX)
      .default(WELLNESS_SUMMARY_HOUSEHOLD_PAGE_LIMIT_DEFAULT),
  })
  .strict();
export type InternalWellnessSummaryHouseholdsQuery = z.infer<
  typeof InternalWellnessSummaryHouseholdsQuerySchema
>;

/**
 * Response body for the households batch. `nextCursor` is the last
 * household id of the page when a further page may exist, else null.
 */
export const InternalWellnessSummaryHouseholdsResponseSchema = z
  .object({
    households: z.array(WellnessSummaryHouseholdSchema),
    nextCursor: z.string().min(1).max(HOUSEHOLD_CURSOR_MAX_LENGTH).nullable(),
  })
  .strict();
export type InternalWellnessSummaryHouseholdsResponse = z.infer<
  typeof InternalWellnessSummaryHouseholdsResponseSchema
>;

// ─── service-identity → recipient contacts batch ────────────────────────

/**
 * Request body for `POST /api/v1/internal/identity/recipient-contacts`.
 * A batch of userIds the worker wants email + status for. Capped so a
 * single household-page's recipients resolve in one round-trip.
 */
export const InternalRecipientContactsRequestSchema = z
  .object({
    userIds: z.array(IdSchema).min(1).max(WELLNESS_SUMMARY_RECIPIENT_BATCH_MAX),
  })
  .strict();
export type InternalRecipientContactsRequest = z.infer<
  typeof InternalRecipientContactsRequestSchema
>;

/**
 * One resolved recipient contact. `email` is the account login address
 * (always present in identity). `status` lets the worker skip
 * non-`active` accounts (suspended / deactivated / pending). A userId
 * with no matching user row is simply absent from `contacts`.
 */
export const RecipientContactSchema = z
  .object({
    userId: IdSchema,
    email: z.string().email().max(WELLNESS_SUMMARY_EMAIL_MAX_LENGTH),
    status: UserStatusSchema,
  })
  .strict();
export type RecipientContact = z.infer<typeof RecipientContactSchema>;

/** Response body for the recipient-contacts batch. */
export const InternalRecipientContactsResponseSchema = z
  .object({
    contacts: z.array(RecipientContactSchema),
  })
  .strict();
export type InternalRecipientContactsResponse = z.infer<
  typeof InternalRecipientContactsResponseSchema
>;

// ─── service-booking → senior observation summary ───────────────────────

/**
 * Per-scale roll-up of a senior's wellness observations over the window.
 * `latestScore` is the most-recent recorded reading; `averageScore` is
 * the mean of every recorded reading (rounded to one decimal);
 * `visitsRecorded` is how many visits captured this scale. All-null when
 * the scale was never recorded in the window.
 */
export const WellnessObservationMetricSummarySchema = z
  .object({
    metric: WellnessTrendMetricSchema,
    latestScore: z
      .number()
      .int()
      .min(WELLNESS_TREND_SCORE_MIN)
      .max(WELLNESS_TREND_SCORE_MAX)
      .nullable(),
    averageScore: z.number().min(WELLNESS_TREND_SCORE_MIN).max(WELLNESS_TREND_SCORE_MAX).nullable(),
    visitsRecorded: z.number().int().nonnegative(),
  })
  .strict();
export type WellnessObservationMetricSummary = z.infer<
  typeof WellnessObservationMetricSummarySchema
>;

/**
 * Response body for
 * `GET /api/v1/internal/bookings/households/:householdId/seniors/:seniorId/wellness-observation-summary`.
 *
 * The compact monthly roll-up the worker folds into the email. Unlike
 * the TS-231 per-visit trend series, this carries only the headline
 * numbers (latest + mean + count) per scale — the email is a summary,
 * not a chart.
 */
export const InternalSeniorWellnessObservationSummaryResponseSchema = z
  .object({
    seniorId: IdSchema,
    windowDays: WellnessTrendWindowDaysSchema,
    totalCompletedVisits: z.number().int().nonnegative(),
    metrics: z.array(WellnessObservationMetricSummarySchema),
    generatedAt: z.string().datetime(),
  })
  .strict();
export type InternalSeniorWellnessObservationSummaryResponse = z.infer<
  typeof InternalSeniorWellnessObservationSummaryResponseSchema
>;

// ─── Notification template definition (shared seed ⇄ worker contract) ───

/**
 * The monthly wellness-summary notification template's identity +
 * variable contract (TS-235). Lives here — not in service-notification
 * or the worker — because PDD §12.2 mandates that template variables are
 * "strictly typed via shared contract package": the service-notification
 * seed (`seedWellnessSummaryTemplate`) declares EXACTLY these variables,
 * and the worker's dispatch call supplies EXACTLY these variables. The
 * render endpoint rejects a dispatch that omits a required variable or
 * sends an unknown one, so the two sides MUST agree — this constant is
 * the single source they both import.
 *
 * The MJML body + subject copy stay in the seed (presentation detail,
 * service-notification-local); only the wire-contract (code, locale,
 * channel, category, variable shape) is shared.
 */
export const WELLNESS_SUMMARY_TEMPLATE_CODE = 'wellness-summary-monthly';
export const WELLNESS_SUMMARY_TEMPLATE_LOCALE: NotificationLocale = 'en-US';
export const WELLNESS_SUMMARY_TEMPLATE_CHANNEL: NotificationChannelKind = 'email';
/**
 * Transactional, not marketing — a wellness summary about a loved one is
 * a service communication the family opted into by subscribing, so it
 * defaults opt-in and is not gated by the marketing opt-out (TCPA /
 * CAN-SPAM). It still honours quiet hours unless the caller bypasses.
 */
export const WELLNESS_SUMMARY_TEMPLATE_CATEGORY: NotificationCategory = 'transactional';

/**
 * The variables the template declares and the worker supplies. `detailShared`
 * gates the observation-detail block (false for a family observer the senior
 * hasn't shared `notes` with — CLAUDE.md §12); the four scale summaries are
 * still passed (empty string) so the render-time variable validation passes,
 * and the template's `{{#if detailShared}}` block decides display.
 */
export const WELLNESS_SUMMARY_TEMPLATE_VARIABLES: readonly NotificationVariableEntry[] = [
  {
    name: 'seniorName',
    type: 'string',
    required: true,
    description: 'The senior the summary is about.',
  },
  {
    name: 'periodLabel',
    type: 'string',
    required: true,
    description: 'Human label for the summary period, e.g. "April 2026".',
  },
  {
    name: 'totalVisits',
    type: 'number',
    required: true,
    description: 'Completed companion visits in the period.',
  },
  {
    name: 'detailShared',
    type: 'boolean',
    required: true,
    description: 'Whether observation detail may be shown to this recipient (consent gate).',
  },
  {
    name: 'moodSummary',
    type: 'string',
    required: true,
    description: 'One-line mood roll-up, or empty when withheld.',
  },
  {
    name: 'appetiteSummary',
    type: 'string',
    required: true,
    description: 'One-line appetite roll-up, or empty when withheld.',
  },
  {
    name: 'hydrationSummary',
    type: 'string',
    required: true,
    description: 'One-line hydration roll-up, or empty when withheld.',
  },
  {
    name: 'socialSummary',
    type: 'string',
    required: true,
    description: 'One-line social-engagement roll-up, or empty when withheld.',
  },
  {
    name: 'appName',
    type: 'string',
    required: true,
    description: 'Product name for the footer, e.g. "Taste & See".',
  },
];

/** The variable names, as a typed tuple, for the worker's builder + tests. */
export const WELLNESS_SUMMARY_TEMPLATE_VARIABLE_NAMES = [
  'seniorName',
  'periodLabel',
  'totalVisits',
  'detailShared',
  'moodSummary',
  'appetiteSummary',
  'hydrationSummary',
  'socialSummary',
  'appName',
] as const;
export type WellnessSummaryTemplateVariableName =
  (typeof WELLNESS_SUMMARY_TEMPLATE_VARIABLE_NAMES)[number];
