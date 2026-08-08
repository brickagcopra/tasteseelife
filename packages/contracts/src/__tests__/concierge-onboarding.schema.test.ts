import { describe, expect, it } from 'vitest';

import {
  CONCIERGE_ONBOARDING_NOTES_MAX_LENGTH,
  CONCIERGE_ONBOARDING_STEP_COUNT,
  CONCIERGE_ONBOARDING_STEP_NOTES_MAX_LENGTH,
  CONCIERGE_ONBOARDING_STEP_TEMPLATE,
  CONCIERGE_ONBOARDING_TERMINAL_STATUSES,
  CONCIERGE_ONBOARDINGS_LIST_LIMIT_DEFAULT,
  CONCIERGE_ONBOARDINGS_LIST_LIMIT_MAX,
  ConciergeOnboardingDetailRecordSchema,
  ConciergeOnboardingRecordSchema,
  ConciergeOnboardingStatusSchema,
  ConciergeOnboardingStepKeySchema,
  ConciergeOnboardingStepRecordSchema,
  ConciergeOnboardingStepStatusSchema,
  ConciergeOnboardingsListResponseSchema,
  CreateConciergeOnboardingRequestSchema,
  ListConciergeOnboardingsQuerySchema,
  MyConciergeOnboardingResponseSchema,
  UpdateConciergeOnboardingRequestSchema,
  UpdateConciergeOnboardingStepRequestSchema,
  isConciergeOnboardingTerminal,
} from '../http/concierge-onboarding.schema';

const NOW = '2026-05-26T15:00:00.000Z';

function validStep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stepKey: 'welcome_kickoff_call',
    sortPosition: 0,
    title: 'Welcome & 30-minute concierge kickoff call',
    description: 'Schedule and hold the white-glove kickoff call.',
    status: 'pending',
    notes: null,
    completedAt: null,
    completedByUserId: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'onb_1',
    householdId: 'hh_1',
    status: 'in_progress',
    kickoffScheduledAt: NOW,
    notes: null,
    startedByUserId: 'user_ops',
    stepsTotal: 6,
    stepsCompleted: 2,
    completedAt: null,
    canceledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('ConciergeOnboardingStatusSchema', () => {
  it('accepts the four rollup statuses', () => {
    for (const status of ['not_started', 'in_progress', 'completed', 'canceled']) {
      expect(ConciergeOnboardingStatusSchema.parse(status)).toBe(status);
    }
  });

  it('rejects an unknown status', () => {
    expect(ConciergeOnboardingStatusSchema.safeParse('paused').success).toBe(false);
  });
});

describe('ConciergeOnboardingStepKeySchema', () => {
  it('accepts the six template step keys', () => {
    for (const step of CONCIERGE_ONBOARDING_STEP_TEMPLATE) {
      expect(ConciergeOnboardingStepKeySchema.parse(step.key)).toBe(step.key);
    }
  });

  it('rejects an unknown step key', () => {
    expect(ConciergeOnboardingStepKeySchema.safeParse('order_groceries').success).toBe(false);
  });
});

describe('ConciergeOnboardingStepStatusSchema', () => {
  it('accepts pending / completed / skipped', () => {
    for (const status of ['pending', 'completed', 'skipped']) {
      expect(ConciergeOnboardingStepStatusSchema.parse(status)).toBe(status);
    }
  });
});

describe('CONCIERGE_ONBOARDING_STEP_TEMPLATE', () => {
  it('has six steps with the expected ordered keys', () => {
    expect(CONCIERGE_ONBOARDING_STEP_COUNT).toBe(6);
    expect(CONCIERGE_ONBOARDING_STEP_TEMPLATE.map((s) => s.key)).toEqual([
      'welcome_kickoff_call',
      'senior_preference_deep_dive',
      'family_expectation_setting',
      'assign_dedicated_concierge',
      'schedule_first_chef_visit',
      'confirm_household_access',
    ]);
  });

  it('has strictly-increasing sort positions starting at 0', () => {
    CONCIERGE_ONBOARDING_STEP_TEMPLATE.forEach((step, index) => {
      expect(step.sortPosition).toBe(index);
    });
  });

  it('carries a non-empty title + description for every step', () => {
    for (const step of CONCIERGE_ONBOARDING_STEP_TEMPLATE) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.description.length).toBeGreaterThan(0);
    }
  });
});

