/** /api/maintenance — maintenance jobs, condition/damage reports, tooling requests (spec §20-§22). */
import express from 'express';
import db from '../db/index.js';
import { asyncRoute, badRequest, notFound, conflict } from '../lib/errors.js';
import { validate, str, num, bool, oneOf, text, idRef } from '../lib/validate.js';
import { requirePermission } from '../middleware/index.js';
import {
  MAINT_TYPES,
  MAINT_STATUSES,
  PRIORITIES,
  REQUEST_STATUSES,
  listMaintenance,
  scheduleMaintenance,
  completeMaintenance,
  updateMaintenance,
  deleteMaintenance,
  listDamage,
  createDamageReport,
  resolveDamageReport,
  listRequests,
  createRequest,
  transitionRequest,
  linkExistingTool,
  promoteRequestToTool,
  dueAlerts,
} from '../services/maintenance.js';
import { DAMAGE_TYPES } from '../seeds/catalog.js';
import { CONDITION_RATINGS } from '../services/tooling.js';
import { addImage, addDocument, listFiles, deleteImage } from '../services/storage.js';
import { upload } from './_upload.js';
import { audit } from '../services/audit.js';
import { listResult, requireId } from './_helpers.js';
import { resolveTooling } from '../services/tooling.js';

const router = express.Router();

router.get('/vocab', asyncRoute(async (req, res) => {
  res.json({
    maintenance_types: MAINT_TYPES,
    maintenance_statuses: MAINT_STATUSES,
    priorities: PRIORITIES,
    damage_types: DAMAGE_TYPES,
    request_statuses: REQUEST_STATUSES,
    conditions: CONDITION_RATINGS,
  });
}));

/* ------------------------------------------------------------- jobs */
router.get('/', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const out = await listMaintenance(req.query);
  res.json(listResult(out));
}));

const MAINT_SCHEMA = {
  tooling_item_id: [idRef, { required: true }],
  kind: oneOf(MAINT_TYPES),
  status: oneOf(MAINT_STATUSES),
  priority: oneOf(PRIORITIES),
  scheduled_date: [str, { max: 20 }],
  completed_date: [str, { max: 20 }],
  technician: [str, { max: 120 }],
  work_description: [text, { max: 4000 }],
  findings: [text, { max: 4000 }],
  condition_before: oneOf(CONDITION_RATINGS),
  condition_after: oneOf(CONDITION_RATINGS),
  parts_replaced: [str, { max: 400 }],
  cost: [num, { min: 0 }],
  downtime_hours: [num, { min: 0, max: 10000 }],
  next_maintenance_date: [str, { max: 20 }],
  damage_report_id: [idRef, {}],
};

router.post('/', requirePermission('maintenance.manage'), asyncRoute(async (req, res) => {
  const data = validate(MAINT_SCHEMA, req.body);
  const out = await scheduleMaintenance(data, req.ctx);
  res.status(201).json(out);
}));

router.get('/due', requirePermission('*.read'), asyncRoute(async (req, res) => {
  res.json(await dueAlerts({ days: Number(req.query.days || 14) }));
}));

router.get('/metrics', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const days = Math.min(365, Math.max(7, Number(req.query.days || 90)));
  res.json({
    days,
    by_type: await db.all(
      `SELECT kind, COUNT(*) AS jobs, COALESCE(SUM(cost),0) AS cost, COALESCE(SUM(downtime_hours),0) AS downtime_hours
       FROM tooling_maintenance WHERE created_at > DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY kind ORDER BY jobs DESC`,
      [days],
    ),
    by_month: await db.all(
      `SELECT DATE_FORMAT(COALESCE(completed_date, scheduled_date), '%Y-%m') AS month, COUNT(*) AS jobs,
              COALESCE(SUM(downtime_hours),0) AS downtime_hours, COALESCE(SUM(cost),0) AS cost
       FROM tooling_maintenance WHERE COALESCE(completed_date, scheduled_date) > DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY DATE_FORMAT(COALESCE(completed_date, scheduled_date), '%Y-%m') ORDER BY month`,
      [days],
    ),
    by_technician: await db.all(
      `SELECT technician, COUNT(*) AS jobs, COALESCE(AVG(DATEDIFF(completed_date, scheduled_date)),0) AS avg_delay_days
       FROM tooling_maintenance WHERE technician IS NOT NULL AND completed_date IS NOT NULL AND scheduled_date > DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY technician ORDER BY jobs DESC LIMIT 15`,
      [days],
    ),
    open_by_priority: await db.all(
      `SELECT priority, COUNT(*) AS jobs FROM tooling_maintenance WHERE status IN ('SCHEDULED','IN_PROGRESS','DEFERRED') GROUP BY priority`,
    ),
  });
}));

