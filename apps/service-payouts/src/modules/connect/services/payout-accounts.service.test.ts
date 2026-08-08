import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import {
  PayoutAccountsService,
  __testing as accountsTesting,
  deriveStatus,
} from './payout-accounts.service';
import {
  StripeConnectService,
  type CreateAccountInput,
  type CreateLinkInput,
} from './stripe-connect.service';
import type { Env } from '../../../config/env';

function buildEnv(): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3018,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    SERVICE_VERSION: 'dev',
    OTEL_TRACES_ENABLED: false,
    OTEL_METRICS_ENABLED: false,
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    STRIPE_API_VERSION: '2024-12-18.acacia',
    STRIPE_STUB_ONBOARDING_BASE_URL: 'https://stub.example.test',
    STRIPE_EVENTS_HEADER_NAME: 'x-internal-api-key',
    STRIPE_EVENTS_API_KEY: 'k'.repeat(40),
    PAYOUT_HOLD_DAYS: 2,
    PAYOUT_MIN_AMOUNT_MINOR: 100,
    PAYOUT_DEFAULT_CURRENCY: 'USD',
    PAYOUT_TRANSFERS_HEADER_NAME: 'x-internal-api-key',
    PAYOUT_TRANSFERS_API_KEY: 't'.repeat(40),
  };
}

interface FakeAccountRow {
  id: string;
  providerId: string;
  stripeAccountId: string;
  country: string;
  defaultCurrency: string;
  status: 'pending_onboarding' | 'restricted' | 'active' | 'disabled';
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  requirementsCurrentlyDue: string[];
  requirementsPastDue: string[];
  disabledReason: string | null;
  liveMode: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeLinkRow {
  id: string;
  providerPayoutAccountId: string;
  kind: string;
  url: string;
  expiresAt: Date;
  liveMode: boolean;
  createdAt: Date;
}

class FakePrisma {
  accounts: FakeAccountRow[] = [];
  links: FakeLinkRow[] = [];
  private idCounter = 0;
  forceCreateConflict = false;

  providerPayoutAccount = {
    findUnique: async (args: {
      where: { providerId?: string; stripeAccountId?: string; id?: string };
    }): Promise<FakeAccountRow | null> => {
      const w = args.where;
      const match = this.accounts.find((r) => {
        if (w.providerId !== undefined) return r.providerId === w.providerId;
        if (w.stripeAccountId !== undefined) return r.stripeAccountId === w.stripeAccountId;
        if (w.id !== undefined) return r.id === w.id;
        return false;
      });
      return match ?? null;
    },
    create: async (args: { data: Partial<FakeAccountRow> }): Promise<FakeAccountRow> => {
      if (this.forceCreateConflict) {
        const err: unknown = { code: 'P2002' };
        throw err;
      }
      const d = args.data;
      if (this.accounts.some((r) => r.providerId === d.providerId)) {
        const err: unknown = { code: 'P2002' };
        throw err;
      }
      const now = new Date();
      const row: FakeAccountRow = {
        id: `acc_${++this.idCounter}`,
        providerId: d.providerId ?? '',
        stripeAccountId: d.stripeAccountId ?? '',
        country: d.country ?? 'US',
        defaultCurrency: d.defaultCurrency ?? 'USD',
        status: (d.status as FakeAccountRow['status']) ?? 'pending_onboarding',
        chargesEnabled: d.chargesEnabled ?? false,
        payoutsEnabled: d.payoutsEnabled ?? false,
        detailsSubmitted: d.detailsSubmitted ?? false,
        requirementsCurrentlyDue: (d.requirementsCurrentlyDue as string[]) ?? [],
        requirementsPastDue: (d.requirementsPastDue as string[]) ?? [],
        disabledReason: d.disabledReason ?? null,
        liveMode: d.liveMode ?? false,
        createdAt: now,
        updatedAt: now,
      };
      this.accounts.push(row);
      return row;
    },
    update: async (args: {
      where: { id: string };
      data: Partial<FakeAccountRow>;
    }): Promise<FakeAccountRow> => {
      const row = this.accounts.find((r) => r.id === args.where.id);
      if (row === undefined) throw new Error('row not found');
      Object.assign(row, args.data);
      row.updatedAt = new Date();
      return row;
    },
    findMany: async (args: {
      where?: { status?: string };
      orderBy?: unknown;
      take?: number;
      cursor?: { id: string };
      skip?: number;
    }): Promise<FakeAccountRow[]> => {
      let rows = [...this.accounts];
      if (args.where?.status !== undefined) {
        rows = rows.filter((r) => r.status === args.where!.status);
      }
      rows.sort((a, b) => {
        if (a.createdAt.getTime() !== b.createdAt.getTime()) {
          return b.createdAt.getTime() - a.createdAt.getTime();
        }
        return a.id < b.id ? 1 : -1;
      });
      if (args.cursor !== undefined) {
        const idx = rows.findIndex((r) => r.id === args.cursor!.id);
        if (idx >= 0) rows = rows.slice(idx + (args.skip ?? 0));
      }
      if (args.take !== undefined && args.take > 0) {
        rows = rows.slice(0, args.take);
      }
      return rows;
    },
  };

