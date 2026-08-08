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
  DeleteProviderAvailabilityResponseSchema,
  ProviderAvailabilityRecordSchema,
  ProviderAvailabilitySnapshotResponseSchema,
  UpdateProviderAvailabilityRequestSchema,
  UpdateProviderAvailabilityResponseSchema,
  type DeleteProviderAvailabilityResponse,
  type ProviderAvailabilityRecord,
  type ProviderAvailabilitySnapshotResponse,
  type UpdateProviderAvailabilityRequest,
  type UpdateProviderAvailabilityResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import {
  AvailabilityService,
  toProviderAvailabilityRecord,
  type ProviderAvailabilityFailure,
} from '../services/availability.service';

/**
 * Provider availability HTTP boundary (TS-203).
 *
 * Endpoints:
 *
 *   GET /api/v1/providers/me/availability-snapshot
 *     Returns the authenticated user's availability snapshot
 *     (`{ availability: ProviderAvailabilityRecord | null }`). The
 *     `null` branch covers pre-application users + active providers
 *     who have not yet declared any schedule. Powers the
 *     web-provider editor's initial-render fetch.
 *
 *   PUT /api/v1/providers/:providerId/availability
 *     Full-set replace of the provider's recurring windows +
 *     date-keyed exclusions. The caller must own the provider row
 *     (the authenticated user's id must match `providers.user_id`).
 *
 *   DELETE /api/v1/providers/:providerId/availability
 *     Full clear (no body). Idempotent — a delete on an already-
 *     empty schedule succeeds with both deleted-counts zero.
 *
 *     Status codes (PUT + DELETE):
 *       200 OK            — body is the matching response shape.
 *       400 Bad Request   — payload failed Zod validation.
 *       401 Unauthorized  — missing / invalid access token.
 *       403 Forbidden     — provider exists but the actor doesn't
 *                           own the row.
 *       404 Not Found     — provider doesn't exist (or has been
 *                           soft-deleted).
 *
 * Idempotency. Both the PUT and DELETE wear `@Idempotent()` so a
 * retried request with the same `Idempotency-Key` returns the
 * cached response. The shared SDK swallows transient client retries
 * (browser refresh, mobile flaky network) without re-running the
 * transaction.
 */
@Controller()
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get('api/v1/providers/me/availability-snapshot')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async getMySnapshot(
    @Req() request: RequestWithContext,
  ): Promise<ProviderAvailabilitySnapshotResponse> {
    const actorUserId = requireActorUserId(request);
    const snapshot = await this.availability.getAvailabilityByUserId(actorUserId);
    if (snapshot === null) {
      return ProviderAvailabilitySnapshotResponseSchema.parse({ availability: null });
    }
    const record: ProviderAvailabilityRecord = ProviderAvailabilityRecordSchema.parse(
      toProviderAvailabilityRecord(snapshot),
    );
    return ProviderAvailabilitySnapshotResponseSchema.parse({ availability: record });
  }

  @Put('api/v1/providers/:providerId/availability')
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async updateAvailability(
    @Param('providerId') providerId: string,
    @Body(new ZodValidationPipe(UpdateProviderAvailabilityRequestSchema))
    body: UpdateProviderAvailabilityRequest,
    @Req() request: RequestWithContext,
  ): Promise<UpdateProviderAvailabilityResponse> {
    const actorUserId = requireActorUserId(request);

    const result = await this.availability.updateAvailability({
      providerId,
      actorUserId,
      windows: body.windows,
      exceptions: body.exceptions,
    });
    if (!result.ok) {
      throwFailure(result.error);
    }

    const response: UpdateProviderAvailabilityResponse = {
      availability: toProviderAvailabilityRecord(result.value),
    };
    return UpdateProviderAvailabilityResponseSchema.parse(response);
  }

  @Delete('api/v1/providers/:providerId/availability')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async deleteAvailability(
    @Param('providerId') providerId: string,
    @Req() request: RequestWithContext,
  ): Promise<DeleteProviderAvailabilityResponse> {
    const actorUserId = requireActorUserId(request);

    const result = await this.availability.deleteAvailability({
      providerId,
      actorUserId,
    });
    if (!result.ok) {
      throwFailure(result.error);
    }

    const response: DeleteProviderAvailabilityResponse = {
      providerId: result.value.providerId,
      deletedWindowCount: result.value.deletedWindowCount,
      deletedExceptionCount: result.value.deletedExceptionCount,
    };
    return DeleteProviderAvailabilityResponseSchema.parse(response);
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

function throwFailure(failure: ProviderAvailabilityFailure): never {
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
        detail: 'You may only edit your own provider availability.',
      });
    case 'outbox_validation_failed':
      throw new InternalServerErrorException({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'Availability update failed at the event-emission stage. Please retry.',
      });
  }
}
