import { Inject, Logger, Module, type FactoryProvider, type OnModuleInit } from '@nestjs/common';
import {
  STRIPE_INVOICE_CHANGED,
  STRIPE_PAYMENT_METHOD_CHANGED,
  STRIPE_SUBSCRIPTION_CHANGED,
} from '@taste-and-see/contracts';
import {
  OutboxConsumerService,
  PgConsumerDedupStore,
  asConsumerRedisClient,
  type ConsumerDedupStore,
  type ConsumerRawExecutor,
  type ConsumerRedisClient,
  type OutboxConsumerDependencyFactory,
} from '@taste-and-see/nest-outbox-consumer';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  runWithoutTenantContext,
  type TenantContextStore,
} from '@taste-and-see/nest-prisma-tenant-scope';
import { Redis } from 'ioredis';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';
import { SubscriptionMetrics } from '../../observability/subscription-metrics';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { StripeInvoiceChangedHandler } from './handlers/stripe-invoice-changed.handler';
import { StripePaymentMethodChangedHandler } from './handlers/stripe-payment-method-changed.handler';
import { StripeSubscriptionChangedHandler } from './handlers/stripe-subscription-changed.handler';
import { StripeDunningBridgeService } from './stripe-dunning-bridge.service';
import { StripeInvoiceReconcilerService } from './stripe-invoice-reconciler.service';
import { StripePaymentMethodReconcilerService } from './stripe-payment-method-reconciler.service';
import { StripeSubscriptionReconcilerService } from './stripe-subscription-reconciler.service';

/**
 * The Stripe mode this pod's secret key belongs to.
 *
 * **Derived from the key, never configured separately.** A standalone
 * `STRIPE_LIVEMODE` flag can contradict the credential it describes, and the
 * contradiction is invisible until a test-mode event is applied to production
 * rows. `sk_live_...` / `rk_live_...` is live; everything else — including
 * every `sk_test_` placeholder in a dev `.env` — is test. Falling to `false`
 * on an unrecognised prefix is the safe direction: a mislabelled live pod
 * drops live events noisily (`mode_mismatch` WARN + metric), whereas a
 * mislabelled test pod would apply test events to real subscriptions.
 */
export const STRIPE_LIVEMODE_TOKEN = Symbol('STRIPE_LIVEMODE');

export function isLiveStripeKey(secretKey: string): boolean {
  return secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_');
}

const stripeLivemodeProvider: FactoryProvider<boolean> = {
  provide: STRIPE_LIVEMODE_TOKEN,
  inject: [ENV_TOKEN],
  useFactory: (env: Env): boolean => isLiveStripeKey(env.STRIPE_SECRET_KEY),
};

const stripeSubscriptionChangedHandlerProvider: FactoryProvider<StripeSubscriptionChangedHandler> =
  {
    provide: StripeSubscriptionChangedHandler,
    inject: [StripeSubscriptionReconcilerService, SubscriptionMetrics, STRIPE_LIVEMODE_TOKEN],
    useFactory: (
      reconciler: StripeSubscriptionReconcilerService,
      metrics: SubscriptionMetrics,
      livemode: boolean,
    ): StripeSubscriptionChangedHandler =>
      new StripeSubscriptionChangedHandler(reconciler, metrics, livemode),
  };

const stripeInvoiceChangedHandlerProvider: FactoryProvider<StripeInvoiceChangedHandler> = {
  provide: StripeInvoiceChangedHandler,
  inject: [
    StripeInvoiceReconcilerService,
    StripeDunningBridgeService,
    SubscriptionMetrics,
    STRIPE_LIVEMODE_TOKEN,
  ],
  useFactory: (
    reconciler: StripeInvoiceReconcilerService,
    dunningBridge: StripeDunningBridgeService,
    metrics: SubscriptionMetrics,
    livemode: boolean,
  ): StripeInvoiceChangedHandler =>
    new StripeInvoiceChangedHandler(reconciler, dunningBridge, metrics, livemode),
};

