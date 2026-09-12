/** /api/filters — catalogue, dimensions, cross refs, applications, tooling overview (spec §3-§6, §21, §57). */
import express from 'express';
import db from '../db/index.js';
import { asyncRoute, badRequest, notFound, conflict } from '../lib/errors.js';
import { validate, str, num, bool, oneOf, text, idRef, idList, escapeLike, inPlaceholders } from '../lib/validate.js';
import { requirePermission } from '../middleware/index.js';
import { FILTER_STATUSES, FILTER_SELECT, getFilterOr404, rebuildSearchBlob, toolingOverview, syncFilterSets, customFields, addCustomField, deleteCustomField, numericDimensions } from '../services/filters.js';
import { dimensionSearch } from '../services/tooling.js';
import { listFiles, addImage, addDocument, deleteImage, deleteDocument, setImagePrimary } from '../services/storage.js';
import { upload } from './_upload.js';
import { audit, auditUpdate } from '../services/audit.js';
import { listResult, orderBy, requireId, toMm } from './_helpers.js';
import { FILTER_DIMENSION_FIELDS } from '../seeds/catalog.js';

const router = express.Router();

const like = (v) => `%${escapeLike(String(v).trim())}%`;

/* ------------------------------------------------------------------ list */
router.get(
  '/',
  requirePermission('*.read'),
  asyncRoute(async (req, res) => {
    const q = req.query;
    const { page, size, offset, orderSql } = orderBy(q, ['internal_number', 'name', 'updated_at', 'created_at', 'status', 'id'], 'internal_number', 'asc');
    const where = [];
    const params = [];
    if (q.q) {
      const like = `%${escapeLike(String(q.q).trim())}%`;
      where.push(`(f.internal_number LIKE ? OR f.product_number LIKE ? OR f.name LIKE ? OR f.search_blob LIKE ? OR EXISTS (SELECT 1 FROM filter_cross_references x WHERE x.filter_id = f.id AND x.ref_number LIKE ?))`);
      params.push(like, like, like, like, like);
    }
    if (q.type) {
      where.push('ft.code = ?');
      params.push(String(q.type).toUpperCase());
    }
    if (q.brand) {
      where.push('(b.code = ? OR b.name LIKE ?)');
      params.push(String(q.brand).toUpperCase(), `%${q.brand}%`);
    }
    if (q.status) {
      where.push('f.status = ?');
      params.push(String(q.status).toUpperCase());
    }
    if (q.family) {
      where.push('ff.code = ?');
      params.push(String(q.family).toUpperCase());
    }
    if (q.active === '1' || q.active === 'true') where.push('f.is_active = 1');
    if (q.has_tooling === '0') where.push('NOT EXISTS (SELECT 1 FROM tooling_compatibility tc WHERE tc.filter_id = f.id)');
    if (q.has_tooling === '1') where.push('EXISTS (SELECT 1 FROM tooling_compatibility tc WHERE tc.filter_id = f.id)');
    if (q.missing_tooling === '1') {
      where.push(`EXISTS (SELECT 1 FROM filter_tooling_requirements r
        WHERE r.filter_id = f.id AND r.is_mandatory = 1 AND
          COALESCE((SELECT SUM(1) FROM tooling_compatibility tc2 JOIN tooling_items ti2 ON ti2.id = tc2.tooling_item_id AND ti2.deleted_at IS NULL
                     JOIN tooling_types t2 ON t2.id = ti2.tooling_type_id AND t2.id = r.tooling_type_id
            WHERE tc2.filter_id = f.id AND ti2.status IN ('AVAILABLE','IN_USE','RESERVED')),0) < r.quantity_required)`);
    }
    if (q.location_id) {
      where.push(`EXISTS (SELECT 1 FROM tooling_compatibility tc3 JOIN tooling_items ti3 ON ti3.id = tc3.tooling_item_id WHERE tc3.filter_id = f.id AND ti3.location_id = ?)`);
      params.push(Number(q.location_id));
    }
    // dimension filters (mm) with optional tolerance
    const dimFilters = [];
    for (const field of ['length', 'width', 'height', 'outer_diameter', 'overall_diameter', 'weight']) {
      if (q[`min_${field}`] || q[`max_${field}`]) {
        const col = { length: 'length_mm', width: 'width_mm', height: 'height_mm', outer_diameter: 'outer_diameter_mm', overall_diameter: 'overall_diameter_mm', weight: 'weight_grams' }[field];
        if (q[`min_${field}`]) {
          dimFilters.push(`fd.${col} >= ?`);
          params.push(toMm(q[`min_${field}`], q.unit || 'mm'));
        }
        if (q[`max_${field}`]) {
          dimFilters.push(`fd.${col} <= ?`);
          params.push(toMm(q[`max_${field}`], q.unit || 'mm'));
        }
      }
    }
    if (q.vehicle) {
      const like = `%${escapeLike(String(q.vehicle).trim())}%`;
      where.push(`EXISTS (SELECT 1 FROM filter_vehicle_applications a JOIN vehicles v ON v.id = a.vehicle_id
        WHERE a.filter_id = f.id AND (v.manufacturer LIKE ? OR v.model LIKE ? OR v.engine LIKE ? OR v.engine_code LIKE ? OR v.generation LIKE ?))`);
      params.push(like, like, like, like, like);
    }
    if (dimFilters.length) where.push(`EXISTS (SELECT 1 FROM filter_dimensions fd WHERE fd.filter_id = f.id AND ${dimFilters.join(' AND ')})`);

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await db.value(
      `SELECT COUNT(*) c FROM filters f
       JOIN filter_types ft ON ft.id = f.filter_type_id
       LEFT JOIN brands b ON b.id = f.brand_id
       LEFT JOIN filter_families ff ON ff.id = f.family_id ${whereSql}`,
      params,
    );
    const items = await db.all(
      `${FILTER_SELECT} ${whereSql} ${orderSql} LIMIT ? OFFSET ?`,
      [...params, size, offset],
    );
    return res.json(listResult({ items, total: Number(total ?? 0), page, size }));
  }),
);

/* --------------------------------------------------------- dimension search */
router.get(
  '/by-dimensions',
  requirePermission('*.read'),
  asyncRoute(async (req, res) => {
    const out = await dimensionSearch({
      length: req.query.length,
      width: req.query.width,
      height: req.query.height,
      diameter: req.query.diameter,
      tolerance_mm: req.query.tolerance ?? 2,
      unit: req.query.unit || 'mm',
      filter_type_code: req.query.filter_type,
      rubber_profile: req.query.rubber_profile,
      location_id: req.query.location_id,
      limit: Number(req.query.limit || 20),
    });
    res.json(out);
  }),
);

/* -------------------------------------------- "do we already have this tool?" */
router.post(
  '/check-existing',
  requirePermission('*.read'),
  asyncRoute(async (req, res) => {
    const body = req.body || {};
    const unit = body.unit || 'mm';
    const dims = body.dimensions || {};
    const picks = {
      length: body.length ?? dims.length_mm,
      width: body.width ?? dims.width_mm,
      height: body.height ?? dims.height_mm,
      diameter: body.overall_diameter ?? dims.overall_diameter_mm,
    };
    const tolerance = Number(body.tolerance_mm ?? 2);
    let toolMatches = { items: [], total: 0 };
    if (picks.length || picks.width || picks.height || picks.diameter) {
      toolMatches = await dimensionSearch({
        ...picks,
        tolerance_mm: tolerance,
        unit,
        type_code: body.tooling_type,
        filter_type_code: body.filter_type,
        brand: body.brand,
        rubber_profile: body.rubber_profile,
        letter_type: body.letter_type,
        limit: 20,
      });
    }
    // also look for filters with the same geometry - their tooling is likely reusable
    const filters = await db.all(
      `SELECT f.id, f.internal_number, f.name, ft.name AS type_name, b.name AS brand,
              fd.length_mm, fd.width_mm, fd.height_mm, fd.overall_diameter_mm,
              (SELECT COUNT(*) FROM tooling_compatibility tc JOIN tooling_items ti ON ti.id = tc.tooling_item_id AND ti.deleted_at IS NULL
                 WHERE tc.filter_id = f.id) AS tool_count,
              (SELECT GROUP_CONCAT(ti.tooling_id ORDER BY ti.tooling_id SEPARATOR ', ') FROM tooling_compatibility tc JOIN tooling_items ti ON ti.id = tc.tooling_item_id AND ti.deleted_at IS NULL WHERE tc.filter_id = f.id) AS tooling
       FROM filters f
       JOIN filter_dimensions fd ON fd.filter_id = f.id
       JOIN filter_types ft ON ft.id = f.filter_type_id
       LEFT JOIN brands b ON b.id = f.brand_id
       WHERE (? IS NULL OR fd.length_mm BETWEEN ? - ? AND ? + ?)
         AND (? IS NULL OR fd.width_mm BETWEEN ? - ? AND ? + ?)
         AND (? IS NULL OR fd.height_mm BETWEEN ? - ? AND ? + ?)
       ORDER BY f.internal_number LIMIT 25`,
      [
        picks.length ?? null,
        picks.length ?? 0, tolerance, picks.length ?? 0, tolerance,
        picks.width ?? null, picks.width ?? 0, tolerance, picks.width ?? 0, tolerance,
        picks.height ?? null, picks.height ?? 0, tolerance, picks.height ?? 0, tolerance,
      ],
    );
    const similarFilterTools = [];
    for (const f of filters.slice(0, 8)) {
      const tools = await db.all(
        `SELECT ti.id, ti.tooling_id, ti.name, ti.status, tt.name AS type_name, tl.full_code AS location
         FROM tooling_compatibility tc JOIN tooling_items ti ON ti.id = tc.tooling_item_id AND ti.deleted_at IS NULL
         JOIN tooling_types tt ON tt.id = ti.tooling_type_id
         LEFT JOIN tooling_locations tl ON tl.id = ti.location_id
         WHERE tc.filter_id = ? ORDER BY tt.sort_order LIMIT 10`,
        [f.id],
      );
      similarFilterTools.push({ ...f, tools });
    }
    const verdict = toolMatches.total > 0 || filters.length > 0;
    res.json({
      conclusion: verdict
        ? 'Existing tooling found - review before manufacturing anything new'
        : 'No matching tooling found - a new tool request is probably needed',
      tooling: toolMatches.items,
      similar_filters: similarFilterTools,
      query: { ...picks, tolerance_mm: tolerance, unit, filter_type: body.filter_type, rubber_profile: body.rubber_profile },
      request_draft: verdict ? null : { title: `New tooling for ${body.filter_type ?? ''} ${picks.length ?? ''}x${picks.width ?? ''}x${picks.height ?? ''}`, priority: 'NORMAL' },
    });
  }),
);

