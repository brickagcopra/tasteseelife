import { z } from 'zod';

/**
 * Thread + thread-participant HTTP DTOs (TS-070-followup-2; PRD §6.7
 * "Messaging"; PDD §8.2 + §13.1).
 *
 * These shape the authenticated CRUD surface `service-messaging` exposes
 * over the `messaging.threads` + `messaging.thread_participants` Postgres
 * metadata tables (TS-070):
 *
 *   POST   /api/v1/threads                       — create a thread, seeding
 *                                                  the creator + any extra
 *                                                  participants.
 *   GET    /api/v1/threads/me                     — the caller's inbox (every
 *                                                  thread they participate in,
 *                                                  newest membership first).
 *   GET    /api/v1/threads/:threadId              — thread detail with the full
 *                                                  participant list (caller
 *                                                  must be a participant).
 *   POST   /api/v1/threads/:threadId/participants — add a participant.
 *   DELETE /api/v1/threads/:threadId/participants/:userId — remove a participant.
 *
 * **The trust gate is participation.** Every read and write is row-scoped
 * by the caller's own `thread_participants` row (CLAUDE.md §3.2 — row-level
 * checks on every read). A user with a valid access token but no membership
 * row gets a 404 (no thread existence leak), not the thread. Membership
 * mutations additionally require the caller to hold a *posting* role for the
 * thread kind (a read-only `observer` cannot change the roster — CLAUDE.md
 * §12 family-observability boundaries); the authoritative grid lives in
 * `service-messaging/src/realtime/thread-posting-policy.ts`.
 *
 * **Message bodies are out of scope here.** This surface owns thread
 * *metadata* + *membership* only. The Cassandra-backed message body store
 * (`messaging.messages_by_thread`, PDD §8.3) is the sibling TS-070-followup-1;
 * the auto-provisioning of threads from `booking.created` / `household.created`
 * events is TS-070-followup-3.
 *
 * **Cross-service ids are free TEXT.** `householdId` / `bookingId` / `userId`
 * are soft references into other service schemas — never a foreign key
 * (CLAUDE.md §2.3). The producer service is the source of truth.
 *
 * **`.strict()` everywhere** — a typo in a field name is a 400, not a
 * silently-dropped knob (CLAUDE.md §3.3).
 */

// ─── Bounded length / pagination constants ──────────────────────────────

/** CUID/CUID2-shaped thread-row id cap. */
export const THREAD_ID_MAX_LENGTH = 64;

/** Soft-FK household id cap — matches `household.households.id`. */
export const THREAD_HOUSEHOLD_ID_MAX_LENGTH = 64;

/** Soft-FK booking id cap — matches `booking.bookings.id`. */
export const THREAD_BOOKING_ID_MAX_LENGTH = 64;

/** Soft-FK user id cap — matches `identity.users.id`. */
export const THREAD_USER_ID_MAX_LENGTH = 64;

/**
 * `last_read_message_id` cap. The column holds the Cassandra
 * `messages_by_thread` TimeUUID cursor (PDD §8.3) once the body store
 * lands (TS-070-followup-1); a TimeUUID string is 36 chars, so 64 is a
 * comfortable bound.
 */
export const THREAD_LAST_READ_MESSAGE_ID_MAX_LENGTH = 64;

/**
 * Maximum number of extra participants accepted in a single create body.
 * A family / booking / concierge thread has a handful of participants; the
 * cap guards against an unbounded `createMany` payload. The creator is
 * added implicitly and does not count against this cap.
 */
export const THREAD_CREATE_PARTICIPANTS_MAX = 100;

/** Inbox pagination caps. Bounded `limit`, no cursor in Phase 1 (carved follow-up). */
export const THREAD_INBOX_LIMIT_DEFAULT = 50;
export const THREAD_INBOX_LIMIT_MAX = 200;

// ─── Field schemas ──────────────────────────────────────────────────────

const ThreadIdSchema = z.string().min(1).max(THREAD_ID_MAX_LENGTH);
const HouseholdIdSchema = z.string().min(1).max(THREAD_HOUSEHOLD_ID_MAX_LENGTH);
const BookingIdSchema = z.string().min(1).max(THREAD_BOOKING_ID_MAX_LENGTH);
const UserIdSchema = z.string().min(1).max(THREAD_USER_ID_MAX_LENGTH);
const LastReadMessageIdSchema = z.string().min(1).max(THREAD_LAST_READ_MESSAGE_ID_MAX_LENGTH);

