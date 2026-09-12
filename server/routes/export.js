/** /api/export — download whatever the user is looking at (spec §42). */
import express from 'express';
import { asyncRoute, badRequest } from '../lib/errors.js';
import { requirePermission } from '../middleware/index.js';
import { buildExport, exportXlsx, exportCsv, EXPORT_ENTITIES } from '../services/export.js';
import { audit } from '../services/audit.js';

const router = express.Router();

router.get('/entities', requirePermission('*.read'), asyncRoute(async (req, res) => {
  res.json({ items: EXPORT_ENTITIES });
}));

router.get('/preview/:entity', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const bundle = await buildExport(req.params.entity, { ...req.query, limit: Math.min(100, Number(req.query.limit || 25)) });
  res.json(bundle);
}));

router.get(
  '/:entity.:format(xlsx|csv|json)',
  requirePermission('*.read'),
  asyncRoute(async (req, res) => {
    const bundle = await buildExport(req.params.entity, req.query);
    const stamp = new Date().toISOString().slice(0, 10);
    const base = `${req.params.entity}-${stamp}`;
    await audit(req.ctx, { action: 'export', entityType: req.params.entity, summary: `Exported ${bundle.count} ${req.params.entity} row(s) as ${req.params.format.toUpperCase()}` });
    if (req.params.format === 'json') return res.json(bundle);
    if (req.params.format === 'csv') {
      return res.type('text/csv').set('Content-Disposition', `attachment; filename="${base}.csv"`).send('' + exportCsv(bundle));
    }
    const buffer = await exportXlsx(bundle);
    return res
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .set('Content-Disposition', `attachment; filename="${base}.xlsx"`)
      .set('Content-Length', String(buffer.length))
      .end(buffer);
  }),
);

/** Bulk export of everything a warehouse audit would need, as one workbook-ready JSON. */
router.get('/bundle/all', requirePermission('reports.export'), asyncRoute(async (req, res) => {
  const out = {};
  for (const { code } of EXPORT_ENTITIES) {
    out[code] = await buildExport(code, { limit: Math.min(2000, Number(req.query.limit || 500)) });
    out[code] = { title: out[code].title, count: out[code].count, columns: out[code].columns, rows: out[code].rows };
  }
  const size = Object.values(out).reduce((s, x) => s + x.count, 0);
  if (!Number.isFinite(size)) throw badRequest('Export failed');
  res.json({ generated_at: new Date().toISOString(), total_rows: size, sections: out });
}));

export default router;
