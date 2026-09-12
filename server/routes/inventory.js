/** /api/inventory — finished goods / part stock, transactions and split counts (spec §34, §35). */
import express from 'express';
import db from '../db/index.js';
import { asyncRoute, badRequest, notFound, conflict } from '../lib/errors.js';
import { validate, str, num, oneOf, idRef, escapeLike } from '../lib/validate.js';
import { requirePermission } from '../middleware/index.js';
import { audit } from '../services/audit.js';
import { listResult, requireId } from './_helpers.js';

const router = express.Router();

const TXN_TYPES = ['RECEIPT', 'ISSUE', 'ADJUSTMENT', 'TRANSFER', 'SCRAP', 'CYCLE_COUNT'];
async function resolveItem({ inventory_item_id, sku, filter_id, filter_number }) {
  if (inventory_item_id) {
    const row = await db.one('SELECT * FROM inventory_items WHERE id = ?', [Number(inventory_item_id)]);
    if (!row) throw notFound(`inventory_item_id ${inventory_item_id} not found`);
    return row;
  }
  if (filter_id) {
    const row = await db.one("SELECT * FROM inventory_items WHERE item_kind = 'FILTER' AND ref_id = ?", [Number(filter_id)]);
    if (row) return row;
    const filter = await db.one('SELECT id, internal_number, name FROM filters WHERE id = ?', [Number(filter_id)]);
    if (!filter) throw notFound(`filter_id ${filter_id} not found`);
    const r = await db.run(
      "INSERT INTO inventory_items (item_kind, ref_id, sku, name, unit, reorder_level, is_active) VALUES ('FILTER', ?, ?, ?, 'PCS', 0, 1)",
      [filter.id, filter.internal_number, filter.name ?? filter.internal_number],
    );
    return db.one('SELECT * FROM inventory_items WHERE id = ?', [r.insertId ?? (await db.value('SELECT id FROM inventory_items WHERE sku = ?', [filter.internal_number]))]);
  }
  if (sku) {
    const row = await db.one('SELECT * FROM inventory_items WHERE UPPER(sku) = ? OR name = ? LIMIT 1', [String(sku).toUpperCase(), sku]);
    if (row) return row;
    if (filter_number === undefined) throw notFound(`No stock item with SKU "${sku}"`);
  }
  if (filter_number) {
    const filter = await db.one('SELECT id, internal_number, name FROM filters WHERE UPPER(internal_number) = ? OR UPPER(product_number) = ? LIMIT 1', [
      String(filter_number).toUpperCase(),
      String(filter_number).toUpperCase(),
    ]);
    if (!filter) throw notFound(`Filter ${filter_number} not found`);
    return resolveItem({ filter_id: filter.id });
  }
  throw badRequest('Provide inventory_item_id, filter_id, sku or filter_number');
}

/** Where the stock sits: reuse a warehouse shelf code when it exists. */
async function resolveStockLocation(ref) {
  if (!ref) return null;
  const code = String(ref).trim().toUpperCase();
  let loc = await db.one('SELECT * FROM inventory_locations WHERE UPPER(code) = ? AND is_active = 1', [code]);
  if (!loc) {
    const toolLoc = await db.one('SELECT * FROM tooling_locations WHERE UPPER(full_code) = ? OR UPPER(code) = ?', [code, code]);
    if (toolLoc) {
      loc = await db.one('SELECT * FROM inventory_locations WHERE code = ?', [toolLoc.full_code]);
      if (!loc) {
        const r = await db.run('INSERT INTO inventory_locations (code, name, warehouse_id, location_type, capacity, is_active) VALUES (?,?,?,?,?,1)', [
          toolLoc.full_code,
          toolLoc.label_path ?? toolLoc.full_code,
          toolLoc.warehouse_id,
          toolLoc.kind,
          toolLoc.capacity_items ?? null,
        ]);
        loc = await db.one('SELECT * FROM inventory_locations WHERE id = ?', [r.insertId ?? (await db.value('SELECT id FROM inventory_locations WHERE code = ?', [toolLoc.full_code]))]);
      }
    }
  }
  if (!loc) throw notFound(`Stock location "${ref}" is not a known shelf/box code`);
  return loc;
}

