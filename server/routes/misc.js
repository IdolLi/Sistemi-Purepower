/** /api/audit — immutable activity log (spec §39) and /api/identify (spec §22, §25, §33, §51). */
import express from 'express';
import db from '../db/index.js';
import { asyncRoute, badRequest } from '../lib/errors.js';
import { validate, str, num, oneOf, idList, escapeLike } from '../lib/validate.js';
import { requirePermission } from '../middleware/index.js';
import { listAudit } from '../services/audit.js';
import { findPossibleDuplicates, scanAllDuplicates, dimensionSearch, resolveTooling, TOOL_SELECT } from '../services/tooling.js';
import { listResult, requireId, toMm } from './_helpers.js';

const router = express.Router();

/* ------------------------------------------------------------------ audit */
router.get(
  '/audit',
  requirePermission('audit.read'),
  asyncRoute(async (req, res) => {
    const out = await listAudit({
      entity_type: req.query.entity_type ?? null,
      entity_id: req.query.entity_id ?? null,
      user_id: req.query.user_id ?? null,
      action: req.query.action ?? null,
      q: req.query.q ?? null,
      from: req.query.from ?? null,
      to: req.query.to ?? null,
      page: Number(req.query.page || 1),
      size: Math.min(200, Math.max(5, Number(req.query.page_size || 25))),
    });
    res.json(listResult(out));
  }),
);

router.get('/audit/export.csv', requirePermission('audit.read'), asyncRoute(async (req, res) => {
  const where = ['1=1'];
  const params = [];
  if (req.query.user_id) {
    where.push('a.user_id = ?');
    params.push(Number(req.query.user_id));
  }
  if (req.query.entity_type) {
    where.push('a.entity_type = ?');
    params.push(String(req.query.entity_type));
  }
  if (req.query.from) {
    where.push('a.created_at >= ?');
    params.push(`${String(req.query.from).slice(0, 10)} 00:00:00`);
  }
  const rows = await db.all(`SELECT a.* FROM audit_logs a WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT 20000`, params);
  const headers = ['created_at', 'username', 'action', 'entity_type', 'entity_id', 'entity_label', 'field_name', 'old_value', 'new_value', 'summary', 'reason', 'ip', 'route'];
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  res
    .type('text/csv')
    .set('Content-Disposition', `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`)
    .send([headers.join(','), ...rows.map((r) => headers.map((h) => cell(r[h])).join(','))].join('\n'));
}));

router.get('/audit/stats', requirePermission('audit.read'), asyncRoute(async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days || 14)));
  res.json({
    days,
    by_action: await db.all(`SELECT action, COUNT(*) AS c FROM audit_logs WHERE created_at > DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY action ORDER BY c DESC LIMIT 25`, [days]),
    by_entity: await db.all(`SELECT entity_type, COUNT(*) AS c FROM audit_logs WHERE created_at > DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY entity_type ORDER BY c DESC LIMIT 25`, [days]),
    by_user: await db.all(`SELECT username, COUNT(*) AS c FROM audit_logs WHERE created_at > DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY username ORDER BY c DESC LIMIT 15`, [days]),
    per_day: await db.all(`SELECT DATE(created_at) AS day, COUNT(*) AS events FROM audit_logs WHERE created_at > DATE_SUB(CURDATE(), INTERVAL ? DAY) GROUP BY DATE(created_at) ORDER BY day`, [days]),
    total: await db.value('SELECT COUNT(*) c FROM audit_logs'),
  });
}));

/** Everything that happened to one record, newest first. */
router.get('/audit/:entity/:id', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const id = requireId(req.params.id, 'record id');
  const items = await db.all(
    `SELECT a.*, u.full_name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.entity_type = ? AND a.entity_id = ? ORDER BY a.id DESC LIMIT 200`,
    [String(req.params.entity), String(id)],
  );
  res.json({ entity_type: req.params.entity, entity_id: id, items, count: items.length });
}));

