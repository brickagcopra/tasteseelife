import { describe, expect, it } from 'vitest';

import { HealthController } from './health.controller';

describe('HealthController', () => {
  const controller = new HealthController();

  it('liveness returns ok', () => {
    expect(controller.liveness()).toEqual({ status: 'ok' });
  });

  it('readiness returns ok (no synchronous hard dependency to probe)', () => {
    expect(controller.readiness()).toEqual({ status: 'ok' });
  });
});