/* --------------------------------------------------------- types / brands */
router.get('/types', asyncRoute(async (req, res) => {
  const rows = await db.all(
    `SELECT ft.*, (SELECT COUNT(*) FROM filters f WHERE f.filter_type_id = ft.id) AS filter_count
     FROM filter_types ft ${req.query.all === '1' ? '' : 'WHERE ft.is_active = 1'} ORDER BY ft.sort_order, ft.name`,
  );
  res.json({ items: rows });
}));

const TYPE_SCHEMA = {
  code: [str, { required: true, upper: true, max: 40, pattern: /^[A-Z0-9_]+$/, hint: 'uppercase letters, digits, underscore' }],
  name: [str, { required: true, max: 120 }],
  description: [str, { max: 400 }],
  icon: [str, { max: 12 }],
  dimension_profile: oneOf(['panel', 'spin_on', 'inline', 'kit', 'cabin', 'general']),
  sort_order: [num, { int: true, min: 0, max: 9999 }],
  is_active: [bool, { default: true }],
};

router.post('/types', requirePermission('settings.manage'), asyncRoute(async (req, res) => {
  const data = validate(TYPE_SCHEMA, req.body);
  const exists = await db.one('SELECT id FROM filter_types WHERE code = ?', [data.code]);
  if (exists) throw conflict(`Filter type ${data.code} already exists`);
  const res2 = await db.run(
    'INSERT INTO filter_types (code, name, description, icon, dimension_profile, sort_order, is_active) VALUES (?,?,?,?,?,?,?)',
    [data.code, data.name, data.description ?? null, data.icon ?? null, data.dimension_profile ?? 'general', data.sort_order ?? 100, data.is_active ? 1 : 0],
  );
  await audit(req.ctx, { action: 'create', entityType: 'filter_type', entityId: res2.insertId, entityLabel: data.code, summary: `Filter type ${data.name} created` });
  res.status(201).json(await db.one('SELECT * FROM filter_types WHERE id = ?', [res2.insertId]));
}));

