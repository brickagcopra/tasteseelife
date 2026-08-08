import { timingSafeEqual } from 'node:crypto';

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  type DispatchNotificationRequest,
  DispatchNotificationRequestSchema,
  type DispatchResponse,
  type DispatchesListResponse,
  type ListDispatchesQuery,
  ListDispatchesQuerySchema,
  type NotificationCategory,
  type NotificationChannelKind,
  type NotificationDispatchStatus,
} from '@taste-and-see/contracts';
import { AccessTokenGuard } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request } from 'express';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';

import { toDispatchListResponse, toDispatchResponse } from '../mappers/dispatch.mapper';
import { DispatchOrchestratorService } from '../services/dispatch-orchestrator.service';

/**
 * Notification dispatch endpoints (TS-073).
 *
 *   POST /api/v1/internal/notification/dispatch
 *     Internal call from upstream services. Shared-secret pinned via
 *     `NOTIFICATION_DISPATCH_HEADER_NAME` /
 *     `NOTIFICATION_DISPATCH_API_KEY` — constant-time `timingSafeEqual`
 *     comparison (mirrors the render endpoint shape).
 *
 *   GET  /api/v1/admin/notification/dispatches
 *     Admin read of the dispatch log. AccessTokenGuard required.
 *     Cursor-paginated with optional filters.
 *
 * Failure mapping:
 *   401 — missing / wrong shared-secret header (internal POST) OR
 *         missing / invalid bearer token (admin GET).
 *   400 — Zod validation failure.
 *
 * Tenant-scoping (TS-020-followup-2b-platform-rollout).
 *
 *   - `dispatch` runs BEFORE any `requestContext` exists (shared-secret
 *     pinned, not bearer-token-authenticated), so the body is wrapped
 *     in `runWithoutTenantContext(..., 'internal-notification-dispatch', ...)`
 *     to seed an explicit `exempt` frame for the Prisma extension under
 *     the `enforcement: 'enforce'` posture wired in `AppModule`.
 *
 *   - `list` sits behind `@UseGuards(AccessTokenGuard)`, so the
 *     `TenantContextInterceptor` seeds a scoped frame from the
 *     access-token claims. No wrap needed.
 */
@Controller()
export class DispatchController {
  private readonly internalApiKey: string;
  private readonly internalHeaderName: string;

  constructor(
    private readonly orchestrator: DispatchOrchestratorService,
    @Inject(ENV_TOKEN) env: Env,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {
    this.internalApiKey = env.NOTIFICATION_DISPATCH_API_KEY;
    this.internalHeaderName = env.NOTIFICATION_DISPATCH_HEADER_NAME;
  }

  @Post('api/v1/internal/notification/dispatch')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(DispatchNotificationRequestSchema))
  async dispatch(
    @Body() body: DispatchNotificationRequest,
    @Req() request: Request,
  ): Promise<DispatchResponse> {
    return runWithoutTenantContext(this.tenantStore, 'internal-notification-dispatch', async () => {
      const presented = request.header(this.internalHeaderName);
      if (!isSharedSecretValid(presented, this.internalApiKey)) {
        throw new UnauthorizedException({
          type: 'about:blank',
          title: 'Unauthorized',
          status: 401,
          detail: 'Internal dispatch authentication failed.',
        });
      }

      const result = await this.orchestrator.dispatch(body);
      return toDispatchResponse(result);
    });
  }

  @Get('api/v1/admin/notification/dispatches')
  @UseGuards(AccessTokenGuard)
  @UsePipes(new ZodValidationPipe(ListDispatchesQuerySchema))
  async list(@Query() query: ListDispatchesQuery): Promise<DispatchesListResponse> {
    const input: {
      limit: number;
      recipientUserId?: string;
      channel?: NotificationChannelKind;
      category?: NotificationCategory;
      status?: NotificationDispatchStatus;
      cursor?: string;
    } = { limit: query.limit };
    if (query.recipientUserId !== undefined) input.recipientUserId = query.recipientUserId;
    if (query.channel !== undefined) input.channel = query.channel;
    if (query.category !== undefined) input.category = query.category;
    if (query.status !== undefined) input.status = query.status;
    if (query.cursor !== undefined) input.cursor = query.cursor;
    const result = await this.orchestrator.list(input);
    return toDispatchListResponse(result.rows, result.nextCursor);
  }
}

function isSharedSecretValid(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
