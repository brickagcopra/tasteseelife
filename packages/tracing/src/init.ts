import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';

const ATTR_SERVICE_NAME = 'service.name';
const ATTR_SERVICE_VERSION = 'service.version';
const ATTR_DEPLOYMENT_ENVIRONMENT = 'deployment.environment';

export interface InitTracingOptions {
  /** Bounded-context service name — emitted as `service.name` resource attribute. Required. */
  service: string;
  /** Deployment environment label. Defaults to `NODE_ENV` then `development`. */
  env?: string;
  /** Build / image version tag — emitted as `service.version`. Optional. */
  version?: string;
  /**
   * OTLP HTTP traces endpoint. Resolution order:
   *   options.endpoint → OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
   *   → OTEL_EXPORTER_OTLP_ENDPOINT (with `/v1/traces` appended if missing)
   *   → http://localhost:4318/v1/traces
   */
  endpoint?: string;
  /** Set to `false` to no-op (e.g. in tests, in CLI scripts). Defaults to `true`. */
  enabled?: boolean;
  /** Extra resource attributes baked into every span. */
  resourceAttributes?: Record<string, string | number | boolean>;
}

let activeSdk: NodeSDK | undefined;

/**
 * Boot the OpenTelemetry Node SDK with the platform's standard configuration:
 * OTLP HTTP trace exporter + the curated auto-instrumentation set (HTTP,
 * Express/NestJS, ioredis, pg, pino, etc.). Call this **before** importing
 * any service module that should be auto-instrumented — typically as the
 * very first line of `main.ts` (or via `--require` of a tracing bootstrap
 * file). The SDK installs hooks at module-load time; instrumenting modules
 * imported earlier is a no-op.
 *
 * Idempotent only via the `enabled: false` short-circuit. A second call with
 * `enabled !== false` throws so misconfiguration surfaces loudly rather than
 * silently dropping instrumentation.
 */
export function initTracing(options: InitTracingOptions): void {
  if (options.enabled === false) return;
  if (activeSdk !== undefined) {
    throw new Error(
      'initTracing: already initialized; call shutdownTracing() before reinitializing',
    );
  }

  const env = options.env ?? process.env['NODE_ENV'] ?? 'development';
  const endpoint = resolveEndpoint(options.endpoint);

  const attributes: Record<string, string | number | boolean> = {
    [ATTR_SERVICE_NAME]: options.service,
    [ATTR_DEPLOYMENT_ENVIRONMENT]: env,
    ...(options.resourceAttributes ?? {}),
  };
  if (options.version !== undefined) {
    attributes[ATTR_SERVICE_VERSION] = options.version;
  }

  activeSdk = new NodeSDK({
    resource: new Resource(attributes),
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    instrumentations: [getNodeAutoInstrumentations()],
  });

  activeSdk.start();
}

/**
 * Flush pending spans and tear down the SDK. Call from a SIGTERM / SIGINT
 * handler so graceful shutdown does not drop the last batch of telemetry.
 */
export async function shutdownTracing(): Promise<void> {
  if (activeSdk === undefined) return;
  const sdk = activeSdk;
  activeSdk = undefined;
  await sdk.shutdown();
}

function resolveEndpoint(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  const tracesEnv = process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'];
  if (tracesEnv !== undefined && tracesEnv.length > 0) return tracesEnv;
  const generic = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  if (generic !== undefined && generic.length > 0) {
    return generic.endsWith('/v1/traces') ? generic : `${stripTrailingSlash(generic)}/v1/traces`;
  }
  return 'http://localhost:4318/v1/traces';
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