router.put('/types/:id', requirePermission('settings.manage'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'filter type id');
  const before = await db.one('SELECT * FROM filter_types WHERE id = ?', [id]);
  if (!before) throw notFound('Filter type not found');
  const data = validate(TYPE_SCHEMA, req.body, { partial: true });
  const keys = Object.keys(data);
  if (!keys.length) throw badRequest('Nothing to update');
  await db.run(`UPDATE filter_types SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => (typeof data[k] === 'boolean' ? Number(data[k]) : data[k])), id]);
  await audit(req.ctx, { action: 'update', entityType: 'filter_type', entityId: id, entityLabel: data.code ?? before.code, summary: `Filter type ${before.code} updated` });
  res.json(await db.one('SELECT * FROM filter_types WHERE id = ?', [id]));
}));

router.delete('/types/:id', requirePermission('settings.manage'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'filter type id');
  const used = await db.value('SELECT COUNT(*) c FROM filters WHERE filter_type_id = ?', [id]);
  if (Number(used) > 0) throw conflict(`${used} filter(s) still use this type - set it inactive instead`);
  const res2 = await db.run('DELETE FROM filter_types WHERE id = ? AND is_system = 0', [id]);
  if (!res2.affectedRows) throw badRequest('System types cannot be deleted - deactivate them instead');
  await audit(req.ctx, { action: 'delete', entityType: 'filter_type', entityId: id, summary: 'Filter type deleted' });
  res.json({ ok: true });
}));

router.get('/brands', asyncRoute(async (req, res) => {
  res.json({ items: await db.all('SELECT b.*, (SELECT COUNT(*) FROM filters f WHERE f.brand_id = b.id) AS filter_count FROM brands b ORDER BY b.name') });
}));

router.post('/brands', requirePermission('settings.manage'), asyncRoute(async (req, res) => {
  const data = validate({ code: [str, { required: true, upper: true, max: 40 }], name: [str, { required: true, max: 120 }], country: [str, { max: 60 }] }, req.body);
  const r = await db.run('INSERT INTO brands (code, name, country) VALUES (?,?,?)', [data.code, data.name, data.country ?? null]);
  res.status(201).json(await db.one('SELECT * FROM brands WHERE id = ?', [r.insertId]));
}));

/* --------------------------------------------------------- vehicles (§6) */
const VEHICLE_FIELDS = {
  manufacturer: [str, { required: true, max: 120 }],
  model: [str, { required: true, max: 120 }],
  generation: [str, { max: 80 }],
  year_from: [num, { int: true, min: 1900, max: 2100 }],
  year_to: [num, { int: true, min: 1900, max: 2100 }],
  engine: [str, { max: 120 }],
  engine_code: [str, { max: 60, upper: true }],
  fuel: [str, { max: 40 }],
  power_hp: [num, { min: 0, max: 9999 }],
  body_type: [str, { max: 60 }],
  notes: [str, { max: 400 }],
};
const VEHICLE_KEYS = Object.keys(VEHICLE_FIELDS);

/** Find a vehicle by its descriptive key, so the same car is never entered twice. */
async function findVehicle(values) {
  return db.one(
    `SELECT * FROM vehicles
     WHERE manufacturer <=> ? AND model <=> ? AND COALESCE(generation, '') = COALESCE(?, '')
       AND COALESCE(engine_code, '') = COALESCE(?, '') AND COALESCE(engine, '') = COALESCE(?, '')
       AND COALESCE(year_from, 0) = COALESCE(?, 0) AND COALESCE(year_to, 0) = COALESCE(?, 0)
     LIMIT 1`,
    [values.manufacturer ?? null, values.model ?? null, values.generation ?? null, values.engine_code ?? null, values.engine ?? null, values.year_from ?? null, values.year_to ?? null],
  );
}

/** Create a vehicle from a partial description; returns { vehicle, created }. */
async function ensureVehicle(values) {
  const hit = await findVehicle(values);
  if (hit) return { vehicle: hit, created: false };
  const cols = VEHICLE_KEYS.filter((k) => values[k] !== undefined && values[k] !== null && values[k] !== '');
  if (!cols.includes('manufacturer') || !cols.includes('model')) throw badRequest('A new vehicle needs at least manufacturer and model');
  const r = await db.run(`INSERT INTO vehicles (${cols.map((k) => `\`${k}\``).join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map((k) => values[k]));
  return { vehicle: await db.one('SELECT * FROM vehicles WHERE id = ?', [r.insertId]), created: true };
}

router.get(
  '/vehicles',
  requirePermission('*.read'),
  asyncRoute(async (req, res) => {
    const where = [];
    const params = [];
    for (const col of ['manufacturer', 'model', 'generation', 'engine', 'engine_code', 'fuel', 'body_type']) {
      if (req.query[col]) {
        where.push(`v.${col} = ?`);
        params.push(String(req.query[col]));
      }
    }
    const q = String(req.query.q ?? '').trim();
    if (q) {
      where.push(`(v.manufacturer LIKE ? OR v.model LIKE ? OR v.generation LIKE ? OR v.engine LIKE ? OR v.engine_code LIKE ?)`);
      for (let i = 0; i < 5; i++) params.push(like(q));
    }
    const year = req.query.year ? Number(req.query.year) : null;
    if (year) {
      where.push('(v.year_from IS NULL OR v.year_from <= ?)');
      where.push('(v.year_to IS NULL OR v.year_to >= ?)');
      params.push(year, year);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const page = Math.max(1, Number(req.query.page || 1));
    const size = Math.min(300, Math.max(1, Number(req.query.page_size || 50)));
    const total = Number(await db.value(`SELECT COUNT(*) FROM vehicles v ${clause}`, params) ?? 0);
    const items = await db.all(
      `SELECT v.*, (SELECT COUNT(*) FROM filter_vehicle_applications a WHERE a.vehicle_id = v.id) AS filter_count
       FROM vehicles v ${clause} ORDER BY v.manufacturer, v.model, COALESCE(v.year_from, 0) DESC LIMIT ? OFFSET ?`,
      [...params, size, (page - 1) * size],
    );
    res.json({ items, pagination: { page, page_size: size, total, pages: Math.max(1, Math.ceil(total / size)), has_more: page * size < total } });
  }),
);

router.post(
  '/vehicles',
  requirePermission('vehicles.create'),
  asyncRoute(async (req, res) => {
    const data = validate(VEHICLE_FIELDS, req.body);
    const existing = await findVehicle(data);
    if (existing) throw conflict(`${existing.manufacturer} ${existing.model}${existing.engine_code ? ` ${existing.engine_code}` : ''} is already vehicle #${existing.id}`);
    const out = await ensureVehicle(data);
    await audit(req.ctx, { action: 'create', entityType: 'vehicle', entityId: out.vehicle.id, entityLabel: `${out.vehicle.manufacturer} ${out.vehicle.model}`, summary: 'Vehicle added to the application catalogue' });
    res.status(201).json({ vehicle: out.vehicle });
  }),
);

router.put(
  '/vehicles/:id',
  requirePermission('vehicles.update'),
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, 'vehicle id');
    const before = await db.one('SELECT * FROM vehicles WHERE id = ?', [id]);
    if (!before) throw notFound('Vehicle not found');
    const data = validate(VEHICLE_FIELDS, req.body, { partial: true });
    const keys = Object.keys(data);
    if (!keys.length) throw badRequest('Nothing to update');
    await db.run(`UPDATE vehicles SET ${keys.map((k) => `\`${k}\`=?`).join(', ')} WHERE id = ?`, [...keys.map((k) => data[k]), id]);
    await auditUpdate(req.ctx, 'vehicle', id, `${data.manufacturer ?? before.manufacturer} ${data.model ?? before.model}`, before, await db.one('SELECT * FROM vehicles WHERE id = ?', [id]));
    res.json({ vehicle: await db.one('SELECT * FROM vehicles WHERE id = ?', [id]) });
  }),
);

router.delete(
  '/vehicles/:id',
  requirePermission('vehicles.delete'),
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, 'vehicle id');
    const used = Number(await db.value('SELECT COUNT(*) FROM filter_vehicle_applications WHERE vehicle_id = ?', [id]) ?? 0);
    if (used) throw conflict(`This vehicle is linked to ${used} filter(s) - remove those applications first so the history stays consistent`);
    const r = await db.run('DELETE FROM vehicles WHERE id = ?', [id]);
    if (!r.affectedRows) throw notFound('Vehicle not found');
    await audit(req.ctx, { action: 'delete', entityType: 'vehicle', entityId: id, summary: 'Vehicle removed' });
    res.json({ ok: true });
  }),
);

/* --------------------------------------------------------- families (§47) */
router.get('/families', asyncRoute(async (req, res) => {
  const items = await db.all(
    `SELECT ff.*, br.name AS brand_name,
            (SELECT COUNT(*) FROM tooling_family_members m WHERE m.family_id = ff.id) AS tool_count,
            (SELECT COUNT(*) FROM tooling_family_filters x WHERE x.family_id = ff.id) AS filter_count,
            (SELECT GROUP_CONCAT(f.internal_number ORDER BY f.internal_number SEPARATOR ', ')
               FROM tooling_family_filters x JOIN filters f ON f.id = x.filter_id WHERE x.family_id = ff.id) AS filters,
            (SELECT GROUP_CONCAT(CONCAT(ti.tooling_id, ' (', tt.code, ')') ORDER BY tt.sort_order SEPARATOR ' || ')
               FROM tooling_family_members m JOIN tooling_items ti ON ti.id = m.tooling_item_id JOIN tooling_types tt ON tt.id = ti.tooling_type_id
              WHERE m.family_id = ff.id AND ti.deleted_at IS NULL) AS shared_tooling
     FROM tooling_families ff LEFT JOIN brands br ON br.id = ff.brand_id ORDER BY ff.name`,
  );
  res.json({ items });
}));

router.post('/families', requirePermission('filters.create'), asyncRoute(async (req, res) => {
  const data = validate({ code: [str, { required: true, upper: true, max: 40 }], name: [str, { required: true, max: 160 }], brand: [str, { max: 40 }], description: [str, { max: 400 }] }, req.body);
  const brand = data.brand ? await db.one('SELECT id FROM brands WHERE code = ? OR name = ?', [data.brand.toUpperCase(), data.brand]) : null;
  const r = await db.run('INSERT INTO tooling_families (code, name, brand_id, description) VALUES (?,?,?,?)', [data.code, data.name, brand?.id ?? null, data.description ?? null]);
  await audit(req.ctx, { action: 'create', entityType: 'tooling_family', entityId: r.insertId, entityLabel: data.code, summary: 'Tooling family created' });
  res.status(201).json(await db.one('SELECT * FROM tooling_families WHERE id = ?', [r.insertId]));
}));

router.put('/families/:id', requirePermission('filters.update'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'family id');
  const data = validate({ name: [str, { max: 160 }], description: [str, { max: 400 }] }, req.body, { partial: true });
  const keys = Object.keys(data);
  if (!keys.length) throw badRequest('Nothing to update');
  await db.run(`UPDATE tooling_families SET ${keys.map((k) => `\`${k}\`=?`).join(',')} WHERE id = ?`, [...keys.map((k) => data[k]), id]);
  res.json(await db.one('SELECT * FROM tooling_families WHERE id = ?', [id]));
}));

router.post('/families/:id/members', requirePermission('filters.update'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'family id');
  const { tooling_ids, filter_ids } = validate({ tooling_ids: [idList, {}], filter_ids: [idList, {}] }, req.body);
  for (const t of tooling_ids) await db.run('INSERT INTO tooling_family_members (family_id, tooling_item_id, role) VALUES (?,?,"SHARED") ON DUPLICATE KEY UPDATE role = VALUES(role)', [id, t]);
  for (const f of filter_ids) await db.run('INSERT INTO tooling_family_filters (family_id, filter_id) VALUES (?,?) ON DUPLICATE KEY UPDATE family_id = VALUES(family_id)', [id, f]);
  await audit(req.ctx, { action: 'update', entityType: 'tooling_family', entityId: id, summary: `Added ${tooling_ids.length} tool(s) and ${filter_ids.length} filter(s) to family` });
  res.json({ ok: true, tools: tooling_ids.length, filters: filter_ids.length });
}));

router.delete('/families/:id/members/:toolingId', requirePermission('filters.update'), asyncRoute(async (req, res) => {
  await db.run('DELETE FROM tooling_family_members WHERE family_id = ? AND tooling_item_id = ?', [requireId(req.params.id, 'family id'), requireId(req.params.toolingId, 'tooling id')]);
  res.json({ ok: true });
}));

router.delete('/families/:id/filters/:filterId', requirePermission('filters.update'), asyncRoute(async (req, res) => {
  await db.run('DELETE FROM tooling_family_filters WHERE family_id = ? AND filter_id = ?', [requireId(req.params.id, 'family id'), requireId(req.params.filterId, 'filter id')]);
  res.json({ ok: true });
}));

router.delete('/families/:id', requirePermission('filters.delete'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'family id');
  await db.run('DELETE FROM tooling_families WHERE id = ?', [id]);
  await audit(req.ctx, { action: 'delete', entityType: 'tooling_family', entityId: id, summary: 'Tooling family deleted' });
  res.json({ ok: true });
}));

/** Filter families double as the "these filters share one tooling family" tag, so
 * a typo in a create form should not fail the save - create the label on demand. */
async function findOrCreateFilterFamily(nameOrCode, req) {
  const code = String(nameOrCode).trim().toUpperCase();
  const existing = await db.one('SELECT id FROM filter_families WHERE code = ? OR name = ?', [code, nameOrCode]);
  if (existing) return existing;
  const r = await db.run('INSERT INTO filter_families (code, name) VALUES (?,?)', [code.slice(0, 40), String(nameOrCode).slice(0, 160)]);
  await audit(req.ctx, { action: 'create', entityType: 'filter_family', entityId: r.insertId, entityLabel: code, summary: `Filter family ${code} created automatically` });
  return db.one('SELECT id FROM filter_families WHERE id = ?', [r.insertId]);
}

/* ------------------------------------------------- filter families (spec §47) */
router.get('/filter-families', asyncRoute(async (req, res) => {
  const items = await db.all(
    `SELECT ff.*, (SELECT COUNT(*) FROM filters f WHERE f.family_id = ff.id) AS filter_count,
            (SELECT GROUP_CONCAT(f.internal_number ORDER BY f.internal_number SEPARATOR ', ') FROM filters f WHERE f.family_id = ff.id) AS members
     FROM filter_families ff ORDER BY ff.name`,
  );
  res.json({ items });
}));

const FILTER_FAMILY_SCHEMA = {
  code: [str, { required: true, upper: true, max: 40, pattern: /^[A-Z0-9_-]+$/ }],
  name: [str, { required: true, max: 160 }],
  description: [str, { max: 400 }],
};

router.post('/filter-families', requirePermission('filters.create'), asyncRoute(async (req, res) => {
  const data = validate(FILTER_FAMILY_SCHEMA, req.body);
  if (await db.one('SELECT id FROM filter_families WHERE code = ?', [data.code])) throw conflict(`Filter family ${data.code} already exists`);
  const r = await db.run('INSERT INTO filter_families (code, name, description) VALUES (?,?,?)', [data.code, data.name, data.description ?? null]);
  await audit(req.ctx, { action: 'create', entityType: 'filter_family', entityId: r.insertId, entityLabel: data.code, summary: `Filter family ${data.name} created` });
  res.status(201).json(await db.one('SELECT * FROM filter_families WHERE id = ?', [r.insertId]));
}));

router.put('/filter-families/:id', requirePermission('filters.update'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'family id');
  const data = validate(FILTER_FAMILY_SCHEMA, req.body, { partial: true });
  const keys = Object.keys(data);
  if (!keys.length) throw badRequest('Nothing to update');
  const r = await db.run(`UPDATE filter_families SET ${keys.map((k) => `\`${k}\`=?`).join(',')} WHERE id = ?`, [...keys.map((k) => data[k]), id]);
  if (!r.affectedRows) throw notFound('Filter family not found');
  await audit(req.ctx, { action: 'update', entityType: 'filter_family', entityId: id, summary: `Filter family updated: ${keys.join(', ')}` });
  res.json(await db.one('SELECT * FROM filter_families WHERE id = ?', [id]));
}));

router.delete('/filter-families/:id', requirePermission('filters.delete'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'family id');
  const used = await db.value('SELECT COUNT(*) c FROM filters WHERE family_id = ?', [id]);
  if (Number(used) > 0) throw conflict(`${used} filter(s) still belong to this family - move them first`);
  await db.run('DELETE FROM filter_families WHERE id = ?', [id]);
  await audit(req.ctx, { action: 'delete', entityType: 'filter_family', entityId: id, summary: 'Filter family deleted' });
  res.json({ ok: true });
}));

/* -------------------------------------------------------------- single */
router.get(
  '/:ref',
  requirePermission('*.read'),
  asyncRoute(async (req, res) => {
    const filter = await getFilterOr404(req.params.ref);
    const exec = await db.rawDriver.executor();
    const [dimensions, materials, xrefs, applications, requirements, images, documents] = await Promise.all([
      exec.one('SELECT * FROM filter_dimensions WHERE filter_id = ?', [filter.id]),
      exec.one('SELECT * FROM filter_materials WHERE filter_id = ?', [filter.id]),
      exec.all('SELECT x.*, b.name AS brand_name FROM filter_cross_references x LEFT JOIN brands b ON b.id = x.brand_id WHERE x.filter_id = ? ORDER BY x.ref_type, x.ref_number', [filter.id]),
      exec.all(
        `SELECT a.id, a.quantity_per_vehicle, a.mounting_note, a.start_year, a.end_year, v.*
         FROM filter_vehicle_applications a JOIN vehicles v ON v.id = a.vehicle_id WHERE a.filter_id = ?
         ORDER BY v.manufacturer, v.model, v.year_from`,
        [filter.id],
      ),
      exec.all(
        `SELECT r.*, t.code AS type_code, t.name AS type_name, t.icon
         FROM filter_tooling_requirements r JOIN tooling_types t ON t.id = r.tooling_type_id WHERE r.filter_id = ? ORDER BY t.sort_order`,
        [filter.id],
      ),
      listFiles('FILTER', filter.id, 'image'),
      listFiles('FILTER', filter.id, 'document'),
    ]);
    res.json({ filter, dimensions: numericDimensions(dimensions, FILTER_DIMENSION_FIELDS), materials, xrefs, applications, requirements, images, documents, custom_fields: await customFields('FILTER') });
  }),
);

/* ------------------------------------------------------------ create/update */
const FILTER_SCHEMA = {
  internal_number: [str, { required: true, upper: true, max: 60, pattern: /^[A-Z0-9][A-Z0-9._/-]{1,59}$/, hint: 'letters, digits, - / . _' }],
  product_number: [str, { max: 80 }],
  name: [str, { max: 200 }],
  filter_type: [str, { required: true, max: 40 }],
  brand: [str, { max: 60 }],
  family: [str, { max: 40 }],
  description: [text, { max: 4000 }],
  status: oneOf(FILTER_STATUSES),
  is_active: [bool, { default: true }],
  notes: [text, { max: 4000 }],
};

/**
 * A filter can be created complete in one call: dimensions (converted from mm/cm/inch),
 * manufacturing materials, cross references and vehicle applications. Anything that is not
 * supplied is left untouched, and each applied block is reported back to the caller.
 */
async function applyFilterExtras(filterId, body = {}) {
  const applied = [];

  const rawDims = body.dimensions?.values ?? body.dimensions;
  if (rawDims && typeof rawDims === 'object' && !Array.isArray(rawDims)) {
    const unit = String(body.dimension_unit || body.dimensions?.unit || 'mm').toLowerCase();
    if (!['mm', 'cm', 'inch'].includes(unit)) throw badRequest('dimension_unit must be mm, cm or inch');
    const cols = [];
    const params = [];
    for (const [key, value] of Object.entries(rawDims)) {
      if (key === 'unit' || key === 'values' || value === undefined) continue;
      const field = FILTER_DIMENSION_FIELDS.find((f) => f.key === key);
      if (!field) continue;
      cols.push(`\`${key}\``);
      params.push(field.type === 'text' || value === null || value === '' ? (value === '' ? null : value) : toMm(value, unit));
    }
    if (cols.length) {
      await db.run('INSERT IGNORE INTO filter_dimensions (filter_id, unit) VALUES (?, ?)', [filterId, unit]);
      await db.run(`UPDATE filter_dimensions SET ${cols.map((c) => `${c} = ?`).join(', ')}, unit = ? WHERE filter_id = ?`, [...params, unit, filterId]);
      await db.tx(async (exec) => rebuildSearchBlob(exec, filterId));
      applied.push(`dimensions (${cols.length} field(s), stored in mm)`);
    }
  }

  if (body.materials && typeof body.materials === 'object') {
    const map = { media: 'media_type', media_type: 'media_type', media_code: 'media_code', glue: 'glue_type', glue_type: 'glue_type', gasket: 'gasket_material', gasket_material: 'gasket_material', rubber: 'rubber_material', rubber_material: 'rubber_material', end_cap: 'end_cap_material', end_cap_material: 'end_cap_material', mesh: 'mesh_type', mesh_type: 'mesh_type', machine: 'production_machine', production_machine: 'production_machine', batch_qty: 'standard_batch_qty', standard_batch_qty: 'standard_batch_qty', pleats: 'pleat_count', notes: 'notes' };
    const cols = [];
    const params = [];
    for (const [key, value] of Object.entries(body.materials)) {
      const column = map[key];
      if (!column || value === undefined || value === null || value === '') continue;
      cols.push(`\`${column}\``);
      params.push(value);
    }
    if (cols.length) {
      await db.run('INSERT IGNORE INTO filter_materials (filter_id) VALUES (?)', [filterId]);
      await db.run(`UPDATE filter_materials SET ${cols.join(' = ?, ')} = ? WHERE filter_id = ?`, [...params, filterId]);
      applied.push(`materials (${cols.length} field(s))`);
    }
  }

  for (const x of body.cross_references ?? []) {
    const ref = typeof x === 'string' ? { ref_number: x } : x ?? {};
    if (!ref.ref_number) continue;
    const brand = ref.brand ? await db.one('SELECT id FROM brands WHERE UPPER(code) = ? OR name = ?', [String(ref.brand).toUpperCase(), ref.brand]) : null;
    await db.run(
      `INSERT INTO filter_cross_references (filter_id, ref_type, brand_id, ref_number, notes) VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE ref_type = VALUES(ref_type), notes = VALUES(notes)`,
      [filterId, String(ref.ref_type || 'OEM').toUpperCase(), brand?.id ?? null, String(ref.ref_number).toUpperCase(), ref.notes ?? null],
    );
  }
  if (body.cross_references?.length) {
    await db.tx(async (exec) => rebuildSearchBlob(exec, filterId));
    applied.push(`cross references (${body.cross_references.length})`);
  }

  let linked = 0;
  for (const raw of body.applications ?? []) {
    const app = typeof raw === 'object' && raw ? raw : { vehicle_id: Number(raw) };
    let vehicleId = app.vehicle_id ?? null;
    if (!vehicleId) {
      const made = await ensureVehicle({
        manufacturer: app.manufacturer,
        model: app.model,
        generation: app.generation,
        engine: app.engine,
        engine_code: app.engine_code,
        fuel: app.fuel,
        power_hp: app.power_hp,
        year_from: app.year_from ?? app.start_year,
        year_to: app.year_to ?? app.end_year,
      });
      vehicleId = made.vehicle.id;
    }
    const r = await db.run(
      `INSERT INTO filter_vehicle_applications (filter_id, vehicle_id, start_year, end_year, quantity_per_vehicle, mounting_note)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE start_year = VALUES(start_year), end_year = VALUES(end_year)`,
      [filterId, vehicleId, app.start_year ?? app.year_from ?? null, app.end_year ?? app.year_to ?? null, app.quantity_per_vehicle ?? 1, app.mounting_note ?? null],
    );
    if (r.affectedRows) linked += 1;
  }
  if (linked) {
    await db.tx(async (exec) => rebuildSearchBlob(exec, filterId));
    applied.push(`vehicle applications (${linked})`);
  }

  return applied;
}

