/** Tooling service: the physical tool record, its dimensions, status and history. */
import { audit } from './audit.js';
import db from '../db/index.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';
import { TOOLING_DIMENSION_FIELDS } from '../seeds/catalog.js';

export const STATUSES = ['AVAILABLE', 'IN_USE', 'MAINTENANCE', 'RESERVED', 'DAMAGED', 'RETIRED', 'MISSING'];
export const STATUSES_REQUIRING_LOCATION = ['AVAILABLE', 'RESERVED'];
export const CONDITION_RATINGS = ['EXCELLENT', 'GOOD', 'FAIR', 'POOR', 'CRITICAL'];

export const TOOL_SELECT = `
  SELECT t.id, t.tooling_id, t.name, t.status, t.condition_rating, t.material, t.manufacturer, t.supplier,
         t.weight_grams, t.quantity, t.serial_number, t.barcode, t.qr_payload, t.manufacturing_date, t.purchase_date,
         t.warranty_until, t.external_location, t.rubber_profile, t.letter_type, t.logo_ref, t.is_tracked,
         t.total_cycles, t.total_parts_produced, t.max_cycles, t.cycle_warning_pct, t.last_used_at,
         t.last_maintenance_date, t.next_maintenance_date, t.maintenance_interval_days, t.maintenance_interval_cycles,
         t.last_condition_check_at, t.open_damage_reports, t.reserved_qty, t.cost, t.current_revision,
         t.notes, t.created_at, t.updated_at, t.primary_filter_id, t.tooling_set_id, t.location_id,
         tt.id AS tooling_type_id, tt.code AS type_code, tt.name AS type_name, tt.icon, tt.group_name, tt.requires_cycle_tracking,
         f.internal_number AS filter_number, f.name AS filter_name, f.id AS filter_id,
         ft.code AS filter_type_code, ft.name AS filter_type_name,
         br.name AS filter_brand,
         ts.code AS set_code, ts.name AS set_name, ts.status AS set_status,
         tl.full_code AS location_code, tl.label_path AS location_path, tl.id AS location_ref_id,
         cu.full_name AS created_by_name,
         (SELECT COUNT(*) FROM tooling_compatibility c2 WHERE c2.tooling_item_id = t.id) AS compatible_filter_count,
         (SELECT COUNT(*) FROM tooling_images im WHERE im.owner_type='TOOLING' AND im.owner_id=t.id) AS image_count,
         (SELECT COUNT(*) FROM tooling_documents dc WHERE dc.owner_type='TOOLING' AND dc.owner_id=t.id) AS document_count,
         (SELECT COUNT(*) FROM tooling_maintenance m WHERE m.tooling_item_id=t.id AND m.status IN ('SCHEDULED','IN_PROGRESS')) AS open_maintenance
  FROM tooling_items t
  JOIN tooling_types tt ON tt.id = t.tooling_type_id
  LEFT JOIN filters f ON f.id = t.primary_filter_id
  LEFT JOIN filter_types ft ON ft.id = f.filter_type_id
  LEFT JOIN brands br ON br.id = f.brand_id
  LEFT JOIN tooling_sets ts ON ts.id = t.tooling_set_id
  LEFT JOIN tooling_locations tl ON tl.id = t.location_id
  LEFT JOIN users cu ON cu.id = t.created_by`;

export async function getTooling(pk) {
  const id = Number(pk);
  const row = await db.one(`${TOOL_SELECT} WHERE t.id = ?${' AND t.deleted_at IS NULL'}`, [id]);
  if (!row) throw notFound(`Tooling #${id} not found`);
  return row;
}

export async function getToolingByCode(code) {
  const row = await db.one(`${TOOL_SELECT} WHERE UPPER(t.tooling_id) = ? AND t.deleted_at IS NULL`, [String(code).toUpperCase()]);
  if (!row) throw notFound(`Tooling ${code} not found`);
  return row;
}

export async function resolveTooling(ref) {
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && numeric > 0) return getTooling(numeric);
  return getToolingByCode(String(ref).trim());
}