/** Apply a signed delta to one stock row and log the transaction (atomically). */
async function applyTxn({ item, locationId, txnType, quantity, balanceAfter, referenceType, referenceId, referenceNo, reason, note, ctx, before }) {
  await db.tx(async (exec) => {
    const inv = await exec.one('SELECT * FROM inventory WHERE inventory_item_id = ? AND (? IS NULL OR location_id = ?)', [item.id, locationId ?? null, locationId ?? null]);
    if (txnType === 'ADJUSTMENT') {
      if (inv) await exec.run('UPDATE inventory SET quantity = ?, updated_at = NOW() WHERE id = ?', [balanceAfter, inv.id]);
      else await exec.run('INSERT INTO inventory (inventory_item_id, location_id, quantity) VALUES (?,?,?)', [item.id, locationId ?? null, balanceAfter]);
    } else if (inv) {
      await exec.run('UPDATE inventory SET quantity = ?, updated_at = NOW() WHERE id = ?', [Number(inv.quantity) + quantity, inv.id]);
    } else {
      await exec.run('INSERT INTO inventory (inventory_item_id, location_id, quantity) VALUES (?,?,?)', [item.id, locationId ?? null, Math.max(0, quantity)]);
    }
    const after = await exec.value('SELECT COALESCE(SUM(quantity),0) q FROM inventory WHERE inventory_item_id = ?', [item.id]);
    await exec.run(
      `INSERT INTO inventory_transactions (inventory_item_id, location_id, txn_type, quantity, balance_after, reference_type, reference_id, reference_no, reason, note, user_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, NOW())`,
      [item.id, locationId ?? null, txnType, quantity, Number(after), referenceType ?? null, referenceId ?? null, referenceNo ?? null, reason ?? null, note ?? null, ctx?.user?.id ?? null],
    );
    return after;
  });
  await audit(ctx, {
    action: `inventory.${String(txnType).toLowerCase()}`,
    entityType: 'inventory_item',
    entityId: item.id,
    entityLabel: item.sku ?? item.name,
    summary: `${txnType} ${Math.abs(quantity)} pcs (${before} -> ${balanceAfter ?? 'n/a'})${locationId ? ' in stock location' : ''}`,
  });
}

async function stockLevels(itemId) {
  const rows = await db.all(
    `SELECT i.id, i.quantity, i.reserved_qty, i.damaged_qty, i.lot_ref, i.location_id, il.code AS location_code, il.name AS location_name, il.location_type
     FROM inventory i
     LEFT JOIN inventory_locations il ON il.id = i.location_id
     WHERE i.inventory_item_id = ? ORDER BY i.quantity DESC`,
    [Number(itemId)],
  );
  const totals = await db.one(
    `SELECT COALESCE(SUM(quantity),0) AS on_hand, COALESCE(SUM(reserved_qty),0) AS reserved, COALESCE(SUM(damaged_qty),0) AS damaged
     FROM inventory WHERE inventory_item_id = ?`,
    [Number(itemId)],
  );
  return { rows, totals };
}

/* ------------------------------------------------------------------ list */
router.get(
  '/',
  requirePermission('*.read'),
  asyncRoute(async (req, res) => {
    const where = ['ii.is_active = 1'];
    const params = [];
    if (req.query.q) {
      const like = `%${escapeLike(req.query.q)}%`;
      where.push('(ii.sku LIKE ? OR ii.name LIKE ? OR f.internal_number LIKE ?)');
      params.push(like, like, like);
    }
    if (req.query.kind) {
      where.push('ii.item_kind = ?');
      params.push(String(req.query.kind).toUpperCase());
    }
    if (req.query.low === '1') where.push('COALESCE(t.on_hand,0) <= ii.reorder_level');
    if (req.query.out === '1') where.push('COALESCE(t.on_hand,0) <= 0');
    const size = Math.min(200, Math.max(1, Number(req.query.page_size || req.query.limit || 25)));
    const page = Math.max(1, Number(req.query.page || 1));
    const total = Number(
      await db.value(
        `SELECT COUNT(*) c FROM inventory_items ii LEFT JOIN filters f ON f.id = ii.ref_id
         LEFT JOIN (SELECT inventory_item_id, SUM(quantity) AS on_hand FROM inventory GROUP BY inventory_item_id) t ON t.inventory_item_id = ii.id
         WHERE ${where.join(' AND ')}`,
        params,
      ),
    );
    const items = await db.all(
      `SELECT ii.*, f.internal_number AS filter_number, f.name AS filter_name, ft.name AS filter_type, ft.icon,
              COALESCE(t.on_hand, 0) AS on_hand, COALESCE(t.reserved, 0) AS reserved, COALESCE(t.available, 0) AS available,
              COALESCE(t.damaged, 0) AS damaged, COALESCE(t.locations, 0) AS location_count, t.last_movement
       FROM inventory_items ii
       LEFT JOIN filters f ON f.id = ii.ref_id
       LEFT JOIN filter_types ft ON ft.id = f.filter_type_id
       LEFT JOIN (
         SELECT inventory_item_id, SUM(quantity) AS on_hand, SUM(reserved_qty) AS reserved,
                SUM(quantity) - SUM(reserved_qty) - SUM(damaged_qty) AS available, SUM(damaged_qty) AS damaged,
                COUNT(DISTINCT location_id) AS locations, MAX(updated_at) AS last_movement
         FROM inventory GROUP BY inventory_item_id
       ) t ON t.inventory_item_id = ii.id
       WHERE ${where.join(' AND ')}
       ORDER BY (COALESCE(t.on_hand,0) <= ii.reorder_level) DESC, ii.sku LIMIT ? OFFSET ?`,
      [...params, size, (page - 1) * size],
    );
    res.json(
      listResult({
        items: items.map((r) => ({
          ...r,
          below_reorder: Number(r.on_hand) <= Number(r.reorder_level),
          status: Number(r.on_hand) <= 0 ? 'OUT_OF_STOCK' : Number(r.on_hand) <= Number(r.reorder_level) ? 'LOW' : Number(r.on_hand) <= Number(r.reorder_level) * 1.5 ? 'OK_LOW' : 'HEALTHY',
        })),
        total,
        page,
        size,
      }),
    );
  }),
);

