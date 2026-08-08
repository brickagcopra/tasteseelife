import { AUDIT_ACTION_RECORDED } from '@taste-and-see/contracts';
import type { ConsumerHandler, OutboxConsumerService } from '@taste-and-see/nest-outbox-consumer';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it, vi } from 'vitest';

import type { AuditActionRecordedHandler } from './handlers/audit-action-recorded.handler';
import { OutboxConsumersModule } from './outbox-consumers.module';

/**
 * Unit tests for `OutboxConsumersModule.onModuleInit` — the consumer-side
 * bridge that registers the `audit.action_recorded` handler into the SDK's
 * poll loop, wrapped in `runWithoutTenantContext(...,
 * 'outbox-consumer-audit-action-recorded', ...)` because the SDK invokes it
 * off a background loop (no `request.requestContext` to seed a scoped frame
 * from; the `enforce` posture would otherwise hard-fail).
 */
type AnyHandler = ConsumerHandler<typeof AUDIT_ACTION_RECORDED>;

function makeConsumerMock(): {
  service: OutboxConsumerService;
  captures: { eventName: string; handler: AnyHandler }[];
} {
  const captures: { eventName: string; handler: AnyHandler }[] = [];
  const service = {
    registerHandler: vi.fn((eventName: string, handler: unknown) => {
      captures.push({ eventName, handler: handler as AnyHandler });
    }),
  } as unknown as OutboxConsumerService;
  return { service, captures };
}

function makeHandlerStub(impl: () => Promise<void>): AuditActionRecordedHandler {
  return { handle: vi.fn(impl) } as unknown as AuditActionRecordedHandler;
}

function makeEnvelope(): Parameters<AnyHandler>[0] {
  return {
    envelope: {
      eventId: 'evt_audit',
      eventName: AUDIT_ACTION_RECORDED,
      occurredAt: new Date('2026-06-22T00:00:00.000Z'),
      producerService: 'service-ads',
      producerSchema: 'ads',
    },
    payload: {} as never,
  } as unknown as Parameters<AnyHandler>[0];
}

function makeModule(
  service: OutboxConsumerService,
  store: TenantContextStore,
  handler?: AuditActionRecordedHandler,
): OutboxConsumersModule {
  return new OutboxConsumersModule(
    service,
    handler ?? makeHandlerStub(async () => undefined),
    store,
  );
}

describe('OutboxConsumersModule.onModuleInit', () => {
  it('registers a handler for audit.action_recorded', () => {
    const { service, captures } = makeConsumerMock();
    makeModule(service, new TenantContextStore()).onModuleInit();

    expect(captures).toHaveLength(1);
    expect(captures[0]?.eventName).toBe(AUDIT_ACTION_RECORDED);
    expect(captures[0]?.handler).toBeTypeOf('function');
  });

  it('invokes the handler inside an exempt frame with the matching reason', async () => {
    const store = new TenantContextStore();
    let captured: TenantContextFrame | null = null;
    const handler = makeHandlerStub(async () => {
      captured = store.current();
    });
    const { service, captures } = makeConsumerMock();
    makeModule(service, store, handler).onModuleInit();

    await captures[0]!.handler(makeEnvelope());

    expect(captured).toEqual({ kind: 'exempt', reason: 'outbox-consumer-audit-action-recorded' });
    expect(handler.handle).toHaveBeenCalledTimes(1);
  });

  it('forwards args to the inner handler unchanged', async () => {
    const handler = makeHandlerStub(async () => undefined);
    const { service, captures } = makeConsumerMock();
    makeModule(service, new TenantContextStore(), handler).onModuleInit();

    const envelope = makeEnvelope();
    await captures[0]!.handler(envelope);
    expect(handler.handle).toHaveBeenCalledWith(envelope);
  });

  it('does not leak the exempt frame outside the wrapped handler', async () => {
    const store = new TenantContextStore();
    const { service, captures } = makeConsumerMock();
    makeModule(service, store).onModuleInit();

    expect(store.current()).toBeNull();
    await captures[0]!.handler(makeEnvelope());
    expect(store.current()).toBeNull();
  });

  it('rethrows errors from the inner handler without swallowing them', async () => {
    const handler = makeHandlerStub(async () => {
      throw new Error('record-failure');
    });
    const { service, captures } = makeConsumerMock();
    makeModule(service, new TenantContextStore(), handler).onModuleInit();

    await expect(captures[0]!.handler(makeEnvelope())).rejects.toThrow('record-failure');
  });
});
