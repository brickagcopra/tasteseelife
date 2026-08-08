import { Controller, Get, HttpCode, HttpStatus, Param, Query, UseGuards } from '@nestjs/common';
import {
  SeniorPhotoGalleryQuerySchema,
  type SeniorPhotoGalleryQuery,
  type SeniorPhotoGalleryResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';

import { AssetsService } from '../services/assets.service';

/**
 * TS-232 — family photo-gallery read surface.
 *
 *   GET /api/v1/media/seniors/:seniorId/photos   (AccessTokenGuard)
 *     Lists a senior's shareable photos — `ready` `senior_photo` assets
 *     owner-scoped to the senior — newest-first, cursor-paginated. Each
 *     item carries a fresh short-lived signed delivery URL.
 *
 * **Authorization.** This endpoint does NOT apply the senior's `photos`
 * consent flag or a household-membership check — media-svc has no
 * household / consent knowledge. The api-gateway aggregator
 * (`GET /api/v1/seniors/:seniorId/photos`) is the gate: it consults the
 * senior's consent record (service-household, TS-238) — which also
 * enforces household membership — before forwarding here. This surface
 * is internal-only (reachable solely via the gateway) and sits behind
 * `AccessTokenGuard` so it is never anonymously addressable. The
 * in-service consent gate is the carved TS-110-followup-10; the
 * in-service membership check is TS-110-followup-9.
 *
 * Read-only — no `@Idempotent()` (GET is naturally idempotent).
 */
@Controller()
@UseGuards(AccessTokenGuard)
export class SeniorPhotosController {
  constructor(private readonly assets: AssetsService) {}

  @Get('api/v1/media/seniors/:seniorId/photos')
  @HttpCode(HttpStatus.OK)
  async listSeniorPhotos(
    @Param('seniorId') seniorId: string,
    @Query(new ZodValidationPipe(SeniorPhotoGalleryQuerySchema)) query: SeniorPhotoGalleryQuery,
  ): Promise<SeniorPhotoGalleryResponse> {
    return this.assets.listSeniorPhotos(seniorId, {
      limit: query.limit,
      ...(query.cursor !== undefined && { cursor: query.cursor }),
    });
  }
}
