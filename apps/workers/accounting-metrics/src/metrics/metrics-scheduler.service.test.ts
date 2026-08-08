import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../config/env';
import type { MetricsOrchestratorService } from './metrics-orchestrator.service';
import { MetricsScheduler } from './metrics-scheduler.service';

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3053,
    LOG_LEVEL: 'info',
    SERVICE_VERSION: 'test',
    // Required on `Env` because `.default(true)` makes the OUTPUT type
    // required even though the input is optional (TS-504-followup-2a-2).
    OTEL_TRACES_ENABLED: true,
    OTEL_METRICS_ENABLED: true,
    ACCOUNTING_SERVICE_BASE_URL: 'http://service-accounting:3015',
    ACCOUNTING_SAAS_METRICS_INTERNAL_API_KEY: 'k'.repeat(32),
    ACCOUNTING_SAAS_METRICS_INTERNAL_HEADER_NAME: 'x-accounting-internal-api-key',
    REQUEST_TIMEOUT_MS: 30_000,
    ACCOUNTING_METRICS_ENABLED: true,
    ACCOUNTING_METRICS_RUN_HOUR_UTC: 2,
    ACCOUNTING_METRICS_SCHEDULER_TICK_MS: 3_600_000,
    ...overrides,
  };
}

function makeOrchestrator(runForDay: ReturnType<typeof vi.fn>): MetricsOrchestratorService {
  return { runForDay } as unknown as MetricsOrchestratorService;
}

describe('MetricsScheduler.runIfDue', () => {
  it('is a no-op when disabled by the kill-switch', async () => {
    const runForDay = vi.fn(async () => true);
    const scheduler = new MetricsScheduler(
      buildEnv({ ACCOUNTING_METRICS_ENABLED: false }),
      makeOrchestrator(runForDay),
    );

    const fired = await scheduler.runIfDue(new Date('2026-05-28T03:00:00Z'));

    expect(fired).toBe(false);
    expect(runForDay).not.toHaveBeenCalled();
  });

  it('does not run before the configured hour', async () => {
    const runForDay = vi.fn(async () => true);
    const scheduler = new MetricsScheduler(buildEnv(), makeOrchestrator(runForDay));

    const fired = await scheduler.runIfDue(new Date('2026-05-28T01:00:00Z'));

    expect(fired).toBe(false);
    expect(runForDay).not.toHaveBeenCalled();
  });

  it('runs once when due and forwards the UTC day key', async () => {
    const runForDay = vi.fn(async () => true);
    const scheduler = new MetricsScheduler(buildEnv(), makeOrchestrator(runForDay));

    const fired = await scheduler.runIfDue(new Date('2026-05-28T02:30:00Z'));

    expect(fired).toBe(true);
    expect(runForDay).toHaveBeenCalledWith('2026-05-28');
  });

  it('does not re-run the same day after it has fired', async () => {
    const runForDay = vi.fn(async () => true);
    const scheduler = new MetricsScheduler(buildEnv(), makeOrchestrator(runForDay));

    await scheduler.runIfDue(new Date('2026-05-28T02:30:00Z'));
    const second = await scheduler.runIfDue(new Date('2026-05-28T05:00:00Z'));

    expect(second).toBe(false);
    expect(runForDay).toHaveBeenCalledTimes(1);
  });

  it('runs again on the next UTC day', async () => {
    const runForDay = vi.fn(async () => true);
    const scheduler = new MetricsScheduler(buildEnv(), makeOrchestrator(runForDay));

    await scheduler.runIfDue(new Date('2026-05-28T02:30:00Z'));
    const next = await scheduler.runIfDue(new Date('2026-05-29T02:30:00Z'));

    expect(next).toBe(true);
    expect(runForDay).toHaveBeenCalledTimes(2);
    expect(runForDay).toHaveBeenLastCalledWith('2026-05-29');
  });
});
