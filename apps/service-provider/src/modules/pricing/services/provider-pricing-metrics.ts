import { Injectable } from '@nestjs/common';
import { type Counter, getMeter, type Histogram } from '@taste-and-see/tracing';

import type { ProviderPricingFailure } from './provider-pricing.service';

const METER_NAME = 'service-provider:pricing';

/**
 * Failure-side outcome labels for `provider_pricing_updates_total` +
 * `provider_pricing_update_duration_seconds`. Each member mirrors a
 * {@link ProviderPricingFailure} `reason` discriminant 1:1:
 * `invalid_request` (empty providerId / actorUserId), `not_found`
 * (provider row miss → 404), `forbidden` (actor doesn't own the row →
 * 403; admin override is TS-204-followup-3), `precondition_failed`
 * (stale `If-Match` → 412), `unsupported_currency` (non-USD → 422),
 * `out_of_band` (rate outside the tier band → 422), and
 * `outbox_validation_failed` (the producer-side outbox SDK rejected the
 * event payload → tx rolled back → 500).
 */
export type ProviderPricingFailureOutcome =
  | 'invalid_request'
  | 'not_found'
  | 'forbidden'
  | 'precondition_failed'
  | 'unsupported_currency'
  | 'out_of_band'
  | 'outbox_validation_failed';

/**
 * Outcome label for `provider_pricing_updates_total` + the matching
 * `provider_pricing_update_duration_seconds` histogram.
 *
 * The two success discriminants split the single `ok` return of
 * `ProviderPricingService.updatePricing` so the no-op short-circuit is
 * visible on the scrape surface (the TS-204-followup-4 acceptance names
 * it explicitly alongside set-rate + rejected-out-of-band):
 *   - `set` — a rate / currency change was persisted and a
 *     `provider.pricing_updated` outbox row appended.
 *   - `noop` — the requested rate + currency already matched the
 *     persisted pair, so the transaction was skipped and `updated_at`
 *     left untouched (the freshness-preserving short-circuit).
 *
 * The remaining members are the {@link ProviderPricingFailureOutcome}
 * failure subset, plus `error` — the unexpected-throw catch-all so a 500
 * stays visible on the scrape surface rather than mislabelling the
 * sample.
 *
 * All values are fixed string literals — bounded cardinality, no PII
 * (CLAUDE.md §10). Mirrors the `ProviderCertificationOutcome`
 * (TS-052-followup-9) shape.
 */
export type ProviderPricingOutcome = 'set' | 'noop' | ProviderPricingFailureOutcome | 'error';

/**
 * Map a `ProviderPricingFailure` to its bounded
 * `provider_pricing_updates_total` outcome label. The reason
 * discriminants are themselves the bounded union members, so the mapper
 * is the identity on `reason` — typed `ProviderPricingFailure →
 * ProviderPricingFailureOutcome` so a new failure reason that is not a
 * bounded outcome member fails the call-site type-check (the cardinality
 * contract). Mirrors `certificationFailureOutcome` (TS-052-followup-9).
 */
export function pricingFailureOutcome(
  failure: ProviderPricingFailure,
): ProviderPricingFailureOutcome {
  return failure.reason;
}

/**
 * service-provider's pricing-surface Prometheus instruments
 * (TS-204-followup-4).
 *
 * Two instruments cover the single write path of the pricing surface:
 *
 *   - `provider_pricing_updates_total{outcome}` — every
 *     `ProviderPricingService.updatePricing` call. A rising `out_of_band`
 *     rate is the signal that the per-tier band policy is mis-tuned
 *     against what providers want to charge; a rising `noop` rate means
 *     the editor is re-submitting unchanged forms; a rising
 *     `outbox_validation_failed` rate means the `provider.pricing_updated`
 *     event payload drifted from its registered schema.
 *   - `provider_pricing_update_duration_seconds{outcome}` — latency of
 *     the same path, bucketed by outcome so the cheap `not_found` /
 *     `forbidden` / `out_of_band` short-circuits don't skew the
 *     applied-write histogram. The `_count` doubles as the per-outcome
 *     call count.
 *
 * Label cardinality is bounded by construction — `outcome` is a fixed
 * string-literal union mapped through {@link pricingFailureOutcome} for
 * the failure paths. No label is ever derived from a providerId, actor
 * userId, hourly rate, or currency (CLAUDE.md §3.9 / §10 / §17.2).
 *
 * Instruments are created via `getMeter`, which returns a usable no-op
 * meter when `initMetrics` was never called — so this class is safe to
 * construct in unit tests without booting the SDK. Mirrors the
 * `CertificationsMetrics` (TS-052-followup-9) domain-instrument shape.
 */
@Injectable()
export class ProviderPricingMetrics {
  private readonly updates: Counter;
  private readonly updateDuration: Histogram;

  constructor() {
    const meter = getMeter(METER_NAME);
    this.updates = meter.createCounter('provider_pricing_updates_total', {
      description: 'Total provider-pricing update attempts, by outcome.',
    });
    this.updateDuration = meter.createHistogram('provider_pricing_update_duration_seconds', {
      description: 'Latency of pricing-update processing, in seconds, by outcome.',
      unit: 's',
    });
  }

  /** Record one `updatePricing` outcome (counter + latency histogram). */
  recordUpdate(outcome: ProviderPricingOutcome, seconds: number): void {
    this.updates.add(1, { outcome });
    this.updateDuration.record(seconds, { outcome });
  }
}
