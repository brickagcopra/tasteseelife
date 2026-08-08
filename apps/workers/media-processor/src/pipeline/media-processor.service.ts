import { Inject, Injectable, Logger } from '@nestjs/common';
import type { MediaAssetEventKind, RecordAssetEventRequest } from '@taste-and-see/contracts';
import { withSpan } from '@taste-and-see/tracing';

import { detectMime } from './content-inspector';
import { MediaProcessorMetrics, type ProcessOutcome } from './media-processor-metrics';
import { isMimeAllowedForKind, resolveProcessingClass } from './processing-class';
import {
  CLOCK_TOKEN,
  type Clock,
  IMAGE_PROCESSOR_TOKEN,
  type ImageProcessorPort,
  type MediaProcessingJob,
  OBJECT_STORE_TOKEN,
  type ObjectStorePort,
  SCAN_EVENT_CLIENT_TOKEN,
  type ScanEventClientPort,
  VIDEO_TRANSCODER_TOKEN,
  type VideoTranscoderPort,
  VIRUS_SCANNER_TOKEN,
  type VirusScannerPort,
} from './ports';

/** Bytes read from the object head for magic-byte sniffing. */
const MAGIC_BYTE_HEAD_BYTES = 64;

export interface ProcessResult {
  readonly assetId: string;
  readonly outcome: ProcessOutcome;
  readonly detail?: string;
}

/**
 * The media-processor pipeline orchestrator (TS-201; ADR-0002).
 *
 * Walks one uploaded asset through the mandatory CLAUDE.md §3.4 sequence
 * and reports each stage outcome to media-svc's internal scan-event
 * ingest, which advances the `media_assets` row's status:
 *
 *   1. `headObject`         — confirm S3 has the bytes; emit `upload_completed`.
 *   2. magic-byte sniff     — `detectMime` + per-kind allow-list. Mismatch →
 *      `magic_byte_failed` (+ delete) → `rejected`. Pass → `magic_byte_passed`.
 *   3. ClamAV scan          — `infected` → `scan_failed` (+ delete) → `rejected`;
 *      `unavailable` → `scan_failed` (FAIL CLOSED → `rejected`, bytes kept for
 *      re-scan); `clean` → `scan_passed`.
 *   4. process by class:
 *        image    → Sharp resize → `process_passed` (deliveryKey + dims).
 *        video    → ffmpeg → HLS manifest + poster → `process_passed`
 *                   (deliveryKey = manifest, dims = poster). Source over the
 *                   transcode-bomb caps → `process_failed` → `failed`.
 *        document → passthrough → `process_passed` (deliveryKey only).
 *
 * The asset only becomes consumable (`ready`) after BOTH `scan_passed` and
 * `process_passed`. Every side-effecting stage is an injectable port so
 * this logic is fully unit-testable with no Docker / ffmpeg / ClamAV / S3.
 *
 * **Idempotency / retry.** media-svc dedups on `(assetId, eventKind)`, so
 * re-running this method for the same asset is safe. If a scan-event POST
 * fails (transport / non-2xx), `record` throws and `process` returns
 * `emit_error` — the asset is left mid-flight and the job source retries;
 * re-emitting the already-applied events is a no-op there.
 */
@Injectable()
export class MediaProcessorService {
  private readonly log = new Logger(MediaProcessorService.name);

  constructor(
    @Inject(OBJECT_STORE_TOKEN) private readonly objectStore: ObjectStorePort,
    @Inject(VIRUS_SCANNER_TOKEN) private readonly scanner: VirusScannerPort,
    @Inject(IMAGE_PROCESSOR_TOKEN) private readonly imageProcessor: ImageProcessorPort,
    @Inject(VIDEO_TRANSCODER_TOKEN) private readonly videoTranscoder: VideoTranscoderPort,
    @Inject(SCAN_EVENT_CLIENT_TOKEN) private readonly scanEventClient: ScanEventClientPort,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    private readonly metrics: MediaProcessorMetrics,
  ) {}

