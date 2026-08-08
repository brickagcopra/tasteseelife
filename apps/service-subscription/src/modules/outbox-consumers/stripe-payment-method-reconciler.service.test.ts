import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import { StripePaymentMethodReconcilerService } from './stripe-payment-method-reconciler.service';

function existingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pm_local_1',
    kind: 'card',
    brand: null,
    last4: null,
    expiryMonth: null,
    expiryYear: null,
    isDefault: true,
    ...overrides,
  };
}

function stripeCard(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'pm_1',
    object: 'payment_method',
    type: 'card',
    card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2030 },
    ...overrides,
  };
}

function build(args?: {
  readonly existing?: Record<string, unknown> | null;
  readonly retrieve?: ReturnType<typeof vi.fn>;
}) {
  const findUnique = vi
    .fn()
    .mockResolvedValue(args?.existing === undefined ? existingRow() : args.existing);
  const update = vi.fn().mockResolvedValue({});
  const retrieve = args?.retrieve ?? vi.fn().mockResolvedValue(stripeCard());

  const prisma = { paymentMethod: { findUnique, update } };
  const stripe = { paymentMethods: { retrieve } };

  const service = new StripePaymentMethodReconcilerService(
    prisma as unknown as PrismaService,
    stripe as unknown as Stripe,
  );
  return { service, findUnique, update, retrieve };
}

function reconcile(
  service: StripePaymentMethodReconcilerService,
  stripeEventType = 'payment_method.attached',
) {
  return service.reconcile({
    stripePaymentMethodId: 'pm_1',
    stripeEventId: 'evt_1',
    stripeEventType,
  });
}

describe('StripePaymentMethodReconcilerService — hydration', () => {
  it('populates the four display fields that have never been written', () => {
    // The whole point of TS-041b-followup-3c: `upsertPaymentMethodMetadata`
    // stores only the handle tuple, so the family billing page had nothing to
    // render a card from.
    const { service, update } = build();

    return reconcile(service).then((outcome) => {
      expect(outcome).toEqual({ kind: 'reconciled', changed: ['displayFields'] });
      const call = update.mock.calls[0]![0] as {
        where: { id: string };
        data: Record<string, unknown>;
      };
      expect(call.where.id).toBe('pm_local_1');
      expect(call.data).toEqual({
        kind: 'card',
        brand: 'visa',
        last4: '4242',
        expiryMonth: 4,
        expiryYear: 2030,
      });
    });
  });

  it('writes NOTHING when the row already agrees', async () => {
    const { service, update } = build({
      existing: existingRow({ brand: 'visa', last4: '4242', expiryMonth: 4, expiryYear: 2030 }),
    });

    await expect(reconcile(service)).resolves.toEqual({ kind: 'no_change' });
    expect(update).not.toHaveBeenCalled();
  });

  it('applies the account-updater expiry change', async () => {
    // `payment_method.automatically_updated` — Stripe replaced an expired
    // card's number/expiry behind the scenes.
    const { service, update } = build({
      existing: existingRow({ brand: 'visa', last4: '4242', expiryMonth: 4, expiryYear: 2030 }),
      retrieve: vi
        .fn()
        .mockResolvedValue(
          stripeCard({ card: { brand: 'visa', last4: '4242', exp_month: 9, exp_year: 2033 } }),
        ),
    });

    const outcome = await reconcile(service, 'payment_method.automatically_updated');
    expect(outcome.kind).toBe('reconciled');
    const data = (update.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data.expiryYear).toBe(2033);
  });

  it('never touches the ownership columns', async () => {
    // `customerId` / `customerGroup` / `stripeCustomerId` belong to the flow
    // that attached the method; a webhook must not re-home a payment method.
    const { service, update } = build();

    await reconcile(service);
    const data = (update.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    for (const forbidden of ['customerId', 'customerGroup', 'stripeCustomerId', 'isDefault']) {
      expect(data, `must not own ${forbidden}`).not.toHaveProperty(forbidden);
    }
  });
});

describe('StripePaymentMethodReconcilerService — detached', () => {
  it('clears the default flag and does NOT call Stripe', async () => {
    // A detached method is not anyone's default; leaving the flag set makes a
    // billing page offer to charge a card Stripe has already let go. Nothing
    // Stripe could tell us changes that, so no fetch.
    const { service, update, retrieve } = build({ existing: existingRow({ isDefault: true }) });

    const outcome = await reconcile(service, 'payment_method.detached');

    expect(outcome).toEqual({ kind: 'reconciled', changed: ['isDefault'] });
    expect(retrieve).not.toHaveBeenCalled();
    expect(update.mock.calls[0]![0]).toEqual({
      where: { id: 'pm_local_1' },
      data: { isDefault: false },
    });
  });

  it('is a no-op when the detached method was not the default', async () => {
    const { service, update } = build({ existing: existingRow({ isDefault: false }) });

    await expect(reconcile(service, 'payment_method.detached')).resolves.toEqual({
      kind: 'no_change',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('KEEPS the row rather than deleting it', async () => {
    // A subscription's history references the method it was charged against.
    const { service, update } = build();
    await reconcile(service, 'payment_method.detached');
    expect(update).toHaveBeenCalledTimes(1);
    expect((update.mock.calls[0]![0] as { data: Record<string, unknown> }).data).toEqual({
      isDefault: false,
    });
  });
});

describe('StripePaymentMethodReconcilerService — the other outcomes', () => {
  it('is a no-op for a payment method with no local row, and costs no Stripe call', async () => {
    const { service, retrieve, update } = build({ existing: null });

    await expect(reconcile(service)).resolves.toEqual({ kind: 'not_tracked' });
    expect(retrieve).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('treats resource_missing as terminal', async () => {
    const missing = new Stripe.errors.StripeInvalidRequestError({
      type: 'invalid_request_error',
      code: 'resource_missing',
      message: 'No such payment method',
    });
    const { service, update } = build({ retrieve: vi.fn().mockRejectedValue(missing) });

    await expect(reconcile(service)).resolves.toEqual({ kind: 'stripe_missing' });
    expect(update).not.toHaveBeenCalled();
  });

  it('re-throws a transient Stripe failure so the SDK retries', async () => {
    const boom = new Error('ECONNRESET');
    const { service } = build({ retrieve: vi.fn().mockRejectedValue(boom) });
    await expect(reconcile(service)).rejects.toBe(boom);
  });

  it('WRITES NOTHING for a payment-method type this platform cannot name', async () => {
    const { service, update } = build({
      retrieve: vi.fn().mockResolvedValue(stripeCard({ type: 'klarna', card: undefined })),
    });

    await expect(reconcile(service)).resolves.toEqual({
      kind: 'unknown_kind',
      stripeType: 'klarna',
    });
    expect(update).not.toHaveBeenCalled();
  });
});
