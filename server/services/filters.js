/** Filter catalogue service: search blob maintenance, overview assembly, stock. */
import db from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { refreshSetStatuses } from '../seeds/demo.js';
import { FILTER_DIMENSION_FIELDS } from '../seeds/catalog.js';

export const FILTER_STATUSES = ['ACTIVE', 'INACTIVE', 'DEVELOPMENT', 'DISCONTINUED', 'OBSOLETE'];

export async function rebuildSearchBlob(exec, filterId) {
  const filter = await exec.one('SELECT id, internal_number, product_number, name, description FROM filters WHERE id = ?', [filterId]);
  if (!filter) return null;
  const xrefs = await exec.all('SELECT ref_number, ref_type FROM filter_cross_references WHERE filter_id = ?', [filterId]);
  const dims = await exec.one('SELECT * FROM filter_dimensions WHERE filter_id = ?', [filterId]);
  const tools = await exec.all(
    `SELECT ti.tooling_id FROM tooling_compatibility tc JOIN tooling_items ti ON ti.id = tc.tooling_item_id
     WHERE tc.filter_id = ? AND ti.deleted_at IS NULL ORDER BY tc.is_primary DESC, ti.tooling_id LIMIT 30`,
    [filterId],
  );
  const vehicles = await exec.all(
    `SELECT v.manufacturer, v.model, v.generation, v.engine, v.engine_code FROM filter_vehicle_applications fva JOIN vehicles v ON v.id = fva.vehicle_id WHERE fva.filter_id = ? LIMIT 40`,
    [filterId],
  );
  const parts = [
    filter.internal_number,
    filter.product_number,
    filter.name,
    ...xrefs.map((x) => `${x.ref_number} ${x.ref_type}`),
    tools.map((t) => t.tooling_id).join(' '),
    vehicles.map((v) => `${v.manufacturer} ${v.model} ${v.generation} ${v.engine} ${v.engine_code}`).join(' '),
  ];
  if (dims) {
    parts.push(`${dims.length_mm ?? ''}x${dims.width_mm ?? ''}x${dims.height_mm ?? ''}`, `D${dims.overall_diameter_mm ?? ''}`);
  }
  const blob = parts.filter(Boolean).join(' | ').slice(0, 2000);
  await exec.run('UPDATE filters SET search_blob = ? WHERE id = ?', [blob, filterId]);
  return blob;
}

export async function getFilterOr404(idOrCode) {
  const numeric = Number(idOrCode);
  const row = Number.isInteger(numeric) && numeric > 0
    ? await db.one(FILTER_SELECT + ' WHERE f.id = ?', [numeric])
    : await db.one(FILTER_SELECT + ' WHERE UPPER(f.internal_number) = ? OR UPPER(f.product_number) = ?', [String(idOrCode).toUpperCase(), String(idOrCode).toUpperCase()]);
  if (!row) throw notFound(`Filter ${idOrCode} not found`);
  return row;
}

export const FILTER_SELECT = `
  SELECT f.id, f.internal_number, f.product_number, f.name, f.description, f.status, f.is_active, f.notes,
         f.created_at, f.updated_at,
         ft.code AS type_code, ft.name AS type_name, ft.icon AS type_icon, ft.dimension_profile,
         b.code AS brand_code, b.name AS brand_name,
         ff.code AS family_code, ff.name AS family_name,
         cu.full_name AS created_by_name,
         (SELECT COUNT(*) FROM filter_cross_references x WHERE x.filter_id = f.id) AS xref_count,
         (SELECT COUNT(*) FROM filter_vehicle_applications a WHERE a.filter_id = f.id) AS application_count,
         (SELECT COUNT(*) FROM tooling_compatibility tc JOIN tooling_items ti ON ti.id = tc.tooling_item_id
            WHERE tc.filter_id = f.id AND ti.deleted_at IS NULL) AS tooling_count,
         (SELECT COUNT(*) FROM tooling_images im WHERE im.owner_type='FILTER' AND im.owner_id=f.id) AS image_count,
         (SELECT COUNT(*) FROM tooling_documents dc WHERE dc.owner_type='FILTER' AND dc.owner_id=f.id) AS document_count
  FROM filters f
  JOIN filter_types ft ON ft.id = f.filter_type_id
  LEFT JOIN brands b ON b.id = f.brand_id
  LEFT JOIN filter_families ff ON ff.id = f.family_id
  LEFT JOIN users cu ON cu.id = f.created_by`;

/**
 * THE central screen (spec §57): filter + dimensions + vehicles + required tooling with
 * live status/location + production readiness + packaging + stock, in one payload.
 */
/**
 * Filter dimensions are stored as DECIMAL so MariaDB hands them back as strings ("76.000").
 * Numbers out, strings for text fields - the UI and any API client can compare them directly.
 */
