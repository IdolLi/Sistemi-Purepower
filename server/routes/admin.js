/** /api/admin — settings, users, roles/permissions, backups (spec §40, §55). */
import express from 'express';
import db from '../db/index.js';
import { requireId } from './_helpers.js';
import config from '../config.js';
import { asyncRoute, badRequest, notFound, conflict } from '../lib/errors.js';
import { validate, str, num, bool, oneOf, text, idRef, idList } from '../lib/validate.js';
import { requirePermission, requireAuth } from '../middleware/index.js';
import { syncPermissions } from '../seeds/core.js';
import { setPassword, invalidateUserSessions } from '../services/auth.js';
import { createBackup, listBackups, resolveBackupFile, deleteBackup, backupFiles } from '../services/backup.js';
import { addCustomField, deleteCustomField } from '../services/filters.js';
import { TOOLING_DIMENSION_FIELDS, FILTER_DIMENSION_FIELDS } from '../seeds/catalog.js';
import { audit } from '../services/audit.js';

const router = express.Router();

/* -------------------------------------------------------------- settings */
router.get('/settings', requirePermission('settings.read'), asyncRoute(async (req, res) => {
  const isPrivileged = !!req.user;
  const rows = await db.all('SELECT * FROM app_settings ORDER BY group_name, setting_key');
  res.json({
    items: rows.filter((r) => r.is_public || isPrivileged),
    groups: [...new Set(rows.map((r) => r.group_name).filter(Boolean))],
  });
}));

router.put('/settings', requirePermission('settings.manage'), asyncRoute(async (req, res) => {
  const entries = req.body?.settings ?? req.body;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw badRequest('Body must be { settings: { key: value, ... } }');
  const keys = Object.keys(entries);
  if (!keys.length) throw badRequest('No settings supplied');
  const known = await db.all('SELECT setting_key, value, value_type, label FROM app_settings');
  const byKey = new Map(known.map((k) => [k.setting_key, k]));
  const changed = [];
  const rejected = [];
  for (const key of keys) {
    const meta = byKey.get(key);
    if (!meta) {
      rejected.push({ key, error: 'unknown setting' });
      continue;
    }
    let value = entries[key];
    if (meta.value_type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        rejected.push({ key, error: 'must be a number' });
        continue;
      }
      value = String(n);
    } else if (meta.value_type === 'boolean') {
      value = value === true || value === 'true' || value === 1 || value === '1' ? '1' : '0';
    } else {
      value = value === null || value === undefined ? '' : String(value);
      if (value.length > 4000) {
        rejected.push({ key, error: 'too long (4000 characters max)' });
        continue;
      }
    }
    if (String(meta.value ?? '') === value) continue;
    await db.run('UPDATE app_settings SET value = ?, updated_at = NOW() WHERE setting_key = ?', [value, key]);
    changed.push({ key, label: meta.label ?? key, from: meta.value ?? '', to: value });
  }
  if (!changed.length && rejected.length) throw badRequest('No setting was changed', { rejected });
  await audit(req.ctx, { action: 'update', entityType: 'settings', summary: changed.length ? `${changed.length} setting(s) changed: ${changed.map((c) => c.key).join(', ')}` : 'No change' });
  res.json({ changed, rejected, items: await db.all('SELECT * FROM app_settings ORDER BY group_name, setting_key') });
}));

router.post('/settings', requirePermission('settings.manage'), asyncRoute(async (req, res) => {
  const data = validate({ setting_key: [str, { required: true, max: 80 }], value: [text, { max: 4000 }], value_type: oneOf(['string', 'number', 'boolean', 'select', 'json']), label: [str, { max: 160 }], group_name: [str, { max: 60 }], description: [str, { max: 400 }], is_public: [bool, { default: false }] }, req.body);
  const key = data.setting_key.toLowerCase();
  if (await db.one('SELECT setting_key FROM app_settings WHERE setting_key = ?', [key])) throw conflict(`Setting ${key} already exists`);
  await db.run('INSERT INTO app_settings (setting_key, value, value_type, label, group_name, description, is_public) VALUES (?,?,?,?,?,?,?)', [
    key,
    data.value ?? null,
    data.value_type ?? 'string',
    data.label ?? key,
    data.group_name ?? 'Custom',
    data.description ?? null,
    data.is_public ? 1 : 0,
  ]);
  await audit(req.ctx, { action: 'create', entityType: 'settings', entityId: null, entityLabel: key, summary: `Custom setting ${key} created` });
  res.status(201).json(await db.one('SELECT * FROM app_settings WHERE setting_key = ?', [key]));
}));

