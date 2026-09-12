/**
 * Availability gate (spec §30, §31) + production order helpers.
 * The same engine backs the production order screen, the filter overview and the alerts.
 */
import db from '../db/index.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';
import { audit } from './audit.js';

/**
 * @param {object} target { production_order_id } | { filter_id, tooling_ids? }
 */
export async function checkReadiness({ production_order_id = null, filter_id = null, qty = null }, { record = true } = {}) {
  const exec = await db.rawDriver.executor();
  let orderId = null;
  let order = null;
  let filterId = filter_id ? Number(filter_id) : null;
  let requiredQty = qty ? Number(qty) : null;

  if (production_order_id) {
    order = await exec.one(
      `SELECT po.*, f.internal_number, f.name AS filter_name, ft.name AS filter_type
       FROM production_orders po JOIN filters f ON f.id = po.filter_id JOIN filter_types ft ON ft.id = f.filter_type_id
       WHERE po.id = ?`,
      [Number(production_order_id)],
    );
    if (!order) throw notFound('Production order not found');
    orderId = order.id;
    filterId = order.filter_id;
    requiredQty = requiredQty ?? Number(order.quantity_ordered);
  }
  if (!filterId) throw badRequest('Provide filter_id or production_order_id');

  const requirements = await exec.all(
    `SELECT r.id, r.quantity_required, r.is_mandatory, r.note, t.id AS tooling_type_id, t.code, t.name, t.icon, t.requires_maintenance
     FROM filter_tooling_requirements r JOIN tooling_types t ON t.id = r.tooling_type_id
     WHERE r.filter_id = ? ORDER BY t.sort_order`,
    [filterId],
  );
  const linked = await exec.all(
    `SELECT ti.id, ti.tooling_id, ti.name, ti.status, ti.quantity, ti.condition_rating, ti.max_cycles, ti.total_cycles,
             ti.next_maintenance_date, ti.location_id, ti.external_location, ti.reserved_qty, ti.cycle_warning_pct, ti.maintenance_interval_cycles,
             tt.code AS type_code, tt.name AS type_name, ti.notes,
             tl.full_code AS location_code, tl.label_path AS location_path,
             (SELECT po2.po_number FROM tooling_reservations r2 JOIN production_orders po2 ON po2.id = r2.production_order_id
               WHERE r2.tooling_item_id = ti.id AND r2.status = 'ACTIVE' ORDER BY r2.id LIMIT 1) AS reserved_for_order,
             (SELECT r3.production_order_id FROM tooling_reservations r3 WHERE r3.tooling_item_id = ti.id AND r3.status = 'ACTIVE' ORDER BY r3.id LIMIT 1) AS reserved_for_id
     FROM tooling_compatibility tc
     JOIN tooling_items ti ON ti.id = tc.tooling_item_id AND ti.deleted_at IS NULL
     JOIN tooling_types tt ON tt.id = ti.tooling_type_id
     LEFT JOIN tooling_locations tl ON tl.id = ti.location_id
     WHERE tc.filter_id = ?
     ORDER BY ti.tooling_id`,
    [filterId],
  );

  const tools = [];
  const blockers = [];
  for (const req of requirements) {
    const candidates = linked.filter((t) => t.type_code === req.code);
    const usable = [];
    for (const t of candidates) {
      const issues = [];
      const isForThisOrder = t.reserved_for_id === null || (orderId !== null && Number(t.reserved_for_id) === Number(orderId));
      if (t.status === 'DAMAGED') issues.push({ code: 'DAMAGED', message: `${t.tooling_id} is flagged damaged`, severity: 'BLOCK' });
      if (t.status === 'MISSING') issues.push({ code: 'MISSING', message: `${t.tooling_id} is recorded as missing`, severity: 'BLOCK' });
      if (t.status === 'RETIRED') issues.push({ code: 'RETIRED', message: `${t.tooling_id} is retired`, severity: 'BLOCK' });
      if (t.status === 'MAINTENANCE') issues.push({ code: 'MAINTENANCE', message: `${t.tooling_id} is under maintenance${t.next_maintenance_date ? ` (since ${t.next_maintenance_date})` : ''}`, severity: 'BLOCK' });
      if (t.status === 'IN_USE' && !orderId) issues.push({ code: 'IN_USE', message: `${t.tooling_id} is currently in use on a machine`, severity: 'WARN' });
      if (t.status === 'IN_USE' && orderId) issues.push({ code: 'IN_USE_OTHER', message: `${t.tooling_id} is still in use${t.external_location ? ` at ${t.external_location}` : ''}`, severity: 'WARN' });
      if (!isForThisOrder) issues.push({ code: 'RESERVED_ELSEWHERE', message: `${t.tooling_id} is reserved for ${t.reserved_for_order}`, severity: 'BLOCK' });
      if (t.max_cycles !== null && Number(t.total_cycles) >= Number(t.max_cycles)) {
        issues.push({ code: 'CYCLE_LIMIT', message: `${t.tooling_id} exceeded its recommended ${t.max_cycles} cycles (${t.total_cycles})`, severity: 'WARN' });
      }
      if (t.next_maintenance_date && new Date(t.next_maintenance_date).getTime() < Date.now() && t.status !== 'MAINTENANCE') {
        issues.push({ code: 'MAINTENANCE_OVERDUE', message: `${t.tooling_id} has overdue maintenance (${t.next_maintenance_date})`, severity: 'WARN' });
      }
      if (t.condition_rating === 'CRITICAL' || t.condition_rating === 'POOR') {
        issues.push({ code: 'CONDITION', message: `${t.tooling_id} condition is ${t.condition_rating}`, severity: t.condition_rating === 'CRITICAL' ? 'BLOCK' : 'WARN' });
      }
      if (!t.location_id && !t.external_location && t.status === 'AVAILABLE') {
        issues.push({ code: 'NO_LOCATION', message: `${t.tooling_id} has no recorded storage location`, severity: 'WARN' });
      }
      const blocking = issues.filter((i) => i.severity === 'BLOCK');
      usable.push({ tool: t, issues, blocked: blocking.length > 0 });
    }
    const available = usable.filter((u) => !u.blocked);
    const satisfied = available.length >= Number(req.quantity_required);
    if (!satisfied && req.is_mandatory) {
      const firstBlocked = usable.find((u) => u.blocked);
      blockers.push({
        type: candidates.length === 0 ? 'MISSING_TOOLING' : 'UNAVAILABLE_TOOLING',
        tooling_type: req.name,
        message:
          candidates.length === 0
            ? `No ${req.name} is linked to this filter`
            : firstBlocked
              ? firstBlocked.issues.find((i) => i.severity === 'BLOCK')?.message ?? `${req.name} not available`
              : `Not enough copies of ${req.name}`,
        tooling_id: firstBlocked?.tool.tooling_id ?? null,
        tooling_pk: firstBlocked?.tool.id ?? null,
      });
    }
    tools.push({
      requirement_id: req.id,
      tooling_type_id: req.tooling_type_id,
      type_code: req.code,
      type_name: req.name,
      icon: req.icon,
      quantity_required: Number(req.quantity_required),
      is_mandatory: !!req.is_mandatory,
      note: req.note,
      state: candidates.length === 0 ? 'MISSING' : satisfied ? 'OK' : 'NOT_AVAILABLE',
      options: usable.map((u) => ({
        tooling_item_id: u.tool.id,
        tooling_id: u.tool.tooling_id,
        name: u.tool.name,
        status: u.tool.status,
        condition: u.tool.condition_rating,
        quantity: Number(u.tool.quantity ?? 1),
        location: u.tool.location_code ?? u.tool.external_location ?? null,
        location_path: u.tool.location_path ?? null,
        cycles: u.tool.max_cycles === null ? null : { total: Number(u.tool.total_cycles), max: Number(u.tool.max_cycles) },
        reserved_for: u.tool.reserved_for_order ?? null,
        usable: !u.blocked,
        issues: u.issues,
      })),
    });
  }

  const result = {
    production_order_id: orderId,
    po_number: order?.po_number ?? null,
    filter_id: filterId,
    filter_number: order?.internal_number ?? null,
    quantity: requiredQty,
    ready: blockers.length === 0 && tools.length > 0,
    status: blockers.length === 0 ? (tools.length ? 'READY' : 'NO_REQUIREMENTS') : 'NOT_READY',
    blockers,
    warnings: tools.flatMap((t) => t.options.flatMap((o) => o.issues.filter((i) => i.severity === 'WARN').map((i) => ({ ...i, tooling_id: o.tooling_id })))),
    tooling: tools,
    checked_at: new Date().toISOString(),
  };

  if (record && orderId) {
    await exec.run('UPDATE production_orders SET availability_status = ?, availability_checked_at = NOW(), blocking_reason = ?, updated_at = NOW() WHERE id = ?', [
      result.ready ? 'READY' : 'NOT_READY',
      result.ready ? null : result.blockers.map((b) => b.message).join('; ').slice(0, 400),
      orderId,
    ]);
  }
  return result;
}

