/** One global search box (spec §37): filters, OEM numbers, cross-refs, tooling, vehicles,
 *  dimensions, locations, QR/barcode text, names and production orders in a single call. */
import express from 'express';
import db from '../db/index.js';
import { asyncRoute, badRequest } from '../lib/errors.js';
import { escapeLike, inPlaceholders } from '../lib/validate.js';
import { requirePermission } from '../middleware/index.js';
import { resolveScan } from '../services/labels.js';
import { toMm } from './_helpers.js';

const router = express.Router();

const LIMITS = 8;

function boolLike(v) {
  return v === '1' || v === 'true' || v === true;
}

router.get(
  '/',
  requirePermission('*.read'),
  asyncRoute(async (req, res) => {
    const raw = String(req.query.q ?? '').trim();
    if (!raw) throw badRequest('Type something to search for (q=...)');
    if (raw.length > 120) throw badRequest('Search text is too long (120 characters max)');
    const like = `%${escapeLike(raw)}%`;
    const words = raw.split(/\s+/).filter(Boolean);
    const only = req.query.type ? String(req.query.type).split(',') : null;
    const want = (k) => !only || only.includes(k);
    const t0 = Date.now();

    const jobs = {};

    if (want('scan')) {
      jobs.scan = (async () => {
        try {
          return [await resolveScan(raw, req)];
        } catch {
          return [];
        }
      })();
    }

    if (want('filters')) {
      jobs.filters = db.all(
        `SELECT f.id, f.internal_number, f.product_number, f.name, f.status, ft.name AS filter_type, ft.icon, b.name AS brand,
                ff.name AS family, fd.length_mm, fd.width_mm, fd.height_mm, fd.overall_diameter_mm,
                (SELECT COUNT(*) FROM tooling_compatibility tc WHERE tc.filter_id = f.id AND tc.tooling_item_id IN
                   (SELECT id FROM tooling_items WHERE deleted_at IS NULL)) AS tooling_count,
                (SELECT COUNT(*) FROM filter_vehicle_applications a WHERE a.filter_id = f.id) AS vehicle_count
         FROM filters f
         JOIN filter_types ft ON ft.id = f.filter_type_id
         LEFT JOIN brands b ON b.id = f.brand_id
         LEFT JOIN filter_families ff ON ff.id = f.family_id
         LEFT JOIN filter_dimensions fd ON fd.filter_id = f.id
         WHERE f.is_active = 1
           AND (UPPER(f.internal_number) LIKE ? OR UPPER(f.product_number) LIKE ? OR f.name LIKE ?
                OR EXISTS (SELECT 1 FROM filter_cross_references x WHERE x.filter_id = f.id AND UPPER(x.ref_number) LIKE ?)
                OR EXISTS (SELECT 1 FROM filter_vehicle_applications a JOIN vehicles v ON v.id = a.vehicle_id
                            WHERE a.filter_id = f.id AND (UPPER(v.manufacturer) LIKE ? OR UPPER(v.model) LIKE ? OR UPPER(v.engine_code) LIKE ? OR UPPER(v.engine) LIKE ?))
                ${words.length > 1 ? `OR EXISTS (SELECT 1 FROM vehicles v2 JOIN filter_vehicle_applications a2 ON a2.vehicle_id = v2.id WHERE a2.filter_id = f.id AND (UPPER(CONCAT(v2.manufacturer,' ',v2.model)) LIKE ? OR UPPER(CONCAT(v2.model,' ',v2.engine)) LIKE ?))` : ''})
         ORDER BY (UPPER(f.internal_number) = ?) DESC, (UPPER(f.product_number) = ?) DESC, f.internal_number
         LIMIT ${LIMITS * 2}`,
        [
          like,
          like,
          like,
          like,
          like,
          like,
          like,
          like,
          ...(words.length > 1 ? [like, like] : []),
          `${escapeLike(raw.toUpperCase())}%`,
          `${escapeLike(raw.toUpperCase())}%`,
        ],
      );
    }

    if (want('tooling')) {
      jobs.tooling = db.all(
        `SELECT t.id, t.tooling_id, t.name, t.status, t.condition_rating, t.quantity, t.serial_number,
                tt.name AS type_name, tt.code AS type_code, tt.icon,
                l.full_code AS location_code, l.label_path AS location_path, l.id AS location_id,
                f.internal_number AS filter_number, t.total_cycles, t.max_cycles, t.next_maintenance_date,
                (SELECT im.id FROM tooling_images im WHERE im.owner_type='TOOLING' AND im.owner_id=t.id ORDER BY im.is_primary DESC LIMIT 1) AS primary_image_id
         FROM tooling_items t
         JOIN tooling_types tt ON tt.id = t.tooling_type_id
         LEFT JOIN tooling_locations l ON l.id = t.location_id
         LEFT JOIN filters f ON f.id = t.primary_filter_id
         WHERE t.deleted_at IS NULL
           AND (UPPER(t.tooling_id) LIKE ? OR t.name LIKE ? OR UPPER(t.serial_number) LIKE ? OR t.barcode = ?
                OR t.material LIKE ? OR t.rubber_profile LIKE ? OR t.letter_type LIKE ? OR t.notes LIKE ?
                OR tt.name LIKE ? OR tt.code LIKE ?)
         ORDER BY (UPPER(t.tooling_id) = ?) DESC, t.tooling_id
         LIMIT ${LIMITS * 2}`,
        [like, like, like, raw.toUpperCase(), like, like, like, like, like, like, raw.toUpperCase()],
      );
    }

    if (want('locations')) {
      jobs.locations = db.all(
        `SELECT l.id, l.kind, l.code, l.full_code, l.label_path, l.capacity_items, l.occupancy_items, l.status,
                w.code AS warehouse_code, w.name AS warehouse_name,
                (SELECT COUNT(*) FROM tooling_items ti WHERE ti.location_id = l.id AND ti.deleted_at IS NULL) AS items_here
         FROM tooling_locations l LEFT JOIN warehouses w ON w.id = l.warehouse_id
         WHERE UPPER(l.full_code) LIKE ? OR UPPER(l.code) = ? OR UPPER(l.label_path) LIKE ?
         ORDER BY (UPPER(l.full_code) = ?) DESC, l.full_code LIMIT ${LIMITS}`,
        [like, raw.toUpperCase(), like, raw.toUpperCase()],
      );
    }

    if (want('vehicles')) {
      jobs.vehicles = db.all(
        `SELECT v.id, v.manufacturer, v.model, v.generation, v.year_from, v.year_to, v.engine, v.engine_code, v.fuel, v.power_hp,
                (SELECT COUNT(*) FROM filter_vehicle_applications a WHERE a.vehicle_id = v.id) AS filter_count,
                (SELECT GROUP_CONCAT(f.internal_number ORDER BY f.internal_number SEPARATOR ', ')
                   FROM filter_vehicle_applications a2 JOIN filters f ON f.id = a2.filter_id WHERE a2.vehicle_id = v.id) AS filters
         FROM vehicles v
         WHERE UPPER(v.manufacturer) LIKE ? OR UPPER(v.model) LIKE ? OR UPPER(v.engine) LIKE ? OR UPPER(v.engine_code) LIKE ?
            OR UPPER(v.generation) LIKE ?
         ORDER BY v.manufacturer, v.model, v.year_from LIMIT ${LIMITS * 2}`,
        [like, like, like, like, like],
      );
    }

    if (want('dimensions')) {
      const dims = /^\s*(\d+(?:\.\d+)?)\s*[x*]\s*(\d+(?:\.\d+)?)\s*(?:[x*]\s*(\d+(?:\.\d+)?))?\s*$/i.exec(raw);
      const tolerance = Math.min(50, Math.max(0, Number(req.query.tolerance ?? 2)));
      if (dims) {
        const unit = String(req.query.unit || 'mm').toLowerCase();
        const l = toMm(dims[1], unit);
        const w = toMm(dims[2], unit);
        const h = dims[3] ? toMm(dims[3], unit) : null;
        jobs.dimensions = {
          pattern: `${l} x ${w}${h !== null ? ` x ${h}` : ''} mm (+/-${toMm(tolerance, unit)} mm)`,
          filters: await db.all(
            `SELECT f.id, f.internal_number, f.name, ft.name AS filter_type, fd.length_mm, fd.width_mm, fd.height_mm,
                    ROUND(100 - (ABS(fd.length_mm - ?) + ABS(fd.width_mm - ?) + (ABS(COALESCE(fd.height_mm,0) - COALESCE(?,0)) * ?)) * 10, 1) AS match_pct
             FROM filter_dimensions fd JOIN filters f ON f.id = fd.filter_id JOIN filter_types ft ON ft.id = f.filter_type_id
             WHERE fd.length_mm BETWEEN ? AND ? AND fd.width_mm BETWEEN ? AND ?
               AND (? IS NULL OR fd.height_mm BETWEEN ? AND ?)
             ORDER BY match_pct DESC LIMIT ${LIMITS}`,
            [l, w, h, h === null ? 0 : 1, l - toMm(tolerance, unit), l + toMm(tolerance, unit), w - toMm(tolerance, unit), w + toMm(tolerance, unit), h, h === null ? 0 : h - toMm(tolerance, unit), h === null ? 0 : h + toMm(tolerance, unit)],
          ),
          tooling: await db.all(
            `SELECT t.id, t.tooling_id, t.name, t.status, tt.name AS type_name, tt.icon, l.full_code AS location_code,
                    d.overall_length_mm, d.overall_width_mm, d.overall_height_mm
             FROM tooling_dimensions d
             JOIN tooling_items t ON t.id = d.tooling_item_id AND t.deleted_at IS NULL
             JOIN tooling_types tt ON tt.id = t.tooling_type_id
             LEFT JOIN tooling_locations l ON l.id = t.location_id
             WHERE d.overall_length_mm BETWEEN ? AND ? AND d.overall_width_mm BETWEEN ? AND ?
               AND (? IS NULL OR d.overall_height_mm BETWEEN ? AND ?)
             ORDER BY t.tooling_id LIMIT ${LIMITS}`,
            [l - toMm(tolerance, unit), l + toMm(tolerance, unit), w - toMm(tolerance, unit), w + toMm(tolerance, unit), h, h === null ? 0 : h - toMm(tolerance, unit), h === null ? 0 : h + toMm(tolerance, unit)],
          ),
        };
      } else {
        jobs.dimensions = { pattern: null, filters: [], tooling: [], hint: 'Try a size like "250x150x50" or "60.5 x 25.5"' };
      }
    }

    if (want('people')) {
      jobs.people = db.all(
        `SELECT u.id, u.username, u.full_name, u.department, r.name AS role_name, r.code AS role_code, u.is_active, u.last_login_at,
                (SELECT COUNT(*) FROM audit_logs a WHERE a.user_id = u.id AND a.created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)) AS actions_7d
         FROM users u LEFT JOIN roles r ON r.id = u.role_id
         WHERE u.username LIKE ? OR u.full_name LIKE ? OR u.email LIKE ? OR u.department LIKE ?
         ORDER BY u.username LIMIT ${LIMITS}`,
        [like, like, like, like],
      );
    }

    if (want('orders')) {
      jobs.orders = db.all(
        `SELECT o.id, o.po_number, o.status, o.availability_status, o.blocking_reason, o.quantity_ordered, o.quantity_produced,
                o.planned_start_at, o.line, o.machine, o.customer_ref, f.internal_number AS filter_number, f.name AS filter_name
         FROM production_orders o JOIN filters f ON f.id = o.filter_id
         WHERE UPPER(o.po_number) LIKE ? OR o.customer_ref LIKE ? OR o.machine LIKE ? OR UPPER(f.internal_number) LIKE ?
         ORDER BY o.planned_start_at DESC LIMIT ${LIMITS}`,
        [like, like, like, like],
      );
    }

    if (want('damage')) {
      jobs.damage = db.all(
        `SELECT d.id, d.report_no, d.damage_type, d.severity, d.status, d.description, d.reported_at,
                t.tooling_id, t.name AS tooling_name, l.full_code AS location_code
         FROM tooling_damage_reports d
         JOIN tooling_items t ON t.id = d.tooling_item_id
         LEFT JOIN tooling_locations l ON l.id = t.location_id
         WHERE UPPER(d.report_no) LIKE ? OR d.description LIKE ? OR UPPER(t.tooling_id) LIKE ? OR d.damage_type LIKE ?
         ORDER BY d.reported_at DESC LIMIT ${LIMITS}`,
        [like, like, like, like],
      );
    }

    const settled = await Promise.all(Object.values(jobs).map((p) => Promise.resolve(p).catch((err) => ({ error: err.message }))));
    const out = {};
    Object.keys(jobs).forEach((k, i) => {
      out[k] = settled[i];
    });
    const asList = (v) => (Array.isArray(v) ? v : []);
    const total = Object.values(out).reduce((sum, v) => sum + (Array.isArray(v) ? v.length : v && v.filters ? v.filters.length + (v.tooling?.length ?? 0) : 0), 0);
    res.json({
      query: raw,
      count: total,
      took_ms: Date.now() - t0,
      groups: Object.fromEntries(
        Object.entries(out).map(([k, v]) => [
          k,
          Array.isArray(v)
            ? { items: v, count: v.length }
            : v && v.filters !== undefined
              ? { items: [...(v.filters ?? []).map((x) => ({ ...x, _group: 'filter' })), ...(v.tooling ?? []).map((x) => ({ ...x, _group: 'tooling' }))], count: (v.filters?.length ?? 0) + (v.tooling?.length ?? 0), pattern: v.pattern ?? null, hint: v.hint ?? null }
              : { items: [], count: 0, error: v?.error },
        ]),
      ),
      counts: {
        filters: asList(out.filters).length,
        tooling: asList(out.tooling).length,
        locations: asList(out.locations).length,
        vehicles: asList(out.vehicles).length,
        orders: asList(out.orders).length,
        damage: asList(out.damage).length,
        people: asList(out.people).length,
        dimensions: out.dimensions && out.dimensions.filters ? out.dimensions.filters.length + (out.dimensions.tooling?.length ?? 0) : 0,
      },
    });
  }),
);

