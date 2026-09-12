/** /api/production — orders, required-tooling gate, take/return, batches (spec §18, §30, §31). */
import express from 'express';
import db from '../db/index.js';
import { asyncRoute, badRequest, notFound, conflict } from '../lib/errors.js';
import { validate, str, num, bool, oneOf, idRef, idList, escapeLike } from '../lib/validate.js';
import { requirePermission } from '../middleware/index.js';
import { checkReadiness, autoAssignTooling, createOrder, completeOrder, receiveFinishedGoods } from '../services/availability.js';
import { performMovement, reserveTooling, releaseReservation } from '../services/movement.js';
import { listResult, orderBy, requireId } from './_helpers.js';
import { audit } from '../services/audit.js';
import { qrSvg } from '../services/labels.js';
import { refreshReservedQty } from '../services/tooling.js';

const router = express.Router();

const ORDER_STATUSES = ['DRAFT', 'PLANNED', 'READY', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED'];

export const ORDER_SELECT = `
  SELECT o.*, f.internal_number AS filter_number, f.name AS filter_name, ft.name AS filter_type, ft.icon AS filter_icon,
         u.full_name AS created_by_name,
         (SELECT COUNT(*) FROM production_order_tools pt WHERE pt.production_order_id = o.id) AS tool_rows,
         (SELECT COUNT(*) FROM production_order_tools pt WHERE pt.production_order_id = o.id AND pt.status = 'RETURNED') AS tools_returned,
         (SELECT COUNT(*) FROM production_order_tools pt WHERE pt.production_order_id = o.id AND pt.status = 'TAKEN') AS tools_taken,
         (SELECT COUNT(*) FROM production_order_tools pt WHERE pt.production_order_id = o.id AND pt.status = 'PENDING') AS tools_pending,
         (SELECT COUNT(*) FROM production_batches b WHERE b.production_order_id = o.id) AS batch_count
  FROM production_orders o
  JOIN filters f ON f.id = o.filter_id
  JOIN filter_types ft ON ft.id = f.filter_type_id
  LEFT JOIN users u ON u.id = o.created_by
`;

/** Readiness for an order, including per-tool storage location so the phone can show "go here". */
async function orderView(id, { unit = 'mm' } = {}) {
  const order = await db.one(`${ORDER_SELECT} WHERE o.id = ?`, [Number(id)]);
  if (!order) throw notFound('Production order not found');
  const tools = await db.all(
    `SELECT pt.*, t.tooling_id, t.name, t.status AS tool_status, t.quantity, t.condition_rating, t.serial_number, t.total_cycles, t.max_cycles,
            t.location_id, t.external_location, t.reserved_qty, t.cycle_warning_pct,
            tt.code AS type_code, tt.name AS type_name, tt.icon,
            l.full_code AS location_code, l.label_path AS location_path, l.id AS location_pk,
            (SELECT im.id FROM tooling_images im WHERE im.owner_type='TOOLING' AND im.owner_id = t.id ORDER BY im.is_primary DESC LIMIT 1) AS primary_image_id,
            d.overall_length_mm, d.overall_width_mm, d.overall_height_mm
     FROM production_order_tools pt
     JOIN tooling_items t ON t.id = pt.tooling_item_id
     JOIN tooling_types tt ON tt.id = t.tooling_type_id
     LEFT JOIN tooling_locations l ON l.id = t.location_id
     LEFT JOIN tooling_dimensions d ON d.tooling_item_id = t.id
     WHERE pt.production_order_id = ?
     ORDER BY tt.sort_order, t.tooling_id`,
    [order.id],
  );
  const readiness = await checkReadiness({ production_order_id: order.id }, { record: false });
  const history = await db.all(
    `SELECT h.*, u.username FROM production_history h LEFT JOIN users u ON u.id = h.user_id WHERE h.production_order_id = ? ORDER BY h.created_at DESC LIMIT 60`,
    [order.id],
  );
  const batches = await db.all(
    `SELECT b.*, u.full_name AS operator_name FROM production_batches b LEFT JOIN users u ON u.id = b.operator_id WHERE b.production_order_id = ? ORDER BY b.id DESC LIMIT 30`,
    [order.id],
  );
  const missingRequired = readiness.tooling.filter((t) => t.state !== 'OK');
  return {
    order: {
      ...order,
      quantity_remaining: Math.max(0, Number(order.quantity_ordered) - Number(order.quantity_produced)),
      progress_pct: Number(order.quantity_ordered) > 0 ? Math.round((Number(order.quantity_produced) / Number(order.quantity_ordered)) * 100) : 0,
    },
    tools: tools.map((t) => ({
      ...t,
      dimensions_mm: { length: t.overall_length_mm ? Number(t.overall_length_mm) : null, width: t.overall_width_mm ? Number(t.overall_width_mm) : null, height: t.overall_height_mm ? Number(t.overall_height_mm) : null },
      overall_length_mm: undefined,
      overall_width_mm: undefined,
      overall_height_mm: undefined,
    })),
    readiness,
    missing_required: missingRequired,
    history,
    batches,
    unit,
  };
}

/* ------------------------------------------------------------------ list */
router.get(
  '/',
  requirePermission('*.read'),
  asyncRoute(async (req, res) => {
    const q = req.query;
    const { page, size, offset, orderSql } = orderBy(
      q,
      ['po_number', 'status', 'planned_start_at', 'planned_end_at', 'priority', 'quantity_ordered', 'created_at', 'availability_status'],
      'planned_start_at',
      'desc',
    );
    const where = ['1=1'];
    const params = [];
    if (q.status) {
      const list = String(q.status).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      where.push(`o.status IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
    if (q.availability === 'blocked') where.push("o.availability_status = 'NOT_READY' AND o.status IN ('PLANNED','READY','IN_PROGRESS')");
    if (q.availability === 'ready') where.push("o.availability_status = 'READY' AND o.status IN ('PLANNED','READY')");
    if (q.availability === 'unchecked') where.push("o.availability_status = 'UNKNOWN'");
    if (q.filter_id) {
      where.push('o.filter_id = ?');
      params.push(Number(q.filter_id));
    }
    if (q.open === '1') where.push("o.status NOT IN ('COMPLETED','CANCELLED')");
    if (q.q) {
      const like = `%${escapeLike(q.q)}%`;
      where.push('(o.po_number LIKE ? OR f.internal_number LIKE ? OR o.customer_ref LIKE ? OR o.machine LIKE ? OR o.line LIKE ? OR o.notes LIKE ?)');
      params.push(like, like, like, like, like, like);
    }
    if (q.from) {
      where.push('DATE(o.planned_start_at) >= ?');
      params.push(String(q.from).slice(0, 10));
    }
    if (q.to) {
      where.push('DATE(o.planned_start_at) <= ?');
      params.push(String(q.to).slice(0, 10));
    }
    if (q.priority) {
      where.push('o.priority = ?');
      params.push(String(q.priority).toUpperCase());
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = await db.value(
      `SELECT COUNT(*) c FROM production_orders o JOIN filters f ON f.id = o.filter_id ${whereSql}`,
      params,
    );
    const items = await db.all(`${ORDER_SELECT} ${whereSql} ${orderSql} LIMIT ? OFFSET ?`, [...params, size, offset]);
    res.json(listResult({ items, total: Number(total), page, size }));
  }),
);

router.get('/board', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const columns = ['PLANNED', 'READY', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED'].map(async (status) => ({
    status,
    items: await db.all(
      `SELECT o.id, o.po_number, o.priority, o.status, o.quantity_ordered, o.quantity_produced, o.availability_status, o.blocking_reason,
              o.planned_start_at, o.line, o.machine, f.internal_number AS filter_number, f.name AS filter_name, ft.icon AS filter_icon,
              (SELECT COUNT(*) FROM production_order_tools pt WHERE pt.production_order_id = o.id AND pt.status='TAKEN') AS tools_out
       FROM production_orders o JOIN filters f ON f.id = o.filter_id JOIN filter_types ft ON ft.id = f.filter_type_id
       WHERE o.status = ? ORDER BY FIELD(o.priority,'URGENT','HIGH','NORMAL','LOW'), o.planned_start_at LIMIT 30`,
      [status],
    ),
  }));
  const [cols, blocked, dueToday] = await Promise.all([
    Promise.all(columns),
    db.all(
      `SELECT o.id, o.po_number, o.blocking_reason, f.internal_number AS filter_number, o.planned_start_at
       FROM production_orders o JOIN filters f ON f.id = o.filter_id
       WHERE o.availability_status = 'NOT_READY' AND o.status IN ('PLANNED','READY','IN_PROGRESS')
       ORDER BY o.planned_start_at LIMIT 25`,
    ),
    db.value(
      `SELECT COUNT(*) c FROM production_orders WHERE status NOT IN ('COMPLETED','CANCELLED') AND DATE(planned_start_at) <= CURDATE()`,
    ),
  ]);
  res.json({ columns: cols, blocked, late_count: Number(dueToday ?? 0) });
}));

/* ------------------------------------------------------------- create */
const ORDER_SCHEMA = {
  po_number: [str, { max: 60, upper: true }],
  filter_id: [idRef, { required: true }],
  quantity_ordered: [num, { int: true, min: 1, max: 10000000, required: true }],
  priority: oneOf(['URGENT', 'HIGH', 'NORMAL', 'LOW']),
  line: [str, { max: 80 }],
  machine: [str, { max: 120 }],
  planned_start_at: [str, { max: 30 }],
  planned_end_at: [str, { max: 30 }],
  customer_ref: [str, { max: 120 }],
  notes: [str, { max: 4000 }],
  status: oneOf(ORDER_STATUSES),
  tooling_item_ids: [idList, {}],
};
router.post('/', requirePermission('production.update'), asyncRoute(async (req, res) => {
  const data = validate(ORDER_SCHEMA, req.body);
  const order = await createOrder(
    {
      po_number: data.po_number,
      filter_id: data.filter_id,
      quantity_ordered: data.quantity_ordered,
      priority: data.priority,
      line: data.line,
      machine: data.machine,
      planned_start_at: data.planned_start_at,
      planned_end_at: data.planned_end_at,
      notes: data.notes,
      status: data.status,
    },
    req.ctx,
  );
  if (data.tooling_item_ids?.length) {
    for (const t of data.tooling_item_ids) {
      await db.run(
        `INSERT INTO production_order_tools (production_order_id, tooling_item_id, is_required, qty, status) VALUES (?,?,1,1,'PENDING')
         ON DUPLICATE KEY UPDATE is_required = 1`,
        [order.id, t],
      );
    }
  }
  const readiness = await checkReadiness({ production_order_id: order.id }, { record: true });
  res.status(201).json({ ...(await orderView(order.id)), readiness });
}));

/* --------------------------------------------------------------- detail */
router.get('/:id', requirePermission('*.read'), asyncRoute(async (req, res) => res.json(await orderView(req.params.id, { unit: req.query.unit || 'mm' }))));

router.put('/:id', requirePermission('production.update'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'order id');
  const order = await db.one('SELECT * FROM production_orders WHERE id = ?', [id]);
  if (!order) throw notFound('Production order not found');
  const data = validate(
    {
      quantity_ordered: [num, { int: true, min: 1, max: 10000000 }],
      priority: oneOf(['URGENT', 'HIGH', 'NORMAL', 'LOW']),
      line: [str, { max: 80 }],
      machine: [str, { max: 120 }],
      planned_start_at: [str, { max: 30 }],
      planned_end_at: [str, { max: 30 }],
      customer_ref: [str, { max: 120 }],
      notes: [str, { max: 4000 }],
      status: oneOf(ORDER_STATUSES),
    },
    req.body,
    { partial: true },
  );
  const keys = Object.keys(data);
  if (!keys.length) throw badRequest('Nothing to update');
  await db.run(`UPDATE production_orders SET ${keys.map((k) => `\`${k}\`=?`).join(',')}, updated_at = NOW() WHERE id = ?`, [...keys.map((k) => data[k]), id]);
  await db.run(
    `INSERT INTO production_history (production_order_id, filter_id, event_type, quantity, note, user_id) VALUES (?,?,?,?,?,?)`,
    [id, order.filter_id, 'UPDATED', order.quantity_ordered, `Updated: ${keys.join(', ')}`, req.user.id],
  );
  await audit(req.ctx, { action: 'update', entityType: 'production_order', entityId: id, entityLabel: order.po_number, summary: `Order updated: ${keys.join(', ')}` });
  if (data.status === 'CANCELLED') {
    // releasing reservations keeps other plans honest
    await releaseReservation({ production_order_id: id, note: `Order ${order.po_number} cancelled`, ctx: req.ctx });
    await refreshReservedQty();
  }
  res.json(await orderView(id));
}));

router.delete('/:id', requirePermission('production.update'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'order id');
  const order = await db.one('SELECT * FROM production_orders WHERE id = ?', [id]);
  if (!order) throw notFound('Production order not found');
  if (['IN_PROGRESS', 'COMPLETED'].includes(order.status)) throw conflict('Started or completed orders cannot be deleted - cancel them instead');
  await db.tx(async (exec) => {
    await exec.run("DELETE FROM tooling_reservations WHERE production_order_id = ? AND status = 'ACTIVE'", [id]);
    await exec.run('DELETE FROM production_order_tools WHERE production_order_id = ?', [id]);
    await exec.run('DELETE FROM production_history WHERE production_order_id = ?', [id]);
    await exec.run('DELETE FROM production_orders WHERE id = ?', [id]);
  });
  await refreshReservedQty();
  await audit(req.ctx, { action: 'delete', entityType: 'production_order', entityId: id, entityLabel: order.po_number, summary: `Order ${order.po_number} deleted` });
  res.json({ ok: true });
}));

/* ------------------------------------------------------- availability */
router.get(
  '/:id/availability',
  requirePermission('*.read'),
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, 'order id');
    const order = await db.one('SELECT * FROM production_orders WHERE id = ?', [id]);
    if (!order) throw notFound('Production order not found');
    const readiness = await checkReadiness({ production_order_id: id, qty: req.query.qty ? Number(req.query.qty) : null }, { record: req.query.record === '1' });
    res.json({
      order_id: order.id,
      po_number: order.po_number,
      filter_id: order.filter_id,
      quantity_ordered: Number(order.quantity_ordered),
      quantity_remaining: Math.max(0, Number(order.quantity_ordered) - Number(order.quantity_produced ?? 0)),
      ...readiness,
    });
  }),
);

router.post('/:id/check-readiness', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'order id');
  res.json(await checkReadiness({ production_order_id: id }, { record: req.query.record !== '0' }));
}));

router.post('/check-readiness', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const data = validate({ filter_id: [idRef, { required: true }], quantity: [num, { int: true, min: 1 }] }, req.body);
  res.json(await checkReadiness({ filter_id: data.filter_id, qty: data.quantity ?? null }, { record: false }));
}));

router.post('/:id/auto-assign', requirePermission('production.update'), asyncRoute(async (req, res) => {
  const out = await autoAssignTooling(requireId(req.params.id, 'order id'), { overwrite: req.body?.overwrite === true });
  await checkReadiness({ production_order_id: Number(req.params.id) }, { record: true });
  res.json(out);
}));

/* ------------------------------------------------- explicit tool linking */
router.post('/:id/tools', requirePermission('production.update'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'order id');
  const data = validate({ tooling_item_ids: [idList, { required: true }], required: [bool, { default: true }], qty: [num, { int: true, min: 1, max: 100 }] }, req.body);
  let added = 0;
  for (const t of data.tooling_item_ids) {
    const tool = await db.one('SELECT id, tooling_id, deleted_at FROM tooling_items WHERE id = ?', [t]);
    if (!tool) throw badRequest(`Tooling #${t} does not exist`);
    if (tool.deleted_at) throw conflict(`${tool.tooling_id} is archived - restore it before assigning it`);
    await db.run(
      `INSERT INTO production_order_tools (production_order_id, tooling_item_id, is_required, qty, status) VALUES (?,?,?,?, 'PENDING')
       ON DUPLICATE KEY UPDATE is_required = VALUES(is_required), qty = VALUES(qty)`,
      [id, tool.id, data.required ? 1 : 0, data.qty ?? 1],
    );
    added += 1;
  }
  await audit(req.ctx, { action: 'assign', entityType: 'production_order', entityId: id, summary: `${added} tooling item(s) assigned to order` });
  await checkReadiness({ production_order_id: id }, { record: true });
  res.json({ ok: true, added });
}));

router.delete('/:id/tools/:toolPk', requirePermission('production.update'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'order id');
  const toolPk = requireId(req.params.toolPk, 'tooling id');
  const row = await db.one('SELECT * FROM production_order_tools WHERE production_order_id = ? AND tooling_item_id = ?', [id, toolPk]);
  if (!row) throw notFound('That tool is not assigned to this order');
  if (row.status === 'TAKEN') throw conflict(`${row.status} tools must be returned before unassigning`);
  await db.run('DELETE FROM production_order_tools WHERE id = ?', [row.id]);
  await checkReadiness({ production_order_id: id }, { record: true });
  res.json({ ok: true });
}));

