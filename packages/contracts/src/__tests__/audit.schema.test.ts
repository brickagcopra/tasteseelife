import { describe, expect, it } from 'vitest';

import {
  ActorTenantScopeTypeSchema,
  AUDIT_ACTION_MAX_LENGTH,
  AUDIT_JSON_PAYLOAD_MAX_BYTES,
  AUDIT_LIST_LIMIT_DEFAULT,
  AUDIT_LIST_LIMIT_MAX,
  AuditEventResponseSchema,
  AUDIT_LIST_RESOURCE_KINDS_MAX,
  AuditEventsListResponseSchema,
  ListAuditEventsByResourceKindQuerySchema,
  parseResourceKindsCsv,
  ListAuditEventsByActorQuerySchema,
  ListAuditEventsByResourceQuerySchema,
  RecordAuditEventRequestSchema,
  RecordAuditEventResponseSchema,
} from '../http';

describe('ActorTenantScopeTypeSchema', () => {
  it('accepts every documented scope', () => {
    (['global', 'tenant', 'household', 'system'] as const).forEach((value) => {
      expect(ActorTenantScopeTypeSchema.safeParse(value).success).toBe(true);
    });
  });

  it('rejects unknown scopes', () => {
    expect(ActorTenantScopeTypeSchema.safeParse('partner_admin').success).toBe(false);
  });
});