router.post('/', requirePermission('filters.create'), asyncRoute(async (req, res) => {
  const data = validate(FILTER_SCHEMA, req.body);
  const type = await db.one('SELECT id FROM filter_types WHERE code = ? OR name = ?', [data.filter_type.toUpperCase(), data.filter_type]);
  if (!type) throw badRequest(`Unknown filter type "${data.filter_type}". Create it in Settings first.`);
  const brand = data.brand ? await db.one('SELECT id FROM brands WHERE UPPER(code) = ? OR name = ?', [data.brand.toUpperCase(), data.brand]) : null;
  if (data.brand && !brand) {
    const known = (await db.all('SELECT name FROM brands ORDER BY name')).map((b) => b.name);
    const list = known.length > 12 ? `${known.slice(0, 12).join(', ')} (+${known.length - 12} more)` : known.join(', ');
    throw badRequest(`Brand "${data.brand}" does not exist. ${list ? `Known brands: ${list}.` : 'No brands are registered yet.'} Create the brand under Filters > Brands first.`);
  }
  const family = data.family ? await findOrCreateFilterFamily(data.family, req) : null;
  const dup = await db.one('SELECT id FROM filters WHERE internal_number = ?', [data.internal_number]);
  if (dup) throw conflict(`Filter ${data.internal_number} already exists`);
  const id = await db.tx(async (exec) => {
    const r = await exec.run(
      `INSERT INTO filters (internal_number, product_number, name, filter_type_id, brand_id, family_id, description, status, is_active, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [data.internal_number, data.product_number ?? null, data.name ?? data.internal_number, type.id, brand?.id ?? null, family?.id ?? null, data.description ?? null, data.status || 'ACTIVE', data.is_active ? 1 : 0, data.notes ?? null, req.user.id],
    );
    const newId = r.insertId;
    await exec.run('INSERT INTO filter_dimensions (filter_id, unit) VALUES (?, ?)', [newId, 'mm']);
    await exec.run('INSERT INTO filter_materials (filter_id) VALUES (?)', [newId]);
    await rebuildSearchBlob(exec, newId);
    return newId;
  });
  const extras = await applyFilterExtras(id, req.body);
  await audit(req.ctx, { action: 'create', entityType: 'filter', entityId: id, entityLabel: data.internal_number, summary: `Filter ${data.internal_number} created` });
  const row = await db.one(FILTER_SELECT + ' WHERE f.id = ?', [id]);
  res.status(201).json({ ...row, filter: row, ...(extras.length ? { applied: extras } : {}) });
}));

router.put(
  '/:id',
  requirePermission('filters.update'),
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, 'filter id');
    const before = await db.one('SELECT * FROM filters WHERE id = ?', [id]);
    if (!before) throw notFound('Filter not found');
    const data = validate(FILTER_SCHEMA, req.body, { partial: true });
    if (data.filter_type) {
      const type = await db.one('SELECT id FROM filter_types WHERE code = ? OR name = ?', [data.filter_type.toUpperCase(), data.filter_type]);
      if (!type) throw badRequest(`Unknown filter type "${data.filter_type}"`);
      data.filter_type_id = type.id;
      delete data.filter_type;
    }
    if (data.brand !== undefined) {
      const brand = data.brand ? await db.one('SELECT id FROM brands WHERE UPPER(code) = ? OR name = ?', [data.brand.toUpperCase(), data.brand]) : null;
      if (data.brand && !brand) {
    const known = (await db.all('SELECT name FROM brands ORDER BY name')).map((b) => b.name);
    const list = known.length > 12 ? `${known.slice(0, 12).join(', ')} (+${known.length - 12} more)` : known.join(', ');
    throw badRequest(`Brand "${data.brand}" does not exist. ${list ? `Known brands: ${list}.` : 'No brands are registered yet.'} Create the brand under Filters > Brands first.`);
  }
      data.brand_id = brand?.id ?? null;
      delete data.brand;
    }
    if (data.family !== undefined) {
      const fam = data.family ? await findOrCreateFilterFamily(data.family, req) : null;
      data.family_id = fam?.id ?? null;
      delete data.family;
    }
    if (typeof data.is_active === 'boolean') data.is_active = data.is_active ? 1 : 0;
    const keys = Object.keys(data).filter((k) => ['internal_number', 'product_number', 'name', 'filter_type_id', 'brand_id', 'family_id', 'description', 'status', 'is_active', 'notes'].includes(k));
    if (!keys.length) throw badRequest('Nothing to update');
    await db.run(`UPDATE filters SET ${keys.map((k) => `\`${k}\`=?`).join(',')}, updated_at = NOW() WHERE id = ?`, [...keys.map((k) => data[k]), id]);
    const after = await db.one('SELECT * FROM filters WHERE id = ?', [id]);
    await db.tx(async (exec) => rebuildSearchBlob(exec, id));
    await auditUpdate(req.ctx, 'filter', id, after.internal_number, before, after);
    const extras = await applyFilterExtras(id, req.body);
    const row = await db.one(FILTER_SELECT + ' WHERE f.id = ?', [id]);
    res.json({ ...row, filter: row, ...(extras.length ? { applied: extras } : {}) });
  }),
);

router.delete(
  '/:id',
  requirePermission('filters.delete'),
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, 'filter id');
    const filter = await db.one('SELECT internal_number, name FROM filters WHERE id = ?', [id]);
    if (!filter) throw notFound('Filter not found');
    const orders = await db.value('SELECT COUNT(*) c FROM production_orders WHERE filter_id = ? AND status IN ("PLANNED","READY","IN_PROGRESS","BLOCKED")', [id]);
    if (Number(orders) > 0) throw conflict(`${orders} open production order(s) still use this filter`);
    await db.tx(async (exec) => {
      await exec.run('UPDATE tooling_items SET primary_filter_id = NULL WHERE primary_filter_id = ?', [id]);
      await exec.run('UPDATE tooling_sets SET filter_id = NULL WHERE filter_id = ?', [id]);
      await exec.run('DELETE FROM filters WHERE id = ?', [id]);
    });
    await audit(req.ctx, { action: 'delete', entityType: 'filter', entityId: id, entityLabel: filter.internal_number, summary: `Filter ${filter.internal_number} deleted`, reason: req.query.reason ?? null });
    res.json({ ok: true, deleted: filter.internal_number });
  }),
);

/* --------------------------------------------------------- dimensions */
const DIM_SCHEMA = {};
for (const field of FILTER_DIMENSION_FIELDS) {
  DIM_SCHEMA[field.key] = field.type === 'text' ? [str, { max: 60 }] : [num, { min: 0, max: 100000 }];
}

router.put(
  '/:id/dimensions',
  requirePermission('dimensions.manage'),
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, 'filter id');
    const unit = String(req.body?.unit || 'mm').toLowerCase();
    if (!['mm', 'cm', 'inch'].includes(unit)) throw badRequest('unit must be mm, cm or inch');
    const data = validate(DIM_SCHEMA, req.body?.values ?? req.body, { partial: true });
    const toMmVal = (v) => (v === null || v === undefined ? null : toMm(v, unit));
    const keys = Object.keys(data).filter((k) => k !== 'custom_values');
    const sets = [];
    const params = [];
    for (const k of keys) {
      const field = FILTER_DIMENSION_FIELDS.find((fd) => fd.key === k);
      sets.push(`\`${k}\` = ?`);
      params.push(field?.type === 'text' ? data[k] : toMmVal(data[k]));
    }
    if (req.body?.custom_values !== undefined) {
      sets.push('custom_values = ?');
      params.push(req.body.custom_values ? JSON.stringify(req.body.custom_values) : null);
    }
    if (!sets.length) throw badRequest('No dimension values supplied');
    await db.run('INSERT IGNORE INTO filter_dimensions (filter_id, unit) VALUES (?, ?)', [id, unit]);
    await db.run(`UPDATE filter_dimensions SET ${sets.join(', ')}, unit = ? WHERE filter_id = ?`, [...params, unit, id]);
    await db.tx(async (exec) => rebuildSearchBlob(exec, id));
    await audit(req.ctx, { action: 'update', entityType: 'filter_dimensions', entityId: id, summary: `Dimensions updated (${keys.length} field(s), unit ${unit})` });
    res.json({ dimensions: await db.one('SELECT * FROM filter_dimensions WHERE filter_id = ?', [id]), unit });
  }),
);

/* --------------------------------------------------------- materials */
const MATERIAL_KEYS = ['media_type', 'media_code', 'glue_type', 'gasket_material', 'rubber_material', 'end_cap_material', 'mesh_type', 'production_machine', 'notes'];

router.put(
  '/:id/materials',
  requirePermission('dimensions.manage'),
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, 'filter id');
    const schema = {};
    for (const k of MATERIAL_KEYS) schema[k] = [str, { max: 200 }];
    schema.pleat_count = [num, { int: true, min: 0, max: 5000 }];
    schema.pleat_height_mm = [num, { min: 0 }];
    schema.standard_batch_qty = [num, { int: true, min: 1 }];
    schema.cycle_time_seconds = [num, { int: true, min: 0 }];
    const data = validate(schema, req.body, { partial: true });
    const keys = Object.keys(data);
    if (!keys.length) throw badRequest('Nothing to update');
    await db.run('INSERT IGNORE INTO filter_materials (filter_id) VALUES (?)', [id]);
    await db.run(`UPDATE filter_materials SET ${keys.map((k) => `\`${k}\`=?`).join(', ')} WHERE filter_id = ?`, [...keys.map((k) => data[k]), id]);
    await audit(req.ctx, { action: 'update', entityType: 'filter_materials', entityId: id, summary: `Manufacturing info updated (${keys.length} field(s))` });
    res.json({ materials: await db.one('SELECT * FROM filter_materials WHERE filter_id = ?', [id]) });
  }),
);

/* --------------------------------------------------------- cross refs */
router.post(
  '/:id/cross-references',
  requirePermission('dimensions.manage'),
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, 'filter id');
    const data = validate({ ref_number: [str, { required: true, upper: true, max: 100 }], ref_type: [str, { max: 30 }], brand: [str, { max: 60 }], notes: [str, { max: 400 }] }, req.body);
    const brand = data.brand ? await db.one('SELECT id FROM brands WHERE UPPER(code) = ? OR name = ?', [data.brand.toUpperCase(), data.brand]) : null;
    const dup = await db.one('SELECT id FROM filter_cross_references WHERE filter_id = ? AND ref_number = ?', [id, data.ref_number]);
    if (dup) throw conflict(`Cross reference ${data.ref_number} is already linked to this filter`);
    const r = await db.run('INSERT INTO filter_cross_references (filter_id, ref_type, brand_id, ref_number, notes) VALUES (?,?,?,?,?)', [
      id,
      (data.ref_type || 'OEM').toUpperCase(),
      brand?.id ?? null,
      data.ref_number,
      data.notes ?? null,
    ]);
    await db.tx(async (exec) => rebuildSearchBlob(exec, id));
    await audit(req.ctx, { action: 'create', entityType: 'filter_cross_reference', entityId: r.insertId, entityLabel: data.ref_number, summary: `Cross reference ${data.ref_number} added to filter #${id}` });
    res.status(201).json(await db.one('SELECT * FROM filter_cross_references WHERE id = ?', [r.insertId]));
  }),
);

