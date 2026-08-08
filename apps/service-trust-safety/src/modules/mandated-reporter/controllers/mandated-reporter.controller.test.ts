import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { IDEMPOTENT_METADATA } from '@taste-and-see/nest-idempotency';
import { describe, expect, it, vi } from 'vitest';

import type {
  MandatedReporterCaseRow,
  MandatedReporterCaseSummaryRow,
} from '../repositories/mandated-reporter.repository';
import { MandatedReporterService } from '../services/mandated-reporter.service';
import { MandatedReporterController } from './mandated-reporter.controller';

const T0 = new Date('2026-07-24T12:00:00.000Z');

function buildRow(overrides: Partial<MandatedReporterCaseRow> = {}): MandatedReporterCaseRow {
  return {
    id: 'mrc_1',
    incidentId: 'inc_1',
    stateCode: 'NY',
    status: 'screening',
    openedByUserId: 'user_ops_1',
    openedAt: T0,
    statutoryDueAt: new Date('2026-07-25T12:00:00.000Z'),
    filedAt: null,
    filingReference: null,
    determinationNotes: null,
    reviewerUserId: null,
    reviewedAt: null,
    reviewerNotes: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function buildSummaryRow(
  overrides: Partial<MandatedReporterCaseSummaryRow> = {},
): MandatedReporterCaseSummaryRow {
  const {
    determinationNotes: _determinationNotes,
    reviewerNotes: _reviewerNotes,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...summary
  } = buildRow();
  return { ...summary, ...overrides };
}

interface FakeService {
  openCase: ReturnType<typeof vi.fn>;
  advance: ReturnType<typeof vi.fn>;
  getCaseForIncident: ReturnType<typeof vi.fn>;
  listCases: ReturnType<typeof vi.fn>;
}

function buildController(overrides: Partial<FakeService> = {}): {
  controller: MandatedReporterController;
  service: FakeService;
} {
  const service: FakeService = {
    openCase: vi.fn(async (): Promise<MandatedReporterCaseRow> => buildRow()),
    advance: vi.fn(async (): Promise<MandatedReporterCaseRow> => buildRow({ status: 'filed' })),
    getCaseForIncident: vi.fn(async (): Promise<MandatedReporterCaseRow | null> => buildRow()),
    listCases: vi.fn(async (): Promise<MandatedReporterCaseSummaryRow[]> => [buildSummaryRow()]),
    ...overrides,
  };
  return {
    controller: new MandatedReporterController(service as unknown as MandatedReporterService),
    service,
  };
}

/** A staff token carrying an explicit permission set at global scope. */
function staffRequest(
  permissions: readonly string[],
  userId = 'user_ops_1',
  headers: Record<string, string> = {},
): RequestWithContext {
  const ctx: RequestContext = {
    userId,
    mfaVerified: true,
    roles: [
      { name: 'trust_safety_operator', scope: { type: 'global' }, permissions },
    ] as unknown as RequestContext['roles'],
    tenantScope: { type: 'global' },
  };
  return {
    requestContext: ctx,
    ip: '203.0.113.7',
    headers: { 'user-agent': 'ops-console/1.0', ...headers },
  } as unknown as RequestWithContext;
}

const OPEN_BODY = { incidentId: 'inc_1', stateCode: 'NY' } as const;

describe('MandatedReporterController — permission gating', () => {
  it.each([
    ['open', (c: MandatedReporterController, r: RequestWithContext) => c.open(OPEN_BODY, r)],
    [
      'advance',
      (c: MandatedReporterController, r: RequestWithContext) =>
        c.advance('mrc_1', { to: 'not_reportable' }, r),
    ],
    [
      'getByIncident',
      (c: MandatedReporterController, r: RequestWithContext) => c.getByIncident('inc_1', r),
    ],
    ['list', (c: MandatedReporterController, r: RequestWithContext) => c.list({ limit: 50 }, r)],
  ])(
    're-checks trust_safety:write downstream on %s — a token without it gets 403',
    async (_name, call) => {
      const { controller, service } = buildController();

      await expect(call(controller, staffRequest(['trust_safety:read']))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(service.openCase).not.toHaveBeenCalled();
      expect(service.advance).not.toHaveBeenCalled();
      expect(service.getCaseForIncident).not.toHaveBeenCalled();
      expect(service.listCases).not.toHaveBeenCalled();
    },
  );

  it('rejects an actor with no permissions at all with 403', async () => {
    const { controller } = buildController();

    await expect(controller.open(OPEN_BODY, staffRequest([]))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('throws 401 when no request context is attached', async () => {
    const { controller } = buildController();

    await expect(
      controller.open(OPEN_BODY, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('MandatedReporterController.open', () => {
  it('stamps the opener from the verified token, never the body', async () => {
    // Half of the four-eyes rule rides on this id. A body-supplied value
    // would let one person be both opener and reviewer.
    const { controller, service } = buildController();

    await controller.open(OPEN_BODY, staffRequest(['trust_safety:write'], 'user_ops_42'));

    expect(service.openCase).toHaveBeenCalledWith(
      expect.objectContaining({ openedByUserId: 'user_ops_42' }),
    );
  });

  it('passes an audit actor context built from the token and request', async () => {
    const { controller, service } = buildController();

    await controller.open(
      OPEN_BODY,
      staffRequest(['trust_safety:write'], 'user_ops_42', { 'x-request-id': 'req_abc' }),
    );

    const passed = service.openCase.mock.calls[0]?.[0] as { audit: Record<string, unknown> };
    expect(passed.audit).toMatchObject({
      actorUserId: 'user_ops_42',
      actorTenantScopeType: 'global',
      ip: '203.0.113.7',
      userAgent: 'ops-console/1.0',
      requestId: 'req_abc',
    });
  });

  it('omits determinationNotes rather than passing undefined when absent', async () => {
    const { controller, service } = buildController();

    await controller.open(OPEN_BODY, staffRequest(['trust_safety:write']));

    const passed = service.openCase.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('determinationNotes' in passed).toBe(false);
  });

  it('returns the case projected through the contract schema', async () => {
    const { controller } = buildController();

    const response = await controller.open(OPEN_BODY, staffRequest(['trust_safety:write']));

    expect(response.case).toMatchObject({
      id: 'mrc_1',
      incidentId: 'inc_1',
      stateCode: 'NY',
      status: 'screening',
      statutoryDueAt: '2026-07-25T12:00:00.000Z',
    });
  });

  it('is marked @Idempotent so a double-submit cannot open two cases', async () => {
    expect(
      Reflect.getMetadata(IDEMPOTENT_METADATA, MandatedReporterController.prototype.open),
    ).toBeDefined();
  });
});

describe('MandatedReporterController.advance', () => {
  it('stamps the actor from the token — the reviewer identity the four-eyes check uses', async () => {
    const { controller, service } = buildController();

    await controller.advance(
      'mrc_1',
      { to: 'signed_off' },
      staffRequest(['trust_safety:write'], 'user_ops_2'),
    );

    expect(service.advance).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: 'mrc_1', to: 'signed_off', actorUserId: 'user_ops_2' }),
    );
  });

  it('forwards the filing reference on a filing transition', async () => {
    const { controller, service } = buildController();

    await controller.advance(
      'mrc_1',
      { to: 'filed', filingReference: 'APS-2026-0001' },
      staffRequest(['trust_safety:write']),
    );

    expect(service.advance).toHaveBeenCalledWith(
      expect.objectContaining({ filingReference: 'APS-2026-0001' }),
    );
  });

  it('is marked @Idempotent', () => {
    expect(
      Reflect.getMetadata(IDEMPOTENT_METADATA, MandatedReporterController.prototype.advance),
    ).toBeDefined();
  });
});

describe('MandatedReporterController.getByIncident', () => {
  it('returns the case when one exists', async () => {
    const { controller } = buildController();

    const response = await controller.getByIncident('inc_1', staffRequest(['trust_safety:write']));

    expect(response.case.incidentId).toBe('inc_1');
  });

  it('404s when triage never routed the incident into the pathway', async () => {
    const { controller } = buildController({
      getCaseForIncident: vi.fn(async () => null),
    });

    await expect(
      controller.getByIncident('inc_none', staffRequest(['trust_safety:write'])),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('MandatedReporterController.list (TS-303c2a)', () => {
  it('returns the queue', async () => {
    const { controller } = buildController();

    const response = await controller.list({ limit: 50 }, staffRequest(['trust_safety:write']));

    expect(response.cases).toHaveLength(1);
    expect(response.cases[0]?.id).toBe('mrc_1');
  });

  it('never emits the PHI-bearing notes fields on a list read', async () => {
    // The whole reason a separate summary shape exists. If someone widens the
    // repository projection back to CASE_SELECT, the response schema's
    // `.strict()` fails here rather than shipping a named senior's abuse
    // narrative to every row of the console (CLAUDE.md §3.9).
    const { controller } = buildController();

    const response = await controller.list({ limit: 50 }, staffRequest(['trust_safety:write']));

    expect(response.cases[0]).not.toHaveProperty('determinationNotes');
    expect(response.cases[0]).not.toHaveProperty('reviewerNotes');
  });

  it('forwards the status and stateCode filters to the service', async () => {
    const { controller, service } = buildController();

    await controller.list(
      { status: 'filing_prep', stateCode: 'CA', limit: 25 },
      staffRequest(['trust_safety:write']),
    );

    expect(service.listCases).toHaveBeenCalledWith({
      status: 'filing_prep',
      stateCode: 'CA',
      limit: 25,
    });
  });

  it('leaves the status filter undefined when absent — the service defaults to live work', async () => {
    const { controller, service } = buildController();

    await controller.list({ limit: 50 }, staffRequest(['trust_safety:write']));

    expect(service.listCases).toHaveBeenCalledWith({
      status: undefined,
      stateCode: undefined,
      limit: 50,
    });
  });

  it('serialises a null statutory deadline as null, not as a fabricated date', async () => {
    // An unestablished state window must render as "not established" in the
    // console, not as an invented deadline an operator might rely on.
    const { controller } = buildController({
      listCases: vi.fn(async () => [buildSummaryRow({ statutoryDueAt: null })]),
    });

    const response = await controller.list({ limit: 50 }, staffRequest(['trust_safety:write']));

    expect(response.cases[0]?.statutoryDueAt).toBeNull();
  });

  it('returns an empty queue as an empty array', async () => {
    const { controller } = buildController({ listCases: vi.fn(async () => []) });

    const response = await controller.list({ limit: 50 }, staffRequest(['trust_safety:write']));

    expect(response.cases).toEqual([]);
  });

  it('is NOT marked @Idempotent — it is a read', () => {
    expect(
      Reflect.getMetadata(IDEMPOTENT_METADATA, MandatedReporterController.prototype.list),
    ).toBeUndefined();
  });
});
