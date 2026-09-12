/**
 * Reports (spec §43) + Excel export/templates and import (spec §42).
 * Every report is a real SQL query; PDF is laid out with pdfkit, XLSX with exceljs,
 * CSV is written inline so no extra dependency is needed.
 */
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import db from '../db/index.js';
import { refreshOccupancy, refreshSetStatuses } from '../seeds/demo.js';
import { audit } from './audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { escapeLike } from '../lib/validate.js';

const like = (v) => `%${escapeLike(String(v).trim())}%`;

export const REPORTS = [
  { code: 'tooling_inventory', name: 'Tooling Inventory Status', group: 'Tooling', description: 'Every tool with status, condition, location, cycles and next maintenance' },
  { code: 'maintenance_history', name: 'Maintenance History', group: 'Tooling', description: 'Maintenance jobs with cost, downtime and condition before/after' },
  { code: 'warehouse_occupancy', name: 'Warehouse Occupancy', group: 'Warehouse', description: 'Locations, capacity, occupancy and fill percentage' },
  { code: 'missing_tools', name: 'Missing / Unreturned Tools', group: 'Warehouse', description: 'Tools that are out, missing or overdue back on the shelf' },
  { code: 'filter_tooling_matrix', name: 'Filter to Tooling Matrix', group: 'Production', description: 'Which tooling each filter needs and whether it is available' },
  { code: 'production_consumption', name: 'Production Consumption', group: 'Production', description: 'Per-order consumption with cycles used per tool' },
  { code: 'dimension_duplicates', name: 'Dimension Duplicates & Near Matches', group: 'Engineering', description: 'Tooling pairs with near-identical geometry' },
  { code: 'damage_summary', name: 'Damage & Condition Summary', group: 'Quality', description: 'Damage reports grouped by tool, type and severity' },
];