export function numericDimensions(row, fields) {
  if (!row) return row;
  const out = { ...row };
  for (const field of fields) {
    const value = out[field.key];
    if (value === null || value === undefined || field.type === 'text') continue;
    const n = Number(value);
    if (Number.isFinite(n)) out[field.key] = n;
  }
  return out;
}

export async function toolingOverview(filterId, { unit = 'mm' } = {}) {
  const exec = await db.rawDriver.executor();
  const filter = await exec.one(FILTER_SELECT + ' WHERE f.id = ?', [filterId]);
  if (!filter) throw notFound('Filter not found');
  const [dimensions, materials, xrefs, vehicles, requirements, images, documents, stock, packaging, orders] = await Promise.all([
    exec.one('SELECT * FROM filter_dimensions WHERE filter_id = ?', [filterId]),
    exec.one('SELECT * FROM filter_materials WHERE filter_id = ?', [filterId]),
    exec.all('SELECT x.*, b.name AS brand_name FROM filter_cross_references x LEFT JOIN brands b ON b.id = x.brand_id WHERE x.filter_id = ? ORDER BY x.ref_type, x.ref_number', [filterId]),
    exec.all(
      `SELECT v.id, v.manufacturer, v.model, v.generation, v.engine, v.engine_code, v.fuel, v.power_hp,
              IFNULL(fva.start_year, v.year_from) AS year_from, IFNULL(fva.end_year, v.year_to) AS year_to, fva.quantity_per_vehicle
       FROM filter_vehicle_applications fva JOIN vehicles v ON v.id = fva.vehicle_id
       WHERE fva.filter_id = ? ORDER BY v.manufacturer, v.model, year_from`,
      [filterId],
    ),
    exec.all(
      `SELECT r.id, r.quantity_required, r.is_mandatory, r.note, t.id AS tooling_type_id, t.code AS type_code, t.name AS type_name, t.icon
       FROM filter_tooling_requirements r JOIN tooling_types t ON t.id = r.tooling_type_id
       WHERE r.filter_id = ? ORDER BY t.sort_order, r.id`,
      [filterId],
    ),
    exec.all('SELECT id, view_type, caption, mime_type, size_bytes, is_primary, created_at FROM tooling_images WHERE owner_type = ? AND owner_id = ? ORDER BY is_primary DESC, sort_order', ['FILTER', filterId]),
    exec.all('SELECT id, doc_type, original_name, extension, mime_type, size_bytes, created_at FROM tooling_documents WHERE owner_type = ? AND owner_id = ? ORDER BY created_at DESC', ['FILTER', filterId]),
    exec.all(
      `SELECT ii.sku, ii.unit, ii.reorder_level, COALESCE(SUM(i.quantity),0) AS quantity,
              COALESCE(SUM(i.reserved_qty),0) AS reserved_qty, COUNT(i.id) AS stock_lines
       FROM inventory_items ii LEFT JOIN inventory i ON i.inventory_item_id = ii.id
       WHERE ii.item_kind = 'FILTER' AND ii.ref_id = ? GROUP BY ii.id, ii.sku, ii.unit, ii.reorder_level`,
      [filterId],
    ),
    exec.all('SELECT * FROM packaging_items WHERE filter_id = ? ORDER BY packaging_type', [filterId]),
    exec.all(
      `SELECT po.id, po.po_number, po.quantity_ordered, po.quantity_produced, po.status, po.priority,
              po.planned_start_at, po.availability_status, po.blocking_reason, po.line
       FROM production_orders po WHERE po.filter_id = ? AND po.status IN ('PLANNED','READY','IN_PROGRESS','BLOCKED')
       ORDER BY po.planned_start_at LIMIT 10`,
      [filterId],
    ),
  ]);

  const tooling = await exec.all(
    `SELECT ti.id, ti.tooling_id, ti.name, ti.status, ti.condition_rating, ti.quantity, ti.total_cycles, ti.max_cycles,
            ti.serial_number, ti.material, ti.rubber_profile, ti.letter_type, ti.external_location, ti.next_maintenance_date,
            ti.last_maintenance_date, ti.total_parts_produced, ti.notes, ti.is_tracked, ti.reserved_qty,
            tt.code AS type_code, tt.name AS type_name, tt.icon, ts.code AS set_code,
            tl.full_code AS location_code, tl.label_path AS location_path,
            tc.compatibility_level, tc.is_primary, tc.note AS compatibility_note,
            (SELECT im.id FROM tooling_images im WHERE im.owner_type='TOOLING' AND im.owner_id=ti.id ORDER BY im.is_primary DESC, im.sort_order LIMIT 1) AS primary_image_id,
            (SELECT COUNT(*) FROM tooling_images im2 WHERE im2.owner_type='TOOLING' AND im2.owner_id=ti.id) AS image_count,
            d.overall_length_mm, d.overall_width_mm, d.overall_height_mm, d.letter_position, d.letter_size_mm,
            (SELECT COUNT(*) FROM tooling_maintenance m WHERE m.tooling_item_id = ti.id AND m.status IN ('SCHEDULED','IN_PROGRESS')) AS open_maintenance,
            (SELECT po.po_number FROM tooling_reservations r JOIN production_orders po ON po.id = r.production_order_id
              WHERE r.tooling_item_id = ti.id AND r.status = 'ACTIVE' ORDER BY r.id LIMIT 1) AS reserved_for
     FROM tooling_compatibility tc
     JOIN tooling_items ti ON ti.id = tc.tooling_item_id AND ti.deleted_at IS NULL
     JOIN tooling_types tt ON tt.id = ti.tooling_type_id
     LEFT JOIN tooling_sets ts ON ts.id = ti.tooling_set_id
     LEFT JOIN tooling_locations tl ON tl.id = ti.location_id
     LEFT JOIN tooling_dimensions d ON d.tooling_item_id = ti.id
     WHERE tc.filter_id = ?
     ORDER BY tt.sort_order, tc.is_primary DESC, ti.tooling_id`,
    [filterId],
  );

  const byType = new Map();
  for (const t of tooling) {
    const list = byType.get(t.tooling_type_id ?? t.type_code) ?? [];
    list.push(t);
    byType.set(t.tooling_type_id ?? t.type_code, list);
  }

  const required = requirements.map((r) => {
    const candidates = tooling.filter((t) => t.type_code === r.type_code);
    const usable = candidates.filter((t) => ['AVAILABLE', 'IN_USE', 'RESERVED'].includes(t.status));
    const blocked = candidates.filter((t) => ['DAMAGED', 'MISSING', 'RETIRED'].includes(t.status));
    let state = 'MISSING';
    if (candidates.length === 0) state = 'MISSING';
    else if (blocked.length === candidates.length) state = 'BLOCKED';
    else if (candidates.some((t) => t.status === 'MAINTENANCE') && usable.length === 0) state = 'MAINTENANCE';
    else if (usable.length >= r.quantity_required) state = 'OK';
    else state = 'PARTIAL';
    return {
      requirement_id: r.id,
      tooling_type_id: r.tooling_type_id,
      type_code: r.type_code,
      type_name: r.type_name,
      icon: r.icon,
      quantity_required: r.quantity_required,
      is_mandatory: !!r.is_mandatory,
      note: r.note,
      state,
      items: candidates.map((t) => shapeToolingLine(t, unit)),
    };
  });

  const blockers = [];
  for (const r of required) {
    if (!r.is_mandatory) continue;
    if (r.state === 'MISSING') blockers.push({ type: 'MISSING_TOOLING', message: `No ${r.type_name} is linked to this filter`, type_name: r.type_name });
    else if (r.state === 'PARTIAL') blockers.push({ type: 'INSUFFICIENT_QTY', message: `${r.type_name}: ${r.items.filter((i) => ['AVAILABLE', 'RESERVED'].includes(i.status)).length} of ${r.quantity_required} available`, type_name: r.type_name });
    else if (r.state === 'MAINTENANCE') blockers.push({ type: 'MAINTENANCE', message: `${r.type_name} is under maintenance`, type_name: r.type_name });
    else if (r.state === 'BLOCKED') {
      for (const item of r.items.filter((i) => ['DAMAGED', 'MISSING'].includes(i.status))) {
        blockers.push({ type: item.status, message: `${item.tooling_id} (${r.type_name}) is ${item.status.toLowerCase()}`, tooling_id: item.tooling_id, tooling_pk: item.id });
      }
    }
  }
  const reservedForeign = tooling
    .filter((t) => t.reserved_for && Number(t.reserved_for) !== 0)
    .map((t) => ({ type: 'RESERVED', tooling_id: t.tooling_id, message: `${t.tooling_id} is reserved for ${t.reserved_for}` }));

  const openOrders = orders.filter((o) => ['PLANNED', 'READY', 'IN_PROGRESS', 'BLOCKED'].includes(o.status));

  const finishedGoods = stock.reduce((sum, s) => sum + Number(s.quantity ?? 0), 0);
  const availableStock = stock.reduce((sum, s) => sum + Number(s.quantity ?? 0) - Number(s.reserved_qty ?? 0), 0);

  return {
    filter,
    dimensions: numericDimensions(dimensions, FILTER_DIMENSION_FIELDS),
    materials,
    unit,
    xrefs,
    vehicles,
    images,
    documents,
    required_tooling: required,
    tooling: tooling.map((t) => shapeToolingLine(t, unit)),
    production: {
      ready: blockers.length === 0,
      status: blockers.length === 0 ? 'READY' : 'NOT_READY',
      blockers: [...blockers, ...reservedForeign],
      open_orders: openOrders,
    },
    stock: {
      lines: stock,
      finished_filters: finishedGoods,
      available_filters: availableStock,
    },
    packaging,
    sets: await exec.all('SELECT * FROM tooling_sets WHERE filter_id = ?', [filterId]),
  };
}

