import {
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  MediaAssetResponseSchema,
  ResolveMediaAssetsQuerySchema,
  isAdminPreviewableMediaKind,
  type MediaAssetResponse,
  type ResolveMediaAssetsResponse,
  type ResolvedMediaAsset,
} from '@taste-and-see/contracts';
import {
  AccessTokenGuard,
  PermissionGuard,
  RequirePermissions,
  type RequestWithContext,
} from '@taste-and-see/nest-auth';

import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Admin media preview resolution (TS-282-followup-5b; CLAUDE.md §3.4).
 *
 *   GET /api/v1/admin/media/assets/resolve?id=…&id=…   (`media:read`)
 *
 * **This closes a live defect, not a nicety.** TS-277a gates ad-creative
 * approval on an accessibility review — alt-text adequacy, WCAG contrast,
 * motion — and web-admin rendered `assetKeys.join(', ')` as literal text, so
 * the reviewer signed off on an image they had never seen.
 *
 * **Fan-out, bounded at the contract.** The gateway makes one
 * `GET /api/v1/media/assets/{id}` call per requested key, in parallel, capped
 * at `ADMIN_MEDIA_RESOLVE_MAX` = 10 by `ResolveMediaAssetsQuerySchema`. Ids are
 * de-duplicated first: a creative that lists the same key twice must not cost
 * two downstream calls.
 *
 * **Every failure degrades to a per-key outcome; the call itself does not
 * fail.** This is the TS-305b contrast applied at a finer grain — there, the
 * dossier was fatal and the incident section degraded. Here nothing is fatal:
 * a console that 502s because one of ten keys is junk is a console that cannot
 * review the other nine. What the endpoint refuses to do is blur the reasons
 * together — see `ResolvedMediaAssetSchema` for why each outcome exists.
 *
 * **The permission is not the whole control.** `media:read` is held by
 * marketing and content editors; media-svc's store also holds seniors'
 * photographs, providers' identity documents and background-check evidence,
 * and `GET /api/v1/media/assets/{id}` has no row-level gate of its own
 * (TS-110-followup-9 is still open). So the gateway applies
 * `isAdminPreviewableMediaKind` to every resolved row and refuses the rest,
 * without naming the kind it refused.
 *
 * **The response is deliberately not media-svc's row.** `MediaAssetResponse`
 * carries `storageBucket` / `storageKey` / `deliveryKey` / `sha256` / owner
 * ids; handing a browser-facing app media-svc's storage layout to draw a
 * picture is the mistake TS-282-followup-5a refused. Only the projection in
 * `toReady` crosses the wire.
 */
@Controller('api/v1/admin/media/assets')
@UseGuards(AccessTokenGuard, PermissionGuard, RateLimitGuard)
export class AdminMediaAssetsProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get('resolve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('media:read')
  async resolve(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<ResolveMediaAssetsResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = ResolveMediaAssetsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest('Media resolve query failed validation.', parsed.error.issues);
    }

    // De-duplicate before the fan-out. A creative may list the same key twice;
    // the caller maps results back by `assetKey`, so a single row per distinct
    // key is what it wants anyway.
    const ids = [...new Set(parsed.data.id)];

    const assets = await Promise.all(
      ids.map(async (assetKey) => this.resolveOne(assetKey, ctx, traceId)),
    );

    return { assets };
  }

  private async resolveOne(
    assetKey: string,
    ctx: NonNullable<RequestWithContext['requestContext']>,
    traceId: string | undefined,
  ): Promise<ResolvedMediaAsset> {
    const result: DownstreamResult = await this.downstream.call({
      service: 'media',
      path: `/api/v1/media/assets/${encodeURIComponent(assetKey)}`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    switch (result.kind) {
      case 'ok': {
        const parsed = MediaAssetResponseSchema.safeParse(result.body);
        if (!parsed.success) {
          // A drifted media-svc row is an outage of THIS key, not of the page.
          // `unavailable` is the honest label: we asked and could not use the
          // answer. Calling it `not_found` would tell the reviewer the asset
          // does not exist, which we have no basis to say.
          return { outcome: 'unavailable', assetKey };
        }
        return toOutcome(assetKey, parsed.data);
      }
      case 'client_error':
        // 404 is the only client error that means something specific to the
        // caller; every other 4xx (403 from a future row-level gate, 400 from a
        // malformed legacy key) is "we could not get it", not "it is not there".
        return result.status === HttpStatus.NOT_FOUND
          ? { outcome: 'not_found', assetKey }
          : { outcome: 'unavailable', assetKey };
      case 'server_error':
      case 'timeout':
      case 'network_error':
      case 'not_configured':
        return { outcome: 'unavailable', assetKey };
    }
  }
}

/**
 * Map one media-svc row into the outcome the console renders.
 *
 * Order matters: the kind check runs BEFORE the status check, so a restricted
 * asset that happens to be mid-scan is reported as restricted rather than
 * leaking, via `not_ready`, that it exists and is being processed.
 */
function toOutcome(assetKey: string, asset: MediaAssetResponse): ResolvedMediaAsset {
  if (!isAdminPreviewableMediaKind(asset.kind)) {
    return { outcome: 'restricted', assetKey };
  }
  if (asset.status !== 'ready' || asset.signedDeliveryUrl === null) {
    return { outcome: 'not_ready', assetKey, status: asset.status };
  }
  return {
    outcome: 'ready',
    assetKey,
    signedUrl: asset.signedDeliveryUrl,
    expiresAt: asset.signedDeliveryUrlExpiresAt,
    // The magic-byte-detected mime is authoritative (CLAUDE.md §17.16); the
    // declared one is the client's claim and is only a fallback for a row the
    // pipeline has not stamped.
    mime: asset.detectedMime ?? asset.declaredMime,
    width: asset.width,
    height: asset.height,
    fileName: asset.declaredFileName,
    sizeBytes: asset.actualSizeBytes,
  };
}

function badRequest(detail: string, issues: unknown): HttpException {
  return new HttpException(
    {
      type: 'about:blank',
      title: 'Bad Request',
      status: HttpStatus.BAD_REQUEST,
      detail,
      issues,
    },
    HttpStatus.BAD_REQUEST,
  );
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

function extractTraceId(request: RequestWithContext): string | undefined {
  const candidates = [request.headers['x-trace-id'], request.headers['x-request-id']];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}
