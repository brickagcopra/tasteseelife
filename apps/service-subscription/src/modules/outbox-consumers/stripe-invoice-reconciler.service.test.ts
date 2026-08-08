import Decimal from 'decimal.js';
import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import { StripeInvoiceReconcilerService } from './stripe-invoice-reconciler.service';
import { StripeInvoiceShapeError } from './stripe-invoice-mapping';

const CREATED = 1_754_000_000;

function stripeInvoice(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'in_1',
    object: 'invoice',
    status: 'open',
    total: 4900,
    tax: 0,
    amount_paid: 0,
    currency: 'usd',
    created: CREATED,
    status_transitions: { paid_at: null },
    hosted_invoice_url: 'https://invoice.stripe.com/i/x',
    invoice_pdf: null,
    ...overrides,
  };
}

function stripeLine(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'il_1',
    object: 'line_item',
    type: 'subscription',
    description: 'Tier 2 — August',
    amount: 4900,
    currency: 'usd',
    proration: false,
    period: { start: CREATED, end: CREATED + 2_678_400 },
    ...overrides,
  };
}

function existingInvoice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'inv_local_1',
    status: 'open',
    total: new Decimal('49.00'),
    tax: new Decimal('0'),
    amountPaid: new Decimal('0'),
    currency: 'USD',
    issuedAt: new Date(CREATED * 1000),
    paidAt: null,
    hostedInvoiceUrl: 'https://invoice.stripe.com/i/x',
    invoicePdfUrl: null,
    lineItems: [
      {
        stripeLineItemId: 'il_1',
        kind: 'subscription',
        description: 'Tier 2 — August',
        amount: new Decimal('49.00'),
        currency: 'USD',
        periodStart: new Date(CREATED * 1000),
        periodEnd: new Date((CREATED + 2_678_400) * 1000),
      },
    ],
    ...overrides,
  };
}

function build(args?: {
  readonly subscription?: { id: string } | null;
  readonly existingInvoice?: Record<string, unknown> | null;
  readonly retrieve?: ReturnType<typeof vi.fn>;
  readonly listLineItems?: ReturnType<typeof vi.fn>;
}) {
  const subscriptionFindUnique = vi
    .fn()
    .mockResolvedValue(
      args?.subscription === undefined ? { id: 'sub_local_1' } : args.subscription,
    );
  const invoiceFindUnique = vi
    .fn()
    .mockResolvedValue(args?.existingInvoice === undefined ? null : args.existingInvoice);
  const invoiceCreate = vi.fn().mockResolvedValue({ id: 'inv_local_new' });
  const invoiceUpdate = vi.fn().mockResolvedValue({});
  const lineDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const lineCreateMany = vi.fn().mockResolvedValue({ count: 0 });

  const retrieve = args?.retrieve ?? vi.fn().mockResolvedValue(stripeInvoice());
  const listLineItems =
    args?.listLineItems ??
    vi.fn().mockResolvedValue({ object: 'list', data: [stripeLine()], has_more: false });

  const tx = {
    invoice: { create: invoiceCreate, update: invoiceUpdate },
    invoiceLineItem: { deleteMany: lineDeleteMany, createMany: lineCreateMany },
  };
  const prisma = {
    subscription: { findUnique: subscriptionFindUnique },
    invoice: { findUnique: invoiceFindUnique },
    $transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(tx)),
  };
  const stripe = { invoices: { retrieve, listLineItems } };

  const service = new StripeInvoiceReconcilerService(
    prisma as unknown as PrismaService,
    stripe as unknown as Stripe,
  );
  return {
    service,
    subscriptionFindUnique,
    invoiceCreate,
    invoiceUpdate,
    lineDeleteMany,
    lineCreateMany,
    retrieve,
    listLineItems,
  };
}

function reconcile(
  service: StripeInvoiceReconcilerService,
  stripeSubscriptionId: string | null = 'sub_stripe_1',
) {
  return service.reconcile({
    stripeInvoiceId: 'in_1',
    stripeSubscriptionId,
    stripeEventId: 'evt_1',
    stripeEventType: 'invoice.created',
  });
}

