import { Injectable } from '@nestjs/common';
import { getMeter, type Counter } from '@taste-and-see/tracing';

const METER_NAME = 'service-content:public-blog';

/** Which public read surface was hit. Fixed literals — bounded cardinality. */
export type PublicBlogSurface = 'list' | 'detail';

/** How the read resolved. Fixed literals — bounded cardinality, no PII. */
export type PublicBlogReadOutcome = 'ok' | 'not_found';

/**
 * service-content's public-blog domain instrument (TS-282-followup-3).
 *
 * `content_public_blog_reads_total{surface,outcome}` counts every anonymous
 * read served by the public blog API — the first unauthenticated read surface
 * on service-content, so this counter is also the de-facto public traffic
 * signal for the service. A `not_found` spike on `detail` is the leading
 * indicator of a bad link in a newsletter / social post; a flat zero after a
 * deploy means the gateway proxy or web-marketing ISR fetch is broken.
 *
 * Instruments are created via `getMeter`, which returns a usable no-op meter
 * when `initMetrics` was never called — safe to construct in unit tests
 * without booting the SDK (mirrors `KycMetrics`).
 */
@Injectable()
export class PublicBlogMetrics {
  private readonly reads: Counter;

  constructor() {
    const meter = getMeter(METER_NAME);
    this.reads = meter.createCounter('content_public_blog_reads_total', {
      description:
        'Total public blog reads served, by surface (list / detail) and outcome (ok / not_found).',
    });
  }

  /** Record one public read. */
  recordRead(surface: PublicBlogSurface, outcome: PublicBlogReadOutcome): void {
    this.reads.add(1, { surface, outcome });
  }
}