/* ---------------------------------------------------- take / return flow */
router.post('/:id/take', requirePermission('tooling.move'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'order id');
  const order = await db.one('SELECT * FROM production_orders WHERE id = ?', [id]);
  if (!order) throw notFound('Production order not found');
  const data = validate({ tooling_item_ids: [idList, {}], note: [str, { max: 400 }] }, req.body);
  const readiness = await checkReadiness({ production_order_id: id }, { record: true });
  const targets = data.tooling_item_ids.length
    ? data.tooling_item_ids
    : (await db.all("SELECT tooling_item_id FROM production_order_tools WHERE production_order_id = ? AND status = 'PENDING'", [id])).map((r) => r.tooling_item_id);
  if (!targets.length) throw badRequest('No pending tooling to take - assign tooling to the order first');
  const taken = [];
  const refused = [];
  for (const t of targets) {
    const row = await db.one('SELECT * FROM production_order_tools WHERE production_order_id = ? AND tooling_item_id = ?', [id, t]);
    if (!row) {
      refused.push({ tooling_item_id: Number(t), reason: 'not assigned to this order' });
      continue;
    }
    if (row.status === 'TAKEN') {
      refused.push({ tooling_item_id: Number(t), reason: 'already taken for this order' });
      continue;
    }
    if (!readiness.ready) {
      const bad = readiness.tooling
        .flatMap((x) => x.options)
        .find((o) => o.tooling_item_id === Number(t) && !o.usable);
      if (bad) {
        refused.push({ tooling_item_id: Number(t), reason: bad.issues.find((i) => i.severity === 'BLOCK')?.message ?? 'tooling blocked' });
        continue;
      }
    }
    try {
      await performMovement({ tooling: Number(t), action: 'TAKE', production_order_id: id, qty: row.qty ?? 1, note: data.note ?? `Taken for ${order.po_number}`, ctx: req.ctx });
      await db.run("UPDATE production_order_tools SET status='TAKEN', taken_at = NOW() WHERE id = ?", [row.id]);
      taken.push(Number(t));
    } catch (err) {
      refused.push({ tooling_item_id: Number(t), reason: err.message });
    }
  }
  if (order.status === 'PLANNED' || order.status === 'READY') {
    await db.run("UPDATE production_orders SET status = 'IN_PROGRESS', started_at = COALESCE(started_at, NOW()), updated_at = NOW() WHERE id = ?", [id]);
    await db.run('INSERT INTO production_history (production_order_id, filter_id, event_type, quantity, note, user_id) VALUES (?,?,?,?,?,?)', [id, order.filter_id, 'STARTED', order.quantity_ordered, `Tooling taken (${taken.length} item(s))`, req.user.id]);
  }
  await refreshReservedQty();
  await checkReadiness({ production_order_id: id }, { record: true });
  res.json({ ok: taken.length > 0, taken, refused, order_id: id });
}));