/** Run one report. `format` only affects rounding of a few columns. */
export async function runReport(code, query = {}) {
  const def = REPORTS.find((r) => r.code === code);
  if (!def) throw notFound(`Unknown report "${code}". Available: ${REPORTS.map((r) => r.code).join(', ')}`);
  const q = String(query.q ?? '').trim();
  const days = Math.min(730, Math.max(7, Number(query.days || 90)));
  switch (def.code) {
    case 'tooling_inventory': {
      const where = ['t.deleted_at IS NULL'];
      const params = [];
      if (query.type) {
        where.push('tt.code = ?');
        params.push(String(query.type).toUpperCase());
      }
      if (query.status) {
        where.push('t.status = ?');
        params.push(String(query.status).toUpperCase());
      }
      if (query.warehouse_id) {
        where.push('tl.warehouse_id = ?');
        params.push(Number(query.warehouse_id));
      }
      if (q) {
        where.push('(t.tooling_id LIKE ? OR t.name LIKE ? OR tl.full_code LIKE ?)');
        params.push(like(q), like(q), like(q));
      }
      const rows = await db.all(
        `SELECT t.tooling_id AS code, tt.name AS type, t.name, t.status, t.condition_rating,
                t.quantity, COALESCE(tl.full_code, t.external_location, '') AS location, l.label_path AS location_path,
                d.overall_length_mm AS length_mm, d.overall_width_mm AS width_mm, d.overall_height_mm AS height_mm,
                t.total_cycles, t.max_cycles, t.next_maintenance_date, t.last_maintenance_date, t.open_damage_reports AS open_damage,
                t.reserved_qty, t.serial_number, t.material, t.manufacturer, f.internal_number AS primary_filter,
                ts.code AS tooling_set, t.current_revision, t.updated_at
         FROM tooling_items t
         JOIN tooling_types tt ON tt.id = t.tooling_type_id
         LEFT JOIN tooling_dimensions d ON d.tooling_item_id = t.id
         LEFT JOIN tooling_locations tl ON tl.id = t.location_id
         LEFT JOIN warehouses w ON w.id = tl.warehouse_id
         LEFT JOIN tooling_locations l ON l.id = t.location_id
         LEFT JOIN filters f ON f.id = t.primary_filter_id
         LEFT JOIN tooling_sets ts ON ts.id = t.tooling_set_id
         WHERE ${where.join(' AND ')}
         ORDER BY tt.sort_order, t.tooling_id LIMIT 5000`,
        params,
      );
      return { ...def, columns: headersOf(rows[0]), rows, count: rows.length, generated_at: new Date().toISOString() };
    }
    case 'maintenance_history': {
      const rows = await db.all(
        `SELECT m.id, t.tooling_id AS code, tt.name AS type, m.kind, m.status, m.priority, m.scheduled_date, m.completed_date,
                DATEDIFF(m.completed_date, m.scheduled_date) AS delay_days, m.technician, m.condition_before, m.condition_after,
                m.parts_replaced, m.cost, m.downtime_hours, m.work_description, d.report_no AS damage_report,
                (SELECT COUNT(*) FROM tooling_images im WHERE im.owner_type='MAINTENANCE' AND im.owner_id = m.id) AS photos
         FROM tooling_maintenance m
         JOIN tooling_items t ON t.id = m.tooling_item_id
         JOIN tooling_types tt ON tt.id = t.tooling_type_id
         LEFT JOIN tooling_damage_reports d ON d.id = m.damage_report_id
         WHERE m.created_at > DATE_SUB(NOW(), INTERVAL ? DAY) ${q ? 'AND (t.tooling_id LIKE ? OR m.technician LIKE ? OR m.work_description LIKE ?)' : ''}
         ORDER BY m.scheduled_date DESC, m.id DESC LIMIT 3000`,
        q ? [days, like(q), like(q), like(q)] : [days],
      );
      return { ...def, columns: headersOf(rows[0]), rows, count: rows.length, days, generated_at: new Date().toISOString() };
    }
    case 'warehouse_occupancy': {
      const rows = await db.all(
        `SELECT l.kind, l.full_code AS location, l.label_path, w.code AS warehouse, l.capacity_items AS capacity,
                l.occupancy_items AS occupied, (l.capacity_items - l.occupancy_items) AS free_places,
                ROUND(l.occupancy_items * 100.0 / NULLIF(l.capacity_items,0)) AS fill_pct, l.status,
                (SELECT COUNT(*) FROM tooling_items t WHERE t.location_id = l.id AND t.deleted_at IS NULL AND t.status <> 'AVAILABLE') AS unavailable_items
         FROM tooling_locations l LEFT JOIN warehouses w ON w.id = l.warehouse_id
         WHERE l.kind IN ('ROW','RACK','SHELF','BOX') ${q ? 'AND (l.full_code LIKE ? OR l.label_path LIKE ?)' : ''}
         ORDER BY l.full_code LIMIT 4000`,
        q ? [like(q), like(q)] : [],
      );
      return { ...def, columns: headersOf(rows[0]), rows, count: rows.length, generated_at: new Date().toISOString() };
    }
    case 'missing_tools': {
      const rows = await db.all(
        `SELECT t.tooling_id AS code, t.name, tt.name AS type, t.status, t.condition_rating,
                COALESCE(l.full_code, '') AS home_location, COALESCE(t.external_location, '') AS last_seen_at,
                o.po_number, m.created_at AS last_movement, TIMESTAMPDIFF(HOUR, m.created_at, NOW()) AS hours_since,
                m.username AS last_handled_by, m.note
         FROM tooling_items t
         JOIN tooling_types tt ON tt.id = t.tooling_type_id
         LEFT JOIN tooling_locations l ON l.id = t.location_id
         LEFT JOIN tooling_movements m ON m.id = (SELECT MAX(id) FROM tooling_movements m2 WHERE m2.tooling_item_id = t.id)
         LEFT JOIN production_orders o ON o.id = m.production_order_id
         WHERE t.deleted_at IS NULL AND (t.status IN ('MISSING','IN_USE','DAMAGED') OR (t.status = 'AVAILABLE' AND t.location_id IS NULL AND (t.external_location IS NULL OR t.external_location = '')))
           ${q ? 'AND (t.tooling_id LIKE ? OR t.name LIKE ? OR o.po_number LIKE ?)' : ''}
         ORDER BY m.created_at IS NULL, m.created_at ASC LIMIT 2000`,
        q ? [like(q), like(q), like(q)] : [],
      );
      return { ...def, columns: headersOf(rows[0]), rows, count: rows.length, generated_at: new Date().toISOString() };
    }
    case 'filter_tooling_matrix': {
      const rows = await db.all(
        `SELECT f.internal_number AS filter_number, f.name AS filter_name, ft.name AS filter_type,
                tt.name AS tooling_type, t.tooling_id AS tooling_code, t.status, t.condition_rating,
                COALESCE(l.full_code, t.external_location, '') AS location, r.quantity_required AS required_qty,
                (SELECT COUNT(*) FROM tooling_compatibility c2 WHERE c2.tooling_item_id = t.id) AS shared_filters,
                CASE WHEN t.id IS NULL THEN 'MISSING' WHEN t.status IN ('DAMAGED','MISSING','RETIRED') THEN 'BLOCKED'
                     WHEN t.status = 'MAINTENANCE' THEN 'MAINTENANCE' ELSE 'OK' END AS readiness
         FROM filters f
         JOIN filter_types ft ON ft.id = f.filter_type_id
         JOIN filter_tooling_requirements r ON r.filter_id = f.id
         JOIN tooling_types tt ON tt.id = r.tooling_type_id
         LEFT JOIN tooling_compatibility c ON c.filter_id = f.id
         LEFT JOIN tooling_items t ON t.id = c.tooling_item_id AND t.tooling_type_id = tt.id AND t.deleted_at IS NULL
         LEFT JOIN tooling_locations l ON l.id = t.location_id
         WHERE f.is_active = 1 ${q ? 'AND (f.internal_number LIKE ? OR f.name LIKE ? OR t.tooling_id LIKE ?)' : ''}
         ORDER BY f.internal_number, tt.sort_order, t.tooling_id LIMIT 6000`,
        q ? [like(q), like(q), like(q)] : [],
      );
      return { ...def, columns: headersOf(rows[0]), rows, count: rows.length, generated_at: new Date().toISOString() };
    }
    case 'production_consumption': {
      const rows = await db.all(
        `SELECT o.po_number, f.internal_number AS filter_number, o.status, o.quantity_ordered, o.quantity_produced,
                o.planned_start_at, o.completed_at, t.tooling_id AS code, tt.name AS tooling_type,
                pt.qty AS qty_used, pt.cycle_count AS cycles, pt.taken_at, pt.returned_at,
                TIMESTAMPDIFF(MINUTE, pt.taken_at, pt.returned_at) AS minutes_out
         FROM production_order_tools pt
         JOIN production_orders o ON o.id = pt.production_order_id
         JOIN filters f ON f.id = o.filter_id
         JOIN tooling_items t ON t.id = pt.tooling_item_id
         JOIN tooling_types tt ON tt.id = t.tooling_type_id
         WHERE o.created_at > DATE_SUB(NOW(), INTERVAL ? DAY) ${q ? 'AND (o.po_number LIKE ? OR f.internal_number LIKE ?)' : ''}
         ORDER BY o.planned_start_at DESC, o.po_number, tt.sort_order LIMIT 5000`,
        q ? [days, like(q), like(q)] : [days],
      );
      return { ...def, columns: headersOf(rows[0]), rows, count: rows.length, days, generated_at: new Date().toISOString() };
    }
    case 'dimension_duplicates': {
      const rows = await db.all(
        `SELECT dc.similarity_pct AS match_pct, a.tooling_id AS code_a, b.tooling_id AS code_b,
                a.name AS name_a, b.name AS name_b, tt.name AS type,
                da.overall_length_mm AS length_a, db_.overall_length_mm AS length_b,
                da.overall_width_mm AS width_a, db_.overall_width_mm AS width_b,
                da.overall_height_mm AS height_a, db_.overall_height_mm AS height_b,
                COALESCE(la.full_code, '') AS location_a, COALESCE(lb.full_code, '') AS location_b,
                dc.status, dc.notes
         FROM duplicate_checks dc
         JOIN tooling_items a ON a.id = dc.tooling_a_id
         JOIN tooling_items b ON b.id = dc.tooling_b_id
         JOIN tooling_types tt ON tt.id = a.tooling_type_id
         LEFT JOIN tooling_dimensions da ON da.tooling_item_id = a.id
         LEFT JOIN tooling_dimensions db_ ON db_.tooling_item_id = b.id
         LEFT JOIN tooling_locations la ON la.id = a.location_id
         LEFT JOIN tooling_locations lb ON lb.id = b.location_id
         WHERE dc.similarity_pct >= ? ${q ? 'AND (a.tooling_id LIKE ? OR b.tooling_id LIKE ?)' : ''}
         ORDER BY dc.similarity_pct DESC LIMIT 2000`,
        q ? [Number(query.min_similarity || 80), like(q), like(q)] : [Number(query.min_similarity || 80)],
      );
      return { ...def, columns: headersOf(rows[0]), rows, count: rows.length, min_similarity: Number(query.min_similarity || 80), generated_at: new Date().toISOString() };
    }
    case 'damage_summary': {
      const rows = await db.all(
        `SELECT d.report_no, d.damage_type, d.severity, d.status, d.reported_at, d.resolved_at,
                t.tooling_id AS code, t.name AS tooling_name, tt.name AS type, COALESCE(l.full_code,'') AS location,
                u.full_name AS reported_by, d.description, d.resolution, o.po_number,
                TIMESTAMPDIFF(HOUR, d.reported_at, COALESCE(d.resolved_at, NOW())) AS open_hours
         FROM tooling_damage_reports d
         JOIN tooling_items t ON t.id = d.tooling_item_id
         JOIN tooling_types tt ON tt.id = t.tooling_type_id
         LEFT JOIN tooling_locations l ON l.id = t.location_id
         LEFT JOIN users u ON u.id = d.reported_by
         LEFT JOIN production_orders o ON o.id = d.production_order_id
         WHERE d.reported_at > DATE_SUB(NOW(), INTERVAL ? DAY) ${q ? 'AND (t.tooling_id LIKE ? OR d.damage_type LIKE ? OR d.description LIKE ?)' : ''}
         ORDER BY FIELD(d.severity,'CRITICAL','HIGH','MEDIUM','LOW'), d.reported_at DESC LIMIT 3000`,
        q ? [days, like(q), like(q), like(q)] : [days],
      );
      const groups = await db.all(
        `SELECT damage_type, severity, COUNT(*) AS reports FROM tooling_damage_reports
         WHERE reported_at > DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY damage_type, severity ORDER BY reports DESC`,
        [days],
      );
      return { ...def, columns: headersOf(rows[0]), rows, count: rows.length, groups, days, generated_at: new Date().toISOString() };
    }
    default:
      throw badRequest(`Report ${def.code} has no query implementation`);
  }
}