router.delete('/settings/:key', requirePermission('settings.manage'), asyncRoute(async (req, res) => {
  const key = String(req.params.key).toLowerCase();
  if ((await db.value('SELECT COUNT(*) c FROM app_settings WHERE setting_key = ? AND is_public = 1', [key])) > 0) {
    throw badRequest('Built-in public settings cannot be deleted - set them back to their default instead');
  }
  const r = await db.run('DELETE FROM app_settings WHERE setting_key = ?', [key]);
  if (!r.affectedRows) throw notFound('Setting not found');
  await audit(req.ctx, { action: 'delete', entityType: 'settings', entityLabel: key, summary: `Custom setting ${key} removed` });
  res.json({ ok: true });
}));

/* ------------------------------------------------- dimension field catalogue */
router.get('/fields', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const entity = String(req.query.entity || 'TOOLING').toUpperCase();
  res.json({
    builtin: entity === 'FILTER' ? FILTER_DIMENSION_FIELDS : TOOLING_DIMENSION_FIELDS,
    custom: await db.all(
      `SELECT c.*, tt.code AS applies_to_code, tt.name AS applies_to_name,
              (SELECT COUNT(*) FROM tooling_dimensions d WHERE JSON_EXTRACT(COALESCE(d.custom_values, '{}'), CONCAT('$.', c.field_key)) IS NOT NULL) AS used_by
       FROM custom_dimension_fields c LEFT JOIN tooling_types tt ON tt.id = c.applies_to_type_id
       WHERE c.entity = ? ORDER BY c.is_active DESC, c.sort_order, c.label`,
      [entity],
    ),
  });
}));

router.post('/fields', requirePermission('dimensions.manage'), asyncRoute(async (req, res) => {
  const data = validate(
    {
      entity: oneOf(['TOOLING', 'FILTER']),
      label: [str, { required: true, max: 120 }],
      field_key: [str, { max: 60, lower: true }],
      unit: oneOf(['mm', 'cm', 'inch', 'g', 'kg', 'shore_a', 'text', '']),
      data_type: oneOf(['decimal', 'int', 'text', 'bool']),
      applies_to_type: [str, { max: 30, upper: true }],
      applies_to_type_id: [idRef, {}],
      sort_order: [num, { int: true, min: 0, max: 9999 }],
    },
    req.body,
  );
  const typeId = data.applies_to_type_id ?? (data.applies_to_type ? await db.value('SELECT id FROM tooling_types WHERE code = ?', [data.applies_to_type]) : null);
  if (data.applies_to_type && !typeId) throw badRequest(`Unknown tooling category "${data.applies_to_type}"`);
  const out = await addCustomField({
    entity: data.entity ?? 'TOOLING',
    label: data.label,
    field_key: data.field_key,
    unit: data.unit || null,
    data_type: data.data_type ?? 'decimal',
    applies_to_type_id: typeId ?? null,
  });
  await audit(req.ctx, { action: 'create', entityType: 'dimension_field', entityId: out.id, entityLabel: out.field_key, summary: `Custom field "${data.label}" added` });
  res.status(201).json(out);
}));

