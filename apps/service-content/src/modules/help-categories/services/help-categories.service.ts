import { Injectable, Logger } from '@nestjs/common';
import type {
  CreateHelpCategoryRequest,
  HelpCategoryRecord,
  UpdateHelpCategoryRequest,
} from '@taste-and-see/contracts';
import type { OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import { AuditEmitter } from '@taste-and-see/nest-audit';
import { CONTENT_AUDIT_RESOURCE } from '../../audit/audit-resources';
import type { AuditActorContext } from '@taste-and-see/nest-audit';
import {
  HelpCategoryRepository,
  type HelpCategoryRow,
} from '../repositories/help-category.repository';

export interface CreateCategoryInput extends CreateHelpCategoryRequest {
  readonly actorUserId: string;
  readonly audit: AuditActorContext;
}

export interface UpdateCategoryInput extends UpdateHelpCategoryRequest {
  readonly categoryId: string;
  readonly actorUserId: string;
  readonly audit: AuditActorContext;
}

export interface ListCategoriesInput {
  readonly parentId?: string | undefined;
  readonly limit: number;
}

export type CreateCategoryOutcome =
  | { readonly ok: true; readonly category: HelpCategoryRecord }
  | { readonly ok: false; readonly reason: 'slug_conflict' }
  | { readonly ok: false; readonly reason: 'parent_not_found' };

export type UpdateCategoryOutcome =
  | { readonly ok: true; readonly category: HelpCategoryRecord }
  | { readonly ok: false; readonly reason: 'category_not_found' }
  | { readonly ok: false; readonly reason: 'parent_not_found' }
  | { readonly ok: false; readonly reason: 'cycle' };

export type GetCategoryOutcome =
  | { readonly ok: true; readonly category: HelpCategoryRecord }
  | { readonly ok: false; readonly reason: 'not_found' };

/**
 * Help-center taxonomy admin service (TS-284-followup-3; PRD §10.11; PDD §19.3).
 *
 * Owns the category tree's domain decisions: slug uniqueness on create, parent
 * existence, and — the interesting one — cycle-safe re-parenting. Setting
 * `C.parent = P` is a cycle iff `P === C` or `P` sits in `C`'s own subtree; the
 * check walks the ancestor chain up from `P` and rejects if it reaches `C`.
 * There is no version history or publish lifecycle (a category is a small
 * mutable node). Every mutation emits `audit.action_recorded` atomically with
 * the write (CLAUDE.md §3.6). Authorisation lives at the controller boundary
 * (`content:read` / `content:edit`).
 */
@Injectable()
export class HelpCategoriesService {
  private readonly logger = new Logger(HelpCategoriesService.name);

  constructor(
    private readonly repo: HelpCategoryRepository,
    private readonly audit: AuditEmitter,
  ) {}

  /** Create a category. Duplicate slug → 409; missing parent → 404. */
  async createCategory(input: CreateCategoryInput): Promise<CreateCategoryOutcome> {
    const existing = await this.repo.findCategoryBySlug(input.slug);
    if (existing !== null) return { ok: false, reason: 'slug_conflict' };

    if (input.parentId !== undefined) {
      const parent = await this.repo.findCategory(input.parentId);
      if (parent === null) return { ok: false, reason: 'parent_not_found' };
    }

    const created = await this.repo.createCategory(
      {
        slug: input.slug,
        name: input.name,
        parentId: input.parentId ?? null,
        sortOrder: input.sortOrder ?? 0,
      },
      async (tx, row) => {
        await this.audit.emit(tx as unknown as OutboxRawExecutor, input.audit, {
          action: 'content_help_category:create',
          resourceKind: CONTENT_AUDIT_RESOURCE.helpCategory,
          resourceId: row.id,
          before: null,
          after: toCategoryRecord(row),
        });
      },
    );

    this.logger.log(
      { categoryId: created.id, slug: created.slug, actorUserId: input.actorUserId },
      'content help category created',
    );
    return { ok: true, category: toCategoryRecord(created) };
  }

  /**
   * Update a category. Resolution order: missing category → 404; a supplied
   * non-null parent that doesn't resolve → 404; a re-parent that would create a
   * cycle → 409. Only then does the write fire.
   */
  async updateCategory(input: UpdateCategoryInput): Promise<UpdateCategoryOutcome> {
    const category = await this.repo.findCategory(input.categoryId);
    if (category === null) return { ok: false, reason: 'category_not_found' };

    if (input.parentId !== undefined && input.parentId !== null) {
      const parent = await this.repo.findCategory(input.parentId);
      if (parent === null) return { ok: false, reason: 'parent_not_found' };
      if (await this.wouldCreateCycle(input.categoryId, input.parentId)) {
        return { ok: false, reason: 'cycle' };
      }
    }

    const before = toCategoryRecord(category);
    const updated = await this.repo.updateCategory(
      input.categoryId,
      { name: input.name, parentId: input.parentId, sortOrder: input.sortOrder },
      async (tx, row) => {
        await this.audit.emit(tx as unknown as OutboxRawExecutor, input.audit, {
          action: 'content_help_category:update',
          resourceKind: CONTENT_AUDIT_RESOURCE.helpCategory,
          resourceId: row.id,
          before,
          after: toCategoryRecord(row),
        });
      },
    );

    this.logger.log(
      { categoryId: input.categoryId, actorUserId: input.actorUserId },
      'content help category updated',
    );
    return { ok: true, category: toCategoryRecord(updated) };
  }

  /** Matching categories as a flat list (client assembles the tree). */
  async listCategories(input: ListCategoriesInput): Promise<readonly HelpCategoryRecord[]> {
    const rows = await this.repo.listCategories({ parentId: input.parentId, limit: input.limit });
    return rows.map(toCategoryRecord);
  }

  /** A single category, or 404. */
  async getCategory(categoryId: string): Promise<GetCategoryOutcome> {
    const category = await this.repo.findCategory(categoryId);
    if (category === null) return { ok: false, reason: 'not_found' };
    return { ok: true, category: toCategoryRecord(category) };
  }

  /**
   * True when setting `categoryId`'s parent to `newParentId` would create a
   * cycle — i.e. `newParentId === categoryId`, or `categoryId` is an ancestor of
   * `newParentId` (so `newParentId` lives in `categoryId`'s subtree). Walks the
   * ancestor chain up from `newParentId`; a cycle-free tree bounds the walk at
   * the tree depth. A defensive visited-set guards against a pre-existing cycle
   * in corrupt data.
   */
  private async wouldCreateCycle(categoryId: string, newParentId: string): Promise<boolean> {
    const visited = new Set<string>();
    let cursor: string | null = newParentId;
    while (cursor !== null) {
      if (cursor === categoryId) return true;
      if (visited.has(cursor)) return true;
      visited.add(cursor);
      const node: HelpCategoryRow | null = await this.repo.findCategory(cursor);
      cursor = node?.parentId ?? null;
    }
    return false;
  }
}

// ─── Row → wire-record mapper ───────────────────────────────────────────

/** Project a persisted category row into the wire `HelpCategoryRecord`. */
export function toCategoryRecord(row: HelpCategoryRow): HelpCategoryRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    parentId: row.parentId,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
