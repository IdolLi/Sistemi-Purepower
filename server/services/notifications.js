/**
 * Alerts + notifications (spec §35). Nine alert kinds are derived from live data; each
 * carries a dedup_key so re-running the sweep does not spam the list.
 */
import db from '../db/index.js';
import { notFound } from '../lib/errors.js';
import { escapeLike } from '../lib/validate.js';
import { audit } from './audit.js';

export const ALERT_KINDS = [
  'maintenance_overdue',
  'maintenance_due',
  'cycle_limit',
  'damage_report',
  'missing_tool',
  'tool_not_returned',
  'production_blocked',
  'low_stock',
  'location_unassigned',
  'duplicate_tool',
  'incomplete_set',
  'tooling_request',
];

/**
 * (Re)compute derived alerts. Returns { created, resolved, total }.
 * Fired alerts are stored in `notifications`; conditions that no longer hold are auto-resolved.
 */
export async function computeAlerts({ maxAgeHours = 48 } = {}) {
  const found = [];
  const push = (kind, severity, title, message, entityType, entityId, entityCode, link, dedup) =>
    found.push({ kind, severity, title, message, entity_type: entityType, entity_id: String(entityId ?? ''), entity_code: entityCode ?? null, link, dedup_key: dedup });

  const overdue = await db.all(
    `SELECT t.id, t.tooling_id, t.name, t.next_maintenance_date, l.full_code
     FROM tooling_items t LEFT JOIN tooling_locations l ON l.id = t.location_id
     WHERE t.deleted_at IS NULL AND t.next_maintenance_date IS NOT NULL AND t.next_maintenance_date < CURDATE()
       AND NOT EXISTS (SELECT 1 FROM tooling_maintenance m WHERE m.tooling_item_id = t.id AND m.status IN ('SCHEDULED','IN_PROGRESS'))
     LIMIT 200`,
  );
  for (const r of overdue) {
    push(
      'maintenance_overdue',
      'critical',
      `Maintenance overdue: ${r.tooling_id}`,
      `${r.name} was due ${r.next_maintenance_date}${r.full_code ? ` and sits in ${r.full_code}` : ''}`,
      'tooling_item',
      r.id,
      r.tooling_id,
      `#/tooling/${r.id}`,
      `maint-overdue:${r.id}:${r.next_maintenance_date}`,
    );
  }

  const due = await db.all(
    `SELECT t.id, t.tooling_id, t.name, t.next_maintenance_date
     FROM tooling_items t
     WHERE t.deleted_at IS NULL AND t.next_maintenance_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 14 DAY)
     LIMIT 200`,
  );
  for (const r of due) {
    push('maintenance_due', 'info', `Maintenance due: ${r.tooling_id}`, `${r.name} is due on ${r.next_maintenance_date}`, 'tooling_item', r.id, r.tooling_id, `#/tooling/${r.id}`, `maint-due:${r.id}:${r.next_maintenance_date}`);
  }

  const cycles = await db.all(
    `SELECT t.id, t.tooling_id, t.name, t.total_cycles, t.max_cycles,
            ROUND(t.total_cycles * 100.0 / t.max_cycles) AS used_pct
     FROM tooling_items t
     WHERE t.deleted_at IS NULL AND t.max_cycles IS NOT NULL AND t.total_cycles * 100 >= t.max_cycles * t.cycle_warning_pct
     ORDER BY used_pct DESC LIMIT 200`,
  );
  for (const r of cycles) {
    const over = Number(r.used_pct) >= 100;
    push(
      'cycle_limit',
      over ? 'critical' : 'warning',
      `${over ? 'Cycle limit exceeded' : 'Cycle limit near'}: ${r.tooling_id}`,
      `${r.total_cycles}/${r.max_cycles} cycles (${r.used_pct}%) - ${over ? 'inspect before the next run' : 'plan an inspection'}`,
      'tooling_item',
      r.id,
      r.tooling_id,
      `#/tooling/${r.id}`,
      `cycles:${r.id}:${Math.floor(Number(r.total_cycles) / 100)}`,
    );
  }

  const openDamage = await db.all(
    `SELECT d.id, d.report_no, d.severity, t.tooling_id FROM tooling_damage_reports d JOIN tooling_items t ON t.id = d.tooling_item_id WHERE d.status = 'OPEN' LIMIT 200`,
  );
  for (const r of openDamage) {
    push('damage_report', r.severity === 'CRITICAL' || r.severity === 'HIGH' ? 'critical' : 'warning', `Open damage report ${r.report_no}`, `${r.severity} damage on ${r.tooling_id} is still unresolved`, 'damage_report', r.id, r.report_no, `#/maintenance/damage`, `damage:${r.id}`);
  }

  const missing = await db.all(
    `SELECT t.id, t.tooling_id, t.name, t.external_location, l.full_code FROM tooling_items t LEFT JOIN tooling_locations l ON l.id = t.location_id WHERE t.deleted_at IS NULL AND t.status = 'MISSING' LIMIT 200`,
  );
  for (const r of missing) {
    push('missing_tool', 'critical', `Missing tool: ${r.tooling_id}`, `${r.name}${r.external_location ? ` last seen at ${r.external_location}` : r.full_code ? ` should be in ${r.full_code}` : ' has no location'}`, 'tooling_item', r.id, r.tooling_id, `#/tooling/${r.id}`, `missing:${r.id}`);
  }

  const stillOut = await db.all(
    `SELECT DISTINCT t.id, t.tooling_id, t.name, o.po_number, o.id AS order_id, pot.taken_at
     FROM production_order_tools pot
     JOIN production_orders o ON o.id = pot.production_order_id
     JOIN tooling_items t ON t.id = pot.tooling_item_id
     WHERE pot.status = 'TAKEN' AND o.status IN ('IN_PROGRESS','COMPLETED')
     ORDER BY pot.taken_at LIMIT 200`,
  );
  for (const r of stillOut) {
    push('tool_not_returned', 'warning', `Tool still out: ${r.tooling_id}`, `Taken for ${r.po_number}${r.taken_at ? ` on ${String(r.taken_at).slice(0, 10)}` : ''} and not returned`, 'production_order', r.order_id, r.po_number, `#/production/${r.order_id}`, `out:${r.id}:${r.order_id}`);
  }

  const blocked = await db.all(
    `SELECT o.id, o.po_number, o.blocking_reason, f.internal_number
     FROM production_orders o JOIN filters f ON f.id = o.filter_id
     WHERE o.availability_status = 'NOT_READY' AND o.status IN ('PLANNED','READY','IN_PROGRESS') LIMIT 200`,
  );
  for (const r of blocked) {
    push('production_blocked', 'critical', `Production blocked: ${r.po_number}`, r.blocking_reason ?? `Tooling for ${r.internal_number} is not available`, 'production_order', r.id, r.po_number, `#/production/${r.id}`, `blocked:${r.id}:${(r.blocking_reason ?? '').slice(0, 40)}`);
  }

  const lowStock = await db.all(
    `SELECT * FROM (
       SELECT ii.id, ii.sku, ii.name, ii.reorder_level, COALESCE(SUM(i.quantity),0) AS on_hand
       FROM inventory_items ii LEFT JOIN inventory i ON i.inventory_item_id = ii.id
       WHERE ii.is_active = 1 AND ii.reorder_level > 0
       GROUP BY ii.id, ii.sku, ii.name, ii.reorder_level
     ) t WHERE t.on_hand <= t.reorder_level ORDER BY (t.on_hand - t.reorder_level) LIMIT 100`,
  );
  for (const r of lowStock) {
    push('low_stock', Number(r.on_hand) <= 0 ? 'critical' : 'warning', `Low stock: ${r.sku}`, `${r.on_hand} pcs on hand, reorder level ${r.reorder_level}`, 'filter', r.id, r.sku, `#/filters`, `stock:${r.id}:${r.on_hand}`);
  }

  const homeless = await db.all(
    `SELECT t.id, t.tooling_id, t.name FROM tooling_items t
     WHERE t.deleted_at IS NULL AND t.status IN ('AVAILABLE','RESERVED') AND t.location_id IS NULL AND (t.external_location IS NULL OR t.external_location = '')
     LIMIT 200`,
  );
  for (const r of homeless) {
    push('location_unassigned', 'warning', `No location: ${r.tooling_id}`, `${r.name} is available in the system but has no shelf - scan it into a location`, 'tooling_item', r.id, r.tooling_id, `#/tooling/${r.id}`, `noloc:${r.id}`);
  }

  const incompleteSets = await db.all(
    `SELECT s.id, s.code, s.name, s.required_count, s.linked_count, s.available_count FROM tooling_sets s WHERE s.status <> 'COMPLETE' AND s.required_count > 0 LIMIT 100`,
  );
  for (const r of incompleteSets) {
    push('incomplete_set', 'warning', `Set incomplete: ${r.code}`, `${r.linked_count}/${r.required_count} required items present (${r.available_count} available now)`, 'tooling_set', r.id, r.code, `#/sets/${r.id}`, `set:${r.id}:${r.linked_count}`);
  }

  const dupes = await db.all(
    `SELECT dc.id, dc.similarity_pct, a.tooling_id AS ca, b.tooling_id AS cb FROM duplicate_checks dc
     JOIN tooling_items a ON a.id = dc.tooling_a_id JOIN tooling_items b ON b.id = dc.tooling_b_id
     WHERE dc.status = 'OPEN' LIMIT 100`,
  );
  for (const r of dupes) {
    push('duplicate_tool', 'info', `Possible duplicate: ${r.ca} / ${r.cb}`, `${r.similarity_pct}% similar geometry - check before manufacturing new tooling`, 'duplicate_check', r.id, `${r.ca}/${r.cb}`, '#/duplicates', `dup:${r.id}`);
  }

  const pendingRequests = await db.all(
    `SELECT r.id, r.request_no, r.title FROM tooling_requests r WHERE r.status = 'PENDING' LIMIT 100`,
  );
  for (const r of pendingRequests) {
    push('tooling_request', 'info', `Tooling request ${r.request_no}`, r.title, 'tooling_request', r.id, r.request_no, '#/requests', `req:${r.id}`);
  }

  let created = 0;
  let updated = 0;
  for (const a of found) {
    const existing = await db.one('SELECT id, is_read, resolved_at FROM notifications WHERE dedup_key = ?', [a.dedup_key]);
    if (existing) {
      if (existing.resolved_at) {
        await db.run('UPDATE notifications SET resolved_at = NULL, is_read = 0, read_at = NULL, message = ?, severity = ?, created_at = NOW() WHERE id = ?', [a.message, a.severity, existing.id]);
        created += 1;
      } else if (existing.message !== a.message) {
        await db.run('UPDATE notifications SET message = ?, severity = ? WHERE id = ?', [a.message, a.severity, existing.id]);
        updated += 1;
      }
      continue;
    }
    await db.run(
      `INSERT INTO notifications (role_code, kind, severity, title, message, entity_type, entity_id, link, dedup_key)
       VALUES (NULL, ?,?,?,?,?,?,?,?)`,
      [a.kind, a.severity, a.title, a.message, a.entity_type, a.entity_id, a.link, a.dedup_key],
    );
    created += 1;
  }
  const keys = found.map((f) => f.dedup_key);
  let resolved = 0;
  if (keys.length) {
    const placeholders = keys.map(() => '?').join(',');
    const kindList = [...new Set(found.map((f) => `'${f.kind}'`))].join(',');
    const stale = await db.all(
      `SELECT id, kind FROM notifications WHERE resolved_at IS NULL AND dedup_key IS NOT NULL AND kind IN (${kindList}) AND dedup_key NOT IN (${placeholders})`,
      keys,
    );
    for (const s of stale) {
      await db.run('UPDATE notifications SET resolved_at = NOW() WHERE id = ?', [s.id]);
      resolved += 1;
    }
  }
  return { created, updated, resolved, total: found.length, kinds: ALERT_KINDS.length, max_age_hours: maxAgeHours };
}