const headersOf = (row) => (row ? Object.keys(row).filter((k) => row[k] !== undefined) : []);

/* ------------------------------------------------------------------ XLSX */
export async function toXlsx(report, { title = null } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sistemi Purepower Tooling';
  wb.created = new Date();
  const ws = wb.addWorksheet(String(title ?? report.name).slice(0, 28));
  const headerRow = ws.addRow(report.columns.map((c) => prettify(c)));
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } };
  headerRow.alignment = { vertical: 'middle' };
  for (const row of report.rows) {
    ws.addRow(report.columns.map((c) => clean(row[c])));
  }
  ws.columns.forEach((col, i) => {
    const key = report.columns[i];
    let width = String(col.header ?? key).length + 2;
    for (let r = 2; r <= Math.min(60, ws.rowCount); r++) {
      const v = ws.getCell(r, i + 1).value;
      width = Math.max(width, String(v ?? '').length + 1);
    }
    col.width = Math.min(46, Math.max(10, width));
    if (/(date|_at)$/.test(key)) col.numFmt = 'yyyy-mm-dd hh:mm';
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, report.columns.length) } };
  const info = ws.addRow([]);
  void info;
  return wb.xlsx.writeBuffer();
}

/** Blank template for the Excel import (headers + one example row + notes sheet). */
export async function importTemplate(kind) {
  const spec = IMPORT_SPECS[kind];
  if (!spec) throw badRequest(`Unknown import template "${kind}". Available: ${Object.keys(IMPORT_SPECS).join(', ')}`);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(kind.replace(/_/g, ' ').slice(0, 28));
  ws.addRow(spec.columns.map((c) => c.label));
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
  ws.addRow(spec.example);
  ws.columns.forEach((col, i) => {
    col.width = Math.max(12, Math.min(38, String(spec.columns[i].label).length + 6));
  });
  const help = wb.addWorksheet('How to fill this in');
  [
    [`${spec.title} - import guide`],
    [],
    ['1. Keep the header row exactly as it is - the importer matches columns by header text.'],
    ['2. One record per row. Delete the example row before uploading.'],
    ['3. Required fields: ' + spec.columns.filter((c) => c.required).map((c) => c.label).join(', ')],
    ['4. Codes must already exist in the system: ' + (spec.lookups ?? 'none')],
    ['5. Upload the file in the app under Import - you will see a row-by-row validation report before anything is written.'],
    [],
    ['Column', 'Field', 'Required', 'Notes'],
    ...spec.columns.map((c) => [c.label, c.key, c.required ? 'yes' : 'no', c.note ?? '']),
  ].forEach((row) => help.addRow(row));
  help.getRow(1).font = { bold: true, size: 14 };
  help.columns = [{ width: 30 }, { width: 22 }, { width: 10 }, { width: 70 }];
  return wb.xlsx.writeBuffer();
}

