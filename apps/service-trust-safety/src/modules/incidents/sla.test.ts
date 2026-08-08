import { describe, expect, it } from 'vitest';

import { computeSlaDueAt, SLA_BUDGET_MINUTES } from './sla';

const OPENED_AT = new Date('2026-07-02T10:00:00.000Z');

describe('SLA_BUDGET_MINUTES', () => {
  it('covers every severity with a positive budget', () => {
    expect(Object.keys(SLA_BUDGET_MINUTES).sort()).toEqual(['critical', 'high', 'low', 'medium']);
    for (const budget of Object.values(SLA_BUDGET_MINUTES)) {
      expect(budget).toBeGreaterThan(0);
    }
  });

  it('orders budgets by urgency: critical < high < medium < low', () => {
    expect(SLA_BUDGET_MINUTES.critical).toBeLessThan(SLA_BUDGET_MINUTES.high);
    expect(SLA_BUDGET_MINUTES.high).toBeLessThan(SLA_BUDGET_MINUTES.medium);
    expect(SLA_BUDGET_MINUTES.medium).toBeLessThan(SLA_BUDGET_MINUTES.low);
  });
});

describe('computeSlaDueAt', () => {
  it('critical → opened_at + 2 hours', () => {
    expect(computeSlaDueAt('critical', OPENED_AT).toISOString()).toBe('2026-07-02T12:00:00.000Z');
  });

  it('high → opened_at + 8 hours', () => {
    expect(computeSlaDueAt('high', OPENED_AT).toISOString()).toBe('2026-07-02T18:00:00.000Z');
  });

  it('medium → opened_at + 24 hours', () => {
    expect(computeSlaDueAt('medium', OPENED_AT).toISOString()).toBe('2026-07-03T10:00:00.000Z');
  });

  it('low → opened_at + 72 hours', () => {
    expect(computeSlaDueAt('low', OPENED_AT).toISOString()).toBe('2026-07-05T10:00:00.000Z');
  });

  it('does not mutate the input date', () => {
    const opened = new Date(OPENED_AT.getTime());
    computeSlaDueAt('critical', opened);
    expect(opened.getTime()).toBe(OPENED_AT.getTime());
  });

  it('preserves millisecond precision across a day boundary', () => {
    const openedLate = new Date('2026-07-02T23:59:59.999Z');
    expect(computeSlaDueAt('critical', openedLate).toISOString()).toBe('2026-07-03T01:59:59.999Z');
  });
});
