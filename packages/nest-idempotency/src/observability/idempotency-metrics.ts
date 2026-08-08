import { Injectable } from '@nestjs/common';
import { type Counter, getMeter, type Histogram } from '@taste-and-see/tracing';

import type { ClaimOutcome } from '../store/types';

const METER_NAME = '@taste-and-see/nest-idempotency';

/**
 * The bounded `decision` label space for the idempotency instruments.
 *
 * Derived from `ClaimOutcome['kind']` rather than hand-written so the metric
 * label space cannot drift from the store contract: add a new
 * {@link ClaimOutcome} variant in `store/types.ts` and this union widens in
 * lockstep, and `recordDecision` / `recordDuration` keep type-checking only
 * against the real outcome kinds. The five members are `claimed` /
 * `cached_hit` / `cached_mismatch` / `in_flight` / `unavailable` (CLAUDE.md
 * §3.3 / §17.5 lifecycle).
 */
export type IdempotencyDecision = ClaimOutcome['kind'];

/**
 * Prometheus instruments for the shared `@Idempotent()` interceptor
 * (TS-044-followup-4; PDD §20.5; CLAUDE.md §10).
 *
 * Two instruments, both keyed only by the bounded {@link IdempotencyDecision}
 * label:
 *
 *   - `idempotency_decisions_total{decision}` — one increment per request that
 *     reaches the claim step (the early pass-throughs — handler not flagged
 *     `@Idempotent()`, non-HTTP context, missing/malformed `Idempotency-Key` —
 *     make no decision and emit nothing). A rising `cached_hit` rate is the
 *     normal client-retry signal; a rising `cached_mismatch` rate flags a
 *     client reusing a key with a changed body; a rising `in_flight` rate flags
 *     concurrent retries racing a slow handler; a rising `unavailable` rate
 *     means Redis is down and the gate is degrading to "proceed without cache"
 *     (CLAUDE.md §4.3).
 *   - `idempotency_operation_duration_seconds{decision}` — claim-to-complete
 *     latency. For the four short-circuit decisions this is just the claim
 *     round-trip; for `claimed` it spans the full handler execution plus the
 *     `complete`/`release` write, so dashboards can separate the cheap
 *     short-circuits from the real protected work.
 *
 * **PII / cardinality discipline (CLAUDE.md §3.9, §10, §17.2).** The only label
 * is `decision`, a fixed five-member union by construction. No
 * `Idempotency-Key`, actor id, request body, or Redis key ever reaches a metric
 * label or span attribute — the raw key is SHA-256-hashed into the Redis key
 * inside the store and never surfaces here at all.
 *
 * Instruments are created via `getMeter`, which returns a usable no-op meter
 * when `initMetrics` was never called — so this class is safe to construct in
 * unit tests, and in any consuming service that has not wired the metrics SDK,
 * without booting OTel. Mirrors the `CouponMetrics` (TS-043-followup-8) /
 * `DunningMetrics` (TS-042-followup-8) domain-instrument shape.
 */
@Injectable()
export class IdempotencyMetrics {
  private readonly decisions: Counter;
  private readonly duration: Histogram;

  constructor() {
    const meter = getMeter(METER_NAME);
    this.decisions = meter.createCounter('idempotency_decisions_total', {
      description: 'Total @Idempotent() claim decisions, by decision kind.',
    });
    this.duration = meter.createHistogram('idempotency_operation_duration_seconds', {
      description: 'Idempotency claim-to-complete latency in seconds, by decision kind.',
      unit: 's',
    });
  }

  /** Record one claim decision (counter). Called once per request that reaches the claim step. */
  recordDecision(decision: IdempotencyDecision): void {
    this.decisions.add(1, { decision });
  }

  /** Record the claim-to-complete latency for one decision (histogram). */
  recordDuration(decision: IdempotencyDecision, seconds: number): void {
    this.duration.record(seconds, { decision });
  }
}

/** Elapsed wall-clock seconds since `startNs` (a `process.hrtime.bigint()` mark). */
export function elapsedSeconds(startNs: bigint): number {
  return Number(process.hrtime.bigint() - startNs) / 1e9;
}