  async process(job: MediaProcessingJob): Promise<ProcessResult> {
    return withSpan('media_processor.process', async (span) => {
      span.setAttribute('media.asset_id', job.assetId);
      span.setAttribute('media.kind', job.kind);
      const start = process.hrtime.bigint();
      let processingClass = 'unknown';
      try {
        const result = await this.runPipeline(job, (cls) => {
          processingClass = cls;
        });
        this.metrics.recordOutcome(job.kind, result.outcome);
        return result;
      } catch (err) {
        // A scan-event POST failed mid-pipeline. The asset is left in an
        // intermediate status; the job source retries and the idempotent
        // ingest collapses the already-applied events.
        this.metrics.recordOutcome(job.kind, 'emit_error');
        this.log.warn(
          { assetId: job.assetId, err: errMessage(err) },
          'media-processor: scan-event emit failed; asset left mid-pipeline for retry',
        );
        return { assetId: job.assetId, outcome: 'emit_error', detail: errMessage(err) };
      } finally {
        const seconds = Number(process.hrtime.bigint() - start) / 1e9;
        this.metrics.recordDuration(processingClass, seconds);
      }
    });
  }

  private async runPipeline(
    job: MediaProcessingJob,
    setClass: (cls: string) => void,
  ): Promise<ProcessResult> {
    const { assetId, kind, storageBucket, storageKey } = job;

    // 1. Confirm the object is present.
    const head = await this.objectStore.headObject(storageBucket, storageKey);
    if (!head.exists) {
      this.log.warn(
        { assetId },
        'media-processor: object not present in store; skipping (no event emitted)',
      );
      return { assetId, outcome: 'missing_object' };
    }
    await this.emit({ assetId, eventKind: 'upload_completed', sizeBytes: head.sizeBytes });

    // 2. Magic-byte MIME validation (authoritative — declared MIME ignored).
    const headBytes = await this.objectStore.readHead(
      storageBucket,
      storageKey,
      MAGIC_BYTE_HEAD_BYTES,
    );
    const detected = detectMime(headBytes);
    if (detected === null || !isMimeAllowedForKind(kind, detected)) {
      const reason =
        detected === null
          ? 'magic-byte mismatch: unrecognised content'
          : `detected MIME ${detected} not allowed for kind ${kind}`;
      await this.emit({ assetId, eventKind: 'magic_byte_failed', reason });
      await this.safeDelete(storageBucket, storageKey);
      this.metrics.recordStage('magic_byte', 'failed');
      return { assetId, outcome: 'rejected', detail: reason };
    }
    const sha256 = await this.objectStore.sha256(storageBucket, storageKey);
    await this.emit({
      assetId,
      eventKind: 'magic_byte_passed',
      detectedMime: detected,
      sha256,
      sizeBytes: head.sizeBytes,
    });
    this.metrics.recordStage('magic_byte', 'passed');

    // 3. Virus scan (fail closed on an unavailable scanner).
    const scan = await this.scanner.scan(storageBucket, storageKey);
    if (scan !== 'clean') {
      const reason = scan === 'infected' ? 'virus signature match' : 'clamav_unavailable';
      await this.emit({ assetId, eventKind: 'scan_failed', reason });
      // Delete confirmed-infected bytes; an UNAVAILABLE scanner leaves the
      // (possibly clean) bytes in place so a later re-scan can clear them —
      // the asset is `rejected` either way, so the read surface is safe.
      if (scan === 'infected') {
        await this.safeDelete(storageBucket, storageKey);
      }
      this.metrics.recordStage('scan', scan);
      return { assetId, outcome: 'rejected', detail: reason };
    }
    await this.emit({ assetId, eventKind: 'scan_passed' });
    this.metrics.recordStage('scan', 'clean');

    // 4. Process by class.
    const cls = resolveProcessingClass(detected);
    if (cls === null) {
      // Unreachable for accepted assets (the magic-byte gate already
      // rejected unknown MIMEs); defensive so the branch is total.
      await this.emit({
        assetId,
        eventKind: 'process_failed',
        reason: `no processor for MIME ${detected}`,
      });
      this.metrics.recordStage('process', 'no_processor');
      return { assetId, outcome: 'failed', detail: 'no processor' };
    }
    setClass(cls);
    if (cls === 'image') return this.processImage(job, detected);
    if (cls === 'video') return this.processVideo(job, detected);
    return this.processDocument(job);
  }

  private async processImage(
    job: MediaProcessingJob,
    detectedMime: string,
  ): Promise<ProcessResult> {
    const { assetId, storageBucket, storageKey } = job;
    let result;
    try {
      result = await this.imageProcessor.process({
        bucket: storageBucket,
        storageKey,
        detectedMime,
      });
    } catch (err) {
      await this.emit({ assetId, eventKind: 'process_failed', reason: 'image_processing_crashed' });
      this.metrics.recordStage('process', 'crashed');
      return { assetId, outcome: 'failed', detail: errMessage(err) };
    }
    if (result.outcome === 'rejected') {
      await this.emit({ assetId, eventKind: 'process_failed', reason: result.reason });
      this.metrics.recordStage('process', 'rejected');
      return { assetId, outcome: 'failed', detail: result.reason };
    }
    await this.emit({
      assetId,
      eventKind: 'process_passed',
      deliveryKey: result.deliveryKey,
      width: result.width,
      height: result.height,
    });
    this.metrics.recordStage('process', 'passed');
    return { assetId, outcome: 'ready' };
  }