const stripePaymentMethodChangedHandlerProvider: FactoryProvider<StripePaymentMethodChangedHandler> =
  {
    provide: StripePaymentMethodChangedHandler,
    inject: [StripePaymentMethodReconcilerService, SubscriptionMetrics, STRIPE_LIVEMODE_TOKEN],
    useFactory: (
      reconciler: StripePaymentMethodReconcilerService,
      metrics: SubscriptionMetrics,
      livemode: boolean,
    ): StripePaymentMethodChangedHandler =>
      new StripePaymentMethodChangedHandler(reconciler, metrics, livemode),
  };

/**
 * Outbox consumers module for service-subscription (TS-041b-followup-3a;
 * PDD §7.3, §11.1; CLAUDE.md §5.3, §6).
 *
 * **service-subscription's first CONSUMER surface.** It has been an outbox
 * PRODUCER since TS-142 and listened to nothing; the local `subscriptions`
 * rows only ever reflected changes this service itself made. Anything Stripe
 * decided — a period roll, a failed payment turning a subscription
 * `past_due`, a cancellation at period end actually taking effect, an
 * operator cancelling in the Dashboard — never reached the database. The
 * invoice tables have existed since TS-041b and received no writes at all.
 *
 * The bridge is an event rather than an inbound call from `service-webhook`
 * for the usual reason (CLAUDE.md §5.3): acking Stripe must not depend on
 * this service being up, and the change has to survive a redelivery.
 *
 * **Tenant-scoping — required for every handler here.** The SDK invokes
 * handlers from its background poll loop, so there is no
 * `request.requestContext` for `TenantContextInterceptor` to seed a scoped
 * frame from, and an unwrapped handler dies with `MissingRequestContextError`
 * on its first Prisma call. Each registration wraps its dispatch in
 * `runWithoutTenantContext` with a distinct, grep-able reason. Reconciliation
 * is inherently unscoped: the event names a Stripe object, and which
 * household or provider it belongs to is what the lookup discovers.
 *
 * **Where the two SDK factories are registered (ADR-0005 / TS-506).** Both are
 * handed to `OutboxConsumerModule.forRoot` in `AppModule`, because
 * `OutboxConsumerService` is declared inside the SDK's own `@Global()` module
 * and a provider declared here would not be in scope at its injection site.
 * Their bodies stay at the bottom of this file, beside the handlers they serve.
 */
@Module({
  // TS-305d-followup-2b1 — `StripeDunningBridgeService` needs `DunningService`,
  // which `SubscriptionsModule` owns and exports. Without this import
  // **service-subscription does not boot**: Nest raises
  // `UnknownDependenciesException` for `StripeDunningBridgeService (PrismaService, ?)`
  // during DI resolution, before it opens a single connection, and the pod
  // crashloops. `PrismaModule` is `@Global()`, which is why the first argument
  // resolved and the second did not.
  //
  // It shipped that way and nothing caught it: the boot-graph guard and the
  // integration suite both compile under vitest's esbuild, which emits no
  // `design:paramtypes`, so Nest read this class as zero-dependency and never
  // attempted the resolution. Proved by running the tsc-built `dist/main.js`.
  imports: [SubscriptionsModule],
  providers: [
    StripeSubscriptionReconcilerService,
    StripeInvoiceReconcilerService,
    StripePaymentMethodReconcilerService,
    StripeDunningBridgeService,
    stripeLivemodeProvider,
    stripeSubscriptionChangedHandlerProvider,
    stripeInvoiceChangedHandlerProvider,
    stripePaymentMethodChangedHandlerProvider,
  ],
})
export class OutboxConsumersModule implements OnModuleInit {
  private readonly logger = new Logger(OutboxConsumersModule.name);

  constructor(
    private readonly consumer: OutboxConsumerService,
    private readonly subscriptionChanged: StripeSubscriptionChangedHandler,
    private readonly invoiceChanged: StripeInvoiceChangedHandler,
    private readonly paymentMethodChanged: StripePaymentMethodChangedHandler,
    @Inject(TENANT_CONTEXT_STORE_TOKEN)
    private readonly tenantStore: TenantContextStore,
  ) {}