const prettify = (key) =>
  String(key)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

const clean = (v) => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
};

/* ------------------------------------------------------------------- PDF */
export function toPdfBuffer(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margins: { top: 34, bottom: 34, left: 34, right: 34 } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(16).text(report.name, { align: 'left' });
    doc.fontSize(9).fillColor('#555').text(`${report.description ?? ''} - generated ${new Date().toLocaleString()}`);
    doc.moveDown(0.6);
    doc.fillColor('#000');
    const cols = report.columns.slice(0, 10);
    const pageWidth = doc.page.width - 68;
    const colWidth = pageWidth / Math.max(1, cols.length);
    const drawHead = () => {
      doc.fontSize(7.5).font('Helvetica-Bold');
      cols.forEach((c, i) => doc.text(prettify(c), 34 + i * colWidth, doc.y, { width: colWidth - 4, height: 11, ellipsis: true }));
      doc.moveDown(0.2);
      doc.font('Helvetica').fontSize(7.5);
      doc.moveTo(34, doc.y).lineTo(34 + pageWidth, doc.y).strokeColor('#999').stroke();
      doc.moveDown(0.25);
    };
    drawHead();
    report.rows.slice(0, 700).forEach((row) => {
      if (doc.y > doc.page.height - 46) {
        doc.addPage();
        drawHead();
      }
      const y = doc.y;
      cols.forEach((c, i) => doc.text(String(clean(row[c])).slice(0, 60), 34 + i * colWidth, y, { width: colWidth - 4, height: 10, ellipsis: true }));
      doc.y = y + 11;
    });
    doc.end();
  });
}

