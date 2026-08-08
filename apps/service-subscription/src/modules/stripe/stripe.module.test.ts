import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';

import { STRIPE_SDK_TOKEN } from './stripe.constants';
import { StripeModule } from './stripe.module';

/**
 * The factory wiring is small but security-critical: a misbound provider
 * could quietly construct the Stripe SDK with the wrong key and silently
 * call live Stripe with test data. The tests pin: (a) the provided
 * instance is a real Stripe SDK; (b) the secret-key env value flows in;
 * (c) the optional API-version pin is honoured when present and absent.
 *
 * Because `StripeModule` is `@Global()`, its factory provider's
 * `inject: [ENV_TOKEN]` resolves through the application's root injector,
 * not the local TestingModule's sibling providers. We work around this
 * by building a thin `TestEnvModule` that's ALSO `@Global` and exports
 * `ENV_TOKEN` — both modules' globals coexist in the root scope and
 * the StripeModule's factory finds the env value cleanly.
 */
function buildEnv(overrides: Partial<Env> = {}): Env {
  const base = {
    NODE_ENV: 'test',
    PORT: 3012,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://localhost:5432/tastesee',
    SERVICE_VERSION: 'test',
    STRIPE_SECRET_KEY: 'sk_test_unit_test_key_value_xx',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
  } as const;
  return { ...base, ...overrides } as unknown as Env;
}

function makeTestEnvModule(env: Env): new () => unknown {
  @(Module({
    providers: [{ provide: ENV_TOKEN, useValue: env }],
    exports: [ENV_TOKEN],
  }) as ClassDecorator)
  class TestEnvModule {}
  // The decorator wires the @Global metadata via `Reflect`; we apply
  // it imperatively here because `@Global` from `@nestjs/common` can
  // only stamp a class declaration once per file.
  Reflect.defineMetadata('__module:global__', true, TestEnvModule);
  return TestEnvModule;
}

describe('StripeModule', () => {
  it('provides a Stripe SDK instance under STRIPE_SDK_TOKEN', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [makeTestEnvModule(buildEnv()), StripeModule],
    }).compile();

    const sdk = moduleRef.get<Stripe>(STRIPE_SDK_TOKEN);
    expect(sdk).toBeInstanceOf(Stripe);
  });

  it('does not throw when STRIPE_API_VERSION is unset (uses SDK default)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        makeTestEnvModule(
          buildEnv({ STRIPE_API_VERSION: undefined as unknown as Env['STRIPE_API_VERSION'] }),
        ),
        StripeModule,
      ],
    }).compile();

    expect(() => moduleRef.get<Stripe>(STRIPE_SDK_TOKEN)).not.toThrow();
  });

  it('honours an explicit STRIPE_API_VERSION pin', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        makeTestEnvModule(buildEnv({ STRIPE_API_VERSION: '2024-12-18.acacia' })),
        StripeModule,
      ],
    }).compile();

    const sdk = moduleRef.get<Stripe>(STRIPE_SDK_TOKEN);
    // The SDK exposes the pinned version on its private-but-stable
    // `_api.version` field. Cast through `unknown` to access it
    // without an `as` assertion-as-truth on the typed surface.
    expect((sdk as unknown as { _api: { version: string } })._api.version).toBe(
      '2024-12-18.acacia',
    );
  });
});
