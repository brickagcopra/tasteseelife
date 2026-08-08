import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_CODE_MAX_LENGTH,
  type Account,
  type AccountsListResponse,
  AccountCodeSchema,
  AccountNormalBalanceSchema,
  AccountSchema,
  AccountTypeSchema,
  AccountsListResponseSchema,
  ListAccountsQuerySchema,
} from '../http/account.schema';

const validAccount: Account = {
  id: 'coa_cash',
  code: '1000',
  name: 'Cash',
  description: 'Operating bank + Stripe balance.',
  type: 'asset',
  parentId: null,
  normalBalance: 'debit',
  currency: 'USD',
  active: true,
  createdAt: '2026-05-13T00:00:00.000Z',
  updatedAt: '2026-05-13T00:00:00.000Z',
};

describe('AccountTypeSchema', () => {
  it('accepts every PDD-named category', () => {
    for (const t of [
      'asset',
      'liability',
      'equity',
      'revenue',
      'contra_revenue',
      'expense',
    ] as const) {
      expect(AccountTypeSchema.parse(t)).toBe(t);
    }
  });

  it('rejects unknown categories', () => {
    expect(AccountTypeSchema.safeParse('income').success).toBe(false);
    expect(AccountTypeSchema.safeParse('asset_long_term').success).toBe(false);
  });
});

describe('AccountNormalBalanceSchema', () => {
  it('accepts debit and credit', () => {
    expect(AccountNormalBalanceSchema.parse('debit')).toBe('debit');
    expect(AccountNormalBalanceSchema.parse('credit')).toBe('credit');
  });

  it('rejects unknown values', () => {
    expect(AccountNormalBalanceSchema.safeParse('zero').success).toBe(false);
  });
});

describe('AccountCodeSchema', () => {
  it('accepts standard four-digit and dot-notation codes', () => {
    for (const code of [
      '1000',
      '2000.family.tier2',
      '4000.provider.elite',
      '4000.academy.membership',
      '5100',
    ]) {
      expect(AccountCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  it('rejects upper-case codes', () => {
    expect(AccountCodeSchema.safeParse('1000.Family.Tier1').success).toBe(false);
  });

  it('rejects whitespace and invalid characters', () => {
    expect(AccountCodeSchema.safeParse('1000 family').success).toBe(false);
    expect(AccountCodeSchema.safeParse('1000/family').success).toBe(false);
    expect(AccountCodeSchema.safeParse('1000@family').success).toBe(false);
  });

  it(`rejects codes longer than ${ACCOUNT_CODE_MAX_LENGTH} characters`, () => {
    expect(AccountCodeSchema.safeParse('a'.repeat(ACCOUNT_CODE_MAX_LENGTH + 1)).success).toBe(
      false,
    );
  });

  it('rejects an empty string', () => {
    expect(AccountCodeSchema.safeParse('').success).toBe(false);
  });
});

describe('AccountSchema', () => {
  it('accepts a valid account and round-trips it unchanged', () => {
    const parsed = AccountSchema.parse(validAccount);
    expect(parsed).toEqual(validAccount);
  });

  it('defaults currency to USD when omitted', () => {
    const { currency, ...without } = validAccount;
    void currency;
    const parsed = AccountSchema.parse(without);
    expect(parsed.currency).toBe('USD');
  });

  it('rejects unknown top-level fields (.strict)', () => {
    expect(AccountSchema.safeParse({ ...validAccount, secret: 'x' }).success).toBe(false);
  });

  it('accepts a non-null parentId (sub-account)', () => {
    const child: Account = {
      ...validAccount,
      id: 'coa_t2',
      code: '2000.family.tier2',
      name: 'Deferred Revenue — Family Tier 2',
      type: 'liability',
      normalBalance: 'credit',
      parentId: 'coa_2000',
    };
    expect(AccountSchema.safeParse(child).success).toBe(true);
  });

  it('rejects an unsupported currency', () => {
    expect(AccountSchema.safeParse({ ...validAccount, currency: 'EUR' }).success).toBe(false);
  });

  it('requires datetime strings for createdAt / updatedAt', () => {
    expect(AccountSchema.safeParse({ ...validAccount, createdAt: '2026-05-13' }).success).toBe(
      false,
    );
    expect(AccountSchema.safeParse({ ...validAccount, updatedAt: 'yesterday' }).success).toBe(
      false,
    );
  });

  it('rejects a name longer than the max', () => {
    expect(AccountSchema.safeParse({ ...validAccount, name: 'a'.repeat(201) }).success).toBe(false);
  });

  it('rejects an invalid type', () => {
    expect(AccountSchema.safeParse({ ...validAccount, type: 'income' }).success).toBe(false);
  });

  it('rejects an invalid normalBalance', () => {
    expect(AccountSchema.safeParse({ ...validAccount, normalBalance: 'zero' }).success).toBe(false);
  });
});

describe('AccountsListResponseSchema', () => {
  it('wraps an array of accounts and rejects bare-array input', () => {
    const valid: AccountsListResponse = { accounts: [validAccount] };
    expect(AccountsListResponseSchema.parse(valid)).toEqual(valid);
    expect(AccountsListResponseSchema.safeParse([validAccount]).success).toBe(false);
  });

  it('rejects unknown top-level fields (.strict)', () => {
    expect(
      AccountsListResponseSchema.safeParse({
        accounts: [validAccount],
        nextCursor: 'abc',
      }).success,
    ).toBe(false);
  });

  it('accepts an empty list', () => {
    expect(AccountsListResponseSchema.parse({ accounts: [] })).toEqual({
      accounts: [],
    });
  });
});

describe('ListAccountsQuerySchema', () => {
  it('defaults activeOnly to true when omitted', () => {
    const parsed = ListAccountsQuerySchema.parse({});
    expect(parsed.activeOnly).toBe(true);
    expect(parsed.type).toBeUndefined();
    expect(parsed.parentId).toBeUndefined();
  });

  it('accepts a narrow filter by type', () => {
    const parsed = ListAccountsQuerySchema.parse({ type: 'revenue' });
    expect(parsed.type).toBe('revenue');
    expect(parsed.activeOnly).toBe(true);
  });

  it('coerces activeOnly=false from the string literal', () => {
    const parsed = ListAccountsQuerySchema.parse({ activeOnly: 'false' });
    expect(parsed.activeOnly).toBe(false);
  });

  it('rejects an unknown query parameter (.strict)', () => {
    expect(ListAccountsQuerySchema.safeParse({ unknown: 'x' }).success).toBe(false);
  });

  it('rejects an invalid activeOnly value', () => {
    expect(ListAccountsQuerySchema.safeParse({ activeOnly: 'maybe' }).success).toBe(false);
  });

  it('rejects an invalid type value', () => {
    expect(ListAccountsQuerySchema.safeParse({ type: 'income' }).success).toBe(false);
  });
});
