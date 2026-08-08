import { Injectable, Logger } from '@nestjs/common';
import {
  CONCIERGE_ONBOARDING_STEP_TEMPLATE,
  type ConciergeOnboardingDetailRecord,
  type ConciergeOnboardingRecord,
  type ConciergeOnboardingStatus,
  type ConciergeOnboardingStepKey,
  type ConciergeOnboardingStepRecord,
  type ConciergeOnboardingStepStatus,
} from '@taste-and-see/contracts';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';

/**
 * Local mirrors of the Prisma-generated rows, narrowed to the columns this
 * module reads / writes. Same TS-021-followup-3 rationale documented across
 * the codebase — Prisma's row types resolve inconsistently under our tsconfig
 * so we project shapes by hand (dropped on the next Prisma bump — followup).
 */
interface ConciergeOnboardingRow {
  readonly id: string;
  readonly householdId: string;
  readonly status: ConciergeOnboardingStatus;
  readonly kickoffScheduledAt: Date | null;
  readonly notes: string | null;
  readonly startedByUserId: string | null;
  readonly completedAt: Date | null;
  readonly canceledAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface ConciergeOnboardingStepRow {
  readonly stepKey: ConciergeOnboardingStepKey;
  readonly status: ConciergeOnboardingStepStatus;
  readonly sortPosition: number;
  readonly notes: string | null;
  readonly completedAt: Date | null;
  readonly completedByUserId: string | null;
  readonly updatedAt: Date;
}

/** Explicit column projections — never `SELECT *` (CLAUDE.md §4.1). */
const ONBOARDING_SELECT = {
  id: true,
  householdId: true,
  status: true,
  kickoffScheduledAt: true,
  notes: true,
  startedByUserId: true,
  completedAt: true,
  canceledAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const STEP_SELECT = {
  stepKey: true,
  status: true,
  sortPosition: true,
  notes: true,
  completedAt: true,
  completedByUserId: true,
  updatedAt: true,
} as const;

/** Template lookup so a step row can project its (unstored) title/description. */
const STEP_TEMPLATE_BY_KEY = new Map(
  CONCIERGE_ONBOARDING_STEP_TEMPLATE.map((step) => [step.key, step]),
);

export interface CreateOnboardingInput {
  readonly householdId: string;
  readonly kickoffScheduledAt?: string | undefined;
  readonly notes?: string | undefined;
  /** The ops staffer opening the onboarding — from the verified token. */
  readonly actorUserId: string;
}

export interface ListOnboardingsInput {
  readonly householdId?: string | undefined;
  readonly status?: ConciergeOnboardingStatus | undefined;
  readonly limit: number;
}

export interface UpdateOnboardingInput {
  readonly onboardingId: string;
  /** `undefined` = leave; `null` = clear; `Date string` = set. */
  readonly kickoffScheduledAt?: string | null | undefined;
  readonly notes?: string | null | undefined;
  /** When true, explicitly cancel the onboarding (sticky terminal). */
  readonly cancel: boolean;
  readonly actorUserId: string;
}

export interface UpdateStepInput {
  readonly onboardingId: string;
  readonly stepKey: ConciergeOnboardingStepKey;
  readonly status: ConciergeOnboardingStepStatus;
  /** `undefined` = leave; `null` = clear; string = set. */
  readonly notes?: string | null | undefined;
  /** The concierge completing the step — from the verified token. */
  readonly actorUserId: string;
}

export type CreateOnboardingOutcome =
  | { readonly ok: true; readonly onboarding: ConciergeOnboardingDetailRecord }
  | { readonly ok: false; readonly reason: 'already_exists' };

export type UpdateOnboardingOutcome =
  | { readonly ok: true; readonly onboarding: ConciergeOnboardingDetailRecord }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'terminal'; readonly status: ConciergeOnboardingStatus };

export type UpdateStepOutcome =
  | { readonly ok: true; readonly onboarding: ConciergeOnboardingDetailRecord }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'step_not_found' }
  | { readonly ok: false; readonly reason: 'terminal'; readonly status: ConciergeOnboardingStatus };

/** Postgres unique-violation error code surfaced by Prisma as `P2002`. */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

