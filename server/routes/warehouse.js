/** /api/warehouse — locations, storage map, layout builder, occupancy (spec §13-§17, §46). */
import express from 'express';
import db from '../db/index.js';
import { asyncRoute, badRequest, notFound, conflict } from '../lib/errors.js';
import { validate, str, num, bool, oneOf, idRef, escapeLike } from '../lib/validate.js';
import { requirePermission } from '../middleware/index.js';
import {
  KINDS,
  listLocations,
  getLocation,
  locationDetail,
  warehouseMap,
  createNode,
  updateNodeLocation,
  deleteNode,
  toolsAtLocation,
  suggest,
  refreshAll,
  getLayout,
  upsertLayout,
  autoGenerateLayout,
  moveContents,
} from '../services/locations.js';
import { requireId } from './_helpers.js';
import { payloadFor, qrSvg, barcodeSvg } from '../services/labels.js';
import { audit } from '../services/audit.js';

const router = express.Router();

/* --------------------------------------------------------------- helpers */
async function countsFor(locationId) {
  const row = await db.one(
    `SELECT (SELECT COUNT(*) FROM tooling_locations WHERE parent_location_id = ?) AS children,
            (SELECT COUNT(*) FROM tooling_items WHERE location_id = ? AND deleted_at IS NULL) AS items,
            (SELECT COALESCE(SUM(quantity),0) FROM tooling_items WHERE location_id = ? AND deleted_at IS NULL) AS pieces`,
    [locationId, locationId, locationId],
  );
  return row;
}

function withFill(loc) {
  const capacity = Number(loc.capacity_items ?? 0);
  const occupancy = Number(loc.occupancy_items ?? 0);
  return { ...loc, capacity_items: capacity || null, fill_pct: capacity > 0 ? Math.min(200, Math.round((occupancy / capacity) * 100)) : null };
}

/* ---------------------------------------------------------------- search */
router.get('/search', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const q = String(req.query.q ?? req.query.code ?? '').trim();
  if (!q) throw badRequest('q (location code or part of it) is required');
  const like = `%${escapeLike(q.toUpperCase())}%`;
  const items = await db.all(
    `SELECT l.*, (SELECT COUNT(*) FROM tooling_items ti WHERE ti.location_id = l.id AND ti.deleted_at IS NULL) AS direct_items,
            w.code AS warehouse_code, w.name AS warehouse_name
     FROM tooling_locations l LEFT JOIN warehouses w ON w.id = l.warehouse_id
     WHERE UPPER(l.full_code) LIKE ? OR UPPER(l.label_path) LIKE ? OR UPPER(l.code) = ?
     ORDER BY l.kind, l.full_code LIMIT 40`,
    [like, like, q.toUpperCase()],
  );
  res.json({ items: items.map(withFill), count: items.length });
}));

/** Flat list with filters (used by pickers + the LOCATIONS home tile). */
router.get('/locations', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const items = await listLocations({
    kind: req.query.kind,
    warehouse_id: req.query.warehouse_id,
    search: req.query.q ?? null,
    only_occupied: req.query.only_occupied === '1',
    limit: Number(req.query.limit || 300),
  });
  const withItems = await Promise.all(
    items.map(async (l) => ({
      ...withFill(l),
      children: await db.value('SELECT COUNT(*) c FROM tooling_locations WHERE parent_location_id = ?', [l.id]),
    })),
  );
  res.json({ items: withItems, count: withItems.length, kinds: KINDS });
}));

router.get('/suggest', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const items = await suggest({
    tooling_id: req.query.tooling_id ? Number(req.query.tooling_id) : null,
    tooling_set_id: req.query.tooling_set_id ? Number(req.query.tooling_set_id) : null,
    filter_id: req.query.filter_id ? Number(req.query.filter_id) : null,
    type_code: req.query.type_code ?? null,
    length_mm: req.query.length ? Number(req.query.length) : null,
    width_mm: req.query.width ? Number(req.query.width) : null,
  });
  res.json({ items, count: items.length });
}));

