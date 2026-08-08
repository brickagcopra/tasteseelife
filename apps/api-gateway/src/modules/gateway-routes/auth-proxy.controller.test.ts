import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';
import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';
import { AuthProxyMetrics, outcomeFromBody } from './auth-proxy-metrics';
import { AuthProxyController } from './auth-proxy.controller';

function makeStore(): TenantContextStore {
  return new TenantContextStore();
}

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

interface FakeResponse {
  readonly headers: Record<string, string | string[]>;
  setHeader: (name: string, value: string | string[]) => void;
}

function buildFakeResponse(): FakeResponse {
  const headers: Record<string, string | string[]> = {};
  return {
    headers,
    setHeader(name, value) {
      headers[name] = value;
    },
  };
}

const VALID_SIGNUP_INPUT = {
  email: 'alex@example.com',
  password: 'correct-horse-battery-staple',
};
const VALID_SIGNUP_BODY = {
  id: 'usr_abc',
  email: 'alex@example.com',
  phone: null,
  status: 'pending_verification' as const,
  createdAt: '2026-05-17T00:00:00.000Z',
};

const VALID_LOGIN_INPUT = {
  email: 'alex@example.com',
  password: 'correct-horse-battery-staple',
};
const VALID_LOGIN_SESSION_BODY = {
  outcome: 'session' as const,
  accessToken: 'eyJhbG.access.token',
  tokenType: 'Bearer' as const,
  expiresIn: 900,
  user: { id: 'usr_abc', email: 'alex@example.com', status: 'active' as const },
};
const VALID_REFRESH_BODY = {
  accessToken: 'eyJhbG.new.access',
  tokenType: 'Bearer' as const,
  expiresIn: 900,
};

const REQUEST: Request = {
  headers: { 'x-trace-id': 'tr_001' },
} as unknown as Request;

/**
 * Build the controller with the REAL metrics class (TS-121-followup-9). Its
 * instruments come from `getMeter`, a no-op with no SDK booted, so it is free
 * to construct; the spy is what lets the suite assert the outcome label —
 * `session` versus `challenge` in particular, which are both 200s and are
 * therefore invisible in every status-derived signal.
 */
function buildController(stub: unknown): {
  controller: AuthProxyController;
  recordCall: ReturnType<typeof vi.spyOn>;
} {
  const metrics = new AuthProxyMetrics();
  const recordCall = vi.spyOn(metrics, 'recordCall');
  return {
    controller: new AuthProxyController(
      stub as unknown as DownstreamHttpClient,
      makeStore(),
      metrics,
    ),
    recordCall,
  };
}

describe('AuthProxyController.signup', () => {
  it('forwards body to identity, returns the validated SignupResponse, and sets no cookies', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 201,
      body: VALID_SIGNUP_BODY,
      setCookies: [],
    });
    const controller = buildController(stub).controller;
    const res = buildFakeResponse();

    const result = await controller.signup(VALID_SIGNUP_INPUT, REQUEST, res as unknown as Response);
    expect(result.id).toBe('usr_abc');
    expect(result.email).toBe('alex@example.com');
    expect(stub.lastOptions?.service).toBe('identity');
    expect(stub.lastOptions?.path).toBe('/api/v1/auth/signup');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.body).toEqual(VALID_SIGNUP_INPUT);
    expect(stub.lastOptions?.actor).toBeUndefined();
    expect(res.headers['Set-Cookie']).toBeUndefined();
  });

  it('rejects an invalid signup body with 400 BadRequest', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 201,
      body: VALID_SIGNUP_BODY,
      setCookies: [],
    });
    const controller = buildController(stub).controller;
    const res = buildFakeResponse();

    let caught: HttpException | null = null;
    try {
      await controller.signup(
        { email: 'not-an-email', password: 'short' } as never,
        REQUEST,
        res as unknown as Response,
      );
    } catch (err) {
      caught = err as HttpException;
    }
    expect(caught).not.toBeNull();
    expect(caught!.getStatus()).toBe(400);
    expect(stub.lastOptions).toBeNull();
  });

  it('translates a malformed downstream body into BadGatewayException', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 201,
      body: { not: 'a-valid-signup-shape' },
      setCookies: [],
    });
    const controller = buildController(stub).controller;
    const res = buildFakeResponse();
    await expect(
      controller.signup(VALID_SIGNUP_INPUT, REQUEST, res as unknown as Response),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('forwards downstream 4xx status + body verbatim via HttpException', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 409,
      body: {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'email already in use',
      },
      setCookies: [],
    });
    const controller = buildController(stub).controller;
    const res = buildFakeResponse();
    let caught: HttpException | null = null;
    try {
      await controller.signup(VALID_SIGNUP_INPUT, REQUEST, res as unknown as Response);
    } catch (err) {
      caught = err as HttpException;
    }
    expect(caught).not.toBeNull();
    expect(caught!.getStatus()).toBe(409);
    const body = caught!.getResponse() as { detail: string };
    expect(body.detail).toBe('email already in use');
  });

  it('translates not_configured into ServiceUnavailableException with an env-hint', async () => {
    const stub = new StubDownstreamClient({ kind: 'not_configured', service: 'identity' });
    const controller = buildController(stub).controller;
    const res = buildFakeResponse();
    let caught: ServiceUnavailableException | null = null;
    try {
      await controller.signup(VALID_SIGNUP_INPUT, REQUEST, res as unknown as Response);
    } catch (err) {
      caught = err as ServiceUnavailableException;
    }
    expect(caught).not.toBeNull();
    const body = caught!.getResponse() as { detail: string };
    expect(body.detail).toContain('IDENTITY_SERVICE_BASE_URL');
  });
});