router.get('/:id(\\d+)', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'maintenance id');
  const row = await db.one(
    `SELECT m.*, t.tooling_id, t.name AS tooling_name, t.status AS tooling_status, t.location_id, l.full_code AS location_code,
            tt.name AS type_name, tt.icon, u.full_name AS created_by_name, d.report_no AS damage_report_no, d.damage_type, d.severity
     FROM tooling_maintenance m
     JOIN tooling_items t ON t.id = m.tooling_item_id
     JOIN tooling_types tt ON tt.id = t.tooling_type_id
     LEFT JOIN tooling_locations l ON l.id = t.location_id
     LEFT JOIN users u ON u.id = m.created_by
     LEFT JOIN tooling_damage_reports d ON d.id = m.damage_report_id
     WHERE m.id = ?`,
    [id],
  );
  if (!row) throw notFound('Maintenance record not found');
  const imageIds = [String(row.before_image_ids ?? ''), String(row.after_image_ids ?? '')].flatMap((s) => s.split(',')).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const images = imageIds.length
    ? await db.all(`SELECT * FROM tooling_images WHERE id IN (${imageIds.map(() => '?').join(',')})`, imageIds)
    : [];
  res.json({
    record: row,
    images: images.map((i) => ({ ...i, url: `/api/files/images/${i.id}` })),
    damage_report: row.damage_report_id ? await db.one('SELECT * FROM tooling_damage_reports WHERE id = ?', [row.damage_report_id]) : null,
    files: await listFiles('TOOLING', row.tooling_item_id, 'document'),
  });
}));

router.put('/:id', requirePermission('maintenance.manage'), asyncRoute(async (req, res) => {
  const data = validate(MAINT_SCHEMA, req.body, { partial: true });
  delete data.tooling_item_id;
  if (!Object.keys(data).length) throw badRequest('Nothing to update');
  res.json(await updateMaintenance(requireId(req.params.id, 'maintenance id'), data, req.ctx));
}));

router.post('/:id/complete', requirePermission('maintenance.manage'), asyncRoute(async (req, res) => {
  const data = validate(
    {
      completed_date: [str, { max: 20 }],
      technician: [str, { max: 120 }],
      work_description: [text, { max: 4000 }],
      findings: [text, { max: 4000 }],
      condition_after: oneOf(CONDITION_RATINGS),
      parts_replaced: [str, { max: 400 }],
      cost: [num, { min: 0 }],
      downtime_hours: [num, { min: 0, max: 10000 }],
      next_maintenance_date: [str, { max: 20 }],
      reset_cycles: [bool, { default: false }],
      return_to_service: [bool, { default: true }],
      before_image_ids: [str, { max: 255 }],
      after_image_ids: [str, { max: 255 }],
      allow_reopen: [bool, { default: false }],
    },
    req.body ?? {},
  );
  res.json(await completeMaintenance(requireId(req.params.id, 'maintenance id'), data, req.ctx));
}));

/** Attach before/after photos to a job (stored on the tooling owner, linked by id list). */
router.post('/:id/photos', requirePermission('maintenance.manage'), upload.array('files', 12), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'maintenance id');
  const row = await db.one('SELECT * FROM tooling_maintenance WHERE id = ?', [id]);
  if (!row) throw notFound('Maintenance record not found');
  const stage = String(req.body?.stage || 'AFTER').toUpperCase();
  if (!['BEFORE', 'AFTER'].includes(stage)) throw badRequest('stage must be BEFORE or AFTER');
  const files = req.files ?? [];
  if (!files.length) throw badRequest('Attach at least one image (field name: files)');
  const created = [];
  for (const file of files) {
    created.push(
      await addImage({
        ownerType: 'MAINTENANCE',
        ownerId: id,
        buffer: file.buffer,
        originalName: file.originalName ?? file.originalname,
        viewType: 'DETAIL',
        caption: `${stage} photo${file.originalname ? ` (${file.originalname})` : ''}`,
        makePrimary: false,
        ctx: req.ctx,
      }),
    );
  }
  const column = stage === 'BEFORE' ? 'before_image_ids' : 'after_image_ids';
  const existing = String(row[column] ?? '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  await db.run(`UPDATE tooling_maintenance SET \`${column}\` = ? WHERE id = ?`, [[...existing, ...created.map((c) => c.id)].join(',').slice(0, 255), id]);
  res.status(201).json({ stage, items: created.map((c) => ({ ...c, url: `/api/files/images/${c.id}` })) });
}));

