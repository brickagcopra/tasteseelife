import { Inject, Injectable, Logger } from '@nestjs/common';
import type Stripe from 'stripe';

import type { PlanCustomerGroup } from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';
import { STRIPE_SDK_TOKEN } from '../../stripe/stripe.constants';
import { err, ok, type Result } from '../result';

/**
 * Failure shapes for Stripe customer lookup / creation. Returned via
 * `Result` so the call site cannot accidentally swallow a Stripe error
 * with a generic catch.
 */
export type StripeCustomerFailure =
  | { readonly reason: 'stripe_unavailable'; readonly cause: unknown }
  | { readonly reason: 'invalid_request'; readonly message: string };

export interface ResolveCustomerInput {
  readonly customerId: string;
  readonly customerGroup: PlanCustomerGroup;
  readonly email: string;
  readonly name?: string;
  /**
   * Idempotency key forwarded to Stripe's `Idempotency-Key` header so a
   * retried request reuses the prior result — Stripe-side de-dup
   * (separate from the Redis-backed CLAUDE.md §3.3 cache that lands with
   * TS-044). Optional because not every call has one.
   */
  readonly idempotencyKey?: string;
}

export interface ResolvedCustomer {
  readonly stripeCustomerId: string;
  readonly created: boolean;
}

/**
 * `StripeCustomerService` — looks up the existing Stripe customer for a
 * `(customerId, customerGroup)` tuple, creating it via Stripe API on
 * first touch.
 *
 * **Lookup strategy.** Reading from Stripe alone is not enough — Stripe
 * has no native "find by external id" endpoint that's both fast and
 * reliable. We use a two-step:
 *   1. Look up the platform-side `subscriptions` or `payment_methods`
 *      rows that already point at this customer; if any row carries a
 *      `stripe_customer_id`, return it. Reads are bounded and fast.
 *   2. If no platform-side row exists, create the Stripe Customer with
 *      `metadata.platform_customer_id` + `metadata.customer_group` set
 *      so a later operator audit can trace platform → Stripe.
 *
 * The first row that pins the relationship wins; once persisted the
 * lookup is O(1). A future cache (Redis, TS-044 follow-up) can collapse
 * the lookup further if it becomes a hotspot.
 *
 * **Idempotency.** When an idempotency key is supplied, it's forwarded
 * to Stripe as the `Idempotency-Key` header — a network retry within
 * Stripe's 24h dedup window returns the same Customer rather than
 * creating a duplicate. The key is opaque to us; we never persist it
 * (the Redis replay cache for our OWN endpoint is TS-044's job).
 *
 * **No throws.** Returns `Result<ResolvedCustomer, StripeCustomerFailure>`
 * — Stripe errors and validation failures both come back as `err(...)`
 * so the caller's branch is explicit (CLAUDE.md §2.1 / §17.6 / §3.9).
 */
@Injectable()
export class StripeCustomerService {
  private readonly logger = new Logger(StripeCustomerService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STRIPE_SDK_TOKEN) private readonly stripe: Stripe,
  ) {}

  async resolve(
    input: ResolveCustomerInput,
  ): Promise<Result<ResolvedCustomer, StripeCustomerFailure>> {
    if (input.email.length === 0) {
      return err({ reason: 'invalid_request', message: 'customer email is required' });
    }

    const existing = await this.findExistingStripeCustomerId(input);
    if (existing !== null) {
      this.logger.debug(
        { customerId: input.customerId, customerGroup: input.customerGroup, found: true },
        'stripe-customer.resolve hit',
      );
      return ok({ stripeCustomerId: existing, created: false });
    }

    let stripeCustomer: Stripe.Customer;
    try {
      stripeCustomer = await this.stripe.customers.create(
        {
          email: input.email,
          ...(input.name !== undefined && { name: input.name }),
          metadata: {
            platform_customer_id: input.customerId,
            customer_group: input.customerGroup,
          },
        },
        {
          ...(input.idempotencyKey !== undefined && {
            idempotencyKey: input.idempotencyKey,
          }),
        },
      );
    } catch (cause) {
      this.logger.warn(
        {
          customerId: input.customerId,
          customerGroup: input.customerGroup,
          err: stripeErrorMessage(cause),
        },
        'stripe-customer.create failed',
      );
      return err({ reason: 'stripe_unavailable', cause });
    }

    this.logger.log(
      {
        customerId: input.customerId,
        customerGroup: input.customerGroup,
        stripeCustomerId: stripeCustomer.id,
        created: true,
      },
      'stripe-customer.create ok',
    );
    return ok({ stripeCustomerId: stripeCustomer.id, created: true });
  }

  /**
   * Best-effort lookup against the platform's own persisted rows. Returns
   * the first `stripe_customer_id` we find for the given customer tuple,
   * or null if none exists. Bounded by the unique constraint on
   * subscriptions.stripe_subscription_id + payment_methods.stripe_payment_method_id;
   * we project only the column we need.
   */
  private async findExistingStripeCustomerId(
    input: Pick<ResolveCustomerInput, 'customerId' | 'customerGroup'>,
  ): Promise<string | null> {
    const sub = await this.prisma.subscription.findFirst({
      where: { customerId: input.customerId, customerGroup: input.customerGroup },
      select: { stripeCustomerId: true },
      orderBy: { createdAt: 'desc' },
    });
    if (sub !== null) return sub.stripeCustomerId;

    const pm = await this.prisma.paymentMethod.findFirst({
      where: { customerId: input.customerId, customerGroup: input.customerGroup },
      select: { stripeCustomerId: true },
      orderBy: { createdAt: 'desc' },
    });
    return pm?.stripeCustomerId ?? null;
  }
}

/**
 * Defensive narrowing of an unknown Stripe-thrown value to a log-safe
 * string. The Stripe SDK throws StripeRawError instances with a `.message`
 * field; a non-Error value (CommonJS interop edge case) becomes the
 * literal string `unknown stripe error`.
 *
 * Never logs `cause.headers`, `cause.requestId`, or any field that could
 * contain card-data echoes (defence-in-depth — the SDK already redacts,
 * but we don't trust by transitive policy).
 */
function stripeErrorMessage(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'message' in cause) {
    const message = (cause as { message: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'unknown stripe error';
}
