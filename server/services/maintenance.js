/**
 * Maintenance, condition/damage reports and tooling requests (spec §20-§22, §35-§36).
 * A damage report can auto-open a repair request; completing maintenance resets the
 * next-due date and (optionally) the cycle counter.
 */
import db from '../db/index.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';
import { audit } from './audit.js';

export const MAINT_TYPES = ['PREVENTIVE', 'CORRECTIVE', 'INSPECTION', 'CLEANING', 'MODIFICATION', 'REPAIR'];
export const MAINT_STATUSES = ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'DEFERRED'];
export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
export const REQUEST_STATUSES = ['PENDING', 'APPROVED', 'IN_PRODUCTION', 'COMPLETED', 'REJECTED', 'CANCELLED'];

const pad = (n) => String(n).padStart(4, '0');

export async function listMaintenance(query = {}) {
  const where = ['1=1'];
  const params = [];
  if (query.tooling_id) {
    where.push('m.tooling_item_id = ?');
    params.push(Number(query.tooling_id));
  }
  if (query.status) {
    where.push('m.status = ?');
    params.push(String(query.status).toUpperCase());
  }
  if (query.kind) {
    where.push('m.kind = ?');
    params.push(String(query.kind).toUpperCase());
  }
  if (query.open_only === '1') where.push("m.status IN ('SCHEDULED','IN_PROGRESS','DEFERRED')");
  if (query.overdue === '1') where.push("m.status = 'SCHEDULED' AND m.scheduled_date < CURDATE()");
  if (query.technician) {
    where.push('m.technician LIKE ?');
    params.push(`%${query.technician}%`);
  }
  if (query.from) {
    where.push('COALESCE(m.completed_date, m.scheduled_date) >= ?');
    params.push(String(query.from).slice(0, 10));
  }
  if (query.to) {
    where.push('COALESCE(m.completed_date, m.scheduled_date) <= ?');
    params.push(String(query.to).slice(0, 10));
  }
  if (query.q) {
    where.push('(t.tooling_id LIKE ? OR t.name LIKE ? OR m.technician LIKE ? OR m.work_description LIKE ?)');
    const like = `%${query.q}%`;
    params.push(like, like, like, like);
  }
  const size = Math.min(200, Math.max(1, Number(query.size || 25)));
  const page = Math.max(1, Number(query.page || 1));
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = Number(
    await db.value(
      `SELECT COUNT(*) c FROM tooling_maintenance m JOIN tooling_items t ON t.id = m.tooling_item_id ${whereSql}`,
      params,
    ),
  );
  const items = await db.all(
    `SELECT m.*, t.tooling_id, t.name AS tooling_name, t.status AS tooling_status, t.condition_rating, t.next_maintenance_date,
            t.total_cycles, t.max_cycles, tt.name AS type_name, tt.code AS type_code, tt.icon,
            l.full_code AS location_code, d.full_name AS created_by_name
     FROM tooling_maintenance m
     JOIN tooling_items t ON t.id = m.tooling_item_id
     JOIN tooling_types tt ON tt.id = t.tooling_type_id
     LEFT JOIN tooling_locations l ON l.id = t.location_id
     LEFT JOIN users d ON d.id = m.created_by
     ${whereSql}
     ORDER BY (m.status = 'SCHEDULED') DESC, m.scheduled_date IS NULL, m.scheduled_date ASC, m.id DESC
     LIMIT ? OFFSET ?`,
    [...params, size, (page - 1) * size],
  );
  return { items, total, page, size, pages: Math.max(1, Math.ceil(total / size)) };
}

