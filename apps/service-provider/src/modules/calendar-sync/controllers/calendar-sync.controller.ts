import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  DisconnectProviderCalendarResponseSchema,
  ProviderCalendarConnectionSnapshotResponseSchema,
  ProviderCalendarOAuthCallbackQuerySchema,
  StartProviderCalendarConnectionResponseSchema,
  SyncProviderCalendarResponseSchema,
  type DisconnectProviderCalendarResponse,
  type ProviderCalendarConnectionSnapshotResponse,
  type StartProviderCalendarConnectionResponse,
  type SyncProviderCalendarResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { Idempotent } from '@taste-and-see/nest-idempotency';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Response } from 'express';

import { CalendarSyncService, type CalendarSyncFailure } from '../services/calendar-sync.service';

/**
 * Provider external-calendar-sync HTTP boundary (TS-206).
 *
 *   POST   /api/v1/providers/:providerId/calendar/google/connect
 *            → `{ authorizationUrl }`. Authenticated; the caller must own
 *              the provider row. Generates the signed-state Google
 *              consent URL (no DB write → no Idempotency-Key needed).
 *
 *   GET    /api/v1/providers/calendar/google/callback?state&code[&error]
 *            → 302 redirect back to the provider portal. UNAUTHENTICATED
 *              (Google redirects the browser, no access token) — the
 *              signed `state` is the identity + CSRF boundary. The writes
 *              are wrapped in `runWithoutTenantContext` (the same exempt-
 *              frame discipline as the internal discovery-snapshot
 *              endpoint).
 *
 *   GET    /api/v1/providers/me/calendar-connection
 *            → `{ connection: ProviderCalendarConnectionRecord | null }`.
 *
 *   POST   /api/v1/providers/:providerId/calendar/sync
 *            → `{ providerId, externalBusyCount, lastSyncedAt }`. Manual
 *              re-pull. `@Idempotent()`.
 *
 *   DELETE /api/v1/providers/:providerId/calendar/google
 *            → `{ providerId, disconnected, removedExternalBusyCount }`.
 *              `@Idempotent()`; a delete on an already-disconnected
 *              provider succeeds with `disconnected: false`.
 *
 * Status codes (authenticated endpoints):
 *   200 OK · 400 Bad Request · 401 Unauthorized · 403 Forbidden ·
 *   404 Not Found · 409 Conflict (not connected / reconnect required) ·
 *   502 Bad Gateway (Google transient failure) · 503 (feature not
 *   configured).
 */
@Controller()
export class CalendarSyncController {
  constructor(
    private readonly calendar: CalendarSyncService,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {}

  @Post('api/v1/providers/:providerId/calendar/google/connect')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async startConnection(
    @Param('providerId') providerId: string,
    @Req() request: RequestWithContext,
  ): Promise<StartProviderCalendarConnectionResponse> {
    const actorUserId = requireActorUserId(request);
    const result = await this.calendar.startConnection({ providerId, actorUserId });
    if (!result.ok) {
      throwFailure(result.error);
    }
    return StartProviderCalendarConnectionResponseSchema.parse({
      authorizationUrl: result.value.authorizationUrl,
    });
  }

  @Get('api/v1/providers/calendar/google/callback')
  async handleGoogleCallback(@Query() rawQuery: unknown, @Res() res: Response): Promise<void> {
    const parsed = ProviderCalendarOAuthCallbackQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      // Malformed callback (missing/oversized state) — answer 400 without
      // following any redirect; we never trust an unverified state.
      res.status(HttpStatus.BAD_REQUEST).json({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'Malformed OAuth callback.',
      });
      return;
    }

    const outcome = await runWithoutTenantContext(
      this.tenantStore,
      'oauth-google-calendar-callback',
      async () =>
        this.calendar.completeConnection({
          state: parsed.data.state,
          ...(parsed.data.code !== undefined ? { code: parsed.data.code } : {}),
          ...(parsed.data.error !== undefined ? { error: parsed.data.error } : {}),
        }),
    );

    switch (outcome.kind) {
      case 'redirect':
        res.redirect(HttpStatus.FOUND, outcome.url);
        return;
      case 'invalid_state':
        res.status(HttpStatus.BAD_REQUEST).json({
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 'Invalid or expired OAuth state.',
        });
        return;
      case 'not_configured':
        res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
          type: 'about:blank',
          title: 'Service Unavailable',
          status: 503,
          detail: 'Calendar sync is not configured.',
        });
        return;
    }
  }

  @Get('api/v1/providers/me/calendar-connection')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async getMyConnection(
    @Req() request: RequestWithContext,
  ): Promise<ProviderCalendarConnectionSnapshotResponse> {
    const actorUserId = requireActorUserId(request);
    const connection = await this.calendar.getConnectionByUserId(actorUserId);
    return ProviderCalendarConnectionSnapshotResponseSchema.parse({ connection });
  }

  @Post('api/v1/providers/:providerId/calendar/sync')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async syncCalendar(
    @Param('providerId') providerId: string,
    @Req() request: RequestWithContext,
  ): Promise<SyncProviderCalendarResponse> {
    const actorUserId = requireActorUserId(request);
    const result = await this.calendar.syncProvider({ providerId, actorUserId });
    if (!result.ok) {
      throwFailure(result.error);
    }
    return SyncProviderCalendarResponseSchema.parse({
      providerId: result.value.providerId,
      externalBusyCount: result.value.externalBusyCount,
      lastSyncedAt: result.value.lastSyncedAt.toISOString(),
    });
  }

  @Delete('api/v1/providers/:providerId/calendar/google')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async disconnectCalendar(
    @Param('providerId') providerId: string,
    @Req() request: RequestWithContext,
  ): Promise<DisconnectProviderCalendarResponse> {
    const actorUserId = requireActorUserId(request);
    const result = await this.calendar.disconnect({ providerId, actorUserId });
    if (!result.ok) {
      throwFailure(result.error);
    }
    return DisconnectProviderCalendarResponseSchema.parse({
      providerId: result.value.providerId,
      disconnected: result.value.disconnected,
      removedExternalBusyCount: result.value.removedExternalBusyCount,
    });
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

function throwFailure(failure: CalendarSyncFailure): never {
  switch (failure.reason) {
    case 'not_configured':
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: 503,
        detail: 'Calendar sync is not configured.',
      });
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
        detail: 'You may only manage your own calendar connection.',
      });
    case 'not_connected':
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'No external calendar is connected for this provider.',
      });
    case 'sync_auth_rejected':
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail:
          'The calendar connection is no longer authorized. Reconnect your calendar to resume sync.',
      });
    case 'exchange_failed':
    case 'sync_failed':
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: 502,
        detail: 'The calendar provider could not be reached. Please retry.',
      });
    case 'outbox_validation_failed':
      throw new InternalServerErrorException({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'Calendar sync failed at the event-emission stage. Please retry.',
      });
  }
}
