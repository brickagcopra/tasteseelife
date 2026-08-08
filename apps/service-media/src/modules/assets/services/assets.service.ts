import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import {
  type IssueUploadUrlRequest,
  type IssueUploadUrlResponse,
  type MediaAssetKind,
  type MediaAssetResponse,
  type MediaAssetStatus,
  type MediaOwnerScopeKind,
  type MediaScanStatus,
  type RecordAssetEventRequest,
  type RecordAssetEventResponse,
  type SeniorPhoto,
  type SeniorPhotoGalleryResponse,
} from '@taste-and-see/contracts';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';
import { getKindPolicy } from './kind-policy';
import { SignedUrlIssuerService } from './signed-url-issuer.service';

/**
 * Orchestrates the TS-110 surfaces:
 *
 *   - `issueUploadUrl(actorUserId, input)` — mint a signed URL, persist
 *     an `awaiting_upload` row, return the upload coords + the asset
 *     metadata.
 *
 *   - `getAssetById(id)` — read-side lookup. Mints a fresh delivery URL
 *     per call (so the URL is never persistently shareable).
 *
 *   - `recordAssetEvent(input)` — internal ingest from the
 *     media-processor (TS-110-followup-1). Idempotent on
 *     `(asset_id, event_kind)`; advances the asset state machine.
 *
 *   - `listAssets(query)` — admin read with kind / status / owner
 *     filters and cursor pagination.
 *
 * Authorization is enforced upstream by `AccessTokenGuard` /
 * `InternalSharedSecretGuard`. Row-level checks (e.g. "is this user a
 * member of household X?") are deferred to TS-110-followup-9 — today
 * the service trusts the `actorUserId` for the audit trail and falls
 * back to "the asset's `ownerUserId` is the actor" for read gating.
 *
 * Domain events (`media.asset_uploaded`, `media.asset_ready`, etc.) via
 * the outbox are deferred to TS-110-followup-8.
 */