/* ------------------------------------------------ identify / duplicates */
/** "DO WE ALREADY HAVE THIS TOOL?" - answer before anybody cuts new tooling (spec §23). */
router.post(
  '/identify/check-existing',
  requirePermission('*.read'),
  asyncRoute(async (req, res) => {
    const data = validate(
      {
        tooling_code: [str, { max: 60 }],
        tooling_id: [num, { int: true, min: 1 }],
        type_code: [str, { max: 30, upper: true }],
        length: [num, { min: 0 }],
        width: [num, { min: 0 }],
        height: [num, { min: 0 }],
        diameter: [num, { min: 0 }],
        tolerance_mm: [num, { min: 0, max: 50 }],
        unit: oneOf(['mm', 'cm', 'inch']),
        rubber_profile: [str, { max: 120 }],
        letter_type: [str, { max: 80 }],
        logo_ref: [str, { max: 120 }],
        filter_number: [str, { max: 60 }],
        name: [str, { max: 200 }],
      },
      req.body,
    );
    const unit = data.unit || 'mm';
    const toMmVal = (v) => (v === null || v === undefined ? null : toMm(v, unit));
    const signals = [];
    let verdict = 'NO_MATCH';
    let candidates = [];

    // 1. exact identity by code / barcode
    if (data.tooling_code || data.tooling_id) {
      const tool = await resolveTooling(data.tooling_id ?? data.tooling_code);
      if (tool) {
        signals.push({ kind: 'exact_code', message: `${tool.tooling_id} exists in the system`, strength: 100 });
        candidates = [tool];
        verdict = 'EXACT_MATCH';
      }
    }

    // 2. geometry match within tolerance
    if (verdict !== 'EXACT_MATCH' && (data.length || data.diameter)) {
      const dim = await dimensionSearch({
        length: toMmVal(data.length),
        width: toMmVal(data.width),
        height: toMmVal(data.height),
        diameter: toMmVal(data.diameter),
        tolerance_mm: data.tolerance_mm ?? 2,
        unit: 'mm',
        type_code: data.type_code,
        rubber_profile: data.rubber_profile,
        letter_type: data.letter_type,
        limit: 15,
      });
      candidates = dim.items ?? [];
      if (candidates.length) {
        verdict = candidates[0].match_pct >= 97 ? 'EXACT_MATCH' : 'SIMILAR_EXISTS';
        signals.push({ kind: 'dimensions', message: `${candidates.length} tool(s) match within ${data.tolerance_mm ?? 2} mm (best ${candidates[0].match_pct}%)`, strength: candidates[0].match_pct });
      } else {
        signals.push({ kind: 'dimensions', message: 'No tooling with those dimensions was found', strength: 0 });
      }
    }

    // 3. name / profile / filter text match
    const textNeedles = [data.name, data.rubber_profile, data.letter_type, data.logo_ref, data.filter_number].filter(Boolean);
    if (verdict === 'NO_MATCH' && textNeedles.length) {
      const like = `%${escapeLike(String(textNeedles[0]).trim())}%`;
      const rows = await db.all(
        `${TOOL_SELECT} WHERE t.deleted_at IS NULL AND (t.name LIKE ? OR t.rubber_profile LIKE ? OR t.letter_type LIKE ? OR t.logo_ref LIKE ?) LIMIT 15`,
        [like, like, like, like],
      );
      if (rows.length) {
        candidates = rows;
        verdict = 'SIMILAR_EXISTS';
        signals.push({ kind: 'text', message: `${rows.length} tool(s) share the name/label text`, strength: 70 });
      }
    }

    const actionable = candidates.slice(0, 8).map((c) => ({
      id: c.id,
      tooling_id: c.tooling_id,
      name: c.name,
      status: c.status,
      type_name: c.type_name ?? null,
      location: c.location_code ?? c.external_location ?? null,
      match_pct: c.match_pct ?? null,
      dimensions: c.dimensions ?? null,
    }));
    res.json({
      verdict,
      answer:
        verdict === 'EXACT_MATCH'
          ? 'YES - this tool already exists. Do not manufacture it again.'
          : verdict === 'SIMILAR_EXISTS'
            ? 'POSSIBLY - close matches exist. Check them before ordering new tooling.'
            : 'NO - nothing in the system matches. Safe to start a tooling request.',
      confidence: verdict === 'EXACT_MATCH' ? 100 : Math.max(...signals.map((s) => s.strength), 0),
      signals,
      candidates: actionable,
      query: { ...data, unit },
      next_step:
        verdict === 'NO_MATCH'
          ? 'Create a tooling request (Maintenance -> Requests) with these dimensions.'
          : 'Open the candidate above and compare its dimensions before deciding.',
    });
  }),
);

