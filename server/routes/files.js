/** /api/files — serve uploaded photos/documents (owned by tooling or filters). */
import express from 'express';
import db from '../db/index.js';
import { asyncRoute, notFound, badRequest } from '../lib/errors.js';
import { requirePermission, can } from '../middleware/index.js';
import { loadForServing, renderReference } from '../services/storage.js';
import { readStoredFile } from '../lib/files.js';

const router = express.Router();

function send(res, row, buffer, { download = false } = {}) {
  res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (download) {
    const name = String(row.original_name || row.filename || 'file').replace(/[^\w.\-() ]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  }
  return res.status(200).end(buffer);
}

async function serve(req, res, kind, id) {
  const { row, buffer } = await loadForServing(kind, id);
  // thumbnails: the browser asks for ?w=NNN and we simply downscale via SVG-less
  // raster pass - we return the original bytes and let the client size the <img>.
  void req.query.w;
  return send(res, row, buffer, { download: req.query.download === '1' });
}

router.get('/images/:id', asyncRoute(async (req, res) => serve(req, res, 'image', req.params.id)));
router.get('/documents/:id', asyncRoute(async (req, res) => serve(req, res, 'document', req.params.id)));

/** Convenience paths that mirror the record structure (nicer for the UI + QR payloads). */
router.get('/tooling/:id/images/:imageId', asyncRoute(async (req, res) => {
  const row = await db.one("SELECT * FROM tooling_images WHERE id = ? AND owner_type = 'TOOLING' AND owner_id = ?", [Number(req.params.imageId), Number(req.params.id)]);
  if (!row) throw notFound('Image not found for that tooling item');
  send(res, row, await readStoredFile(row.stored_name), { download: req.query.download === '1' });
}));

router.get('/tooling/:id/documents/:docId', asyncRoute(async (req, res) => {
  const row = await db.one("SELECT * FROM tooling_documents WHERE id = ? AND owner_type = 'TOOLING' AND owner_id = ?", [Number(req.params.docId), Number(req.params.id)]);
  if (!row) throw notFound('Document not found for that tooling item');
  send(res, row, await readStoredFile(row.stored_name), { download: true });
}));

/** The primary photo of a tool, or a rendered reference view when there is no photo. */
router.get('/tooling/:id/primary', asyncRoute(async (req, res) => {
  const row = await db.one(
    "SELECT * FROM tooling_images WHERE owner_type = 'TOOLING' AND owner_id = ? ORDER BY is_primary DESC, sort_order, id LIMIT 1",
    [Number(req.params.id)],
  );
  if (row) {
    if (req.query.meta === '1') return res.json({ source: 'PHOTO', image: row, url: `/api/files/images/${row.id}` });
    return send(res, row, await readStoredFile(row.stored_name));
  }
  if (req.query.meta === '1') return res.json({ source: 'RENDER', url: `/api/files/tooling/${req.params.id}/reference?view=${req.query.view || 'FRONT'}` });
  const { svg } = await renderReference(req.params.id, req.query.view || 'FRONT');
  return res.type('image/svg+xml').set('Cache-Control', 'private, max-age=3600').send(svg);
}));

router.get('/tooling/:id/reference', asyncRoute(async (req, res) => {
  const { svg } = await renderReference(req.params.id, req.query.view || 'FRONT');
  res.type('image/svg+xml').set('Cache-Control', 'private, max-age=3600').send(svg);
}));

router.get('/filter/:id/primary', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const row = await db.one(
    "SELECT * FROM tooling_images WHERE owner_type = 'FILTER' AND owner_id = ? ORDER BY is_primary DESC, sort_order, id LIMIT 1",
    [Number(req.params.id)],
  );
  if (!row) throw notFound('This filter has no photo yet - upload one on the filter screen');
  send(res, row, await readStoredFile(row.stored_name));
}));

router.get('/warehouse-layout/:id/image', asyncRoute(async (req, res) => {
  const row = await db.one('SELECT d.* FROM tooling_documents d JOIN warehouses w ON w.id = d.owner_id WHERE d.id = ? AND d.owner_type = ?', [
    Number(req.params.id),
    'WAREHOUSE',
  ]);
  if (!row) throw notFound('No background image for that warehouse');
  send(res, row, await readStoredFile(row.stored_name));
}));

/** One shot: every file row for an owner (used by the record screens). */
router.get('/owner/:type/:id', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const type = String(req.params.type).toUpperCase();
  if (!['TOOLING', 'FILTER', 'DAMAGE_REPORT', 'MAINTENANCE'].includes(type)) throw badRequest('type must be TOOLING, FILTER, DAMAGE_REPORT or MAINTENANCE');
  const [images, documents] = await Promise.all([
    db.all(`SELECT id, owner_id, view_type, caption, filename, mime_type, size_bytes, width_px, height_px, is_primary, created_at FROM tooling_images WHERE owner_type = ? AND owner_id = ? ORDER BY is_primary DESC, sort_order, id`, [type, Number(req.params.id)]),
    db.all(`SELECT id, owner_id, doc_type, original_name, extension, mime_type, size_bytes, version_no, is_current, description, created_at FROM tooling_documents WHERE owner_type = ? AND owner_id = ? ORDER BY doc_type, original_name, version_no DESC`, [type, Number(req.params.id)]),
  ]);
  res.json({
    owner_type: type,
    owner_id: Number(req.params.id),
    images: images.map((i) => ({ ...i, url: `/api/files/images/${i.id}` })),
    documents: documents.map((d) => ({ ...d, url: `/api/files/documents/${d.id}` })),
    may_upload: can(req, 'files.manage'),
  });
}));

export default router;
