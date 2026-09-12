/** /api/movements — tool movement history, undo, "what is out there now" (spec §18, §19). */
import express from 'express';
import db from '../db/index.js';
import { asyncRoute, badRequest, notFound, conflict } from '../lib/errors.js';
import { validate, str, num, oneOf, idRef, escapeLike } from '../lib/validate.js';
import { requirePermission } from '../middleware/index.js';
import { MOVEMENT_TYPES, performMovement } from '../services/movement.js';
import { refreshReservedQty } from '../services/tooling.js';
import { listResult, requireId } from './_helpers.js';
import { audit } from '../services/audit.js';

const router = express.Router();

const SELECT = `
  SELECT m.*, t.tooling_id, t.name AS tooling_name, tt.name AS type_name, tt.code AS type_code, tt.icon,
         o.po_number, o.status AS order_status, o.line, o.machine,
         u.full_name AS user_name,
         fl.full_code AS from_code, to_l.full_code AS to_code
  FROM tooling_movements m
  JOIN tooling_items t ON t.id = m.tooling_item_id
  JOIN tooling_types tt ON tt.id = t.tooling_type_id
  LEFT JOIN production_orders o ON o.id = m.production_order_id
  LEFT JOIN users u ON u.id = m.user_id
  LEFT JOIN tooling_locations fl ON fl.id = m.from_location_id
  LEFT JOIN tooling_locations to_l ON to_l.id = m.to_location_id`;

