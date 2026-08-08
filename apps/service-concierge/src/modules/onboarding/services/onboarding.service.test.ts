import { beforeEach, describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import { OnboardingService, deriveOnboardingStatus } from './onboarding.service';

/**
 * Unit tests for `OnboardingService` (TS-228).
 *
 * `FakePrisma` is an in-memory store implementing the narrow
 * `conciergeOnboarding` (create-with-nested-steps / findMany / findFirst /
 * update) + `conciergeOnboardingStep` (findMany / findFirst / update) +
 * `$transaction` surface the service consumes. The partial-unique single-active
 * constraint is modelled by throwing a P2002-shaped error from `create`. The
 * real FK / cascade / transactional guarantees are covered by the
 * Testcontainers integration test (followup); this suite pins the service's
 * branching + rollup-derivation logic.
 */

interface OnboardingSeed {
  id: string;
  householdId: string;
  status: 'not_started' | 'in_progress' | 'completed' | 'canceled';
  kickoffScheduledAt: Date | null;
  notes: string | null;
  startedByUserId: string | null;
  completedAt: Date | null;
  canceledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

interface StepSeed {
  id: string;
  onboardingId: string;
  householdId: string;
  stepKey: string;
  status: 'pending' | 'completed' | 'skipped';
  sortPosition: number;
  notes: string | null;
  completedAt: Date | null;
  completedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const BASE = new Date('2026-05-26T15:00:00.000Z');

class P2002Error extends Error {
  public readonly code = 'P2002';
}

let idCounter = 0;

class FakePrisma {
  public onboardings: OnboardingSeed[] = [];
  public steps: StepSeed[] = [];

  public get conciergeOnboarding() {
    return {
      create: async (args: { data: Record<string, unknown>; select?: unknown }) => {
        const d = args.data;
        const householdId = String(d['householdId']);
        // Model the partial unique index: at most one non-deleted row / household.
        if (this.onboardings.some((o) => o.householdId === householdId && o.deletedAt === null)) {
          throw new P2002Error('unique violation');
        }
        idCounter += 1;
        const id = `onb_${idCounter}`;
        this.onboardings.push({
          id,
          householdId,
          status: (d['status'] as OnboardingSeed['status']) ?? 'not_started',
          kickoffScheduledAt: (d['kickoffScheduledAt'] as Date | null) ?? null,
          notes: (d['notes'] as string | null) ?? null,
          startedByUserId: (d['startedByUserId'] as string | null) ?? null,
          completedAt: null,
          canceledAt: null,
          createdAt: BASE,
          updatedAt: BASE,
          deletedAt: null,
        });
        const nested = d['steps'] as { create?: Record<string, unknown>[] } | undefined;
        for (const step of nested?.create ?? []) {
          idCounter += 1;
          this.steps.push({
            id: `stp_${idCounter}`,
            onboardingId: id,
            householdId: String(step['householdId']),
            stepKey: String(step['stepKey']),
            status: (step['status'] as StepSeed['status']) ?? 'pending',
            sortPosition: Number(step['sortPosition']),
            notes: null,
            completedAt: null,
            completedByUserId: null,
            createdAt: BASE,
            updatedAt: BASE,
          });
        }
        return { id };
      },
      findFirst: async (args: { where: Record<string, unknown>; select?: unknown }) => {
        const match = this.onboardings.find((o) => onboardingMatches(o, args.where));
        return match ?? null;
      },
      findMany: async (args: {
        where: Record<string, unknown>;
        orderBy?: unknown;
        take?: number;
      }) => {
        let result = this.onboardings.filter((o) => onboardingMatches(o, args.where));
        result = [...result].sort((a, b) => b.id.localeCompare(a.id)); // createdAt desc ~ id desc
        if (typeof args.take === 'number') result = result.slice(0, args.take);
        return result;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = this.onboardings.find((o) => o.id === args.where.id);
        if (row === undefined) throw new Error(`onboarding ${args.where.id} not found`);
        Object.assign(row, args.data, { updatedAt: new Date('2026-05-27T00:00:00.000Z') });
        return { id: row.id };
      },
    };
  }

  public get conciergeOnboardingStep() {
    return {
      findFirst: async (args: { where: Record<string, unknown>; select?: unknown }) => {
        const match = this.steps.find((s) => stepMatches(s, args.where));
        return match ?? null;
      },
      findMany: async (args: {
        where: Record<string, unknown>;
        orderBy?: unknown;
        select?: unknown;
      }) => {
        let result = this.steps.filter((s) => stepMatches(s, args.where));
        result = [...result].sort((a, b) => a.sortPosition - b.sortPosition);
        return result;
      },
      update: async (args: {
        where: { onboardingId_stepKey: { onboardingId: string; stepKey: string } };
        data: Record<string, unknown>;
      }) => {
        const { onboardingId, stepKey } = args.where.onboardingId_stepKey;
        const row = this.steps.find(
          (s) => s.onboardingId === onboardingId && s.stepKey === stepKey,
        );
        if (row === undefined) throw new Error(`step ${stepKey} not found`);
        Object.assign(row, args.data, { updatedAt: new Date('2026-05-27T00:00:00.000Z') });
        return { stepKey: row.stepKey };
      },
    };
  }

  public async $transaction<T>(fn: (tx: FakePrisma) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

function onboardingMatches(o: OnboardingSeed, where: Record<string, unknown>): boolean {
  if ('id' in where && o.id !== where['id']) return false;
  if ('householdId' in where && o.householdId !== where['householdId']) return false;
  if ('status' in where && o.status !== where['status']) return false;
  if ('deletedAt' in where && where['deletedAt'] === null && o.deletedAt !== null) return false;
  return true;
}

function stepMatches(s: StepSeed, where: Record<string, unknown>): boolean {
  if ('stepKey' in where && s.stepKey !== where['stepKey']) return false;
  const onboardingId = where['onboardingId'];
  if (onboardingId !== undefined) {
    if (typeof onboardingId === 'object' && onboardingId !== null && 'in' in onboardingId) {
      const ids = (onboardingId as { in: string[] }).in;
      if (!ids.includes(s.onboardingId)) return false;
    } else if (s.onboardingId !== onboardingId) {
      return false;
    }
  }
  return true;
}

function makeService(): { service: OnboardingService; prisma: FakePrisma } {
  const prisma = new FakePrisma();
  const service = new OnboardingService(prisma as unknown as PrismaService);
  return { service, prisma };
}

beforeEach(() => {
  idCounter = 0;
});

describe('deriveOnboardingStatus', () => {
  it('is not_started when no step is done', () => {
    expect(deriveOnboardingStatus(['pending', 'pending', 'pending'])).toBe('not_started');
  });

  it('is in_progress when some but not all steps are done', () => {
    expect(deriveOnboardingStatus(['completed', 'pending', 'pending'])).toBe('in_progress');
  });

  it('counts skipped steps toward done', () => {
    expect(deriveOnboardingStatus(['skipped', 'pending'])).toBe('in_progress');
  });

  it('is completed when every step is completed or skipped', () => {
    expect(deriveOnboardingStatus(['completed', 'skipped', 'completed'])).toBe('completed');
  });

  it('is not_started for an empty step list', () => {
    expect(deriveOnboardingStatus([])).toBe('not_started');
  });
});

describe('OnboardingService.createOnboarding', () => {
  it('seeds the six template steps as pending and starts not_started', async () => {
    const { service } = makeService();
    const outcome = await service.createOnboarding({
      householdId: 'hh_1',
      actorUserId: 'user_ops',
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.onboarding.status).toBe('not_started');
    expect(outcome.onboarding.steps).toHaveLength(6);
    expect(outcome.onboarding.steps.every((s) => s.status === 'pending')).toBe(true);
    expect(outcome.onboarding.steps[0]?.stepKey).toBe('welcome_kickoff_call');
    expect(outcome.onboarding.steps[0]?.title.length).toBeGreaterThan(0);
    expect(outcome.onboarding.stepsTotal).toBe(6);
    expect(outcome.onboarding.stepsCompleted).toBe(0);
    expect(outcome.onboarding.startedByUserId).toBe('user_ops');
  });

  it('persists an optional kickoff time + notes', async () => {
    const { service } = makeService();
    const outcome = await service.createOnboarding({
      householdId: 'hh_1',
      kickoffScheduledAt: '2026-06-01T18:00:00.000Z',
      notes: 'Evening calls preferred.',
      actorUserId: 'user_ops',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.onboarding.kickoffScheduledAt).toBe('2026-06-01T18:00:00.000Z');
    expect(outcome.onboarding.notes).toBe('Evening calls preferred.');
  });

  it('rejects a second active onboarding for the same household (already_exists)', async () => {
    const { service } = makeService();
    await service.createOnboarding({ householdId: 'hh_1', actorUserId: 'user_ops' });
    const second = await service.createOnboarding({ householdId: 'hh_1', actorUserId: 'user_ops' });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('already_exists');
  });
});

describe('OnboardingService.listOnboardings', () => {
  it('returns summaries with derived step counts', async () => {
    const { service } = makeService();
    const created = await service.createOnboarding({
      householdId: 'hh_1',
      actorUserId: 'user_ops',
    });
    if (!created.ok) throw new Error('setup failed');
    await service.updateStep({
      onboardingId: created.onboarding.id,
      stepKey: 'welcome_kickoff_call',
      status: 'completed',
      actorUserId: 'user_ops',
    });

    const list = await service.listOnboardings({ limit: 50 });
    expect(list).toHaveLength(1);
    expect(list[0]?.stepsTotal).toBe(6);
    expect(list[0]?.stepsCompleted).toBe(1);
    expect(list[0]?.status).toBe('in_progress');
  });

  it('filters by householdId', async () => {
    const { service } = makeService();
    await service.createOnboarding({ householdId: 'hh_1', actorUserId: 'user_ops' });
    await service.createOnboarding({ householdId: 'hh_2', actorUserId: 'user_ops' });

    const list = await service.listOnboardings({ householdId: 'hh_2', limit: 50 });
    expect(list).toHaveLength(1);
    expect(list[0]?.householdId).toBe('hh_2');
  });

  it('filters by status', async () => {
    const { service } = makeService();
    await service.createOnboarding({ householdId: 'hh_1', actorUserId: 'user_ops' });

    expect(await service.listOnboardings({ status: 'completed', limit: 50 })).toHaveLength(0);
    expect(await service.listOnboardings({ status: 'not_started', limit: 50 })).toHaveLength(1);
  });

  it('returns an empty list when nothing matches', async () => {
    const { service } = makeService();
    expect(await service.listOnboardings({ limit: 50 })).toEqual([]);
  });
});

describe('OnboardingService.getOnboarding / getOnboardingForHousehold', () => {
  it('returns the detail for a known id', async () => {
    const { service } = makeService();
    const created = await service.createOnboarding({
      householdId: 'hh_1',
      actorUserId: 'user_ops',
    });
    if (!created.ok) throw new Error('setup failed');

    const detail = await service.getOnboarding(created.onboarding.id);
    expect(detail?.id).toBe(created.onboarding.id);
    expect(detail?.steps).toHaveLength(6);
  });

  it('returns null for an unknown id', async () => {
    const { service } = makeService();
    expect(await service.getOnboarding('onb_missing')).toBeNull();
  });

  it('resolves the household onboarding for the family read', async () => {
    const { service } = makeService();
    await service.createOnboarding({ householdId: 'hh_42', actorUserId: 'user_ops' });
    const detail = await service.getOnboardingForHousehold('hh_42');
    expect(detail?.householdId).toBe('hh_42');
  });

  it('returns null when the household has no onboarding', async () => {
    const { service } = makeService();
    expect(await service.getOnboardingForHousehold('hh_none')).toBeNull();
  });
});

describe('OnboardingService.updateOnboarding', () => {
  it('updates the kickoff time without changing the derived status', async () => {
    const { service } = makeService();
    const created = await service.createOnboarding({
      householdId: 'hh_1',
      actorUserId: 'user_ops',
    });
    if (!created.ok) throw new Error('setup failed');

    const outcome = await service.updateOnboarding({
      onboardingId: created.onboarding.id,
      kickoffScheduledAt: '2026-06-02T17:00:00.000Z',
      cancel: false,
      actorUserId: 'user_ops',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.onboarding.kickoffScheduledAt).toBe('2026-06-02T17:00:00.000Z');
    expect(outcome.onboarding.status).toBe('not_started');
  });

  it('clears the notes when passed null', async () => {
    const { service } = makeService();
    const created = await service.createOnboarding({
      householdId: 'hh_1',
      notes: 'initial',
      actorUserId: 'user_ops',
    });
    if (!created.ok) throw new Error('setup failed');

    const outcome = await service.updateOnboarding({
      onboardingId: created.onboarding.id,
      notes: null,
      cancel: false,
      actorUserId: 'user_ops',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.onboarding.notes).toBeNull();
  });

  it('cancels the onboarding (sets canceled + canceledAt)', async () => {
    const { service } = makeService();
    const created = await service.createOnboarding({
      householdId: 'hh_1',
      actorUserId: 'user_ops',
    });
    if (!created.ok) throw new Error('setup failed');

    const outcome = await service.updateOnboarding({
      onboardingId: created.onboarding.id,
      cancel: true,
      actorUserId: 'user_ops',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.onboarding.status).toBe('canceled');
    expect(outcome.onboarding.canceledAt).not.toBeNull();
  });

  it('returns not_found for an unknown id', async () => {
    const { service } = makeService();
    const outcome = await service.updateOnboarding({
      onboardingId: 'onb_missing',
      cancel: true,
      actorUserId: 'user_ops',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('not_found');
  });

  it('rejects edits to a canceled onboarding (terminal)', async () => {
    const { service } = makeService();
    const created = await service.createOnboarding({
      householdId: 'hh_1',
      actorUserId: 'user_ops',
    });
    if (!created.ok) throw new Error('setup failed');
    await service.updateOnboarding({
      onboardingId: created.onboarding.id,
      cancel: true,
      actorUserId: 'user_ops',
    });

    const outcome = await service.updateOnboarding({
      onboardingId: created.onboarding.id,
      notes: 'too late',
      cancel: false,
      actorUserId: 'user_ops',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('terminal');
  });
});

describe('OnboardingService.updateStep', () => {
  it('completes a step (stamps completedAt + completedByUserId) and rolls up to in_progress', async () => {
    const { service } = makeService();
    const created = await service.createOnboarding({
      householdId: 'hh_1',
      actorUserId: 'user_ops',
    });
    if (!created.ok) throw new Error('setup failed');

    const outcome = await service.updateStep({
      onboardingId: created.onboarding.id,
      stepKey: 'welcome_kickoff_call',
      status: 'completed',
      notes: 'Held the call.',
      actorUserId: 'user_concierge',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.onboarding.status).toBe('in_progress');
    const step = outcome.onboarding.steps.find((s) => s.stepKey === 'welcome_kickoff_call');
    expect(step?.status).toBe('completed');
    expect(step?.completedAt).not.toBeNull();
    expect(step?.completedByUserId).toBe('user_concierge');
    expect(step?.notes).toBe('Held the call.');
    expect(outcome.onboarding.stepsCompleted).toBe(1);
  });

  it('rolls up to completed + stamps onboarding.completedAt when every step is done', async () => {
    const { service } = makeService();
    const created = await service.createOnboarding({
      householdId: 'hh_1',
      actorUserId: 'user_ops',
    });
    if (!created.ok) throw new Error('setup failed');

    const stepKeys = created.onboarding.steps.map((s) => s.stepKey);
    let last;
    for (const stepKey of stepKeys) {
      last = await service.updateStep({
        onboardingId: created.onboarding.id,
        stepKey,
        status: 'completed',
        actorUserId: 'user_concierge',
      });
    }
    expect(last?.ok).toBe(true);
    if (!last?.ok) return;
    expect(last.onboarding.status).toBe('completed');
    expect(last.onboarding.completedAt).not.toBeNull();
    expect(last.onboarding.stepsCompleted).toBe(6);
  });

  it('reverts to in_progress + clears onboarding.completedAt when a completed step is re-opened', async () => {
    const { service } = makeService();
    const created = await service.createOnboarding({
      householdId: 'hh_1',
      actorUserId: 'user_ops',
    });
    if (!created.ok) throw new Error('setup failed');
    for (const step of created.onboarding.steps) {
      await service.updateStep({
        onboardingId: created.onboarding.id,
        stepKey: step.stepKey,
        status: 'completed',
        actorUserId: 'user_concierge',
      });
    }

    const reopened = await service.updateStep({
      onboardingId: created.onboarding.id,
      stepKey: 'schedule_first_chef_visit',
      status: 'pending',
      actorUserId: 'user_concierge',
    });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.onboarding.status).toBe('in_progress');
    expect(reopened.onboarding.completedAt).toBeNull();
    const step = reopened.onboarding.steps.find((s) => s.stepKey === 'schedule_first_chef_visit');
    expect(step?.completedAt).toBeNull();
    expect(step?.completedByUserId).toBeNull();
  });

  it('treats a skipped step as done for the rollup', async () => {
    const { service } = makeService();
    const created = await service.createOnboarding({
      householdId: 'hh_1',
      actorUserId: 'user_ops',
    });
    if (!created.ok) throw new Error('setup failed');

    const outcome = await service.updateStep({
      onboardingId: created.onboarding.id,
      stepKey: 'schedule_first_chef_visit',
      status: 'skipped',
      actorUserId: 'user_concierge',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.onboarding.status).toBe('in_progress');
    expect(outcome.onboarding.stepsCompleted).toBe(1);
  });

  it('returns not_found for an unknown onboarding', async () => {
    const { service } = makeService();
    const outcome = await service.updateStep({
      onboardingId: 'onb_missing',
      stepKey: 'welcome_kickoff_call',
      status: 'completed',
      actorUserId: 'user_ops',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('not_found');
  });

  it('rejects a step edit on a canceled onboarding (terminal)', async () => {
    const { service } = makeService();
    const created = await service.createOnboarding({
      householdId: 'hh_1',
      actorUserId: 'user_ops',
    });
    if (!created.ok) throw new Error('setup failed');
    await service.updateOnboarding({
      onboardingId: created.onboarding.id,
      cancel: true,
      actorUserId: 'user_ops',
    });

    const outcome = await service.updateStep({
      onboardingId: created.onboarding.id,
      stepKey: 'welcome_kickoff_call',
      status: 'completed',
      actorUserId: 'user_concierge',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('terminal');
  });
});
