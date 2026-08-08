import { z } from 'zod';

import {
  CONCIERGE_TICKET_HOUSEHOLD_ID_MAX_LENGTH,
  CONCIERGE_TICKET_ID_MAX_LENGTH,
  CONCIERGE_TICKET_USER_ID_MAX_LENGTH,
} from './concierge-ticket.schema';

/**
 * Tier-3 onboarding ("white-glove kickoff") HTTP DTOs (TS-228; PRD §5.1
 * Tier 3; PDD §10.6).
 *
 * A checklist-driven workflow that guides a new Tier-3 (Concierge Lifestyle)
 * household through the white-glove kickoff: a 30-minute concierge kickoff
 * call, a senior-preference deep-dive (the TS-214 preference editor), family
 * expectation-setting, plus the natural first-week steps (assign a dedicated
 * concierge, schedule the first chef visit, confirm household access &
 * emergency contacts).
 *
 * **Where the state lives.** The acceptance frames the status as "persisted on
 * the subscription record", but the workflow is concierge-domain and a
 * cross-service DB write into `subscription` is forbidden (CLAUDE.md §2.3).
 * The onboarding therefore lives in `service-concierge`, keyed by the Tier-3
 * household's `householdId` — the same soft-FK pattern every concierge table
 * uses — and is surfaced in admin ops + as a read-only family progress card.
 *
 * Three surfaces share this contract:
 *
 *   1. **Admin ops** — `POST/GET/PATCH /api/v1/admin/concierge/onboardings`
 *      (+ `PATCH .../:onboardingId/steps/:stepKey`). The ops actor is
 *      global-scoped, so the create body carries the target `householdId`.
 *      Gated on `concierge:read` (reads) / `concierge:write` (mutations) — the
 *      same RBAC permissions TS-224 added (no new permission here).
 *
 *   2. **Family read** — `GET /api/v1/concierge/onboarding/me`. The actor
 *      token's `tenantScope: {type:'household', householdId}` claim resolves
 *      the household — no household id crosses the wire. Read-only; the family
 *      sees their progress, the concierge drives the work.
 *
 * **Checklist model.** The step set is a FROZEN template
 * (`CONCIERGE_ONBOARDING_STEP_TEMPLATE`) seeded onto every onboarding at
 * create time — the same "frozen policy constant" pattern as the per-kind SLA
 * (TS-223) and the pricing bands (TS-204). A followup can extend the template;
 * ops cannot add ad-hoc steps. Each step carries its own completion state +
 * optional notes; the onboarding's rollup `status` is DERIVED from the steps.
 *
 * **Lifecycle.** `not_started` → `in_progress` (≥ 1 step done) → `completed`
 * (every step completed-or-skipped). `completed` is a *derived* rollup —
 * re-opening a step reverts it to `in_progress`. `canceled` is the only sticky
 * terminal state (set explicitly via PATCH; e.g. the household downgrades out
 * of Tier 3); a canceled onboarding rejects all further edits (409).
 *
 * **`.strict()` everywhere** — a typo in a field name is a 400, not a
 * silently-dropped knob (CLAUDE.md §3.3).
 */

// ─── Bounded length / numeric constants ─────────────────────────────────

/** CUID/CUID2-shaped onboarding-row id cap. */
export const CONCIERGE_ONBOARDING_ID_MAX_LENGTH = CONCIERGE_TICKET_ID_MAX_LENGTH;

/** Soft-FK household id cap — matches `household.households.id`. */
export const CONCIERGE_ONBOARDING_HOUSEHOLD_ID_MAX_LENGTH =
  CONCIERGE_TICKET_HOUSEHOLD_ID_MAX_LENGTH;

/** Soft-FK user id cap — matches `identity.users.id`. */
export const CONCIERGE_ONBOARDING_USER_ID_MAX_LENGTH = CONCIERGE_TICKET_USER_ID_MAX_LENGTH;

