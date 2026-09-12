/** Warehouse location service: hierarchy, map, contents, smart suggestions (spec §13-§16, §46). */
import db from '../db/index.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';
import { refreshOccupancy, refreshSetStatuses } from '../seeds/demo.js';
import { audit } from './audit.js';

export const KINDS = ['WAREHOUSE', 'ROW', 'RACK', 'SHELF', 'BOX'];
const PARENT_OF = { ROW: 'WAREHOUSE', RACK: 'ROW', SHELF: 'RACK', BOX: 'SHELF' };
const CHILD_TABLE = { ROW: 'warehouse_rows', RACK: 'warehouse_racks', SHELF: 'warehouse_shelves', BOX: 'warehouse_boxes' };
const FK_OF = { ROW: 'warehouse_id', RACK: 'row_id', SHELF: 'rack_id', BOX: 'shelf_id' };

export async function listLocations({ kind = null, warehouse_id = null, search = null, only_occupied = false, limit = 200 } = {}) {
  const where = ['1=1'];
  const params = [];
  if (kind) {
    where.push('l.kind = ?');
    params.push(String(kind).toUpperCase());
  }
  if (warehouse_id) {
    where.push('l.warehouse_id = ?');
    params.push(Number(warehouse_id));
  }
  if (search) {
    where.push('(l.full_code LIKE ? OR l.label_path LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  if (only_occupied) where.push('l.occupancy_items > 0');
  const rows = await db.all(
    `SELECT l.*, (SELECT COUNT(*) FROM tooling_items ti WHERE ti.location_id = l.id AND ti.deleted_at IS NULL) AS direct_items
     FROM tooling_locations l WHERE ${where.join(' AND ')} ORDER BY l.full_code LIMIT ?`,
    [...params, Number(limit) || 200],
  );
  return rows;
}

export async function getLocation(ref) {
  const numeric = Number(ref);
  const row = Number.isInteger(numeric) && numeric > 0
    ? await db.one('SELECT * FROM tooling_locations WHERE id = ?', [numeric])
    : await db.one('SELECT * FROM tooling_locations WHERE full_code = ? OR code = ?', [String(ref).toUpperCase(), String(ref).toUpperCase()]);
  if (!row) throw notFound(`Location ${ref} not found`);
  return row;
}

export async function locationDetail(ref) {
  const exec = await db.rawDriver.executor();
  const loc = await getLocation(ref);
  const children = await exec.all('SELECT * FROM tooling_locations WHERE parent_location_id = ? ORDER BY kind, full_code', [loc.id]);
  const items = await exec.all(
    `SELECT t.id, t.tooling_id, t.name, t.status, t.condition_rating, t.quantity, t.serial_number,
            tt.code AS type_code, tt.name AS type_name, tt.icon,
            f.internal_number AS filter_number, f.name AS filter_name,
            (SELECT im.id FROM tooling_images im WHERE im.owner_type='TOOLING' AND im.owner_id=t.id ORDER BY im.is_primary DESC LIMIT 1) AS primary_image_id,
            d.overall_length_mm, d.overall_width_mm, d.overall_height_mm
     FROM tooling_items t
     JOIN tooling_types tt ON tt.id = t.tooling_type_id
     LEFT JOIN filters f ON f.id = t.primary_filter_id
     LEFT JOIN tooling_dimensions d ON d.tooling_item_id = t.id
     WHERE t.location_id = ? AND t.deleted_at IS NULL ORDER BY t.tooling_id`,
    [loc.id],
  );
  const capacity = loc.capacity_items ?? (await capacityOf(exec, loc));
  return {
    location: { ...loc, capacity_items: capacity, occupancy_items: Number(loc.occupancy_items ?? 0) },
    children: children.map((c) => ({ ...c, fill_pct: c.capacity_items ? Math.round((Number(c.occupancy_items) / Number(c.capacity_items)) * 100) : null })),
    items,
    parent: loc.parent_location_id ? await exec.one('SELECT * FROM tooling_locations WHERE id = ?', [loc.parent_location_id]) : null,
    stock: await exec.all(
      `SELECT ii.sku, ii.name, ii.unit, SUM(i.quantity) AS quantity, COUNT(*) AS stock_rows
       FROM inventory i JOIN inventory_items ii ON ii.id = i.inventory_item_id
       WHERE i.location_id = ? OR (i.location_id IS NULL AND ? IS NULL)
       GROUP BY ii.id, ii.sku, ii.name, ii.unit ORDER BY quantity DESC LIMIT 50`,
      [loc.id, loc.id],
    ),
  };
}

async function capacityOf(exec, loc) {
  if (loc.kind === 'SHELF' || loc.kind === 'BOX') {
    const row = await exec.one('SELECT capacity_items FROM tooling_locations WHERE id = ?', [loc.id]);
    return row?.capacity_items ?? null;
  }
  const v = await exec.value('SELECT SUM(COALESCE(capacity_items,0)) c FROM tooling_locations WHERE parent_location_id = ? AND kind = ?', [
    loc.id,
    KINDS[KINDS.indexOf(loc.kind) + 1] ?? 'BOX',
  ]);
  return Number(v ?? 0) || null;
}

/** Visual storage map (spec §14). */
export async function warehouseMap(warehouseRef) {
  const exec = await db.rawDriver.executor();
  const numeric = Number(warehouseRef);
  const wh = Number.isInteger(numeric) && numeric > 0
    ? await exec.one('SELECT * FROM warehouses WHERE id = ?', [numeric])
    : await exec.one('SELECT * FROM warehouses WHERE code = ? OR name = ?', [String(warehouseRef).toUpperCase(), warehouseRef]);
  if (!wh) throw notFound('Warehouse not found');
  const rows = await exec.all('SELECT * FROM warehouse_rows WHERE warehouse_id = ? AND is_active = 1 ORDER BY sort_order, code', [wh.id]);
  const racks = await exec.all(
    `SELECT r.*, l.full_code, l.occupancy_items, l.capacity_items, l.status FROM warehouse_racks r
     JOIN tooling_locations l ON l.kind = 'RACK' AND l.ref_id = r.id
     JOIN warehouse_rows w ON w.id = r.row_id WHERE w.warehouse_id = ? ORDER BY r.sort_order, r.code`,
    [wh.id],
  );
  const shelves = await exec.all(
    `SELECT s.*, l.full_code, l.occupancy_items, l.capacity_items, l.status, l.id AS location_id,
            k.code AS rack_code, k.row_id
     FROM warehouse_shelves s
     JOIN tooling_locations l ON l.kind = 'SHELF' AND l.ref_id = s.id
     JOIN warehouse_racks k ON k.id = s.rack_id
     JOIN warehouse_rows w ON w.id = k.row_id
     WHERE w.warehouse_id = ? ORDER BY k.code, s.code`,
    [wh.id],
  );
  const byRack = new Map();
  for (const s of shelves) {
    const list = byRack.get(s.rack_id) ?? [];
    list.push(s);
    byRack.set(s.rack_id, list);
  }
  const byRow = new Map();
  for (const r of racks) {
    const list = byRow.get(r.row_id) ?? [];
    list.push({ ...r, shelves: byRack.get(r.id) ?? [] });
    byRow.set(r.row_id, list);
  }
  return {
    warehouse: wh,
    rows: rows.map((r) => {
      const rackList = byRow.get(r.id) ?? [];
      const occupancy = rackList.reduce((sum, k) => sum + Number(k.occupancy_items ?? 0), 0);
      const capacity = rackList.reduce((sum, k) => sum + Number(k.capacity_items ?? 0), 0);
      return {
        ...r,
        racks: rackList.map((k) => ({
          ...k,
          shelves: k.shelves.map((s) => ({
            ...s,
            fill_pct: s.capacity_items ? Math.round((Number(s.occupancy_items) / Number(s.capacity_items)) * 100) : null,
            tooling: undefined,
          })),
        })),
        occupancy,
        capacity: capacity || null,
        fill_pct: capacity ? Math.round((occupancy / capacity) * 100) : null,
      };
    }),
    totals: await exec.one(
      `SELECT COUNT(*) AS locations, COALESCE(SUM(occupancy_items),0) AS items FROM tooling_locations WHERE warehouse_id = ? AND kind IN ('SHELF','BOX')`,
      [wh.id],
    ),
  };
}

/** Create / rename / archive a level in the hierarchy. Keeps `tooling_locations` in sync. */
export async function createNode({ kind, parent_id, code, label, capacity_items = null, max_weight_kg = null, level_no = null, side = null, description = null }) {
  const exec = await db.rawDriver.executor();
  if (!CHILD_TABLE[kind]) throw badRequest('kind must be ROW, RACK, SHELF or BOX');
  const parentKind = PARENT_OF[kind];
  const parentId = Number(parent_id);
  if (!Number.isInteger(parentId) || parentId <= 0) throw badRequest(`parent_location_id is required - pass the id of the ${parentKind.toLowerCase()} this ${kind.toLowerCase()} belongs to`);
  const parent = await exec.one('SELECT * FROM tooling_locations WHERE id = ?', [parentId]);
  if (!parent) throw badRequest(`Parent location #${parentId} does not exist - pick a ${parentKind.toLowerCase()} in the storage map`);
  if (parent.kind !== parentKind) {
    throw badRequest(`A ${kind.toLowerCase()} must sit inside a ${parentKind.toLowerCase()} - #${parentId} (${parent.full_code}) is a ${String(parent.kind).toLowerCase()}`);
  }
  const table = CHILD_TABLE[kind];
  const fk = FK_OF[kind];
  const upper = String(code).toUpperCase();
  const dupe = await exec.one(`SELECT id FROM ${table} WHERE ${fk} = ? AND code = ?`, [parent.ref_id, upper]);
  if (dupe) throw conflict(`${kind} ${upper} already exists under ${parent.full_code}`);
  const cols = { [fk]: parent.ref_id, code: upper, label: label ?? upper };
  if (kind === 'SHELF') {
    cols.capacity_items = capacity_items ?? 10;
    cols.max_weight_kg = max_weight_kg;
    cols.level_no = level_no ?? ((await exec.value(`SELECT MAX(COALESCE(level_no,0)) m FROM warehouse_shelves WHERE rack_id = ?`, [parent.ref_id])) + 1);
    if (capacity_items === null) cols.capacity_items = 10;
  }
  if (kind === 'BOX') cols.capacity_items = capacity_items ?? 2;
  if (kind === 'RACK') cols.side = side;
  if (kind === 'ROW') cols.description = description;
  const keys = Object.keys(cols);
  const res = await exec.run(`INSERT INTO ${table} (${keys.map((k) => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => cols[k]));
  const refId = res.insertId;
  if (!refId) throw new Error('Could not determine new location id');
  await syncLocationNode(exec, kind, refId);
  await refreshOccupancy(exec);
  return exec.one('SELECT * FROM tooling_locations WHERE kind = ? AND ref_id = ?', [kind, refId]);
}

/** Recompute the materialised path row for one hierarchy node. */
export async function syncLocationNode(exec, kind, refId) {
  const table = CHILD_TABLE[kind];
  const node = await exec.one(`SELECT * FROM ${table} WHERE id = ?`, [Number(refId)]);
  if (!node) return null;
  const parentLoc = await findParentLocation(exec, kind, node);
  const fullCode = parentLoc ? `${parentLoc.full_code}-${node.code}` : node.code;
  const labelPath = parentLoc ? `${parentLoc.label_path ?? parentLoc.full_code} / ${node.label || node.code}` : node.label || node.code;
  const ids = await hierarchyIds(exec, kind, node);
  const capacity = node.capacity_items ?? null;
  await exec.run(
    `INSERT INTO tooling_locations (kind, code, full_code, label_path, ref_id, warehouse_id, row_id, rack_id, shelf_id, box_id, parent_location_id, depth, capacity_items, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'AVAILABLE')
     ON DUPLICATE KEY UPDATE full_code=VALUES(full_code), label_path=VALUES(label_path), capacity_items=VALUES(capacity_items),
       parent_location_id=VALUES(parent_location_id), warehouse_id=VALUES(warehouse_id), row_id=VALUES(row_id), rack_id=VALUES(rack_id),
       shelf_id=VALUES(shelf_id), box_id=VALUES(box_id), updated_at=NOW()`,
    [
      kind,
      node.code,
      fullCode,
      labelPath,
      node.id,
      ids.warehouse_id,
      ids.row_id,
      ids.rack_id,
      ids.shelf_id,
      ids.box_id,
      parentLoc?.id ?? null,
      KINDS.indexOf(kind),
      capacity,
    ],
  );
  return exec.one('SELECT * FROM tooling_locations WHERE kind = ? AND ref_id = ?', [kind, node.id]);
}

async function findParentLocation(exec, kind, node) {
  const parentKind = PARENT_OF[kind];
  if (!parentKind) return null;
  const fk = { ROW: 'warehouse_id', RACK: 'row_id', SHELF: 'rack_id', BOX: 'shelf_id' }[kind];
  return exec.one('SELECT * FROM tooling_locations WHERE kind = ? AND ref_id = ?', [parentKind, node[fk]]);
}

async function hierarchyIds(exec, kind, node) {
  const out = { warehouse_id: null, row_id: null, rack_id: null, shelf_id: null, box_id: null };
  if (kind === 'ROW') {
    out.warehouse_id = node.warehouse_id;
    out.row_id = node.id;
  } else if (kind === 'RACK') {
    const row = await exec.one('SELECT * FROM warehouse_rows WHERE id = ?', [node.row_id]);
    out.row_id = node.row_id;
    out.warehouse_id = row?.warehouse_id ?? null;
    out.rack_id = node.id;
  } else if (kind === 'SHELF') {
    const rack = await exec.one('SELECT * FROM warehouse_racks WHERE id = ?', [node.rack_id]);
    const row = rack ? await exec.one('SELECT * FROM warehouse_rows WHERE id = ?', [rack.row_id]) : null;
    out.rack_id = node.rack_id;
    out.row_id = rack?.row_id ?? null;
    out.warehouse_id = row?.warehouse_id ?? null;
    out.shelf_id = node.id;
  } else if (kind === 'BOX') {
    const shelf = await exec.one('SELECT * FROM warehouse_shelves WHERE id = ?', [node.shelf_id]);
    const rack = shelf ? await exec.one('SELECT * FROM warehouse_racks WHERE id = ?', [shelf.rack_id]) : null;
    const row = rack ? await exec.one('SELECT * FROM warehouse_rows WHERE id = ?', [rack.row_id]) : null;
    out.shelf_id = node.shelf_id;
    out.rack_id = shelf?.rack_id ?? null;
    out.row_id = rack?.row_id ?? null;
    out.warehouse_id = row?.warehouse_id ?? null;
    out.box_id = node.id;
  }
  return out;
}

export async function updateNodeLocation(refId, kind, changes, ctx) {
  const exec = await db.rawDriver.executor();
  const table = CHILD_TABLE[kind];
  if (!table) throw badRequest('Unsupported location kind');
  const before = await exec.one(`SELECT * FROM ${table} WHERE id = ?`, [Number(refId)]);
  if (!before) throw notFound('Location not found');
  const allowed = { ROW: ['code', 'label', 'description', 'is_active', 'sort_order'], RACK: ['code', 'label', 'side', 'is_active', 'sort_order'], SHELF: ['code', 'label', 'capacity_items', 'max_weight_kg', 'level_no', 'height_mm', 'is_active'], BOX: ['code', 'label', 'capacity_items', 'is_active'] }[kind];
  const keys = Object.keys(changes).filter((k) => allowed.includes(k));
  if (!keys.length) throw badRequest('No editable fields supplied');
  for (const k of keys) {
    if (changes[k] === before[k]) continue;
    await exec.run(`UPDATE ${table} SET \`${k}\` = ? WHERE id = ?`, [changes[k], before.id]);
    await audit(ctx, { action: 'update', entityType: `location.${kind.toLowerCase()}`, entityId: before.id, entityLabel: before.code, field: k, oldValue: before[k], newValue: changes[k], summary: `Location ${kind} ${before.code}: ${k} changed` });
  }
  await syncLocationNode(exec, kind, before.id);
  if (changes.code) await reparentPaths(exec, kind, before.id);
  await refreshOccupancy(exec);
  return exec.one('SELECT * FROM tooling_locations WHERE kind = ? AND ref_id = ?', [kind, before.id]);
}

/** After a code change, refresh descendant paths. */
async function reparentPaths(exec, kind, refId) {
  const loc = await exec.one('SELECT * FROM tooling_locations WHERE kind = ? AND ref_id = ?', [kind, refId]);
  if (!loc) return;
  const childKind = KINDS[KINDS.indexOf(kind) + 1];
  if (!childKind) return;
  const children = await exec.all('SELECT ref_id FROM tooling_locations WHERE parent_location_id = ? AND kind = ?', [loc.id, childKind]);
  for (const c of children) {
    await syncLocationNode(exec, childKind, c.ref_id);
    await reparentPaths(exec, childKind, c.ref_id);
  }
}

export async function deleteNode(kind, refId, ctx) {
  const exec = await db.rawDriver.executor();
  const table = CHILD_TABLE[kind];
  const node = await exec.one(`SELECT * FROM ${table} WHERE id = ?`, [Number(refId)]);
  if (!node) throw notFound('Location not found');
  const loc = await exec.one('SELECT id FROM tooling_locations WHERE kind = ? AND ref_id = ?', [kind, node.id]);
  const occupants = loc ? await exec.value('SELECT COUNT(*) c FROM tooling_items WHERE location_id = ? AND deleted_at IS NULL', [loc.id]) : 0;
  if (Number(occupants) > 0) throw conflict(`${node.code} still holds ${occupants} tooling item(s) - move them out first`);
  const childKind = KINDS[KINDS.indexOf(kind) + 1];
  if (childKind && loc) {
    const kids = await exec.value('SELECT COUNT(*) c FROM tooling_locations WHERE parent_location_id = ? AND kind = ?', [loc.id, childKind]);
    if (Number(kids) > 0) throw conflict(`${node.code} still has ${kids} ${childKind.toLowerCase()}(s) below it - remove those first`);
  }
  await exec.run(`DELETE FROM ${table} WHERE id = ?`, [node.id]);
  if (loc) await exec.run('DELETE FROM tooling_locations WHERE id = ?', [loc.id]);
  await refreshOccupancy(exec);
  await audit(ctx, { action: 'delete', entityType: `location.${kind.toLowerCase()}`, entityId: node.id, entityLabel: node.code, summary: `Removed ${kind} ${node.code}` });
  return { removed: node.code };
}

/** Spec §46 - suggest a place for a new/returning tool, with a human reason. */
export async function suggest({ tooling_id = null, tooling_set_id = null, filter_id = null, type_code = null, length_mm = null, width_mm = null } = {}) {
  const exec = await db.rawDriver.executor();
  const reasons = [];
  const scored = new Map();
  const bump = (id, delta, why) => {
    const row = scored.get(id) ?? { score: 0, reasons: [] };
    row.score += delta;
    row.reasons.push(why);
    scored.set(id, row);
  };

  if (filter_id) {
    const siblings = await exec.all(
      `SELECT l.id, COUNT(*) AS cnt, MIN(f.internal_number) AS filter_number
       FROM tooling_items t
       JOIN tooling_compatibility c ON c.tooling_item_id = t.id
       JOIN tooling_locations l ON l.id = t.location_id
       LEFT JOIN filters f ON f.id = t.primary_filter_id
       WHERE c.filter_id = ? AND t.deleted_at IS NULL AND t.location_id IS NOT NULL
       GROUP BY l.id ORDER BY cnt DESC LIMIT 3`,
      [Number(filter_id)],
    );
    for (const s of siblings) bump(s.id, 120 + Number(s.cnt) * 8, `other tooling for ${s.filter_number ?? 'this filter'} is stored here (${s.cnt} item${Number(s.cnt) > 1 ? 's' : ''})`);
  }
  if (tooling_set_id) {
    const setSiblings = await exec.all(
      `SELECT location_id AS id, COUNT(*) cnt FROM tooling_items WHERE tooling_set_id = ? AND location_id IS NOT NULL AND deleted_at IS NULL GROUP BY location_id ORDER BY cnt DESC LIMIT 3`,
      [Number(tooling_set_id)],
    );
    for (const s of setSiblings) bump(s.id, 90 + Number(s.cnt) * 6, 'same tooling set');
  }
  if (type_code) {
    const zone = await exec.all(
      `SELECT t.location_id AS id, COUNT(*) cnt FROM tooling_items t JOIN tooling_types ty ON ty.id = t.tooling_type_id
       WHERE ty.code = ? AND t.location_id IS NOT NULL AND t.deleted_at IS NULL GROUP BY t.location_id ORDER BY cnt DESC LIMIT 5`,
      [String(type_code).toUpperCase()],
    );
    for (const z of zone) bump(z.id, 40 + Number(z.cnt), `other ${type_code} tooling uses this shelf (type zone)`);
  }
  const free = await exec.all(
    `SELECT l.id, (l.capacity_items - l.occupancy_items) AS free_space FROM tooling_locations l
     WHERE l.kind IN ('SHELF','BOX') AND l.capacity_items IS NOT NULL AND l.occupancy_items < l.capacity_items
     ORDER BY free_space DESC LIMIT 12`,
  );
  for (const f of free) bump(f.id, 12 + Math.min(20, Number(f.free_space) * 2), `${f.free_space} free place(s)`);
  if (length_mm && width_mm) {
    reasons.push('largest free shelf chosen for the given footprint');
  }
  const list = await Promise.all(
    [...scored.entries()].map(async ([id, v]) => {
      const loc = await exec.one('SELECT * FROM tooling_locations WHERE id = ?', [id]);
      if (!loc) return null;
      return {
        location_id: loc.id,
        full_code: loc.full_code,
        label_path: loc.label_path,
        kind: loc.kind,
        capacity_items: loc.capacity_items,
        occupancy_items: loc.occupancy_items,
        free_space: loc.capacity_items ? Number(loc.capacity_items) - Number(loc.occupancy_items) : null,
        score: v.score,
        reason: v.reasons.join('; '),
      };
    }),
  );
  return list.filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 5);
}

