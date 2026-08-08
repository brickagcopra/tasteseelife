import type { VideoTranscodeInput, VideoTranscodeResult, VideoTranscoderPort } from '../ports';

/**
 * Video source probe — duration + frame dimensions. In live mode
 * (`FfmpegVideoTranscoder`, TS-201-followup-1) these come from
 * `ffprobe`; in stub mode they're a fixed configured value.
 */
export interface VideoProbe {
  readonly durationSeconds: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Transcode-bomb caps — the video analog of Sharp's `limitInputPixels`
 * (CLAUDE.md §3.4 step 5 / §17.15). A provider intro is short and modest
 * resolution; a source over either cap is rejected BEFORE any expensive
 * transcode begins (ADR-0002 §3).
 */
export interface VideoTranscodeCaps {
  readonly maxDurationSeconds: number;
  readonly maxInputPixels: number;
}

/** Poster thumbnails are clamped to this width, preserving aspect ratio. */
const POSTER_MAX_WIDTH = 1280;

/**
 * Pure transcode planner — decides accept/reject against the caps and
 * derives the deterministic output keys (HLS manifest + poster). Shared
 * by the stub here and the future live `FfmpegVideoTranscoder` so the
 * security-critical cap logic has ONE tested implementation.
 *
 * Output keys are namespaced under `delivery/<storageKey>/` so they never
 * collide with the immutable source `storage_key` (the media_assets
 * trigger forbids rebinding it).
 */
export function planVideoTranscode(
  storageKey: string,
  probe: VideoProbe,
  caps: VideoTranscodeCaps,
): VideoTranscodeResult {
  if (probe.durationSeconds > caps.maxDurationSeconds) {
    return {
      outcome: 'rejected',
      reason: `video too long: ${probe.durationSeconds}s exceeds the ${caps.maxDurationSeconds}s cap`,
    };
  }
  const inputPixels = probe.width * probe.height;
  if (inputPixels > caps.maxInputPixels) {
    return {
      outcome: 'rejected',
      reason: `video resolution ${probe.width}x${probe.height} (${inputPixels}px) exceeds the ${caps.maxInputPixels}px cap`,
    };
  }
  const base = `delivery/${storageKey}`;
  const poster = clampPoster(probe.width, probe.height);
  return {
    outcome: 'ok',
    hlsManifestKey: `${base}/index.m3u8`,
    posterKey: `${base}/poster.webp`,
    posterWidth: poster.width,
    posterHeight: poster.height,
    durationSeconds: probe.durationSeconds,
  };
}

/** Downscale the poster to `POSTER_MAX_WIDTH`, preserving aspect ratio. */
function clampPoster(width: number, height: number): { width: number; height: number } {
  if (width <= POSTER_MAX_WIDTH) return { width, height };
  const scale = POSTER_MAX_WIDTH / width;
  return { width: POSTER_MAX_WIDTH, height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Phase-1 stub transcoder (ADR-0002). Applies the real cap logic via
 * `planVideoTranscode` against a fixed configured probe — so the
 * orchestrator's video path (accept + reject + the `ready`/`failed`
 * transitions) is exercised deterministically without ffmpeg. The live
 * adapter that shells out to `ffmpeg`/`ffprobe` via `fluent-ffmpeg` is
 * TS-201-followup-1.
 */
export class StubVideoTranscoder implements VideoTranscoderPort {
  constructor(
    private readonly caps: VideoTranscodeCaps,
    /** Fixed probe the stub reports for every source. Defaults within caps. */
    private readonly probe: VideoProbe = { durationSeconds: 30, width: 1280, height: 720 },
  ) {}

  transcode(input: VideoTranscodeInput): Promise<VideoTranscodeResult> {
    return Promise.resolve(planVideoTranscode(input.storageKey, this.probe, this.caps));
  }
}
