import { createHash } from 'node:crypto';

import type {
  Clock,
  ImageProcessInput,
  ImageProcessResult,
  ImageProcessorPort,
  JobSourcePort,
  MediaProcessingJob,
  ObjectHead,
  ObjectStorePort,
  VirusScannerPort,
  VirusScanResult,
} from '../ports';

/**
 * Phase-1 stub adapters (ADR-0002). They make the worker's DI graph
 * bootable + give local dev a deterministic, dependency-free pipeline.
 * The live adapters (S3 / ClamAV / Sharp) swap in behind the same ports
 * as the deferred follow-ups land (TS-110-followup-2/3/4). The
 * orchestrator's unit tests use their own purpose-built fakes, not these.
 */

/** Real wall-clock. Injected so tests can supply a fixed clock. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/**
 * In-memory object store. Empty by default (the Phase-1 worker has no
 * live job source, so it processes nothing); `put` seeds objects for
 * local dev / a future stub job source.
 */
export class StubObjectStore implements ObjectStorePort {
  private readonly objects = new Map<string, Buffer>();

  put(bucket: string, key: string, bytes: Buffer): void {
    this.objects.set(refOf(bucket, key), bytes);
  }

  headObject(bucket: string, key: string): Promise<ObjectHead> {
    const bytes = this.objects.get(refOf(bucket, key));
    return Promise.resolve(
      bytes === undefined
        ? { exists: false, sizeBytes: 0 }
        : { exists: true, sizeBytes: bytes.length },
    );
  }

  readHead(bucket: string, key: string, byteCount: number): Promise<Buffer> {
    const bytes = this.objects.get(refOf(bucket, key)) ?? Buffer.alloc(0);
    return Promise.resolve(bytes.subarray(0, byteCount));
  }

  sha256(bucket: string, key: string): Promise<string> {
    const bytes = this.objects.get(refOf(bucket, key)) ?? Buffer.alloc(0);
    return Promise.resolve(createHash('sha256').update(bytes).digest('hex'));
  }

  deleteObject(bucket: string, key: string): Promise<void> {
    this.objects.delete(refOf(bucket, key));
    return Promise.resolve();
  }
}

function refOf(bucket: string, key: string): string {
  return `${bucket}/${key}`;
}

/**
 * Stub scanner — reports a fixed result (default `clean`). Construct with
 * `'infected'` / `'unavailable'` to exercise the rejection / fail-closed
 * paths in local dev.
 */
export class StubVirusScanner implements VirusScannerPort {
  constructor(private readonly result: VirusScanResult = 'clean') {}

  scan(): Promise<VirusScanResult> {
    return Promise.resolve(this.result);
  }
}

/**
 * Stub image processor — returns a deterministic WebP delivery variant.
 * The live Sharp adapter (TS-110-followup-4) produces real responsive
 * variants + honours `IMAGE_MAX_INPUT_PIXELS` (decompression-bomb floor).
 */
export class StubImageProcessor implements ImageProcessorPort {
  process(input: ImageProcessInput): Promise<ImageProcessResult> {
    return Promise.resolve({
      outcome: 'ok',
      deliveryKey: `delivery/${input.storageKey}/1280.webp`,
      width: 1280,
      height: 960,
    });
  }
}

/**
 * In-memory job source. Empty by default; `enqueue` seeds jobs. The live
 * source (S3 object-created → BullMQ) is TS-201-followup-2.
 */
export class StubJobSource implements JobSourcePort {
  private readonly queue: MediaProcessingJob[] = [];

  enqueue(...jobs: MediaProcessingJob[]): void {
    this.queue.push(...jobs);
  }

  claim(max: number): Promise<MediaProcessingJob[]> {
    return Promise.resolve(this.queue.splice(0, Math.max(0, max)));
  }
}
