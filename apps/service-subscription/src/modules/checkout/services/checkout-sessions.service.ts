import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  SUBSCRIPTION_ACTIVATED,
  type BillingInterval,
  type CreateCheckoutSessionRequest,
  type CreateCheckoutSessionResponse,
  type GetCheckoutSessionResponse,
  type PlanCustomerGroup,
  type SubscriptionResponse,
  type SubscriptionStatus,
} from '@taste-and-see/contracts';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';
import Decimal from 'decimal.js';
import type Stripe from 'stripe';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';
import { CouponsService, type ValidatedCoupon } from '../../coupons/services/coupons.service';
import { STRIPE_SDK_TOKEN } from '../../stripe/stripe.constants';
import { mapStripeStatus } from '../../subscriptions/mappers/stripe-status.mapper';
import {
  toSubscriptionResponse,
  type SubscriptionDtoSource,
} from '../../subscriptions/mappers/subscription.mapper';
import { err, ok, type Result } from '../../subscriptions/result';
import { StripeCustomerService } from '../../subscriptions/services/stripe-customer.service';

/**
 * Failure shapes returned by the CheckoutSessionsService (TS-124). Mirrors
 * the SubscriptionsService failure enum so the controller's `throwFailure`
 * branch is a thin extension.
 */
export type CheckoutSessionsFailure =
  | { readonly reason: 'plan_not_found'; readonly planId: string }
  | { readonly reason: 'plan_inactive'; readonly planId: string }
  | {
      readonly reason: 'plan_group_mismatch';
      readonly planId: string;
      readonly expected: PlanCustomerGroup;
      readonly actual: PlanCustomerGroup;
    }
  | { readonly reason: 'session_not_found'; readonly sessionId: string }
  | { readonly reason: 'session_not_subscription_mode'; readonly sessionId: string }
  | { readonly reason: 'session_not_complete'; readonly sessionId: string; readonly status: string }
  | {
      readonly reason: 'session_metadata_invalid';
      readonly sessionId: string;
      readonly missingKey: string;
    }
  | { readonly reason: 'subscription_not_found'; readonly stripeSubscriptionId: string }
  | { readonly reason: 'stripe_unavailable'; readonly cause: unknown }
  | { readonly reason: 'invalid_request'; readonly message: string }
  | {
      readonly reason: 'coupon_invalid';
      readonly couponCode: string;
      readonly failureReason: string;
    }
  | {
      readonly reason: 'outbox_validation_failed';
      readonly eventName: string;
      readonly message: string;
    };

export interface CreateCheckoutSessionInput {
  readonly request: CreateCheckoutSessionRequest;
  readonly requesterUserId: string;
  readonly idempotencyKey?: string;
}

export interface GetCheckoutSessionInput {
  readonly sessionId: string;
  readonly requesterUserId: string;
}

export interface FinalizeCheckoutSessionInput {
  readonly sessionId: string;
  readonly requesterUserId: string;
  readonly idempotencyKey?: string;
}

interface PlanRecord {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly customerGroup: PlanCustomerGroup;
  readonly monthlyPrice: Decimal;
  readonly annualPrice: Decimal;
  readonly currency: string;
  readonly active: boolean;
  readonly stripeProductId: string | null;
}

/**
 * Keys we stamp on the Stripe Checkout Session's `metadata` map so the
 * `finalize` step can rehydrate the local subscription row without a
 * cross-service lookup. Stripe propagates these to the resulting
 * Subscription via the `subscription_data.metadata` we set; we ALSO put
 * them on the Session itself so a session that never produced a
 * subscription (expired / abandoned) can still be triaged.
 */
const SESSION_METADATA_KEYS = {
  planId: 'platform_plan_id',
  planCode: 'plan_code',
  customerId: 'platform_customer_id',
  customerGroup: 'customer_group',
  billingInterval: 'billing_interval',
  requesterUserId: 'requester_user_id',
  couponCode: 'coupon_code',
} as const;