/**
 * Tier-3 onboarding ("white-glove kickoff") service (TS-228; PRD §5.1 Tier 3;
 * PDD §10.6).
 *
 * Owns the onboarding lifecycle:
 *   - `createOnboarding` — open a checklist for a household, seeding the six
 *     frozen template steps as `pending`. The single-active partial unique
 *     index rejects a second active onboarding (`already_exists`).
 *   - `listOnboardings` — admin ops list (summaries with derived step counts),
 *     newest-first, filterable by household / status.
 *   - `getOnboarding` — admin detail read (onboarding + ordered steps).
 *   - `getOnboardingForHousehold` — the family read-only progress card read.
 *   - `updateOnboarding` — edit the kickoff time / notes, or cancel (the only
 *     explicit, sticky-terminal status transition). A canceled onboarding
 *     rejects all edits.
 *   - `updateStep` — advance / re-open one checklist step + recompute the
 *     derived rollup status.
 *
 * The rollup `status` is DERIVED from the steps on every step mutation
 * (`deriveOnboardingStatus`); `canceled` is the only status set directly.
 *
 * Authorisation lives at the controller boundary: the admin surfaces gate on
 * `concierge:read` / `concierge:write`; the family read is household-scoped via
 * the token. The service trusts the household / actor ids it is handed.
 */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Open a kickoff checklist for a household, seeding the six template steps.
   * Returns `already_exists` when the household already has an active
   * (non-deleted) onboarding (the partial unique index trips → P2002).
   */
  async createOnboarding(input: CreateOnboardingInput): Promise<CreateOnboardingOutcome> {
    try {
      const created = (await this.prisma.conciergeOnboarding.create({
        data: {
          householdId: input.householdId,
          status: 'not_started',
          kickoffScheduledAt:
            input.kickoffScheduledAt === undefined ? null : new Date(input.kickoffScheduledAt),
          notes: input.notes ?? null,
          startedByUserId: input.actorUserId,
          steps: {
            create: CONCIERGE_ONBOARDING_STEP_TEMPLATE.map((step) => ({
              householdId: input.householdId,
              stepKey: step.key,
              status: 'pending' as const,
              sortPosition: step.sortPosition,
            })),
          },
        },
        select: { id: true },
      })) as { id: string };

      this.logger.log(
        {
          onboardingId: created.id,
          householdId: input.householdId,
          actorUserId: input.actorUserId,
        },
        'concierge onboarding created',
      );
      const detail = await this.loadDetail(created.id);
      // The row was just created in this request — it cannot be missing.
      return { ok: true, onboarding: detail as ConciergeOnboardingDetailRecord };
    } catch (cause) {
      if (isUniqueViolation(cause)) {
        this.logger.warn(
          { householdId: input.householdId },
          'concierge onboarding create rejected — household already has an active onboarding (P2002)',
        );
        return { ok: false, reason: 'already_exists' };
      }
      throw cause;
    }
  }

  /** Matching onboarding summaries (with derived step counts), newest-first. */
  async listOnboardings(
    input: ListOnboardingsInput,
  ): Promise<readonly ConciergeOnboardingRecord[]> {
    const where: Record<string, unknown> = { deletedAt: null };
    if (input.householdId !== undefined) where['householdId'] = input.householdId;
    if (input.status !== undefined) where['status'] = input.status;

    const rows = (await this.prisma.conciergeOnboarding.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
      select: ONBOARDING_SELECT,
    })) as ConciergeOnboardingRow[];
    if (rows.length === 0) return [];

    // Step counts in one batched read (no N+1) — group in app.
    const stepRows = (await this.prisma.conciergeOnboardingStep.findMany({
      where: { onboardingId: { in: rows.map((row) => row.id) } },
      select: { onboardingId: true, status: true },
    })) as { onboardingId: string; status: ConciergeOnboardingStepStatus }[];

    const counts = new Map<string, { total: number; done: number }>();
    for (const step of stepRows) {
      const entry = counts.get(step.onboardingId) ?? { total: 0, done: 0 };
      entry.total += 1;
      if (isStepDone(step.status)) entry.done += 1;
      counts.set(step.onboardingId, entry);
    }

    return rows.map((row) => {
      const entry = counts.get(row.id) ?? { total: 0, done: 0 };
      return toSummaryRecord(row, entry.total, entry.done);
    });
  }

  /** Admin detail read — onboarding + ordered steps, or `null`. */
  async getOnboarding(onboardingId: string): Promise<ConciergeOnboardingDetailRecord | null> {
    return this.loadDetail(onboardingId);
  }

  /**
   * The household's active (non-deleted) onboarding for the family read-only
   * progress card, or `null` when the household has none. A household has at
   * most one active onboarding (the partial unique index), so `findFirst` is
   * unambiguous.
   */
  async getOnboardingForHousehold(
    householdId: string,
  ): Promise<ConciergeOnboardingDetailRecord | null> {
    const row = (await this.prisma.conciergeOnboarding.findFirst({
      where: { householdId, deletedAt: null },
      select: { id: true },
    })) as { id: string } | null;
    if (row === null) return null;
    return this.loadDetail(row.id);
  }

  /**
   * Edit the onboarding-level fields and/or cancel. Resolution order:
   *   1. `not_found` — the onboarding does not resolve (or is soft-deleted).
   *   2. `terminal` — a canceled onboarding rejects all edits.
   * Then the write fires. Cancelling sets `status='canceled'` + `canceledAt`;
   * the kickoff/notes edits do not change the derived rollup status.
   */
  async updateOnboarding(input: UpdateOnboardingInput): Promise<UpdateOnboardingOutcome> {
    const current = (await this.prisma.conciergeOnboarding.findFirst({
      where: { id: input.onboardingId, deletedAt: null },
      select: { id: true, status: true },
    })) as { id: string; status: ConciergeOnboardingStatus } | null;
    if (current === null) return { ok: false, reason: 'not_found' };
    if (current.status === 'canceled')
      return { ok: false, reason: 'terminal', status: current.status };

    const data: Record<string, unknown> = {};
    if (input.kickoffScheduledAt !== undefined) {
      data['kickoffScheduledAt'] =
        input.kickoffScheduledAt === null ? null : new Date(input.kickoffScheduledAt);
    }
    if (input.notes !== undefined) data['notes'] = input.notes;
    if (input.cancel) {
      data['status'] = 'canceled';
      data['canceledAt'] = new Date();
    }

    await this.prisma.conciergeOnboarding.update({
      where: { id: input.onboardingId },
      data,
      select: { id: true },
    });
    this.logger.log(
      {
        onboardingId: input.onboardingId,
        actorUserId: input.actorUserId,
        canceled: input.cancel,
        fields: Object.keys(data),
      },
      'concierge onboarding updated',
    );
    const detail = await this.loadDetail(input.onboardingId);
    return { ok: true, onboarding: detail as ConciergeOnboardingDetailRecord };
  }

  /**
   * Advance / re-open one checklist step and recompute the rollup. Resolution
   * order: `not_found` (onboarding) → `terminal` (canceled) → `step_not_found`
   * → write. Completing a step stamps its `completedAt` + `completedByUserId`;
   * any other status clears them. The onboarding's `status` + `completedAt`
   * recompute from the full step set in the same transaction.
   */
  async updateStep(input: UpdateStepInput): Promise<UpdateStepOutcome> {
    const onboarding = (await this.prisma.conciergeOnboarding.findFirst({
      where: { id: input.onboardingId, deletedAt: null },
      select: { id: true, status: true },
    })) as { id: string; status: ConciergeOnboardingStatus } | null;
    if (onboarding === null) return { ok: false, reason: 'not_found' };
    if (onboarding.status === 'canceled') {
      return { ok: false, reason: 'terminal', status: onboarding.status };
    }

    const step = (await this.prisma.conciergeOnboardingStep.findFirst({
      where: { onboardingId: input.onboardingId, stepKey: input.stepKey },
      select: { stepKey: true },
    })) as { stepKey: ConciergeOnboardingStepKey } | null;
    if (step === null) return { ok: false, reason: 'step_not_found' };

    const now = new Date();
    const completing = input.status === 'completed';

    await this.prisma.$transaction(async (tx: PrismaTransactionClient): Promise<void> => {
      const stepData: Record<string, unknown> = {
        status: input.status,
        completedAt: completing ? now : null,
        completedByUserId: completing ? input.actorUserId : null,
      };
      if (input.notes !== undefined) stepData['notes'] = input.notes;

      await tx.conciergeOnboardingStep.update({
        where: {
          onboardingId_stepKey: { onboardingId: input.onboardingId, stepKey: input.stepKey },
        },
        data: stepData,
        select: { stepKey: true },
      });

      // Recompute the rollup from the full (post-update) step set.
      const steps = (await tx.conciergeOnboardingStep.findMany({
        where: { onboardingId: input.onboardingId },
        select: { status: true },
      })) as { status: ConciergeOnboardingStepStatus }[];
      const rollup = deriveOnboardingStatus(steps.map((s) => s.status));

      await tx.conciergeOnboarding.update({
        where: { id: input.onboardingId },
        data: {
          status: rollup,
          // `completedAt` tracks the rollup: stamp when it reaches `completed`,
          // clear when a re-opened step drops it back below complete.
          completedAt: rollup === 'completed' ? now : null,
        },
        select: { id: true },
      });
    });

    this.logger.log(
      {
        onboardingId: input.onboardingId,
        stepKey: input.stepKey,
        status: input.status,
        actorUserId: input.actorUserId,
      },
      'concierge onboarding step updated',
    );
    const detail = await this.loadDetail(input.onboardingId);
    return { ok: true, onboarding: detail as ConciergeOnboardingDetailRecord };
  }

  /** Load an onboarding + its ordered steps, or `null` if missing/soft-deleted. */
  private async loadDetail(onboardingId: string): Promise<ConciergeOnboardingDetailRecord | null> {
    const row = (await this.prisma.conciergeOnboarding.findFirst({
      where: { id: onboardingId, deletedAt: null },
      select: ONBOARDING_SELECT,
    })) as ConciergeOnboardingRow | null;
    if (row === null) return null;

    const stepRows = (await this.prisma.conciergeOnboardingStep.findMany({
      where: { onboardingId },
      orderBy: [{ sortPosition: 'asc' }],
      select: STEP_SELECT,
    })) as ConciergeOnboardingStepRow[];

    return toDetailRecord(row, stepRows);
  }
}