/* ------------------------------------------------- what is in a location */
router.get('/contents', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const ref = req.query.location ?? req.query.code ?? req.query.qr;
  if (!ref) throw badRequest('location (code or id) is required');
  const loc = await getLocation(ref);
  const items = await toolsAtLocation(loc.id, { include_children: req.query.deep !== '0' });
  const stock = await db.all(
    `SELECT ii.sku, ii.name, ii.unit, SUM(i.quantity) AS quantity
     FROM inventory i JOIN inventory_items ii ON ii.id = i.inventory_item_id AND ii.item_kind = 'FILTER'
     JOIN filters f ON f.id = ii.ref_id
     WHERE i.location_id = ? GROUP BY ii.id, ii.sku, ii.name, ii.unit ORDER BY quantity DESC LIMIT 50`,
    [loc.id],
  );
  const recent = await db.all(
    `SELECT m.id, m.movement_type, m.qty, m.note, m.username, m.created_at, t.tooling_id
     FROM tooling_movements m JOIN tooling_items t ON t.id = m.tooling_item_id
     WHERE m.to_location_id = ? OR m.from_location_id = ? ORDER BY m.created_at DESC LIMIT 20`,
    [loc.id, loc.id],
  );
  res.json({
    location: withFill(loc),
    items,
    stock,
    recent_movements: recent,
    tooling_count: items.length,
    hint: items.length === 0 ? 'This location is empty' : `${items.length} tooling item(s) here`,
  });
}));

/* ----------------------------------------------------------- occupancy */
router.get('/occupancy', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const where = ["l.capacity_items IS NOT NULL"];
  const params = [];
  if (req.query.warehouse_id) {
    where.push('l.warehouse_id = ?');
    params.push(Number(req.query.warehouse_id));
  }
  if (req.query.kind) {
    where.push('l.kind = ?');
    params.push(String(req.query.kind).toUpperCase());
  }
  const rows = await db.all(
    `SELECT l.id, l.kind, l.code, l.full_code, l.label_path, l.capacity_items, l.occupancy_items,
            ROUND(l.occupancy_items * 100.0 / l.capacity_items) AS fill_pct, l.status, w.code AS warehouse_code
     FROM tooling_locations l LEFT JOIN warehouses w ON w.id = l.warehouse_id
     WHERE ${where.join(' AND ')} ORDER BY fill_pct DESC, l.full_code LIMIT 200`,
    params,
  );
  const filtered = rows.filter((r) => {
    if (req.query.min_pct && Number(r.fill_pct) < Number(req.query.min_pct)) return false;
    if (req.query.max_pct && Number(r.fill_pct) > Number(req.query.max_pct)) return false;
    return true;
  });
  res.json({
    items: filtered,
    summary: {
      total_capacity: rows.reduce((s, r) => s + Number(r.capacity_items ?? 0), 0),
      total_used: rows.reduce((s, r) => s + Number(r.occupancy_items ?? 0), 0),
      full: filtered.filter((r) => Number(r.fill_pct) >= 100).length,
      nearly_full: filtered.filter((r) => Number(r.fill_pct) >= 80 && Number(r.fill_pct) < 100).length,
      free: filtered.filter((r) => Number(r.fill_pct) < 20).length,
    },
  });
}));