/**
 * Thread origin kind. Mirrors `messaging.thread_kind` in the Prisma schema
 * and the `THREAD_KINDS` union in `thread-posting-policy.ts`.
 *
 *   - `household`   — household-wide "family chat" thread.
 *   - `booking`     — a thread scoped to a single booking.
 *   - `concierge`   — a Tier-3 Concierge thread (PRD §6.6).
 *   - `peer_thread` — provider-to-provider community thread (PRD §7.7).
 */
export const ThreadKindSchema = z.enum(['household', 'booking', 'concierge', 'peer_thread']);
export type ThreadKind = z.infer<typeof ThreadKindSchema>;

/**
 * Thread-participant role. Mirrors `messaging.thread_participant_role`.
 *
 *   - `member`    — full read + write.
 *   - `observer`  — read-only (family observer; remote adult child).
 *   - `concierge` — concierge staff on a Tier-3 thread.
 *   - `moderator` — trust-safety / provider-ops staff on a peer thread.
 */
export const ThreadParticipantRoleSchema = z.enum(['member', 'observer', 'concierge', 'moderator']);
export type ThreadParticipantRole = z.infer<typeof ThreadParticipantRoleSchema>;

// ─── Record / response shapes ───────────────────────────────────────────

/**
 * One participant membership row. `lastReadMessageId` is the read-receipt
 * cursor into the Cassandra message partition — null until the participant
 * has read at least one message (PDD §8.3).
 */
export const ThreadParticipantRecordSchema = z
  .object({
    threadId: ThreadIdSchema,
    userId: UserIdSchema,
    role: ThreadParticipantRoleSchema,
    joinedAt: z.string().datetime({ offset: true }),
    lastReadMessageId: LastReadMessageIdSchema.nullable(),
  })
  .strict();
export type ThreadParticipantRecord = z.infer<typeof ThreadParticipantRecordSchema>;

/**
 * Base thread metadata shape (shared between the bare record + the
 * participant-bearing detail record). Defined as a plain object so the
 * detail + inbox shapes can `.extend(...)` it before sealing with
 * `.strict()`.
 */
const threadRecordShape = {
  id: ThreadIdSchema,
  kind: ThreadKindSchema,
  /** Set on `household` / `concierge` (and optionally `booking`); null on `peer_thread`. */
  householdId: HouseholdIdSchema.nullable(),
  /** Set only on `kind = booking`; null otherwise. */
  bookingId: BookingIdSchema.nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  /** Soft-archive timestamp; null means active. */
  archivedAt: z.string().datetime({ offset: true }).nullable(),
} as const;

/** Bare thread metadata record (no participant list). */
export const ThreadRecordSchema = z.object(threadRecordShape).strict();
export type ThreadRecord = z.infer<typeof ThreadRecordSchema>;

/** Thread metadata plus its full participant list (the detail read). */
export const ThreadWithParticipantsRecordSchema = z
  .object({
    ...threadRecordShape,
    participants: z.array(ThreadParticipantRecordSchema),
  })
  .strict();
export type ThreadWithParticipantsRecord = z.infer<typeof ThreadWithParticipantsRecordSchema>;

/**
 * One inbox entry: the thread metadata plus the *caller's own* membership
 * facets (role + read cursor) and a participant count — enough to render a
 * conversation list row without a second round-trip.
 */
export const ThreadInboxEntrySchema = z
  .object({
    ...threadRecordShape,
    /** The caller's role in this thread. */
    myRole: ThreadParticipantRoleSchema,
    /** The caller's read-receipt cursor (null until they've read a message). */
    myLastReadMessageId: LastReadMessageIdSchema.nullable(),
    /** Total participants in the thread. */
    participantCount: z.number().int().nonnegative(),
  })
  .strict();
export type ThreadInboxEntry = z.infer<typeof ThreadInboxEntrySchema>;

// ─── Request shapes ─────────────────────────────────────────────────────

/**
 * A seeded participant in the create body, or the body of the add-participant
 * endpoint. `{ userId, role }`.
 */
export const ThreadParticipantSeedSchema = z
  .object({
    userId: UserIdSchema,
    role: ThreadParticipantRoleSchema,
  })
  .strict();
export type ThreadParticipantSeed = z.infer<typeof ThreadParticipantSeedSchema>;

/**
 * `POST /api/v1/threads` body. Creates a thread of `kind`, seeding the
 * supplied `participants` (the authenticated creator is added implicitly as
 * a `member` if not named, so they can immediately read the thread they
 * created).
 *
 * **Per-kind id invariant** (enforced by the `superRefine`):
 *   - `booking`     → `bookingId` required (`householdId` optional hint).
 *   - `household`   → `householdId` required, `bookingId` forbidden.
 *   - `concierge`   → `householdId` required, `bookingId` forbidden.
 *   - `peer_thread` → both forbidden.
 *
 * Seeded participant `userId`s must be unique.
 */