router.post('/:id/return', requirePermission('tooling.move'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'order id');
  const order = await db.one('SELECT * FROM production_orders WHERE id = ?', [id]);
  if (!order) throw notFound('Production order not found');
  const data = validate({ tooling_item_ids: [idList, {}], location: [str, { max: 200 }], cycles: [num, { int: true, min: 0 }], produced_qty: [num, { int: true, min: 0 }], note: [str, { max: 400 }] }, req.body);
  const rows = data.tooling_item_ids.length
    ? await db.all(`SELECT * FROM production_order_tools WHERE production_order_id = ? AND tooling_item_id IN (${data.tooling_item_ids.map(() => '?').join(',')})`, [id, ...data.tooling_item_ids])
    : await db.all("SELECT * FROM production_order_tools WHERE production_order_id = ? AND status = 'TAKEN'", [id]);
  if (!rows.length) throw badRequest('Nothing to return for this order');
  const returned = [];
  const problems = [];
  for (const row of rows) {
    const cycles = Number(data.cycles ?? row.cycle_count ?? 1) || 1;
    try {
      await performMovement({ tooling: row.tooling_item_id, action: 'RETURN', location: data.location ?? null, production_order_id: id, qty: row.qty ?? 1, note: data.note ?? `Returned from ${order.po_number}`, ctx: req.ctx });
      await db.run("UPDATE production_order_tools SET status='RETURNED', returned_at = NOW(), cycle_count = cycle_count + ?, produced_qty = ? WHERE id = ?", [cycles, data.produced_qty ?? row.produced_qty ?? 0, row.id]);
      await db.run(
        `INSERT INTO tooling_usage_history (tooling_item_id, production_order_id, filter_id, event_type, cycles, quantity, produced_qty, operator_id, operator_name, note)
         VALUES (?,?,?, 'USAGE', ?,?,?,?, ?, ?)`,
        [row.tooling_item_id, id, order.filter_id, cycles, data.produced_qty ?? 0, data.produced_qty ?? 0, req.user.id, req.user.full_name, `Return of ${order.po_number}`],
      );
      await db.run('UPDATE tooling_items SET total_cycles = total_cycles + ?, total_parts_produced = total_parts_produced + ?, last_used_at = NOW() WHERE id = ?', [cycles, data.produced_qty ?? 0, row.tooling_item_id]);
      returned.push(row.tooling_item_id);
    } catch (err) {
      problems.push({ tooling_item_id: row.tooling_item_id, reason: err.message });
    }
  }
  await refreshReservedQty();
  await db.run('INSERT INTO production_history (production_order_id, filter_id, event_type, quantity, note, user_id) VALUES (?,?,?,?,?,?)', [id, order.filter_id, 'TOOLING_RETURNED', returned.length, `Returned ${returned.length} item(s)`, req.user.id]);
  await checkReadiness({ production_order_id: id }, { record: true });
  res.json({ ok: returned.length > 0, returned, problems, all_returned: (await db.value("SELECT COUNT(*) c FROM production_order_tools WHERE production_order_id = ? AND status='TAKEN'", [id])) === 0 });
}));

