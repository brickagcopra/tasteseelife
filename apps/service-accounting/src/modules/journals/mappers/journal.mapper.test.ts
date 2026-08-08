import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { toJournalResponse, type PersistedJournalWithLines } from './journal.mapper';

function baseRow(overrides: Partial<PersistedJournalWithLines> = {}): PersistedJournalWithLines {
  return {
    id: 'jrnl_abc',
    kind: 'subscription_activation',
    occurredAt: new Date('2026-05-13T00:00:00.000Z'),
    postedAt: new Date('2026-05-13T00:00:01.000Z'),
    sourceEventId: 'evt_abc',
    description: 'Tier 2 activated.',
    periodId: 'prd_2026-05',
    period: { id: 'prd_2026-05', name: '2026-05', status: 'open' },
    postedByUserId: null,
    reversedJournalId: null,
    reversedByJournalId: null,
    context: { stripeInvoiceId: 'in_abc' },
    lines: [
      {
        id: 'jl_1',
        accountId: 'coa_cash',
        debit: new Decimal('299.00'),
        credit: new Decimal('0'),
        currency: 'USD',
        memo: 'Tier 2 cash.',
        account: { code: '1000' },
      },
      {
        id: 'jl_2',
        accountId: 'coa_deferred',
        debit: new Decimal('0'),
        credit: new Decimal('299.00'),
        currency: 'USD',
        memo: null,
        account: { code: '2000.family.tier2' },
      },
    ],
    ...overrides,
  };
}

describe('toJournalResponse', () => {
  it('maps a simple two-line journal to the wire DTO', () => {
    const dto = toJournalResponse(baseRow());
    expect(dto.id).toBe('jrnl_abc');
    expect(dto.occurredAt).toBe('2026-05-13T00:00:00.000Z');
    expect(dto.postedAt).toBe('2026-05-13T00:00:01.000Z');
    expect(dto.periodId).toBe('prd_2026-05');
    expect(dto.periodName).toBe('2026-05');
    expect(dto.context).toEqual({ stripeInvoiceId: 'in_abc' });
    expect(dto.lines).toHaveLength(2);
    expect(dto.lines[0]?.debitMinor).toBe(29_900);
    expect(dto.lines[0]?.creditMinor).toBe(0);
    expect(dto.lines[0]?.memo).toBe('Tier 2 cash.');
    expect(dto.lines[1]?.creditMinor).toBe(29_900);
    expect(dto.lines[1]?.memo).toBeUndefined();
  });

  it('converts Decimal amounts to integer minor units exactly', () => {
    const row = baseRow({
      lines: [
        {
          id: 'jl_1',
          accountId: 'coa_cash',
          debit: new Decimal('1.23'),
          credit: new Decimal('0'),
          currency: 'USD',
          memo: null,
          account: { code: '1000' },
        },
        {
          id: 'jl_2',
          accountId: 'coa_other',
          debit: new Decimal('0'),
          credit: new Decimal('1.23'),
          currency: 'USD',
          memo: null,
          account: { code: '2000.family.tier2' },
        },
      ],
    });
    const dto = toJournalResponse(row);
    expect(dto.lines[0]?.debitMinor).toBe(123);
    expect(dto.lines[1]?.creditMinor).toBe(123);
  });

  it('accepts Prisma-runtime Decimal (string-shaped) values', () => {
    // Prisma's Decimal is a different class but has a compatible
    // toString() — the mapper coerces via that contract.
    const fakePrismaDecimal = { toString: () => '99.99' };
    const row = baseRow({
      lines: [
        {
          id: 'jl_1',
          accountId: 'coa_cash',
          debit: fakePrismaDecimal as unknown,
          credit: new Decimal('0'),
          currency: 'USD',
          memo: null,
          account: { code: '1000' },
        },
        {
          id: 'jl_2',
          accountId: 'coa_other',
          debit: new Decimal('0'),
          credit: fakePrismaDecimal as unknown,
          currency: 'USD',
          memo: null,
          account: { code: '2000.family.tier2' },
        },
      ],
    });
    const dto = toJournalResponse(row);
    expect(dto.lines[0]?.debitMinor).toBe(9_999);
    expect(dto.lines[1]?.creditMinor).toBe(9_999);
  });

  it('preserves the reversedJournalId + reversedByJournalId back-pointer columns', () => {
    const dto = toJournalResponse(
      baseRow({
        reversedJournalId: 'jrnl_original',
        reversedByJournalId: 'jrnl_other_reversal',
        kind: 'reversal',
      }),
    );
    expect(dto.kind).toBe('reversal');
    expect(dto.reversedJournalId).toBe('jrnl_original');
    expect(dto.reversedByJournalId).toBe('jrnl_other_reversal');
  });

  it('throws on an unsupported currency at the line level', () => {
    expect(() =>
      toJournalResponse(
        baseRow({
          lines: [
            {
              id: 'jl_1',
              accountId: 'coa_cash',
              debit: new Decimal('1.00'),
              credit: new Decimal('0'),
              currency: 'EUR',
              memo: null,
              account: { code: '1000' },
            },
            {
              id: 'jl_2',
              accountId: 'coa_other',
              debit: new Decimal('0'),
              credit: new Decimal('1.00'),
              currency: 'EUR',
              memo: null,
              account: { code: '2000.family.tier2' },
            },
          ],
        }),
      ),
    ).toThrow(/unsupported currency/i);
  });

  it('normalises a null/undefined context to an empty object', () => {
    const dto = toJournalResponse(baseRow({ context: null as unknown }));
    expect(dto.context).toEqual({});
  });
});
