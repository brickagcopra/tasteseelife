import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  BookingServiceKind,
  HouseholdSubscriptionTier,
  ProviderTier,
  ProviderTierSnapshotTier,
  BookingTierGatingMode,
  BookingTierGatingViolationReason,
} from '@taste-and-see/contracts';

import { err, ok, type Result } from '../../../common/result';
import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { PrismaService } from '../../../prisma/prisma.service';
import { CatalogService } from '../../catalog/services/catalog.service';

/**
 * Ordinal ranking of the provider-tier ladder (TS-220-followup-1). Both
 * `ProviderTier` (the catalog's `required_provider_tier`) and
 * `ProviderTierSnapshotTier` (the per-booking provider-tier cache) share
 * the identical `basic | certified | elite` value domain — see
 * TS-220-followup-2 for the eventual enum consolidation. A provider
 * satisfies a service-kind requirement when its rank is at or above the
 * required rank.
 */
const PROVIDER_TIER_RANK: Record<'basic' | 'certified' | 'elite', number> = {
  basic: 0,
  certified: 1,
  elite: 2,
};

/**
 * Persisted shape returned by the tier-snapshot upsert methods. The
 * field set mirrors the contract response schemas in
 * `packages/contracts/src/http/booking-tier-snapshots.schema.ts`.
 */