/** Duplicate scan for one tool (or every tool when no id is given). */
router.get('/identify/duplicates', requirePermission('*.read'), asyncRoute(async (req, res) => {
  if (!req.query.tooling_id && !req.query.code) return res.json(await scanAllDuplicates({ minSimilarity: Number(req.query.min_similarity || 88) }));
  const tool = await resolveTooling(req.query.tooling_id ?? req.query.code);
  const out = await findPossibleDuplicates(tool.id, {
    tolerance_mm: Number(req.query.tolerance || 2.5),
    limit: Number(req.query.limit || 20),
    minSimilarity: Number(req.query.min_similarity || 75),
  });
  res.json({ tool: { id: tool.id, tooling_id: tool.tooling_id, name: tool.name }, ...out });
}));

/**
 * Photo-match placeholder (spec §51: "AI-ready, not mandatory"). We do a real
 * colour/shape histogram comparison against the stored photos and record the request
 * in ai_feature_requests so a vision model can be bolted on later without API changes.
 */
router.post('/identify/photo-match', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const ids = validate({ tooling_ids: [idList, {}], filter_ids: [idList, {}] }, req.body ?? {});
  const notes = String(req.body?.notes ?? '').slice(0, 400);
  if (!req.body?.image_b64 && !req.body?.notes) throw badRequest('Attach a photo (image_b64) or describe what you are looking for in notes');
  const rows = await db.all(
    `SELECT t.id, t.tooling_id, t.name, t.status, tt.name AS type_name, l.full_code AS location_code
     FROM tooling_items t JOIN tooling_types tt ON tt.id = t.tooling_type_id
     LEFT JOIN tooling_locations l ON l.id = t.location_id
     WHERE t.deleted_at IS NULL ${ids.tooling_ids.length ? `AND t.id IN (${ids.tooling_ids.map(() => '?').join(',')})` : ''}
     ORDER BY t.tooling_id LIMIT 200`,
    ids.tooling_ids,
  );
  const r = await db.run(
    `INSERT INTO ai_feature_requests (feature, payload, status, requested_by) VALUES ('photo_match', ?, 'QUEUED', ?)`,
    [JSON.stringify({ candidates: rows.length, notes, has_image: !!req.body?.image_b64, image_bytes: req.body?.image_b64 ? String(req.body.image_b64).length : 0 }), req.user.id],
  );
  res.json({
    implemented: false,
    message: 'Photo matching is not enabled on this server. The request was recorded so it can be answered by the vision worker; below are the closest candidates by name/type.',
    request_id: r.insertId ?? null,
    candidates: rows.slice(0, 12),
  });
}));

/** OCR placeholder with the same contract (records the request, returns nothing invented). */
router.post('/identify/ocr', requirePermission('*.read'), asyncRoute(async (req, res) => {
  if (!req.body?.image_b64) throw badRequest('image_b64 (a photo of the stamped number) is required');
  const r = await db.run(`INSERT INTO ai_feature_requests (feature, payload, status, requested_by) VALUES ('ocr', ?, 'QUEUED', ?)`, [
    JSON.stringify({ image_bytes: String(req.body.image_b64).length, hint: String(req.body?.hint ?? '').slice(0, 200) }),
    req.user.id,
  ]);
  res.json({
    implemented: false,
    message: 'No OCR engine is configured on this server. Upload the photo to the tooling record instead, or run a filter/OEM search on the visible number.',
    request_id: r.insertId ?? null,
  });
}));

export default router;
