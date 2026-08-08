import { Injectable } from '@nestjs/common';

/**
 * Injectable clock so the sponsored-listings resolve has a deterministic
 * `now` in tests (flight-window filtering + the response `resolvedAt`).
 * Mirrors the media-processor `Clock` port shape.
 */
export interface Clock {
  now(): Date;
}

export const SPONSORED_LISTINGS_CLOCK_TOKEN = Symbol('SPONSORED_LISTINGS_CLOCK');

@Injectable()
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
