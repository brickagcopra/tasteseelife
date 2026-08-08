import { IdentityRoleAssignmentExpiredSchema } from '@taste-and-see/contracts';
import type { OutboxService } from '@taste-and-see/nest-outbox';
import { describe, expect, it, vi } from 'vitest';

import { RbacExpiryEmitFailedError, RbacExpiryEmitter } from './rbac-expiry-emitter';

/**
 * Unit tests for the TS-293 outbox emitter — identity's first producer.
 * Pins: the payload validates against the registry contract, the append
 * rides the caller's tx client, and a rejected append throws (rolling the
 * sweep batch back per the CLAUDE.md §5.3 outbox invariant).
 */

interface AppendCall {
  readonly tx: unknown;
  readonly input: {
    readonly eventName: string;
    readonly payload: unknown;
    readonly eventId: string;
    readonly occurredAt: Date;
  };
}

function buildFakeOutbox(result: { kind: string; issues?: [] }): {
  outbox: OutboxService;
  calls: AppendCall[];
} {
  const calls: AppendCall[] = [];
  const outbox = {
    append: vi.fn(async (tx: unknown, input: AppendCall['input']) => {
      calls.push({ tx, input });
      return result;
    }),
  } as unknown as OutboxService;
  return { outbox, calls };
}

const DESCRIPTOR = {
  assignmentId: 'ur_1',
  userId: 'user_1',
  roleName: 'operations_manager',
  scopeType: 'tenant' as const,
  scopeId: 'tenant_abc',
  expiresAt: new Date('2026-07-01T00:00:00.000Z'),
  revokedAt: new Date('2026-07-01T12:00:00.000Z'),
};

describe('RbacExpiryEmitter', () => {
  it('appends a registry-valid payload on the given tx client', async () => {
    const { outbox, calls } = buildFakeOutbox({ kind: 'appended' });
    const emitter = new RbacExpiryEmitter(outbox);
    const tx = { marker: 'tx' };

    await emitter.emitExpired(tx as never, DESCRIPTOR);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    expect(call?.tx).toBe(tx);
    expect(call?.input.eventName).toBe('identity.role_assignment.expired');
    const parsed = IdentityRoleAssignmentExpiredSchema.safeParse(call?.input.payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.assignmentId).toBe('ur_1');
      expect(parsed.data.scopeType).toBe('tenant');
      expect(parsed.data.expiresAt).toBe('2026-07-01T00:00:00.000Z');
      expect(parsed.data.revokedAt).toBe('2026-07-01T12:00:00.000Z');
      // occurredAt is the revocation moment — the sweep's clock, not wall-clock drift.
      expect(parsed.data.occurredAt).toBe('2026-07-01T12:00:00.000Z');
    }
  });

  it('encodes a global scope with null scopeId', async () => {
    const { outbox, calls } = buildFakeOutbox({ kind: 'appended' });
    const emitter = new RbacExpiryEmitter(outbox);

    await emitter.emitExpired({} as never, {
      ...DESCRIPTOR,
      scopeType: 'global',
      scopeId: null,
    });

    const payload = calls[0]?.input.payload as { scopeType: string; scopeId: string | null };
    expect(payload.scopeType).toBe('global');
    expect(payload.scopeId).toBeNull();
  });

  it('throws RbacExpiryEmitFailedError when the append is rejected', async () => {
    const { outbox } = buildFakeOutbox({ kind: 'rejected', issues: [] });
    const emitter = new RbacExpiryEmitter(outbox);

    await expect(emitter.emitExpired({} as never, DESCRIPTOR)).rejects.toBeInstanceOf(
      RbacExpiryEmitFailedError,
    );
  });
});
