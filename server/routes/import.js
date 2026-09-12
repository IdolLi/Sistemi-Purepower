/** /api/import — Excel/CSV upload with a validation pass before anything is written (spec §42). */
import express from 'express';
import multer from 'multer';
import config from '../config.js';
import { asyncRoute, badRequest } from '../lib/errors.js';
import { requirePermission } from '../middleware/index.js';
import { IMPORT_SPECS, importTemplate, importRows, readWorksheet } from '../services/reports.js';
import { parseCsv, normaliseCsvRows } from '../services/export.js';
import { HEADER_ALIASES } from '../services/importAliases.js';
import { audit } from '../services/audit.js';
import db from '../db/index.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

router.get('/templates', requirePermission('*.read'), asyncRoute(async (req, res) => {
  res.json({
    kinds: Object.entries(IMPORT_SPECS).map(([code, spec]) => ({
      code,
      title: spec.title,
      required: spec.columns.filter((c) => c.required).map((c) => c.label),
      columns: spec.columns,
      lookups: spec.lookups,
    })),
  });
}));

router.get('/templates/:kind.xlsx', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const buffer = await importTemplate(req.params.kind);
  await audit(req.ctx, { action: 'download_template', entityType: 'import', entityLabel: req.params.kind, summary: `Downloaded the ${req.params.kind} import template` });
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .set('Content-Disposition', `attachment; filename="import-${req.params.kind}-template.xlsx"`)
    .end(Buffer.from(buffer));
}));

async function readUpload(file) {
  const name = String(file.originalname ?? '').toLowerCase();
  if (/\.(csv|txt)$/.test(name)) {
    const parsed = parseCsv(file.buffer.toString('utf8'));
    return { ...parsed, source: 'csv', rows: normaliseCsvRows(parsed, HEADER_ALIASES) };
  }
  if (!/\.xlsx?$/.test(name)) throw badRequest('Upload an .xlsx (the template) or a .csv file');
  const parsed = await readWorksheet(file.buffer);
  const remapped = parsed.rows.map((row) => {
    const out = { __row: row.__row };
    for (const [key, value] of Object.entries(row)) if (key !== '__row' && key !== '__sheet') out[key] = value;
    return out;
  });
  return { ...parsed, rows: remapped, source: 'xlsx' };
}

/** Validate only (default) - returns a per-row report and changes nothing. */
router.post('/:kind/validate', requirePermission('importexport.manage'), upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) throw badRequest('Attach the spreadsheet in the "file" field');
  const parsed = await readUpload(req.file);
  const out = await importRows(req.params.kind, { rows: parsed.rows, dryRun: true, actor: req.user });
  res.json({ file: req.file.originalname, bytes: req.file.size, ...out });
}));

router.post('/:kind', requirePermission('importexport.manage'), upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) throw badRequest('Attach the spreadsheet in the "file" field');
  const parsed = await readUpload(req.file);
  if (!parsed.rows.length) throw badRequest('No data rows found below the header');
  const out = await importRows(req.params.kind, { rows: parsed.rows, dryRun: req.query.dry_run === '1', actor: req.user, ctx: req.ctx });
  res.json({ file: req.file.originalname, source: parsed.source, sheet: parsed.sheetName, ...out, import_limits: { max_bytes: config.uploads.maxDocBytes, max_rows: 5000 } });
}));

/** Paste-in import (same validator, no file) - handy on a phone. */
router.post('/:kind/paste', requirePermission('importexport.manage'), asyncRoute(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rows?.length) throw badRequest('Body must be { rows: [ { column: value, ... }, ... ] }');
  if (rows.length > 2000) throw badRequest('Paste at most 2000 rows at a time');
  const out = await importRows(req.params.kind, { rows: rows.map((r, i) => ({ ...r, __row: i + 2 })), dryRun: req.body?.dry_run !== false, actor: req.user, ctx: req.ctx });
  res.json(out);
}));

router.get('/history', requirePermission('importexport.manage'), asyncRoute(async (req, res) => {
  res.json({
    items: await db.all(
      `SELECT id, username, action, entity_type, summary, created_at FROM audit_logs
       WHERE action = 'import' ORDER BY id DESC LIMIT 30`,
    ),
  });
}));

export default router;
