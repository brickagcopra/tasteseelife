import { Injectable } from '@nestjs/common';
import { type Counter, getMeter, type Histogram } from '@taste-and-see/tracing';

const METER_NAME = 'worker-media-processor:pipeline';

/** Terminal outcome of processing one asset. Bounded label set. */
export type ProcessOutcome = 'ready' | 'rejected' | 'failed' | 'missing_object' | 'emit_error';

/** Pipeline stage that produced a counted outcome. Bounded label set. */
export type PipelineStage = 'magic_byte' | 'scan' | 'process';

/**
 * The media-processor's domain Prometheus instruments (ADR-0002;
 * CLAUDE.md §10):
 *
 *   - `media_processor_assets_processed_total{kind,outcome}` (counter) —
 *     per-asset terminal outcome. `ready` (consumable), `rejected`
 *     (magic-byte / virus), `failed` (process crash / too-big),
 *     `missing_object` (triggered before S3 saw the bytes),
 *     `emit_error` (a scan-event POST failed → job will retry).
 *   - `media_processor_stage_total{stage,outcome}` (counter) — per-stage
 *     pass/fail so a dashboard can localise where assets die (magic-byte
 *     vs scanner vs processing).
 *   - `media_processor_process_duration_seconds{processing_class}`
 *     (histogram) — wall-clock of one asset's full pipeline, by
 *     image/video/document.
 *
 * All label values are fixed code-constant enums (`kind` is the
 * `MediaAssetKind` enum; `outcome`/`stage`/`processing_class` are the
 * unions above) — never an asset id, owner id, storage key, or any
 * user-derived value, so cardinality stays bounded and no PII leaks to
 * the scrape surface (CLAUDE.md §10).
 *
 * Created via `getMeter`, which returns a usable no-op meter when
 * `initMetrics` was never called — safe to construct in unit tests
 * without booting the SDK.
 */
@Injectable()
export class MediaProcessorMetrics {
  private readonly assetsProcessed: Counter;
  private readonly stageTotal: Counter;
  private readonly processDuration: Histogram;

  constructor() {
    const meter = getMeter(METER_NAME);
    this.assetsProcessed = meter.createCounter('media_processor_assets_processed_total', {
      description: 'Total media assets processed, by kind and terminal outcome',
    });
    this.stageTotal = meter.createCounter('media_processor_stage_total', {
      description: 'Per-stage pipeline outcomes (magic-byte / scan / process)',
    });
    this.processDuration = meter.createHistogram('media_processor_process_duration_seconds', {
      description: 'Wall-clock duration of one asset pipeline in seconds, by processing class',
      unit: 's',
    });
  }

  recordOutcome(kind: string, outcome: ProcessOutcome): void {
    this.assetsProcessed.add(1, { kind, outcome });
  }

  recordStage(stage: PipelineStage, outcome: string): void {
    this.stageTotal.add(1, { stage, outcome });
  }

  recordDuration(processingClass: string, seconds: number): void {
    this.processDuration.record(seconds, { processing_class: processingClass });
  }
}