export async function loadToolingRecord(ref, { unit = 'mm' } = {}) {
  const tool = await resolveTooling(ref);
  const exec = await db.rawDriver.executor();
  const [dimensions, images, documents, compatibility, revisions, movements, maintenance, usage, reservations, damage, setInfo] = await Promise.all([
    exec.one('SELECT * FROM tooling_dimensions WHERE tooling_item_id = ?', [tool.id]),
    exec.all('SELECT id, view_type, caption, filename, mime_type, size_bytes, is_primary, sort_order, created_at FROM tooling_images WHERE owner_type = ? AND owner_id = ? ORDER BY is_primary DESC, sort_order, id', ['TOOLING', tool.id]),
    exec.all('SELECT id, doc_type, original_name, extension, mime_type, size_bytes, version_no, is_current, description, created_at FROM tooling_documents WHERE owner_type = ? AND owner_id = ? AND is_current = 1 ORDER BY doc_type, original_name', ['TOOLING', tool.id]),
    exec.all(
      `SELECT c.id AS link_id, c.compatibility_level, c.is_primary, c.note, f.id AS filter_id, f.internal_number, f.name,
              ft.name AS type_name, ft.code AS type_code, b.name AS brand
       FROM tooling_compatibility c
       JOIN filters f ON f.id = c.filter_id
       JOIN filter_types ft ON ft.id = f.filter_type_id
       LEFT JOIN brands b ON b.id = f.brand_id
       WHERE c.tooling_item_id = ? ORDER BY c.is_primary DESC, f.internal_number`,
      [tool.id],
    ),
    exec.all(
      `SELECT r.*, u.full_name AS created_by_name, dc.original_name AS cad_file, dd.original_name AS drawing_file
       FROM tooling_revisions r
       LEFT JOIN users u ON u.id = r.created_by
       LEFT JOIN tooling_documents dc ON dc.id = r.cad_document_id
       LEFT JOIN tooling_documents dd ON dd.id = r.drawing_document_id
       WHERE r.tooling_item_id = ? ORDER BY r.revision_no DESC, r.id DESC`,
      [tool.id],
    ),
    exec.all(
      `SELECT m.*, u.full_name AS user_name FROM tooling_movements m
       LEFT JOIN users u ON u.id = m.user_id
       WHERE m.tooling_item_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT 40`,
      [tool.id],
    ),
    exec.all(
      `SELECT m.*, u.full_name AS created_by_name FROM tooling_maintenance m
       LEFT JOIN users u ON u.id = m.created_by
       WHERE m.tooling_item_id = ? ORDER BY COALESCE(m.completed_date, m.scheduled_date, m.created_at) DESC LIMIT 30`,
      [tool.id],
    ),
    exec.all(
      `SELECT u.*, po.po_number, f.internal_number FROM tooling_usage_history u
       LEFT JOIN production_orders po ON po.id = u.production_order_id
       LEFT JOIN filters f ON f.id = u.filter_id
       WHERE u.tooling_item_id = ? ORDER BY u.occurred_at DESC LIMIT 30`,
      [tool.id],
    ),
    exec.all(
      `SELECT r.*, po.po_number, u.full_name AS reserved_by_name
       FROM tooling_reservations r
       LEFT JOIN production_orders po ON po.id = r.production_order_id
       LEFT JOIN users u ON u.id = r.reserved_by
       WHERE r.tooling_item_id = ? AND r.status = 'ACTIVE' ORDER BY r.id DESC`,
      [tool.id],
    ),
    exec.all(
      `SELECT d.*, u.full_name AS reported_by_name FROM tooling_damage_reports d
       LEFT JOIN users u ON u.id = d.reported_by
       WHERE d.tooling_item_id = ? ORDER BY d.reported_at DESC LIMIT 20`,
      [tool.id],
    ),
    tool.tooling_set_id ? exec.one('SELECT * FROM tooling_sets WHERE id = ?', [tool.tooling_set_id]) : Promise.resolve(null),
  ]);

  const cycleMax = tool.max_cycles === null ? null : Number(tool.max_cycles);
  const cycles = Number(tool.total_cycles ?? 0);
  const life = cycleMax
    ? {
        total: cycles,
        max: cycleMax,
        remaining: Math.max(0, cycleMax - cycles),
        used_pct: Math.round((cycles / cycleMax) * 1000) / 10,
        warn: cycles / cycleMax >= Number(tool.cycle_warning_pct ?? 85) / 100,
        exceeded: cycles >= cycleMax,
      }
    : { total: cycles, max: null, remaining: null, used_pct: null, warn: false, exceeded: false };

  return {
    tool: {
      ...tool,
      quantity: Number(tool.quantity ?? 1),
      total_cycles: cycles,
      max_cycles: cycleMax,
      dimensions_display: formatDimensions(dimensions, unit),
    },
    dimensions,
    unit,
    life,
    images: images.map((im) => ({ ...im, url: `/api/files/tooling/${tool.id}/images/${im.id}`, download: `/api/files/tooling/${tool.id}/images/${im.id}?download=1` })),
    documents: documents.map((d) => ({ ...d, url: `/api/files/tooling/${tool.id}/documents/${d.id}`, download: `/api/files/tooling/${tool.id}/documents/${d.id}?download=1` })),
    compatibility,
    revisions,
    movements,
    maintenance,
    usage,
    reservations,
    damage_reports: damage,
    set: setInfo,
    duplicate_flags: await findPossibleDuplicates(tool.id, { limit: 4, internalOnly: true }),
    next_suggested_location: await suggestLocationFor(tool),
  };
}

export function formatDimensions(dims, unit = 'mm') {
  if (!dims) return null;
  const factor = { mm: 1, cm: 0.1, inch: 1 / 25.4 }[String(unit).toLowerCase()] ?? 1;
  const fmt = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * factor * 100) / 100);
  const overall = [dims.overall_length_mm, dims.overall_width_mm, dims.overall_height_mm].map(fmt);
  const internal = [dims.internal_length_mm, dims.internal_width_mm, dims.internal_height_mm].map(fmt);
  return {
    overall: overall.some((v) => v !== null) ? `${overall.map((v) => v ?? '?').join(' × ')} ${unit}` : null,
    overall_mm: overall,
    internal: internal.some((v) => v !== null) ? `${internal.map((v) => v ?? '?').join(' × ')} ${unit}` : null,
    values: TOOLING_DIMENSION_FIELDS.map((field) => ({
      key: field.key,
      label: field.label,
      unit: field.unit ? (field.unit === 'mm' ? unit : field.unit) : null,
      value: field.unit === 'mm' ? fmt(dims[field.key]) : dims[field.key],
    })).filter((v) => v.value !== null && v.value !== undefined && v.value !== ''),
  };
}

/** Inventory breakdown per tooling "family code" (same base code, multiple physical copies). */
export async function inventorySummary(whereSql = '', params = []) {
  const rows = await db.all(
    `SELECT tt.name AS type_name, tt.code AS type_code, tt.icon,
            COUNT(*) AS records,
            SUM(t.quantity) AS total_qty,
            SUM(CASE WHEN t.status = 'AVAILABLE' THEN t.quantity ELSE 0 END) AS available,
            SUM(CASE WHEN t.status = 'IN_USE' THEN t.quantity ELSE 0 END) AS in_use,
            SUM(CASE WHEN t.status = 'RESERVED' THEN t.quantity ELSE 0 END) AS reserved,
            SUM(CASE WHEN t.status = 'MAINTENANCE' THEN t.quantity ELSE 0 END) AS maintenance,
            SUM(CASE WHEN t.status = 'DAMAGED' THEN t.quantity ELSE 0 END) AS damaged,
            SUM(CASE WHEN t.status = 'MISSING' THEN t.quantity ELSE 0 END) AS missing,
            SUM(CASE WHEN t.status = 'RETIRED' THEN t.quantity ELSE 0 END) AS retired
     FROM tooling_items t JOIN tooling_types tt ON tt.id = t.tooling_type_id
     LEFT JOIN tooling_locations tl ON tl.id = t.location_id
     WHERE t.deleted_at IS NULL ${whereSql}
     GROUP BY tt.id, tt.name, tt.code, tt.icon, tt.sort_order
     ORDER BY tt.sort_order`,
    params,
  );
  return rows;
}