router.get('/summary', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const totals = await db.one(
    `SELECT COUNT(*) AS items, COALESCE(SUM(t.on_hand),0) AS units, COALESCE(SUM(t.cost_value),0) AS value,
            COALESCE(SUM(CASE WHEN t.on_hand <= ii.reorder_level THEN 1 ELSE 0 END),0) AS low_count,
            COALESCE(SUM(CASE WHEN t.on_hand <= 0 THEN 1 ELSE 0 END),0) AS out_count
     FROM inventory_items ii
     LEFT JOIN (SELECT inventory_item_id, SUM(quantity) AS on_hand, SUM(quantity * COALESCE(0,0)) AS cost_value FROM inventory GROUP BY inventory_item_id) t ON t.inventory_item_id = ii.id
     WHERE ii.is_active = 1`,
  );
  res.json({
    totals,
    by_type: await db.all(
      `SELECT ft.name AS filter_type, COUNT(*) AS items, COALESCE(SUM(t.on_hand),0) AS units
       FROM inventory_items ii JOIN filters f ON f.id = ii.ref_id JOIN filter_types ft ON ft.id = f.filter_type_id
       LEFT JOIN (SELECT inventory_item_id, SUM(quantity) AS on_hand FROM inventory GROUP BY inventory_item_id) t ON t.inventory_item_id = ii.id
       WHERE ii.item_kind = 'FILTER' GROUP BY ft.name ORDER BY units DESC`,
    ),
    locations: await db.all(
      `SELECT il.code, il.name, il.location_type, COALESCE(SUM(i.quantity),0) AS units, COUNT(DISTINCT i.inventory_item_id) AS items
       FROM inventory_locations il LEFT JOIN inventory i ON i.location_id = il.id
       GROUP BY il.id, il.code, il.name, il.location_type ORDER BY units DESC LIMIT 25`,
    ),
  });
}));

/* --------------------------------------------------------------- detail */
router.get('/items/:id', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'inventory item id');
  const item = await db.one(
    `SELECT ii.*, f.id AS filter_pk, f.internal_number AS filter_number, f.name AS filter_name, ft.name AS filter_type
     FROM inventory_items ii
     LEFT JOIN filters f ON f.id = ii.ref_id
     LEFT JOIN filter_types ft ON ft.id = f.filter_type_id
     WHERE ii.id = ?`,
    [id],
  );
  if (!item) throw notFound('Stock item not found');
  const { rows, totals } = await stockLevels(id);
  res.json({
    item,
    stock: rows,
    totals,
    transactions: await db.all(
      `SELECT t.*, u.username, u.full_name, il.code AS location_code FROM inventory_transactions t
       LEFT JOIN users u ON u.id = t.user_id LEFT JOIN inventory_locations il ON il.id = t.location_id
       WHERE t.inventory_item_id = ? ORDER BY t.created_at DESC, t.id DESC LIMIT 50`,
      [id],
    ),
  });
}));

/** Per-location stock for one filter (used by the filter overview "stock" block). */
router.get('/filter/:filterId', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const item = await db.one("SELECT * FROM inventory_items WHERE item_kind = 'FILTER' AND ref_id = ?", [Number(req.params.filterId)]);
  if (!item) return res.json({ item: null, stock: [], totals: { on_hand: 0, reserved: 0, damaged: 0 } });
  const { rows, totals } = await stockLevels(item.id);
  res.json({ item, stock: rows, totals });
}));