export function toCsv(report) {
  const cell = (v) => {
    const s = String(clean(v));
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [report.columns.map((c) => cell(prettify(c))).join(','), ...report.rows.map((r) => report.columns.map((c) => cell(r[c])).join(','))].join('\n');
}

/* ------------------------------------------------------------- importing */
export const IMPORT_SPECS = {
  filters: {
    title: 'Filter catalogue import',
    lookups: 'filter types (AIR, OIL, ...), brands (FIAT, VW, ...)',
    columns: [
      { key: 'internal_number', label: 'Internal number', required: true, note: 'Unique - existing numbers are updated' },
      { key: 'product_number', label: 'Product number' },
      { key: 'name', label: 'Name' },
      { key: 'filter_type', label: 'Filter type', required: true, note: 'Code or name, e.g. OIL' },
      { key: 'brand', label: 'Brand', note: 'Code or name' },
      { key: 'length_mm', label: 'Length (mm)', type: 'number' },
      { key: 'width_mm', label: 'Width (mm)', type: 'number' },
      { key: 'height_mm', label: 'Height (mm)', type: 'number' },
      { key: 'outer_diameter_mm', label: 'Outer diameter (mm)', type: 'number' },
      { key: 'status', label: 'Status', note: 'ACTIVE / DEVELOPMENT / DISCONTINUED / OBSOLETE' },
      { key: 'oem_numbers', label: 'OEM numbers', note: 'Separated by | or ,' },
    ],
    example: ['PP-OIL-9001', 'PU1029', 'Oil filter', 'OIL', 'FIAT', 76, 76, 90, 92, 'ACTIVE', '71750040 | 5860177'],
  },
  tooling: {
    title: 'Tooling register import',
    lookups: 'tooling categories, location codes, filter internal numbers',
    columns: [
      { key: 'tooling_id', label: 'Tooling ID', required: true, note: 'e.g. H-00452-A - existing IDs are updated' },
      { key: 'name', label: 'Name', required: true },
      { key: 'tooling_type', label: 'Category', required: true, note: 'Code or name, e.g. HOUSING_RUBBER' },
      { key: 'status', label: 'Status', note: 'AVAILABLE / IN_USE / MAINTENANCE / RESERVED / DAMAGED / RETIRED / MISSING' },
      { key: 'condition_rating', label: 'Condition' },
      { key: 'quantity', label: 'Quantity', type: 'number' },
      { key: 'material', label: 'Material' },
      { key: 'overall_length_mm', label: 'Length (mm)', type: 'number' },
      { key: 'overall_width_mm', label: 'Width (mm)', type: 'number' },
      { key: 'overall_height_mm', label: 'Height (mm)', type: 'number' },
      { key: 'max_cycles', label: 'Max cycles', type: 'number' },
      { key: 'location', label: 'Location code', note: 'e.g. TR-R02-RK05-S03 - unknown codes are reported' },
      { key: 'filter_number', label: 'Used for filter', note: 'Internal number of the filter this tool belongs to' },
    ],
    example: ['H-00999-A', 'Rubber forming housing 999', 'HOUSING_RUBBER', 'AVAILABLE', 'GOOD', 1, 'Aluminium 7075', 250, 150, 80, 50000, 'TR-R02-RK05-S03', 'PP-OIL-9001'],
  },
  applications: {
    title: 'Vehicle application import',
    lookups: 'filter internal numbers; vehicles are created when missing',
    columns: [
      { key: 'internal_number', label: 'Internal number', required: true },
      { key: 'manufacturer', label: 'Manufacturer', required: true },
      { key: 'model', label: 'Model', required: true },
      { key: 'generation', label: 'Generation' },
      { key: 'year_from', label: 'Year from', type: 'number' },
      { key: 'year_to', label: 'Year to', type: 'number' },
      { key: 'engine', label: 'Engine' },
      { key: 'engine_code', label: 'Engine code' },
      { key: 'fuel', label: 'Fuel' },
      { key: 'power_hp', label: 'Power (HP)', type: 'number' },
      { key: 'quantity_per_vehicle', label: 'Qty per vehicle', type: 'number' },
    ],
    example: ['PP-OIL-9001', 'Fiat', 'Panda', '2020>', 2020, 2026, '1.0 FireFly', 'FH', 'Petrol', 70, 1],
  },
};

import { HEADER_ALIASES } from './importAliases.js';

function readWorksheet(buffer) {
  return (async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets.find((w) => w.actualRowCount > 1) ?? wb.worksheets[0];
    if (!ws) throw badRequest('The workbook has no sheets');
    const headerCells = ws.getRow(1).values ?? [];
    const headers = headerCells.slice(1).map((h) => String(h ?? '').trim().toLowerCase());
    const map = {};
    for (const [index, header] of headers.entries()) {
      for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
        if (map[key] === undefined && (aliases.includes(header) || header.includes(key.replace(/_/g, ' ')) || header === key)) map[key] = index + 1;
      }
    }
    const rows = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const obj = {};
      let any = false;
      for (const [key, col] of Object.entries(map)) {
        let v = row.getCell(col).value;
        if (v && typeof v === 'object' && v.richText) v = v.richText.map((t) => t.text).join('');
        if (v && typeof v === 'object' && v.text !== undefined) v = v.text;
        if (v && typeof v === 'object' && v.result !== undefined) v = v.result;
        if (v instanceof Date) v = v.toISOString().slice(0, 10);
        if (typeof v === 'string') v = v.trim();
        if (v === '' || v === null || v === undefined) continue;
        obj[key] = v;
        any = true;
      }
      if (any) rows.push({ __row: r, ...obj });
    }
    return { headers, rows, sheetName: ws.name };
  })();
}

