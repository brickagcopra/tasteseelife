/**
 * `@taste-and-see/nest-audit` — shared admin-mutation audit emission.
 *
 * See `audit-context.ts` for why the actor comes from the verified token, and
 * `audit-emitter.ts` for why emission happens inside the caller's transaction.
 */
export {
  SYSTEM_AUDIT_ACTOR,
  buildAuditActorContext,
  type AuditActor,
  type AuditActorContext,
  type AuditRequestLike,
  type AuditSystemActorContext,
} from './audit-context';
export { AuditEmitter, AuditEmitFailedError, type AuditMutationDescriptor } from './audit-emitter';
export { AuditModule, type AuditModuleOptions } from './module/audit.module';
export { AUDIT_PRODUCER_SERVICE } from './module/tokens';