export interface HouseholdTierSnapshotRecord {
  readonly householdId: string;
  readonly tier: HouseholdSubscriptionTier;
  readonly lastSyncedAt: Date;
  readonly sourceEventId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ProviderTierSnapshotRecord {
  readonly providerId: string;
  readonly tier: ProviderTierSnapshotTier;
  readonly lastSyncedAt: Date;
  readonly sourceEventId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Inputs accepted by the upsert methods. `sourceEventId` is optional —
 * the internal HTTP endpoint leaves it undefined when ops/gateway is
 * the caller; the future TS-142 event consumer sets it.
 */
export interface UpsertHouseholdSnapshotInput {
  readonly householdId: string;
  readonly tier: HouseholdSubscriptionTier;
  readonly lastSyncedAt: Date;
  readonly sourceEventId?: string;
}

export interface UpsertProviderSnapshotInput {
  readonly providerId: string;
  readonly tier: ProviderTierSnapshotTier;
  readonly lastSyncedAt: Date;
  readonly sourceEventId?: string;
}

/**
 * `evaluate` outcome — what the booking-create gate found and
 * decided. Three shapes:
 *
 *   - `allowed`                       — both snapshots present, gate passes.
 *   - `allowed_with_advisory_warning` — gate would block, but mode is
 *                                       `advisory` so booking proceeds.
 *                                       Carries the categorical reason
 *                                       so the caller can log + emit a
 *                                       `booking.tier_gating_violation`
 *                                       event.
 *   - `blocked`                       — mode is `enforce` and the gate
 *                                       failed. Caller rejects the
 *                                       booking with a typed failure.
 */
export type TierGatingDecision =
  | {
      readonly outcome: 'allowed';
      readonly householdTier: HouseholdSubscriptionTier;
      readonly providerTier: ProviderTierSnapshotTier;
    }
  | {
      readonly outcome: 'allowed_with_advisory_warning';
      readonly reason: BookingTierGatingViolationReason;
      readonly householdTier: HouseholdSubscriptionTier | null;
      readonly providerTier: ProviderTierSnapshotTier | null;
    }
  | {
      readonly outcome: 'blocked';
      readonly reason: BookingTierGatingViolationReason;
      readonly householdTier: HouseholdSubscriptionTier | null;
      readonly providerTier: ProviderTierSnapshotTier | null;
    };

export interface EvaluateInput {
  readonly householdId: string;
  readonly providerId: string;
  /**
   * The bookable service kind (TS-220-followup-1). Drives the
   * per-service-kind catalog tier gate — the service resolves the
   * matching `service_catalog` row and, when it carries a
   * `required_provider_tier`, rejects an under-tier provider.
   */
  readonly serviceKind: BookingServiceKind;
}

/**
 * Failure shapes returned by the upsert methods. The current set is
 * empty — every upsert call succeeds against the database — but the
 * `Result` wrapping makes it easy to add typed failures later (e.g.
 * snapshot-staleness rejection when the producer-side timestamp is
 * older than the persisted one).
 */
export type TierGatingServiceFailure = {
  readonly reason: 'invalid_request';
  readonly message: string;
};

/**
 * Tier-gating service (TS-064; PRD §5.1 / §5.2; CLAUDE.md §12).
 *
 * Two responsibilities:
 *
 *   1. Persist read-side cache rows for household + provider tier.
 *      Hydrated by the internal HTTP endpoint (ops / gateway BFF) in
 *      Phase 1; eventually by the `subscription.tier_changed` /
 *      `provider.tier_changed` event consumer once TS-142 lands.
 *
 *   2. Evaluate the booking-create gate. CLAUDE.md §12 mandates two
 *      complementary tier rules:
 *        a. **Per-household** — Tier-3 Concierge households can only
 *           book Elite Concierge providers (TS-064).
 *        b. **Per-service-kind** (TS-220-followup-1) — a service kind
 *           may carry a `service_catalog.required_provider_tier` (the
 *           Tier-3 concierge experiences in PRD §6.6 require `elite`);
 *           the assigned provider's tier must rank at or above it. This
 *           catches the case rule (a) misses: a Tier-1/Tier-2 household
 *           booking a concierge experience with a non-elite provider.
 *      The evaluation is a decision over the two snapshots + the
 *      resolved catalog row + the configured mode.
 *
 * The gate logic is intentionally narrow so it lives inline. Future
 * tier policies (e.g. "Tier 2 can book Certified or Elite") get added
 * as additional cases here. The decision shape (`TierGatingDecision`)
 * is forward-compatible.
 *
 * **Mode-gated behaviour** (`BOOKING_TIER_GATING_MODE`):
 *
 *   - `enforce`  — missing snapshot OR tier mismatch returns `blocked`.
 *   - `advisory` — same conditions return `allowed_with_advisory_warning`,
 *                  letting the booking proceed but tagging the attempt.
 *
 * Phase-1 default is `advisory` so the cache can hydrate without
 * breaking new sign-ups. The mode flips to `enforce` once snapshot
 * coverage is acceptable (Phase-2 — see TS-064 follow-ups).
 */
@Injectable()
export class TierGatingService {
  private readonly logger = new Logger(TierGatingService.name);
  private readonly mode: BookingTierGatingMode;

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    @Inject(ENV_TOKEN) env: Env,
  ) {
    this.mode = env.BOOKING_TIER_GATING_MODE;
    this.logger.log(`tier-gating mode=${this.mode}`);
  }

  /**
   * Insert or update a household tier snapshot. Keyed by `householdId`;
   * the upsert path is a PK lookup. Returns the persisted row.
   */
  async upsertHouseholdSnapshot(
    input: UpsertHouseholdSnapshotInput,
  ): Promise<Result<HouseholdTierSnapshotRecord, TierGatingServiceFailure>> {
    if (input.householdId.length === 0) {
      return err({ reason: 'invalid_request', message: 'householdId is required' });
    }
    const row = (await this.prisma.householdTierSnapshot.upsert({
      where: { householdId: input.householdId },
      create: {
        householdId: input.householdId,
        tier: input.tier,
        lastSyncedAt: input.lastSyncedAt,
        ...(input.sourceEventId !== undefined && { sourceEventId: input.sourceEventId }),
      },
      update: {
        tier: input.tier,
        lastSyncedAt: input.lastSyncedAt,
        sourceEventId: input.sourceEventId ?? null,
      },
    })) as HouseholdTierSnapshotRecord;
    this.logger.log(
      `household-tier-snapshot upserted householdId=${row.householdId} tier=${row.tier}`,
    );
    return ok(row);
  }

  /**
   * Insert or update a provider tier snapshot. Mirrors
   * `upsertHouseholdSnapshot` for the provider side.
   */
  async upsertProviderSnapshot(
    input: UpsertProviderSnapshotInput,
  ): Promise<Result<ProviderTierSnapshotRecord, TierGatingServiceFailure>> {
    if (input.providerId.length === 0) {
      return err({ reason: 'invalid_request', message: 'providerId is required' });
    }
    const row = (await this.prisma.providerTierSnapshot.upsert({
      where: { providerId: input.providerId },
      create: {
        providerId: input.providerId,
        tier: input.tier,
        lastSyncedAt: input.lastSyncedAt,
        ...(input.sourceEventId !== undefined && { sourceEventId: input.sourceEventId }),
      },
      update: {
        tier: input.tier,
        lastSyncedAt: input.lastSyncedAt,
        sourceEventId: input.sourceEventId ?? null,
      },
    })) as ProviderTierSnapshotRecord;
    this.logger.log(
      `provider-tier-snapshot upserted providerId=${row.providerId} tier=${row.tier}`,
    );
    return ok(row);
  }

  /**
   * Evaluate the tier-gating decision for a booking attempt.
   *
   * Reads the two snapshot rows in parallel, applies the gate, and
   * returns the categorical decision. Pure-ish — the only side effect
   * is the DB read.
   */
  async evaluate(input: EvaluateInput): Promise<TierGatingDecision> {
    const [household, provider, catalogEntry] = await Promise.all([
      this.prisma.householdTierSnapshot.findUnique({
        where: { householdId: input.householdId },
      }) as Promise<HouseholdTierSnapshotRecord | null>,
      this.prisma.providerTierSnapshot.findUnique({
        where: { providerId: input.providerId },
      }) as Promise<ProviderTierSnapshotRecord | null>,
      // The catalog row carries the per-service-kind tier requirement
      // (TS-220-followup-1). Null when no row exists for the kind — a
      // kind without a catalog row carries no requirement.
      this.catalog.getByKind(input.serviceKind),
    ]);

    if (household === null) {
      return this.violation({
        reason: 'household_snapshot_unknown',
        householdTier: null,
        providerTier: provider?.tier ?? null,
      });
    }
    if (provider === null) {
      return this.violation({
        reason: 'provider_snapshot_unknown',
        householdTier: household.tier,
        providerTier: null,
      });
    }

    // Rule (a): per-household gate (TS-064; CLAUDE.md §12). Checked
    // first so its established `tier_3_requires_elite` reason keeps
    // precedence for a Tier-3 household.
    if (household.tier === 'tier_3_concierge' && provider.tier !== 'elite') {
      return this.violation({
        reason: 'tier_3_requires_elite',
        householdTier: household.tier,
        providerTier: provider.tier,
      });
    }

    // Rule (b): per-service-kind catalog gate (TS-220-followup-1;
    // CLAUDE.md §12). Catches the case rule (a) misses — a Tier-1/Tier-2
    // household booking a concierge experience (PRD §6.6) with an
    // under-tier provider.
    const requiredTier: ProviderTier | null = catalogEntry?.requiredProviderTier ?? null;
    if (
      requiredTier !== null &&
      PROVIDER_TIER_RANK[provider.tier] < PROVIDER_TIER_RANK[requiredTier]
    ) {
      return this.violation({
        reason: 'service_kind_requires_higher_tier',
        householdTier: household.tier,
        providerTier: provider.tier,
      });
    }

    return {
      outcome: 'allowed',
      householdTier: household.tier,
      providerTier: provider.tier,
    };
  }

  /**
   * Read-only access to the configured mode. Exposed so the caller
   * (`BookingsService`) and the OpenAPI / observability surfaces can
   * inspect the policy without re-injecting the env.
   */
  getMode(): BookingTierGatingMode {
    return this.mode;
  }

  private violation(args: {
    readonly reason: BookingTierGatingViolationReason;
    readonly householdTier: HouseholdSubscriptionTier | null;
    readonly providerTier: ProviderTierSnapshotTier | null;
  }): TierGatingDecision {
    if (this.mode === 'enforce') {
      return {
        outcome: 'blocked',
        reason: args.reason,
        householdTier: args.householdTier,
        providerTier: args.providerTier,
      };
    }
    return {
      outcome: 'allowed_with_advisory_warning',
      reason: args.reason,
      householdTier: args.householdTier,
      providerTier: args.providerTier,
    };
  }
}
