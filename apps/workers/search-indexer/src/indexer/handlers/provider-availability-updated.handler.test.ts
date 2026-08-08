import type { ProviderAvailabilityUpdated } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';
import { describe, expect, it, vi } from 'vitest';

import type { ProjectionOrchestratorService } from '../services/projection-orchestrator.service';
import { ProviderAvailabilityUpdatedHandler } from './provider-availability-updated.handler';

function buildArgs(providerId: string): HandleArgs<'provider.availability_updated'> {
  const payload: ProviderAvailabilityUpdated = {
    eventId: 'evt_availability_1',
    occurredAt: '2026-05-25T12:00:00.000Z',
    providerId,
    windowCount: 5,
    exceptionCount: 2,
    actorUserId: 'user_1',
  };
  return {
    envelope: {
      eventId: 'evt_availability_1',
      eventName: 'provider.availability_updated',
      occurredAt: new Date('2026-05-25T12:00:00.000Z'),
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

describe('ProviderAvailabilityUpdatedHandler.handle', () => {
  it('re-projects using the payload providerId', async () => {
    const orchestrator = buildOrchestrator();
    const handler = new ProviderAvailabilityUpdatedHandler(orchestrator);

    await handler.handle(buildArgs('prov_1'));

    expect(orchestrator.project).toHaveBeenCalledTimes(1);
    expect(orchestrator.project).toHaveBeenCalledWith('prov_1');
  });

  it('propagates a transport-layer throw so the consumer SDK can retry', async () => {
    const orchestrator = {
      project: vi.fn(async () => {
        throw new Error('service-search unavailable');
      }),
    } as unknown as ProjectionOrchestratorService;
    const handler = new ProviderAvailabilityUpdatedHandler(orchestrator);

    await expect(handler.handle(buildArgs('prov_1'))).rejects.toThrow('service-search unavailable');
  });
});
