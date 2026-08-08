import type { ProviderProfileUpdated } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';
import { describe, expect, it, vi } from 'vitest';

import type { ProjectionOrchestratorService } from '../services/projection-orchestrator.service';
import { ProviderProfileUpdatedHandler } from './provider-profile-updated.handler';

function buildArgs(providerId: string): HandleArgs<'provider.profile_updated'> {
  const payload: ProviderProfileUpdated = {
    eventId: 'evt_profile_1',
    occurredAt: '2026-05-25T12:00:00.000Z',
    providerId,
    changedKinds: ['bio', 'language'],
    actorUserId: 'user_1',
  };
  return {
    envelope: {
      eventId: 'evt_profile_1',
      eventName: 'provider.profile_updated',
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

describe('ProviderProfileUpdatedHandler.handle', () => {
  it('re-projects using the payload providerId', async () => {
    const orchestrator = buildOrchestrator();
    const handler = new ProviderProfileUpdatedHandler(orchestrator);

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
    const handler = new ProviderProfileUpdatedHandler(orchestrator);

    await expect(handler.handle(buildArgs('prov_1'))).rejects.toThrow('service-search unavailable');
  });
});
