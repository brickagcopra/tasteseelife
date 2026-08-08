import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  UseGuards,
} from '@nestjs/common';
import {
  ProviderDossierResponseSchema,
  type ProviderDossierCore,
  type ProviderDossierResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, PermissionGuard, RequirePermissions } from '@taste-and-see/nest-auth';

import type { ProviderProfileSnapshot } from '../../profile/services/provider-profile.service';
import { ProviderDossierService } from '../services/provider-dossier.service';

/** Bound so a pathological path param can't reach the database. */
const PROVIDER_ID_MAX_LENGTH = 64;

/**
 * Admin provider dossier HTTP boundary (TS-305a; PRD §10.14, PDD §16.1).
 *
 *   GET /api/v1/admin/providers/:providerId/dossier
 *     Everything a reviewer needs about one provider in a single
 *     round-trip: the core row, the full certification history, the
 *     tier-transition log, and the latest background-check verdict.
 *
 * **Gated on `provider:read`, a permission this task adds.** The only
 * provider permission that existed was `provider:approve`, and it is a
 * WRITE authority — it gates granting a certification and overriding a
 * tier. Gating a read on it would mean anyone allowed to look at a
 * provider is also allowed to revoke their credentials. It is also not
 * held by the `trust_safety` role, so the review committee this
 * endpoint exists for would have been locked out of it. `provider:read`
 * is granted to `super_admin`, `operations_manager`, `provider_ops`,
 * and `trust_safety` in the identity seed catalog. **`pnpm seed:rbac`
 * must re-run on deploy** before the gate can pass for anyone.
 *
 * **Read-only, no idempotency key.** GET is naturally idempotent.
 *
 * **No audit emission.** service-provider does not emit audit events
 * on any surface yet, and this endpoint mutates nothing. Read-audit
 * for admin surfaces is a platform-wide gap tracked separately
 * (TS-128-followup-7); adding a one-off here would be a second
 * implementation to reconcile later. Filed as TS-305a-followup-1.
 *
 * **Tenant scoping.** The route is authenticated, so
 * `TenantContextInterceptor` has seeded a scoped frame before the
 * handler runs — no `runWithoutTenantContext` wrap (unlike the
 * anonymous catalog read on `CertificationsController`).
 */
@Controller()
export class ProviderDossierController {
  constructor(private readonly dossier: ProviderDossierService) {}

  @Get('api/v1/admin/providers/:providerId/dossier')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @RequirePermissions('provider:read')
  async getDossier(@Param('providerId') providerId: string): Promise<ProviderDossierResponse> {
    if (providerId.length === 0 || providerId.length > PROVIDER_ID_MAX_LENGTH) {
      throw notFound(providerId);
    }

    // One clock for the whole dossier — see the service doc-block.
    const now = new Date();
    const snapshot = await this.dossier.getDossier(providerId, now);
    if (snapshot === null) {
      throw notFound(providerId);
    }

    const response: ProviderDossierResponse = {
      provider: toDossierCoreDto(snapshot.profile),
      certifications: [...snapshot.certifications],
      tierHistory: [...snapshot.tierHistory],
      backgroundCheck: snapshot.backgroundCheck,
      // TS-305d. Passed through unchanged — the metrics service already
      // produced the contract's shape, including its ISO strings, so
      // there is nothing for this mapper to decide.
      metrics: snapshot.metrics,
      generatedAt: now.toISOString(),
    };
    return ProviderDossierResponseSchema.parse(response);
  }
}

/**
 * Project the profile snapshot to the dossier's core DTO.
 *
 * Separate from `ProviderProfileController`'s `toProfileDto` on
 * purpose: this one carries `userId` and `deletedAt`, which are
 * admin-only and must never appear on the public profile shape. Two
 * mappers because they answer to two different audiences — merging
 * them is how an admin field ends up on a family-facing response.
 */
function toDossierCoreDto(snapshot: ProviderProfileSnapshot): ProviderDossierCore {
  const { row } = snapshot;
  return {
    id: row.id,
    userId: row.userId,
    status: row.status,
    tier: row.tier,
    displayName: row.displayName,
    headline: row.headline,
    bio: row.bio,
    profilePhotoKey: row.profilePhotoKey,
    videoIntroKey: row.videoIntroKey,
    timeZone: row.timeZone,
    dementiaSensitive: row.dementiaSensitive,
    languages: [...snapshot.languages],
    cuisines: [...snapshot.cuisines],
    dietaryExpertise: [...snapshot.dietaryExpertise],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt !== null ? row.deletedAt.toISOString() : null,
  };
}

function notFound(providerId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: 404,
    // The id is echoed truncated — it is an opaque CUID supplied by the
    // caller, not a secret, and a reviewer pasting the wrong id needs to
    // see which one missed.
    detail: `Provider ${truncateForError(providerId)} not found.`,
  });
}

function truncateForError(value: string): string {
  if (value.length <= 32) return value;
  return `${value.slice(0, 29)}...`;
}
