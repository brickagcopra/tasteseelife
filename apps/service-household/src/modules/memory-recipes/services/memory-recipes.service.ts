import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  MEMORY_RECIPES_MAX_PER_SENIOR,
  type CreateMemoryRecipeRequest,
  type MemoryRecipe,
  type MemoryRecipeSource,
  type MemoryRecipesListResponse,
  type UpdateMemoryRecipeRequest,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Domain service for the senior memory-recipes catalog (TS-033).
 *
 * Four surfaces:
 *
 *   - `list({ seniorId, requesterUserId })`
 *       Active recipes (`deletedAt IS NULL`) in family-controlled
 *       order — `sortPosition` ascending, `createdAt` ascending as
 *       tie-breaker. Wrapped in `{ recipes: [...] }` for forward-
 *       compatible pagination evolution.
 *
 *   - `create({ seniorId, requesterUserId, input })`
 *       Persist a new recipe. Enforces the per-senior cap of
 *       `MEMORY_RECIPES_MAX_PER_SENIOR` (200) — over-cap inserts
 *       throw 422 UnprocessableEntity. Auto-assigns `sortPosition`
 *       to next-available (current max + 1, starting at 0). Sets
 *       `contributedByUserId` to the requester only when source =
 *       `family_contribution`; `senior_request` (entered by the
 *       family on behalf of the senior or by ops) leaves it null
 *       so the dashboard renders that provenance distinctly.
 *
 *   - `update({ seniorId, recipeId, requesterUserId, input })`
 *       Patch a subset of fields. Empty patches throw 400 — the
 *       contract layer accepts `{}` for syntactic ergonomics but
 *       the service requires real intent. `source` and
 *       `contributedByUserId` are write-once on create and not
 *       reachable through this surface (the contract layer omits
 *       them).
 *
 *   - `remove({ seniorId, recipeId, requesterUserId })`
 *       Soft-delete by setting `deletedAt`. Audit reads can pull
 *       the row back via admin tooling; default list endpoint
 *       filters it out. Idempotent — repeated deletes succeed
 *       silently.
 *
 * Authorisation. Every method runs `loadAuthorisedSenior` first.
 * Mirrors the senior-intake / access-instructions / emergency-
 * contacts pattern: the controller cannot bypass this gate today,
 * and TS-141's Prisma extension will push enforcement down further.
 *
 * No PII in logs. We log `seniorId`, `requesterUserId`, the action,
 * and the recipe id (post-create / on update / on remove). Titles,
 * descriptions, image keys — never logged at info level. The audit-
 * svc (TS-100) is the right home for the full before/after diff.
 */
@Injectable()
export class MemoryRecipesService {
  private readonly logger = new Logger(MemoryRecipesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(args: {
    readonly seniorId: string;
    readonly requesterUserId: string;
  }): Promise<MemoryRecipesListResponse> {
    await this.loadAuthorisedSenior(args.seniorId, args.requesterUserId);
    const rows = await this.prisma.memoryRecipe.findMany({
      where: { seniorId: args.seniorId, deletedAt: null },
      orderBy: [{ sortPosition: 'asc' }, { createdAt: 'asc' }],
      select: RECIPE_SELECT,
    });
    return { recipes: rows.map(toDto) };
  }

  async create(args: {
    readonly seniorId: string;
    readonly requesterUserId: string;
    readonly input: CreateMemoryRecipeRequest;
  }): Promise<MemoryRecipe> {
    const { seniorId, requesterUserId, input } = args;
    await this.loadAuthorisedSenior(seniorId, requesterUserId);

    // Cap-check before the insert. A small race window exists where
    // two concurrent creates could both pass this check and land a
    // 201st row; the cap-as-422 contract is best-effort. A DB-level
    // guard is captured as a follow-up if drift is observed.
    const activeCount = await this.prisma.memoryRecipe.count({
      where: { seniorId, deletedAt: null },
    });
    if (activeCount >= MEMORY_RECIPES_MAX_PER_SENIOR) {
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: `Cannot add another memory recipe — this senior is at the ${MEMORY_RECIPES_MAX_PER_SENIOR}-recipe maximum.`,
      });
    }

    // Auto-assign sortPosition: next-available across ACTIVE rows
    // (soft-deleted recipes don't reserve slots). aggregate.max
    // returns null for an empty set; we start at 0 in that case so
    // the first recipe lands at position 0 for predictable ordering.
    const maxAggregate = await this.prisma.memoryRecipe.aggregate({
      where: { seniorId, deletedAt: null },
      _max: { sortPosition: true },
    });
    const nextSortPosition =
      maxAggregate._max.sortPosition === null ? 0 : maxAggregate._max.sortPosition + 1;

    const contributedByUserId = input.source === 'family_contribution' ? requesterUserId : null;