export async function scheduleMaintenance(data, ctx) {
  const tool = await db.one(
    `SELECT t.*, tt.requires_maintenance FROM tooling_items t JOIN tooling_types tt ON tt.id = t.tooling_type_id WHERE t.id = ?`,
    [Number(data.tooling_item_id)],
  );
  if (!tool) throw badRequest('tooling_item_id does not match an existing tool');
  if (tool.deleted_at) throw conflict(`${tool.tooling_id} is archived - restore it before logging maintenance`);
  const scheduled = data.scheduled_date ?? new Date().toISOString().slice(0, 10);
  const res = await db.run(
    `INSERT INTO tooling_maintenance (tooling_item_id, kind, status, priority, scheduled_date, technician, work_description, condition_before, damage_report_id, next_maintenance_date, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, NOW())`,
    [
      tool.id,
      data.kind ?? 'PREVENTIVE',
      data.status ?? 'SCHEDULED',
      data.priority ?? 'NORMAL',
      scheduled,
      data.technician ?? null,
      data.work_description ?? null,
      data.condition_before ?? tool.condition_rating ?? 'GOOD',
      data.damage_report_id ?? null,
      data.next_maintenance_date ?? defaultNextDue(tool, scheduled),
      ctx?.user?.id ?? null,
    ],
  );
  const id = res.insertId ?? (await db.value('SELECT MAX(id) m FROM tooling_maintenance WHERE tooling_item_id = ?', [tool.id]));
  if (data.status === 'IN_PROGRESS') {
    await db.run("UPDATE tooling_items SET status = 'MAINTENANCE', updated_at = NOW() WHERE id = ?", [tool.id]);
  }
  await audit(ctx, {
    action: 'create',
    entityType: 'maintenance',
    entityId: id,
    entityLabel: tool.tooling_id,
    summary: `${data.kind ?? 'PREVENTIVE'} maintenance scheduled for ${tool.tooling_id} on ${scheduled}`,
  });
  return db.one('SELECT * FROM tooling_maintenance WHERE id = ?', [id]);
}

function defaultNextDue(tool, fromDate) {
  const days = Number(tool.maintenance_interval_days ?? 0);
  if (!days) return null;
  const d = new Date(`${String(fromDate).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function completeMaintenance(id, data, ctx) {
  const row = await db.one(
    `SELECT m.*, t.tooling_id, t.maintenance_interval_days, t.maintenance_interval_cycles FROM tooling_maintenance m
     JOIN tooling_items t ON t.id = m.tooling_item_id WHERE m.id = ?`,
    [Number(id)],
  );
  if (!row) throw notFound('Maintenance record not found');
  if (row.status === 'COMPLETED' && data.allow_reopen !== true) throw conflict('This maintenance job is already completed');
  const completed = data.completed_date ?? new Date().toISOString().slice(0, 10);
  const nextDue = data.next_maintenance_date ?? defaultNextDue(row, completed);
  return db.tx(async (exec) => {
    await exec.run(
      `UPDATE tooling_maintenance SET status='COMPLETED', completed_date=?, technician=COALESCE(?, technician), work_description=COALESCE(?, work_description),
              findings=COALESCE(?, findings), condition_after=?, parts_replaced=COALESCE(?, parts_replaced), cost=COALESCE(?, cost),
              downtime_hours=COALESCE(?, downtime_hours), next_maintenance_date=?, before_image_ids=COALESCE(?, before_image_ids), after_image_ids=COALESCE(?, after_image_ids),
              updated_at = NOW()
       WHERE id = ?`,
      [
        completed,
        data.technician ?? null,
        data.work_description ?? null,
        data.findings ?? null,
        data.condition_after ?? 'GOOD',
        data.parts_replaced ?? null,
        data.cost ?? null,
        data.downtime_hours ?? null,
        nextDue,
        data.before_image_ids ?? null,
        data.after_image_ids ?? null,
        row.id,
      ],
    );
    // COALESCE keeps a due date that an earlier (longer-interval) job already established
    await exec.run('UPDATE tooling_items SET last_maintenance_date = ?, next_maintenance_date = COALESCE(?, next_maintenance_date), condition_rating = ?, last_condition_check_at = NOW(), updated_at = NOW() WHERE id = ?', [
      completed,
      nextDue,
      data.condition_after ?? row.condition_after ?? 'GOOD',
      row.tooling_item_id,
    ]);
    if (data.reset_cycles === true) await exec.run('UPDATE tooling_items SET total_cycles = 0 WHERE id = ?', [row.tooling_item_id]);
    if (data.return_to_service !== false) {
      const stillBlocked = await exec.value(
        "SELECT COUNT(*) c FROM tooling_maintenance WHERE tooling_item_id = ? AND status IN ('SCHEDULED','IN_PROGRESS') AND id <> ?",
        [row.tooling_item_id, row.id],
      );
      const damage = await exec.value("SELECT COUNT(*) c FROM tooling_damage_reports WHERE tooling_item_id = ? AND status = 'OPEN'", [row.tooling_item_id]);
      const statusNow = await exec.value('SELECT status FROM tooling_items WHERE id = ?', [row.tooling_item_id]);
      if (!Number(stillBlocked) && !Number(damage) && ['MAINTENANCE', 'DAMAGED', 'MISSING'].includes(String(statusNow))) {
        await exec.run("UPDATE tooling_items SET status = 'AVAILABLE', updated_at = NOW() WHERE id = ?", [row.tooling_item_id]);
        await exec.run(
          `INSERT INTO tooling_movements (tooling_item_id, movement_type, status_before, status_after, note, user_id, username, created_at)
           VALUES (?, 'MAINTENANCE', ?, 'AVAILABLE', ?, ?, ?, NOW())`,
          [row.tooling_item_id, statusNow, `Maintenance completed (${row.tooling_id}) - back in service`, ctx?.user?.id ?? null, ctx?.user?.username ?? 'system'],
        );
      }
    }
    if (row.damage_report_id) {
      await exec.run("UPDATE tooling_damage_reports SET status='RESOLVED', resolved_at = NOW(), resolution = COALESCE(resolution, ?), maintenance_id = ? WHERE id = ?", [
        `Fixed under maintenance #${row.id}`,
        row.id,
        row.damage_report_id,
      ]);
      await exec.run('UPDATE tooling_items SET open_damage_reports = GREATEST(open_damage_reports - 1, 0) WHERE id = ?', [row.tooling_item_id]);
    }
    await exec.run(
      `INSERT INTO tooling_usage_history (tooling_item_id, event_type, cycles, quantity, produced_qty, operator_id, operator_name, note)
       VALUES (?, 'MAINTENANCE', 0, 0, 0, ?, ?, ?)`,
      [row.tooling_item_id, ctx?.user?.id ?? null, ctx?.user?.full_name ?? null, `Maintenance #${row.id} completed`],
    );
    await audit(ctx, {
      action: 'complete',
      entityType: 'maintenance',
      entityId: row.id,
      entityLabel: row.tooling_id,
      summary: `Maintenance completed for ${row.tooling_id}${nextDue ? `, next due ${nextDue}` : ''}`,
    });
    return db.one('SELECT * FROM tooling_maintenance WHERE id = ?', [row.id]);
  });
}

