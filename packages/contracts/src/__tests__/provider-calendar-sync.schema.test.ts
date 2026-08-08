import { describe, expect, it } from 'vitest';

import {
  DisconnectProviderCalendarResponseSchema,
  PROVIDER_CALENDAR_CONNECTION_STATUS_VALUES,
  PROVIDER_CALENDAR_EXTERNAL_BUSY_MAX,
  PROVIDER_CALENDAR_PROVIDER_VALUES,
  ProviderCalendarConnectionRecordSchema,
  ProviderCalendarConnectionSnapshotResponseSchema,
  ProviderCalendarConnectionStatusSchema,
  ProviderCalendarOAuthCallbackQuerySchema,
  ProviderCalendarProviderSchema,
  StartProviderCalendarConnectionResponseSchema,
  SyncProviderCalendarResponseSchema,
} from '../http/provider-calendar-sync.schema';

describe('ProviderCalendarProviderSchema', () => {
  it('accepts google', () => {
    expect(ProviderCalendarProviderSchema.safeParse('google').success).toBe(true);
  });
  it('rejects not-yet-supported providers', () => {
    expect(ProviderCalendarProviderSchema.safeParse('icloud').success).toBe(false);
    expect(ProviderCalendarProviderSchema.safeParse('outlook').success).toBe(false);
  });
  it('exposes the value list', () => {
    expect(PROVIDER_CALENDAR_PROVIDER_VALUES).toEqual(['google']);
  });
});

describe('ProviderCalendarConnectionStatusSchema', () => {
  it('accepts connected + error', () => {
    expect(ProviderCalendarConnectionStatusSchema.safeParse('connected').success).toBe(true);
    expect(ProviderCalendarConnectionStatusSchema.safeParse('error').success).toBe(true);
  });
  it('has no `disconnected` member (no row = not connected)', () => {
    expect(ProviderCalendarConnectionStatusSchema.safeParse('disconnected').success).toBe(false);
    expect(PROVIDER_CALENDAR_CONNECTION_STATUS_VALUES).toEqual(['connected', 'error']);
  });
});

describe('ProviderCalendarConnectionRecordSchema', () => {
  const valid = {
    providerId: 'prov_abc',
    calendarProvider: 'google' as const,
    status: 'connected' as const,
    connectedAccountEmail: 'chef@gmail.com',
    externalBusyCount: 5,
    lastSyncedAt: '2026-05-29T12:00:00.000Z',
    lastSyncError: null,
    createdAt: '2026-05-29T11:00:00.000Z',
    updatedAt: '2026-05-29T12:00:00.000Z',
  };

  it('accepts a valid record', () => {
    expect(ProviderCalendarConnectionRecordSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts nullable email / lastSyncedAt + an error message', () => {
    expect(
      ProviderCalendarConnectionRecordSchema.safeParse({
        ...valid,
        status: 'error',
        connectedAccountEmail: null,
        lastSyncedAt: null,
        lastSyncError: 'invalid_grant',
      }).success,
    ).toBe(true);
  });

  it('rejects an externalBusyCount over the cap', () => {
    expect(
      ProviderCalendarConnectionRecordSchema.safeParse({
        ...valid,
        externalBusyCount: PROVIDER_CALENDAR_EXTERNAL_BUSY_MAX + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects a negative externalBusyCount', () => {
    expect(
      ProviderCalendarConnectionRecordSchema.safeParse({ ...valid, externalBusyCount: -1 }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (`.strict()`) — no token columns may leak', () => {
    expect(
      ProviderCalendarConnectionRecordSchema.safeParse({ ...valid, refreshToken: 'secret' })
        .success,
    ).toBe(false);
  });
});

describe('StartProviderCalendarConnectionResponseSchema', () => {
  it('requires a URL', () => {
    expect(
      StartProviderCalendarConnectionResponseSchema.safeParse({
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=x',
      }).success,
    ).toBe(true);
    expect(
      StartProviderCalendarConnectionResponseSchema.safeParse({ authorizationUrl: 'not-a-url' })
        .success,
    ).toBe(false);
  });
});

describe('ProviderCalendarConnectionSnapshotResponseSchema', () => {
  it('accepts null (not connected)', () => {
    expect(
      ProviderCalendarConnectionSnapshotResponseSchema.safeParse({ connection: null }).success,
    ).toBe(true);
  });
  it('accepts a populated connection', () => {
    expect(
      ProviderCalendarConnectionSnapshotResponseSchema.safeParse({
        connection: {
          providerId: 'prov_abc',
          calendarProvider: 'google',
          status: 'connected',
          connectedAccountEmail: 'chef@gmail.com',
          externalBusyCount: 0,
          lastSyncedAt: null,
          lastSyncError: null,
          createdAt: '2026-05-29T11:00:00.000Z',
          updatedAt: '2026-05-29T11:00:00.000Z',
        },
      }).success,
    ).toBe(true);
  });
});

describe('SyncProviderCalendarResponseSchema', () => {
  it('accepts a valid response', () => {
    expect(
      SyncProviderCalendarResponseSchema.safeParse({
        providerId: 'prov_abc',
        externalBusyCount: 7,
        lastSyncedAt: '2026-05-29T12:00:00.000Z',
      }).success,
    ).toBe(true);
  });
  it('rejects a missing lastSyncedAt', () => {
    expect(
      SyncProviderCalendarResponseSchema.safeParse({ providerId: 'prov_abc', externalBusyCount: 7 })
        .success,
    ).toBe(false);
  });
});

describe('DisconnectProviderCalendarResponseSchema', () => {
  it('accepts the disconnected + idempotent-noop shapes', () => {
    expect(
      DisconnectProviderCalendarResponseSchema.safeParse({
        providerId: 'prov_abc',
        disconnected: true,
        removedExternalBusyCount: 4,
      }).success,
    ).toBe(true);
    expect(
      DisconnectProviderCalendarResponseSchema.safeParse({
        providerId: 'prov_abc',
        disconnected: false,
        removedExternalBusyCount: 0,
      }).success,
    ).toBe(true);
  });
});

describe('ProviderCalendarOAuthCallbackQuerySchema', () => {
  it('accepts the success shape (state + code)', () => {
    expect(
      ProviderCalendarOAuthCallbackQuerySchema.safeParse({ state: 'a.b', code: 'auth_code' })
        .success,
    ).toBe(true);
  });
  it('accepts the denied shape (state + error)', () => {
    expect(
      ProviderCalendarOAuthCallbackQuerySchema.safeParse({ state: 'a.b', error: 'access_denied' })
        .success,
    ).toBe(true);
  });
  it('rejects a missing state', () => {
    expect(ProviderCalendarOAuthCallbackQuerySchema.safeParse({ code: 'x' }).success).toBe(false);
  });
  it('rejects an oversized state (cap guard)', () => {
    expect(
      ProviderCalendarOAuthCallbackQuerySchema.safeParse({ state: 'a'.repeat(4096), code: 'x' })
        .success,
    ).toBe(false);
  });
});
