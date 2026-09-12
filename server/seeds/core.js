/**
 * Core seed: roles, permissions, demo users, static catalogues, settings.
 * Idempotent - safe to run repeatedly (uses upsert-style inserts).
 */
import bcrypt from 'bcryptjs';
import db from '../db/index.js';
import logger from '../lib/logger.js';
import {
  APP_SETTINGS,
  BRANDS,
  DEMO_ROLES,
  DEMO_USERS,
  FILTER_TYPES,
  LABEL_TEMPLATES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  TOOLING_TYPES,
  XREF_BRANDS,
} from './catalog.js';

export async function insertRow(exec, table, data) {
  const keys = Object.keys(data);
  const sql = `INSERT INTO \`${table}\` (${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  const res = await exec.run(sql, keys.map((k) => data[k]));
  return res.insertId ?? null;
}

export async function upsertBy(exec, table, key, data) {
  const existing = await exec.one(`SELECT id FROM \`${table}\` WHERE \`${key}\` = ?`, [data[key]]);
  if (existing) {
    const keys = Object.keys(data).filter((k) => k !== key);
    if (keys.length) {
      await exec.run(
        `UPDATE \`${table}\` SET ${keys.map((k) => `\`${k}\`=?`).join(', ')} WHERE \`${key}\`=?`,
        [...keys.map((k) => data[k]), data[key]],
      );
    }
    return existing.id;
  }
  return insertRow(exec, table, data);
}

export async function seedCore({ passwordOverride = null } = {}) {
  const exec = await db.rawDriver.executor();
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  // --- roles -------------------------------------------------------------
  const roleIds = new Map();
  for (const role of DEMO_ROLES) {
    const id = await upsertBy(exec, 'roles', 'code', { ...role, created_at: now });
    roleIds.set(role.code, id);
  }

  // --- permissions -------------------------------------------------------
  const permIds = new Map();
  for (const perm of PERMISSIONS) {
    const row = await exec.one('SELECT id FROM permissions WHERE code = ?', [perm.code]);
    if (row) {
      permIds.set(perm.code, row.id);
      await exec.run('UPDATE permissions SET module=?, action=?, description=? WHERE id=?', [perm.module, perm.action, perm.description, row.id]);
      continue;
    }
    const id = await insertRow(exec, 'permissions', perm);
    permIds.set(perm.code, id);
  }

  // --- role -> permission grants ----------------------------------------
  await applyRolePermissions(exec, roleIds, permIds);

  // --- users -------------------------------------------------------------
  const userIds = new Map();
  for (const user of DEMO_USERS) {
    const plain = passwordOverride || user.password;
    const hash = await bcrypt.hash(plain, 10);
    const existing = await exec.one('SELECT id FROM users WHERE username = ?', [user.username]);
    if (existing) {
      await exec.run('UPDATE users SET password_hash=?, role_id=?, is_active=1, must_change_password=0 WHERE id=?', [
        hash,
        roleIds.get(user.role),
        existing.id,
      ]);
      userIds.set(user.username, existing.id);
      continue;
    }
    const id = await insertRow(exec, 'users', {
      username: user.username,
      password_hash: hash,
      full_name: user.full_name,
      email: user.email,
      role_id: roleIds.get(user.role),
      department: user.department,
      is_active: 1,
      must_change_password: user.username === 'admin' ? 1 : 0,
      created_at: now,
      updated_at: now,
    });
    userIds.set(user.username, id);
  }

  // --- catalogues --------------------------------------------------------
  const filterTypeIds = new Map();
  for (const t of FILTER_TYPES) {
    filterTypeIds.set(t.code, await upsertBy(exec, 'filter_types', 'code', { ...t, is_system: 1, is_active: 1 }));
  }

  const brandIds = new Map();
  for (const b of [...BRANDS, ...XREF_BRANDS]) {
    if (brandIds.has(b.code)) continue;
    brandIds.set(b.code, await upsertBy(exec, 'brands', 'code', { code: b.code, name: b.name, country: b.country ?? null, is_active: 1 }));
  }

  const toolingTypeIds = new Map();
  for (const t of TOOLING_TYPES) {
    toolingTypeIds.set(t.code, await upsertBy(exec, 'tooling_types', 'code', { ...t, is_system: 1, is_active: 1 }));
  }

  for (const s of APP_SETTINGS) {
    await exec.run(
      `INSERT INTO app_settings (setting_key, value, value_type, label, group_name, is_public)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE value_type=VALUES(value_type), label=VALUES(label), group_name=VALUES(group_name), is_public=VALUES(is_public)`,
      [s.key, s.value, s.type || 'string', s.label, s.group, s.is_public ?? 0],
    );
  }

  for (const t of LABEL_TEMPLATES) {
    await upsertBy(exec, 'label_templates', 'name', t);
  }

  return { roleIds, userIds, filterTypeIds, brandIds, toolingTypeIds, permIds };
}

