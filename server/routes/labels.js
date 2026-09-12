/** /api/labels — printable tool + shelf labels, raw codes, scan resolution (spec §15, §16, §44, §45). */
import express from 'express';
import db from '../db/index.js';
import { asyncRoute, badRequest, notFound } from '../lib/errors.js';
import { validate, str, num, bool, idList, idRef } from '../lib/validate.js';
import { requirePermission } from '../middleware/index.js';
import { labelSheet, payloadFor, qrSvg, qrPng, barcodeSvg, barcodePng, resolveScan, ensureCode } from '../services/labels.js';
import { audit } from '../services/audit.js';

const router = express.Router();

router.get('/templates', asyncRoute(async (req, res) => {
  res.json({ items: await db.all('SELECT * FROM label_templates WHERE kind = COALESCE(?, kind) ORDER BY kind, is_default DESC, width_mm', [req.query.kind ? String(req.query.kind).toUpperCase() : null]) });
}));

const TEMPLATE_SCHEMA = {
  name: [str, { required: true, max: 120 }],
  kind: [str, { max: 20 }],
  width_mm: [num, { min: 10, max: 400 }],
  height_mm: [num, { min: 5, max: 400 }],
  columns_per_row: [num, { int: true, min: 1, max: 10 }],
  rows_per_page: [num, { int: true, min: 1, max: 30 }],
  show_logo: [bool],
  show_type: [bool],
  show_filter: [bool],
  show_location: [bool],
  show_dimensions: [bool],
  show_status: [bool],
  font_scale: [num, { min: 0.5, max: 3 }],
  is_default: [bool],
};

router.post('/templates', requirePermission('labels.manage'), asyncRoute(async (req, res) => {
  const data = validate(TEMPLATE_SCHEMA, req.body);
  const r = await db.run(
    `INSERT INTO label_templates (name, kind, width_mm, height_mm, columns_per_row, rows_per_page, show_logo, show_type, show_filter, show_location, show_dimensions, show_status, font_scale, is_default)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      data.name,
      (data.kind ?? 'TOOLING').toUpperCase(),
      data.width_mm ?? 70,
      data.height_mm ?? 40,
      data.columns_per_row ?? 2,
      data.rows_per_page ?? 6,
      flag(data.show_logo, true),
      flag(data.show_type, true),
      flag(data.show_filter, true),
      flag(data.show_location, true),
      flag(data.show_dimensions, false),
      flag(data.show_status, true),
      data.font_scale ?? 1,
      flag(data.is_default, false),
    ],
  );
  const id = r.insertId ?? (await db.value('SELECT id FROM label_templates WHERE name = ?', [data.name]));
  if (data.is_default) await db.run('UPDATE label_templates SET is_default = 0 WHERE kind = (SELECT kind FROM label_templates WHERE id = ?) AND id <> ?', [id, id]);
  await audit(req.ctx, { action: 'create', entityType: 'label_template', entityId: id, entityLabel: data.name, summary: 'Label template created' });
  res.status(201).json(await db.one('SELECT * FROM label_templates WHERE id = ?', [id]));
}));

const flag = (v, dflt) => (v === undefined || v === null ? (dflt ? 1 : 0) : v ? 1 : 0);

router.put('/templates/:id', requirePermission('labels.manage'), asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const row = await db.one('SELECT * FROM label_templates WHERE id = ?', [id]);
  if (!row) throw notFound('Label template not found');
  const data = validate(TEMPLATE_SCHEMA, req.body, { partial: true });
  const keys = Object.keys(data).filter((k) => k !== 'kind');
  if (!keys.length) throw badRequest('Nothing to update');
  const values = keys.map((k) => (typeof data[k] === 'boolean' ? Number(data[k]) : data[k]));
  await db.run(`UPDATE label_templates SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, [...values, id]);
  if (data.is_default) await db.run('UPDATE label_templates SET is_default = 0 WHERE kind = ? AND id <> ?', [row.kind, id]);
  await audit(req.ctx, { action: 'update', entityType: 'label_template', entityId: id, entityLabel: row.name, summary: `Template updated: ${keys.join(', ')}` });
  res.json(await db.one('SELECT * FROM label_templates WHERE id = ?', [id]));
}));

