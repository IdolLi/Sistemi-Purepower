/** /api/reports — the eight reports (spec §43), as JSON / PDF / XLSX / CSV. */
import express from 'express';
import { asyncRoute, badRequest } from '../lib/errors.js';
import { requirePermission } from '../middleware/index.js';
import { REPORTS, runReport, toXlsx, toPdfBuffer, toCsv } from '../services/reports.js';
import { audit } from '../services/audit.js';

const router = express.Router();

router.get('/', requirePermission('*.read'), asyncRoute(async (req, res) => {
  res.json({ items: REPORTS, groups: [...new Set(REPORTS.map((r) => r.group))] });
}));

router.get('/:code/data', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const report = await runReport(req.params.code, req.query);
  res.json(report);
}));

router.get(
  '/:code.:format(pdf|xlsx|csv)',
  requirePermission('reports.export'),
  asyncRoute(async (req, res) => {
    const report = await runReport(req.params.code, req.query);
    const stamp = new Date().toISOString().slice(0, 10);
    const base = `${req.params.code}-${stamp}`;
    if (req.params.format === 'pdf') {
      if (!report.rows.length) throw badRequest('This report has no rows for the filters you chose - nothing to export');
      const buffer = await toPdfBuffer(report);
      await audit(req.ctx, { action: 'export', entityType: 'report', entityLabel: base, summary: `${report.name} exported as PDF (${report.count} rows)` });
      return res.type('application/pdf').set('Content-Disposition', `attachment; filename="${base}.pdf"`).set('Content-Length', String(buffer.length)).end(buffer);
    }
    if (req.params.format === 'csv') {
      await audit(req.ctx, { action: 'export', entityType: 'report', entityLabel: base, summary: `${report.name} exported as CSV (${report.count} rows)` });
      return res.type('text/csv').set('Content-Disposition', `attachment; filename="${base}.csv"`).send('' + toCsv(report));
    }
    const buffer = await toXlsx(report);
    await audit(req.ctx, { action: 'export', entityType: 'report', entityLabel: base, summary: `${report.name} exported as Excel (${report.count} rows)` });
    return res
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .set('Content-Disposition', `attachment; filename="${base}.xlsx"`)
      .set('Content-Length', String(buffer.length))
      .end(Buffer.from(buffer));
  }),
);

export default router;