export async function updateMaintenance(id, data, ctx) {
  const row = await db.one('SELECT * FROM tooling_maintenance WHERE id = ?', [Number(id)]);
  if (!row) throw notFound('Maintenance record not found');
  const allowed = ['kind', 'status', 'priority', 'scheduled_date', 'technician', 'work_description', 'findings', 'parts_replaced', 'cost', 'downtime_hours', 'next_maintenance_date', 'condition_after', 'condition_before'];
  const keys = Object.keys(data).filter((k) => allowed.includes(k));
  if (!keys.length) throw badRequest('Nothing to update');
  await db.run(`UPDATE tooling_maintenance SET ${keys.map((k) => `\`${k}\`=?`).join(',')}, updated_at = NOW() WHERE id = ?`, [...keys.map((k) => data[k]), row.id]);
  await audit(ctx, { action: 'update', entityType: 'maintenance', entityId: row.id, summary: `Maintenance updated: ${keys.join(', ')}` });
  return db.one('SELECT * FROM tooling_maintenance WHERE id = ?', [row.id]);
}

export async function deleteMaintenance(id, ctx) {
  const row = await db.one('SELECT * FROM tooling_maintenance WHERE id = ?', [Number(id)]);
  if (!row) throw notFound('Maintenance record not found');
  await db.run('DELETE FROM tooling_maintenance WHERE id = ?', [row.id]);
  await audit(ctx, { action: 'delete', entityType: 'maintenance', entityId: row.id, summary: 'Maintenance record deleted' });
  return { ok: true };
}

/* ------------------------------------------------------------ damage */
export async function listDamage(query = {}) {
  const where = ['1=1'];
  const params = [];
  if (query.tooling_id) {
    where.push('d.tooling_item_id = ?');
    params.push(Number(query.tooling_id));
  }
  if (query.status) {
    where.push('d.status = ?');
    params.push(String(query.status).toUpperCase());
  }
  if (query.severity) {
    where.push('d.severity = ?');
    params.push(String(query.severity).toUpperCase());
  }
  if (query.open_only === '1') where.push("d.status = 'OPEN'");
  const size = Math.min(200, Math.max(1, Number(query.size || 25)));
  const page = Math.max(1, Number(query.page || 1));
  const total = Number(
    await db.value(`SELECT COUNT(*) c FROM tooling_damage_reports d WHERE ${where.join(' AND ')}`, params),
  );
  const items = await db.all(
    `SELECT d.*, t.tooling_id, t.name AS tooling_name, t.status AS tooling_status, t.location_id, l.full_code AS location_code,
            tt.name AS type_name, tt.code AS type_code, u.full_name AS reported_by_name,
            (SELECT COUNT(*) FROM tooling_images im WHERE im.owner_type='DAMAGE_REPORT' AND im.owner_id = d.id) AS photo_count
     FROM tooling_damage_reports d
     JOIN tooling_items t ON t.id = d.tooling_item_id
     JOIN tooling_types tt ON tt.id = t.tooling_type_id
     LEFT JOIN tooling_locations l ON l.id = t.location_id
     LEFT JOIN users u ON u.id = d.reported_by
     WHERE ${where.join(' AND ')}
     ORDER BY (d.status = 'OPEN') DESC, FIELD(d.severity,'CRITICAL','HIGH','MEDIUM','LOW'), d.reported_at DESC
     LIMIT ? OFFSET ?`,
    [...params, size, (page - 1) * size],
  );
  return { items, total, page, size, pages: Math.max(1, Math.ceil(total / size)) };
}

export async function createDamageReport(data, ctx) {
  const tool = await db.one(
    `SELECT t.*, tt.name AS type_name FROM tooling_items t JOIN tooling_types tt ON tt.id = t.tooling_type_id WHERE t.id = ?`,
    [Number(data.tooling_item_id)],
  );
  if (!tool) throw badRequest('tooling_item_id does not match an existing tool');
  if (tool.deleted_at) throw conflict(`${tool.tooling_id} is archived`);
  let reportNo = data.report_no;
  if (!reportNo) {
    for (let i = 0; i < 40; i++) {
      const seq = Number(await db.value('SELECT COUNT(*) c FROM tooling_damage_reports')) + 1 + i;
      reportNo = `DMG-${new Date().getFullYear()}-${pad(seq)}`;
      if (!(await db.one('SELECT id FROM tooling_damage_reports WHERE report_no = ?', [reportNo]))) break;
    }
  }
  return db.tx(async (exec) => {
    const res = await exec.run(
      `INSERT INTO tooling_damage_reports (report_no, tooling_item_id, damage_type, severity, location_note, description, production_order_id, reported_by, reported_at, status)
       VALUES (?,?,?,?,?,?,?,?, NOW(), 'OPEN')`,
      [reportNo, tool.id, data.damage_type, data.severity ?? 'MEDIUM', data.location_note ?? null, data.description ?? null, data.production_order_id ?? null, ctx?.user?.id ?? null],
    );
    const id = res.insertId ?? (await exec.value('SELECT id FROM tooling_damage_reports WHERE report_no = ?', [reportNo]));
    await exec.run('UPDATE tooling_items SET open_damage_reports = open_damage_reports + 1, updated_at = NOW() WHERE id = ?', [tool.id]);
    let maintenanceId = null;
    if (data.create_repair_request !== false) {
      const m = await exec.run(
        `INSERT INTO tooling_maintenance (tooling_item_id, kind, status, priority, scheduled_date, technician, work_description, condition_before, damage_report_id, created_by, created_at)
         VALUES (?, 'CORRECTIVE', 'SCHEDULED', ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          tool.id,
          data.severity === 'CRITICAL' || data.severity === 'HIGH' ? 'URGENT' : 'HIGH',
          new Date().toISOString().slice(0, 10),
          data.technician ?? null,
          `Repair required - ${data.damage_type}${data.description ? `: ${String(data.description).slice(0, 300)}` : ''}`,
          tool.condition_rating,
          id,
          ctx?.user?.id ?? null,
        ],
      );
      maintenanceId = m.insertId ?? (await exec.value('SELECT MAX(id) m FROM tooling_maintenance WHERE damage_report_id = ?', [id]));
      if (maintenanceId) await exec.run('UPDATE tooling_damage_reports SET maintenance_id = ? WHERE id = ?', [maintenanceId, id]);
    }
    const newStatus = data.quarantine === false ? tool.status : data.severity === 'LOW' ? tool.status : 'DAMAGED';
    if (newStatus !== tool.status) {
      await exec.run('UPDATE tooling_items SET status = ?, updated_at = NOW() WHERE id = ?', [newStatus, tool.id]);
      await exec.run(
        `INSERT INTO tooling_movements (tooling_item_id, movement_type, status_before, status_after, note, user_id, username, created_at)
         VALUES (?, 'DAMAGE', ?,?,?,?,?,NOW())`,
        [tool.id, tool.status, newStatus, `Damage report ${reportNo} raised`, ctx?.user?.id ?? null, ctx?.user?.username ?? 'system'],
      );
    }
    await exec.run(
      `INSERT INTO notifications (user_id, role_code, kind, severity, title, message, entity_type, entity_id, link)
       VALUES (NULL, ?, 'damage_report', ?, ?, ?, 'damage_report', ?, ?)`,
      [
        'quality',
        data.severity === 'CRITICAL' ? 'critical' : 'warning',
        `Damage reported on ${tool.tooling_id}`,
        `${data.damage_type} (${data.severity ?? 'MEDIUM'})${data.description ? ` - ${String(data.description).slice(0, 200)}` : ''}`,
        id,
        `#/tooling/${tool.id}`,
      ],
    );
    await audit(ctx, {
      action: 'create',
      entityType: 'damage_report',
      entityId: id,
      entityLabel: reportNo,
      summary: `${data.damage_type} (${data.severity ?? 'MEDIUM'}) on ${tool.tooling_id}${maintenanceId ? `, repair request #${maintenanceId} opened` : ''}`,
    });
    return { id, report_no: reportNo, maintenance_id: maintenanceId, tooling_status: newStatus };
  });
}