router.delete('/templates/:id', requirePermission('labels.manage'), asyncRoute(async (req, res) => {
  const r = await db.run('DELETE FROM label_templates WHERE id = ? AND is_default = 0', [Number(req.params.id)]);
  if (!r.affectedRows) throw badRequest('The default template cannot be deleted - set another one as default first');
  await audit(req.ctx, { action: 'delete', entityType: 'label_template', entityId: req.params.id, summary: 'Label template deleted' });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------- sheets */
const SHEET_SCHEMA = {
  ids: [idList, { default: [] }],
  template_id: [idRef, {}],
  codes: [str, { max: 2000 }],
  resolve_codes: [bool, { default: true }],
};

async function resolveIds(kind, { ids, codes }) {
  const out = [...ids];
  const list = String(codes ?? '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const code of list) {
    const row =
      kind === 'tooling'
        ? await db.one('SELECT id FROM tooling_items WHERE tooling_id = ? OR barcode = ? LIMIT 1', [code.toUpperCase(), code])
        : await db.one('SELECT id FROM tooling_locations WHERE full_code = ? OR code = ? LIMIT 1', [code.toUpperCase(), code.toUpperCase()]);
    if (!row) throw notFound(`${kind} "${code}" was not found`);
    if (!out.includes(Number(row.id))) out.push(Number(row.id));
  }
  if (!out.length) throw badRequest('Provide ids (numbers) or codes (tooling IDs / location codes)');
  return out.slice(0, 200);
}

router.post('/sheet', requirePermission('labels.print'), asyncRoute(async (req, res) => {
  const data = validate(SHEET_SCHEMA, req.body);
  const kind = String(req.body.kind || 'tooling').toLowerCase();
  if (!['tooling', 'location'].includes(kind)) throw badRequest('kind must be tooling or location');
  const ids = await resolveIds(kind, data);
  const out = await labelSheet({ kind, ids, templateId: data.template_id, req });
  await audit(req.ctx, { action: 'print', entityType: 'label', summary: `${out.count} ${kind} label(s) printed (${out.template.name})` });
  if (req.query.format === 'html') return res.type('html').send(out.html);
  res.json(out);
}));

router.get('/sheet-print/:kind', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const kind = req.params.kind === 'locations' || req.params.kind === 'location' ? 'location' : 'tooling';
  const ids = await resolveIds(kind, { ids: [], codes: req.query.codes });
  const out = await labelSheet({ kind, ids, templateId: req.query.template_id ? Number(req.query.template_id) : null, req });
  res.type('html').send(out.html);
}));

/** Print every label that has never been printed yet (first roll for a new warehouse). */
router.post('/sheet/unprinted', requirePermission('labels.print'), asyncRoute(async (req, res) => {
  const kind = String(req.body?.kind || 'tooling').toLowerCase();
  const limit = Math.min(200, Math.max(1, Number(req.body?.limit || 60)));
  const rows =
    kind === 'location'
      ? await db.all('SELECT l.id FROM tooling_locations l ORDER BY l.full_code LIMIT ?', [limit])
      : await db.all('SELECT t.id FROM tooling_items t WHERE t.deleted_at IS NULL ORDER BY t.tooling_id LIMIT ?', [limit]);
  const out = await labelSheet({ kind, ids: rows.map((r) => r.id), templateId: req.body?.template_id ?? null, req });
  res.json(out);
}));

/* ---------------------------------------------------- raw codes for the UI */
router.get('/qr', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const { kind, code } = req.query;
  if (!kind || !code) throw badRequest('kind (tooling|location|filter|order) and code are required');
  const payload = await payloadFor(String(kind).toLowerCase(), String(code), req);
  if (String(req.query.format) === 'png') return res.type('image/png').send(await qrPng(payload, { width: Number(req.query.width || 320) }));
  res.type('image/svg+xml').send(await qrSvg(payload, { width: Number(req.query.width || 240) }));
}));

router.get('/barcode', requirePermission('*.read'), asyncRoute(async (req, res) => {
  if (!req.query.code) throw badRequest('code is required');
  const opts = { height: Number(req.query.height || 60), scale: Number(req.query.scale || 2) };
  if (String(req.query.format) === 'png') return res.type('image/png').send(await barcodePng(String(req.query.code), opts));
  res.type('image/svg+xml').send(await barcodeSvg(String(req.query.code), opts));
}));

router.get('/payload', requirePermission('*.read'), asyncRoute(async (req, res) => {
  res.json({ payload: await payloadFor(String(req.query.kind || 'tooling').toLowerCase(), String(req.query.code || ''), req) });
}));

/* ----------------------------------------------------------------- scan */
router.post('/scan', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const raw = req.body?.code ?? req.body?.text ?? req.body?.payload;
  const out = await resolveScan(raw, req);
  if (out.kind === 'tooling') {
    await ensureCode('TOOLING', out.id, out.code, { symbology: 'QR', payload: `SP:T:${out.code}`, targetUrl: `/t/${encodeURIComponent(out.code)}` });
  }
  res.json({
    ...out,
    detail_url:
      out.kind === 'tooling'
        ? `/api/tooling/code/${encodeURIComponent(out.code)}`
        : out.kind === 'location'
          ? `/api/warehouse/locations/${out.id}`
          : out.kind === 'filter'
            ? `/api/filters/${out.id}/tooling-overview`
            : `/api/production/${out.id}`,
  });
}));

export default router;
