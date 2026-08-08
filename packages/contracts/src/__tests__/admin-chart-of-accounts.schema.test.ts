import { describe, expect, it } from 'vitest';

import {
  ADMIN_ACCOUNTS_ACTION_NOTE_MAX_LENGTH,
  ADMIN_ACCOUNTS_ACTIVE_REASONS,
  AdminAccountActiveStateSnapshotSchema,
  UpdateAccountActiveRequestSchema,
  UpdateAccountActiveResponseSchema,
  type Account,
  type AdminAccountActiveReason,
  type UpdateAccountActiveResponse,
} from '../http';

const NOW_ISO = '2026-05-18T12:00:00.000Z';

const sampleAccount: Account = {
  id: 'coa_cash',
  code: '1000',
  name: 'Cash',
  description: 'Operating bank + Stripe balance.',
  type: 'asset',
  parentId: null,
  normalBalance: 'debit',
  currency: 'USD',
  active: false,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

describe('UpdateAccountActiveRequestSchema', () => {
  it('accepts every documented reason', () => {
    for (const reason of ADMIN_ACCOUNTS_ACTIVE_REASONS) {
      const parsed = UpdateAccountActiveRequestSchema.safeParse({
        active: false,
        reason,
      });
      expect(parsed.success, `reason=${reason}`).toBe(true);
    }
  });

  it('accepts a note within the length cap', () => {
    const parsed = UpdateAccountActiveRequestSchema.safeParse({
      active: false,
      reason: 'chart_cleanup',
      note: 'Replaced by sub-account hierarchy added in TS-260.',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty note', () => {
    const parsed = UpdateAccountActiveRequestSchema.safeParse({
      active: false,
      reason: 'chart_cleanup',
      note: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a note past the length cap', () => {
    const parsed = UpdateAccountActiveRequestSchema.safeParse({
      active: false,
      reason: 'other',
      note: 'a'.repeat(ADMIN_ACCOUNTS_ACTION_NOTE_MAX_LENGTH + 1),
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown reason', () => {
    const parsed = UpdateAccountActiveRequestSchema.safeParse({
      active: false,
      reason: 'whatever',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing reason', () => {
    const parsed = UpdateAccountActiveRequestSchema.safeParse({
      active: false,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing active field', () => {
    const parsed = UpdateAccountActiveRequestSchema.safeParse({
      reason: 'chart_cleanup',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-boolean active field', () => {
    const parsed = UpdateAccountActiveRequestSchema.safeParse({
      active: 'false',
      reason: 'chart_cleanup',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    const parsed = UpdateAccountActiveRequestSchema.safeParse({
      active: false,
      reason: 'chart_cleanup',
      severity: 'high',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('AdminAccountActiveStateSnapshotSchema', () => {
  it('accepts a minimal active snapshot', () => {
    const parsed = AdminAccountActiveStateSnapshotSchema.safeParse({
      active: true,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects unknown fields (strict)', () => {
    const parsed = AdminAccountActiveStateSnapshotSchema.safeParse({
      active: true,
      retiredAt: NOW_ISO,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('UpdateAccountActiveResponseSchema', () => {
  const baseResponse: UpdateAccountActiveResponse = {
    account: sampleAccount,
    performedAt: NOW_ISO,
    performedByUserId: 'usr_admin',
    before: { active: true },
    after: { active: false },
    reason: 'chart_cleanup',
    note: 'Replaced by 1000.cash.stripe.',
  };

  it('round-trips a fully-populated response', () => {
    const parsed = UpdateAccountActiveResponseSchema.safeParse(baseResponse);
    expect(parsed.success).toBe(true);
  });

  it('accepts a null note', () => {
    const parsed = UpdateAccountActiveResponseSchema.safeParse({
      ...baseResponse,
      note: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects unknown fields (strict)', () => {
    const parsed = UpdateAccountActiveResponseSchema.safeParse({
      ...baseResponse,
      surface: 'admin',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a malformed performedAt timestamp', () => {
    const parsed = UpdateAccountActiveResponseSchema.safeParse({
      ...baseResponse,
      performedAt: 'not-a-date',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty performedByUserId', () => {
    const parsed = UpdateAccountActiveResponseSchema.safeParse({
      ...baseResponse,
      performedByUserId: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing before snapshot', () => {
    const { before: _omitted, ...rest } = baseResponse;
    const parsed = UpdateAccountActiveResponseSchema.safeParse(rest);
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown reason in the response shape', () => {
    const parsed = UpdateAccountActiveResponseSchema.safeParse({
      ...baseResponse,
      reason: 'archive' as AdminAccountActiveReason,
    });
    expect(parsed.success).toBe(false);
  });
});