describe('AuthProxyController.login', () => {
  it('forwards the login body and propagates the downstream Set-Cookie array', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LOGIN_SESSION_BODY,
      setCookies: ['tas_refresh=abc.def; HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth'],
    });
    const controller = buildController(stub).controller;
    const res = buildFakeResponse();

    const result = await controller.login(VALID_LOGIN_INPUT, REQUEST, res as unknown as Response);
    expect(result.outcome).toBe('session');
    if (result.outcome === 'session') {
      expect(result.accessToken).toBe('eyJhbG.access.token');
    }
    expect(stub.lastOptions?.path).toBe('/api/v1/auth/login');
    expect(stub.lastOptions?.body).toEqual(VALID_LOGIN_INPUT);
    expect(res.headers['Set-Cookie']).toEqual([
      'tas_refresh=abc.def; HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth',
    ]);
  });

  it('rejects an invalid login body with 400 BadRequest', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LOGIN_SESSION_BODY,
      setCookies: [],
    });
    const controller = buildController(stub).controller;
    const res = buildFakeResponse();
    let caught: HttpException | null = null;
    try {
      await controller.login(
        { email: '', password: '' } as never,
        REQUEST,
        res as unknown as Response,
      );
    } catch (err) {
      caught = err as HttpException;
    }
    expect(caught).not.toBeNull();
    expect(caught!.getStatus()).toBe(400);
    expect(stub.lastOptions).toBeNull();
  });

  it('translates a malformed downstream body into BadGatewayException', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { outcome: 'undefined-variant' },
      setCookies: [],
    });
    const controller = buildController(stub).controller;
    const res = buildFakeResponse();
    await expect(
      controller.login(VALID_LOGIN_INPUT, REQUEST, res as unknown as Response),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('forwards a downstream 401 verbatim via HttpException + propagates clearing cookies', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 401,
      body: {
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'Invalid credentials.',
      },
      setCookies: ['tas_refresh=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/api/v1/auth'],
    });
    const controller = buildController(stub).controller;
    const res = buildFakeResponse();
    let caught: HttpException | null = null;
    try {
      await controller.login(VALID_LOGIN_INPUT, REQUEST, res as unknown as Response);
    } catch (err) {
      caught = err as HttpException;
    }
    expect(caught).not.toBeNull();
    expect(caught!.getStatus()).toBe(401);
    expect(res.headers['Set-Cookie']).toEqual([
      'tas_refresh=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/api/v1/auth',
    ]);
  });

  it('translates timeout into GatewayTimeoutException', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    const controller = buildController(stub).controller;
    const res = buildFakeResponse();
    await expect(
      controller.login(VALID_LOGIN_INPUT, REQUEST, res as unknown as Response),
    ).rejects.toBeInstanceOf(GatewayTimeoutException);
  });
});