/* ---------------------------------------------------------- transactions */
const TXN_SCHEMA = {
  inventory_item_id: [idRef, {}],
  filter_id: [idRef, {}],
  sku: [str, { max: 80 }],
  filter_number: [str, { max: 60 }],
  txn_type: oneOf(TXN_TYPES, { required: true }),
  quantity: [num, { int: true, min: 0, max: 10000000, required: true }],
  location: [str, { max: 200 }],
  lot_ref: [str, { max: 60 }],
  reference_type: [str, { max: 30 }],
  reference_id: [idRef, {}],
  reference_no: [str, { max: 60 }],
  reason: oneOf(['PRODUCTION', 'SALE', 'DAMAGE', 'RECOUNT', 'TRANSFER', 'SCRAP', 'SAMPLE', 'CORRECTION', 'OTHER']),
  note: [str, { max: 400 }],
};

router.post('/transactions', requirePermission('inventory.update'), asyncRoute(async (req, res) => {
  const data = validate(TXN_SCHEMA, req.body);
  const item = await resolveItem(data);
  const loc = await resolveStockLocation(data.location);
  const totals = await db.one('SELECT COALESCE(SUM(quantity),0) q FROM inventory WHERE inventory_item_id = ?', [item.id]);
  const before = Number(totals?.q ?? 0);
  const signed = data.txn_type === 'ISSUE' || data.txn_type === 'SCRAP' ? -Math.abs(data.quantity) : data.txn_type === 'ADJUSTMENT' ? data.quantity : Math.abs(data.quantity);
  const after = data.txn_type === 'ADJUSTMENT' ? data.quantity : before + signed;
  if (after < 0) throw conflict(`Only ${before} pcs of ${item.sku ?? item.name} in stock - cannot issue ${Math.abs(signed)}`);
  await applyTxn({
    item,
    locationId: loc?.id ?? null,
    txnType: data.txn_type,
    quantity: data.txn_type === 'ADJUSTMENT' ? data.quantity - before : signed,
    balanceAfter: after,
    referenceType: data.reference_type ?? null,
    referenceId: data.reference_id ?? null,
    referenceNo: data.reference_no ?? null,
    reason: data.reason ?? null,
    note: data.note ?? null,
    ctx: req.ctx,
    before,
  });
  if (data.lot_ref) {
    await db.run('UPDATE inventory SET lot_ref = ? WHERE inventory_item_id = ? AND (? IS NULL OR location_id = ?)', [data.lot_ref, item.id, loc?.id ?? null, loc?.id ?? null]);
  }
  const { rows, totals: newTotals } = await stockLevels(item.id);
  res.status(201).json({ item, before, after, delta: after - before, stock: rows, totals: newTotals, location: loc ? { id: loc.id, code: loc.code } : null });
}));

/** Move stock between locations. */
router.post('/transfer', requirePermission('inventory.update'), asyncRoute(async (req, res) => {
  const data = validate(
    { filter_id: [idRef, {}], inventory_item_id: [idRef, {}], sku: [str, { max: 80 }], quantity: [num, { int: true, min: 1, required: true }], from: [str, { max: 200 }], to: [str, { max: 200, required: true }], note: [str, { max: 400 }] },
    req.body,
  );
  const item = await resolveItem(data);
  const from = await resolveStockLocation(data.from);
  const to = await resolveStockLocation(data.to);
  const fromRow = await db.one('SELECT * FROM inventory WHERE inventory_item_id = ? AND location_id = ?', [item.id, from.id]);
  if (!fromRow || Number(fromRow.quantity) < data.quantity) {
    throw conflict(`${from.code} only holds ${fromRow?.quantity ?? 0} pcs of ${item.sku ?? item.name} - cannot move ${data.quantity}`);
  }
  await db.tx(async (exec) => {
    await exec.run('UPDATE inventory SET quantity = quantity - ?, updated_at = NOW() WHERE id = ?', [data.quantity, fromRow.id]);
    const target = await exec.one('SELECT * FROM inventory WHERE inventory_item_id = ? AND location_id = ?', [item.id, to.id]);
    if (target) await exec.run('UPDATE inventory SET quantity = quantity + ?, updated_at = NOW() WHERE id = ?', [data.quantity, target.id]);
    else await exec.run('INSERT INTO inventory (inventory_item_id, location_id, quantity) VALUES (?,?,?)', [item.id, to.id, data.quantity]);
    for (const [txnType, qty, locId] of [
      ['TRANSFER', -data.quantity, from.id],
      ['TRANSFER', data.quantity, to.id],
    ]) {
      await exec.run(
        `INSERT INTO inventory_transactions (inventory_item_id, location_id, txn_type, quantity, balance_after, reason, note, user_id, created_at)
         VALUES (?,?,?,?,?,?,?, ?, NOW())`,
        [item.id, locId, txnType, qty, await exec.value('SELECT COALESCE(SUM(quantity),0) q FROM inventory WHERE inventory_item_id = ?', [item.id]), 'TRANSFER', data.note ?? `Transfer ${from.code} -> ${to.code}`, req.user.id],
      );
    }
  });
  await audit(req.ctx, { action: 'transfer', entityType: 'inventory_item', entityId: item.id, entityLabel: item.sku, summary: `Moved ${data.quantity} pcs from ${from.code} to ${to.code}` });
  res.json({ ok: true, item: item.sku, quantity: data.quantity, from: from.code, to: to.code });
}));

