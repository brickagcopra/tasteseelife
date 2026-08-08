import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { type Counter, getMeter, type Histogram } from '@taste-and-see/tracing';
import type { Request } from 'express';
import { type Observable, tap } from 'rxjs';

import { OBSERVABILITY_SERVICE_NAME } from './tokens';

/**
 * HTTP request observability (TS-022-followup-3a-followup-1, lifted from the
 * verbatim per-service copies in service-identity TS-020-followup-1,
 * service-provider TS-050-followup-1, and service-webhook
 * TS-041a-followup-4). Records two Prometheus instruments per request:
 *
 *   - `http_server_requests_total` (counter) — total requests handled,
 *     bucketed by `method` / `route` / `status_code`. Drives "requests
 *     per minute" + per-endpoint error rate dashboards.
 *   - `http_server_request_duration_seconds` (histogram) — request
 *     latency, same labels. The default OTel bucket boundaries cover
 *     ms-to-multi-second latency without per-route tuning.
 *
 * The meter name (`<serviceName>:http`) and the counter description are
 * derived from the injected `OBSERVABILITY_SERVICE_NAME` so a shared
 * package still attributes metrics to the concrete service.
 *
 * **PII discipline** (CLAUDE.md §10, §17.2): labels are RESTRICTED to
 * `method`, `route`, and `status_code` — never the raw URL, query string,
 * request body, or any user / senior / provider / Stripe / Checkr
 * identifier. The `route` label is the controller's path template (e.g.
 * `/api/v1/auth/signup`), NOT the concrete URL — so cardinality stays
 * bounded and a path containing an identifier never lands on a metric
 * label.
 *
 * The interceptor handles BOTH success and error paths:
 *   - On success → `tap.next` records the elapsed time + 2xx/3xx status.
 *   - On `HttpException` thrown from a controller (e.g. a 400 from a failed
 *     signature verification) → `tap.error` records the elapsed time + the
 *     exception's HTTP status (4xx/5xx).
 *   - On unhandled (non-`HttpException`) errors → status 500.
 *
 * Mounted globally via APP_INTERCEPTOR in `ObservabilityModule.forRoot`
 * (unless `httpMetrics: false` is passed — e.g. workers whose only HTTP
 * surface is health probes + the scrape route).
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  private readonly counter: Counter;
  private readonly histogram: Histogram;

  constructor(@Inject(OBSERVABILITY_SERVICE_NAME) serviceName: string) {
    const meter = getMeter(`${serviceName}:http`);
    this.counter = meter.createCounter('http_server_requests_total', {
      description: `Total HTTP requests handled by ${serviceName}`,
    });
    this.histogram = meter.createHistogram('http_server_request_duration_seconds', {
      description: 'HTTP request duration in seconds, observed at the controller boundary',
      unit: 's',
    });
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Only HTTP transports are instrumented — RPC / GraphQL / WS go to a
    // sibling interceptor when those surfaces land.
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const httpCtx = context.switchToHttp();
    const request = httpCtx.getRequest<Request>();
    const method = request.method;
    const route = extractRouteTemplate(request);
    const startNs = process.hrtime.bigint();

    return next.handle().pipe(
      tap({
        next: () => {
          // Nest may set the response status late (e.g. via @HttpCode);
          // by the time tap.next fires, the controller has resolved.
          const status = httpCtx.getResponse().statusCode ?? 200;
          this.record(method, route, status, startNs);
        },
        error: (err: unknown) => {
          const status = err instanceof HttpException ? err.getStatus() : 500;
          this.record(method, route, status, startNs);
        },
      }),
    );
  }

  private record(method: string, route: string, statusCode: number, startNs: bigint): void {
    const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
    const attributes = {
      method,
      route,
      status_code: String(statusCode),
    };
    this.counter.add(1, attributes);
    this.histogram.record(durationSeconds, attributes);
  }
}

/**
 * Extract the controller's path template from the Express request.
 * Express stamps the matched route on `request.route.path` for handlers
 * registered through Nest's router. Before the router matches (e.g. when
 * the request hits 404 before any controller), the template is unknown
 * — we fall back to the literal `unknown` label so the cardinality
 * doesn't explode with one-off 404 paths (CLAUDE.md §10).
 */
function extractRouteTemplate(request: Request): string {
  // Express types `request.route` as `unknown`-shaped at runtime; we narrow
  // safely without an `any` cast (CLAUDE.md §2.1, §17.4).
  const route = (request as { route?: { path?: unknown } }).route;
  if (route !== undefined && typeof route.path === 'string' && route.path.length > 0) {
    // The matched template might be relative to a controller's `@Controller('prefix')`.
    // Express composes them into `baseUrl + route.path` for nested routers; the
    // base path lives on `request.baseUrl`. Combine them so the metric label
    // matches the full path the client called.
    const baseUrl = typeof request.baseUrl === 'string' ? request.baseUrl : '';
    return `${baseUrl}${route.path}`;
  }
  return 'unknown';
}
