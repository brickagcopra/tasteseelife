import { describe, expect, it, vi } from 'vitest';

import type { ReconciliationClient } from './clients/reconciliation.client';
import { ReconciliationOrchestratorService } from './reconciliation-orchestrator.service';

function makeClient(run: ReturnType<typeof vi.fn>): ReconciliationClient {
  return { run } as unknown as ReconciliationClient;
}

describe('ReconciliationOrchestratorService.runForDay', () => {
  it('returns true + passes a deterministic idempotency key on success', async () => {
    const run = vi.fn(async () => ({
      reconciliationDate: '2026-05-28',
      mode: 'live' as const,
      checks: [],
      openMismatchCount: 0,
    }));
    const svc = new ReconciliationOrchestratorService(makeClient(run));

    expect(await svc.runForDay('2026-05-29')).toBe(true);
    expect(run).toHaveBeenCalledWith('stripe-reconciliation:run:2026-05-29');
  });

  it('returns true even when mismatches are open (the run succeeded)', async () => {
    const run = vi.fn(async () => ({
      reconciliationDate: '2026-05-28',
      mode: 'live' as const,
      checks: [],
      openMismatchCount: 2,
    }));
    const svc = new ReconciliationOrchestratorService(makeClient(run));
    expect(await svc.runForDay('2026-05-29')).toBe(true);
  });

  it('swallows a transport error and returns false', async () => {
    const run = vi.fn(async () => {
      throw new Error('upstream down');
    });
    const svc = new ReconciliationOrchestratorService(makeClient(run));
    expect(await svc.runForDay('2026-05-29')).toBe(false);
  });
});