router.delete(
  '/:id/cross-references/:xrefId',
  requirePermission('dimensions.manage'),
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, 'filter id');
    const r = await db.run('DELETE FROM filter_cross_references WHERE id = ? AND filter_id = ?', [requireId(req.params.xrefId, 'cross reference id'), id]);
    if (!r.affectedRows) throw notFound('Cross reference not found on this filter');
    await db.tx(async (exec) => rebuildSearchBlob(exec, id));
    await audit(req.ctx, { action: 'delete', entityType: 'filter_cross_reference', entityId: req.params.xrefId, summary: `Cross reference removed from filter #${id}` });
    res.json({ ok: true });
  }),
);

/* --------------------------------------------------------- applications */
router.post(
  '/:id/applications',
  requirePermission('dimensions.manage'),
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, 'filter id');
    const body = req.body ?? {};
    if (!body.vehicle_ids?.length && (body.manufacturer || body.new_vehicle || body.vehicle_id)) {
      // one application at a time, the way the floor adds a fitment
      const wanted = typeof body.new_vehicle === 'object' && body.new_vehicle ? body.new_vehicle : body;
      const base = {
        manufacturer: wanted.manufacturer,
        model: wanted.model,
        generation: wanted.generation,
        engine: wanted.engine,
        engine_code: wanted.engine_code,
        fuel: wanted.fuel,
        power_hp: wanted.power_hp,
        year_from: wanted.year_from ?? wanted.start_year,
        year_to: wanted.year_to ?? wanted.end_year,
      };
      let vehicle = body.vehicle_id ? await db.one('SELECT * FROM vehicles WHERE id = ?', [Number(body.vehicle_id)]) : null;
      if (!vehicle) {
        if (!base.manufacturer || !base.model) throw badRequest('Provide vehicle_ids, an existing vehicle_id, or manufacturer + model for a new vehicle');
        vehicle = null;
        const found = await findVehicle(base);
        if (found) vehicle = found;
      }
      let createdVehicle = false;
      if (!vehicle) {
        const out = await ensureVehicle(base);
        vehicle = out.vehicle;
        createdVehicle = out.created;
      }
      if (!vehicle) throw badRequest(`Vehicle #${body.vehicle_id} not found`);
      const startYear = validate({ y: [num, { int: true, min: 1900, max: 2100 }] }, { y: body.start_year ?? body.year_from ?? vehicle.year_from }, { partial: true }).y ?? null;
      const endYear = validate({ y: [num, { int: true, min: 1900, max: 2100 }] }, { y: body.end_year ?? body.year_to ?? vehicle.year_to }, { partial: true }).y ?? null;
      const r = await db.run(
        `INSERT INTO filter_vehicle_applications (filter_id, vehicle_id, start_year, end_year, quantity_per_vehicle, mounting_note)
         VALUES (?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE start_year = VALUES(start_year), end_year = VALUES(end_year), quantity_per_vehicle = VALUES(quantity_per_vehicle), mounting_note = VALUES(mounting_note)`,
        [id, vehicle.id, startYear, endYear, body.quantity_per_vehicle ?? 1, body.mounting_note ?? null],
      );
      await db.tx(async (exec) => rebuildSearchBlob(exec, id));
      await audit(req.ctx, { action: 'create', entityType: 'filter_application', entityId: r.insertId ?? id, entityLabel: `${vehicle.manufacturer} ${vehicle.model}`, summary: `Application ${vehicle.manufacturer} ${vehicle.model} linked to filter #${id}${createdVehicle ? ' (vehicle created)' : ''}` });
      const row = await db.one(
        `SELECT a.*, v.manufacturer, v.model, v.generation, v.engine, v.engine_code, v.fuel, v.power_hp, v.year_from, v.year_to
         FROM filter_vehicle_applications a JOIN vehicles v ON v.id = a.vehicle_id
         WHERE a.filter_id = ? AND a.vehicle_id = ?`,
        [id, vehicle.id],
      );
      return res.status(201).json({ application: row, vehicle, created_vehicle: createdVehicle, ok: true, added: 1 });
    }
    const data = validate(
      {
        vehicle_ids: [idList, { required: true }],
        new_vehicle: [text, { max: 0 }],
        quantity_per_vehicle: [num, { int: true, min: 1, max: 32 }],
        start_year: [num, { int: true, min: 1900, max: 2100 }],
        end_year: [num, { int: true, min: 1900, max: 2100 }],
        mounting_note: [str, { max: 400 }],
      },
      req.body,
      { partial: true },
    );
    let added = 0;
    for (const vid of data.vehicle_ids ?? []) {
      const exists = await db.one('SELECT id FROM vehicles WHERE id = ?', [vid]);
      if (!exists) throw badRequest(`Vehicle #${vid} not found`);
      await db.run(
        `INSERT INTO filter_vehicle_applications (filter_id, vehicle_id, start_year, end_year, quantity_per_vehicle, mounting_note)
         VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE start_year=VALUES(start_year), end_year=VALUES(end_year), quantity_per_vehicle=VALUES(quantity_per_vehicle), mounting_note=VALUES(mounting_note)`,
        [id, vid, data.start_year ?? null, data.end_year ?? null, data.quantity_per_vehicle ?? 1, data.mounting_note ?? null],
      );
      added += 1;
    }
    await db.tx(async (exec) => rebuildSearchBlob(exec, id));
    await audit(req.ctx, { action: 'create', entityType: 'filter_application', entityId: id, summary: `${added} vehicle application(s) linked` });
    res.json({ ok: true, added });
  }),
);

