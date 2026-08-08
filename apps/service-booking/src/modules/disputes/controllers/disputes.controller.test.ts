import 'reflect-metadata';

import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { DisputesController } from './disputes.controller';

/**
 * Controller-level wiring assertions for `DisputesController`
 * (TS-065).
 *
 * Service-layer behavioural coverage lives in
 * `services/disputes.service.test.ts`. This file pins the
 * controller's metadata wiring so a refactor that drops the
 * `@Idempotent()` decorator from POST / PATCH — silently defeating
 * CLAUDE.md §3.3 / §17.5 replay protection — fails here before
 * reaching production. Same shape as
 * `services/check-ins.controller.test.ts` (TS-063) and
 * `services/visit-notes.controller.test.ts` (TS-062).
 */
describe('DisputesController route + idempotency wiring (TS-065)', () => {
  // The IdempotencyInterceptor reads this exact symbol when deciding
  // whether to engage the Redis-backed Idempotency-Key replay cache.
  // Symbol.for keeps this test independent of any future internal
  // rename in `@taste-and-see/nest-idempotency`.
  const IDEMPOTENT_METADATA = Symbol.for('@taste-and-see/nest-idempotency:idempotent');

  it('marks POST /api/v1/bookings/:bookingId/disputes as @Idempotent()', () => {
    const handler = DisputesController.prototype.openDispute as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });

  it('marks PATCH /api/v1/disputes/:disputeId as @Idempotent()', () => {
    const handler = DisputesController.prototype.updateDispute as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });

  it('does NOT mark the list endpoint with @Idempotent()', () => {
    const handler = DisputesController.prototype.listByBookingId as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBeUndefined();
  });

  it('does NOT mark the single-read endpoint with @Idempotent()', () => {
    const handler = DisputesController.prototype.getById as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBeUndefined();
  });

  it('routes openDispute at POST api/v1/bookings/:bookingId/disputes', () => {
    const handler = DisputesController.prototype.openDispute as unknown as object;
    const path = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as unknown;
    expect(path).toBe('api/v1/bookings/:bookingId/disputes');
    expect(method).toBe(RequestMethod.POST);
  });

  it('routes listByBookingId at GET api/v1/bookings/:bookingId/disputes', () => {
    const handler = DisputesController.prototype.listByBookingId as unknown as object;
    const path = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as unknown;
    expect(path).toBe('api/v1/bookings/:bookingId/disputes');
    expect(method).toBe(RequestMethod.GET);
  });

  it('routes getById at GET api/v1/disputes/:disputeId', () => {
    const handler = DisputesController.prototype.getById as unknown as object;
    const path = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as unknown;
    expect(path).toBe('api/v1/disputes/:disputeId');
    expect(method).toBe(RequestMethod.GET);
  });

  it('routes updateDispute at PATCH api/v1/disputes/:disputeId', () => {
    const handler = DisputesController.prototype.updateDispute as unknown as object;
    const path = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as unknown;
    expect(path).toBe('api/v1/disputes/:disputeId');
    expect(method).toBe(RequestMethod.PATCH);
  });
});
