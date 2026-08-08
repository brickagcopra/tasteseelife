import { TenantContextStore } from './context-store';

/**
 * Length cap on the `reason` string to prevent log injection / unbounded
 * memory growth. 200 chars is generous for a "what's running" label.
 */
const MAX_REASON_LENGTH = 200;

/**
 * Explicitly run `fn` outside a request-bound tenant context. The
 * extension treats the resulting frame as `exempt` and lets every
 * Prisma operation through (with an audit-log line when enforcement is
 * `audit`).
 *
 * Intended callers:
 *
 *   - Boot-time seeds (`seedRbacCatalog`, `seedPlanCatalog`, etc.).
 *     These run once at deploy time on behalf of the system, not a
 *     request.
 *
 *   - Background workers (BullMQ janitor jobs, the outbox relay's
 *     producer-side append-as-system path).
 *
 *   - Migration scripts.
 *
 *   - Cross-service integration tests that own their data setup.
 *
 * The `reason` is mandatory + bounded so a log scan can trace back
 * which infrastructure path bypassed the gate. The store keeps it on
 * the frame; the extension surfaces it in its warn-level log line.
 *
 * The function is generic over `T` so both sync and async callbacks
 * compose naturally — the return type is exactly what the callback
 * returns (including promises).
 *
 * @throws if `reason` is empty or > 200 chars. The check is at the
 *   boundary so a caller can't accidentally bypass the SDK's
 *   bookkeeping with an empty marker.
 */
export function runWithoutTenantContext<T>(
  store: TenantContextStore,
  reason: string,
  fn: () => T,
): T {
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new RangeError(
      `runWithoutTenantContext: reason must be a non-empty string (CLAUDE.md §3.2 — every exempt scope must declare why).`,
    );
  }
  if (reason.length > MAX_REASON_LENGTH) {
    throw new RangeError(
      `runWithoutTenantContext: reason length ${reason.length} exceeds the ${MAX_REASON_LENGTH}-char cap.`,
    );
  }
  return store.run({ kind: 'exempt', reason }, fn);
}

/**
 * Re-export for consumers that want to compose their own auditable
 * exempt wrappers (e.g. a `runAsSystem(fn)` helper in a worker app).
 */
export const RUN_WITHOUT_TENANT_CONTEXT_MAX_REASON_LENGTH = MAX_REASON_LENGTH;