/** Validate + (optionally) write an uploaded sheet. Never partially commits a bad row. */
export async function importRows(kind, { rows, dryRun = true, actor = null, ctx = null }) {
  const spec = IMPORT_SPECS[kind];
  if (!spec) throw badRequest(`Unknown import kind "${kind}"`);
  const errors = [];
  const valid = [];
  for (const raw of rows) {
    const problems = [];
    for (const col of spec.columns) {
      const value = raw[col.key];
      if (col.required && (value === undefined || value === '')) problems.push(`${col.label} is required`);
      if (col.type === 'number' && value !== undefined && value !== '') {
        const n = Number(value);
        if (!Number.isFinite(n)) problems.push(`${col.label} must be a number (got "${value}")`);
        else raw[col.key] = n;
      }
    }
    if (problems.length) errors.push({ row: raw.__row, errors: problems, data: omitMeta(raw) });
    else valid.push(omitMeta(raw));
  }
  if (dryRun) {
    return { kind, dry_run: true, total: rows.length, valid: valid.length, invalid: errors.length, errors: errors.slice(0, 200), preview: valid.slice(0, 20) };
  }
  let written = 0;
  const notes = [];
  for (const item of valid) {
    try {
      const res = kind === 'filters' ? await upsertFilterRow(item, ctx) : kind === 'tooling' ? await upsertToolingRow(item, ctx) : await upsertApplicationRow(item, ctx);
          written += 1;
      if (res.note) notes.push({ key: res.key, note: res.note });
    } catch (err) {
      errors.push({ row: null, errors: [err.message], data: item });
    }
  }
  await audit(ctx, {
    action: 'import',
    entityType: kind,
    summary: `Imported ${written}/${rows.length} ${kind} row(s) from Excel${errors.length ? `, ${errors.length} rejected` : ''}`,
  });
  return { kind, dry_run: false, total: rows.length, written, invalid: errors.length, errors: errors.slice(0, 200), notes, actor: actor?.username ?? null };
}

