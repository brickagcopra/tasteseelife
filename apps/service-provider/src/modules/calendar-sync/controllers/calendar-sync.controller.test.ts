import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import type { TenantContextStore } from '@taste-and-see/nest-prisma-tenant-scope';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import {
  CalendarSyncService,
  type CalendarSyncFailure,
  type CompleteConnectionOutcome,
  type DisconnectOutcome,
  type SyncOutcome,
} from '../services/calendar-sync.service';
import type { ProviderCalendarConnectionRecord } from '@taste-and-see/contracts';

import { CalendarSyncController } from './calendar-sync.controller';

type Result<T> = { ok: true; value: T } | { ok: false; error: CalendarSyncFailure };

function buildService(
  overrides: Partial<Record<keyof CalendarSyncService, unknown>> = {},
): CalendarSyncService {
  return {
    startConnection: vi.fn(),
    completeConnection: vi.fn(),
    getConnectionByUserId: vi.fn(),
    syncProvider: vi.fn(),
    disconnect: vi.fn(),
    ...overrides,
  } as unknown as CalendarSyncService;
}

// Minimal exempt-frame store: run the callback directly.
const tenantStore = {
  run: (_frame: unknown, fn: () => unknown) => fn(),
} as unknown as TenantContextStore;

function authedRequest(userId = 'user_1'): RequestWithContext {
  return { requestContext: { userId } } as unknown as RequestWithContext;
}

function buildResponse(): {
  res: Response;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  redirect: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const redirect = vi.fn();
  const status = vi.fn(() => ({ json }) as unknown as Response);
  const res = { status, json, redirect } as unknown as Response;
  return { res, status, json, redirect };
}