/**
 * `CheckoutSessionsService` — owns the Stripe Checkout hosted-page flow
 * (TS-124).
 *
 * Three operations:
 *
 *   1. `create` — validates the plan + coupon, resolves the Stripe
 *      customer + product, and asks Stripe to mint a Checkout Session in
 *      `subscription` mode. Returns the hosted URL the portal redirects
 *      to. No local persistence — the subscription row is created at
 *      `finalize` time when we know the payment cleared.
 *
 *   2. `get` — retrieves the session from Stripe (pure read). If the
 *      session has completed and a local Subscription row exists for
 *      the resulting `sub_...`, the row's id is included so the portal
 *      can deep-link to the subscription detail page.
 *
 *   3. `finalize` — given a completed Checkout Session, creates the local
 *      Subscription row + outbox `subscription.activated` event + audit
 *      history entry. **Idempotent on `stripeSubscriptionId`** — replays
 *      after the row exists return the existing row. This keeps the
 *      portal's success page free to retry without producing duplicate
 *      rows.
 *
 * Why no local "pending" row at create time: a session that expires
 * without payment leaves no trace on our side, which keeps the data
 * model honest about what actually billed. The trade-off is that an
 * operator can't see in-flight checkouts in admin tooling — captured
 * as a TS-124 follow-up.
 *
 * **Money math.** Every conversion uses `Decimal`. The plan's
 * `monthlyPrice` / `annualPrice` are `Decimal` from Prisma; we convert
 * to integer minor units only at the Stripe boundary (CLAUDE.md §17.6).
 *
 * **Idempotency.** The optional `idempotencyKey` is forwarded to Stripe
 * with `:phase` suffixes so each Stripe call de-dups independently
 * within Stripe's 24h window. The cross-service Redis cache (TS-044)
 * sits in front via `@Idempotent()` on the controller.
 *
 * **Authorization.** Today the service verifies authentication only;
 * row-level checks (the family-payer can only create a checkout for
 * their household) land with the Prisma tenant-scoping extension
 * (TS-141). Audit log is the trust gate until then.
 */
