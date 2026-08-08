import { Injectable } from '@nestjs/common';
import { type Counter, getMeter, type Histogram } from '@taste-and-see/tracing';

const METER_NAME = 'service-ads:sponsored-listings';

/** Fill outcome of a sponsored resolve — bounded, derived from filled vs limit. */
export type SponsoredResolveOutcome = 'filled' | 'partial' | 'empty';

/**
 * Bucket a resolve by how many of its `limit` slots filled. `empty` covers
 * both "no candidates supplied" and "no candidate matched targeting".
 */
export function sponsoredResolveOutcome(
  filledCount: number,
  limit: number,
): SponsoredResolveOutcome {
  if (filledCount <= 0) return 'empty';
  if (filledCount >= limit) return 'filled';
  return 'partial';
}

/**
 * service-ads sponsored-listings delivery instruments (TS-218a-followup-3;
 * CLAUDE.md §10; PDD §20.5).
 *
 * One counter + two histograms span the resolve surface
 * (`SponsoredListingsService.resolve`, called by `service-search` to fill the
 * reserved sponsored slot(s) on a results page):
 *
 *   - `ads_sponsored_resolve_total{outcome}` — every resolve, partitioned by
 *     fill outcome (`filled` = all slots taken, `partial` = some, `empty` =
 *     none). A rising `empty` rate at steady traffic is the leading indicator
 *     of thin sponsored inventory or over-narrow targeting.
 *   - `ads_sponsored_slots_filled` (histogram) — sponsored slots filled per
 *     resolve. The fill-depth distribution behind monetisation yield.
 *   - `ads_sponsored_candidates` (histogram) — organic candidates considered
 *     per resolve. Sized against `slots_filled`, it shows how much of the
 *     organic page is eligible for sponsorship.
 *
 * Label cardinality is bounded by construction: the only label is the
 * three-value `outcome` union. The placement `slotCode` is deliberately NOT a
 * metric label — it is a free-form slug at the contract boundary
 * (`SponsoredListingSlotCodeSchema`), so it rides the resolve span instead
 * (spans tolerate high cardinality; metrics do not — CLAUDE.md §10). Provider
 * / campaign / creative ids never appear on labels.
 *
 * Instruments are created via `getMeter`, which returns a usable no-op meter
 * when `initMetrics` was never called — so this class is safe to construct in
 * unit tests without booting the SDK. Mirrors the `SearchMetrics` shape.
 */
@Injectable()
export class SponsoredListingsMetrics {
  private readonly resolves: Counter;
  private readonly slotsFilled: Histogram;
  private readonly candidates: Histogram;

  constructor() {
    const meter = getMeter(METER_NAME);
    this.resolves = meter.createCounter('ads_sponsored_resolve_total', {
      description: 'Total sponsored-listing resolves, by fill outcome',
    });
    this.slotsFilled = meter.createHistogram('ads_sponsored_slots_filled', {
      description: 'Number of sponsored slots filled per resolve',
    });
    this.candidates = meter.createHistogram('ads_sponsored_candidates', {
      description: 'Number of organic candidates considered per resolve',
    });
  }

  /** Record one resolve: its fill outcome, slots filled, and candidate count. */
  recordResolve(input: {
    readonly candidateCount: number;
    readonly filledCount: number;
    readonly limit: number;
  }): void {
    this.resolves.add(1, { outcome: sponsoredResolveOutcome(input.filledCount, input.limit) });
    this.slotsFilled.record(input.filledCount);
    this.candidates.record(input.candidateCount);
  }
}
