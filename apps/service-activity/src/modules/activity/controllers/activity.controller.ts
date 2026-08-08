import { timingSafeEqual } from 'node:crypto';

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  type ActivityEventResponse,
  type ActivityEventsListResponse,
  ActivityEventResponseSchema,
  ActivityEventsListResponseSchema,
  type ListMyActivityQuery,
  ListMyActivityQuerySchema,
  type ListUserActivityQuery,
  ListUserActivityQuerySchema,
  type RecordActivityEventRequest,
  RecordActivityEventRequestSchema,
  type RecordActivityEventResponse,
  RecordActivityEventResponseSchema,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request } from 'express';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { ActivityService, type ActivityEvent } from '../services/activity.service';

/**
 * Activity-event HTTP boundary (TS-101). Three endpoints:
 *
 *   POST /api/v1/internal/activity/events
 *     Internal-only — every producer service POSTs here with a
 *     producer-assigned `eventId`. Pinned to a shared-secret header
 *     (`ACTIVITY_INGEST_API_KEY`) as defence-in-depth against the
 *     TS-151 NetworkPolicy that will restrict this route to in-cluster
 *     callers. Idempotent on `eventId` — a retried submission replays
 *     into the existing row.
 *
 *   GET /api/v1/users/me/activity
 *     User-facing self-view. The actor sees only their own row stream
 *     — the controller pulls the `userId` from
 *     `request.requestContext.userId` (set by the AccessTokenGuard)
 *     and forwards it to the service. No `userId` query param is
 *     accepted, so the actor cannot peek at another user's stream.
 *
 *   GET /api/v1/admin/users/:userId/activity
 *     Admin search — return events for any user. Currently gated on
 *     AccessTokenGuard only; per-permission gating (`activity:read`)
 *     lands with TS-101-followup-7 + TS-052-followup-11's
 *     PermissionGuard lift.
 *
 * Authentication. The two GET endpoints require a valid Bearer access
 * token minted by `service-identity`. The internal ingest endpoint
 * pins the shared-secret header — that header value is the auth model
 * for the route (mirrors the established Stripe-webhook + KYC
 * internal-dispatch patterns).
 *
 * Authorization. Phase-1 admin reads are gated on AccessTokenGuard
 * only; the `activity:read` PermissionGuard lift lands with
 * TS-101-followup-7. Captured up-front so the admin tooling (TS-126)
 * has a named permission to wire.
 *
 * Tenant-scoping (TS-020-followup-2b-platform-rollout). `recordEvent`
 * runs BEFORE any `requestContext` exists — the endpoint is shared-
 * secret-pinned, not bearer-token-authenticated, so the
 * `TenantContextInterceptor` cannot seed a scoped frame. The body is
 * wrapped in `runWithoutTenantContext(..., 'internal-activity-event-record', ...)`
 * so the Prisma extension's gate sees an explicit `exempt` frame
 * rather than failing with `MissingRequestContextError` under the
 * `enforcement: 'enforce'` posture wired in `AppModule`. The two GET
 * handlers (`listMyActivity`, `listUserActivity`) sit behind
 * `AccessTokenGuard`, so the interceptor seeds a scoped frame from the
 * access-token claims — they are deliberately NOT wrapped. Mirrors the
 * pattern landed in service-audit's `AuditController.recordEvent`
 * (`internal-audit-event-record`) and service-identity's
 * `KycController.receiveWebhookEvent` (`internal-kyc-webhook-dispatch`).
 */
@Controller()
export class ActivityController {
  private readonly logger = new Logger(ActivityController.name);
  private readonly internalApiKey: string;
  private readonly internalHeaderName: string;

  constructor(
    private readonly activity: ActivityService,
    @Inject(ENV_TOKEN) env: Env,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {
    this.internalApiKey = env.ACTIVITY_INGEST_API_KEY;
    this.internalHeaderName = env.ACTIVITY_INGEST_HEADER_NAME;
  }

  /**
   * POST /api/v1/internal/activity/events — record an activity event.
   *
   * Status codes:
   *   200 OK            — outcome `recorded` | `replayed`. Body is the
   *                       persisted row.
   *   400 Bad Request   — payload failed Zod validation.
   *   401 Unauthorized  — missing or wrong shared-secret header.
   */
  @Post('api/v1/internal/activity/events')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(RecordActivityEventRequestSchema))
  async recordEvent(
    @Body() body: RecordActivityEventRequest,
    @Req() request: Request,
  ): Promise<RecordActivityEventResponse> {
    return runWithoutTenantContext(this.tenantStore, 'internal-activity-event-record', async () => {
      const presented = request.header(this.internalHeaderName);
      if (!isSharedSecretValid(presented, this.internalApiKey)) {
        throw new UnauthorizedException({
          type: 'about:blank',
          title: 'Unauthorized',
          status: 401,
          detail: 'Internal dispatch authentication failed.',
        });
      }

      const occurredAt = new Date(body.occurredAt);
      if (Number.isNaN(occurredAt.getTime())) {
        // Zod's `.datetime()` already validated this — but defence in
        // depth keeps an upstream regression from corrupting the row.
        throw new BadRequestException({
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 'occurredAt is not a valid ISO-8601 datetime.',
        });
      }

      const result = await this.activity.recordEvent({
        eventId: body.eventId,
        userId: body.userId,
        kind: body.kind,
        occurredAt,
        ip: body.ip ?? null,
        userAgent: body.userAgent ?? null,
        deviceFingerprint: body.deviceFingerprint ?? null,
        requestId: body.requestId ?? null,
        traceId: body.traceId ?? null,
        metadata: body.metadata ?? null,
      });

      const response: RecordActivityEventResponse = {
        outcome: result.outcome,
        event: toDto(result.event),
      };
      // Parse-validate the response shape before returning so a future
      // drift between the service and the contract surfaces at the
      // boundary rather than in the consumer.
      return RecordActivityEventResponseSchema.parse(response);
    });
  }

