import type { ServerClient } from 'postmark';

/**
 * `POSTMARK_CLIENT_TOKEN` — DI token for the (mockable) Postmark SDK client
 * (TS-073-followup-1).
 *
 * Mirrors `STRIPE_SDK_TOKEN` in service-subscription: the SDK is constructed
 * once by the module factory and injected, so unit tests supply a fake and
 * never open a socket.
 *
 * **The provided value is `null` when `POSTMARK_SERVER_TOKEN` is unset**, and
 * that null IS the stub-mode signal. Deriving stub mode from the env var at
 * the call site instead would let the two disagree — a token present but a
 * client that failed to construct is exactly the state that must not read as
 * "stub mode, all good".
 */
export const POSTMARK_CLIENT_TOKEN = Symbol.for('@taste-and-see/service-notification:postmark-sdk');

/**
 * The narrow slice of the Postmark `ServerClient` surface this service uses.
 * Typing the injection to a structural subset rather than the whole class
 * keeps the test fake honest (it cannot accidentally satisfy the type by
 * being `any`) and documents that nothing here touches templates, bounces, or
 * the account API.
 */
export type PostmarkEmailClient = Pick<ServerClient, 'sendEmail'>;