/* ------------------------------------------------------- split counts (spec §34) */
async function countSummary(exec, countId) {
  const row = await (exec ?? db).one(
    `SELECT COUNT(*) AS line_total,
            COALESCE(SUM(system_qty),0) AS system_qty,
            COALESCE(SUM(COALESCE(counted_qty, system_qty)),0) AS counted_qty,
            COALESCE(SUM(variance),0) AS variance,
            COALESCE(SUM(CASE WHEN variance IS NOT NULL AND variance <> 0 THEN 1 ELSE 0 END),0) AS variances,
            COALESCE(SUM(CASE WHEN counted_qty IS NOT NULL THEN 1 ELSE 0 END),0) AS counted,
            COALESCE(SUM(CASE WHEN status = 'APPLIED' THEN 1 ELSE 0 END)) AS applied
     FROM inventory_count_lines WHERE count_id = ?`,
    [Number(countId)],
  );
  return {
    lines: Number(row.line_total ?? 0),
    system_qty: Number(row.system_qty ?? 0),
    counted_qty: Number(row.counted_qty ?? 0),
    variance: Number(row.variance ?? 0),
    variances: Number(row.variances ?? 0),
    counted: Number(row.counted ?? 0),
    applied: Number(row.applied ?? 0),
    pending: Math.max(0, Number(row.line_total ?? 0) - Number(row.counted ?? 0)),
  };
}

router.get('/counts', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const items = await db.all(
    `SELECT ic.*, u.full_name AS created_by_name, la.full_name AS counter_a_name, lb.full_name AS counter_b_name,
            (SELECT COUNT(*) FROM inventory_count_lines l WHERE l.count_id = ic.id) AS line_count,
            (SELECT COUNT(*) FROM inventory_count_lines l WHERE l.count_id = ic.id AND l.counted_qty IS NOT NULL) AS counted_lines,
            (SELECT COALESCE(SUM(l.variance),0) FROM inventory_count_lines l WHERE l.count_id = ic.id) AS total_variance
     FROM inventory_counts ic
     LEFT JOIN users u ON u.id = ic.created_by
     LEFT JOIN users la ON la.id = ic.counter_a
     LEFT JOIN users lb ON lb.id = ic.counter_b
     WHERE (? IS NULL OR ic.status = ?) ORDER BY ic.id DESC LIMIT 60`,
    [req.query.status ? String(req.query.status).toUpperCase() : null, req.query.status ? String(req.query.status).toUpperCase() : null],
  );
  res.json({ items, open: items.filter((i) => i.status === 'OPEN').length });
}));