describe('AuthProxyController.mfaVerify', () => {
  const VALID_MFA_VERIFY_INPUT = {
    challengeToken: 'eyJhbG.challenge.token',
    code: '123456',
  };

  it('forwards the verify body, validates the LoginSession response, and propagates Set-Cookie', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LOGIN_SESSION_BODY,
      setCookies: [
        'tas_refresh=verified.refresh; HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth',
      ],
    });
    const controller = buildController(stub).controller;
    const res = buildFakeResponse();

    const result = await controller.mfaVerify(
      VALID_MFA_VERIFY_INPUT,
      REQUEST,
      res as unknown as Response,
    );
    expect(result.outcome).toBe('session');
    expect(result.accessToken).toBe('eyJhbG.access.token');
    expect(stub.lastOptions?.service).toBe('identity');
    expect(stub.lastOptions?.path).toBe('/api/v1/auth/mfa/verify');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.body).toEqual(VALID_MFA_VERIFY_INPUT);
    expect(stub.lastOptions?.actor).toBeUndefined();
    expect(res.headers['Set-Cookie']).toEqual([
      'tas_refresh=verified.refresh; HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth',
    ]);
  });

  it('rejects a malformed verify body (non-6-digit code) with 400 BadRequest', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LOGIN_SESSION_BODY,
      setCookies: [],
    });
    const controller = buildController(stub).controller;
    const res = buildFakeResponse();
    let caught: HttpException | null = null;
    try {
      await controller.mfaVerify(
        { challengeToken: 'tok', code: '12345' } as never,
        REQUEST,
        res as unknown as Response,
      );
    } catch (err) {
      caught = err as HttpException;
    }
    expect(caught).not.toBeNull();
    expect(caught!.getStatus()).toBe(400);
    expect(stub.lastOptions).toBeNull();
  });

  it('translates a malformed downstream body into BadGatewayException', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      // Downstream returned a non-session body (e.g. accidentally returned
      // a challenge response). The proxy's contract is LoginSession only.
      body: { outcome: 'challenge', challengeToken: 'x', expiresIn: 300 },
      setCookies: [],
    });
    const controller = buildController(stub).controller;
    const res = buildFakeResponse();
    await expect(
      controller.mfaVerify(VALID_MFA_VERIFY_INPUT, REQUEST, res as unknown as Response),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('forwards a downstream 401 verbatim via HttpException (generic — no enumeration)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 401,
      body: {
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'Invalid email or password.',
      },
      setCookies: [],
    });
    const controller = buildController(stub).controller;
    const res = buildFakeResponse();
    let caught: HttpException | null = null;
    try {
      await controller.mfaVerify(VALID_MFA_VERIFY_INPUT, REQUEST, res as unknown as Response);
    } catch (err) {
      caught = err as HttpException;
    }
    expect(caught).not.toBeNull();
    expect(caught!.getStatus()).toBe(401);
  });

  it('translates timeout into GatewayTimeoutException', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    const controller = buildController(stub).controller;
    const res = buildFakeResponse();
    await expect(
      controller.mfaVerify(VALID_MFA_VERIFY_INPUT, REQUEST, res as unknown as Response),
    ).rejects.toBeInstanceOf(GatewayTimeoutException);
  });
});

describe('AuthProxyController.refresh', () => {
  it('forwards the inbound Cookie header to the downstream', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_REFRESH_BODY,
      setCookies: ['tas_refresh=new.value; HttpOnly; Secure'],
    });
    const controller = buildController(stub).controller;
    const res = buildFakeResponse();
    const request = {
      headers: { 'x-trace-id': 'tr_002', cookie: 'tas_refresh=old.value' },
    } as unknown as RequestWithContext;

    const result = await controller.refresh(request, res as unknown as Response);
    expect(result.accessToken).toBe('eyJhbG.new.access');
    expect(stub.lastOptions?.cookieHeader).toBe('tas_refresh=old.value');
    expect(res.headers['Set-Cookie']).toEqual(['tas_refresh=new.value; HttpOnly; Secure']);
  });

  it('still calls downstream when no Cookie header is supplied (downstream returns 401)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 401,
      body: {
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'missing cookie',
      },
      setCookies: [],
    });
    const controller = buildController(stub).controller;
    const res = buildFakeResponse();
    const request = { headers: {} } as unknown as RequestWithContext;
    await expect(controller.refresh(request, res as unknown as Response)).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(stub.lastOptions?.cookieHeader).toBeUndefined();
  });
});

