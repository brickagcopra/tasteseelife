import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  MySeniorsResponse,
  SeniorAlertPreferencesResponse,
  SeniorConsentResponse,
  SeniorPreferencesResponse,
} from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it } from 'vitest';

import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';

import {
  MeSeniorsProxyController,
  SeniorAlertPreferencesProxyController,
  SeniorConsentProxyController,
  SeniorPreferencesProxyController,
} from './senior-profile-proxy.controller';

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
    userId: 'usr_payer',
    mfaVerified: true,
    roles: [],
    tenantScope: { type: 'household', householdId: 'hh_1' },
  },
  headers: { 'x-trace-id': 'tr_test_214' },
} as unknown as RequestWithContext;

const SAMPLE_SENIORS: MySeniorsResponse = {
  seniors: [
    {
      seniorId: 'senior_mom',
      householdId: 'hh_1',
      firstName: 'Anna',
      lastName: 'Kowalski',
      displayName: 'Bobchi',
      status: 'active',
    },
  ],
};

const SAMPLE_PREFERENCES: SeniorPreferencesResponse = {
  seniorId: 'senior_mom',
  preferences: [
    {
      key: 'favorite_dish',
      value: 'Kielbasa and sauerkraut',
      createdAt: '2026-05-25T12:00:00.000Z',
      updatedAt: '2026-05-25T12:00:00.000Z',
    },
  ],
};

function makeMeController(result: DownstreamResult): {
  controller: MeSeniorsProxyController;
  stub: StubDownstreamClient;
} {
  const stub = new StubDownstreamClient(result);
  const controller = new MeSeniorsProxyController(stub as unknown as DownstreamHttpClient);
  return { controller, stub };
}

function makePrefsController(result: DownstreamResult): {
  controller: SeniorPreferencesProxyController;
  stub: StubDownstreamClient;
} {
  const stub = new StubDownstreamClient(result);
  const controller = new SeniorPreferencesProxyController(stub as unknown as DownstreamHttpClient);
  return { controller, stub };
}

const SAMPLE_CONSENT: SeniorConsentResponse = {
  seniorId: 'senior_mom',
  photos: true,
  notes: false,
  location: false,
  health: true,
  updatedAt: '2026-05-26T12:00:00.000Z',
  updatedByUserId: 'usr_payer',
  canManage: true,
};

function makeConsentController(result: DownstreamResult): {
  controller: SeniorConsentProxyController;
  stub: StubDownstreamClient;
} {
  const stub = new StubDownstreamClient(result);
  const controller = new SeniorConsentProxyController(stub as unknown as DownstreamHttpClient);
  return { controller, stub };
}

const SAMPLE_ALERT_PREFERENCES: SeniorAlertPreferencesResponse = {
  seniorId: 'senior_mom',
  missedVisit: true,
  concerningObservation: false,
  emergencyFlag: true,
  updatedAt: '2026-05-27T12:00:00.000Z',
};

function makeAlertPreferencesController(result: DownstreamResult): {
  controller: SeniorAlertPreferencesProxyController;
  stub: StubDownstreamClient;
} {
  const stub = new StubDownstreamClient(result);
  const controller = new SeniorAlertPreferencesProxyController(
    stub as unknown as DownstreamHttpClient,
  );
  return { controller, stub };
}

