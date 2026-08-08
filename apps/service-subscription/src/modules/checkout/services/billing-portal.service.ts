import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BillingPortalSessionResponse } from '@taste-and-see/contracts';
import type Stripe from 'stripe';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { PrismaService } from '../../../prisma/prisma.service';
import { STRIPE_SDK_TOKEN } from '../../stripe/stripe.constants';
import { err, ok, type Result } from '../../subscriptions/result';

/**
 * Failure shapes for the Billing Portal surface. Discriminated so the
 * controller's branch is explicit (CLAUDE.md §2.1).
 */
export type BillingPortalFailure =
  | { readonly reason: 'no_subscription' }
  | { readonly reason: 'no_stripe_customer'; readonly subscriptionId: string }
  | { readonly reason: 'stripe_unavailable'; readonly cause: unknown };

export interface CreatePortalSessionInput {
  /**
   * The household the caller is acting in, resolved from the token's
   * `tenantScope` by the controller. There is no other input, and that
   * is the point — see the class doc-comment.
   */
  readonly householdId: string;
  readonly requesterUserId: string;
}

/**
 * `BillingPortalService` — mints Stripe-hosted Billing Portal sessions
 * (TS-042-followup-3a3-followup-1).
 *
 * **What was missing.** The dunning ladder (TS-042-followup-3a2/-3a3)
 * emails a family whose payment failed and points them at their billing
 * page, which was read-only: `PaymentMethod` rows were reachable only
 * through the admin subscription detail, and no route on the platform
 * created, updated, or defaulted a card. The platform asked families to
 * fix a payment problem and gave them nowhere to do it. The dunning copy
 * was written around that absence, with a test enforcing it.
 *
 * **Why the portal rather than a first-party card form.** Stripe hosts
 * the card entry, so no PAN reaches this platform at any point
 * (CLAUDE.md §3.9, §17.1) and the PCI surface stays Stripe's. The
 * checkout flow already has Elements wired, so a first-party form was
 * possible — it is simply more code carrying more liability for the same
 * outcome.
 *
 * **The customer comes from the token, and nothing else.** A portal
 * session is not a read: its holder can update the payment method, read
 * every invoice, and *cancel the subscription*. Taking a subscription id
 * from the caller — the shape the original task implied — would have
 * escalated the exposure TS-124-followup-scoping had just closed from a
 * read into full billing control. So the household is read from
 * `tenantScope` (the gateway's `HouseholdScopeInterceptor` establishes
 * it) and the subscription resolved here:
 *
 *   `WHERE customer_id = :householdId AND customer_group = 'family'`
 *
 * Stripe's portal is scoped to a **customer**, not a subscription, so
 * this also removes a granularity mismatch an id-in-body shape would
 * have had to paper over: a household with two subscriptions has one
 * Stripe customer and gets one portal covering both.
 *
 * **`family` only, deliberately.** `subscriptions.customer_id` is a soft
 * FK whose target schema depends on `customer_group`
 * (TS-042-followup-3a2a), and a provider's portal needs the
 * provider→account linkage TS-042-followup-3a1a is still blocked on.
 * A non-family caller therefore meets a named refusal rather than an
 * empty result — the two are different facts and a family with no
 * subscription deserves different words from a provider whose case is
 * not built yet.
 */
@Injectable()
export class BillingPortalService {
  private readonly logger = new Logger(BillingPortalService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STRIPE_SDK_TOKEN) private readonly stripe: Stripe,
    @Inject(ENV_TOKEN) private readonly env: Env,
  ) {}

  async createSession(
    input: CreatePortalSessionInput,
  ): Promise<Result<BillingPortalSessionResponse, BillingPortalFailure>> {
    // Most recent first: a household that has re-subscribed after a
    // cancellation may carry more than one row, and the Stripe customer
    // on the newest is the one their card lives on. Every row for a
    // household normally shares a customer, so this only matters at the
    // edges — but "only matters at the edges" is where a family whose
    // renewal is failing actually is.
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        customerId: input.householdId,
        customerGroup: 'family',
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        stripeCustomerId: true,
      },
    });

    if (subscription === null) {
      this.logger.log(
        { householdId: input.householdId, requesterUserId: input.requesterUserId },
        'billing-portal.create no subscription for household',
      );
      return err({ reason: 'no_subscription' });
    }

    if (subscription.stripeCustomerId.length === 0) {
      // Should not happen — a subscription row is written from a Stripe
      // object. If it ever does, it is a data defect, not a customer
      // problem, and it must not be reported to the family as "you have
      // no plan".
      this.logger.error(
        { householdId: input.householdId, subscriptionId: subscription.id },
        'billing-portal.create subscription has no stripe customer id',
      );
      return err({ reason: 'no_stripe_customer', subscriptionId: subscription.id });
    }

    let session: Stripe.BillingPortal.Session;
    try {
      session = await this.stripe.billingPortal.sessions.create({
        customer: subscription.stripeCustomerId,
        return_url: this.env.BILLING_PORTAL_RETURN_URL,
      });
    } catch (cause) {
      this.logger.warn(
        {
          householdId: input.householdId,
          subscriptionId: subscription.id,
          err: stripeErrorMessage(cause),
        },
        'billing-portal.create stripe failure',
      );
      return err({ reason: 'stripe_unavailable', cause });
    }

    // The session URL is a bearer credential for this household's
    // billing — it is never logged, here or anywhere. The success line
    // records that a session was minted, for whom, and by whom, which is
    // what an operator investigating a disputed cancellation needs.
    this.logger.log(
      {
        householdId: input.householdId,
        subscriptionId: subscription.id,
        requesterUserId: input.requesterUserId,
        stripeSessionId: session.id,
      },
      'billing-portal.create ok',
    );

    return ok({ url: session.url });
  }
}

function stripeErrorMessage(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'message' in cause) {
    const message = (cause as { message: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'unknown stripe error';
}
