import type {
  MediaAssetEventKind,
  MediaAssetKind,
  RecordAssetEventRequest,
} from '@taste-and-see/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { MediaProcessorMetrics } from './media-processor-metrics';
import { MediaProcessorService } from './media-processor.service';
import type {
  Clock,
  ImageProcessResult,
  ImageProcessorPort,
  MediaProcessingJob,
  ObjectHead,
  ObjectStorePort,
  ScanEventClientPort,
  VideoTranscodeResult,
  VideoTranscoderPort,
  VirusScannerPort,
  VirusScanResult,
} from './ports';

// ─── Head-byte builders (mirror content-inspector signatures) ────────────

function jpegHead(): Buffer {
  const b = Buffer.alloc(64);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(b);
  return b;
}
function mp4Head(): Buffer {
  const b = Buffer.alloc(64);
  b.write('\x00\x00\x00\x20', 0, 'binary');
  b.write('ftyp', 4, 'ascii');
  b.write('isom', 8, 'ascii');
  return b;
}
function pdfHead(): Buffer {
  const b = Buffer.alloc(64);
  Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]).copy(b);
  return b;
}
function junkHead(): Buffer {
  return Buffer.alloc(64); // all zeroes — detector returns null
}

// ─── Fakes ────────────────────────────────────────────────────────────────

class FakeObjectStore implements ObjectStorePort {
  deleted: Array<{ bucket: string; key: string }> = [];
  constructor(
    private readonly cfg: { exists?: boolean; sizeBytes?: number; head: Buffer; sha?: string },
  ) {}
  headObject(): Promise<ObjectHead> {
    return Promise.resolve({
      exists: this.cfg.exists ?? true,
      sizeBytes: this.cfg.sizeBytes ?? 4096,
    });
  }
  readHead(): Promise<Buffer> {
    return Promise.resolve(this.cfg.head);
  }
  sha256(): Promise<string> {
    return Promise.resolve(this.cfg.sha ?? 'a'.repeat(64));
  }
  deleteObject(bucket: string, key: string): Promise<void> {
    this.deleted.push({ bucket, key });
    return Promise.resolve();
  }
}

class FakeScanner implements VirusScannerPort {
  constructor(private readonly result: VirusScanResult) {}
  scan(): Promise<VirusScanResult> {
    return Promise.resolve(this.result);
  }
}

class FakeImageProcessor implements ImageProcessorPort {
  constructor(private readonly result: ImageProcessResult | 'throw') {}
  process(): Promise<ImageProcessResult> {
    if (this.result === 'throw') return Promise.reject(new Error('sharp boom'));
    return Promise.resolve(this.result);
  }
}

class FakeVideoTranscoder implements VideoTranscoderPort {
  constructor(private readonly result: VideoTranscodeResult | 'throw') {}
  transcode(): Promise<VideoTranscodeResult> {
    if (this.result === 'throw') return Promise.reject(new Error('ffmpeg boom'));
    return Promise.resolve(this.result);
  }
}

class RecordingClient implements ScanEventClientPort {
  events: RecordAssetEventRequest[] = [];
  constructor(private readonly throwOn?: MediaAssetEventKind) {}
  record(event: RecordAssetEventRequest): Promise<void> {
    if (this.throwOn !== undefined && event.eventKind === this.throwOn) {
      return Promise.reject(new Error(`emit failed for ${event.eventKind}`));
    }
    this.events.push(event);
    return Promise.resolve();
  }
  kinds(): MediaAssetEventKind[] {
    return this.events.map((e) => e.eventKind);
  }
}

const FIXED = new Date('2026-05-29T12:00:00.000Z');
const clock: Clock = { now: () => FIXED };

function job(overrides: Partial<MediaProcessingJob> = {}): MediaProcessingJob {
  return {
    assetId: 'm_test',
    kind: 'senior_photo',
    declaredMime: 'image/jpeg',
    storageBucket: 'media-bucket',
    storageKey: 'seniors/s1/photo',
    declaredSizeBytes: 4096,
    ...overrides,
  };
}

interface Overrides {
  store?: ObjectStorePort;
  scanner?: VirusScannerPort;
  image?: ImageProcessorPort;
  video?: VideoTranscoderPort;
  client?: RecordingClient;
}