router.post('/:id/reserve', requirePermission('production.update'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'order id');
  const data = validate({ tooling_item_ids: [idList, { required: true }], note: [str, { max: 400 }] }, req.body);
  const order = await db.one('SELECT * FROM production_orders WHERE id = ?', [id]);
  if (!order) throw notFound('Production order not found');
  const results = [];
  for (const t of data.tooling_item_ids) {
    try {
      const out = await reserveTooling({ tooling: Number(t), production_order_id: id, qty: 1, planned_start_at: order.planned_start_at, planned_end_at: order.planned_end_at, note: data.note ?? `Reserved for ${order.po_number}`, ctx: req.ctx });
      results.push({ tooling_item_id: Number(t), ok: true, ...out });
    } catch (err) {
      results.push({ tooling_item_id: Number(t), ok: false, error: err.message });
    }
  }
  await refreshReservedQty();
  await checkReadiness({ production_order_id: id }, { record: true });
  const refused = results.filter((r) => !r.ok);
  if (refused.length === results.length) {
    throw conflict(`${order.po_number} cannot reserve ${refused.map((r) => `#${r.tooling_item_id}`).join(', ')}: ${refused[0].error}`);
  }
  res.json({ order_id: id, results, all_ok: !refused.length, refused: refused.length });
}));

