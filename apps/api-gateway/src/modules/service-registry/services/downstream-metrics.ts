import { Injectable } from '@nestjs/common';
import { type Counter, getMeter, type Histogram } from '@taste-and-see/tracing';

import type { DownstreamServiceName } from './service-registry';

const METER_NAME = 'api-gateway:downstream';

/**
 * How a downstream call terminated. **Mirrors `DownstreamResult`'s
 * discriminant exactly** — a seventh variant added to that union becomes a
 * compile error here rather than an unrecorded outcome, the same rule the
 * trust-safety pager metric follows (TS-306-followup-1c).
 */
export type DownstreamCallResult =
  | 'ok'
  | 'client_error'
  | 'server_error'
  | 'timeout'
  | 'network_error'
  | 'not_configured';

/**
 * Downstream-call instruments for the gateway's `fetch` wrapper
 * (TS-140-followup-4).
 *
 *   - `gateway_downstream_calls_total{service,result}` — every call the
 *     gateway makes into the cluster, by target and outcome.
 *   - `gateway_downstream_latency_seconds{service,result}` — how long it
 *     took, same labels.
 *
 * **The auto-instrumented `http` client spans do not make these redundant**,
 * and the reason is the result taxonomy. A span records a status; this
 * client already classifies each call into six states the gateway then
 * renders into six different upstream responses — a `timeout` becomes a 504,
 * a `network_error` a 502, a `not_configured` a 503 — and those are three
 * different operational problems (a slow service, an unreachable one, an env
 * gap nobody filled in). Collapsing them into "the call failed" throws away
 * exactly the distinction an on-call engineer needs at 3am. Spans carry the
 * per-request detail; this carries the rate, which is what an alert fires on.
 *
 * **`not_configured` is the one worth naming.** It means the registry has no
 * base URL for that service, so the gateway never made a call at all — a
 * deployment gap rather than a runtime failure, and one that is invisible in
 * any latency signal because it costs no time. It is also the failure that
 * looks like a working system in staging, where the service simply is not
 * deployed yet.
 *
 * **Labels are bounded and carry nothing about the caller**: `service` is the
 * closed `DownstreamServiceName` union, `result` is the six-state one. No
 * path, no query, no actor, no trace id — the path in particular would carry
 * ids (`/api/v1/households/{id}/...`), which is both unbounded cardinality
 * and personal data on a metric label (CLAUDE.md §10 / §17.2).
 *
 * Instruments come from `getMeter`, a usable no-op when `initMetrics` was
 * never called — safe to construct in unit tests without booting the SDK.
 */
@Injectable()
export class DownstreamMetrics {
  private readonly calls: Counter;
  private readonly latency: Histogram;

  constructor() {
    const meter = getMeter(METER_NAME);
    this.calls = meter.createCounter('gateway_downstream_calls_total', {
      description:
        'Total downstream service calls made by the gateway, by target service and result.',
    });
    this.latency = meter.createHistogram('gateway_downstream_latency_seconds', {
      description: 'Downstream call latency in seconds, by target service and result.',
      unit: 's',
    });
  }

  /**
   * Record one downstream call.
   *
   * A `not_configured` call is recorded with its (near-zero) elapsed time
   * rather than skipped: an absent series would make "we never call this
   * service" and "this service is unconfigured" indistinguishable, and the
   * second is a deployment gap somebody has to close.
   */
  recordCall(service: DownstreamServiceName, result: DownstreamCallResult, seconds: number): void {
    const attributes = { service, result };
    this.calls.add(1, attributes);
    this.latency.record(seconds, attributes);
  }
}
