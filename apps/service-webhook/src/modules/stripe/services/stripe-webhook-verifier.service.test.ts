import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import { StripeWebhookVerifierService } from './stripe-webhook-verifier.service';

/**
 * A `Stripe` stand-in surfacing only the `webhooks.constructEvent` method
 * the verifier touches. The rest of the SDK surface is irrelevant to this
 * test suite — keeping the stub minimal forces the verifier to interact
 * with only the contract we've documented.
 */
interface FakeStripe {
  readonly webhooks: {
    readonly constructEvent: ReturnType<typeof vi.fn>;
  };
}

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3013,
    LOG_LEVEL: 'error', // suppress info logs during noisy tests
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    SERVICE_VERSION: 'dev',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_aaaaaaaaaaaaaaaaaaaa',
    STRIPE_WEBHOOK_TOLERANCE_SECONDS: 300,
    // TS-026 / TS-051: required by Env shape (defaulted).
    KYC_DISPATCH_TIMEOUT_MS: 5_000,
    CHECKR_WEBHOOK_SECRET: 'whsec_test_checkr_bbbbbbbbbbbbbb',
    CHECKR_WEBHOOK_TOLERANCE_SECONDS: 300,
    BACKGROUND_CHECK_DISPATCH_TIMEOUT_MS: 5_000,
    // TS-041a-followup-4: now-required schema fields (boolean post-transform).
    OTEL_TRACES_ENABLED: true,
    OTEL_METRICS_ENABLED: true,
    ...overrides,
  };
}

function buildVerifier(args?: {
  readonly constructEvent?: ReturnType<typeof vi.fn>;
  readonly env?: Env;
}): { verifier: StripeWebhookVerifierService; stripe: FakeStripe } {
  const constructEvent = args?.constructEvent ?? vi.fn();
  const stripe: FakeStripe = {
    webhooks: { constructEvent },
  };
  const verifier = new StripeWebhookVerifierService(
    stripe as unknown as Stripe,
    args?.env ?? buildEnv(),
  );
  return { verifier, stripe };
}

function makeEvent(overrides: Partial<Stripe.Event> = {}): Stripe.Event {
  return {
    id: 'evt_test_1',
    object: 'event',
    api_version: '2025-09-30.basil',
    created: Math.floor(Date.now() / 1000),
    data: { object: {} } as Stripe.Event.Data,
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: 'customer.subscription.created',
    ...overrides,
  } as Stripe.Event;
}

