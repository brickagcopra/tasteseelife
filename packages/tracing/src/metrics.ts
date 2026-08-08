import { diag, type Meter, metrics as otelMetrics } from '@opentelemetry/api';
import { PrometheusSerializer } from '@opentelemetry/exporter-prometheus';
import { Resource } from '@opentelemetry/resources';
import {
  AggregationTemporality,
  type CollectionResult,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';

const ATTR_SERVICE_NAME = 'service.name';
const ATTR_SERVICE_VERSION = 'service.version';
const ATTR_DEPLOYMENT_ENVIRONMENT = 'deployment.environment';

const METER_PROVIDER_VERSION = '0.0.0';

export interface InitMetricsOptions {
  /** Bounded-context service name — emitted as `service.name` resource attribute. Required. */
  service: string;
  /** Deployment environment label. Defaults to `NODE_ENV` then `development`. */
  env?: string;
  /** Build / image version tag — emitted as `service.version`. Optional. */
  version?: string;
  /** Set to `false` to no-op (e.g. in tests, in CLI scripts). Defaults to `true`. */
  enabled?: boolean;
  /** Extra resource attributes baked into every metric. */
  resourceAttributes?: Record<string, string | number | boolean>;
  /**
   * How often the in-memory reader sweeps recorded measurements into the
   * exporter's local cache. The `/metrics` endpoint serialises whatever's in
   * the cache at scrape time, so this interval bounds the staleness of a
   * value reported to Prometheus. Defaults to 10s — well under Prometheus's
   * typical 15s/30s scrape interval, so a Prometheus scrape never sees data
   * older than one local interval.
   */
  exportIntervalMillis?: number;
}

interface ActiveMetrics {
  readonly provider: MeterProvider;
  readonly reader: PeriodicExportingMetricReader;
  readonly exporter: InMemoryMetricExporter;
}

let active: ActiveMetrics | undefined;

/**
 * Boot the OpenTelemetry metrics SDK with the platform's standard
 * configuration: a single `MeterProvider` wired to an in-process
 * `InMemoryMetricExporter` swept on a fixed interval by a
 * `PeriodicExportingMetricReader`. The provider is registered globally so
 * any code in the process can call `metrics.getMeter(...)` (or our
 * convenience `getMeter` re-export) without holding a reference to the
 * provider.
 *
 * The Prometheus exposition endpoint is intentionally NOT exposed by this
 * function — services mount their own `/metrics` HTTP handler that calls
 * `serializeMetrics()` on demand. This keeps the OTel SDK out of the HTTP
 * server lifecycle entirely (the `PrometheusExporter` from
 * `@opentelemetry/exporter-prometheus` starts its own HTTP server by
 * default, which is awkward in K8s where we want a single pod port
 * exposing both the app + the scrape endpoint).
 *
 * Idempotent only via the `enabled: false` short-circuit. A second call
 * with `enabled !== false` throws so misconfiguration surfaces loudly
 * rather than silently dropping measurements.
 */
export function initMetrics(options: InitMetricsOptions): void {
  if (options.enabled === false) return;
  if (active !== undefined) {
    throw new Error(
      'initMetrics: already initialized; call shutdownMetrics() before reinitializing',
    );
  }

  const env = options.env ?? process.env['NODE_ENV'] ?? 'development';
  const intervalMs = options.exportIntervalMillis ?? 10_000;

  const attributes: Record<string, string | number | boolean> = {
    [ATTR_SERVICE_NAME]: options.service,
    [ATTR_DEPLOYMENT_ENVIRONMENT]: env,
    ...(options.resourceAttributes ?? {}),
  };
  if (options.version !== undefined) {
    attributes[ATTR_SERVICE_VERSION] = options.version;
  }

  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: intervalMs,
    exportTimeoutMillis: Math.min(intervalMs, 5_000),
  });

  const provider = new MeterProvider({
    resource: new Resource(attributes),
    readers: [reader],
  });

  otelMetrics.setGlobalMeterProvider(provider);
  active = { provider, reader, exporter };
}

/**
 * Flush and dispose the metrics provider. Call from a SIGTERM / SIGINT
 * handler alongside `shutdownTracing` so graceful shutdown does not drop
 * the last batch of telemetry.
 */
export async function shutdownMetrics(): Promise<void> {
  if (active === undefined) return;
  const handle = active;
  active = undefined;
  try {
    await handle.reader.forceFlush();
  } catch (err) {
    diag.warn('shutdownMetrics: forceFlush failed', err);
  }
  await handle.provider.shutdown();
  otelMetrics.disable();
}

/**
 * Convenience wrapper over `metrics.getMeter(name)` from the OTel API.
 * Use this when wiring custom instruments (counters, histograms) from a
 * service module — the meter name should namespace the instruments
 * (`service-identity:http`, `service-identity:lockout`, etc.) so
 * dashboards can filter by source.
 */
export function getMeter(name: string, version: string = METER_PROVIDER_VERSION): Meter {
  return otelMetrics.getMeter(name, version);
}

/**
 * Render the current metric values in Prometheus text exposition format.
 * Called by each service's `/metrics` controller on every scrape.
 *
 * Forces a synchronous collection so the response reflects the latest
 * recorded values — the periodic reader's interval bounds the worst-case
 * staleness, but on each scrape we still want the freshest snapshot.
 *
 * Returns an empty Prometheus document (just a trailing newline) when
 * metrics are disabled — the scrape endpoint stays 200 OK so Prometheus
 * doesn't alert on a missing target.
 */
export async function serializeMetrics(): Promise<string> {
  if (active === undefined) return '\n';

  const collected = await active.reader.collect();
  const serializer = new PrometheusSerializer();
  return serializer.serialize(toResourceMetrics(collected));
}

/**
 * The `PrometheusSerializer.serialize` API accepts a `ResourceMetrics`
 * shape; `MetricReader.collect()` returns `CollectionResult` which has
 * the same structure under a `resourceMetrics` key plus an `errors`
 * array. This tiny adapter pulls the shape out.
 */
function toResourceMetrics(
  collected: CollectionResult,
): Parameters<PrometheusSerializer['serialize']>[0] {
  return collected.resourceMetrics;
}