router.put('/fields/:id', requirePermission('dimensions.manage'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'field id');
  const data = validate({ label: [str, { max: 120 }], unit: [str, { max: 20 }], data_type: oneOf(['decimal', 'int', 'text', 'bool']), sort_order: [num, { int: true, min: 0 }], is_active: [bool] }, req.body, { partial: true });
  const keys = Object.keys(data);
  if (!keys.length) throw badRequest('Nothing to update');
  const r = await db.run(`UPDATE custom_dimension_fields SET ${keys.map((k) => `\`${k}\`=?`).join(',')} WHERE id = ?`, [...keys.map((k) => (typeof data[k] === 'boolean' ? Number(data[k]) : data[k])), id]);
  if (!r.affectedRows) throw notFound('Field not found');
  await audit(req.ctx, { action: 'update', entityType: 'dimension_field', entityId: id, summary: `Custom field updated: ${keys.join(', ')}` });
  res.json(await db.one('SELECT * FROM custom_dimension_fields WHERE id = ?', [id]));
}));

router.delete('/fields/:id', requirePermission('dimensions.manage'), asyncRoute(async (req, res) => {
  await deleteCustomField(req.params.id);
  await audit(req.ctx, { action: 'delete', entityType: 'dimension_field', entityId: req.params.id, summary: 'Custom field removed' });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ users */
router.get('/users', requirePermission('users.read'), asyncRoute(async (req, res) => {
  const items = await db.all(
    `SELECT u.id, u.username, u.full_name, u.email, u.phone, u.department, u.language, u.is_active, u.must_change_password,
            u.last_login_at, u.created_at, r.code AS role_code, r.name AS role_name,
            (SELECT COUNT(*) FROM audit_logs a WHERE a.user_id = u.id AND a.created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)) AS actions_30d,
            (SELECT COUNT(*) FROM app_sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > NOW()) AS live_sessions
     FROM users u JOIN roles r ON r.id = u.role_id ORDER BY r.code, u.username`,
  );
  res.json({ items });
}));

const USER_SCHEMA = {
  username: [str, { required: true, max: 60, lower: true, pattern: /^[a-z0-9._-]{2,60}$/ }],
  full_name: [str, { required: true, max: 120 }],
  email: [str, { max: 160 }],
  phone: [str, { max: 40 }],
  role: [str, { required: true, max: 40, lower: true }],
  department: [str, { max: 80 }],
  language: [str, { max: 8 }],
  password: [str, { max: 200 }],
  is_active: [bool, { default: true }],
  must_change_password: [bool, { default: true }],
};

router.post('/users', requirePermission('users.manage'), asyncRoute(async (req, res) => {
  const data = validate(USER_SCHEMA, req.body);
  const role = await db.one('SELECT id, code FROM roles WHERE code = ?', [data.role]);
  if (!role) throw badRequest(`Unknown role "${data.role}". Existing roles: ${(await db.all('SELECT code FROM roles')).map((r) => r.code).join(', ')}`);
  if (await db.one('SELECT id FROM users WHERE username = ?', [data.username])) throw conflict(`Username ${data.username} is taken`);
  const password = data.password && data.password.length >= 8 ? data.password : null;
  if (!password) throw badRequest('password is required and must be at least 8 characters');
  const { hash } = await import('bcryptjs').then(async (bcrypt) => ({ hash: await bcrypt.default.hash(password, 10) }));
  const r = await db.run(
    `INSERT INTO users (username, password_hash, full_name, email, phone, role_id, department, language, is_active, must_change_password)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [data.username, hash, data.full_name, data.email ?? null, data.phone ?? null, role.id, data.department ?? null, data.language ?? 'en', data.is_active ? 1 : 0, data.must_change_password === false ? 0 : 1],
  );
  const id = r.insertId ?? (await db.value('SELECT id FROM users WHERE username = ?', [data.username]));
  await audit(req.ctx, { action: 'create', entityType: 'user', entityId: id, entityLabel: data.username, summary: `User ${data.full_name} created with role ${role.code}` });
  res.status(201).json({ id, username: data.username, role: role.code, must_change_password: data.must_change_password !== false });
}));