/* ------------------------------------------------------------ dimension search */

const round1 = (v) => (v === null || v === undefined || v === '' ? null : Math.round(Number(v) * 1000) / 1000);

/**
 * Dimension-first identification (spec §23): rank tooling by closeness to the given
 * measurements within a tolerance, then by how well the profile/type matches.
 */
export async function dimensionSearch({ length, width, height, tolerance_mm = 2, diameter = null, type_code = null, filter_type_code = null, brand = null, rubber_profile = null, letter_type = null, location_id = null, limit = 25, unit = 'mm' }) {
  const factor = { mm: 1, cm: 10, inch: 25.4 }[String(unit).toLowerCase()] ?? 1;
  const L = round1(length ? Number(length) * factor : null);
  const W = round1(width ? Number(width) * factor : null);
  const H = round1(height ? Number(height) * factor : null);
  const D = round1(diameter ? Number(diameter) * factor : null);
  const tol = Math.max(0.1, Number(tolerance_mm) || 2) * factor;
  if (L === null && W === null && H === null && D === null) throw badRequest('Provide at least one dimension to search by');

  const where = ['t.deleted_at IS NULL'];
  const params = [];
  const dimsMatch = [];
  if (L !== null) dimsMatch.push('(d.overall_length_mm BETWEEN ? AND ? OR d.internal_length_mm BETWEEN ? AND ?)');
  if (W !== null) dimsMatch.push('(d.overall_width_mm BETWEEN ? AND ? OR d.internal_width_mm BETWEEN ? AND ?)');
  if (H !== null) dimsMatch.push('(d.overall_height_mm BETWEEN ? AND ? OR d.internal_height_mm BETWEEN ? AND ?)');
  if (D !== null) dimsMatch.push('(d.overall_diameter_mm BETWEEN ? AND ? OR d.internal_diameter_mm BETWEEN ? AND ? OR d.hole_diameter_mm BETWEEN ? AND ?)');
  where.push(...dimsMatch);
  for (const [index, v] of [L, W, H, D].entries()) {
    if (v === null) continue;
    const pairs = index === 3 ? 3 : 2;
    for (let i = 0; i < pairs; i++) params.push(v - tol, v + tol);
  }

  if (type_code) {
    where.push('tt.code = ?');
    params.push(String(type_code).toUpperCase());
  }
  if (filter_type_code) {
    where.push('ft.code = ?');
    params.push(String(filter_type_code).toUpperCase());
  }
  if (brand) {
    where.push('(br.name LIKE ? OR br.code = ?)');
    params.push(`%${brand}%`, String(brand).toUpperCase());
  }
  if (rubber_profile) {
    where.push('t.rubber_profile LIKE ?');
    params.push(`%${rubber_profile}%`);
  }
  if (letter_type) {
    where.push('t.letter_type LIKE ?');
    params.push(`%${letter_type}%`);
  }
  if (location_id) {
    where.push('(t.location_id = ? OR tl.parent_location_id = ?)');
    params.push(Number(location_id), Number(location_id));
  }

  const rows = await db.all(
    `SELECT t.id, t.tooling_id, t.name, t.status, t.material, t.rubber_profile, t.letter_type, t.serial_number, t.quantity,
            tt.code AS type_code, tt.name AS type_name, tt.icon,
            d.overall_length_mm, d.overall_width_mm, d.overall_height_mm, d.internal_length_mm, d.internal_width_mm, d.internal_height_mm,
            d.overall_diameter_mm, d.internal_diameter_mm, d.letter_position, d.letter_size_mm, d.channel_width_mm, d.channel_depth_mm,
            tl.full_code AS location_code,
            f.internal_number AS filter_number,
            (SELECT COUNT(*) FROM tooling_compatibility c WHERE c.tooling_item_id = t.id) AS filter_count,
            (SELECT im.id FROM tooling_images im WHERE im.owner_type='TOOLING' AND im.owner_id=t.id ORDER BY im.is_primary DESC LIMIT 1) AS primary_image_id
     FROM tooling_items t
     JOIN tooling_dimensions d ON d.tooling_item_id = t.id
     JOIN tooling_types tt ON tt.id = t.tooling_type_id
     LEFT JOIN tooling_locations tl ON tl.id = t.location_id
     LEFT JOIN filters f ON f.id = t.primary_filter_id
     LEFT JOIN filter_types ft ON ft.id = f.filter_type_id
     LEFT JOIN brands br ON br.id = f.brand_id
     WHERE ${where.join(' AND ')}
     ORDER BY t.tooling_id
     LIMIT 200`,
    params,
  );

  const scored = rows.map((r) => {
    let matchedFields = 0;
    let totalDelta = 0;
    const scoreFor = (target, actual) => {
      if (target === null) return;
      if (actual === null || actual === undefined) return;
      const delta = Math.abs(Number(actual) - target);
      if (delta <= tol) matchedFields += 1;
      totalDelta += delta;
    };
    scoreFor(L, r.overall_length_mm ?? r.internal_length_mm);
    scoreFor(W, r.overall_width_mm ?? r.internal_width_mm);
    scoreFor(H, r.overall_height_mm ?? r.internal_height_mm);
    scoreFor(D, r.overall_diameter_mm ?? r.internal_diameter_mm ?? r.hole_diameter_mm);
    const requested = [L, W, H, D].filter((v) => v !== null).length;
    const closeness = requested ? Math.max(0, 1 - totalDelta / (requested * Math.max(tol, 0.5))) : 0;
    const coverage = requested ? matchedFields / requested : 0;
    const match = Math.round(Math.min(99.9, 100 * (0.55 * coverage + 0.45 * Math.min(1, closeness))) * 10) / 10;
    const dims = [
      r.overall_length_mm ?? r.internal_length_mm,
      r.overall_width_mm ?? r.internal_width_mm,
      r.overall_height_mm ?? r.internal_height_mm,
    ].filter((v) => v !== null && v !== undefined);
    return {
      id: r.id,
      tooling_id: r.tooling_id,
      name: r.name,
      type_code: r.type_code,
      type_name: r.type_name,
      icon: r.icon,
      status: r.status,
      material: r.material,
      rubber_profile: r.rubber_profile,
      letter_type: r.letter_type,
      serial_number: r.serial_number,
      quantity: r.quantity,
      filter_number: r.filter_number,
      filter_count: Number(r.filter_count ?? 0),
      location: r.location_code,
      primary_image_id: r.primary_image_id,
      dimensions_mm: dims,
      dimensions_display: dims.length ? dims.map((v) => round1(Number(v) / factor)).join(' × ') : `Ø${round1(Number(r.overall_diameter_mm) / factor)}`,
      tolerance_mm: round1(tol / factor),
      match_pct: match,
      matched_fields: matchedFields,
      requested_fields: requested,
      deltas_mm: {
        length: L === null || r.overall_length_mm === null ? null : round1((Number(r.overall_length_mm) - L) / factor),
        width: W === null || r.overall_width_mm === null ? null : round1((Number(r.overall_width_mm) - W) / factor),
        height: H === null || r.overall_height_mm === null ? null : round1((Number(r.overall_height_mm) - H) / factor),
        diameter: D === null || r.overall_diameter_mm === null ? null : round1((Number(r.overall_diameter_mm) - D) / factor),
      },
    };
  });
  scored.sort((a, b) => b.match_pct - a.match_pct || a.tooling_id.localeCompare(b.tooling_id));
  return { query: { length: L && round1(L / factor), width: W && round1(W / factor), height: H && round1(H / factor), diameter: D && round1(D / factor), tolerance_mm: round1(tol / factor), unit }, items: scored.slice(0, limit), total: scored.length };
}

