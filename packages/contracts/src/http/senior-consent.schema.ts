import { z } from 'zod';

/**
 * Senior family-observability consent HTTP DTOs (TS-238; PRD §6.4,
 * §6.5; CLAUDE.md §12 "Family observability boundaries" + "Senior
 * consent gates ... the default is opt-out").
 *
 * The per-senior consent map controls which *surfaces* a senior has
 * agreed to share with **family observers** — the adult children /
 * siblings / spouses who hold a `family_observer` membership in the
 * household. Each surface is a single boolean; the model is deliberately
 * per-senior-surface (one record per senior, applied uniformly to every
 * observer) rather than per-(senior × observer): the downstream gates
 * the map unblocks (TS-062-followup-3 photo-key gate, TS-110-followup-10
 * senior-photo reads, TS-232 photo gallery, TS-233 family thread) all
 * assume a flat `senior_consent`-with-a-boolean shape, and a per-observer
 * matrix would force each of them to rework their lookup. Per-observer
 * overrides are a deliberate future extension, captured as a TS-238
 * follow-up.
 *
 * **Default is opt-out** (CLAUDE.md §12). A senior with no consent row —
 * or a freshly-created one — shares nothing. The service returns the
 * all-`false` shape when no row exists; the family observer's view masks
 * accordingly until the senior (or the primary payer, acting as account
 * manager / guardian) flips a surface on.
 *
 * **The gate masks family observers only.** The primary payer is the
 * account manager: they always see everything they manage (CLAUDE.md §12
 * frames the boundary as "family observers see what the senior has
 * consented to share" — the payer is not an observer). The senior
 * end-user, when they log in, sees their own data unconditionally.
 *
 * Surfaces (the enum mirrors PRD §6.4 / the TS-238 acceptance wording):
 *
 *   - `photos`   — visit photo summaries + memory-recipe images
 *                  (media-svc; gated by TS-232 / TS-110-followup-10 /
 *                  TS-062-followup-3 once those land).
 *   - `notes`    — wellness observation notes from visits (mood,
 *                  appetite, hydration, social engagement — service-
 *                  booking; gated by a TS-238 follow-up + TS-233).
 *   - `location` — geo check-in / check-out coordinates (service-booking;
 *                  gated by a TS-238 follow-up).
 *   - `health`   — the senior's health / medical profile: date of birth,
 *                  dementia stage, and the encrypted intake notes
 *                  (service-household). This is the one surface TS-238
 *                  gates **live** — the intake read (`IntakeService.get`)
 *                  now returns 403 to a family observer unless `health`
 *                  consent is granted.
 *
 * `.strict()` everywhere — unknown fields are a 400.
 */

const SENIOR_ID_MAX_LENGTH = 64;
const USER_ID_MAX_LENGTH = 64;

/**
 * The four consent surfaces, as an `as const` tuple so the enum and the
 * iteration order stay in lockstep (no magic strings — CLAUDE.md §2.2).
 * Frontends iterate this to render one toggle per surface.
 */
export const SENIOR_CONSENT_SURFACES = ['photos', 'notes', 'location', 'health'] as const;

/** Discriminator for a single consent surface. */
export const SeniorConsentSurfaceSchema = z.enum(SENIOR_CONSENT_SURFACES);
export type SeniorConsentSurface = z.infer<typeof SeniorConsentSurfaceSchema>;

/**
 * The four-flag consent state. Reused as the **full-replace** PUT body
 * (the editor is a small four-toggle form, so the client always sends
 * the complete state — no partial-merge ambiguity) and embedded in the
 * response. Every flag is required: a client that omits one is sending
 * an incomplete picture and gets a 400, which is safer than silently
 * defaulting an unspecified surface either way.
 */
export const SeniorConsentFlagsSchema = z
  .object({
    photos: z.boolean(),
    notes: z.boolean(),
    location: z.boolean(),
    health: z.boolean(),
  })
  .strict();
export type SeniorConsentFlags = z.infer<typeof SeniorConsentFlagsSchema>;

/** Request body for `PUT /api/v1/seniors/{seniorId}/consent`. */
export const SetSeniorConsentRequestSchema = SeniorConsentFlagsSchema;
export type SetSeniorConsentRequest = z.infer<typeof SetSeniorConsentRequestSchema>;

/**
 * Response body for both `GET` and `PUT /api/v1/seniors/{seniorId}/consent`.
 *
 * Carries the four persisted flags plus audit metadata:
 *   - `updatedAt`        — null until the senior's consent has ever been
 *                          set (an all-`false` default that has never been
 *                          written has no timestamp).
 *   - `updatedByUserId`  — soft FK into `identity.users.id` for the
 *                          household member who last set consent; null on
 *                          the never-set default. Not sensitive PII (a
 *                          CUID), so it is safe to surface to any member.
 *   - `canManage`        — the **authenticated caller's** capability, NOT
 *                          part of the persisted record. True only for the
 *                          primary payer or the senior end-user; false for
 *                          a family observer. A pure UI hint — the PUT
 *                          handler authoritatively re-checks server-side
 *                          (defence in depth), so a tampered `canManage`
 *                          buys nothing.
 */
export const SeniorConsentResponseSchema = z
  .object({
    seniorId: z.string().min(1).max(SENIOR_ID_MAX_LENGTH),
    photos: z.boolean(),
    notes: z.boolean(),
    location: z.boolean(),
    health: z.boolean(),
    updatedAt: z.string().datetime().nullable(),
    updatedByUserId: z.string().min(1).max(USER_ID_MAX_LENGTH).nullable(),
    canManage: z.boolean(),
  })
  .strict();
export type SeniorConsentResponse = z.infer<typeof SeniorConsentResponseSchema>;

export const SENIOR_CONSENT_SENIOR_ID_MAX_LENGTH = SENIOR_ID_MAX_LENGTH;
export const SENIOR_CONSENT_USER_ID_MAX_LENGTH = USER_ID_MAX_LENGTH;
