import type { MediaAssetKind, RecordAssetEventRequest } from '@taste-and-see/contracts';

/**
 * Ports for the media-processor pipeline (ADR-0002).
 *
 * Every side-effecting stage of the CLAUDE.md §3.4 pipeline is an
 * injectable port so the orchestrator (`MediaProcessorService`) stays
 * pure + fully unit-testable, and the Phase-1 stub implementations swap
 * for live adapters (S3 / ClamAV / Sharp / ffmpeg) behind a stable seam
 * as the deferred follow-ups land. Tokens are symbols so a typo at the
 * `@Inject(...)` site is a TS error.
 */

// ─── The unit of work ───────────────────────────────────────────────────

/**
 * One media asset to process. In live mode an adapter resolves these
 * fields from the S3 object-created event (bucket/key) + a media-svc
 * metadata read (kind/declaredMime/declaredSizeBytes); that resolution
 * is the deferred `JobSource` live wiring (TS-201-followup-2). The
 * orchestrator takes the job as given so its logic is source-agnostic.
 */
export interface MediaProcessingJob {
  readonly assetId: string;
  readonly kind: MediaAssetKind;
  readonly declaredMime: string;
  readonly storageBucket: string;
  readonly storageKey: string;
  readonly declaredSizeBytes: number;
}

// ─── Clock (injected for deterministic `occurredAt` in tests) ────────────

export interface Clock {
  now(): Date;
}
export const CLOCK_TOKEN = Symbol('MEDIA_PROCESSOR_CLOCK');

// ─── Object store ────────────────────────────────────────────────────────

export interface ObjectHead {
  readonly exists: boolean;
  readonly sizeBytes: number;
}

export interface ObjectStorePort {
  /** Confirm the object exists + report its size. */
  headObject(bucket: string, key: string): Promise<ObjectHead>;
  /** Read the first `byteCount` bytes for magic-byte sniffing. */
  readHead(bucket: string, key: string, byteCount: number): Promise<Buffer>;
  /** Lower-case hex SHA-256 of the full object (client-side dedup). */
  sha256(bucket: string, key: string): Promise<string>;
  /** Delete the object (called on magic-byte / virus rejection). */
  deleteObject(bucket: string, key: string): Promise<void>;
}
export const OBJECT_STORE_TOKEN = Symbol('MEDIA_PROCESSOR_OBJECT_STORE');

// ─── Virus scanner ───────────────────────────────────────────────────────

/**
 * `unavailable` is distinct from `infected`: a scanner that cannot finish
 * (timeout, socket closed) must FAIL CLOSED — the asset is rejected, never
 * marked ready (CLAUDE.md §3.4 step 6). The orchestrator maps both
 * `infected` and `unavailable` to a `scan_failed` event (→ `rejected`),
 * with distinct reasons for ops triage.
 */
export type VirusScanResult = 'clean' | 'infected' | 'unavailable';

export interface VirusScannerPort {
  scan(bucket: string, key: string): Promise<VirusScanResult>;
}
export const VIRUS_SCANNER_TOKEN = Symbol('MEDIA_PROCESSOR_VIRUS_SCANNER');

// ─── Image processor (Sharp, deferred) ───────────────────────────────────

export type ImageProcessResult =
  | {
      readonly outcome: 'ok';
      readonly deliveryKey: string;
      readonly width: number;
      readonly height: number;
    }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface ImageProcessInput {
  readonly bucket: string;
  readonly storageKey: string;
  readonly detectedMime: string;
}

export interface ImageProcessorPort {
  /**
   * Resize + format-convert to a delivery variant. Returns `rejected`
   * for a decompression bomb (pixels > `IMAGE_MAX_INPUT_PIXELS`); MAY
   * throw on an unexpected crash — the orchestrator maps a throw to
   * `process_failed`.
   */
  process(input: ImageProcessInput): Promise<ImageProcessResult>;
}
export const IMAGE_PROCESSOR_TOKEN = Symbol('MEDIA_PROCESSOR_IMAGE_PROCESSOR');

// ─── Video transcoder (ffmpeg, deferred — the TS-201 headline) ───────────

export type VideoTranscodeResult =
  | {
      readonly outcome: 'ok';
      /** HLS manifest object key → becomes the asset's `deliveryKey`. */
      readonly hlsManifestKey: string;
      /** Poster thumbnail object key (derived-by-convention from the manifest). */
      readonly posterKey: string;
      readonly posterWidth: number;
      readonly posterHeight: number;
      readonly durationSeconds: number;
    }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface VideoTranscodeInput {
  readonly assetId: string;
  readonly bucket: string;
  readonly storageKey: string;
  readonly detectedMime: string;
  readonly declaredSizeBytes: number;
}

export interface VideoTranscoderPort {
  /**
   * Probe + transcode to an HLS manifest + poster. Returns `rejected`
   * when the source exceeds the transcode-bomb caps
   * (`MEDIA_VIDEO_MAX_DURATION_SECONDS` / `MEDIA_VIDEO_MAX_INPUT_PIXELS`)
   * or carries an unsupported codec — BEFORE any expensive transcode.
   * MAY throw on an unexpected crash — the orchestrator maps a throw to
   * `process_failed`.
   */
  transcode(input: VideoTranscodeInput): Promise<VideoTranscodeResult>;
}
export const VIDEO_TRANSCODER_TOKEN = Symbol('MEDIA_PROCESSOR_VIDEO_TRANSCODER');

// ─── Scan-event client (media-svc internal ingest) ───────────────────────

export interface ScanEventClientPort {
  /**
   * POST a single scan-event to media-svc's internal ingest. Idempotent
   * downstream on `(assetId, eventKind)` — a replay is a no-op success.
   * Throws on a non-2xx / transport failure so the orchestrator can let
   * the job be retried (re-emitting the same events is safe).
   */
  record(event: RecordAssetEventRequest): Promise<void>;
}
export const SCAN_EVENT_CLIENT_TOKEN = Symbol('MEDIA_PROCESSOR_SCAN_EVENT_CLIENT');

// ─── Job source ──────────────────────────────────────────────────────────

export interface JobSourcePort {
  /** Claim up to `max` jobs to process this tick. May return `[]`. */
  claim(max: number): Promise<MediaProcessingJob[]>;
}
export const JOB_SOURCE_TOKEN = Symbol('MEDIA_PROCESSOR_JOB_SOURCE');
