import type { MeResponse } from '@taste-and-see/contracts';
import { describe, expect, it } from 'vitest';

import {
  activeAdminRoleNames,
  hasAnyAdminRole,
  hasPermission,
  hasRoleName,
  hasSuperAdminRole,
} from './admin-gate';

/**
 * Unit tests for the admin permission gate (TS-303c2b-followup-1; the
 * helpers themselves are TS-123 / TS-290).
 *
 * Every `(protected)` route in web-admin decides whether an operator
 * sees a surface by calling one of these four functions. The one
 * property that matters most and is easiest to lose in a refactor:
 * **an EXPIRED assignment must not grant anything.** CLAUDE.md §3.2
 * makes role expiry a first-class feature, and a gate that reads
 * `role.permissions` without checking `expiresAt` would keep a
 * time-boxed reviewer inside the mandated-reporter console after their
 * window closed — with the server-side gates still holding, but the
 * console telling them otherwise.
 *
 * The clock is injected on every helper, so these assert against a
 * fixed `NOW` rather than wall time.
 */

const NOW = new Date('2026-07-26T12:00:00.000Z');
const YESTERDAY = '2026-07-25T12:00:00.000Z';
const TOMORROW = '2026-07-27T12:00:00.000Z';

function me(roles: MeResponse['roles']): MeResponse {
  return {
    userId: 'usr_1',
    mfaVerified: true,
    roles,
  } as unknown as MeResponse;
}

function role(
  name: string,
  permissions: readonly string[],
  expiresAt?: string,
): MeResponse['roles'][number] {
  return {
    name,
    permissions: [...permissions],
    scope: { type: 'global' },
    ...(expiresAt !== undefined && { expiresAt }),
  } as unknown as MeResponse['roles'][number];
}

describe('hasPermission', () => {
  it('grants a permission carried by an unexpiring role', () => {
    expect(
      hasPermission(me([role('trust_safety', ['trust_safety:read'])]), 'trust_safety:read', NOW),
    ).toBe(true);
  });

  it('grants a permission carried by a role that has not yet expired', () => {
    expect(
      hasPermission(
        me([role('trust_safety', ['trust_safety:read'], TOMORROW)]),
        'trust_safety:read',
        NOW,
      ),
    ).toBe(true);
  });

  it('REFUSES a permission carried only by an EXPIRED role', () => {
    // The whole point of §3.2 role expiry. A gate that skipped this
    // would show a time-boxed reviewer a console the server then 403s.
    expect(
      hasPermission(
        me([role('trust_safety', ['trust_safety:read'], YESTERDAY)]),
        'trust_safety:read',
        NOW,
      ),
    ).toBe(false);
  });

  it('refuses a permission nobody holds', () => {
    expect(
      hasPermission(me([role('trust_safety', ['trust_safety:read'])]), 'provider:read', NOW),
    ).toBe(false);
  });

  it('matches exactly — a read grant is not a write grant', () => {
    const actor = me([role('trust_safety', ['trust_safety:read'])]);

    expect(hasPermission(actor, 'trust_safety:write', NOW)).toBe(false);
  });

  it('finds a permission on the second of several roles', () => {
    const actor = me([
      role('provider_ops', ['provider:read']),
      role('trust_safety', ['trust_safety:read', 'trust_safety:write']),
    ]);

    expect(hasPermission(actor, 'trust_safety:write', NOW)).toBe(true);
  });

  it('grants when an expired role and a live role both name it', () => {
    const actor = me([
      role('trust_safety', ['trust_safety:read'], YESTERDAY),
      role('operations_manager', ['trust_safety:read']),
    ]);

    expect(hasPermission(actor, 'trust_safety:read', NOW)).toBe(true);
  });

  it('refuses everything for an actor with no roles', () => {
    expect(hasPermission(me([]), 'provider:read', NOW)).toBe(false);
  });
});

describe('hasSuperAdminRole', () => {
  it('is true for an active super_admin', () => {
    expect(hasSuperAdminRole(me([role('super_admin', [])]), NOW)).toBe(true);
  });

  it('is false for an EXPIRED super_admin', () => {
    expect(hasSuperAdminRole(me([role('super_admin', [], YESTERDAY)]), NOW)).toBe(false);
  });

  it('is false for another admin role', () => {
    expect(hasSuperAdminRole(me([role('operations_manager', [])]), NOW)).toBe(false);
  });
});

describe('hasAnyAdminRole', () => {
  it('is true for a recognised admin staff role', () => {
    expect(hasAnyAdminRole(me([role('operations_manager', [])]), NOW)).toBe(true);
  });

  it('is false for a customer role', () => {
    // The gate applies to the PDD §10.2 system-defined staff roles; a
    // family payer must never reach the console shell.
    expect(hasAnyAdminRole(me([role('family_payer', [])]), NOW)).toBe(false);
  });

  it('is false when the only admin role has expired', () => {
    expect(hasAnyAdminRole(me([role('operations_manager', [], YESTERDAY)]), NOW)).toBe(false);
  });

  it('is false for an actor with no roles at all', () => {
    expect(hasAnyAdminRole(me([]), NOW)).toBe(false);
  });
});

describe('hasRoleName', () => {
  it('matches an active role by exact name', () => {
    expect(hasRoleName(me([role('finance', [])]), 'finance', NOW)).toBe(true);
    expect(hasRoleName(me([role('finance', [])]), 'Finance', NOW)).toBe(false);
  });

  it('does not match an expired role', () => {
    expect(hasRoleName(me([role('finance', [], YESTERDAY)]), 'finance', NOW)).toBe(false);
  });
});

describe('activeAdminRoleNames', () => {
  it('lists only active, recognised admin roles', () => {
    const actor = me([
      role('super_admin', []),
      role('operations_manager', [], YESTERDAY),
      role('family_payer', []),
      role('trust_safety', []),
    ]);

    const names = activeAdminRoleNames(actor, NOW);

    expect(names).toContain('super_admin');
    expect(names).toContain('trust_safety');
    expect(names).not.toContain('operations_manager');
    expect(names).not.toContain('family_payer');
  });

  it('is empty for an actor with none', () => {
    expect(activeAdminRoleNames(me([]), NOW)).toEqual([]);
  });
});