export async function resolveDamageReport(id, data, ctx) {
  const row = await db.one('SELECT * FROM tooling_damage_reports WHERE id = ?', [Number(id)]);
  if (!row) throw notFound('Damage report not found');
  if (row.status !== 'OPEN') throw conflict('This report is already closed');
  return db.tx(async (exec) => {
    await exec.run("UPDATE tooling_damage_reports SET status=?, resolution=?, resolved_at = NOW(), maintenance_id = COALESCE(?, maintenance_id) WHERE id = ?", [
      data.status ?? 'RESOLVED',
      data.resolution ?? null,
      data.maintenance_id ?? null,
      row.id,
    ]);
    await exec.run('UPDATE tooling_items SET open_damage_reports = GREATEST(open_damage_reports - 1, 0) WHERE id = ?', [row.tooling_item_id]);
    if (data.set_status) {
      const tool = await exec.one('SELECT status FROM tooling_items WHERE id = ?', [row.tooling_item_id]);
      await exec.run('UPDATE tooling_items SET status = ?, updated_at = NOW() WHERE id = ?', [data.set_status, row.tooling_item_id]);
      await exec.run(
        `INSERT INTO tooling_movements (tooling_item_id, movement_type, status_before, status_after, note, user_id, username, created_at)
         VALUES (?, 'STATUS_CHANGE', ?,?,?,?,?,NOW())`,
        [row.tooling_item_id, tool.status, data.set_status, `Damage report ${row.report_no} closed`, ctx?.user?.id ?? null, ctx?.user?.username ?? 'system'],
      );
    }
    await exec.run("UPDATE notifications SET is_read = 1, read_at = NOW() WHERE entity_type = 'damage_report' AND entity_id = ? AND is_read = 0", [String(row.id)]);
    await audit(ctx, { action: 'resolve', entityType: 'damage_report', entityId: row.id, entityLabel: row.report_no, summary: `Damage report ${data.status ?? 'RESOLVED'}` });
    return db.one('SELECT * FROM tooling_damage_reports WHERE id = ?', [row.id]);
  });
}