  onModuleInit(): void {
    const subscriptionChanged = this.subscriptionChanged.handle.bind(this.subscriptionChanged);
    this.consumer.registerHandler(STRIPE_SUBSCRIPTION_CHANGED, async (args) =>
      runWithoutTenantContext(
        this.tenantStore,
        'outbox-consumer-stripe-subscription-changed',
        async () => subscriptionChanged(args),
      ),
    );
    this.logger.log({ event: STRIPE_SUBSCRIPTION_CHANGED }, 'outbox-consumers.handler-registered');

    const invoiceChanged = this.invoiceChanged.handle.bind(this.invoiceChanged);
    this.consumer.registerHandler(STRIPE_INVOICE_CHANGED, async (args) =>
      runWithoutTenantContext(
        this.tenantStore,
        'outbox-consumer-stripe-invoice-changed',
        async () => invoiceChanged(args),
      ),
    );
    this.logger.log({ event: STRIPE_INVOICE_CHANGED }, 'outbox-consumers.handler-registered');

    const paymentMethodChanged = this.paymentMethodChanged.handle.bind(this.paymentMethodChanged);
    this.consumer.registerHandler(STRIPE_PAYMENT_METHOD_CHANGED, async (args) =>
      runWithoutTenantContext(
        this.tenantStore,
        'outbox-consumer-stripe-payment-method-changed',
        async () => paymentMethodChanged(args),
      ),
    );
    this.logger.log(
      { event: STRIPE_PAYMENT_METHOD_CHANGED },
      'outbox-consumers.handler-registered',
    );
  }
}

/**
 * The Redis client the consumer SDK uses for `XREADGROUP` / `XAUTOCLAIM` /
 * `XACK`. One connection per pod, on the same `REDIS_URL` that backs the
 * Idempotency-Key cache.
 */
export const outboxConsumerRedisFactory: OutboxConsumerDependencyFactory<ConsumerRedisClient> = {
  useFactory: (env: Env): ConsumerRedisClient =>
    asConsumerRedisClient(
      new Redis(env.REDIS_URL, {
        // Lazy so tests can substitute a mock without a real connection
        // attempt at module instantiation; production connects on the first
        // XREADGROUP.
        lazyConnect: true,
        // The SDK issues blocking `XREADGROUP BLOCK <ms>` calls, and
        // auto-pipelining would hold adjacent commands behind that long-poll
        // round trip.
        enableAutoPipelining: false,
        // Bounded — the SDK retries on its own cadence
        // (`OUTBOX_CONSUMER_POLL_INTERVAL_MS`).
        maxRetriesPerRequest: 3,
      }),
    ),
  inject: [ENV_TOKEN],
};

/**
 * The Postgres-backed dedup store, scoped to the `subscription` schema.
 *
 * The SDK's line of defence against redelivery. Unlike service-booking's
 * holds, there is no domain-level UNIQUE backing it up here — and there does
 * not need to be, because reconciliation CONVERGES: re-running it against
 * unchanged Stripe state writes nothing at all. A truncated dedup table costs
 * duplicate Stripe reads, not duplicate effects.
 */
export const outboxConsumerDedupStoreFactory: OutboxConsumerDependencyFactory<ConsumerDedupStore> =
  {
    useFactory: (prisma: PrismaService): PgConsumerDedupStore =>
      // `PrismaService` extends `PrismaClient` and exposes `$executeRaw` /
      // `$queryRaw` with the canonical Prisma signature; the SDK's
      // `ConsumerRawExecutor` is a narrower structural contract. The cast goes
      // through `unknown` because Prisma's tagged-template surface uses generic
      // overloads the SDK cannot pin without taking a hard dependency on a
      // specific @prisma/client version (CLAUDE.md §13).
      new PgConsumerDedupStore(prisma as unknown as ConsumerRawExecutor, 'subscription'),
    inject: [PrismaService],
  };

/** Re-exported so tests can inspect the tokens without importing the SDK. */
export {
  OUTBOX_CONSUMER_DEDUP_STORE_TOKEN,
  OUTBOX_CONSUMER_REDIS_TOKEN,
} from '@taste-and-see/nest-outbox-consumer';
