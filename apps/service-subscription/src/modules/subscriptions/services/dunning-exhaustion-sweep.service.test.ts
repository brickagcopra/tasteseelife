import { describe, expect, it, vi } from 'vitest';

import type { SubscriptionMetrics } from '../../../observability/subscription-metrics';
import type { PrismaService } from '../../../prisma/prisma.service';
import {
  DUNNING_EXHAUSTION_MAX_PER_TICK,
  DunningExhaustionSweepService,
} from './dunning-exhaustion-sweep.service';
import type { DunningService } from './dunning.service';

const NOW = new Date('2026-08-01T12:00:00.000Z');

function build(args?: { readonly candidates?: Array<{ id: string }> }) {
  const findMany = vi.fn().mockResolvedValue(args?.candidates ?? [{ id: 'sub_1' }]);
  const applyDunningExhaustion = vi.fn().mockResolvedValue({ ok: true, value: {} });
  const recordDunningExhaustionSweep = vi.fn();

  const prisma = { subscription: { findMany } };
  const dunning = { applyDunningExhaustion };
  const metrics = { recordDunningExhaustionSweep };

  const service = new DunningExhaustionSweepService(
    prisma as unknown as PrismaService,
    dunning as unknown as DunningService,
    metrics as unknown as SubscriptionMetrics,
  );
  return { service, findMany, applyDunningExhaustion, recordDunningExhaustionSweep };
}

describe('DunningExhaustionSweepService — the query', () => {
  it('asks only for past_due rows whose grace window has already expired', () => {
    const { service, findMany } = build();

    return service.sweep({ now: NOW }).then(() => {
      const call = findMany.mock.calls[0]![0] as {
        where: Record<string, unknown>;
        orderBy: Record<string, unknown>;
        take: number;
        select: Record<string, unknown>;
      };
      expect(call.where).toEqual({ status: 'past_due', dunningGraceUntil: { lt: NOW } });
      // Oldest deadline first: if the cap bites, the family who has been
      // waiting longest is resolved first.
      expect(call.orderBy).toEqual({ dunningGraceUntil: 'asc' });
      // One extra row is the truncation probe.
      expect(call.take).toBe(DUNNING_EXHAUSTION_MAX_PER_TICK + 1);
      // Projection carries the id ALONE — nothing about a family's billing
      // state needs to leave the query for the sweep to do its job.
      expect(call.select).toEqual({ id: true });
    });
  });

  it('reports a clean tick rather than staying silent', async () => {
    // A sweep you only hear about when it finds something is
    // indistinguishable from a sweep that stopped running.
    const { service, recordDunningExhaustionSweep } = build({ candidates: [] });

    await expect(service.sweep({ now: NOW })).resolves.toEqual({
      candidates: 0,
      exhausted: 0,
      skipped: 0,
      failed: 0,
      truncated: false,
    });
    expect(recordDunningExhaustionSweep).toHaveBeenCalledTimes(1);
  });
});

describe('DunningExhaustionSweepService — per-row handling', () => {
  it('calls applyDunningExhaustion once per candidate with a deterministic source id', async () => {
    const { service, applyDunningExhaustion } = build({
      candidates: [{ id: 'sub_1' }, { id: 'sub_2' }],
    });

    const result = await service.sweep({ now: NOW });

    expect(result.exhausted).toBe(2);
    expect(applyDunningExhaustion).toHaveBeenCalledTimes(2);
    expect(applyDunningExhaustion.mock.calls[0]![0]).toEqual({
      subscriptionId: 'sub_1',
      // Deterministic per subscription per tick-day, so a retried tick leaves
      // a traceable `subscription_history.source` rather than a fresh opaque
      // id each time.
      sourceEventId: 'dunning-exhaustion-sweep:sub_1:2026-08-01',
      now: NOW,
    });
  });

  it('counts a REFUSED transition as skipped, not failed', async () => {
    // The row moved between the query and the call — it recovered, or another
    // tick got there first. The service refusing is exactly the guard that
    // makes a stale candidate list safe, so it is not an error.
    const { service, applyDunningExhaustion } = build({
      candidates: [{ id: 'sub_1' }, { id: 'sub_2' }],
    });
    applyDunningExhaustion.mockResolvedValueOnce({
      ok: false,
      error: { reason: 'grace_not_expired', subscriptionId: 'sub_1', graceUntil: NOW },
    });

    const result = await service.sweep({ now: NOW });

    expect(result).toMatchObject({ exhausted: 1, skipped: 1, failed: 0 });
  });

  it('a THROWN row never stops the tick', async () => {
    // Letting one locked row cost every other family's transition — with
    // nothing saying the rest were skipped rather than clean — is the quiet
    // failure this whole area exists to avoid.
    const { service, applyDunningExhaustion } = build({
      candidates: [{ id: 'sub_1' }, { id: 'sub_2' }, { id: 'sub_3' }],
    });
    applyDunningExhaustion.mockRejectedValueOnce(new Error('row locked'));

    const result = await service.sweep({ now: NOW });

    expect(result).toMatchObject({ candidates: 3, exhausted: 2, failed: 1 });
    expect(applyDunningExhaustion).toHaveBeenCalledTimes(3);
  });

  it('does not re-derive the expiry rule — it passes `now` and lets the service decide', async () => {
    const { service, applyDunningExhaustion } = build();
    await service.sweep({ now: NOW });
    expect(applyDunningExhaustion.mock.calls[0]![0]).toMatchObject({ now: NOW });
  });
});

describe('DunningExhaustionSweepService — the cap', () => {
  it('REPORTS truncation rather than swallowing a backlog', async () => {
    const candidates = Array.from({ length: DUNNING_EXHAUSTION_MAX_PER_TICK + 1 }, (_, i) => ({
      id: `sub_${i}`,
    }));
    const { service, applyDunningExhaustion, recordDunningExhaustionSweep } = build({ candidates });

    const result = await service.sweep({ now: NOW });

    expect(result.truncated).toBe(true);
    // The probe row is NOT processed — the cap is a cap.
    expect(result.candidates).toBe(DUNNING_EXHAUSTION_MAX_PER_TICK);
    expect(applyDunningExhaustion).toHaveBeenCalledTimes(DUNNING_EXHAUSTION_MAX_PER_TICK);
    expect(recordDunningExhaustionSweep).toHaveBeenCalledWith(
      expect.objectContaining({ truncated: true }),
    );
  });

  it('is not truncated at exactly the cap', async () => {
    const candidates = Array.from({ length: DUNNING_EXHAUSTION_MAX_PER_TICK }, (_, i) => ({
      id: `sub_${i}`,
    }));
    const { service } = build({ candidates });

    const result = await service.sweep({ now: NOW });

    expect(result.truncated).toBe(false);
    expect(result.candidates).toBe(DUNNING_EXHAUSTION_MAX_PER_TICK);
  });
});
