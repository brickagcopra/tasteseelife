import 'reflect-metadata';

import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { CheckInsController } from './check-ins.controller';

/**
 * Controller-level wiring assertions for `CheckInsController` (TS-063).
 *
 * Service-layer behavioural coverage lives in
 * `services/check-ins.service.test.ts`. This file pins the controller's
 * metadata wiring so a refactor that drops the `@Idempotent()`
 * decorator from the POST handler — silently defeating CLAUDE.md
 * §3.3 / §17.5 replay protection — fails here before reaching
 * production. Same shape as `VisitNotesController`'s wiring test.
 */
describe('CheckInsController route + idempotency wiring (TS-063)', () => {
  // The IdempotencyInterceptor reads this exact symbol when deciding
  // whether to engage the Redis-backed Idempotency-Key replay cache.
  const IDEMPOTENT_METADATA = Symbol.for('@taste-and-see/nest-idempotency:idempotent');

  it('marks POST /api/v1/bookings/:bookingId/check-ins as @Idempotent()', () => {
    const handler = CheckInsController.prototype.record as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });

  it('does NOT mark the GET endpoint with @Idempotent()', () => {
    const handler = CheckInsController.prototype.list as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBeUndefined();
  });

  it('routes record at POST api/v1/bookings/:bookingId/check-ins', () => {
    const handler = CheckInsController.prototype.record as unknown as object;
    const path = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as unknown;
    expect(path).toBe('api/v1/bookings/:bookingId/check-ins');
    expect(method).toBe(RequestMethod.POST);
  });

  it('routes list at GET api/v1/bookings/:bookingId/check-ins', () => {
    const handler = CheckInsController.prototype.list as unknown as object;
    const path = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as unknown;
    expect(path).toBe('api/v1/bookings/:bookingId/check-ins');
    expect(method).toBe(RequestMethod.GET);
  });
});
