import { z } from 'zod';

/**
 * Per-(senior × family-member) alert-subscription HTTP DTOs (TS-234;
 * PRD §6.4 "Alert configurations"; PDD §12.3).
 *
 * The family peace-of-mind dashboard lets each household member — the
 * primary payer *and* every family observer — choose which alerts they
 * personally want to receive about a given senior. Unlike the
 * `senior_consent` map (TS-238), which is **one record per senior** set
 * by the account manager and applied uniformly to every observer, this
 * record is **per (senior × member)**: each member subscribes for
 * themselves, so a row is keyed `(seniorId, userId)` and a member may
 * only read / write *their own* subscription. Membership in the senior's
 * household is the row-level authorisation (a non-member gets 403); there
 * is no manager-role gate, because subscribing yourself to alerts is not
 * an act performed on the senior's behalf.
 *
 * Alert types (the enum mirrors the TS-234 acceptance wording):
 *
 *   - `missedVisit`           — a booked visit the provider did not show
 *                               up for (no check-in past the window).
 *                               Operational / reliability signal.
 *   - `concerningObservation` — a concerning pattern in the senior's
 *                               wellness observations (e.g. declining
 *                               appetite across 2+ visits — the TS-236
 *                               anomaly detector). This alert derives from
 *                               senior wellness data, so its **delivery to
 *                               a family observer is gated at emission time
 *                               by the senior's `notes` consent** (TS-238;
 *                               the gate is the dispatcher's job — a TS-234
 *                               follow-up — not this config surface).
 *   - `emergencyFlag`         — a welfare / emergency flag raised during a
 *                               visit or by trust & safety. Safety signal.
 *
 * **Defaults (no stored row).** Operational + safety alerts are on by
 * default — `missedVisit` and `emergencyFlag` are `true` — because a
 * family that has just signed up wants to know if a visit is missed or an
 * emergency is raised without having to opt in first. `concerningObservation`
 * defaults `false`: it derives from senior wellness data and the upstream
 * detector (TS-236) is a scaffold, so it is opt-in to avoid premature
 * noise. The absence of a row is observationally identical to an explicit
 * row carrying these defaults.
 *
 * **Channels are orthogonal.** This surface stores *which alert types* a
 * member subscribes to — not *which channel* (email / SMS / push) fires.
 * Channel selection is governed by the member's notification preferences
 * (TS-073). Keeping the two axes decoupled keeps this schema small and
 * avoids duplicating channel state.
 *
 * `.strict()` everywhere — unknown fields are a 400.
 */

const SENIOR_ID_MAX_LENGTH = 64;
const USER_ID_MAX_LENGTH = 64;

/**
 * The three alert types, as an `as const` tuple so the enum and the
 * iteration order stay in lockstep (no magic strings — CLAUDE.md §2.2).
 * The tuple values double as the flag-object keys, so frontends iterate
 * this to render one toggle per type and index `flags[type]` directly —
 * the same shape `senior-consent.schema.ts` uses for its surfaces.
 */
export const SENIOR_ALERT_TYPES = [
  'missedVisit',
  'concerningObservation',
  'emergencyFlag',
] as const;

/** Discriminator for a single alert type. */
export const SeniorAlertTypeSchema = z.enum(SENIOR_ALERT_TYPES);
export type SeniorAlertType = z.infer<typeof SeniorAlertTypeSchema>;

/**
 * The three-flag subscription state. Reused as the **full-replace** PUT
 * body (the editor is a small three-toggle form, so the client always
 * sends the complete state — no partial-merge ambiguity) and embedded in
 * the response. Every flag is required: a client that omits one is
 * sending an incomplete picture and gets a 400, which is safer than
 * silently defaulting an unspecified type either way.
 */
export const SeniorAlertPreferencesFlagsSchema = z
  .object({
    missedVisit: z.boolean(),
    concerningObservation: z.boolean(),
    emergencyFlag: z.boolean(),
  })
  .strict();
export type SeniorAlertPreferencesFlags = z.infer<typeof SeniorAlertPreferencesFlagsSchema>;

/** Request body for `PUT /api/v1/seniors/{seniorId}/alert-preferences`. */
export const SetSeniorAlertPreferencesRequestSchema = SeniorAlertPreferencesFlagsSchema;
export type SetSeniorAlertPreferencesRequest = z.infer<
  typeof SetSeniorAlertPreferencesRequestSchema
>;

/**
 * Response body for both `GET` and
 * `PUT /api/v1/seniors/{seniorId}/alert-preferences`.
 *
 * Carries the three persisted flags plus audit metadata:
 *   - `updatedAt` — null until this member has ever set their preferences
 *                   for the senior (the never-set default has no
 *                   timestamp). When null, the three flags carry the
 *                   default state described above.
 *
 * There is no `canManage` flag (cf. `SeniorConsentResponse`): every
 * household member manages their own subscription, so the capability is
 * always implied by a successful read.
 */
export const SeniorAlertPreferencesResponseSchema = z
  .object({
    seniorId: z.string().min(1).max(SENIOR_ID_MAX_LENGTH),
    missedVisit: z.boolean(),
    concerningObservation: z.boolean(),
    emergencyFlag: z.boolean(),
    updatedAt: z.string().datetime().nullable(),
  })
  .strict();
export type SeniorAlertPreferencesResponse = z.infer<typeof SeniorAlertPreferencesResponseSchema>;

/**
 * The default subscription state for a member who has never configured
 * their preferences for a senior. Operational + safety alerts on,
 * observation-derived alert off (see the file header). The service
 * returns this shape when no row exists; the frontend renders these as
 * the initial toggle states.
 */
export const SENIOR_ALERT_PREFERENCES_DEFAULTS: SeniorAlertPreferencesFlags = {
  missedVisit: true,
  concerningObservation: false,
  emergencyFlag: true,
};

export const SENIOR_ALERT_PREFERENCES_SENIOR_ID_MAX_LENGTH = SENIOR_ID_MAX_LENGTH;
export const SENIOR_ALERT_PREFERENCES_USER_ID_MAX_LENGTH = USER_ID_MAX_LENGTH;
