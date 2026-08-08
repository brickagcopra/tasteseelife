import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
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

import { ConciergeEmergencyProxyController } from './concierge-emergency-proxy.controller';

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
  headers: { 'x-trace-id': 'tr_test_emergency' },
} as unknown as RequestWithContext;

const EMERGENCY_TICKET = {
  id: 'tk_emergency_1',
  householdId: 'hh_1',
  kind: 'emergency_assistance' as const,
  status: 'escalated' as const,
  subject: 'Emergency assistance — Medical concern',
  body: "Mom isn't answering.",
  requestedDate: null,
  partySize: null,
  theme: null,
  slaDueAt: NOW_ISO,
  assignedToUserId: 'user_primary',
  escalationPath: 'emergency_on_call' as const,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

const VALID_BODY = { category: 'medical', note: "Mom isn't answering." };

function buildController(stub: StubDownstreamClient): ConciergeEmergencyProxyController {
  return new ConciergeEmergencyProxyController(stub as unknown as DownstreamHttpClient);
}

function ok(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 201, body, setCookies: [] };
}

describe('ConciergeEmergencyProxyController.trigger', () => {
  it('forwards a valid trigger and returns the created ticket', async () => {
    const stub = new StubDownstreamClient(ok({ ticket: EMERGENCY_TICKET }));
    const controller = buildController(stub);

    const response = await controller.trigger(VALID_BODY, 'idem-key-1', FAMILY_REQUEST);

    expect(response.ticket.id).toBe('tk_emergency_1');
    expect(response.ticket.kind).toBe('emergency_assistance');
    expect(stub.lastOptions?.service).toBe('concierge');
    expect(stub.lastOptions?.path).toBe('/api/v1/concierge/emergency');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_family');
    expect(stub.lastOptions?.traceId).toBe('tr_test_emergency');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-key-1');
  });

  it('forwards the parsed (validated) body and accepts a category-only trigger', async () => {
    const stub = new StubDownstreamClient(ok({ ticket: EMERGENCY_TICKET }));
    const controller = buildController(stub);

    await controller.trigger({ category: 'safety' }, undefined, FAMILY_REQUEST);

    expect(stub.lastOptions?.body).toMatchObject({ category: 'safety' });
    expect(stub.lastOptions?.idempotencyKey).toBeUndefined();
  });

  it('rejects an invalid body at the gateway with 400 (no downstream hop)', async () => {
    const stub = new StubDownstreamClient(ok({ ticket: EMERGENCY_TICKET }));
    const controller = buildController(stub);

    await expect(controller.trigger({}, undefined, FAMILY_REQUEST)).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(stub.lastOptions).toBeNull();
  });

  it('rejects an unknown category at the gateway with 400', async () => {
    const stub = new StubDownstreamClient(ok({ ticket: EMERGENCY_TICKET }));
    const controller = buildController(stub);

    await expect(
      controller.trigger({ category: 'fire' }, undefined, FAMILY_REQUEST),
    ).rejects.toMatchObject({ status: 400 });
    expect(stub.lastOptions).toBeNull();
  });

  it('throws 401 when no request context is attached', async () => {
    const stub = new StubDownstreamClient(ok({ ticket: EMERGENCY_TICKET }));
    const controller = buildController(stub);

    await expect(
      controller.trigger(VALID_BODY, undefined, {} as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('forwards a downstream 400 (non-household actor) verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 400,
      body: { type: 'about:blank', title: 'Bad Request', status: 400, detail: 'household-only' },
      setCookies: [],
    });
    const controller = buildController(stub);

    await expect(controller.trigger(VALID_BODY, undefined, FAMILY_REQUEST)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('maps a contract-violating downstream body to 502', async () => {
    const stub = new StubDownstreamClient(ok({ wrong: true }));
    const controller = buildController(stub);

    await expect(controller.trigger(VALID_BODY, undefined, FAMILY_REQUEST)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('maps a timeout to 504', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    const controller = buildController(stub);

    await expect(controller.trigger(VALID_BODY, undefined, FAMILY_REQUEST)).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
  });

  it('maps not_configured to 503', async () => {
    const stub = new StubDownstreamClient({ kind: 'not_configured', service: 'concierge' });
    const controller = buildController(stub);

    await expect(controller.trigger(VALID_BODY, undefined, FAMILY_REQUEST)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