/* ------------------------------------------------------- tooling requests */
export async function listRequests(query = {}) {
  const where = ['1=1'];
  const params = [];
  if (query.status) {
    where.push('r.status = ?');
    params.push(String(query.status).toUpperCase());
  }
  if (query.mine === '1' && query.user_id) {
    where.push('(r.requested_by = ? OR r.assigned_to = ?)');
    params.push(Number(query.user_id), Number(query.user_id));
  }
  if (query.filter_id) {
    where.push('r.filter_id = ?');
    params.push(Number(query.filter_id));
  }
  const size = Math.min(200, Math.max(1, Number(query.size || 25)));
  const page = Math.max(1, Number(query.page || 1));
  const total = Number(await db.value(`SELECT COUNT(*) c FROM tooling_requests r WHERE ${where.join(' AND ')}`, params));
  const items = await db.all(
    `SELECT r.*, f.internal_number AS filter_number, f.name AS filter_name, tt.name AS type_name, tt.code AS type_code, tt.icon,
            req.full_name AS requested_by_name, asn.full_name AS assigned_to_name, app.full_name AS approved_by_name,
            t.tooling_id AS created_tooling_id_code, ex.tooling_id AS existing_tool_code, ex.status AS existing_tool_status,
            l.full_code AS existing_tool_location
     FROM tooling_requests r
     LEFT JOIN filters f ON f.id = r.filter_id
     LEFT JOIN tooling_types tt ON tt.id = r.requested_tooling_type_id
     LEFT JOIN users req ON req.id = r.requested_by
     LEFT JOIN users asn ON asn.id = r.assigned_to
     LEFT JOIN users app ON app.id = r.approved_by
     LEFT JOIN tooling_items t ON t.id = r.created_tooling_id
     LEFT JOIN tooling_items ex ON ex.id = r.existing_tool_id
     LEFT JOIN tooling_locations l ON l.id = ex.location_id
     ${where.join(' AND ') ? whereSqlOf(where) : ''}
     ORDER BY FIELD(r.status,'PENDING','APPROVED','IN_PRODUCTION','COMPLETED','REJECTED','CANCELLED'), r.target_date IS NULL, r.target_date
     LIMIT ? OFFSET ?`,
    [...params, size, (page - 1) * size],
  );
  return { items, total, page, size, pages: Math.max(1, Math.ceil(total / size)) };
}

