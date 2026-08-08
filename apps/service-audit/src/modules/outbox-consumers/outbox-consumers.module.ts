import { Inject, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { AUDIT_ACTION_RECORDED } from '@taste-and-see/contracts';
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
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';
import { Redis } from 'ioredis';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditModule } from '../audit/audit.module';
import { AuditActionRecordedHandler } from './handlers/audit-action-recorded.handler';

/**
 * Outbox consumers module (TS-271a-followup-1 / TS-272a-followup-1 /
 * TS-277a-followup-1; PDD §7.3, §7.4, §17.1; CLAUDE.md §3.6, §5.3).
 *
 * Wires the consumer-side bridge between the
 * `@taste-and-see/nest-outbox-consumer` SDK and `AuditService`, which owns the
 * append-only, hash-chained persistence. The SDK itself is registered globally
 * by `OutboxConsumerModule.forRoot` in the composition root; this module:
 *
 *   - **Registers the `audit.action_recorded` handler** from `OnModuleInit`.
 *      New events slot in here as the audit service consumes more.
 *
 * **Tenant-scoping (TS-141).** The consumer SDK invokes the handler from its
 * background poll loop, not from an HTTP request, so there is no
 * `request.requestContext` for the `TenantContextInterceptor` to seed a scoped
 * frame from. The dispatch is wrapped in
 * `runWithoutTenantContext(..., 'outbox-consumer-audit-action-recorded', ...)`
 * so every Prisma operation `recordEvent` performs (and the collateral
 * `PgConsumerDedupStore` writes) sees an explicit `exempt` frame rather than
 * failing with `MissingRequestContextError` under the `enforce` posture wired
 * in `AppModule`. The producer stamps the actor's scope into the event payload;
 * the audit service writes it verbatim — the audit row's tenant axis comes from
 * the payload, not from a request frame.
 *
 * **Where the SDK's two dependencies live (ADR-0005 / TS-506).** This
 * module used to *provide* `OUTBOX_CONSUMER_REDIS_TOKEN` and
 * `OUTBOX_CONSUMER_DEDUP_STORE_TOKEN`, as the SDK's doc-block then
 * instructed. Nest could never see them: `OutboxConsumerService` is
 * declared inside the SDK's own `@Global()` module, and a provider
 * resolves against the module that declares it — so the service failed
 * to construct and the process died in the injector on every boot. Both
 * factories are now handed to `forRoot`, which declares them alongside
 * the service; their bodies stay at the bottom of this file.
 *
 */
@Module({
  imports: [AuditModule],
  providers: [AuditActionRecordedHandler],
})
export class OutboxConsumersModule implements OnModuleInit {
  private readonly logger = new Logger(OutboxConsumersModule.name);

  constructor(
    private readonly consumer: OutboxConsumerService,
    private readonly auditActionRecorded: AuditActionRecordedHandler,
    @Inject(TENANT_CONTEXT_STORE_TOKEN)
    private readonly tenantStore: TenantContextStore,
  ) {}

  onModuleInit(): void {
    const auditActionRecorded = this.auditActionRecorded.handle.bind(this.auditActionRecorded);
    this.consumer.registerHandler(AUDIT_ACTION_RECORDED, async (args) =>
      runWithoutTenantContext(this.tenantStore, 'outbox-consumer-audit-action-recorded', async () =>
        auditActionRecorded(args),
      ),
    );
    this.logger.log({ event: AUDIT_ACTION_RECORDED }, 'outbox-consumers.handler-registered');
  }
}

/**
 * Provider for the Redis client the consumer SDK uses for its
 * `XREADGROUP` / `XAUTOCLAIM` / `XACK` calls. Single connection per pod
 * (shared `REDIS_URL` with the idempotency cache).
 *
 * Passed to `OutboxConsumerModule.forRoot` in `AppModule` rather than
 * registered here: `OutboxConsumerService` is declared inside the SDK's
 * own module, so a provider declared in *this* module is not in scope at
 * its injection site (ADR-0005 / TS-506). The factory body stays here,
 * beside the handlers it serves.
 */
export const outboxConsumerRedisFactory: OutboxConsumerDependencyFactory<ConsumerRedisClient> = {
  // `asConsumerRedisClient` narrows ioredis's heavily-overloaded stream
  // command signatures to the SDK's structural contract. Previously the
  // token was untyped, so the raw `Redis` flowed through unchecked; now
  // the factory's return type is the SDK's own interface and the
  // conversion is explicit.
  useFactory: (env: Env): ConsumerRedisClient =>
    asConsumerRedisClient(
      new Redis(env.REDIS_URL, {
        // Lazy connect so the test environment can mock the client without a
        // real connection attempt on module instantiation.
        lazyConnect: true,
        // The SDK issues blocking `XREADGROUP BLOCK <ms>` calls; auto-pipelining
        // can hold adjacent commands behind the long-poll round-trip.
        enableAutoPipelining: false,
        // Bounded retries; the SDK's scheduler retries on its own cadence.
        maxRetriesPerRequest: 3,
      }),
    ),
  inject: [ENV_TOKEN],
};

/**
 * Provider for the Postgres-backed dedup store, scoped to the `audit` schema's
 * `outbox_consumer_dedup` table. The recognizer's own `audit_events.event_id`
 * UNIQUE is the primary dedup; this store is the SDK's secondary line.
 *
 * Passed to `OutboxConsumerModule.forRoot` in `AppModule` rather than
 * registered here: `OutboxConsumerService` is declared inside the SDK's
 * own module, so a provider declared in *this* module is not in scope at
 * its injection site (ADR-0005 / TS-506). The factory body stays here,
 * beside the handlers it serves.
 */
export const outboxConsumerDedupStoreFactory: OutboxConsumerDependencyFactory<ConsumerDedupStore> =
  {
    useFactory: (prisma: PrismaService): PgConsumerDedupStore =>
      // Cast through `unknown` — the SDK's `ConsumerRawExecutor` is a narrower
      // structural contract than Prisma's generic tagged-template overloads
      // (CLAUDE.md §13 — workspace packages don't hard-dep @prisma/client).
      new PgConsumerDedupStore(prisma as unknown as ConsumerRawExecutor, 'audit'),
    inject: [PrismaService],
  };

/** Re-export for tests that inspect the injection tokens. */
export {
  OUTBOX_CONSUMER_DEDUP_STORE_TOKEN,
  OUTBOX_CONSUMER_REDIS_TOKEN,
} from '@taste-and-see/nest-outbox-consumer';
