import { z } from 'zod';

/**
 * Ad targeting-rule grammar + audience shape (TS-273; PRD §10.9; PDD §18.1
 * "Targeting — audience expression … evaluated server-side").
 *
 * This is the shared, authoritative grammar for the JSON ASTs that
 * `service-ads` persists in `ad_targeting_rules.value` (a TEXT column, so the
 * schema never constrains the evolving grammar) and evaluates at delivery
 * time. Two future consumers share it:
 *
 *   1. **Campaign admin** (TS-271) — validates an operator-authored targeting
 *      AST before persisting it as a rule row.
 *   2. **Delivery** (TS-218 sponsored search slot / TS-275 capture) — reads a
 *      campaign's rule rows, parses each `value` back into a predicate, and
 *      AND-combines them against the request's audience to decide eligibility.
 *
 * ── Data model ──────────────────────────────────────────────────────────
 *
 * A campaign carries zero or more **rules**. Each rule lives in one
 * `ad_targeting_rules` row: the `kind` column names the dimension
 * (`AdTargetingRuleKind` — geography / persona / tier / behavior_cohort /
 * household_composition) and the `value` column holds the dimension's
 * **predicate** as a JSON AST (`AdTargetingPredicate`).
 *
 * A predicate is `{ operator, values }`:
 *
 *   - `any_of`  — the audience's value(s) for this dimension OVERLAP `values`
 *                 (set intersection is non-empty). The inclusion operator.
 *   - `none_of` — the audience's value(s) do NOT overlap `values` (empty
 *                 intersection). The exclusion operator. An audience with an
 *                 *unknown* (null/empty) value for the dimension trivially
 *                 satisfies `none_of` — it is not excluded.
 *   - `all_of`  — `values` is a SUBSET of the audience's value(s). Only
 *                 meaningful for the multi-valued `behavior_cohort` dimension
 *                 ("in all of these cohorts"); for a single-valued dimension
 *                 it can only match when `values` has exactly one element.
 *
 * ── Combination semantics (the evaluator, in service-ads) ───────────────
 *
 *   - A campaign matches an audience IFF **every** rule matches (logical AND
 *     across rules, including multiple rules of the same kind — which lets
 *     ops express "geography any_of [A,B] AND geography none_of [C]").
 *   - A campaign with **no** rules matches **every** audience (an untargeted
 *     campaign delivers to everyone — the broadest reach).
 *
 * ── Audience ────────────────────────────────────────────────────────────
 *
 * The `AdTargetingAudience` is the evaluation context — the viewer the
 * delivery layer is deciding whether to show an ad to. Every dimension is a
 * single value EXCEPT `behaviorCohorts`, which is a set (a viewer belongs to
 * many cohorts at once). A null / omitted dimension means "unknown for this
 * viewer" — an `any_of`/`all_of` rule on an unknown dimension fails (the
 * viewer is not provably in the targeted set), while a `none_of` rule passes.
 *
 * `.strict()` everywhere — a typo in a field name is a parse failure, not a
 * silently-dropped knob (CLAUDE.md §3.3). A malformed persisted AST fails
 * closed at delivery (the rule does not match → the campaign is excluded),
 * so a bad rule can never widen a campaign's reach.
 */

// ─── Bounded length / count constants ───────────────────────────────────

/**
 * A single targeting token — a region code (`NY-Manhattan`), a persona slug
 * (`adult_child`), a tier code (`tier_3_concierge`), a cohort slug
 * (`booked_last_30d`), a household-composition slug (`lives_alone`). Bounded
 * so a malformed token can't bloat a rule row or the audience payload.
 */
export const AD_TARGETING_VALUE_MAX_LENGTH = 64;

/** Max tokens in a single predicate's `values` list. */
export const AD_TARGETING_PREDICATE_VALUES_MAX = 256;

/** Max cohorts an audience may carry (a viewer is in a bounded set). */
export const AD_TARGETING_AUDIENCE_COHORTS_MAX = 64;

/**
 * Max rules the delivery evaluator will AND-combine for one campaign — a
 * defensive bound so a pathological campaign can't turn delivery into an
 * unbounded loop. Far above any realistic targeting expression.
 */
export const AD_TARGETING_RULES_MAX = 32;

// ─── Field schemas ──────────────────────────────────────────────────────

/**
 * Targeting-rule dimension. Mirrors the `AdTargetingRuleKind` Prisma enum
 * one-to-one (and evolves additively in lockstep with it).
 */
