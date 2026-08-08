import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type { RequestWithContext } from '@taste-and-see/nest-auth';

import type {
  CreateOrFetchResult,
  ListAccountsInput,
  MintLinkResult,
  PayoutAccountRecord,
  PayoutAccountsListResult,
  PayoutAccountsService,
} from '../services/payout-accounts.service';

import { ConnectController } from './connect.controller';

function buildAccount(overrides: Partial<PayoutAccountRecord> = {}): PayoutAccountRecord {
  return {
    id: 'pa_1',
    providerId: 'pr_a',
    stripeAccountId: 'acct_stub_pr_a',
    country: 'US',
    defaultCurrency: 'USD',
    status: 'pending_onboarding',
    chargesEnabled: false,
    payoutsEnabled: false,
    detailsSubmitted: false,
    requirementsCurrentlyDue: [],
    requirementsPastDue: [],
    disabledReason: null,
    liveMode: false,
    createdAt: new Date('2026-05-16T12:00:00.000Z'),
    updatedAt: new Date('2026-05-16T12:00:00.000Z'),
    ...overrides,
  };
}

class FakeAccountsService {
  nextCreate: CreateOrFetchResult = {
    outcome: 'created',
    account: buildAccount(),
  };
  nextMint: MintLinkResult = {
    outcome: 'minted',
    link: {
      kind: 'account_onboarding',
      url: 'https://stub.example.test/account_onboarding/acct_stub_pr_a',
      expiresAt: new Date('2026-05-16T12:10:00.000Z'),
      liveMode: false,
    },
  };
  nextLookup: PayoutAccountRecord | null = buildAccount();
  nextList: PayoutAccountsListResult = { rows: [], nextCursor: null };
  lastListInput: ListAccountsInput | null = null;
  lastCreateInput: { providerId: string; country: string; defaultCurrency: string } | null = null;

  async createOrFetchForProvider(input: {
    providerId: string;
    country: string;
    defaultCurrency: string;
  }): Promise<CreateOrFetchResult> {
    this.lastCreateInput = input;
    return this.nextCreate;
  }

  async mintAccountLink(_input: unknown): Promise<MintLinkResult> {
    return this.nextMint;
  }

  async getByProvider(_id: string): Promise<PayoutAccountRecord | null> {
    return this.nextLookup;
  }

  async list(input: ListAccountsInput): Promise<PayoutAccountsListResult> {
    this.lastListInput = input;
    return this.nextList;
  }
}

function buildRequest(userId = 'pr_a'): RequestWithContext {
  const ctx: RequestContext = {
    userId,
    mfaVerified: false,
    roles: [],
    tenantScope: { type: 'global' },
  };
  return { requestContext: ctx } as unknown as RequestWithContext;
}

describe('ConnectController.createMyConnectAccount', () => {
  it('passes the body and request-derived providerId to the service', async () => {
    const svc = new FakeAccountsService();
    svc.nextCreate = {
      outcome: 'created',
      account: buildAccount({ providerId: 'pr_a' }),
    };
    const controller = new ConnectController(svc as unknown as PayoutAccountsService);

    const out = await controller.createMyConnectAccount({}, buildRequest('pr_a'));

    expect(out.outcome).toBe('created');
    expect(out.account.providerId).toBe('pr_a');
    expect(svc.lastCreateInput).toEqual({
      providerId: 'pr_a',
      country: 'US',
      defaultCurrency: 'USD',
    });
  });

  it('honours country + currency overrides', async () => {
    const svc = new FakeAccountsService();
    const controller = new ConnectController(svc as unknown as PayoutAccountsService);

    await controller.createMyConnectAccount(
      { country: 'US', defaultCurrency: 'USD' },
      buildRequest('pr_a'),
    );

    expect(svc.lastCreateInput).toEqual({
      providerId: 'pr_a',
      country: 'US',
      defaultCurrency: 'USD',
    });
  });

  it('returns the existing outcome on idempotent call', async () => {
    const svc = new FakeAccountsService();
    svc.nextCreate = { outcome: 'existing', account: buildAccount() };
    const controller = new ConnectController(svc as unknown as PayoutAccountsService);

    const out = await controller.createMyConnectAccount({}, buildRequest());
    expect(out.outcome).toBe('existing');
  });
});

describe('ConnectController.createMyOnboardingLink', () => {
  it('returns the minted link DTO', async () => {
    const svc = new FakeAccountsService();
    const controller = new ConnectController(svc as unknown as PayoutAccountsService);

    const out = await controller.createMyOnboardingLink(
      {
        refreshUrl: 'https://app.example.com/r',
        returnUrl: 'https://app.example.com/d',
      },
      buildRequest('pr_a'),
    );
    expect(out.kind).toBe('account_onboarding');
    expect(out.url).toContain('account_onboarding');
  });

  it('maps account_not_found to 404', async () => {
    const svc = new FakeAccountsService();
    svc.nextMint = { outcome: 'account_not_found' };
    const controller = new ConnectController(svc as unknown as PayoutAccountsService);

    await expect(
      controller.createMyOnboardingLink(
        {
          refreshUrl: 'https://app.example.com/r',
          returnUrl: 'https://app.example.com/d',
        },
        buildRequest('pr_missing'),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ConnectController.getMyConnectAccount', () => {
  it('returns the account on hit', async () => {
    const svc = new FakeAccountsService();
    const controller = new ConnectController(svc as unknown as PayoutAccountsService);

    const out = await controller.getMyConnectAccount(buildRequest('pr_a'));
    expect(out.providerId).toBe('pr_a');
  });

  it('throws 404 on miss', async () => {
    const svc = new FakeAccountsService();
    svc.nextLookup = null;
    const controller = new ConnectController(svc as unknown as PayoutAccountsService);

    await expect(controller.getMyConnectAccount(buildRequest('pr_missing'))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('ConnectController.getAccountByProvider (admin)', () => {
  it('returns the account on hit', async () => {
    const svc = new FakeAccountsService();
    const controller = new ConnectController(svc as unknown as PayoutAccountsService);

    const out = await controller.getAccountByProvider('pr_a');
    expect(out.providerId).toBe('pr_a');
  });

  it('throws 404 on miss', async () => {
    const svc = new FakeAccountsService();
    svc.nextLookup = null;
    const controller = new ConnectController(svc as unknown as PayoutAccountsService);

    await expect(controller.getAccountByProvider('pr_missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects an empty provider id', async () => {
    const svc = new FakeAccountsService();
    const controller = new ConnectController(svc as unknown as PayoutAccountsService);

    await expect(controller.getAccountByProvider('')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ConnectController.listAccounts (admin)', () => {
  it('passes the query through to the service', async () => {
    const svc = new FakeAccountsService();
    svc.nextList = {
      rows: [
        buildAccount(),
        buildAccount({ providerId: 'pr_b', stripeAccountId: 'acct_stub_pr_b' }),
      ],
      nextCursor: null,
    };
    const controller = new ConnectController(svc as unknown as PayoutAccountsService);

    const out = await controller.listAccounts({ limit: 25, status: 'pending_onboarding' });
    expect(out.rows).toHaveLength(2);
    expect(svc.lastListInput).toEqual({ limit: 25, status: 'pending_onboarding' });
  });

  it('passes the cursor through', async () => {
    const svc = new FakeAccountsService();
    const controller = new ConnectController(svc as unknown as PayoutAccountsService);

    await controller.listAccounts({ limit: 50, cursor: 'abc' });
    expect(svc.lastListInput).toEqual({ limit: 50, cursor: 'abc' });
  });
});