const whereSqlOf = (where) => `WHERE ${where.join(' AND ')}`;

export async function createRequest(data, ctx) {
  let requestNo = data.request_no;
  if (!requestNo) {
    for (let i = 0; i < 40; i++) {
      requestNo = `REQ-${new Date().getFullYear()}-${pad(Number(await db.value('SELECT COUNT(*) c FROM tooling_requests')) + 1 + i)}`;
      if (!(await db.one('SELECT id FROM tooling_requests WHERE request_no = ?', [requestNo]))) break;
    }
  }
  const res = await db.run(
    `INSERT INTO tooling_requests (request_no, filter_id, requested_tooling_type_id, title, description, priority, status, quantity, target_date, requested_by, requested_for_dept, existing_tool_id, checked_existing, estimate_cost)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?)`,
    [
      requestNo,
      data.filter_id ?? null,
      data.tooling_type_id ?? null,
      data.title,
      data.description ?? null,
      data.priority ?? 'NORMAL',
      'PENDING',
      data.quantity ?? 1,
      data.target_date ?? null,
      ctx?.user?.id ?? null,
      data.requested_for_dept ?? null,
      data.existing_tool_id ?? null,
      data.existing_tool_id ? 1 : 0,
      data.estimate_cost ?? null,
    ],
  );
  const id = res.insertId ?? (await db.value('SELECT id FROM tooling_requests WHERE request_no = ?', [requestNo]));
  await db.run(
    `INSERT INTO notifications (role_code, kind, severity, title, message, entity_type, entity_id, link)
     VALUES ('engineering', 'tooling_request', 'info', ?, ?, 'tooling_request', ?, ?)`,
    [`New tooling request ${requestNo}`, `${data.title}${data.filter_id ? ` (filter #${data.filter_id})` : ''}`, id, '#/requests'],
  );
  await audit(ctx, { action: 'create', entityType: 'tooling_request', entityId: id, entityLabel: requestNo, summary: `Request "${data.title}" submitted` });
  return db.one('SELECT * FROM tooling_requests WHERE id = ?', [id]);
}

export async function transitionRequest(id, nextStatus, data, ctx) {
  const row = await db.one('SELECT * FROM tooling_requests WHERE id = ?', [Number(id)]);
  if (!row) throw notFound('Tooling request not found');
  const flow = { PENDING: ['APPROVED', 'REJECTED', 'CANCELLED'], APPROVED: ['IN_PRODUCTION', 'CANCELLED', 'REJECTED'], IN_PRODUCTION: ['COMPLETED', 'CANCELLED'], COMPLETED: [], REJECTED: ['PENDING'], CANCELLED: ['PENDING'] };
  if (!(flow[row.status] ?? []).includes(nextStatus)) {
    throw badRequest(`Cannot move a request from ${row.status} to ${nextStatus}. Allowed: ${(flow[row.status] ?? []).join(', ') || 'nothing'}`);
  }
  return db.tx(async (exec) => {
    await exec.run(
      `UPDATE tooling_requests SET status = ?, approved_by = ?, approved_at = ?, rejection_reason = ?, assigned_to = COALESCE(?, assigned_to),
              actual_cost = COALESCE(?, actual_cost), completed_at = ?, updated_at = NOW() WHERE id = ?`,
      [
        nextStatus,
        nextStatus === 'APPROVED' ? ctx?.user?.id ?? null : row.approved_by,
        nextStatus === 'APPROVED' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : row.approved_at,
        nextStatus === 'REJECTED' ? data.reason ?? 'No reason recorded' : row.rejection_reason,
        data.assigned_to ?? null,
        data.actual_cost ?? null,
        nextStatus === 'COMPLETED' ? new Date() : row.completed_at,
        row.id,
      ],
    );
    if (data.note) {
      await exec.run(
        `INSERT INTO notifications (user_id, kind, severity, title, message, entity_type, entity_id, link)
         VALUES (?, 'tooling_request', 'info', ?, ?, 'tooling_request', ?, ?)`,
        [row.requested_by, `Request ${row.request_no} is now ${nextStatus}`, String(data.note).slice(0, 300), row.id, '#/requests'],
      );
    }
    await audit(ctx, { action: nextStatus.toLowerCase(), entityType: 'tooling_request', entityId: row.id, entityLabel: row.request_no, summary: `${row.request_no}: ${row.status} -> ${nextStatus}${data.reason ? ` (${data.reason})` : ''}` });
    return db.one('SELECT * FROM tooling_requests WHERE id = ?', [row.id]);
  });
}

/** Link an existing tool as the answer to a request ("we already have this"). */
export async function linkExistingTool(requestId, toolingItemId, ctx) {
  const req = await db.one('SELECT * FROM tooling_requests WHERE id = ?', [Number(requestId)]);
  if (!req) throw notFound('Tooling request not found');
  const tool = await db.one('SELECT id, tooling_id, status FROM tooling_items WHERE id = ?', [Number(toolingItemId)]);
  if (!tool) throw badRequest('Tooling item not found');
  await db.run('UPDATE tooling_requests SET existing_tool_id = ?, checked_existing = 1, status = ?, updated_at = NOW() WHERE id = ?', [tool.id, 'REJECTED', req.id]);
  await db.run(
    `INSERT INTO notifications (user_id, kind, severity, title, message, entity_type, entity_id, link)
     VALUES (?, 'tooling_request', 'info', ?, ?, 'tooling_request', ?, ?)`,
    [req.requested_by, `Request ${req.request_no}: tool already exists`, `${tool.tooling_id} (${tool.status}) can be used instead of making new tooling`, req.id, `#/tooling/${tool.id}`],
  );
  await audit(ctx, { action: 'link_existing', entityType: 'tooling_request', entityId: req.id, entityLabel: req.request_no, summary: `Marked as satisfied by existing ${tool.tooling_id}` });
  return db.one('SELECT * FROM tooling_requests WHERE id = ?', [req.id]);
}

/** Convert an approved request into a real tooling record. */
export async function promoteRequestToTool(requestId, toolData, ctx) {
  const req = await db.one('SELECT * FROM tooling_requests WHERE id = ?', [Number(requestId)]);
  if (!req) throw notFound('Tooling request not found');
  if (!['APPROVED', 'IN_PRODUCTION'].includes(req.status)) throw conflict(`Only approved requests can be turned into tooling (this one is ${req.status})`);
  const { createTool } = await import('./tooling.js');
  const created = await createTool({
    ...toolData,
    tooling_type_id: toolData.tooling_type_id ?? req.requested_tooling_type_id,
    primary_filter_id: toolData.primary_filter_id ?? req.filter_id,
    quantity: toolData.quantity ?? req.quantity ?? 1,
    created_by: ctx?.user?.id ?? null,
  });
  await db.run("UPDATE tooling_requests SET status='COMPLETED', created_tooling_id = ?, completed_at = NOW(), updated_at = NOW() WHERE id = ?", [created.id, req.id]);
  await audit(ctx, { action: 'promote', entityType: 'tooling_request', entityId: req.id, entityLabel: req.request_no, summary: `Request fulfilled - created ${created.tooling_id}` });
  return { request: await db.one('SELECT * FROM tooling_requests WHERE id = ?', [req.id]), tooling: created };
}

/** Alerts for the dashboard (spec §20/§35). */
export async function dueAlerts({ days = 14, includeOverdue = true } = {}) {
  const window = Math.max(0, Math.min(365, Number(days) || 14));
  const overdue = await db.all(
    `SELECT t.id, t.tooling_id, t.name, t.next_maintenance_date, t.total_cycles, t.max_cycles, tt.name AS type_name, tt.icon,
            DATEDIFF(CURDATE(), t.next_maintenance_date) AS days_overdue, l.full_code AS location_code, l.label_path AS location_path
     FROM tooling_items t JOIN tooling_types tt ON tt.id = t.tooling_type_id
     LEFT JOIN tooling_locations l ON l.id = t.location_id
     WHERE t.deleted_at IS NULL AND t.next_maintenance_date IS NOT NULL AND t.next_maintenance_date < CURDATE()
     ORDER BY t.next_maintenance_date LIMIT 60`,
  );
  const upcoming = await db.all(
    `SELECT t.id, t.tooling_id, t.name, t.next_maintenance_date, t.total_cycles, t.max_cycles, tt.name AS type_name, tt.icon,
            DATEDIFF(t.next_maintenance_date, CURDATE()) AS days_left, l.full_code AS location_code
     FROM tooling_items t JOIN tooling_types tt ON tt.id = t.tooling_type_id
     LEFT JOIN tooling_locations l ON l.id = t.location_id
     WHERE t.deleted_at IS NULL AND t.next_maintenance_date IS NOT NULL AND t.next_maintenance_date >= CURDATE() AND t.next_maintenance_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)
     ORDER BY t.next_maintenance_date LIMIT 60`,
    [window],
  );
  const cycleLimits = await db.all(
    `SELECT t.id, t.tooling_id, t.name, t.total_cycles, t.max_cycles,
            ROUND(t.total_cycles * 100.0 / t.max_cycles) AS used_pct, tt.name AS type_name, l.full_code AS location_code
     FROM tooling_items t JOIN tooling_types tt ON tt.id = t.tooling_type_id
     LEFT JOIN tooling_locations l ON l.id = t.location_id
     WHERE t.deleted_at IS NULL AND t.max_cycles IS NOT NULL AND t.total_cycles * 100 >= t.max_cycles * t.cycle_warning_pct
     ORDER BY used_pct DESC LIMIT 60`,
  );
  return { overdue: includeOverdue ? overdue : [], upcoming, cycle_limits: cycleLimits, window_days: window };
}