router.post('/:id/release', requirePermission('production.update'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'order id');
  const data = validate({ tooling_item_ids: [idList, {}], note: [str, { max: 400 }] }, req.body);
  const targets = data.tooling_item_ids.length ? data.tooling_item_ids : (await db.all("SELECT tooling_item_id FROM tooling_reservations WHERE production_order_id = ? AND status='ACTIVE'", [id])).map((r) => r.tooling_item_id);
  let released = 0;
  for (const t of targets) {
    try {
      await releaseReservation({ tooling: Number(t), production_order_id: id, note: data.note ?? null, ctx: req.ctx });
      released += 1;
    } catch {
      /* nothing active for that pair */
    }
  }
  await refreshReservedQty();
  await checkReadiness({ production_order_id: id }, { record: true });
  res.json({ ok: true, released });
}));

/* --------------------------------------------------------- complete */
router.post('/:id/start', requirePermission('production.update'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'order id');
  const order = await db.one('SELECT * FROM production_orders WHERE id = ?', [id]);
  if (!order) throw notFound('Production order not found');
  const readiness = await checkReadiness({ production_order_id: id }, { record: true });
  if (!readiness.ready && req.body?.force !== true) {
    throw conflict(`Production is blocked: ${readiness.blockers.map((b) => b.message).join('; ')}`, { blockers: readiness.blockers, hint: 'Resolve the flagged tooling, or send force:true with a reason if you know why' });
  }
  await db.run("UPDATE production_orders SET status='IN_PROGRESS', started_at = COALESCE(started_at, NOW()), updated_at = NOW() WHERE id = ?", [id]);
  await db.run('INSERT INTO production_history (production_order_id, filter_id, event_type, quantity, note, user_id) VALUES (?,?,?,?,?,?)', [
    id,
    order.filter_id,
    'STARTED',
    order.quantity_ordered,
    readiness.ready ? 'Started - all tooling available' : `Force-started: ${readiness.blockers.map((b) => b.message).join('; ')}`.slice(0, 380),
    req.user.id,
  ]);
  await audit(req.ctx, { action: 'start', entityType: 'production_order', entityId: id, entityLabel: order.po_number, summary: readiness.ready ? 'Production started' : 'Production force-started with blockers' });
  res.json(await orderView(id));
}));