describe('CalendarSyncController.startConnection', () => {
  it('returns the authorization URL on success', async () => {
    const service = buildService({
      startConnection: vi.fn(
        async (): Promise<Result<{ authorizationUrl: string }>> => ({
          ok: true,
          value: { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=x' },
        }),
      ),
    });
    const controller = new CalendarSyncController(service, tenantStore);
    const out = await controller.startConnection('prov_1', authedRequest());
    expect(out.authorizationUrl).toContain('accounts.google.com');
  });

  it('maps not_found → 404', async () => {
    const service = buildService({
      startConnection: vi.fn(
        async (): Promise<Result<never>> => ({
          ok: false,
          error: { reason: 'not_found', providerId: 'prov_1' },
        }),
      ),
    });
    const controller = new CalendarSyncController(service, tenantStore);
    await expect(controller.startConnection('prov_1', authedRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('maps not_configured → 503', async () => {
    const service = buildService({
      startConnection: vi.fn(
        async (): Promise<Result<never>> => ({ ok: false, error: { reason: 'not_configured' } }),
      ),
    });
    const controller = new CalendarSyncController(service, tenantStore);
    await expect(controller.startConnection('prov_1', authedRequest())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('throws 401 when the request carries no auth context', async () => {
    const controller = new CalendarSyncController(buildService(), tenantStore);
    await expect(
      controller.startConnection('prov_1', {} as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('CalendarSyncController.getMyConnection', () => {
  it('wraps the record (or null)', async () => {
    const record: ProviderCalendarConnectionRecord = {
      providerId: 'prov_1',
      calendarProvider: 'google',
      status: 'connected',
      connectedAccountEmail: 'chef@gmail.com',
      externalBusyCount: 2,
      lastSyncedAt: '2026-05-29T12:00:00.000Z',
      lastSyncError: null,
      createdAt: '2026-05-29T11:00:00.000Z',
      updatedAt: '2026-05-29T12:00:00.000Z',
    };
    const service = buildService({ getConnectionByUserId: vi.fn(async () => record) });
    const controller = new CalendarSyncController(service, tenantStore);
    const out = await controller.getMyConnection(authedRequest());
    expect(out.connection?.providerId).toBe('prov_1');
  });

  it('returns { connection: null } when not connected', async () => {
    const service = buildService({ getConnectionByUserId: vi.fn(async () => null) });
    const controller = new CalendarSyncController(service, tenantStore);
    const out = await controller.getMyConnection(authedRequest());
    expect(out.connection).toBeNull();
  });
});

describe('CalendarSyncController.syncCalendar', () => {
  it('returns the sync outcome on success', async () => {
    const service = buildService({
      syncProvider: vi.fn(
        async (): Promise<Result<SyncOutcome>> => ({
          ok: true,
          value: {
            providerId: 'prov_1',
            externalBusyCount: 3,
            lastSyncedAt: new Date('2026-05-29T12:00:00.000Z'),
          },
        }),
      ),
    });
    const controller = new CalendarSyncController(service, tenantStore);
    const out = await controller.syncCalendar('prov_1', authedRequest());
    expect(out.externalBusyCount).toBe(3);
    expect(out.lastSyncedAt).toBe('2026-05-29T12:00:00.000Z');
  });

  it('maps sync_auth_rejected → 409 (reconnect required)', async () => {
    const service = buildService({
      syncProvider: vi.fn(
        async (): Promise<Result<never>> => ({
          ok: false,
          error: { reason: 'sync_auth_rejected', providerId: 'prov_1' },
        }),
      ),
    });
    const controller = new CalendarSyncController(service, tenantStore);
    await expect(controller.syncCalendar('prov_1', authedRequest())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('CalendarSyncController.disconnectCalendar', () => {
  it('returns the disconnect outcome', async () => {
    const service = buildService({
      disconnect: vi.fn(
        async (): Promise<Result<DisconnectOutcome>> => ({
          ok: true,
          value: { providerId: 'prov_1', disconnected: true, removedExternalBusyCount: 4 },
        }),
      ),
    });
    const controller = new CalendarSyncController(service, tenantStore);
    const out = await controller.disconnectCalendar('prov_1', authedRequest());
    expect(out.disconnected).toBe(true);
    expect(out.removedExternalBusyCount).toBe(4);
  });
});

describe('CalendarSyncController.handleGoogleCallback', () => {
  it('302-redirects on a redirect outcome', async () => {
    const service = buildService({
      completeConnection: vi.fn(
        async (): Promise<CompleteConnectionOutcome> => ({
          kind: 'redirect',
          url: 'https://provider.example.com/dashboard/calendar?calendar=connected',
        }),
      ),
    });
    const controller = new CalendarSyncController(service, tenantStore);
    const { res, redirect } = buildResponse();
    await controller.handleGoogleCallback({ state: 'a.b', code: 'auth_code' }, res);
    expect(redirect).toHaveBeenCalledWith(302, expect.stringContaining('calendar=connected'));
  });

  it('answers 400 on an invalid_state outcome (no redirect)', async () => {
    const service = buildService({
      completeConnection: vi.fn(
        async (): Promise<CompleteConnectionOutcome> => ({ kind: 'invalid_state' }),
      ),
    });
    const controller = new CalendarSyncController(service, tenantStore);
    const { res, status, redirect } = buildResponse();
    await controller.handleGoogleCallback({ state: 'forged', code: 'x' }, res);
    expect(status).toHaveBeenCalledWith(400);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('answers 400 on a malformed callback query (missing state)', async () => {
    const completeConnection = vi.fn();
    const service = buildService({ completeConnection });
    const controller = new CalendarSyncController(service, tenantStore);
    const { res, status } = buildResponse();
    await controller.handleGoogleCallback({ code: 'x' }, res);
    expect(status).toHaveBeenCalledWith(400);
    // The service is never reached for a malformed query.
    expect(completeConnection).not.toHaveBeenCalled();
  });

  it('answers 503 on a not_configured outcome', async () => {
    const service = buildService({
      completeConnection: vi.fn(
        async (): Promise<CompleteConnectionOutcome> => ({ kind: 'not_configured' }),
      ),
    });
    const controller = new CalendarSyncController(service, tenantStore);
    const { res, status } = buildResponse();
    await controller.handleGoogleCallback({ state: 'a.b', code: 'x' }, res);
    expect(status).toHaveBeenCalledWith(503);
  });
});
