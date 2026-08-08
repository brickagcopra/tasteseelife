import { z } from 'zod';

/**
 * "My seniors" directory DTOs (TS-214).
 *
 * The family portal needs to enumerate the seniors a signed-in family
 * member can act on before it can render any per-senior surface — the
 * preference editor (TS-214), the intake form (TS-031), the memory-recipe
 * catalog (TS-033). Every other senior endpoint takes a `seniorId` path
 * param the caller is assumed to already hold; there is no household →
 * seniors resolver anywhere else.
 *
 * `GET /api/v1/me/seniors` closes that gap. The service resolves the
 * actor's active household memberships (`household_members.user_id`,
 * `removed_at IS NULL`) → the households they belong to → the active
 * seniors in those households (`seniors.deleted_at IS NULL`). It is the
 * family-portal entry point into the per-senior surfaces.
 *
 * Lightweight projection. Only the fields the directory list renders +
 * the ids a follow-on per-senior call needs: name, display name, status,
 * and the parent household id. Sensitive intake (DOB, medical notes,
 * dementia narrative) is NEVER in this shape — it stays behind the
 * per-senior intake endpoint with its own decrypt boundary (TS-031).
 * Operational tags (dietary / allergen / language) are likewise omitted;
 * a caller that wants them reads the intake.
 *
 * `.strict()` everywhere — unknown fields are a 400.
 */

const SENIOR_ID_MAX_LENGTH = 64;
const HOUSEHOLD_ID_MAX_LENGTH = 64;
const NAME_MAX_LENGTH = 200;

/**
 * Senior lifecycle status. Mirrors the `household.senior_status`
 * Postgres enum (`active` / `paused` / `archived`). The directory
 * surfaces every non-deleted senior regardless of status so the family
 * can still reach the profile of a senior who is temporarily paused.
 */
export const MySeniorStatusSchema = z.enum(['active', 'paused', 'archived']);
export type MySeniorStatus = z.infer<typeof MySeniorStatusSchema>;

/**
 * One row in the "your loved ones" list. `displayName` is the preferred
 * greeting / nickname the family entered (null = fall back to
 * `firstName` at render time).
 */
export const MySeniorSummarySchema = z
  .object({
    seniorId: z.string().min(1).max(SENIOR_ID_MAX_LENGTH),
    householdId: z.string().min(1).max(HOUSEHOLD_ID_MAX_LENGTH),
    firstName: z.string().min(1).max(NAME_MAX_LENGTH),
    lastName: z.string().min(1).max(NAME_MAX_LENGTH),
    displayName: z.string().min(1).max(NAME_MAX_LENGTH).nullable(),
    status: MySeniorStatusSchema,
  })
  .strict();
export type MySeniorSummary = z.infer<typeof MySeniorSummarySchema>;

/**
 * List response. Wraps the array in an object so future additions
 * (household grouping, per-senior intake-completion cues) stay
 * non-breaking schema extensions. Order is server-controlled:
 * ascending `firstName` then `lastName` then `seniorId` for a stable
 * scan order.
 */
export const MySeniorsResponseSchema = z
  .object({
    seniors: z.array(MySeniorSummarySchema),
  })
  .strict();
export type MySeniorsResponse = z.infer<typeof MySeniorsResponseSchema>;

export const MY_SENIORS_SENIOR_ID_MAX_LENGTH = SENIOR_ID_MAX_LENGTH;
export const MY_SENIORS_HOUSEHOLD_ID_MAX_LENGTH = HOUSEHOLD_ID_MAX_LENGTH;
export const MY_SENIORS_NAME_MAX_LENGTH = NAME_MAX_LENGTH;