router.post('/counts', requirePermission('inventory.manage'), asyncRoute(async (req, res) => {
  const data = validate(
    {
      title: [str, { required: true, max: 200 }],
      location: [str, { max: 200 }],
      method: oneOf(['FULL', 'SPLIT', 'A_ONLY', 'B_ONLY']),
      counter_a: [idRef, {}],
      counter_b: [idRef, {}],
      notes: [str, { max: 500 }],
    },
    req.body,
  );
  const loc = data.location ? await resolveStockLocation(data.location) : null;
  const seq = Number(await db.value('SELECT COUNT(*) c FROM inventory_counts')) + 1;
  const countNo = `CNT-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(seq).padStart(3, '0')}`;
  const r = await db.run(
    `INSERT INTO inventory_counts (count_no, title, location_code, warehouse_id, status, method, counter_a, counter_b, notes, created_by)
     VALUES (?,?,?,?,'OPEN',?,?,?,?,?)`,
    [countNo, data.title, loc?.code ?? null, loc?.warehouse_id ?? null, data.method ?? (data.counter_b ? 'SPLIT' : 'FULL'), data.counter_a ?? req.user.id, data.counter_b ?? null, data.notes ?? null, req.user.id],
  );
  const id = r.insertId ?? (await db.value('SELECT id FROM inventory_counts WHERE count_no = ?', [countNo]));
  const rows = await db.all(
    `SELECT i.inventory_item_id, i.location_id, i.quantity FROM inventory i ${loc ? 'WHERE i.location_id = ?' : ''}`,
    loc ? [loc.id] : [],
  );
  for (const row of rows) {
    await db.run(
      `INSERT INTO inventory_count_lines (count_id, inventory_item_id, location_id, system_qty, status) VALUES (?,?,?,?, 'PENDING')
       ON DUPLICATE KEY UPDATE system_qty = VALUES(system_qty)`,
      [id, row.inventory_item_id, row.location_id ?? null, Number(row.quantity)],
    );
  }
  await audit(req.ctx, { action: 'create', entityType: 'inventory_count', entityId: id, entityLabel: countNo, summary: `Count "${data.title}" opened with ${rows.length} line(s)${loc ? ` in ${loc.code}` : ' plant-wide'}` });
  res.status(201).json({ id, count_no: countNo, lines: rows.length, location: loc?.code ?? null, summary: await countSummary(null, id) });
}));

router.get('/counts/:id', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'count id');
  const head = await db.one(
    `SELECT ic.*, u.full_name AS created_by_name, la.full_name AS counter_a_name, lb.full_name AS counter_b_name
     FROM inventory_counts ic
     LEFT JOIN users u ON u.id = ic.created_by LEFT JOIN users la ON la.id = ic.counter_a LEFT JOIN users lb ON lb.id = ic.counter_b
     WHERE ic.id = ?`,
    [id],
  );
  if (!head) throw notFound('Count not found');
  const lines = await db.all(
    `SELECT l.*, ii.sku, ii.name, ii.unit, ii.item_kind, f.internal_number AS filter_number, il.code AS location_code
     FROM inventory_count_lines l
     JOIN inventory_items ii ON ii.id = l.inventory_item_id
     LEFT JOIN filters f ON f.id = ii.ref_id
     LEFT JOIN inventory_locations il ON il.id = l.location_id
     WHERE l.count_id = ? ORDER BY (l.variance IS NOT NULL AND l.variance <> 0) DESC, ii.sku LIMIT 1000`,
    [id],
  );
  res.json({ count: head, lines, summary: await countSummary(null, id) });
}));

async function applyCountEntry(id, lineId, data, ctx) {
  const head = await db.one('SELECT * FROM inventory_counts WHERE id = ?', [id]);
  if (!head) throw notFound('Count not found');
  if (head.status !== 'OPEN') throw conflict(`This count is ${head.status} - open it again before entering numbers`);
  const line = await db.one('SELECT * FROM inventory_count_lines WHERE id = ? AND count_id = ?', [Number(lineId), id]);
  if (!line) throw notFound('That line does not belong to this count');
  const column = data.counter === 'B' ? 'counted_b' : 'counted_a';
  await db.run(`UPDATE inventory_count_lines SET ${column} = ?, note = COALESCE(?, note), counted_at = NOW() WHERE id = ?`, [data.qty, data.note ?? null, line.id]);
  const fresh = await db.one('SELECT * FROM inventory_count_lines WHERE id = ?', [line.id]);
  let resolved = null;
  let status = 'PENDING';
  if (head.method === 'FULL' || head.method === 'A_ONLY') resolved = fresh.counted_a ?? (head.method === 'A_ONLY' ? null : fresh.counted_a);
  else if (head.method === 'B_ONLY') resolved = fresh.counted_b;
  else if (head.method === 'SPLIT' && head.counter_b) {
    if (fresh.counted_a !== null && fresh.counted_b !== null) {
      resolved = fresh.counted_a === fresh.counted_b ? fresh.counted_a : Math.round((Number(fresh.counted_a) + Number(fresh.counted_b)) / 2);
      status = fresh.counted_a === fresh.counted_b ? 'MATCHED' : 'DISPUTED';
    } else {
      status = 'WAITING_SECOND';
    }
  } else if (head.method === 'SPLIT') {
    resolved = fresh.counted_a ?? fresh.counted_b;
  }
  if (resolved !== null && resolved !== undefined) {
    if (status === 'PENDING' || status === 'WAITING_SECOND') status = 'COUNTED';
    await db.run('UPDATE inventory_count_lines SET counted_qty = ?, variance = ?, status = ? WHERE id = ?', [resolved, resolved - Number(line.system_qty), status, line.id]);
  }
  await audit(ctx, {
    action: 'count',
    entityType: 'inventory_count',
    entityId: id,
    entityLabel: head.count_no,
    summary: `${head.count_no} line #${line.id} counter ${data.counter === 'B' ? 'B' : 'A'} = ${data.qty} (system ${line.system_qty})`,
  });
  return { line: await db.one('SELECT * FROM inventory_count_lines WHERE id = ?', [line.id]), summary: await countSummary(null, id) };
}

