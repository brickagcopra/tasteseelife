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
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  type AuditEventResponse,
  type AuditEventsListResponse,
  AuditEventsListResponseSchema,
  AuditEventResponseSchema,
  type ListAuditEventsByActorQuery,
  ListAuditEventsByActorQuerySchema,
  type ListAuditEventsByResourceKindQuery,
  ListAuditEventsByResourceKindQuerySchema,
  type ListAuditEventsByResourceQuery,
  ListAuditEventsByResourceQuerySchema,
  parseResourceKindsCsv,
  type RecordAuditEventRequest,
  RecordAuditEventRequestSchema,
  type RecordAuditEventResponse,
  RecordAuditEventResponseSchema,
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
import { AuditService, type AuditEvent } from '../services/audit.service';

/**
 * Audit-event HTTP boundary (TS-100). Three endpoints:
 *
 *   POST /api/v1/internal/audit/events
 *     Internal-only — every producer service POSTs here with a
 *     producer-assigned `eventId`. Pinned to a shared-secret header
 *     (`AUDIT_INGEST_API_KEY`) as defence-in-depth against the TS-151
 *     NetworkPolicy that will restrict this route to in-cluster
 *     callers. Idempotent on `eventId` — a retried submission replays
 *     into the existing row.
 *
 *   GET /api/v1/admin/audit/events/by-resource
 *     Admin search: return events for a `(resourceKind, resourceId)`
 *     partition, ordered newest-first, cursor-paginated. Behind the
 *     AccessTokenGuard; future permission gating (`audit:read`) lands
 *     with TS-052-followup-11's PermissionGuard lift.
 *
 *   GET /api/v1/admin/audit/events/by-actor
 *     Admin search: return events authored by a single user-id,
 *     ordered newest-first, cursor-paginated.
 *
 * Authentication. The admin endpoints require a valid Bearer access
 * token minted by `service-identity`. The internal ingest endpoint
 * pins the shared-secret header — that header value is the auth model
 * for the route (mirrors the established Stripe-webhook + KYC
 * internal-dispatch patterns).
 *
 * Authorization. Phase-1 admin reads are gated on AccessTokenGuard
 * only; the `audit:read` PermissionGuard lift lands with
 * TS-052-followup-11. Captured up-front so the admin tooling
 * (TS-126 / TS-127) has a named permission to wire.
 *
 * Tenant-scoping (TS-020-followup-2b-platform-rollout). The internal
 * ingest endpoint (`recordEvent`) authenticates via a shared-secret
 * header, NOT the `AccessTokenGuard`, so the `TenantContextInterceptor`
 * cannot seed a scoped frame from a `request.requestContext` that does
 * not exist. The handler body wraps in
 * `runWithoutTenantContext(..., 'internal-audit-event-record', ...)` so
 * every Prisma operation downstream sees an explicit `exempt` frame
 * rather than failing with `MissingRequestContextError` under the
 * `enforcement: 'enforce'` posture wired in `AppModule`. Mirrors the
 * `KycController.receiveWebhookEvent` wrap landed under
 * TS-020-followup-2b.
 *
 * The two admin endpoints (`listByResource` / `listByActor`) deliberately
 * are NOT wrapped — they sit behind `AccessTokenGuard` so the
 * `TenantContextInterceptor` seeds a scoped frame from the access-token
 * claims before the handler body runs.
 */
@Controller()
export class AuditController {
  private readonly logger = new Logger(AuditController.name);
  private readonly internalApiKey: string;
  private readonly internalHeaderName: string;

  constructor(
    private readonly audit: AuditService,
    @Inject(ENV_TOKEN) env: Env,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {
    this.internalApiKey = env.AUDIT_INGEST_API_KEY;
    this.internalHeaderName = env.AUDIT_INGEST_HEADER_NAME;
  }

  /**
   * POST /api/v1/internal/audit/events — record an audit event.
   *
   * Status codes:
   *   200 OK            — outcome `recorded` | `replayed`. Body is the
   *                       persisted row including chain metadata.
   *   400 Bad Request   — payload failed Zod validation.
   *   401 Unauthorized  — missing or wrong shared-secret header.
   */
  @Post('api/v1/internal/audit/events')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(RecordAuditEventRequestSchema))
  async recordEvent(
    @Body() body: RecordAuditEventRequest,
    @Req() request: Request,
  ): Promise<RecordAuditEventResponse> {
    return runWithoutTenantContext(this.tenantStore, 'internal-audit-event-record', async () => {
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

      const result = await this.audit.recordEvent({
        eventId: body.eventId,
        occurredAt,
        actorUserId: body.actorUserId ?? null,
        actorRole: body.actorRole ?? null,
        actorTenantScopeType: body.actorTenantScopeType,
        actorTenantScopeId: body.actorTenantScopeId ?? null,
        action: body.action,
        resourceKind: body.resourceKind,
        resourceId: body.resourceId,
        beforeJson: body.beforeJson ?? null,
        afterJson: body.afterJson ?? null,
        ip: body.ip ?? null,
        userAgent: body.userAgent ?? null,
        requestId: body.requestId ?? null,
        traceId: body.traceId ?? null,
      });

      const response: RecordAuditEventResponse = {
        outcome: result.outcome,
        event: toDto(result.event),
      };
      // Parse-validate the response shape before returning so a future
      // drift between the service and the contract surfaces at the
      // boundary rather than in the consumer.
      return RecordAuditEventResponseSchema.parse(response);
    });
  }