router.delete(
  '/:id/applications/:appId',
  requirePermission('dimensions.manage'),
  asyncRoute(async (req, res) => {
    const r = await db.run('DELETE FROM filter_vehicle_applications WHERE id = ? AND filter_id = ?', [requireId(req.params.appId, 'application id'), requireId(req.params.id, 'filter id')]);
    if (!r.affectedRows) throw notFound('Application not found');
    await db.tx(async (exec) => rebuildSearchBlob(exec, Number(req.params.id)));
    res.json({ ok: true });
  }),
);

router.get(
  '/:id/applications/search-vehicle',
  requirePermission('*.read'),
  asyncRoute(async (req, res) => {
    const like = `%${escapeLike(String(req.query.q ?? '').trim())}%`;
    if (like === '%%') return res.json({ items: [] });
    const items = await db.all(
      `SELECT v.*, COUNT(a.filter_id) AS used_by FROM vehicles v
       LEFT JOIN filter_vehicle_applications a ON a.vehicle_id = v.id
       WHERE v.manufacturer LIKE ? OR v.model LIKE ? OR v.engine LIKE ? OR v.engine_code LIKE ? OR v.generation LIKE ?
       GROUP BY v.id ORDER BY v.manufacturer, v.model LIMIT 30`,
      [like, like, like, like, like],
    );
    res.json({ items });
  }),
);

