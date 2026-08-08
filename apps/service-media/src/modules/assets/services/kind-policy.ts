import {
  MEDIA_MAX_IMAGE_SIZE_BYTES,
  MEDIA_MAX_PDF_SIZE_BYTES,
  MEDIA_MAX_VIDEO_SIZE_BYTES,
  type MediaAssetKind,
} from '@taste-and-see/contracts';

/**
 * Per-kind upload policy (TS-110).
 *
 * The contract's `IssueUploadUrlRequestSchema` caps the declared size
 * at `MEDIA_MAX_SIZE_BYTES` (the outermost ceiling). The service layer
 * applies the per-kind cap before minting the signed URL — a 199 MiB
 * "memory recipe image" is a malformed request even though the contract
 * cap would let it through.
 *
 * The per-kind MIME allow-list is enforced at the same gate. The
 * magic-byte detector (downstream in the media-processor) is the
 * authoritative check — this is the inbound gate that keeps the row
 * count honest.
 *
 * Open-world MIMEs (e.g. HEIC variants) are deliberately rolled into
 * the AVIF bucket by the magic-byte detector (see its doc-comment).
 */
export interface KindPolicy {
  readonly maxBytes: number;
  readonly allowedMimes: readonly string[];
}

const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'] as const;

const PDF_MIMES = ['application/pdf'] as const;

const VIDEO_MIMES = ['video/mp4', 'video/webm'] as const;

const PDF_OR_IMAGE_MIMES = [...IMAGE_MIMES, ...PDF_MIMES] as const;

const POLICIES: Record<MediaAssetKind, KindPolicy> = {
  senior_photo: {
    maxBytes: MEDIA_MAX_IMAGE_SIZE_BYTES,
    allowedMimes: IMAGE_MIMES,
  },
  provider_profile_photo: {
    maxBytes: MEDIA_MAX_IMAGE_SIZE_BYTES,
    allowedMimes: IMAGE_MIMES,
  },
  provider_video_intro: {
    maxBytes: MEDIA_MAX_VIDEO_SIZE_BYTES,
    allowedMimes: VIDEO_MIMES,
  },
  memory_recipe_image: {
    maxBytes: MEDIA_MAX_IMAGE_SIZE_BYTES,
    allowedMimes: IMAGE_MIMES,
  },
  provider_document: {
    maxBytes: MEDIA_MAX_PDF_SIZE_BYTES,
    allowedMimes: PDF_MIMES,
  },
  certification_evidence: {
    maxBytes: MEDIA_MAX_PDF_SIZE_BYTES,
    allowedMimes: PDF_OR_IMAGE_MIMES,
  },
  academy_lesson_attachment: {
    maxBytes: MEDIA_MAX_PDF_SIZE_BYTES,
    allowedMimes: PDF_OR_IMAGE_MIMES,
  },
};

export function getKindPolicy(kind: MediaAssetKind): KindPolicy {
  const policy = POLICIES[kind];
  // Exhaustive switch — Prisma enum + Zod enum are kept in sync; a new
  // kind without a policy here is a compile error because of the
  // explicit Record<MediaAssetKind, KindPolicy> declaration above.
  return policy;
}

/**
 * Exhaustive read-only view of the policy table. Exported for tests.
 */
export const KIND_POLICIES: Readonly<Record<MediaAssetKind, KindPolicy>> = POLICIES;
