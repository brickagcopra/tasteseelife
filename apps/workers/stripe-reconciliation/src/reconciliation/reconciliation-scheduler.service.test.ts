import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../config/env';

import type { ReconciliationOrchestratorService } from './reconciliation-orchestrator.service';
import { ReconciliationScheduler } from './reconciliation-scheduler.service';

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3054,
    LOG_LEVEL: 'info',
    SERVICE_VERSION: 'test',
    // Required on `Env` because `.default(true)` makes the OUTPUT type
    // required even though the input is optional (TS-504-followup-2a-2).
    OTEL_TRACES_ENABLED: true,
    OTEL_METRICS_ENABLED: true,
    ACCOUNTING_SERVICE_BASE_URL: 'http://service-accounting:3015',
    STRIPE_RECONCILIATION_INTERNAL_API_KEY: 'k'.repeat(32),
    STRIPE_RECONCILIATION_INTERNAL_HEADER_NAME: 'x-accounting-internal-api-key',
    REQUEST_TIMEOUT_MS: 30_000,
    STRIPE_RECONCILIATION_ENABLED: true,
    STRIPE_RECONCILIATION_RUN_HOUR_UTC: 3,
    STRIPE_RECONCILIATION_SCHEDULER_TICK_MS: 3_600_000,
    ...overrides,
  };
}

function makeOrchestrator(runForDay: ReturnType<typeof vi.fn>): ReconciliationOrchestratorService {
  return { runForDay } as unknown as ReconciliationOrchestratorService;
}

describe('ReconciliationScheduler.runIfDue', () => {
  it('is a no-op when disabled by the kill-switch', async () => {
    const runForDay = vi.fn(async () => true);
    const scheduler = new ReconciliationScheduler(
      buildEnv({ STRIPE_RECONCILIATION_ENABLED: false }),
      makeOrchestrator(runForDay),
    );
    expect(await scheduler.runIfDue(new Date('2026-05-29T04:00:00Z'))).toBe(false);
    expect(runForDay).not.toHaveBeenCalled();
  });

  it('does not run before the configured hour', async () => {
    const runForDay = vi.fn(async () => true);
    const scheduler = new ReconciliationScheduler(buildEnv(), makeOrchestrator(runForDay));
    expect(await scheduler.runIfDue(new Date('2026-05-29T02:00:00Z'))).toBe(false);
    expect(runForDay).not.toHaveBeenCalled();
  });

  it('runs once when due and forwards the UTC day key', async () => {
    const runForDay = vi.fn(async () => true);
    const scheduler = new ReconciliationScheduler(buildEnv(), makeOrchestrator(runForDay));
    expect(await scheduler.runIfDue(new Date('2026-05-29T03:30:00Z'))).toBe(true);
    expect(runForDay).toHaveBeenCalledWith('2026-05-29');
  });

  it('does not re-run the same day after it has fired', async () => {
    const runForDay = vi.fn(async () => true);
    const scheduler = new ReconciliationScheduler(buildEnv(), makeOrchestrator(runForDay));
    await scheduler.runIfDue(new Date('2026-05-29T03:30:00Z'));
    expect(await scheduler.runIfDue(new Date('2026-05-29T06:00:00Z'))).toBe(false);
    expect(runForDay).toHaveBeenCalledTimes(1);
  });

  it('runs again on the next UTC day', async () => {
    const runForDay = vi.fn(async () => true);
    const scheduler = new ReconciliationScheduler(buildEnv(), makeOrchestrator(runForDay));
    await scheduler.runIfDue(new Date('2026-05-29T03:30:00Z'));
    expect(await scheduler.runIfDue(new Date('2026-05-30T03:30:00Z'))).toBe(true);
    expect(runForDay).toHaveBeenCalledTimes(2);
    expect(runForDay).toHaveBeenLastCalledWith('2026-05-30');
  });
});