export const AdTargetingRuleKindSchema = z.enum([
  'geography',
  'persona',
  'tier',
  'behavior_cohort',
  'household_composition',
]);
export type AdTargetingRuleKind = z.infer<typeof AdTargetingRuleKindSchema>;

/**
 * Predicate match operator. See the module doc-block for set semantics.
 */
export const AdTargetingMatchOperatorSchema = z.enum(['any_of', 'none_of', 'all_of']);
export type AdTargetingMatchOperator = z.infer<typeof AdTargetingMatchOperatorSchema>;

/**
 * A single targeting token — non-empty, length-bounded, and restricted to a
 * conservative slug/code alphabet (`A-Za-z0-9`, plus `_ . : -`) so a token
 * can never carry whitespace, control characters, or structural JSON.
 */
export const AdTargetingValueSchema = z
  .string()
  .min(1)
  .max(AD_TARGETING_VALUE_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'targeting value must be a slug/code token');

/**
 * The predicate AST persisted in `ad_targeting_rules.value`. `values` is a
 * non-empty, bounded, de-duplicated set of tokens.
 */
export const AdTargetingPredicateSchema = z
  .object({
    operator: AdTargetingMatchOperatorSchema,
    values: z.array(AdTargetingValueSchema).min(1).max(AD_TARGETING_PREDICATE_VALUES_MAX),
  })
  .strict();
export type AdTargetingPredicate = z.infer<typeof AdTargetingPredicateSchema>;

/**
 * A parsed targeting rule — the `kind` column joined with the predicate
 * decoded from the `value` column. This is the shape the evaluator consumes
 * (the persistence layer reads rows and parses each `value` into one of
 * these).
 */
export const AdTargetingRuleSchema = z
  .object({
    kind: AdTargetingRuleKindSchema,
    predicate: AdTargetingPredicateSchema,
  })
  .strict();
export type AdTargetingRule = z.infer<typeof AdTargetingRuleSchema>;

/**
 * The audience an ad-delivery decision is evaluated against. Single-valued
 * dimensions are nullable (null = unknown for this viewer); `behaviorCohorts`
 * is a bounded set (a viewer is in many cohorts at once) and defaults to the
 * empty set.
 */
export const AdTargetingAudienceSchema = z
  .object({
    geography: AdTargetingValueSchema.nullish(),
    persona: AdTargetingValueSchema.nullish(),
    tier: AdTargetingValueSchema.nullish(),
    behaviorCohorts: z
      .array(AdTargetingValueSchema)
      .max(AD_TARGETING_AUDIENCE_COHORTS_MAX)
      .default([]),
    householdComposition: AdTargetingValueSchema.nullish(),
  })
  .strict();
export type AdTargetingAudience = z.infer<typeof AdTargetingAudienceSchema>;

// ─── Persisted-AST parse helper ─────────────────────────────────────────

/**
 * Outcome of decoding a persisted `ad_targeting_rules.value` TEXT column.
 * Discriminated so callers fail closed on a malformed rule without a
 * thrown exception crossing the delivery hot path (CLAUDE.md §2.1 — typed
 * Result over silent throw).
 */
export type ParseAdTargetingPredicateResult =
  | { readonly ok: true; readonly predicate: AdTargetingPredicate }
  | {
      readonly ok: false;
      readonly error: 'invalid_json' | 'invalid_shape';
      readonly message: string;
    };

/**
 * Decode a persisted predicate AST (the `ad_targeting_rules.value` TEXT) into
 * a validated `AdTargetingPredicate`. Centralised here so every consumer
 * (delivery evaluator, admin-side validation) decodes the grammar
 * identically.
 *
 *   - `invalid_json`  — the TEXT was not parseable JSON.
 *   - `invalid_shape` — parsed JSON that did not satisfy the predicate schema
 *     (unknown operator, empty/over-long values, extra keys, …).
 *
 * The delivery layer treats either failure as fail-closed: the rule does not
 * match, so the campaign is excluded — a corrupt rule can never widen reach.
 */
export function parseAdTargetingPredicate(raw: string): ParseAdTargetingPredicateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return {
      ok: false,
      error: 'invalid_json',
      message: cause instanceof Error ? cause.message : 'value is not valid JSON',
    };
  }
  const result = AdTargetingPredicateSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: 'invalid_shape', message: result.error.message };
  }
  return { ok: true, predicate: result.data };
}
