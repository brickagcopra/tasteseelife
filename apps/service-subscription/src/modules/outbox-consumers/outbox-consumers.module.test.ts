import {
  STRIPE_INVOICE_CHANGED,
  STRIPE_PAYMENT_METHOD_CHANGED,
  STRIPE_SUBSCRIPTION_CHANGED,
} from '@taste-and-see/contracts';
import type { OutboxConsumerService } from '@taste-and-see/nest-outbox-consumer';
import type { TenantContextStore } from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it, vi } from 'vitest';

import type { StripeInvoiceChangedHandler } from './handlers/stripe-invoice-changed.handler';
import type { StripePaymentMethodChangedHandler } from './handlers/stripe-payment-method-changed.handler';
import type { StripeSubscriptionChangedHandler } from './handlers/stripe-subscription-changed.handler';
import { OutboxConsumersModule, isLiveStripeKey } from './outbox-consumers.module';

describe('isLiveStripeKey', () => {
  it('recognises the two live key prefixes', () => {
    expect(isLiveStripeKey('sk_live_abc123')).toBe(true);
    expect(isLiveStripeKey('rk_live_abc123')).toBe(true);
  });

  it('treats test keys as test', () => {
    expect(isLiveStripeKey('sk_test_abc123')).toBe(false);
    expect(isLiveStripeKey('rk_test_abc123')).toBe(false);
  });

  it('FALLS TO TEST on an unrecognised prefix — the safe direction', () => {
    // A mislabelled live pod drops live events noisily (mode_mismatch WARN +
    // metric). A mislabelled test pod would apply test events to real
    // subscriptions, which no retry recovers from. The asymmetry decides the
    // default.
    expect(isLiveStripeKey('')).toBe(false);
    expect(isLiveStripeKey('whsec_something')).toBe(false);
    expect(isLiveStripeKey('sk_LIVE_uppercase')).toBe(false);
  });

  it('is not fooled by `live` appearing anywhere but the prefix', () => {
    expect(isLiveStripeKey('sk_test_deliverance')).toBe(false);
  });
});

describe('OutboxConsumersModule', () => {
  it('registers BOTH relayed event classes under their contract names', () => {
    const registerHandler = vi.fn();
    const handle = vi.fn().mockResolvedValue(undefined);
    const module = new OutboxConsumersModule(
      { registerHandler } as unknown as OutboxConsumerService,
      { handle } as unknown as StripeSubscriptionChangedHandler,
      { handle } as unknown as StripeInvoiceChangedHandler,
      { handle } as unknown as StripePaymentMethodChangedHandler,
      {} as unknown as TenantContextStore,
    );

    module.onModuleInit();

    // Both relayed classes are registered. A handler built but never
    // registered is the failure mode this asserts against: every unit test
    // for it passes and it is never invoked in production.
    expect(registerHandler).toHaveBeenCalledTimes(3);
    expect(registerHandler.mock.calls.map((call) => call[0])).toEqual([
      STRIPE_SUBSCRIPTION_CHANGED,
      STRIPE_INVOICE_CHANGED,
      STRIPE_PAYMENT_METHOD_CHANGED,
    ]);
  });

  it('wraps the dispatch so the handler runs with a tenant-context frame', async () => {
    // The SDK invokes handlers from a background poll loop, so there is no
    // request to seed the scoped frame from. Unwrapped, the first Prisma call
    // dies with MissingRequestContextError — at runtime only, in production
    // only, on the first real Stripe event.
    const registerHandler = vi.fn();
    const handle = vi.fn().mockResolvedValue(undefined);
    const frames: string[] = [];
    const store = {
      run: vi.fn((_context: unknown, fn: () => Promise<unknown>) => fn()),
    };
    const module = new OutboxConsumersModule(
      { registerHandler } as unknown as OutboxConsumerService,
      { handle } as unknown as StripeSubscriptionChangedHandler,
      { handle } as unknown as StripeInvoiceChangedHandler,
      { handle } as unknown as StripePaymentMethodChangedHandler,
      store as unknown as TenantContextStore,
    );

    module.onModuleInit();
    const registered = registerHandler.mock.calls[0]![1] as (args: unknown) => Promise<void>;
    await registered({ envelope: {}, payload: {} });

    expect(store.run).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledTimes(1);
    // The frame's reason string is grep-able and names this consumer.
    const context = store.run.mock.calls[0]![0] as { reason?: string };
    frames.push(String(context.reason ?? ''));
    expect(frames[0]).toContain('stripe-subscription-changed');
  });
});
