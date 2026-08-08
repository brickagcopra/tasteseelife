import { SetMetadata } from '@nestjs/common';

import type { RateLimitPolicy } from '../services/rate-limit.service';

export const RATE_LIMIT_METADATA = Symbol.for('@taste-and-see/api-gateway:rate-limit');

export interface RateLimitOptions {
  readonly policy: RateLimitPolicy;
}

/**
 * Per-route rate-limit policy decorator. Place above a controller
 * method to override the default policy:
 *
 *   `@RateLimit({ policy: 'sensitive' })`
 *
 * Surface stays minimal in Phase 1 — only the policy selector is
 * configurable; the actual window + max come from env so ops can
 * adjust them across deploys without code changes (PRD §11.1).
 *
 * Omitting the decorator on a route is the `default` policy.
 */
export const RateLimit = (options: RateLimitOptions): MethodDecorator =>
  SetMetadata(RATE_LIMIT_METADATA, options);