/**
 * Re-apply the permission catalogue + the default role grants without touching users.
 * Used on boot and by "Settings -> Sync permissions" after a release adds new codes.
 * Grants that an administrator removed by hand are restored for the built-in roles only
 * when the code is brand new (never silently re-grant something that was revoked).
 */
export async function syncPermissions({ resetGrants = false } = {}) {
  const exec = await db.rawDriver.executor();
  const permIds = new Map();
  let created = 0;
  let updated = 0;
  for (const perm of PERMISSIONS) {
    const row = await exec.one('SELECT id FROM permissions WHERE code = ?', [perm.code]);
    if (row) {
      permIds.set(perm.code, row.id);
      if (row.id) {
        await exec.run('UPDATE permissions SET module=?, action=?, description=? WHERE id=?', [perm.module, perm.action, perm.description, row.id]);
        updated += 1;
      }
      continue;
    }
    permIds.set(perm.code, await insertRow(exec, 'permissions', perm));
    created += 1;
  }
  const roleRows = await exec.all('SELECT id, code FROM roles');
  const roleIds = new Map(roleRows.map((r) => [r.code, r.id]));
  for (const role of DEMO_ROLES) {
    if (!roleIds.has(role.code)) {
      const id = await insertRow(exec, 'roles', { ...role, created_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
      roleIds.set(role.code, id);
    }
  }
  const grants = resetGrants ? await applyRolePermissions(exec, roleIds, permIds, { wipe: true }) : await applyMissingGrants(roleIds, permIds);
  const orphans = await exec.all('SELECT id, code FROM permissions');
  let removed = 0;
  const catalogue = new Set(PERMISSIONS.map((p) => p.code));
  for (const p of orphans) {
    if (catalogue.has(p.code)) continue;
    await exec.run('DELETE FROM role_permissions WHERE permission_id = ?', [p.id]);
    await exec.run('DELETE FROM permissions WHERE id = ?', [p.id]);
    removed += 1;
  }
  return { permissions: PERMISSIONS.length, created, updated, removed, grants_added: grants.added, roles: roleIds.size };
}

async function applyRolePermissions(exec, roleIds, permIds, { wipe = false } = {}) {
  let added = 0;
  for (const [roleCode, list] of Object.entries(ROLE_PERMISSIONS)) {
    const roleId = roleIds.get(roleCode);
    if (!roleId) continue;
    if (wipe) await exec.run('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
    for (const code of list) {
      const permId = permIds.get(code);
      if (!permId) {
        logger.warn('seed: unknown permission code %s (role %s) skipped', code, roleCode);
        continue;
      }
      const before = await exec.value('SELECT COUNT(*) c FROM role_permissions WHERE role_id = ? AND permission_id = ?', [roleId, permId]);
      await exec.run('INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?,?)', [roleId, permId]);
      if (!Number(before)) added += 1;
    }
  }
  return { added };
}

async function applyMissingGrants(roleIds, permIds) {
  const exec = await db.rawDriver.executor();
  return applyRolePermissions(exec, roleIds, permIds);
}

export { DEMO_USERS };