/**
 * Frame-capture tests for the four exempt wraps introduced under
 * TS-020-followup-2b-platform-rollout. Each wrapped handler is
 * exercised against a real `TenantContextStore`; a tracking downstream
 * client captures `store.current()` at the collaborator callsite and
 * the test asserts the frame equals `{ kind: 'exempt', reason: '...' }`
 * with the expected reason string. The no-frame-leak invariant
 * (store.current() === null BEFORE and AFTER the handler) is pinned
 * for both happy and short-circuit paths.
 *
 * The structural difference from the eleven prior Prisma-owning
 * rollouts (service-identity / service-household / ... / service-media)
 * + the twelfth Prisma-less rollout (service-search) is that
 * api-gateway has NO Prisma; the wraps are defence-in-depth + parity
 * scaffolding, not an enforcement-critical body. The tests still pin
 * the wire-shape invariant so a future maintainer adding Prisma here
 * cannot accidentally hoist a Prisma call OUTSIDE the wrap by adding
 * "just one tiny read" between the existing collaborator return and
 * post-processing.
 */
class TrackingDownstreamClient {
  public lastFrame: TenantContextFrame | null = null;
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(
    private readonly store: TenantContextStore,
    private readonly result: DownstreamResult,
  ) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    this.lastFrame = this.store.current();
    return this.result as DownstreamResult<TBody>;
  }
}