/* ------------------------------------------------------------ duplicate detection */

/**
 * Spec §24: same type + near-identical dimensions + (shared compatible filters OR same
 * rubber profile OR same letter position) -> possible duplicate.
 */
export async function findPossibleDuplicates(toolingId, { tolerance_mm = 2.5, limit = 20, minSimilarity = 75, internalOnly = false } = {}) {
  const tool = await db.one(
    `SELECT t.id, t.tooling_id, t.tooling_type_id, t.rubber_profile, t.letter_type, t.name, t.status, t.quantity,
            d.overall_length_mm, d.overall_width_mm, d.overall_height_mm, d.internal_length_mm, d.internal_width_mm, d.internal_height_mm,
            d.letter_position, d.channel_width_mm, d.channel_depth_mm, d.corner_radius_mm
     FROM tooling_items t LEFT JOIN tooling_dimensions d ON d.tooling_item_id = t.id
     WHERE t.id = ?`,
    [Number(toolingId)],
  );
  if (!tool) throw notFound('Tooling not found');
  const candidates = await db.all(
    `SELECT t.id, t.tooling_id, t.name, t.status, t.rubber_profile, t.quantity, t.location_id,
            tt.code AS type_code, tt.name AS type_name,
            d.overall_length_mm, d.overall_width_mm, d.overall_height_mm, d.internal_length_mm, d.internal_width_mm,
            d.letter_position, d.channel_width_mm, d.channel_depth_mm, d.corner_radius_mm,
            tl.full_code AS location_code,
            (SELECT GROUP_CONCAT(f.internal_number ORDER BY f.internal_number SEPARATOR ',') FROM tooling_compatibility c JOIN filters f ON f.id=c.filter_id WHERE c.tooling_item_id = t.id) AS filters
     FROM tooling_items t
     JOIN tooling_dimensions d ON d.tooling_item_id = t.id
     JOIN tooling_types tt ON tt.id = t.tooling_type_id
     LEFT JOIN tooling_locations tl ON tl.id = t.location_id
     WHERE t.deleted_at IS NULL AND t.id <> ? AND t.tooling_type_id = ?
     ORDER BY t.tooling_id LIMIT 300`,
    [Number(toolingId), tool.tooling_type_id],
  );
  const shared = new Set(
    (await db.all('SELECT filter_id FROM tooling_compatibility WHERE tooling_item_id = ?', [Number(toolingId)])).map((r) => Number(r.filter_id)),
  );
  const results = [];
  for (const c of candidates) {
    const reasons = [];
    let score = 0;
    const dimsScore = (a, b, weight) => {
      if (a === null || a === undefined || b === null || b === undefined) return 0;
      const delta = Math.abs(Number(a) - Number(b));
      if (delta <= tolerance_mm) {
        score += weight;
        return 1;
      }
      const falloff = Math.max(0, 1 - (delta - tolerance_mm) / Math.max(tolerance_mm * 4, 5));
      score += weight * falloff;
      return falloff;
    };
    const l = dimsScore(tool.overall_length_mm, c.overall_length_mm, 22);
    const w = dimsScore(tool.overall_width_mm, c.overall_width_mm, 18);
    const h = dimsScore(tool.overall_height_mm, c.overall_height_mm, 14);
    dimsScore(tool.internal_length_mm, c.internal_length_mm, 12);
    dimsScore(tool.internal_width_mm, c.internal_width_mm, 10);
    if (l === 1 && w === 1) reasons.push(`overall size within ±${tolerance_mm}mm`);
    if (tool.rubber_profile && c.rubber_profile && tool.rubber_profile === c.rubber_profile) {
      score += 8;
      reasons.push('same rubber profile');
    }
    if (tool.letter_position && c.letter_position && String(tool.letter_position).toLowerCase() === String(c.letter_position).toLowerCase()) {
      score += 6;
      reasons.push('same letter position');
    }
    if (Number(tool.channel_width_mm ?? 0) && Number(tool.channel_width_mm) === Number(c.channel_width_mm)) {
      score += 5;
      reasons.push('same rubber channel width');
    }
    if (Number(tool.channel_depth_mm ?? 0) && Number(tool.channel_depth_mm) === Number(c.channel_depth_mm)) score += 4;
    if (tool.corner_radius_mm !== null && Number(tool.corner_radius_mm) === Number(c.corner_radius_mm)) score += 3;
    const candidateFilters = new Set(
      (await db.all('SELECT filter_id FROM tooling_compatibility WHERE tooling_item_id = ?', [c.id])).map((r) => Number(r.filter_id)),
    );
    const common = [...candidateFilters].filter((f) => shared.has(f));
    if (common.length) {
      score += Math.min(10, common.length * 5);
      reasons.push(`shared filters: ${common.length}`);
    }
    const similarity = Math.round(Math.min(100, score) * 10) / 10;
    if (similarity < minSimilarity) continue;
    results.push({
      id: c.id,
      tooling_id: c.tooling_id,
      name: c.name,
      status: c.status,
      quantity: c.quantity,
      type_name: c.type_name,
      location: c.location_code,
      filters: c.filters,
      similarity_pct: similarity,
      reasons,
    });
  }
  results.sort((a, b) => b.similarity_pct - a.similarity_pct);
  if (internalOnly) return results;
  return { tool, candidates: results.slice(0, limit) };
}