/** Type-ahead for the mobile search field (fast, few fields, debounced client side). */
router.get('/suggest', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const raw = String(req.query.q ?? '').trim();
  if (raw.length < 1) return res.json({ items: [] });
  const like = `%${escapeLike(raw.toUpperCase())}%`;
  const limit = Math.min(20, Math.max(3, Number(req.query.limit || 10)));
  const items = await db.all(
    `SELECT 'filter' AS kind, f.id, UPPER(f.internal_number) AS code, COALESCE(f.name, f.internal_number) AS label, ft.icon AS icon, f.status AS badge
     FROM filters f JOIN filter_types ft ON ft.id = f.filter_type_id
     WHERE f.is_active = 1 AND (UPPER(f.internal_number) LIKE ? OR UPPER(f.product_number) LIKE ? OR UPPER(f.name) LIKE ?)
     UNION ALL
     SELECT 'tooling' AS kind, t.id, UPPER(t.tooling_id) AS code, t.name AS label, tt.icon, t.status AS badge
     FROM tooling_items t JOIN tooling_types tt ON tt.id = t.tooling_type_id
     WHERE t.deleted_at IS NULL AND (UPPER(t.tooling_id) LIKE ? OR UPPER(t.name) LIKE ?)
     UNION ALL
     SELECT 'location' AS kind, l.id, UPPER(l.full_code) AS code, COALESCE(l.label_path, l.full_code) AS label, '📍' AS icon, l.status AS badge
     FROM tooling_locations l WHERE UPPER(l.full_code) LIKE ? OR UPPER(l.label_path) LIKE ?
     UNION ALL
     SELECT 'xref' AS kind, f2.id, UPPER(x.ref_number) AS code, CONCAT(f2.internal_number, ' (', x.ref_type, ')') AS label, '🔗' AS icon, x.ref_type AS badge
     FROM filter_cross_references x JOIN filters f2 ON f2.id = x.filter_id WHERE UPPER(x.ref_number) LIKE ?
     UNION ALL
     SELECT 'order' AS kind, o.id, UPPER(o.po_number) AS code, CONCAT(COALESCE(o.customer_ref, o.machine, o.line, 'production'), ' - ', f3.internal_number) AS label, '🏭' AS icon, o.status AS badge
     FROM production_orders o JOIN filters f3 ON f3.id = o.filter_id WHERE UPPER(o.po_number) LIKE ? OR UPPER(o.customer_ref) LIKE ?
     LIMIT ?`,
    [like, like, like, like, like, like, like, like, like, like, limit],
  );
  const scored = items
    .map((i) => ({ ...i, exact: i.code === raw.toUpperCase(), score: i.code === raw.toUpperCase() ? 0 : i.code.startsWith(raw.toUpperCase()) ? 1 : 2 }))
    .sort((a, b) => a.score - b.score || a.kind.localeCompare(b.kind) || String(a.code).localeCompare(String(b.code)));
  res.json({ items: scored.slice(0, limit), count: scored.length, query: raw });
}));