/** Free-text onboarding-level notes (kickoff scheduling context, etc.). */
export const CONCIERGE_ONBOARDING_NOTES_MAX_LENGTH = 4000;

/** Free-text per-step notes (what was covered, follow-ups). */
export const CONCIERGE_ONBOARDING_STEP_NOTES_MAX_LENGTH = 2000;

/** Step title shown on the ops + family checklist (from the frozen template). */
export const CONCIERGE_ONBOARDING_STEP_TITLE_MAX_LENGTH = 160;

/** Step description (from the frozen template). */
export const CONCIERGE_ONBOARDING_STEP_DESCRIPTION_MAX_LENGTH = 400;

/** Ops onboarding-list caps. Bounded, no cursor (Phase 1 — followup). */
export const CONCIERGE_ONBOARDINGS_LIST_LIMIT_DEFAULT = 50;
export const CONCIERGE_ONBOARDINGS_LIST_LIMIT_MAX = 200;

// ─── Enums ──────────────────────────────────────────────────────────────

/**
 * Onboarding rollup status — mirrors the `ConciergeOnboardingStatus` Prisma
 * enum. Derived from the steps on every mutation, except `canceled` which is
 * set explicitly and is sticky.
 *
 *   `not_started` = created; no step completed or skipped yet.
 *   `in_progress` = at least one step completed/skipped, but not all.
 *   `completed`   = every step is completed or skipped (derived — reverts to
 *                   `in_progress` if a step is re-opened).
 *   `canceled`    = abandoned (e.g. household downgraded out of Tier 3).
 *                   Sticky terminal; rejects further edits.
 */
export const ConciergeOnboardingStatusSchema = z.enum([
  'not_started',
  'in_progress',
  'completed',
  'canceled',
]);
export type ConciergeOnboardingStatus = z.infer<typeof ConciergeOnboardingStatusSchema>;

/**
 * The canonical white-glove kickoff steps — mirrors the
 * `ConciergeOnboardingStepKey` Prisma enum. Ordered by `sortPosition` in the
 * template below. Additive only — new steps arrive via `ALTER TYPE … ADD
 * VALUE` + a template extension (TS-228 followup).
 */
export const ConciergeOnboardingStepKeySchema = z.enum([
  'welcome_kickoff_call',
  'senior_preference_deep_dive',
  'family_expectation_setting',
  'assign_dedicated_concierge',
  'schedule_first_chef_visit',
  'confirm_household_access',
]);
export type ConciergeOnboardingStepKey = z.infer<typeof ConciergeOnboardingStepKeySchema>;

/**
 * Per-step completion state — mirrors the `ConciergeOnboardingStepStatus`
 * Prisma enum. A checklist toggle, not a state machine: ops may move a step
 * between any of the three (re-opening a `completed`/`skipped` step back to
 * `pending` is allowed).
 *
 *   `pending`   = not yet done.
 *   `completed` = the concierge completed the step (stamps `completedAt` +
 *                 `completedByUserId`).
 *   `skipped`   = deliberately not applicable for this household (counts
 *                 toward "done" for the rollup, but is not a `completed`).
 */
export const ConciergeOnboardingStepStatusSchema = z.enum(['pending', 'completed', 'skipped']);
export type ConciergeOnboardingStepStatus = z.infer<typeof ConciergeOnboardingStepStatusSchema>;

// ─── Frozen step template ───────────────────────────────────────────────

/**
 * The white-glove kickoff checklist (TS-228). Seeded onto every onboarding at
 * create time; the source of truth for step ordering + the human-facing
 * title/description the ops + family surfaces render. Shared by the service
 * (seeding + projection) and the web UIs (labels) so the two never drift.
 *
 * A step is "done" for the rollup when it is `completed` OR `skipped`.
 */