describe('isConciergeOnboardingTerminal', () => {
  it('treats only canceled as terminal', () => {
    expect(CONCIERGE_ONBOARDING_TERMINAL_STATUSES).toEqual(['canceled']);
    expect(isConciergeOnboardingTerminal('canceled')).toBe(true);
    expect(isConciergeOnboardingTerminal('completed')).toBe(false);
    expect(isConciergeOnboardingTerminal('in_progress')).toBe(false);
    expect(isConciergeOnboardingTerminal('not_started')).toBe(false);
  });
});

describe('ConciergeOnboardingStepRecordSchema', () => {
  it('accepts a valid step', () => {
    expect(ConciergeOnboardingStepRecordSchema.safeParse(validStep()).success).toBe(true);
  });

  it('accepts a completed step with completedAt + completedByUserId set', () => {
    const result = ConciergeOnboardingStepRecordSchema.safeParse(
      validStep({
        status: 'completed',
        completedAt: NOW,
        completedByUserId: 'user_ops',
        notes: 'Done.',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects an unknown field (strict)', () => {
    expect(ConciergeOnboardingStepRecordSchema.safeParse(validStep({ extra: 1 })).success).toBe(
      false,
    );
  });

  it('rejects step notes over the cap', () => {
    const tooLong = 'x'.repeat(CONCIERGE_ONBOARDING_STEP_NOTES_MAX_LENGTH + 1);
    expect(
      ConciergeOnboardingStepRecordSchema.safeParse(validStep({ notes: tooLong })).success,
    ).toBe(false);
  });
});

describe('ConciergeOnboardingRecordSchema', () => {
  it('accepts a valid summary record', () => {
    expect(ConciergeOnboardingRecordSchema.safeParse(validRecord()).success).toBe(true);
  });

  it('accepts a completed onboarding with completedAt set', () => {
    expect(
      ConciergeOnboardingRecordSchema.safeParse(
        validRecord({ status: 'completed', stepsCompleted: 6, completedAt: NOW }),
      ).success,
    ).toBe(true);
  });

  it('accepts null kickoffScheduledAt / notes / startedByUserId', () => {
    expect(
      ConciergeOnboardingRecordSchema.safeParse(
        validRecord({ kickoffScheduledAt: null, notes: null, startedByUserId: null }),
      ).success,
    ).toBe(true);
  });

  it('rejects an unknown field (strict)', () => {
    expect(ConciergeOnboardingRecordSchema.safeParse(validRecord({ tier: 3 })).success).toBe(false);
  });

  it('rejects a negative stepsCompleted', () => {
    expect(
      ConciergeOnboardingRecordSchema.safeParse(validRecord({ stepsCompleted: -1 })).success,
    ).toBe(false);
  });
});

describe('ConciergeOnboardingDetailRecordSchema', () => {
  it('accepts a record with a steps array', () => {
    const result = ConciergeOnboardingDetailRecordSchema.safeParse({
      ...validRecord(),
      steps: [validStep(), validStep({ stepKey: 'family_expectation_setting', sortPosition: 2 })],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a detail record missing the steps array', () => {
    expect(ConciergeOnboardingDetailRecordSchema.safeParse(validRecord()).success).toBe(false);
  });
});

describe('CreateConciergeOnboardingRequestSchema', () => {
  it('accepts a bare householdId', () => {
    expect(CreateConciergeOnboardingRequestSchema.safeParse({ householdId: 'hh_1' }).success).toBe(
      true,
    );
  });

  it('accepts an optional kickoffScheduledAt + notes', () => {
    expect(
      CreateConciergeOnboardingRequestSchema.safeParse({
        householdId: 'hh_1',
        kickoffScheduledAt: NOW,
        notes: 'Family prefers evening calls.',
      }).success,
    ).toBe(true);
  });

  it('requires householdId', () => {
    expect(CreateConciergeOnboardingRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an unknown field (strict)', () => {
    expect(
      CreateConciergeOnboardingRequestSchema.safeParse({ householdId: 'hh_1', steps: [] }).success,
    ).toBe(false);
  });

  it('rejects notes over the cap', () => {
    const tooLong = 'x'.repeat(CONCIERGE_ONBOARDING_NOTES_MAX_LENGTH + 1);
    expect(
      CreateConciergeOnboardingRequestSchema.safeParse({ householdId: 'hh_1', notes: tooLong })
        .success,
    ).toBe(false);
  });
});

describe('UpdateConciergeOnboardingRequestSchema', () => {
  it('accepts a notes clear (null)', () => {
    expect(UpdateConciergeOnboardingRequestSchema.safeParse({ notes: null }).success).toBe(true);
  });

  it('accepts a kickoffScheduledAt update', () => {
    expect(
      UpdateConciergeOnboardingRequestSchema.safeParse({ kickoffScheduledAt: NOW }).success,
    ).toBe(true);
  });

  it('accepts status=canceled', () => {
    expect(UpdateConciergeOnboardingRequestSchema.safeParse({ status: 'canceled' }).success).toBe(
      true,
    );
  });

  it('rejects status=completed (derived, never set directly)', () => {
    expect(UpdateConciergeOnboardingRequestSchema.safeParse({ status: 'completed' }).success).toBe(
      false,
    );
  });

  it('rejects an empty body', () => {
    expect(UpdateConciergeOnboardingRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an unknown field (strict)', () => {
    expect(UpdateConciergeOnboardingRequestSchema.safeParse({ tier: 3 }).success).toBe(false);
  });
});

describe('UpdateConciergeOnboardingStepRequestSchema', () => {
  it('accepts a status update', () => {
    expect(
      UpdateConciergeOnboardingStepRequestSchema.safeParse({ status: 'completed' }).success,
    ).toBe(true);
  });

  it('accepts a status + notes update', () => {
    expect(
      UpdateConciergeOnboardingStepRequestSchema.safeParse({ status: 'skipped', notes: 'N/A' })
        .success,
    ).toBe(true);
  });

  it('accepts a notes clear (null)', () => {
    expect(
      UpdateConciergeOnboardingStepRequestSchema.safeParse({ status: 'pending', notes: null })
        .success,
    ).toBe(true);
  });

  it('requires status', () => {
    expect(UpdateConciergeOnboardingStepRequestSchema.safeParse({ notes: 'x' }).success).toBe(
      false,
    );
  });
});

describe('ListConciergeOnboardingsQuerySchema', () => {
  it('defaults the limit', () => {
    const result = ListConciergeOnboardingsQuerySchema.parse({});
    expect(result.limit).toBe(CONCIERGE_ONBOARDINGS_LIST_LIMIT_DEFAULT);
  });

  it('coerces a string limit', () => {
    expect(ListConciergeOnboardingsQuerySchema.parse({ limit: '10' }).limit).toBe(10);
  });

  it('rejects a limit over the cap', () => {
    expect(
      ListConciergeOnboardingsQuerySchema.safeParse({
        limit: CONCIERGE_ONBOARDINGS_LIST_LIMIT_MAX + 1,
      }).success,
    ).toBe(false);
  });

  it('accepts householdId + status filters', () => {
    expect(
      ListConciergeOnboardingsQuerySchema.safeParse({ householdId: 'hh_1', status: 'in_progress' })
        .success,
    ).toBe(true);
  });
});

describe('ConciergeOnboardingsListResponseSchema', () => {
  it('accepts a list of summary records', () => {
    expect(
      ConciergeOnboardingsListResponseSchema.safeParse({ onboardings: [validRecord()] }).success,
    ).toBe(true);
  });
});

describe('MyConciergeOnboardingResponseSchema', () => {
  it('accepts a null onboarding (no onboarding for the household)', () => {
    expect(
      MyConciergeOnboardingResponseSchema.safeParse({ householdId: 'hh_1', onboarding: null })
        .success,
    ).toBe(true);
  });

  it('accepts a populated onboarding detail', () => {
    expect(
      MyConciergeOnboardingResponseSchema.safeParse({
        householdId: 'hh_1',
        onboarding: { ...validRecord(), steps: [validStep()] },
      }).success,
    ).toBe(true);
  });
});
