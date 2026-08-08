import { Inject, Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { isStripeStubMode } from '../../../config/env';

/**
 * Thin wrapper around the Stripe SDK for the two TS-090 surfaces we
 * need: create-or-fetch an Express connected account, and mint an
 * account link.
 *
 * **Stub mode.** When `STRIPE_SECRET_KEY` is absent (or the explicit
 * `sk_test_stub_*` sentinel is set), the service returns deterministic
 * synthetic values:
 *
 *   - `acct_stub_<providerId>` for account ids
 *   - `<STRIPE_STUB_ONBOARDING_BASE_URL>/<kind>/<providerId>?ts=<iso>`
 *     for onboarding links
 *
 * Stub mode logs `[stub]` at info level so the stub-vs-live state is
 * observable in dev/CI. Live-mode wiring (real `stripe.accounts.create`
 * + `stripe.accountLinks.create` calls) lands as TS-090-followup-1.
 *
 * **Why stub here rather than in the route handler.** Channel-style
 * stubs (mirrors the notification email/sms/push dispatchers) keep the
 * "does the SDK call land?" decision at the I/O boundary. Route
 * handlers + the orchestrator stay shape-stable.
 */
@Injectable()
export class StripeConnectService {
  private readonly logger = new Logger(StripeConnectService.name);
  private readonly stubMode: boolean;
  private readonly stubBaseUrl: string;
  // Initialised in live mode for boot-time secret + API-version
  // validation. The actual `accounts.create` / `accountLinks.create`
  // calls are deferred to TS-090-followup-1 — the field is intentionally
  // unused-for-now and exposed via `getStripeClientForLiveSdkWiring`
  // so a regression that drops the import surfaces at compile time.
  private readonly stripeClient: Stripe | null;

  constructor(@Inject(ENV_TOKEN) env: Env) {
    this.stubMode = isStripeStubMode(env);
    this.stubBaseUrl = env.STRIPE_STUB_ONBOARDING_BASE_URL;

    if (this.stubMode || env.STRIPE_SECRET_KEY === undefined) {
      this.stripeClient = null;
    } else {
      this.stripeClient = new Stripe(env.STRIPE_SECRET_KEY, {
        apiVersion: env.STRIPE_API_VERSION as Stripe.LatestApiVersion,
        typescript: true,
      });
    }
  }

  /**
   * Accessor for the live Stripe client. Used by the TS-090-followup-1
   * implementation to make real `accounts.create` / `accountLinks.create`
   * calls. Returns null when running in stub mode.
   */
  getStripeClientForLiveSdkWiring(): Stripe | null {
    return this.stripeClient;
  }

  /**
   * Create (or — in stub mode — derive) a Stripe Connect Express
   * account for the given provider.
   *
   * **Important**: in stub mode this is deterministic on
   * `(providerId)`. The service-layer code calls this only when the
   * persistent UNIQUE constraint says no row exists for the provider,
   * so the determinism is a feature: a regression that calls this
   * twice for the same provider lands the same stub id either way.
   *
   * Live mode (TS-090-followup-1) will call
   * `stripe.accounts.create({ type: 'express', country, capabilities:
   * { transfers: { requested: true } }, metadata: { providerId } })`.
   */
  async createConnectAccount(input: CreateAccountInput): Promise<CreateAccountOutput> {
    if (this.stubMode) {
      const stubId = buildStubAccountId(input.providerId);
      this.logger.log(
        `[stub] createConnectAccount providerId=${input.providerId} stubAccountId=${stubId}`,
      );
      return {
        stripeAccountId: stubId,
        country: input.country,
        defaultCurrency: input.defaultCurrency,
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
        requirementsCurrentlyDue: ['external_account', 'tos_acceptance.date'],
        requirementsPastDue: [],
        disabledReason: null,
        liveMode: false,
      };
    }

    this.logger.warn(
      `[live-pending] createConnectAccount providerId=${input.providerId} — TS-090-followup-1 not yet shipped, returning stub-shaped account`,
    );
    const stubId = buildStubAccountId(input.providerId);
    return {
      stripeAccountId: stubId,
      country: input.country,
      defaultCurrency: input.defaultCurrency,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      requirementsCurrentlyDue: ['external_account', 'tos_acceptance.date'],
      requirementsPastDue: [],
      disabledReason: null,
      liveMode: false,
    };
  }

  /**
   * Mint a Stripe account link (`account_onboarding` or
   * `account_update`).
   *
   * Stripe-issued live links expire after ~5 minutes; the stub returns
   * a `now + 10 min` expiration so consumers can exercise the cap.
   *
   * Live mode (TS-090-followup-1) will call
   * `stripe.accountLinks.create({ account, refresh_url, return_url,
   * type })`.
   */
  async createAccountLink(input: CreateLinkInput): Promise<CreateLinkOutput> {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    if (this.stubMode) {
      const url = buildStubLinkUrl(this.stubBaseUrl, input.kind, input.stripeAccountId);
      this.logger.log(
        `[stub] createAccountLink kind=${input.kind} stripeAccountId=${input.stripeAccountId} url=${url}`,
      );
      return { url, expiresAt, liveMode: false };
    }

    this.logger.warn(
      `[live-pending] createAccountLink kind=${input.kind} stripeAccountId=${input.stripeAccountId} — TS-090-followup-1 not yet shipped`,
    );
    const url = buildStubLinkUrl(this.stubBaseUrl, input.kind, input.stripeAccountId);
    return { url, expiresAt, liveMode: false };
  }

  /** Whether the SDK is configured for live mode. Tests + the orchestrator read this. */
  isLiveMode(): boolean {
    return !this.stubMode;
  }
}

export interface CreateAccountInput {
  readonly providerId: string;
  readonly country: string;
  readonly defaultCurrency: string;
}

export interface CreateAccountOutput {
  readonly stripeAccountId: string;
  readonly country: string;
  readonly defaultCurrency: string;
  readonly chargesEnabled: boolean;
  readonly payoutsEnabled: boolean;
  readonly detailsSubmitted: boolean;
  readonly requirementsCurrentlyDue: readonly string[];
  readonly requirementsPastDue: readonly string[];
  readonly disabledReason: string | null;
  readonly liveMode: boolean;
}

export interface CreateLinkInput {
  readonly stripeAccountId: string;
  readonly kind: 'account_onboarding' | 'account_update';
  readonly refreshUrl: string;
  readonly returnUrl: string;
}

export interface CreateLinkOutput {
  readonly url: string;
  readonly expiresAt: Date;
  readonly liveMode: boolean;
}

/**
 * Build a deterministic stub Stripe account id.
 *
 * Stripe live ids are `acct_` + 16 base58 chars. The stub format is
 * `acct_stub_<providerId>` — same `acct_` prefix so the UNIQUE
 * constraint can't collide a stub with a live id, and the providerId
 * suffix keeps the determinism that's load-bearing for the idempotent
 * create path.
 *
 * `providerId` is bounded to 128 chars at the contract layer and the
 * stub-id column is bounded to 40 chars at the DB layer — too-long
 * provider ids would overflow. We truncate to 28 chars (40 - 12 prefix)
 * and append a short hash of the full provider id so the truncated id
 * remains unique-by-provider.
 */
function buildStubAccountId(providerId: string): string {
  const prefix = 'acct_stub_';
  const maxBase = 40 - prefix.length;
  if (providerId.length <= maxBase) {
    return `${prefix}${providerId}`;
  }
  // Compact hash for collisions among truncated ids. Not cryptographic
  // — only needs to differ for ids that share a prefix.
  let h = 5381;
  for (let i = 0; i < providerId.length; i++) {
    h = ((h << 5) + h + providerId.charCodeAt(i)) | 0;
  }
  const suffix = Math.abs(h).toString(36).padStart(6, '0').slice(0, 6);
  const head = providerId.slice(0, maxBase - 6 - 1);
  return `${prefix}${head}_${suffix}`;
}

function buildStubLinkUrl(baseUrl: string, kind: string, stripeAccountId: string): string {
  // URL-encode the account id; the base URL itself is operator-supplied
  // and trusted (env-validated as a real URL at boot).
  return `${baseUrl}/${kind}/${encodeURIComponent(stripeAccountId)}`;
}

export const __testing = { buildStubAccountId, buildStubLinkUrl };