/** Scan every tool once and persist the flagged pairs (used by reports + alerts). */
export async function scanAllDuplicates({ minSimilarity = 88, tolerance_mm = 2.5 } = {}) {
  const rows = await db.all(
    `SELECT t.id, t.tooling_type_id, t.rubber_profile, t.status, t.quantity, t.name,
            tt.code AS type_name,
            d.overall_length_mm, d.overall_width_mm, d.overall_height_mm, d.internal_length_mm, d.internal_width_mm,
            d.letter_position, d.channel_width_mm, d.channel_depth_mm, d.corner_radius_mm,
            tl.full_code AS location_code,
            (SELECT GROUP_CONCAT(f.internal_number ORDER BY f.internal_number SEPARATOR ',')
               FROM tooling_compatibility c JOIN filters f ON f.id = c.filter_id WHERE c.tooling_item_id = t.id) AS filters
     FROM tooling_items t
     JOIN tooling_dimensions d ON d.tooling_item_id = t.id
     JOIN tooling_types tt ON tt.id = t.tooling_type_id
     LEFT JOIN tooling_locations tl ON tl.id = t.location_id
     WHERE t.deleted_at IS NULL
     ORDER BY t.tooling_type_id, t.id
     LIMIT 6000`,
  );
  const sharedFilters = new Map();
  for (const l of await db.all('SELECT tooling_item_id, filter_id FROM tooling_compatibility')) {
    const set = sharedFilters.get(Number(l.tooling_item_id)) ?? new Set();
    set.add(Number(l.filter_id));
    sharedFilters.set(Number(l.tooling_item_id), set);
  }
  const byType = new Map();
  for (const r of rows) {
    const list = byType.get(r.tooling_type_id) ?? [];
    list.push(r);
    byType.set(r.tooling_type_id, list);
  }
  const similarityOf = (a, b) => {
    let score = 0;
    const reasons = [];
    const dims = (x, y, weight) => {
      if (x === null || x === undefined || y === null || y === undefined) return 0;
      const delta = Math.abs(Number(x) - Number(y));
      if (delta <= tolerance_mm) {
        score += weight;
        return 1;
      }
      const falloff = Math.max(0, 1 - (delta - tolerance_mm) / Math.max(tolerance_mm * 4, 5));
      score += weight * falloff;
      return falloff;
    };
    const l = dims(a.overall_length_mm, b.overall_length_mm, 22);
    const w = dims(a.overall_width_mm, b.overall_width_mm, 18);
    dims(a.overall_height_mm, b.overall_height_mm, 14);
    dims(a.internal_length_mm, b.internal_length_mm, 12);
    dims(a.internal_width_mm, b.internal_width_mm, 10);
    if (l === 1 && w === 1) reasons.push(`overall size within ±${tolerance_mm}mm`);
    if (a.rubber_profile && b.rubber_profile && a.rubber_profile === b.rubber_profile) {
      score += 8;
      reasons.push('same rubber profile');
    }
    if (a.letter_position && b.letter_position && String(a.letter_position).toLowerCase() === String(b.letter_position).toLowerCase()) {
      score += 6;
      reasons.push('same letter position');
    }
    if (a.channel_width_mm !== null && Number(a.channel_width_mm) === Number(b.channel_width_mm)) score += 5;
    if (a.channel_depth_mm !== null && Number(a.channel_depth_mm) === Number(b.channel_depth_mm)) score += 4;
    if (a.corner_radius_mm !== null && Number(a.corner_radius_mm) === Number(b.corner_radius_mm)) score += 3;
    const fa = sharedFilters.get(Number(a.id)) ?? new Set();
    const fb = sharedFilters.get(Number(b.id)) ?? new Set();
    const common = [...fa].filter((x) => fb.has(x)).length;
    if (common) {
      score += Math.min(10, common * 5);
      reasons.push(`shared filters: ${common}`);
    }
    return { similarity: Math.round(Math.min(100, score) * 10) / 10, reasons };
  };
  let flagged = 0;
  for (const [, group] of byType) {
    const maxPairs = Math.min(group.length, 60);
    for (let i = 0; i < maxPairs; i++) {
      for (let j = i + 1; j < maxPairs; j++) {
        const a = group[i];
        const b = group[j];
        const { similarity, reasons } = similarityOf(a, b);
        if (similarity < minSimilarity) continue;
        const lo = Math.min(Number(a.id), Number(b.id));
        const hi = Math.max(Number(a.id), Number(b.id));
        await db.run(
          `INSERT INTO duplicate_checks (tooling_a_id, tooling_b_id, similarity_pct, reason, status)
           VALUES (?,?,?,?, 'OPEN')
           ON DUPLICATE KEY UPDATE similarity_pct=VALUES(similarity_pct), reason=VALUES(reason)`,
          [lo, hi, similarity, reasons.join('; ').slice(0, 400)],
        );
        flagged += 1;
      }
    }
  }
  await db.run(
    `UPDATE duplicate_checks dc
     JOIN tooling_items a ON a.id = dc.tooling_a_id
     JOIN tooling_items b ON b.id = dc.tooling_b_id
     SET dc.status = 'RESOLVED'
     WHERE dc.status = 'OPEN' AND (a.deleted_at IS NOT NULL OR b.deleted_at IS NOT NULL)`,
  );
  return { groups: byType.size, scanned: rows.length, flagged };
}