/** Record one counter's number; when both agree (or method = FULL) the line is resolved. */
router.post('/counts/:id/lines/:lineId', requirePermission('inventory.update'), asyncRoute(async (req, res) => {
  const data = validate({ counter: oneOf(['A', 'B'], { default: 'A' }), qty: [num, { int: true, min: 0, max: 10000000, required: true }], note: [str, { max: 400 }] }, req.body);
  res.json(await applyCountEntry(requireId(req.params.id, 'count id'), requireId(req.params.lineId, 'line id'), data, req.ctx));
}));

/** Quick entry by SKU/number (what the phone does after a scan). */
router.post('/counts/:id/scan', requirePermission('inventory.update'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'count id');
  const data = validate(
    { sku: [str, { max: 80 }], filter_number: [str, { max: 60 }], counter: oneOf(['A', 'B'], { default: 'A' }), qty: [num, { int: true, min: 0, max: 10000000 }] },
    req.body,
  );
  if (!data.sku && !data.filter_number) throw badRequest('sku or filter_number is required');
  if (data.qty === null || data.qty === undefined) {
    throw badRequest('qty is required - count the parts, then send the number');
  }
  const needle = String(data.sku ?? data.filter_number).toUpperCase();
  const line = await db.one(
    `SELECT l.* FROM inventory_count_lines l JOIN inventory_items ii ON ii.id = l.inventory_item_id
     WHERE l.count_id = ? AND (UPPER(ii.sku) = ? OR UPPER(ii.name) = ?) LIMIT 1`,
    [id, needle, String(data.filter_number ?? data.sku).toUpperCase()],
  );
  if (!line) throw notFound(`"${data.sku ?? data.filter_number}" is not on this count sheet (it may be in another location)`);
  res.json(await applyCountEntry(id, line.id, { ...data, note: 'entered by scan' }, req.ctx));
}));

/** Apply the variances as ADJUSTMENT transactions (admin/quality only). */
router.post('/counts/:id/apply', requirePermission('inventory.manage'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'count id');
  const head = await db.one('SELECT * FROM inventory_counts WHERE id = ?', [id]);
  if (!head) throw notFound('Count not found');
  if (head.status === 'APPLIED') throw conflict('This count has already been applied');
  const lines = await db.all("SELECT * FROM inventory_count_lines WHERE count_id = ? AND status IN ('COUNTED','MATCHED','DISPUTED') AND counted_qty IS NOT NULL AND counted_qty <> system_qty", [id]);
  if (!lines.length) throw badRequest('There are no counted lines with a variance to apply');
  if (lines.some((l) => l.status === 'DISPUTED') && req.body?.force !== true) {
    throw conflict('Some lines are still disputed between the two counters - recount them or send force:true', { disputed: lines.filter((l) => l.status === 'DISPUTED').length });
  }
  let applied = 0;
  for (const line of lines) {
    const item = await db.one('SELECT * FROM inventory_items WHERE id = ?', [line.inventory_item_id]);
    const before = Number(await db.value('SELECT COALESCE(SUM(quantity),0) q FROM inventory WHERE inventory_item_id = ?', [item.id]));
    const after = Number(await db.value('SELECT COALESCE(SUM(quantity),0) q FROM inventory WHERE inventory_item_id = ? AND (? IS NULL OR location_id = ?)', [item.id, line.location_id ?? null, line.location_id ?? null])) - Number(line.system_qty) + Number(line.counted_qty);
    await db.tx(async (exec) => {
      if (line.location_id) {
        await exec.run('UPDATE inventory SET quantity = ?, updated_at = NOW() WHERE inventory_item_id = ? AND location_id = ?', [Number(line.counted_qty), line.inventory_item_id, line.location_id]);
      } else {
        await exec.run('UPDATE inventory SET quantity = ? WHERE inventory_item_id = ?', [Number(line.counted_qty), line.inventory_item_id]);
      }
      const txn = await exec.run(
        `INSERT INTO inventory_transactions (inventory_item_id, location_id, txn_type, quantity, balance_after, reference_type, reference_id, reference_no, reason, note, user_id, created_at)
         VALUES (?,?, 'CYCLE_COUNT', ?,?, 'INVENTORY_COUNT', ?,?, 'RECOUNT', ?, ?, NOW())`,
        [line.inventory_item_id, line.location_id, Number(line.counted_qty) - Number(line.system_qty), after, id, head.count_no, `Count ${head.count_no} line adjustment`, req.user.id],
      );
      await exec.run("UPDATE inventory_count_lines SET status = 'APPLIED', applied_txn_id = ? WHERE id = ?", [txn.insertId ?? null, line.id]);
    });
    await audit(req.ctx, { action: 'inventory.cycle_count', entityType: 'inventory_item', entityId: item.id, entityLabel: item.sku, summary: `Count ${head.count_no}: ${line.system_qty} -> ${line.counted_qty} (${before} -> ${after} on hand)` });
    applied += 1;
  }
  await db.run("UPDATE inventory_counts SET status = 'APPLIED', finished_at = NOW(), updated_at = NOW() WHERE id = ?", [id]);
  res.json({ ok: true, applied, summary: await countSummary(null, id) });
}));

