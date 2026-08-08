import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  DementiaStatus,
  InternalSeniorPrepSnapshotResponse,
  MemoryRecipe,
  MemoryRecipeSource,
  SeniorMobilityLevel,
  VisitPrepChecklistSenior,
} from '@taste-and-see/contracts';
import { VISIT_PREP_MEMORY_RECIPES_MAX } from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Domain service for the visit-prep snapshot (TS-208).
 *
 * One read surface:
 *
 *   - `getSnapshot({ seniorId })`
 *       Project the senior's operational intake columns + the per-
 *       senior memory recipes into the `InternalSeniorPrepSnapshotResponse`
 *       shape consumed by api-gateway's BFF aggregator. Throws 404
 *       when the senior does not exist or has been soft-deleted.
 *
 * **No membership check.** The endpoint that calls this service
 * (`VisitPrepInternalController`) is pinned by the
 * `HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY` shared-secret header — the
 * caller (api-gateway BFF) has already verified the requesting provider
 * is the assigned provider for the booking before issuing the call.
 * Mirrors the trust posture of `ProviderDiscoveryService.getSnapshot`
 * on service-provider (TS-053).
 *
 * **No encrypted payload.** The senior intake's encrypted free-form
 * notes (DOB / dietary / allergy / mobility / medical) are deliberately
 * NOT decrypted here. The TS-208 Phase-1 contract surfaces operational
 * columns only (dietary tags / allergen tags / language tags / mobility
 * level / dementia status). Sensitive notes land via a follow-up once
 * the senior-consent table (TS-062-followup-3) exists; until then the
 * provider sees the categorical signals + memory recipes only.
 *
 * **Memory recipes ordering.** Two passes through the per-senior
 * catalog:
 *   1. `requestedForUpcomingVisit = true` recipes — these are the
 *      loud signal the family / senior wants this dish at the
 *      upcoming visit; sorted by `sortPosition` ascending then
 *      `createdAt` ascending as tie-breaker.
 *   2. The remaining active recipes — same ordering primary keys.
 *
 * The combined list is sliced at `VISIT_PREP_MEMORY_RECIPES_MAX = 24`
 * so the page renders without scrolling on the provider portal.
 */
@Injectable()
export class VisitPrepService {
  private readonly logger = new Logger(VisitPrepService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getSnapshot(args: {
    readonly seniorId: string;
  }): Promise<InternalSeniorPrepSnapshotResponse> {
    const senior = (await this.prisma.senior.findFirst({
      where: { id: args.seniorId, deletedAt: null },
      select: SENIOR_SELECT,
    })) as SeniorRowForPrep | null;

    if (senior === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Senior not found.',
      });
    }

    const recipes = await this.prisma.memoryRecipe.findMany({
      where: { seniorId: senior.id, deletedAt: null },
      orderBy: [
        { requestedForUpcomingVisit: 'desc' },
        { sortPosition: 'asc' },
        { createdAt: 'asc' },
      ],
      take: VISIT_PREP_MEMORY_RECIPES_MAX,
      select: RECIPE_SELECT,
    });

    this.logger.debug(
      {
        seniorId: senior.id,
        recipeCount: recipes.length,
        intakeCompletedAt: senior.intakeCompletedAt?.toISOString() ?? null,
      },
      'visit-prep.snapshot built',
    );

    return {
      senior: toSeniorDto(senior),
      memoryRecipes: recipes.map(toRecipeDto),
    };
  }
}

const SENIOR_SELECT = {
  id: true,
  dietaryTags: true,
  allergenTags: true,
  languageTags: true,
  mobilityLevel: true,
  dementiaStatus: true,
  intakeCompletedAt: true,
} as const;

interface SeniorRowForPrep {
  readonly id: string;
  readonly dietaryTags: string[];
  readonly allergenTags: string[];
  readonly languageTags: string[];
  readonly mobilityLevel: string;
  readonly dementiaStatus: string;
  readonly intakeCompletedAt: Date | null;
}

const RECIPE_SELECT = {
  id: true,
  seniorId: true,
  title: true,
  description: true,
  source: true,
  cuisineTag: true,
  imageKey: true,
  requestedForUpcomingVisit: true,
  contributedByUserId: true,
  sortPosition: true,
  createdAt: true,
  updatedAt: true,
} as const;

interface RecipeRowForPrep {
  readonly id: string;
  readonly seniorId: string;
  readonly title: string;
  readonly description: string;
  readonly source: string;
  readonly cuisineTag: string | null;
  readonly imageKey: string | null;
  readonly requestedForUpcomingVisit: boolean;
  readonly contributedByUserId: string | null;
  readonly sortPosition: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toSeniorDto(row: SeniorRowForPrep): VisitPrepChecklistSenior {
  return {
    seniorId: row.id,
    dietaryTags: row.dietaryTags,
    allergenTags: row.allergenTags,
    languageTags: row.languageTags,
    mobilityLevel: row.mobilityLevel as SeniorMobilityLevel,
    dementiaStatus: row.dementiaStatus as DementiaStatus,
    intakeCompletedAt: row.intakeCompletedAt === null ? null : row.intakeCompletedAt.toISOString(),
  };
}

function toRecipeDto(row: RecipeRowForPrep): MemoryRecipe {
  return {
    id: row.id,
    seniorId: row.seniorId,
    title: row.title,
    description: row.description,
    source: row.source as MemoryRecipeSource,
    cuisineTag: row.cuisineTag,
    imageKey: row.imageKey,
    requestedForUpcomingVisit: row.requestedForUpcomingVisit,
    contributedByUserId: row.contributedByUserId,
    sortPosition: row.sortPosition,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
