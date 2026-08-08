import {
  BadGatewayException,
  GatewayTimeoutException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';
import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';

import { ConciergeAssignmentsProxyController } from './concierge-assignments-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const NOW_ISO = '2026-06-01T09:00:00.000Z';

const FAMILY_REQUEST: RequestWithContext = {
  requestContext: {
    userId: 'usr_family',
    mfaVerified: false,
    roles: [
      { name: 'family_payer', permissions: [], scope: { type: 'household', householdId: 'hh_1' } },
    ],
    tenantScope: { type: 'household', householdId: 'hh_1' },
  },
  headers: { 'x-trace-id': 'tr_test_002' },
} as unknown as RequestWithContext;

const SNAPSHOT_WITH_ASSIGNMENT = {
  householdId: 'hh_1',
  assignment: {
    id: 'ca_1',
    householdId: 'hh_1',
    primaryConciergeUserId: 'user_primary',
    primaryConciergeDisplayName: 'Avery Concierge',
    backupConciergeUserId: null,
    backupConciergeDisplayName: null,
    status: 'active' as const,
    assignedByUserId: 'usr_admin',
    startedAt: NOW_ISO,
    endedAt: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  },
};

const SNAPSHOT_EMPTY = { householdId: 'hh_1', assignment: null };

function buildController(stub: StubDownstreamClient): ConciergeAssignmentsProxyController {
  return new ConciergeAssignmentsProxyController(stub as unknown as DownstreamHttpClient);
}

function ok(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

describe('ConciergeAssignmentsProxyController.getMine', () => {
  it('forwards to the downstream /me surface and returns the snapshot', async () => {
    const stub = new StubDownstreamClient(ok(SNAPSHOT_WITH_ASSIGNMENT));
    const controller = buildController(stub);

    const response = await controller.getMine(FAMILY_REQUEST);

    expect(response.assignment?.id).toBe('ca_1');
    expect(stub.lastOptions?.service).toBe('concierge');
    expect(stub.lastOptions?.path).toBe('/api/v1/concierge/assignments/me');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_family');
    expect(stub.lastOptions?.traceId).toBe('tr_test_002');
  });

  it('returns a null-assignment snapshot when the household has no concierge', async () => {
    const stub = new StubDownstreamClient(ok(SNAPSHOT_EMPTY));
    const controller = buildController(stub);

    const response = await controller.getMine(FAMILY_REQUEST);

    expect(response.assignment).toBeNull();
    expect(response.householdId).toBe('hh_1');
  });

  it('throws 401 when no request context is attached', async () => {
    const stub = new StubDownstreamClient(ok(SNAPSHOT_EMPTY));
    const controller = buildController(stub);

    await expect(controller.getMine({} as unknown as RequestWithContext)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('forwards a downstream 400 (non-household actor) verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 400,
      body: { type: 'about:blank', title: 'Bad Request', status: 400, detail: 'household-only' },
      setCookies: [],
    });
    const controller = buildController(stub);

    await expect(controller.getMine(FAMILY_REQUEST)).rejects.toMatchObject({ status: 400 });
  });

  it('maps a contract-violating downstream body to 502', async () => {
    const stub = new StubDownstreamClient(ok({ wrong: true }));
    const controller = buildController(stub);

    await expect(controller.getMine(FAMILY_REQUEST)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps a timeout to 504', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    const controller = buildController(stub);

    await expect(controller.getMine(FAMILY_REQUEST)).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
  });

  it('maps not_configured to 503', async () => {
    const stub = new StubDownstreamClient({ kind: 'not_configured', service: 'concierge' });
    const controller = buildController(stub);

    await expect(controller.getMine(FAMILY_REQUEST)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
