import { BadRequestException } from '@nestjs/common';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it, vi } from 'vitest';

import type { RideWebhookOutcome, TransportationService } from '../services/transportation.service';
import { TransportationWebhookController } from './transportation-webhook.controller';

function makeStore(): TenantContextStore {
  return new TenantContextStore();
}

const baseEvent = {
  externalProvider: 'uber_health',
  externalReference: 'uber_ride_1',
  externalStatus: 'arriving',
  occurredAt: '2026-06-01T13:45:00.000Z',
} as const;

interface FakeService {
  applyWebhookEvent: ReturnType<typeof vi.fn>;
}

function buildController(
  applyOutcome: RideWebhookOutcome = { outcome: 'applied', status: 'in_progress' },
  store: TenantContextStore = makeStore(),
): {
  controller: TransportationWebhookController;
  service: FakeService;
  store: TenantContextStore;
} {
  const service: FakeService = {
    applyWebhookEvent: vi.fn(async (): Promise<RideWebhookOutcome> => applyOutcome),
  };
  const controller = new TransportationWebhookController(
    service as unknown as TransportationService,
    store,
  );
  return { controller, service, store };
}

describe('TransportationWebhookController.receive', () => {
  it('maps the service outcome onto the ack response', async () => {
    const { controller } = buildController({ outcome: 'applied', status: 'in_progress' });
    const response = await controller.receive({ ...baseEvent });
    expect(response).toEqual({ received: true, outcome: 'applied', status: 'in_progress' });
  });

  it('passes the event fields through to the service', async () => {
    const { controller, service } = buildController();
    await controller.receive({ ...baseEvent });
    expect(service.applyWebhookEvent).toHaveBeenCalledWith({
      externalProvider: 'uber_health',
      externalReference: 'uber_ride_1',
      externalStatus: 'arriving',
      occurredAt: '2026-06-01T13:45:00.000Z',
    });
  });

  it('surfaces a not_found outcome with a null status', async () => {
    const { controller } = buildController({ outcome: 'not_found', status: null });
    const response = await controller.receive({ ...baseEvent });
    expect(response).toEqual({ received: true, outcome: 'not_found', status: null });
  });

  it('rejects a manual-provider event with 400 (no vendor edge)', async () => {
    const { controller, service } = buildController();
    await expect(
      controller.receive({ ...baseEvent, externalProvider: 'manual' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.applyWebhookEvent).not.toHaveBeenCalled();
  });
});

describe('TransportationWebhookController tenant-scope exempt wrap (TS-020-followup-2b / §3.2)', () => {
  it('runs receive inside an exempt frame with reason "internal-transportation-ride-event"', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const service: FakeService = {
      applyWebhookEvent: vi.fn(async (): Promise<RideWebhookOutcome> => {
        captured = store.current();
        return { outcome: 'applied', status: 'in_progress' };
      }),
    };
    const controller = new TransportationWebhookController(
      service as unknown as TransportationService,
      store,
    );

    expect(store.current()).toBeNull();
    await controller.receive({ ...baseEvent });
    expect(store.current()).toBeNull();

    expect(captured).toEqual({ kind: 'exempt', reason: 'internal-transportation-ride-event' });
  });

  it('runs the manual-rejection 400 branch inside the same exempt frame', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const { controller, service } = buildController(
      { outcome: 'applied', status: 'in_progress' },
      store,
    );
    // The manual rejection short-circuits before any service call. The handler
    // reads `body.externalProvider` first INSIDE the wrap, so a getter on that
    // field captures `store.current()` at the precise moment the gate would be
    // consulted (mirrors the stripe-webhook not-a-Buffer probe).
    const probingBody = {
      get externalProvider() {
        captured = store.current();
        return 'manual' as const;
      },
      externalReference: 'uber_ride_1',
      externalStatus: 'arriving',
      occurredAt: '2026-06-01T13:45:00.000Z',
    } as unknown as Parameters<TransportationWebhookController['receive']>[0];

    expect(store.current()).toBeNull();
    await expect(controller.receive(probingBody)).rejects.toBeInstanceOf(BadRequestException);
    expect(store.current()).toBeNull();

    expect(captured).toEqual({ kind: 'exempt', reason: 'internal-transportation-ride-event' });
    expect(service.applyWebhookEvent).not.toHaveBeenCalled();
  });
});