export const CONCIERGE_ONBOARDING_STEP_TEMPLATE = [
  {
    key: 'welcome_kickoff_call',
    sortPosition: 0,
    title: 'Welcome & 30-minute concierge kickoff call',
    description:
      'Schedule and hold the white-glove kickoff call to introduce the concierge team and walk the family through what to expect.',
  },
  {
    key: 'senior_preference_deep_dive',
    sortPosition: 1,
    title: 'Senior-preference deep-dive',
    description:
      'Capture the senior’s favourite dishes, cultural traditions, dietary needs, and comfort cues in the preference profile (TS-214).',
  },
  {
    key: 'family_expectation_setting',
    sortPosition: 2,
    title: 'Family expectation-setting',
    description:
      'Align with the family on cadence, communication preferences, and how updates and wellness notes will flow.',
  },
  {
    key: 'assign_dedicated_concierge',
    sortPosition: 3,
    title: 'Assign dedicated concierge',
    description:
      'Assign the household’s primary (and backup) dedicated culinary concierge (TS-222).',
  },
  {
    key: 'schedule_first_chef_visit',
    sortPosition: 4,
    title: 'Schedule first chef visit',
    description:
      'Book the first companion-dining or chef visit so the relationship starts within the first week.',
  },
  {
    key: 'confirm_household_access',
    sortPosition: 5,
    title: 'Confirm household access & emergency contacts',
    description:
      'Confirm entry instructions, household access notes, and the emergency contact chain.',
  },
] as const satisfies readonly {
  readonly key: ConciergeOnboardingStepKey;
  readonly sortPosition: number;
  readonly title: string;
  readonly description: string;
}[];

/** Number of steps every onboarding is seeded with. */
export const CONCIERGE_ONBOARDING_STEP_COUNT = CONCIERGE_ONBOARDING_STEP_TEMPLATE.length;

/** Terminal statuses — a canceled onboarding rejects all further edits. */
export const CONCIERGE_ONBOARDING_TERMINAL_STATUSES = ['canceled'] as const;

/** `true` when the onboarding can no longer be acted on (canceled). */
export function isConciergeOnboardingTerminal(status: ConciergeOnboardingStatus): boolean {
  return (CONCIERGE_ONBOARDING_TERMINAL_STATUSES as readonly ConciergeOnboardingStatus[]).includes(
    status,
  );
}

// ─── Field schemas ──────────────────────────────────────────────────────

const IdSchema = z.string().min(1).max(CONCIERGE_ONBOARDING_ID_MAX_LENGTH);
const HouseholdIdSchema = z.string().min(1).max(CONCIERGE_ONBOARDING_HOUSEHOLD_ID_MAX_LENGTH);
const UserIdSchema = z.string().min(1).max(CONCIERGE_ONBOARDING_USER_ID_MAX_LENGTH);
const NotesSchema = z.string().trim().min(1).max(CONCIERGE_ONBOARDING_NOTES_MAX_LENGTH);
const StepNotesSchema = z.string().trim().min(1).max(CONCIERGE_ONBOARDING_STEP_NOTES_MAX_LENGTH);
const StepTitleSchema = z.string().min(1).max(CONCIERGE_ONBOARDING_STEP_TITLE_MAX_LENGTH);
const StepDescriptionSchema = z
  .string()
  .min(1)
  .max(CONCIERGE_ONBOARDING_STEP_DESCRIPTION_MAX_LENGTH);
const TimestampSchema = z.string().datetime({ offset: true });

// ─── Step record ────────────────────────────────────────────────────────

/**
 * One checklist step on an onboarding. `title` + `description` are projected
 * from `CONCIERGE_ONBOARDING_STEP_TEMPLATE` (not stored), so the record is
 * self-describing for API consumers. `completedAt` / `completedByUserId` are
 * set only when `status === 'completed'`.
 */
export const ConciergeOnboardingStepRecordSchema = z
  .object({
    stepKey: ConciergeOnboardingStepKeySchema,
    sortPosition: z.number().int().nonnegative(),
    title: StepTitleSchema,
    description: StepDescriptionSchema,
    status: ConciergeOnboardingStepStatusSchema,
    notes: StepNotesSchema.nullable(),
    completedAt: TimestampSchema.nullable(),
    completedByUserId: UserIdSchema.nullable(),
    updatedAt: TimestampSchema,
  })
  .strict();