  /**
   * GET /api/v1/admin/audit/events/by-resource — list events for a
   * `(resourceKind, resourceId)` partition.
   *
   * Status codes:
   *   200 OK            — body is the AuditEventsListResponse.
   *   400 Bad Request   — query string failed Zod validation.
   *   401 Unauthorized  — missing / invalid access token.
   */
  @Get('api/v1/admin/audit/events/by-resource')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async listByResource(
    @Query(new ZodValidationPipe(ListAuditEventsByResourceQuerySchema))
    query: ListAuditEventsByResourceQuery,
    @Req() request: RequestWithContext,
  ): Promise<AuditEventsListResponse> {
    this.logger.debug(
      {
        actorUserId: request.requestContext?.userId,
        resourceKind: query.resourceKind,
        resourceId: query.resourceId,
      },
      'audit.listByResource',
    );
    const result = await this.audit.listByResource(query);
    const response: AuditEventsListResponse = {
      events: result.events.map(toDto),
      nextCursor: result.nextCursor,
    };
    return AuditEventsListResponseSchema.parse(response);
  }

  /**
   * GET /api/v1/admin/audit/events/by-resource-kind — KIND-WIDE listing
   * (TS-295): every event for the named resource kinds (≤5, CSV),
   * optionally filtered by exact action / actor, direction-ordered.
   * Powers the RBAC History view (`rbac_role,rbac_assignment,
   * rbac_approval` in one stream). Same auth posture as the sibling
   * admin reads (AccessTokenGuard; the `audit:read` PermissionGuard
   * lift rides TS-052-followup-11).
   *
   * Status codes:
   *   200 OK            — body is the AuditEventsListResponse.
   *   400 Bad Request   — query string failed Zod validation.
   *   401 Unauthorized  — missing / invalid access token.
   */
  @Get('api/v1/admin/audit/events/by-resource-kind')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async listByResourceKind(
    @Query(new ZodValidationPipe(ListAuditEventsByResourceKindQuerySchema))
    query: ListAuditEventsByResourceKindQuery,
    @Req() request: RequestWithContext,
  ): Promise<AuditEventsListResponse> {
    this.logger.debug(
      {
        actorUserId: request.requestContext?.userId,
        resourceKinds: query.resourceKinds,
        action: query.action ?? null,
      },
      'audit.listByResourceKind',
    );
    const result = await this.audit.listByResourceKinds({
      resourceKinds: parseResourceKindsCsv(query.resourceKinds),
      action: query.action,
      actorUserId: query.actorUserId,
      order: query.order,
      cursor: query.cursor,
      limit: query.limit,
    });
    const response: AuditEventsListResponse = {
      events: result.events.map(toDto),
      nextCursor: result.nextCursor,
    };
    return AuditEventsListResponseSchema.parse(response);
  }

  /**
   * GET /api/v1/admin/audit/events/by-actor — list events authored by
   * a single user-id.
   *
   * Status codes:
   *   200 OK            — body is the AuditEventsListResponse.
   *   400 Bad Request   — query string failed Zod validation.
   *   401 Unauthorized  — missing / invalid access token.
   */
  @Get('api/v1/admin/audit/events/by-actor')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async listByActor(
    @Query(new ZodValidationPipe(ListAuditEventsByActorQuerySchema))
    query: ListAuditEventsByActorQuery,
    @Req() request: RequestWithContext,
  ): Promise<AuditEventsListResponse> {
    this.logger.debug(
      {
        actorUserId: request.requestContext?.userId,
        targetActorUserId: query.actorUserId,
      },
      'audit.listByActor',
    );
    const result = await this.audit.listByActor(query);
    const response: AuditEventsListResponse = {
      events: result.events.map(toDto),
      nextCursor: result.nextCursor,
    };
    return AuditEventsListResponseSchema.parse(response);
  }
}

/**
 * Project the service-layer AuditEvent to the contract DTO. Dates
 * become ISO-8601 strings; the rest passes through unchanged.
 */
function toDto(event: AuditEvent): AuditEventResponse {
  return AuditEventResponseSchema.parse({
    id: event.id,
    eventId: event.eventId,
    occurredAt: event.occurredAt.toISOString(),
    actorUserId: event.actorUserId,
    actorRole: event.actorRole,
    actorTenantScopeType: event.actorTenantScopeType,
    actorTenantScopeId: event.actorTenantScopeId,
    action: event.action,
    resourceKind: event.resourceKind,
    resourceId: event.resourceId,
    beforeJson: event.beforeJson,
    afterJson: event.afterJson,
    ip: event.ip,
    userAgent: event.userAgent,
    requestId: event.requestId,
    traceId: event.traceId,
    chainPrevHash: event.chainPrevHash,
    chainHash: event.chainHash,
    createdAt: event.createdAt.toISOString(),
  });
}

/**
 * Constant-time shared-secret comparison. Mirrors the pattern in
 * service-identity's KycController — the length check is the only
 * branch on the secret material; the `timingSafeEqual` comparison is
 * O(N) regardless of where the first byte differs.
 */
function isSharedSecretValid(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
