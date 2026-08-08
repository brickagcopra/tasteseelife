import { Injectable } from '@nestjs/common';
import type { ContentStatus } from '@taste-and-see/contracts';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';

/**
 * Local mirrors of the Prisma-generated `pages` / `page_versions` rows, narrowed
 * to the columns this module reads/writes. Same TS-021-followup-3 rationale
 * documented across the codebase — Prisma's row types resolve inconsistently
 * under our tsconfig so we project shapes by hand (mirrors service-ads's
 * `AdCampaignRow`).
 */
export interface PageRow {
  readonly id: string;
  readonly slug: string;
  readonly status: ContentStatus;
  readonly title: string;
  readonly currentVersionId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PageVersionRow {
  readonly id: string;
  readonly pageId: string;
  readonly versionNo: number;
  readonly title: string;
  readonly body: string;
  readonly effectiveAt: Date | null;
  readonly isMaterialChange: boolean;
  readonly materialChangeNote: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Explicit column projections — never `SELECT *` (CLAUDE.md §4.1). */
const PAGE_SELECT = {
  id: true,
  slug: true,
  status: true,
  title: true,
  currentVersionId: true,
  createdAt: true,
  updatedAt: true,
} as const;

const VERSION_SELECT = {
  id: true,
  pageId: true,
  versionNo: true,
  title: true,
  body: true,
  effectiveAt: true,
  isMaterialChange: true,
  materialChangeNote: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface PageWriteData {
  readonly slug: string;
  readonly title: string;
}

export interface PageVersionWriteData {
  readonly title: string;
  readonly body: string;
  readonly createdBy: string;
}

/** Publish-time write data — the effective date + the material-change flag (TS-285). */
export interface PublishWriteData {
  readonly effectiveAt: Date;
  readonly isMaterialChange: boolean;
  readonly materialChangeNote: string | null;
}

export interface PageDetailRows {
  readonly page: PageRow;
  readonly versions: readonly PageVersionRow[];
}

export interface PublishResultRows {
  readonly page: PageRow;
  readonly version: PageVersionRow;
}

/**
 * Persistence for the static-pages aggregate (TS-284; PDD §8.2, §19.2).
 *
 * `Page` / `PageVersion` are `unscopedModel`s (platform-wide content-staff
 * inventory — see `app.module.ts`), so the tenant-scope gate short-circuits to
 * `proceed_unscoped_model` before any request-context check.
 *
 * The repository deals in RAW persisted shapes; lifecycle decisions (slug
 * uniqueness, version-number assignment, publish ordering) and the wire mapping
 * live in `PagesService`. `onPersist` (when supplied) runs INSIDE the mutation
 * transaction — the audit-outbox append — so the audit row commits atomically
 * with the state change (CLAUDE.md §3.6, §5.3). It throwing rolls the write back.
 */
@Injectable()
export class PageRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Create a page shell (draft, no version). */
  async createPage(
    data: PageWriteData,
    onPersist?: (tx: PrismaTransactionClient, created: PageRow) => Promise<void>,
  ): Promise<PageRow> {
    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const created = (await tx.page.create({
        data: { slug: data.slug, title: data.title },
        select: PAGE_SELECT,
      })) as PageRow;
      if (onPersist !== undefined) await onPersist(tx, created);
      return created;
    });
  }

  /** Shallow page row by slug, or null. */
  async findPageBySlug(slug: string): Promise<PageRow | null> {
    return (await this.prisma.page.findUnique({
      where: { slug },
      select: PAGE_SELECT,
    })) as PageRow | null;
  }

  /** Shallow page row by id, or null. */
  async findPage(id: string): Promise<PageRow | null> {
    return (await this.prisma.page.findUnique({
      where: { id },
      select: PAGE_SELECT,
    })) as PageRow | null;
  }

  /** Matching pages ordered by `createdAt` descending (newest first). */
  async listPages(filter: {
    readonly status?: ContentStatus | undefined;
    readonly limit: number;
  }): Promise<readonly PageRow[]> {
    const where: Record<string, unknown> = {};
    if (filter.status !== undefined) where['status'] = filter.status;

    return (await this.prisma.page.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit,
      select: PAGE_SELECT,
    })) as PageRow[];
  }

  /** Page + its versions (newest-first), or null when no page resolves. */
  async findDetail(id: string): Promise<PageDetailRows | null> {
    const page = await this.findPage(id);
    if (page === null) return null;

    const versions = (await this.prisma.pageVersion.findMany({
      where: { pageId: id },
      orderBy: [{ versionNo: 'desc' }],
      select: VERSION_SELECT,
    })) as PageVersionRow[];

    return { page, versions };
  }

  /**
   * Append a new version, assigning the next monotonic `versionNo` per page
   * inside the transaction (read the current max, then insert max + 1). The
   * `page_versions_page_id_version_no_key` unique index is the backstop against
   * a concurrent double-append.
   */
  async appendVersion(
    pageId: string,
    data: PageVersionWriteData,
    onPersist?: (tx: PrismaTransactionClient, created: PageVersionRow) => Promise<void>,
  ): Promise<PageVersionRow> {
    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const last = (await tx.pageVersion.findFirst({
        where: { pageId },
        orderBy: [{ versionNo: 'desc' }],
        select: { versionNo: true },
      })) as { versionNo: number } | null;
      const versionNo = (last?.versionNo ?? 0) + 1;

      const created = (await tx.pageVersion.create({
        data: { pageId, versionNo, title: data.title, body: data.body, createdBy: data.createdBy },
        select: VERSION_SELECT,
      })) as PageVersionRow;
      if (onPersist !== undefined) await onPersist(tx, created);
      return created;
    });
  }

  /** A version scoped to its page, or null when it does not resolve. */
  async findVersion(pageId: string, versionId: string): Promise<PageVersionRow | null> {
    return (await this.prisma.pageVersion.findFirst({
      where: { id: versionId, pageId },
      select: VERSION_SELECT,
    })) as PageVersionRow | null;
  }

  /**
   * Publish a version: stamp its `effectiveAt` (+ the TS-285 material-change
   * flag / note), repoint the page's `currentVersionId`, and move the page to
   * `published` — all in one transaction. `onPersist` runs inside it (the
   * audit-outbox append, plus — for a material change — the
   * `content.page.material_changed` append).
   */
  async publishVersion(
    pageId: string,
    versionId: string,
    publish: PublishWriteData,
    onPersist?: (tx: PrismaTransactionClient, result: PublishResultRows) => Promise<void>,
  ): Promise<PublishResultRows> {
    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const version = (await tx.pageVersion.update({
        where: { id: versionId },
        data: {
          effectiveAt: publish.effectiveAt,
          isMaterialChange: publish.isMaterialChange,
          materialChangeNote: publish.materialChangeNote,
        },
        select: VERSION_SELECT,
      })) as PageVersionRow;

      const page = (await tx.page.update({
        where: { id: pageId },
        data: { currentVersionId: versionId, status: 'published' },
        select: PAGE_SELECT,
      })) as PageRow;

      const result = { page, version };
      if (onPersist !== undefined) await onPersist(tx, result);
      return result;
    });
  }
}
