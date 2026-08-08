import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MediaProcessorMetrics } from './media-processor-metrics';

/**
 * Exercises the FULL surface — init → record → serialize — so the test
 * proves the instruments render in Prometheus text format with the
 * expected names + bounded labels, not merely that a method was called.
 *
 * Long export interval (1h) so the periodic reader's background sweep
 * doesn't race the inline `collect()` inside `serializeMetrics()`.
 */
describe('MediaProcessorMetrics', () => {
  beforeEach(() => {
    initMetrics({
      service: 'worker-media-processor-test',
      env: 'test',
      exportIntervalMillis: 3_600_000,
    });
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  it('renders per-kind/outcome asset counters', async () => {
    const metrics = new MediaProcessorMetrics();
    metrics.recordOutcome('provider_video_intro', 'ready');
    metrics.recordOutcome('senior_photo', 'rejected');

    const out = await serializeMetrics();

    expect(out).toMatch(/# TYPE media_processor_assets_processed_total counter/);
    expect(out).toMatch(
      /media_processor_assets_processed_total\{[^}]*kind="provider_video_intro"[^}]*outcome="ready"[^}]*\} 1/,
    );
    expect(out).toMatch(
      /media_processor_assets_processed_total\{[^}]*kind="senior_photo"[^}]*outcome="rejected"[^}]*\} 1/,
    );
  });

  it('renders per-stage counters', async () => {
    const metrics = new MediaProcessorMetrics();
    metrics.recordStage('scan', 'clean');
    metrics.recordStage('scan', 'infected');
    metrics.recordStage('magic_byte', 'failed');

    const out = await serializeMetrics();

    expect(out).toMatch(/# TYPE media_processor_stage_total counter/);
    expect(out).toMatch(
      /media_processor_stage_total\{[^}]*stage="scan"[^}]*outcome="clean"[^}]*\} 1/,
    );
    expect(out).toMatch(
      /media_processor_stage_total\{[^}]*stage="magic_byte"[^}]*outcome="failed"[^}]*\} 1/,
    );
  });

  it('renders the process-duration histogram by processing class', async () => {
    const metrics = new MediaProcessorMetrics();
    metrics.recordDuration('video', 1.2);
    metrics.recordDuration('image', 0.05);

    const out = await serializeMetrics();

    expect(out).toMatch(/# TYPE media_processor_process_duration_seconds histogram/);
    expect(out).toMatch(
      /media_processor_process_duration_seconds_count\{[^}]*processing_class="video"[^}]*\} 1/,
    );
  });

  it('does NOT leak a PII / unbounded label (only kind + outcome)', async () => {
    const metrics = new MediaProcessorMetrics();
    metrics.recordOutcome('provider_video_intro', 'ready');
    const out = await serializeMetrics();
    // No asset id / storage key / owner id should ever appear on a label.
    expect(out).not.toMatch(/asset_id=/);
    expect(out).not.toMatch(/storage_key=/);
    expect(out).not.toMatch(/owner/);
  });

  it('is safe to construct + record when metrics are not initialized', async () => {
    await shutdownMetrics();
    const metrics = new MediaProcessorMetrics();
    expect(() => {
      metrics.recordOutcome('senior_photo', 'ready');
      metrics.recordStage('process', 'passed');
      metrics.recordDuration('document', 0.01);
    }).not.toThrow();
  });
});