export async function toolsAtLocation(locationId, { include_children = true } = {}) {
  return db.all(
    `SELECT t.id, t.tooling_id, t.name, t.status, t.quantity, t.condition_rating, tt.name AS type_name, tt.code AS type_code, tt.icon,
            f.internal_number AS filter_number, l.full_code AS location_code, l.label_path AS location_path
     FROM tooling_items t
     JOIN tooling_types tt ON tt.id = t.tooling_type_id
     JOIN tooling_locations l ON l.id = t.location_id
     LEFT JOIN filters f ON f.id = t.primary_filter_id
     WHERE t.deleted_at IS NULL AND (${include_children ? 'l.id = ? OR l.parent_location_id = ?' : 'l.id = ?'})
     ORDER BY l.full_code, t.tooling_id LIMIT 300`,
    include_children ? [Number(locationId), Number(locationId)] : [Number(locationId)],
  );
}

export async function refreshAll() {
  const exec = await db.rawDriver.executor();
  await refreshOccupancy(exec);
  await refreshSetStatuses(exec);
  return true;
}

/* ------------------------------------------------------------- visual layout */

/** Storage-map grid + per-node placement (spec §14). */
export async function getLayout(warehouseRef) {
  const wh = await resolveWarehouse(warehouseRef);
  const exec = await db.rawDriver.executor();
  const layout =
    (await exec.one('SELECT * FROM warehouse_layouts WHERE warehouse_id = ?', [wh.id])) ?? {
      warehouse_id: wh.id,
      grid_cols: 12,
      grid_rows: 8,
      cell_size_px: 64,
      background_document_id: null,
      note: null,
    };
  const cells = await exec.all(
    `SELECT l.id AS location_id, l.kind, l.code, l.full_code, l.label_path, l.capacity_items, l.occupancy_items, l.status,
            l.map_row, l.map_col, l.map_span, l.map_color,
            COALESCE(r.sort_order, 999) AS row_sort
     FROM tooling_locations l
     LEFT JOIN warehouse_rows r ON r.id = l.row_id
     WHERE l.warehouse_id = ? AND l.kind IN ('ROW','RACK','SHELF')
     ORDER BY l.kind, l.full_code`,
    [wh.id],
  );
  const placed = cells.filter((c) => c.map_row !== null && c.map_col !== null);
  const unplaced = cells.filter((c) => c.map_row === null || c.map_col === null);
  return {
    warehouse: wh,
    layout,
    rows: cells
      .filter((c) => c.kind === 'ROW')
      .map((c) => ({
        ...c,
        fill_pct: c.capacity_items ? Math.round((Number(c.occupancy_items) / Number(c.capacity_items)) * 100) : null,
      })),
    placed,
    unplaced,
    cells: placed,
  };
}

