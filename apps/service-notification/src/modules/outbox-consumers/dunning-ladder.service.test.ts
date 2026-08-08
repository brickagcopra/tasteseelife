import {
  BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_CODE,
  type DispatchNotificationRequest,
} from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../config/env';

import type { BillingContactsClient } from './clients/billing-contacts.client';
import { DunningLadderService } from './dunning-ladder.service';
import { DunningMetrics } from './dunning-metrics';
import type { DunningRung } from './dunning-rung';
import type { DispatchOrchestratorService } from '../dispatch/services/dispatch-orchestrator.service';

const SEND_RUNG: DunningRung = {
  kind: 'send',
  templateCode: BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_CODE,
  variables: { appName: 'Taste & See', billingUrl: 'https://app.example.com/billing/invoices' },
};

function makeService(
  opts: {
    payerUserIds?: string[];
    ownerUserIds?: string[];
    contacts?: Array<{ userId: string; email: string; status: string }>;
  } = {},
) {
  const resolveHouseholdPayers = vi.fn(async () =>
    opts.payerUserIds === undefined
      ? [{ householdId: 'hh_1', payerUserIds: ['usr_a'] }]
      : opts.payerUserIds.length === 0
        ? []
        : [{ householdId: 'hh_1', payerUserIds: opts.payerUserIds }],
  );
  const resolveProviderOwners = vi.fn(async () =>
    opts.ownerUserIds === undefined
      ? [{ providerId: 'prov_1', ownerUserId: 'usr_a' }]
      : opts.ownerUserIds.map((ownerUserId, i) => ({
          providerId: `prov_${i + 1}`,
          ownerUserId,
        })),
  );
  const resolveRecipientContacts = vi.fn(
    async () => opts.contacts ?? [{ userId: 'usr_a', email: 'a@example.com', status: 'active' }],
  );
  const dispatch = vi.fn(async (_request: DispatchNotificationRequest) => ({
    dispatch: {},
    replayed: false,
  }));

  const env = {
    DUNNING_APP_NAME: 'Taste & See',
    EMAIL_VERIFICATION_URL_BASE: 'http://localhost:3000/verify-email',
    EMAIL_VERIFICATION_NOTIFICATIONS_ENABLED: true,
    DUNNING_BILLING_URL: 'https://app.example.com/billing/invoices',
  } as unknown as Env;

  // The REAL metrics class — a no-op meter costs nothing and constructing
  // it asserts the instrument actually builds. Spying on `record` pins the
  // label set without a hand-written double that could drift from it.
  const metrics = new DunningMetrics();
  const recordSpy = vi.spyOn(metrics, 'record');

  const service = new DunningLadderService(
    {
      resolveHouseholdPayers,
      resolveProviderOwners,
      resolveRecipientContacts,
    } as unknown as BillingContactsClient,
    { dispatch } as unknown as DispatchOrchestratorService,
    metrics,
    env,
  );
  /** The nth dispatch request, or a loud failure — never an `undefined` read. */
  const nthRequest = (n: number): DispatchNotificationRequest => {
    const call = dispatch.mock.calls[n];
    if (call === undefined) throw new Error(`no dispatch call at index ${n}`);
    return call[0];
  };

  return {
    service,
    resolveHouseholdPayers,
    resolveProviderOwners,
    resolveRecipientContacts,
    dispatch,
    nthRequest,
    recordSpy,
  };
}

const baseInput = {
  rung: SEND_RUNG,
  eventId: 'evt_1',
  eventName: 'subscription.payment_failed',
  customerId: 'hh_1',
  customerGroup: 'family',
  subscriptionId: 'sub_1',
};

