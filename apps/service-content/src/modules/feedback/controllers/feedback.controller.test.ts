import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type { ArticleFeedbackSummary, RelatedArticle } from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import type { FeedbackService } from '../services/feedback.service';
import type { RelatedArticlesService } from '../services/related-articles.service';
import { FeedbackController } from './feedback.controller';

function summary(overrides: Partial<ArticleFeedbackSummary> = {}): ArticleFeedbackSummary {
  return {
    articleId: 'art_1',
    helpfulCount: 3,
    notHelpfulCount: 1,
    ownRating: 'helpful',
    ...overrides,
  };
}

function relatedArticle(overrides: Partial<RelatedArticle> = {}): RelatedArticle {
  return {
    id: 'art_2',
    slug: 'sibling',
    title: 'Sibling',
    categoryId: 'cat_1',
    score: 2,
    ...overrides,
  };
}

interface FakeServices {
  feedback: {
    submit: ReturnType<typeof vi.fn>;
    getSummary: ReturnType<typeof vi.fn>;
  };
  related: { getRelated: ReturnType<typeof vi.fn> };
}

function build(overrides: Partial<FakeServices> = {}): {
  controller: FeedbackController;
  services: FakeServices;
} {
  const services: FakeServices = {
    feedback: {
      submit: vi.fn(async () => ({ ok: true, summary: summary() })),
      getSummary: vi.fn(async () => ({ ok: true, summary: summary({ ownRating: null }) })),
      ...overrides.feedback,
    },
    related: {
      getRelated: vi.fn(async () => ({ ok: true, related: [relatedArticle()] })),
      ...overrides.related,
    },
  };
  const controller = new FeedbackController(
    services.feedback as unknown as FeedbackService,
    services.related as unknown as RelatedArticlesService,
  );
  return { controller, services };
}

function userRequest(userId = 'user_reader'): RequestWithContext {
  const ctx: RequestContext = {
    userId,
    mfaVerified: false,
    roles: [],
    tenantScope: { type: 'global' },
  };
  return {
    requestContext: ctx,
    ip: '203.0.113.9',
    headers: { 'user-agent': 'jest', 'x-request-id': 'req_test' },
  } as unknown as RequestWithContext;
}

const noAuth = { requestContext: undefined } as unknown as RequestWithContext;

describe('FeedbackController.submit', () => {
  it('keys the vote by the token userId (never the body) and returns the summary', async () => {
    const { controller, services } = build();
    const response = await controller.submit(
      'art_1',
      { rating: 'helpful' },
      userRequest('reader_9'),
    );
    expect(response.feedback).toEqual(summary());
    expect(services.feedback.submit).toHaveBeenCalledWith({
      articleId: 'art_1',
      userId: 'reader_9',
      rating: 'helpful',
    });
  });

  it('maps a not_available outcome to 404', async () => {
    const { controller } = build({
      feedback: {
        submit: vi.fn(async () => ({ ok: false, reason: 'not_available' })),
        getSummary: vi.fn(),
      },
    });
    await expect(
      controller.submit('art_1', { rating: 'helpful' }, userRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a request with no auth context', async () => {
    const { controller } = build();
    await expect(controller.submit('art_1', { rating: 'helpful' }, noAuth)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('FeedbackController.summary', () => {
  it('returns the aggregate + own rating', async () => {
    const { controller, services } = build();
    const response = await controller.summary('art_1', userRequest('reader_9'));
    expect(response.feedback.ownRating).toBeNull();
    expect(services.feedback.getSummary).toHaveBeenCalledWith('art_1', 'reader_9');
  });

  it('maps not_available to 404', async () => {
    const { controller } = build({
      feedback: {
        submit: vi.fn(),
        getSummary: vi.fn(async () => ({ ok: false, reason: 'not_available' })),
      },
    });
    await expect(controller.summary('art_1', userRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('FeedbackController.relatedArticles', () => {
  it('returns the ranked related articles and forwards the limit', async () => {
    const { controller, services } = build();
    const response = await controller.relatedArticles('art_1', { limit: 5 }, userRequest());
    expect(response.related).toHaveLength(1);
    expect(services.related.getRelated).toHaveBeenCalledWith('art_1', 5);
  });

  it('maps not_available to 404', async () => {
    const { controller } = build({
      related: { getRelated: vi.fn(async () => ({ ok: false, reason: 'not_available' })) },
    });
    await expect(
      controller.relatedArticles('art_1', { limit: 5 }, userRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a request with no auth context', async () => {
    const { controller } = build();
    await expect(controller.relatedArticles('art_1', { limit: 5 }, noAuth)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