describe('MeSeniorsProxyController.list', () => {
  it('forwards to GET /api/v1/me/seniors on the household service', async () => {
    const { controller, stub } = makeMeController({
      kind: 'ok',
      status: 200,
      body: SAMPLE_SENIORS,
      setCookies: [],
    });
    const response = await controller.list(REQUEST_WITH_CTX);
    expect(response).toEqual(SAMPLE_SENIORS);
    expect(stub.lastOptions?.service).toBe('household');
    expect(stub.lastOptions?.path).toBe('/api/v1/me/seniors');
    expect(stub.lastOptions?.method).toBe('GET');
  });

  it('throws Unauthorized when no requestContext', async () => {
    const { controller } = makeMeController({
      kind: 'ok',
      status: 200,
      body: SAMPLE_SENIORS,
      setCookies: [],
    });
    await expect(
      controller.list({ headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps not_configured to 503', async () => {
    const { controller } = makeMeController({ kind: 'not_configured', service: 'household' });
    await expect(controller.list(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('maps timeout to 504', async () => {
    const { controller } = makeMeController({ kind: 'timeout' });
    await expect(controller.list(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('maps a contract-violating ok body to 502', async () => {
    const { controller } = makeMeController({
      kind: 'ok',
      status: 200,
      body: { seniors: [{ seniorId: 'x' }] }, // missing required fields
      setCookies: [],
    });
    await expect(controller.list(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('SeniorPreferencesProxyController.getPreferences', () => {
  it('forwards a URL-encoded seniorId to the household service', async () => {
    const { controller, stub } = makePrefsController({
      kind: 'ok',
      status: 200,
      body: SAMPLE_PREFERENCES,
      setCookies: [],
    });
    const response = await controller.getPreferences('senior_mom', REQUEST_WITH_CTX);
    expect(response).toEqual(SAMPLE_PREFERENCES);
    expect(stub.lastOptions?.path).toBe('/api/v1/seniors/senior_mom/preferences');
    expect(stub.lastOptions?.method).toBe('GET');
  });

  it('re-throws a downstream 403 (non-member) verbatim', async () => {
    const { controller } = makePrefsController({
      kind: 'client_error',
      status: 403,
      body: { type: 'about:blank', title: 'Forbidden' },
      setCookies: [],
    });
    await expect(controller.getPreferences('senior_mom', REQUEST_WITH_CTX)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('SeniorPreferencesProxyController.bulkUpsertPreferences', () => {
  it('forwards a valid body via PATCH and returns the read-back', async () => {
    const { controller, stub } = makePrefsController({
      kind: 'ok',
      status: 200,
      body: SAMPLE_PREFERENCES,
      setCookies: [],
    });
    const response = await controller.bulkUpsertPreferences(
      'senior_mom',
      { entries: [{ key: 'favorite_dish', value: 'Kielbasa and sauerkraut' }] },
      'idem-key-001',
      REQUEST_WITH_CTX,
    );
    expect(response).toEqual(SAMPLE_PREFERENCES);
    expect(stub.lastOptions?.method).toBe('PATCH');
    expect(stub.lastOptions?.path).toBe('/api/v1/seniors/senior_mom/preferences');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-key-001');
  });

  it('rejects a malformed body with 400 before calling downstream', async () => {
    const { controller, stub } = makePrefsController({
      kind: 'ok',
      status: 200,
      body: SAMPLE_PREFERENCES,
      setCookies: [],
    });
    await expect(
      controller.bulkUpsertPreferences(
        'senior_mom',
        { entries: [{ key: 'NOT snake case', value: 'x' }] },
        undefined,
        REQUEST_WITH_CTX,
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('forwards no idempotency-key when the header is absent', async () => {
    const { controller, stub } = makePrefsController({
      kind: 'ok',
      status: 200,
      body: SAMPLE_PREFERENCES,
      setCookies: [],
    });
    await controller.bulkUpsertPreferences(
      'senior_mom',
      { entries: [{ key: 'comfort_food', value: null }] },
      undefined,
      REQUEST_WITH_CTX,
    );
    expect(stub.lastOptions?.idempotencyKey).toBeUndefined();
  });

  it('re-throws a downstream 422 (cap exceeded) verbatim', async () => {
    const { controller } = makePrefsController({
      kind: 'client_error',
      status: 422,
      body: { type: 'about:blank', title: 'Unprocessable Entity' },
      setCookies: [],
    });
    await expect(
      controller.bulkUpsertPreferences(
        'senior_mom',
        { entries: [{ key: 'favorite_dish', value: 'x' }] },
        undefined,
        REQUEST_WITH_CTX,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('SeniorConsentProxyController.getConsent', () => {
  it('forwards a URL-encoded seniorId to the household service', async () => {
    const { controller, stub } = makeConsentController({
      kind: 'ok',
      status: 200,
      body: SAMPLE_CONSENT,
      setCookies: [],
    });
    const response = await controller.getConsent('senior mom', REQUEST_WITH_CTX);
    expect(response).toEqual(SAMPLE_CONSENT);
    expect(stub.lastOptions?.path).toBe('/api/v1/seniors/senior%20mom/consent');
    expect(stub.lastOptions?.method).toBe('GET');
  });

  it('throws Unauthorized when no requestContext', async () => {
    const { controller } = makeConsentController({
      kind: 'ok',
      status: 200,
      body: SAMPLE_CONSENT,
      setCookies: [],
    });
    await expect(
      controller.getConsent('senior_mom', { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps a contract-violating ok body to 502', async () => {
    const { controller } = makeConsentController({
      kind: 'ok',
      status: 200,
      body: { seniorId: 'senior_mom', photos: 'yes' }, // wrong types / missing fields
      setCookies: [],
    });
    await expect(controller.getConsent('senior_mom', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});

describe('SeniorConsentProxyController.setConsent', () => {
  const VALID_FLAGS = { photos: true, notes: false, location: false, health: true };

  it('forwards a valid body via PUT and returns the read-back', async () => {
    const { controller, stub } = makeConsentController({
      kind: 'ok',
      status: 200,
      body: SAMPLE_CONSENT,
      setCookies: [],
    });
    const response = await controller.setConsent(
      'senior_mom',
      VALID_FLAGS,
      'idem-key-consent',
      REQUEST_WITH_CTX,
    );
    expect(response).toEqual(SAMPLE_CONSENT);
    expect(stub.lastOptions?.method).toBe('PUT');
    expect(stub.lastOptions?.path).toBe('/api/v1/seniors/senior_mom/consent');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-key-consent');
    expect(stub.lastOptions?.body).toEqual(VALID_FLAGS);
  });

  it('rejects a malformed body with 400 before calling downstream', async () => {
    const { controller, stub } = makeConsentController({
      kind: 'ok',
      status: 200,
      body: SAMPLE_CONSENT,
      setCookies: [],
    });
    await expect(
      controller.setConsent(
        'senior_mom',
        { photos: true } as unknown, // missing notes/location/health
        undefined,
        REQUEST_WITH_CTX,
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('re-throws a downstream 403 (family observer) verbatim', async () => {
    const { controller } = makeConsentController({
      kind: 'client_error',
      status: 403,
      body: { type: 'about:blank', title: 'Forbidden' },
      setCookies: [],
    });
    await expect(
      controller.setConsent('senior_mom', VALID_FLAGS, undefined, REQUEST_WITH_CTX),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('forwards no idempotency-key when the header is absent', async () => {
    const { controller, stub } = makeConsentController({
      kind: 'ok',
      status: 200,
      body: SAMPLE_CONSENT,
      setCookies: [],
    });
    await controller.setConsent('senior_mom', VALID_FLAGS, undefined, REQUEST_WITH_CTX);
    expect(stub.lastOptions?.idempotencyKey).toBeUndefined();
  });
});

describe('SeniorAlertPreferencesProxyController.getPreferences', () => {
  it('forwards a URL-encoded seniorId to the household service', async () => {
    const { controller, stub } = makeAlertPreferencesController({
      kind: 'ok',
      status: 200,
      body: SAMPLE_ALERT_PREFERENCES,
      setCookies: [],
    });
    const response = await controller.getPreferences('senior mom', REQUEST_WITH_CTX);
    expect(response).toEqual(SAMPLE_ALERT_PREFERENCES);
    expect(stub.lastOptions?.path).toBe('/api/v1/seniors/senior%20mom/alert-preferences');
    expect(stub.lastOptions?.method).toBe('GET');
  });

  it('throws Unauthorized when no requestContext', async () => {
    const { controller } = makeAlertPreferencesController({
      kind: 'ok',
      status: 200,
      body: SAMPLE_ALERT_PREFERENCES,
      setCookies: [],
    });
    await expect(
      controller.getPreferences('senior_mom', { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps a contract-violating ok body to 502', async () => {
    const { controller } = makeAlertPreferencesController({
      kind: 'ok',
      status: 200,
      body: { seniorId: 'senior_mom', missedVisit: 'yes' }, // wrong types / missing fields
      setCookies: [],
    });
    await expect(controller.getPreferences('senior_mom', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('maps a not_configured result to 503', async () => {
    const { controller } = makeAlertPreferencesController({
      kind: 'not_configured',
      service: 'household',
    });
    await expect(controller.getPreferences('senior_mom', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('SeniorAlertPreferencesProxyController.setPreferences', () => {
  const VALID_FLAGS = { missedVisit: false, concerningObservation: true, emergencyFlag: true };

  it('forwards a valid body via PUT and returns the read-back', async () => {
    const { controller, stub } = makeAlertPreferencesController({
      kind: 'ok',
      status: 200,
      body: SAMPLE_ALERT_PREFERENCES,
      setCookies: [],
    });
    const response = await controller.setPreferences(
      'senior_mom',
      VALID_FLAGS,
      'idem-key-alerts',
      REQUEST_WITH_CTX,
    );
    expect(response).toEqual(SAMPLE_ALERT_PREFERENCES);
    expect(stub.lastOptions?.method).toBe('PUT');
    expect(stub.lastOptions?.path).toBe('/api/v1/seniors/senior_mom/alert-preferences');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-key-alerts');
    expect(stub.lastOptions?.body).toEqual(VALID_FLAGS);
  });

  it('rejects a malformed body with 400 before calling downstream', async () => {
    const { controller, stub } = makeAlertPreferencesController({
      kind: 'ok',
      status: 200,
      body: SAMPLE_ALERT_PREFERENCES,
      setCookies: [],
    });
    await expect(
      controller.setPreferences(
        'senior_mom',
        { missedVisit: true } as unknown, // missing concerningObservation/emergencyFlag
        undefined,
        REQUEST_WITH_CTX,
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('re-throws a downstream 403 (non-member) verbatim', async () => {
    const { controller } = makeAlertPreferencesController({
      kind: 'client_error',
      status: 403,
      body: { type: 'about:blank', title: 'Forbidden' },
      setCookies: [],
    });
    await expect(
      controller.setPreferences('senior_mom', VALID_FLAGS, undefined, REQUEST_WITH_CTX),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('forwards no idempotency-key when the header is absent', async () => {
    const { controller, stub } = makeAlertPreferencesController({
      kind: 'ok',
      status: 200,
      body: SAMPLE_ALERT_PREFERENCES,
      setCookies: [],
    });
    await controller.setPreferences('senior_mom', VALID_FLAGS, undefined, REQUEST_WITH_CTX);
    expect(stub.lastOptions?.idempotencyKey).toBeUndefined();
  });

  it('maps a downstream timeout to 504', async () => {
    const { controller } = makeAlertPreferencesController({ kind: 'timeout' });
    await expect(
      controller.setPreferences('senior_mom', VALID_FLAGS, undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(GatewayTimeoutException);
  });
});