function shapeToolingLine(t, unit) {
  const dims = [t.overall_length_mm, t.overall_width_mm, t.overall_height_mm].filter((v) => v !== null && v !== undefined);
  return {
    id: t.id,
    tooling_id: t.tooling_id,
    name: t.name,
    status: t.status,
    condition: t.condition_rating,
    type_code: t.type_code,
    type_name: t.type_name,
    icon: t.icon,
    set_code: t.set_code,
    quantity: Number(t.quantity ?? 1),
    compatibility_level: t.compatibility_level,
    is_primary: !!Number(t.is_primary ?? 0),
    compatibility_note: t.compatibility_note,
    location: t.location_code ? { code: t.location_code, path: t.location_path } : null,
    where: t.location_code ?? t.external_location ?? 'not recorded',
    material: t.material,
    rubber_profile: t.rubber_profile,
    letter_type: t.letter_type,
    letter_position: t.letter_position,
    letter_size_mm: t.letter_size_mm,
    serial_number: t.serial_number,
    next_maintenance_date: t.next_maintenance_date,
    last_maintenance_date: t.last_maintenance_date,
    open_maintenance: Number(t.open_maintenance ?? 0),
    cycles: { total: Number(t.total_cycles ?? 0), max: t.max_cycles === null ? null : Number(t.max_cycles), parts: Number(t.total_parts_produced ?? 0) },
    reserved_qty: Number(t.reserved_qty ?? 0),
    notes: t.notes,
    image_count: Number(t.image_count ?? 0),
    primary_image_id: t.primary_image_id ?? null,
    has_photo: Number(t.image_count ?? 0) > 0,
    display_dimensions: dims.length ? `${dims.join(' × ')} ${unit}` : null,
    dimensions_mm: dims.length ? dims : null,
  };
}