@Injectable()
export class CheckoutSessionsService {
  private readonly logger = new Logger(CheckoutSessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: StripeCustomerService,
    @Inject(STRIPE_SDK_TOKEN) private readonly stripe: Stripe,
    private readonly coupons: CouponsService,
    private readonly outbox: OutboxService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────
  // CREATE
  // ─────────────────────────────────────────────────────────────────────

  async create(
    input: CreateCheckoutSessionInput,
  ): Promise<Result<CreateCheckoutSessionResponse, CheckoutSessionsFailure>> {
    const planResult = await this.loadPlanForCreate(input.request);
    if (!planResult.ok) return planResult;
    let plan = planResult.value;

    const customerResult = await this.customers.resolve({
      customerId: input.request.customerId,
      customerGroup: input.request.customerGroup,
      email: input.request.customerEmail,
      ...(input.request.customerName !== undefined && { name: input.request.customerName }),
      ...(input.idempotencyKey !== undefined && {
        idempotencyKey: `${input.idempotencyKey}:cust`,
      }),
    });
    if (!customerResult.ok) {
      if (customerResult.error.reason === 'invalid_request') {
        return err({ reason: 'invalid_request', message: customerResult.error.message });
      }
      return err({ reason: 'stripe_unavailable', cause: customerResult.error.cause });
    }
    const stripeCustomerId = customerResult.value.stripeCustomerId;

    const productResult = await this.ensureStripeProduct(plan, input.idempotencyKey);
    if (!productResult.ok) return productResult;
    plan = productResult.value;

    const unitPriceDecimal = unitPriceFor(plan, input.request.billingInterval);

    let validatedCoupon: ValidatedCoupon | null = null;
    let stripeCouponId: string | null = null;
    let effectiveTrialDays = input.request.trialDays;
    if (input.request.couponCode !== undefined) {
      const monthlyMinor = decimalToMinorUnits(plan.monthlyPrice);
      const annualMinor = decimalToMinorUnits(plan.annualPrice);
      const validationResult = await this.coupons.validate(
        {
          code: input.request.couponCode,
          planId: plan.id,
          customerId: input.request.customerId,
          customerGroup: input.request.customerGroup,
        },
        {
          id: plan.id,
          currency: plan.currency,
          monthlyPriceMinor: monthlyMinor,
          annualPriceMinor: annualMinor,
        },
        input.request.billingInterval,
      );
      if (!validationResult.ok) {
        return err({
          reason: 'coupon_invalid',
          couponCode: input.request.couponCode,
          failureReason: validationResult.error.reason,
        });
      }
      validatedCoupon = validationResult.value;

      if (validatedCoupon.kind === 'extended_trial' && validatedCoupon.extendedTrialDays !== null) {
        effectiveTrialDays = (input.request.trialDays ?? 0) + validatedCoupon.extendedTrialDays;
      } else {
        const ensureResult = await this.coupons.ensureStripeCoupon(
          validatedCoupon.id,
          input.idempotencyKey,
        );
        if (!ensureResult.ok) {
          if (ensureResult.error.reason === 'stripe_unavailable') {
            return err({ reason: 'stripe_unavailable', cause: ensureResult.error.cause });
          }
          return err({
            reason: 'coupon_invalid',
            couponCode: input.request.couponCode,
            failureReason: ensureResult.error.reason,
          });
        }
        stripeCouponId = ensureResult.value;
      }
    }

    const metadata: Record<string, string> = {
      [SESSION_METADATA_KEYS.planId]: plan.id,
      [SESSION_METADATA_KEYS.planCode]: plan.code,
      [SESSION_METADATA_KEYS.customerId]: input.request.customerId,
      [SESSION_METADATA_KEYS.customerGroup]: input.request.customerGroup,
      [SESSION_METADATA_KEYS.billingInterval]: input.request.billingInterval,
      [SESSION_METADATA_KEYS.requesterUserId]: input.requesterUserId,
    };
    if (input.request.couponCode !== undefined) {
      metadata[SESSION_METADATA_KEYS.couponCode] = input.request.couponCode;
    }

    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripe.checkout.sessions.create(
        {
          mode: 'subscription',
          customer: stripeCustomerId,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: plan.currency.toLowerCase(),
                product: requireProductId(plan),
                unit_amount: decimalToMinorUnits(unitPriceDecimal),
                recurring: {
                  interval: input.request.billingInterval === 'monthly' ? 'month' : 'year',
                },
              },
            },
          ],
          ...(stripeCouponId !== null && {
            discounts: [{ coupon: stripeCouponId }],
          }),
          subscription_data: {
            ...(effectiveTrialDays !== undefined &&
              effectiveTrialDays > 0 && { trial_period_days: effectiveTrialDays }),
            metadata: { ...metadata },
          },
          success_url: input.request.successUrl,
          cancel_url: input.request.cancelUrl,
          metadata,
        },
        {
          ...(input.idempotencyKey !== undefined && {
            idempotencyKey: `${input.idempotencyKey}:session`,
          }),
        },
      );
    } catch (cause) {
      this.logger.warn(
        {
          requesterUserId: input.requesterUserId,
          planId: plan.id,
          err: stripeErrorMessage(cause),
        },
        'checkout-sessions.create stripe failure',
      );
      return err({ reason: 'stripe_unavailable', cause });
    }

    if (session.url === null) {
      // Defensive: Stripe should always return a URL for a mode=subscription
      // session. Treat the absence as an upstream failure rather than
      // returning an unusable response.
      this.logger.error(
        { sessionId: session.id },
        'checkout-sessions.create returned without a hosted url',
      );
      return err({ reason: 'stripe_unavailable', cause: new Error('session has no url') });
    }

    this.logger.log(
      {
        sessionId: session.id,
        planId: plan.id,
        customerId: input.request.customerId,
      },
      'checkout-sessions.create ok',
    );

    return ok({
      id: session.id,
      url: session.url,
      expiresAt: unixToIsoDate(session.expires_at),
      status: mapSessionStatus(session.status),
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // GET
  // ─────────────────────────────────────────────────────────────────────

  async get(
    input: GetCheckoutSessionInput,
  ): Promise<Result<GetCheckoutSessionResponse, CheckoutSessionsFailure>> {
    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripe.checkout.sessions.retrieve(input.sessionId);
    } catch (cause) {
      if (isResourceMissingError(cause)) {
        return err({ reason: 'session_not_found', sessionId: input.sessionId });
      }
      this.logger.warn(
        { sessionId: input.sessionId, err: stripeErrorMessage(cause) },
        'checkout-sessions.get stripe failure',
      );
      return err({ reason: 'stripe_unavailable', cause });
    }

    if (session.url === null) {
      this.logger.error(
        { sessionId: session.id },
        'checkout-sessions.get returned without a hosted url',
      );
      return err({ reason: 'stripe_unavailable', cause: new Error('session has no url') });
    }

    const stripeSubscriptionId = extractSubscriptionId(session);
    let subscriptionId: string | null = null;
    if (stripeSubscriptionId !== null) {
      const local = await this.prisma.subscription.findUnique({
        where: { stripeSubscriptionId },
        select: { id: true, customerId: true },
      });
      if (local !== null) {
        subscriptionId = local.id;
      }
    }

    return ok({
      id: session.id,
      url: session.url,
      expiresAt: unixToIsoDate(session.expires_at),
      status: mapSessionStatus(session.status),
      stripeSubscriptionId,
      subscriptionId,
      customerEmail: session.customer_details?.email ?? null,
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // FINALIZE
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Promote a completed Checkout Session into a local Subscription row.
   *
   * **Idempotent**: replay after the row exists returns the existing row.
   * Two concurrent finalizes for the same session race on the unique
   * constraint over `stripe_subscription_id`; the loser re-reads.
   *
   * Returns:
   *  - `ok(SubscriptionResponse)` on success or when the row already
   *    exists.
   *  - `err(session_not_complete)` if the session has not been paid yet
   *    (portal should re-poll).
   *  - `err(session_not_subscription_mode)` for an operator misuse.
   *  - `err(session_metadata_invalid)` when the metadata stamped at
   *    create time is missing (a Phase-1-style "we created the session
   *    via the API and then someone hand-edited it in the Dashboard"
   *    scenario — refuse rather than guess).
   */
  async finalize(
    input: FinalizeCheckoutSessionInput,
  ): Promise<Result<SubscriptionResponse, CheckoutSessionsFailure>> {
    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripe.checkout.sessions.retrieve(input.sessionId, {
        expand: ['subscription'],
      });
    } catch (cause) {
      if (isResourceMissingError(cause)) {
        return err({ reason: 'session_not_found', sessionId: input.sessionId });
      }
      this.logger.warn(
        { sessionId: input.sessionId, err: stripeErrorMessage(cause) },
        'checkout-sessions.finalize stripe-retrieve failure',
      );
      return err({ reason: 'stripe_unavailable', cause });
    }

    if (session.mode !== 'subscription') {
      return err({ reason: 'session_not_subscription_mode', sessionId: session.id });
    }
    if (session.status !== 'complete') {
      return err({
        reason: 'session_not_complete',
        sessionId: session.id,
        status: session.status ?? 'unknown',
      });
    }
    const paymentStatus = session.payment_status;
    if (paymentStatus !== 'paid' && paymentStatus !== 'no_payment_required') {
      return err({
        reason: 'session_not_complete',
        sessionId: session.id,
        status: `payment_status=${paymentStatus}`,
      });
    }

    const stripeSubscriptionId = extractSubscriptionId(session);
    if (stripeSubscriptionId === null) {
      return err({
        reason: 'session_not_complete',
        sessionId: session.id,
        status: 'no subscription on session',
      });
    }

    const existing = await this.loadLocalSubscriptionWithPlan(stripeSubscriptionId);
    if (existing !== null) {
      this.logger.log(
        { sessionId: session.id, subscriptionId: existing.subscription.id },
        'checkout-sessions.finalize replay returns existing row',
      );
      return ok(buildSubscriptionResponse(existing.subscription, existing.plan));
    }

    const planId = readSessionMetadata(session, SESSION_METADATA_KEYS.planId);
    if (planId === null) {
      return err({
        reason: 'session_metadata_invalid',
        sessionId: session.id,
        missingKey: SESSION_METADATA_KEYS.planId,
      });
    }
    const customerId = readSessionMetadata(session, SESSION_METADATA_KEYS.customerId);
    if (customerId === null) {
      return err({
        reason: 'session_metadata_invalid',
        sessionId: session.id,
        missingKey: SESSION_METADATA_KEYS.customerId,
      });
    }
    const customerGroupRaw = readSessionMetadata(session, SESSION_METADATA_KEYS.customerGroup);
    if (customerGroupRaw === null || !isCustomerGroup(customerGroupRaw)) {
      return err({
        reason: 'session_metadata_invalid',
        sessionId: session.id,
        missingKey: SESSION_METADATA_KEYS.customerGroup,
      });
    }
    const billingIntervalRaw = readSessionMetadata(session, SESSION_METADATA_KEYS.billingInterval);
    if (billingIntervalRaw === null || !isBillingInterval(billingIntervalRaw)) {
      return err({
        reason: 'session_metadata_invalid',
        sessionId: session.id,
        missingKey: SESSION_METADATA_KEYS.billingInterval,
      });
    }
    const customerGroup = customerGroupRaw;
    const billingInterval = billingIntervalRaw;

    const planResult = await this.loadPlan(planId);
    if (!planResult.ok) return planResult;
    const plan = planResult.value;
    const unitPriceDecimal = unitPriceFor(plan, billingInterval);

    let stripeSubscription: Stripe.Subscription;
    try {
      stripeSubscription = await this.stripe.subscriptions.retrieve(stripeSubscriptionId);
    } catch (cause) {
      this.logger.warn(
        {
          sessionId: session.id,
          stripeSubscriptionId,
          err: stripeErrorMessage(cause),
        },
        'checkout-sessions.finalize subscription-retrieve failure',
      );
      return err({ reason: 'stripe_unavailable', cause });
    }

    const stripeCustomerId =
      typeof session.customer === 'string' ? session.customer : session.customer?.id;
    if (stripeCustomerId === undefined || stripeCustomerId === null) {
      return err({
        reason: 'session_metadata_invalid',
        sessionId: session.id,
        missingKey: 'customer',
      });
    }

    const status = mapStripeStatus(stripeSubscription.status);
    const periodStart = unixToDate(getCurrentPeriodStart(stripeSubscription));
    const periodEnd = unixToDate(getCurrentPeriodEnd(stripeSubscription));
    const trialEnd =
      stripeSubscription.trial_end !== null ? unixToDate(stripeSubscription.trial_end) : null;
    const now = new Date();

    let persisted: PersistedSubscriptionRow;
    try {
      persisted = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
        // Race: a concurrent finalize may have raced us to the create.
        // Re-check inside the tx so we converge cleanly on the existing
        // row rather than tripping the unique constraint.
        const racer = await tx.subscription.findUnique({
          where: { stripeSubscriptionId },
        });
        if (racer !== null) {
          return racer as unknown as PersistedSubscriptionRow;
        }

        const created = await tx.subscription.create({
          data: {
            stripeSubscriptionId,
            stripeCustomerId,
            customerId,
            customerGroup,
            planId: plan.id,
            status,
            billingInterval,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            trialEnd,
          },
        });

        await tx.subscriptionHistory.create({
          data: {
            subscriptionId: created.id,
            event: 'created',
            fromStatus: null,
            toStatus: status,
            context: {
              planId: plan.id,
              planCode: plan.code,
              billingInterval,
              stripeSubscriptionId,
              checkoutSessionId: session.id,
            },
            actorUserId: input.requesterUserId,
            actorKind: 'user',
          },
        });

        const activationAmountMinor = decimalToMinorUnits(unitPriceDecimal);
        const activatedResult = await this.outbox.append(tx as unknown as OutboxRawExecutor, {
          eventName: SUBSCRIPTION_ACTIVATED,
          eventId: `${created.id}.activated`,
          occurredAt: now,
          payload: {
            eventId: `${created.id}.activated`,
            occurredAt: now.toISOString(),
            subscriptionId: created.id,
            customerId,
            customerGroup,
            planId: plan.id,
            planCode: plan.code,
            periodStart: periodStart.toISOString(),
            periodEnd: periodEnd.toISOString(),
            amountMinor: activationAmountMinor,
            currency: plan.currency,
          },
        });
        if (activatedResult.kind !== 'appended') {
          throw new FinalizeOutboxValidationFailed(
            activatedResult.eventName,
            JSON.stringify(activatedResult.issues),
          );
        }

        return created as unknown as PersistedSubscriptionRow;
      });
    } catch (e) {
      if (e instanceof FinalizeOutboxValidationFailed) {
        this.logger.error(
          { eventName: e.eventName, sessionId: session.id },
          'checkout-sessions.finalize outbox validation failed; tx rolled back',
        );
        return err({
          reason: 'outbox_validation_failed',
          eventName: e.eventName,
          message: `event ${e.eventName} payload failed validation`,
        });
      }
      throw e;
    }

    this.logger.log(
      {
        sessionId: session.id,
        subscriptionId: persisted.id,
        stripeSubscriptionId,
        planId: plan.id,
        status,
      },
      'checkout-sessions.finalize ok',
    );

    return ok(toSubscriptionResponse(toDtoSource(persisted, plan, unitPriceDecimal)));
  }

  // ─────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────

  private async loadPlanForCreate(
    request: CreateCheckoutSessionRequest,
  ): Promise<Result<PlanRecord, CheckoutSessionsFailure>> {
    const planResult = await this.loadPlan(request.planId);
    if (!planResult.ok) return planResult;
    const plan = planResult.value;
    if (plan.customerGroup !== request.customerGroup) {
      return err({
        reason: 'plan_group_mismatch',
        planId: plan.id,
        expected: request.customerGroup,
        actual: plan.customerGroup,
      });
    }
    return ok(plan);
  }

  private async loadPlan(planId: string): Promise<Result<PlanRecord, CheckoutSessionsFailure>> {
    const plan = await this.prisma.plan.findUnique({
      where: { id: planId },
      select: {
        id: true,
        code: true,
        name: true,
        customerGroup: true,
        monthlyPrice: true,
        annualPrice: true,
        currency: true,
        active: true,
        stripeProductId: true,
      },
    });
    if (plan === null) {
      return err({ reason: 'plan_not_found', planId });
    }
    if (!plan.active) {
      return err({ reason: 'plan_inactive', planId });
    }
    return ok({
      id: plan.id,
      code: plan.code,
      name: plan.name,
      customerGroup: plan.customerGroup as PlanCustomerGroup,
      monthlyPrice: plan.monthlyPrice,
      annualPrice: plan.annualPrice,
      currency: plan.currency,
      active: plan.active,
      stripeProductId: plan.stripeProductId,
    });
  }

  /**
   * Lazy-create the Stripe Product backing this plan. Mirrors the same
   * pattern in `SubscriptionsService.ensureStripeProduct` — the
   * `plans.stripe_product_id` column is a write-once cache; concurrent
   * first-touches are bounded by Stripe-side idempotency.
   */
  private async ensureStripeProduct(
    plan: PlanRecord,
    idempotencyKey: string | undefined,
  ): Promise<Result<PlanRecord, CheckoutSessionsFailure>> {
    if (plan.stripeProductId !== null) {
      return ok(plan);
    }
    let product: Stripe.Product;
    try {
      product = await this.stripe.products.create(
        {
          name: plan.name,
          metadata: {
            platform_plan_id: plan.id,
            plan_code: plan.code,
          },
        },
        {
          idempotencyKey:
            idempotencyKey !== undefined
              ? `${idempotencyKey}:product:${plan.id}`
              : `plan-product:${plan.id}`,
        },
      );
    } catch (cause) {
      this.logger.warn(
        { planId: plan.id, err: stripeErrorMessage(cause) },
        'checkout-sessions.ensureStripeProduct stripe failure',
      );
      return err({ reason: 'stripe_unavailable', cause });
    }
    await this.prisma.plan.update({
      where: { id: plan.id },
      data: { stripeProductId: product.id },
    });
    return ok({ ...plan, stripeProductId: product.id });
  }

  /**
   * Resolve `stripeSubscriptionId` to a local `Subscription` + its plan.
   * Returns null when the row does not exist (the finalize callsite uses
   * this to decide whether to take the create branch).
   */
  private async loadLocalSubscriptionWithPlan(stripeSubscriptionId: string): Promise<{
    readonly subscription: PersistedSubscriptionRow;
    readonly plan: PlanRecord;
  } | null> {
    const row = await this.prisma.subscription.findUnique({
      where: { stripeSubscriptionId },
      include: { plan: true },
    });
    if (row === null) return null;
    const { plan, ...rest } = row;
    return {
      subscription: rest as unknown as PersistedSubscriptionRow,
      plan: {
        id: plan.id,
        code: plan.code,
        name: plan.name,
        customerGroup: plan.customerGroup as PlanCustomerGroup,
        monthlyPrice: plan.monthlyPrice,
        annualPrice: plan.annualPrice,
        currency: plan.currency,
        active: plan.active,
        stripeProductId: plan.stripeProductId,
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Module-private helpers
// ─────────────────────────────────────────────────────────────────────────

class FinalizeOutboxValidationFailed extends Error {
  constructor(
    public readonly eventName: string,
    message: string,
  ) {
    super(message);
    this.name = 'FinalizeOutboxValidationFailed';
  }
}

interface PersistedSubscriptionRow {
  readonly id: string;
  readonly stripeSubscriptionId: string;
  readonly stripeCustomerId: string;
  readonly customerId: string;
  readonly customerGroup: string;
  readonly planId: string;
  readonly status: string;
  readonly billingInterval: string;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly trialEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly cancelReason: string | null;
  readonly canceledAt: Date | null;
  readonly dunningAttempts: number;
  readonly dunningLastAttemptAt: Date | null;
  readonly dunningGraceUntil: Date | null;
  readonly pauseCollectionStartedAt: Date | null;
  readonly pauseCollectionResumesAt: Date | null;
  readonly pauseReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function unitPriceFor(plan: PlanRecord, interval: BillingInterval): Decimal {
  return interval === 'monthly' ? plan.monthlyPrice : plan.annualPrice;
}

function decimalToMinorUnits(value: Decimal): number {
  return value
    .toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN)
    .mul(100)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN)
    .toNumber();
}

function unixToDate(seconds: number): Date {
  return new Date(seconds * 1000);
}

function unixToIsoDate(seconds: number | null | undefined): string {
  if (typeof seconds === 'number') {
    return new Date(seconds * 1000).toISOString();
  }
  // Defensive: Stripe always returns expires_at on a Session, but the SDK
  // type allows null. Surface "now" as a degraded fallback so the contract
  // never breaks.
  return new Date().toISOString();
}

function mapSessionStatus(
  status: Stripe.Checkout.Session.Status | null,
): 'open' | 'complete' | 'expired' {
  switch (status) {
    case 'complete':
      return 'complete';
    case 'expired':
      return 'expired';
    default:
      return 'open';
  }
}

function readSessionMetadata(session: Stripe.Checkout.Session, key: string): string | null {
  const value = session.metadata?.[key];
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

function extractSubscriptionId(session: Stripe.Checkout.Session): string | null {
  const sub = session.subscription;
  if (sub === null || sub === undefined) return null;
  if (typeof sub === 'string') return sub;
  return sub.id;
}

function isCustomerGroup(value: string): value is PlanCustomerGroup {
  return value === 'family' || value === 'provider' || value === 'academy';
}

function isBillingInterval(value: string): value is BillingInterval {
  return value === 'monthly' || value === 'annual';
}

function getCurrentPeriodStart(sub: Stripe.Subscription): number {
  if (typeof sub.current_period_start === 'number') return sub.current_period_start;
  const itemPeriodStart = (
    sub.items.data[0] as unknown as
      | {
          current_period_start?: number;
        }
      | undefined
  )?.current_period_start;
  if (typeof itemPeriodStart === 'number') return itemPeriodStart;
  return Math.floor(Date.now() / 1000);
}

function getCurrentPeriodEnd(sub: Stripe.Subscription): number {
  if (typeof sub.current_period_end === 'number') return sub.current_period_end;
  const itemPeriodEnd = (
    sub.items.data[0] as unknown as
      | {
          current_period_end?: number;
        }
      | undefined
  )?.current_period_end;
  if (typeof itemPeriodEnd === 'number') return itemPeriodEnd;
  return Math.floor(Date.now() / 1000);
}

function isResourceMissingError(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false;
  const code = (cause as { code?: unknown }).code;
  if (code === 'resource_missing') return true;
  const status = (cause as { statusCode?: unknown }).statusCode;
  return status === 404;
}

function stripeErrorMessage(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'message' in cause) {
    const message = (cause as { message: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'unknown stripe error';
}

function requireProductId(plan: PlanRecord): string {
  if (plan.stripeProductId === null) {
    throw new Error(`plan ${plan.id} has no stripeProductId; ensureStripeProduct was skipped`);
  }
  return plan.stripeProductId;
}

function toDtoSource(
  row: PersistedSubscriptionRow,
  plan: PlanRecord,
  unitPriceDecimal: Decimal,
): SubscriptionDtoSource {
  return {
    id: row.id,
    stripeSubscriptionId: row.stripeSubscriptionId,
    stripeCustomerId: row.stripeCustomerId,
    customerId: row.customerId,
    customerGroup: row.customerGroup as SubscriptionDtoSource['customerGroup'],
    planId: row.planId,
    planCode: plan.code,
    status: row.status as SubscriptionStatus,
    billingInterval: row.billingInterval as BillingInterval,
    unitPriceDecimal,
    currency: plan.currency,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    trialEnd: row.trialEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    cancelReason:
      row.cancelReason !== null
        ? (row.cancelReason as SubscriptionDtoSource['cancelReason'])
        : null,
    canceledAt: row.canceledAt,
    dunningAttempts: row.dunningAttempts,
    dunningLastAttemptAt: row.dunningLastAttemptAt,
    dunningGraceUntil: row.dunningGraceUntil,
    pauseCollectionStartedAt: row.pauseCollectionStartedAt,
    pauseCollectionResumesAt: row.pauseCollectionResumesAt,
    pauseReason: row.pauseReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function buildSubscriptionResponse(
  row: PersistedSubscriptionRow,
  plan: PlanRecord,
): SubscriptionResponse {
  const unitPriceDecimal = unitPriceFor(plan, row.billingInterval as BillingInterval);
  return toSubscriptionResponse(toDtoSource(row, plan, unitPriceDecimal));
}