router.delete('/:id', requirePermission('maintenance.manage'), asyncRoute(async (req, res) => {
  res.json(await deleteMaintenance(requireId(req.params.id, 'maintenance id'), req.ctx));
}));

/* ------------------------------------------------------- damage reports */
router.get('/damage', requirePermission('*.read'), asyncRoute(async (req, res) => {
  res.json(listResult(await listDamage(req.query)));
}));

router.post('/damage', requirePermission('tooling.inspect'), upload.any(), asyncRoute(async (req, res) => {
  const body = {
    tooling_item_id: req.body?.tooling_item_id,
    tooling_code: req.body?.tooling_code,
    damage_type: req.body?.damage_type,
    severity: req.body?.severity,
    location_note: req.body?.location_note,
    description: req.body?.description,
    production_order_id: req.body?.production_order_id,
    create_repair_request: req.body?.create_repair_request !== 'false',
    quarantine: req.body?.quarantine !== 'false',
    report_no: req.body?.report_no,
    technician: req.body?.technician,
  };
  let toolingId = body.tooling_item_id ? Number(body.tooling_item_id) : null;
  if (!toolingId && body.tooling_code) toolingId = (await resolveTooling(body.tooling_code)).id;
  if (!toolingId) {
    const err = badRequest('tooling_item_id (or tooling_code) is required');
    err.details = { fields: ['tooling_item_id'] };
    throw err;
  }
  const data = validate(
    {
      tooling_item_id: [idRef, { required: true }],
      damage_type: oneOf(DAMAGE_TYPES, { required: true }),
      severity: oneOf(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
      location_note: [str, { max: 255 }],
      description: [text, { max: 4000 }],
      production_order_id: [idRef, {}],
      report_no: [str, { max: 40, upper: true }],
      technician: [str, { max: 120 }],
      create_repair_request: [bool, { default: true }],
      quarantine: [bool, { default: true }],
    },
    { ...body, tooling_item_id: toolingId },
  );
  const out = await createDamageReport(data, req.ctx);
  const files = (req.files ?? []).filter((f) => f.fieldname === 'photos' || /^(photo|files)/.test(String(f.fieldname)));
  const imageIds = [];
  for (const file of files) {
    try {
      const img = await addImage({
        ownerType: 'DAMAGE_REPORT',
        ownerId: out.id,
        buffer: file.buffer,
        originalName: file.originalname,
        viewType: 'DAMAGE',
        caption: file.originalname,
        makePrimary: imageIds.length === 0,
        ctx: req.ctx,
      });
      imageIds.push(img.id);
    } catch (err) {
      out.photo_errors = [...(out.photo_errors ?? []), { file: file.originalname, error: err.message }];
    }
  }
  if (imageIds.length) {
    await db.run('UPDATE tooling_damage_reports SET photos_created = 1, image_ids = ? WHERE id = ?', [imageIds.join(','), out.id]);
  }
  res.status(201).json({ ...out, image_ids: imageIds });
}));

router.get('/damage/:id', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const row = await db.one(
    `SELECT d.*, t.tooling_id, t.name AS tooling_name, t.status AS tooling_status, t.location_id, l.full_code AS location_code,
            u.full_name AS reported_by_name, m.status AS maintenance_status, m.technician, tt.name AS type_name, tt.icon
     FROM tooling_damage_reports d
     JOIN tooling_items t ON t.id = d.tooling_item_id
     JOIN tooling_types tt ON tt.id = t.tooling_type_id
     LEFT JOIN tooling_locations l ON l.id = t.location_id
     LEFT JOIN users u ON u.id = d.reported_by
     LEFT JOIN tooling_maintenance m ON m.id = d.maintenance_id
     WHERE d.id = ?`,
    [requireId(req.params.id, 'report id')],
  );
  if (!row) throw notFound('Damage report not found');
  const images = await listFiles('DAMAGE_REPORT', row.id, 'image');
  res.json({ report: row, images: images.map((i) => ({ ...i, url: `/api/files/images/${i.id}` })) });
}));