router.post('/counts/:id/close', requirePermission('inventory.manage'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'count id');
  const head = await db.one('SELECT * FROM inventory_counts WHERE id = ?', [id]);
  if (!head) throw notFound('Count not found');
  const summary = await countSummary(null, id);
  if (summary.pending > 0 && req.body?.force !== true) throw conflict(`${summary.pending} line(s) have not been counted yet - recount or send force:true to close anyway`);
  await db.run("UPDATE inventory_counts SET status = ?, finished_at = NOW(), notes = COALESCE(?, notes), updated_at = NOW() WHERE id = ?", [
    req.body?.status === 'CANCELLED' ? 'CANCELLED' : 'CLOSED',
    req.body?.notes ?? null,
    id,
  ]);
  await audit(req.ctx, { action: 'close', entityType: 'inventory_count', entityId: id, entityLabel: head.count_no, summary: `Count ${head.count_no} closed (variance ${summary.variance} pcs over ${summary.variances} line(s))` });
  res.json({ ok: true, status: req.body?.status === 'CANCELLED' ? 'CANCELLED' : 'CLOSED', summary });
}));

/* ------------------------------------------------------------ locations */
router.get('/locations', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const items = await db.all(
    `SELECT il.*, COALESCE(SUM(i.quantity),0) AS units, COUNT(i.id) AS rows_count
     FROM inventory_locations il LEFT JOIN inventory i ON i.location_id = il.id
     ${req.query.active_only === '1' ? 'WHERE il.is_active = 1' : ''}
     GROUP BY il.id, il.code, il.name, il.location_type, il.capacity, il.is_active, il.warehouse_id
     ORDER BY il.code`,
  );
  res.json({ items });
}));

router.post('/locations', requirePermission('inventory.manage'), asyncRoute(async (req, res) => {
  const data = validate({ code: [str, { required: true, upper: true, max: 60 }], name: [str, { max: 160 }], location_type: oneOf(['BIN', 'RACK', 'SHELF', 'BOX', 'FLOOR', 'OFFSITE', 'QUARANTINE']), capacity: [num, { int: true, min: 0 }], warehouse: [str, { max: 60 }] }, req.body);
  if (await db.one('SELECT id FROM inventory_locations WHERE code = ?', [data.code])) throw conflict(`Stock location ${data.code} already exists`);
  const wh = data.warehouse ? await db.one('SELECT id FROM warehouses WHERE UPPER(code) = ?', [data.warehouse.toUpperCase()]) : null;
  const r = await db.run('INSERT INTO inventory_locations (code, name, warehouse_id, location_type, capacity, is_active) VALUES (?,?,?,?,?,1)', [
    data.code,
    data.name ?? data.code,
    wh?.id ?? null,
    data.location_type ?? 'BIN',
    data.capacity ?? null,
  ]);
  await audit(req.ctx, { action: 'create', entityType: 'inventory_location', entityId: r.insertId, entityLabel: data.code, summary: `Stock location ${data.code} created` });
  res.status(201).json(await db.one('SELECT * FROM inventory_locations WHERE id = ?', [r.insertId ?? (await db.value('SELECT id FROM inventory_locations WHERE code = ?', [data.code]))]));
}));

export default router;
