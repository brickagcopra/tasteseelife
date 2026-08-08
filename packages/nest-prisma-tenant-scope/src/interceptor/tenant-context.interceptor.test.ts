import 'reflect-metadata';

import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import { firstValueFrom, Observable, of, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { validateOptions } from '../config';
import { TenantContextStore } from '../context/context-store';
import { TenantContextInterceptor } from './tenant-context.interceptor';

const sampleContext = (): RequestContext => ({
  userId: 'usr_1',
  mfaVerified: true,
  roles: [],
  tenantScope: { type: 'global' },
});

function makeExecutionContext(
  request: Record<string, unknown>,
  type: 'http' | 'rpc' = 'http',
): ExecutionContext {
  return {
    getType: () => type,
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

function makeInterceptor(overrides: {
  store?: TenantContextStore;
  enforcement?: 'audit' | 'enforce';
  actorResolver?: (req: { requestContext?: unknown }) => unknown;
}): { interceptor: TenantContextInterceptor; store: TenantContextStore } {
  const store = overrides.store ?? new TenantContextStore();
  const options = validateOptions({
    serviceName: 'service-test',
    environment: 'test',
    ...(overrides.enforcement !== undefined && { enforcement: overrides.enforcement }),
    ...(overrides.actorResolver !== undefined && { actorResolver: overrides.actorResolver }),
  });
  return {
    interceptor: new TenantContextInterceptor(store, options),
    store,
  };
}

describe('TenantContextInterceptor', () => {
  describe('frame seeding', () => {
    it('seeds the store with the request context for the lifetime of next.handle()', async () => {
      const { interceptor, store } = makeInterceptor({});
      const ctx = sampleContext();
      const request = { requestContext: ctx };
      const execution = makeExecutionContext(request);

      let observedInside: RequestContext | null = null;
      // The interceptor subscribes to next.handle() inside store.run(...) —
      // a custom Observable that reads the frame at subscription time
      // proves the frame is visible to downstream work.
      const next: CallHandler = {
        handle: () =>
          new Observable((subscriber) => {
            const frame = store.current();
            if (frame?.kind === 'scoped') observedInside = frame.context;
            subscriber.next('ok');
            subscriber.complete();
          }),
      };

      const stream = interceptor.intercept(execution, next);
      await firstValueFrom(stream);
      expect(observedInside).toBe(ctx);
      expect(store.current()).toBeNull();
    });

    it('passes through unchanged when the request has no requestContext', async () => {
      const { interceptor, store } = makeInterceptor({});
      const execution = makeExecutionContext({});

      let observedInside: unknown = 'unset';
      const next: CallHandler = {
        handle: () => {
          observedInside = store.current();
          return of('plain');
        },
      };

      const stream = interceptor.intercept(execution, next);
      await expect(firstValueFrom(stream)).resolves.toBe('plain');
      expect(observedInside).toBeNull();
    });

    it('passes through unchanged when the requestContext fails the shape guard', async () => {
      const { interceptor, store } = makeInterceptor({});
      const execution = makeExecutionContext({
        requestContext: { userId: 'usr_1' /* missing required fields */ },
      });

      let observedInside: unknown = 'unset';
      const next: CallHandler = {
        handle: () => {
          observedInside = store.current();
          return of('plain');
        },
      };

      const stream = interceptor.intercept(execution, next);
      await expect(firstValueFrom(stream)).resolves.toBe('plain');
      expect(observedInside).toBeNull();
    });

    it('passes through unchanged on a non-http execution context (rpc / ws)', async () => {
      const { interceptor, store } = makeInterceptor({});
      const execution = makeExecutionContext({ requestContext: sampleContext() }, 'rpc');

      let observedInside: unknown = 'unset';
      const next: CallHandler = {
        handle: () => {
          observedInside = store.current();
          return of('rpc');
        },
      };

      const stream = interceptor.intercept(execution, next);
      await expect(firstValueFrom(stream)).resolves.toBe('rpc');
      expect(observedInside).toBeNull();
    });

    it('respects a custom actorResolver that returns null', async () => {
      const { interceptor, store } = makeInterceptor({
        actorResolver: () => null,
      });
      const execution = makeExecutionContext({ requestContext: sampleContext() });

      let observedInside: unknown = 'unset';
      const next: CallHandler = {
        handle: () => {
          observedInside = store.current();
          return of('null-actor');
        },
      };

      await firstValueFrom(interceptor.intercept(execution, next));
      expect(observedInside).toBeNull();
    });

    it('respects a custom actorResolver that returns the request context from a custom slot', async () => {
      const { interceptor, store } = makeInterceptor({
        actorResolver: (req: { requestContext?: unknown }) =>
          (req as { auth?: { context?: unknown }; requestContext?: unknown }).auth?.context ??
          req.requestContext,
      });
      const ctx = sampleContext();
      const execution = makeExecutionContext({ auth: { context: ctx } });

      let observedInside: unknown = 'unset';
      const next: CallHandler = {
        handle: () => {
          observedInside = store.current();
          return of('custom-slot');
        },
      };

      await firstValueFrom(interceptor.intercept(execution, next));
      expect(observedInside).toMatchObject({ kind: 'scoped' });
    });
  });

  describe('error propagation', () => {
    it('passes errors from next.handle() through unchanged', async () => {
      const { interceptor } = makeInterceptor({});
      const execution = makeExecutionContext({ requestContext: sampleContext() });

      const boom = new Error('boom');
      const next: CallHandler = {
        handle: () => throwError(() => boom),
      };

      await expect(firstValueFrom(interceptor.intercept(execution, next))).rejects.toBe(boom);
    });
  });

  describe('async work inside the handler', () => {
    it('preserves the frame across an await inside the downstream pipeline', async () => {
      const { interceptor, store } = makeInterceptor({});
      const execution = makeExecutionContext({ requestContext: sampleContext() });

      let observedAfterAwait: unknown = 'unset';
      const next: CallHandler = {
        handle: () =>
          new Observable((subscriber) => {
            // Schedule an async read of the store AFTER an await. The
            // AsyncLocalStorage frame must propagate through the await.
            void (async () => {
              await new Promise((resolve) => setImmediate(resolve));
              observedAfterAwait = store.current();
              subscriber.next('done');
              subscriber.complete();
            })();
          }),
      };

      await firstValueFrom(interceptor.intercept(execution, next));
      const frame = observedAfterAwait as { kind?: string } | null;
      expect(frame?.kind).toBe('scoped');
    });
  });
});
