import type { MediaAssetKind } from '@taste-and-see/contracts';

/**
 * Processing class — which downstream stage handles an asset after the
 * scan passes:
 *
 *   - `image`    → Sharp resize / format-conversion (TS-110-followup-4).
 *   - `video`    → ffmpeg transcode → HLS manifest + poster (TS-201).
 *   - `document` → passthrough (PDF: original bytes become the delivery
 *     object; no Sharp/transcode).
 *
 * The `certification_evidence` / `academy_lesson_attachment` kinds accept
 * BOTH images and PDFs at upload; their processing class is decided from
 * the **detected** MIME (the authoritative magic-byte result), not the
 * kind. `resolveProcessingClass` therefore takes the detected MIME.
 */
export type ProcessingClass = 'image' | 'video' | 'document';

const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'] as const;
const VIDEO_MIMES = ['video/mp4', 'video/webm'] as const;
const PDF_MIMES = ['application/pdf'] as const;

/**
 * Allowed detected-MIME set per asset kind. A **local mirror** of
 * service-media's per-kind `KindPolicy.allowedMimes` (CLAUDE.md §2.3 — the
 * worker can't import another service's module). The magic-byte gate
 * rejects a detected MIME outside this set even when the detector
 * recognised the bytes (e.g. a real MP4 uploaded as a `senior_photo`).
 * Shares the TS-201-followup-5 dedupe-into-`@taste-and-see/media-core`
 * fate with `content-inspector.ts`.
 */
const ALLOWED_MIMES: Readonly<Record<MediaAssetKind, readonly string[]>> = {
  senior_photo: IMAGE_MIMES,
  provider_profile_photo: IMAGE_MIMES,
  provider_video_intro: VIDEO_MIMES,
  memory_recipe_image: IMAGE_MIMES,
  provider_document: PDF_MIMES,
  certification_evidence: [...IMAGE_MIMES, ...PDF_MIMES],
  academy_lesson_attachment: [...IMAGE_MIMES, ...PDF_MIMES],
};

/** Whether `detectedMime` is allowed for `kind` (post-magic-byte gate). */
export function isMimeAllowedForKind(kind: MediaAssetKind, detectedMime: string): boolean {
  return ALLOWED_MIMES[kind].includes(detectedMime);
}

/**
 * Map a detected MIME to its processing class. Returns `null` for a MIME
 * the worker does not know how to process (defensive — the magic-byte
 * gate already rejects unknown MIMEs, so this is unreachable for accepted
 * assets, but keeps the orchestrator's branch total).
 */
export function resolveProcessingClass(detectedMime: string): ProcessingClass | null {
  if ((IMAGE_MIMES as readonly string[]).includes(detectedMime)) return 'image';
  if ((VIDEO_MIMES as readonly string[]).includes(detectedMime)) return 'video';
  if ((PDF_MIMES as readonly string[]).includes(detectedMime)) return 'document';
  return null;
}

/** Exported for tests. */
export const PROCESSING_CLASS_MIMES = {
  image: IMAGE_MIMES,
  video: VIDEO_MIMES,
  document: PDF_MIMES,
} as const;
