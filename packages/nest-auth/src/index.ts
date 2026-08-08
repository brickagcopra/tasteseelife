export { AccessTokenGuard } from './access-token-guard';
export type { RequestWithContext } from './access-token-guard';

export { PermissionGuard } from './permission-guard';

export {
  REQUIRE_PERMISSIONS_METADATA_KEY,
  RequirePermissions,
} from './require-permissions.decorator';

export { NestAuthModule } from './module/nest-auth.module';
export { JWT_VERIFIER_OPTIONS_TOKEN } from './module/tokens';
export { NestAuthConfigError, validateNestAuthOptions } from './module/options';
export type { NestAuthModuleOptions, ValidatedNestAuthOptions } from './module/options';
