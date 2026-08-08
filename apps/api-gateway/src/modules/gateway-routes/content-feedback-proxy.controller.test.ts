import {
  BadGatewayException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ArticleFeedbackSummary, RelatedArticle } from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it } from 'vitest';

import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';

import { ContentFeedbackProxyController } from './content-feedback-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const REQUEST_WITH_CTX: RequestWithContext = {
  requestContext: {
    userId: 'usr_abc',
    mfaVerified: false,
    roles: [],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_test_001' },
} as unknown as RequestWithContext;

const NO_CTX = { headers: {} } as unknown as RequestWithContext;

const SUMMARY: ArticleFeedbackSummary = {
  articleId: 'art_1',
  helpfulCount: 3,
  notHelpfulCount: 1,
  ownRating: 'helpful',
};

const RELATED: RelatedArticle = {
  id: 'art_2',
  slug: 'sibling',
  title: 'Sibling',
  categoryId: 'cat_1',
  score: 3,
};

function makeController(result: DownstreamResult): {
  controller: ContentFeedbackProxyController;
  stub: StubDownstreamClient;
} {
  const stub = new StubDownstreamClient(result);
  const controller = new ContentFeedbackProxyController(stub as unknown as DownstreamHttpClient);
  return { controller, stub };
}

describe('ContentFeedbackProxyController.submitFeedback', () => {
  it('forwards a valid vote (PUT, content service, idempotency key, actor)', async () => {
    const { controller, stub } = makeController({
      kind: 'ok',
      status: 200,
      body: { feedback: SUMMARY },
      setCookies: [],
    });
    const response = await controller.submitFeedback(
      'art_1',
      { rating: 'helpful' },
      'idem-1',
      REQUEST_WITH_CTX,
    );

    expect(response.feedback).toEqual(SUMMARY);
    expect(stub.lastOptions?.service).toBe('content');
    expect(stub.lastOptions?.method).toBe('PUT');
    expect(stub.lastOptions?.path).toBe('/api/v1/content/articles/art_1/feedback');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-1');
    expect(stub.lastOptions?.actor).toEqual(REQUEST_WITH_CTX.requestContext);
  });

  it('rejects an invalid rating with 400 (never calls downstream)', async () => {
    const { controller, stub } = makeController({
      kind: 'ok',
      status: 200,
      body: {},
      setCookies: [],
    });
    await expect(
      controller.submitFeedback('art_1', { rating: 'meh' }, undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('rejects an unauthenticated request', async () => {
    const { controller } = makeController({
      kind: 'ok',
      status: 200,
      body: { feedback: SUMMARY },
      setCookies: [],
    });
    await expect(
      controller.submitFeedback('art_1', { rating: 'helpful' }, undefined, NO_CTX),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('propagates a downstream 404 verbatim', async () => {
    const { controller } = makeController({
      kind: 'client_error',
      status: 404,
      body: { detail: "No published content article found for id 'art_1'." },
      setCookies: [],
    });
    await expect(
      controller.submitFeedback('art_1', { rating: 'helpful' }, undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
  });
});

describe('ContentFeedbackProxyController.feedbackSummary', () => {
  it('forwards a GET and returns the summary', async () => {
    const { controller, stub } = makeController({
      kind: 'ok',
      status: 200,
      body: { feedback: SUMMARY },
      setCookies: [],
    });
    const response = await controller.feedbackSummary('art_1', REQUEST_WITH_CTX);
    expect(response.feedback).toEqual(SUMMARY);
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.path).toBe('/api/v1/content/articles/art_1/feedback');
  });

  it('maps a not_configured downstream to 503', async () => {
    const { controller } = makeController({ kind: 'not_configured', service: 'content' });
    await expect(controller.feedbackSummary('art_1', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('ContentFeedbackProxyController.related', () => {
  it('forwards the validated limit in the downstream path', async () => {
    const { controller, stub } = makeController({
      kind: 'ok',
      status: 200,
      body: { related: [RELATED] },
      setCookies: [],
    });
    const response = await controller.related('art_1', { limit: '5' }, REQUEST_WITH_CTX);
    expect(response.related).toEqual([RELATED]);
    expect(stub.lastOptions?.path).toBe('/api/v1/content/articles/art_1/related?limit=5');
  });

  it('rejects a body that fails the contract with 502', async () => {
    const { controller } = makeController({
      kind: 'ok',
      status: 200,
      body: { related: [{ bad: true }] },
      setCookies: [],
    });
    await expect(
      controller.related('art_1', { limit: '5' }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});
