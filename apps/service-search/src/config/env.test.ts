import { describe, expect, it } from 'vitest';

import {
  EnvValidationError,
  isSearchBackendStubMode,
  isSponsoredListingsEnabled,
  loadEnv,
} from './env';

const REQUIRED: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://test:test@localhost:5432/search_test',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
  SEARCH_INDEX_API_KEY: 'y'.repeat(32),
};

describe('loadEnv', () => {
  it('parses with the minimum required env', () => {
    const env = loadEnv(REQUIRED);
    expect(env.PORT).toBe(3020);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.SERVICE_VERSION).toBe('dev');
    expect(env.JWT_ISSUER).toBe('taste-and-see/service-identity');
    expect(env.JWT_AUDIENCE).toBe('taste-and-see/api');
    expect(env.SEARCH_PROVIDER_INDEX_NAME).toBe('providers_v1');
    expect(env.SEARCH_INDEX_HEADER_NAME).toBe('x-internal-api-key');
    expect(env.ELASTICSEARCH_NODE_URL).toBeUndefined();
    expect(env.ELASTICSEARCH_TLS_REJECT_UNAUTHORIZED).toBe(true);
    // TS-211 — fallback defaults now match the seeded `global` row.
    expect(env.SEARCH_TIER_BOOST_BASIC).toBe(1.0);
    expect(env.SEARCH_TIER_BOOST_CERTIFIED).toBe(1.2);
    expect(env.SEARCH_TIER_BOOST_ELITE).toBe(1.5);
    // TS-210 — geo-distance decay scale defaults to 25 miles in km.
    expect(env.SEARCH_GEO_DECAY_SCALE_KM).toBe(40.2336);
    // TS-217-prep-1 — outbox producer name defaults to the service name.
    expect(env.OUTBOX_PRODUCER_SERVICE).toBe('service-search');
  });

  it('honours a custom OUTBOX_PRODUCER_SERVICE override (TS-217-prep-1)', () => {
    const env = loadEnv({ ...REQUIRED, OUTBOX_PRODUCER_SERVICE: 'service-search-canary' });
    expect(env.OUTBOX_PRODUCER_SERVICE).toBe('service-search-canary');
  });

  it('requires DATABASE_URL — service-search now owns the `search` Postgres schema (TS-211)', () => {
    const { ['DATABASE_URL']: _, ...withoutDb } = REQUIRED;
    void _;
    expect(() => loadEnv(withoutDb)).toThrow(EnvValidationError);
  });

  it('rejects malformed DATABASE_URL', () => {
    expect(() => loadEnv({ ...REQUIRED, DATABASE_URL: 'not-a-url' })).toThrow(EnvValidationError);
  });

  it('coerces PORT from string', () => {
    const env = loadEnv({ ...REQUIRED, PORT: '4050' });
    expect(env.PORT).toBe(4050);
  });

  it('coerces tier boost weights from string', () => {
    const env = loadEnv({ ...REQUIRED, SEARCH_TIER_BOOST_ELITE: '3.25' });
    expect(env.SEARCH_TIER_BOOST_ELITE).toBe(3.25);
  });

  it('rejects a short JWT secret', () => {
    expect(() => loadEnv({ ...REQUIRED, JWT_ACCESS_SECRET: 'too-short' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects a short search index API key', () => {
    expect(() => loadEnv({ ...REQUIRED, SEARCH_INDEX_API_KEY: 'too-short' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects unknown NODE_ENV', () => {
    expect(() => loadEnv({ ...REQUIRED, NODE_ENV: 'qa' })).toThrow(EnvValidationError);
  });

  it('rejects malformed ELASTICSEARCH_NODE_URL', () => {
    expect(() => loadEnv({ ...REQUIRED, ELASTICSEARCH_NODE_URL: 'not-a-url' })).toThrow(
      EnvValidationError,
    );
  });

  it('accepts well-formed ELASTICSEARCH_NODE_URL', () => {
    const env = loadEnv({ ...REQUIRED, ELASTICSEARCH_NODE_URL: 'https://es.example.com:9200' });
    expect(env.ELASTICSEARCH_NODE_URL).toBe('https://es.example.com:9200');
  });

  it('ignores undeclared env keys (tolerates ambient / k8s-injected vars)', () => {
    // TS-153: a pod's process.env carries PATH/HOME + Kubernetes-injected
    // POD_* and <SERVICE>_SERVICE_HOST/_PORT vars; loadEnv strips undeclared
    // keys rather than CrashLoop on them at boot.
    const env = loadEnv({ ...REQUIRED, EXTRA_FIELD: 'oops' });
    expect((env as Record<string, unknown>).EXTRA_FIELD).toBeUndefined();
  });

  it('rejects production with TLS verification disabled', () => {
    expect(() =>
      loadEnv({
        ...REQUIRED,
        NODE_ENV: 'production',
        ELASTICSEARCH_TLS_REJECT_UNAUTHORIZED: 'false',
      }),
    ).toThrow(EnvValidationError);
  });

  it('allows non-production with TLS verification disabled', () => {
    const env = loadEnv({
      ...REQUIRED,
      NODE_ENV: 'development',
      ELASTICSEARCH_TLS_REJECT_UNAUTHORIZED: 'false',
    });
    expect(env.ELASTICSEARCH_TLS_REJECT_UNAUTHORIZED).toBe(false);
  });

  it('rejects malformed index name', () => {
    expect(() => loadEnv({ ...REQUIRED, SEARCH_PROVIDER_INDEX_NAME: 'Providers V1!' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects zero tier boost', () => {
    expect(() => loadEnv({ ...REQUIRED, SEARCH_TIER_BOOST_ELITE: '0' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects negative tier boost', () => {
    expect(() => loadEnv({ ...REQUIRED, SEARCH_TIER_BOOST_CERTIFIED: '-1' })).toThrow(
      EnvValidationError,
    );
  });

  it('coerces SEARCH_GEO_DECAY_SCALE_KM from string (TS-210)', () => {
    const env = loadEnv({ ...REQUIRED, SEARCH_GEO_DECAY_SCALE_KM: '15' });
    expect(env.SEARCH_GEO_DECAY_SCALE_KM).toBe(15);
  });

  it('rejects a non-positive geo decay scale (TS-210)', () => {
    expect(() => loadEnv({ ...REQUIRED, SEARCH_GEO_DECAY_SCALE_KM: '0' })).toThrow(
      EnvValidationError,
    );
    expect(() => loadEnv({ ...REQUIRED, SEARCH_GEO_DECAY_SCALE_KM: '-5' })).toThrow(
      EnvValidationError,
    );
  });
});

describe('sponsored-listings resolve env (TS-218b)', () => {
  const ADS_KEY = 'z'.repeat(32);

  it('leaves the ADS_* knobs absent by default (feature gated off)', () => {
    const env = loadEnv(REQUIRED);
    expect(env.ADS_SERVICE_BASE_URL).toBeUndefined();
    expect(env.ADS_INTERNAL_API_KEY).toBeUndefined();
    expect(env.ADS_INTERNAL_HEADER_NAME).toBeUndefined();
    expect(env.SEARCH_SPONSORED_SLOTS).toBeUndefined();
    expect(env.ADS_RESOLVE_TIMEOUT_MS).toBeUndefined();
    expect(isSponsoredListingsEnabled(env)).toBe(false);
  });

  it('enables the feature when the base URL + shared secret are supplied', () => {
    const env = loadEnv({
      ...REQUIRED,
      ADS_SERVICE_BASE_URL: 'http://service-ads:3024',
      ADS_INTERNAL_API_KEY: ADS_KEY,
      SEARCH_SPONSORED_SLOTS: '3',
      ADS_RESOLVE_TIMEOUT_MS: '500',
    });
    expect(isSponsoredListingsEnabled(env)).toBe(true);
    expect(env.SEARCH_SPONSORED_SLOTS).toBe(3);
    expect(env.ADS_RESOLVE_TIMEOUT_MS).toBe(500);
  });

  it('requires the shared secret when the base URL is set', () => {
    expect(() => loadEnv({ ...REQUIRED, ADS_SERVICE_BASE_URL: 'http://service-ads:3024' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects a short ADS_INTERNAL_API_KEY', () => {
    expect(() =>
      loadEnv({
        ...REQUIRED,
        ADS_SERVICE_BASE_URL: 'http://service-ads:3024',
        ADS_INTERNAL_API_KEY: 'too-short',
      }),
    ).toThrow(EnvValidationError);
  });

  it('rejects a malformed ADS_SERVICE_BASE_URL', () => {
    expect(() =>
      loadEnv({ ...REQUIRED, ADS_SERVICE_BASE_URL: 'not-a-url', ADS_INTERNAL_API_KEY: ADS_KEY }),
    ).toThrow(EnvValidationError);
  });

  it('rejects a sponsored-slot count above the resolve ceiling', () => {
    expect(() =>
      loadEnv({
        ...REQUIRED,
        ADS_SERVICE_BASE_URL: 'http://service-ads:3024',
        ADS_INTERNAL_API_KEY: ADS_KEY,
        SEARCH_SPONSORED_SLOTS: '99',
      }),
    ).toThrow(EnvValidationError);
  });
});

describe('OTel observability knobs (TS-111-followup-4)', () => {
  it('defaults both flags on when unset', () => {
    const env = loadEnv(REQUIRED);
    expect(env.OTEL_TRACES_ENABLED).toBe(true);
    expect(env.OTEL_METRICS_ENABLED).toBe(true);
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });

  it('coerces the string "false" to a boolean false', () => {
    const env = loadEnv({
      ...REQUIRED,
      OTEL_TRACES_ENABLED: 'false',
      OTEL_METRICS_ENABLED: 'false',
    });
    expect(env.OTEL_TRACES_ENABLED).toBe(false);
    expect(env.OTEL_METRICS_ENABLED).toBe(false);
  });

  it('accepts a valid OTLP endpoint URL', () => {
    const env = loadEnv({
      ...REQUIRED,
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318/v1/traces',
    });
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://otel-collector:4318/v1/traces');
  });

  it('rejects a malformed OTLP endpoint URL', () => {
    expect(() => loadEnv({ ...REQUIRED, OTEL_EXPORTER_OTLP_ENDPOINT: 'not-a-url' })).toThrow(
      EnvValidationError,
    );
  });
});

describe('isSearchBackendStubMode', () => {
  it('returns true when ELASTICSEARCH_NODE_URL is absent', () => {
    const env = loadEnv(REQUIRED);
    expect(isSearchBackendStubMode(env)).toBe(true);
  });

  it('returns false when ELASTICSEARCH_NODE_URL is supplied', () => {
    const env = loadEnv({ ...REQUIRED, ELASTICSEARCH_NODE_URL: 'https://es.example.com:9200' });
    expect(isSearchBackendStubMode(env)).toBe(false);
  });
});
