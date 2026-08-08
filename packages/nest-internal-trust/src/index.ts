export { TRUST_HEADERS, TRUST_HEADER_VERSION } from './headers';
export type { TrustHeaders } from './headers';

export { buildCanonicalInput, decodeBase64Url, encodeBase64Url } from './canonical';

export { signTrustHeaders } from './signer';

export { verifyTrustHeaders } from './verifier';
export type { VerifyTrustHeadersOptions, VerifyTrustHeadersResult } from './verifier';

export { TrustHeaderGuard } from './guard';
export type { RequestWithContext } from './guard';

export { TrustHeaderGuardModule } from './module/trust-header-guard.module';
export { TRUST_HEADER_OPTIONS_TOKEN } from './module/tokens';
export { TrustHeaderConfigError, validateTrustHeaderOptions } from './module/options';
export type { TrustHeaderModuleOptions, ValidatedTrustHeaderOptions } from './module/options';