/** Recent searches are not stored server-side on purpose (privacy) - the client keeps them. */
router.post('/scan', requirePermission('*.read'), asyncRoute(async (req, res) => {
  res.json(await resolveScan(req.body?.code ?? req.body?.text, req));
}));

/** Filters matching several codes at once (used by the import preview + "compare" picker). */
router.post('/by-codes', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const codes = Array.isArray(req.body?.codes) ? req.body.codes.slice(0, 200).map((c) => String(c).trim()) : [];
  if (!codes.length) throw badRequest('codes[] is required');
  const found = await db.all(
    `SELECT f.id, f.internal_number, f.product_number, f.name, ft.name AS filter_type
     FROM filters f JOIN filter_types ft ON ft.id = f.filter_type_id
     WHERE UPPER(f.internal_number) IN (${inPlaceholders(codes)}) OR UPPER(f.product_number) IN (${inPlaceholders(codes)})`,
    [...codes.map((c) => c.toUpperCase()), ...codes.map((c) => c.toUpperCase())],
  );
  const foundSet = new Set(found.map((f) => f.internal_number.toUpperCase()));
  const foundAlt = new Set(found.map((f) => String(f.product_number ?? '').toUpperCase()));
  res.json({
    items: found,
    missing: codes.filter((c) => !foundSet.has(c.toUpperCase()) && !foundAlt.has(c.toUpperCase())),
    requested: codes.length,
    matched: found.length,
  });
}));

export default router;
