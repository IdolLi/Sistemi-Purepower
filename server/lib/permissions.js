/** Permission helpers shared by the API middleware and services. */
import { forbidden, unauthorized } from './errors.js';

/**
 * Reads that the generic `*.read` wildcard must never unlock: the administration plane
 * (accounts, roles, settings, backups) and the audit trail. Only an explicit grant - or
 * the `*` super-permission - opens those. Mirrored by `can()` on the client.
 */
export const RESTRICTED_READS = new Set([
  'users.read',
  'roles.read',
  'permissions.read',
  'settings.read',
  'backups.read',
  'environment.read',
  'audit.read',
]);

/**
 * @param {Set<string>|string[]|undefined} granted permission codes held by the user
 * @param {string} needed e.g. "tooling.move"
 */
export function hasPermission(granted, needed) {
  const set = granted instanceof Set ? granted : new Set(granted || []);
  if (set.has('*') || set.has(needed)) return true;
  if (needed.endsWith('.read') && !RESTRICTED_READS.has(needed)) {
    const module = needed.split('.')[0];
    if (set.has(`${module}.read`) || set.has('*.read')) return true;
  }
  return false;
}

export function hasAny(granted, list) {
  return list.some((p) => hasPermission(granted, p));
}

/** Express middleware factory: user needs any one of the listed permissions. */
export function requirePermission(...needed) {
  return function permissionMiddleware(req, res, next) {
    if (!req.user) return next(unauthorized());
    if (!req.user.is_active) return next(forbidden('Account is disabled'));
    if (!needed.some((p) => hasPermission(req.user.permissions, p))) {
      return next(forbidden(`Missing permission: ${needed.join(' or ')}`));
    }
    return next();
  };
}

/** Permission codes a role would need to run a given write operation (UI hints). */
export const WRITE_PERMISSIONS = {
  filters: ['filters.create', 'filters.update', 'filters.delete'],
  tooling: ['tooling.create', 'tooling.update', 'tooling.manage'],
  maintenance: ['maintenance.manage'],
  damage: ['damage.create', 'damage.update'],
  locations: ['locations.manage', 'locations.map'],
  production: ['production.create', 'production.update', 'production.manage'],
};
