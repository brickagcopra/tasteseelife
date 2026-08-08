import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  IssueUploadUrlRequestSchema,
  ListMediaAssetsQuerySchema,
  type IssueUploadUrlResponse,
  type ListMediaAssetsQuery,
  type MediaAssetResponse,
  type MediaAssetsListResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';

import { AssetsService, IssueUploadUrlFailure } from '../services/assets.service';

/**
 * TS-110 — owner / admin asset surface.
 *
 *   POST /api/v1/media/upload-urls   (AccessTokenGuard)
 *     Mints a single-use signed URL targeting S3. The client uploads
 *     direct-to-S3 with the returned method + headers. The asset row
 *     is created in `awaiting_upload` state; the media-processor
 *     (TS-110-followup-1) advances it via the internal scan-event
 *     ingest endpoint.
 *
 *   GET /api/v1/media/assets/:id     (AccessTokenGuard)
 *     Read-side lookup. A fresh delivery URL is minted per call for
 *     `ready` assets (the URL is never persistently shareable).
 *
 *   GET /api/v1/admin/media/assets   (AccessTokenGuard)
 *     Admin list with optional kind / status / owner filters and
 *     cursor pagination. Permission-gated behind `media:read`
 *     (deferred to TS-110-followup-9 — today any authenticated admin
 *     can hit the surface; live-mode roll-out blocks on the lift).
 *
 * Row-level access (CLAUDE.md §3.2) — the get endpoint is currently a
 * "trust the authenticated actor + audit-trail it" gate; the
 * cross-service membership check ("is this user a member of household
 * X?") lands with TS-110-followup-9.
 */
@Controller()
@UseGuards(AccessTokenGuard)
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Post('api/v1/media/upload-urls')
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(IssueUploadUrlRequestSchema))
  async issueUploadUrl(
    @Body() body: unknown,
    @Req() request: RequestWithContext,
  ): Promise<IssueUploadUrlResponse> {
    const ctx = request.requestContext;
    if (ctx === undefined) {
      throw new UnauthorizedException(unauthorizedBody());
    }
    try {
      return await this.assets.issueUploadUrl(
        ctx.userId,
        body as Parameters<AssetsService['issueUploadUrl']>[1],
      );
    } catch (err) {
      if (err instanceof IssueUploadUrlFailure) {
        throw new UnprocessableEntityException({
          type: 'about:blank',
          title: 'Unprocessable Entity',
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          detail: err.detail,
          code: err.code,
        });
      }
      throw err;
    }
  }

  @Get('api/v1/media/assets/:id')
  async getAsset(@Param('id') id: string): Promise<MediaAssetResponse> {
    const asset = await this.assets.getAssetById(id);
    if (asset === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: HttpStatus.NOT_FOUND,
        detail: `media asset ${id} not found`,
      });
    }
    return asset;
  }

  @Get('api/v1/admin/media/assets')
  @UsePipes(new ZodValidationPipe(ListMediaAssetsQuerySchema))
  async listAssets(@Query() query: ListMediaAssetsQuery): Promise<MediaAssetsListResponse> {
    const result = await this.assets.listAssets({
      limit: query.limit,
      ...(query.kind !== undefined && { kind: query.kind }),
      ...(query.status !== undefined && { status: query.status }),
      ...(query.ownerScopeKind !== undefined && { ownerScopeKind: query.ownerScopeKind }),
      ...(query.ownerScopeId !== undefined && { ownerScopeId: query.ownerScopeId }),
      ...(query.cursor !== undefined && { cursor: query.cursor }),
    });
    return {
      rows: [...result.rows],
      nextCursor: result.nextCursor,
    };
  }
}

function unauthorizedBody(): {
  readonly type: 'about:blank';
  readonly title: 'Unauthorized';
  readonly status: 401;
  readonly detail: string;
} {
  return {
    type: 'about:blank',
    title: 'Unauthorized',
    status: 401,
    detail: 'Authentication required.',
  };
}
