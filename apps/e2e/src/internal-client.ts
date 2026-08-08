import { FLEET, INTERNAL_API_KEY_HEADER, type FleetService } from './fleet';
import { loadRepoEnvExample } from './repo-env';

/**
 * Client for cluster-internal, shared-secret routes (TS-505c).
 *
 * **This is the one deliberate exception to "specs talk to the gateway and
 * nothing else"** (see `fleet.ts`), and the reason is the same one that lets
 * `outbox-reader.ts` read `identity.outbox_events` directly: these routes have
 * no client. They are the surface a *sibling workload* calls —
 * `worker-search-indexer` for the provider index, and the tier-snapshot
 * dispatcher for booking's read-side cache — and they are pinned behind
 * `InternalSharedSecretGuard`, deliberately not proxied by the gateway, and
 * NetworkPolicy-restricted in a cluster (TS-151). A spec calling one is
 * standing in for that workload, exactly as the outbox reader stands in for
 * service-notification.
 *
 * **Why not run the real workers instead.** For search, TS-505c's own
 * reasoning: the indexer's correctness — that it hears `provider.tier_changed`
 * and writes the right document — is a different assertion from "a tier-gated
 * booking is refused", and folding them together means an indexer bug reads as
 * a booking-gate failure. For booking's tier snapshots there is no worker at
 * all yet: the TS-142 event consumer that will hydrate them has not landed, and
 * the internal endpoint's own doc-block names ops/gateway as the Phase-1
 * caller. So the alternative to this client is not "a more realistic path", it
 * is "no coverage of the gate".
 *
 * What this client must NOT become is a shortcut around a route a client
 * *does* have. Anything a family, provider or operator can reach goes through
 * `gateway()`.
 */

export interface InternalRequestOptions {
  readonly method?: 'POST' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  /**
   * The `.env.example` key holding the shared secret this route checks.
   * Named per call rather than looked up from the service, because the two
   * services in the fleet guard their internal routes with *different*
   * secrets and silently sending the wrong one produces a 401 that looks like
   * a guard bug.
   */
  readonly secretEnvKey: string;
}

export interface InternalResponse {
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
}

/**
 * Call an internal route on a fleet member by its directory name.
 *
 * The base URL is composed from the fleet's own port table rather than from
 * `.env.example`'s `{NAME}_SERVICE_BASE_URL`: those values are what the
 * *gateway* is configured with, and a spec that read them would keep passing
 * if the fleet relocated a service and the gateway followed it.
 */
export async function internal(
  serviceDirName: string,
  path: string,
  options: InternalRequestOptions,
): Promise<InternalResponse> {
  const service = findService(serviceDirName);
  const secret = requireSecret(options.secretEnvKey);

  const headers: Record<string, string> = {
    accept: 'application/json',
    [INTERNAL_API_KEY_HEADER]: secret,
  };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  const response = await fetch(`http://127.0.0.1:${String(service.port)}${path}`, {
    method: options.method ?? 'POST',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });

  const text = await response.text();
  let body: unknown;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }
  return { status: response.status, body, text };
}

/** Throw unless the internal call returned `expected`, naming the surface. */
export function expectInternalStatus(
  response: InternalResponse,
  expected: number,
  surface: string,
): void {
  if (response.status !== expected) {
    throw new Error(
      `${surface} returned ${String(response.status)}, expected ${String(expected)}: ${response.text.slice(0, 800)}`,
    );
  }
}

function findService(dir: string): FleetService {
  const service = FLEET.find((entry) => entry.dir === dir);
  if (service === undefined) {
    throw new Error(
      `${dir} is not in FLEET — an internal call to a service the suite does not start ` +
        `would fail as a connection error, which reads as a bug in the route.`,
    );
  }
  return service;
}

let cachedEnv: Record<string, string> | undefined;

function requireSecret(key: string): string {
  cachedEnv ??= loadRepoEnvExample();
  const value = cachedEnv[key];
  if (value === undefined || value === '') {
    throw new Error(`${key} is missing from .env.example — the internal route cannot be called.`);
  }
  return value;
}
