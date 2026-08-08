import { randomUUID } from 'node:crypto';

import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { captureException } from '@taste-and-see/sentry/node';
import type { Request, Response } from 'express';

/**
 * Global exception filter — converts every error into an RFC 7807 Problem
 * Details JSON response (CLAUDE.md §5.1: "Errors: RFC 7807 Problem Details.
 * Always include `traceId`.").
 *
 * Behaviour:
 *
 * - `HttpException` thrown by controllers (or by `ZodValidationPipe`) is
 *   re-shaped — if the exception's response body already has the Problem
 *   Details fields (set by the pipe / a controller), they're preserved and
 *   only the `traceId` and `instance` are filled in. Otherwise we
 *   synthesise a minimal payload from the exception status + message.
 *
 *   "Preserved" means an **allow-list**, not a spread: `type`, `title`,
 *   `detail`, plus the extension members `errors`, `code` and `issues`.
 *   Anything else a caller attached to the exception body is dropped, because
 *   an exception body is a convenient place for internal detail to
 *   accumulate and a spread would ship all of it. Adding an extension member
 *   is therefore a deliberate edit here — TS-510 is a cautionary example: four
 *   features had been attaching a `code` for clients to branch on and none of
 *   them ever received it.
 *
 * - Anything that escapes as a non-`HttpException` is treated as an
 *   internal error (HTTP 500). The message is NOT echoed to the client —
 *   only `detail: "An unexpected error occurred."` so we don't leak stack
 *   traces, file paths, or DB driver internals (CLAUDE.md §3.9 silent
 *   leakage; §17.2 PII / secret logging discipline).
 *
 * `traceId` here is sourced from the `x-request-id` / `x-trace-id` headers
 * if present (set by an upstream load-balancer or gateway), and falls back
 * to a fresh UUID. Once `@taste-and-see/tracing` is wired into a service,
 * the OpenTelemetry span ID becomes the canonical source — this filter is
 * forward-compatible.
 */
@Catch()
export class RfcProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(RfcProblemFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const traceId = extractTraceId(request);

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      // 5xx only. A 4xx is a business outcome — validation rejected the
      // payload, a permission gate held, a row was not found — and reporting
      // those would bury the failures under a stream of things working
      // correctly. A 5xx is us: an `InternalServerErrorException`, or the
      // gateway's 502 on downstream contract drift, which is a deploy-skew
      // signal worth a page-worthy trail.
      if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
        reportToSentry(exception, request, traceId, status);
      }
      const body = buildProblemBody(exception, status, request.url, traceId);
      response.status(status).json(body);
      return;
    }

    // Unhandled / non-HTTP exception → 500. Log full detail server-side,
    // return a deliberately uninformative body to the client.
    this.logger.error(
      {
        traceId,
        path: request.url,
        method: request.method,
        err:
          exception instanceof Error
            ? { message: exception.message, stack: exception.stack }
            : exception,
      },
      'unhandled exception',
    );

    // This filter is the ONLY place an unhandled in-request error can be
    // reported. Nest catches it before it can reach `process`, so Sentry's
    // `onUncaughtException` integration never sees it — without this call the
    // fleet would report crashes and background-job failures while silently
    // dropping every 500 a user actually hit (TS-504-followup-2a).
    reportToSentry(exception, request, traceId, HttpStatus.INTERNAL_SERVER_ERROR);

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: 'An unexpected error occurred.',
      instance: request.url,
      traceId,
    });
  }
}

/**
 * Hand the error to Sentry with just enough context to find it again.
 *
 * A no-op when Sentry is unconfigured, so this costs nothing in development
 * and needs no guard at the call site.
 *
 * What travels: the trace id (which joins the report to the span in the OTLP
 * collector), the HTTP method, the status, and the **route path** — never the
 * request body, headers, or query string. `sendDefaultPii: false` and
 * `beforeSend` would strip the worst of it anyway, but the cheapest way to
 * keep a family's booking payload out of a third-party processor is not to
 * put it in the envelope. `request.url` carries the query component, so it is
 * scrubbed on the way past rather than sent raw.
 */
function reportToSentry(
  exception: unknown,
  request: Request,
  traceId: string,
  status: number,
): void {
  captureException(exception, {
    traceId,
    method: request.method,
    status,
    path: request.route?.path ?? stripQuery(request.url),
  });
}

