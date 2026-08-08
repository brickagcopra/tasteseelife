import 'reflect-metadata';

import { Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { PagerDutyClient } from '../client';
import { PagerDutyConfigError } from './options';
import { PagerDutyModule } from './pagerduty.module';
import { PAGERDUTY_OPTIONS_TOKEN } from './tokens';

/**
 * The module is `@Global()` on purpose: a feature module that pages on-call
 * injects `PagerDutyClient` without importing anything, which is how
 * `service-concierge`'s `EmergencyModule` consumes it after TS-302b removed
 * the client from its own `providers`. `ConsumerModule` below reproduces
 * exactly that shape — no import of `PagerDutyModule` — so a regression to a
 * non-global module fails here rather than at service boot.
 *
 * The injection is written `@Inject(PagerDutyClient)` rather than relying on
 * the constructor parameter type: vitest transpiles with esbuild, which
 * implements `experimentalDecorators` but NOT `emitDecoratorMetadata`, so
 * `design:paramtypes` is absent under test. The real services compile with
 * `tsc`, where the bare parameter type resolves as usual.
 */
@Injectable()
class PagingConsumer {
  constructor(@Inject(PagerDutyClient) readonly pagerDuty: PagerDutyClient) {}
}

@Module({ providers: [PagingConsumer] })
class ConsumerModule {}

describe('PagerDutyModule.forRoot', () => {
  it('provides the client to a feature module that never imports it', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PagerDutyModule.forRoot({ source: 'service-concierge' }), ConsumerModule],
    }).compile();

    expect(moduleRef.get(PagingConsumer).pagerDuty).toBeInstanceOf(PagerDutyClient);
    await moduleRef.close();
  });

  it('binds the validated options (defaults applied) to the options token', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PagerDutyModule.forRoot({ source: 'service-trust-safety', routingKey: 'rk_1' })],
    }).compile();

    expect(moduleRef.get(PAGERDUTY_OPTIONS_TOKEN)).toEqual({
      source: 'service-trust-safety',
      routingKey: 'rk_1',
      eventsUrl: 'https://events.pagerduty.com/v2/enqueue',
      timeoutMs: 5_000,
    });
    await moduleRef.close();
  });

  it('fails at module-definition time on bad configuration, before boot', () => {
    expect(() => PagerDutyModule.forRoot({ source: 'svc', timeoutMs: 60_000 })).toThrow(
      PagerDutyConfigError,
    );
  });
});