  private async processVideo(
    job: MediaProcessingJob,
    detectedMime: string,
  ): Promise<ProcessResult> {
    const { assetId, storageBucket, storageKey, declaredSizeBytes } = job;
    let result;
    try {
      result = await this.videoTranscoder.transcode({
        assetId,
        bucket: storageBucket,
        storageKey,
        detectedMime,
        declaredSizeBytes,
      });
    } catch (err) {
      await this.emit({ assetId, eventKind: 'process_failed', reason: 'video_transcode_crashed' });
      this.metrics.recordStage('process', 'crashed');
      return { assetId, outcome: 'failed', detail: errMessage(err) };
    }
    if (result.outcome === 'rejected') {
      await this.emit({ assetId, eventKind: 'process_failed', reason: result.reason });
      this.metrics.recordStage('process', 'rejected');
      return { assetId, outcome: 'failed', detail: result.reason };
    }
    // The HLS manifest is the consumable delivery artifact → `deliveryKey`.
    // The poster's dimensions ride the existing width/height fields; the
    // poster key + duration are logged (dedicated columns are
    // TS-201-followup-3).
    await this.emit({
      assetId,
      eventKind: 'process_passed',
      deliveryKey: result.hlsManifestKey,
      width: result.posterWidth,
      height: result.posterHeight,
    });
    this.log.log(
      {
        assetId,
        hlsManifestKey: result.hlsManifestKey,
        posterKey: result.posterKey,
        durationSeconds: result.durationSeconds,
      },
      'media-processor: video transcode complete',
    );
    this.metrics.recordStage('process', 'passed');
    return { assetId, outcome: 'ready' };
  }

  private async processDocument(job: MediaProcessingJob): Promise<ProcessResult> {
    const { assetId, storageKey } = job;
    // PDFs bypass Sharp/transcode — the original bytes become the delivery
    // object (CLAUDE.md §3.4 step 7). The live S3 adapter copies bytes to
    // this key; the stub just reports it.
    const deliveryKey = deriveDocumentDeliveryKey(storageKey);
    await this.emit({ assetId, eventKind: 'process_passed', deliveryKey });
    this.metrics.recordStage('process', 'passed');
    return { assetId, outcome: 'ready' };
  }

  private async emit(args: {
    readonly assetId: string;
    readonly eventKind: MediaAssetEventKind;
    readonly detectedMime?: string;
    readonly sha256?: string;
    readonly sizeBytes?: number;
    readonly width?: number;
    readonly height?: number;
    readonly deliveryKey?: string;
    readonly reason?: string;
  }): Promise<void> {
    const event: RecordAssetEventRequest = {
      assetId: args.assetId,
      eventKind: args.eventKind,
      occurredAt: this.clock.now().toISOString(),
      ...(args.detectedMime !== undefined && { detectedMime: args.detectedMime }),
      ...(args.sha256 !== undefined && { sha256: args.sha256 }),
      ...(args.sizeBytes !== undefined && { sizeBytes: args.sizeBytes }),
      ...(args.width !== undefined && { width: args.width }),
      ...(args.height !== undefined && { height: args.height }),
      ...(args.deliveryKey !== undefined && { deliveryKey: args.deliveryKey }),
      ...(args.reason !== undefined && { reason: args.reason }),
    };
    await this.scanEventClient.record(event);
  }

  private async safeDelete(bucket: string, key: string): Promise<void> {
    try {
      await this.objectStore.deleteObject(bucket, key);
    } catch (err) {
      // Best-effort — a failed delete must not crash the pipeline. The
      // asset is already `rejected`; an orphaned object is swept later.
      this.log.warn(
        { bucket, key, err: errMessage(err) },
        'media-processor: failed to delete rejected object (best-effort)',
      );
    }
  }
}

/**
 * Derive the delivery object key for a passthrough (document) asset.
 * Namespaced under `delivery/` so it never collides with the immutable
 * source `storage_key` (which the media_assets trigger forbids rebinding).
 */
export function deriveDocumentDeliveryKey(storageKey: string): string {
  return `delivery/${storageKey}`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
