/** Audit log (spec §41). Records are append-only: there is no update/delete path. */
import db from '../db/index.js';
import logger from '../lib/logger.js';

const short = (v) => {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v).slice(0, 4000);
    } catch {
      return String(v).slice(0, 4000);
    }
  }
  return String(v).slice(0, 4000);
};

export async function audit(ctx, entry) {
  try {
    await db.run(
      `INSERT INTO audit_logs (user_id, username, action, entity_type, entity_id, entity_label, field_name, old_value, new_value, summary, reason, ip, route)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        ctx?.user?.id ?? null,
        ctx?.user?.username ?? entry.username ?? null,
        entry.action,
        entry.entityType,
        entry.entityId != null ? String(entry.entityId) : null,
        entry.entityLabel ? String(entry.entityLabel).slice(0, 160) : null,
        entry.field ?? null,
        short(entry.oldValue),
        short(entry.newValue),
        entry.summary ? String(entry.summary).slice(0, 400) : null,
        entry.reason ? String(entry.reason).slice(0, 400) : null,
        ctx?.ip ?? null,
        ctx?.route ? String(ctx.route).slice(0, 160) : null,
      ],
    );
  } catch (err) {
    logger.warn('audit write failed (%s %s): %s', entry.action, entry.entityType, err.message);
  }
}

/** Field-by-field diff of two records, ignoring bookkeeping columns. */
const IGNORED = new Set(['updated_at', 'created_at', 'search_blob', 'password_hash']);

export function diffFields(before, after, { labels = {} } = {}) {
  const changes = [];
  if (!before || !after) return changes;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (IGNORED.has(key)) continue;
    const a = before[key];
    const b = after[key];
    const na = a === undefined ? null : a;
    const nb = b === undefined ? null : b;
    if (na === null && nb === null) continue;
    if (String(na ?? '') === String(nb ?? '')) continue;
    if (typeof na === 'object' || typeof nb === 'object') {
      if (JSON.stringify(na) === JSON.stringify(nb)) continue;
    }
    changes.push({ field: key, label: labels[key] ?? key, oldValue: na, newValue: nb });
  }
  return changes;
}

export async function auditUpdate(ctx, entityType, entityId, entityLabel, before, after, options = {}) {
  const changes = diffFields(before, after, options);
  if (!changes.length) return { changes: [] };
  for (const change of changes) {
    await audit(ctx, {
      action: 'update',
      entityType,
      entityId,
      entityLabel,
      field: change.field,
      oldValue: change.oldValue,
      newValue: change.newValue,
      summary: `Changed ${change.label} of ${entityLabel ?? entityId}`,
      reason: options.reason,
    });
  }
  return { changes };
}

export async function listAudit({ entity_type, entity_id, user_id, action, from, to, q, page = 1, size = 25 } = {}) {
  const where = ['1=1'];
  const params = [];
  if (entity_type) {
    where.push('a.entity_type = ?');
    params.push(entity_type);
  }
  if (entity_id) {
    where.push('a.entity_id = ?');
    params.push(String(entity_id));
  }
  if (user_id) {
    where.push('a.user_id = ?');
    params.push(Number(user_id));
  }
  if (action) {
    where.push('a.action = ?');
    params.push(action);
  }
  if (from) {
    where.push('a.created_at >= ?');
    params.push(`${String(from).slice(0, 10)} 00:00:00`);
  }
  if (to) {
    where.push('a.created_at <= ?');
    params.push(`${String(to).slice(0, 10)} 23:59:59`);
  }
  if (q) {
    const like = `%${String(q).replace(/[\\%_]/g, '\\$&')}%`;
    where.push('(a.summary LIKE ? OR a.username LIKE ? OR a.entity_label LIKE ? OR a.reason LIKE ?)');
    params.push(like, like, like, like);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = Number(await db.value(`SELECT COUNT(*) c FROM audit_logs a ${whereSql}`, params));
  const items = await db.all(
    `SELECT a.*, u.full_name AS user_name, r.code AS role_code
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.user_id
     LEFT JOIN roles r ON r.id = u.role_id
     ${whereSql} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    [...params, size, (Math.max(1, page) - 1) * size],
  );
  return { items, total, page: Math.max(1, Number(page) || 1), size: Number(size) || 25 };
}
