import { isAdminRoleName, type RequestContext } from '@taste-and-see/auth-sdk';
import {
  AUDIT_EVENT_ACTOR_ROLE_MAX_LENGTH,
  AUDIT_EVENT_REQUEST_ID_MAX_LENGTH,
  AUDIT_EVENT_TRACE_ID_MAX_LENGTH,
  AUDIT_EVENT_USER_AGENT_MAX_LENGTH,
  type AuditEventActorScopeType,
} from '@taste-and-see/contracts';

/**
 * Admin-mutation audit actor context (TS-303b-followup-1; CLAUDE.md §3.6,
 * §3.2).
 *
 * The actor + request metadata an admin-mutation controller hands its service
 * so the service can stamp an `audit.action_recorded` event — actor, role,
 * scope, IP, UA, request id on every admin mutation.
 *
 * **The actor identity comes from the VERIFIED token, never the request
 * body.** That is the whole point of building it here rather than letting a
 * caller assemble one: an audit row whose actor is body-supplied proves
 * nothing, because the thing it attributes the action to is the thing under
 * the actor's control.
 *
 * Extracted verbatim from the three byte-identical copies that had
 * accumulated in service-ads (TS-2xx), service-content (TS-284), and
 * service-trust-safety (TS-303b). The rule of three was met the moment the
 * third landed; this is the same extraction TS-302b did for the PagerDuty
 * client.
 */
export interface AuditActorContext {
  readonly actorUserId: string;
  readonly actorRole: string | null;
  readonly actorTenantScopeType: AuditEventActorScopeType;
  readonly actorTenantScopeId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
  readonly traceId: string | null;
}

/**
 * The actor for a mutation NO PERSON performed — an expiry sweep, a detector,
 * a scheduled job.
 *
 * Modelled as its own type rather than by loosening `actorUserId` to
 * `string | null`, because the `audit.action_recorded` contract permits a null
 * actor **only** under the `system` scope: a human-scoped row with no actor id
 * would be an audit entry attributing an action to nobody, which is exactly
 * what an audit log must not be able to say. Pinning both fields as literals
 * makes that pairing a type-level fact rather than a convention.
 *
 * Added by TS-309a-followup-3, when service-identity's local RBAC emitter —
 * which had carried its own nullable-actor shape since TS-295 — folded onto
 * this package. Its expiry sweep is the first job-driven auditable mutation on
 * the platform, and it will not be the last.
 */
export interface AuditSystemActorContext {
  readonly actorUserId: null;
  readonly actorRole: null;
  readonly actorTenantScopeType: 'system';
  readonly actorTenantScopeId: null;
  readonly ip: null;
  readonly userAgent: null;
  readonly requestId: null;
  readonly traceId: null;
}

/** The one value of {@link AuditSystemActorContext} — there is nothing to vary. */
export const SYSTEM_AUDIT_ACTOR: AuditSystemActorContext = Object.freeze({
  actorUserId: null,
  actorRole: null,
  actorTenantScopeType: 'system',
  actorTenantScopeId: null,
  ip: null,
  userAgent: null,
  requestId: null,
  traceId: null,
});

/** Either kind of actor an audit event may name. */
export type AuditActor = AuditActorContext | AuditSystemActorContext;

/**
 * The minimal request surface `buildAuditActorContext` reads — structurally a
 * subset of the Express `Request` (`RequestWithContext` satisfies it),
 * declared locally so the builder is unit-testable with a plain object.
 */
export interface AuditRequestLike {
  readonly ip?: string | undefined;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

const IP_MAX_LENGTH = 45;

/**
 * Build the {@link AuditActorContext} from the verified request context + the
 * raw request. Pure aside from reading the passed request — no I/O.
 */
export function buildAuditActorContext(
  ctx: RequestContext,
  request: AuditRequestLike,
): AuditActorContext {
  const scope = mapTenantScope(ctx);
  return {
    actorUserId: ctx.userId,
    actorRole: deriveActorRole(ctx),
    actorTenantScopeType: scope.type,
    actorTenantScopeId: scope.id,
    ip: boundedNonEmpty(request.ip, IP_MAX_LENGTH),
    userAgent: boundedNonEmpty(header(request, 'user-agent'), AUDIT_EVENT_USER_AGENT_MAX_LENGTH),
    requestId: boundedNonEmpty(header(request, 'x-request-id'), AUDIT_EVENT_REQUEST_ID_MAX_LENGTH),
    traceId: parseTraceId(header(request, 'traceparent')),
  };
}

/** Pick the admin-staff role (preferred), else the first role, else null. */
function deriveActorRole(ctx: RequestContext): string | null {
  const adminRole = ctx.roles.find((r) => isAdminRoleName(r.name));
  const name = adminRole?.name ?? ctx.roles[0]?.name;
  return name === undefined ? null : name.slice(0, AUDIT_EVENT_ACTOR_ROLE_MAX_LENGTH);
}

/** Map the auth-sdk `TenantScope` union onto the audit actor-scope columns. */
function mapTenantScope(ctx: RequestContext): {
  readonly type: AuditEventActorScopeType;
  readonly id: string | null;
} {
  const scope = ctx.tenantScope;
  switch (scope.type) {
    case 'global':
      return { type: 'global', id: null };
    case 'tenant':
      return { type: 'tenant', id: scope.tenantId };
    case 'household':
      return { type: 'household', id: scope.householdId };
  }
}

/** First value of a (possibly multi-valued) header, or undefined. */
function header(request: AuditRequestLike, name: string): string | undefined {
  const value = request.headers[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : (value as string);
}

/** Trim + bound a maybe-string; null when absent or blank. */
function boundedNonEmpty(value: string | undefined, max: number): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, max);
}

/**
 * Extract the 32-hex trace id from a W3C `traceparent`
 * (`version-traceid-spanid-flags`). Null when the header is absent or
 * malformed — audit trace correlation is best-effort.
 */
function parseTraceId(traceparent: string | undefined): string | null {
  if (traceparent === undefined) return null;
  const segments = traceparent.trim().split('-');
  const traceId = segments[1];
  if (traceId === undefined || !/^[0-9a-f]{32}$/i.test(traceId)) return null;
  return traceId.slice(0, AUDIT_EVENT_TRACE_ID_MAX_LENGTH);
}
