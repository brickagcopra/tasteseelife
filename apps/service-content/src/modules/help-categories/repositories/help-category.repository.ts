import { Injectable } from '@nestjs/common';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';

/**
 * Local mirror of the Prisma-generated `help_categories` row, narrowed to the
 * columns this module reads/writes (same hand-projection rationale as the pages
 * / articles repositories).
 */
export interface HelpCategoryRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly sortOrder: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Explicit column projection — never `SELECT *` (CLAUDE.md §4.1). */
const CATEGORY_SELECT = {
  id: true,
  slug: true,
  name: true,
  parentId: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface HelpCategoryWriteData {
  readonly slug: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly sortOrder: number;
}

export interface HelpCategoryUpdateData {
  readonly name?: string | undefined;
  /** Present = set (including `null` to promote to root); absent = unchanged. */
  readonly parentId?: string | null | undefined;
  readonly sortOrder?: number | undefined;
}

/**
 * Persistence for the help-center taxonomy (TS-284-followup-3; PDD §8.2, §19.3).
 * `HelpCategory` is an `unscopedModel` (platform-wide taxonomy — see
 * `app.module.ts`), so the tenant-scope gate short-circuits. Cycle-safety and
 * parent validation live in `HelpCategoriesService`; `onPersist` (when supplied)
 * runs INSIDE the mutation transaction (the audit-outbox append) so the audit
 * row commits atomically with the state change (CLAUDE.md §3.6, §5.3).
 */
@Injectable()
export class HelpCategoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Create a category. */
  async createCategory(
    data: HelpCategoryWriteData,
    onPersist?: (tx: PrismaTransactionClient, created: HelpCategoryRow) => Promise<void>,
  ): Promise<HelpCategoryRow> {
    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const created = (await tx.helpCategory.create({
        data: {
          slug: data.slug,
          name: data.name,
          parentId: data.parentId,
          sortOrder: data.sortOrder,
        },
        select: CATEGORY_SELECT,
      })) as HelpCategoryRow;
      if (onPersist !== undefined) await onPersist(tx, created);
      return created;
    });
  }

  /** Update a category's name / parent / ordering. */
  async updateCategory(
    id: string,
    data: HelpCategoryUpdateData,
    onPersist?: (tx: PrismaTransactionClient, updated: HelpCategoryRow) => Promise<void>,
  ): Promise<HelpCategoryRow> {
    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const patch: Record<string, unknown> = {};
      if (data.name !== undefined) patch['name'] = data.name;
      if (data.parentId !== undefined) patch['parentId'] = data.parentId;
      if (data.sortOrder !== undefined) patch['sortOrder'] = data.sortOrder;

      const updated = (await tx.helpCategory.update({
        where: { id },
        data: patch,
        select: CATEGORY_SELECT,
      })) as HelpCategoryRow;
      if (onPersist !== undefined) await onPersist(tx, updated);
      return updated;
    });
  }

  /** Shallow category row by id, or null. */
  async findCategory(id: string): Promise<HelpCategoryRow | null> {
    return (await this.prisma.helpCategory.findUnique({
      where: { id },
      select: CATEGORY_SELECT,
    })) as HelpCategoryRow | null;
  }

  /** Shallow category row by slug, or null. */
  async findCategoryBySlug(slug: string): Promise<HelpCategoryRow | null> {
    return (await this.prisma.helpCategory.findUnique({
      where: { slug },
      select: CATEGORY_SELECT,
    })) as HelpCategoryRow | null;
  }

  /**
   * Matching categories as a FLAT list ordered by `(sortOrder, name)`. When
   * `parentId` is supplied only that parent's direct children are returned;
   * otherwise the whole taxonomy (the client assembles the tree from each
   * node's `parentId`). Bounded by `limit`.
   */
  async listCategories(filter: {
    readonly parentId?: string | undefined;
    readonly limit: number;
  }): Promise<readonly HelpCategoryRow[]> {
    const where: Record<string, unknown> = {};
    if (filter.parentId !== undefined) where['parentId'] = filter.parentId;

    return (await this.prisma.helpCategory.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      take: filter.limit,
      select: CATEGORY_SELECT,
    })) as HelpCategoryRow[];
  }

  /**
   * The direct children of a category — used by the cycle check to walk the
   * subtree when validating a re-parent. Returns just the ids.
   */
  async findChildIds(parentId: string): Promise<readonly string[]> {
    const rows = (await this.prisma.helpCategory.findMany({
      where: { parentId },
      select: { id: true },
    })) as ReadonlyArray<{ id: string }>;
    return rows.map((r) => r.id);
  }
}
