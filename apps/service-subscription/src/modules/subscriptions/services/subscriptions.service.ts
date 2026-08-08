import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  SUBSCRIPTION_ACTIVATED,
  SUBSCRIPTION_CANCELED,
  type BillingInterval,
  type CancelSubscriptionRequest,
  type CreateSubscriptionRequest,
  type PatchSubscriptionRequest,
  type PlanCustomerGroup,
  type SubscriptionCancelReason,
  type SubscriptionResponse,
  type SubscriptionStatus,
} from '@taste-and-see/contracts';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';
import Decimal from 'decimal.js';
import type Stripe from 'stripe';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';
import { CouponsService, type ValidatedCoupon } from '../../coupons/services/coupons.service';
import { STRIPE_SDK_TOKEN } from '../../stripe/stripe.constants';
import { mapStripeStatus } from '../mappers/stripe-status.mapper';
import { toSubscriptionResponse, type SubscriptionDtoSource } from '../mappers/subscription.mapper';
import { err, ok, type Result } from '../result';
import { StripeCustomerService } from './stripe-customer.service';

/**
 * Failure shapes returned by the SubscriptionsService. The service wraps
 * every cross-boundary failure (Stripe, DB, validation) in a Result so
 * the controller's branch is explicit (CLAUDE.md §2.1).
 */
export type SubscriptionsFailure =
  | { readonly reason: 'plan_not_found'; readonly planId: string }
  | { readonly reason: 'plan_inactive'; readonly planId: string }
  | {
      readonly reason: 'plan_group_mismatch';
      readonly planId: string;
      readonly expected: PlanCustomerGroup;
      readonly actual: PlanCustomerGroup;
    }
  | { readonly reason: 'subscription_not_found'; readonly subscriptionId: string }
  | { readonly reason: 'subscription_already_canceled'; readonly subscriptionId: string }
  | { readonly reason: 'stripe_unavailable'; readonly cause: unknown }
  | { readonly reason: 'invalid_request'; readonly message: string }
  /**
   * TS-043 — coupon-related failures surfaced from the create flow.
   * The validation gate runs BEFORE the Stripe Subscription create
   * call so a failing coupon never produces a Stripe-side artifact.
   */
  | {
      readonly reason: 'coupon_invalid';
      readonly couponCode: string;
      readonly failureReason: string;
    }
  /**
   * TS-142-followup-9 — the outbox SDK rejected the server-side event
   * payload as failing the registry Zod schema. Effectively a 500 —
   * the payload is constructed from trusted local data so a validation
   * failure means we have a bug. The transactional Prisma write rolls
   * back when this surfaces, leaving no orphan rows.
   */
  | {
      readonly reason: 'outbox_validation_failed';
      readonly eventName: string;
      readonly message: string;
    };

export interface CreateSubscriptionInput {
  readonly request: CreateSubscriptionRequest;
  readonly requesterUserId: string;
  readonly idempotencyKey?: string;
}

export interface PatchSubscriptionInput {
  readonly subscriptionId: string;
  readonly request: PatchSubscriptionRequest;
  readonly requesterUserId: string;
  readonly idempotencyKey?: string;
}

export interface CancelSubscriptionInput {
  readonly subscriptionId: string;
  readonly request: CancelSubscriptionRequest;
  readonly requesterUserId: string;
  readonly idempotencyKey?: string;
}