describe('AuthProxyController tenant-scope exempt wrap (TS-020-followup-2b-platform-rollout)', () => {
  it('seeds gateway-pre-auth-signup at the downstream.call site on the happy signup path', async () => {
    const store = makeStore();
    const tracker = new TrackingDownstreamClient(store, {
      kind: 'ok',
      status: 201,
      body: VALID_SIGNUP_BODY,
      setCookies: [],
    });
    const controller = new AuthProxyController(
      tracker as unknown as DownstreamHttpClient,
      store,
      new AuthProxyMetrics(),
    );
    const res = buildFakeResponse();

    expect(store.current()).toBeNull();
    await controller.signup(VALID_SIGNUP_INPUT, REQUEST, res as unknown as Response);
    expect(tracker.lastFrame).toEqual({
      kind: 'exempt',
      reason: 'gateway-pre-auth-signup',
    });
    expect(store.current()).toBeNull();
  });

  it('seeds gateway-pre-auth-login at the downstream.call site on the happy login path', async () => {
    const store = makeStore();
    const tracker = new TrackingDownstreamClient(store, {
      kind: 'ok',
      status: 200,
      body: VALID_LOGIN_SESSION_BODY,
      setCookies: [],
    });
    const controller = new AuthProxyController(
      tracker as unknown as DownstreamHttpClient,
      store,
      new AuthProxyMetrics(),
    );
    const res = buildFakeResponse();

    expect(store.current()).toBeNull();
    await controller.login(VALID_LOGIN_INPUT, REQUEST, res as unknown as Response);
    expect(tracker.lastFrame).toEqual({
      kind: 'exempt',
      reason: 'gateway-pre-auth-login',
    });
    expect(store.current()).toBeNull();
  });

  it('seeds gateway-pre-auth-refresh at the downstream.call site on the happy refresh path', async () => {
    const store = makeStore();
    const tracker = new TrackingDownstreamClient(store, {
      kind: 'ok',
      status: 200,
      body: VALID_REFRESH_BODY,
      setCookies: [],
    });
    const controller = new AuthProxyController(
      tracker as unknown as DownstreamHttpClient,
      store,
      new AuthProxyMetrics(),
    );
    const res = buildFakeResponse();
    const request = {
      headers: { 'x-trace-id': 'tr_003', cookie: 'tas_refresh=old.value' },
    } as unknown as RequestWithContext;

    expect(store.current()).toBeNull();
    await controller.refresh(request, res as unknown as Response);
    expect(tracker.lastFrame).toEqual({
      kind: 'exempt',
      reason: 'gateway-pre-auth-refresh',
    });
    expect(store.current()).toBeNull();
  });

  it('seeds gateway-pre-auth-mfa-verify at the downstream.call site on the happy verify path', async () => {
    const store = makeStore();
    const tracker = new TrackingDownstreamClient(store, {
      kind: 'ok',
      status: 200,
      body: VALID_LOGIN_SESSION_BODY,
      setCookies: [],
    });
    const controller = new AuthProxyController(
      tracker as unknown as DownstreamHttpClient,
      store,
      new AuthProxyMetrics(),
    );
    const res = buildFakeResponse();
    const VALID_MFA_VERIFY_INPUT = {
      challengeToken: 'eyJhbG.challenge.token',
      code: '123456',
    };

    expect(store.current()).toBeNull();
    await controller.mfaVerify(VALID_MFA_VERIFY_INPUT, REQUEST, res as unknown as Response);
    expect(tracker.lastFrame).toEqual({
      kind: 'exempt',
      reason: 'gateway-pre-auth-mfa-verify',
    });
    expect(store.current()).toBeNull();
  });

  it('does not leak a frame outside the wrap on a 400-validation short-circuit (signup)', async () => {
    const store = makeStore();
    const tracker = new TrackingDownstreamClient(store, {
      kind: 'ok',
      status: 201,
      body: VALID_SIGNUP_BODY,
      setCookies: [],
    });
    const controller = new AuthProxyController(
      tracker as unknown as DownstreamHttpClient,
      store,
      new AuthProxyMetrics(),
    );
    const res = buildFakeResponse();

    expect(store.current()).toBeNull();
    await expect(
      controller.signup(
        { email: 'not-an-email', password: 'short' } as never,
        REQUEST,
        res as unknown as Response,
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(tracker.lastOptions).toBeNull();
    expect(store.current()).toBeNull();
  });

  it('does not leak a frame outside the wrap on a downstream 4xx (login)', async () => {
    const store = makeStore();
    const tracker = new TrackingDownstreamClient(store, {
      kind: 'client_error',
      status: 401,
      body: { type: 'about:blank', title: 'Unauthorized', status: 401, detail: 'bad' },
      setCookies: [],
    });
    const controller = new AuthProxyController(
      tracker as unknown as DownstreamHttpClient,
      store,
      new AuthProxyMetrics(),
    );
    const res = buildFakeResponse();

    expect(store.current()).toBeNull();
    await expect(
      controller.login(VALID_LOGIN_INPUT, REQUEST, res as unknown as Response),
    ).rejects.toBeInstanceOf(HttpException);
    expect(tracker.lastFrame).toEqual({
      kind: 'exempt',
      reason: 'gateway-pre-auth-login',
    });
    expect(store.current()).toBeNull();
  });
});

describe('AuthProxyController — outcome metric (TS-121-followup-9)', () => {
  it('records a login SESSION and a login CHALLENGE as different outcomes', async () => {
    // Both are 200s on the same route. Without this label the one number
    // that says whether MFA enrolment is actually protecting logins does not
    // exist anywhere, and a collapse of `challenge` toward zero — what an
    // MFA bypass looks like from outside — is invisible.
    const sessionStub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LOGIN_SESSION_BODY,
      setCookies: [],
    });
    const session = buildController(sessionStub);
    await session.controller.login(
      VALID_LOGIN_INPUT,
      REQUEST,
      buildFakeResponse() as unknown as Response,
    );
    expect(session.recordCall).toHaveBeenCalledTimes(1);
    expect(session.recordCall).toHaveBeenCalledWith('login', 'session');

    const challengeStub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { outcome: 'challenge', challengeToken: 'eyJ.challenge', expiresIn: 300 },
      setCookies: [],
    });
    const challenge = buildController(challengeStub);
    await challenge.controller.login(
      VALID_LOGIN_INPUT,
      REQUEST,
      buildFakeResponse() as unknown as Response,
    );
    expect(challenge.recordCall).toHaveBeenCalledWith('login', 'challenge');
  });

  it('records a signup as `ok` — its contract names no outcome', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 201,
      body: VALID_SIGNUP_BODY,
      setCookies: [],
    });
    const { controller, recordCall } = buildController(stub);

    await controller.signup(
      VALID_SIGNUP_INPUT,
      REQUEST,
      buildFakeResponse() as unknown as Response,
    );

    expect(recordCall).toHaveBeenCalledWith('signup', 'ok');
  });

  it('records a gateway-side validation failure as `invalid_request`, before any downstream call', async () => {
    // A 400 from us and a 401 from identity are both "the caller failed";
    // only one of them means somebody is probing the shape of the API.
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LOGIN_SESSION_BODY,
      setCookies: [],
    });
    const { controller, recordCall } = buildController(stub);

    await expect(
      controller.login(
        { email: 'not-an-email' } as never,
        REQUEST,
        buildFakeResponse() as unknown as Response,
      ),
    ).rejects.toBeInstanceOf(HttpException);

    expect(recordCall).toHaveBeenCalledWith('login', 'invalid_request');
    expect(stub.lastOptions).toBeNull();
  });

  it('records a drifted 200 body as `contract_violation`, NOT as a server error', async () => {
    // The gateway renders this as a 502, which in the status series is
    // indistinguishable from a downstream 5xx — and it means something else
    // entirely: gateway/identity deploy skew, not a failing service.
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { outcome: 'session', accessToken: 'tok' },
      setCookies: [],
    });
    const { controller, recordCall } = buildController(stub);

    await expect(
      controller.login(VALID_LOGIN_INPUT, REQUEST, buildFakeResponse() as unknown as Response),
    ).rejects.toBeInstanceOf(BadGatewayException);

    expect(recordCall).toHaveBeenCalledWith('login', 'contract_violation');
  });

  it.each([
    [{ kind: 'client_error', status: 401, body: {}, setCookies: [] }, 'client_error'],
    [{ kind: 'server_error', status: 503, body: {}, setCookies: [] }, 'server_error'],
    [{ kind: 'timeout' }, 'timeout'],
    [{ kind: 'network_error', detail: 'ECONNREFUSED' }, 'network_error'],
    [{ kind: 'not_configured', service: 'identity' }, 'not_configured'],
  ] as const)('records a downstream %# failure as `%s`', async (result, outcome) => {
    const stub = new StubDownstreamClient(result as DownstreamResult);
    const { controller, recordCall } = buildController(stub);

    await expect(
      controller.login(VALID_LOGIN_INPUT, REQUEST, buildFakeResponse() as unknown as Response),
    ).rejects.toBeInstanceOf(Error);

    expect(recordCall).toHaveBeenCalledWith('login', outcome);
  });

  it('carries NO email, user id or token into the labels', async () => {
    // This is the surface where a careless label puts a credential-adjacent
    // identifier into a metrics backend (CLAUDE.md §10, §17.2).
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_LOGIN_SESSION_BODY,
      setCookies: [],
    });
    const { controller, recordCall } = buildController(stub);

    await controller.login(VALID_LOGIN_INPUT, REQUEST, buildFakeResponse() as unknown as Response);

    const serialised = JSON.stringify(recordCall.mock.calls);
    expect(serialised).not.toContain('alex@example.com');
    expect(serialised).not.toContain('usr_abc');
    expect(serialised).not.toContain('eyJhbG.access.token');
  });
});

describe('outcomeFromBody', () => {
  it('reads the contract discriminator when there is one', () => {
    expect(outcomeFromBody({ outcome: 'challenge' })).toBe('challenge');
    expect(outcomeFromBody({ outcome: 'session' })).toBe('session');
  });

  it('falls back to `ok` for a body with no outcome field', () => {
    expect(outcomeFromBody(VALID_SIGNUP_BODY)).toBe('ok');
  });

  it('refuses to mint a label from an unrecognised discriminator', () => {
    // A body field, even a validated one, must not be able to create metric
    // series — that is an unbounded-cardinality hole with a downstream
    // service on the other end of it.
    expect(outcomeFromBody({ outcome: 'something_new' })).toBe('ok');
    expect(outcomeFromBody(null)).toBe('ok');
    expect(outcomeFromBody('a string')).toBe('ok');
  });
});