/** Save grid settings and/or a batch of placements. Returns counts. */
export async function upsertLayout(warehouseRef, { grid_cols, grid_rows, cell_size_px, background_document_id, clear_background, note, items } = {}) {
  const wh = await resolveWarehouse(warehouseRef);
  const exec = await db.rawDriver.executor();
  // The layout row may not exist yet: create it with the schema defaults, then touch only the
  // fields the caller actually sent, so a settings-only save cannot blank the grid.
  await exec.run('INSERT IGNORE INTO warehouse_layouts (warehouse_id) VALUES (?)', [wh.id]);
  const sets = [];
  const params = [];
  const clampInt = (v, min, max) => {
    // The validator writes null for "field absent" - Number(null) is 0, which would silently
    // clamp a missing grid size to its minimum, so absence has to be tested before coercion.
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : null;
  };
  for (const [col, value] of [
    ['grid_cols', clampInt(grid_cols, 1, 100)],
    ['grid_rows', clampInt(grid_rows, 1, 100)],
    ['cell_size_px', clampInt(cell_size_px, 20, 200)],
  ]) {
    if (value !== null) {
      sets.push(`${col} = ?`);
      params.push(value);
    }
  }
  if (note !== undefined && note !== null) {
    sets.push('note = ?');
    params.push(note);
  }
  if (clear_background) sets.push('background_document_id = NULL');
  else if (background_document_id !== undefined && background_document_id !== null) {
    sets.push('background_document_id = ?');
    params.push(background_document_id);
  }
  if (sets.length) await exec.run(`UPDATE warehouse_layouts SET ${sets.join(', ')}, updated_at = NOW() WHERE warehouse_id = ?`, [...params, wh.id]);

  let updated = 0;
  let skipped = 0;
  for (const it of items ?? []) {
    if (!it.id) {
      skipped += 1;
      continue;
    }
    const loc = await exec.one('SELECT id, warehouse_id, kind FROM tooling_locations WHERE id = ?', [Number(it.id)]);
    if (!loc || Number(loc.warehouse_id) !== Number(wh.id)) {
      skipped += 1;
      continue;
    }
    await exec.run('UPDATE tooling_locations SET map_row = ?, map_col = ?, map_span = ?, map_color = ? WHERE id = ?', [
      Math.max(0, Math.min(500, Number(it.y ?? 0))),
      Math.max(0, Math.min(500, Number(it.x ?? 0))),
      Math.max(1, Math.min(20, Number(it.w ?? 1))),
      it.color ?? null,
      loc.id,
    ]);
    updated += 1;
  }
  const stored = await exec.one('SELECT grid_cols, grid_rows, cell_size_px, background_document_id, note FROM warehouse_layouts WHERE warehouse_id = ?', [wh.id]);
  return { warehouse_id: wh.id, updated, skipped, ...stored };
}

