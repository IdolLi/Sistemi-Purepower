/** /api/tooling — the tooling & housing module (spec §7-§12, §22, §33-§35, §46). */
import express from 'express';
import db from '../db/index.js';
import { asyncRoute, badRequest, notFound, conflict } from '../lib/errors.js';
import { validate, str, num, bool, oneOf, text, idRef, idList, escapeLike } from '../lib/validate.js';
import { requirePermission } from '../middleware/index.js';
import {
  STATUSES,
  CONDITION_RATINGS,
  TOOL_SELECT,
  getTooling,
  resolveTooling,
  loadToolingRecord,
  createTool,
  saveDimensions,
  setStatus,
  adjustCycles,
  archiveTooling,
  restoreTooling,
  setCompatibility,
  removeCompatibility,
  findPossibleDuplicates,
  snapshotRevision,
  nextToolingId,
  inventorySummary,
  dimensionSearch,
  suggestLocationFor,
  refreshReservedQty,
} from '../services/tooling.js';
import { TOOLING_DIMENSION_FIELDS } from '../seeds/catalog.js';
import { listFiles, addImage, addDocument, deleteImage, deleteDocument, setImagePrimary, updateImage, renderReference } from '../services/storage.js';
import { performMovement, reserveTooling, releaseReservation, logUsage } from '../services/movement.js';
import { suggest } from '../services/locations.js';
import { payloadFor, qrSvg, barcodeSvg } from '../services/labels.js';
import { upload } from './_upload.js';
import { audit, auditUpdate } from '../services/audit.js';
import { listResult, orderBy, requireId, toMm, convertFromMm } from './_helpers.js';
import { refreshOccupancy, refreshSetStatuses } from '../seeds/demo.js';
import { scanAllDuplicates } from '../services/tooling.js';

const router = express.Router();

/* ------------------------------------------------------------------ list */
router.get(
  '/',
  requirePermission('*.read'),
  asyncRoute(async (req, res) => {
    const q = req.query;
    const { page, size, offset, orderSql } = orderBy(
      q,
      ['tooling_id', 'name', 'status', 'updated_at', 'created_at', 'total_cycles', 'next_maintenance_date', 'quantity', 'id'],
      'tooling_id',
      'asc',
    );
    const where = [];
    const params = [];
    if (q.deleted === '1') where.push('t.deleted_at IS NOT NULL');
    else where.push('t.deleted_at IS NULL');
    if (q.q) {
      const like = `%${escapeLike(String(q.q).trim())}%`;
      where.push(`(t.tooling_id LIKE ? OR t.name LIKE ? OR t.serial_number LIKE ? OR t.barcode LIKE ? OR t.rubber_profile LIKE ? OR t.letter_type LIKE ?
        OR f.internal_number LIKE ? OR ts.code LIKE ? OR EXISTS (SELECT 1 FROM tooling_compatibility c2 JOIN filters f2 ON f2.id = c2.filter_id WHERE c2.tooling_item_id = t.id AND f2.internal_number LIKE ?))`);
      params.push(like, like, like, like, like, like, like, like, like);
    }
    if (q.type) {
      where.push('tt.code = ?');
      params.push(String(q.type).toUpperCase());
    }
    if (q.group) {
      where.push('tt.group_name = ?');
      params.push(String(q.group));
    }
    if (q.status) {
      const list = String(q.status).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
      where.push(`t.status IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
    if (q.filter_id) {
      where.push('EXISTS (SELECT 1 FROM tooling_compatibility c3 WHERE c3.tooling_item_id = t.id AND c3.filter_id = ?)');
      params.push(Number(q.filter_id));
    }
    if (q.set_id) {
      where.push('t.tooling_set_id = ?');
      params.push(Number(q.set_id));
    }
    if (q.location_id) {
      where.push('(t.location_id = ? OR t.location_id IN (SELECT id FROM tooling_locations WHERE parent_location_id = ?))');
      params.push(Number(q.location_id), Number(q.location_id));
    }
    if (q.warehouse_id) {
      where.push('tl.warehouse_id = ?');
      params.push(Number(q.warehouse_id));
    }
    if (q.maintenance_due === '1') {
      where.push(`(t.next_maintenance_date IS NOT NULL AND t.next_maintenance_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY))`, );
      params.push(Number(q.overdue_days ?? 14));
    }
    if (q.cycle_warning === '1') {
      where.push('t.max_cycles IS NOT NULL AND t.total_cycles * 100 >= t.max_cycles * t.cycle_warning_pct');
    }
    if (q.no_location === '1') where.push('t.location_id IS NULL AND t.external_location IS NULL AND t.status = "AVAILABLE"');
    if (q.open_damage === '1') where.push('t.open_damage_reports > 0');
    if (q.filter_type) {
      where.push('EXISTS (SELECT 1 FROM tooling_compatibility c4 JOIN filters f4 ON f4.id = c4.filter_id JOIN filter_types ft4 ON ft4.id = f4.filter_type_id WHERE c4.tooling_item_id = t.id AND ft4.code = ?)');
      params.push(String(q.filter_type).toUpperCase());
    }
    if (q.brand) {
      where.push('EXISTS (SELECT 1 FROM tooling_compatibility c5 JOIN filters f5 ON f5.id = c5.filter_id JOIN brands b5 ON b5.id = f5.brand_id WHERE c5.tooling_item_id = t.id AND (b5.code = ? OR b5.name LIKE ?))');
      params.push(String(q.brand).toUpperCase(), `%${q.brand}%`);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = await db.value(
      `SELECT COUNT(*) c FROM tooling_items t
       JOIN tooling_types tt ON tt.id = t.tooling_type_id
       LEFT JOIN tooling_locations tl ON tl.id = t.location_id
       LEFT JOIN filters f ON f.id = t.primary_filter_id
       LEFT JOIN tooling_sets ts ON ts.id = t.tooling_set_id ${whereSql}`,
      params,
    );
    const items = await db.all(
      `SELECT t.id, t.tooling_id, t.name, t.status, t.condition_rating, t.quantity, t.serial_number, t.material,
              t.total_cycles, t.max_cycles, t.reserved_qty, t.open_damage_reports, t.next_maintenance_date, t.last_used_at,
              t.current_revision, t.updated_at, t.created_at, t.qr_payload, t.barcode, t.rubber_profile, t.letter_type,
              t.location_id, t.external_location, t.notes, t.tooling_set_id, t.primary_filter_id, t.deleted_at,
              tt.code AS type_code, tt.name AS type_name, tt.icon, tt.group_name,
              f.internal_number AS filter_number, f.name AS filter_name,
              ts.code AS set_code, tl.full_code AS location_code, tl.label_path AS location_path,
              (SELECT COUNT(*) FROM tooling_compatibility c6 WHERE c6.tooling_item_id = t.id) AS compatible_filter_count,
              (SELECT im.id FROM tooling_images im WHERE im.owner_type='TOOLING' AND im.owner_id=t.id ORDER BY im.is_primary DESC, im.sort_order LIMIT 1) AS primary_image_id,
              d.overall_length_mm, d.overall_width_mm, d.overall_height_mm
       FROM tooling_items t
       JOIN tooling_types tt ON tt.id = t.tooling_type_id
       LEFT JOIN filters f ON f.id = t.primary_filter_id
       LEFT JOIN tooling_sets ts ON ts.id = t.tooling_set_id
       LEFT JOIN tooling_locations tl ON tl.id = t.location_id
       LEFT JOIN tooling_dimensions d ON d.tooling_item_id = t.id
       ${whereSql} ${orderSql} LIMIT ? OFFSET ?`,
      [...params, size, offset],
    );
    return res.json(listResult({ items, total: Number(total ?? 0), page, size }));
  }),
);

/* --------------------------------------------------- tooling types */
router.get('/types/list', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const items = await db.all(
    `SELECT t.*, (SELECT COUNT(*) FROM tooling_items i WHERE i.tooling_type_id = t.id AND i.deleted_at IS NULL) AS item_count,
            (SELECT COUNT(*) FROM filter_tooling_requirements r WHERE r.tooling_type_id = t.id) AS requirement_count
     FROM tooling_types t ${req.query.all === '1' ? '' : 'WHERE t.is_active = 1'} ORDER BY t.sort_order, t.name`,
  );
  res.json({ items });
}));

const TYPE_SCHEMA = {
  code: [str, { required: true, upper: true, max: 30, pattern: /^[A-Z0-9_]+$/ }],
  name: [str, { required: true, max: 160 }],
  group_name: [str, { max: 80 }],
  icon: [str, { max: 12 }],
  description: [str, { max: 400 }],
  id_prefix: [str, { max: 10, upper: true }],
  requires_cycle_tracking: [bool],
  requires_maintenance: [bool],
  sort_order: [num, { int: true, min: 0, max: 9999 }],
  is_active: [bool, { default: true }],
};

router.post('/types/list', requirePermission('tooling_types.manage'), asyncRoute(async (req, res) => {
  const data = validate(TYPE_SCHEMA, req.body);
  if (await db.one('SELECT id FROM tooling_types WHERE code = ?', [data.code])) throw conflict(`Tooling category ${data.code} already exists`);
  const r = await db.run(
    `INSERT INTO tooling_types (code, name, group_name, icon, description, id_prefix, requires_cycle_tracking, requires_maintenance, sort_order, is_active)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [data.code, data.name, data.group_name ?? null, data.icon ?? '🔧', data.description ?? null, data.id_prefix ?? data.code.slice(0, 3), data.requires_cycle_tracking ? 1 : 0, data.requires_maintenance === false ? 0 : 1, data.sort_order ?? 100, data.is_active ? 1 : 0],
  );
  await audit(req.ctx, { action: 'create', entityType: 'tooling_type', entityId: r.insertId, entityLabel: data.code, summary: `Tooling category ${data.name} created` });
  res.status(201).json(await db.one('SELECT * FROM tooling_types WHERE id = ?', [r.insertId]));
}));