  /**
   * GET /api/v1/users/me/activity — user-facing self-view.
   *
   * The actor sees ONLY their own stream — the userId is pulled from
   * the access token, not from the query string. Optional `kind`
   * filter narrows to a single category.
   *
   * Status codes:
   *   200 OK            — body is the ActivityEventsListResponse.
   *   400 Bad Request   — query string failed Zod validation.
   *   401 Unauthorized  — missing / invalid access token.
   */
  @Get('api/v1/users/me/activity')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async listMyActivity(
    @Query(new ZodValidationPipe(ListMyActivityQuerySchema))
    query: ListMyActivityQuery,
    @Req() request: RequestWithContext,
  ): Promise<ActivityEventsListResponse> {
    const actorUserId = request.requestContext?.userId;
    if (actorUserId === undefined || actorUserId.length === 0) {
      // Defensive — the guard should always populate this. If it
      // doesn't, we cannot serve a per-user stream safely.
      throw new UnauthorizedException({
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'Authentication required.',
      });
    }

    this.logger.debug({ actorUserId, kind: query.kind }, 'activity.listMyActivity');

    const result = await this.activity.listByUser({
      userId: actorUserId,
      kindFilter: query.kind,
      cursor: query.cursor,
      limit: query.limit,
    });

    const response: ActivityEventsListResponse = {
      events: result.events.map(toDto),
      nextCursor: result.nextCursor,
    };
    return ActivityEventsListResponseSchema.parse(response);
  }

  /**
   * GET /api/v1/admin/users/:userId/activity — admin search.
   *
   * Status codes:
   *   200 OK            — body is the ActivityEventsListResponse.
   *   400 Bad Request   — query string failed Zod validation or the
   *                       path :userId is empty.
   *   401 Unauthorized  — missing / invalid access token.
   */
  @Get('api/v1/admin/users/:userId/activity')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async listUserActivity(
    @Param('userId') userId: string,
    @Query(new ZodValidationPipe(ListUserActivityQuerySchema))
    query: ListUserActivityQuery,
    @Req() request: RequestWithContext,
  ): Promise<ActivityEventsListResponse> {
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'userId path parameter is required.',
      });
    }

    this.logger.debug(
      {
        actorUserId: request.requestContext?.userId,
        targetUserId: userId,
        kind: query.kind,
      },
      'activity.listUserActivity',
    );

    const result = await this.activity.listByUser({
      userId,
      kindFilter: query.kind,
      cursor: query.cursor,
      limit: query.limit,
    });

    const response: ActivityEventsListResponse = {
      events: result.events.map(toDto),
      nextCursor: result.nextCursor,
    };
    return ActivityEventsListResponseSchema.parse(response);
  }
}

/**
 * Project the service-layer ActivityEvent to the contract DTO. Dates
 * become ISO-8601 strings; the rest passes through unchanged.
 */
function toDto(event: ActivityEvent): ActivityEventResponse {
  return ActivityEventResponseSchema.parse({
    id: event.id,
    eventId: event.eventId,
    userId: event.userId,
    kind: event.kind,
    occurredAt: event.occurredAt.toISOString(),
    ip: event.ip,
    userAgent: event.userAgent,
    deviceFingerprint: event.deviceFingerprint,
    requestId: event.requestId,
    traceId: event.traceId,
    metadata: event.metadata,
    createdAt: event.createdAt.toISOString(),
  });
}

/**
 * Constant-time shared-secret comparison. Mirrors the pattern in
 * service-audit / service-identity's KycController — the length check
 * is the only branch on the secret material; the `timingSafeEqual`
 * comparison is O(N) regardless of where the first byte differs.
 */
function isSharedSecretValid(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
