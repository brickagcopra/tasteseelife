import { AUDIT_ACTION_RECORDED, type AuditActionRecorded } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';
import { describe, expect, it, vi } from 'vitest';

import {
  AuditService,
  type RecordEventInput,
  type RecordEventResult,
} from '../../audit/services/audit.service';
import { AuditActionRecordedHandler } from './audit-action-recorded.handler';

function payload(overrides: Partial<AuditActionRecorded> = {}): AuditActionRecorded {
  return {
    eventId: 'evt_audit_1',
    occurredAt: '2026-06-22T12:00:00.000Z',
    actorUserId: 'admin_1',
    actorRole: 'marketing',
    actorTenantScopeType: 'global',
    actorTenantScopeId: null,
    action: 'ad_campaign:create',
    resourceKind: 'ad_campaign',
    resourceId: 'camp_123',
    beforeJson: null,
    afterJson: { id: 'camp_123', status: 'draft' },
    ip: '203.0.113.7',
    userAgent: 'Mozilla/5.0',
    requestId: 'req_abc',
    traceId: null,
    ...overrides,
  };
}

function args(p: AuditActionRecorded): HandleArgs<typeof AUDIT_ACTION_RECORDED> {
  return {
    envelope: {
      eventId: p.eventId,
      eventName: AUDIT_ACTION_RECORDED,
      occurredAt: new Date(p.occurredAt),
      producerService: 'service-ads',
      producerSchema: 'ads',
    },
    payload: p,
  };
}

function build(outcome: RecordEventResult['outcome'] = 'recorded'): {
  handler: AuditActionRecordedHandler;
  recordEvent: ReturnType<typeof vi.fn>;
} {
  const recordEvent = vi.fn(
    async (input: RecordEventInput): Promise<RecordEventResult> => ({
      outcome,
      event: { eventId: input.eventId } as unknown as RecordEventResult['event'],
    }),
  );
  const audit = { recordEvent } as unknown as AuditService;
  return { handler: new AuditActionRecordedHandler(audit), recordEvent };
}

describe('AuditActionRecordedHandler', () => {
  it('maps the event payload 1:1 onto recordEvent (occurredAt parsed to Date)', async () => {
    const { handler, recordEvent } = build();
    const p = payload();
    await handler.handle(args(p));

    expect(recordEvent).toHaveBeenCalledTimes(1);
    const input = recordEvent.mock.calls[0]![0] as RecordEventInput;
    expect(input).toMatchObject({
      eventId: 'evt_audit_1',
      actorUserId: 'admin_1',
      actorRole: 'marketing',
      actorTenantScopeType: 'global',
      actorTenantScopeId: null,
      action: 'ad_campaign:create',
      resourceKind: 'ad_campaign',
      resourceId: 'camp_123',
      beforeJson: null,
      afterJson: { id: 'camp_123', status: 'draft' },
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
      requestId: 'req_abc',
      traceId: null,
    });
    expect(input.occurredAt).toBeInstanceOf(Date);
    expect(input.occurredAt.toISOString()).toBe('2026-06-22T12:00:00.000Z');
  });

  it('uses the payload eventId (= the producer-stamped id) as the dedup key', async () => {
    const { handler, recordEvent } = build();
    await handler.handle(args(payload({ eventId: 'evt_special' })));
    expect((recordEvent.mock.calls[0]![0] as RecordEventInput).eventId).toBe('evt_special');
  });

  it('forwards a system-scoped event with a null actor', async () => {
    const { handler, recordEvent } = build();
    await handler.handle(
      args(payload({ actorUserId: null, actorRole: null, actorTenantScopeType: 'system' })),
    );
    const input = recordEvent.mock.calls[0]![0] as RecordEventInput;
    expect(input.actorUserId).toBeNull();
    expect(input.actorTenantScopeType).toBe('system');
  });

  it('completes on a replayed outcome (idempotent redelivery)', async () => {
    const { handler, recordEvent } = build('replayed');
    await expect(handler.handle(args(payload()))).resolves.toBeUndefined();
    expect(recordEvent).toHaveBeenCalledTimes(1);
  });

  it('propagates a recordEvent failure so the SDK retries', async () => {
    const { handler, recordEvent } = build();
    recordEvent.mockRejectedValueOnce(new Error('db down'));
    await expect(handler.handle(args(payload()))).rejects.toThrow('db down');
  });
});
