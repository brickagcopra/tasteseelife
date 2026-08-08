import { Injectable, Logger } from '@nestjs/common';
import { PROVIDER_TIER_CHANGED } from '@taste-and-see/contracts';
import { AuditEmitter, type AuditActorContext } from '@taste-and-see/nest-audit';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';
import { withSpan } from '@taste-and-see/tracing';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';

import { PROVIDER_AUDIT_RESOURCE } from '../../audit/audit-resources';
import { CERTIFIED_TIER_CODE, ELITE_TIER_CODE } from '../seed-catalog';
import {
  CertificationsMetrics,
  tierFailureOutcome,
  type ProviderTierOutcome,
  type TierTransitionLabels,
} from './certifications-metrics';
import { ProviderCertificationsService } from './provider-certifications.service';
import { err, ok, type Result } from './result';

/**
 * Local mirrors of the Prisma-generated enums + row shapes. Same
 * TS-051-followup-9 rationale documented elsewhere.
 */
export type ProviderTier = 'basic' | 'certified' | 'elite';
export type ProviderStatus = 'pending' | 'in_review' | 'active' | 'suspended' | 'archived';
export type TierTransitionReason = 'auto_evaluation' | 'admin_override';

export interface ProviderTierHistoryRow {
  readonly id: string;
  readonly providerId: string;
  readonly fromTier: ProviderTier | null;
  readonly toTier: ProviderTier;
  readonly reason: TierTransitionReason;
  readonly triggeredByUserId: string | null;
  readonly notes: string | null;
  readonly occurredAt: Date;
  readonly createdAt: Date;
}

export interface ProviderRowForPromotion {
  readonly id: string;
  readonly status: ProviderStatus;
  readonly tier: ProviderTier;
}

export interface EvaluateAndApplyInput {
  readonly providerId: string;
  readonly triggeredByUserId?: string;
  readonly notes?: string;
  /**
   * `true` returns the computed next tier without writing — useful
   * for an admin UI preview. Default `false` (write-through).
   */
  readonly dryRun?: boolean;
  /**
   * TS-305a-followup-1 — the verified actor. REQUIRED on the write path;
   * a tier move changes which clients a provider may be booked for
   * (CLAUDE.md §12 tier gating), so an unaudited one must not be
   * representable. A dryRun still carries it — the type stays uniform and
   * the emit never runs on that path anyway.
   */
  readonly audit: AuditActorContext;
}

export interface EvaluateAndApplyResult {
  readonly provider: ProviderRowForPromotion;
  readonly previousTier: ProviderTier;
  readonly nextTier: ProviderTier;
  readonly applied: boolean;
  readonly history: ProviderTierHistoryRow | null;
}

export interface OverrideTierInput {
  readonly providerId: string;
  readonly targetTier: ProviderTier;
  readonly triggeredByUserId: string;
  readonly notes: string;
  /** TS-305a-followup-1 — see EvaluateAndApplyInput.audit. */
  readonly audit: AuditActorContext;
}

export interface OverrideTierResult {
  readonly provider: ProviderRowForPromotion;
  readonly previousTier: ProviderTier;
  readonly nextTier: ProviderTier;
  readonly applied: boolean;
  readonly history: ProviderTierHistoryRow | null;
}

export type TierPromotionFailure =
  | { readonly reason: 'invalid_request'; readonly message: string }
  | { readonly reason: 'provider_not_found'; readonly providerId: string }
  | {
      readonly reason: 'outbox_validation_failed';
      readonly eventName: string;
      readonly message: string;
    };

/**
 * Thrown inside `applyTransition`'s `$transaction` when
 * `OutboxService.append` rejects the payload — mirrors the same
 * pattern in `provider-certifications.service.ts`. Caught at the
 * outer `evaluateAndApply` / `overrideTier` boundary and translated
 * to a typed `outbox_validation_failed` failure.
 */
class OutboxValidationFailedError extends Error {
  constructor(
    public readonly eventName: string,
    public readonly issues: ReadonlyArray<{
      readonly path: ReadonlyArray<string | number>;
      readonly message: string;
    }>,
  ) {
    super(`outbox.append validation failed for ${eventName}`);
    this.name = 'OutboxValidationFailedError';
  }
}

