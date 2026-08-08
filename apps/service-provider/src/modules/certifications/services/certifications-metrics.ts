import { Injectable } from '@nestjs/common';
import { type Counter, getMeter, type Histogram } from '@taste-and-see/tracing';

import type { ProviderCertificationsFailure } from './provider-certifications.service';
import type {
  ProviderTier,
  TierPromotionFailure,
  TierTransitionReason,
} from './tier-promotion.service';

const METER_NAME = 'service-provider:certifications';

/**
 * Outcome label for `provider_certifications_granted_total` +
 * `provider_certifications_revoked_total` (and their matching latency
 * histograms). `ok` is a successful grant / revoke. The remainder mirror
 * {@link ProviderCertificationsFailure}'s `reason` discriminants 1:1:
 * `invalid_request` (empty providerId / certificationCode / reason),
 * `provider_not_found` / `certification_not_found` (grant-path lookups),
 * `already_active` (the active-grant short-circuit), `not_found`
 * (revoke-path row miss — surfaced to the client as a generic 404),
 * `already_revoked` (the idempotent re-revoke short-circuit), and
 * `outbox_validation_failed` (the producer-side outbox SDK rejected the
 * event payload → tx rolled back → 500). `error` is the unexpected-throw
 * catch-all so a 500 stays visible on the scrape surface.
 *
 * A single union covers both counters even though each path only
 * realistically produces a subset (the grant path never returns
 * `not_found` / `already_revoked`; the revoke path never returns
 * `provider_not_found` / `certification_not_found` / `already_active`).
 * Sharing the union keeps {@link certificationFailureOutcome} an identity
 * mapper — the cardinality contract lands at the type layer, mirroring
 * `submitApplicationOutcome` (TS-051-followup-7). All values are fixed
 * string literals — bounded cardinality, no PII (CLAUDE.md §10).
 */
export type ProviderCertificationOutcome =
  | 'ok'
  | 'invalid_request'
  | 'provider_not_found'
  | 'certification_not_found'
  | 'already_active'
  | 'not_found'
  | 'already_revoked'
  | 'outbox_validation_failed'
  | 'error';

/**
 * Outcome label for `provider_tier_evaluate_duration_seconds` +
 * `provider_tier_override_duration_seconds`. `ok` is a successful
 * evaluate / override (whether or not a transition was applied — a
 * no-op evaluate is still `ok`). The remainder mirror
 * {@link TierPromotionFailure}'s `reason` discriminants 1:1:
 * `invalid_request`, `provider_not_found`, `outbox_validation_failed`.
 * `error` is the unexpected-throw catch-all. Bounded, no PII.
 */
export type ProviderTierOutcome =
  | 'ok'
  | 'invalid_request'
  | 'provider_not_found'
  | 'outbox_validation_failed'
  | 'error';

/**
 * Labels for one `provider_tier_transitions_total` increment. `from` /
 * `to` are the three-member {@link ProviderTier} union (a bounded 3×3
 * label space) and `reason` is the two-member {@link TierTransitionReason}
 * union — `auto_evaluation` from the evaluate path, `admin_override` from
 * the override path. No PII; cardinality fixed at compile time.
 */
export interface TierTransitionLabels {
  readonly from: ProviderTier;
  readonly to: ProviderTier;
  readonly reason: TierTransitionReason;
}

/**
 * Map a `ProviderCertificationsFailure` to its bounded
 * `provider_certifications_{granted,revoked}_total` outcome label. The
 * reason discriminants are themselves the bounded union members, so the
 * mapper is the identity on `reason` — typed so a new failure reason that
 * is not a {@link ProviderCertificationOutcome} member fails the
 * call-site type-check (the cardinality contract). Mirrors
 * `submitApplicationOutcome` (TS-051-followup-7).
 */
export function certificationFailureOutcome(
  failure: ProviderCertificationsFailure,
): ProviderCertificationOutcome {
  return failure.reason;
}

/**
 * Map a `TierPromotionFailure` to its bounded
 * `provider_tier_{evaluate,override}_duration_seconds` outcome label.
 * Identity on `reason`, same type-pinned cardinality contract as
 * {@link certificationFailureOutcome}.
 */
export function tierFailureOutcome(failure: TierPromotionFailure): ProviderTierOutcome {
  return failure.reason;
}

