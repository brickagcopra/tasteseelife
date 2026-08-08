import {
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it } from 'vitest';
import type { Request } from 'express';

import type { Env } from '../../../config/env';
import type { RenderTemplateResult, TemplatesService } from '../services/templates.service';

import { RenderController } from './render.controller';

function buildEnv(): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3017,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    SERVICE_VERSION: 'dev',
    OTEL_TRACES_ENABLED: false,
    OTEL_METRICS_ENABLED: false,
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    NOTIFICATION_RENDER_HEADER_NAME: 'x-internal-api-key',
    NOTIFICATION_RENDER_API_KEY: 'k'.repeat(40),
    NOTIFICATION_DISPATCH_HEADER_NAME: 'x-internal-api-key',
    NOTIFICATION_DISPATCH_API_KEY: 'd'.repeat(40),
    NOTIFICATION_EMAIL_FROM_ADDRESS: 'no-reply@example.com',
    NOTIFICATION_EMAIL_FROM_NAME: 'Taste & See',
    // TS-042-followup-3a2 — the dunning-consumer env cluster.
    REDIS_URL: 'redis://localhost:6379',
    OUTBOX_CONSUMER_NAME: 'default',
    OUTBOX_STREAM_PREFIX: 'events',
    OUTBOX_CONSUMER_MAX_ATTEMPTS: 10,
    OUTBOX_CONSUMER_POLL_BLOCK_MS: 5_000,
    OUTBOX_CONSUMER_RECLAIM_IDLE_MS: 60_000,
    OUTBOX_CONSUMER_POLL_INTERVAL_MS: 1_000,
    DUNNING_NOTIFICATIONS_ENABLED: true,
    HOUSEHOLD_SERVICE_BASE_URL: 'http://service-household:3011',
    PROVIDER_SERVICE_BASE_URL: 'http://service-household:3011',
    PROVIDER_BILLING_CONTACTS_INTERNAL_API_KEY: 'p'.repeat(48),
    PROVIDER_BILLING_CONTACTS_INTERNAL_HEADER_NAME: 'x-provider-billing-contacts-internal-api-key',
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_HEADER_NAME: 'x-internal-api-key',
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY: 'a'.repeat(32),
    IDENTITY_SERVICE_BASE_URL: 'http://service-identity:3010',
    IDENTITY_RECIPIENT_CONTACTS_HEADER_NAME: 'x-internal-api-key',
    IDENTITY_RECIPIENT_CONTACTS_API_KEY: 'b'.repeat(32),
    DUNNING_BILLING_URL: 'https://app.example.com/billing/invoices',
    DUNNING_APP_NAME: 'Taste & See',
    EMAIL_VERIFICATION_URL_BASE: 'http://localhost:3000/verify-email',
    EMAIL_VERIFICATION_NOTIFICATIONS_ENABLED: true,
  };
}

class FakeTemplatesService {
  nextResult: RenderTemplateResult = {
    outcome: 'ok',
    rendered: {
      templateCode: 'welcome',
      locale: 'en-US',
      kind: 'email',
      version: 1,
      subject: 'Welcome Alice',
      bodyHtml: '<p>Hi Alice</p>',
      bodyText: 'Hi Alice',
    },
  };
  async render(): Promise<RenderTemplateResult> {
    return this.nextResult;
  }
}

