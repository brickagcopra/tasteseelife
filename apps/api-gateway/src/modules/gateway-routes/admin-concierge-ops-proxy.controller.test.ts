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

import { AdminConciergeOpsProxyController } from './admin-concierge-ops-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const NOW_ISO = '2026-06-01T09:00:00.000Z';

function requestWithCtx(userId = 'usr_ops'): RequestWithContext {
  return {
    requestContext: {
      userId,
      mfaVerified: true,
      roles: [
        {
          name: 'concierge_lead',
          permissions: ['concierge:read', 'concierge:write'],
          scope: { type: 'global' },
        },
      ],
      tenantScope: { type: 'global' },
    },
    headers: { 'x-trace-id': 'tr_test_001' },
  } as unknown as RequestWithContext;
}

const TICKET = {
  id: 'tk_1',
  householdId: 'hh_1',
  kind: 'holiday_dinner' as const,
  status: 'open' as const,
  subject: 'Thanksgiving supper',
  body: 'Small traditional turkey dinner.',
  requestedDate: null,
  partySize: null,
  theme: null,
  slaDueAt: NOW_ISO,
  assignedToUserId: null,
  escalationPath: 'standard' as const,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

const NOTE = {
  id: 'note_1',
  ticketId: 'tk_1',
  authorUserId: 'usr_ops',
  body: 'Reached out to confirm the guest count.',
  createdAt: NOW_ISO,
};

const VALID_LIST_RESPONSE = { tickets: [TICKET] };
const VALID_DETAIL_RESPONSE = { ticket: TICKET, notes: [NOTE] };
const VALID_TRANSITION_RESPONSE = { ticket: { ...TICKET, status: 'in_progress' as const } };
const VALID_ESCALATE_RESPONSE = {
  ticket: { ...TICKET, status: 'escalated' as const, escalationPath: 'trust_safety' as const },
};
const VALID_NOTE_RESPONSE = { note: NOTE };

function buildController(stub: StubDownstreamClient): AdminConciergeOpsProxyController {
  return new AdminConciergeOpsProxyController(stub as unknown as DownstreamHttpClient);
}

function ok(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

// ─────────────────────────────────────────────────────────────────────
// listQueue()
// ─────────────────────────────────────────────────────────────────────

describe('AdminConciergeOpsProxyController.listQueue', () => {
  it('forwards the GET with an allow-listed query string', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);

    const response = await controller.listQueue(
      {
        status: 'escalated',
        escalationPath: 'trust_safety',
        kind: 'memory_meal',
        householdId: 'hh_9',
        limit: '25',
      },
      requestWithCtx(),
    );

    expect(response.tickets).toHaveLength(1);
    expect(stub.lastOptions?.service).toBe('concierge');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.path).toContain('/api/v1/admin/concierge/tickets?');
    expect(stub.lastOptions?.path).toContain('status=escalated');
    expect(stub.lastOptions?.path).toContain('escalationPath=trust_safety');
    expect(stub.lastOptions?.path).toContain('kind=memory_meal');
    expect(stub.lastOptions?.path).toContain('householdId=hh_9');
    expect(stub.lastOptions?.path).toContain('limit=25');
    expect(stub.lastOptions?.traceId).toBe('tr_test_001');
  });

  it('defaults the limit when no query is supplied', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);
    await controller.listQueue({}, requestWithCtx());
    expect(stub.lastOptions?.path).toContain('limit=50');
  });

  it('rejects a malformed query with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);
    await expect(controller.listQueue({ status: 'nope' }, requestWithCtx())).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(stub.lastOptions).toBeNull();
  });

  it('throws 401 when no request context is attached', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.listQueue({}, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps a contract-violating downstream body to 502', async () => {
    const stub = new StubDownstreamClient(ok({ wrong: 'shape' }));
    const controller = buildController(stub);
    await expect(controller.listQueue({}, requestWithCtx())).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('maps timeout to 504 and not_configured to 503', async () => {
    const timeout = buildController(new StubDownstreamClient({ kind: 'timeout' }));
    await expect(timeout.listQueue({}, requestWithCtx())).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
    const notConfigured = buildController(
      new StubDownstreamClient({ kind: 'not_configured', service: 'concierge' }),
    );
    await expect(notConfigured.listQueue({}, requestWithCtx())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// getTicket()
// ─────────────────────────────────────────────────────────────────────

describe('AdminConciergeOpsProxyController.getTicket', () => {
  it('forwards the GET and returns the detail', async () => {
    const stub = new StubDownstreamClient(ok(VALID_DETAIL_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.getTicket('tk_1', requestWithCtx());
    expect(response.ticket.id).toBe('tk_1');
    expect(response.notes).toHaveLength(1);
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/concierge/tickets/tk_1');
  });

  it('url-encodes the ticketId (path-traversal defence)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_DETAIL_RESPONSE));
    const controller = buildController(stub);
    await controller.getTicket('tk/../admin', requestWithCtx());
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/concierge/tickets/tk%2F..%2Fadmin');
  });

  it('forwards a downstream 404 verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 404,
      body: { type: 'about:blank', title: 'Not Found', status: 404, detail: 'gone' },
      setCookies: [],
    });
    const controller = buildController(stub);
    await expect(controller.getTicket('nope', requestWithCtx())).rejects.toMatchObject({
      status: 404,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// transition()
// ─────────────────────────────────────────────────────────────────────

describe('AdminConciergeOpsProxyController.transition', () => {
  it('forwards the POST + body + Idempotency-Key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_TRANSITION_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.transition(
      'tk_1',
      { targetStatus: 'in_progress', note: 'Starting.' },
      'idem-9',
      requestWithCtx(),
    );
    expect(response.ticket.status).toBe('in_progress');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/concierge/tickets/tk_1/transition');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-9');
    expect(stub.lastOptions?.body).toEqual({ targetStatus: 'in_progress', note: 'Starting.' });
  });

  it('rejects a malformed body with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_TRANSITION_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.transition('tk_1', { targetStatus: 'nope' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('forwards a downstream 409 (invalid transition) verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 409,
      body: { type: 'about:blank', title: 'Conflict', status: 409, detail: 'bad move' },
      setCookies: [],
    });
    const controller = buildController(stub);
    await expect(
      controller.transition('tk_1', { targetStatus: 'resolved' }, undefined, requestWithCtx()),
    ).rejects.toMatchObject({ status: 409 });
  });
});

// ─────────────────────────────────────────────────────────────────────
// escalate()
// ─────────────────────────────────────────────────────────────────────

describe('AdminConciergeOpsProxyController.escalate', () => {
  it('forwards the POST + body + Idempotency-Key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_ESCALATE_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.escalate(
      'tk_1',
      { escalationPath: 'trust_safety', note: 'Welfare concern.' },
      'idem-10',
      requestWithCtx(),
    );
    expect(response.ticket.escalationPath).toBe('trust_safety');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/concierge/tickets/tk_1/escalate');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-10');
  });

  it('rejects `standard` as an escalation target with 400', async () => {
    const stub = new StubDownstreamClient(ok(VALID_ESCALATE_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.escalate('tk_1', { escalationPath: 'standard' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// addNote()
// ─────────────────────────────────────────────────────────────────────

describe('AdminConciergeOpsProxyController.addNote', () => {
  it('forwards the POST + body + Idempotency-Key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_NOTE_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.addNote(
      'tk_1',
      { body: 'Confirmed with the chef.' },
      'idem-11',
      requestWithCtx(),
    );
    expect(response.note.id).toBe('note_1');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/concierge/tickets/tk_1/notes');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-11');
    expect(stub.lastOptions?.body).toEqual({ body: 'Confirmed with the chef.' });
  });

  it('rejects an empty note body with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_NOTE_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.addNote('tk_1', { body: '   ' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('maps a network_error to 502', async () => {
    const stub = new StubDownstreamClient({ kind: 'network_error', detail: 'ECONNREFUSED' });
    const controller = buildController(stub);
    await expect(
      controller.addNote('tk_1', { body: 'hi' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});
