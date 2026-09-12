/** Files: photo/document uploads + serving (spec §10, §28). */
import db from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { storeFile, validateUpload, deleteStoredFile, readStoredFile, imageDimensions } from '../lib/files.js';
import { renderToolingImage } from './referenceImage.js';
import { audit } from './audit.js';

const IMAGE_VIEWS = ['FRONT', 'BACK', 'TOP', 'BOTTOM', 'SIDE', 'DETAIL', 'LETTERING', 'DAMAGE', 'LOCATION', 'DRAWING', 'OTHER'];

export async function listFiles(ownerType, ownerId, kind = 'image') {
  const table = kind === 'image' ? 'tooling_images' : 'tooling_documents';
  return db.all(
    `SELECT f.*, u.full_name AS uploaded_by_name FROM ${table} f LEFT JOIN users u ON u.id = f.uploaded_by
     WHERE f.owner_type = ? AND f.owner_id = ? ORDER BY ${kind === 'image' ? 'f.is_primary DESC, f.sort_order, f.id' : 'f.doc_type, f.original_name'}`,
    [ownerType, Number(ownerId)],
  );
}

export async function addImage({ ownerType, ownerId, buffer, originalName, viewType = 'DETAIL', caption = null, makePrimary = false, ctx }) {
  const meta = validateUpload({ buffer, originalName, kind: 'image' });
  const owner = await resolveOwner(ownerType, ownerId);
  const stored = storeFile(ownerType, ownerId, meta, { subdir: 'images' });
  const dims = imageDimensions(meta.buffer, meta.mime);
  if (makePrimary) await db.run('UPDATE tooling_images SET is_primary = 0 WHERE owner_type = ? AND owner_id = ?', [ownerType, ownerId]);
  const res = await db.run(
    `INSERT INTO tooling_images (owner_type, owner_id, view_type, caption, filename, stored_name, mime_type, size_bytes, width_px, height_px, is_primary, sort_order, uploaded_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, NOW())`,
    [
      ownerType,
      ownerId,
      IMAGE_VIEWS.includes(String(viewType).toUpperCase()) ? String(viewType).toUpperCase() : 'DETAIL',
      caption,
      stored.filename,
      stored.relative_path,
      meta.mime,
      meta.size,
      dims.width_px,
      dims.height_px,
      makePrimary ? 1 : 0,
      50,
      ctx?.user?.id ?? null,
    ],
  );
  await audit(ctx, { action: 'upload', entityType: 'image', entityId: res.insertId, entityLabel: `${owner.label}/${stored.filename}`, summary: `Photo uploaded (${viewType})` });
  return db.one('SELECT * FROM tooling_images WHERE id = ?', [res.insertId]);
}

export async function addDocument({ ownerType, ownerId, buffer, originalName, docType = 'CAD', description = null, ctx }) {
  const meta = validateUpload({ buffer, originalName, kind: 'doc' });
  const owner = await resolveOwner(ownerType, ownerId);
  const stored = storeFile(ownerType, ownerId, meta, { subdir: 'documents' });
  const ext = meta.ext.replace('.', '').toUpperCase();
  const resolvedType = normaliseDocType(docType, ext);
  // version the file: same original name on the same owner becomes a new version
  const previous = await db.one('SELECT * FROM tooling_documents WHERE owner_type = ? AND owner_id = ? AND original_name = ? AND is_current = 1', [ownerType, ownerId, originalName]);
  if (previous) await db.run('UPDATE tooling_documents SET is_current = 0 WHERE id = ?', [previous.id]);
  const res = await db.run(
    `INSERT INTO tooling_documents (owner_type, owner_id, doc_type, filename, stored_name, original_name, extension, mime_type, size_bytes, version_no, is_current, description, uploaded_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?, NOW())`,
    [
      ownerType,
      ownerId,
      resolvedType,
      stored.filename,
      stored.relative_path,
      String(originalName).slice(0, 255),
      ext,
      meta.mime,
      meta.size,
      previous ? Number(previous.version_no) + 1 : 1,
      description,
      ctx?.user?.id ?? null,
    ],
  );
  await audit(ctx, { action: 'upload', entityType: 'document', entityId: res.insertId, entityLabel: `${owner.label}/${originalName}`, summary: `${resolvedType} file uploaded (v${previous ? Number(previous.version_no) + 1 : 1})` });
  return db.one('SELECT * FROM tooling_documents WHERE id = ?', [res.insertId]);
}

function normaliseDocType(docType, ext) {
  const map = { STEP: 'STEP', STL: 'STL', SLDPRT: 'CAD', SLDASM: 'CAD', DXF: 'DXF', DWG: 'CAD', PDF: 'DRAWING', ZIP: 'ARCHIVE' };
  const upper = String(docType || '').toUpperCase();
  if (['CAD', 'STEP', 'STL', 'DXF', 'DRAWING', 'PHOTO', 'TECHNICAL_DRAWING', 'SPEC', 'ARCHIVE', 'OTHER'].includes(upper)) return upper;
  return map[ext] ?? 'OTHER';
}

