import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Env } from '../../config/env';

import {
  INBOUND_ONLY_SENTINEL_API_KEY,
  createInboundOnlyStripeClient,
} from './stripe-client.factory';

/**
 * Pins the inbound-only Stripe contract chosen in TS-508.
 *
 * These are not incidental assertions. Each is a property the service
 * depends on, and the first of them was violated by the previous
 * `new Stripe('')` wiring — which threw at construction and so kept
 * `service-webhook` from ever answering `/healthz`.
 */

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_WEBHOOK_TOLERANCE_SECONDS: 300,
    ...overrides,
  } as unknown as Env;
}

const WEBHOOK_SECRET = 'whsec_test_secret_value_long_enough';

/**
 * A fixed timestamp keeps signature verification off the wall clock
 * (CLAUDE.md §9.3 "no sleep(), deterministic clock"). Tolerance is
 * disabled at the call site rather than faking `Date`.
 */
const FIXED_TIMESTAMP = 1_700_000_000;

/**
 * `getApiField` is real and stable on the SDK but absent from its public
 * `.d.ts`, so the read is narrowed here rather than casting at each site.
 */
function apiVersionOf(client: Stripe): string {
  return (client as unknown as { getApiField(key: 'version'): string }).getApiField('version');
}

function signPayload(payload: string, secret: string): string {
  const signature = createHmac('sha256', secret)
    .update(`${String(FIXED_TIMESTAMP)}.${payload}`)
    .digest('hex');
  return `t=${String(FIXED_TIMESTAMP)},v1=${signature}`;
}

describe('createInboundOnlyStripeClient', () => {
  it('constructs without a real API key — the pod must be able to boot', () => {
    expect(() => createInboundOnlyStripeClient(makeEnv())).not.toThrow();
  });

  it('pins the API version from env when one is configured', () => {
    const client = createInboundOnlyStripeClient(
      makeEnv({ STRIPE_API_VERSION: '2024-11-20.acacia' }),
    );

    expect(apiVersionOf(client)).toBe('2024-11-20.acacia');
  });

  it('leaves the API version to the SDK default when env does not pin one', () => {
    const client = createInboundOnlyStripeClient(makeEnv());

    expect(apiVersionOf(client)).not.toBe('');
  });

  it('verifies a genuine webhook signature — the API key plays no part on this path', () => {
    const client = createInboundOnlyStripeClient(makeEnv());
    const payload = JSON.stringify({ id: 'evt_test_1', object: 'event', type: 'ping' });

    const event = client.webhooks.constructEvent(
      payload,
      signPayload(payload, WEBHOOK_SECRET),
      WEBHOOK_SECRET,
      Number.MAX_SAFE_INTEGER,
    );

    expect(event.id).toBe('evt_test_1');
  });

  it('rejects a forged webhook signature', () => {
    const client = createInboundOnlyStripeClient(makeEnv());

    expect(() =>
      client.webhooks.constructEvent(
        JSON.stringify({ id: 'evt_forged' }),
        't=1700000000,v1=deadbeef',
        WEBHOOK_SECRET,
        Number.MAX_SAFE_INTEGER,
      ),
    ).toThrow();
  });
});

describe('INBOUND_ONLY_SENTINEL_API_KEY', () => {
  it('is not credential-shaped, so nothing can mistake it for a real key', () => {
    expect(INBOUND_ONLY_SENTINEL_API_KEY).not.toMatch(/^(sk|rk|pk)_/);
    expect(INBOUND_ONLY_SENTINEL_API_KEY).toContain('unusable-key');
  });
});

/**
 * The fail-loud half of the contract: an accidental outbound call must
 * reject, promptly and unmistakably, rather than hang or succeed.
 *
 * Run against a local server standing in for Stripe's 401 so the test
 * needs no network. The client is built directly rather than through
 * the factory only because `host`/`port`/`protocol` are construction-
 * time options the factory (rightly) does not expose — it carries the
 * same {@link INBOUND_ONLY_SENTINEL_API_KEY} the factory uses, which is
 * the property under test.
 */
describe('outbound API calls with the sentinel key', () => {
  let server: Server;
  let requestedAuthorization: string | undefined;
  let client: Stripe;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      requestedAuthorization = req.headers.authorization;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { type: 'invalid_request_error', message: 'Invalid API Key provided' },
        }),
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });

    const { port } = server.address() as AddressInfo;
    client = new Stripe(INBOUND_ONLY_SENTINEL_API_KEY, {
      host: '127.0.0.1',
      port,
      protocol: 'http',
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  it('rejects the caller promise instead of hanging or resolving', async () => {
    // `rejects` is what pins the contract: the authenticator approach
    // considered in TS-508 left this promise permanently pending.
    await expect(client.customers.list()).rejects.toBeInstanceOf(Stripe.errors.StripeError);
  });

  it('sends the sentinel, so no usable credential leaves the pod', async () => {
    await client.customers.list().catch(() => undefined);

    expect(requestedAuthorization).toBe(`Bearer ${INBOUND_ONLY_SENTINEL_API_KEY}`);
  });
});
