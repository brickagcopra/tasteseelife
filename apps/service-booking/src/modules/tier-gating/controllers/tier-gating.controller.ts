import { timingSafeEqual } from 'node:crypto';

import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  UnauthorizedException,
  UsePipes,
} from '@nestjs/common';
import {
  type HouseholdTierSnapshotResponse,
  HouseholdTierSnapshotResponseSchema,
  type ProviderTierSnapshotResponse,
  ProviderTierSnapshotResponseSchema,
  type UpsertHouseholdTierSnapshotRequest,
  UpsertHouseholdTierSnapshotRequestSchema,
  type UpsertProviderTierSnapshotRequest,
  UpsertProviderTierSnapshotRequestSchema,
} from '@taste-and-see/contracts';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request } from 'express';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import {
  TierGatingService,
  type HouseholdTierSnapshotRecord,
  type ProviderTierSnapshotRecord,
  type TierGatingServiceFailure,
} from '../services/tier-gating.service';

/**
 * Tier-snapshot internal HTTP surface (TS-064). Two endpoints, both
 * pinned to a shared-secret header — same defence-in-depth pattern
 * as service-identity's KYC internal-dispatch endpoint (TS-026) and
 * service-provider's background-check ingress endpoint (TS-051).
 *
 *   POST /api/v1/internal/booking/tier-snapshots/household
 *     Upsert a household tier snapshot. Called by ops / the gateway
 *     BFF when a household's plan changes; eventually the
 *     `subscription.tier_changed` event consumer (TS-142).
 *
 *   POST /api/v1/internal/booking/tier-snapshots/provider
 *     Mirror endpoint for providers. Called when a provider's tier
 *     transitions (TS-052 tier promotion). Eventually consumed via
 *     `provider.tier_changed` events.
 *
 * Both routes return the upserted row shape so the caller can verify
 * the persisted state (mirrors the KYC dispatcher's pattern — the
 * dispatcher stamps `dispatched_at` only on a successful 2xx).
 *
 * Auth model. Pinned to a shared-secret header (configurable via
 * `BOOKING_TIER_DISPATCH_HEADER_NAME` / `BOOKING_TIER_DISPATCH_API_KEY`).
 * The TS-151 NetworkPolicy will restrict the routes to in-cluster
 * callers; the header is the application-layer defence-in-depth.
 *
 * Idempotency. The endpoints are inherently idempotent (PK upsert)
 * so they do NOT wear `@Idempotent()` — a retry simply re-applies the
 * same state. Mirrors the KYC dispatcher's design.
 *
 * Tenant-scoping (TS-020-followup-2b-platform-rollout). Both endpoints
 * run BEFORE any `requestContext` exists — they pin the shared-secret
 * header instead of `AccessTokenGuard`, so the
 * `TenantContextInterceptor` cannot seed a scoped frame. Each handler
 * body is wrapped in `runWithoutTenantContext(..., '<reason>', ...)` so
 * the Prisma extension's gate sees an explicit `exempt` frame rather
 * than failing with `MissingRequestContextError` under the
 * `enforcement: 'enforce'` posture wired in `AppModule`. The two reason
 * strings are unique + grep-able so a future audit-log scan can trace
 * every "no-context" Prisma access back to its dispatch source:
 *
 *   - `internal-tier-snapshot-household-upsert` for
 *     `upsertHouseholdSnapshot`
 *   - `internal-tier-snapshot-provider-upsert` for
 *     `upsertProviderSnapshot`
 *
 * Mirrors the canonical shape landed in `service-identity`'s
 * `KycController.receiveWebhookEvent` and `service-provider`'s
 * `ApplicationsController.receiveWebhookEvent` /
 * `ProviderDiscoveryController.getSnapshot` under TS-020-followup-2b.
 */
@Controller()
export class TierGatingController {
  private readonly internalApiKey: string;
  private readonly headerName: string;

  constructor(
    private readonly tierGating: TierGatingService,
    @Inject(ENV_TOKEN) env: Env,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {
    this.internalApiKey = env.BOOKING_TIER_DISPATCH_API_KEY;
    this.headerName = env.BOOKING_TIER_DISPATCH_HEADER_NAME;
  }

  @Post('api/v1/internal/booking/tier-snapshots/household')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(UpsertHouseholdTierSnapshotRequestSchema))
  async upsertHouseholdSnapshot(
    @Body() body: UpsertHouseholdTierSnapshotRequest,
    @Req() request: Request,
  ): Promise<HouseholdTierSnapshotResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'internal-tier-snapshot-household-upsert',
      async () => {
        this.requireSharedSecret(request);
        const result = await this.tierGating.upsertHouseholdSnapshot({
          householdId: body.householdId,
          tier: body.tier,
          lastSyncedAt: new Date(body.lastSyncedAt),
          ...(body.sourceEventId !== undefined && { sourceEventId: body.sourceEventId }),
        });
        if (!result.ok) {
          throwUpsertFailure(result.error);
        }
        return HouseholdTierSnapshotResponseSchema.parse(toHouseholdResponse(result.value));
      },
    );
  }

  @Post('api/v1/internal/booking/tier-snapshots/provider')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(UpsertProviderTierSnapshotRequestSchema))
  async upsertProviderSnapshot(
    @Body() body: UpsertProviderTierSnapshotRequest,
    @Req() request: Request,
  ): Promise<ProviderTierSnapshotResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'internal-tier-snapshot-provider-upsert',
      async () => {
        this.requireSharedSecret(request);
        const result = await this.tierGating.upsertProviderSnapshot({
          providerId: body.providerId,
          tier: body.tier,
          lastSyncedAt: new Date(body.lastSyncedAt),
          ...(body.sourceEventId !== undefined && { sourceEventId: body.sourceEventId }),
        });
        if (!result.ok) {
          throwUpsertFailure(result.error);
        }
        return ProviderTierSnapshotResponseSchema.parse(toProviderResponse(result.value));
      },
    );
  }

  private requireSharedSecret(request: Request): void {
    const presented = request.header(this.headerName);
    if (!isSharedSecretValid(presented, this.internalApiKey)) {
      throw new UnauthorizedException({
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'Internal dispatch authentication failed.',
      });
    }
  }
}

function toHouseholdResponse(row: HouseholdTierSnapshotRecord): HouseholdTierSnapshotResponse {
  return {
    householdId: row.householdId,
    tier: row.tier,
    lastSyncedAt: row.lastSyncedAt.toISOString(),
    sourceEventId: row.sourceEventId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toProviderResponse(row: ProviderTierSnapshotRecord): ProviderTierSnapshotResponse {
  return {
    providerId: row.providerId,
    tier: row.tier,
    lastSyncedAt: row.lastSyncedAt.toISOString(),
    sourceEventId: row.sourceEventId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function throwUpsertFailure(failure: TierGatingServiceFailure): never {
  switch (failure.reason) {
    case 'invalid_request':
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: failure.message,
      });
  }
}

/**
 * Constant-time shared-secret comparison. Mirrors service-identity's
 * `isSharedSecretValid` shape — `timingSafeEqual` over equal-length
 * buffers, length check as the early reject. Defence-in-depth against
 * timing oracles even though this surface is in-cluster only.
 */
function isSharedSecretValid(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