/** Auto-attach the tooling that is compatible with the order's filter. */
export async function autoAssignTooling(orderId, { overwrite = false } = {}) {
  const exec = await db.rawDriver.executor();
  const order = await exec.one('SELECT * FROM production_orders WHERE id = ?', [Number(orderId)]);
  if (!order) throw notFound('Production order not found');
  const linked = await exec.all(
    `SELECT DISTINCT ti.id, tt.id AS tooling_type_id, r.quantity_required
     FROM tooling_compatibility tc
     JOIN tooling_items ti ON ti.id = tc.tooling_item_id AND ti.deleted_at IS NULL
     JOIN tooling_types tt ON tt.id = ti.tooling_type_id
     LEFT JOIN filter_tooling_requirements r ON r.filter_id = tc.filter_id AND r.tooling_type_id = ti.tooling_type_id
     WHERE tc.filter_id = ?
     ORDER BY tt.sort_order, ti.tooling_id`,
    [order.filter_id],
  );
  let assigned = 0;
  for (const t of linked) {
    await exec.run(
      `INSERT INTO production_order_tools (production_order_id, tooling_item_id, is_required, qty, status)
       VALUES (?,?,1,?, 'PENDING') ON DUPLICATE KEY UPDATE is_required = 1${overwrite ? ", status = 'PENDING'" : ''}`,
      [order.id, t.id, Math.max(1, Number(t.quantity_required ?? 1))],
    );
    assigned += 1;
  }
  return { assigned, order: order.po_number };
}