@Injectable()
export class AssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly urls: SignedUrlIssuerService,
  ) {}

  // ─── Mutations ────────────────────────────────────────────────────────

  async issueUploadUrl(
    actorUserId: string,
    input: IssueUploadUrlRequest,
    now: Date = new Date(),
  ): Promise<IssueUploadUrlResponse> {
    const policy = getKindPolicy(input.kind);

    if (!policy.allowedMimes.includes(input.declaredMime)) {
      throw new IssueUploadUrlFailure({
        code: 'declared_mime_not_allowed',
        detail: `declared MIME ${input.declaredMime} is not allowed for kind ${input.kind}`,
      });
    }

    if (input.declaredSizeBytes > policy.maxBytes) {
      throw new IssueUploadUrlFailure({
        code: 'declared_size_exceeds_kind_cap',
        detail: `declared size ${input.declaredSizeBytes} exceeds the kind cap of ${policy.maxBytes} bytes`,
      });
    }

    // Pre-generate the asset id so the storage key is computable
    // before the INSERT. The migration trigger forbids any UPDATE that
    // changes `storage_key` (defence-in-depth against audit-trail
    // corruption) — so the canonical storage key MUST be set on the
    // INSERT itself. The id is a 24-char base64url-encoded 16-byte
    // random suffix — same cardinality as `@default(cuid())` and
    // collision-resistant for the lifetime of the platform.
    const assetId = generateAssetId();
    const storageKey = this.urls.buildStorageKey({
      kind: input.kind,
      assetId,
      now,
    });
    const signed = this.urls.issueUploadUrl({
      storageBucket: this.urls.bucketName,
      storageKey,
      declaredMime: input.declaredMime,
      declaredSizeBytes: input.declaredSizeBytes,
      now,
    });

    const created = await this.prisma.mediaAsset.create({
      data: {
        id: assetId,
        ownerUserId: actorUserId,
        ownerScopeKind: input.ownerScope.kind,
        ownerScopeId: input.ownerScope.id,
        kind: input.kind,
        status: 'awaiting_upload',
        scanStatus: 'pending',
        declaredMime: input.declaredMime,
        declaredFileName: input.declaredFileName ?? null,
        declaredSizeBytes: BigInt(input.declaredSizeBytes),
        storageBucket: this.urls.bucketName,
        storageKey,
        liveMode: this.urls.liveMode,
        uploadUrlExpiresAt: signed.expiresAt,
      },
      select: ASSET_SELECT,
    });
    return {
      asset: this.toResponse(created, now),
      uploadUrl: signed.url,
      uploadMethod: signed.method,
      requiredHeaders: signed.requiredHeaders,
      expiresAt: signed.expiresAt.toISOString(),
      liveMode: this.urls.liveMode,
    };
  }

  // ─── Reads ────────────────────────────────────────────────────────────

  async getAssetById(id: string, now: Date = new Date()): Promise<MediaAssetResponse | null> {
    const row = await this.prisma.mediaAsset.findUnique({
      where: { id },
      select: ASSET_SELECT,
    });
    if (row === null) return null;
    return this.toResponse(row, now);
  }

  async listAssets(query: ListAssetsArgs, now: Date = new Date()): Promise<ListAssetsResult> {
    const limit = query.limit;
    const cursorRow = query.cursor === undefined ? null : decodeCursor(query.cursor);

    const rows = await this.prisma.mediaAsset.findMany({
      where: {
        ...(query.kind !== undefined && { kind: query.kind }),
        ...(query.status !== undefined && { status: query.status }),
        ...(query.ownerScopeKind !== undefined && { ownerScopeKind: query.ownerScopeKind }),
        ...(query.ownerScopeId !== undefined && { ownerScopeId: query.ownerScopeId }),
        ...(cursorRow !== null && {
          OR: [
            { createdAt: { lt: cursorRow.createdAt } },
            {
              AND: [{ createdAt: cursorRow.createdAt }, { id: { lt: cursorRow.id } }],
            },
          ],
        }),
      },
      take: limit + 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: ASSET_SELECT,
    });

    const sliced = rows.slice(0, limit);
    const next = rows.length > limit ? rows[limit] : null;
    const nextCursor =
      next === undefined || next === null
        ? null
        : encodeCursor({ createdAt: next.createdAt, id: next.id });
    return {
      rows: sliced.map((r: AssetRow) => this.toResponse(r, now)),
      nextCursor,
    };
  }

  /**
   * Family photo-gallery read (TS-232). Lists a senior's *shareable*
   * photos — `senior_photo` kind, `ready` status, owner-scope
   * `senior:<seniorId>`, with a non-null delivery key — newest-first,
   * cursor-paginated. Each row is projected to the trimmed `SeniorPhoto`
   * shape (a fresh short-lived delivery URL minted per read), withholding
   * the asset internals (`ownerUserId` / `storageKey` / `sha256` / scan
   * fields) that `getAssetById` exposes to the owner.
   *
   * **No consent / membership gate here.** media-svc has no household-
   * membership or consent knowledge. The api-gateway aggregator applies
   * the senior's `photos` consent flag (TS-238) before calling this
   * surface — that, plus the household-membership check the consent read
   * performs, is the authorization gate (TS-232). The in-service gate
   * (cross-service consent lookup) is the carved TS-110-followup-10; the
   * in-service membership check is TS-110-followup-9. This endpoint sits
   * behind `AccessTokenGuard` so it is never anonymously reachable, and
   * is only addressable internally via the gateway.
   *
   * Index: the `media_assets_scope_created_idx`
   * `(owner_scope_kind, owner_scope_id, created_at DESC)` covers the
   * leading predicate + the sort; `kind` / `status` / `delivery_key` are
   * cheap residual filters within a single senior's (small) asset set.
   */
  async listSeniorPhotos(
    seniorId: string,
    args: ListSeniorPhotosArgs,
    now: Date = new Date(),
  ): Promise<SeniorPhotoGalleryResponse> {
    const limit = args.limit;
    const cursorRow = args.cursor === undefined ? null : decodeCursor(args.cursor);

    const rows = await this.prisma.mediaAsset.findMany({
      where: {
        ownerScopeKind: 'senior',
        ownerScopeId: seniorId,
        kind: 'senior_photo',
        status: 'ready',
        deliveryKey: { not: null },
        ...(cursorRow !== null && {
          OR: [
            { createdAt: { lt: cursorRow.createdAt } },
            { AND: [{ createdAt: cursorRow.createdAt }, { id: { lt: cursorRow.id } }] },
          ],
        }),
      },
      take: limit + 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: SENIOR_PHOTO_SELECT,
    });

    // Keyset pagination: take `limit + 1` to detect a further page, but
    // anchor the cursor on the LAST row of THIS page (not the peek row)
    // so the next query's strict `<` comparator starts immediately after
    // it — no row is skipped at the page boundary.
    const hasMore = rows.length > limit;
    const sliced = rows.slice(0, limit);
    const lastRow = sliced.length > 0 ? sliced[sliced.length - 1] : undefined;
    const nextCursor =
      hasMore && lastRow !== undefined
        ? encodeCursor({ createdAt: lastRow.createdAt, id: lastRow.id })
        : null;

    return {
      seniorId,
      photos: sliced.map((r: SeniorPhotoRow) => this.toSeniorPhoto(r, now)),
      nextCursor,
    };
  }

  // ─── Internal ingest ──────────────────────────────────────────────────

  async recordAssetEvent(
    input: RecordAssetEventRequest,
    now: Date = new Date(),
  ): Promise<RecordAssetEventResponse> {
    const occurredAt = new Date(input.occurredAt);
    // Explicit callback return type: without it the `return { outcome:
    // 'replayed', ... }` / `{ outcome: 'applied', ... }` literals have no
    // contextual type, so `outcome` widens from the literal to `string`
    // and no longer satisfies `RecordAssetEventResponse` (TS-501).
    return this.prisma.$transaction(
      async (tx: PrismaTransactionClient): Promise<RecordAssetEventResponse> => {
        const existing = await tx.mediaAssetEvent.findUnique({
          where: {
            assetId_eventKind: { assetId: input.assetId, eventKind: input.eventKind },
          },
          select: { id: true },
        });
        if (existing !== null) {
          const asset = await tx.mediaAsset.findUnique({
            where: { id: input.assetId },
            select: ASSET_SELECT,
          });
          if (asset === null) {
            throw new RecordAssetEventFailure({
              code: 'asset_not_found',
              detail: `asset ${input.assetId} not found`,
            });
          }
          return { outcome: 'replayed', asset: this.toResponse(asset, now) };
        }

        const asset = await tx.mediaAsset.findUnique({
          where: { id: input.assetId },
          select: ASSET_SELECT,
        });
        if (asset === null) {
          throw new RecordAssetEventFailure({
            code: 'asset_not_found',
            detail: `asset ${input.assetId} not found`,
          });
        }

        // Compute the next state from the event kind. The transitions
        // mirror the contract doc-comment on `MediaAssetEventKindSchema`.
        const next = computeNextState(asset.status, asset.scanStatus, input);
        if (next === null) {
          throw new RecordAssetEventFailure({
            code: 'event_not_applicable',
            detail: `event ${input.eventKind} is not applicable to asset in status ${asset.status}`,
          });
        }

        await tx.mediaAssetEvent.create({
          data: {
            assetId: input.assetId,
            eventKind: input.eventKind,
            occurredAt,
            detectedMime: input.detectedMime ?? null,
            sha256: input.sha256 ?? null,
            sizeBytes: input.sizeBytes === undefined ? null : BigInt(input.sizeBytes),
            width: input.width ?? null,
            height: input.height ?? null,
            deliveryKey: input.deliveryKey ?? null,
            reason: input.reason ?? null,
          },
        });

        const updated = await tx.mediaAsset.update({
          where: { id: input.assetId },
          data: {
            status: next.status,
            scanStatus: next.scanStatus,
            ...(next.detectedMime !== undefined && { detectedMime: next.detectedMime }),
            ...(next.actualSizeBytes !== undefined && {
              actualSizeBytes: BigInt(next.actualSizeBytes),
            }),
            ...(next.sha256 !== undefined && { sha256: next.sha256 }),
            ...(next.width !== undefined && { width: next.width }),
            ...(next.height !== undefined && { height: next.height }),
            ...(next.deliveryKey !== undefined && { deliveryKey: next.deliveryKey }),
            ...(next.scanReason !== undefined && { scanReason: next.scanReason }),
            ...(next.uploadedAt !== undefined && { uploadedAt: next.uploadedAt }),
            ...(next.scannedAt !== undefined && { scannedAt: next.scannedAt }),
            ...(next.processedAt !== undefined && { processedAt: next.processedAt }),
          },
          select: ASSET_SELECT,
        });
        return { outcome: 'applied', asset: this.toResponse(updated, now) };
      },
    );
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  /**
   * Project a `ready` senior-photo row to the trimmed `SeniorPhoto`
   * gallery item, minting a fresh short-lived delivery URL. Callers pass
   * only rows already filtered to `status='ready'` + `deliveryKey != null`,
   * so the minted URL is always present.
   */
  private toSeniorPhoto(row: SeniorPhotoRow, now: Date): SeniorPhoto {
    const minted = this.urls.issueDeliveryUrl({
      storageBucket: row.storageBucket,
      // Filtered to `deliveryKey != null` at the query layer; the fallback
      // to storageKey is unreachable defence so the type narrows without a
      // non-null assertion.
      deliveryKey: row.deliveryKey ?? row.storageKey,
      now,
    });
    return {
      id: row.id,
      signedDeliveryUrl: minted.url,
      signedDeliveryUrlExpiresAt: minted.expiresAt.toISOString(),
      width: row.width,
      height: row.height,
      declaredFileName: row.declaredFileName,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toResponse(row: AssetRow, now: Date): MediaAssetResponse {
    const isReady = row.status === 'ready' && row.deliveryKey !== null;
    let signedDeliveryUrl: string | null = null;
    let signedDeliveryUrlExpiresAt: string | null = null;
    if (isReady && row.deliveryKey !== null) {
      const minted = this.urls.issueDeliveryUrl({
        storageBucket: row.storageBucket,
        deliveryKey: row.deliveryKey,
        now,
      });
      signedDeliveryUrl = minted.url;
      signedDeliveryUrlExpiresAt = minted.expiresAt.toISOString();
    }
    return {
      id: row.id,
      kind: row.kind,
      ownerUserId: row.ownerUserId,
      ownerScopeKind: row.ownerScopeKind,
      ownerScopeId: row.ownerScopeId,
      status: row.status,
      scanStatus: row.scanStatus,
      scanReason: row.scanReason,
      declaredMime: row.declaredMime,
      detectedMime: row.detectedMime,
      declaredFileName: row.declaredFileName,
      declaredSizeBytes: Number(row.declaredSizeBytes),
      actualSizeBytes: row.actualSizeBytes === null ? null : Number(row.actualSizeBytes),
      width: row.width,
      height: row.height,
      sha256: row.sha256,
      storageBucket: row.storageBucket,
      storageKey: row.storageKey,
      deliveryKey: row.deliveryKey,
      signedDeliveryUrl,
      signedDeliveryUrlExpiresAt,
      liveMode: row.liveMode,
      uploadUrlExpiresAt: row.uploadUrlExpiresAt.toISOString(),
      uploadedAt: row.uploadedAt === null ? null : row.uploadedAt.toISOString(),
      scannedAt: row.scannedAt === null ? null : row.scannedAt.toISOString(),
      processedAt: row.processedAt === null ? null : row.processedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

export interface ListAssetsArgs {
  readonly limit: number;
  readonly kind?: MediaAssetKind;
  readonly status?: MediaAssetStatus;
  readonly ownerScopeKind?: MediaOwnerScopeKind;
  readonly ownerScopeId?: string;
  readonly cursor?: string;
}

export interface ListAssetsResult {
  readonly rows: readonly MediaAssetResponse[];
  readonly nextCursor: string | null;
}

export interface ListSeniorPhotosArgs {
  readonly limit: number;
  readonly cursor?: string;
}

export type IssueUploadUrlFailureCode =
  | 'declared_mime_not_allowed'
  | 'declared_size_exceeds_kind_cap'
  | 'unreachable';

export class IssueUploadUrlFailure extends Error {
  readonly code: IssueUploadUrlFailureCode;
  readonly detail: string;
  constructor(args: { code: IssueUploadUrlFailureCode; detail: string }) {
    super(args.detail);
    this.name = 'IssueUploadUrlFailure';
    this.code = args.code;
    this.detail = args.detail;
  }
}

export type RecordAssetEventFailureCode = 'asset_not_found' | 'event_not_applicable';

export class RecordAssetEventFailure extends Error {
  readonly code: RecordAssetEventFailureCode;
  readonly detail: string;
  constructor(args: { code: RecordAssetEventFailureCode; detail: string }) {
    super(args.detail);
    this.name = 'RecordAssetEventFailure';
    this.code = args.code;
    this.detail = args.detail;
  }
}

// ─── Prisma row shape ─────────────────────────────────────────────────

/**
 * The shape of a `mediaAsset` row as projected by `ASSET_SELECT`.
 * Locally-declared rather than imported from `@prisma/client` because of
 * the same TS-021-followup-2 namespace resolution issue documented
 * throughout the codebase — the local interface lets us narrow without
 * the value-side `Prisma` import.
 */
interface AssetRow {
  id: string;
  ownerUserId: string;
  ownerScopeKind: MediaOwnerScopeKind;
  ownerScopeId: string;
  kind: MediaAssetKind;
  status: MediaAssetStatus;
  scanStatus: MediaScanStatus;
  scanReason: string | null;
  declaredMime: string;
  detectedMime: string | null;
  declaredFileName: string | null;
  declaredSizeBytes: bigint;
  actualSizeBytes: bigint | null;
  width: number | null;
  height: number | null;
  sha256: string | null;
  storageBucket: string;
  storageKey: string;
  deliveryKey: string | null;
  liveMode: boolean;
  uploadUrlExpiresAt: Date;
  uploadedAt: Date | null;
  scannedAt: Date | null;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const ASSET_SELECT = {
  id: true,
  ownerUserId: true,
  ownerScopeKind: true,
  ownerScopeId: true,
  kind: true,
  status: true,
  scanStatus: true,
  scanReason: true,
  declaredMime: true,
  detectedMime: true,
  declaredFileName: true,
  declaredSizeBytes: true,
  actualSizeBytes: true,
  width: true,
  height: true,
  sha256: true,
  storageBucket: true,
  storageKey: true,
  deliveryKey: true,
  liveMode: true,
  uploadUrlExpiresAt: true,
  uploadedAt: true,
  scannedAt: true,
  processedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * The narrow column set the senior-photo gallery read projects — just
 * what `toSeniorPhoto` needs to render a thumbnail + paginate. No
 * `SELECT *` (CLAUDE.md §4.1); the asset internals never leave the
 * service for this surface.
 */
interface SeniorPhotoRow {
  id: string;
  storageBucket: string;
  storageKey: string;
  deliveryKey: string | null;
  width: number | null;
  height: number | null;
  declaredFileName: string | null;
  createdAt: Date;
}

const SENIOR_PHOTO_SELECT = {
  id: true,
  storageBucket: true,
  storageKey: true,
  deliveryKey: true,
  width: true,
  height: true,
  declaredFileName: true,
  createdAt: true,
} as const;

// ─── State machine ────────────────────────────────────────────────────

interface NextState {
  readonly status: MediaAssetStatus;
  readonly scanStatus: MediaScanStatus;
  readonly detectedMime?: string;
  readonly actualSizeBytes?: number;
  readonly sha256?: string;
  readonly width?: number;
  readonly height?: number;
  readonly deliveryKey?: string;
  readonly scanReason?: string;
  readonly uploadedAt?: Date;
  readonly scannedAt?: Date;
  readonly processedAt?: Date;
}

/**
 * Pure helper exported for tests.
 *
 *   upload_completed:   awaiting_upload → uploaded
 *   magic_byte_passed:  uploaded         → scanning           (detected_mime, sha256, size)
 *   magic_byte_failed:  uploaded         → rejected           (scan_reason)
 *   scan_passed:        scanning         → scanning           (no status flip; awaits process_passed)
 *   scan_failed:        scanning         → rejected           (scanStatus=infected, scan_reason)
 *   process_passed:     scanning|ready   → ready              (width, height, delivery_key, scanStatus=clean)
 *   process_failed:     scanning|ready   → failed             (scan_reason)
 *   expired:            awaiting_upload  → expired
 */
export function computeNextState(
  currentStatus: MediaAssetStatus,
  currentScanStatus: MediaScanStatus,
  input: RecordAssetEventRequest,
): NextState | null {
  const occurredAt = new Date(input.occurredAt);
  switch (input.eventKind) {
    case 'upload_completed':
      if (currentStatus !== 'awaiting_upload') return null;
      return {
        status: 'uploaded',
        scanStatus: currentScanStatus,
        uploadedAt: occurredAt,
        ...(input.sizeBytes !== undefined && { actualSizeBytes: input.sizeBytes }),
      };
    case 'magic_byte_passed':
      if (currentStatus !== 'uploaded') return null;
      return {
        status: 'scanning',
        scanStatus: currentScanStatus,
        ...(input.detectedMime !== undefined && { detectedMime: input.detectedMime }),
        ...(input.sha256 !== undefined && { sha256: input.sha256 }),
        ...(input.sizeBytes !== undefined && { actualSizeBytes: input.sizeBytes }),
      };
    case 'magic_byte_failed':
      if (currentStatus !== 'uploaded') return null;
      return {
        status: 'rejected',
        scanStatus: currentScanStatus,
        scanReason: input.reason ?? 'magic-byte mismatch',
      };
    case 'scan_passed':
      if (currentStatus !== 'scanning') return null;
      return {
        status: 'scanning',
        scanStatus: 'clean',
        scannedAt: occurredAt,
      };
    case 'scan_failed':
      if (currentStatus !== 'scanning') return null;
      return {
        status: 'rejected',
        scanStatus: 'infected',
        scanReason: input.reason ?? 'virus signature match',
        scannedAt: occurredAt,
      };
    case 'process_passed':
      if (currentStatus !== 'scanning' && currentStatus !== 'ready') return null;
      return {
        status: 'ready',
        scanStatus: currentScanStatus === 'pending' ? 'clean' : currentScanStatus,
        processedAt: occurredAt,
        ...(input.deliveryKey !== undefined && { deliveryKey: input.deliveryKey }),
        ...(input.width !== undefined && { width: input.width }),
        ...(input.height !== undefined && { height: input.height }),
      };
    case 'process_failed':
      if (currentStatus !== 'scanning' && currentStatus !== 'ready') return null;
      return {
        status: 'failed',
        scanStatus: currentScanStatus,
        scanReason: input.reason ?? 'processing failed',
        processedAt: occurredAt,
      };
    case 'expired':
      if (currentStatus !== 'awaiting_upload') return null;
      return {
        status: 'expired',
        scanStatus: currentScanStatus,
      };
    default:
      return null;
  }
}

// ─── Cursor pagination ────────────────────────────────────────────────

interface DecodedCursor {
  readonly createdAt: Date;
  readonly id: string;
}

function encodeCursor(c: DecodedCursor): string {
  return Buffer.from(`${c.createdAt.toISOString()}|${c.id}`).toString('base64url');
}

function decodeCursor(raw: string): DecodedCursor | null {
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const [iso, id] = decoded.split('|', 2);
    if (iso === undefined || id === undefined) return null;
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * Generate a base64url-encoded 16-byte random asset id. Same
 * cardinality as `@default(cuid())` (≈10^29 distinct values) and
 * collision-resistant for the platform's lifetime. Distinct from
 * Prisma's default-generation strategy because we need the id BEFORE
 * the INSERT (the storage_key column derives from it, and the
 * append-only trigger forbids any UPDATE that changes the storage_key).
 */
function generateAssetId(): string {
  // 16 random bytes → 22-char base64url. Prepend `m_` so the id is
  // visually distinguishable from other services' cuid-shaped ids in
  // logs / audit trails.
  return `m_${randomBytes(16).toString('base64url')}`;
}
