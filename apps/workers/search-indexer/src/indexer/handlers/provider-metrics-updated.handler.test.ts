import type { ProviderMetricsUpdated } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';
import { describe, expect, it, vi } from 'vitest';

import type { ProjectionOrchestratorService } from '../services/projection-orchestrator.service';
import { ProviderMetricsUpdatedHandler } from './provider-metrics-updated.handler';

function buildArgs(
  providerId: string,
  completedBookingCount = 12,
): HandleArgs<'provider.metrics_updated'> {
  const payload: ProviderMetricsUpdated = {
    eventId: `provider-metrics:${providerId}:bkg_1`,
    occurredAt: '2026-08-06T12:00:00.000Z',
    providerId,
    completedBookingCount,
  };
  return {
    envelope: {
      eventId: `provider-metrics:${providerId}:bkg_1`,
      eventName: 'provider.metrics_updated',
      occurredAt: new Date('2026-08-06T12:00:00.000Z'),
      producerService: 'service-provider',
      producerSchema: 'provider',
    },
    payload,
  };
}

function buildOrchestrator(): ProjectionOrchestratorService {
  return {
    project: vi.fn(async () => ({
      kind: 'upserted' as const,
      providerId: 'prov_1',
      outcome: 'updated' as const,
    })),
  } as unknown as ProjectionOrchestratorService;
}

describe('ProviderMetricsUpdatedHandler.handle', () => {
  it('re-projects using the payload providerId', async () => {
    const orchestrator = buildOrchestrator();
    const handler = new ProviderMetricsUpdatedHandler(orchestrator);

    await handler.handle(buildArgs('prov_1'));

    expect(orchestrator.project).toHaveBeenCalledTimes(1);
    expect(orchestrator.project).toHaveBeenCalledWith('prov_1');
  });

  it('does NOT pass the payload count to the projection — the orchestrator re-reads the snapshot, so a stale or reordered event still produces a fresh document', async () => {
    const orchestrator = buildOrchestrator();
    const handler = new ProviderMetricsUpdatedHandler(orchestrator);

    await handler.handle(buildArgs('prov_1', 99));

    // One argument, and it is the id. If the count ever became an
    // argument, a reordered redelivery could write an older number over
    // a newer one — the exact failure the re-read design avoids.
    expect(orchestrator.project).toHaveBeenCalledWith('prov_1');
    const call = (orchestrator.project as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0];
    expect(call).toHaveLength(1);
  });

  it('propagates a transport-layer throw so the consumer SDK can retry', async () => {
    const orchestrator = {
      project: vi.fn(async () => {
        throw new Error('service-search unavailable');
      }),
    } as unknown as ProjectionOrchestratorService;
    const handler = new ProviderMetricsUpdatedHandler(orchestrator);

    await expect(handler.handle(buildArgs('prov_1'))).rejects.toThrow('service-search unavailable');
  });
});