router.get(
  '/:id/applications',
  requirePermission('*.read'),
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, 'filter id');
    const items = await db.all(
      `SELECT a.id, a.filter_id, a.vehicle_id, a.start_year, a.end_year, a.quantity_per_vehicle, a.mounting_note,
              v.manufacturer, v.model, v.generation, v.engine, v.engine_code, v.fuel, v.power_hp, v.body_type,
              v.year_from, v.year_to
       FROM filter_vehicle_applications a JOIN vehicles v ON v.id = a.vehicle_id
       WHERE a.filter_id = ?
       ORDER BY v.manufacturer, v.model, COALESCE(a.start_year, v.year_from) DESC`,
      [id],
    );
    res.json({ items, count: items.length, display: items.map((r) => `${r.manufacturer} ${r.model}${r.generation ? ` ${r.generation}` : ''} ${r.start_year ?? r.year_from ?? ''}-${r.end_year ?? r.year_to ?? ''} ${r.engine ?? ''}`.replace(/\s+/g, ' ').trim()) });
  }),
);

/* --------------------------------------------------------- overview §57 */
router.get(
  '/:id/tooling-overview',
  requirePermission('*.read'),
  asyncRoute(async (req, res) => {
    const out = await toolingOverview(requireId(req.params.id, 'filter id'), { unit: req.query.unit || 'mm' });
    res.json(out);
  }),
);

router.get(
  '/:internal/overview',
  requirePermission('*.read'),
  asyncRoute(async (req, res) => {
    const filter = await getFilterOr404(req.params.internal);
    res.json(await toolingOverview(filter.id, { unit: req.query.unit || 'mm' }));
  }),
);

/* --------------------------------------------------------- requirements */
router.get('/:id/requirements', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const items = await db.all(
    `SELECT r.*, t.code AS type_code, t.name AS type_name, t.icon,
            (SELECT COUNT(*) FROM tooling_compatibility c JOIN tooling_items ti ON ti.id = c.tooling_item_id AND ti.deleted_at IS NULL
              WHERE c.filter_id = r.filter_id AND ti.tooling_type_id = r.tooling_type_id) AS linked
     FROM filter_tooling_requirements r JOIN tooling_types t ON t.id = r.tooling_type_id WHERE r.filter_id = ? ORDER BY t.sort_order`,
    [requireId(req.params.id, 'filter id')],
  );
  res.json({ items });
}));

router.post('/:id/requirements', requirePermission('dimensions.manage'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'filter id');
  const data = validate({ tooling_type_id: [idRef, { required: true }], quantity_required: [num, { int: true, min: 1, max: 99 }], is_mandatory: [bool, { default: true }], note: [str, { max: 255 }] }, req.body);
  const type = await db.one('SELECT id, name FROM tooling_types WHERE id = ?', [data.tooling_type_id]);
  if (!type) throw badRequest('Unknown tooling type');
  await db.run(
    `INSERT INTO filter_tooling_requirements (filter_id, tooling_type_id, quantity_required, is_mandatory, note) VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE quantity_required = VALUES(quantity_required), is_mandatory = VALUES(is_mandatory), note = VALUES(note)`,
    [id, type.id, data.quantity_required ?? 1, data.is_mandatory ? 1 : 0, data.note ?? null],
  );
  await syncFilterSets(id);
  await audit(req.ctx, { action: 'create', entityType: 'filter_requirement', entityId: id, summary: `${type.name} required for filter #${id}` });
  res.json({ ok: true });
}));

router.delete('/:id/requirements/:reqId', requirePermission('dimensions.manage'), asyncRoute(async (req, res) => {
  const r = await db.run('DELETE FROM filter_tooling_requirements WHERE id = ? AND filter_id = ?', [requireId(req.params.reqId, 'requirement id'), requireId(req.params.id, 'filter id')]);
  if (!r.affectedRows) throw notFound('Requirement not found');
  await syncFilterSets(Number(req.params.id));
  res.json({ ok: true });
}));

/* --------------------------------------------------------- compatibility links */
router.post('/:id/tooling', requirePermission('dimensions.manage'), asyncRoute(async (req, res) => {
  const filterId = requireId(req.params.id, 'filter id');
  const data = validate({ tooling_ids: [idList, { required: true }], level: oneOf(['EXACT', 'ALT', 'CANDIDATE']), note: [str, { max: 400 }] }, req.body);
  let linked = 0;
  for (const toolId of data.tooling_ids) {
    const tool = await db.one('SELECT id, tooling_id FROM tooling_items WHERE id = ? AND deleted_at IS NULL', [toolId]);
    if (!tool) throw badRequest(`Tooling #${toolId} not found`);
    await db.run(
      `INSERT INTO tooling_compatibility (tooling_item_id, filter_id, compatibility_level, is_primary, note, created_by)
       VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE compatibility_level = VALUES(compatibility_level), note = VALUES(note)`,
      [toolId, filterId, data.level || 'EXACT', 0, data.note ?? null, req.user.id],
    );
    linked += 1;
  }
  await db.tx(async (exec) => {
    await rebuildSearchBlob(exec, filterId);
  });
  await syncFilterSets(filterId);
  await audit(req.ctx, { action: 'link', entityType: 'filter', entityId: filterId, summary: `Linked ${linked} tooling item(s) to this filter` });
  res.json({ ok: true, linked });
}));

router.delete('/:id/tooling/:compatId', requirePermission('dimensions.manage'), asyncRoute(async (req, res) => {
  const filterId = requireId(req.params.id, 'filter id');
  const r = await db.run('DELETE FROM tooling_compatibility WHERE id = ? AND filter_id = ?', [requireId(req.params.compatId, 'link id'), filterId]);
  if (!r.affectedRows) throw notFound('Link not found');
  await syncFilterSets(filterId);
  res.json({ ok: true });
}));

/* --------------------------------------------------------- stock + packaging */
router.get('/:id/stock', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'filter id');
  const item = await db.one("SELECT * FROM inventory_items WHERE item_kind = 'FILTER' AND ref_id = ?", [id]);
  const lines = item
    ? await db.all(
        `SELECT i.*, l.code AS location_code, l.name AS location_name FROM inventory i
         LEFT JOIN inventory_locations l ON l.id = i.location_id WHERE i.inventory_item_id = ?`,
        [item.id],
      )
    : [];
  const txns = item
    ? await db.all(
        `SELECT t.*, u.username FROM inventory_transactions t LEFT JOIN users u ON u.id = t.user_id
         WHERE t.inventory_item_id = ? ORDER BY t.created_at DESC LIMIT 25`,
        [item.id],
      )
    : [];
  res.json({ item, lines, transactions: txns, total: lines.reduce((s, l) => s + Number(l.quantity), 0) });
}));