    const created = await this.prisma.memoryRecipe.create({
      data: {
        seniorId,
        title: input.title,
        description: input.description,
        source: input.source,
        cuisineTag: input.cuisineTag ?? null,
        imageKey: input.imageKey ?? null,
        requestedForUpcomingVisit: input.requestedForUpcomingVisit ?? false,
        contributedByUserId,
        sortPosition: nextSortPosition,
      },
      select: RECIPE_SELECT,
    });

    this.logger.log(
      {
        seniorId,
        requesterUserId,
        recipeId: created.id,
        source: created.source,
        action: 'create',
      },
      'memory recipe created',
    );

    return toDto(created);
  }

  async update(args: {
    readonly seniorId: string;
    readonly recipeId: string;
    readonly requesterUserId: string;
    readonly input: UpdateMemoryRecipeRequest;
  }): Promise<MemoryRecipe> {
    const { seniorId, recipeId, requesterUserId, input } = args;
    await this.loadAuthorisedSenior(seniorId, requesterUserId);

    if (Object.keys(input).length === 0) {
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'Update request must include at least one field.',
      });
    }

    const existing = await this.prisma.memoryRecipe.findFirst({
      where: { id: recipeId, seniorId, deletedAt: null },
      select: { id: true },
    });
    if (existing === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Memory recipe not found.',
      });
    }

    const updated = await this.prisma.memoryRecipe.update({
      where: { id: recipeId },
      // Conditional spreads rather than `key: value` with a possibly-
      // `undefined` value: this is a PATCH, so an omitted field must mean
      // "leave the column unchanged" — which Prisma expresses as the key
      // being ABSENT. Under `exactOptionalPropertyTypes` a present-but-
      // `undefined` property is not assignable to the generated update
      // input, and writing `null` instead would wrongly clear the column
      // (TS-501). An explicit `null` from the caller still clears, because
      // only `undefined` is filtered here.
      data: {
        ...(input.title !== undefined && { title: input.title }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.cuisineTag !== undefined && { cuisineTag: input.cuisineTag }),
        ...(input.imageKey !== undefined && { imageKey: input.imageKey }),
        ...(input.requestedForUpcomingVisit !== undefined && {
          requestedForUpcomingVisit: input.requestedForUpcomingVisit,
        }),
        ...(input.sortPosition !== undefined && { sortPosition: input.sortPosition }),
      },
      select: RECIPE_SELECT,
    });

    this.logger.log(
      {
        seniorId,
        requesterUserId,
        recipeId: updated.id,
        action: 'update',
        fields: Object.keys(input),
      },
      'memory recipe updated',
    );

    return toDto(updated);
  }

  async remove(args: {
    readonly seniorId: string;
    readonly recipeId: string;
    readonly requesterUserId: string;
  }): Promise<void> {
    const { seniorId, recipeId, requesterUserId } = args;
    await this.loadAuthorisedSenior(seniorId, requesterUserId);

    const existing = await this.prisma.memoryRecipe.findFirst({
      where: { id: recipeId, seniorId },
      select: { id: true, deletedAt: true },
    });
    if (existing === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Memory recipe not found.',
      });
    }
    if (existing.deletedAt !== null) {
      // Idempotent — repeated deletes resolve cleanly.
      return;
    }

    await this.prisma.memoryRecipe.update({
      where: { id: recipeId },
      data: { deletedAt: new Date() },
      select: { id: true },
    });

    this.logger.log(
      { seniorId, requesterUserId, recipeId, action: 'remove' },
      'memory recipe removed',
    );
  }

  /**
   * Active-membership precondition. Mirror of `IntakeService.loadAuthorisedSenior`
   * — see that method for the rationale on (a) two queries instead of a
   * JOIN, and (b) 403 (not 404) when the requester is not a member.
   */
  private async loadAuthorisedSenior(
    seniorId: string,
    requesterUserId: string,
  ): Promise<{ readonly id: string; readonly householdId: string }> {
    const senior = await this.prisma.senior.findFirst({
      where: { id: seniorId, deletedAt: null },
      select: { id: true, householdId: true },
    });
    if (senior === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Senior not found.',
      });
    }
    const membership = await this.prisma.householdMember.findFirst({
      where: {
        householdId: senior.householdId,
        userId: requesterUserId,
        removedAt: null,
      },
      select: { id: true },
    });
    if (membership === null) {
      throw new ForbiddenException({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'You do not have access to this senior.',
      });
    }
    return senior;
  }
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

interface RecipeRow {
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

function toDto(row: RecipeRow): MemoryRecipe {
  return {
    id: row.id,
    seniorId: row.seniorId,
    title: row.title,
    description: row.description,
    // Prisma generates the source enum as a string-literal union; the
    // contract enum is the same closed set. Cast to the contract type
    // so the response DTO is strongly typed for downstream consumers.
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