/**
 * Slim Plan projection the service needs. Hoisted to a module-level
 * type so the loadPlan helper signature stays stable as the Plan
 * model grows.
 */
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
 * `SubscriptionsService` — orchestrates the per-customer subscription
 * lifecycle (PDD §11.1, §8.2; CLAUDE.md §6).
 *
 * The service is the only place in the codebase that calls Stripe's
 * subscription / customer / product APIs on the outbound path. Every
 * mutation follows a strict expand/migrate/contract pattern:
 *
 *   1. Validate the request (plan exists / is active / customerGroup
 *      matches; subscription exists for patch + cancel).
 *   2. Resolve the Stripe customer (find-or-create).
 *   3. Resolve the Stripe Product backing the plan (lazy-create on
 *      first use; the product id is cached on `plans.stripe_product_id`
 *      so subsequent subscriptions reuse it).
 *   4. Make the Stripe Subscription API call FIRST (before persisting
 *      the row) so a Stripe failure leaves zero local state. The
 *      opposite — persist then call Stripe — would leave orphan rows
 *      on Stripe failure.
 *   5. Persist the subscription row + the audit-history entry in a
 *      SINGLE Prisma transaction. Either both land or neither does.
 *   6. Return the read-back DTO.
 *
 * **Money math**: every conversion uses `Decimal` (CLAUDE.md §17.6).
 * The plan's `monthlyPrice` / `annualPrice` is `Decimal` from Prisma;
 * the service converts to integer minor units only at the Stripe
 * boundary and at the DTO boundary.
 *
 * **Idempotency**: the optional `idempotencyKey` is forwarded to Stripe
 * as the `Idempotency-Key` header on the customer-create + product-
 * create + subscription-create calls (each with a `:phase` suffix so
 * each Stripe call de-dups independently within Stripe's 24h window).
 * The cross-service Redis-backed cache (CLAUDE.md §3.3 / §17.5) lands
 * with TS-044; this service participates by accepting the header here.
 *
 * **Authorization**: the service verifies authentication (the
 * AccessTokenGuard ensures `requesterUserId` is non-empty) but does
 * NOT enforce row-level authorization beyond logging. The full
 * `(family_payer can subscribe their household, provider can
 * subscribe themselves, academy can subscribe themselves)` model
 * arrives via TS-141's tenant-scoping middleware once a cross-service
 * household-membership check is feasible.
 */
@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: StripeCustomerService,
    @Inject(STRIPE_SDK_TOKEN) private readonly stripe: Stripe,
    private readonly coupons: CouponsService,
    /**
     * TS-142-followup-9 — producer-side outbox SDK. Injected here so the
     * `subscription.activated` / `subscription.canceled` events can be
     * appended inside the same Prisma transaction as the row write
     * (the outbox invariant from PDD §7.3 / CLAUDE.md §5.3).
     *
     * Provided by the global `OutboxModule` wired in `app.module.ts`.
     */
    private readonly outbox: OutboxService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────
  // CREATE
  // ─────────────────────────────────────────────────────────────────────

  async create(
    input: CreateSubscriptionInput,
  ): Promise<Result<SubscriptionResponse, SubscriptionsFailure>> {
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

    if (input.request.paymentMethodId !== undefined) {
      const attachResult = await this.attachPaymentMethod(
        input.request.paymentMethodId,
        stripeCustomerId,
        input.idempotencyKey,
      );
      if (!attachResult.ok) return attachResult;
    }

    const productResult = await this.ensureStripeProduct(plan, input.idempotencyKey);
    if (!productResult.ok) return productResult;
    plan = productResult.value;

    const unitPriceDecimal = unitPriceFor(plan, input.request.billingInterval);

    // TS-043 — validate + (lazy-)create Stripe coupon BEFORE the
    // subscription is created on Stripe so a coupon failure produces
    // zero Stripe-side artifacts. The coupon redemption row is
    // persisted inside the same DB transaction as the subscription row
    // below, so a DB-side failure rolls back both writes.
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
        // Stack on top of any caller-supplied trialDays. The contract
        // already caps trialDays at SUBSCRIPTION_TRIAL_DAYS_MAX (90);
        // the sum can briefly exceed that — Stripe accepts up to 730
        // so the stacked value stays within its bound.
        effectiveTrialDays = (input.request.trialDays ?? 0) + validatedCoupon.extendedTrialDays;
      } else {
        // percent_off / amount_off — lazy-create the Stripe Coupon if
        // it doesn't already exist, then attach via `discounts` on
        // the Stripe Subscription create call below.
        const ensureResult = await this.coupons.ensureStripeCoupon(
          validatedCoupon.id,
          input.idempotencyKey,
        );
        if (!ensureResult.ok) {
          if (ensureResult.error.reason === 'stripe_unavailable') {
            return err({ reason: 'stripe_unavailable', cause: ensureResult.error.cause });
          }
          // coupon_not_found here means the coupon was deactivated
          // between validate() and ensureStripeCoupon() — race; surface
          // as coupon_invalid so the family-portal can re-prompt.
          return err({
            reason: 'coupon_invalid',
            couponCode: input.request.couponCode,
            failureReason: ensureResult.error.reason,
          });
        }
        stripeCouponId = ensureResult.value;
      }
    }

    let stripeSubscription: Stripe.Subscription;
    try {
      stripeSubscription = await this.stripe.subscriptions.create(
        {
          customer: stripeCustomerId,
          items: [
            {
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
          ...(input.request.paymentMethodId !== undefined && {
            default_payment_method: input.request.paymentMethodId,
          }),
          ...(effectiveTrialDays !== undefined &&
            effectiveTrialDays > 0 && {
              trial_period_days: effectiveTrialDays,
            }),
          ...(stripeCouponId !== null && {
            discounts: [{ coupon: stripeCouponId }],
          }),
          payment_behavior: 'default_incomplete',
          payment_settings: {
            save_default_payment_method: 'on_subscription',
          },
          metadata: {
            platform_plan_id: plan.id,
            platform_customer_id: input.request.customerId,
            customer_group: input.request.customerGroup,
            requester_user_id: input.requesterUserId,
          },
          expand: ['latest_invoice.payment_intent'],
        },
        {
          ...(input.idempotencyKey !== undefined && {
            idempotencyKey: `${input.idempotencyKey}:sub`,
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
        'subscriptions.create stripe failure',
      );
      return err({ reason: 'stripe_unavailable', cause });
    }

    const status = mapStripeStatus(stripeSubscription.status);
    const periodStart = unixToDate(getCurrentPeriodStart(stripeSubscription));
    const periodEnd = unixToDate(getCurrentPeriodEnd(stripeSubscription));
    const trialEnd =
      stripeSubscription.trial_end !== null ? unixToDate(stripeSubscription.trial_end) : null;

    const now = new Date();
    let persisted;
    try {
      persisted = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
        const subscription = await tx.subscription.create({
          data: {
            stripeSubscriptionId: stripeSubscription.id,
            stripeCustomerId,
            customerId: input.request.customerId,
            customerGroup: input.request.customerGroup,
            planId: plan.id,
            status,
            billingInterval: input.request.billingInterval,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            trialEnd,
          },
        });

        await tx.subscriptionHistory.create({
          data: {
            subscriptionId: subscription.id,
            event: 'created',
            fromStatus: null,
            toStatus: status,
            context: {
              planId: plan.id,
              planCode: plan.code,
              billingInterval: input.request.billingInterval,
              stripeSubscriptionId: stripeSubscription.id,
            },
            actorUserId: input.requesterUserId,
            actorKind: 'user',
          },
        });

        if (input.request.paymentMethodId !== undefined) {
          await upsertPaymentMethodMetadata(tx, {
            stripePaymentMethodId: input.request.paymentMethodId,
            stripeCustomerId,
            customerId: input.request.customerId,
            customerGroup: input.request.customerGroup,
          });
        }

        if (validatedCoupon !== null) {
          const redemptionResult = await this.coupons.recordRedemption({
            couponId: validatedCoupon.id,
            customerId: input.request.customerId,
            customerGroup: input.request.customerGroup,
            subscriptionId: subscription.id,
            valueAppliedMinor: validatedCoupon.valueAppliedMinor,
            currency: validatedCoupon.currency,
            kind: validatedCoupon.kind,
            tx,
          });
          if (!redemptionResult.ok) {
            // Surface as a transaction abort so the whole subscription
            // row + history entry roll back. The caller will see the
            // throw as a stripe_unavailable / unknown failure — log
            // structured context so ops triage can identify the racing
            // redemption.
            this.logger.warn(
              {
                subscriptionId: subscription.id,
                couponId: validatedCoupon.id,
                failure: redemptionResult.error.reason,
              },
              'subscriptions.create coupon redemption failed; aborting tx',
            );
            throw new Error(`coupon redemption failed: ${redemptionResult.error.reason}`);
          }
        }

        // TS-142-followup-9 — append `subscription.activated` through the
        // outbox SDK inside the same transaction. The eventId is derived
        // from the subscription id so a retry of the surrounding write
        // collapses onto the existing row idempotently (the outbox table's
        // PK on `event_id` rejects the duplicate).
        //
        // TS-142-followup-2-followup-2 — emit `amountMinor` + `currency`
        // so the downstream consumer (service-accounting's revenue
        // recognizer) has everything it needs to post the activation
        // journal + create the deferred-revenue balance without a
        // cross-service lookup (cross-service DB joins forbidden per
        // CLAUDE.md §2.3). The activation amount is the unit price for
        // the selected billing interval — one month's price for
        // monthly, one year's price for annual; the consumer recognises
        // this amount over `[periodStart, periodEnd]` per CLAUDE.md
        // §17.17.
        const activationAmountMinor = decimalToMinorUnits(unitPriceDecimal);
        const activatedResult = await this.outbox.append(tx as unknown as OutboxRawExecutor, {
          eventName: SUBSCRIPTION_ACTIVATED,
          eventId: `${subscription.id}.activated`,
          occurredAt: now,
          payload: {
            eventId: `${subscription.id}.activated`,
            occurredAt: now.toISOString(),
            subscriptionId: subscription.id,
            customerId: input.request.customerId,
            customerGroup: input.request.customerGroup,
            planId: plan.id,
            planCode: plan.code,
            periodStart: periodStart.toISOString(),
            periodEnd: periodEnd.toISOString(),
            amountMinor: activationAmountMinor,
            currency: plan.currency,
          },
        });
        if (activatedResult.kind !== 'appended') {
          throw new OutboxValidationFailedError(activatedResult.eventName, activatedResult.issues);
        }

        return subscription;
      });
    } catch (e) {
      if (e instanceof OutboxValidationFailedError) {
        this.logger.error(
          { eventName: e.eventName, issues: e.issues },
          'subscriptions.create outbox validation failed; tx rolled back',
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
        subscriptionId: persisted.id,
        stripeSubscriptionId: stripeSubscription.id,
        planId: plan.id,
        status,
      },
      'subscriptions.create ok',
    );

    return ok(toSubscriptionResponse(toDtoSource(persisted, plan, unitPriceDecimal)));
  }

  // ─────────────────────────────────────────────────────────────────────
  // PATCH
  // ─────────────────────────────────────────────────────────────────────

  async patch(
    input: PatchSubscriptionInput,
  ): Promise<Result<SubscriptionResponse, SubscriptionsFailure>> {
    const existing = await this.prisma.subscription.findUnique({
      where: { id: input.subscriptionId },
      include: { plan: true },
    });
    if (existing === null) {
      return err({ reason: 'subscription_not_found', subscriptionId: input.subscriptionId });
    }

    let nextPlan: PlanRecord = toPlanRecord(existing.plan);
    let unitPriceDecimal = unitPriceFor(nextPlan, existing.billingInterval as BillingInterval);
    const updateData: Stripe.SubscriptionUpdateParams = {
      proration_behavior: 'create_prorations',
    };

    if (input.request.planId !== undefined && input.request.planId !== existing.planId) {
      const planResult = await this.loadPlan(input.request.planId);
      if (!planResult.ok) return planResult;
      const newPlan = planResult.value;
      if (newPlan.customerGroup !== existing.customerGroup) {
        return err({
          reason: 'plan_group_mismatch',
          planId: newPlan.id,
          expected: existing.customerGroup,
          actual: newPlan.customerGroup,
        });
      }

      const productResult = await this.ensureStripeProduct(newPlan, input.idempotencyKey);
      if (!productResult.ok) return productResult;
      nextPlan = productResult.value;
      unitPriceDecimal = unitPriceFor(nextPlan, existing.billingInterval as BillingInterval);

      const stripeSubscription = await this.fetchStripeSubscription(existing.stripeSubscriptionId);
      if (!stripeSubscription.ok) return stripeSubscription;

      const firstItemId = stripeSubscription.value.items.data[0]?.id;
      if (firstItemId === undefined) {
        return err({
          reason: 'invalid_request',
          message: 'subscription has no items to update',
        });
      }

      updateData.items = [
        {
          id: firstItemId,
          price_data: {
            currency: nextPlan.currency.toLowerCase(),
            product: requireProductId(nextPlan),
            unit_amount: decimalToMinorUnits(unitPriceDecimal),
            recurring: {
              interval: existing.billingInterval === 'monthly' ? 'month' : 'year',
            },
          },
        },
      ];
    }

    if (input.request.paymentMethodId !== undefined) {
      const attachResult = await this.attachPaymentMethod(
        input.request.paymentMethodId,
        existing.stripeCustomerId,
        input.idempotencyKey,
      );
      if (!attachResult.ok) return attachResult;
      updateData.default_payment_method = input.request.paymentMethodId;
    }

    let updated: Stripe.Subscription;
    try {
      updated = await this.stripe.subscriptions.update(existing.stripeSubscriptionId, updateData, {
        ...(input.idempotencyKey !== undefined && {
          idempotencyKey: `${input.idempotencyKey}:patch`,
        }),
      });
    } catch (cause) {
      this.logger.warn(
        {
          subscriptionId: existing.id,
          stripeSubscriptionId: existing.stripeSubscriptionId,
          err: stripeErrorMessage(cause),
        },
        'subscriptions.patch stripe failure',
      );
      return err({ reason: 'stripe_unavailable', cause });
    }

    const status = mapStripeStatus(updated.status);
    const persisted = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const next = await tx.subscription.update({
        where: { id: existing.id },
        data: {
          ...(input.request.planId !== undefined && { planId: nextPlan.id }),
          status,
          currentPeriodStart: unixToDate(getCurrentPeriodStart(updated)),
          currentPeriodEnd: unixToDate(getCurrentPeriodEnd(updated)),
          trialEnd: updated.trial_end !== null ? unixToDate(updated.trial_end) : null,
        },
      });

      if (input.request.planId !== undefined && input.request.planId !== existing.planId) {
        await tx.subscriptionHistory.create({
          data: {
            subscriptionId: next.id,
            event: 'plan_changed',
            fromStatus: existing.status,
            toStatus: status,
            context: {
              fromPlanId: existing.planId,
              toPlanId: nextPlan.id,
              fromPlanCode: existing.plan.code,
              toPlanCode: nextPlan.code,
            },
            actorUserId: input.requesterUserId,
            actorKind: 'user',
          },
        });
      }

      if (input.request.paymentMethodId !== undefined) {
        await tx.subscriptionHistory.create({
          data: {
            subscriptionId: next.id,
            event: 'payment_method_changed',
            fromStatus: existing.status,
            toStatus: status,
            context: { stripePaymentMethodId: input.request.paymentMethodId },
            actorUserId: input.requesterUserId,
            actorKind: 'user',
          },
        });
        await upsertPaymentMethodMetadata(tx, {
          stripePaymentMethodId: input.request.paymentMethodId,
          stripeCustomerId: existing.stripeCustomerId,
          customerId: existing.customerId,
          customerGroup: existing.customerGroup,
        });
      }

      return next;
    });

    this.logger.log(
      {
        subscriptionId: persisted.id,
        stripeSubscriptionId: existing.stripeSubscriptionId,
        status,
        planChanged: input.request.planId !== undefined && input.request.planId !== existing.planId,
        paymentMethodChanged: input.request.paymentMethodId !== undefined,
      },
      'subscriptions.patch ok',
    );

    return ok(toSubscriptionResponse(toDtoSource(persisted, nextPlan, unitPriceDecimal)));
  }

  // ─────────────────────────────────────────────────────────────────────
  // CANCEL
  // ─────────────────────────────────────────────────────────────────────

  async cancel(
    input: CancelSubscriptionInput,
  ): Promise<Result<SubscriptionResponse, SubscriptionsFailure>> {
    const existing = await this.prisma.subscription.findUnique({
      where: { id: input.subscriptionId },
      include: { plan: true },
    });
    if (existing === null) {
      return err({ reason: 'subscription_not_found', subscriptionId: input.subscriptionId });
    }
    if (existing.status === 'canceled') {
      return err({ reason: 'subscription_already_canceled', subscriptionId: existing.id });
    }

    let canceledStripe: Stripe.Subscription;
    try {
      if (input.request.cancelAtPeriodEnd) {
        canceledStripe = await this.stripe.subscriptions.update(
          existing.stripeSubscriptionId,
          { cancel_at_period_end: true },
          {
            ...(input.idempotencyKey !== undefined && {
              idempotencyKey: `${input.idempotencyKey}:cancel-eop`,
            }),
          },
        );
      } else {
        canceledStripe = await this.stripe.subscriptions.cancel(
          existing.stripeSubscriptionId,
          {},
          {
            ...(input.idempotencyKey !== undefined && {
              idempotencyKey: `${input.idempotencyKey}:cancel-now`,
            }),
          },
        );
      }
    } catch (cause) {
      this.logger.warn(
        {
          subscriptionId: existing.id,
          stripeSubscriptionId: existing.stripeSubscriptionId,
          err: stripeErrorMessage(cause),
        },
        'subscriptions.cancel stripe failure',
      );
      return err({ reason: 'stripe_unavailable', cause });
    }

    const nextStatus = mapStripeStatus(canceledStripe.status);
    const canceledAt =
      canceledStripe.canceled_at !== null ? unixToDate(canceledStripe.canceled_at) : new Date();

    // TS-142-followup-9 — the `effectiveAt` field on the canceled event
    // is the wall-clock at which the cancellation takes effect. For an
    // at-period-end cancellation that's the period end; for an immediate
    // cancellation it's `canceledAt` (the time Stripe acknowledged). The
    // event payload's enum reuses the same five-value set as the
    // `SubscriptionCancelReason` HTTP schema (kept in lockstep).
    const effectiveAt = input.request.cancelAtPeriodEnd
      ? unixToDate(getCurrentPeriodEnd(canceledStripe))
      : canceledAt;
    const cancelReasonForEvent = input.request.reason ?? 'customer_request';
    let persisted;
    try {
      persisted = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
        const next = await tx.subscription.update({
          where: { id: existing.id },
          data: {
            status: nextStatus,
            cancelAtPeriodEnd: canceledStripe.cancel_at_period_end,
            cancelReason: input.request.reason,
            canceledAt,
            currentPeriodStart: unixToDate(getCurrentPeriodStart(canceledStripe)),
            currentPeriodEnd: unixToDate(getCurrentPeriodEnd(canceledStripe)),
          },
        });

        await tx.subscriptionHistory.create({
          data: {
            subscriptionId: next.id,
            event: 'canceled',
            fromStatus: existing.status,
            toStatus: nextStatus,
            context: {
              cancelAtPeriodEnd: canceledStripe.cancel_at_period_end,
              reason: input.request.reason,
              ...(input.request.note !== undefined && { note: input.request.note }),
            },
            actorUserId: input.requesterUserId,
            actorKind: 'user',
          },
        });

        // TS-142-followup-9 — append `subscription.canceled` through the
        // outbox SDK inside the same transaction. The eventId is derived
        // from the subscription id + `canceledAt` so an at-period-end
        // cancellation that's later replayed (e.g. ops re-emit) is
        // idempotent on event_id even if `effectiveAt` shifted.
        const canceledResult = await this.outbox.append(tx as unknown as OutboxRawExecutor, {
          eventName: SUBSCRIPTION_CANCELED,
          eventId: `${next.id}.canceled.${canceledAt.getTime()}`,
          occurredAt: canceledAt,
          payload: {
            eventId: `${next.id}.canceled.${canceledAt.getTime()}`,
            occurredAt: canceledAt.toISOString(),
            subscriptionId: next.id,
            customerId: existing.customerId,
            reason: cancelReasonForEvent,
            effectiveAt: effectiveAt.toISOString(),
          },
        });
        if (canceledResult.kind !== 'appended') {
          throw new OutboxValidationFailedError(canceledResult.eventName, canceledResult.issues);
        }

        return next;
      });
    } catch (e) {
      if (e instanceof OutboxValidationFailedError) {
        this.logger.error(
          { eventName: e.eventName, issues: e.issues },
          'subscriptions.cancel outbox validation failed; tx rolled back',
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
        subscriptionId: persisted.id,
        cancelAtPeriodEnd: persisted.cancelAtPeriodEnd,
        reason: input.request.reason,
      },
      'subscriptions.cancel ok',
    );

    const planRecord = toPlanRecord(existing.plan);
    const unitPriceDecimal = unitPriceFor(planRecord, existing.billingInterval as BillingInterval);
    return ok(toSubscriptionResponse(toDtoSource(persisted, planRecord, unitPriceDecimal)));
  }

  // ─────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────

  private async loadPlanForCreate(
    request: CreateSubscriptionRequest,
  ): Promise<Result<PlanRecord, SubscriptionsFailure>> {
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

  private async loadPlan(planId: string): Promise<Result<PlanRecord, SubscriptionsFailure>> {
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
    return ok(toPlanRecord(plan));
  }

  /**
   * Lazy-create the Stripe Product backing this plan. Idempotent on the
   * `plans.stripe_product_id` column — if it's already set we return
   * the plan unchanged. Concurrent first-touches are bounded by Stripe's
   * own idempotency-key dedup AND by the row update being a one-shot
   * `WHERE stripe_product_id IS NULL` (the second writer no-ops).
   */
  private async ensureStripeProduct(
    plan: PlanRecord,
    idempotencyKey: string | undefined,
  ): Promise<Result<PlanRecord, SubscriptionsFailure>> {
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
          // Use the plan id as the dedup key so a Phase-1 cold start
          // racing against itself only ever creates one Product.
          idempotencyKey:
            idempotencyKey !== undefined
              ? `${idempotencyKey}:product:${plan.id}`
              : `plan-product:${plan.id}`,
        },
      );
    } catch (cause) {
      this.logger.warn(
        { planId: plan.id, err: stripeErrorMessage(cause) },
        'subscriptions.ensureStripeProduct stripe failure',
      );
      return err({ reason: 'stripe_unavailable', cause });
    }

    await this.prisma.plan.update({
      where: { id: plan.id },
      data: { stripeProductId: product.id },
    });

    return ok({ ...plan, stripeProductId: product.id });
  }

  private async attachPaymentMethod(
    stripePaymentMethodId: string,
    stripeCustomerId: string,
    idempotencyKey: string | undefined,
  ): Promise<Result<void, SubscriptionsFailure>> {
    try {
      await this.stripe.paymentMethods.attach(
        stripePaymentMethodId,
        { customer: stripeCustomerId },
        {
          ...(idempotencyKey !== undefined && {
            idempotencyKey: `${idempotencyKey}:pm-attach`,
          }),
        },
      );
      return ok(undefined);
    } catch (cause) {
      if (isAlreadyAttachedError(cause)) {
        return ok(undefined);
      }
      this.logger.warn(
        {
          stripeCustomerId,
          stripePaymentMethodId,
          err: stripeErrorMessage(cause),
        },
        'subscriptions.attachPaymentMethod stripe failure',
      );
      return err({ reason: 'stripe_unavailable', cause });
    }
  }

  private async fetchStripeSubscription(
    stripeSubscriptionId: string,
  ): Promise<Result<Stripe.Subscription, SubscriptionsFailure>> {
    try {
      const sub = await this.stripe.subscriptions.retrieve(stripeSubscriptionId);
      return ok(sub);
    } catch (cause) {
      return err({ reason: 'stripe_unavailable', cause });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Local helpers — kept module-private to avoid leaking Stripe-specific
// shapes into the rest of the service.
// ─────────────────────────────────────────────────────────────────────────

interface PlanRowSlice {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly currency: string;
  readonly monthlyPrice: Decimal;
  readonly annualPrice: Decimal;
}

function unitPriceFor(plan: PlanRowSlice, interval: BillingInterval): Decimal {
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

/**
 * Stripe 17.4.0's `Subscription` type exposes `current_period_start` /
 * `current_period_end` directly on the subscription object. Older API
 * versions only had them on the items[0]; we read from the top-level
 * field and fall back to items[0] for forward compatibility.
 */
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

function isAlreadyAttachedError(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false;
  const message = (cause as { message?: unknown }).message;
  if (typeof message !== 'string') return false;
  return message.toLowerCase().includes('already been attached');
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
    // Should be unreachable — `ensureStripeProduct` is called before
    // every Stripe boundary that needs the product id. A null here is
    // a programmer error (skipped the ensure step), not a runtime path.
    throw new Error(`plan ${plan.id} has no stripeProductId; ensureStripeProduct was skipped`);
  }
  return plan.stripeProductId;
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
  /** TS-042 — see `Subscription` model doc-comments. */
  readonly dunningAttempts: number;
  readonly dunningLastAttemptAt: Date | null;
  readonly dunningGraceUntil: Date | null;
  readonly pauseCollectionStartedAt: Date | null;
  readonly pauseCollectionResumesAt: Date | null;
  readonly pauseReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toDtoSource(
  row: PersistedSubscriptionRow,
  plan: PlanRowSlice,
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
    cancelReason: row.cancelReason !== null ? (row.cancelReason as SubscriptionCancelReason) : null,
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

interface PlanRowFromPrisma {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly customerGroup: string;
  readonly monthlyPrice: Decimal;
  readonly annualPrice: Decimal;
  readonly currency: string;
  readonly active: boolean;
  readonly stripeProductId: string | null;
}

function toPlanRecord(row: PlanRowFromPrisma): PlanRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    customerGroup: row.customerGroup as PlanCustomerGroup,
    monthlyPrice: row.monthlyPrice,
    annualPrice: row.annualPrice,
    currency: row.currency,
    active: row.active,
    stripeProductId: row.stripeProductId,
  };
}

/**
 * Cache-only metadata write: mirrors the Stripe payment-method record
 * into our DB so the family-portal billing page can render the brand /
 * last4 without a Stripe round-trip on every page load. The full
 * brand/last4/exp arrives via the future `payment_method.attached`
 * webhook flow once TS-142's relay routes payment-method events.
 *
 * Hoisted to module scope so the function works against either the
 * `PrismaService` instance OR an interactive `tx` argument (Prisma's
 * `$transaction(fn)` callback receives a structurally compatible
 * client). The shape narrows at call sites via PrismaTransactionClient.
 */
/**
 * TS-142-followup-9 — surface an outbox validation failure as a typed
 * exception so the Prisma `$transaction` rolls back. The same pattern
 * the booking service uses (CLAUDE.md §5.3 — atomic state+event write).
 *
 * Local class — not exported. The service maps it to a typed failure
 * (`outbox_validation_failed`) for the controller.
 */
class OutboxValidationFailedError extends Error {
  constructor(
    readonly eventName: string,
    readonly issues: ReadonlyArray<{
      readonly path: ReadonlyArray<string | number>;
      readonly message: string;
    }>,
  ) {
    super(
      `outbox.append validation failed for ${eventName}: ${issues
        .map((i) => i.message)
        .join('; ')}`,
    );
    this.name = 'OutboxValidationFailedError';
  }
}

async function upsertPaymentMethodMetadata(
  tx: PrismaTransactionClient,
  args: {
    readonly stripePaymentMethodId: string;
    readonly stripeCustomerId: string;
    readonly customerId: string;
    readonly customerGroup: PlanCustomerGroup;
  },
): Promise<void> {
  await tx.paymentMethod.upsert({
    where: { stripePaymentMethodId: args.stripePaymentMethodId },
    create: {
      stripePaymentMethodId: args.stripePaymentMethodId,
      stripeCustomerId: args.stripeCustomerId,
      customerId: args.customerId,
      customerGroup: args.customerGroup,
      kind: 'card',
      isDefault: true,
    },
    update: {
      isDefault: true,
    },
  });
}
