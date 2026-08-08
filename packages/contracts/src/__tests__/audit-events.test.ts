import { describe, expect, it } from 'vitest';

import {
  AUDIT_ACTION_RECORDED,
  AUDIT_EVENT_ACTION_MAX_LENGTH,
  AUDIT_EVENT_JSON_PAYLOAD_MAX_BYTES,
  AUDIT_EVENT_RESOURCE_ID_MAX_LENGTH,
  AuditActionRecordedSchema,
  eventRegistry,
  getEventSchema,
} from '../events';

/**
 * Contract tests for the `audit.action_recorded` event
 * (TS-271a-followup-1 / TS-272a-followup-1 / TS-277a-followup-1).
 *
 * Pins the wire shape (`.strict()`), the envelope, the actor invariant
 * (`actorUserId` required unless scope is `system`), the before/after
 * byte cap, and the bounded fields — so a producer edit is a TS/parse
 * error and the `service-audit` consumer can map the payload 1:1 onto
 * `recordEvent` without re-validating shape.
 */
describe('audit.action_recorded registry wiring', () => {
  it('is registered under its dotted constant', () => {
    expect(eventRegistry[AUDIT_ACTION_RECORDED]).toBe(AuditActionRecordedSchema);
    expect(getEventSchema(AUDIT_ACTION_RECORDED)).toBe(AuditActionRecordedSchema);
  });

  it('uses a past-tense dotted name', () => {
    expect(AUDIT_ACTION_RECORDED).toBe('audit.action_recorded');
    expect(AUDIT_ACTION_RECORDED).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
  });
});

describe('AuditActionRecorded event', () => {
  const valid = {
    eventId: 'evt_audit_1',
    occurredAt: '2026-06-22T12:00:00.000Z',
    actorUserId: 'user_admin',
    actorRole: 'marketing',
    actorTenantScopeType: 'global' as const,
    actorTenantScopeId: null,
    action: 'ad_campaign:create',
    resourceKind: 'ad_campaign',
    resourceId: 'camp_123',
    beforeJson: null,
    afterJson: { id: 'camp_123', status: 'draft' },
    ip: '203.0.113.7',
    userAgent: 'Mozilla/5.0',
    requestId: 'req_abc',
    traceId: 'trace_abc',
  };

  it('accepts a valid create payload (null beforeJson)', () => {
    expect(AuditActionRecordedSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts an update payload (both before + after present)', () => {
    expect(
      AuditActionRecordedSchema.safeParse({
        ...valid,
        action: 'ad_campaign:update',
        beforeJson: { status: 'draft' },
        afterJson: { status: 'active' },
      }).success,
    ).toBe(true);
  });

  it('accepts null request-metadata fields', () => {
    expect(
      AuditActionRecordedSchema.safeParse({
        ...valid,
        actorRole: null,
        ip: null,
        userAgent: null,
        requestId: null,
        traceId: null,
      }).success,
    ).toBe(true);
  });

  it('accepts a system-scoped event with a null actorUserId', () => {
    expect(
      AuditActionRecordedSchema.safeParse({
        ...valid,
        actorUserId: null,
        actorRole: null,
        actorTenantScopeType: 'system',
      }).success,
    ).toBe(true);
  });

  it('rejects a non-system event with a null actorUserId', () => {
    expect(AuditActionRecordedSchema.safeParse({ ...valid, actorUserId: null }).success).toBe(
      false,
    );
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(AuditActionRecordedSchema.safeParse({ ...valid, extraField: 'no' }).success).toBe(false);
  });

  it('requires an ISO `occurredAt`', () => {
    expect(AuditActionRecordedSchema.safeParse({ ...valid, occurredAt: 'now' }).success).toBe(
      false,
    );
  });

  it('rejects an unknown actorTenantScopeType', () => {
    expect(
      AuditActionRecordedSchema.safeParse({ ...valid, actorTenantScopeType: 'partner' }).success,
    ).toBe(false);
  });

  it('rejects an action over the length cap', () => {
    expect(
      AuditActionRecordedSchema.safeParse({
        ...valid,
        action: 'a'.repeat(AUDIT_EVENT_ACTION_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects a resourceId over the length cap', () => {
    expect(
      AuditActionRecordedSchema.safeParse({
        ...valid,
        resourceId: 'a'.repeat(AUDIT_EVENT_RESOURCE_ID_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects an empty action / resourceKind / resourceId', () => {
    expect(AuditActionRecordedSchema.safeParse({ ...valid, action: '' }).success).toBe(false);
    expect(AuditActionRecordedSchema.safeParse({ ...valid, resourceKind: '' }).success).toBe(false);
    expect(AuditActionRecordedSchema.safeParse({ ...valid, resourceId: '' }).success).toBe(false);
  });

  it('rejects an afterJson over the serialised byte cap', () => {
    const huge = { blob: 'a'.repeat(AUDIT_EVENT_JSON_PAYLOAD_MAX_BYTES) };
    expect(AuditActionRecordedSchema.safeParse({ ...valid, afterJson: huge }).success).toBe(false);
  });
});
