import { describe, expect, it } from 'vitest';

import {
  evaluateRetakePolicy,
  type PriorAttemptsSummary,
  type RetakePolicy,
} from './quiz-retake-policy';

const NOW = new Date('2026-06-08T12:00:00.000Z');

function prior(overrides: Partial<PriorAttemptsSummary> = {}): PriorAttemptsSummary {
  return { totalCount: 0, hasInProgress: false, lastSubmittedAt: null, ...overrides };
}

const UNLIMITED: RetakePolicy = { maxAttempts: null, retakeCooldownMinutes: null };

describe('evaluateRetakePolicy', () => {
  it('allows a first attempt (attemptNumber 1) with an unlimited policy', () => {
    const decision = evaluateRetakePolicy(UNLIMITED, prior(), NOW);
    expect(decision).toEqual({ ok: true, attemptNumber: 1 });
  });

  it('numbers the next attempt from the total count', () => {
    const decision = evaluateRetakePolicy(UNLIMITED, prior({ totalCount: 4 }), NOW);
    expect(decision).toEqual({ ok: true, attemptNumber: 5 });
  });

  it('rejects when an attempt is already in progress (highest precedence)', () => {
    const decision = evaluateRetakePolicy(
      { maxAttempts: 1, retakeCooldownMinutes: 60 },
      prior({ totalCount: 5, hasInProgress: true, lastSubmittedAt: NOW }),
      NOW,
    );
    expect(decision).toEqual({ ok: false, reason: 'attempt_in_progress' });
  });

  it('rejects at the max-attempts cap', () => {
    const decision = evaluateRetakePolicy(
      { maxAttempts: 3, retakeCooldownMinutes: null },
      prior({ totalCount: 3 }),
      NOW,
    );
    expect(decision).toEqual({ ok: false, reason: 'max_attempts_reached' });
  });

  it('allows the last attempt under the cap', () => {
    const decision = evaluateRetakePolicy(
      { maxAttempts: 3, retakeCooldownMinutes: null },
      prior({ totalCount: 2 }),
      NOW,
    );
    expect(decision).toEqual({ ok: true, attemptNumber: 3 });
  });

  it('rejects while the cooldown is active, carrying the retryAfter instant', () => {
    const lastSubmittedAt = new Date('2026-06-08T11:30:00.000Z'); // 30m ago
    const decision = evaluateRetakePolicy(
      { maxAttempts: null, retakeCooldownMinutes: 60 },
      prior({ totalCount: 1, lastSubmittedAt }),
      NOW,
    );
    expect(decision).toEqual({
      ok: false,
      reason: 'cooldown_active',
      retryAfter: new Date('2026-06-08T12:30:00.000Z'),
    });
  });

  it('allows once the cooldown has elapsed (boundary is inclusive)', () => {
    const lastSubmittedAt = new Date('2026-06-08T11:00:00.000Z'); // exactly 60m ago
    const decision = evaluateRetakePolicy(
      { maxAttempts: null, retakeCooldownMinutes: 60 },
      prior({ totalCount: 1, lastSubmittedAt }),
      NOW,
    );
    expect(decision).toEqual({ ok: true, attemptNumber: 2 });
  });

  it('ignores the cooldown when there is no prior submitted attempt', () => {
    const decision = evaluateRetakePolicy(
      { maxAttempts: null, retakeCooldownMinutes: 60 },
      prior({ totalCount: 0, lastSubmittedAt: null }),
      NOW,
    );
    expect(decision).toEqual({ ok: true, attemptNumber: 1 });
  });

  it('checks the cap before the cooldown', () => {
    const decision = evaluateRetakePolicy(
      { maxAttempts: 2, retakeCooldownMinutes: 60 },
      prior({ totalCount: 2, lastSubmittedAt: NOW }),
      NOW,
    );
    expect(decision).toEqual({ ok: false, reason: 'max_attempts_reached' });
  });
});
