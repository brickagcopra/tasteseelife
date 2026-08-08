export type { RequestContext } from './context';

export { GLOBAL_SCOPE, formatScope, scopeAllows } from './scope';
export type { TenantScope } from './scope';

export {
  ADMIN_ROLE_NAMES,
  SYSTEM_ROLE_NAMES,
  holdsAdminRole,
  isAdminRoleName,
  isAssignmentActive,
} from './roles';
export type { AdminRoleName, RoleAssignment, SystemRoleName } from './roles';

export { hasPermission, requirePermission, PermissionDeniedError } from './permissions';
export type {
  PermissionCheckOptions,
  PermissionDeniedDetails,
  PermissionString,
} from './permissions';

export { AccessTokenPayloadSchema, InvalidTokenError, verifyAccessToken } from './jwt';
export type { AccessTokenPayload, VerifyAccessTokenOptions } from './jwt';
