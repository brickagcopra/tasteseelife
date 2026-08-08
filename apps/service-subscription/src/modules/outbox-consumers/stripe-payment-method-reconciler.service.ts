import { Inject, Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';

import { PrismaService } from '../../prisma/prisma.service';
import { STRIPE_SDK_TOKEN } from '../stripe/stripe.constants';
import {
  mapStripePaymentMethod,
  paymentMethodDiffers,
  type MappedPaymentMethod,
} from './stripe-payment-method-mapping';

export type PaymentMethodReconcileOutcome =
  | { readonly kind: 'reconciled'; readonly changed: readonly string[] }
  | { readonly kind: 'no_change' }
  | { readonly kind: 'not_tracked' }
  | { readonly kind: 'stripe_missing' }
  | { readonly kind: 'unknown_kind'; readonly stripeType: string };

/**
 * Hydrates `payment_methods.brand` / `last4` / `expiry_month` / `expiry_year`
 * from Stripe (TS-041b-followup-3c; PRD §6.2; PDD §11.1).
 *
 * **Those four columns have been nullable and never populated since TS-041b.**
 * `upsertPaymentMethodMetadata` stores only the handle tuple, so the family
 * billing page cannot render a card without its own Stripe round-trip. This is
 * the handler that fills them.
 *
 * Third copy of the shape TS-041b-followup-3a established and 3b inherited,
 * intentionally: re-fetch rather than trust the payload, `resource_missing`
 * terminal / transient throw, no local row is a no-op, an unrepresentable
 * value writes nothing.
 *
 * **`detached` is a real branch, not a skip.** Stripe clears the customer link
 * before emitting it, which is why the relayed payload's `stripeCustomerId` is
 * null on that event and why the row is identified by
 * `stripePaymentMethodId` — the one handle the contract never allows to be
 * null. The row is kept (a subscription's history references it) and its
 * `isDefault` flag is cleared, because a detached method is not anyone's
 * default and leaving the flag set makes a billing page offer to charge a card
 * Stripe has already let go.
 */
@Injectable()
export class StripePaymentMethodReconcilerService {
  private readonly logger = new Logger(StripePaymentMethodReconcilerService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STRIPE_SDK_TOKEN) private readonly stripe: Stripe,
  ) {}

  async reconcile(args: {
    readonly stripePaymentMethodId: string;
    readonly stripeEventId: string;
    readonly stripeEventType: string;
  }): Promise<PaymentMethodReconcileOutcome> {
    const { stripePaymentMethodId, stripeEventId, stripeEventType } = args;

    const existing = await this.prisma.paymentMethod.findUnique({
      where: { stripePaymentMethodId },
      select: {
        id: true,
        kind: true,
        brand: true,
        last4: true,
        expiryMonth: true,
        expiryYear: true,
        isDefault: true,
      },
    });

    if (existing === null) {
      // Same reasoning as the sibling reconcilers: only the flow that attached
      // the method knows its `customerId` / `customerGroup`, and a payment
      // method row invented from a webhook would belong to nobody.
      this.logger.log(
        `stripe.payment_method.reconcile.not_tracked ${JSON.stringify({
          stripeEventId,
          stripeEventType,
          stripePaymentMethodId,
        })}`,
      );
      return { kind: 'not_tracked' };
    }

    if (stripeEventType === 'payment_method.detached') {
      return this.applyDetached({
        id: existing.id,
        isDefault: existing.isDefault,
        stripeEventId,
        stripePaymentMethodId,
      });
    }

    const fetched = await this.fetch(stripePaymentMethodId);
    if (fetched === null) {
      this.logger.error(
        `stripe.payment_method.reconcile.stripe_missing ${JSON.stringify({
          stripeEventId,
          stripeEventType,
          stripePaymentMethodId,
        })}`,
      );
      return { kind: 'stripe_missing' };
    }

    const mapped = mapStripePaymentMethod(fetched);
    if (mapped.kind === 'unknown_kind') {
      this.logger.error(
        `stripe.payment_method.reconcile.unknown_kind ${JSON.stringify({
          stripeEventId,
          stripePaymentMethodId,
          stripeType: mapped.stripeType,
        })} — refusing to file it as a kind it is not`,
      );
      return { kind: 'unknown_kind', stripeType: mapped.stripeType };
    }

    const current: MappedPaymentMethod = {
      kind: existing.kind as MappedPaymentMethod['kind'],
      brand: existing.brand,
      last4: existing.last4,
      expiryMonth: existing.expiryMonth,
      expiryYear: existing.expiryYear,
    };

    if (!paymentMethodDiffers(mapped.fields, current)) {
      return { kind: 'no_change' };
    }

    await this.prisma.paymentMethod.update({
      where: { id: existing.id },
      data: { ...mapped.fields },
    });

    this.logger.log(
      `stripe.payment_method.reconciled ${JSON.stringify({
        stripeEventId,
        stripeEventType,
        paymentMethodId: existing.id,
        kind: mapped.fields.kind,
        // Deliberately NOT logging brand/last4 — display metadata for a named
        // family's card does not belong in a log line (CLAUDE.md §3.9, §10).
      })}`,
    );

    return { kind: 'reconciled', changed: ['displayFields'] };
  }

  /**
   * A detached method: clear the default flag, keep the row.
   *
   * No Stripe fetch — the object is still retrievable but its customer link is
   * already gone, so there is nothing to learn that changes what happens here.
   */
  private async applyDetached(args: {
    readonly id: string;
    readonly isDefault: boolean;
    readonly stripeEventId: string;
    readonly stripePaymentMethodId: string;
  }): Promise<PaymentMethodReconcileOutcome> {
    if (!args.isDefault) return { kind: 'no_change' };

    await this.prisma.paymentMethod.update({
      where: { id: args.id },
      data: { isDefault: false },
    });

    this.logger.log(
      `stripe.payment_method.detached ${JSON.stringify({
        stripeEventId: args.stripeEventId,
        paymentMethodId: args.id,
      })} — cleared default flag`,
    );

    return { kind: 'reconciled', changed: ['isDefault'] };
  }

  /** See the subscription reconciler's twin for the terminal/transient split. */
  private async fetch(stripePaymentMethodId: string): Promise<Stripe.PaymentMethod | null> {
    try {
      return await this.stripe.paymentMethods.retrieve(stripePaymentMethodId);
    } catch (err) {
      if (
        err instanceof Stripe.errors.StripeInvalidRequestError &&
        err.code === 'resource_missing'
      ) {
        return null;
      }
      throw err;
    }
  }
}
