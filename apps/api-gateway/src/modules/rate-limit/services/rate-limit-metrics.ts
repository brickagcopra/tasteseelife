import { Injectable } from '@nestjs/common';
import { type Counter, getMeter } from '@taste-and-see/tracing';

const METER_NAME = 'api-gateway:rate-limit';

/**
 * How a rate-limit check resolved.
 *
 *   - `allowed` — under the ceiling; the request proceeded.
 *   - `blocked` — over the ceiling; the caller got a 429.
 *   - `unavailable` — **Redis failed and the limiter FAILED OPEN**. The
 *     request proceeded, so it is a 200 in every other signal on the
 *     platform.
 */
export type RateLimitOutcome = 'allowed' | 'blocked' | 'unavailable';

/**
 * Which kind of actor the limit was keyed on. Derived from the actor KEY,
 * never carrying it: `user:{id}` / `ip:{addr}` are unbounded-cardinality
 * values, and the second is personal data (CLAUDE.md §10 / §17.2).
 */
export type RateLimitActorKind = 'user' | 'ip' | 'unknown';

/**
 * The gateway's rate-limit instrument (TS-140-followup-4).
 *
 * `gateway_rate_limit_decisions_total{policy,outcome,actor_kind}` — and the
 * reason it earns its place next to the shared `http_server_requests_total`
 * is the `unavailable` outcome. When Redis fails, `RateLimitService` fails
 * OPEN by design (CLAUDE.md §4.3: caches are best-effort), so the request
 * succeeds, the status is whatever the downstream returned, and **nothing
 * anywhere on the platform says the gateway is currently unlimited**. The
 * guard sets an `X-RateLimit-Status: unavailable` response header for that
 * reason; a header the client sees and nobody dashboards is not a signal.
 * This is the series an alert can fire on.
 *
 * `blocked` is separable from the HTTP metric too, though less sharply: a
 * 429 in `http_server_requests_total` is a rate-limit rejection, but it
 * cannot say which POLICY rejected it, and `sensitive` firing is a
 * different event from `default` firing.
 *
 * `actor_kind` is derived, not the key: `user` / `ip` / `unknown`, three
 * values. It separates "one authenticated client is hammering us" from
 * "anonymous traffic is being throttled", which are different responses.
 * The IP itself never becomes a label — that is both an unbounded
 * cardinality problem and a personal-data one.
 *
 * Instruments come from `getMeter`, which returns a usable no-op meter when
 * `initMetrics` was never called — safe to construct in unit tests without
 * booting the SDK. api-gateway only stopped being that case in
 * TS-306-followup-1d, which is what unblocked this task.
 */
@Injectable()
export class RateLimitMetrics {
  private readonly decisions: Counter;

  constructor() {
    const meter = getMeter(METER_NAME);
    this.decisions = meter.createCounter('gateway_rate_limit_decisions_total', {
      description:
        'Total gateway rate-limit checks, by policy, outcome (allowed / blocked / unavailable) and actor kind.',
    });
  }

  /** Record one check. Called for every gated request, including the allowed majority. */
  recordDecision(policy: string, outcome: RateLimitOutcome, actorKind: RateLimitActorKind): void {
    this.decisions.add(1, { policy, outcome, actor_kind: actorKind });
  }
}

/**
 * Classify an actor key into its bounded kind.
 *
 * `resolveActorKey` produces `user:{id}`, `ip:{addr}`, or the literal
 * `ip:unknown` for a caller with no identity at all. That last one is
 * deliberately NOT reported as `ip`: it is the shared bucket every
 * header-less caller falls into, so counting it as a real address would
 * make one bucket look like one client.
 *
 * Exported so the guard has no classification logic of its own and the
 * rule is testable in isolation.
 */
export function actorKindFromKey(actorKey: string): RateLimitActorKind {
  if (actorKey === 'ip:unknown') return 'unknown';
  if (actorKey.startsWith('user:')) return 'user';
  if (actorKey.startsWith('ip:')) return 'ip';
  return 'unknown';
}
