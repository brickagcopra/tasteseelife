// Thread posting / moderation policy — see PRD §7.7 ("Provider
// community: Peer messaging (moderated) · Best-practice forums") and
// CLAUDE.md §12 ("hospitality, not clinical" — the community surface is
// a warm professional space, moderated for safety, never punitive by
// default).
//
// TS-209 introduces the `peer_thread` thread kind (provider-to-provider
// community / best-practice forums) and the `moderator` participant role
// (trust-safety / provider-ops staff who join a peer thread to keep the
// space safe and who will action the moderation queue once
// `service-trust-safety` lands — TS-300 / TS-209-followup-1).
//
// This module is the single source of truth for the two finite string
// unions (`ThreadKind`, `ThreadParticipantRole`) plus the *pure*
// posting-permission matrix. It is deliberately persistence-free and
// transport-free so it can be consumed identically from:
//
//   - the realtime gateway's (future) `message:send` handler — the
//     publish-time gate that today's TS-071 read-only delivery defers
//     (TS-209-followup-3, blocked on the Cassandra body store
//     TS-070-followup-1); and
//   - any HTTP message-create surface that lands later.
//
// Why a table, not a switch? A `Record<ThreadKind, Record<Role, …>>`
// literal is exhaustive *by construction* — the compiler rejects the
// file if a kind or role is added to a union without a matching matrix
// entry — and it reads as the permission grid that PRD §7.7 describes.
// No `assertNever` ceremony, no fall-through default that could silently
// grant or deny a newly-added role.

/**
 * Thread origin kinds (mirrors `messaging.thread_kind` in
 * `prisma/schema.prisma`). Kept as a hand-maintained const union rather
 * than imported from `@prisma/client` for the same reason the rest of
 * service-messaging does (the Prisma enum value-side does not resolve
 * cleanly under our `isolatedModules` tsconfig — see TS-021-followup-3);
 * the migration + a Prisma round-trip are the drift guard.
 */
export const THREAD_KINDS = ['household', 'booking', 'concierge', 'peer_thread'] as const;
export type ThreadKind = (typeof THREAD_KINDS)[number];

/**
 * Thread-participant roles (mirrors `messaging.thread_participant_role`).
 *
 *   - `member`    — full read + write (senior, primary payer, provider
 *                   on a booking thread, **provider on a peer thread**).
 *   - `observer`  — read-only (family observer; remote adult child).
 *   - `concierge` — concierge staff on a Tier-3 thread.
 *   - `moderator` — trust-safety / provider-ops staff on a peer thread
 *                   (TS-209). May post (to intervene) and moderate.
 */
export const THREAD_PARTICIPANT_ROLES = ['member', 'observer', 'concierge', 'moderator'] as const;
export type ThreadParticipantRole = (typeof THREAD_PARTICIPANT_ROLES)[number];

/**
 * Who may **post** a message, per thread kind.
 *
 * Peer threads (`peer_thread`): providers (`member`) and staff
 * moderators post; observers are read-only; concierge has no standing in
 * a provider-only space.
 *
 * The three pre-TS-209 kinds keep their TS-070 semantics unchanged:
 * members + concierge post, observers are read-only. `moderator` has no
 * standing outside peer threads in Phase 1 (a peer-only role), so it is
 * `false` there — defence-in-depth against a moderator membership row
 * being mis-created on a family thread.
 */
const POSTING_MATRIX: Record<ThreadKind, Record<ThreadParticipantRole, boolean>> = {
  household: { member: true, observer: false, concierge: true, moderator: false },
  booking: { member: true, observer: false, concierge: true, moderator: false },
  concierge: { member: true, observer: false, concierge: true, moderator: false },
  peer_thread: { member: true, observer: false, concierge: false, moderator: true },
};

/**
 * Who may **moderate** (hide / flag a message, surface it to the
 * trust-safety queue), per thread kind. Phase 1: only a `moderator` on a
 * `peer_thread`. The flagged-message → `service-trust-safety` routing
 * itself is TS-209-followup-1 (blocked on TS-300); this predicate is the
 * authorization half of that gate and is wired forward now.
 */
const MODERATION_MATRIX: Record<ThreadKind, Record<ThreadParticipantRole, boolean>> = {
  household: { member: false, observer: false, concierge: false, moderator: false },
  booking: { member: false, observer: false, concierge: false, moderator: false },
  concierge: { member: false, observer: false, concierge: false, moderator: false },
  peer_thread: { member: false, observer: false, concierge: false, moderator: true },
};

/**
 * `true` when a participant holding `role` may post a message into a
 * thread of `kind`. Pure — no I/O, no clock, no tenant context.
 */
export function canPostInThread(kind: ThreadKind, role: ThreadParticipantRole): boolean {
  return POSTING_MATRIX[kind][role];
}

/**
 * `true` when a participant holding `role` may take a moderation action
 * (hide / flag / escalate) in a thread of `kind`. Pure.
 */
export function canModerateThread(kind: ThreadKind, role: ThreadParticipantRole): boolean {
  return MODERATION_MATRIX[kind][role];
}
