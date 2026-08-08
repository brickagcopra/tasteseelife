import type { PagerDutyClient, PagerDutyEnqueueInput } from '@taste-and-see/nest-pagerduty';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import type { IncidentRow } from '../repositories/incident.repository';
import { IncidentPagerMetrics } from './incident-pager-metrics';
import { IncidentPagerService } from './incident-pager.service';

const OPENED_AT = new Date('2026-07-24T12:00:00.000Z');

function buildIncident(overrides: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id: 'inc_1',
    householdId: 'hh_1',
    seniorId: 'sen_1',
    providerId: null,
    reporterUserId: 'user_family',
    source: 'family',
    category: 'welfare',
    severity: 'critical',
    status: 'open',
    description: 'Mom seemed frightened of her afternoon visitor.',
    openedAt: OPENED_AT,
    slaDueAt: new Date('2026-07-24T14:00:00.000Z'),
    resolvedAt: null,
    resolutionNotes: null,
    // TS-307a-followup-1 / TS-308c-followup-2 — the system-intake trail.
    // Null here: these fixtures are human-filed reports.
    sourceEventId: null,
    detector: null,
    systemFacts: null,
    createdAt: OPENED_AT,
    updatedAt: OPENED_AT,
    ...overrides,
  };
}

function build(
  env: Partial<Env> = {},
  result: Awaited<ReturnType<PagerDutyClient['enqueue']>> = {
    kind: 'sent',
    dedupKey: 'trust-safety-incident-inc_1',
  },
): {
  service: IncidentPagerService;
  enqueue: ReturnType<typeof vi.fn>;
  recordPage: ReturnType<typeof vi.spyOn>;
} {
  const enqueue = vi.fn(async (_input: PagerDutyEnqueueInput) => result);
  const client = { enqueue } as unknown as PagerDutyClient;
  // The real metrics class, not a double: its instruments come from
  // `getMeter`, which is a no-op meter when the SDK was never booted
  // (TS-306-followup-1c). Spying on the method is what lets the suite assert
  // the outcome label without a metrics backend.
  const metrics = new IncidentPagerMetrics();
  const recordPage = vi.spyOn(metrics, 'recordPage');
  return {
    service: new IncidentPagerService(client, env as Env, metrics),
    enqueue,
    recordPage,
  };
}

describe('IncidentPagerService.pageIfCritical — who gets paged', () => {
  it('pages on a critical incident', async () => {
    const { service, enqueue } = build();

    await service.pageIfCritical(buildIncident());

    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it.each(['high', 'medium', 'low'] as const)('does NOT page on %s', async (severity) => {
    // These have SLA budgets measured in hours and belong to the ops queue,
    // not to someone's phone at 3am. A pager that fires constantly is a
    // pager nobody answers.
    const { service, enqueue } = build();

    await service.pageIfCritical(buildIncident({ severity }));

    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('IncidentPagerService — payload', () => {
  it('keys the alert on the incident so a retry does not wake anyone twice', async () => {
    const { service, enqueue } = build();

    await service.pageIfCritical(buildIncident({ id: 'inc_42' }));

    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      dedupKey: 'trust-safety-incident-inc_42',
      severity: 'critical',
    });
  });

  it('NEVER carries the report description — that is a family account of a named senior', async () => {
    const { service, enqueue } = build();
    const incident = buildIncident({
      description: 'Mom seemed frightened of her afternoon visitor.',
    });

    await service.pageIfCritical(incident);

    const payload = enqueue.mock.calls[0]?.[0] as PagerDutyEnqueueInput;
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain('frightened');
    expect(Object.keys(payload.customDetails)).not.toContain('description');
  });

  it('carries operational identifiers and the deadline', async () => {
    const { service, enqueue } = build();

    await service.pageIfCritical(buildIncident());

    const payload = enqueue.mock.calls[0]?.[0] as PagerDutyEnqueueInput;
    expect(payload.customDetails).toMatchObject({
      incidentId: 'inc_1',
      category: 'welfare',
      severity: 'critical',
      source: 'family',
      slaDueAt: '2026-07-24T14:00:00.000Z',
    });
  });

  it('embeds the runbook URL when configured (TS-306 acceptance)', async () => {
    const { service, enqueue } = build({
      TRUST_SAFETY_RUNBOOK_URL: 'https://wiki.example.com/runbooks/trust-safety-critical',
    });

    await service.pageIfCritical(buildIncident());

    const payload = enqueue.mock.calls[0]?.[0] as PagerDutyEnqueueInput;
    expect(payload.customDetails['runbookUrl']).toBe(
      'https://wiki.example.com/runbooks/trust-safety-critical',
    );
  });

  it('omits the runbook key entirely when unconfigured, rather than sending a broken link', async () => {
    const { service, enqueue } = build({});

    await service.pageIfCritical(buildIncident());

    const payload = enqueue.mock.calls[0]?.[0] as PagerDutyEnqueueInput;
    expect('runbookUrl' in payload.customDetails).toBe(false);
  });

  it('builds a console deep link, tolerating a trailing slash on the base URL', async () => {
    const { service, enqueue } = build({
      TRUST_SAFETY_OPS_CONSOLE_BASE_URL: 'https://admin.example.com/',
    });

    await service.pageIfCritical(buildIncident({ id: 'inc_7' }));

    const payload = enqueue.mock.calls[0]?.[0] as PagerDutyEnqueueInput;
    expect(payload.customDetails['incidentUrl']).toBe(
      'https://admin.example.com/trust-safety/incidents/inc_7',
    );
  });
});

describe('IncidentPagerService — degradation', () => {
  it('never throws when paging is unconfigured', async () => {
    const { service } = build({}, { kind: 'skipped_unconfigured' });

    await expect(service.pageIfCritical(buildIncident())).resolves.toBeUndefined();
  });

  it('never throws when the page fails', async () => {
    // The incident is already durable with its SLA clock running; a paging
    // failure must not roll it back or fail the filer's request.
    const { service } = build({}, { kind: 'failed', detail: 'PagerDuty responded 500' });

    await expect(service.pageIfCritical(buildIncident())).resolves.toBeUndefined();
  });
});

describe('IncidentPagerService — metrics (TS-306-followup-1c)', () => {
  // The three outcomes fail in different directions and an alert has to be
  // able to tell them apart: a rising `failed` is an outage in the paging
  // path, a steady `skipped_unconfigured` is an environment that intends to
  // page and has no routing key, and a `sent` that stops moving while
  // critical incidents keep arriving is a broken call site.
  it.each([
    ['sent', { kind: 'sent', dedupKey: 'trust-safety-incident-inc_1' }],
    ['skipped_unconfigured', { kind: 'skipped_unconfigured' }],
    ['failed', { kind: 'failed', detail: 'PagerDuty responded 500' }],
  ] as const)('records the `%s` outcome', async (outcome, result) => {
    const { service, recordPage } = build({}, result);

    await service.pageIfCritical(buildIncident());

    expect(recordPage).toHaveBeenCalledTimes(1);
    expect(recordPage).toHaveBeenCalledWith(outcome);
  });

  it('records NOTHING for a non-critical incident — a page that was never attempted is not an outcome', async () => {
    // Counting a skipped `low` as `skipped_unconfigured` would make the
    // series read as a paging outage in an environment that is behaving
    // exactly as designed.
    const { service, recordPage } = build();

    await service.pageIfCritical(buildIncident({ severity: 'low' }));

    expect(recordPage).not.toHaveBeenCalled();
  });
});
