import { describe, expect, it } from 'vitest';

import {
  INVOICE_LIST_LIMIT_DEFAULT,
  INVOICE_LIST_LIMIT_MAX,
  InvoiceResponseSchema,
  InvoicesListResponseSchema,
  ListInvoicesQuerySchema,
  type InvoiceResponse,
  type InvoicesListResponse,
  type ListInvoicesQuery,
} from '../http/invoice.schema';

describe('ListInvoicesQuerySchema', () => {
  it('requires subscriptionId', () => {
    const result = ListInvoicesQuerySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('defaults limit to the documented default', () => {
    const parsed = ListInvoicesQuerySchema.parse({ subscriptionId: 'sub_local_xyz' });
    expect(parsed.limit).toBe(INVOICE_LIST_LIMIT_DEFAULT);
  });

  it('coerces a numeric string limit (query parameters arrive as strings)', () => {
    const parsed = ListInvoicesQuerySchema.parse({
      subscriptionId: 'sub_local_xyz',
      limit: '25',
    });
    expect(parsed.limit).toBe(25);
  });

  it('rejects a limit above the bound', () => {
    expect(
      ListInvoicesQuerySchema.safeParse({
        subscriptionId: 'sub_local_xyz',
        limit: INVOICE_LIST_LIMIT_MAX + 1,
      }).success,
    ).toBe(false);
  });

  it('accepts a startingAfter cursor', () => {
    const parsed: ListInvoicesQuery = ListInvoicesQuerySchema.parse({
      subscriptionId: 'sub_local_xyz',
      startingAfter: 'in_1ABcDef',
    });
    expect(parsed.startingAfter).toBe('in_1ABcDef');
  });

  it('rejects unknown fields', () => {
    expect(
      ListInvoicesQuerySchema.safeParse({
        subscriptionId: 'sub_local_xyz',
        secret: 1,
      }).success,
    ).toBe(false);
  });
});

const validInvoice: InvoiceResponse = {
  id: 'in_1ABcDef',
  subscriptionId: 'sub_local_xyz',
  stripeSubscriptionId: 'sub_stripe_xyz',
  stripeCustomerId: 'cus_stripe_xyz',
  status: 'paid',
  number: 'TASTESEE-0001',
  description: 'Tier 2 Companion Dining — May 2026',
  currency: 'USD',
  amountDueUsdMinor: 29900,
  amountPaidUsdMinor: 29900,
  amountRemainingUsdMinor: 0,
  hostedInvoiceUrl: 'https://invoice.stripe.com/i/inv_xyz',
  invoicePdf: 'https://files.stripe.com/i/inv_xyz/pdf',
  periodStart: '2026-05-01T00:00:00.000Z',
  periodEnd: '2026-06-01T00:00:00.000Z',
  createdAt: '2026-05-01T00:00:00.000Z',
  paidAt: '2026-05-01T00:00:01.000Z',
  dueAt: null,
};

describe('InvoiceResponseSchema', () => {
  it('accepts a paid invoice and round-trips it unchanged', () => {
    const parsed = InvoiceResponseSchema.parse(validInvoice);
    expect(parsed).toEqual(validInvoice);
  });

  it('accepts a draft invoice with null number / hostedInvoiceUrl', () => {
    const draft: InvoiceResponse = {
      ...validInvoice,
      status: 'draft',
      number: null,
      hostedInvoiceUrl: null,
      invoicePdf: null,
      paidAt: null,
      amountPaidUsdMinor: 0,
      amountRemainingUsdMinor: 29900,
    };
    expect(InvoiceResponseSchema.parse(draft)).toEqual(draft);
  });

  it('rejects unknown fields', () => {
    expect(InvoiceResponseSchema.safeParse({ ...validInvoice, extra: 1 }).success).toBe(false);
  });

  it('rejects negative money values', () => {
    expect(
      InvoiceResponseSchema.safeParse({ ...validInvoice, amountDueUsdMinor: -1 }).success,
    ).toBe(false);
  });

  it('rejects an invalid status', () => {
    expect(InvoiceResponseSchema.safeParse({ ...validInvoice, status: 'pending' }).success).toBe(
      false,
    );
  });

  it('rejects a non-https hosted URL', () => {
    expect(
      InvoiceResponseSchema.safeParse({
        ...validInvoice,
        hostedInvoiceUrl: 'not a url',
      }).success,
    ).toBe(false);
  });
});

describe('InvoicesListResponseSchema', () => {
  it('accepts an empty page', () => {
    const empty: InvoicesListResponse = {
      invoices: [],
      hasMore: false,
      nextStartingAfter: null,
    };
    expect(InvoicesListResponseSchema.parse(empty)).toEqual(empty);
  });

  it('accepts a populated page with a cursor', () => {
    const page: InvoicesListResponse = {
      invoices: [validInvoice],
      hasMore: true,
      nextStartingAfter: validInvoice.id,
    };
    expect(InvoicesListResponseSchema.parse(page)).toEqual(page);
  });

  it('rejects unknown fields', () => {
    expect(
      InvoicesListResponseSchema.safeParse({
        invoices: [],
        hasMore: false,
        nextStartingAfter: null,
        extra: 1,
      }).success,
    ).toBe(false);
  });
});