router.put('/users/:id', requirePermission('users.manage'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'user id');
  const before = await db.one('SELECT * FROM users WHERE id = ?', [id]);
  if (!before) throw notFound('User not found');
  const data = validate({ ...USER_SCHEMA, username: [str, { max: 60, lower: true }], role: [str, { max: 40, lower: true }] }, req.body, { partial: true });
  const updates = {};
  for (const k of ['username', 'full_name', 'email', 'phone', 'department', 'language']) if (data[k] !== undefined && data[k] !== null) updates[k] = data[k];
  if (data.is_active !== undefined) updates.is_active = data.is_active ? 1 : 0;
  if (data.must_change_password !== undefined) updates.must_change_password = data.must_change_password ? 1 : 0;
  if (data.role) {
    const role = await db.one('SELECT id, code FROM roles WHERE code = ?', [data.role]);
    if (!role) throw badRequest(`Unknown role "${data.role}"`);
    updates.role_id = role.id;
  }
  if (data.password) {
    if (String(data.password).length < 8) throw badRequest('password must be at least 8 characters');
    await setPassword(id, data.password);
    delete updates.must_change_password;
  }
  if (!Object.keys(updates).length && !data.password) throw badRequest('Nothing to update');
  await db.run(`UPDATE users SET ${Object.keys(updates).map((k) => `\`${k}\`=?`).join(',')}, updated_at = NOW() WHERE id = ?`, [...Object.values(updates), id]);
  if (updates.is_active === 0 || updates.role_id) await invalidateUserSessions(id);
  await audit(req.ctx, {
    action: 'update',
    entityType: 'user',
    entityId: id,
    entityLabel: data.username ?? before.username,
    summary: `User updated: ${Object.keys(updates).join(', ')}${data.password ? ', password' : ''}`,
  });
  res.json(await db.one('SELECT id, username, full_name, email, phone, department, language, is_active, must_change_password, last_login_at, role_id FROM users WHERE id = ?', [id]));
}));

router.post('/users/:id/password', requirePermission('users.manage'), asyncRoute(async (req, res) => {
  const data = validate({ password: [str, { required: true, max: 200 }], must_change: [bool, { default: true }] }, req.body);
  const id = requireId(req.params.id, 'user id');
  if (!await db.one('SELECT id FROM users WHERE id = ?', [id])) throw notFound('User not found');
  await setPassword(id, data.password);
  if (data.must_change) await db.run('UPDATE users SET must_change_password = 1 WHERE id = ?', [id]);
  await audit(req.ctx, { action: 'password_reset', entityType: 'user', entityId: id, summary: 'Password reset by an administrator' });
  res.json({ ok: true, sessions_revoked: true });
}));

router.post('/users/:id/unlock', requirePermission('users.manage'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'user id');
  const r = await db.run('UPDATE users SET locked_until = NULL, failed_attempts = 0, updated_at = NOW() WHERE id = ?', [id]);
  if (!r.affectedRows) throw notFound('User not found');
  await audit(req.ctx, { action: 'unlock', entityType: 'user', entityId: id, summary: 'Login lock cleared' });
  res.json({ ok: true });
}));

router.delete('/users/:id', requirePermission('users.manage'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'user id');
  if (Number(id) === Number(req.user.id)) throw badRequest('You cannot delete your own account');
  const owned = await db.value(
    `SELECT (SELECT COUNT(*) FROM tooling_items WHERE created_by = ?) + (SELECT COUNT(*) FROM production_orders WHERE created_by = ?) AS c`,
    [id, id],
  );
  const r = await db.run('DELETE FROM users WHERE id = ?', [id]).catch(() => null);
  if (!r || !r.affectedRows) {
    await db.run('UPDATE users SET is_active = 0, updated_at = NOW() WHERE id = ?', [id]);
    await invalidateUserSessions(id);
    await audit(req.ctx, { action: 'deactivate', entityType: 'user', entityId: id, summary: `User deactivated (they own ${owned} record(s) - history kept)` });
    return res.json({ ok: true, deactivated: true, note: `This user has ${owned} record(s), so they were deactivated instead of deleted.` });
  }
  await audit(req.ctx, { action: 'delete', entityType: 'user', entityId: id, summary: 'User deleted' });
  res.json({ ok: true, deleted: true });
}));

router.get('/users/:id/sessions', requirePermission('users.manage'), asyncRoute(async (req, res) => {
  res.json({
    items: await db.all(
      `SELECT id, ip, user_agent, created_at, last_seen_at, expires_at, revoked_at FROM app_sessions
       WHERE user_id = ? ORDER BY id DESC LIMIT 30`,
      [requireId(req.params.id, 'user id')],
    ),
  });
}));

router.post('/users/:id/revoke-sessions', requirePermission('users.manage'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'user id');
  await invalidateUserSessions(id);
  await audit(req.ctx, { action: 'revoke', entityType: 'user', entityId: id, summary: 'All sessions revoked' });
  res.json({ ok: true });
}));

/* ----------------------------------------------------------- roles */
router.get('/roles', requirePermission('users.read'), asyncRoute(async (req, res) => {
  const roles = await db.all(
    `SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS user_count,
            (SELECT COUNT(*) FROM role_permissions rp WHERE rp.role_id = r.id) AS permission_count
     FROM roles r ORDER BY r.code`,
  );
  const perms = await db.all('SELECT * FROM permissions ORDER BY module, action');
  const grants = await db.all('SELECT role_id, permission_id FROM role_permissions');
  const byRole = new Map();
  for (const g of grants) {
    const list = byRole.get(g.role_id) ?? [];
    list.push(g.permission_id);
    byRole.set(g.role_id, list);
  }
  res.json({
    roles: roles.map((r) => ({ ...r, permissions: (byRole.get(r.id) ?? []).map((id) => perms.find((p) => p.id === id)?.code).filter(Boolean) })),
    permissions: perms,
    modules: [...new Set(perms.map((p) => p.module))],
  });
}));

router.put('/roles/:code/permissions', requirePermission('users.manage'), asyncRoute(async (req, res) => {
  const role = await db.one('SELECT * FROM roles WHERE code = ?', [req.params.code]);
  if (!role) throw notFound(`Role ${req.params.code} not found`);
  const data = validate({ permissions: [idList, { required: true }], codes: [str, { max: 4000 }] }, req.body);
  let ids = data.permissions;
  if (data.codes) {
    const codes = String(data.codes)
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    const rows = await db.all(`SELECT id FROM permissions WHERE code IN (${codes.map(() => '?').join(',')})`, codes);
    ids = [...new Set([...ids, ...rows.map((r) => r.id)])];
  }
  if (req.body?.codes && !ids.length) throw badRequest('None of the permission codes supplied exist');
  const before = await db.all('SELECT permission_id FROM role_permissions WHERE role_id = ?', [role.id]);
  if (role.code === 'admin' && !ids.length) throw badRequest('The admin role must keep at least one permission');
  await db.tx(async (exec) => {
    await exec.run('DELETE FROM role_permissions WHERE role_id = ?', [role.id]);
    for (const pid of ids) await exec.run('INSERT INTO role_permissions (role_id, permission_id) VALUES (?,?)', [role.id, pid]).catch(() => null);
  });
  for (const user of await db.all('SELECT id FROM users WHERE role_id = ?', [role.id])) invalidateUserSessions(user.id);
  await audit(req.ctx, {
    action: 'permissions',
    entityType: 'role',
    entityId: role.id,
    entityLabel: role.code,
    summary: `Permissions changed for ${role.name}: ${ids.length} granted (was ${before.length})`,
  });
  res.json({ ok: true, role: role.code, granted: ids.length });
}));

router.post('/roles', requirePermission('users.manage'), asyncRoute(async (req, res) => {
  const data = validate({ code: [str, { required: true, max: 40, lower: true, pattern: /^[a-z0-9_]+$/ }], name: [str, { required: true, max: 120 }], description: [str, { max: 400 }], permissions: [str, { max: 4000 }] }, req.body);
  if (await db.one('SELECT id FROM roles WHERE code = ?', [data.code])) throw conflict(`Role ${data.code} already exists`);
  const r = await db.run('INSERT INTO roles (code, name, description) VALUES (?,?,?)', [data.code, data.name, data.description ?? null]);
  const id = r.insertId ?? (await db.value('SELECT id FROM roles WHERE code = ?', [data.code]));
  if (data.permissions) {
    const codes = data.permissions.split(',').map((c) => c.trim()).filter(Boolean);
    for (const code of codes) {
      const pid = await db.value('SELECT id FROM permissions WHERE code = ?', [code]);
      if (pid) await db.run('INSERT INTO role_permissions (role_id, permission_id) VALUES (?,?)', [id, pid]).catch(() => null);
    }
  }
  await audit(req.ctx, { action: 'create', entityType: 'role', entityId: id, entityLabel: data.code, summary: `Role ${data.name} created` });
  res.status(201).json(await db.one('SELECT * FROM roles WHERE id = ?', [id]));
}));

router.delete('/roles/:code', requirePermission('users.manage'), asyncRoute(async (req, res) => {
  const role = await db.one('SELECT * FROM roles WHERE code = ?', [req.params.code]);
  if (!role) throw notFound('Role not found');
  if (role.is_system) throw conflict('Built-in roles cannot be deleted');
  const users = await db.value('SELECT COUNT(*) c FROM users WHERE role_id = ?', [role.id]);
  if (Number(users) > 0) throw conflict(`${users} user(s) still use this role`);
  await db.run('DELETE FROM roles WHERE id = ?', [role.id]);
  await audit(req.ctx, { action: 'delete', entityType: 'role', entityId: role.id, entityLabel: role.code, summary: 'Role deleted' });
  res.json({ ok: true });
}));

router.post('/permissions/sync', requirePermission('settings.manage'), asyncRoute(async (req, res) => {
  const out = await syncPermissions();
  await audit(req.ctx, { action: 'sync', entityType: 'permissions', summary: `Permissions synced from the catalogue (${out.permissions} codes)` });
  res.json(out);
}));

/* ---------------------------------------------------------- backups */
router.get('/backups', requirePermission('backups.read'), asyncRoute(async (req, res) => {
  res.json(await listBackups());
}));

router.post('/backups', requirePermission('backups.manage'), asyncRoute(async (req, res) => {
  const out = await createBackup({ ctx: req.ctx, kind: req.body?.kind ?? 'manual' });
  res.status(201).json(out);
}));

router.get('/backups/files', requirePermission('backups.read'), asyncRoute(async (req, res) => {
  res.json({ dir: BACKUP_DIR_LABEL, files: backupFiles() });
}));
const BACKUP_DIR_LABEL = config.backupDir;

router.get('/backups/:id/download', requirePermission('backups.manage'), asyncRoute(async (req, res) => {
  const { filename, filePath, size } = await resolveBackupFile(req.params.id);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Length', String(size));
  const stream = (await import('node:fs')).createReadStream(filePath);
  stream.on('error', () => res.status(500).end());
  await audit(req.ctx, { action: 'download', entityType: 'backup', entityLabel: filename, summary: 'Backup downloaded' });
  stream.pipe(res);
}));

router.delete('/backups/:id', requirePermission('backups.manage'), asyncRoute(async (req, res) => {
  res.json(await deleteBackup(req.params.id, req.ctx));
}));

/* -------------------------------------------------------------- misc */
router.get('/environment', requirePermission('settings.manage'), asyncRoute(async (req, res) => {
  const counts = await db.one(
    `SELECT (SELECT COUNT(*) FROM filters) AS filters, (SELECT COUNT(*) FROM tooling_items) AS tooling,
            (SELECT COUNT(*) FROM tooling_movements) AS movements, (SELECT COUNT(*) FROM audit_logs) AS audit_rows,
            (SELECT COUNT(*) FROM vehicles) AS vehicles, (SELECT COUNT(*) FROM tooling_locations) AS locations`,
  );
  res.json({
    app: { name: config.app.name, module: config.app.module, env: config.env, version: process.env.npm_package_version ?? '1.0.0' },
    server: { node: process.version, pid: process.pid, uptime_seconds: Math.round(process.uptime()), memory_mb: Math.round(process.memoryUsage().rss / 1048576) },
    database: { mode: config.db.mode, host: db.embedded ? 'embedded' : config.db.host, port: db.embedded ? 0 : config.db.port, name: db.embedded ? config.db.embeddedDir : config.db.database, version: await db.value('SELECT VERSION() v').catch(() => null) },
    counts,
    limits: { upload_image_mb: Math.round(config.uploads.maxImageBytes / 1048576), upload_doc_mb: Math.round(config.uploads.maxDocBytes / 1048576), page_size: config.pagination.max, rate_limit_api: config.rateLimit.apiMax },
    flags: { sql_debug: !!process.env.SQL_DEBUG, demo_password: !!process.env.DEMO_PASSWORD },
  });
}));

router.post('/cache/clear', requirePermission('settings.manage'), asyncRoute(async (req, res) => {
  const { clearCache } = await import('../services/auth.js');
  clearCache();
  await audit(req.ctx, { action: 'cache_clear', entityType: 'settings', summary: 'Session + permission cache cleared' });
  res.json({ ok: true });
}));

export default router;