router.post('/recalculate', requirePermission('locations.manage'), asyncRoute(async (req, res) => {
  await refreshAll();
  await audit(req.ctx, { action: 'recalculate', entityType: 'tooling_location', summary: 'Occupancy + set completeness recalculated' });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------ warehouses */
router.get('/warehouses', asyncRoute(async (req, res) => {
  const items = await db.all(
    `SELECT w.*,
            (SELECT COUNT(*) FROM tooling_locations l WHERE l.warehouse_id = w.id AND l.kind = 'ROW') AS rows_count,
            (SELECT COUNT(*) FROM tooling_locations l WHERE l.warehouse_id = w.id AND l.kind = 'RACK') AS racks_count,
            (SELECT COUNT(*) FROM tooling_locations l WHERE l.warehouse_id = w.id AND l.kind = 'SHELF') AS shelves_count,
            (SELECT COUNT(*) FROM tooling_locations l WHERE l.warehouse_id = w.id AND l.kind = 'BOX') AS boxes_count,
            (SELECT COUNT(*) FROM tooling_items t WHERE t.deleted_at IS NULL AND t.location_id IN (SELECT id FROM tooling_locations WHERE warehouse_id = w.id)) AS item_count,
            (SELECT COALESCE(SUM(l.occupancy_items),0) FROM tooling_locations l WHERE l.warehouse_id = w.id AND l.kind IN ('SHELF','BOX')) AS used_places,
            (SELECT COALESCE(SUM(l.capacity_items),0) FROM tooling_locations l WHERE l.warehouse_id = w.id AND l.kind IN ('SHELF','BOX')) AS total_places
     FROM warehouses w ${req.query.active === '1' ? 'WHERE w.is_active = 1' : ''}
     ORDER BY w.sort_order, w.code`,
  );
  res.json({
    items: items.map((w) => ({
      ...w,
      fill_pct: Number(w.total_places) > 0 ? Math.round((Number(w.used_places) / Number(w.total_places)) * 100) : null,
    })),
  });
}));

const WH_SCHEMA = {
  code: [str, { required: true, upper: true, max: 20, pattern: /^[A-Z0-9-]+$/ }],
  name: [str, { required: true, max: 160 }],
  warehouse_type: oneOf(['TOOL_ROOM', 'WAREHOUSE', 'PRODUCTION_STORE', 'QUARANTINE', 'OFFSITE']),
  address: [str, { max: 255 }],
  manager: [str, { max: 120 }],
  level_prefix: [str, { max: 10, upper: true }],
  level_label: [str, { max: 40 }],
  is_active: [bool, { default: true }],
  sort_order: [num, { int: true, min: 0, max: 9999 }],
  notes: [str, { max: 2000 }],
};

router.post('/warehouses', requirePermission('locations.manage'), asyncRoute(async (req, res) => {
  const data = validate(WH_SCHEMA, req.body);
  if (await db.one('SELECT id FROM warehouses WHERE code = ?', [data.code])) throw conflict(`Warehouse ${data.code} already exists`);
  const r = await db.run(
    'INSERT INTO warehouses (code, name, warehouse_type, address, manager, level_prefix, level_label, is_active, sort_order, notes) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [data.code, data.name, data.warehouse_type ?? 'TOOL_ROOM', data.address ?? null, data.manager ?? null, (data.level_prefix ?? (data.code.replace(/[^A-Z]/g, '').slice(0, 4) || 'W')), data.level_label ?? null, data.is_active === false ? 0 : 1, data.sort_order ?? 100, data.notes ?? null],
  );
  const id = r.insertId ?? (await db.value('SELECT id FROM warehouses WHERE code = ?', [data.code]));
  await db.run(
    `INSERT INTO tooling_locations (kind, code, full_code, label_path, ref_id, warehouse_id, depth, status)
     VALUES ('WAREHOUSE', ?, ?, ?, ?, ?, 0, 'AVAILABLE')
     ON DUPLICATE KEY UPDATE full_code = VALUES(full_code), label_path = VALUES(label_path), updated_at = NOW()`,
    [data.code, data.code, data.name, id, id],
  );
  await audit(req.ctx, { action: 'create', entityType: 'warehouse', entityId: id, entityLabel: data.code, summary: `Warehouse ${data.name} (${data.code}) created` });
  res.status(201).json(await db.one('SELECT * FROM warehouses WHERE id = ?', [id]));
}));

router.put('/warehouses/:id', requirePermission('locations.manage'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'warehouse id');
  const before = await db.one('SELECT * FROM warehouses WHERE id = ?', [id]);
  if (!before) throw notFound('Warehouse not found');
  const data = validate(WH_SCHEMA, req.body, { partial: true });
  const keys = Object.keys(data);
  if (!keys.length) throw badRequest('Nothing to update');
  await db.run(`UPDATE warehouses SET ${keys.map((k) => `\`${k}\`=?`).join(',')} WHERE id = ?`, [
    ...keys.map((k) => (typeof data[k] === 'boolean' ? Number(data[k]) : data[k])),
    id,
  ]);
  if (data.code && data.code !== before.code) {
    await db.run('UPDATE tooling_locations SET full_code = ?, code = ?, label_path = ? WHERE kind = ? AND ref_id = ?', [data.code, data.code, data.name ?? data.code, 'WAREHOUSE', id]);
  }
  await audit(req.ctx, { action: 'update', entityType: 'warehouse', entityId: id, entityLabel: before.code, summary: `Warehouse updated: ${keys.join(', ')}` });
  res.json(await db.one('SELECT * FROM warehouses WHERE id = ?', [id]));
}));

/* ------------------------------------------------- location hierarchy CRUD */
const NODE_SCHEMA = {
  kind: oneOf(['ROW', 'RACK', 'SHELF', 'BOX']),
  parent_location_id: [idRef, { required: true }],
  code: [str, { required: true, upper: true, max: 20, pattern: /^[A-Z0-9-]+$/ }],
  label: [str, { max: 120 }],
  capacity_items: [num, { int: true, min: 0, max: 100000 }],
  max_weight_kg: [num, { min: 0 }],
  height_mm: [num, { int: true, min: 0, max: 100000 }],
  level_no: [num, { int: true, min: 0, max: 100 }],
  side: oneOf(['LEFT', 'RIGHT', 'FRONT', 'BACK', 'CENTER']),
  description: [str, { max: 400 }],
  is_active: [bool, { default: true }],
  sort_order: [num, { int: true, min: 0, max: 9999 }],
};

router.get('/locations/tree', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const whId = req.query.warehouse_id ? Number(req.query.warehouse_id) : null;
  const maxDepth = req.query.max_depth ? Number(req.query.max_depth) : 3;
  const rows = await db.all(
    `SELECT l.id, l.kind, l.code, l.full_code, l.label_path, l.depth, l.capacity_items, l.occupancy_items, l.status, l.parent_location_id, l.ref_id,
            (SELECT COUNT(*) FROM tooling_items t WHERE t.location_id = l.id AND t.deleted_at IS NULL) AS direct_items,
            (SELECT COUNT(*) FROM tooling_locations c WHERE c.parent_location_id = l.id) AS child_count
     FROM tooling_locations l
     WHERE (? IS NULL OR l.warehouse_id = ?) AND l.depth <= ?
     ORDER BY l.full_code LIMIT 3000`,
    [whId, whId, maxDepth],
  );
  const byParent = new Map();
  for (const r of rows) {
    const node = withFill({ ...r, items_total: Number(r.direct_items) });
    const list = byParent.get(r.parent_location_id) ?? [];
    list.push(node);
    byParent.set(r.parent_location_id, list);
  }
  const build = (parentId, guard = 0) => {
    if (guard > 8) return [];
    return (byParent.get(parentId) ?? []).map((n) => {
      const kids = build(n.id, guard + 1);
      const subItems = kids.reduce((s, k) => s + (k.items_total ?? 0), 0);
      return { ...n, children: kids, items_total: Number(n.direct_items) + subItems };
    });
  };
  const locByWh = new Map();
  for (const l of await db.all(
    `SELECT l.id AS location_id, l.ref_id FROM tooling_locations l WHERE l.kind = 'WAREHOUSE'`,
  )) {
    locByWh.set(Number(l.ref_id), l.location_id);
  }
  const warehouseRows = whId
    ? await db.all('SELECT id AS ref_id, code, name, warehouse_type, address, is_active FROM warehouses WHERE id = ?', [whId])
    : await db.all('SELECT id AS ref_id, code, name, warehouse_type, address, is_active FROM warehouses ORDER BY sort_order, code');
  const warehouses = warehouseRows.map((w) => {
    const locId = locByWh.get(Number(w.ref_id)) ?? null;
    return {
      ...w,
      id: locId,
      location_id: locId,
      kind: 'WAREHOUSE',
      full_code: w.code,
      label_path: w.name,
      children: locId ? build(locId) : [],
    };
  });
  res.json({
    warehouses: warehouses.map((w) => ({
      ...w,
      items_total: (w.children ?? []).reduce((sum, c) => sum + (c.items_total ?? 0), 0),
      child_count: (w.children ?? []).length,
    })),
    total_locations: rows.length,
  });
}));

router.get('/locations/levels', asyncRoute(async (req, res) => {
  const stats = await db.all(
    `SELECT kind, COUNT(*) AS nodes, SUM(COALESCE(capacity_items,0)) AS capacity, SUM(occupancy_items) AS occupied
     FROM tooling_locations GROUP BY kind ORDER BY depth`,
  );
  res.json({
    kinds: KINDS,
    levels: KINDS.map((k, i) => {
      const row = stats.find((x) => x.kind === k) ?? {};
      return { kind: k, level: i, name: { WAREHOUSE: 'Warehouse', ROW: 'Row', RACK: 'Rack', SHELF: 'Shelf', BOX: 'Box' }[k], nodes: Number(row.nodes ?? 0), capacity: Number(row.capacity ?? 0), occupied: Number(row.occupied ?? 0) };
    }),
  });
}));

router.get('/locations/resolve/:ref', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const loc = await getLocation(decodeURIComponent(req.params.ref));
  res.json({ location: withFill(loc), counts: await countsFor(loc.id) });
}));

router.get('/locations/:id', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const detail = await locationDetail(req.params.id);
  const parentChain = [];
  let cursor = detail.location.parent_location_id;
  let guard = 0;
  while (cursor && guard++ < 8) {
    const row = await db.one('SELECT id, code, full_code, kind, parent_location_id FROM tooling_locations WHERE id = ?', [cursor]);
    if (!row) break;
    parentChain.unshift(withFill({ ...row, capacity_items: null, occupancy_items: null }));
    cursor = row.parent_location_id;
  }
  res.json({
    ...detail,
    location: withFill(detail.location),
    children: (detail.children ?? []).map(withFill),
    parent_chain: parentChain,
    counts: await countsFor(detail.location.id),
  });
}));

router.post('/locations', requirePermission('locations.manage'), asyncRoute(async (req, res) => {
  const data = validate(NODE_SCHEMA, req.body);
  const out = await createNode({
    kind: data.kind,
    parent_id: data.parent_location_id,
    code: data.code,
    label: data.label ?? data.code,
    capacity_items: data.capacity_items ?? null,
    max_weight_kg: data.max_weight_kg ?? null,
    level_no: data.level_no ?? null,
    side: data.side ?? null,
    description: data.description ?? null,
  });
  await audit(req.ctx, { action: 'create', entityType: 'tooling_location', entityId: out?.id ?? null, entityLabel: out?.full_code, summary: `${data.kind} ${out?.full_code ?? data.code} created` });
  res.status(201).json(out);
}));

router.put('/locations/:id', requirePermission('locations.manage'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'location id');
  const loc = await getLocation(id);
  const data = validate(
    {
      code: [str, { max: 20, upper: true, pattern: /^[A-Z0-9-]+$/ }],
      label: [str, { max: 120 }],
      capacity_items: [num, { int: true, min: 0, max: 100000 }],
      max_weight_kg: [num, { min: 0 }],
      height_mm: [num, { int: true, min: 0, max: 100000 }],
      level_no: [num, { int: true, min: 0, max: 100 }],
      side: oneOf(['LEFT', 'RIGHT', 'FRONT', 'BACK', 'CENTER']),
      description: [str, { max: 400 }],
      is_active: [bool],
      sort_order: [num, { int: true, min: 0, max: 9999 }],
      status: oneOf(['AVAILABLE', 'ACTIVE', 'MAINTENANCE', 'BLOCKED', 'FULL', 'DISABLED']),
    },
    req.body,
    { partial: true },
  );
  if (!Object.keys(data).length) throw badRequest('Nothing to update');
  if (loc.kind === 'WAREHOUSE') {
    await db.run('UPDATE warehouses SET name = COALESCE(?, name) WHERE id = ?', [data.label ?? null, loc.ref_id]);
    await db.run('UPDATE tooling_locations SET label_path = COALESCE(?, label_path) WHERE id = ?', [data.label ?? null, loc.id]);
  } else {
    if (data.status) {
      await db.run('UPDATE tooling_locations SET status = ? WHERE id = ?', [data.status === 'ACTIVE' ? 'AVAILABLE' : data.status, loc.id]);
      delete data.status;
    }
    if (!Object.keys(data).length) data.label = data.label ?? null;
    await updateNodeLocation(loc.ref_id, loc.kind, data, req.ctx);
  }
  await audit(req.ctx, { action: 'update', entityType: 'tooling_location', entityId: loc.id, entityLabel: loc.full_code, summary: `${loc.kind} ${loc.full_code} updated` });
  res.json(withFill(await getLocation(loc.id)));
}));

router.delete('/locations/:id', requirePermission('locations.manage'), asyncRoute(async (req, res) => {
  const loc = await getLocation(req.params.id);
  if (loc.kind === 'WAREHOUSE') {
    const used = await db.value('SELECT COUNT(*) c FROM tooling_locations WHERE warehouse_id = ?', [loc.ref_id]);
    if (Number(used) > 0) throw badRequest(`Warehouse still contains ${used} location(s) - delete those first`);
    await db.run('UPDATE warehouses SET is_active = 0 WHERE id = ?', [loc.ref_id]);
    await audit(req.ctx, { action: 'archive', entityType: 'tooling_location', entityId: loc.id, entityLabel: loc.full_code, summary: `Warehouse ${loc.code} deactivated` });
    return res.json({ ok: true, deactivated: loc.full_code });
  }
  const out = await deleteNode(loc.kind, loc.ref_id, req.ctx);
  res.json({ ok: true, ...out });
}));

router.post('/locations/:id/move-contents', requirePermission('tooling.move'), asyncRoute(async (req, res) => {
  const from = await getLocation(req.params.id);
  const data = validate({ to: [str, { required: true, max: 200 }], note: [str, { max: 400 }], only_status: oneOf(['AVAILABLE', 'IN_USE', 'MAINTENANCE', 'DAMAGED', 'MISSING', 'RESERVED']) }, req.body);
  const to = await getLocation(data.to);
  const moved = await moveContents({ fromId: from.id, toId: to.id, onlyStatus: data.only_status ?? null, ctx: req.ctx, note: data.note ?? null });
  await audit(req.ctx, { action: 'bulk_move', entityType: 'tooling_location', entityId: from.id, entityLabel: from.full_code, summary: `Moved ${moved} tooling item(s) from ${from.full_code} to ${to.full_code}` });
  res.json({ ok: true, moved, from: from.full_code, to: to.full_code });
}));

/* -------------------------------------------------------- auto-generate */
router.post('/locations/auto-generate', requirePermission('locations.manage'), asyncRoute(async (req, res) => {
  const data = validate(
    {
      warehouse: [str, { required: true, max: 60 }],
      rows: [num, { int: true, min: 1, max: 60, required: true }],
      racks_per_row: [num, { int: true, min: 1, max: 60, required: true }],
      shelves_per_rack: [num, { int: true, min: 1, max: 40 }],
      boxes_per_shelf: [num, { int: true, min: 0, max: 40 }],
      capacity_per_box: [num, { int: true, min: 1, max: 10000 }],
      capacity_per_shelf: [num, { int: true, min: 1, max: 10000 }],
      prefix: [str, { max: 10, upper: true }],
      dry_run: [bool, { default: false }],
    },
    req.body,
  );
  const out = await autoGenerateLayout(data.warehouse, {
    rows: data.rows,
    racksPerRow: data.racks_per_row,
    shelvesPerRack: data.shelves_per_rack ?? 4,
    boxesPerShelf: data.boxes_per_shelf ?? 0,
    capacityPerBox: data.capacity_per_box ?? 8,
    capacityPerShelf: data.capacity_per_shelf ?? null,
    prefix: data.prefix ?? null,
    dryRun: data.dry_run,
  });
  if (!data.dry_run) {
    await audit(req.ctx, { action: 'auto_generate', entityType: 'tooling_location', summary: `Auto-generated ${out.created} location(s) in ${out.warehouse} (skipped ${out.skipped} existing)` });
  }
  res.json(out);
}));

/* ---------------------------------------------------------- map + layout */
router.get('/warehouses/:id/map', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const map = await warehouseMap(req.params.id);
  res.json(map);
}));

router.get('/warehouses/:id/layout', requirePermission('*.read'), asyncRoute(async (req, res) => {
  res.json(await getLayout(req.params.id));
}));

/**
 * Storage-map cell list. The validator contract is (value, field, out, errors): a field the caller
 * omitted is left as null so a settings-only save cannot move or clear the placed cells, and a
 * submitted list is applied additively - cells that are not mentioned keep their position.
 */
function layoutItems(value, field, out, errors) {
  if (value === undefined || value === null) {
    out[field] = null;
    return;
  }
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array of { location_id, x, y, w, color }`);
    return;
  }
  out[field] = value.slice(0, 4000).map((it) => ({
    id: Number(it?.location_id ?? it?.id ?? 0),
    x: Number(it?.x ?? 0),
    y: Number(it?.y ?? 0),
    w: Number(it?.w ?? 1),
    color: typeof it?.color === 'string' ? it.color.slice(0, 20) : null,
  }));
}