describe('StripeInvoiceReconcilerService — skips', () => {
  it('skips a ONE-OFF invoice without any lookup or Stripe call', async () => {
    // `invoices.subscription_id` is a real, non-nullable FK — an invoice
    // belonging to no subscription is not representable. The relayed payload
    // models the field as nullable precisely so this costs nothing to decide.
    const { service, subscriptionFindUnique, retrieve } = build();

    await expect(reconcile(service, null)).resolves.toEqual({ kind: 'one_off' });
    expect(subscriptionFindUnique).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('skips an invoice for a subscription this platform does not track', async () => {
    const { service, retrieve, invoiceCreate } = build({ subscription: null });

    await expect(reconcile(service)).resolves.toEqual({ kind: 'not_tracked' });
    expect(retrieve).not.toHaveBeenCalled();
    expect(invoiceCreate).not.toHaveBeenCalled();
  });
});

describe('StripeInvoiceReconcilerService — Stripe fetch', () => {
  it('treats resource_missing as terminal', async () => {
    const missing = new Stripe.errors.StripeInvalidRequestError({
      type: 'invalid_request_error',
      code: 'resource_missing',
      message: 'No such invoice',
    });
    const { service, invoiceCreate } = build({ retrieve: vi.fn().mockRejectedValue(missing) });

    await expect(reconcile(service)).resolves.toEqual({ kind: 'stripe_missing' });
    expect(invoiceCreate).not.toHaveBeenCalled();
  });

  it('re-throws a transient Stripe failure so the SDK retries', async () => {
    const boom = new Error('ECONNRESET');
    const { service } = build({ retrieve: vi.fn().mockRejectedValue(boom) });
    await expect(reconcile(service)).rejects.toBe(boom);
  });

  it('PAGES the line items rather than trusting the retrieved invoice`s first 10', async () => {
    // `invoice.lines` on the retrieved object is capped at 10 by Stripe and
    // nothing in the response makes that obvious at the call site — which is
    // how an invoice ends up stored with a total that does not equal the sum
    // of its visible lines.
    const listLineItems = vi
      .fn()
      .mockResolvedValueOnce({ data: [stripeLine({ id: 'il_a' })], has_more: true })
      .mockResolvedValueOnce({ data: [stripeLine({ id: 'il_b', amount: 0 })], has_more: false });
    const { service, lineCreateMany } = build({ listLineItems });

    await reconcile(service);

    expect(listLineItems).toHaveBeenCalledTimes(2);
    // Second page asks for what follows the last id of the first.
    expect(listLineItems.mock.calls[1]![1]).toMatchObject({ starting_after: 'il_a' });
    const rows = (lineCreateMany.mock.calls[0]![0] as { data: Array<{ stripeLineItemId: string }> })
      .data;
    expect(rows.map((row) => row.stripeLineItemId)).toEqual(['il_a', 'il_b']);
  });

  it('THROWS rather than truncating when the pages never end', async () => {
    // Storing an invoice with only some of its lines is the one defect a
    // billing page must never have.
    const listLineItems = vi
      .fn()
      .mockResolvedValue({ data: [stripeLine({ id: 'il_x' })], has_more: true });
    const { service } = build({ listLineItems });

    await expect(reconcile(service)).rejects.toBeInstanceOf(StripeInvoiceShapeError);
  });
});

describe('StripeInvoiceReconcilerService — writing', () => {
  it('CREATES an invoice and its lines on first sight', async () => {
    const { service, invoiceCreate, lineCreateMany } = build();

    await expect(reconcile(service)).resolves.toEqual({ kind: 'reconciled', changed: ['created'] });

    const created = (invoiceCreate.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(created.stripeInvoiceId).toBe('in_1');
    expect(created.subscriptionId).toBe('sub_local_1');
    expect((created.total as Decimal).toString()).toBe('49');
    expect(created.currency).toBe('USD');
    expect(lineCreateMany).toHaveBeenCalledTimes(1);
  });

  it('writes NOTHING when the stored invoice already agrees', async () => {
    const { service, invoiceCreate, invoiceUpdate, lineDeleteMany } = build({
      existingInvoice: existingInvoice(),
    });

    await expect(reconcile(service)).resolves.toEqual({ kind: 'no_change' });
    expect(invoiceCreate).not.toHaveBeenCalled();
    expect(invoiceUpdate).not.toHaveBeenCalled();
    // Crucially it does not churn the line-item primary keys either.
    expect(lineDeleteMany).not.toHaveBeenCalled();
  });

  it('UPDATES on a payment landing and stamps amountPaid + paidAt', async () => {
    const { service, invoiceUpdate, invoiceCreate } = build({
      existingInvoice: existingInvoice(),
      retrieve: vi.fn().mockResolvedValue(
        stripeInvoice({
          status: 'paid',
          amount_paid: 4900,
          status_transitions: { paid_at: CREATED + 60 },
        }),
      ),
    });

    const outcome = await reconcile(service);
    expect(outcome).toEqual({ kind: 'reconciled', changed: ['invoice'] });

    expect(invoiceCreate).not.toHaveBeenCalled();
    const updateCall = invoiceUpdate.mock.calls[0]![0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(updateCall.where.id).toBe('inv_local_1');
    expect(updateCall.data.status).toBe('paid');
    expect((updateCall.data.amountPaid as Decimal).toString()).toBe('49');
    expect(updateCall.data.paidAt).toEqual(new Date((CREATED + 60) * 1000));
    // An invoice never changes which subscription it belongs to; leaving the
    // field out of the update means a bug elsewhere cannot re-parent a
    // financial record.
    expect(updateCall.data).not.toHaveProperty('subscriptionId');
  });

  it('REPLACES line items rather than merging them', async () => {
    // Stripe recomputes the whole collection on finalisation — proration
    // lines appear, a discount is recalculated. Merging accumulates lines and
    // doubles an invoice's apparent total.
    const { service, lineDeleteMany, lineCreateMany } = build({
      existingInvoice: existingInvoice(),
      listLineItems: vi.fn().mockResolvedValue({
        data: [stripeLine(), stripeLine({ id: 'il_2', proration: true, amount: -1200 })],
        has_more: false,
      }),
    });

    await reconcile(service);

    expect(lineDeleteMany).toHaveBeenCalledTimes(1);
    expect(lineDeleteMany.mock.calls[0]![0]).toEqual({ where: { invoiceId: 'inv_local_1' } });
    const rows = (lineCreateMany.mock.calls[0]![0] as { data: Array<Record<string, unknown>> })
      .data;
    expect(rows).toHaveLength(2);
    expect(rows[1]!.kind).toBe('proration');
  });

  it('deletes then skips createMany for an invoice with no lines', async () => {
    const { service, lineDeleteMany, lineCreateMany } = build({
      listLineItems: vi.fn().mockResolvedValue({ data: [], has_more: false }),
    });

    await reconcile(service);
    expect(lineDeleteMany).toHaveBeenCalledTimes(1);
    expect(lineCreateMany).not.toHaveBeenCalled();
  });

  it('WRITES NOTHING on an unmappable invoice status', async () => {
    const { service, invoiceCreate, lineDeleteMany } = build({
      retrieve: vi.fn().mockResolvedValue(stripeInvoice({ status: 'brand_new' })),
    });

    await expect(reconcile(service)).resolves.toEqual({
      kind: 'unknown_status',
      stripeStatus: 'brand_new',
    });
    expect(invoiceCreate).not.toHaveBeenCalled();
    expect(lineDeleteMany).not.toHaveBeenCalled();
  });

  it('replaces lines and updates the invoice in ONE transaction', async () => {
    // A reader must never observe an invoice with no lines. Asserted by
    // recorded ORDER — call counts pass whether or not the writes are
    // bracketed by the transaction.
    const order: string[] = [];
    const invoiceCreate = vi.fn().mockImplementation(() => {
      order.push('invoice');
      return Promise.resolve({ id: 'inv_local_new' });
    });
    const lineDeleteMany = vi.fn().mockImplementation(() => {
      order.push('delete-lines');
      return Promise.resolve({ count: 0 });
    });
    const lineCreateMany = vi.fn().mockImplementation(() => {
      order.push('create-lines');
      return Promise.resolve({ count: 1 });
    });
    const prisma = {
      subscription: { findUnique: vi.fn().mockResolvedValue({ id: 'sub_local_1' }) },
      invoice: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => {
        order.push('tx-open');
        const result = await fn({
          invoice: { create: invoiceCreate, update: vi.fn() },
          invoiceLineItem: { deleteMany: lineDeleteMany, createMany: lineCreateMany },
        });
        order.push('tx-commit');
        return result;
      }),
    };
    const stripe = {
      invoices: {
        retrieve: vi.fn().mockResolvedValue(stripeInvoice()),
        listLineItems: vi.fn().mockResolvedValue({ data: [stripeLine()], has_more: false }),
      },
    };
    const scoped = new StripeInvoiceReconcilerService(
      prisma as unknown as PrismaService,
      stripe as unknown as Stripe,
    );

    await reconcile(scoped);

    expect(order).toEqual(['tx-open', 'invoice', 'delete-lines', 'create-lines', 'tx-commit']);
  });
});