/* ------------------------------------------------------------ compatibility */

export async function setCompatibility(toolingId, filterId, { level = 'EXACT', primary = 0, note = null } = {}) {
  await db.run(
    `INSERT INTO tooling_compatibility (tooling_item_id, filter_id, compatibility_level, is_primary, note)
     VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE compatibility_level=VALUES(compatibility_level), note=VALUES(note), is_primary=VALUES(is_primary)`,
    [Number(toolingId), Number(filterId), level, primary ? 1 : 0, note],
  );
  if (primary) await db.run('UPDATE tooling_compatibility SET is_primary = 0 WHERE tooling_item_id = ? AND filter_id <> ?', [Number(toolingId), Number(filterId)]);
  await db.run('UPDATE filters SET updated_at = NOW() WHERE id = ?', [Number(filterId)]);
}

export async function removeCompatibility(toolingId, linkId) {
  const res = await db.run('DELETE FROM tooling_compatibility WHERE id = ? AND tooling_item_id = ?', [Number(linkId), Number(toolingId)]);
  if (!res.affectedRows) throw notFound('Compatibility link not found');
  return true;
}

/* ------------------------------------------------------------ cycle counter */

export async function adjustCycles(toolingId, { cycles = 0, produced = 0, note = null, reset = false }) {
  const tool = await getTooling(toolingId);
  if (reset) {
    await db.run('UPDATE tooling_items SET total_cycles = 0, total_parts_produced = 0, updated_at = NOW() WHERE id = ?', [tool.id]);
    return { before: tool.total_cycles, after: 0 };
  }
  const newCycles = Math.max(0, Number(tool.total_cycles ?? 0) + Number(cycles || 0));
  const newParts = Math.max(0, Number(tool.total_parts_produced ?? 0) + Number(produced || 0));
  await db.run('UPDATE tooling_items SET total_cycles = ?, total_parts_produced = ?, last_used_at = NOW(), updated_at = NOW() WHERE id = ?', [newCycles, newParts, tool.id]);
  const max = tool.max_cycles === null ? null : Number(tool.max_cycles);
  await db.run(
    `INSERT INTO tooling_usage_history (tooling_item_id, event_type, cycles, quantity, produced_qty, note)
     VALUES (?, 'CYCLE_COUNT', ?, ?, ?, ?)`,
    [tool.id, Math.max(0, Number(cycles || 0)), Math.max(0, Number(produced || 0)), Math.max(0, Number(produced || 0)), note],
  );
  return {
    before: Number(tool.total_cycles ?? 0),
    after: newCycles,
    warning: max ? newCycles / max >= Number(tool.cycle_warning_pct ?? 85) / 100 : false,
    exceeded: max ? newCycles >= max : false,
  };
}

/* ------------------------------------------------------------ status */

