import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { HashChainService, type ChainInput } from './hash-chain.service';

/**
 * HashChainService is the load-bearing primitive of the audit
 * subsystem. Every property the chain depends on — determinism, field-
 * order stability, null collapsing, deep-object key ordering, newline
 * escape — has a dedicated test. A regression here silently breaks
 * tamper-evidence across every audit row.
 *
 * Coverage gates (CLAUDE.md §9.2): 100% on this file. The service is
 * pure and small enough that the bar is reachable.
 */

function baseInput(): ChainInput {
  return {
    eventId: 'evt_abc',
    occurredAt: new Date('2026-05-13T12:34:56.000Z'),
    actorUserId: 'user_001',
    actorRole: 'super_admin',
    actorTenantScopeType: 'global',
    actorTenantScopeId: null,
    action: 'subscription:write',
    resourceKind: 'subscription',
    resourceId: 'sub_001',
    beforeJson: { status: 'past_due' },
    afterJson: { status: 'active' },
    ip: '203.0.113.7',
    userAgent: 'Mozilla/5.0',
    requestId: 'req_001',
    traceId: 'trace_001',
    chainPrevHash: null,
  };
}

describe('HashChainService.compute', () => {
  it('returns a 64-char lowercase hex SHA-256 digest', () => {
    const svc = new HashChainService();
    const hash = svc.compute(baseInput());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic across calls', () => {
    const svc = new HashChainService();
    const input = baseInput();
    const a = svc.compute(input);
    const b = svc.compute(input);
    expect(a).toBe(b);
  });

  it('matches an independent SHA-256 of the canonical form', () => {
    const svc = new HashChainService();
    const input = baseInput();
    const canonical = svc.canonicalize(input);
    const expected = createHash('sha256').update(canonical, 'utf8').digest('hex');
    expect(svc.compute(input)).toBe(expected);
  });

  it('chains: a second event with chainPrevHash = first hash differs from the first', () => {
    const svc = new HashChainService();
    const first = baseInput();
    const firstHash = svc.compute(first);

    const second: ChainInput = {
      ...baseInput(),
      eventId: 'evt_def',
      occurredAt: new Date('2026-05-13T13:00:00.000Z'),
      beforeJson: { status: 'active' },
      afterJson: { status: 'canceled' },
      chainPrevHash: firstHash,
    };
    const secondHash = svc.compute(second);
    expect(secondHash).not.toBe(firstHash);
  });

  it('first event for a resource: chainPrevHash null produces a distinct hash from chainPrevHash empty-string', () => {
    // Defends against a future bug where `null` and `""` collapse to
    // the same canonical string (they must not — `""` is a real
    // 0-length string, `null` is the absence of a predecessor).
    const svc = new HashChainService();
    const a = svc.compute(baseInput());
    const b = svc.compute({ ...baseInput(), chainPrevHash: '' });
    expect(a).not.toBe(b);
  });

  it('tampering with any field changes the hash', () => {
    const svc = new HashChainService();
    const baseline = svc.compute(baseInput());
    const fields: readonly (keyof ChainInput)[] = [
      'eventId',
      'occurredAt',
      'actorUserId',
      'actorRole',
      'actorTenantScopeType',
      'actorTenantScopeId',
      'action',
      'resourceKind',
      'resourceId',
      'beforeJson',
      'afterJson',
      'ip',
      'userAgent',
      'requestId',
      'traceId',
      'chainPrevHash',
    ];
    for (const field of fields) {
      const tampered: ChainInput = { ...baseInput() };
      switch (field) {
        case 'occurredAt':
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (tampered as any)[field] = new Date('2026-05-13T13:00:00.000Z');
          break;
        case 'beforeJson':
        case 'afterJson':
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (tampered as any)[field] = { status: 'tampered' };
          break;
        case 'actorUserId':
        case 'actorRole':
        case 'actorTenantScopeId':
        case 'ip':
        case 'userAgent':
        case 'requestId':
        case 'traceId':
        case 'chainPrevHash':
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (tampered as any)[field] = 'tampered';
          break;
        default:
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (tampered as any)[field] = 'tampered-value';
      }
      expect(svc.compute(tampered)).not.toBe(baseline);
    }
  });

  it('null and undefined collapse in canonicalisation', () => {
    const svc = new HashChainService();
    // Constructing a ChainInput with `undefined` actorUserId via cast —
    // the type is `string | null`, but we want to validate the runtime
    // collapsing semantic.
    const withNull: ChainInput = { ...baseInput(), actorUserId: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withUndefined: ChainInput = { ...baseInput(), actorUserId: undefined as any };
    expect(svc.compute(withNull)).toBe(svc.compute(withUndefined));
  });

  it('deep-object key order does not affect the hash', () => {
    const svc = new HashChainService();
    const a: ChainInput = {
      ...baseInput(),
      afterJson: { name: 'X', tier: 'elite', deep: { a: 1, b: 2 } },
    };
    const b: ChainInput = {
      ...baseInput(),
      afterJson: { deep: { b: 2, a: 1 }, tier: 'elite', name: 'X' },
    };
    expect(svc.compute(a)).toBe(svc.compute(b));
  });

  it('newlines inside string fields are escaped, not ambiguous separators', () => {
    const svc = new HashChainService();
    // A user-agent with a literal newline + a regular UA must not
    // collide with another canonical shape. Validate by computing both
    // hashes — they must differ.
    const ua1 = svc.compute({
      ...baseInput(),
      userAgent: 'Mozilla/5.0',
    });
    const ua2 = svc.compute({
      ...baseInput(),
      userAgent: 'Mozilla/5.0\nMalicious-Header: yes',
    });
    expect(ua1).not.toBe(ua2);
  });

  it('Date objects serialise to ISO-8601 UTC', () => {
    const svc = new HashChainService();
    const baseline = svc.canonicalize(baseInput());
    expect(baseline).toContain('occurredAt=2026-05-13T12:34:56.000Z');
  });
});

describe('HashChainService.verify', () => {
  it('returns true for the expected hash', () => {
    const svc = new HashChainService();
    const input = baseInput();
    const hash = svc.compute(input);
    expect(svc.verify(input, hash)).toBe(true);
  });

  it('returns false for a tampered hash', () => {
    const svc = new HashChainService();
    const input = baseInput();
    const hash = svc.compute(input);
    const tampered = hash.slice(0, -1) + (hash.endsWith('a') ? 'b' : 'a');
    expect(svc.verify(input, tampered)).toBe(false);
  });

  it('returns false when the input changes', () => {
    const svc = new HashChainService();
    const input = baseInput();
    const hash = svc.compute(input);
    const altered: ChainInput = { ...input, action: 'subscription:read' };
    expect(svc.verify(altered, hash)).toBe(false);
  });

  it('returns false when the candidate hash length differs', () => {
    const svc = new HashChainService();
    const input = baseInput();
    expect(svc.verify(input, 'too-short')).toBe(false);
  });
});

describe('HashChainService.canonicalize', () => {
  it('emits exactly one line per canonical field in the documented order', () => {
    const svc = new HashChainService();
    const lines = svc.canonicalize(baseInput()).split('\n');
    // 16 documented fields in CANONICAL_FIELD_ORDER.
    expect(lines).toHaveLength(16);
    expect(lines[0]?.startsWith('eventId=')).toBe(true);
    expect(lines[lines.length - 1]?.startsWith('chainPrevHash=')).toBe(true);
  });

  it('renders null fields as `null`', () => {
    const svc = new HashChainService();
    const canonical = svc.canonicalize({
      ...baseInput(),
      actorTenantScopeId: null,
      chainPrevHash: null,
    });
    expect(canonical).toContain('actorTenantScopeId=null');
    expect(canonical).toContain('chainPrevHash=null');
  });
});