/**
 * `TierPromotionService` — owns the tier-eligibility rules and the
 * append-only transition log (TS-052).
 *
 * Surfaces:
 *  - `evaluateAndApply({providerId, triggeredByUserId?, dryRun?})` —
 *    recomputes the eligible tier from the provider's active
 *    certifications + status. Applies the resulting tier if it
 *    differs from the current one, records a history row, and
 *    returns the projected result. A `dryRun` returns the projection
 *    without writing.
 *  - `overrideTier({providerId, targetTier, triggeredByUserId,
 *    notes})` — sets the tier directly, bypassing the eligibility
 *    rules. Records `reason = admin_override` in history; requires
 *    notes for the audit trail.
 *  - `getHistory(providerId)` — returns the append-only transition
 *    log newest-first.
 *
 * **Eligibility rules** (PRD §5.2):
 *   - `basic`     — default. Provider has no qualifying credential.
 *   - `certified` — provider holds the Certified Culinary Companion
 *                   (`ccc`) credential.
 *   - `elite`     — provider holds both CCC and the Elite Concierge
 *                   Provider (`ecc`) credential.
 *
 * **Status interaction**. Eligibility rules apply regardless of
 * `Provider.status` — a `suspended` provider keeps their tier on
 * paper (so resuming doesn't re-trigger an evaluation cycle), but
 * cannot accept bookings (CLAUDE.md §12 / PDD §16.1). Admin tooling
 * uses `overrideTier` to demote on suspension when the policy calls
 * for it.
 *
 * **Append-only invariant** (CLAUDE.md §3.6). Tier-history rows are
 * inserted and never updated or deleted. `getHistory` reads but the
 * service never exposes a mutate-row method.
 */
@Injectable()
export class TierPromotionService {
  private readonly logger = new Logger(TierPromotionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly certifications: ProviderCertificationsService,
    /**
     * TS-052-followup-1 — producer-side outbox SDK. Injected here so
     * `provider.tier_changed` events append inside the same Prisma
     * transaction that updates `providers.tier` + inserts the
     * `provider_tier_history` row (the outbox invariant from
     * PDD §7.3 / CLAUDE.md §5.3).
     *
     * Provided by the global `OutboxModule` wired in `app.module.ts`.
     */
    private readonly outbox: OutboxService,
    /** TS-305a-followup-1 — shared audit emission, in-transaction. */
    private readonly audit: AuditEmitter,
    // Optional default (TS-052-followup-9) — the existing three-arg
    // unit-test call sites keep working; Nest injects the registered
    // provider in prod. No-op meter until `initMetrics` runs.
    private readonly metrics: CertificationsMetrics = new CertificationsMetrics(),
  ) {}

  /**
   * Recompute and (optionally) apply the tier matching the
   * provider's current eligibility. Writes a history row only when
   * the tier actually changes.
   *
   * History is recorded inside the same transaction as the
   * `providers.tier` update — a partial failure rolls both back.
   */
  async evaluateAndApply(
    input: EvaluateAndApplyInput,
  ): Promise<Result<EvaluateAndApplyResult, TierPromotionFailure>> {
    return withSpan('provider.tier.evaluate', async (span) => {
      const startNs = process.hrtime.bigint();
      let outcome: ProviderTierOutcome = 'error';
      let transition: TierTransitionLabels | null = null;
      try {
        const result = await this.runEvaluateAndApply(input);
        if (result.ok) {
          outcome = 'ok';
          if (result.value.applied) {
            transition = {
              from: result.value.previousTier,
              to: result.value.nextTier,
              reason: 'auto_evaluation',
            };
          }
        } else {
          outcome = tierFailureOutcome(result.error);
        }
        return result;
      } finally {
        const seconds = Number(process.hrtime.bigint() - startNs) / 1e9;
        span.setAttribute('provider.tier.outcome', outcome);
        this.metrics.recordTierEvaluate(outcome, seconds, transition);
      }
    });
  }