router.post('/:id/stock', requirePermission('inventory.update'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'filter id');
  const data = validate(
    {
      quantity: [num, { required: true, int: true, max: 10000000 }],
      txn_type: oneOf(['RECEIPT', 'ISSUE', 'ADJUSTMENT', 'SCRAP', 'RETURN', 'TRANSFER']),
      reason: [str, { max: 40 }],
      note: [str, { max: 400 }],
      location_code: [str, { max: 60 }],
      reference_no: [str, { max: 60 }],
    },
    req.body,
  );
  let item = await db.one("SELECT * FROM inventory_items WHERE item_kind = 'FILTER' AND ref_id = ?", [id]);
  if (!item) {
    const filter = await db.one('SELECT internal_number, name FROM filters WHERE id = ?', [id]);
    const r = await db.run("INSERT INTO inventory_items (item_kind, ref_id, sku, name, unit, is_active) VALUES ('FILTER', ?,?,?, 'PCS', 1)", [id, filter.internal_number, filter.name ?? filter.internal_number]);
    item = await db.one('SELECT * FROM inventory_items WHERE id = ?', [r.insertId]);
  }
  const loc = data.location_code ? await db.one('SELECT * FROM inventory_locations WHERE code = ?', [data.location_code.toUpperCase()]) : await db.one('SELECT * FROM inventory_locations ORDER BY code LIMIT 1');
  const signed = data.txn_type === 'ADJUSTMENT' ? data.quantity : data.txn_type === 'RECEIPT' || data.txn_type === 'RETURN' ? Math.abs(data.quantity) : -Math.abs(data.quantity);
  return res.json(await db.tx(async (exec) => {
    const inv = await exec.one('SELECT * FROM inventory WHERE inventory_item_id = ? AND (location_id = ? OR (? IS NULL AND location_id IS NULL))', [item.id, loc?.id ?? null, loc?.id ?? null]);
    const before = Number(inv?.quantity ?? 0);
    const after = before + signed;
    if (after < 0) throw conflict(`Not enough stock: ${before} pcs on hand, requested change ${signed}`);
    if (inv) await exec.run('UPDATE inventory SET quantity = ?, updated_at = NOW() WHERE id = ?', [after, inv.id]);
    else await exec.run('INSERT INTO inventory (inventory_item_id, location_id, quantity) VALUES (?,?,?)', [item.id, loc?.id ?? null, after]);
    await exec.run(
      `INSERT INTO inventory_transactions (inventory_item_id, location_id, txn_type, quantity, balance_after, reference_type, reference_no, reason, note, user_id)
       VALUES (?,?,?,?,?, 'MANUAL', ?,?,?,?)`,
      [item.id, loc?.id ?? null, data.txn_type, signed, after, data.reference_no ?? null, data.reason ?? null, data.note ?? null, req.user.id],
    );
    await audit(req.ctx, { action: `inventory.${data.txn_type.toLowerCase()}`, entityType: 'filter', entityId: id, entityLabel: item.sku, summary: `${data.txn_type} ${Math.abs(signed)} pcs (${before} -> ${after})` });
    return { ok: true, before, change: signed, after, sku: item.sku };
  }));
}));

router.put('/:id/packaging', requirePermission('dimensions.manage'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'filter id');
  const data = validate({ packaging_type: [str, { required: true, max: 60 }], units_per_pack: [num, { int: true, min: 1, max: 10000 }], available_packs: [num, { int: true, min: 0 }], notes: [str, { max: 400 }] }, req.body);
  const existing = await db.one('SELECT id FROM packaging_items WHERE filter_id = ? AND packaging_type = ?', [id, data.packaging_type.toUpperCase()]);
  if (existing) {
    await db.run(
      'UPDATE packaging_items SET units_per_pack = ?, available_packs = ?, notes = ?, updated_at = NOW() WHERE id = ?',
      [data.units_per_pack ?? 1, data.available_packs ?? 0, data.notes ?? null, existing.id],
    );
  } else {
    await db.run(
      'INSERT INTO packaging_items (filter_id, packaging_type, units_per_pack, available_packs, notes) VALUES (?,?,?,?,?)',
      [id, data.packaging_type.toUpperCase(), data.units_per_pack ?? 1, data.available_packs ?? 0, data.notes ?? null],
    );
  }
  res.json({ items: await db.all('SELECT * FROM packaging_items WHERE filter_id = ?', [id]) });
}));

router.delete('/:id/packaging/:packId', requirePermission('dimensions.manage'), asyncRoute(async (req, res) => {
  const filterId = requireId(req.params.id, 'filter id');
  const r = await db.run('DELETE FROM packaging_items WHERE id = ? AND filter_id = ?', [requireId(req.params.packId, 'packaging id'), filterId]);
  if (!r.affectedRows) throw notFound('Packaging row not found for that filter');
  await audit(req.ctx, { action: 'delete', entityType: 'packaging', entityId: req.params.packId, entityLabel: await db.value('SELECT internal_number FROM filters WHERE id = ?', [filterId]), summary: 'Packaging option removed' });
  res.json({ ok: true });
}));

/* --------------------------------------------------------- files */
router.get('/:id/files', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'filter id');
  res.json({ images: await listFiles('FILTER', id, 'image'), documents: await listFiles('FILTER', id, 'document') });
}));

router.post(
  '/:id/images',
  requirePermission('files.manage'),
  upload.array('files', 12),
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, 'filter id');
    const files = req.files ?? [];
    if (!files.length) throw badRequest('Attach at least one image file (field name: files)');
    const created = [];
    for (const [i, file] of files.entries()) {
      created.push(
        await addImage({
          ownerType: 'FILTER',
          ownerId: id,
          buffer: file.buffer,
          originalName: file.originalname,
          viewType: req.body?.view_type || 'DETAIL',
          caption: req.body?.caption || null,
          makePrimary: i === 0 && (req.body?.make_primary === '1' || req.body?.make_primary === 'true'),
          ctx: req.ctx,
        }),
      );
    }
    res.status(201).json({ items: created });
  }),
);

router.post(
  '/:id/documents',
  requirePermission('files.manage'),
  upload.array('files', 12),
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, 'filter id');
    const files = req.files ?? [];
    if (!files.length) throw badRequest('Attach at least one file');
    const created = [];
    for (const file of files) {
      created.push(await addDocument({ ownerType: 'FILTER', ownerId: id, buffer: file.buffer, originalName: file.originalname, docType: req.body?.doc_type || 'DRAWING', description: req.body?.description ?? null, ctx: req.ctx }));
    }
    res.status(201).json({ items: created });
  }),
);

router.put('/:id/images/:imageId', requirePermission('files.manage'), asyncRoute(async (req, res) => {
  await setImagePrimary(requireId(req.params.imageId, 'image id'));
  res.json({ ok: true });
}));

router.delete('/:id/images/:imageId', requirePermission('files.manage'), asyncRoute(async (req, res) => {
  await deleteImage(requireId(req.params.imageId, 'image id'), req.ctx);
  res.json({ ok: true });
}));

router.delete('/:id/documents/:docId', requirePermission('files.manage'), asyncRoute(async (req, res) => {
  await deleteDocument(requireId(req.params.docId, 'document id'), req.ctx);
  res.json({ ok: true });
}));

/* --------------------------------------------------------- custom fields */
router.get('/settings/custom-fields', requirePermission('*.read'), asyncRoute(async (req, res) => {
  res.json({ items: await customFields(req.query.entity === 'FILTER' ? 'FILTER' : 'TOOLING') });
}));

router.post('/settings/custom-fields', requirePermission('dimensions.manage'), asyncRoute(async (req, res) => {
  const data = validate({ entity: oneOf(['FILTER', 'TOOLING']), label: [str, { required: true, max: 120 }], field_key: [str, { max: 60 }], unit: [str, { max: 20 }], data_type: oneOf(['decimal', 'integer', 'text', 'boolean']) }, req.body);
  const row = await addCustomField(data);
  await audit(req.ctx, { action: 'create', entityType: 'custom_dimension_field', entityId: row.id, entityLabel: row.field_key, summary: `Custom ${data.entity} field "${data.label}" created` });
  res.status(201).json(row);
}));

router.delete('/settings/custom-fields/:id', requirePermission('dimensions.manage'), asyncRoute(async (req, res) => {
  await deleteCustomField(req.params.id);
  res.json({ ok: true });
}));

export default router;