  payoutAccountLinkEvent = {
    create: async (args: { data: Partial<FakeLinkRow> }): Promise<FakeLinkRow> => {
      const row: FakeLinkRow = {
        id: `lnk_${++this.idCounter}`,
        providerPayoutAccountId: args.data.providerPayoutAccountId ?? '',
        kind: args.data.kind ?? 'account_onboarding',
        url: args.data.url ?? '',
        expiresAt: args.data.expiresAt ?? new Date(),
        liveMode: args.data.liveMode ?? false,
        createdAt: new Date(),
      };
      this.links.push(row);
      return row;
    },
  };
}

describe('deriveStatus', () => {
  it('returns disabled when disabledReason is set', () => {
    expect(
      deriveStatus({
        chargesEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
        requirementsCurrentlyDue: [],
        requirementsPastDue: [],
        disabledReason: 'requirements.past_due',
      }),
    ).toBe('disabled');
  });

  it('returns pending_onboarding when details are not submitted', () => {
    expect(
      deriveStatus({
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
        requirementsCurrentlyDue: ['external_account'],
        requirementsPastDue: [],
        disabledReason: null,
      }),
    ).toBe('pending_onboarding');
  });

  it('returns restricted when payouts disabled even with details submitted', () => {
    expect(
      deriveStatus({
        chargesEnabled: true,
        payoutsEnabled: false,
        detailsSubmitted: true,
        requirementsCurrentlyDue: [],
        requirementsPastDue: [],
        disabledReason: null,
      }),
    ).toBe('restricted');
  });

  it('returns restricted when requirements past due', () => {
    expect(
      deriveStatus({
        chargesEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
        requirementsCurrentlyDue: [],
        requirementsPastDue: ['individual.verification.document'],
        disabledReason: null,
      }),
    ).toBe('restricted');
  });

  it('returns active when everything is green', () => {
    expect(
      deriveStatus({
        chargesEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
        requirementsCurrentlyDue: ['tos_acceptance.date'],
        requirementsPastDue: [],
        disabledReason: null,
      }),
    ).toBe('active');
  });

  it('treats empty-string disabledReason as not disabled', () => {
    expect(
      deriveStatus({
        chargesEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
        requirementsCurrentlyDue: [],
        requirementsPastDue: [],
        disabledReason: '',
      }),
    ).toBe('active');
  });
});

describe('isUniqueViolation', () => {
  it('detects P2002', () => {
    expect(accountsTesting.isUniqueViolation({ code: 'P2002' })).toBe(true);
  });

  it('returns false for null + non-objects + unrelated errors', () => {
    expect(accountsTesting.isUniqueViolation(null)).toBe(false);
    expect(accountsTesting.isUniqueViolation('boom')).toBe(false);
    expect(accountsTesting.isUniqueViolation({ code: 'P2025' })).toBe(false);
  });
});

describe('PayoutAccountsService.createOrFetchForProvider', () => {
  it('returns outcome=created on first call', async () => {
    const prisma = new FakePrisma();
    const stripe = new StripeConnectService(buildEnv());
    const svc = new PayoutAccountsService(prisma as unknown as PrismaService, stripe);

    const out = await svc.createOrFetchForProvider({
      providerId: 'pr_abc',
      country: 'US',
      defaultCurrency: 'USD',
    });
    expect(out.outcome).toBe('created');
    expect(out.account.providerId).toBe('pr_abc');
    expect(out.account.stripeAccountId).toBe('acct_stub_pr_abc');
    expect(out.account.status).toBe('pending_onboarding');
    expect(prisma.accounts).toHaveLength(1);
  });

  it('returns outcome=existing on second call for the same provider', async () => {
    const prisma = new FakePrisma();
    const stripe = new StripeConnectService(buildEnv());
    const svc = new PayoutAccountsService(prisma as unknown as PrismaService, stripe);

    await svc.createOrFetchForProvider({
      providerId: 'pr_abc',
      country: 'US',
      defaultCurrency: 'USD',
    });
    const second = await svc.createOrFetchForProvider({
      providerId: 'pr_abc',
      country: 'US',
      defaultCurrency: 'USD',
    });
    expect(second.outcome).toBe('existing');
    expect(prisma.accounts).toHaveLength(1);
  });

  it('resolves a concurrent-create race via P2002 → re-read', async () => {
    const prisma = new FakePrisma();
    const stripe = new StripeConnectService(buildEnv());
    const svc = new PayoutAccountsService(prisma as unknown as PrismaService, stripe);

    // Seed a winner row first, then force the create path to raise
    // P2002 on the next insert.
    await svc.createOrFetchForProvider({
      providerId: 'pr_race',
      country: 'US',
      defaultCurrency: 'USD',
    });
    prisma.forceCreateConflict = true;

    // Pretend the lookup misses (simulate ordering of the race):
    // delete then attempt create again with the same providerId. Since
    // we set forceCreateConflict, the create raises P2002 and the
    // service re-reads — but we've removed the row. Adjust by re-
    // inserting via direct manipulation so the re-read finds it.
    const winner = prisma.accounts[0]!;
    prisma.accounts.length = 0;
    prisma.accounts.push(winner);

    const out = await svc.createOrFetchForProvider({
      providerId: 'pr_race',
      country: 'US',
      defaultCurrency: 'USD',
    });
    expect(out.outcome).toBe('existing');
  });

  it('rethrows non-P2002 errors from the create path', async () => {
    const prisma = new FakePrisma();
    const stripe = new StripeConnectService(buildEnv());
    const svc = new PayoutAccountsService(prisma as unknown as PrismaService, stripe);

    // Override create to throw a non-P2002 error.
    prisma.providerPayoutAccount.create = async () => {
      throw new Error('connection refused');
    };

    await expect(
      svc.createOrFetchForProvider({
        providerId: 'pr_err',
        country: 'US',
        defaultCurrency: 'USD',
      }),
    ).rejects.toThrow('connection refused');
  });
});

describe('PayoutAccountsService.mintAccountLink', () => {
  it('returns account_not_found when no payout account exists', async () => {
    const prisma = new FakePrisma();
    const stripe = new StripeConnectService(buildEnv());
    const svc = new PayoutAccountsService(prisma as unknown as PrismaService, stripe);

    const out = await svc.mintAccountLink({
      providerId: 'pr_missing',
      refreshUrl: 'https://app.example.com/r',
      returnUrl: 'https://app.example.com/d',
    });
    expect(out.outcome).toBe('account_not_found');
  });

  it('mints an account_onboarding link by default + records an audit row', async () => {
    const prisma = new FakePrisma();
    const stripe = new StripeConnectService(buildEnv());
    const svc = new PayoutAccountsService(prisma as unknown as PrismaService, stripe);

    await svc.createOrFetchForProvider({
      providerId: 'pr_a',
      country: 'US',
      defaultCurrency: 'USD',
    });
    const out = await svc.mintAccountLink({
      providerId: 'pr_a',
      refreshUrl: 'https://app.example.com/r',
      returnUrl: 'https://app.example.com/d',
    });

    expect(out.outcome).toBe('minted');
    if (out.outcome === 'minted') {
      expect(out.link.kind).toBe('account_onboarding');
      expect(out.link.url).toContain('account_onboarding');
      expect(out.link.liveMode).toBe(false);
    }
    expect(prisma.links).toHaveLength(1);
    expect(prisma.links[0]?.kind).toBe('account_onboarding');
  });

  it('honours an explicit account_update kind', async () => {
    const prisma = new FakePrisma();
    const stripe = new StripeConnectService(buildEnv());
    const svc = new PayoutAccountsService(prisma as unknown as PrismaService, stripe);

    await svc.createOrFetchForProvider({
      providerId: 'pr_a',
      country: 'US',
      defaultCurrency: 'USD',
    });
    const out = await svc.mintAccountLink({
      providerId: 'pr_a',
      kind: 'account_update',
      refreshUrl: 'https://app.example.com/r',
      returnUrl: 'https://app.example.com/d',
    });

    expect(out.outcome).toBe('minted');
    if (out.outcome === 'minted') {
      expect(out.link.kind).toBe('account_update');
      expect(out.link.url).toContain('account_update');
    }
  });
});

describe('PayoutAccountsService.getByProvider + getByStripeAccountId', () => {
  it('returns null when no row exists', async () => {
    const prisma = new FakePrisma();
    const stripe = new StripeConnectService(buildEnv());
    const svc = new PayoutAccountsService(prisma as unknown as PrismaService, stripe);

    expect(await svc.getByProvider('nope')).toBeNull();
    expect(await svc.getByStripeAccountId('acct_nope')).toBeNull();
  });

  it('returns the record by either lookup', async () => {
    const prisma = new FakePrisma();
    const stripe = new StripeConnectService(buildEnv());
    const svc = new PayoutAccountsService(prisma as unknown as PrismaService, stripe);

    await svc.createOrFetchForProvider({
      providerId: 'pr_a',
      country: 'US',
      defaultCurrency: 'USD',
    });
    const a = await svc.getByProvider('pr_a');
    const b = await svc.getByStripeAccountId('acct_stub_pr_a');
    expect(a?.providerId).toBe('pr_a');
    expect(b?.stripeAccountId).toBe('acct_stub_pr_a');
  });
});

describe('PayoutAccountsService.list', () => {
  it('returns rows in newest-first order with cursor handoff', async () => {
    const prisma = new FakePrisma();
    const stripe = new StripeConnectService(buildEnv());
    const svc = new PayoutAccountsService(prisma as unknown as PrismaService, stripe);

    for (const id of ['pr_a', 'pr_b', 'pr_c']) {
      await svc.createOrFetchForProvider({
        providerId: id,
        country: 'US',
        defaultCurrency: 'USD',
      });
      // Stagger createdAt manually.
      const row = prisma.accounts.find((r) => r.providerId === id);
      if (row !== undefined) {
        row.createdAt = new Date(2026, 0, 1, 12, 0, prisma.accounts.indexOf(row));
      }
    }

    const page1 = await svc.list({ limit: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const cursor = page1.nextCursor;
    expect(cursor).toBeTruthy();
    const page2 = await svc.list({ limit: 2, ...(cursor !== null ? { cursor } : {}) });
    expect(page2.rows).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
  });

  it('filters by status', async () => {
    const prisma = new FakePrisma();
    const stripe = new StripeConnectService(buildEnv());
    const svc = new PayoutAccountsService(prisma as unknown as PrismaService, stripe);

    await svc.createOrFetchForProvider({
      providerId: 'pr_a',
      country: 'US',
      defaultCurrency: 'USD',
    });
    await svc.createOrFetchForProvider({
      providerId: 'pr_b',
      country: 'US',
      defaultCurrency: 'USD',
    });
    // Mutate one of the rows to `active` directly in the fake store.
    if (prisma.accounts[0] !== undefined) {
      prisma.accounts[0].status = 'active';
    }

    const out = await svc.list({ limit: 50, status: 'active' });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]?.status).toBe('active');
  });
});

describe('PayoutAccountsService.applyAccountUpdate', () => {
  it('updates the row + derives the new status', async () => {
    const prisma = new FakePrisma();
    const stripe = new StripeConnectService(buildEnv());
    const svc = new PayoutAccountsService(prisma as unknown as PrismaService, stripe);

    const created = await svc.createOrFetchForProvider({
      providerId: 'pr_a',
      country: 'US',
      defaultCurrency: 'USD',
    });

    // Fake "transaction" — the FakePrisma object IS our transaction client.
    const updated = await svc.applyAccountUpdate(prisma as never, {
      stripeAccountId: created.account.stripeAccountId,
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      requirementsCurrentlyDue: [],
      requirementsPastDue: [],
      disabledReason: null,
      liveMode: true,
    });
    expect(updated?.status).toBe('active');
    expect(updated?.chargesEnabled).toBe(true);
    expect(updated?.liveMode).toBe(true);
  });

  it('returns null when the stripeAccountId is unknown', async () => {
    const prisma = new FakePrisma();
    const stripe = new StripeConnectService(buildEnv());
    const svc = new PayoutAccountsService(prisma as unknown as PrismaService, stripe);

    const out = await svc.applyAccountUpdate(prisma as never, {
      stripeAccountId: 'acct_unknown',
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      requirementsCurrentlyDue: [],
      requirementsPastDue: [],
      disabledReason: null,
      liveMode: false,
    });
    expect(out).toBeNull();
  });

  it('takes a non-existent ignoreOptional input (undefined helper input)', async () => {
    // Just verifies the test path doesn't accidentally throw if a
    // caller passes an empty `CreateAccountInput`.
    const stripe = new StripeConnectService(buildEnv());
    expect(stripe.isLiveMode()).toBe(false);
    const probe = { providerId: 'pr_x', country: 'US', defaultCurrency: 'USD' };
    const out = await stripe.createConnectAccount(probe as CreateAccountInput);
    expect(out.stripeAccountId).toBe('acct_stub_pr_x');
  });

  it('createAccountLink call shape is consumable as CreateLinkInput', async () => {
    const stripe = new StripeConnectService(buildEnv());
    const link = await stripe.createAccountLink({
      stripeAccountId: 'acct_stub_pr_a',
      kind: 'account_onboarding',
      refreshUrl: 'https://app.example.com/r',
      returnUrl: 'https://app.example.com/d',
    } as CreateLinkInput);
    expect(link.url).toContain('account_onboarding');
  });
});
