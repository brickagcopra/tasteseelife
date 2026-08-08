import { trace } from '@opentelemetry/api';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  injectIntoJobData,
  type JobDataWithTraceContext,
  runWithJobContext,
  TRACE_CONTEXT_KEY,
  withSpan,
} from '../index';

import { ensureHarness, harnessExporter } from './_harness';

describe('BullMQ trace-context propagation helpers', () => {
  beforeAll(() => {
    ensureHarness();
  });

  beforeEach(() => {
    harnessExporter.reset();
  });

  it('injectIntoJobData stamps a W3C carrier under _traceContext when in a span', async () => {
    let payload: JobDataWithTraceContext<{ id: string }> | undefined;
    await withSpan('producer', async () => {
      payload = injectIntoJobData({ id: 'order_abc' });
    });

    expect(payload).toBeDefined();
    expect(payload?.id).toBe('order_abc');
    const traceparent = payload?.[TRACE_CONTEXT_KEY]?.['traceparent'];
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
  });

  it('injectIntoJobData still attaches the field (empty carrier) when no span is active', () => {
    const payload = injectIntoJobData({ id: 'order_xyz' });
    expect(payload[TRACE_CONTEXT_KEY]).toBeDefined();
    expect(payload[TRACE_CONTEXT_KEY]['traceparent']).toBeUndefined();
  });

  it('runWithJobContext links the consumer span to the producer trace', async () => {
    let producerTraceId: string | undefined;
    let producerSpanId: string | undefined;
    let consumerTraceId: string | undefined;
    let payload: JobDataWithTraceContext<{ id: string }> | undefined;

    await withSpan('producer', async () => {
      const ctx = trace.getActiveSpan()?.spanContext();
      producerTraceId = ctx?.traceId;
      producerSpanId = ctx?.spanId;
      payload = injectIntoJobData({ id: 'job_1' });
    });

    expect(payload).toBeDefined();
    if (payload === undefined) return; // type-narrow for the rest of the test
    await runWithJobContext(payload, async () => {
      await withSpan('consumer', async () => {
        consumerTraceId = trace.getActiveSpan()?.spanContext().traceId;
      });
    });

    const consumer = harnessExporter.getFinishedSpans().find((s) => s.name === 'consumer');
    expect(consumerTraceId).toBe(producerTraceId);
    expect(consumer?.parentSpanId).toBe(producerSpanId);
  });

  it('runWithJobContext is a clean no-op when the carrier is missing', () => {
    const fn = vi.fn(() => 'ran');
    const result = runWithJobContext({ id: 'no-carrier' }, fn);
    expect(result).toBe('ran');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('runWithJobContext is a clean no-op when the carrier is present but empty', () => {
    const fn = vi.fn(() => 'ran');
    const result = runWithJobContext({ [TRACE_CONTEXT_KEY]: {} }, fn);
    expect(result).toBe('ran');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('returns whatever the wrapped fn returns (sync + async)', async () => {
    expect(runWithJobContext({}, () => 7)).toBe(7);
    await expect(runWithJobContext({}, async () => 'async-value')).resolves.toBe('async-value');
  });
});