router.post('/:id/complete', requirePermission('production.update'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'order id');
  const data = validate({ produced_qty: [num, { int: true, min: 0, max: 10000000 }], note: [str, { max: 400 }], receive_to_stock: [bool, { default: false }] }, req.body);
  const out = await completeOrder(id, { produced_qty: data.produced_qty, note: data.note, ctx: req.ctx });
  const received = data.receive_to_stock ? await receiveFinishedGoods(id, { quantity: data.produced_qty, note: data.note, ctx: req.ctx }) : null;
  await checkReadiness({ production_order_id: id }, { record: true });
  res.json({ ...out, received, order: await db.one('SELECT * FROM production_orders WHERE id = ?', [id]) });
}));

router.post('/:id/receive', requirePermission('inventory.update'), asyncRoute(async (req, res) => {
  const data = validate({ quantity: [num, { int: true, min: 1, max: 10000000 }], note: [str, { max: 400 }] }, req.body);
  res.json(await receiveFinishedGoods(requireId(req.params.id, 'order id'), { quantity: data.quantity, note: data.note, ctx: req.ctx }));
}));

/* ------------------------------------------------------------- batches */
router.get('/:id/batches', requirePermission('*.read'), asyncRoute(async (req, res) => {
  res.json({
    items: await db.all(
      `SELECT b.*, u.full_name AS operator_name FROM production_batches b LEFT JOIN users u ON u.id = b.operator_id
       WHERE b.production_order_id = ? ORDER BY b.id DESC`,
      [requireId(req.params.id, 'order id')],
    ),
  });
}));