export type ConciergeOnboardingStepRecord = z.infer<typeof ConciergeOnboardingStepRecordSchema>;

// ─── Onboarding record (summary) ────────────────────────────────────────

/**
 * Onboarding summary row — the shape the list returns and the base for the
 * detail record. Carries the derived `stepsTotal` / `stepsCompleted` counts
 * (where "completed" counts steps that are `completed` OR `skipped`, i.e. the
 * rollup denominator) so a list row can render a progress bar without the full
 * steps array.
 */
export const ConciergeOnboardingRecordSchema = z
  .object({
    id: IdSchema,
    householdId: HouseholdIdSchema,
    status: ConciergeOnboardingStatusSchema,
    kickoffScheduledAt: TimestampSchema.nullable(),
    notes: NotesSchema.nullable(),
    startedByUserId: UserIdSchema.nullable(),
    stepsTotal: z.number().int().nonnegative(),
    stepsCompleted: z.number().int().nonnegative(),
    completedAt: TimestampSchema.nullable(),
    canceledAt: TimestampSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type ConciergeOnboardingRecord = z.infer<typeof ConciergeOnboardingRecordSchema>;

/**
 * Full onboarding detail — the summary record plus the ordered checklist
 * steps. Returned by create / get / update / update-step and the family `/me`
 * read.
 */
export const ConciergeOnboardingDetailRecordSchema = ConciergeOnboardingRecordSchema.extend({
  steps: z.array(ConciergeOnboardingStepRecordSchema),
}).strict();
export type ConciergeOnboardingDetailRecord = z.infer<typeof ConciergeOnboardingDetailRecordSchema>;

// ─── Create ─────────────────────────────────────────────────────────────

/**
 * `POST /api/v1/admin/concierge/onboardings` body — open a kickoff checklist
 * for a household (`householdId` required — the ops actor is global-scoped).
 * The six template steps are seeded `pending`. `kickoffScheduledAt` (the
 * scheduled time of the 30-minute kickoff call) and `notes` are optional. A
 * household may have at most one active (non-deleted) onboarding — a second
 * create is a 409.
 */
export const CreateConciergeOnboardingRequestSchema = z
  .object({
    householdId: HouseholdIdSchema,
    kickoffScheduledAt: TimestampSchema.optional(),
    notes: NotesSchema.optional(),
  })
  .strict();
export type CreateConciergeOnboardingRequest = z.infer<
  typeof CreateConciergeOnboardingRequestSchema
>;

/** `POST .../onboardings` response — the newly-created onboarding + steps. */
export const CreateConciergeOnboardingResponseSchema = z
  .object({
    onboarding: ConciergeOnboardingDetailRecordSchema,
  })
  .strict();
export type CreateConciergeOnboardingResponse = z.infer<
  typeof CreateConciergeOnboardingResponseSchema
>;

// ─── Update (onboarding-level) ──────────────────────────────────────────

/**
 * `PATCH /api/v1/admin/concierge/onboardings/:onboardingId` body — edit the
 * onboarding-level fields. At least one field must be present. `notes` and
 * `kickoffScheduledAt` accept `null` to clear. `status` may only be set to
 * `canceled` (the other statuses are derived from the steps, never set
 * directly); cancelling is the explicit terminal action. A canceled
 * onboarding rejects all edits (409).
 */
export const UpdateConciergeOnboardingRequestSchema = z
  .object({
    kickoffScheduledAt: TimestampSchema.nullable().optional(),
    notes: NotesSchema.nullable().optional(),
    status: z.literal('canceled').optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'at least one field must be supplied',
      });
    }
  });
export type UpdateConciergeOnboardingRequest = z.infer<
  typeof UpdateConciergeOnboardingRequestSchema
>;