  private async runEvaluateAndApply(
    input: EvaluateAndApplyInput,
  ): Promise<Result<EvaluateAndApplyResult, TierPromotionFailure>> {
    if (input.providerId.length === 0) {
      return err({ reason: 'invalid_request', message: 'providerId is required' });
    }

    const provider = (await this.prisma.provider.findUnique({
      where: { id: input.providerId },
      select: { id: true, status: true, tier: true },
    })) as ProviderRowForPromotion | null;
    if (provider === null) {
      return err({ reason: 'provider_not_found', providerId: input.providerId });
    }

    const codes = await this.certifications.listActiveCodes(input.providerId);
    const nextTier = computeEligibleTier(codes);
    const previousTier = provider.tier;

    if (nextTier === previousTier || input.dryRun === true) {
      return ok({
        provider,
        previousTier,
        nextTier,
        applied: false,
        history: null,
      });
    }

    try {
      const applied = await this.applyTransition({
        providerId: input.providerId,
        fromTier: previousTier,
        toTier: nextTier,
        reason: 'auto_evaluation',
        audit: input.audit,
        ...(input.triggeredByUserId !== undefined && {
          triggeredByUserId: input.triggeredByUserId,
        }),
        ...(input.notes !== undefined && { notes: input.notes }),
      });

      this.logger.log(
        {
          providerId: input.providerId,
          previousTier,
          nextTier,
          triggeredByUserId: input.triggeredByUserId ?? null,
        },
        'tier-promotion.evaluate ok',
      );

      return ok({
        provider: applied.provider,
        previousTier,
        nextTier,
        applied: true,
        history: applied.history,
      });
    } catch (e) {
      if (e instanceof OutboxValidationFailedError) {
        this.logger.error(
          { eventName: e.eventName, issues: e.issues },
          'tier-promotion.evaluate outbox validation failed; tx rolled back',
        );
        return err({
          reason: 'outbox_validation_failed',
          eventName: e.eventName,
          message: `event ${e.eventName} payload failed validation`,
        });
      }
      throw e;
    }
  }

  /**
   * Set the provider's tier directly. Used for ops overrides that
   * bypass eligibility rules (e.g. demoting a provider pending
   * complaint review, or restoring a tier after resolution).
   *
   * A no-op call (target === current) returns `applied = false` and
   * `history = null` — the audit trail records *transitions*, not
   * confirmations.
   */
  async overrideTier(
    input: OverrideTierInput,
  ): Promise<Result<OverrideTierResult, TierPromotionFailure>> {
    return withSpan('provider.tier.override', async (span) => {
      const startNs = process.hrtime.bigint();
      let outcome: ProviderTierOutcome = 'error';
      let transition: TierTransitionLabels | null = null;
      try {
        const result = await this.runOverrideTier(input);
        if (result.ok) {
          outcome = 'ok';
          if (result.value.applied) {
            transition = {
              from: result.value.previousTier,
              to: result.value.nextTier,
              reason: 'admin_override',
            };
          }
        } else {
          outcome = tierFailureOutcome(result.error);
        }
        return result;
      } finally {
        const seconds = Number(process.hrtime.bigint() - startNs) / 1e9;
        span.setAttribute('provider.tier.outcome', outcome);
        this.metrics.recordTierOverride(outcome, seconds, transition);
      }
    });
  }

  private async runOverrideTier(
    input: OverrideTierInput,
  ): Promise<Result<OverrideTierResult, TierPromotionFailure>> {
    if (input.providerId.length === 0) {
      return err({ reason: 'invalid_request', message: 'providerId is required' });
    }
    if (input.triggeredByUserId.length === 0) {
      return err({
        reason: 'invalid_request',
        message: 'triggeredByUserId is required for an admin override',
      });
    }
    if (input.notes.length === 0) {
      return err({
        reason: 'invalid_request',
        message: 'notes is required for an admin override',
      });
    }

    const provider = (await this.prisma.provider.findUnique({
      where: { id: input.providerId },
      select: { id: true, status: true, tier: true },
    })) as ProviderRowForPromotion | null;
    if (provider === null) {
      return err({ reason: 'provider_not_found', providerId: input.providerId });
    }

    const previousTier = provider.tier;
    const nextTier = input.targetTier;

    if (previousTier === nextTier) {
      return ok({
        provider,
        previousTier,
        nextTier,
        applied: false,
        history: null,
      });
    }

    try {
      const applied = await this.applyTransition({
        providerId: input.providerId,
        fromTier: previousTier,
        toTier: nextTier,
        reason: 'admin_override',
        audit: input.audit,
        triggeredByUserId: input.triggeredByUserId,
        notes: input.notes,
      });

      this.logger.log(
        {
          providerId: input.providerId,
          previousTier,
          nextTier,
          triggeredByUserId: input.triggeredByUserId,
        },
        'tier-promotion.override ok',
      );

      return ok({
        provider: applied.provider,
        previousTier,
        nextTier,
        applied: true,
        history: applied.history,
      });
    } catch (e) {
      if (e instanceof OutboxValidationFailedError) {
        this.logger.error(
          { eventName: e.eventName, issues: e.issues },
          'tier-promotion.override outbox validation failed; tx rolled back',
        );
        return err({
          reason: 'outbox_validation_failed',
          eventName: e.eventName,
          message: `event ${e.eventName} payload failed validation`,
        });
      }
      throw e;
    }
  }