router.put('/types/list/:id', requirePermission('tooling_types.manage'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'type id');
  const before = await db.one('SELECT * FROM tooling_types WHERE id = ?', [id]);
  if (!before) throw notFound('Tooling category not found');
  const data = validate(TYPE_SCHEMA, req.body, { partial: true });
  const keys = Object.keys(data);
  if (!keys.length) throw badRequest('Nothing to update');
  await db.run(`UPDATE tooling_types SET ${keys.map((k) => `\`${k}\`=?`).join(',')} WHERE id = ?`, [...keys.map((k) => (typeof data[k] === 'boolean' ? Number(data[k]) : data[k])), id]);
  await auditUpdate(req.ctx, 'tooling_type', id, before.code, before, await db.one('SELECT * FROM tooling_types WHERE id = ?', [id]));
  res.json(await db.one('SELECT * FROM tooling_types WHERE id = ?', [id]));
}));

router.delete('/types/list/:id', requirePermission('tooling_types.manage'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'type id');
  const used = await db.value('SELECT COUNT(*) c FROM tooling_items WHERE tooling_type_id = ?', [id]);
  if (Number(used) > 0) throw conflict(`${used} tooling item(s) use this category - deactivate it instead`);
  const r = await db.run('DELETE FROM tooling_types WHERE id = ? AND is_system = 0', [id]);
  if (!r.affectedRows) throw badRequest('System categories cannot be deleted - deactivate them instead');
  await audit(req.ctx, { action: 'delete', entityType: 'tooling_type', entityId: id, summary: 'Tooling category deleted' });
  res.json({ ok: true });
}));

/* --------------------------------------------------- status vocabulary + inventory */
router.get('/statuses', asyncRoute(async (req, res) => {
  res.json({ statuses: STATUSES, conditions: CONDITION_RATINGS, dimension_fields: TOOLING_DIMENSION_FIELDS });
}));

router.get('/inventory', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const byWarehouse = req.query.warehouse_id ? 'AND tl.warehouse_id = ?' : '';
  const params = req.query.warehouse_id ? [Number(req.query.warehouse_id)] : [];
  const items = await inventorySummary(byWarehouse, params);
  const totals = items.reduce(
    (acc, r) => {
      for (const k of ['total_qty', 'available', 'in_use', 'reserved', 'maintenance', 'damaged', 'missing', 'retired']) acc[k] = Number(acc[k] ?? 0) + Number(r[k] ?? 0);
      return acc;
    },
    {},
  );
  res.json({ items, totals, by_location: await db.all(`SELECT l.full_code, l.kind, COUNT(t.id) AS items, SUM(t.quantity) AS pieces
      FROM tooling_items t JOIN tooling_locations l ON l.id = t.location_id WHERE t.deleted_at IS NULL GROUP BY l.id, l.full_code, l.kind ORDER BY pieces DESC LIMIT 40`) });
}));

/* --------------------------------------------------- dimension search */
router.get('/dimension-search', requirePermission('*.read'), asyncRoute(async (req, res) => {
  res.json(
    await dimensionSearch({
      length: req.query.length,
      width: req.query.width,
      height: req.query.height,
      diameter: req.query.diameter,
      tolerance_mm: req.query.tolerance ?? 2,
      unit: req.query.unit || 'mm',
      type_code: req.query.type_code,
      filter_type_code: req.query.filter_type,
      brand: req.query.brand,
      rubber_profile: req.query.rubber_profile,
      letter_type: req.query.letter_type,
      location_id: req.query.location_id,
      limit: Number(req.query.limit || 25),
    }),
  );
}));

/* --------------------------------------------------- suggestions */
router.get('/suggest-location', requirePermission('*.read'), asyncRoute(async (req, res) => {
  res.json({ items: await suggest(req.query) });
}));

router.get('/next-id', requirePermission('*.read'), asyncRoute(async (req, res) => {
  if (!req.query.type) throw badRequest('type query param is required');
  res.json({ tooling_id: await nextToolingId(req.query.type, req.query.base) });
}));

/* --------------------------------------------------- comparison (spec §10) */
router.get('/compare', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
  if (ids.length < 2) throw badRequest('Provide at least two tooling ids or codes (?ids=H-00452-A,H-00781-A)');
  const items = [];
  for (const ref of ids) {
    const tool = await resolveTooling(ref);
    const record = await loadToolingRecord(tool.id, { unit: req.query.unit || 'mm' });
    items.push({
      tool: record.tool,
      dimensions: record.dimensions,
      images: record.images.slice(0, 3),
      compatibility: record.compatibility,
      location: tool.location_code ?? tool.external_location ?? null,
      filters: tool.compatible_filter_count,
    });
  }
  // compute pairwise similarity using the duplicate engine
  const pairs = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const dup = await findPossibleDuplicates(items[i].tool.id, { limit: 200 });
      const match = (dup.candidates ?? []).find((c) => c.id === items[j].tool.id);
      pairs.push({
        a: items[i].tool.tooling_id,
        b: items[j].tool.tooling_id,
        similarity_pct: match?.similarity_pct ?? 0,
        reasons: match?.reasons ?? ['no strong similarity'],
        possible_duplicate: !!match && match.similarity_pct >= Number(process.env.DUP_THRESHOLD || 88),
      });
    }
  }
  res.json({ items, pairs, unit: req.query.unit || 'mm' });
}));

/* --------------------------------------------------- duplicates */
router.get('/duplicates/scan', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const out = await scanAllDuplicates({ minSimilarity: Number(req.query.min_similarity || 88) });
  await audit(req.ctx, { action: 'scan', entityType: 'duplicate_check', summary: `Duplicate scan: ${out.flagged} pair(s) flagged` });
  res.json(out);
}));

router.get('/duplicates/open', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const items = await db.all(
    `SELECT dc.*, a.tooling_id AS code_a, a.name AS name_a, b.tooling_id AS code_b, b.name AS name_b,
            ta.name AS type_name, ua.full_code AS location_a, ub.full_code AS location_b,
            a.quantity AS qty_a, b.quantity AS qty_b, a.status AS status_a, b.status AS status_b,
            da.overall_length_mm AS la, da.overall_width_mm AS wa, da.overall_height_mm AS ha,
            db_.overall_length_mm AS lb, db_.overall_width_mm AS wb, db_.overall_height_mm AS hb
     FROM duplicate_checks dc
     JOIN tooling_items a ON a.id = dc.tooling_a_id
     JOIN tooling_items b ON b.id = dc.tooling_b_id
     JOIN tooling_types ta ON ta.id = a.tooling_type_id
     LEFT JOIN tooling_locations ua ON ua.id = a.location_id
     LEFT JOIN tooling_locations ub ON ub.id = b.location_id
     LEFT JOIN tooling_dimensions da ON da.tooling_item_id = a.id
     LEFT JOIN tooling_dimensions db_ ON db_.tooling_item_id = b.id
     WHERE dc.status = 'OPEN' ORDER BY dc.similarity_pct DESC LIMIT 100`,
  );
  res.json({ items, threshold: Number(process.env.DUP_THRESHOLD || 88) });
}));

router.post('/duplicates/:id/review', requirePermission('tooling.update'), asyncRoute(async (req, res) => {
  const data = validate({ status: oneOf(['RESOLVED', 'CONFIRMED_DUPLICATE', 'OPEN', 'IGNORED'], { required: true }), notes: [str, { max: 400 }] }, req.body);
  const id = requireId(req.params.id, 'check id');
  const r = await db.run('UPDATE duplicate_checks SET status=?, notes=?, reviewed_by=?, reviewed_at=NOW() WHERE id=?', [data.status, data.notes ?? null, req.user.id, id]);
  if (!r.affectedRows) throw notFound('Duplicate check not found');
  if (data.status === 'CONFIRMED_DUPLICATE' && data.notes !== '__keep__') {
    await audit(req.ctx, { action: 'duplicate_review', entityType: 'duplicate_check', entityId: id, summary: `Confirmed duplicate - ${data.notes ?? 'no note'}` });
  }
  res.json({ ok: true });
}));

/* --------------------------------------------------- sets */
router.get('/sets/list', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const { page, size, offset, orderSql } = orderBy(req.query, ['code', 'status', 'required_count', 'id'], 'code', 'asc');
  const where = ['1=1'];
  const params = [];
  if (req.query.status) {
    where.push('s.status = ?');
    params.push(String(req.query.status).toUpperCase());
  }
  if (req.query.q) {
    const like = `%${escapeLike(req.query.q)}%`;
    where.push('(s.code LIKE ? OR s.name LIKE ? OR f.internal_number LIKE ?)');
    params.push(like, like, like);
  }
  const total = await db.value(`SELECT COUNT(*) c FROM tooling_sets s LEFT JOIN filters f ON f.id = s.filter_id WHERE ${where.join(' AND ')}`, params);
  const items = await db.all(
    `SELECT s.*, f.internal_number AS filter_number, f.name AS filter_name, ft.name AS filter_type,
            (SELECT COUNT(*) FROM tooling_items ti WHERE ti.tooling_set_id = s.id AND ti.deleted_at IS NULL) AS items_count,
            (SELECT GROUP_CONCAT(CONCAT(ti.tooling_id, ':', ti.status) ORDER BY ti.tooling_id SEPARATOR '|') FROM tooling_items ti WHERE ti.tooling_set_id = s.id AND ti.deleted_at IS NULL) AS item_status
     FROM tooling_sets s
     LEFT JOIN filters f ON f.id = s.filter_id
     LEFT JOIN filter_types ft ON ft.id = f.filter_type_id
     WHERE ${where.join(' AND ')} ${orderSql} LIMIT ? OFFSET ?`,
    [...params, size, offset],
  );
  res.json(listResult({ items, total: Number(total), page, size }));
}));

router.post('/sets/list', requirePermission('tooling_sets.manage'), asyncRoute(async (req, res) => {
  const data = validate({ code: [str, { required: true, upper: true, max: 60 }], name: [str, { max: 160 }], filter_id: [idRef, {}], notes: [text, { max: 2000 }] }, req.body);
  if (await db.one('SELECT id FROM tooling_sets WHERE code = ?', [data.code])) throw conflict(`Tooling set ${data.code} already exists`);
  if (data.filter_id && !(await db.one('SELECT id FROM filters WHERE id = ?', [data.filter_id]))) throw badRequest('filter_id not found');
  const r = await db.run('INSERT INTO tooling_sets (code, name, filter_id, notes) VALUES (?,?,?,?)', [data.code, data.name ?? `${data.code} tooling set`, data.filter_id ?? null, data.notes ?? null]);
  await audit(req.ctx, { action: 'create', entityType: 'tooling_set', entityId: r.insertId, entityLabel: data.code, summary: 'Tooling set created' });
  res.status(201).json(await db.one('SELECT * FROM tooling_sets WHERE id = ?', [r.insertId]));
}));

router.get('/sets/list/:id', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'set id');
  const set = await db.one(
    `SELECT s.*, f.id AS filter_pk, f.internal_number AS filter_number, f.name AS filter_name, ft.name AS filter_type, fd.*
     FROM tooling_sets s
     LEFT JOIN filters f ON f.id = s.filter_id
     LEFT JOIN filter_types ft ON ft.id = f.filter_type_id
     LEFT JOIN filter_dimensions fd ON fd.filter_id = f.filter_id
     WHERE s.id = ?`,
    [id],
  );
  if (!set) throw notFound('Tooling set not found');
  const items = await db.all(
    `SELECT t.id, t.tooling_id, t.name, t.status, t.condition_rating, t.quantity, t.location_id, t.external_location,
            tt.code AS type_code, tt.name AS type_name, tt.icon, tl.full_code AS location_code,
            (SELECT im.id FROM tooling_images im WHERE im.owner_type='TOOLING' AND im.owner_id=t.id ORDER BY im.is_primary DESC LIMIT 1) AS primary_image_id
     FROM tooling_items t JOIN tooling_types tt ON tt.id = t.tooling_type_id
     LEFT JOIN tooling_locations tl ON tl.id = t.location_id
     WHERE t.tooling_set_id = ? AND t.deleted_at IS NULL ORDER BY tt.sort_order, t.tooling_id`,
    [id],
  );
  const requirements = set.filter_pk
    ? await db.all(
        `SELECT r.*, tt.code AS type_code, tt.name AS type_name,
                (SELECT COUNT(*) FROM tooling_compatibility c JOIN tooling_items ti ON ti.id = c.tooling_item_id AND ti.deleted_at IS NULL
                  WHERE c.filter_id = r.filter_id AND ti.tooling_type_id = r.tooling_type_id) AS have
         FROM filter_tooling_requirements r JOIN tooling_types tt ON tt.id = r.tooling_type_id WHERE r.filter_id = ?`,
        [set.filter_pk],
      )
    : [];
  res.json({ set: { ...set, items: items.length }, items, requirements });
}));

router.put('/sets/list/:id', requirePermission('tooling_sets.manage'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'set id');
  const data = validate({ name: [str, { max: 160 }], notes: [text, { max: 2000 }], filter_id: [idRef, {}] }, req.body, { partial: true });
  const keys = Object.keys(data);
  if (!keys.length) throw badRequest('Nothing to update');
  const r = await db.run(`UPDATE tooling_sets SET ${keys.map((k) => `\`${k}\`=?`).join(',')}, updated_at = NOW() WHERE id = ?`, [...keys.map((k) => data[k]), id]);
  if (!r.affectedRows) throw notFound('Tooling set not found');
  await refreshSetStatuses(null);
  res.json(await db.one('SELECT * FROM tooling_sets WHERE id = ?', [id]));
}));

router.post('/sets/list/:id/items', requirePermission('tooling_sets.manage'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'set id');
  const { tooling_ids, remove_ids } = validate({ tooling_ids: [idList, {}], remove_ids: [idList, {}] }, req.body);
  for (const t of tooling_ids) await db.run('UPDATE tooling_items SET tooling_set_id = ?, updated_at = NOW() WHERE id = ?', [id, t]);
  for (const t of remove_ids ?? []) await db.run('UPDATE tooling_items SET tooling_set_id = NULL WHERE id = ?', [t]);
  await refreshSetStatuses(null);
  await audit(req.ctx, { action: 'update', entityType: 'tooling_set', entityId: id, summary: `Set membership changed (+${tooling_ids.length}/-${(remove_ids ?? []).length})` });
  res.json({ ok: true });
}));

router.post('/sets/list/:id/refresh', requirePermission('tooling_sets.manage'), asyncRoute(async (req, res) => {
  const exec = await db.rawDriver.executor();
  await refreshSetStatuses(exec, { sets: [requireId(req.params.id, 'set id')] });
  res.json(await db.one('SELECT * FROM tooling_sets WHERE id = ?', [Number(req.params.id)]));
}));

router.delete('/sets/list/:id', requirePermission('tooling_sets.manage'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'set id');
  await db.run('UPDATE tooling_items SET tooling_set_id = NULL WHERE tooling_set_id = ?', [id]);
  await db.run('DELETE FROM tooling_sets WHERE id = ?', [id]);
  await audit(req.ctx, { action: 'delete', entityType: 'tooling_set', entityId: id, summary: 'Tooling set deleted (items kept)' });
  res.json({ ok: true });
}));

/* --------------------------------------------------- single tool */
router.get(
  '/:ref',
  requirePermission('*.read'),
  asyncRoute(async (req, res) => res.json(await loadToolingRecord(req.params.ref, { unit: req.query.unit || 'mm' }))),
);

router.get(
  '/code/:code',
  requirePermission('*.read'),
  asyncRoute(async (req, res) => {
    const tool = await resolveTooling(req.params.code);
    res.json(await loadToolingRecord(tool.id, { unit: req.query.unit || 'mm' }));
  }),
);

/* --------------------------------------------------- create / update */
const TOOL_SCHEMA = {
  tooling_id: [str, { max: 60, upper: true }],
  auto_id_type: [str, { max: 30 }],
  auto_id_base: [str, { max: 20 }],
  name: [str, { required: true, max: 200 }],
  tooling_type_id: [idRef, { required: true }],
  tooling_set_id: [idRef, {}],
  primary_filter_id: [idRef, {}],
  status: oneOf(STATUSES),
  condition_rating: oneOf(CONDITION_RATINGS),
  material: [str, { max: 120 }],
  manufacturer: [str, { max: 160 }],
  supplier: [str, { max: 160 }],
  weight_grams: [num, { min: 0 }],
  quantity: [num, { int: true, min: 1, max: 9999 }],
  serial_number: [str, { max: 80 }],
  barcode: [str, { max: 64 }],
  manufacturing_date: [str, { max: 20 }],
  purchase_date: [str, { max: 20 }],
  location_id: [idRef, {}],
  external_location: [str, { max: 200 }],
  rubber_profile: [str, { max: 120 }],
  letter_type: [str, { max: 80 }],
  logo_ref: [str, { max: 120 }],
  is_tracked: [bool, { default: true }],
  total_cycles: [num, { int: true, min: 0 }],
  max_cycles: [num, { int: true, min: 1 }],
  cycle_warning_pct: [num, { int: true, min: 50, max: 100 }],
  maintenance_interval_days: [num, { int: true, min: 1, max: 3650 }],
  maintenance_interval_cycles: [num, { int: true, min: 1 }],
  cost: [num, { min: 0 }],
  notes: [text, { max: 4000 }],
};

router.post('/', requirePermission('tooling.create'), asyncRoute(async (req, res) => {
  const body = { ...(req.body ?? {}) };
  // accept a category given by code or name, and a single linked filter, so imports/API clients work too
  if (!body.tooling_type_id && (body.tooling_type || body.category)) {
    const needle = String(body.tooling_type ?? body.category).trim();
    const found = await db.one('SELECT id FROM tooling_types WHERE code = ? OR name = ? OR id = ? LIMIT 1', [needle.toUpperCase(), needle, /^\d+$/.test(needle) ? Number(needle) : 0]);
    if (!found) {
      const codes = (await db.all('SELECT code FROM tooling_types WHERE is_active = 1 ORDER BY sort_order LIMIT 12')).map((t) => t.code);
      throw badRequest(`Unknown tooling category "${needle}". Use one of: ${codes.join(', ')} (or send tooling_type_id).`);
    }
    body.tooling_type_id = found.id;
    delete body.tooling_type;
    delete body.category;
  }
  if (!body.primary_filter_id && body.filter_id) {
    body.primary_filter_id = body.filter_id;
    delete body.filter_id;
  }
  const data = validate(TOOL_SCHEMA, body);
  const type = await db.one('SELECT id, code, name FROM tooling_types WHERE id = ?', [data.tooling_type_id]);
  if (!type) throw badRequest('tooling_type_id does not match an existing category - or send tooling_type with the category code');
  if (data.primary_filter_id && !(await db.one('SELECT id FROM filters WHERE id = ?', [data.primary_filter_id]))) throw badRequest('primary_filter_id not found');
  if (data.location_id) {
    const loc = await db.one('SELECT id, kind, status FROM tooling_locations WHERE id = ?', [data.location_id]);
    if (!loc) throw badRequest('location_id not found');
  }
  let toolingId = data.tooling_id;
  if (!toolingId) toolingId = await nextToolingId(type.code, data.auto_id_base ?? (data.primary_filter_id ? String(await db.value('SELECT internal_number FROM filters WHERE id = ?', [data.primary_filter_id])).slice(-5) : null));
  if (await db.one('SELECT id FROM tooling_items WHERE tooling_id = ?', [toolingId])) throw conflict(`Tooling ID ${toolingId} already exists`);
  const created = await createTool({ ...data, tooling_id: toolingId, created_by: req.user.id });
  if (req.body?.dimensions) await saveDimensions(created.id, normaliseDimensions(req.body.dimensions, req.body.unit), req.body.dimension_notes ?? null);
  if (req.body?.compatible_filter_ids?.length) {
    for (const fid of validate({ ids: [idList, {}] }, { ids: req.body.compatible_filter_ids }).ids ?? []) {
      await setCompatibility(created.id, fid, { level: 'EXACT' });
    }
  }
  await snapshotRevision(created.id, { change_summary: 'Initial record created', created_by: req.user.id, revision_no: 1 });
  await refreshOccupancy();
  await refreshSetStatuses();
  await audit(req.ctx, { action: 'create', entityType: 'tooling_item', entityId: created.id, entityLabel: toolingId, summary: `Tooling ${toolingId} (${type.name}) created` });
  res.status(201).json(await loadToolingRecord(created.id));
}));

function normaliseDimensions(values, unit) {
  const out = {};
  const u = String(unit || 'mm').toLowerCase();
  for (const field of TOOLING_DIMENSION_FIELDS) {
    const key = field.key;
    if (!(key in (values || {}))) continue;
    const raw = values[key];
    if (raw === null || raw === '' || raw === undefined) {
      out[key] = null;
      continue;
    }
    if (field.unit === 'mm') out[key] = toMm(raw, u);
    else if (field.key.endsWith('_position') || field.key === 'mounting_dimensions') out[key] = String(raw).slice(0, 200);
    else if (field.key === 'custom_values') out[key] = raw;
    else out[key] = Number.isFinite(Number(raw)) ? Number(raw) : null;
  }
  if (values?.custom_values !== undefined) out.custom_values = values.custom_values;
  return out;
}

router.put(
  '/:id',
  requirePermission('tooling.update'),
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, 'tooling id');
    const before = await getTooling(id);
    const data = validate(TOOL_SCHEMA, req.body, { partial: true });
    delete data.auto_id_type;
    delete data.auto_id_base;
    if (typeof data.is_tracked === 'boolean') data.is_tracked = data.is_tracked ? 1 : 0;
    const allowed = ['tooling_id', 'name', 'tooling_type_id', 'tooling_set_id', 'primary_filter_id', 'status', 'condition_rating', 'material', 'manufacturer', 'supplier', 'weight_grams', 'quantity', 'serial_number', 'barcode', 'manufacturing_date', 'purchase_date', 'location_id', 'external_location', 'rubber_profile', 'letter_type', 'logo_ref', 'is_tracked', 'total_cycles', 'max_cycles', 'cycle_warning_pct', 'maintenance_interval_days', 'maintenance_interval_cycles', 'cost', 'notes'];
    const keys = Object.keys(data).filter((k) => allowed.includes(k) && data[k] !== undefined);
    const dimsIn = req.body?.dimensions && typeof req.body.dimensions === 'object';
    if (!keys.length && !dimsIn) throw badRequest('Nothing to update - send a field or a dimensions object');
    const significant = keys.some((k) => ['material', 'quantity', 'max_cycles', 'tooling_type_id'].includes(k));
    const updateTx = async (exec) => {
      await exec.run(`UPDATE tooling_items SET ${keys.map((k) => `\`${k}\`=?`).join(',')}, updated_at = NOW() WHERE id = ?`, [...keys.map((k) => data[k]), id]);
      if (data.tooling_id && data.tooling_id !== before.tooling_id) {
        await exec.run('UPDATE tooling_items SET qr_payload = ? WHERE id = ?', [`SP:T:${data.tooling_id}`, id]);
      }
      if (data.primary_filter_id && Number(data.primary_filter_id) !== Number(before.primary_filter_id)) {
        await exec.run(
          `INSERT INTO tooling_compatibility (tooling_item_id, filter_id, compatibility_level, is_primary, created_by) VALUES (?,?, 'EXACT', 1, ?)
           ON DUPLICATE KEY UPDATE is_primary = 1`,
          [id, data.primary_filter_id, req.user.id],
        );
      }
      if (data.location_id !== undefined && Number(data.location_id) !== Number(before.location_id)) {
        const toLoc = data.location_id ? await exec.one('SELECT * FROM tooling_locations WHERE id = ?', [Number(data.location_id)]) : null;
        await exec.run(
          `INSERT INTO tooling_movements (tooling_item_id, movement_type, from_location_id, to_location_id, from_location_code, to_location_code, status_before, status_after, note, user_id, username, created_at)
           VALUES (?, 'MOVE', ?,?,?,?,?,?,?,?, ?, NOW())`,
          [id, before.location_id, toLoc?.id ?? null, before.location_code ?? null, toLoc?.full_code ?? null, before.status, before.status, 'Location set on record edit', req.user.id, req.user.username],
        );
      }
    };
    if (keys.length) await db.tx(updateTx);
    const after = await getTooling(id);
    if (keys.length) await auditUpdate(req.ctx, 'tooling_item', id, after.tooling_id, before, after);
    if (significant) {
      await snapshotRevision(id, { change_summary: `Record update: ${keys.join(', ')}`, created_by: req.user.id });
    }
    if (dimsIn) {
      await saveDimensions(id, normaliseDimensions(req.body.dimensions, req.body.unit), req.body.dimension_notes ?? null);
      await snapshotRevision(id, { change_summary: String(req.body.change_reason ?? 'Dimensions updated').slice(0, 255), created_by: req.user.id });
    }
    await refreshOccupancy();
    await refreshSetStatuses();
    res.json(await loadToolingRecord(id));
  }),
);

/* --------------------------------------------------- dimensions */
router.put(
  '/:id/dimensions',
  requirePermission('tooling.update'),
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, 'tooling id');
    const before = await db.one('SELECT * FROM tooling_dimensions WHERE tooling_item_id = ?', [id]);
    const dims = normaliseDimensions(req.body?.values ?? req.body, req.body?.unit);
    if (!Object.keys(dims).length) throw badRequest('No dimension values supplied');
    const after = await saveDimensions(id, dims, req.body?.notes ?? null);
    await auditUpdate(req.ctx, 'tooling_dimensions', id, (await getTooling(id)).tooling_id, before ?? {}, after ?? {}, {
      labels: Object.fromEntries(TOOLING_DIMENSION_FIELDS.map((f) => [f.key, f.label])),
      reason: req.body?.reason ?? null,
    });
    if (req.body?.snapshot === true || req.body?.new_revision === true) {
      await snapshotRevision(id, { change_summary: req.body?.change_summary ?? 'Dimensions revised', created_by: req.user.id });
    }
    res.json({ dimensions: await db.one('SELECT * FROM tooling_dimensions WHERE tooling_item_id = ?', [id]), unit: req.body?.unit || 'mm' });
  }),
);

/* --------------------------------------------------- compatibility (spec §12) */
router.put(
  '/:id/filters',
  requirePermission('compatibility.manage'),
  asyncRoute(async (req, res) => {
    const id = requireId(req.params.id, 'tooling id');
    const data = validate({ filter_ids: [idList, { required: true }], level: oneOf(['EXACT', 'ALT', 'CANDIDATE']) }, req.body);
    const tool = await getTooling(id);
    const existing = await db.all('SELECT id, filter_id FROM tooling_compatibility WHERE tooling_item_id = ?', [id]);
    const keep = new Set(data.filter_ids);
    for (const row of existing) if (!keep.has(Number(row.filter_id))) await db.run('DELETE FROM tooling_compatibility WHERE id = ?', [row.id]);
    for (const fid of data.filter_ids) await setCompatibility(id, fid, { level: data.level || 'EXACT' });
    if (data.filter_ids.length && !tool.primary_filter_id) {
      await db.run('UPDATE tooling_items SET primary_filter_id = ? WHERE id = ?', [data.filter_ids[0], id]);
    }
    await refreshSetStatuses();
    await audit(req.ctx, { action: 'update', entityType: 'tooling_item', entityId: id, entityLabel: tool.tooling_id, summary: `Compatibility set to ${data.filter_ids.length} filter(s)` });
    res.json({ ok: true, filters: data.filter_ids });
  }),
);

router.post('/:id/filters', requirePermission('compatibility.manage'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'tooling id');
  const data = validate({ filter_ids: [idList, { required: true }], level: oneOf(['EXACT', 'ALT', 'CANDIDATE']), note: [str, { max: 400 }] }, req.body);
  for (const fid of data.filter_ids) await setCompatibility(id, fid, { level: data.level || 'EXACT', note: data.note ?? null });
  await refreshSetStatuses();
  res.json({ ok: true, added: data.filter_ids.length });
}));

router.delete('/:id/filters/:linkId', requirePermission('compatibility.manage'), asyncRoute(async (req, res) => {
  await removeCompatibility(requireId(req.params.id, 'tooling id'), req.params.linkId);
  await refreshSetStatuses();
  res.json({ ok: true });
}));

/* --------------------------------------------------- status + movement */
router.post('/:id/status', requirePermission('tooling.update'), asyncRoute(async (req, res) => {
  const data = validate({ status: oneOf(STATUSES, { required: true }), reason: [str, { max: 400 }] }, req.body);
  const out = await setStatus(requireId(req.params.id, 'tooling id'), data.status, { reason: data.reason ?? null, ctx: req.ctx });
  await refreshOccupancy();
  res.json(out);
}));

const MOVE_SCHEMA = {
  action: oneOf(['TAKE', 'MOVE', 'RETURN', 'TRANSFER', 'SCRAP', 'INVENTORY_CHECK', 'MAINTENANCE', 'DAMAGE', 'MISSING', 'RELEASE'], { required: true }),
  location: [str, { max: 200 }],
  location_id: [idRef, {}],
  external: [str, { max: 200 }],
  production_order_id: [idRef, {}],
  qty: [num, { int: true, min: 1, max: 999 }],
  reason: [str, { max: 40 }],
  note: [str, { max: 500 }],
};

router.post('/:id/move', requirePermission('tooling.move'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'tooling id');
  const data = validate(MOVE_SCHEMA, { ...req.body, location: req.body?.location ?? req.body?.location_code ?? null });
  const out = await performMovement({
    tooling: id,
    action: data.action,
    location: data.location_id ?? data.location,
    external: data.external ?? null,
    production_order_id: data.production_order_id ?? null,
    qty: data.qty ?? 1,
    reason: data.reason ?? null,
    note: data.note ?? null,
    ctx: req.ctx,
  });
  res.json(out);
}));

router.post('/:id/reserve', requirePermission('tooling.reserve'), asyncRoute(async (req, res) => {
  const data = validate({ production_order_id: [idRef, { required: true }], qty: [num, { int: true, min: 1, max: 99 }], planned_start_at: [str, { max: 30 }], planned_end_at: [str, { max: 30 }], note: [str, { max: 400 }] }, req.body);
  const out = await reserveTooling({ tooling: requireId(req.params.id, 'tooling id'), ...data, ctx: req.ctx });
  await refreshReservedQty();
  res.json(out);
}));

router.post('/:id/release', requirePermission('tooling.reserve'), asyncRoute(async (req, res) => {
  const out = await releaseReservation({ tooling: requireId(req.params.id, 'tooling id'), production_order_id: req.body?.production_order_id ?? null, note: req.body?.note ?? null, ctx: req.ctx });
  await refreshReservedQty();
  res.json(out);
}));

router.post('/:id/usage', requirePermission('tooling.move'), asyncRoute(async (req, res) => {
  const data = validate({ cycles: [num, { int: true, min: 0, max: 1000000 }], produced_qty: [num, { int: true, min: 0 }], production_order_id: [idRef, {}], note: [str, { max: 400 }] }, req.body);
  const out = await logUsage({ tooling: requireId(req.params.id, 'tooling id'), ...data, ctx: req.ctx });
  res.json(out);
}));

router.post('/:id/cycles', requirePermission('tooling.inspect'), asyncRoute(async (req, res) => {
  const data = validate({ cycles: [num, { int: true, min: 0, max: 1000000 }], produced: [num, { int: true, min: 0 }], reset: [bool], note: [str, { max: 400 }] }, req.body);
  const out = await adjustCycles(requireId(req.params.id, 'tooling id'), data);
  await audit(req.ctx, { action: 'cycles', entityType: 'tooling_item', entityId: Number(req.params.id), summary: `Cycle counter ${data.reset ? 'reset' : `adjusted ${out.after - out.before}`}` });
  res.json(out);
}));

/* --------------------------------------------------- revisions (spec §27) */
router.get('/:id/revisions', requirePermission('*.read'), asyncRoute(async (req, res) => {
  res.json({ items: await db.all('SELECT * FROM tooling_revisions WHERE tooling_item_id = ? ORDER BY revision_no DESC', [requireId(req.params.id, 'tooling id')]) });
}));

router.post('/:id/revisions', requirePermission('revisions.manage'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'tooling id');
  const data = validate(
    {
      change_summary: [str, { required: true, max: 400 }],
      designer: [str, { max: 120 }],
      manufacturer: [str, { max: 160 }],
      material: [str, { max: 120 }],
      cost: [num, { min: 0 }],
      manufacturing_date: [str, { max: 20 }],
      cad_document_id: [idRef, {}],
      drawing_document_id: [idRef, {}],
      apply_to_item: [bool, { default: true }],
    },
    req.body,
  );
  const tool = await getTooling(id);
  const nextNo = Number(tool.current_revision ?? 1) + 1;
  const rev = await snapshotRevision(id, { change_summary: data.change_summary, created_by: req.user.id, revision_no: nextNo });
  await db.run(
    `UPDATE tooling_revisions SET designer=?, manufacturer=?, material=?, cost=?, manufacturing_date=?, cad_document_id=?, drawing_document_id=? WHERE id=?`,
    [data.designer ?? tool.created_by_name, data.manufacturer ?? tool.manufacturer, data.material ?? tool.material, data.cost ?? tool.cost, data.manufacturing_date ?? null, data.cad_document_id ?? null, data.drawing_document_id ?? null, rev.id],
  );
  if (data.apply_to_item) {
    await db.run(
      'UPDATE tooling_items SET current_revision = ?, material = COALESCE(?, material), manufacturer = COALESCE(?, manufacturer), cost = COALESCE(?, cost) WHERE id = ?',
      [nextNo, data.material ?? null, data.manufacturer ?? null, data.cost ?? null, id],
    );
  }
  await audit(req.ctx, { action: 'revision', entityType: 'tooling_item', entityId: id, entityLabel: tool.tooling_id, summary: `Revision ${nextNo}: ${data.change_summary}` });
  res.status(201).json(await db.one('SELECT * FROM tooling_revisions WHERE id = ?', [rev.id]));
}));

/* --------------------------------------------------- images + docs + codes */
router.get('/:id/files', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'tooling id');
  res.json({ images: await listFiles('TOOLING', id, 'image'), documents: await listFiles('TOOLING', id, 'document') });
}));

router.post('/:id/images', requirePermission('files.manage'), upload.array('files', 12), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'tooling id');
  const files = req.files ?? [];
  if (!files.length) throw badRequest('Attach at least one image (field name: files)');
  const hadPrimary = Number(await db.value('SELECT COUNT(*) c FROM tooling_images WHERE owner_type = ? AND owner_id = ? AND is_primary = 1', ['TOOLING', id])) > 0;
  const wantPrimary = req.body?.make_primary === '1' || req.body?.make_primary === 'true' || !hadPrimary;
  const created = [];
  for (const [i, file] of files.entries()) {
    created.push(
      await addImage({
        ownerType: 'TOOLING',
        ownerId: id,
        buffer: file.buffer,
        originalName: file.originalname,
        viewType: req.body?.view_type || 'DETAIL',
        caption: req.body?.caption || null,
        makePrimary: wantPrimary && i === 0,
        ctx: req.ctx,
      }),
    );
  }
  res.status(201).json({ items: created.map((c) => ({ ...c, url: `/api/files/tooling/${id}/images/${c.id}` })) });
}));

router.post('/:id/documents', requirePermission('files.manage'), upload.array('files', 12), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'tooling id');
  const files = req.files ?? [];
  if (!files.length) throw badRequest('Attach at least one file');
  const created = [];
  for (const file of files) {
    created.push(await addDocument({ ownerType: 'TOOLING', ownerId: id, buffer: file.buffer, originalName: file.originalname, docType: req.body?.doc_type || 'CAD', description: req.body?.description ?? null, ctx: req.ctx }));
  }
  res.status(201).json({ items: created.map((c) => ({ ...c, url: `/api/files/tooling/${id}/documents/${c.id}` })) });
}));

router.put('/:id/images/:imageId', requirePermission('files.manage'), asyncRoute(async (req, res) => {
  const imageId = requireId(req.params.imageId, 'image id');
  if (req.body?.make_primary === true || req.body?.make_primary === 'true') await setImagePrimary(imageId);
  const updated = await updateImage(imageId, { view_type: req.body?.view_type, caption: req.body?.caption, sort_order: req.body?.sort_order });
  res.json(updated);
}));

router.delete('/:id/images/:imageId', requirePermission('files.manage'), asyncRoute(async (req, res) => {
  await deleteImage(requireId(req.params.imageId, 'image id'), req.ctx);
  res.json({ ok: true });
}));

router.delete('/:id/documents/:docId', requirePermission('files.manage'), asyncRoute(async (req, res) => {
  await deleteDocument(requireId(req.params.docId, 'document id'), req.ctx);
  res.json({ ok: true });
}));

router.get('/:id/reference-image', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const { svg } = await renderReference(requireId(req.params.id, 'tooling id'), req.query.view || 'FRONT');
  res.type('image/svg+xml').set('Cache-Control', 'private, max-age=300').send(svg);
}));

router.get('/:id/qr', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const tool = await getTooling(req.params.id);
  const payload = await payloadFor('tooling', tool.tooling_id, req);
  if (String(req.query.format || 'svg') === 'png') {
    const QRCode = (await import('qrcode')).default;
    const buf = await QRCode.toBuffer(payload, { width: Number(req.query.width || 320), margin: 1 });
    return res.type('image/png').set('Content-Disposition', `inline; filename="${tool.tooling_id}.png"`).send(buf);
  }
  res.type('image/svg+xml').send(await qrSvg(payload, { width: Number(req.query.width || 240) }));
}));

router.get('/:id/barcode', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const tool = await getTooling(req.params.id);
  if (!tool.barcode) throw badRequest('This tooling record has no barcode value');
  res.type('image/svg+xml').send(await barcodeSvg(tool.barcode, { height: Number(req.query.height || 60), scale: Number(req.query.scale || 2) }));
}));

/* --------------------------------------------------- archive */
router.delete('/:id', requirePermission('tooling.manage'), asyncRoute(async (req, res) => {
  const out = await archiveTooling(requireId(req.params.id, 'tooling id'));
  await audit(req.ctx, { action: 'archive', entityType: 'tooling_item', entityId: req.params.id, entityLabel: out.tooling_id, summary: `Archived ${out.tooling_id} (soft delete - history preserved)`, reason: req.query.reason ?? null });
  res.json({ ok: true, ...out });
}));

router.post('/:id/restore', requirePermission('tooling.manage'), asyncRoute(async (req, res) => {
  await restoreTooling(requireId(req.params.id, 'tooling id'));
  await refreshOccupancy();
  await refreshSetStatuses();
  await audit(req.ctx, { action: 'restore', entityType: 'tooling_item', entityId: req.params.id, summary: 'Archived tooling restored' });
  res.json({ ok: true });
}));

router.get('/counts/by-status', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const items = await db.all("SELECT status, COUNT(*) AS records, SUM(quantity) AS pieces FROM tooling_items WHERE deleted_at IS NULL GROUP BY status ORDER BY FIELD(status,'AVAILABLE','RESERVED','IN_USE','MAINTENANCE','DAMAGED','MISSING','RETIRED')");
  res.json({ items });
}));

export default router;