describe('StripeWebhookVerifierService', () => {
  describe('success path', () => {
    it('returns ok=true with the parsed event when constructEvent succeeds', () => {
      const event = makeEvent({ id: 'evt_happy', type: 'invoice.paid' });
      const constructEvent = vi.fn().mockReturnValue(event);
      const { verifier } = buildVerifier({ constructEvent });

      const result = verifier.verify({
        rawBody: Buffer.from('{"id":"evt_happy"}'),
        signatureHeader: 't=1700000000,v1=abc123',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.event.id).toBe('evt_happy');
        expect(result.event.type).toBe('invoice.paid');
        expect(result.verifiedAt).toBeInstanceOf(Date);
      }
    });

    it('passes the configured secret and tolerance window to the SDK', () => {
      const event = makeEvent();
      const constructEvent = vi.fn().mockReturnValue(event);
      const env = buildEnv({
        STRIPE_WEBHOOK_SECRET: 'whsec_specific_secret_value',
        STRIPE_WEBHOOK_TOLERANCE_SECONDS: 600,
      });
      const { verifier } = buildVerifier({ constructEvent, env });

      const body = Buffer.from('{}');
      verifier.verify({
        rawBody: body,
        signatureHeader: 't=1,v1=x',
      });

      expect(constructEvent).toHaveBeenCalledTimes(1);
      expect(constructEvent).toHaveBeenCalledWith(
        body,
        't=1,v1=x',
        'whsec_specific_secret_value',
        600,
      );
    });

    it('accepts a first non-empty entry when the signature header is an array', () => {
      const event = makeEvent();
      const constructEvent = vi.fn().mockReturnValue(event);
      const { verifier } = buildVerifier({ constructEvent });

      const result = verifier.verify({
        rawBody: Buffer.from('{}'),
        signatureHeader: ['', 't=1,v1=ok'],
      });

      expect(result.ok).toBe(true);
      expect(constructEvent).toHaveBeenCalledWith(
        expect.any(Buffer),
        't=1,v1=ok',
        expect.any(String),
        expect.any(Number),
      );
    });
  });

  describe('failure: missing signature header', () => {
    it.each([undefined, '', [], ['', '']])(
      'returns ok=false reason=missing_signature_header when the header is %p',
      (header) => {
        const constructEvent = vi.fn();
        const { verifier } = buildVerifier({ constructEvent });

        const result = verifier.verify({
          rawBody: Buffer.from('{}'),
          signatureHeader: header as string | string[] | undefined,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe('missing_signature_header');
        }
        // Crucially: the SDK is NEVER invoked when no signature is
        // present (defence-in-depth — avoid handing arbitrary input to
        // the SDK without first proving Stripe asked us to look at it).
        expect(constructEvent).not.toHaveBeenCalled();
      },
    );
  });

  describe('failure: invalid signature', () => {
    it('returns ok=false reason=invalid_signature when the SDK throws StripeSignatureVerificationError', () => {
      const err = new Error('No signatures found matching the expected signature for payload.');
      err.name = 'StripeSignatureVerificationError';
      const constructEvent = vi.fn().mockImplementation(() => {
        throw err;
      });
      const { verifier } = buildVerifier({ constructEvent });

      const result = verifier.verify({
        rawBody: Buffer.from('{"x":1}'),
        signatureHeader: 't=1,v1=forged',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid_signature');
      }
    });
  });

  describe('failure: replay outside tolerance', () => {
    it('returns ok=false reason=replay_outside_tolerance when the SDK reports a stale timestamp', () => {
      const err = new Error('Timestamp outside the tolerance zone');
      err.name = 'StripeSignatureVerificationError';
      const constructEvent = vi.fn().mockImplementation(() => {
        throw err;
      });
      const { verifier } = buildVerifier({ constructEvent });

      const result = verifier.verify({
        rawBody: Buffer.from('{}'),
        signatureHeader: 't=1000,v1=valid_but_stale',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('replay_outside_tolerance');
      }
    });
  });

  describe('failure: invalid payload shape', () => {
    it('classifies a JSON-parse error as invalid_payload_shape', () => {
      const err = new Error('Unexpected token < in JSON at position 0');
      const constructEvent = vi.fn().mockImplementation(() => {
        throw err;
      });
      const { verifier } = buildVerifier({ constructEvent });

      const result = verifier.verify({
        rawBody: Buffer.from('<html/>'),
        signatureHeader: 't=1,v1=x',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid_payload_shape');
      }
    });
  });

  describe('failure: unknown SDK error', () => {
    it('classifies an unrecognised SDK error as unknown without throwing', () => {
      const constructEvent = vi.fn().mockImplementation(() => {
        throw new Error('some new sdk error mode we have not seen before');
      });
      const { verifier } = buildVerifier({ constructEvent });

      const result = verifier.verify({
        rawBody: Buffer.from('{}'),
        signatureHeader: 't=1,v1=x',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('unknown');
      }
    });

    it('classifies a non-Error throw as unknown', () => {
      const constructEvent = vi.fn().mockImplementation(() => {
        // Stripe SDK should not do this, but defence-in-depth: if a future
        // SDK version throws a plain string, we still return a typed
        // failure rather than letting it escape.
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'boom';
      });
      const { verifier } = buildVerifier({ constructEvent });

      const result = verifier.verify({
        rawBody: Buffer.from('{}'),
        signatureHeader: 't=1,v1=x',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('unknown');
      }
    });
  });

  describe('misuse: non-Buffer raw body', () => {
    it('throws TypeError when rawBody is a string (raw-body parser is misconfigured)', () => {
      const constructEvent = vi.fn();
      const { verifier } = buildVerifier({ constructEvent });

      expect(() =>
        verifier.verify({
          rawBody: '{}' as unknown as Buffer,
          signatureHeader: 't=1,v1=x',
        }),
      ).toThrow(TypeError);
      // The SDK must not be consulted when the raw body shape is wrong —
      // surfacing the misconfiguration loudly is the whole point.
      expect(constructEvent).not.toHaveBeenCalled();
    });
  });
});
