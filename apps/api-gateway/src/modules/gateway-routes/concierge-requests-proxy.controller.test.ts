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

import { ConciergeRequestsProxyController } from './concierge-requests-proxy.controller';

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
  headers: { 'x-trace-id': 'tr_test_003' },
} as unknown as RequestWithContext;

const TICKET = {
  id: 'tk_1',
  householdId: 'hh_1',
  kind: 'holiday_dinner' as const,
  status: 'assigned' as const,
  subject: 'Thanksgiving supper',
  body: 'A small traditional dinner.',
  requestedDate: '2026-11-26',
  partySize: 6,
  theme: 'Traditional',
  slaDueAt: NOW_ISO,
  assignedToUserId: 'user_primary',
  escalationPath: 'standard' as const,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

const VALID_BODY = {
  kind: 'holiday_dinner',
  subject: 'Thanksgiving supper',
  body: 'A small traditional dinner.',
  requestedDate: '2026-11-26',
  partySize: 6,
  theme: 'Traditional',
};

function buildController(stub: StubDownstreamClient): ConciergeRequestsProxyController {
  return new ConciergeRequestsProxyController(stub as unknown as DownstreamHttpClient);
}

function ok(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

describe('ConciergeRequestsProxyController.submit', () => {
  it('forwards a valid submission and returns the created ticket', async () => {
    const stub = new StubDownstreamClient(ok({ ticket: TICKET }));
    const controller = buildController(stub);

    const response = await controller.submit(VALID_BODY, 'idem-key-1', FAMILY_REQUEST);

    expect(response.ticket.id).toBe('tk_1');
    expect(stub.lastOptions?.service).toBe('concierge');
    expect(stub.lastOptions?.path).toBe('/api/v1/concierge/requests');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_family');
    expect(stub.lastOptions?.traceId).toBe('tr_test_003');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-key-1');
  });

  it('forwards the parsed (validated) body, not the raw input', async () => {
    const stub = new StubDownstreamClient(ok({ ticket: TICKET }));
    const controller = buildController(stub);

    await controller.submit(VALID_BODY, undefined, FAMILY_REQUEST);

    expect(stub.lastOptions?.body).toMatchObject({
      kind: 'holiday_dinner',
      subject: 'Thanksgiving supper',
    });
    expect(stub.lastOptions?.idempotencyKey).toBeUndefined();
  });

  it('rejects an invalid body at the gateway with 400 (no downstream hop)', async () => {
    const stub = new StubDownstreamClient(ok({ ticket: TICKET }));
    const controller = buildController(stub);

    await expect(
      controller.submit({ kind: 'custom_request' }, undefined, FAMILY_REQUEST),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('rejects a non-family-submittable kind at the gateway with 400', async () => {
    const stub = new StubDownstreamClient(ok({ ticket: TICKET }));
    const controller = buildController(stub);

    await expect(
      controller.submit(
        { kind: 'emergency_assistance', subject: 'help', body: 'help' },
        undefined,
        FAMILY_REQUEST,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(stub.lastOptions).toBeNull();
  });

  it('throws 401 when no request context is attached', async () => {
    const stub = new StubDownstreamClient(ok({ ticket: TICKET }));
    const controller = buildController(stub);

    await expect(
      controller.submit(VALID_BODY, undefined, {} as unknown as RequestWithContext),
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

    await expect(controller.submit(VALID_BODY, undefined, FAMILY_REQUEST)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('maps a contract-violating downstream body to 502', async () => {
    const stub = new StubDownstreamClient(ok({ wrong: true }));
    const controller = buildController(stub);

    await expect(controller.submit(VALID_BODY, undefined, FAMILY_REQUEST)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('maps a timeout to 504', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    const controller = buildController(stub);

    await expect(controller.submit(VALID_BODY, undefined, FAMILY_REQUEST)).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
  });

  it('maps not_configured to 503', async () => {
    const stub = new StubDownstreamClient({ kind: 'not_configured', service: 'concierge' });
    const controller = buildController(stub);

    await expect(controller.submit(VALID_BODY, undefined, FAMILY_REQUEST)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('ConciergeRequestsProxyController.listMine', () => {
  it('forwards to the downstream /me list with an allow-listed limit', async () => {
    const stub = new StubDownstreamClient(ok({ tickets: [TICKET] }));
    const controller = buildController(stub);

    const response = await controller.listMine({ limit: '10' }, FAMILY_REQUEST);

    expect(response.tickets).toHaveLength(1);
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.path).toBe('/api/v1/concierge/requests/me?limit=10');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_family');
  });

  it('rejects a smuggled query param at the gateway (strict schema, no downstream hop)', async () => {
    const stub = new StubDownstreamClient(ok({ tickets: [] }));
    const controller = buildController(stub);

    // A non-household id can't ride through to service-concierge — the
    // household is resolved from the token, and the strict query schema
    // rejects the unknown field outright.
    await expect(
      controller.listMine({ householdId: 'hh_other', limit: '5' }, FAMILY_REQUEST),
    ).rejects.toMatchObject({ status: 400 });
    expect(stub.lastOptions).toBeNull();
  });

  it('uses the default limit when omitted', async () => {
    const stub = new StubDownstreamClient(ok({ tickets: [] }));
    const controller = buildController(stub);

    await controller.listMine({}, FAMILY_REQUEST);

    expect(stub.lastOptions?.path).toBe('/api/v1/concierge/requests/me?limit=50');
  });

  it('rejects an out-of-bounds limit at the gateway with 400', async () => {
    const stub = new StubDownstreamClient(ok({ tickets: [] }));
    const controller = buildController(stub);

    await expect(controller.listMine({ limit: '99999' }, FAMILY_REQUEST)).rejects.toMatchObject({
      status: 400,
    });
    expect(stub.lastOptions).toBeNull();
  });

  it('throws 401 when no request context is attached', async () => {
    const stub = new StubDownstreamClient(ok({ tickets: [] }));
    const controller = buildController(stub);

    await expect(
      controller.listMine({}, {} as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps a timeout to 504', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    const controller = buildController(stub);

    await expect(controller.listMine({}, FAMILY_REQUEST)).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
  });
});
