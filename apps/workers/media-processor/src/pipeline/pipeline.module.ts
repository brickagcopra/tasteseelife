import { Module } from '@nestjs/common';

import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';

import { HttpScanEventClient, LoggingScanEventClient } from './adapters/http-scan-event-client';
import {
  StubImageProcessor,
  StubJobSource,
  StubObjectStore,
  StubVirusScanner,
  SystemClock,
} from './adapters/stub-adapters';
import { StubVideoTranscoder } from './adapters/stub-video-transcoder';
import { MediaProcessorMetrics } from './media-processor-metrics';
import { MediaProcessorService } from './media-processor.service';
import { ProcessorScheduler } from './processor-scheduler.service';
import {
  CLOCK_TOKEN,
  IMAGE_PROCESSOR_TOKEN,
  JOB_SOURCE_TOKEN,
  OBJECT_STORE_TOKEN,
  SCAN_EVENT_CLIENT_TOKEN,
  type ScanEventClientPort,
  VIDEO_TRANSCODER_TOKEN,
  VIRUS_SCANNER_TOKEN,
} from './ports';

/**
 * Wires the media-processor pipeline (ADR-0002). Every side-effecting
 * port resolves to its Phase-1 stub by default; the live adapters
 * (S3 / ClamAV / Sharp / ffmpeg) swap in behind these tokens as the
 * deferred follow-ups land. The scan-event client is the one already-live
 * adapter — it talks to media-svc's internal ingest when configured, and
 * falls back to a logging no-op in stub/dev mode.
 */
@Module({
  providers: [
    MediaProcessorMetrics,
    MediaProcessorService,
    ProcessorScheduler,
    { provide: CLOCK_TOKEN, useClass: SystemClock },
    { provide: OBJECT_STORE_TOKEN, useClass: StubObjectStore },
    { provide: VIRUS_SCANNER_TOKEN, useClass: StubVirusScanner },
    { provide: IMAGE_PROCESSOR_TOKEN, useClass: StubImageProcessor },
    { provide: JOB_SOURCE_TOKEN, useClass: StubJobSource },
    {
      provide: VIDEO_TRANSCODER_TOKEN,
      inject: [ENV_TOKEN],
      useFactory: (env: Env): StubVideoTranscoder =>
        new StubVideoTranscoder({
          maxDurationSeconds: env.MEDIA_VIDEO_MAX_DURATION_SECONDS,
          maxInputPixels: env.MEDIA_VIDEO_MAX_INPUT_PIXELS,
        }),
    },
    {
      provide: SCAN_EVENT_CLIENT_TOKEN,
      inject: [ENV_TOKEN],
      useFactory: (env: Env): ScanEventClientPort => {
        if (
          env.SCAN_EVENT_INGEST_URL === undefined ||
          env.SCAN_EVENT_INGEST_API_KEY === undefined
        ) {
          return new LoggingScanEventClient();
        }
        return new HttpScanEventClient({
          baseUrl: env.SCAN_EVENT_INGEST_URL,
          apiKey: env.SCAN_EVENT_INGEST_API_KEY,
          apiKeyHeader: env.SCAN_EVENT_INGEST_API_KEY_HEADER,
          timeoutMs: env.SCAN_EVENT_INGEST_TIMEOUT_MS,
        });
      },
    },
  ],
})
export class PipelineModule {}
