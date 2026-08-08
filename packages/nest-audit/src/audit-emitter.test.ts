import { AUDIT_ACTION_RECORDED, AuditActionRecordedSchema } from '@taste-and-see/contracts';
import { OutboxService, type AppendResult } from '@taste-and-see/nest-outbox';
import { describe, expect, it, vi } from 'vitest';

import { AuditEmitter, AuditEmitFailedError } from './audit-emitter';
import { SYSTEM_AUDIT_ACTOR } from './audit-context';
import type { AuditActorContext } from './audit-context';

const TX = {} as never;

function actor(overrides: Partial<AuditActorContext> = {}): AuditActorContext {
  return {
    actorUserId: 'admin_1',
    actorRole: 'marketing',
    actorTenantScopeType: 'global',
    actorTenantScopeId: null,
    ip: '203.0.113.4',
    userAgent: 'Mozilla/5.0',
    requestId: 'req_9',
    traceId: 'a'.repeat(32),
    ...overrides,
  };
}

function build(result: AppendResult): {
  emitter: AuditEmitter;
  append: ReturnType<typeof vi.fn>;
} {
  const append = vi.fn(async (): Promise<AppendResult> => result);
  const outbox = { append } as unknown as OutboxService;
  return { emitter: new AuditEmitter(outbox, 'service-ads'), append };
}

describe('AuditEmitter.emit', () => {
  const appended: AppendResult = {
    kind: 'appended',
    eventId: 'ignored',
    eventName: AUDIT_ACTION_RECORDED,
    occurredAt: new Date(),
  };

  it('appends audit.action_recorded with a payload that maps the actor + descriptor', async () => {
    const { emitter, append } = build(appended);
    await emitter.emit(TX, actor(), {
      action: 'ad_campaign:create',
      resourceKind: 'ad_campaign',
      resourceId: 'camp_1',
      before: null,
      after: { id: 'camp_1', status: 'draft' },
    });

    expect(append).toHaveBeenCalledTimes(1);
    const [, args] = append.mock.calls[0]!;
    expect(args.eventName).toBe(AUDIT_ACTION_RECORDED);
    expect(args.payload).toMatchObject({
      actorUserId: 'admin_1',
      actorRole: 'marketing',
      actorTenantScopeType: 'global',
      actorTenantScopeId: null,
      action: 'ad_campaign:create',
      resourceKind: 'ad_campaign',
      resourceId: 'camp_1',
      beforeJson: null,
      afterJson: { id: 'camp_1', status: 'draft' },
      ip: '203.0.113.4',
      requestId: 'req_9',
    });
    // The payload is a valid audit.action_recorded event.
    expect(AuditActionRecordedSchema.safeParse(args.payload).success).toBe(true);
  });

  it('stamps the SAME eventId + occurredAt on the row args and the payload envelope', async () => {
    const { emitter, append } = build(appended);
    await emitter.emit(TX, actor(), {
      action: 'ad_campaign:update',
      resourceKind: 'ad_campaign',
      resourceId: 'camp_1',
      before: { status: 'draft' },
      after: { status: 'active' },
    });
    const [, args] = append.mock.calls[0]!;
    expect(args.eventId).toBe(args.payload.eventId);
    expect((args.occurredAt as Date).toISOString()).toBe(args.payload.occurredAt);
  });

  it('throws AuditEmitFailedError when the outbox rejects the payload', async () => {
    const { emitter } = build({
      kind: 'validation_failed',
      eventName: AUDIT_ACTION_RECORDED,
      issues: [{ path: ['action'], message: 'bad' }],
    });
    await expect(
      emitter.emit(TX, actor(), {
        action: 'ad_campaign:create',
        resourceKind: 'ad_campaign',
        resourceId: 'camp_1',
        before: null,
        after: {},
      }),
    ).rejects.toBeInstanceOf(AuditEmitFailedError);
  });

  it('carries a null actor role / request metadata through to the payload', async () => {
    const { emitter, append } = build(appended);
    await emitter.emit(
      TX,
      actor({ actorRole: null, ip: null, userAgent: null, requestId: null, traceId: null }),
      {
        action: 'ad_creative:status_changed',
        resourceKind: 'ad_creative',
        resourceId: 'crea_1',
        before: {},
        after: {},
      },
    );
    const [, args] = append.mock.calls[0]!;
    expect(args.payload).toMatchObject({
      actorRole: null,
      ip: null,
      userAgent: null,
      requestId: null,
      traceId: null,
    });
    expect(AuditActionRecordedSchema.safeParse(args.payload).success).toBe(true);
  });

  /**
   * The job-driven actor (TS-309a-followup-3). service-identity's RBAC expiry
   * sweep is the first caller: nobody performed the mutation, and the
   * `audit.action_recorded` contract permits a null actor id ONLY under the
   * `system` scope — so the two fields have to travel together, which is why
   * the system actor is its own type rather than a loosened field.
   */
  it('emits a system-actor event for a mutation no person performed', async () => {
    const { emitter, append } = build(appended);
    await emitter.emit(TX, SYSTEM_AUDIT_ACTOR, {
      action: 'rbac_assignment:expire',
      resourceKind: 'rbac_assignment',
      resourceId: 'ur_1',
      before: { revokedAt: null },
      after: { revokedAt: '2026-07-27T00:00:00.000Z' },
    });

    const [, args] = append.mock.calls[0]!;
    expect(args.payload).toMatchObject({
      actorUserId: null,
      actorRole: null,
      actorTenantScopeType: 'system',
      actorTenantScopeId: null,
    });
    // The contract is the authority on the null-actor pairing — parse, don't
    // assert field by field.
    expect(AuditActionRecordedSchema.safeParse(args.payload).success).toBe(true);
  });
});
