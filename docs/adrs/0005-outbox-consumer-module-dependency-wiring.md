# ADR-0005 — `@taste-and-see/nest-outbox-consumer`: the SDK module owns its own dependency providers

- **Status:** Accepted
- **Date:** 2026-07-29
- **Deciders:** Engineering (owner: brickagcopra)
- **Supersedes:** —
- **Superseded by:** —
- **Implements:** TS-506 (5 of the 8 services that die at boot on an unresolvable DI graph)

---

## Context

`OutboxConsumerModule.forRoot(...)` declares `OutboxConsumerService` inside the
SDK's own `@Global()` dynamic module. That service injects two tokens:

- `OUTBOX_CONSUMER_REDIS_TOKEN` — the ioredis client used for
  `XREADGROUP` / `XAUTOCLAIM` / `XACK`;
- `OUTBOX_CONSUMER_DEDUP_STORE_TOKEN` — the `ConsumerDedupStore`.

The SDK's own doc-block instructs each consuming service to provide those two
tokens **in its own module** (`apps/<service>/src/modules/outbox-consumers/`),
and all five consumers — `service-audit`, `service-accounting`,
`service-analytics`, `service-booking`, `service-trust-safety` — followed that
instruction exactly.

It cannot work. Nest resolves a provider's dependencies in the scope of the
module where the provider is **declared**: that module's own providers, the
providers exported by the modules it imports, and the exports of global modules.
`OutboxConsumerService` is declared in `OutboxConsumerModule`, which imports
nothing and to which the consumer's local providers are invisible. `@Global()`
does not help — it widens where the SDK's _exports_ can be **consumed**, not
where the SDK's _own_ dependencies can be **found**.

So every one of the five services threw
`Nest can't resolve dependencies of the OutboxConsumerService (..., ?, ?)` inside
the injector, before the HTTP server bound. None of them could answer `/healthz`.

Nothing caught it because the unit suites build narrow
`Test.createTestingModule` graphs with mocks; nothing instantiates the real
`AppModule`. The five services' 2,000-odd tests were all green against a wiring
that had never once started.

Two further details shaped the decision:

1. The SDK's `useMemoryDedupStore?: boolean` flag provided _one_ of the two
   tokens from inside the SDK module. That is exactly the half-provision that
   made the broken contract read as plausible: it demonstrated the SDK
   _could_ provide these tokens, while the doc-block said consumers must. It has
   **zero callers** in the repo.
2. The consumers' factories inject `ENV_TOKEN` and `PrismaService` — per-service
   providers. Any fix must therefore give the SDK module a way to reach into the
   consumer's graph, not merely to construct values itself.

## Decision

### 1. The SDK module declares the providers; the consumer supplies the factories

`forRoot` gains three fields, and the two dependency factories are **required**:

```ts
OutboxConsumerModule.forRoot({
  consumerGroup: 'service-trust-safety',
  consumerName: env.OUTBOX_CONSUMER_NAME,
  // …existing tuning options…
  imports: [AppConfigModule, PrismaModule],
  redis: {
    useFactory: (env: Env) =>
      new Redis(env.REDIS_URL, {
        /* … */
      }),
    inject: [ENV_TOKEN],
  },
  dedupStore: {
    useFactory: (prisma: PrismaService) => new PgConsumerDedupStore(prisma, 'trust_safety'),
    inject: [PrismaService],
  },
});
```

The returned `DynamicModule` carries `imports` plus provider entries for both
tokens, so `OutboxConsumerService`'s dependencies are declared in the same module
it is. This is the ordinary Nest idiom for a dynamic module with per-app
dependencies (`TypeOrmModule.forRootAsync`, `JwtModule.registerAsync`), and it
keeps the SDK free of a direct `ioredis` or `@prisma/client` dependency — the
factory bodies still live in the consuming service, typed against the SDK's own
structural `ConsumerRedisClient` / `ConsumerDedupStore` interfaces.

### 2. `redis` and `dedupStore` are required, not optional

Making them optional would leave every current call site compiling and still
broken — the TS-506 failure itself. Required means the five migrations are
compile errors, and a sixth consumer added next year cannot repeat the mistake.
This is the same posture TS-308c-followup-2 and TS-304-followup-1 arrived at
independently: _a documented input field is not a wired one; make it required and
let the compiler enumerate the call sites._

### 3. `useMemoryDedupStore` is removed

It has no callers, and its only effect was to provide one of the two tokens from
inside the SDK — the ambiguity at the root of this bug. A test that wants the
memory store now passes it explicitly, which reads the same as production:

```ts
dedupStore: {
  useFactory: () => new MemoryConsumerDedupStore();
}
```

`MemoryConsumerDedupStore` is already exported from the package index; nothing
else changes.

### 4. A boot-graph regression test per service

The API change fixes today's five. It does not address _why nobody noticed_, and
that blind spot is not specific to the outbox SDK — TS-506's other three
services (`service-search`, `service-academy`, `service-content`) each failed on
an unrelated hole in their own graph.

So every Nest service gains a test that compiles its **real** `AppModule` against
stub env and asserts the injector resolves. It does not listen on a port or touch
Postgres/Redis — `Test.createTestingModule({ imports: [AppModule] }).compile()`
performs dependency resolution, which is the property that was unguarded.

## Consequences

**Positive.**

- The five services boot. `OutboxConsumerService` is resolvable by construction
  rather than by convention.
- The SDK is self-contained: reading `consumer.module.ts` now tells you where
  every dependency comes from.
- The compiler, not a doc-block, enforces the wiring contract.
- The per-service boot test closes the class of defect, not just this instance.

**Negative / accepted.**

- Five `AppModule`s grow the factory bodies that used to live in their local
  `OutboxConsumersModule`. The composition root is the honest home for them —
  they configure a globally-registered SDK — but the local modules become
  thinner, and a reader looking for the Redis client now looks one level up. The
  local modules keep a pointer comment.
- `forRoot`'s options object is larger. Accepted: the alternative is an options
  object that lies.

**Rejected alternatives.**

- _Move `OutboxConsumerService` into each consumer's module._ Restores
  resolution, but every consumer would re-declare the service and the scheduler,
  and `@Global()` would stop meaning anything. It pushes SDK wiring into five
  places instead of removing the hazard from one.
- _Re-export the tokens from the consumer's module._ Nest exports flow to
  importers; the SDK module does not import the consumer's module, and making it
  do so inverts the dependency (the SDK would have to know its consumers).
- _Resolve the tokens lazily via `ModuleRef` at bootstrap time._ Works, and keeps
  every call site untouched — which is precisely the objection: it converts a
  compile-time hole into a runtime one, deferring the same failure from
  `NestFactory` to the first poll tick, where a service that answers `/healthz`
  quietly consumes nothing.
- _Give the SDK a direct `ioredis` dependency and build the client from
  `REDIS_URL`._ Removes the `redis` factory entirely, but breaks the deliberate
  property recorded in the SDK's doc-block: consumers share one ioredis client
  between the consumer SDK and the idempotency cache, so a pod holds one
  connection rather than two.
