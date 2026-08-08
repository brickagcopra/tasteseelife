import { context, trace } from '@opentelemetry/api';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { extractTraceContext, injectTraceContext, type TraceCarrier, withSpan } from '../index';

import { ensureHarness, harnessExporter } from './_harness';

describe('injectTraceContext', () => {
  beforeAll(() => {
    ensureHarness();
  });

  beforeEach(() => {
    harnessExporter.reset();
  });

  it('writes a valid W3C `traceparent` when there is an active span', async () => {
    let carrier: TraceCarrier = {};
    await withSpan('producer', async () => {
      carrier = injectTraceContext({});
    });
    expect(carrier['traceparent']).toBeDefined();
    expect(carrier['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
  });

  it('returns the same carrier object that was passed in (chainable)', async () => {
    const input: TraceCarrier = {};
    let returned: TraceCarrier | undefined;
    await withSpan('producer', async () => {
      returned = injectTraceContext(input);
    });
    expect(returned).toBe(input);
  });

  it('leaves the carrier empty when there is no active span', () => {
    const carrier = injectTraceContext({});
    expect(carrier['traceparent']).toBeUndefined();
  });
});

describe('extractTraceContext', () => {
  beforeAll(() => {
    ensureHarness();
  });

  beforeEach(() => {
    harnessExporter.reset();
  });

  it('preserves traceId across an inject → extract round trip', async () => {
    const carrier: TraceCarrier = {};
    let producerTraceId: string | undefined;

    await withSpan('producer', async () => {
      producerTraceId = trace.getActiveSpan()?.spanContext().traceId;
      injectTraceContext(carrier);
    });

    let consumerTraceId: string | undefined;
    const parent = extractTraceContext(carrier);
    await context.with(parent, async () => {
      await withSpan('consumer', async () => {
        consumerTraceId = trace.getActiveSpan()?.spanContext().traceId;
      });
    });

    expect(producerTraceId).toBeDefined();
    expect(consumerTraceId).toBe(producerTraceId);
  });

  it('makes the consumer span a child of the producer span', async () => {
    const carrier: TraceCarrier = {};
    let producerSpanId: string | undefined;

    await withSpan('producer', async () => {
      producerSpanId = trace.getActiveSpan()?.spanContext().spanId;
      injectTraceContext(carrier);
    });

    const parent = extractTraceContext(carrier);
    await context.with(parent, async () => {
      await withSpan('consumer', async () => undefined);
    });

    const finished = harnessExporter.getFinishedSpans();
    const consumer = finished.find((s) => s.name === 'consumer');
    expect(consumer?.parentSpanId).toBe(producerSpanId);
  });

  it('falls back to the active context when the carrier has no propagation headers', async () => {
    let outerTraceId: string | undefined;
    let innerTraceId: string | undefined;

    await withSpan('outer', async () => {
      outerTraceId = trace.getActiveSpan()?.spanContext().traceId;
      const parent = extractTraceContext({}); // empty carrier
      await context.with(parent, async () => {
        await withSpan('inner', async () => {
          innerTraceId = trace.getActiveSpan()?.spanContext().traceId;
        });
      });
    });

    expect(innerTraceId).toBe(outerTraceId);
  });
});
