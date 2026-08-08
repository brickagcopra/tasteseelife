import { Inject, Logger, Module, type OnModuleInit } from '@nestjs/common';
import {
  IDENTITY_EMAIL_VERIFICATION_REQUESTED,
  SUBSCRIPTION_DUNNING_EXHAUSTED,
  SUBSCRIPTION_PAYMENT_FAILED,
  SUBSCRIPTION_PAYMENT_SUCCEEDED,
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
import { PrismaService } from '../../prisma/prisma.service';
import { DispatchModule } from '../dispatch/dispatch.module';

import { BillingContactsClient } from './clients/billing-contacts.client';
import { DunningLadderService } from './dunning-ladder.service';
import { EmailVerificationMailerService } from './email-verification-mailer.service';
import { DunningMetrics } from './dunning-metrics';
import {
  SubscriptionDunningExhaustedHandler,
  SubscriptionPaymentFailedHandler,
  SubscriptionPaymentSucceededHandler,
} from './handlers/dunning.handlers';
import { IdentityEmailVerificationRequestedHandler } from './handlers/email-verification.handler';

/**
 * Outbox consumers module for service-notification (TS-042-followup-3a2;
 * PDD §7.3, §12.2; CLAUDE.md §5.3, §12).
 *
 * **service-notification's FIRST consumer surface.** Until now this service
 * only ever acted when something called it — admin CRUD, the internal render
 * endpoint, the internal dispatch endpoint. Every notification on the
 * platform therefore existed only because some other service remembered to
 * ask for it. The dunning ladder is the first the notification service sends
 * on its own initiative, off an event.
 *
 * The consumer reads the `subscription.*` dunning events service-subscription
 * produces. An event rather than an inbound call for the usual reason
 * (CLAUDE.md §5.3): the subscription transaction must not depend on
 * service-notification being up, and a family whose payment failed while the
 * mailer was restarting must still be told.
 *
 * **Tenant-scoping.** The SDK invokes handlers from its background poll loop,
 * so there is no `request.requestContext` for `TenantContextInterceptor` to
 * seed a scoped frame from, and an unwrapped handler dies with
 * `MissingRequestContextError` on its first Prisma call. Each registration
 * wraps its dispatch in `runWithoutTenantContext` with a distinct, grep-able
 * reason.
 *
 * **The kill switch registers NO handlers**, rather than registering handlers
 * that return early. A handler that acks the event and does nothing consumes
 * it permanently: flipping the switch back on would not recover the events
 * that arrived while it was off. Registering nothing leaves them in the
 * stream.
 */
@Module({
  imports: [DispatchModule],
  providers: [
    BillingContactsClient,
    DunningMetrics,
    DunningLadderService,
    SubscriptionPaymentFailedHandler,
    SubscriptionPaymentSucceededHandler,
    SubscriptionDunningExhaustedHandler,
    EmailVerificationMailerService,
    IdentityEmailVerificationRequestedHandler,
  ],
})
export class OutboxConsumersModule implements OnModuleInit {
  private readonly logger = new Logger(OutboxConsumersModule.name);

  constructor(
    private readonly consumer: OutboxConsumerService,
    private readonly paymentFailed: SubscriptionPaymentFailedHandler,
    private readonly paymentSucceeded: SubscriptionPaymentSucceededHandler,
    private readonly dunningExhausted: SubscriptionDunningExhaustedHandler,
    private readonly emailVerification: IdentityEmailVerificationRequestedHandler,
    @Inject(TENANT_CONTEXT_STORE_TOKEN)
    private readonly tenantStore: TenantContextStore,
    @Inject(ENV_TOKEN) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    this.registerEmailVerification();
    this.registerDunning();
  }

  /**
   * `identity.email_verification_requested` → the verification email
   * (TS-510-followup-4).
   *
   * Registered under its own switch, separate from the dunning ladder's.
   * They are different failure domains: turning off billing mail because
   * a template is wrong must not also stop new customers receiving the
   * link that lets them use their account.
   */
  private registerEmailVerification(): void {
    if (!this.env.EMAIL_VERIFICATION_NOTIFICATIONS_ENABLED) {
      this.logger.warn(
        { disabledBy: 'EMAIL_VERIFICATION_NOTIFICATIONS_ENABLED' },
        'email-verification.handler-not-registered',
      );
      return;
    }

    const emailVerification = this.emailVerification.handle.bind(this.emailVerification);
    this.consumer.registerHandler(IDENTITY_EMAIL_VERIFICATION_REQUESTED, async (args) => {
      // Outcome discarded, exceptions NOT: `skipped_expired` is a decision
      // and acks, while a render or transport failure throws out of the
      // mailer and redelivers. That asymmetry is deliberate — a dropped
      // verification email is a customer who cannot use the account they
      // just made.
      await runWithoutTenantContext(
        this.tenantStore,
        'outbox-consumer-identity-email-verification-requested',
        () => emailVerification(args),
      );
    });
    this.logger.log(
      { event: IDENTITY_EMAIL_VERIFICATION_REQUESTED },
      'outbox-consumers.handler-registered',
    );
  }

  private registerDunning(): void {
    if (!this.env.DUNNING_NOTIFICATIONS_ENABLED) {
      this.logger.warn(
        { disabledBy: 'DUNNING_NOTIFICATIONS_ENABLED' },
        'dunning.handlers-not-registered',
      );
      return;
    }

    const paymentFailed = this.paymentFailed.handle.bind(this.paymentFailed);
    this.consumer.registerHandler(SUBSCRIPTION_PAYMENT_FAILED, async (args) => {
      // The outcome is deliberately discarded: the SDK's contract is "threw
      // = redeliver, returned = ack", and every non-send path here is a
      // decision, not a failure. They are logged inside the ladder; turning
      // one into a throw would redeliver an event nothing will ever handle
      // differently.
      await runWithoutTenantContext(
        this.tenantStore,
        'outbox-consumer-subscription-payment-failed',
        () => paymentFailed(args),
      );
    });
    this.logger.log({ event: SUBSCRIPTION_PAYMENT_FAILED }, 'outbox-consumers.handler-registered');

    const paymentSucceeded = this.paymentSucceeded.handle.bind(this.paymentSucceeded);
    this.consumer.registerHandler(SUBSCRIPTION_PAYMENT_SUCCEEDED, async (args) => {
      await runWithoutTenantContext(
        this.tenantStore,
        'outbox-consumer-subscription-payment-succeeded',
        () => paymentSucceeded(args),
      );
    });
    this.logger.log(
      { event: SUBSCRIPTION_PAYMENT_SUCCEEDED },
      'outbox-consumers.handler-registered',
    );

    const dunningExhausted = this.dunningExhausted.handle.bind(this.dunningExhausted);
    this.consumer.registerHandler(SUBSCRIPTION_DUNNING_EXHAUSTED, async (args) => {
      await runWithoutTenantContext(
        this.tenantStore,
        'outbox-consumer-subscription-dunning-exhausted',
        () => dunningExhausted(args),
      );
    });
    this.logger.log(
      { event: SUBSCRIPTION_DUNNING_EXHAUSTED },
      'outbox-consumers.handler-registered',
    );
  }
}

/**
 * The Redis client the consumer SDK uses for `XREADGROUP` / `XAUTOCLAIM` /
 * `XACK`. One connection per pod — this service's first Redis dependency.
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
        maxRetriesPerRequest: 3,
      }),
    ),
  inject: [ENV_TOKEN],
};

/**
 * The Postgres-backed dedup store, scoped to the `notification` schema.
 *
 * **Unlike its siblings' reconciliation handlers, a notification does NOT
 * converge** — re-running a send is a second email, not a no-op write. So
 * this ledger is backed by a real domain guard: the dispatch table's
 * `idempotency_key` UNIQUE, keyed on `(eventId, recipientUserId)`. A
 * redelivery that slips past this table replays the dispatch row instead of
 * sending again.
 */
export const outboxConsumerDedupStoreFactory: OutboxConsumerDependencyFactory<ConsumerDedupStore> =
  {
    useFactory: (prisma: PrismaService): PgConsumerDedupStore =>
      // The cast goes through `unknown` because Prisma's tagged-template
      // surface uses generic overloads the SDK cannot pin without taking a hard
      // dependency on a specific @prisma/client version (CLAUDE.md §13).
      new PgConsumerDedupStore(prisma as unknown as ConsumerRawExecutor, 'notification'),
    inject: [PrismaService],
  };