const omitMeta = (o) => {
  const { __row, ...rest } = o;
  void __row;
  return rest;
};

async function upsertFilterRow(row, ctx) {
  const type = await db.one('SELECT id FROM filter_types WHERE is_active = 1 AND (code = ? OR name = ?)', [String(row.filter_type).toUpperCase(), row.filter_type]);
  if (!type) throw badRequest(`Filter type "${row.filter_type}" does not exist`);
  const brand = row.brand ? await db.one('SELECT id FROM brands WHERE UPPER(code) = ? OR name = ?', [String(row.brand).toUpperCase(), row.brand]) : null;
  if (row.brand && !brand) throw badRequest(`Brand "${row.brand}" does not exist`);
  const existing = await db.one('SELECT id FROM filters WHERE internal_number = ?', [row.internal_number]);
  if (existing) {
    await db.run(
      `UPDATE filters SET product_number = COALESCE(?, product_number), name = COALESCE(?, name), filter_type_id = ?, brand_id = COALESCE(?, brand_id),
              status = COALESCE(?, status), updated_at = NOW() WHERE id = ?`,
      [row.product_number ?? null, row.name ?? null, type.id, brand?.id ?? null, row.status ?? null, existing.id],
    );
    if (row.internal_number) await writeFilterDimensions(existing.id, row, true);
    return { key: row.internal_number, note: 'updated' };
  }
  const r = await db.run(
    `INSERT INTO filters (internal_number, product_number, name, filter_type_id, brand_id, status, is_active, created_by) VALUES (?,?,?,?,?,?,1,?)`,
    [row.internal_number, row.product_number ?? null, row.name ?? row.internal_number, type.id, brand?.id ?? null, row.status ?? 'ACTIVE', ctx?.user?.id ?? null],
  );
  const id = r.insertId ?? (await db.value('SELECT id FROM filters WHERE internal_number = ?', [row.internal_number]));
  await writeFilterDimensions(id, row, false);
  for (const ref of String(row.oem_numbers ?? '').split(/[|,;]/).map((s) => s.trim()).filter(Boolean)) {
    await db.run('INSERT IGNORE INTO filter_cross_references (filter_id, ref_number, ref_type) VALUES (?,?,?)', [id, ref, 'OEM']);
  }
  return { key: row.internal_number, note: 'created' };
}

async function writeFilterDimensions(id, row, upsert) {
  const vals = { length_mm: row.length_mm ?? null, width_mm: row.width_mm ?? null, height_mm: row.height_mm ?? null, overall_diameter_mm: row.outer_diameter_mm ?? null };
  if (!Object.values(vals).some((v) => v !== null)) return;
  await db.run(
    `INSERT INTO filter_dimensions (filter_id, unit, length_mm, width_mm, height_mm, overall_diameter_mm) VALUES (?, 'mm', ?,?,?,?)
     ON DUPLICATE KEY UPDATE length_mm = VALUES(length_mm), width_mm = VALUES(width_mm), height_mm = VALUES(height_mm), overall_diameter_mm = VALUES(overall_diameter_mm)`,
    [id, vals.length_mm, vals.width_mm, vals.height_mm, vals.overall_diameter_mm],
  );
  await db.run('UPDATE filters SET search_blob = CONCAT_WS(" | ", internal_number, name, ?) WHERE id = ?', [Object.values(vals).filter((v) => v !== null).join('x'), id]).catch(() => null);
}

