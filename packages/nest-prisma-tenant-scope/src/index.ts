// Public surface of @taste-and-see/nest-prisma-tenant-scope (TS-141).
//
// Three layers:
//
//   1. Module: `TenantContextModule.forRoot({...})` wires the store +
//      interceptor + validated options into a Nest application.
//
//   2. Context primitives: `TenantContextStore` (the AsyncLocalStorage
//      wrapper) + `runWithoutTenantContext` (the explicit-exempt escape
//      hatch for workers / boot-time seeds / migrations).
//
//   3. Prisma extension: `createTenantScopeExtension({...})` produces
//      the `$extends` payload services apply to their `PrismaClient`.
//      Consumers wire this in their own `PrismaModule` because the
//      extended-client type is service-local generic state.
//
// CLAUDE.md §3.2 + §17.10 — tenant scoping enforced at the Prisma
// extension layer; reject queries without `requestContext` (mode =
// `enforce`) or log a warning and proceed (mode = `audit`, the
// Phase-1 default).

// Config
export { DEFAULT_UNSCOPED_OPERATIONS, TenantContextConfigError, validateOptions } from './config';
export type {
  ActorRequest,
  ActorResolver,
  TenantContextEnforcement,
  TenantContextModuleOptions,
  ValidatedOptions,
} from './config';

// Context store + escape hatch
export { TenantContextStore } from './context/context-store';
export type { TenantContextFrame } from './context/context-store';
export {
  RUN_WITHOUT_TENANT_CONTEXT_MAX_REASON_LENGTH,
  runWithoutTenantContext,
} from './context/exempt';

// Prisma extension
export { createTenantScopeExtension } from './extension/tenant-scope.extension';
export type { CreateExtensionOptions, ExtensionLogger } from './extension/tenant-scope.extension';
export { MissingRequestContextError } from './extension/errors';
export { evaluateGate, toReadonlySet } from './extension/gate';
export type { GateDecision, GateInputs } from './extension/gate';

// Module
export { TenantContextModule } from './module/tenant-context.module';
export { TENANT_CONTEXT_OPTIONS_TOKEN, TENANT_CONTEXT_STORE_TOKEN } from './module/tokens';

// Interceptor (exported in case a consumer wants to compose its own
// module rather than using the canonical `TenantContextModule.forRoot`).
export { TenantContextInterceptor } from './interceptor/tenant-context.interceptor';
