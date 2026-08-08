import {
  type CallHandler,
  ConflictException,
  type ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { withSpan } from '@taste-and-see/tracing';
import type { Request, Response } from 'express';
import { from, type Observable, of } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';

import type { ValidatedOptions } from '../config';
import { IDEMPOTENT_METADATA } from '../decorators/idempotent.decorator';
import { IDEMPOTENCY_OPTIONS_TOKEN, IDEMPOTENCY_STORE_TOKEN } from '../module/tokens';
import { elapsedSeconds, IdempotencyMetrics } from '../observability/idempotency-metrics';
import { formatIdempotencyKey, hashRequestBody } from '../store/key';
import type { CompletedRecord, IdempotencyStore } from '../store/types';

/**
 * Header name. Lowercased — Express normalises incoming headers.
 */
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/**
 * Loose bounds on the raw client-supplied key. Inside the package we
 * SHA-256 the key (`store/key.ts`) so the stored Redis key is fixed at
 * 64 hex chars regardless of input length. These bounds exist to reject
 * obviously-junk values (empty / single-char) and to cap log noise on
 * pathological inputs (clients sending megabyte keys). The consumer's
 * own contract (e.g. `SUBSCRIPTION_IDEMPOTENCY_KEY_MIN_LENGTH = 8` in
 * service-subscription) may be stricter.
 */
const RAW_KEY_MIN_LENGTH = 1;
const RAW_KEY_MAX_LENGTH = 1024;

/**
 * `IdempotencyInterceptor` — CLAUDE.md §3.3 / §17.5 implementation.
 *
 * Lifecycle of a request flagged with `@Idempotent()`:
 *
 *   1. Read `Idempotency-Key` header. If absent or malformed, pass
 *      through to the handler with no caching (the original behaviour).
 *   2. Resolve the actor scope via the configured resolver (default:
 *      `request.requestContext.userId` → `request.user.id` → `anonymous`).
 *   3. Hash the request body (SHA-256 over the parsed body).
 *   4. Format the Redis key per CLAUDE.md §3.7.
 *   5. Atomically claim the slot. Branch on the outcome:
 *
 *        `claimed`            — proceed to the handler; on success
 *                               persist the response; on failure either
 *                               persist (cacheable status) or release.
 *        `cached_hit`         — short-circuit and replay the cached
 *                               response (same status code, body, and
 *                               Content-Type).
 *        `cached_mismatch`    — 409 Conflict. Same key reused with a
 *                               different body — client bug.
 *        `in_flight`          — 409 Conflict + Retry-After header.
 *        `unavailable`        — log a warning and proceed without
 *                               caching (CLAUDE.md §4.3: caches are
 *                               best-effort).
 *
 * The interceptor never returns 5xx itself — internal errors degrade
 * to "proceed without caching" (best-effort).
 *
 * **Observability (TS-044-followup-4; PDD §20.5; CLAUDE.md §10).** Every
 * request that reaches the claim step runs inside an `idempotency.claim` OTel
 * span tagged with the resolved `idempotency.decision`, increments the
 * `idempotency_decisions_total{decision}` counter exactly once, and records its
 * claim-to-complete latency on `idempotency_operation_duration_seconds`. The
 * early pass-throughs (handler not flagged, non-HTTP, missing key) make no
 * decision and emit nothing. {@link IdempotencyMetrics} defaults to a no-op
 * meter, so this stays correct in services that haven't wired the metrics SDK.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(IDEMPOTENCY_STORE_TOKEN) private readonly store: IdempotencyStore,
    @Inject(IDEMPOTENCY_OPTIONS_TOKEN) private readonly options: ValidatedOptions,
    private readonly metrics: IdempotencyMetrics = new IdempotencyMetrics(),
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const handler = context.getHandler();
    const klass = context.getClass();
    const isIdempotent =
      this.reflector.get<boolean | undefined>(IDEMPOTENT_METADATA, handler) === true ||
      this.reflector.get<boolean | undefined>(IDEMPOTENT_METADATA, klass) === true;
    if (!isIdempotent) {
      return next.handle();
    }

    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const rawKey = readHeader(request);
    if (rawKey === null) {
      return next.handle();
    }

    const actor = this.options.actorResolver(request as unknown as ActorReq) ?? 'anonymous';
    const bodyHash = hashRequestBody((request as Request & { body?: unknown }).body);

    const redisKey = formatIdempotencyKey({
      environment: this.options.environment,
      serviceName: this.options.serviceName,
      actor: sanitiseActor(actor),
      rawKey,
    });

    // Measured from just before the claim so the `claimed` decision's latency
    // is true claim-to-complete (handler execution + persistence), while the
    // short-circuit decisions report just the claim round-trip.
    const startNs = process.hrtime.bigint();
    const claim = await withSpan('idempotency.claim', async (span) => {
      const outcome = await this.store.claim(redisKey, bodyHash);
      span.setAttribute('idempotency.decision', outcome.kind);
      span.setAttribute('idempotency.service', this.options.serviceName);
      return outcome;
    });
    this.metrics.recordDecision(claim.kind);

    switch (claim.kind) {
      case 'cached_hit':
        this.metrics.recordDuration(claim.kind, elapsedSeconds(startNs));
        return of(this.replay(response, claim.record));

      case 'cached_mismatch':
        this.metrics.recordDuration(claim.kind, elapsedSeconds(startNs));
        throw new ConflictException({
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail:
            'Idempotency-Key reused with a different request body. Either retry with the original body or use a new Idempotency-Key.',
        });

      case 'in_flight':
        this.metrics.recordDuration(claim.kind, elapsedSeconds(startNs));
        response.setHeader('Retry-After', String(claim.ttlSeconds));
        throw new ConflictException({
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'A request with this Idempotency-Key is still in progress. Retry shortly.',
        });

      case 'unavailable':
        this.metrics.recordDuration(claim.kind, elapsedSeconds(startNs));
        this.logger.warn(
          { cause: failureSummary(claim.cause) },
          'idempotency store unavailable; proceeding without cache',
        );
        return next.handle();

      case 'claimed':
        // fall through to the handler
        break;
    }

    return next.handle().pipe(
      mergeMap(async (value: unknown) => {
        const statusCode = response.statusCode;
        if (this.options.shouldCacheStatus(statusCode)) {
          await this.store.complete(redisKey, {
            bodyHash,
            statusCode,
            body: safeStringify(value),
            contentType: 'application/json',
          });
        } else {
          await this.store.release(redisKey);
        }
        this.metrics.recordDuration('claimed', elapsedSeconds(startNs));
        return value;
      }),
      catchError((err: unknown) =>
        from(
          this.persistError(redisKey, bodyHash, err).then(() => {
            this.metrics.recordDuration('claimed', elapsedSeconds(startNs));
            throw err;
          }),
        ),
      ),
    );
  }

  private async persistError(key: string, bodyHash: string, err: unknown): Promise<void> {
    if (err instanceof HttpException) {
      const status = err.getStatus();
      if (this.options.shouldCacheStatus(status)) {
        const raw = err.getResponse();
        await this.store.complete(key, {
          bodyHash,
          statusCode: status,
          body: safeStringify(raw),
          contentType: 'application/json',
        });
        return;
      }
    }
    // Non-HttpException OR a status we don't cache (5xx). Release the
    // in-flight marker so retries can attempt fresh.
    await this.store.release(key);
  }

  private replay(response: Response, record: CompletedRecord): unknown {
    response.status(record.statusCode);
    response.setHeader('Content-Type', record.contentType);
    response.setHeader('X-Idempotent-Replay', 'true');
    return parseCachedBody(record.body);
  }
}

interface ActorReq {
  readonly requestContext?: { readonly userId?: string | null };
  readonly user?: { readonly id?: string | null };
}

function readHeader(request: Request): string | null {
  const raw = request.headers[IDEMPOTENCY_KEY_HEADER];
  if (raw === undefined) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < RAW_KEY_MIN_LENGTH) return null;
  if (trimmed.length > RAW_KEY_MAX_LENGTH) return null;
  return trimmed;
}

function sanitiseActor(actor: string): string {
  // The key formatter rejects whitespace + ':' — collapse them to '_'
  // here so a stray space in a user id (unlikely but possible from a
  // custom resolver) doesn't crash the request.
  const collapsed = actor.replace(/[\s:]+/g, '_');
  return collapsed.length === 0 ? 'anonymous' : collapsed;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return 'null';
  }
}

function parseCachedBody(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function failureSummary(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return 'unknown';
}
