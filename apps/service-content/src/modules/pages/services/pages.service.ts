import { Injectable, Logger } from '@nestjs/common';
import type {
  ContentStatus,
  CreatePageRequest,
  CreatePageVersionRequest,
  PageDetail,
  PageRecord,
  PageVersionRecord,
} from '@taste-and-see/contracts';
import type { OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import { AuditEmitter } from '@taste-and-see/nest-audit';
import { CONTENT_AUDIT_RESOURCE } from '../../audit/audit-resources';
import { ContentLegalEmitter } from '../../audit/content-legal-emitter';
import type { AuditActorContext } from '@taste-and-see/nest-audit';
import { PageRepository, type PageRow, type PageVersionRow } from '../repositories/page.repository';

export interface CreatePageInput extends CreatePageRequest {
  readonly actorUserId: string;
  readonly audit: AuditActorContext;
}

export interface AppendVersionInput extends CreatePageVersionRequest {
  readonly pageId: string;
  readonly actorUserId: string;
  readonly audit: AuditActorContext;
}

export interface PublishVersionInput {
  readonly pageId: string;
  readonly versionId: string;
  /** Explicit compliance-effective date, or undefined = "effective now". */
  readonly effectiveAt: string | undefined;
  /** TS-285: mark this publish a material change (emits the notification event). */
  readonly isMaterialChange?: boolean | undefined;
  /** TS-285: the editor's material-change note (only meaningful when material). */
  readonly materialChangeNote?: string | undefined;
  readonly actorUserId: string;
  readonly audit: AuditActorContext;
}

export interface ListPagesInput {
  readonly status?: ContentStatus | undefined;
  readonly limit: number;
}

export type CreatePageOutcome =
  | { readonly ok: true; readonly page: PageRecord }
  | { readonly ok: false; readonly reason: 'slug_conflict' };

export type AppendVersionOutcome =
  | { readonly ok: true; readonly version: PageVersionRecord }
  | { readonly ok: false; readonly reason: 'page_not_found' };

export type PublishVersionOutcome =
  | { readonly ok: true; readonly page: PageRecord }
  | { readonly ok: false; readonly reason: 'page_not_found' }
  | { readonly ok: false; readonly reason: 'version_not_found' }
  | { readonly ok: false; readonly reason: 'page_archived' };

export type GetPageOutcome =
  | { readonly ok: true; readonly page: PageDetail }
  | { readonly ok: false; readonly reason: 'not_found' };

export type GetVersionOutcome =
  | { readonly ok: true; readonly version: PageVersionRecord }
  | { readonly ok: false; readonly reason: 'not_found' };

/**
 * Static-pages admin service (TS-284; PRD §10.11; PDD §19.2).
 *
 * Owns the page aggregate's domain decisions: slug-uniqueness on create,
 * monotonic per-page version numbering (delegated to the repo's
 * read-max-then-insert inside a transaction), and the publish lifecycle
 * (stamp `effectiveAt` + repoint the live head + move the page to `published`,
 * blocked on an archived page). Every mutation emits `audit.action_recorded`
 * atomically with the write (CLAUDE.md §3.6). Authorisation lives at the
 * controller boundary (`content:read` / `content:edit` / `content:publish`).
 */
@Injectable()
export class PagesService {
  private readonly logger = new Logger(PagesService.name);

  constructor(
    private readonly repo: PageRepository,
    private readonly audit: AuditEmitter,
    private readonly legal: ContentLegalEmitter,
  ) {}

  /** Create a page shell in `draft`. A duplicate slug is a 409. */
  async createPage(input: CreatePageInput): Promise<CreatePageOutcome> {
    const existing = await this.repo.findPageBySlug(input.slug);
    if (existing !== null) return { ok: false, reason: 'slug_conflict' };

    const created = await this.repo.createPage(
      { slug: input.slug, title: input.title },
      async (tx, row) => {
        await this.audit.emit(tx as unknown as OutboxRawExecutor, input.audit, {
          action: 'content_page:create',
          resourceKind: CONTENT_AUDIT_RESOURCE.page,
          resourceId: row.id,
          before: null,
          after: toPageRecord(row),
        });
      },
    );

    this.logger.log(
      { pageId: created.id, slug: created.slug, actorUserId: input.actorUserId },
      'content page created',
    );
    return { ok: true, page: toPageRecord(created) };
  }

  /** Append a new revision to a page. A missing page is a 404. */
  async appendVersion(input: AppendVersionInput): Promise<AppendVersionOutcome> {
    const page = await this.repo.findPage(input.pageId);
    if (page === null) return { ok: false, reason: 'page_not_found' };

    const created = await this.repo.appendVersion(
      input.pageId,
      { title: input.title, body: input.body, createdBy: input.actorUserId },
      async (tx, row) => {
        await this.audit.emit(tx as unknown as OutboxRawExecutor, input.audit, {
          action: 'content_page_version:create',
          resourceKind: CONTENT_AUDIT_RESOURCE.pageVersion,
          resourceId: row.id,
          before: null,
          after: toVersionRecord(row),
        });
      },
    );

    this.logger.log(
      {
        pageId: input.pageId,
        versionId: created.id,
        versionNo: created.versionNo,
        actorUserId: input.actorUserId,
      },
      'content page version appended',
    );
    return { ok: true, version: toVersionRecord(created) };
  }

  /**
   * Publish a version live. Resolution order:
   *   1. `page_not_found` — the page does not resolve.
   *   2. `version_not_found` — the version does not resolve on that page.
   *   3. `page_archived` — an archived page cannot be (re)published.
   * Only then does the write fire (stamp `effectiveAt`, repoint the head,
   * move the page to `published`).
   */
  async publishVersion(input: PublishVersionInput): Promise<PublishVersionOutcome> {
    const page = await this.repo.findPage(input.pageId);
    if (page === null) return { ok: false, reason: 'page_not_found' };

    const version = await this.repo.findVersion(input.pageId, input.versionId);
    if (version === null) return { ok: false, reason: 'version_not_found' };

    if (page.status === 'archived') return { ok: false, reason: 'page_archived' };

    const effectiveAt = input.effectiveAt !== undefined ? new Date(input.effectiveAt) : new Date();
    const isMaterialChange = input.isMaterialChange === true;
    // A note only rides a material change; drop it otherwise (the DTO already
    // rejects a note without the flag, so this is belt-and-suspenders).
    const materialChangeNote =
      isMaterialChange && input.materialChangeNote !== undefined ? input.materialChangeNote : null;
    const before = toPageRecord(page);
    const result = await this.repo.publishVersion(
      input.pageId,
      input.versionId,
      { effectiveAt, isMaterialChange, materialChangeNote },
      async (tx, rows) => {
        // Audit trail — every publish, atomic with the state change.
        await this.audit.emit(tx as unknown as OutboxRawExecutor, input.audit, {
          action: 'content_page:publish',
          resourceKind: CONTENT_AUDIT_RESOURCE.page,
          resourceId: rows.page.id,
          before,
          after: toPageRecord(rows.page),
        });
        // TS-285: a MATERIAL publish additionally queues the subscriber
        // notification onto the outbox, in the SAME transaction — the change
        // cannot go live without its notice being durably queued (CLAUDE.md §5.3).
        if (isMaterialChange) {
          await this.legal.emit(tx as unknown as OutboxRawExecutor, {
            pageId: rows.page.id,
            pageVersionId: rows.version.id,
            slug: rows.page.slug,
            versionNo: rows.version.versionNo,
            effectiveAt: (rows.version.effectiveAt ?? effectiveAt).toISOString(),
            materialChangeNote,
          });
        }
      },
    );

    this.logger.log(
      {
        pageId: input.pageId,
        versionId: input.versionId,
        versionNo: result.version.versionNo,
        effectiveAt: effectiveAt.toISOString(),
        isMaterialChange,
        actorUserId: input.actorUserId,
      },
      'content page version published',
    );
    return { ok: true, page: toPageRecord(result.page) };
  }

  /** Matching pages ordered by `createdAt` descending. */
  async listPages(input: ListPagesInput): Promise<readonly PageRecord[]> {
    const rows = await this.repo.listPages({ status: input.status, limit: input.limit });
    return rows.map(toPageRecord);
  }

  /** Page detail with its version history (newest-first). */
  async getPageDetail(pageId: string): Promise<GetPageOutcome> {
    const detail = await this.repo.findDetail(pageId);
    if (detail === null) return { ok: false, reason: 'not_found' };

    const page: PageDetail = {
      ...toPageRecord(detail.page),
      versions: detail.versions.map(toVersionRecord),
    };
    return { ok: true, page };
  }

  /** A single version (the compliance-reachable read). A miss is a 404. */
  async getVersion(pageId: string, versionId: string): Promise<GetVersionOutcome> {
    const version = await this.repo.findVersion(pageId, versionId);
    if (version === null) return { ok: false, reason: 'not_found' };
    return { ok: true, version: toVersionRecord(version) };
  }
}

// ─── Row → wire-record mappers ──────────────────────────────────────────

/** Project a persisted page row into the wire `PageRecord`. */
export function toPageRecord(row: PageRow): PageRecord {
  return {
    id: row.id,
    slug: row.slug,
    status: row.status,
    title: row.title,
    currentVersionId: row.currentVersionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Project a persisted version row into the wire `PageVersionRecord`. */
export function toVersionRecord(row: PageVersionRow): PageVersionRecord {
  return {
    id: row.id,
    pageId: row.pageId,
    versionNo: row.versionNo,
    title: row.title,
    body: row.body,
    effectiveAt: row.effectiveAt === null ? null : row.effectiveAt.toISOString(),
    isMaterialChange: row.isMaterialChange,
    materialChangeNote: row.materialChangeNote,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