/**
 * service-provider's certifications + tier-promotion Prometheus
 * instruments (TS-052-followup-9).
 *
 * Five instruments cover the four write paths of the certifications
 * surface:
 *
 *   - `provider_certifications_granted_total{outcome}` +
 *     `provider_certification_grant_duration_seconds{outcome}` — every
 *     `ProviderCertificationsService.grant` call. A rising `already_active`
 *     rate is the normal duplicate-grant-retry signal from admin tooling;
 *     a rising `outbox_validation_failed` rate means the grant event
 *     payload drifted from its registered schema.
 *   - `provider_certifications_revoked_total{outcome}` +
 *     `provider_certification_revoke_duration_seconds{outcome}` — every
 *     `ProviderCertificationsService.revoke` call.
 *   - `provider_tier_transitions_total{from,to,reason}` — every applied
 *     tier transition, partitioned by the from/to tier and the trigger
 *     (`auto_evaluation` from the evaluate path, `admin_override` from
 *     the override path). The transition is recorded only when a tier
 *     actually changes (a no-op evaluate / override increments no
 *     transition).
 *   - `provider_tier_evaluate_duration_seconds{outcome}` +
 *     `provider_tier_override_duration_seconds{outcome}` — latency of the
 *     `TierPromotionService.evaluateAndApply` / `overrideTier` paths,
 *     bucketed by outcome so the cheap `invalid_request` /
 *     `provider_not_found` short-circuits don't skew the applied-path
 *     histograms. The `_count` of each histogram doubles as the
 *     per-outcome call count for the tier handlers.
 *
 * Label cardinality is bounded by construction — `outcome` is a fixed
 * string-literal union mapped through {@link certificationFailureOutcome}
 * / {@link tierFailureOutcome}, and `from` / `to` / `reason` are the
 * bounded tier + reason unions. No label is ever derived from a
 * providerId, certification id, actor / issuer / revoker userId, or any
 * free-text note (CLAUDE.md §3.9 / §10 / §17.2).
 *
 * Instruments are created via `getMeter`, which returns a usable no-op
 * meter when `initMetrics` was never called — so this class is safe to
 * construct in unit tests without booting the SDK. Mirrors the
 * `ApplicationsMetrics` (TS-051-followup-7) domain-instrument shape.
 */
@Injectable()
export class CertificationsMetrics {
  private readonly granted: Counter;
  private readonly grantDuration: Histogram;
  private readonly revoked: Counter;
  private readonly revokeDuration: Histogram;
  private readonly tierTransitions: Counter;
  private readonly tierEvaluateDuration: Histogram;
  private readonly tierOverrideDuration: Histogram;

  constructor() {
    const meter = getMeter(METER_NAME);
    this.granted = meter.createCounter('provider_certifications_granted_total', {
      description: 'Total provider-certification grants, by outcome.',
    });
    this.grantDuration = meter.createHistogram('provider_certification_grant_duration_seconds', {
      description: 'Latency of grant processing, in seconds, by outcome.',
      unit: 's',
    });
    this.revoked = meter.createCounter('provider_certifications_revoked_total', {
      description: 'Total provider-certification revocations, by outcome.',
    });
    this.revokeDuration = meter.createHistogram('provider_certification_revoke_duration_seconds', {
      description: 'Latency of revoke processing, in seconds, by outcome.',
      unit: 's',
    });
    this.tierTransitions = meter.createCounter('provider_tier_transitions_total', {
      description: 'Total applied provider-tier transitions, by from/to tier and reason.',
    });
    this.tierEvaluateDuration = meter.createHistogram('provider_tier_evaluate_duration_seconds', {
      description: 'Latency of tier evaluateAndApply processing, in seconds, by outcome.',
      unit: 's',
    });
    this.tierOverrideDuration = meter.createHistogram('provider_tier_override_duration_seconds', {
      description: 'Latency of tier overrideTier processing, in seconds, by outcome.',
      unit: 's',
    });
  }

  /** Record one `grant` outcome (counter + latency histogram). */
  recordGrant(outcome: ProviderCertificationOutcome, seconds: number): void {
    this.granted.add(1, { outcome });
    this.grantDuration.record(seconds, { outcome });
  }

  /** Record one `revoke` outcome (counter + latency histogram). */
  recordRevoke(outcome: ProviderCertificationOutcome, seconds: number): void {
    this.revoked.add(1, { outcome });
    this.revokeDuration.record(seconds, { outcome });
  }

  /**
   * Record one `evaluateAndApply` outcome (latency histogram) plus the
   * applied tier transition, if any.
   */
  recordTierEvaluate(
    outcome: ProviderTierOutcome,
    seconds: number,
    transition: TierTransitionLabels | null,
  ): void {
    this.tierEvaluateDuration.record(seconds, { outcome });
    if (transition !== null) {
      this.recordTierTransition(transition);
    }
  }

  /**
   * Record one `overrideTier` outcome (latency histogram) plus the
   * applied tier transition, if any.
   */
  recordTierOverride(
    outcome: ProviderTierOutcome,
    seconds: number,
    transition: TierTransitionLabels | null,
  ): void {
    this.tierOverrideDuration.record(seconds, { outcome });
    if (transition !== null) {
      this.recordTierTransition(transition);
    }
  }

  private recordTierTransition(transition: TierTransitionLabels): void {
    this.tierTransitions.add(1, {
      from: transition.from,
      to: transition.to,
      reason: transition.reason,
    });
  }
}
