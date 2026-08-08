import {
  BadGatewayException,
  Controller,
  GatewayTimeoutException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  FamilySeniorPhotoGalleryResponseSchema,
  SeniorConsentResponseSchema,
  SeniorPhotoGalleryQuerySchema,
  SeniorPhotoGalleryResponseSchema,
  type FamilySeniorPhotoGalleryResponse,
  type SeniorConsentResponse,
  type SeniorPhotoGalleryResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';

import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Consent-gated senior photo-gallery BFF aggregator (TS-232).
 *
 *   GET /api/v1/seniors/:seniorId/photos?limit=&cursor=
 *     Returns the photos a senior has agreed to share with family
 *     observers. Aggregates two upstreams:
 *
 *       1. `service-household` — the senior's consent record
 *          (`GET /api/v1/seniors/:seniorId/consent`, TS-238) read with the
 *          actor's own token. This call is BOTH the consent gate AND the
 *          household-membership gate: a non-member gets the downstream
 *          403/404 verbatim, so a foreign senior id can't be probed.
 *       2. `service-media` — the senior's `ready` `senior_photo` assets
 *          (`GET /api/v1/media/seniors/:seniorId/photos`), called only
 *          when the caller is allowed to see them.
 *
 * **The consent gate (CLAUDE.md §12 — default opt-out).** The consent
 * record carries `canManage` (true for the primary payer + senior
 * end-user) and the four surface flags. The caller may see photos when
 * `canManage` is true (manager / senior — they always see what they
 * manage) OR `photos` is true (a family observer the senior has shared
 * photos with). Otherwise `shared: false` with an empty gallery — the
 * photos never cross. A senior with no consent row defaults to all-false,
 * so an observer sees nothing until the senior opts in.
 *
 * **Failure modes.**
 *   - 401 — missing/invalid access token (AccessTokenGuard).
 *   - 400 — malformed query (limit out of range / unknown field).
 *   - 403 / 404 — propagated verbatim from the consent read (non-member /
 *     missing senior).
 *   - 502 — either upstream unreachable / returned a malformed body.
 *   - 503 — HOUSEHOLD_SERVICE_BASE_URL / MEDIA_SERVICE_BASE_URL unset.
 *   - 504 — either upstream times out.
 *
 * Read-only — no idempotency-key handling (GET is naturally idempotent).
 * RFC 7807 problem-details bodies with traceId propagation throughout.
 */
@Controller('api/v1/seniors')
@UseGuards(AccessTokenGuard, RateLimitGuard)
export class SeniorPhotosAggregatorController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get(':seniorId/photos')
  @HttpCode(HttpStatus.OK)
  async getSeniorPhotos(
    @Param('seniorId') seniorId: string,
    @Query() query: unknown,
    @Req() request: RequestWithContext,
  ): Promise<FamilySeniorPhotoGalleryResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsedQuery = SeniorPhotoGalleryQuerySchema.safeParse(query ?? {});
    if (!parsedQuery.success) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: HttpStatus.BAD_REQUEST,
          detail: 'Senior-photos query failed validation.',
          issues: parsedQuery.error.issues,
          ...(traceId !== undefined && { traceId }),
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Step 1 — the consent read. This both authorises household membership
    // (403/404 verbatim for a non-member / missing senior) and tells us
    // whether the caller may see photos.
    const consentResult = await this.downstream.call({
      service: 'household',
      path: `/api/v1/seniors/${encodeURIComponent(seniorId)}/consent`,
      method: 'GET',
      actor: ctx,
      traceId,
    });
    const consent = mapConsentResult(consentResult, traceId);

    // The gate: managers (payer / senior) always see; an observer sees
    // only when the senior has turned the `photos` surface on. Default
    // opt-out — a missing consent row reads all-false.
    const shared = consent.canManage || consent.photos;
    if (!shared) {
      return FamilySeniorPhotoGalleryResponseSchema.parse({
        seniorId,
        shared: false,
        photos: [],
        nextCursor: null,
      });
    }

    // Step 2 — the media list. Forward the validated limit + cursor.
    const search = new URLSearchParams({ limit: String(parsedQuery.data.limit) });
    if (parsedQuery.data.cursor !== undefined) {
      search.set('cursor', parsedQuery.data.cursor);
    }
    const mediaResult = await this.downstream.call({
      service: 'media',
      path: `/api/v1/media/seniors/${encodeURIComponent(seniorId)}/photos?${search.toString()}`,
      method: 'GET',
      actor: ctx,
      traceId,
    });
    const gallery = mapMediaResult(mediaResult, traceId);

    // Parse the composed aggregate at the boundary so any future drift
    // between the media projection + the published family contract
    // surfaces here rather than at the web-family consumer.
    return FamilySeniorPhotoGalleryResponseSchema.parse({
      seniorId,
      shared: true,
      photos: gallery.photos,
      nextCursor: gallery.nextCursor,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Per-upstream result mappers — each names its downstream service in the
// failure detail so an operator can tell consent failures from media
// failures at a glance.
// ─────────────────────────────────────────────────────────────────────

function mapConsentResult(
  result: DownstreamResult,
  traceId: string | undefined,
): SeniorConsentResponse {
  switch (result.kind) {
    case 'ok': {
      const parsed = SeniorConsentResponseSchema.safeParse(result.body);
      if (!parsed.success) {
        throw new BadGatewayException(
          problem(
            'Downstream service-household returned a body that does not conform to the consent contract.',
            traceId,
          ),
        );
      }
      return parsed.data;
    }
    case 'client_error': {
      // 403 (non-member) / 404 (missing senior) propagate verbatim — the
      // photos gallery's membership gate is the consent read's own.
      throw new HttpException(
        toBodyOrFallback(result.body, 'Downstream client error.'),
        result.status,
      );
    }
    case 'server_error':
      throw new BadGatewayException(
        problem('Downstream service-household returned an unsuccessful response.', traceId),
      );
    case 'timeout':
      throw new GatewayTimeoutException(
        timeout('Downstream service-household did not respond within the timeout window.', traceId),
      );
    case 'network_error':
      throw new BadGatewayException(
        problem('Downstream service-household is unreachable.', traceId),
      );
    case 'not_configured':
      throw new ServiceUnavailableException(
        unavailable(
          "Gateway has no route for the 'household' service. Configure HOUSEHOLD_SERVICE_BASE_URL.",
          traceId,
        ),
      );
  }
}

function mapMediaResult(
  result: DownstreamResult,
  traceId: string | undefined,
): SeniorPhotoGalleryResponse {
  switch (result.kind) {
    case 'ok': {
      const parsed = SeniorPhotoGalleryResponseSchema.safeParse(result.body);
      if (!parsed.success) {
        throw new BadGatewayException(
          problem(
            'Downstream service-media returned a body that does not conform to the senior-photos contract.',
            traceId,
          ),
        );
      }
      return parsed.data;
    }
    case 'client_error':
      // The gateway already authorised the caller via the consent read
      // and validated the query; a 4xx from media here is unexpected
      // (mis-wiring), so surface it as a 502 rather than leaking the
      // internal status to the family client.
      throw new BadGatewayException(
        problem(
          `Downstream service-media rejected the request (status ${result.status}).`,
          traceId,
        ),
      );
    case 'server_error':
      throw new BadGatewayException(
        problem('Downstream service-media returned an unsuccessful response.', traceId),
      );
    case 'timeout':
      throw new GatewayTimeoutException(
        timeout('Downstream service-media did not respond within the timeout window.', traceId),
      );
    case 'network_error':
      throw new BadGatewayException(problem('Downstream service-media is unreachable.', traceId));
    case 'not_configured':
      throw new ServiceUnavailableException(
        unavailable(
          "Gateway has no route for the 'media' service. Configure MEDIA_SERVICE_BASE_URL.",
          traceId,
        ),
      );
  }
}

function problem(detail: string, traceId: string | undefined): Record<string, unknown> {
  return {
    type: 'about:blank',
    title: 'Bad Gateway',
    status: HttpStatus.BAD_GATEWAY,
    detail,
    ...(traceId !== undefined && { traceId }),
  };
}

function timeout(detail: string, traceId: string | undefined): Record<string, unknown> {
  return {
    type: 'about:blank',
    title: 'Gateway Timeout',
    status: HttpStatus.GATEWAY_TIMEOUT,
    detail,
    ...(traceId !== undefined && { traceId }),
  };
}

function unavailable(detail: string, traceId: string | undefined): Record<string, unknown> {
  return {
    type: 'about:blank',
    title: 'Service Unavailable',
    status: HttpStatus.SERVICE_UNAVAILABLE,
    detail,
    ...(traceId !== undefined && { traceId }),
  };
}

function requireContext(
  request: RequestWithContext,
): NonNullable<RequestWithContext['requestContext']> {
  const ctx = request.requestContext;
  if (ctx === undefined) {
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: HttpStatus.UNAUTHORIZED,
      detail: 'Authentication required.',
    });
  }
  return ctx;
}

function toBodyOrFallback(body: unknown, fallbackDetail: string): string | Record<string, unknown> {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return { type: 'about:blank', title: 'Error', detail: fallbackDetail };
}

function extractTraceId(request: RequestWithContext): string | undefined {
  const candidates = [request.headers['x-trace-id'], request.headers['x-request-id']];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}