router.post('/damage/:id/resolve', requirePermission('maintenance.manage'), asyncRoute(async (req, res) => {
  const data = validate(
    {
      status: oneOf(['RESOLVED', 'IGNORED', 'CONVERTED']),
      resolution: [str, { max: 500 }],
      maintenance_id: [idRef, {}],
      set_status: oneOf(['AVAILABLE', 'MAINTENANCE', 'DAMAGED', 'RETIRED', 'MISSING']),
    },
    req.body ?? {},
  );
  res.json(await resolveDamageReport(requireId(req.params.id, 'report id'), data, req.ctx));
}));

router.post('/damage/:id/photos', requirePermission('tooling.inspect'), upload.array('files', 12), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'report id');
  const row = await db.one('SELECT id, image_ids FROM tooling_damage_reports WHERE id = ?', [id]);
  if (!row) throw notFound('Damage report not found');
  const files = req.files ?? [];
  if (!files.length) throw badRequest('Attach at least one image');
  const created = [];
  for (const file of files) {
    created.push(await addImage({ ownerType: 'DAMAGE_REPORT', ownerId: id, buffer: file.buffer, originalName: file.originalname, viewType: 'DAMAGE', caption: file.originalname, ctx: req.ctx }));
  }
  const existing = String(row.image_ids ?? '')
    .split(',')
    .map(Number)
    .filter(Boolean);
  await db.run('UPDATE tooling_damage_reports SET photos_created = 1, image_ids = ? WHERE id = ?', [[...existing, ...created.map((c) => c.id)].join(','), id]);
  res.status(201).json({ items: created.map((c) => ({ ...c, url: `/api/files/images/${c.id}` })) });
}));

router.delete('/damage/photos/:imageId', requirePermission('files.manage'), asyncRoute(async (req, res) => {
  await deleteImage(requireId(req.params.imageId, 'image id'), req.ctx);
  res.json({ ok: true });
}));

/* -------------------------------------------------- tooling requests */
router.get('/requests', requirePermission('*.read'), asyncRoute(async (req, res) => {
  res.json(listResult(await listRequests({ ...req.query, user_id: req.user.id })));
}));

router.post('/requests', requirePermission('requests.manage'), asyncRoute(async (req, res) => {
  const data = validate(
    {
      title: [str, { required: true, max: 200 }],
      description: [text, { max: 4000 }],
      filter_id: [idRef, {}],
      tooling_type_id: [idRef, {}],
      priority: oneOf(PRIORITIES),
      quantity: [num, { int: true, min: 1, max: 1000 }],
      target_date: [str, { max: 20 }],
      requested_for_dept: [str, { max: 60 }],
      existing_tool_id: [idRef, {}],
      existing_tool_code: [str, { max: 60 }],
      estimate_cost: [num, { min: 0 }],
      request_no: [str, { max: 40, upper: true }],
    },
    req.body,
  );
  if (data.filter_id && !(await db.one('SELECT id FROM filters WHERE id = ?', [data.filter_id]))) throw badRequest('filter_id not found');
  if (data.tooling_type_id && !(await db.one('SELECT id FROM tooling_types WHERE id = ?', [data.tooling_type_id]))) throw badRequest('tooling_type_id not found');
  let existingToolId = data.existing_tool_id;
  if (!existingToolId && data.existing_tool_code) existingToolId = (await resolveTooling(data.existing_tool_code)).id;
  const out = await createRequest({ ...data, existing_tool_id: existingToolId ?? null }, req.ctx);
  res.status(201).json(out);
}));

/** "DO WE ALREADY HAVE THIS TOOL?" - answer a request with an existing tool. */
router.post('/requests/:id/link-existing', requirePermission('requests.manage'), asyncRoute(async (req, res) => {
  const data = validate({ tooling_item_id: [idRef, {}], tooling_code: [str, { max: 60 }] }, req.body);
  let toolId = data.tooling_item_id;
  if (!toolId && data.tooling_code) toolId = (await resolveTooling(data.tooling_code)).id;
  if (!toolId) throw badRequest('Provide tooling_item_id or tooling_code');
  res.json(await linkExistingTool(requireId(req.params.id, 'request id'), toolId, req.ctx));
}));

router.post('/requests/:id/status', requirePermission('requests.manage'), asyncRoute(async (req, res) => {
  const data = validate({ status: oneOf(REQUEST_STATUSES, { required: true }), reason: [str, { max: 400 }], note: [str, { max: 400 }], assigned_to: [idRef, {}], actual_cost: [num, { min: 0 }] }, req.body);
  if (data.status === 'REJECTED' && !data.reason) throw badRequest('A rejection needs a reason');
  res.json(await transitionRequest(requireId(req.params.id, 'request id'), data.status, data, req.ctx));
}));