export async function setStatus(toolingId, status, { reason = null, ctx = null } = {}) {
  if (!STATUSES.includes(status)) throw badRequest(`status must be one of ${STATUSES.join(', ')}`);
  const tool = await getTooling(toolingId);
  if (tool.status === status) return { changed: false, tool };
  await db.run('UPDATE tooling_items SET status = ?, notes = COALESCE(?, notes), updated_at = NOW() WHERE id = ?', [status, reason ? `[status] ${reason}` : null, tool.id]);
  await db.run(
    `INSERT INTO tooling_movements (tooling_item_id, movement_type, from_location_id, to_location_id, from_location_code, to_location_code,
       external_location, status_before, status_after, note, user_id, username, created_at)
     VALUES (?, 'STATUS_CHANGE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      tool.id,
      tool.location_id,
      tool.location_id,
      tool.location_code ?? null,
      tool.location_code ?? null,
      status === 'IN_USE' ? tool.external_location : null,
      tool.status,
      status,
      reason,
      ctx?.user?.id ?? null,
      ctx?.user?.username ?? null,
    ],
  );
  await audit(ctx, {
    action: 'status',
    entityType: 'tooling_item',
    entityId: tool.id,
    entityLabel: tool.tooling_id,
    field: 'status',
    oldValue: tool.status,
    newValue: status,
    reason,
    summary: `Status ${tool.status} to ${status}${reason ? ` (${reason})` : ''}`,
  });
  return { changed: true, before: tool.status, after: status, tool: await getTooling(tool.id) };
}

/** Recalculate reserved_qty from active reservations (spec §32). */
export async function refreshReservedQty(toolingId = null) {
  if (toolingId) {
    await db.run(
      `UPDATE tooling_items t SET t.reserved_qty =
         (SELECT COALESCE(SUM(r.qty),0) FROM tooling_reservations r WHERE r.tooling_item_id = t.id AND r.status = 'ACTIVE')
       WHERE t.id = ?`,
      [Number(toolingId)],
    );
    return;
  }
  await db.run(
    `UPDATE tooling_items t SET t.reserved_qty =
       (SELECT COALESCE(SUM(r.qty),0) FROM tooling_reservations r WHERE r.tooling_item_id = t.id AND r.status = 'ACTIVE')`,
  );
}

export async function nextToolingId(typeCode, baseHint) {
  const needle = String(typeCode).trim();
  const type = await db.one(
    'SELECT id, code, id_prefix, name FROM tooling_types WHERE code = ? OR id = ? OR name = ? LIMIT 1',
    [needle.toUpperCase(), /^\d+$/.test(needle) ? Number(needle) : 0, needle],
  );
  if (!type) {
    const known = (await db.all('SELECT code FROM tooling_types WHERE is_active = 1 ORDER BY sort_order LIMIT 12')).map((t) => t.code);
    throw badRequest(`Unknown tooling type "${typeCode}". Use a category code, e.g. ${known.join(', ')}.`);
  }
  const prefix = type.id_prefix || type.code;
  const hint = String(baseHint || '')
    .replace(/[^0-9A-Za-z]/g, '')
    .replace(/^[A-Z]+/, '')
    .slice(0, 8);
  const numeric = hint.replace(/\D/g, '');
  const stem = `${prefix}-${numeric || (await nextSequenceNumber())}`;
  for (let i = 0; i < 26; i++) {
    const candidate = `${stem}-${String.fromCharCode(65 + i)}`;
    const taken = await db.one('SELECT id FROM tooling_items WHERE tooling_id = ?', [candidate]);
    if (!taken) return candidate;
  }
  return `${stem}-${Date.now().toString(36).slice(-4).toUpperCase()}`;
}

async function nextSequenceNumber() {
  const max = await db.value('SELECT MAX(CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(tooling_id, "-", 2), "-", -1) AS UNSIGNED)) m FROM tooling_items');
  const n = Number(max ?? 0);
  return String((Number.isFinite(n) ? n : 0) + 1).padStart(5, '0');
}

export async function createTool(data) {
  // Built from the object so the column list, placeholders and parameters cannot drift apart.
  const cols = {
    tooling_id: data.tooling_id,
    name: data.name,
    tooling_type_id: data.tooling_type_id,
    tooling_set_id: data.tooling_set_id ?? null,
    primary_filter_id: data.primary_filter_id ?? null,
    status: data.status || 'AVAILABLE',
    condition_rating: data.condition_rating || 'GOOD',
    material: data.material ?? null,
    manufacturer: data.manufacturer ?? null,
    supplier: data.supplier ?? null,
    weight_grams: data.weight_grams ?? null,
    quantity: data.quantity ?? 1,
    serial_number: data.serial_number ?? null,
    barcode: data.barcode ?? null,
    qr_payload: data.qr_payload ?? null,
    manufacturing_date: data.manufacturing_date ?? null,
    purchase_date: data.purchase_date ?? null,
    location_id: data.location_id ?? null,
    external_location: data.external_location ?? null,
    rubber_profile: data.rubber_profile ?? null,
    letter_type: data.letter_type ?? null,
    logo_ref: data.logo_ref ?? null,
    is_tracked: data.is_tracked ?? 1,
    total_cycles: data.total_cycles ?? 0,
    max_cycles: data.max_cycles ?? null,
    cycle_warning_pct: data.cycle_warning_pct ?? 85,
    maintenance_interval_days: data.maintenance_interval_days ?? null,
    maintenance_interval_cycles: data.maintenance_interval_cycles ?? null,
    cost: data.cost ?? null,
    notes: data.notes ?? null,
    created_by: data.created_by ?? null,
  };
  const keys = Object.keys(cols);
  const res = await db.run(
    `INSERT INTO tooling_items (${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    keys.map((k) => cols[k]),
  );
  const id = res.insertId;
  if (!id) throw new Error('Could not determine the new tooling id');
  if (!data.barcode) await db.run('UPDATE tooling_items SET barcode = ? WHERE id = ?', [`SP${String(id).padStart(6, '0')}`, id]);
  await db.run('UPDATE tooling_items SET qr_payload = ? WHERE id = ?', [`SP:T:${data.tooling_id}`, id]);
  if (data.dimensions) await saveDimensions(id, data.dimensions, data.dimension_notes);
  if (data.primary_filter_id) await setCompatibility(id, data.primary_filter_id, { primary: 1, note: 'Created from tooling request' });
  return getTooling(id);
}

const DIM_KEYS = TOOLING_DIMENSION_FIELDS.map((f) => f.key);

export async function saveDimensions(toolingId, values, notes = null) {
  const cols = [];
  const placeholders = [];
  const params = [];
  const updates = [];
  for (const key of DIM_KEYS) {
    if (!(key in values)) continue;
    cols.push(`\`${key}\``);
    placeholders.push('?');
    const raw = values[key];
    params.push(raw === '' || raw === undefined ? null : key.endsWith('_position') || key === 'mounting_dimensions' || key === 'hole_position' ? String(raw).slice(0, 200) : Number(raw));
    updates.push(`\`${key}\`=VALUES(\`${key}\`)`);
  }
  const custom = values.custom_values ?? null;
  if (custom !== undefined) {
    cols.push('`custom_values`');
    placeholders.push('?');
    params.push(custom ? JSON.stringify(custom) : null);
    updates.push('`custom_values`=VALUES(`custom_values`)');
  }
  cols.push('`notes`');
  placeholders.push('?');
  params.push(notes ?? null);
  updates.push('`notes`=VALUES(`notes`)');
  if (!updates.length) return null;
  const sql = `INSERT INTO tooling_dimensions (tooling_item_id, ${cols.join(', ')}) VALUES (?, ${placeholders.join(', ')}) ON DUPLICATE KEY UPDATE ${updates.join(', ')}`;
  await db.run(sql, [Number(toolingId), ...params]);
  return db.one('SELECT * FROM tooling_dimensions WHERE tooling_item_id = ?', [Number(toolingId)]);
}

/** Snapshot the current record as an immutable revision before a significant change. */
export async function snapshotRevision(toolingId, { change_summary, created_by, revision_no = null }) {
  const tool = await db.one('SELECT * FROM tooling_items WHERE id = ?', [Number(toolingId)]);
  if (!tool) throw notFound('Tooling not found');
  const dimensions = await db.one('SELECT * FROM tooling_dimensions WHERE tooling_item_id = ?', [tool.id]);
  const next = revision_no ?? Number(tool.current_revision ?? 1) + 1;
  await db.run('UPDATE tooling_revisions SET is_current = 0 WHERE tooling_item_id = ?', [tool.id]);
  const res = await db.run(
    `INSERT INTO tooling_revisions (tooling_item_id, filter_id, revision_no, change_summary, designer, manufacturer, material, cost,
       manufacturing_date, cad_document_id, drawing_document_id, snapshot, is_current, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
    [
      tool.id,
      tool.primary_filter_id,
      next,
      change_summary ?? null,
      tool.created_by_name ?? null,
      tool.manufacturer,
      tool.material,
      tool.cost,
      tool.manufacturing_date,
      null,
      null,
      JSON.stringify({ tool: stripToolSnapshot(tool), dimensions: dimensions ? stripToolSnapshot(dimensions) : null }),
      created_by ?? null,
    ],
  );
  await db.run('UPDATE tooling_items SET current_revision = ?, updated_at = NOW() WHERE id = ?', [next, tool.id]);
  return db.one('SELECT * FROM tooling_revisions WHERE id = ?', [res.insertId]);
}

const stripToolSnapshot = (obj) => {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== null && v !== undefined && v !== '') out[k] = v;
  return out;
};

/* ------------------------------------------------------------ soft delete */

export async function archiveTooling(toolingId) {
  const tool = await getTooling(toolingId);
  if (['IN_USE', 'RESERVED'].includes(tool.status)) throw conflict(`Cannot archive ${tool.tooling_id} while it is ${tool.status.toLowerCase()} - return or release it first`);
  await db.run('UPDATE tooling_items SET deleted_at = NOW(), status = ?, location_id = NULL, updated_at = NOW() WHERE id = ?', ['RETIRED', tool.id]);
  await db.run('UPDATE tooling_locations tl SET tl.occupancy_items = GREATEST(0, tl.occupancy_items - ?) WHERE tl.id = ?', [tool.quantity ?? 1, tool.location_id ?? 0]);
  await refreshSetFor(tool.id);
  return { tooling_id: tool.tooling_id };
}

export async function restoreTooling(toolingId) {
  const res = await db.run('UPDATE tooling_items SET deleted_at = NULL, status = COALESCE(status, \'AVAILABLE\'), updated_at = NOW() WHERE id = ? AND deleted_at IS NOT NULL', [Number(toolingId)]);
  if (!res.affectedRows) throw notFound('Archived tooling not found');
  await refreshSetFor(Number(toolingId));
  return true;
}

async function refreshSetFor(toolingId) {
  const setId = await db.value('SELECT tooling_set_id FROM tooling_items WHERE id = ?', [Number(toolingId)]);
  if (!setId) return;
  const { refreshSetStatuses } = await import('../seeds/demo.js');
  const exec = await db.rawDriver.executor();
  await refreshSetStatuses(exec, { sets: [Number(setId)] });
}

/* ------------------------------------------------------------ suggestions */

/**
 * Spec §46: prefer the shelf that already holds sibling tooling for the same filter/set,
 * then fall back to the emptiest suitable shelf. Explains the reason so the user trusts it.
 */
export async function suggestLocationFor(toolOrId) {
  const tool = typeof toolOrId === 'object' ? toolOrId : await getTooling(toolOrId);
  const exec = await db.rawDriver.executor();
  const siblings = await exec.all(
    `SELECT s.full_code, s.id, s.label_path, COUNT(*) AS cnt, t2.primary_filter_id, f.internal_number
     FROM tooling_items t2
     JOIN tooling_locations s ON s.id = t2.location_id
     LEFT JOIN filters f ON f.id = t2.primary_filter_id
     WHERE t2.deleted_at IS NULL AND t2.id <> ?
       AND (t2.tooling_set_id = ? OR t2.primary_filter_id = ?)
     GROUP BY s.id, s.full_code, s.label_path, t2.primary_filter_id, f.internal_number
     ORDER BY cnt DESC, s.full_code LIMIT 4`,
    [tool.id, tool.tooling_set_id ?? 0, tool.primary_filter_id ?? 0],
  );
  const suggestions = siblings.map((s) => ({
    location_id: s.id,
    full_code: s.full_code,
    label_path: s.label_path,
    reason: `Other tooling for ${s.internal_number ?? 'this tooling set'} is stored here (${s.cnt} item${Number(s.cnt) > 1 ? 's' : ''})`,
    score: 100 + Number(s.cnt) * 5,
  }));
  const spare = await exec.all(
    `SELECT l.id, l.full_code, l.label_path, l.capacity_items, l.occupancy_items,
            (l.capacity_items - l.occupancy_items) AS free_space
     FROM tooling_locations l
     WHERE l.kind IN ('SHELF','BOX') AND l.capacity_items IS NOT NULL AND l.occupancy_items < l.capacity_items
     ORDER BY (l.occupancy_items / l.capacity_items), l.full_code
     LIMIT 5`,
  );
  for (const s of spare) {
    suggestions.push({
      location_id: s.id,
      full_code: s.full_code,
      label_path: s.label_path,
      reason: `${s.free_space} free place${Number(s.free_space) > 1 ? 's' : ''} on this shelf`,
      score: 40 + Number(s.free_space),
    });
  }
  suggestions.sort((a, b) => b.score - a.score);
  return suggestions.slice(0, 5);
}