async function upsertToolingRow(row, ctx) {
  const { createTool, saveDimensions } = await import('./tooling.js');
  const type = await db.one('SELECT id, code FROM tooling_types WHERE is_active = 1 AND (code = ? OR name = ?)', [String(row.tooling_type).toUpperCase(), row.tooling_type]);
  if (!type) throw badRequest(`Tooling category "${row.tooling_type}" does not exist`);
  const location = row.location ? await db.one('SELECT id FROM tooling_locations WHERE full_code = ? OR code = ?', [String(row.location).toUpperCase(), String(row.location).toUpperCase()]) : null;
  if (row.location && !location) throw badRequest(`Location "${row.location}" was not found`);
  const filter = row.filter_number ? await db.one('SELECT id FROM filters WHERE internal_number = ?', [row.filter_number]) : null;
  if (row.filter_number && !filter) throw badRequest(`Filter "${row.filter_number}" was not found`);
  const existing = await db.one('SELECT id FROM tooling_items WHERE tooling_id = ?', [row.tooling_id]);
  if (existing) {
    await db.run(
      `UPDATE tooling_items SET name = COALESCE(?, name), quantity = COALESCE(?, quantity), status = COALESCE(?, status),
              condition_rating = COALESCE(?, condition_rating), material = COALESCE(?, material), location_id = COALESCE(?, location_id), updated_at = NOW() WHERE id = ?`,
      [row.name ?? null, row.quantity ?? null, row.status ?? null, row.condition_rating ?? null, row.material ?? null, location?.id ?? null, existing.id],
    );
    return { key: row.tooling_id, note: 'updated' };
  }
  const created = await createTool({
    tooling_id: row.tooling_id,
    name: row.name,
    tooling_type_id: type.id,
    status: STATUSES_OK.has(String(row.status ?? '').toUpperCase()) ? row.status.toUpperCase() : 'AVAILABLE',
    condition_rating: CONDITIONS_OK.has(String(row.condition_rating ?? '').toUpperCase()) ? row.condition_rating.toUpperCase() : 'GOOD',
    material: row.material ?? null,
    quantity: Number(row.quantity ?? 1),
    max_cycles: row.max_cycles ? Number(row.max_cycles) : null,
    location_id: location?.id ?? null,
    primary_filter_id: filter?.id ?? null,
    created_by: ctx?.user?.id ?? null,
  });
  const dims = { overall_length_mm: row.overall_length_mm ?? null, overall_width_mm: row.overall_width_mm ?? null, overall_height_mm: row.overall_height_mm ?? null };
  if (Object.values(dims).some((v) => v !== null)) await saveDimensions(created.id, dims);
  if (filter) await db.run('INSERT IGNORE INTO tooling_compatibility (tooling_item_id, filter_id, compatibility_level, is_primary, created_by) VALUES (?,?,?,1,?)', [created.id, filter.id, 'EXACT', ctx?.user?.id ?? null]);
  await refreshOccupancy();
  await refreshSetStatuses();
  return { key: row.tooling_id, note: 'created' };
}

const STATUSES_OK = new Set(['AVAILABLE', 'IN_USE', 'MAINTENANCE', 'RESERVED', 'DAMAGED', 'RETIRED', 'MISSING']);
const CONDITIONS_OK = new Set(['EXCELLENT', 'GOOD', 'FAIR', 'POOR', 'CRITICAL']);

async function upsertApplicationRow(row, ctx) {
  const filter = await db.one('SELECT id FROM filters WHERE internal_number = ? OR product_number = ?', [row.internal_number, row.internal_number]);
  if (!filter) throw badRequest(`Filter "${row.internal_number}" was not found - import the filters sheet first`);
  const vehicle = await db.one(
    `SELECT id FROM vehicles WHERE UPPER(manufacturer) = ? AND UPPER(model) = ? AND COALESCE(generation,'') = ? AND COALESCE(engine_code,'') = ?`,
    [String(row.manufacturer).toUpperCase(), String(row.model).toUpperCase(), String(row.generation ?? '').trim(), String(row.engine_code ?? '').trim()],
  );
  let vehicleId = vehicle?.id;
  if (!vehicleId) {
    const r = await db.run(
      `INSERT INTO vehicles (manufacturer, model, generation, year_from, year_to, engine, engine_code, fuel, power_hp) VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        String(row.manufacturer).trim(),
        String(row.model).trim(),
        row.generation ?? null,
        row.year_from ?? null,
        row.year_to ?? null,
        row.engine ?? null,
        row.engine_code ?? null,
        row.fuel ?? null,
        row.power_hp ?? null,
      ],
    );
    vehicleId = r.insertId ?? (await db.value('SELECT MAX(id) m FROM vehicles'));
  }
  await db.run(
    `INSERT INTO filter_vehicle_applications (filter_id, vehicle_id, quantity_per_vehicle, start_year, end_year)
     VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE quantity_per_vehicle = VALUES(quantity_per_vehicle), start_year = VALUES(start_year), end_year = VALUES(end_year)`,
    [filter.id, vehicleId, Number(row.quantity_per_vehicle ?? 1), row.year_from ?? null, row.year_to ?? null],
  );
  return { key: `${row.internal_number}/${row.manufacturer} ${row.model}`, note: 'linked' };
}

export { readWorksheet };