/** A step counts toward "done" when it is completed OR deliberately skipped. */
function isStepDone(status: ConciergeOnboardingStepStatus): boolean {
  return status === 'completed' || status === 'skipped';
}

/**
 * Derive the rollup status from the step statuses. `canceled` is never derived
 * (it is set explicitly + is sticky), so this returns one of the three derived
 * states only.
 */
export function deriveOnboardingStatus(
  statuses: readonly ConciergeOnboardingStepStatus[],
): Exclude<ConciergeOnboardingStatus, 'canceled'> {
  const done = statuses.filter(isStepDone).length;
  if (done === 0) return 'not_started';
  if (done === statuses.length) return 'completed';
  return 'in_progress';
}

/** Project a step row into the wire record (title/description from template). */
function toStepRecord(row: ConciergeOnboardingStepRow): ConciergeOnboardingStepRecord {
  const template = STEP_TEMPLATE_BY_KEY.get(row.stepKey);
  return {
    stepKey: row.stepKey,
    sortPosition: row.sortPosition,
    // The enum is template-complete, so `template` is always defined; the
    // `stepKey` fallback keeps the projection total + satisfies the contract's
    // non-empty title/description in the impossible missing-template case.
    title: template?.title ?? row.stepKey,
    description: template?.description ?? row.stepKey,
    status: row.status,
    notes: row.notes,
    completedAt: row.completedAt === null ? null : row.completedAt.toISOString(),
    completedByUserId: row.completedByUserId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Project an onboarding row into the summary wire record. */
function toSummaryRecord(
  row: ConciergeOnboardingRow,
  stepsTotal: number,
  stepsCompleted: number,
): ConciergeOnboardingRecord {
  return {
    id: row.id,
    householdId: row.householdId,
    status: row.status,
    kickoffScheduledAt:
      row.kickoffScheduledAt === null ? null : row.kickoffScheduledAt.toISOString(),
    notes: row.notes,
    startedByUserId: row.startedByUserId,
    stepsTotal,
    stepsCompleted,
    completedAt: row.completedAt === null ? null : row.completedAt.toISOString(),
    canceledAt: row.canceledAt === null ? null : row.canceledAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Project an onboarding row + its steps into the detail wire record. */
function toDetailRecord(
  row: ConciergeOnboardingRow,
  stepRows: readonly ConciergeOnboardingStepRow[],
): ConciergeOnboardingDetailRecord {
  const stepsTotal = stepRows.length;
  const stepsCompleted = stepRows.filter((step) => isStepDone(step.status)).length;
  return {
    ...toSummaryRecord(row, stepsTotal, stepsCompleted),
    steps: stepRows.map(toStepRecord),
  };
}

/**
 * Narrow an unknown thrown value to a Prisma unique-constraint violation
 * (`P2002`) without importing `Prisma.PrismaClientKnownRequestError`
 * (TS-021-followup-2 — the instanceof check resolves inconsistently under our
 * tsconfig, so we duck-type the `code` property).
 */
function isUniqueViolation(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as { code?: unknown }).code === PRISMA_UNIQUE_VIOLATION
  );
}
