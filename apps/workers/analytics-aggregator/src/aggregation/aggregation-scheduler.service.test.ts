import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../config/env';
import type { AggregationOrchestratorService } from './aggregation-orchestrator.service';
import { AggregationScheduler } from './aggregation-scheduler.service';

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
    ANALYTICS_SERVICE_BASE_URL: 'http://service-analytics:3023',
    ANALYTICS_AGGREGATION_INTERNAL_API_KEY: 'k'.repeat(32),
    ANALYTICS_AGGREGATION_INTERNAL_HEADER_NAME: 'x-analytics-internal-api-key',
    REQUEST_TIMEOUT_MS: 30_000,
    ANALYTICS_AGGREGATOR_ENABLED: true,
    ANALYTICS_AGGREGATOR_RUN_HOUR_UTC: 3,
    ANALYTICS_AGGREGATOR_SCHEDULER_TICK_MS: 3_600_000,
    ...overrides,
  };
}

function makeOrchestrator(runForDay: ReturnType<typeof vi.fn>): AggregationOrchestratorService {
  return { runForDay } as unknown as AggregationOrchestratorService;
}

describe('AggregationScheduler.runIfDue', () => {
  it('is a no-op when disabled by the kill-switch', async () => {
    const runForDay = vi.fn(async () => true);
    const scheduler = new AggregationScheduler(
      buildEnv({ ANALYTICS_AGGREGATOR_ENABLED: false }),
      makeOrchestrator(runForDay),
    );

    const fired = await scheduler.runIfDue(new Date('2026-06-09T03:00:00Z'));

    expect(fired).toBe(false);
    expect(runForDay).not.toHaveBeenCalled();
  });

  it('does not run before the configured hour', async () => {
    const runForDay = vi.fn(async () => true);
    const scheduler = new AggregationScheduler(buildEnv(), makeOrchestrator(runForDay));

    const fired = await scheduler.runIfDue(new Date('2026-06-09T02:00:00Z'));

    expect(fired).toBe(false);
    expect(runForDay).not.toHaveBeenCalled();
  });

  it('runs once when due and targets the PREVIOUS UTC day', async () => {
    const runForDay = vi.fn(async () => true);
    const scheduler = new AggregationScheduler(buildEnv(), makeOrchestrator(runForDay));

    const fired = await scheduler.runIfDue(new Date('2026-06-09T03:30:00Z'));

    expect(fired).toBe(true);
    expect(runForDay).toHaveBeenCalledWith('2026-06-08');
  });

  it('does not re-run the same calendar day after it has fired', async () => {
    const runForDay = vi.fn(async () => true);
    const scheduler = new AggregationScheduler(buildEnv(), makeOrchestrator(runForDay));

    await scheduler.runIfDue(new Date('2026-06-09T03:30:00Z'));
    const second = await scheduler.runIfDue(new Date('2026-06-09T06:00:00Z'));

    expect(second).toBe(false);
    expect(runForDay).toHaveBeenCalledTimes(1);
  });

  it('runs again on the next UTC day, targeting that day’s predecessor', async () => {
    const runForDay = vi.fn(async () => true);
    const scheduler = new AggregationScheduler(buildEnv(), makeOrchestrator(runForDay));

    await scheduler.runIfDue(new Date('2026-06-09T03:30:00Z'));
    const next = await scheduler.runIfDue(new Date('2026-06-10T03:30:00Z'));

    expect(next).toBe(true);
    expect(runForDay).toHaveBeenCalledTimes(2);
    expect(runForDay).toHaveBeenLastCalledWith('2026-06-09');
  });
});
