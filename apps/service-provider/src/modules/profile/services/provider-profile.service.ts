import { Injectable, Logger } from '@nestjs/common';
import {
  PROVIDER_PROFILE_TAG_KIND_CUISINE,
  PROVIDER_PROFILE_TAG_KIND_DIETARY_EXPERTISE,
  PROVIDER_PROFILE_TAG_KIND_LANGUAGE,
  PROVIDER_PROFILE_UPDATED,
  type ProviderProfileChangeKind,
  type ProviderProfileTagKind,
} from '@taste-and-see/contracts';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';

import { err, ok, type Result } from './result';

/**
 * Local mirror of the Prisma-generated `providers` row, narrowed to
 * the columns the profile module reads / writes. Same
 * TS-021-followup-2 / TS-021-followup-3 rationale documented across
 * the rest of the codebase — Prisma's row types resolve inconsistently
 * under our tsconfig so we project shapes by hand.
 */
export interface ProviderRow {
  readonly id: string;
  readonly userId: string;
  readonly status: 'pending' | 'in_review' | 'active' | 'suspended' | 'archived';
  readonly tier: 'basic' | 'certified' | 'elite';
  readonly displayName: string;
  readonly headline: string | null;
  readonly bio: string | null;
  readonly profilePhotoKey: string | null;
  readonly videoIntroKey: string | null;
  readonly timeZone: string;
  readonly dementiaSensitive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

/**
 * Profile-tag row shape — one row per (provider, kind, tag) triple
 * in `provider_profile_tags`.
 */
export interface ProviderProfileTagRow {
  readonly providerId: string;
  readonly kind: ProviderProfileTagKind;
  readonly tag: string;
}

/**
 * Materialised profile shape — the `providers` row plus the
 * partitioned tag arrays. The controller projects this to the
 * `ProviderProfileRecord` DTO before returning.
 */
export interface ProviderProfileSnapshot {
  readonly row: ProviderRow;
  readonly languages: readonly string[];
  readonly cuisines: readonly string[];
  readonly dietaryExpertise: readonly string[];
}

export interface UpdateProfileInput {
  /** Authoritative provider row id — set from the route param. */
  readonly providerId: string;
  /** The authenticated user attempting the edit. */
  readonly actorUserId: string;
  readonly bio: string | null;
  readonly languages: readonly string[];
  readonly cuisines: readonly string[];
  readonly dietaryExpertise: readonly string[];
  readonly dementiaSensitive: boolean;
  /**
   * Optional optimistic-concurrency precondition (TS-200-followup-5).
   * When set, the service refuses the update unless the row's current
   * `updatedAt` matches this value. The controller parses the
   * `If-Match` HTTP header into this field. `undefined` skips the
   * precondition check — preserves backward-compatibility for any
   * client that hasn't yet adopted the If-Match convention.
   */
  readonly ifMatchUpdatedAt?: Date | undefined;
}

export type ProviderProfileFailure =
  | { readonly reason: 'invalid_request'; readonly message: string }
  | { readonly reason: 'not_found'; readonly providerId: string }
  | { readonly reason: 'forbidden'; readonly providerId: string }
  | {
      readonly reason: 'precondition_failed';
      readonly providerId: string;
      /** The row's actual `updated_at` at read time (the server's truth). */
      readonly currentUpdatedAt: Date;
    }
  | {
      readonly reason: 'outbox_validation_failed';
      readonly eventName: string;
      readonly message: string;
    };

/**
 * Internal exception thrown inside `prisma.$transaction` when the
 * outbox SDK rejects the payload. Caught by the outer service so the
 * surrounding transaction rolls back atomically and we surface a
 * typed failure rather than a 500. Same shape as
 * `ProviderCertificationsService.OutboxValidationFailedError`.
 */
class OutboxValidationFailedError extends Error {
  constructor(
    public readonly eventName: string,
    public readonly issues: ReadonlyArray<{
      readonly path: ReadonlyArray<string | number>;
      readonly message: string;
    }>,
  ) {
    super(`outbox.append validation failed for ${eventName}`);
    this.name = 'OutboxValidationFailedError';
  }
}

/**
 * `ProviderProfileService` — the self-service profile-edit surface
 * (TS-200).
 *
 * Two surfaces:
 *
 *   - `getProfile(providerId)` — returns the materialised snapshot
 *     (row + tag partitions). Used by:
 *       - `GET /api/v1/providers/:providerId/profile` (TS-200-
 *         followup-4 — the by-id read surface; the controller
 *         layer treats `null` and soft-deleted rows as 404).
 *       - the PUT's response composition.
 *
 *   - `updateProfile({ providerId, actorUserId, bio, languages,
 *     cuisines, dietaryExpertise, dementiaSensitive })` — the write
 *     path. Inside one Prisma transaction:
 *       1. Loads the provider row (404 if missing).
 *       2. Verifies the row's `user_id` matches `actorUserId` (403 if
 *          not — admin override is TS-200-followup-1).
 *       3. UPDATEs `providers.bio` + `providers.dementia_sensitive`.
 *       4. DELETEs every existing `provider_profile_tags` row for the
 *          three kinds in scope, then bulk-inserts the new set.
 *       5. Appends a `provider.profile_updated` outbox row via the
 *          shared SDK. Rolls back atomically on a validation reject.
 *       6. Re-reads the materialised snapshot for the response.
 *
 * **Tenant scoping** (CLAUDE.md §3.2). Self-service-first: the
 * authenticated user must own the provider row. Admin override
 * lands when `PermissionGuard` lifts to `packages/nest-auth` via
 * TS-052-followup-11 — captured as TS-200-followup-1.
 *
 * **Outbox emission**. `provider.profile_updated` carries
 * `changedKinds` (the subset of `bio` / `dementia_sensitive` /
 * `language` / `cuisine` / `dietary_expertise` that the edit
 * actually touched). The producer compares the pre-edit row + tag
 * sets against the requested values and emits only the kinds that
 * actually differ.
 *
 * **Transparent no-op short-circuit** (TS-200-followup-7). A re-PUT
 * from a noisy UI that exactly matches the persisted state computes
 * `changedKinds = []`; before TS-200-followup-7 the transaction
 * still ran (bumping `updated_at` via Prisma's `@updatedAt`, then
 * skipping the outbox emit), making the freshness signal lie about
 * when state last actually changed. We now detect the no-op AFTER
 * the pre-transaction read but BEFORE the transaction begins, log
 * the skip for observability, and return the already-loaded
 * snapshot unchanged — preserving `updated_at` + avoiding the
 * `UPDATE` + `DELETE` + `createMany` round-trips entirely.
 *
 * **Optimistic concurrency** (TS-200-followup-5). The PUT accepts an
 * optional `If-Match: <updatedAt>` header (parsed by the controller
 * into `UpdateProfileInput.ifMatchUpdatedAt`). When set, the service
 * refuses the update unless the row's current `updated_at` matches
 * — preventing two browser tabs from silently overwriting each
 * other's edits. The check fires AFTER the 404 / 403 guards
 * (callers who can't see the row get the canonical refusal first)
 * and BEFORE the no-op short-circuit (a stale If-Match still
 * fails, even if the requested state would have been a no-op —
 * the freshness mismatch is what the client cares about).
 * `undefined` skips the precondition entirely, preserving
 * backward-compat for clients that haven't adopted If-Match.
 */
@Injectable()
export class ProviderProfileService {
  private readonly logger = new Logger(ProviderProfileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Fetch the materialised profile snapshot for a provider. Returns
   * `null` when no row exists (caller decides between 404 / 200-with-
   * null based on the surface semantics).
   */
  async getProfile(providerId: string): Promise<ProviderProfileSnapshot | null> {
    if (providerId.length === 0) return null;
    const row = (await this.prisma.provider.findUnique({
      where: { id: providerId },
    })) as ProviderRow | null;
    if (row === null) return null;
    return this.composeSnapshot(this.prisma, row);
  }

  /**
   * Fetch the materialised profile snapshot for the provider row
   * owned by `userId`. Returns `null` when the user has no
   * provider row (they haven't completed the application yet).
   * Used by the editor's initial-render GET surface.
   */
  async getProfileByUserId(userId: string): Promise<ProviderProfileSnapshot | null> {
    if (userId.length === 0) return null;
    const row = (await this.prisma.provider.findUnique({
      where: { userId },
    })) as ProviderRow | null;
    if (row === null) return null;
    return this.composeSnapshot(this.prisma, row);
  }

  async updateProfile(
    input: UpdateProfileInput,
  ): Promise<Result<ProviderProfileSnapshot, ProviderProfileFailure>> {
    if (input.providerId.length === 0) {
      return err({ reason: 'invalid_request', message: 'providerId is required' });
    }
    if (input.actorUserId.length === 0) {
      return err({ reason: 'invalid_request', message: 'actorUserId is required' });
    }

    const existing = (await this.prisma.provider.findUnique({
      where: { id: input.providerId },
    })) as ProviderRow | null;

    if (existing === null) {
      return err({ reason: 'not_found', providerId: input.providerId });
    }
    if (existing.userId !== input.actorUserId) {
      // Admin override path is deferred to TS-200-followup-1 once the
      // permission gate is available. Until then, a mismatch is a
      // hard 403 — the controller surfaces "Forbidden" without
      // distinguishing "this row is someone else's" from "you don't
      // exist as a provider" to avoid leaking ownership.
      return err({ reason: 'forbidden', providerId: input.providerId });
    }

    // TS-200-followup-5: optimistic concurrency. The client sends the
    // snapshot's `updatedAt` as `If-Match`; if the row has been
    // touched in between (another tab, an admin edit), we refuse the
    // write so the latest state isn't silently overwritten. The
    // `getTime()` equality compares numeric epoch ms — ISO-string
    // formatting is the controller's concern, not the service's.
    if (
      input.ifMatchUpdatedAt !== undefined &&
      input.ifMatchUpdatedAt.getTime() !== existing.updatedAt.getTime()
    ) {
      return err({
        reason: 'precondition_failed',
        providerId: input.providerId,
        currentUpdatedAt: existing.updatedAt,
      });
    }

    const existingTags = (await this.prisma.providerProfileTag.findMany({
      where: { providerId: input.providerId },
      select: { kind: true, tag: true },
    })) as ReadonlyArray<{ kind: ProviderProfileTagKind; tag: string }>;

    const requestedLanguages = normalizeTags(input.languages);
    const requestedCuisines = normalizeTags(input.cuisines);
    const requestedDietaryExpertise = normalizeTags(input.dietaryExpertise);

    const existingLanguages = pickTags(existingTags, PROVIDER_PROFILE_TAG_KIND_LANGUAGE);
    const existingCuisines = pickTags(existingTags, PROVIDER_PROFILE_TAG_KIND_CUISINE);
    const existingDietaryExpertise = pickTags(
      existingTags,
      PROVIDER_PROFILE_TAG_KIND_DIETARY_EXPERTISE,
    );

    const changedKinds = computeChangedKinds({
      bioChanged: input.bio !== existing.bio,
      dementiaSensitiveChanged: input.dementiaSensitive !== existing.dementiaSensitive,
      languageChanged: !arraysEqual(existingLanguages, requestedLanguages),
      cuisineChanged: !arraysEqual(existingCuisines, requestedCuisines),
      dietaryExpertiseChanged: !arraysEqual(existingDietaryExpertise, requestedDietaryExpertise),
    });

    // TS-200-followup-7: when the request exactly matches persisted
    // state, skip the transaction entirely. We already have the row +
    // tag partitions in hand from the pre-transaction reads above, so
    // we compose the snapshot and return without touching Prisma
    // writes. Preserves `updated_at` as an accurate freshness signal
    // (otherwise Prisma's `@updatedAt` would bump every PUT).
    if (changedKinds.length === 0) {
      this.logger.log(
        {
          providerId: input.providerId,
          actorUserId: input.actorUserId,
        },
        'provider-profile.update no-op short-circuit',
      );
      return ok({
        row: existing,
        languages: existingLanguages,
        cuisines: existingCuisines,
        dietaryExpertise: existingDietaryExpertise,
      });
    }

    const now = new Date();

    try {
      const result = await this.prisma.$transaction(
        async (tx: PrismaTransactionClient): Promise<ProviderProfileSnapshot> => {
          // 1. Update the row. `changedKinds` is non-empty by the
          //    short-circuit above — at least one of bio /
          //    dementia_sensitive / a tag kind differs, so the
          //    `updated_at` bump from Prisma's `@updatedAt` reflects a
          //    real state change.
          const updated = (await tx.provider.update({
            where: { id: input.providerId },
            data: {
              bio: input.bio,
              dementiaSensitive: input.dementiaSensitive,
            },
          })) as ProviderRow;

          // 2. Replace the three tag kinds. The delete + insertMany
          //    pair inside the transaction yields atomic-from-the-outside
          //    "set of tags now equals X" semantics.
          await tx.providerProfileTag.deleteMany({
            where: {
              providerId: input.providerId,
              kind: {
                in: [
                  PROVIDER_PROFILE_TAG_KIND_LANGUAGE,
                  PROVIDER_PROFILE_TAG_KIND_CUISINE,
                  PROVIDER_PROFILE_TAG_KIND_DIETARY_EXPERTISE,
                ],
              },
            },
          });

          const tagRows = [
            ...requestedLanguages.map((tag) => ({
              providerId: input.providerId,
              kind: PROVIDER_PROFILE_TAG_KIND_LANGUAGE,
              tag,
            })),
            ...requestedCuisines.map((tag) => ({
              providerId: input.providerId,
              kind: PROVIDER_PROFILE_TAG_KIND_CUISINE,
              tag,
            })),
            ...requestedDietaryExpertise.map((tag) => ({
              providerId: input.providerId,
              kind: PROVIDER_PROFILE_TAG_KIND_DIETARY_EXPERTISE,
              tag,
            })),
          ];
          if (tagRows.length > 0) {
            await tx.providerProfileTag.createMany({ data: tagRows });
          }

          // 3. Outbox emission. `changedKinds` is non-empty by the
          //    pre-transaction short-circuit above, so the event
          //    always fires when we reach this line.
          const eventId = `${input.providerId}.profile_updated.${now.getTime()}`;
          const appended = await this.outbox.append(tx as unknown as OutboxRawExecutor, {
            eventName: PROVIDER_PROFILE_UPDATED,
            eventId,
            occurredAt: now,
            payload: {
              eventId,
              occurredAt: now.toISOString(),
              providerId: input.providerId,
              // Spread to a mutable array — the Zod schema (z.array)
              // narrows to mutable on the payload side and TS-4104
              // refuses readonly → mutable assignment.
              changedKinds: [...changedKinds],
              actorUserId: input.actorUserId,
            },
          });
          if (appended.kind !== 'appended') {
            throw new OutboxValidationFailedError(appended.eventName, appended.issues);
          }

          // 4. Re-read tags so the response carries the exact set the
          //    transaction wrote. Using the same tx ensures we read-
          //    after-write consistently.
          const writtenTags = (await tx.providerProfileTag.findMany({
            where: { providerId: input.providerId },
            select: { kind: true, tag: true },
          })) as ReadonlyArray<{ kind: ProviderProfileTagKind; tag: string }>;

          return {
            row: updated,
            languages: pickTags(writtenTags, PROVIDER_PROFILE_TAG_KIND_LANGUAGE),
            cuisines: pickTags(writtenTags, PROVIDER_PROFILE_TAG_KIND_CUISINE),
            dietaryExpertise: pickTags(writtenTags, PROVIDER_PROFILE_TAG_KIND_DIETARY_EXPERTISE),
          };
        },
      );

      this.logger.log(
        {
          providerId: input.providerId,
          actorUserId: input.actorUserId,
          changedKinds,
        },
        'provider-profile.update ok',
      );

      return ok(result);
    } catch (e) {
      if (e instanceof OutboxValidationFailedError) {
        this.logger.error(
          { eventName: e.eventName, issues: e.issues, providerId: input.providerId },
          'provider-profile.update outbox validation failed; tx rolled back',
        );
        return err({
          reason: 'outbox_validation_failed',
          eventName: e.eventName,
          message: `event ${e.eventName} payload failed validation`,
        });
      }
      throw e;
    }
  }

  /**
   * Compose the materialised snapshot for a provider row already in
   * hand. Used by the GET path + as a building block in
   * `getProfile`.
   */
  private async composeSnapshot(
    client: PrismaService | PrismaTransactionClient,
    row: ProviderRow,
  ): Promise<ProviderProfileSnapshot> {
    const tags = (await client.providerProfileTag.findMany({
      where: { providerId: row.id },
      select: { kind: true, tag: true },
    })) as ReadonlyArray<{ kind: ProviderProfileTagKind; tag: string }>;
    return {
      row,
      languages: pickTags(tags, PROVIDER_PROFILE_TAG_KIND_LANGUAGE),
      cuisines: pickTags(tags, PROVIDER_PROFILE_TAG_KIND_CUISINE),
      dietaryExpertise: pickTags(tags, PROVIDER_PROFILE_TAG_KIND_DIETARY_EXPERTISE),
    };
  }
}

/**
 * Sort + de-dupe a tag array. The contract layer already rejects
 * intra-kind duplicates at the boundary — this is defence-in-depth
 * for the case where a controller bypass sneaks a duplicate through.
 * Sorting yields a stable canonical form for the diff comparison
 * against `existingTags` (which itself doesn't carry an order — we
 * sort it the same way for symmetric compare).
 */
function normalizeTags(tags: readonly string[]): readonly string[] {
  return Array.from(new Set(tags)).sort();
}

function pickTags(
  tags: ReadonlyArray<{ kind: ProviderProfileTagKind; tag: string }>,
  kind: ProviderProfileTagKind,
): readonly string[] {
  return tags
    .filter((row) => row.kind === kind)
    .map((row) => row.tag)
    .sort();
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

interface ChangedKindsInput {
  readonly bioChanged: boolean;
  readonly dementiaSensitiveChanged: boolean;
  readonly languageChanged: boolean;
  readonly cuisineChanged: boolean;
  readonly dietaryExpertiseChanged: boolean;
}

function computeChangedKinds(input: ChangedKindsInput): readonly ProviderProfileChangeKind[] {
  const out: ProviderProfileChangeKind[] = [];
  if (input.bioChanged) out.push('bio');
  if (input.dementiaSensitiveChanged) out.push('dementia_sensitive');
  if (input.languageChanged) out.push(PROVIDER_PROFILE_TAG_KIND_LANGUAGE);
  if (input.cuisineChanged) out.push(PROVIDER_PROFILE_TAG_KIND_CUISINE);
  if (input.dietaryExpertiseChanged) {
    out.push(PROVIDER_PROFILE_TAG_KIND_DIETARY_EXPERTISE);
  }
  return out;
}