export const CreateThreadRequestSchema = z
  .object({
    kind: ThreadKindSchema,
    householdId: HouseholdIdSchema.optional(),
    bookingId: BookingIdSchema.optional(),
    participants: z
      .array(ThreadParticipantSeedSchema)
      .max(THREAD_CREATE_PARTICIPANTS_MAX)
      .default([]),
  })
  .strict()
  .superRefine((req, ctx) => {
    const requireHousehold = (): void => {
      if (req.householdId === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['householdId'],
          message: `householdId is required for a ${req.kind} thread`,
        });
      }
    };
    const forbidBooking = (): void => {
      if (req.bookingId !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['bookingId'],
          message: `bookingId is not allowed on a ${req.kind} thread`,
        });
      }
    };
    const forbidHousehold = (): void => {
      if (req.householdId !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['householdId'],
          message: 'householdId is not allowed on a peer_thread',
        });
      }
    };

    switch (req.kind) {
      case 'booking':
        if (req.bookingId === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['bookingId'],
            message: 'bookingId is required for a booking thread',
          });
        }
        break;
      case 'household':
      case 'concierge':
        requireHousehold();
        forbidBooking();
        break;
      case 'peer_thread':
        forbidHousehold();
        forbidBooking();
        break;
    }

    const userIds = req.participants.map((p) => p.userId);
    if (new Set(userIds).size !== userIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['participants'],
        message: 'participant userIds must be unique',
      });
    }
  });
export type CreateThreadRequest = z.infer<typeof CreateThreadRequestSchema>;

/** `POST /api/v1/threads` response — the created thread with its seeded participants. */
export const CreateThreadResponseSchema = z
  .object({
    thread: ThreadWithParticipantsRecordSchema,
  })
  .strict();
export type CreateThreadResponse = z.infer<typeof CreateThreadResponseSchema>;

/**
 * `GET /api/v1/threads/me` query. Bounded `limit`; `includeArchived` opts the
 * soft-archived threads back into the result (default excludes them, mirroring
 * the family-portal default view).
 */
export const ListThreadsInboxQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(THREAD_INBOX_LIMIT_MAX)
      .default(THREAD_INBOX_LIMIT_DEFAULT),
    includeArchived: z
      .union([z.literal('true'), z.literal('false')])
      .transform((value) => value === 'true')
      .optional(),
  })
  .strict();
export type ListThreadsInboxQuery = z.infer<typeof ListThreadsInboxQuerySchema>;

/** `GET /api/v1/threads/me` response — the caller's threads, newest membership first. */
export const ThreadsInboxResponseSchema = z
  .object({
    threads: z.array(ThreadInboxEntrySchema),
  })
  .strict();
export type ThreadsInboxResponse = z.infer<typeof ThreadsInboxResponseSchema>;

/** `GET /api/v1/threads/:threadId` response — full detail with participants. */
export const ThreadDetailResponseSchema = z
  .object({
    thread: ThreadWithParticipantsRecordSchema,
  })
  .strict();
export type ThreadDetailResponse = z.infer<typeof ThreadDetailResponseSchema>;

/** `POST /api/v1/threads/:threadId/participants` body — `{ userId, role }`. */
export const AddThreadParticipantRequestSchema = ThreadParticipantSeedSchema;
export type AddThreadParticipantRequest = z.infer<typeof AddThreadParticipantRequestSchema>;

/**
 * `POST /api/v1/threads/:threadId/participants` response. Idempotent on the
 * roster:
 *   - `added`          — a new membership row was inserted.
 *   - `already_present`— the user was already a participant (role left
 *     unchanged — a re-add never silently mutates an existing role; remove +
 *     re-add to change a role).
 */
export const AddThreadParticipantResponseSchema = z
  .object({
    participant: ThreadParticipantRecordSchema,
    outcome: z.enum(['added', 'already_present']),
  })
  .strict();
export type AddThreadParticipantResponse = z.infer<typeof AddThreadParticipantResponseSchema>;

/**
 * `DELETE /api/v1/threads/:threadId/participants/:userId` response. Idempotent:
 *   - `removed`     — the membership row was deleted by this call.
 *   - `not_present` — the user was not a participant (replay / no-op).
 */
export const RemoveThreadParticipantResponseSchema = z
  .object({
    outcome: z.enum(['removed', 'not_present']),
    threadId: ThreadIdSchema,
    userId: UserIdSchema,
  })
  .strict();
export type RemoveThreadParticipantResponse = z.infer<typeof RemoveThreadParticipantResponseSchema>;