async function resolveOwner(ownerType, ownerId) {
  const registry = {
    TOOLING: { table: 'tooling_items', col: 'tooling_id' },
    FILTER: { table: 'filters', col: 'internal_number' },
    DAMAGE_REPORT: { table: 'tooling_damage_reports', col: 'report_no' },
    MAINTENANCE: { table: 'tooling_maintenance', col: 'id' },
    WAREHOUSE: { table: 'warehouses', col: 'code' },
    LOCATION: { table: 'tooling_locations', col: 'full_code' },
  };
  const spec = registry[String(ownerType).toUpperCase()];
  if (!spec) throw badRequest(`Unsupported file owner type ${ownerType} (expected ${Object.keys(registry).join(', ')})`);
  const row = await db.one(`SELECT id, ${spec.col} AS code FROM ${spec.table} WHERE id = ?`, [Number(ownerId)]);
  if (!row) throw notFound(`${spec.table.replace(/s$/, '')} #${ownerId} not found`);
  return { id: row.id, label: row.code };
}

/** Every file row for an owner, with a serving URL. */
export async function ownerFiles(ownerType, ownerId) {
  const images = await listFiles(ownerType, ownerId, 'image');
  const documents = await listFiles(ownerType, ownerId, 'document');
  return {
    images: images.map((i) => ({ ...i, url: `/api/files/images/${i.id}`, thumb_url: `/api/files/images/${i.id}?w=320` })),
    documents: documents.map((d) => ({ ...d, url: `/api/files/documents/${d.id}` })),
  };
}

export async function setImagePrimary(imageId) {
  const img = await db.one('SELECT * FROM tooling_images WHERE id = ?', [Number(imageId)]);
  if (!img) throw notFound('Image not found');
  await db.run('UPDATE tooling_images SET is_primary = 0 WHERE owner_type = ? AND owner_id = ?', [img.owner_type, img.owner_id]);
  await db.run('UPDATE tooling_images SET is_primary = 1, sort_order = 1 WHERE id = ?', [img.id]);
  return true;
}

export async function updateImage(imageId, { view_type, caption, sort_order }) {
  const img = await db.one('SELECT * FROM tooling_images WHERE id = ?', [Number(imageId)]);
  if (!img) throw notFound('Image not found');
  await db.run('UPDATE tooling_images SET view_type = COALESCE(?, view_type), caption = COALESCE(?, caption), sort_order = COALESCE(?, sort_order) WHERE id = ?', [
    view_type ? (IMAGE_VIEWS.includes(String(view_type).toUpperCase()) ? String(view_type).toUpperCase() : 'DETAIL') : null,
    caption ?? null,
    sort_order ?? null,
    img.id,
  ]);
  return db.one('SELECT * FROM tooling_images WHERE id = ?', [img.id]);
}

export async function deleteImage(imageId, ctx) {
  const img = await db.one('SELECT * FROM tooling_images WHERE id = ?', [Number(imageId)]);
  if (!img) throw notFound('Image not found');
  await deleteStoredFile(img.stored_name);
  await db.run('DELETE FROM tooling_images WHERE id = ?', [img.id]);
  if (img.is_primary) {
    const next = await db.one('SELECT id FROM tooling_images WHERE owner_type = ? AND owner_id = ? ORDER BY sort_order LIMIT 1', [img.owner_type, img.owner_id]);
    if (next) await db.run('UPDATE tooling_images SET is_primary = 1 WHERE id = ?', [next.id]);
  }
  await audit(ctx, { action: 'delete', entityType: 'image', entityId: img.id, entityLabel: img.filename, summary: 'Photo deleted' });
  return true;
}

export async function deleteDocument(documentId, ctx) {
  const doc = await db.one('SELECT * FROM tooling_documents WHERE id = ?', [Number(documentId)]);
  if (!doc) throw notFound('Document not found');
  await deleteStoredFile(doc.stored_name);
  await db.run('DELETE FROM tooling_documents WHERE id = ?', [doc.id]);
  await audit(ctx, { action: 'delete', entityType: 'document', entityId: doc.id, entityLabel: doc.original_name, summary: 'File deleted' });
  return true;
}

/** Load a stored file row + its bytes, checking ownership. */
export async function loadForServing(kind, id) {
  const table = kind === 'image' ? 'tooling_images' : 'tooling_documents';
  const row = await db.one(`SELECT * FROM ${table} WHERE id = ?`, [Number(id)]);
  if (!row) throw notFound('File not found');
  const buffer = await readStoredFile(row.stored_name);
  return { row, buffer };
}

/**
 * Reference photo fallback: when a tooling item has no uploaded photo we render a
 * dimensioned technical view from the stored geometry so the record is never blank.
 */
export async function renderReference(toolingPk, view = 'FRONT') {
  const tool = await db.one(
    `SELECT t.id, t.tooling_id, t.name, t.status, tt.code AS type_code, tt.name AS type_name
     FROM tooling_items t JOIN tooling_types tt ON tt.id = t.tooling_type_id WHERE t.id = ?`,
    [Number(toolingPk)],
  );
  if (!tool) throw notFound('Tooling not found');
  const dimensions = await db.one('SELECT * FROM tooling_dimensions WHERE tooling_item_id = ?', [tool.id]);
  return renderToolingImage({ ...tool, dimensions: dimensions ?? {} }, String(view).toUpperCase());
}

export const VIEWS = IMAGE_VIEWS;