async function resolveWarehouse(ref) {
  const numeric = Number(ref);
  const wh =
    Number.isInteger(numeric) && numeric > 0
      ? await db.one('SELECT * FROM warehouses WHERE id = ?', [numeric])
      : await db.one('SELECT * FROM warehouses WHERE code = ? OR name = ?', [String(ref).toUpperCase(), ref]);
  if (!wh) throw notFound(`Warehouse ${ref} not found`);
  return wh;
}

/**
 * Build a whole row/rack/shelf/box grid under a warehouse (spec §13 bulk setup).
 * Returns the counts created/skipped; `dryRun` only reports what would happen.
 */
export async function autoGenerateLayout(
  warehouseRef,
  { rows = 4, racksPerRow = 6, shelvesPerRack = 4, boxesPerShelf = 0, capacityPerBox = 8, capacityPerShelf = null, prefix = null, dryRun = false } = {},
) {
  const wh = await resolveWarehouse(warehouseRef);
  const exec = await db.rawDriver.executor();
  const p = String(prefix ?? wh.code ?? 'W').toUpperCase();
  const plan = [];
  for (let r = 1; r <= rows; r++) {
    const rowCode = `R${String(r).padStart(2, '0')}`;
    const rowId = `LAYOUT:${p}:${rowCode}`;
    plan.push({ kind: 'ROW', code: rowCode, parent: wh.id, key: rowId });
    for (let k = 1; k <= racksPerRow; k++) {
      const rackCode = `RK${String(k).padStart(2, '0')}`;
      plan.push({ kind: 'RACK', code: rackCode, parent: rowId, key: `${rowId}:${rackCode}` });
      for (let s = 1; s <= shelvesPerRack; s++) {
        const shelfCode = `S${String(s).padStart(2, '0')}`;
        plan.push({
          kind: 'SHELF',
          code: shelfCode,
          parent: `${rowId}:${rackCode}`,
          key: `${rowId}:${rackCode}:${shelfCode}`,
          capacity_items: capacityPerShelf ?? shelvesPerRack * capacityPerBox,
        });
        for (let b = 1; b <= boxesPerShelf; b++) {
          const boxCode = `B${String(b).padStart(2, '0')}`;
          plan.push({ kind: 'BOX', code: boxCode, parent: `${rowId}:${rackCode}:${shelfCode}`, key: `${rowId}:${rackCode}:${shelfCode}:${boxCode}`, capacity_items: capacityPerBox });
        }
      }
    }
  }
  if (dryRun) return { dry_run: true, would_create: plan.length, by_kind: countByKind(plan), warehouse: wh.code };

  const idByCode = new Map();
  let created = 0;
  let skipped = 0;
  for (const node of plan) {
    const table = { ROW: 'warehouse_rows', RACK: 'warehouse_racks', SHELF: 'warehouse_shelves', BOX: 'warehouse_boxes' }[node.kind];
    const fk = { ROW: 'warehouse_id', RACK: 'row_id', SHELF: 'rack_id', BOX: 'shelf_id' }[node.kind];
    const parentRefId = node.kind === 'ROW' ? wh.id : idByCode.get(node.parent);
    if (!parentRefId) {
      skipped += 1;
      continue;
    }
    const existing = await exec.one(`SELECT id FROM ${table} WHERE ${fk} = ? AND code = ?`, [parentRefId, node.code]);
    let refId = existing?.id;
    if (!refId) {
      const cols = { [fk]: parentRefId, code: node.code, label: node.code };
      if (node.kind === 'SHELF') {
        cols.capacity_items = node.capacity_items ?? 10;
        cols.level_no = Number(node.code.replace(/\D+/g, '')) || 1;
      }
      if (node.kind === 'BOX') cols.capacity_items = capacityPerBox;
      const keys = Object.keys(cols);
      const res = await exec.run(`INSERT INTO ${table} (${keys.map((k) => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => cols[k]));
      refId = res.insertId ?? (await exec.value(`SELECT id FROM ${table} WHERE ${fk} = ? AND code = ?`, [parentRefId, node.code]));
      created += 1;
    } else skipped += 1;
    idByCode.set(node.key, refId);
    await syncLocationNode(exec, node.kind, refId);
  }
  await refreshOccupancy(exec);
  return { dry_run: false, created, skipped, total_planned: plan.length, by_kind: countByKind(plan), warehouse: wh.code };
}

const countByKind = (plan) => plan.reduce((acc, n) => ({ ...acc, [n.kind.toLowerCase()]: (acc[n.kind.toLowerCase()] ?? 0) + 1 }), {});

/** Move every (optionally status-filtered) tool from one location to another. */
export async function moveContents({ fromId, toId, onlyStatus = null, ctx = null, note = null }) {
  const exec = await db.rawDriver.executor();
  const from = await exec.one('SELECT * FROM tooling_locations WHERE id = ?', [Number(fromId)]);
  const to = await exec.one('SELECT * FROM tooling_locations WHERE id = ?', [Number(toId)]);
  if (!from || !to) throw badRequest('Unknown location id');
  const tools = await exec.all(
    `SELECT id, tooling_id, status, location_id FROM tooling_items WHERE deleted_at IS NULL AND location_id = ? ${onlyStatus ? 'AND status = ?' : ''}`,
    onlyStatus ? [Number(fromId), String(onlyStatus).toUpperCase()] : [Number(fromId)],
  );
  for (const t of tools) {
    await exec.run('UPDATE tooling_items SET location_id = ?, updated_at = NOW() WHERE id = ?', [to.id, t.id]);
    await exec.run(
      `INSERT INTO tooling_movements (tooling_item_id, movement_type, from_location_id, to_location_id, from_location_code, to_location_code,
                                      status_before, status_after, qty, note, user_id, username, created_at)
       VALUES (?, 'MOVE', ?,?,?,?,?,?,1,?,?,?,NOW())`,
      [t.id, from.id, to.id, from.full_code, to.full_code, t.status, t.status, note ?? `Bulk move ${from.full_code} -> ${to.full_code}`, ctx?.user?.id ?? null, ctx?.user?.username ?? 'system'],
    );
  }
  await refreshOccupancy(exec);
  return tools.length;
}
