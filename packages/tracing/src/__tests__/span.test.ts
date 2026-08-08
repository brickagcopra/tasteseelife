import { SpanStatusCode } from '@opentelemetry/api';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getActiveSpanContext, withSpan } from '../index';

import { ensureHarness, harnessExporter } from './_harness';

describe('withSpan', () => {
  beforeAll(() => {
    ensureHarness();
  });

  beforeEach(() => {
    harnessExporter.reset();
  });

  it('starts a span with the given name and ends it after `fn` resolves', async () => {
    const result = await withSpan('test.op', async () => 42);
    expect(result).toBe(42);

    const finished = harnessExporter.getFinishedSpans();
    expect(finished).toHaveLength(1);
    expect(finished[0]?.name).toBe('test.op');
    expect(finished[0]?.status.code).toBe(SpanStatusCode.OK);
    expect(finished[0]?.endTime).toBeDefined();
  });

  it('marks the span ERROR and records the exception when `fn` throws', async () => {
    const boom = new Error('boom');
    await expect(
      withSpan('test.failing', async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    const finished = harnessExporter.getFinishedSpans();
    expect(finished).toHaveLength(1);
    const [span] = finished;
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.status.message).toBe('boom');
    const exceptionEvents = span?.events.filter((e) => e.name === 'exception') ?? [];
    expect(exceptionEvents).toHaveLength(1);
  });

  it('still ends the span when a non-Error is thrown, with stringified status message', async () => {
    await expect(
      withSpan('test.string-throw', async () => {
        throw 'literal-string'; // eslint-disable-line no-throw-literal
      }),
    ).rejects.toBe('literal-string');

    const [span] = harnessExporter.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.status.message).toBe('literal-string');
    const exceptionEvents = span?.events.filter((e) => e.name === 'exception') ?? [];
    expect(exceptionEvents).toHaveLength(0);
  });

  it('makes the started span the active span for the duration of `fn`', async () => {
    let capturedTraceId: string | undefined;
    let capturedSpanId: string | undefined;

    await withSpan('test.active', async () => {
      const ctx = getActiveSpanContext();
      capturedTraceId = ctx?.traceId;
      capturedSpanId = ctx?.spanId;
    });

    const [span] = harnessExporter.getFinishedSpans();
    expect(capturedTraceId).toBe(span?.spanContext().traceId);
    expect(capturedSpanId).toBe(span?.spanContext().spanId);
  });

  it('passes through caller-supplied SpanOptions (attributes)', async () => {
    await withSpan('test.with-attrs', async () => undefined, {
      attributes: { 'app.flag': 'on', 'app.count': 7 },
    });

    const [span] = harnessExporter.getFinishedSpans();
    expect(span?.attributes['app.flag']).toBe('on');
    expect(span?.attributes['app.count']).toBe(7);
  });
});

describe('getActiveSpanContext', () => {
  beforeAll(() => {
    ensureHarness();
  });

  beforeEach(() => {
    harnessExporter.reset();
  });

  it('returns undefined when there is no active span', () => {
    expect(getActiveSpanContext()).toBeUndefined();
  });

  it('returns hex traceId / spanId of the right length when inside a span', async () => {
    let captured: ReturnType<typeof getActiveSpanContext>;
    await withSpan('test.ids', async () => {
      captured = getActiveSpanContext();
    });
    expect(captured).toBeDefined();
    expect(captured?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(captured?.spanId).toMatch(/^[0-9a-f]{16}$/);
  });
});
