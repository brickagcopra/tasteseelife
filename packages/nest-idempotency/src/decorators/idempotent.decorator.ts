import { SetMetadata } from '@nestjs/common';

/**
 * Reflector metadata key set by `@Idempotent()`. The
 * `IdempotencyInterceptor` reads this metadata; without it, the
 * interceptor is a pass-through.
 *
 * Exported so the interceptor (and consumer tests) can reference the
 * same symbol — never type the literal string.
 */
export const IDEMPOTENT_METADATA = Symbol.for('@taste-and-see/nest-idempotency:idempotent');

/**
 * Mark a controller method as idempotent. The
 * `IdempotencyInterceptor` (wired globally by `IdempotencyModule`)
 * inspects this metadata and applies the Redis-backed
 * Idempotency-Key replay cache per CLAUDE.md §3.3.
 *
 * Usage:
 *
 *   ```ts
 *   @Post()
 *   @Idempotent()
 *   async create(@Body() body: CreateRequest) { ... }
 *   ```
 *
 * Endpoints that DON'T carry this decorator are passed through the
 * interceptor without any Redis call (zero cost). The opt-in design
 * keeps read endpoints fast and forces a deliberate choice at every
 * write site.
 */
export const Idempotent = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IDEMPOTENT_METADATA, true);