describe('RecordAuditEventRequestSchema', () => {
  const minimalBody = {
    eventId: 'evt_001',
    occurredAt: '2026-05-13T12:00:00.000Z',
    actorUserId: 'user_001',
    actorRole: 'super_admin',
    actorTenantScopeType: 'global' as const,
    actorTenantScopeId: null,
    action: 'subscription:write',
    resourceKind: 'subscription',
    resourceId: 'sub_001',
    beforeJson: null,
    afterJson: { status: 'active' },
    ip: '203.0.113.7',
    userAgent: 'Mozilla/5.0',
    requestId: 'req_001',
    traceId: 'trace_001',
  };

  it('accepts a fully-populated body', () => {
    const result = RecordAuditEventRequestSchema.safeParse(minimalBody);
    expect(result.success).toBe(true);
  });

  it('rejects an empty body (eventId missing)', () => {
    expect(RecordAuditEventRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects unknown fields (strict mode)', () => {
    const tampered = { ...minimalBody, extraField: 'oops' };
    expect(RecordAuditEventRequestSchema.safeParse(tampered).success).toBe(false);
  });

  it('rejects when actorUserId is missing on a non-system scope', () => {
    const { actorUserId: _omit, ...rest } = minimalBody;
    const result = RecordAuditEventRequestSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects when actorUserId is null on a non-system scope', () => {
    const result = RecordAuditEventRequestSchema.safeParse({
      ...minimalBody,
      actorUserId: null,
    });
    expect(result.success).toBe(false);
  });

  it('accepts a system-scoped body with no actor', () => {
    const result = RecordAuditEventRequestSchema.safeParse({
      ...minimalBody,
      actorUserId: null,
      actorRole: null,
      actorTenantScopeType: 'system',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an action longer than the cap', () => {
    const tampered = { ...minimalBody, action: 'x'.repeat(AUDIT_ACTION_MAX_LENGTH + 1) };
    expect(RecordAuditEventRequestSchema.safeParse(tampered).success).toBe(false);
  });

  it('rejects an occurredAt that is not ISO-8601', () => {
    const tampered = { ...minimalBody, occurredAt: 'not-a-date' };
    expect(RecordAuditEventRequestSchema.safeParse(tampered).success).toBe(false);
  });

  it('rejects a beforeJson payload above the size cap', () => {
    // 65 KiB > 64 KiB cap. Build a string that, when JSON-stringified,
    // exceeds the cap.
    const bloat = 'x'.repeat(AUDIT_JSON_PAYLOAD_MAX_BYTES + 100);
    const tampered = { ...minimalBody, beforeJson: { bloat } };
    expect(RecordAuditEventRequestSchema.safeParse(tampered).success).toBe(false);
  });

  it('accepts a beforeJson payload at the size cap boundary', () => {
    // Tighter test — slightly under the cap.
    const room = AUDIT_JSON_PAYLOAD_MAX_BYTES - 100;
    const tampered = { ...minimalBody, beforeJson: { x: 'y'.repeat(room) } };
    expect(RecordAuditEventRequestSchema.safeParse(tampered).success).toBe(true);
  });

  it('rejects a non-serialisable diff payload', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const tampered = { ...minimalBody, beforeJson: circular };
    expect(RecordAuditEventRequestSchema.safeParse(tampered).success).toBe(false);
  });
});

describe('AuditEventResponseSchema', () => {
  it('round-trips a fully-populated response', () => {
    const event = {
      id: 'row_000001',
      eventId: 'evt_001',
      occurredAt: '2026-05-13T12:00:00.000Z',
      actorUserId: 'user_001',
      actorRole: 'super_admin',
      actorTenantScopeType: 'global',
      actorTenantScopeId: null,
      action: 'subscription:write',
      resourceKind: 'subscription',
      resourceId: 'sub_001',
      beforeJson: null,
      afterJson: { status: 'active' },
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
      requestId: 'req_001',
      traceId: 'trace_001',
      chainPrevHash: null,
      chainHash: 'a'.repeat(64),
      createdAt: '2026-05-13T12:00:01.000Z',
    };
    expect(AuditEventResponseSchema.safeParse(event).success).toBe(true);
  });

  it('rejects a chainHash that is not 64 chars', () => {
    const event = {
      id: 'row_000001',
      eventId: 'evt_001',
      occurredAt: '2026-05-13T12:00:00.000Z',
      actorUserId: 'user_001',
      actorRole: 'super_admin',
      actorTenantScopeType: 'global',
      actorTenantScopeId: null,
      action: 'subscription:write',
      resourceKind: 'subscription',
      resourceId: 'sub_001',
      beforeJson: null,
      afterJson: null,
      ip: null,
      userAgent: null,
      requestId: null,
      traceId: null,
      chainPrevHash: null,
      chainHash: 'too-short',
      createdAt: '2026-05-13T12:00:01.000Z',
    };
    expect(AuditEventResponseSchema.safeParse(event).success).toBe(false);
  });
});

describe('RecordAuditEventResponseSchema', () => {
  it('accepts a recorded-outcome response', () => {
    const response = {
      outcome: 'recorded' as const,
      event: {
        id: 'row_000001',
        eventId: 'evt_001',
        occurredAt: '2026-05-13T12:00:00.000Z',
        actorUserId: 'user_001',
        actorRole: 'super_admin',
        actorTenantScopeType: 'global',
        actorTenantScopeId: null,
        action: 'subscription:write',
        resourceKind: 'subscription',
        resourceId: 'sub_001',
        beforeJson: null,
        afterJson: { status: 'active' },
        ip: null,
        userAgent: null,
        requestId: null,
        traceId: null,
        chainPrevHash: null,
        chainHash: 'b'.repeat(64),
        createdAt: '2026-05-13T12:00:01.000Z',
      },
    };
    expect(RecordAuditEventResponseSchema.safeParse(response).success).toBe(true);
  });

  it('rejects an unknown outcome value', () => {
    const response = {
      outcome: 'unknown',
      event: {
        id: 'row_000001',
        eventId: 'evt_001',
        occurredAt: '2026-05-13T12:00:00.000Z',
        actorUserId: 'user_001',
        actorRole: 'super_admin',
        actorTenantScopeType: 'global',
        actorTenantScopeId: null,
        action: 'subscription:write',
        resourceKind: 'subscription',
        resourceId: 'sub_001',
        beforeJson: null,
        afterJson: null,
        ip: null,
        userAgent: null,
        requestId: null,
        traceId: null,
        chainPrevHash: null,
        chainHash: 'b'.repeat(64),
        createdAt: '2026-05-13T12:00:01.000Z',
      },
    };
    expect(RecordAuditEventResponseSchema.safeParse(response).success).toBe(false);
  });
});

describe('ListAuditEventsByResourceQuerySchema', () => {
  it('applies the default limit when omitted', () => {
    const result = ListAuditEventsByResourceQuerySchema.safeParse({
      resourceKind: 'subscription',
      resourceId: 'sub_001',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(AUDIT_LIST_LIMIT_DEFAULT);
    }
  });

  it('coerces a string limit', () => {
    const result = ListAuditEventsByResourceQuerySchema.safeParse({
      resourceKind: 'subscription',
      resourceId: 'sub_001',
      limit: '25',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(25);
    }
  });

  it('rejects a limit above the cap', () => {
    const result = ListAuditEventsByResourceQuerySchema.safeParse({
      resourceKind: 'subscription',
      resourceId: 'sub_001',
      limit: AUDIT_LIST_LIMIT_MAX + 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects when resourceKind or resourceId is missing', () => {
    expect(
      ListAuditEventsByResourceQuerySchema.safeParse({ resourceKind: 'subscription' }).success,
    ).toBe(false);
    expect(ListAuditEventsByResourceQuerySchema.safeParse({ resourceId: 'sub_001' }).success).toBe(
      false,
    );
  });
});

describe('ListAuditEventsByActorQuerySchema', () => {
  it('applies the default limit when omitted', () => {
    const result = ListAuditEventsByActorQuerySchema.safeParse({
      actorUserId: 'user_001',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(AUDIT_LIST_LIMIT_DEFAULT);
    }
  });

  it('rejects when actorUserId is missing', () => {
    expect(ListAuditEventsByActorQuerySchema.safeParse({}).success).toBe(false);
  });
});

describe('AuditEventsListResponseSchema', () => {
  it('round-trips an empty list with no cursor', () => {
    const response = { events: [], nextCursor: null };
    expect(AuditEventsListResponseSchema.safeParse(response).success).toBe(true);
  });

  it('round-trips a list with a cursor', () => {
    const response = {
      events: [],
      nextCursor: 'eyJvY2N1cnJlZEF0IjoiMjAyNi0wNS0xM1QxMjowMDowMC4wMDBaIiwiaWQiOiJyb3dfMDAwMDAxIn0',
    };
    expect(AuditEventsListResponseSchema.safeParse(response).success).toBe(true);
  });
});

describe('ListAuditEventsByResourceKindQuerySchema (TS-295)', () => {
  it('accepts a single kind and applies defaults', () => {
    const result = ListAuditEventsByResourceKindQuerySchema.safeParse({
      resourceKinds: 'rbac_role',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(AUDIT_LIST_LIMIT_DEFAULT);
      expect(result.data.order).toBe('desc');
    }
  });

  it('accepts a CSV of kinds up to the cap', () => {
    const result = ListAuditEventsByResourceKindQuerySchema.safeParse({
      resourceKinds: 'rbac_role,rbac_assignment,rbac_approval',
      order: 'asc',
      action: 'rbac_role:updated',
      actorUserId: 'user_001',
    });
    expect(result.success).toBe(true);
  });

  it('rejects more kinds than the cap', () => {
    const result = ListAuditEventsByResourceKindQuerySchema.safeParse({
      resourceKinds: Array.from(
        { length: AUDIT_LIST_RESOURCE_KINDS_MAX + 1 },
        (_, i) => `kind_${i}`,
      ).join(','),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty CSV segment', () => {
    expect(
      ListAuditEventsByResourceKindQuerySchema.safeParse({ resourceKinds: 'rbac_role,,x' }).success,
    ).toBe(false);
  });

  it('rejects an unknown order value and unknown fields', () => {
    expect(
      ListAuditEventsByResourceKindQuerySchema.safeParse({
        resourceKinds: 'rbac_role',
        order: 'newest',
      }).success,
    ).toBe(false);
    expect(
      ListAuditEventsByResourceKindQuerySchema.safeParse({
        resourceKinds: 'rbac_role',
        surprise: true,
      }).success,
    ).toBe(false);
  });
});

describe('parseResourceKindsCsv', () => {
  it('splits, trims, and de-duplicates preserving order', () => {
    expect(parseResourceKindsCsv(' rbac_role , rbac_assignment,rbac_role ')).toEqual([
      'rbac_role',
      'rbac_assignment',
    ]);
  });
});