router.post('/:id/batches', requirePermission('production.update'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'order id');
  const order = await db.one('SELECT * FROM production_orders WHERE id = ?', [id]);
  if (!order) throw notFound('Production order not found');
  const data = validate({ quantity: [num, { int: true, min: 1, required: true }], good_qty: [num, { int: true, min: 0 }], scrap_qty: [num, { int: true, min: 0 }], notes: [str, { max: 400 }], started_at: [str, { max: 30 }] }, req.body);
  const good = data.good_qty ?? data.quantity;
  const batchNo = `B-${order.po_number.replace(/[^A-Z0-9]/gi, '').slice(-8)}-${String(Number(await db.value('SELECT COUNT(*) c FROM production_batches WHERE production_order_id = ?', [id])) + 1).padStart(3, '0')}`;
  const r = await db.run(
    `INSERT INTO production_batches (batch_number, production_order_id, filter_id, quantity, good_qty, scrap_qty, started_at, completed_at, operator_id, notes)
     VALUES (?,?,?,?,?,?,?,NOW(),?,?)`,
    [batchNo, id, order.filter_id, data.quantity, good, data.scrap_qty ?? 0, data.started_at ?? null, req.user.id, data.notes ?? null],
  );
  const batchId = r.insertId ?? (await db.value('SELECT id FROM production_batches WHERE batch_number = ?', [batchNo]));
  await db.run('UPDATE production_orders SET quantity_produced = quantity_produced + ?, status = IF(status = "PLANNED" OR status = "READY", "IN_PROGRESS", status), updated_at = NOW() WHERE id = ?', [data.quantity, id]);
  await db.run('INSERT INTO production_history (production_order_id, filter_id, event_type, quantity, note, user_id) VALUES (?,?,?,?,?,?)', [id, order.filter_id, 'BATCH', data.quantity, `Batch ${batchNo} recorded`, req.user.id]);
  await audit(req.ctx, { action: 'create', entityType: 'production_batch', entityId: batchId, entityLabel: batchNo, summary: `Batch ${batchNo}: ${data.quantity} pcs (${good} good / ${data.scrap_qty ?? 0} scrap)` });
  res.status(201).json(await db.one('SELECT * FROM production_batches WHERE id = ?', [batchId]));
}));

/* -------------------------------------------------------------- labels */
router.get('/:id/qr', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const order = await db.one('SELECT po_number FROM production_orders WHERE id = ?', [requireId(req.params.id, 'order id')]);
  if (!order) throw notFound('Production order not found');
  res.type('image/svg+xml').send(await qrSvg(`SP:P:${order.po_number}`, { width: Number(req.query.width || 220) }));
}));

export default router;
