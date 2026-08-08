import { context } from '@opentelemetry/api';

import { extractTraceContext, injectTraceContext, type TraceCarrier } from './propagation';

/**
 * Field name on BullMQ `job.data` that carries the W3C trace-context
 * propagation carrier. Underscore prefix marks it as platform metadata so
 * domain-level field validation (e.g. Zod schemas in `packages/contracts`)
 * can ignore it cleanly.
 */
export const TRACE_CONTEXT_KEY = '_traceContext' as const;

export type JobDataWithTraceContext<T extends object> = T & {
  readonly [TRACE_CONTEXT_KEY]: TraceCarrier;
};

/**
 * Producer-side helper: stamp the current OTel context onto a BullMQ job
 * payload before enqueue.
 *
 * ```ts
 * await queue.add('send-welcome', injectIntoJobData({ userId }));
 * ```
 *
 * If there is no active span the carrier is empty but the field is still
 * attached — consumer-side `runWithJobContext` is a clean no-op in that
 * case, so producers do not have to branch.
 */
export function injectIntoJobData<T extends object>(data: T): JobDataWithTraceContext<T> {
  const carrier = injectTraceContext({});
  return { ...data, [TRACE_CONTEXT_KEY]: carrier };
}

/**
 * Shape constraint for `runWithJobContext`: a job payload may optionally
 * carry a trace-context carrier under `_traceContext`. The string index
 * signature is what lets callers pass jobs with arbitrary additional domain
 * fields without tripping TS's excess-property check on fresh object
 * literals — the generic constraint alone is not enough because TS still
 * applies the freshness rule against the constraint type.
 */
type JobLikeWithTraceContext = {
  readonly [TRACE_CONTEXT_KEY]?: TraceCarrier | undefined;
  readonly [key: string]: unknown;
};

/**
 * Consumer-side helper: run `fn` inside the OTel context that the producer
 * stamped onto `jobData`, so any spans started inside `fn` (e.g. via
 * `withSpan`) link back to the trace that scheduled the work.
 *
 * ```ts
 * new Worker(name, async (job) =>
 *   runWithJobContext(job.data, () =>
 *     withSpan('send-welcome', async () => { ... })));
 * ```
 *
 * No-ops cleanly when the carrier is missing or empty — older jobs in the
 * queue from before this helper landed don't break.
 */
export function runWithJobContext<T, J extends JobLikeWithTraceContext>(
  jobData: J,
  fn: () => T,
): T {
  const carrier = jobData[TRACE_CONTEXT_KEY];
  if (carrier === undefined || Object.keys(carrier).length === 0) {
    return fn();
  }
  const parent = extractTraceContext(carrier);
  return context.with(parent, fn);
}