/**
 * Drop the query component entirely rather than scrubbing it param by param.
 * Here we are choosing what to include, not filtering what arrived, and a
 * path is enough to locate the handler.
 */
function stripQuery(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

interface ProblemDetailsBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly traceId: string;
  readonly errors?: unknown;
  /** RFC 7807 §3.1 extension members. Each is allow-listed in `buildProblemBody`. */
  readonly code?: string;
  readonly issues?: unknown;
  readonly allowedStatuses?: readonly string[];
}

function buildProblemBody(
  exception: HttpException,
  status: number,
  instance: string,
  traceId: string,
): ProblemDetailsBody {
  const raw = exception.getResponse();

  // `getResponse()` returns a string when the controller threw e.g.
  // `new BadRequestException('something')`, and an object when the body
  // was already shaped (our pipe + controllers).
  if (typeof raw === 'string') {
    return {
      type: 'about:blank',
      title: defaultTitle(status),
      status,
      detail: raw,
      instance,
      traceId,
    };
  }

  if (raw === null || typeof raw !== 'object') {
    return {
      type: 'about:blank',
      title: defaultTitle(status),
      status,
      detail: exception.message,
      instance,
      traceId,
    };
  }

  const r = raw as Record<string, unknown>;
  return {
    type: typeof r['type'] === 'string' ? r['type'] : 'about:blank',
    title: typeof r['title'] === 'string' ? r['title'] : defaultTitle(status),
    status,
    detail:
      typeof r['detail'] === 'string'
        ? r['detail']
        : typeof r['message'] === 'string'
          ? r['message']
          : exception.message,
    instance,
    traceId,
    ...(r['errors'] !== undefined && { errors: r['errors'] }),
    // TS-510 — `code` is the machine-readable discriminator RFC 7807 §3.1
    // reserves extension members for, and it was being silently dropped.
    //
    // Four shipped features add it to their problem bodies for a client to
    // branch on: the admin MFA-enrolment gate and the SSO gate
    // (`AUTH_GATE_PROBLEM_CODE`, TS-023-followup-1 / TS-296) and the three
    // email-verification rejections (`EMAIL_VERIFICATION_PROBLEM_CODE`).
    // None of them ever received it. `apps/web-admin`'s login action is why
    // that went unnoticed: it reads `code` but falls back to
    // `/mfa|multi-factor/i.test(detail)`, and the regex over human-facing copy
    // — precisely what the contract's doc-block says the code exists to avoid
    // — was carrying the whole feature.
    //
    // Narrowly allow-listed and type-guarded rather than spreading `r`: a
    // blanket spread would echo whatever a caller happened to attach to an
    // exception body, which is how a stack trace or an internal id reaches a
    // client.
    ...(typeof r['code'] === 'string' && { code: r['code'] }),
    // `issues` is the Zod issue array the api-gateway's proxies attach when
    // they reject a payload before calling downstream. Same class of drop:
    // set at four call sites, delivered at none.
    ...(Array.isArray(r['issues']) && { issues: r['issues'] }),
    // TS-305d-followup-2b1b — the third instance of exactly the drop described
    // above, found when the revived integration lane asserted it.
    // `visit-notes.controller.ts` attaches `allowedStatuses` to its 409 so a
    // provider's client can say "visible after you check in" instead of a bare
    // conflict; the field never left the process. Same guard shape as `issues`,
    // narrowed to strings because that is what the only producer sends and a
    // problem body is not a place to widen by default.
    ...(Array.isArray(r['allowedStatuses']) &&
      r['allowedStatuses'].every((value) => typeof value === 'string') && {
        allowedStatuses: r['allowedStatuses'],
      }),
  };
}

function defaultTitle(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'Bad Request';
    case HttpStatus.UNAUTHORIZED:
      return 'Unauthorized';
    case HttpStatus.FORBIDDEN:
      return 'Forbidden';
    case HttpStatus.NOT_FOUND:
      return 'Not Found';
    case HttpStatus.CONFLICT:
      return 'Conflict';
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return 'Unprocessable Entity';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'Too Many Requests';
    case HttpStatus.SERVICE_UNAVAILABLE:
      return 'Service Unavailable';
    default:
      return status >= 500 ? 'Internal Server Error' : 'Error';
  }
}

function extractTraceId(request: Request): string {
  const headers = request.headers;
  const candidates = [headers['x-trace-id'], headers['x-request-id'], headers['traceparent']];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return randomUUID();
}