router.put('/warehouses/:id/layout', requirePermission('locations.manage'), asyncRoute(async (req, res) => {
  const data = validate(
    {
      background_document_id: [idRef, {}],
      clear_background: [bool, { default: false }],
      grid_cols: [num, { int: true, min: 1, max: 100 }],
      grid_rows: [num, { int: true, min: 1, max: 100 }],
      cell_size_px: [num, { int: true, min: 20, max: 200 }],
      note: [str, { max: 500 }],
      items: layoutItems,
    },
    req.body,
  );
  const result = await upsertLayout(req.params.id, data);
  await audit(req.ctx, { action: 'update', entityType: 'warehouse_layout', entityId: result.warehouse_id, summary: `Storage map saved: ${result.updated} cell(s) placed, ${result.skipped} skipped` });
  res.json(result);
}));

/* ------------------------------------------------------------- label codes */
router.get('/locations/:id/qr', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const loc = await getLocation(req.params.id);
  const payload = await payloadFor('location', loc.full_code, req);
  res.type('image/svg+xml').send(await qrSvg(payload, { width: Number(req.query.width || 220) }));
}));

router.get('/locations/:id/barcode', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const loc = await getLocation(req.params.id);
  res.type('image/svg+xml').send(await barcodeSvg(loc.full_code, { height: Number(req.query.height || 50) }));
}));

export default router;
