/**
 * Table export (spec §42): every list screen can be written to XLSX/CSV using the
 * same WHERE clauses the UI uses, so "export this filtered view" really means that.
 */
import ExcelJS from 'exceljs';
import db from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { escapeLike } from '../lib/validate.js';

const like = (v) => `%${escapeLike(String(v).trim())}%`;

const ENTITIES = {
  filters: {
    title: 'Filters',
    sql: (w) => `SELECT f.internal_number, f.product_number, f.name, ft.name AS filter_type, b.name AS brand,
                       ff.name AS family, f.status, fd.length_mm, fd.width_mm, fd.height_mm, fd.inner_diameter_mm, fd.overall_diameter_mm,
                       (SELECT COUNT(*) FROM filter_cross_references x WHERE x.filter_id = f.id) AS cross_references,
                       (SELECT COUNT(*) FROM filter_vehicle_applications a WHERE a.filter_id = f.id) AS vehicle_applications,
                       (SELECT COUNT(*) FROM tooling_compatibility c JOIN tooling_items ti ON ti.id = c.tooling_item_id AND ti.deleted_at IS NULL WHERE c.filter_id = f.id) AS tooling_items
                FROM filters f
                JOIN filter_types ft ON ft.id = f.filter_type_id
                LEFT JOIN brands b ON b.id = f.brand_id
                LEFT JOIN filter_families ff ON ff.id = f.family_id
                LEFT JOIN filter_dimensions fd ON fd.filter_id = f.id
                ${w.sql} ORDER BY f.internal_number LIMIT ?`,
    where: (q) => {
      const where = ['1=1'];
      const params = [];
      if (q.q) {
        where.push('(f.internal_number LIKE ? OR f.product_number LIKE ? OR f.name LIKE ?)');
        params.push(like(q.q), like(q.q), like(q.q));
      }
      if (q.type) {
        where.push('ft.code = ?');
        params.push(String(q.type).toUpperCase());
      }
      if (q.brand) {
        where.push('b.code = ?');
        params.push(String(q.brand).toUpperCase());
      }
      if (q.status) {
        where.push('f.status = ?');
        params.push(String(q.status).toUpperCase());
      }
      return { sql: `WHERE ${where.join(' AND ')}`, params };
    },
  },
  tooling: {
    title: 'Tooling register',
    sql: (w) => `SELECT t.tooling_id, t.name, tt.name AS type, t.status, t.condition_rating, t.quantity, t.material,
                       t.serial_number, t.barcode, COALESCE(l.full_code, t.external_location, '') AS location,
                       d.overall_length_mm, d.overall_width_mm, d.overall_height_mm, d.overall_diameter_mm,
                       t.total_cycles, t.max_cycles, t.next_maintenance_date, t.last_maintenance_date,
                       t.open_damage_reports, t.reserved_qty, f.internal_number AS filter_number,
                       ts.code AS tooling_set, ts.status AS set_status, t.current_revision, t.updated_at
                FROM tooling_items t
                JOIN tooling_types tt ON tt.id = t.tooling_type_id
                LEFT JOIN tooling_dimensions d ON d.tooling_item_id = t.id
                LEFT JOIN tooling_locations l ON l.id = t.location_id
                LEFT JOIN filters f ON f.id = t.primary_filter_id
                LEFT JOIN tooling_sets ts ON ts.id = t.tooling_set_id
                ${w.sql} ORDER BY t.tooling_id LIMIT ?`,
    where: (q) => {
      const where = ['t.deleted_at IS NULL'];
      const params = [];
      if (q.q) {
        where.push('(t.tooling_id LIKE ? OR t.name LIKE ? OR t.serial_number LIKE ?)');
        params.push(like(q.q), like(q.q), like(q.q));
      }
      if (q.type) {
        where.push('tt.code = ?');
        params.push(String(q.type).toUpperCase());
      }
      if (q.status) {
        where.push('t.status = ?');
        params.push(String(q.status).toUpperCase());
      }
      if (q.location_id) {
        where.push('(t.location_id = ? OR t.location_id IN (SELECT id FROM tooling_locations WHERE parent_location_id = ?))');
        params.push(Number(q.location_id), Number(q.location_id));
      }
      if (q.needs_location === '1') where.push("t.status = 'AVAILABLE' AND t.location_id IS NULL AND (t.external_location IS NULL OR t.external_location = '')");
      return { sql: `WHERE ${where.join(' AND ')}`, params };
    },
  },
  movements: {
    title: 'Movement history',
    sql: (w) => `SELECT m.created_at, m.movement_type, t.tooling_id, t.name AS tooling_name, m.qty,
                       m.from_location_code, m.to_location_code, m.external_location, m.status_before, m.status_after,
                       o.po_number, m.username, m.note, m.reason_code
                FROM tooling_movements m
                JOIN tooling_items t ON t.id = m.tooling_item_id
                LEFT JOIN production_orders o ON o.id = m.production_order_id
                ${w.sql} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
    where: (q) => {
      const where = ['1=1'];
      const params = [];
      if (q.days) {
        where.push('m.created_at > DATE_SUB(NOW(), INTERVAL ? DAY)');
        params.push(Math.min(3650, Math.max(1, Number(q.days))));
      }
      if (q.tooling_code) {
        where.push('UPPER(t.tooling_id) = ?');
        params.push(String(q.tooling_code).toUpperCase());
      }
      if (q.type) {
        where.push('m.movement_type = ?');
        params.push(String(q.type).toUpperCase());
      }
      if (q.q) {
        where.push('(t.name LIKE ? OR m.note LIKE ? OR o.po_number LIKE ?)');
        params.push(like(q.q), like(q.q), like(q.q));
      }
      return { sql: `WHERE ${where.join(' AND ')}`, params };
    },
  },
  locations: {
    title: 'Storage locations',
    sql: (w) => `SELECT l.kind, l.code, l.full_code, l.label_path, w2.code AS warehouse, l.capacity_items, l.occupancy_items,
                       ROUND(l.occupancy_items * 100.0 / NULLIF(l.capacity_items,0)) AS fill_pct, l.status,
                       (SELECT COUNT(*) FROM tooling_items t WHERE t.location_id = l.id AND t.deleted_at IS NULL) AS items_now
                FROM tooling_locations l LEFT JOIN warehouses w2 ON w2.id = l.warehouse_id
                ${w.sql} ORDER BY l.full_code LIMIT ?`,
    where: (q) => {
      const where = ['1=1'];
      const params = [];
      if (q.kind) {
        where.push('l.kind = ?');
        params.push(String(q.kind).toUpperCase());
      }
      if (q.warehouse_id) {
        where.push('l.warehouse_id = ?');
        params.push(Number(q.warehouse_id));
      }
      if (q.q) {
        where.push('(l.full_code LIKE ? OR l.label_path LIKE ?)');
        params.push(like(q.q), like(q.q));
      }
      return { sql: `WHERE ${where.join(' AND ')}`, params };
    },
  },
  production: {
    title: 'Production orders',
    sql: (w) => `SELECT o.po_number, f.internal_number AS filter_number, f.name AS filter_name, o.status, o.priority,
                       o.availability_status, o.blocking_reason, o.quantity_ordered, o.quantity_produced,
                       o.planned_start_at, o.planned_end_at, o.started_at, o.completed_at, o.line, o.machine, o.customer_ref,
                       (SELECT COUNT(*) FROM production_order_tools pt WHERE pt.production_order_id = o.id) AS tool_rows,
                       (SELECT COUNT(*) FROM production_order_tools pt WHERE pt.production_order_id = o.id AND pt.status='TAKEN') AS tools_out
                FROM production_orders o JOIN filters f ON f.id = o.filter_id
                ${w.sql} ORDER BY o.planned_start_at DESC LIMIT ?`,
    where: (q) => {
      const where = ['1=1'];
      const params = [];
      if (q.status) {
        where.push('o.status = ?');
        params.push(String(q.status).toUpperCase());
      }
      if (q.blocked === '1') where.push("o.availability_status = 'NOT_READY' AND o.status IN ('PLANNED','READY','IN_PROGRESS')");
      if (q.q) {
        where.push('(o.po_number LIKE ? OR f.internal_number LIKE ? OR o.customer_ref LIKE ?)');
        params.push(like(q.q), like(q.q), like(q.q));
      }
      return { sql: `WHERE ${where.join(' AND ')}`, params };
    },
  },
  maintenance: {
    title: 'Maintenance jobs',
    sql: (w) => `SELECT m.id, t.tooling_id, t.name AS tooling_name, m.kind, m.status, m.priority, m.scheduled_date, m.completed_date,
                        m.technician, m.condition_before, m.condition_after, m.parts_replaced, m.cost, m.downtime_hours,
                        m.next_maintenance_date, m.work_description, m.findings
                 FROM tooling_maintenance m JOIN tooling_items t ON t.id = m.tooling_item_id
                 ${w.sql} ORDER BY m.id DESC LIMIT ?`,
    where: (q) => {
      const where = ['1=1'];
      const params = [];
      if (q.status) {
        where.push('m.status = ?');
        params.push(String(q.status).toUpperCase());
      }
      if (q.days) {
        where.push('m.created_at > DATE_SUB(NOW(), INTERVAL ? DAY)');
        params.push(Math.min(3650, Math.max(7, Number(q.days))));
      }
      return { sql: `WHERE ${where.join(' AND ')}`, params };
    },
  },
  stock: {
    title: 'Finished goods stock',
    sql: (w) => `SELECT ii.sku, ii.name, ii.unit, ii.reorder_level, COALESCE(t.on_hand,0) AS on_hand,
                        COALESCE(t.reserved,0) AS reserved, COALESCE(t.on_hand,0) - COALESCE(t.reserved,0) AS available,
                        ii.location_id, il.code AS location_code
                 FROM inventory_items ii
                 LEFT JOIN (SELECT inventory_item_id, SUM(quantity) AS on_hand, SUM(reserved_qty) AS reserved FROM inventory GROUP BY inventory_item_id) t ON t.inventory_item_id = ii.id
                 LEFT JOIN inventory_locations il ON il.id = ii.location_id
                 ${w.sql} ORDER BY ii.sku LIMIT ?`,
    where: (q) => {
      const where = ["ii.item_kind = 'FILTER'"];
      const params = [];
      if (q.low === '1') where.push('COALESCE(t.on_hand,0) <= ii.reorder_level');
      if (q.q) {
        where.push('(ii.sku LIKE ? OR ii.name LIKE ?)');
        params.push(like(q.q), like(q.q));
      }
      return { sql: `WHERE ${where.join(' AND ')}`, params };
    },
  },
  vehicles: {
    title: 'Vehicle applications',
    sql: (w) => `SELECT v.manufacturer, v.model, v.generation, v.year_from, v.year_to, v.engine, v.engine_code, v.fuel, v.power_hp,
                        f.internal_number AS filter_number, a.quantity_per_vehicle, a.mounting_note
                 FROM filter_vehicle_applications a
                 JOIN vehicles v ON v.id = a.vehicle_id
                 JOIN filters f ON f.id = a.filter_id
                 ${w.sql} ORDER BY v.manufacturer, v.model, f.internal_number LIMIT ?`,
    where: (q) => {
      const where = ['1=1'];
      const params = [];
      if (q.q) {
        where.push('(v.manufacturer LIKE ? OR v.model LIKE ? OR f.internal_number LIKE ? OR v.engine_code LIKE ?)');
        params.push(like(q.q), like(q.q), like(q.q), like(q.q));
      }
      return { sql: `WHERE ${where.join(' AND ')}`, params };
    },
  },
};

export const EXPORT_ENTITIES = Object.entries(ENTITIES).map(([code, v]) => ({ code, title: v.title }));

export async function buildExport(entity, query = {}) {
  const spec = ENTITIES[entity];
  if (!spec) throw notFound(`Unknown export entity "${entity}". Available: ${Object.keys(ENTITIES).join(', ')}`);
  const w = spec.where(query);
  const limit = Math.min(50000, Math.max(1, Number(query.limit || 5000)));
  const rows = await db.all(spec.sql(w), [...w.params, limit]);
  const columns = rows[0] ? Object.keys(rows[0]) : [];
  return { entity, title: spec.title, columns, rows, count: rows.length, truncated: rows.length >= limit, filters: w.params };
}

export async function exportXlsx(bundle, { sheetTitle = null } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sistemi Purepower Tooling';
  wb.created = new Date();
  const ws = wb.addWorksheet(String(sheetTitle ?? bundle.title).slice(0, 28));
  const header = ws.addRow(bundle.columns.map((c) => c.replace(/_/g, ' ').replace(/\b\w/g, (x) => x.toUpperCase())));
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
  for (const row of bundle.rows) {
    ws.addRow(bundle.columns.map((c) => {
      const v = row[c];
      if (v === null || v === undefined) return '';
      if (v instanceof Date) return v;
      if (typeof v === 'object') return JSON.stringify(v);
      return v;
    }));
  }
  bundle.columns.forEach((c, i) => {
    let width = c.length + 3;
    for (let r = 2; r <= Math.min(50, ws.rowCount); r++) width = Math.max(width, String(ws.getCell(r, i + 1).value ?? '').length + 1);
    ws.getColumn(i + 1).width = Math.min(40, Math.max(10, width));
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  if (bundle.columns.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: bundle.columns.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function exportCsv(bundle) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().slice(0, 19).replace('T', ' ') : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [bundle.columns.join(','), ...bundle.rows.map((r) => bundle.columns.map((c) => cell(r[c])).join(','))].join('\n');
}

/**
 * Tiny RFC4180-ish CSV reader for the import screen (quoted fields, doubled quotes).
 * Returns { headers, rows } with rows keyed by header (falling back to alias matching
 * done by the import spec).
 */
export function parseCsv(text) {
  const src = String(text).replace(/^\uFEFF/, '');
  const delim = sniffDelimiter(src);
  const out = [];
  let field = '';
  let row = [];
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === delim) {
      row.push(field.trim());
      field = '';
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field.trim());
      field = '';
      if (row.some((v) => v !== '')) out.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  row.push(field.trim());
  if (row.some((v) => v !== '')) out.push(row);
  if (!out.length) throw badRequest('The file has no rows');
  const headers = out[0].map((h) => String(h).trim().toLowerCase());
  const rows = out.slice(1).map((r, index) => {
    const obj = { __row: index + 2 };
    headers.forEach((h, i) => {
      if (h && r[i] !== undefined && r[i] !== '') obj[h] = r[i];
    });
    return obj;
  });
  return { headers, rows };
}

function sniffDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const counts = { ',': (firstLine.match(/,/g) ?? []).length, ';': (firstLine.match(/;/g) ?? []).length, '\t': (firstLine.match(/\t/g) ?? []).length };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] || ',';
}

/** Map CSV header text onto import spec keys. */
export function normaliseCsvRows({ rows }, aliasMap) {
  return rows.map((row) => {
    const out = { __row: row.__row };
    for (const [key, aliases] of Object.entries(aliasMap)) {
      for (const alias of aliases) {
        const hit = Object.keys(row).find((h) => h === alias || h.includes(alias));
        if (hit && out[key] === undefined) out[key] = row[hit];
      }
    }
    return out;
  });
}
