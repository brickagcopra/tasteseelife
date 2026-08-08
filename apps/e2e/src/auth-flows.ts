import {
  IDENTITY_EMAIL_VERIFICATION_REQUESTED,
  IdentityEmailVerificationRequestedSchema,
  LoginResponseSchema,
  SignupResponseSchema,
  VerifyEmailResponseSchema,
  type SignupResponse,
} from '@taste-and-see/contracts';

import { gateway, type GatewayResponse } from './gateway-client';
import { waitForOutboxEvent } from './outbox-reader';
import { uniqueEmail } from './actors';

/**
 * Composite auth flows every later spec starts from (TS-505).
 *
 * A spec about bookings should not restate the four steps it takes to obtain a
 * session; it should say `registerVerifiedUser()` and get on with the booking.
 * These helpers therefore assert their own steps and throw on anything
 * unexpected, so a failure in a prerequisite reads as "signup broke", not as a
 * confusing 401 three assertions later in an unrelated spec.
 */

export const DEFAULT_PASSWORD = 'correct-horse-battery-staple';

export interface RegisteredUser {
  readonly userId: string;
  readonly email: string;
  readonly password: string;
  readonly accessToken: string;
  readonly refreshToken: string;
}

/** `POST /auth/signup`, asserting 201 and returning the created account. */
export async function signUp(
  email: string,
  password: string = DEFAULT_PASSWORD,
): Promise<SignupResponse> {
  const response = await gateway('/api/v1/auth/signup', {
    method: 'POST',
    body: { email, password },
  });
  expectStatus(response, 201, 'signup');
  return SignupResponseSchema.parse(response.body);
}

/**
 * Read the verification token out of the delivery event and spend it.
 *
 * The suite reads `identity.email_verification_requested` because that event is
 * the *only* place the raw token exists after the signup response — the table
 * holds a SHA-256 digest by design (TS-510). Standing in for the
 * `service-notification` consumer that will render the email is the closest a
 * test can get to being the user who clicks the link, and it means the token's
 * event payload is contract-checked on every run.
 */
export async function verifyEmail(userId: string): Promise<void> {
  const event = await waitForOutboxEvent(
    IDENTITY_EMAIL_VERIFICATION_REQUESTED,
    (payload) => payload['userId'] === userId,
  );
  const delivery = IdentityEmailVerificationRequestedSchema.parse(event.payload);

  const response = await gateway('/api/v1/auth/verify-email', {
    method: 'POST',
    body: { token: delivery.token },
  });
  expectStatus(response, 200, 'verify-email');

  const verified = VerifyEmailResponseSchema.parse(response.body);
  if (verified.status !== 'active') {
    throw new Error(`verify-email left the account ${verified.status}, expected active`);
  }
}

/** `POST /auth/login`, asserting a session (not an MFA challenge) came back. */
export async function login(
  email: string,
  password: string = DEFAULT_PASSWORD,
): Promise<{
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly userId: string;
}> {
  const response = await gateway('/api/v1/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  expectStatus(response, 200, 'login');

  const parsed = LoginResponseSchema.parse(response.body);
  if (parsed.outcome !== 'session') {
    throw new Error('login returned an MFA challenge; this account has no confirmed factor');
  }

  const refreshToken = readRefreshCookie(response);
  return { accessToken: parsed.accessToken, refreshToken, userId: parsed.user.id };
}

/**
 * The full onboarding sequence: sign up → verify → log in.
 *
 * This is what "a user exists" means on this platform, and it is four HTTP
 * calls across two services rather than one insert — which is precisely why
 * every later spec should go through here rather than reaching for a fixture.
 */
export async function registerVerifiedUser(
  label = 'user',
  password: string = DEFAULT_PASSWORD,
): Promise<RegisteredUser> {
  const email = uniqueEmail(label);
  const created = await signUp(email, password);
  await verifyEmail(created.id);
  const session = await login(email, password);

  return {
    userId: created.id,
    email,
    password,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
  };
}

function readRefreshCookie(response: GatewayResponse): string {
  const raw = response.headers.getSetCookie().find((line) => line.startsWith('tns_refresh='));
  if (raw === undefined) {
    throw new Error('login did not set a refresh cookie');
  }
  const value = raw.slice('tns_refresh='.length).split(';')[0] ?? '';
  if (value === '') {
    throw new Error('login set an empty refresh cookie');
  }
  return decodeURIComponent(value);
}

function expectStatus(response: GatewayResponse, expected: number, surface: string): void {
  if (response.status !== expected) {
    throw new Error(
      `${surface} returned ${String(response.status)}, expected ${String(expected)}: ${response.text.slice(0, 800)}`,
    );
  }
}