/** `PATCH .../onboardings/:onboardingId` response — the updated onboarding. */
export const UpdateConciergeOnboardingResponseSchema = z
  .object({
    onboarding: ConciergeOnboardingDetailRecordSchema,
  })
  .strict();
export type UpdateConciergeOnboardingResponse = z.infer<
  typeof UpdateConciergeOnboardingResponseSchema
>;

// ─── Update step ────────────────────────────────────────────────────────

/**
 * `PATCH /api/v1/admin/concierge/onboardings/:onboardingId/steps/:stepKey`
 * body — advance (or re-open) one checklist step. `status` is required;
 * `notes` accepts `null` to clear. Setting `status='completed'` stamps the
 * step's `completedAt` + `completedByUserId` (the acting concierge, from the
 * token); any other status clears them. The onboarding's rollup `status`
 * recomputes after the step change. Editing a step on a canceled onboarding is
 * a 409.
 */
export const UpdateConciergeOnboardingStepRequestSchema = z
  .object({
    status: ConciergeOnboardingStepStatusSchema,
    notes: StepNotesSchema.nullable().optional(),
  })
  .strict();
export type UpdateConciergeOnboardingStepRequest = z.infer<
  typeof UpdateConciergeOnboardingStepRequestSchema
>;

/** `PATCH .../steps/:stepKey` response — the updated onboarding + steps. */
export const UpdateConciergeOnboardingStepResponseSchema = z
  .object({
    onboarding: ConciergeOnboardingDetailRecordSchema,
  })
  .strict();
export type UpdateConciergeOnboardingStepResponse = z.infer<
  typeof UpdateConciergeOnboardingStepResponseSchema
>;

// ─── Get (detail) ───────────────────────────────────────────────────────

/** `GET .../onboardings/:onboardingId` response — the onboarding + steps. */
export const GetConciergeOnboardingResponseSchema = z
  .object({
    onboarding: ConciergeOnboardingDetailRecordSchema,
  })
  .strict();
export type GetConciergeOnboardingResponse = z.infer<typeof GetConciergeOnboardingResponseSchema>;

// ─── List ───────────────────────────────────────────────────────────────

/**
 * `GET /api/v1/admin/concierge/onboardings` query. With no filters returns
 * onboardings across every household, newest-first. `householdId` narrows to
 * one household; `status` narrows by rollup state.
 */
export const ListConciergeOnboardingsQuerySchema = z
  .object({
    householdId: HouseholdIdSchema.optional(),
    status: ConciergeOnboardingStatusSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(CONCIERGE_ONBOARDINGS_LIST_LIMIT_MAX)
      .default(CONCIERGE_ONBOARDINGS_LIST_LIMIT_DEFAULT),
  })
  .strict();
export type ListConciergeOnboardingsQuery = z.infer<typeof ListConciergeOnboardingsQuerySchema>;

/**
 * `GET /api/v1/admin/concierge/onboardings` response — the matching
 * onboardings (summaries, no steps) newest-first. Bounded by `limit`; no
 * cursor at Phase-1 volume (followup carries cursor pagination).
 */
export const ConciergeOnboardingsListResponseSchema = z
  .object({
    onboardings: z.array(ConciergeOnboardingRecordSchema),
  })
  .strict();
export type ConciergeOnboardingsListResponse = z.infer<
  typeof ConciergeOnboardingsListResponseSchema
>;

// ─── Family read ────────────────────────────────────────────────────────

/**
 * `GET /api/v1/concierge/onboarding/me` response — the household's onboarding
 * (with steps), resolved from the token `tenantScope`. `null` when the
 * household has no onboarding (e.g. a non-Tier-3 household, or one not yet
 * kicked off). Read-only — the family sees progress; the concierge drives it.
 */
export const MyConciergeOnboardingResponseSchema = z
  .object({
    householdId: HouseholdIdSchema,
    onboarding: ConciergeOnboardingDetailRecordSchema.nullable(),
  })
  .strict();
export type MyConciergeOnboardingResponse = z.infer<typeof MyConciergeOnboardingResponseSchema>;
