import { Injectable } from '@nestjs/common';
import type {
  CreateFavoriteProviderRequest,
  CreateFavoriteProviderResponse,
  FavoriteProvider,
} from '@taste-and-see/contracts';
import { FAVORITE_PROVIDERS_MAX_PER_OWNER } from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Persistence layer for TS-215 favourite providers.
 *
 * Every method takes an explicit `ownerUserId` derived from the
 * authenticated actor's request context. The controller passes it
 * through; the service never reads the request context directly.
 *
 * **Idempotent create.** The composite `(ownerUserId, providerId,
 * seniorId)` is unique at the DB layer. The create method reads the
 * existing row first to determine whether the supplied `notes` differ
 * from the stored value — replaying with identical notes returns
 * `unchanged` without bumping `createdAt`; differing notes update the
 * row and return `updated`. A first call returns `created`.
 *
 * **Idempotent delete.** Returns `not_found` rather than throwing so
 * the gateway can surface the response verbatim — see the contract's
 * `DeleteFavoriteProviderResponse` discriminator.
 *
 * **Quota enforcement.** Create rejects with `OwnerQuotaExceededError`
 * once the owner already has `FAVORITE_PROVIDERS_MAX_PER_OWNER` rows.
 * The controller maps this to a 409 Conflict. Replays against an
 * existing tuple bypass the quota — only NEW rows count.
 */
@Injectable()
export class FavoriteProvidersService {
  constructor(private readonly prisma: PrismaService) {}

  async listForOwner(
    ownerUserId: string,
    filter: ListFilter = {},
  ): Promise<readonly FavoriteProvider[]> {
    const where: {
      ownerUserId: string;
      seniorId?: string | null;
      providerId?: string;
    } = { ownerUserId };

    // `seniorId === null` filters to no-senior favourites only.
    // `seniorId === 'senior_xyz'` filters to that senior only.
    // `seniorId` omitted returns every row for the owner.
    if (filter.seniorId !== undefined) {
      where.seniorId = filter.seniorId;
    }
    if (filter.providerId !== undefined) {
      where.providerId = filter.providerId;
    }

    const rows = await this.prisma.favoriteProvider.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toContract);
  }

  async findByIdForOwner(ownerUserId: string, id: string): Promise<FavoriteProvider | null> {
    const row = await this.prisma.favoriteProvider.findUnique({ where: { id } });
    if (row === null || row.ownerUserId !== ownerUserId) return null;
    return toContract(row);
  }

  async upsert(
    ownerUserId: string,
    input: CreateFavoriteProviderRequest,
  ): Promise<CreateFavoriteProviderResponse> {
    const seniorId = input.seniorId ?? null;
    const notes = input.notes ?? null;

    const existing = await this.prisma.favoriteProvider.findFirst({
      where: {
        ownerUserId,
        providerId: input.providerId,
        seniorId,
      },
    });

    if (existing === null) {
      const count = await this.prisma.favoriteProvider.count({ where: { ownerUserId } });
      if (count >= FAVORITE_PROVIDERS_MAX_PER_OWNER) {
        throw new OwnerQuotaExceededError(count, FAVORITE_PROVIDERS_MAX_PER_OWNER);
      }
      const created = await this.prisma.favoriteProvider.create({
        data: {
          ownerUserId,
          providerId: input.providerId,
          seniorId,
          notes,
        },
      });
      return { outcome: 'created', favorite: toContract(created) };
    }

    if ((existing.notes ?? null) === notes) {
      return { outcome: 'unchanged', favorite: toContract(existing) };
    }

    const updated = await this.prisma.favoriteProvider.update({
      where: { id: existing.id },
      data: { notes },
    });
    return { outcome: 'updated', favorite: toContract(updated) };
  }

  async delete(ownerUserId: string, id: string): Promise<'deleted' | 'not_found'> {
    const current = await this.prisma.favoriteProvider.findUnique({ where: { id } });
    if (current === null || current.ownerUserId !== ownerUserId) return 'not_found';

    await this.prisma.favoriteProvider.delete({ where: { id } });
    return 'deleted';
  }
}

export interface ListFilter {
  /** `null` = no-senior favourites only; string = that senior only. */
  readonly seniorId?: string | null;
  readonly providerId?: string;
}

export class OwnerQuotaExceededError extends Error {
  readonly existing: number;
  readonly max: number;

  constructor(existing: number, max: number) {
    super(`Owner has reached the favorite-providers quota: ${existing}/${max}.`);
    this.name = 'OwnerQuotaExceededError';
    this.existing = existing;
    this.max = max;
  }
}

interface FavoriteProviderRow {
  readonly id: string;
  readonly ownerUserId: string;
  readonly providerId: string;
  readonly seniorId: string | null;
  readonly notes: string | null;
  readonly createdAt: Date;
}

function toContract(row: FavoriteProviderRow): FavoriteProvider {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    providerId: row.providerId,
    seniorId: row.seniorId,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  };
}