describe('DunningLadderService.deliver', () => {
  it('dispatches one email per active payer', async () => {
    const { service, dispatch } = makeService({
      payerUserIds: ['usr_a', 'usr_b'],
      contacts: [
        { userId: 'usr_a', email: 'a@example.com', status: 'active' },
        { userId: 'usr_b', email: 'b@example.com', status: 'active' },
      ],
    });

    const outcome = await service.deliver(baseInput);

    expect(outcome).toEqual({ kind: 'sent', recipientCount: 2, replayedCount: 0 });
    expect(dispatch).toHaveBeenCalledTimes(2);
    // Distinct idempotency keys — an event-only key would let the first
    // payer's dispatch suppress the second's.
    const keys = dispatch.mock.calls.map((c) => c[0].idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });

  it('honours quiet hours — no billing email bypasses them', async () => {
    const { service, nthRequest } = makeService();
    await service.deliver(baseInput);
    expect(nthRequest(0).bypassQuietHours).toBe(false);
  });

  it('sends the rung the caller chose, with its variables verbatim', async () => {
    const { service, nthRequest } = makeService();
    await service.deliver(baseInput);
    const request = nthRequest(0);
    expect(request.templateCode).toBe(BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_CODE);
    expect(request.channel).toBe('email');
    expect(request.category).toBe('transactional');
    expect(request.variables).toEqual(SEND_RUNG.kind === 'send' ? SEND_RUNG.variables : {});
  });

  it('returns the rung skip WITHOUT resolving a recipient', async () => {
    // A routine renewal is by far the highest-volume event of the three; it
    // must not cost a household lookup and an identity lookup apiece.
    const { service, resolveHouseholdPayers, dispatch } = makeService();
    const outcome = await service.deliver({
      ...baseInput,
      rung: { kind: 'skip', reason: 'routine_renewal' },
    });

    expect(outcome).toEqual({ kind: 'skipped_rung', reason: 'routine_renewal' });
    expect(resolveHouseholdPayers).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('mails the owner of a provider subscription (TS-042-followup-3a1a)', async () => {
    // This assertion used to say the opposite: before the provider resolver
    // existed, a provider whose card failed was counted `skipped_customer_group`
    // and told nothing at all. Same property, opposite sign — the customer
    // must be reached, and the route that reaches them is not the household
    // one.
    const { service, resolveProviderOwners, resolveHouseholdPayers, dispatch } = makeService();

    const outcome = await service.deliver({
      ...baseInput,
      customerGroup: 'provider',
      customerId: 'prov_1',
    });

    expect(outcome).toEqual({ kind: 'sent', recipientCount: 1, replayedCount: 0 });
    expect(resolveProviderOwners).toHaveBeenCalledWith(['prov_1']);
    // Asking the household route for a provider id would return a 200 with
    // an empty list — the silent failure TS-042-followup-3a2a exists to
    // prevent, and it must not come back in through the new branch.
    expect(resolveHouseholdPayers).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('reports no_payer when a provider id resolves to nothing', async () => {
    // A dangling provider reference in a subscription: a paying customer
    // nobody can reach. A named outcome, never a quiet return.
    const { service, resolveRecipientContacts, dispatch } = makeService({
      ownerUserIds: [],
    });

    const outcome = await service.deliver({
      ...baseInput,
      customerGroup: 'provider',
      customerId: 'prov_missing',
    });

    expect(outcome).toEqual({ kind: 'no_payer' });
    expect(resolveRecipientContacts).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('still skips a customer group with no resolver at all', async () => {
    // `academy`'s `customerId` is already a userId, so it needs no resolver
    // hop — just a decision about whether academy subscriptions dun. Left
    // unsupported deliberately, and the outcome says so rather than
    // guessing.
    const { service, resolveHouseholdPayers, resolveProviderOwners, dispatch } = makeService();
    const outcome = await service.deliver({ ...baseInput, customerGroup: 'academy' });

    expect(outcome).toEqual({ kind: 'skipped_customer_group', customerGroup: 'academy' });
    expect(resolveHouseholdPayers).not.toHaveBeenCalled();
    expect(resolveProviderOwners).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('reports no_payer as an outcome rather than returning quietly', async () => {
    const { service, resolveRecipientContacts, dispatch } = makeService({ payerUserIds: [] });
    const outcome = await service.deliver(baseInput);

    expect(outcome).toEqual({ kind: 'no_payer' });
    expect(resolveRecipientContacts).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('skips a suspended account but still mails the active one', async () => {
    const { service, nthRequest } = makeService({
      payerUserIds: ['usr_a', 'usr_b'],
      contacts: [
        { userId: 'usr_a', email: 'a@example.com', status: 'suspended' },
        { userId: 'usr_b', email: 'b@example.com', status: 'active' },
      ],
    });

    const outcome = await service.deliver(baseInput);

    expect(outcome).toEqual({ kind: 'sent', recipientCount: 1, replayedCount: 0 });
    expect(nthRequest(0).recipientUserId).toBe('usr_b');
  });

  it('reports no_deliverable_contact when every payer account is inactive', async () => {
    const { service, dispatch } = makeService({
      payerUserIds: ['usr_a'],
      contacts: [{ userId: 'usr_a', email: 'a@example.com', status: 'deactivated' }],
    });

    const outcome = await service.deliver(baseInput);

    expect(outcome).toEqual({ kind: 'no_deliverable_contact', payerCount: 1 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('counts a replayed dispatch separately from a fresh send', async () => {
    const { service, dispatch } = makeService();
    dispatch.mockResolvedValueOnce({ dispatch: {}, replayed: true });

    const outcome = await service.deliver(baseInput);

    expect(outcome).toEqual({ kind: 'sent', recipientCount: 1, replayedCount: 1 });
  });

  it('lets a resolver failure propagate so the SDK redelivers', async () => {
    // A brief service-household outage must not consume the event and drop
    // the family's notification.
    const { service } = makeService();
    const boom = new DunningLadderService(
      {
        resolveHouseholdPayers: vi.fn(async () => {
          throw new Error('household-billing-contacts: HTTP 503');
        }),
        resolveRecipientContacts: vi.fn(),
      } as unknown as BillingContactsClient,
      { dispatch: vi.fn() } as unknown as DispatchOrchestratorService,
      new DunningMetrics(),
      { DUNNING_APP_NAME: 'x', DUNNING_BILLING_URL: 'https://x.test' } as unknown as Env,
    );
    void service;

    await expect(boom.deliver(baseInput)).rejects.toThrow('HTTP 503');
  });

  describe('metrics', () => {
    it('records EVERY outcome, including the silent ones', async () => {
      // `no_payer` and `no_deliverable_contact` are precisely the outcomes a
      // log-only implementation buries: nobody is mailed, nothing is broken,
      // and the family's care lapses on schedule.
      const cases: Array<[Parameters<typeof makeService>[0], string]> = [
        [{ payerUserIds: [] }, 'no_payer'],
        [
          {
            payerUserIds: ['usr_a'],
            contacts: [{ userId: 'usr_a', email: 'a@example.com', status: 'deactivated' }],
          },
          'no_deliverable_contact',
        ],
        [{}, 'sent'],
      ];

      for (const [opts, expected] of cases) {
        const { service, recordSpy } = makeService(opts);
        await service.deliver(baseInput);
        expect(recordSpy, expected).toHaveBeenCalledTimes(1);
        expect(recordSpy.mock.calls[0]?.[0].kind).toBe(expected);
      }
    });

    it('labels a skip with the `none` template code, never an absent label', async () => {
      // An absent label makes the skip series a different shape from the send
      // series, and PromQL joins across the two stop working.
      const { service, recordSpy } = makeService();
      await service.deliver({ ...baseInput, rung: { kind: 'skip', reason: 'routine_renewal' } });
      expect(recordSpy).toHaveBeenCalledWith(
        { kind: 'skipped_rung', reason: 'routine_renewal' },
        null,
      );
    });

    it('carries the template code on a send so the SUSPENDED email is separately alertable', async () => {
      const { service, recordSpy } = makeService();
      await service.deliver(baseInput);
      expect(recordSpy.mock.calls[0]?.[1]).toBe(BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_CODE);
    });

    it('counts EVENTS not recipients — a two-payer household still adds one', async () => {
      const { service, recordSpy } = makeService({
        payerUserIds: ['usr_a', 'usr_b'],
        contacts: [
          { userId: 'usr_a', email: 'a@example.com', status: 'active' },
          { userId: 'usr_b', email: 'b@example.com', status: 'active' },
        ],
      });
      await service.deliver(baseInput);
      expect(recordSpy).toHaveBeenCalledTimes(1);
    });
  });
});
