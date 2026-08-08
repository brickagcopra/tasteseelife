import 'reflect-metadata';

import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { VisitNotesController } from './visit-notes.controller';

/**
 * Controller-level wiring assertions for `VisitNotesController`
 * (TS-062).
 *
 * Service-layer behavioural coverage lives in
 * `services/visit-notes.service.test.ts`. This file pins the
 * controller's metadata wiring so a refactor that drops the
 * `@Idempotent()` decorator from the PUT handler — silently
 * defeating CLAUDE.md §3.3 / §17.5 replay protection — fails here
 * before reaching production. Same shape as
 * `service-household`'s intake-controller wiring test
 * (TS-044-followup-1).
 */
describe('VisitNotesController route + idempotency wiring (TS-062)', () => {
  // The IdempotencyInterceptor reads this exact symbol when deciding
  // whether to engage the Redis-backed Idempotency-Key replay cache.
  // Symbol.for keeps this test independent of any future internal
  // rename in `@taste-and-see/nest-idempotency`.
  const IDEMPOTENT_METADATA = Symbol.for('@taste-and-see/nest-idempotency:idempotent');

  it('marks PUT /api/v1/bookings/:bookingId/visit-notes as @Idempotent()', () => {
    const handler = VisitNotesController.prototype.upsert as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });

  it('does NOT mark the GET endpoint with @Idempotent()', () => {
    const handler = VisitNotesController.prototype.getByBookingId as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBeUndefined();
  });

  it('routes upsert at PUT api/v1/bookings/:bookingId/visit-notes', () => {
    const handler = VisitNotesController.prototype.upsert as unknown as object;
    const path = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as unknown;
    expect(path).toBe('api/v1/bookings/:bookingId/visit-notes');
    expect(method).toBe(RequestMethod.PUT);
  });

  it('routes getByBookingId at GET api/v1/bookings/:bookingId/visit-notes', () => {
    const handler = VisitNotesController.prototype.getByBookingId as unknown as object;
    const path = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as unknown;
    expect(path).toBe('api/v1/bookings/:bookingId/visit-notes');
    expect(method).toBe(RequestMethod.GET);
  });
});