/** CSV export needs the same filters, so build the clause once. */
function buildWhere(q) {
  const where = ['1=1'];
  const params = [];
  if (q.tooling_id) {
    where.push('m.tooling_item_id = ?');
    params.push(Number(q.tooling_id));
  }
  if (q.tooling_code) {
    where.push('UPPER(t.tooling_id) = ?');
    params.push(String(q.tooling_code).toUpperCase());
  }
  if (q.location_id) {
    where.push('(m.from_location_id = ? OR m.to_location_id = ?)');
    params.push(Number(q.location_id), Number(q.location_id));
  }
  if (q.location_code) {
    const code = String(q.location_code).toUpperCase();
    where.push('(UPPER(fl.full_code) = ? OR UPPER(to_l.full_code) = ?)');
    params.push(code, code);
  }
  if (q.user_id) {
    where.push('m.user_id = ?');
    params.push(Number(q.user_id));
  }
  if (q.order_id) {
    where.push('m.production_order_id = ?');
    params.push(Number(q.order_id));
  }
  if (q.type) {
    const list = String(q.type).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
    where.push(`m.movement_type IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  if (q.from) {
    where.push('m.created_at >= ?');
    params.push(`${String(q.from).slice(0, 10)} 00:00:00`);
  }
  if (q.to) {
    where.push('m.created_at <= ?');
    params.push(`${String(q.to).slice(0, 10)} 23:59:59`);
  }
  if (q.days) {
    where.push('m.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)');
    params.push(Math.min(3650, Math.max(1, Number(q.days))));
  }
  if (q.q) {
    const like = `%${escapeLike(q.q)}%`;
    where.push('(UPPER(t.tooling_id) LIKE ? OR t.name LIKE ? OR m.note LIKE ? OR o.po_number LIKE ? OR m.username LIKE ?)');
    params.push(like, like, like, like, like);
  }
  return { sql: `WHERE ${where.join(' AND ')}`, params };
}

async function query(q, { limit = 50, offset = 0 } = {}) {
  const { sql, params } = buildWhere(q);
  const dir = String(q.dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const sortMap = { created_at: 'm.created_at', tooling_id: 't.tooling_id', movement_type: 'm.movement_type', id: 'm.id' };
  const sort = sortMap[q.sort] ?? 'm.created_at';
  return { sql, params, orderSql: `ORDER BY ${sort} ${dir}, m.id DESC`, limit, offset };
}

router.get(
  '/',
  requirePermission('*.read'),
  asyncRoute(async (req, res) => {
    const size = Math.min(200, Math.max(5, Number(req.query.page_size || req.query.limit || 50)));
    const page = Math.max(1, Number(req.query.page || 1));
    const { sql, params, orderSql, offset } = await query(req.query, { limit: size, offset: (page - 1) * size });
    const total = Number(await db.value(`SELECT COUNT(*) c FROM tooling_movements m JOIN tooling_items t ON t.id = m.tooling_item_id LEFT JOIN production_orders o ON o.id = m.production_order_id LEFT JOIN tooling_locations fl ON fl.id = m.from_location_id LEFT JOIN tooling_locations to_l ON to_l.id = m.to_location_id ${sql}`, params));
    const items = await db.all(`${SELECT} ${sql} ${orderSql} LIMIT ? OFFSET ?`, [...params, size, offset]);
    res.json(
      listResult({
        items: items.map((m) => ({
          ...m,
          label: `${m.movement_type === 'TAKE' ? 'Taken' : m.movement_type === 'RETURN' ? 'Returned' : m.movement_type.replace(/_/g, ' ').toLowerCase()} ${m.tooling_id}`,
          moved_from: m.from_location_code ?? m.from_code ?? null,
          moved_to: m.to_location_code ?? m.to_code ?? m.external_location ?? null,
        })),
        total,
        page,
        size,
      }),
    );
  }),
);

router.get('/export.csv', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const { sql, params, orderSql } = await query(req.query, { limit: 20000, offset: 0 });
  const rows = await db.all(`${SELECT} ${sql} ${orderSql} LIMIT ? OFFSET ?`, [...params, 20000, 0]);
  const headers = ['created_at', 'movement_type', 'tooling_id', 'tooling_name', 'type_name', 'from_location', 'to_location', 'external_location', 'status_before', 'status_after', 'qty', 'production_order', 'username', 'note'];
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => cell(r[h])).join(','))].join('\n');
  res.type('text/csv').set('Content-Disposition', `attachment; filename="movements-${new Date().toISOString().slice(0, 10)}.csv"`).send(csv);
}));

router.get('/stats', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days || 30)));
  res.json({
    days,
    by_type: await db.all(
      `SELECT movement_type, COUNT(*) AS events FROM tooling_movements WHERE created_at > DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY movement_type ORDER BY events DESC`,
      [days],
    ),
    by_day: await db.all(
      `SELECT DATE(created_at) AS day, COUNT(*) AS events,
              SUM(movement_type = 'TAKE') AS takes, SUM(movement_type = 'RETURN') AS returns_
       FROM tooling_movements WHERE created_at > DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY DATE(created_at) ORDER BY day`,
      [days],
    ),
    by_user: await db.all(
      `SELECT m.username, COUNT(*) AS events FROM tooling_movements m WHERE m.created_at > DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY m.username ORDER BY events DESC LIMIT 15`,
      [days],
    ),
    busiest_locations: await db.all(
      `SELECT to_l.full_code AS location, COUNT(*) AS arrivals FROM tooling_movements m
       JOIN tooling_locations to_l ON to_l.id = m.to_location_id
       WHERE m.created_at > DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY to_l.full_code ORDER BY arrivals DESC LIMIT 10`,
      [days],
    ),
  });
}));

/** Everything currently away from its shelf (the "where is it?" question). */
router.get('/out', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const days = Number(req.query.older_than_days || 0);
  const items = await db.all(
    `SELECT t.id, t.tooling_id, t.name, t.status, t.external_location, t.quantity, t.serial_number,
            tt.name AS type_name, tt.code AS type_code, tt.icon, l.full_code AS home_location, l.label_path AS home_path,
            o.po_number, o.id AS order_id, o.line, o.machine, o.status AS order_status,
            m.created_at AS taken_at, m.username AS taken_by, m.id AS movement_id, m.note,
            TIMESTAMPDIFF(HOUR, m.created_at, NOW()) AS hours_out
     FROM tooling_items t
     JOIN tooling_types tt ON tt.id = t.tooling_type_id
     JOIN tooling_movements m ON m.id = (SELECT MAX(id) FROM tooling_movements m2 WHERE m2.tooling_item_id = t.id)
     LEFT JOIN tooling_locations l ON l.id = t.location_id
     LEFT JOIN production_orders o ON o.id = m.production_order_id
     LEFT JOIN production_order_tools pot ON pot.production_order_id = o.id AND pot.tooling_item_id = t.id
     WHERE t.deleted_at IS NULL AND t.status = 'IN_USE' AND COALESCE(pot.status, 'TAKEN') = 'TAKEN'
       ${days > 0 ? 'AND m.created_at < DATE_SUB(NOW(), INTERVAL ? DAY)' : ''}
     ORDER BY m.created_at ASC LIMIT 200`,
    days > 0 ? [days] : [],
  );
  res.json({
    items,
    count: items.length,
    overdue: items.filter((i) => Number(i.hours_out) > 24).length,
    note: 'Sorted oldest first - these are the tools to chase up.',
  });
}));

/** Last movement for a tool (used on the tool card "history" strip). */
router.get('/tool/:ref', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const tool = /^\d+$/.test(req.params.ref)
    ? await db.one('SELECT id, tooling_id FROM tooling_items WHERE id = ?', [Number(req.params.ref)])
    : await db.one('SELECT id, tooling_id FROM tooling_items WHERE UPPER(tooling_id) = ?', [req.params.ref.toUpperCase()]);
  if (!tool) throw notFound(`Tooling ${req.params.ref} not found`);
  const size = Math.min(200, Math.max(5, Number(req.query.page_size || 50)));
  const page = Math.max(1, Number(req.query.page || 1));
  const total = Number(await db.value('SELECT COUNT(*) c FROM tooling_movements WHERE tooling_item_id = ?', [tool.id]));
  const items = await db.all(
    `SELECT m.*, o.po_number, u.full_name AS user_name, fl.full_code AS from_code, to_l.full_code AS to_code
     FROM tooling_movements m
     LEFT JOIN production_orders o ON o.id = m.production_order_id
     LEFT JOIN users u ON u.id = m.user_id
     LEFT JOIN tooling_locations fl ON fl.id = m.from_location_id
     LEFT JOIN tooling_locations to_l ON to_l.id = m.to_location_id
     WHERE m.tooling_item_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`,
    [tool.id, size, (page - 1) * size],
  );
  res.json(listResult({ items, total, page, size }));
}));

router.get('/recent', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const limit = Math.min(100, Math.max(5, Number(req.query.limit || 25)));
  res.json({ items: await db.all(`${SELECT} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`, [limit]) });
}));

/** Undo the last movement of a tool (mis-scan correction). Never deletes history. */
router.post('/:id/undo', requirePermission('locations.manage'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'movement id');
  const mv = await db.one('SELECT * FROM tooling_movements WHERE id = ?', [id]);
  if (!mv) throw notFound('Movement not found');
  const later = await db.value('SELECT COUNT(*) c FROM tooling_movements WHERE tooling_item_id = ? AND id > ?', [mv.tooling_item_id, id]);
  if (Number(later) > 0) throw conflict(`${later} newer movement(s) exist for this tool - undo them first (or move it manually)`);
  return db.tx(async (exec) => {
    await exec.run('UPDATE tooling_items SET location_id = ?, external_location = ?, status = ?, updated_at = NOW() WHERE id = ?', [mv.from_location_id, null, mv.status_before ?? mv.status_after, mv.tooling_item_id]);
    await exec.run(
      `INSERT INTO tooling_movements (tooling_item_id, movement_type, from_location_id, to_location_id, from_location_code, to_location_code,
                                      status_before, status_after, qty, reason_code, note, user_id, username, created_at)
       VALUES (?, 'UNDO', ?,?,?,?,?,?,?, 'CORRECTION', ?,?,?, NOW())`,
      [
        mv.tooling_item_id,
        mv.to_location_id,
        mv.from_location_id,
        mv.to_location_code ?? null,
        mv.from_location_code ?? null,
        mv.status_after,
        mv.status_before,
        mv.qty ?? 1,
        `Undid movement #${mv.id} (${mv.movement_type})${req.body?.reason ? `: ${String(req.body.reason).slice(0, 300)}` : ''}`,
        req.user.id,
        req.user.username,
      ],
    );
    if (mv.production_order_id) {
      await exec.run("UPDATE production_order_tools SET status = 'PENDING', taken_at = NULL WHERE production_order_id = ? AND tooling_item_id = ? AND status = 'TAKEN'", [mv.production_order_id, mv.tooling_item_id]);
    }
    await exec.run("UPDATE tooling_movements SET note = CONCAT(COALESCE(note,''), ' [UNDONE]') WHERE id = ?", [mv.id]);
    await audit(req.ctx, {
      action: 'undo',
      entityType: 'movement',
      entityId: mv.id,
      entityLabel: mv.movement_type,
      summary: `Undid ${mv.movement_type} for tool #${mv.tooling_item_id}${req.body?.reason ? ` (reason: ${String(req.body.reason).slice(0, 200)})` : ''}`,
    });
    await refreshReservedQty();
    return { ok: true, restored_location: mv.from_location_code, restored_status: mv.status_before };
  }).then(async (out) => {
    res.json(out);
  });
}));

/** Manual log entry (paper-based correction, e.g. "this was taken before we had the app"). */
router.post('/', requirePermission('tooling.move'), asyncRoute(async (req, res) => {
  const data = validate(
    {
      tooling_item_id: [idRef, { required: true }],
      movement_type: oneOf(MOVEMENT_TYPES, { required: true }),
      location: [str, { max: 200 }],
      production_order_id: [idRef, {}],
      qty: [num, { int: true, min: 1, max: 999 }],
      reason: oneOf(['MIS_SCAN', 'CORRECTION', 'AUDIT', 'OTHER']),
      note: [str, { max: 500 }],
    },
    req.body,
  );
  if (!data.note) throw badRequest('A manual entry needs a note explaining why');
  const out = await performMovement({
    tooling: data.tooling_item_id,
    action: data.movement_type,
    location: data.location ?? null,
    production_order_id: data.production_order_id ?? null,
    qty: data.qty ?? 1,
    reason: data.reason ?? 'CORRECTION',
    note: data.note,
    ctx: req.ctx,
  });
  res.status(201).json(out);
}));

export default router;