/** Approved request -> real tooling record (with the usual tooling fields). */
router.post('/requests/:id/create-tooling', requirePermission('tooling.create'), asyncRoute(async (req, res) => {
  const data = validate(
    {
      name: [str, { required: true, max: 200 }],
      tooling_type_id: [idRef, {}],
      status: oneOf(['AVAILABLE', 'MAINTENANCE', 'DAMAGED', 'RESERVED', 'IN_USE']),
      condition_rating: oneOf(CONDITION_RATINGS),
      material: [str, { max: 120 }],
      manufacturer: [str, { max: 160 }],
      quantity: [num, { int: true, min: 1, max: 9999 }],
      location: [str, { max: 200 }],
      max_cycles: [num, { int: true, min: 1 }],
      notes: [text, { max: 4000 }],
      dimensions: [(v) => ({ ok: !v || typeof v === 'object', message: 'dimensions must be an object', value: v ?? null })],
    },
    req.body,
  );
  const type = data.tooling_type_id ?? (await db.value('SELECT requested_tooling_type_id FROM tooling_requests WHERE id = ?', [requireId(req.params.id, 'request id')]));
  if (!type) throw badRequest('tooling_type_id is required (the request has no category to inherit)');
  const { createTool, saveDimensions, nextToolingId } = await import('../services/tooling.js');
  const { performMovement } = await import('../services/movement.js');
  const requestRow = await db.one('SELECT * FROM tooling_requests WHERE id = ?', [Number(req.params.id)]);
  if (!requestRow) throw notFound('Tooling request not found');
  if (!['APPROVED', 'IN_PRODUCTION'].includes(requestRow.status)) throw conflict(`Only an approved request can be turned into tooling (this one is ${requestRow.status})`);
  const typeRow = await db.one('SELECT id, code FROM tooling_types WHERE id = ?', [type]);
  if (!typeRow) throw badRequest('tooling_type_id not found');
  const toolingId = await nextToolingId(typeRow.code, requestRow.filter_id ? String(await db.value('SELECT internal_number FROM filters WHERE id = ?', [requestRow.filter_id]) ?? '').slice(-5) : null);
  const created = await createTool({
    tooling_id: toolingId,
    name: data.name,
    tooling_type_id: typeRow.id,
    primary_filter_id: requestRow.filter_id,
    status: data.status ?? 'AVAILABLE',
    condition_rating: data.condition_rating ?? 'EXCELLENT',
    material: data.material ?? null,
    manufacturer: data.manufacturer ?? null,
    quantity: data.quantity ?? requestRow.quantity ?? 1,
    max_cycles: data.max_cycles ?? null,
    notes: data.notes ?? `Created from request ${requestRow.request_no}`,
    created_by: req.user.id,
  });
  if (data.dimensions) await saveDimensions(created.id, data.dimensions);
  let locationApplied = false;
  if (data.location) {
    await performMovement({ tooling: created.id, action: 'MOVE', location: data.location, note: `Initial storage of new tooling from ${requestRow.request_no}`, ctx: req.ctx });
    locationApplied = true;
  }
  await db.run("UPDATE tooling_requests SET status='COMPLETED', created_tooling_id = ?, completed_at = NOW(), updated_at = NOW() WHERE id = ?", [created.id, requestRow.id]);
  await audit(req.ctx, { action: 'create', entityType: 'tooling_item', entityId: created.id, entityLabel: toolingId, summary: `New tooling ${toolingId} created from request ${requestRow.request_no}` });
  const { refreshOccupancy, refreshSetStatuses } = await import('../seeds/demo.js');
  await refreshOccupancy();
  await refreshSetStatuses();
  res.status(201).json({ ok: true, request_no: requestRow.request_no, location_applied: locationApplied, tooling: created });
}));

router.get('/requests/stats', requirePermission('*.read'), asyncRoute(async (req, res) => {
  res.json({
    by_status: await db.all('SELECT status, COUNT(*) AS c FROM tooling_requests GROUP BY status'),
    avg_days: await db.value(
      `SELECT ROUND(AVG(DATEDIFF(COALESCE(completed_at, updated_at), created_at)), 1) FROM tooling_requests WHERE status IN ('COMPLETED','REJECTED')`,
    ),
  });
}));

export default router;