export async function createOrder(data, ctx) {
  const filter = await db.one('SELECT id, internal_number FROM filters WHERE id = ?', [Number(data.filter_id)]);
  if (!filter) throw badRequest('filter_id does not match an existing filter');
  const year = new Date().getFullYear();
  let poNumber = data.po_number;
  if (!poNumber) {
    for (let i = 0; i < 50; i++) {
      const last = await db.value('SELECT MAX(CAST(SUBSTRING(po_number, -4) AS UNSIGNED)) m FROM production_orders WHERE po_number LIKE ?', [`PO-${year}-%`]);
      poNumber = `PO-${year}-${String(Number(last ?? 0) + 1 + i).padStart(4, '0')}`;
      const clash = await db.one('SELECT id FROM production_orders WHERE po_number = ?', [poNumber]);
      if (!clash) break;
    }
  } else {
    const clash = await db.one('SELECT id FROM production_orders WHERE po_number = ?', [poNumber]);
    if (clash) throw conflict(`Production order ${poNumber} already exists`);
  }
  const res = await db.run(
    `INSERT INTO production_orders (po_number, filter_id, quantity_ordered, status, priority, line, machine, planned_start_at, planned_end_at, notes, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      poNumber,
      filter.id,
      data.quantity_ordered,
      data.status || 'PLANNED',
      data.priority || 'NORMAL',
      data.line ?? null,
      data.machine ?? null,
      data.planned_start_at ?? null,
      data.planned_end_at ?? null,
      data.notes ?? null,
      ctx?.user?.id ?? null,
    ],
  );
  const id = res.insertId;
  if (!id) throw new Error('Production order insert failed');
  await autoAssignTooling(id);
  await checkReadiness({ production_order_id: id }, { record: true });
  await db.run(
    `INSERT INTO production_history (production_order_id, filter_id, event_type, quantity, note, user_id) VALUES (?,?,?,?,?,?)`,
    [id, filter.id, 'CREATED', data.quantity_ordered, `Created ${poNumber}`, ctx?.user?.id ?? null],
  );
  await audit(ctx, { action: 'create', entityType: 'production_order', entityId: id, entityLabel: poNumber, summary: `${poNumber} for ${filter.internal_number} x${data.quantity_ordered}` });
  return db.one('SELECT * FROM production_orders WHERE id = ?', [id]);
}

export async function completeOrder(orderId, { produced_qty = null, note = null, ctx } = {}) {
  const order = await db.one('SELECT * FROM production_orders WHERE id = ?', [Number(orderId)]);
  if (!order) throw notFound('Production order not found');
  if (order.status === 'COMPLETED') throw conflict('Order is already completed');
  const produced = Number(produced_qty ?? order.quantity_ordered);
  return db.tx(async (exec) => {
    await exec.run("UPDATE production_orders SET status = 'COMPLETED', quantity_produced = ?, completed_at = NOW(), updated_at = NOW() WHERE id = ?", [produced, order.id]);
    const tools = await exec.all("SELECT * FROM production_order_tools WHERE production_order_id = ? AND tooling_item_id IS NOT NULL", [order.id]);
    const batchRes = await exec.run(
      `INSERT INTO production_batches (batch_number, production_order_id, filter_id, quantity, good_qty, scrap_qty, started_at, completed_at, operator_id)
       VALUES (?,?,?,?,?,?,?,NOW(),?)`,
      [`B-${order.po_number.slice(-5)}-${Date.now().toString(36).slice(-3).toUpperCase()}`, order.id, order.filter_id, produced, produced, 0, order.started_at, ctx?.user?.id ?? null],
    );
    const batchId = batchRes.insertId;
    for (const t of tools) {
      const cycles = Math.max(1, Number(t.cycle_count || 1));
      await exec.run(
        `INSERT INTO tooling_usage_history (tooling_item_id, production_order_id, batch_id, filter_id, event_type, cycles, quantity, produced_qty, operator_id, operator_name, note)
         VALUES (?,?,?,?,'USAGE', ?,?,?, ?, ?, ?, ?)`,
        [t.tooling_item_id, order.id, batchId, order.filter_id, cycles, produced, produced, ctx?.user?.id ?? null, ctx?.user?.full_name ?? null, note ?? `${order.po_number} completed`],
      );
      await exec.run(
        `UPDATE tooling_items SET total_cycles = total_cycles + ?, total_parts_produced = total_parts_produced + ?, last_used_at = NOW(), updated_at = NOW() WHERE id = ?`,
        [cycles, produced, t.tooling_item_id],
      );
      await exec.run("UPDATE production_order_tools SET status = 'RETURNED', produced_qty = ?, returned_at = COALESCE(returned_at, NOW()) WHERE id = ?", [produced, t.id]);
    }
    await exec.run(
      `INSERT INTO production_history (production_order_id, filter_id, event_type, quantity, note, user_id) VALUES (?,?,?,?,?,?)`,
      [order.id, order.filter_id, 'COMPLETED', produced, note, ctx?.user?.id ?? null],
    );
    await exec.run("UPDATE tooling_reservations SET status = 'FULFILLED', released_at = NOW() WHERE production_order_id = ? AND status = 'ACTIVE'", [order.id]);
    await audit(ctx, { action: 'complete', entityType: 'production_order', entityId: order.id, entityLabel: order.po_number, summary: `Completed with ${produced} pcs, ${tools.length} tool usage record(s) written` });
    return { ok: true, batch: produced, tools: tools.length };
  });
}

/** Production consumption -> filter finished goods (spec §29/§35). */
export async function receiveFinishedGoods(orderId, { quantity = null, note = null, ctx } = {}) {
  const order = await db.one('SELECT * FROM production_orders WHERE id = ?', [Number(orderId)]);
  if (!order) throw notFound('Production order not found');
  const qty = Number(quantity ?? Math.max(0, Number(order.quantity_ordered) - Number(order.quantity_produced)));
  if (qty <= 0) throw badRequest('Nothing to receive - quantity must be greater than zero');
  let item = await db.one("SELECT * FROM inventory_items WHERE item_kind = 'FILTER' AND ref_id = ?", [order.filter_id]);
  if (!item) {
    const filter = await db.one('SELECT internal_number, name FROM filters WHERE id = ?', [order.filter_id]);
    const res = await db.run(
      "INSERT INTO inventory_items (item_kind, ref_id, sku, name, unit, reorder_level, is_active) VALUES ('FILTER', ?, ?, ?, 'PCS', 0, 1)",
      [order.filter_id, filter.internal_number, filter.name ?? filter.internal_number],
    );
    item = await db.one('SELECT * FROM inventory_items WHERE id = ?', [res.insertId]);
  }
  return db.tx(async (exec) => {
    const inv = await exec.one('SELECT * FROM inventory WHERE inventory_item_id = ? LIMIT 1', [item.id]);
    const balance = Number(inv?.quantity ?? 0) + qty;
    if (inv) await exec.run('UPDATE inventory SET quantity = ?, updated_at = NOW() WHERE id = ?', [balance, inv.id]);
    else await exec.run('INSERT INTO inventory (inventory_item_id, quantity) VALUES (?, ?)', [item.id, qty]);
    await exec.run(
      `INSERT INTO inventory_transactions (inventory_item_id, location_id, txn_type, quantity, balance_after, reference_type, reference_id, reference_no, reason, note, user_id)
       VALUES (?,?, 'RECEIPT', ?,?, 'PRODUCTION_ORDER', ?,?, 'PRODUCTION', ?, ?)`,
      [item.id, inv?.location_id ?? null, qty, balance, order.id, order.po_number, note, ctx?.user?.id ?? null],
    );
    await exec.run('UPDATE production_orders SET quantity_produced = quantity_produced + ?, updated_at = NOW() WHERE id = ?', [qty, order.id]);
    await audit(ctx, { action: 'receive', entityType: 'production_order', entityId: order.id, entityLabel: order.po_number, summary: `Received ${qty} pcs of ${item.sku} into finished goods` });
    return { sku: item.sku, quantity: qty, balance };
  });
}
