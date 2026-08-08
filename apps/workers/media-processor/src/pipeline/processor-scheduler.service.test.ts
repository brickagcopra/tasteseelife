import { describe, expect, it } from 'vitest';

import { loadEnv } from '../config/env';

import { StubJobSource } from './adapters/stub-adapters';
import type { MediaProcessorService, ProcessResult } from './media-processor.service';
import type { ProcessOutcome } from './media-processor-metrics';
import type { MediaProcessingJob } from './ports';
import { ProcessorScheduler } from './processor-scheduler.service';

class FakeProcessor {
  seen: MediaProcessingJob[] = [];
  constructor(private readonly outcome: ProcessOutcome = 'ready') {}
  process(job: MediaProcessingJob): Promise<ProcessResult> {
    this.seen.push(job);
    return Promise.resolve({ assetId: job.assetId, outcome: this.outcome });
  }
}

function job(id: string): MediaProcessingJob {
  return {
    assetId: id,
    kind: 'provider_video_intro',
    declaredMime: 'video/mp4',
    storageBucket: 'b',
    storageKey: `k/${id}`,
    declaredSizeBytes: 1024,
  };
}

function makeScheduler(opts: {
  enabled: boolean;
  source: StubJobSource;
  processor: FakeProcessor;
}): ProcessorScheduler {
  const env = loadEnv({
    NODE_ENV: 'test',
    MEDIA_PROCESSOR_ENABLED: opts.enabled ? 'true' : 'false',
    MEDIA_PROCESSOR_BATCH_SIZE: '10',
  });
  return new ProcessorScheduler(
    env,
    opts.source,
    opts.processor as unknown as MediaProcessorService,
  );
}

describe('ProcessorScheduler.runOnce', () => {
  it('is a no-op when the kill-switch is off', async () => {
    const source = new StubJobSource();
    source.enqueue(job('a'));
    const processor = new FakeProcessor();
    const scheduler = makeScheduler({ enabled: false, source, processor });

    expect(await scheduler.runOnce()).toBe(0);
    expect(processor.seen).toHaveLength(0);
  });

  it('returns 0 when the source is empty', async () => {
    const scheduler = makeScheduler({
      enabled: true,
      source: new StubJobSource(),
      processor: new FakeProcessor(),
    });
    expect(await scheduler.runOnce()).toBe(0);
  });

  it('processes every claimed job and returns the count', async () => {
    const source = new StubJobSource();
    source.enqueue(job('a'), job('b'), job('c'));
    const processor = new FakeProcessor();
    const scheduler = makeScheduler({ enabled: true, source, processor });

    expect(await scheduler.runOnce()).toBe(3);
    expect(processor.seen.map((j) => j.assetId)).toEqual(['a', 'b', 'c']);
  });
});