/** Stored + derived list for the UI. */
export async function listNotifications({ user_id = null, role_code = null, kind = null, unread_only = false, limit = 50, q = null } = {}) {
  const where = ['(n.resolved_at IS NULL OR n.created_at > DATE_SUB(NOW(), INTERVAL 7 DAY))'];
  const params = [];
  if (kind) {
    where.push('n.kind = ?');
    params.push(String(kind));
  }
  if (unread_only) where.push('n.is_read = 0');
  if (q) {
    where.push('(n.title LIKE ? OR n.message LIKE ?)');
    params.push(`%${escapeLike(q)}%`, `%${escapeLike(q)}%`);
  }
  if (user_id) where.push('(n.user_id = ? OR n.role_code = ? OR (n.user_id IS NULL AND n.role_code IS NULL))');
  else if (role_code) where.push('(n.role_code = ? OR (n.user_id IS NULL AND n.role_code IS NULL))');
  if (user_id) params.push(Number(user_id), String(role_code ?? ''));
  else if (role_code) params.push(String(role_code));
  const items = await db.all(
    `SELECT n.*, u.full_name AS actor_name
     FROM notifications n
     LEFT JOIN users u ON u.id = n.user_id
     WHERE ${where.join(' AND ')}
     ORDER BY FIELD(n.severity,'critical','warning','info'), n.created_at DESC LIMIT ?`,
    [...params, Math.min(200, Math.max(1, Number(limit) || 50))],
  );
  const counts = await db.one(
    `SELECT COUNT(*) AS total, COALESCE(SUM(n.is_read = 0),0) AS unread, COALESCE(SUM(n.severity = 'critical' AND n.is_read = 0),0) AS critical
     FROM notifications n
     WHERE n.resolved_at IS NULL AND (? IS NULL OR n.user_id IS NULL OR n.user_id = ?)`,
    [user_id ? Number(user_id) : null, user_id ? Number(user_id) : null],
  );
  return { items, counts: { total: Number(counts?.total ?? 0), unread: Number(counts?.unread ?? 0), critical: Number(counts?.critical ?? 0) }, kinds: ALERT_KINDS };
}

export async function markRead(ids, ctx, all = false) {
  if (all) {
    const r = await db.run('UPDATE notifications SET is_read = 1, read_at = NOW() WHERE is_read = 0 AND (user_id = ? OR user_id IS NULL)', [ctx?.user?.id ?? 0]);
    return { marked: r.affectedRows };
  }
  const list = (Array.isArray(ids) ? ids : String(ids ?? '').split(',')).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!list.length) throw notFound('No notification ids supplied');
  const r = await db.run(`UPDATE notifications SET is_read = 1, read_at = NOW() WHERE id IN (${list.map(() => '?').join(',')})`, list);
  await audit(ctx, { action: 'read', entityType: 'notification', summary: `${r.affectedRows} notification(s) marked read` });
  return { marked: r.affectedRows };
}

export async function dismiss(id, ctx) {
  const row = await db.one('SELECT * FROM notifications WHERE id = ?', [Number(id)]);
  if (!row) throw notFound('Notification not found');
  await db.run('UPDATE notifications SET resolved_at = NOW(), is_read = 1, read_at = NOW() WHERE id = ?', [row.id]);
  await audit(ctx, { action: 'dismiss', entityType: 'notification', entityId: row.id, summary: `Dismissed "${row.title}"` });
  return { ok: true };
}
