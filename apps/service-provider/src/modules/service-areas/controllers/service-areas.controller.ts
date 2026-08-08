import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  DeleteProviderServiceAreasResponseSchema,
  ProviderServiceAreaRecordSchema,
  ProviderServiceAreasSnapshotResponseSchema,
  UpdateProviderServiceAreasRequestSchema,
  UpdateProviderServiceAreasResponseSchema,
  type DeleteProviderServiceAreasResponse,
  type ProviderServiceAreaRecord,
  type ProviderServiceAreasSnapshotResponse,
  type UpdateProviderServiceAreasRequest,
  type UpdateProviderServiceAreasResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import {
  ServiceAreasService,
  type ProviderServiceAreasFailure,
} from '../services/service-areas.service';

/**
 * Provider service-area HTTP boundary (TS-202).
 *
 * Endpoints:
 *
 *   GET /api/v1/providers/me/service-areas-snapshot
 *     Returns the authenticated user's coverage set
 *     (`{ serviceAreas: ProviderServiceAreaRecord[] | null }`). The
 *     `null` branch covers pre-application users; an empty array
 *     covers a live provider who has not yet drawn any area. Powers
 *     the web-provider editor's initial-render fetch.
 *
 *   PUT /api/v1/providers/:providerId/service-areas
 *     Full-set replace of the provider's coverage polygons. The caller
 *     must own the provider row (the authenticated user's id must
 *     match `providers.user_id`). The service computes the centroid +
 *     bounding box for each polygon at write time.
 *
 *   DELETE /api/v1/providers/:providerId/service-areas
 *     Full clear (no body). Idempotent — a delete on an already-empty
 *     set succeeds with `deletedCount` zero.
 *
 *     Status codes (PUT + DELETE):
 *       200 OK            — body is the matching response shape.
 *       400 Bad Request   — payload failed Zod validation.
 *       401 Unauthorized  — missing / invalid access token.
 *       403 Forbidden     — provider exists but the actor doesn't own
 *                           the row.
 *       404 Not Found     — provider doesn't exist (or soft-deleted).
 *
 * Design choice (TS-202): the codebase idiom for "a set of
 * provider-owned child rows" is a full-set-replace PUT + a clear-all
 * DELETE + a snapshot GET (mirrors TS-203 availability). The PRD's
 * "POST/PUT/DELETE" is satisfied in spirit — PUT covers create +
 * update via replace; DELETE clears. A per-area POST/PATCH/DELETE-by-id
 * surface is a follow-up if granular edits are needed.
 *
 * Idempotency. Both the PUT and DELETE wear `@Idempotent()` so a
 * retried request with the same `Idempotency-Key` returns the cached
 * response.
 */
@Controller()
export class ServiceAreasController {
  constructor(private readonly serviceAreas: ServiceAreasService) {}

  @Get('api/v1/providers/me/service-areas-snapshot')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async getMySnapshot(
    @Req() request: RequestWithContext,
  ): Promise<ProviderServiceAreasSnapshotResponse> {
    const actorUserId = requireActorUserId(request);
    const snapshot = await this.serviceAreas.getServiceAreasByUserId(actorUserId);
    if (snapshot === null) {
      return ProviderServiceAreasSnapshotResponseSchema.parse({
        providerId: null,
        serviceAreas: null,
      });
    }
    const parsed: ProviderServiceAreaRecord[] = snapshot.serviceAreas.map((record) =>
      ProviderServiceAreaRecordSchema.parse(record),
    );
    return ProviderServiceAreasSnapshotResponseSchema.parse({
      providerId: snapshot.providerId,
      serviceAreas: parsed,
    });
  }

  @Put('api/v1/providers/:providerId/service-areas')
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async updateServiceAreas(
    @Param('providerId') providerId: string,
    @Body(new ZodValidationPipe(UpdateProviderServiceAreasRequestSchema))
    body: UpdateProviderServiceAreasRequest,
    @Req() request: RequestWithContext,
  ): Promise<UpdateProviderServiceAreasResponse> {
    const actorUserId = requireActorUserId(request);

    const result = await this.serviceAreas.updateServiceAreas({
      providerId,
      actorUserId,
      serviceAreas: body.serviceAreas,
    });
    if (!result.ok) {
      throwFailure(result.error);
    }

    const response: UpdateProviderServiceAreasResponse = {
      serviceAreas: result.value,
    };
    return UpdateProviderServiceAreasResponseSchema.parse(response);
  }

  @Delete('api/v1/providers/:providerId/service-areas')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async deleteServiceAreas(
    @Param('providerId') providerId: string,
    @Req() request: RequestWithContext,
  ): Promise<DeleteProviderServiceAreasResponse> {
    const actorUserId = requireActorUserId(request);

    const result = await this.serviceAreas.deleteServiceAreas({ providerId, actorUserId });
    if (!result.ok) {
      throwFailure(result.error);
    }

    const response: DeleteProviderServiceAreasResponse = {
      providerId: result.value.providerId,
      deletedCount: result.value.deletedCount,
    };
    return DeleteProviderServiceAreasResponseSchema.parse(response);
  }
}

function requireActorUserId(request: RequestWithContext): string {
  const ctx = request.requestContext;
  if (ctx === undefined) {
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication required.',
    });
  }
  return ctx.userId;
}

function throwFailure(failure: ProviderServiceAreasFailure): never {
  switch (failure.reason) {
    case 'invalid_request':
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: failure.message,
      });
    case 'not_found':
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Provider not found.',
      });
    case 'forbidden':
      throw new ForbiddenException({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'You may only edit your own provider service areas.',
      });
    case 'outbox_validation_failed':
      throw new InternalServerErrorException({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'Service-area update failed at the event-emission stage. Please retry.',
      });
  }
}
