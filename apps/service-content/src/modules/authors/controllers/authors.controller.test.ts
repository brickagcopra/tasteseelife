import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type { ArticleAuthor, ContentAuthorRecord } from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import { AuthorsService } from '../services/authors.service';
import { AuthorsController } from './authors.controller';

const TS = '2026-06-30T00:00:00.000Z';

function authorRecord(overrides: Partial<ContentAuthorRecord> = {}): ContentAuthorRecord {
  return {
    id: 'author_1',
    userId: 'user_writer',
    displayName: 'Ada Writer',
    bio: null,
    photoAssetKey: null,
    socialLinks: null,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function articleAuthor(overrides: Partial<ArticleAuthor> = {}): ArticleAuthor {
  return { role: 'primary', sortOrder: 0, author: authorRecord(), ...overrides };
}

interface FakeService {
  listAuthors: ReturnType<typeof vi.fn>;
  createAuthor: ReturnType<typeof vi.fn>;
  updateAuthor: ReturnType<typeof vi.fn>;
  getAuthor: ReturnType<typeof vi.fn>;
  getArticleAuthors: ReturnType<typeof vi.fn>;
  setArticleAuthors: ReturnType<typeof vi.fn>;
}

function build(overrides: Partial<FakeService> = {}): {
  controller: AuthorsController;
  service: FakeService;
} {
  const service: FakeService = {
    listAuthors: vi.fn(async (): Promise<readonly ContentAuthorRecord[]> => [authorRecord()]),
    createAuthor: vi.fn(async () => ({ ok: true, author: authorRecord() })),
    updateAuthor: vi.fn(async () => ({
      ok: true,
      author: authorRecord({ displayName: 'Renamed' }),
    })),
    getAuthor: vi.fn(async () => ({ ok: true, author: authorRecord() })),
    getArticleAuthors: vi.fn(async () => ({ ok: true, authors: [articleAuthor()] })),
    setArticleAuthors: vi.fn(async () => ({ ok: true, authors: [articleAuthor()] })),
    ...overrides,
  };
  const controller = new AuthorsController(service as unknown as AuthorsService);
  return { controller, service };
}

function adminRequest(userId = 'user_admin'): RequestWithContext {
  const ctx: RequestContext = {
    userId,
    mfaVerified: true,
    roles: [],
    tenantScope: { type: 'global' },
  };
  return {
    requestContext: ctx,
    ip: '203.0.113.9',
    headers: { 'user-agent': 'jest', 'x-request-id': 'req_test' },
  } as unknown as RequestWithContext;
}

describe('AuthorsController.list', () => {
  it('returns authors and forwards the limit', async () => {
    const { controller, service } = build();
    const response = await controller.list({ limit: 50 });
    expect(response.authors).toHaveLength(1);
    expect(service.listAuthors).toHaveBeenCalledWith(50);
  });
});

describe('AuthorsController.create', () => {
  const body = { userId: 'user_writer', displayName: 'Ada Writer' };

  it('creates and attributes the actor from the token', async () => {
    const { controller, service } = build();
    const response = await controller.create(body, adminRequest('admin_42'));
    expect(response.author.userId).toBe('user_writer');
    expect(service.createAuthor).toHaveBeenCalledWith(
      expect.objectContaining({
        ...body,
        actorUserId: 'admin_42',
        audit: expect.objectContaining({ actorUserId: 'admin_42', userAgent: 'jest' }),
      }),
    );
  });

  it('maps a userId conflict to 409', async () => {
    const conflict = build({
      createAuthor: vi.fn(async () => ({ ok: false, reason: 'user_conflict' })),
    });
    await expect(conflict.controller.create(body, adminRequest())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rejects a request with no auth context', async () => {
    const { controller } = build();
    await expect(
      controller.create(body, { requestContext: undefined } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AuthorsController.update', () => {
  it('updates and forwards the actor', async () => {
    const { controller, service } = build();
    const response = await controller.update(
      'author_1',
      { displayName: 'Renamed' },
      adminRequest('admin_9'),
    );
    expect(response.author.displayName).toBe('Renamed');
    expect(service.updateAuthor).toHaveBeenCalledWith(
      expect.objectContaining({
        authorId: 'author_1',
        displayName: 'Renamed',
        actorUserId: 'admin_9',
      }),
    );
  });

  it('404s an unknown author', async () => {
    const missing = build({
      updateAuthor: vi.fn(async () => ({ ok: false, reason: 'author_not_found' })),
    });
    await expect(
      missing.controller.update('ghost', { displayName: 'x' }, adminRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AuthorsController.detail', () => {
  it('returns an author, 404 on miss', async () => {
    const { controller } = build();
    const response = await controller.detail('author_1');
    expect(response.author.id).toBe('author_1');

    const missing = build({ getAuthor: vi.fn(async () => ({ ok: false, reason: 'not_found' })) });
    await expect(missing.controller.detail('ghost')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AuthorsController.listArticleAuthors', () => {
  it('returns the byline, 404 on unknown article', async () => {
    const { controller } = build();
    const response = await controller.listArticleAuthors('art_1');
    expect(response.authors).toHaveLength(1);

    const missing = build({
      getArticleAuthors: vi.fn(async () => ({ ok: false, reason: 'article_not_found' })),
    });
    await expect(missing.controller.listArticleAuthors('ghost')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('AuthorsController.setArticleAuthors', () => {
  const body = { authors: [{ authorId: 'author_1', role: 'primary' as const }] };

  it('sets the byline and attributes the actor', async () => {
    const { controller, service } = build();
    const response = await controller.setArticleAuthors('art_1', body, adminRequest('admin_5'));
    expect(response.authors).toHaveLength(1);
    expect(service.setArticleAuthors).toHaveBeenCalledWith(
      expect.objectContaining({
        articleId: 'art_1',
        authors: body.authors,
        actorUserId: 'admin_5',
      }),
    );
  });

  it('maps article_not_found and author_not_found to 404', async () => {
    const noArticle = build({
      setArticleAuthors: vi.fn(async () => ({ ok: false, reason: 'article_not_found' })),
    });
    await expect(
      noArticle.controller.setArticleAuthors('ghost', body, adminRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);

    const noAuthor = build({
      setArticleAuthors: vi.fn(async () => ({ ok: false, reason: 'author_not_found' })),
    });
    await expect(
      noAuthor.controller.setArticleAuthors('art_1', body, adminRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a request with no auth context', async () => {
    const { controller } = build();
    await expect(
      controller.setArticleAuthors('art_1', body, {
        requestContext: undefined,
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
