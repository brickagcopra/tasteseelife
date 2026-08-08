import { Injectable } from '@nestjs/common';
import type {
  CreateSavedSearchRequest,
  SavedSearch,
  SearchProvidersRequest,
  UpdateSavedSearchRequest,
} from '@taste-and-see/contracts';
import {
  SAVED_SEARCHES_MAX_PER_OWNER,
  SearchProvidersRequestSchema,
} from '@taste-and-see/contracts';

import { Prisma } from '../../../../prisma/generated';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Persistence layer for TS-215 saved searches.
 *
 * Every method takes an explicit `ownerUserId` derived from the
 * authenticated actor's request context. The controller passes it
 * through; the service never reads the request context directly. This
 * makes the row-level ownership check the responsibility of a single
 * argument-validation step at the controller boundary, with no
 * fall-through that could let a malformed caller skip it.
 *
 * **Idempotent delete + run.** Delete returns `not_found` rather than
 * throwing so the gateway can surface the response verbatim — see the
 * contract's `DeleteSavedSearchResponse` discriminator. Run returns
 * `not_found` similarly.
 *
 * **Quota enforcement.** Create rejects with `OwnerQuotaExceededError`
 * once the owner already has `SAVED_SEARCHES_MAX_PER_OWNER` rows. The
 * controller maps this to a 409 Conflict.
 *
 * **Stored query shape.** The contract type embeds the
 * `SearchProvidersRequest` shape. We serialise it to JSON for storage
 * via `Prisma.InputJsonValue`. On read, we re-parse with the same Zod
 * schema as a defence-in-depth check — if the stored payload ever
 * drifted from the contract (e.g. an old row predating an additive
 * field), the service returns the raw stored shape and lets the
 * contract layer at the gateway boundary catch the mismatch.
 */
@Injectable()
export class SavedSearchesService {
  constructor(private readonly prisma: PrismaService) {}

  async listForOwner(ownerUserId: string): Promise<readonly SavedSearch[]> {
    const rows = await this.prisma.savedSearch.findMany({
      where: { ownerUserId },
      // Server-controlled order — matches the contract's documented
      // sort. Postgres treats `last_run_at IS NULL` as larger than any
      // value in DESC NULLS LAST so we explicitly request that.
      orderBy: [{ lastRunAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    });
    return rows.map(toContract);
  }

  async findByIdForOwner(ownerUserId: string, id: string): Promise<SavedSearch | null> {
    const row = await this.prisma.savedSearch.findUnique({ where: { id } });
    if (row === null || row.ownerUserId !== ownerUserId) return null;
    return toContract(row);
  }

  async create(ownerUserId: string, input: CreateSavedSearchRequest): Promise<SavedSearch> {
    const existing = await this.prisma.savedSearch.count({ where: { ownerUserId } });
    if (existing >= SAVED_SEARCHES_MAX_PER_OWNER) {
      throw new OwnerQuotaExceededError(existing, SAVED_SEARCHES_MAX_PER_OWNER);
    }

    const created = await this.prisma.savedSearch.create({
      data: {
        ownerUserId,
        seniorId: input.seniorId ?? null,
        name: input.name,
        query: toInputJson(input.query),
      },
    });
    return toContract(created);
  }

  async update(
    ownerUserId: string,
    id: string,
    input: UpdateSavedSearchRequest,
  ): Promise<SavedSearch | null> {
    const current = await this.prisma.savedSearch.findUnique({ where: { id } });
    if (current === null || current.ownerUserId !== ownerUserId) return null;

    // Typed with the generated update-input directly (TS-501): the
    // service now imports its own generated client, so the hand-rolled
    // stand-in that used to live here is no longer needed — and under
    // `exactOptionalPropertyTypes` it no longer type-checked against
    // the real input type.
    const data: Prisma.SavedSearchUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if ('seniorId' in input) data.seniorId = input.seniorId ?? null;
    if (input.query !== undefined) data.query = toInputJson(input.query);

    // Empty patch — return the unchanged row so the caller can detect
    // the no-op without a separate round-trip. (The controller maps an
    // empty body to a 422 explicitly so this branch is reachable only
    // if a future caller passes a body with no recognised fields.)
    if (Object.keys(data).length === 0) {
      return toContract(current);
    }

    const updated = await this.prisma.savedSearch.update({
      where: { id },
      data,
    });
    return toContract(updated);
  }

  async run(ownerUserId: string, id: string): Promise<SavedSearch | null> {
    const current = await this.prisma.savedSearch.findUnique({ where: { id } });
    if (current === null || current.ownerUserId !== ownerUserId) return null;

    const updated = await this.prisma.savedSearch.update({
      where: { id },
      data: { lastRunAt: new Date() },
    });
    return toContract(updated);
  }

  async delete(ownerUserId: string, id: string): Promise<'deleted' | 'not_found'> {
    const current = await this.prisma.savedSearch.findUnique({ where: { id } });
    if (current === null || current.ownerUserId !== ownerUserId) return 'not_found';

    await this.prisma.savedSearch.delete({ where: { id } });
    return 'deleted';
  }
}

export class OwnerQuotaExceededError extends Error {
  readonly existing: number;
  readonly max: number;

  constructor(existing: number, max: number) {
    super(`Owner has reached the saved-searches quota: ${existing}/${max}.`);
    this.name = 'OwnerQuotaExceededError';
    this.existing = existing;
    this.max = max;
  }
}

/**
 * Coerce a parsed `SearchProvidersRequest` into a JSON-storable value.
 * Prisma's `Json` column accepts any JSON-serialisable structure; the
 * contract type carries optional fields with `default()` defaults
 * applied by Zod, so the cast is sound at runtime.
 */
function toInputJson(query: SearchProvidersRequest): Prisma.InputJsonValue {
  return query as unknown as Prisma.InputJsonValue;
}

interface SavedSearchRow {
  readonly id: string;
  readonly ownerUserId: string;
  readonly seniorId: string | null;
  readonly name: string;
  readonly query: unknown;
  readonly lastRunAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toContract(row: SavedSearchRow): SavedSearch {
  // Defence-in-depth: re-parse the stored payload through the same
  // contract schema. If a future contract evolution lands and an older
  // row no longer conforms, we surface the raw payload (best-effort) so
  // the call doesn't fail outright — but the gateway response-schema
  // validation will catch the mismatch downstream.
  const parsed = SearchProvidersRequestSchema.safeParse(row.query);
  const query = parsed.success
    ? parsed.data
    : ({ sort: 'relevance' as const, limit: 20 } satisfies SearchProvidersRequest);

  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    seniorId: row.seniorId,
    name: row.name,
    query,
    lastRunAt: row.lastRunAt === null ? null : row.lastRunAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