function buildRequest(headers: Record<string, string> = {}): Request {
  // Express's `request.header(name)` returns the value for a case-
  // insensitive header lookup. Our test stub mirrors that behaviour.
  return {
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

function makeStore(): TenantContextStore {
  return new TenantContextStore();
}

describe('RenderController', () => {
  it('rejects a request missing the shared-secret header with 401', async () => {
    const fakeSvc = new FakeTemplatesService();
    const controller = new RenderController(
      fakeSvc as unknown as TemplatesService,
      buildEnv(),
      makeStore(),
    );
    const request = buildRequest({});

    await expect(
      controller.render({ templateCode: 'welcome', locale: 'en-US' }, request),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a request with a wrong-value shared-secret header with 401', async () => {
    const fakeSvc = new FakeTemplatesService();
    const controller = new RenderController(
      fakeSvc as unknown as TemplatesService,
      buildEnv(),
      makeStore(),
    );
    const request = buildRequest({ 'x-internal-api-key': 'x'.repeat(40) });

    await expect(
      controller.render({ templateCode: 'welcome', locale: 'en-US' }, request),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns the rendered DTO on success', async () => {
    const fakeSvc = new FakeTemplatesService();
    const controller = new RenderController(
      fakeSvc as unknown as TemplatesService,
      buildEnv(),
      makeStore(),
    );
    const request = buildRequest({ 'x-internal-api-key': 'k'.repeat(40) });

    const result = await controller.render({ templateCode: 'welcome', locale: 'en-US' }, request);

    expect(result.templateCode).toBe('welcome');
    expect(result.bodyText).toBe('Hi Alice');
    expect(result.bodyHtml).toBe('<p>Hi Alice</p>');
    expect(result.kind).toBe('email');
  });

  it('maps template_or_active_version_not_found to 404', async () => {
    const fakeSvc = new FakeTemplatesService();
    fakeSvc.nextResult = {
      outcome: 'failed',
      failure: { kind: 'template_or_active_version_not_found' },
    };
    const controller = new RenderController(
      fakeSvc as unknown as TemplatesService,
      buildEnv(),
      makeStore(),
    );
    const request = buildRequest({ 'x-internal-api-key': 'k'.repeat(40) });

    await expect(
      controller.render({ templateCode: 'x', locale: 'en-US' }, request),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps variable_validation_failed to 422 with the issues payload', async () => {
    const fakeSvc = new FakeTemplatesService();
    fakeSvc.nextResult = {
      outcome: 'failed',
      failure: {
        kind: 'variable_validation_failed',
        issues: [
          {
            kind: 'missing_required',
            variableName: 'firstName',
            message: "variable 'firstName' is required by the template",
          },
        ],
      },
    };
    const controller = new RenderController(
      fakeSvc as unknown as TemplatesService,
      buildEnv(),
      makeStore(),
    );
    const request = buildRequest({ 'x-internal-api-key': 'k'.repeat(40) });

    try {
      await controller.render({ templateCode: 'x', locale: 'en-US' }, request);
      throw new Error('expected 422');
    } catch (err) {
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      const body = (err as UnprocessableEntityException).getResponse() as Record<string, unknown>;
      expect(body['errors']).toBeDefined();
      expect(Array.isArray(body['errors'])).toBe(true);
    }
  });

  it('honours a custom NOTIFICATION_RENDER_HEADER_NAME override', async () => {
    const fakeSvc = new FakeTemplatesService();
    const env: Env = {
      ...buildEnv(),
      NOTIFICATION_RENDER_HEADER_NAME: 'x-tns-render',
    };
    const controller = new RenderController(
      fakeSvc as unknown as TemplatesService,
      env,
      makeStore(),
    );
    const request = buildRequest({ 'x-tns-render': 'k'.repeat(40) });

    const result = await controller.render({ templateCode: 'welcome', locale: 'en-US' }, request);

    expect(result.templateCode).toBe('welcome');
  });
});

describe('RenderController tenant-scope exempt wrap (TS-020-followup-2b-platform-rollout)', () => {
  it('seeds an exempt frame at the templates.render collaborator callsite', async () => {
    const store = makeStore();
    let observedFrame: TenantContextFrame | null = null;
    const fakeSvc = {
      async render(): Promise<RenderTemplateResult> {
        observedFrame = store.current();
        return {
          outcome: 'ok',
          rendered: {
            templateCode: 'welcome',
            locale: 'en-US',
            kind: 'email',
            version: 1,
            subject: 'Welcome',
            bodyHtml: '<p>Hi</p>',
            bodyText: 'Hi',
          },
        };
      },
    };
    const controller = new RenderController(
      fakeSvc as unknown as TemplatesService,
      buildEnv(),
      store,
    );
    const request = buildRequest({ 'x-internal-api-key': 'k'.repeat(40) });
    expect(store.current()).toBeNull();
    await controller.render({ templateCode: 'welcome', locale: 'en-US' }, request);
    expect(observedFrame).toEqual({
      kind: 'exempt',
      reason: 'internal-notification-render',
    });
    expect(store.current()).toBeNull();
  });

  it('seeds the exempt frame on the 401 short-circuit path (the header lookup runs inside the wrap)', async () => {
    const store = makeStore();
    let observedFrame: TenantContextFrame | null = null;
    const probingHeader = (name: string): string | undefined => {
      observedFrame = store.current();
      return name === 'x-internal-api-key' ? undefined : undefined;
    };
    const request = { header: probingHeader } as unknown as Request;
    const fakeSvc = new FakeTemplatesService();
    const controller = new RenderController(
      fakeSvc as unknown as TemplatesService,
      buildEnv(),
      store,
    );
    await expect(
      controller.render({ templateCode: 'welcome', locale: 'en-US' }, request),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(observedFrame).toEqual({
      kind: 'exempt',
      reason: 'internal-notification-render',
    });
    expect(store.current()).toBeNull();
  });
});