export async function syncFilterSets(filterId = null) {
  const exec = await db.rawDriver.executor();
  if (filterId) {
    const linked = await exec.all(
      `SELECT DISTINCT ti.tooling_set_id id FROM tooling_items ti
       JOIN tooling_compatibility tc ON tc.tooling_item_id = ti.id
       WHERE tc.filter_id = ? AND ti.tooling_set_id IS NOT NULL`,
      [filterId],
    );
    const own = await exec.all('SELECT id FROM tooling_sets WHERE filter_id = ?', [filterId]);
    const ids = new Set([...linked, ...own].map((r) => r.id));
    if (!ids.size) return;
    await refreshSetStatuses(exec, { sets: [...ids] });
    return;
  }
  await refreshSetStatuses(exec);
}

/** Custom dimension field catalogue (spec §4 + §9 custom measurements). */
export async function customFields(entity = 'TOOLING') {
  return db.all('SELECT * FROM custom_dimension_fields WHERE entity = ? AND is_active = 1 ORDER BY sort_order, label', [entity]);
}

export async function addCustomField({ entity, label, field_key, unit, data_type, applies_to_type_id }) {
  const key = (field_key || label).toString().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);
  if (!key) throw badRequest('Could not derive a field key from that label');
  const clash = await db.one('SELECT id FROM custom_dimension_fields WHERE entity = ? AND field_key = ?', [entity, key]);
  if (clash) throw badRequest(`A custom field called "${key}" already exists for ${entity} records`);
  const res = await db.run(
    'INSERT INTO custom_dimension_fields (entity, label, field_key, unit, data_type, applies_to_type_id, sort_order) VALUES (?,?,?,?,?,?,?)',
    [entity, label, key, unit ?? null, data_type || 'decimal', applies_to_type_id ?? null, Number((await db.value('SELECT COALESCE(MAX(sort_order),100) m FROM custom_dimension_fields WHERE entity = ?', [entity])) ?? 100) + 10],
  );
  const id = res.insertId ?? (await db.value('SELECT id FROM custom_dimension_fields WHERE entity = ? AND field_key = ?', [entity, key]));
  return db.one('SELECT * FROM custom_dimension_fields WHERE id = ?', [id]);
}

export async function deleteCustomField(id) {
  const res = await db.run('DELETE FROM custom_dimension_fields WHERE id = ?', [Number(id)]);
  if (!res.affectedRows) throw notFound('Custom field not found');
  return true;
}