  /**
   * Return the append-only history for a provider, newest-first.
   */
  async getHistory(providerId: string): Promise<readonly ProviderTierHistoryRow[]> {
    if (providerId.length === 0) return [];
    const rows = (await this.prisma.providerTierHistory.findMany({
      where: { providerId },
      orderBy: { occurredAt: 'desc' },
    })) as ProviderTierHistoryRow[];
    return rows;
  }

  /**
   * Atomic provider-row update + history-row insert + outbox-event
   * append. Returns the updated provider + history row.
   *
   * The outbox event is appended inside the same `prisma.$transaction`
   * as the row writes so the bus never sees a tier change that didn't
   * land in the ledger (PDD §7.3 / CLAUDE.md §5.3 outbox invariant).
   * A validation failure on the payload throws
   * `OutboxValidationFailedError`, which rolls the transaction back;
   * the caller (`evaluateAndApply` / `overrideTier`) catches it and
   * surfaces a typed `outbox_validation_failed` failure.
   *
   * `eventId` is `${historyRow.id}.tier_changed` — one history row =
   * one tier transition = one outbox event. The history row id is
   * stable + unique + generated by the same transaction, so a retry
   * never produces a duplicate event (the SDK's `ON CONFLICT
   * DO NOTHING` clause additionally swallows accidental replays).
   */
  private async applyTransition(args: {
    readonly providerId: string;
    readonly fromTier: ProviderTier;
    readonly toTier: ProviderTier;
    readonly reason: TierTransitionReason;
    readonly triggeredByUserId?: string;
    readonly notes?: string;
    readonly audit: AuditActorContext;
  }): Promise<{
    readonly provider: ProviderRowForPromotion;
    readonly history: ProviderTierHistoryRow;
  }> {
    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const provider = (await tx.provider.update({
        where: { id: args.providerId },
        data: { tier: args.toTier },
        select: { id: true, status: true, tier: true },
      })) as ProviderRowForPromotion;

      const history = (await tx.providerTierHistory.create({
        data: {
          providerId: args.providerId,
          fromTier: args.fromTier,
          toTier: args.toTier,
          reason: args.reason,
          ...(args.triggeredByUserId !== undefined && {
            triggeredByUserId: args.triggeredByUserId,
          }),
          ...(args.notes !== undefined && { notes: args.notes }),
        },
      })) as ProviderTierHistoryRow;

      const appended = await this.outbox.append(tx as unknown as OutboxRawExecutor, {
        eventName: PROVIDER_TIER_CHANGED,
        eventId: `${history.id}.tier_changed`,
        occurredAt: history.occurredAt,
        payload: {
          eventId: `${history.id}.tier_changed`,
          occurredAt: history.occurredAt.toISOString(),
          providerId: args.providerId,
          fromTier: args.fromTier,
          toTier: args.toTier,
          reason: args.reason,
          triggeredByUserId: args.triggeredByUserId ?? null,
        },
      });
      if (appended.kind !== 'appended') {
        throw new OutboxValidationFailedError(appended.eventName, appended.issues);
      }

      // TS-305a-followup-1 — audited in the SAME transaction as the move
      // (CLAUDE.md §3.6, §5.3). One emission covers both entry points:
      // auto-evaluation and admin override differ only by `reason`, which is
      // on the diff, so a second call site would only be a second thing to
      // forget. An audit failure rolls the tier change back.
      await this.audit.emit(tx as unknown as OutboxRawExecutor, args.audit, {
        action: 'provider_tier:change',
        resourceKind: PROVIDER_AUDIT_RESOURCE.tier,
        resourceId: args.providerId,
        before: { tier: args.fromTier },
        after: {
          tier: args.toTier,
          reason: args.reason,
          historyId: history.id,
          triggeredByUserId: args.triggeredByUserId ?? null,
          notes: args.notes ?? null,
        },
      });

      return { provider, history };
    });
  }
}

/**
 * Compute the eligible tier given the set of active certification
 * codes. Pure function — easy to unit-test in isolation and easy to
 * extend with new rules.
 */
export function computeEligibleTier(activeCodes: ReadonlySet<string>): ProviderTier {
  const hasCcc = activeCodes.has(CERTIFIED_TIER_CODE);
  const hasEcc = activeCodes.has(ELITE_TIER_CODE);
  if (hasCcc && hasEcc) return 'elite';
  if (hasCcc) return 'certified';
  return 'basic';
}