function build(o: Overrides): {
  svc: MediaProcessorService;
  client: RecordingClient;
  store: FakeObjectStore | ObjectStorePort;
} {
  const store = o.store ?? new FakeObjectStore({ head: jpegHead() });
  const client = o.client ?? new RecordingClient();
  const svc = new MediaProcessorService(
    store,
    o.scanner ?? new FakeScanner('clean'),
    o.image ??
      new FakeImageProcessor({ outcome: 'ok', deliveryKey: 'd/k', width: 640, height: 480 }),
    o.video ??
      new FakeVideoTranscoder({
        outcome: 'ok',
        hlsManifestKey: 'delivery/v/index.m3u8',
        posterKey: 'delivery/v/poster.webp',
        posterWidth: 1280,
        posterHeight: 720,
        durationSeconds: 30,
      }),
    client,
    clock,
    new MediaProcessorMetrics(),
  );
  return { svc, client, store };
}

const VIDEO_KIND: MediaAssetKind = 'provider_video_intro';

describe('MediaProcessorService.process', () => {
  let store: FakeObjectStore;

  beforeEach(() => {
    store = new FakeObjectStore({ head: jpegHead() });
  });

  it('happy image path: upload → magic-byte → scan → process → ready', async () => {
    const { svc, client } = build({ store });
    const result = await svc.process(job());

    expect(result.outcome).toBe('ready');
    expect(client.kinds()).toEqual([
      'upload_completed',
      'magic_byte_passed',
      'scan_passed',
      'process_passed',
    ]);
    const magic = client.events.find((e) => e.eventKind === 'magic_byte_passed')!;
    expect(magic.detectedMime).toBe('image/jpeg');
    expect(magic.sha256).toBe('a'.repeat(64));
    expect(magic.sizeBytes).toBe(4096);
    const passed = client.events.find((e) => e.eventKind === 'process_passed')!;
    expect(passed.deliveryKey).toBe('d/k');
    expect(passed.width).toBe(640);
    expect(passed.height).toBe(480);
    expect(store.deleted).toHaveLength(0);
  });

  it('stamps occurredAt from the injected clock', async () => {
    const { svc, client } = build({ store });
    await svc.process(job());
    for (const e of client.events) {
      expect(e.occurredAt).toBe('2026-05-29T12:00:00.000Z');
    }
  });

  it('happy video path: process_passed carries the HLS manifest as deliveryKey + poster dims', async () => {
    const videoStore = new FakeObjectStore({ head: mp4Head() });
    const { svc, client } = build({
      store: videoStore,
      video: new FakeVideoTranscoder({
        outcome: 'ok',
        hlsManifestKey: 'delivery/providers/p1/intro.mp4/index.m3u8',
        posterKey: 'delivery/providers/p1/intro.mp4/poster.webp',
        posterWidth: 1280,
        posterHeight: 720,
        durationSeconds: 42,
      }),
    });

    const result = await svc.process(
      job({ kind: VIDEO_KIND, declaredMime: 'video/mp4', storageKey: 'providers/p1/intro.mp4' }),
    );

    expect(result.outcome).toBe('ready');
    const passed = client.events.find((e) => e.eventKind === 'process_passed')!;
    expect(passed.deliveryKey).toBe('delivery/providers/p1/intro.mp4/index.m3u8');
    expect(passed.width).toBe(1280);
    expect(passed.height).toBe(720);
  });

  it('video over the transcode-bomb caps → process_failed → failed', async () => {
    const videoStore = new FakeObjectStore({ head: mp4Head() });
    const { svc, client } = build({
      store: videoStore,
      video: new FakeVideoTranscoder({
        outcome: 'rejected',
        reason: 'video too long: 600s exceeds the 180s cap',
      }),
    });

    const result = await svc.process(job({ kind: VIDEO_KIND, declaredMime: 'video/mp4' }));

    expect(result.outcome).toBe('failed');
    const failed = client.events.find((e) => e.eventKind === 'process_failed')!;
    expect(failed.reason).toMatch(/video too long/);
  });

  it('video transcoder crash → process_failed (video_transcode_crashed)', async () => {
    const videoStore = new FakeObjectStore({ head: mp4Head() });
    const { svc, client } = build({ store: videoStore, video: new FakeVideoTranscoder('throw') });

    const result = await svc.process(job({ kind: VIDEO_KIND, declaredMime: 'video/mp4' }));

    expect(result.outcome).toBe('failed');
    expect(client.events.find((e) => e.eventKind === 'process_failed')!.reason).toBe(
      'video_transcode_crashed',
    );
  });

  it('magic-byte: detected MIME not allowed for kind → magic_byte_failed + delete + rejected', async () => {
    // A real MP4 uploaded as a senior_photo.
    const mismatchStore = new FakeObjectStore({ head: mp4Head() });
    const { svc, client } = build({ store: mismatchStore });

    const result = await svc.process(job({ kind: 'senior_photo' }));

    expect(result.outcome).toBe('rejected');
    expect(client.kinds()).toEqual(['upload_completed', 'magic_byte_failed']);
    expect(client.events[1]!.reason).toMatch(/not allowed for kind senior_photo/);
    expect(mismatchStore.deleted).toEqual([{ bucket: 'media-bucket', key: 'seniors/s1/photo' }]);
  });

  it('magic-byte: unrecognised bytes → magic_byte_failed + delete', async () => {
    const junkStore = new FakeObjectStore({ head: junkHead() });
    const { svc, client } = build({ store: junkStore });

    const result = await svc.process(job());

    expect(result.outcome).toBe('rejected');
    expect(client.events[1]!.reason).toMatch(/unrecognised content/);
    expect(junkStore.deleted).toHaveLength(1);
  });

  it('infected scan → scan_failed + delete + rejected (after magic_byte_passed)', async () => {
    const { svc, client } = build({ store, scanner: new FakeScanner('infected') });

    const result = await svc.process(job());

    expect(result.outcome).toBe('rejected');
    expect(client.kinds()).toEqual(['upload_completed', 'magic_byte_passed', 'scan_failed']);
    expect(client.events[2]!.reason).toBe('virus signature match');
    expect(store.deleted).toHaveLength(1);
  });

  it('unavailable scanner → scan_failed (fail-closed) + bytes KEPT for re-scan', async () => {
    const { svc, client } = build({ store, scanner: new FakeScanner('unavailable') });

    const result = await svc.process(job());

    expect(result.outcome).toBe('rejected');
    expect(client.events[2]!.eventKind).toBe('scan_failed');
    expect(client.events[2]!.reason).toBe('clamav_unavailable');
    // Fail-closed but bytes are kept (might be clean) — NOT deleted.
    expect(store.deleted).toHaveLength(0);
  });

  it('missing object → missing_object outcome, NO events emitted', async () => {
    const missingStore = new FakeObjectStore({ exists: false, head: jpegHead() });
    const { svc, client } = build({ store: missingStore });

    const result = await svc.process(job());

    expect(result.outcome).toBe('missing_object');
    expect(client.events).toHaveLength(0);
  });

  it('image processor crash → process_failed (image_processing_crashed)', async () => {
    const { svc, client } = build({ store, image: new FakeImageProcessor('throw') });

    const result = await svc.process(job());

    expect(result.outcome).toBe('failed');
    expect(client.events.find((e) => e.eventKind === 'process_failed')!.reason).toBe(
      'image_processing_crashed',
    );
  });

  it('image processor reject (decompression bomb) → process_failed with the reason', async () => {
    const { svc, client } = build({
      store,
      image: new FakeImageProcessor({
        outcome: 'rejected',
        reason: 'image exceeds limitInputPixels',
      }),
    });

    const result = await svc.process(job());

    expect(result.outcome).toBe('failed');
    expect(client.events.find((e) => e.eventKind === 'process_failed')!.reason).toMatch(
      /limitInputPixels/,
    );
  });

  it('document (pdf) → passthrough process_passed (deliveryKey only, no dims)', async () => {
    const pdfStore = new FakeObjectStore({ head: pdfHead() });
    const { svc, client } = build({ store: pdfStore });

    const result = await svc.process(
      job({
        kind: 'provider_document',
        declaredMime: 'application/pdf',
        storageKey: 'docs/d1.pdf',
      }),
    );

    expect(result.outcome).toBe('ready');
    const passed = client.events.find((e) => e.eventKind === 'process_passed')!;
    expect(passed.deliveryKey).toBe('delivery/docs/d1.pdf');
    expect(passed.width).toBeUndefined();
    expect(passed.height).toBeUndefined();
  });

  it('emit failure mid-pipeline → emit_error (asset left for retry)', async () => {
    const { svc } = build({ store, client: new RecordingClient('scan_passed') });

    const result = await svc.process(job());

    expect(result.outcome).toBe('emit_error');
    expect(result.detail).toMatch(/emit failed for scan_passed/);
  });
});
