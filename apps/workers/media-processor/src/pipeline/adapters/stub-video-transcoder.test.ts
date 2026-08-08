import { describe, expect, it } from 'vitest';

import {
  planVideoTranscode,
  StubVideoTranscoder,
  type VideoTranscodeCaps,
} from './stub-video-transcoder';

const CAPS: VideoTranscodeCaps = { maxDurationSeconds: 180, maxInputPixels: 8_300_000 };

describe('planVideoTranscode', () => {
  it('accepts a within-caps source and derives manifest + poster keys', () => {
    const result = planVideoTranscode(
      'providers/p1/intro.mp4',
      {
        durationSeconds: 45,
        width: 1280,
        height: 720,
      },
      CAPS,
    );

    expect(result).toEqual({
      outcome: 'ok',
      hlsManifestKey: 'delivery/providers/p1/intro.mp4/index.m3u8',
      posterKey: 'delivery/providers/p1/intro.mp4/poster.webp',
      posterWidth: 1280,
      posterHeight: 720,
      durationSeconds: 45,
    });
  });

  it('rejects a source over the duration cap (transcode-bomb floor)', () => {
    const result = planVideoTranscode('k', { durationSeconds: 181, width: 640, height: 480 }, CAPS);
    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toMatch(/video too long: 181s exceeds the 180s cap/);
    }
  });

  it('accepts a source exactly at the duration cap (boundary)', () => {
    const result = planVideoTranscode('k', { durationSeconds: 180, width: 640, height: 480 }, CAPS);
    expect(result.outcome).toBe('ok');
  });

  it('rejects a source over the resolution cap', () => {
    // 4096 × 2160 = 8,847,360 px > 8,300,000 cap.
    const result = planVideoTranscode(
      'k',
      { durationSeconds: 10, width: 4096, height: 2160 },
      CAPS,
    );
    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toMatch(/resolution 4096x2160/);
    }
  });

  it('downscales the poster to 1280 wide preserving aspect ratio', () => {
    const result = planVideoTranscode(
      'k',
      { durationSeconds: 10, width: 1920, height: 1080 },
      CAPS,
    );
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.posterWidth).toBe(1280);
      expect(result.posterHeight).toBe(720); // 1080 * (1280/1920)
    }
  });
});

describe('StubVideoTranscoder', () => {
  it('applies the configured caps via planVideoTranscode (default probe → ok)', async () => {
    const t = new StubVideoTranscoder(CAPS);
    const result = await t.transcode({
      assetId: 'm_1',
      bucket: 'b',
      storageKey: 'providers/p1/intro.mp4',
      detectedMime: 'video/mp4',
      declaredSizeBytes: 1024,
    });
    expect(result.outcome).toBe('ok');
  });

  it('rejects when the configured probe exceeds the caps', async () => {
    const t = new StubVideoTranscoder(CAPS, { durationSeconds: 600, width: 1280, height: 720 });
    const result = await t.transcode({
      assetId: 'm_1',
      bucket: 'b',
      storageKey: 'k',
      detectedMime: 'video/mp4',
      declaredSizeBytes: 1024,
    });
    expect(result.outcome).toBe('rejected');
  });
});
