/** QR codes, Code-128 barcodes and printable labels (spec §15, §16, §44, §45). */
import QRCode from 'qrcode';
import { toSVG as bwipSvg, toBuffer as bwipBuffer } from 'bwip-js';
import db from '../db/index.js';
import config from '../config.js';
import { badRequest, notFound } from '../lib/errors.js';

export const TOOL_CODE_PREFIX = 'SP:T:';
export const LOCATION_CODE_PREFIX = 'SP:L:';
export const FILTER_CODE_PREFIX = 'SP:F:';
export const ORDER_CODE_PREFIX = 'SP:P:';

function baseUrl(req) {
  if (config.publicUrl) return config.publicUrl.replace(/\/$/, '');
  const host = req?.headers?.host;
  if (!host) return '';
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${host}`;
}

export async function payloadFor(kind, code, req) {
  const settings = await db.one("SELECT value FROM app_settings WHERE setting_key = 'scan_open_mode'");
  const compact = String(settings?.value ?? 'tool') === 'tool';
  if (compact) {
    const prefix = { tooling: TOOL_CODE_PREFIX, location: LOCATION_CODE_PREFIX, filter: FILTER_CODE_PREFIX, order: ORDER_CODE_PREFIX }[kind];
    return `${prefix}${code}`;
  }
  const path = { tooling: `/t/`, location: `/loc/`, filter: `/f/`, order: `/po/` }[kind];
  return `${baseUrl(req)}${path}${encodeURIComponent(code)}`;
}

export async function qrSvg(text, { margin = 1, width = 240, dark = '#0f172a' } = {}) {
  return QRCode.toString(String(text), {
    type: 'svg',
    margin,
    width,
    color: { dark, light: '#ffffff' },
    errorCorrectionLevel: 'M',
  });
}

export async function qrPng(text, { margin = 1, width = 320 } = {}) {
  return QRCode.toBuffer(String(text), { type: 'png', margin, width, errorCorrectionLevel: 'M' });
}

export async function barcodeSvg(text, { height = 46, scale = 2, bcid = 'code128' } = {}) {
  if (!String(text).trim()) throw badRequest('Barcode text is empty');
  return bwipSvg({ bcid, text: String(text), height, scale, includetext: true, textxalign: 'center', paddingwidth: 4, paddingheight: 2 });
}

export async function barcodePng(text, { height = 46, scale = 2, bcid = 'code128' } = {}) {
  return bwipBuffer({ bcid, text: String(text), filetype: 'png', height, scale, includetext: true, textxalign: 'center', paddingwidth: 4, paddingheight: 2 });
}

/** Resolve a scanned payload (QR or barcode) to an app route + entity. */
export async function resolveScan(raw, req) {
  const text = String(raw || '').trim();
  if (!text) throw badRequest('Nothing was scanned');
  const attempt = async () => {
    if (text.startsWith(TOOL_CODE_PREFIX)) return byTooling(text.slice(TOOL_CODE_PREFIX.length));
    if (text.startsWith(LOCATION_CODE_PREFIX)) return byLocation(text.slice(LOCATION_CODE_PREFIX.length));
    if (text.startsWith(FILTER_CODE_PREFIX)) return byFilter(text.slice(FILTER_CODE_PREFIX.length));
    if (text.startsWith(ORDER_CODE_PREFIX)) return byOrder(text.slice(ORDER_CODE_PREFIX.length));
    if (/^https?:\/\//i.test(text)) {
      const path = text.replace(/^https?:\/\/[^/]+/i, '');
      const m = /^\/(?:t|tooling)\/([^/?#]+)/i.exec(path) || /^\/loc\/([^/?#]+)/i.exec(path) || /^\/f\/([^/?#]+)/i.exec(path) || /^\/po\/([^/?#]+)/i.exec(path) || /^\/#\/(.+)$/i.exec(path);
      if (m) {
        const frag = decodeURIComponent(m[1]);
        if (/^\/?t\//i.test(m[1]) || /^t\//i.test(frag)) return byTooling(frag.replace(/^t\//i, ''));
        if (/^loc\//i.test(frag)) return byLocation(frag.replace(/^loc\//i, ''));
        if (/^f\//i.test(frag)) return byFilter(frag.replace(/^f\//i, ''));
        if (/^po\//i.test(frag)) return byOrder(frag.replace(/^po\//i, ''));
      }
    }
    // free text: tooling id -> location -> filter -> barcode -> production order
    const tool = await byTooling(text, true);
    if (tool) return tool;
    const loc = await byLocation(text, true);
    if (loc) return loc;
    const filt = await byFilter(text, true);
    if (filt) return filt;
    const order = await byOrder(text, true);
    if (order) return order;
    return null;
  };
  const result = await attempt();
  if (!result) throw notFound(`Nothing found for "${text}". It is neither a tooling ID, location code, filter number nor production order in this plant.`);
  if (result.kind === 'tooling' || result.kind === 'location') {
    await db.run('UPDATE code_registry SET printed_count = printed_count, last_printed_at = last_printed_at WHERE entity_type = ? AND code = ?', [result.kind, result.code]);
  }
  return { ...result, route: routeFor(result), scan_payload: text };
}

function routeFor(r) {
  if (r.kind === 'tooling') return `#/tooling/${encodeURIComponent(r.code)}`;
  if (r.kind === 'location') return `#/location/${encodeURIComponent(r.code)}`;
  if (r.kind === 'filter') return `#/filters/${encodeURIComponent(r.code)}`;
  if (r.kind === 'order') return `#/production/${r.id}`;
  return '#/search';
}

async function byTooling(code, soft = false) {
  const row = await db.one(
    `SELECT t.id, t.tooling_id, t.name, t.status, t.barcode FROM tooling_items t WHERE UPPER(t.tooling_id) = ? OR t.barcode = ? LIMIT 1`,
    [String(code).toUpperCase(), String(code).toUpperCase()],
  );
  if (!row) {
    if (soft) return null;
    throw notFound(`Tooling ${code} not found`);
  }
  return { kind: 'tooling', id: row.id, code: row.tooling_id, label: row.name, status: row.status };
}

async function byLocation(code, soft = false) {
  const row = await db.one('SELECT id, full_code, kind, label_path, occupancy_items FROM tooling_locations WHERE full_code = ? OR code = ? LIMIT 1', [String(code).toUpperCase(), String(code).toUpperCase()]);
  if (!row) {
    if (soft) return null;
    throw notFound(`Storage location ${code} not found`);
  }
  return { kind: 'location', id: row.id, code: row.full_code, label: row.label_path, occupancy: Number(row.occupancy_items ?? 0), location_kind: row.kind };
}

async function byFilter(code, soft = false) {
  const row = await db.one('SELECT id, internal_number, name FROM filters WHERE UPPER(internal_number) = ? OR UPPER(product_number) = ? LIMIT 1', [String(code).toUpperCase(), String(code).toUpperCase()]);
  if (!row) {
    if (soft) return null;
    throw notFound(`Filter ${code} not found`);
  }
  return { kind: 'filter', id: row.id, code: row.internal_number, label: row.name };
}

async function byOrder(code, soft = false) {
  const row = await db.one('SELECT id, po_number, status FROM production_orders WHERE UPPER(po_number) = ? LIMIT 1', [String(code).toUpperCase()]);
  if (!row) {
    if (soft) return null;
    throw notFound(`Production order ${code} not found`);
  }
  return { kind: 'order', id: row.id, code: row.po_number, label: `Production order ${row.po_number}`, status: row.status };
}

/** Upsert the code registry row used for label reprinting. */
export async function ensureCode(entityType, entityId, code, { symbology = 'QR', payload, targetUrl, labelSize = null } = {}) {
  await db.run(
    `INSERT INTO code_registry (entity_type, entity_id, code, symbology, payload, target_url, label_size_mm)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE code=VALUES(code), payload=VALUES(payload), target_url=VALUES(target_url), label_size_mm=VALUES(label_size_mm), updated_at=NOW()`,
    [entityType, Number(entityId), code, symbology, payload, targetUrl, labelSize],
  );
  return db.one('SELECT * FROM code_registry WHERE entity_type = ? AND entity_id = ? AND symbology = ?', [entityType, Number(entityId), symbology]);
}

export async function markPrinted(ids, count = 1) {
  if (!ids.length) return 0;
  const ph = ids.map(() => '?').join(',');
  const res = await db.run(`UPDATE code_registry SET printed_count = printed_count + ?, last_printed_at = NOW() WHERE id IN (${ph})`, [Number(count) || 1, ...ids.map(Number)]);
  return res.affectedRows;
}

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Printable sheet of labels (browser print -> PDF, or a label printer).
 * Uses the selected label template (spec §44/§45).
 */
export async function labelSheet({ kind, ids, templateId = null, req }) {
  const template = templateId
    ? await db.one('SELECT * FROM label_templates WHERE id = ?', [Number(templateId)])
    : await db.one('SELECT * FROM label_templates WHERE kind = ? ORDER BY is_default DESC, id LIMIT 1', [kind === 'tooling' ? 'TOOLING' : 'LOCATION']);
  if (!template) throw badRequest('No label template found');
  const settings = await db.all('SELECT setting_key, value FROM app_settings WHERE setting_key IN (?,?,?,?,?)', [
    'company_name',
    'company_logo_text',
    'base_url',
    'scan_open_mode',
    'duplicate_similarity_pct',
  ]);
  const cfg = Object.fromEntries(settings.map((s) => [s.setting_key, s.value]));
  const labels = [];
  for (const rawId of ids.slice(0, 200)) {
    const id = Number(rawId);
    if (kind === 'tooling') {
      const t = await db.one(
        `SELECT t.id, t.tooling_id, t.name, t.status, t.quantity, t.serial_number,
                tt.name AS type_name, tt.icon, tl.full_code, tl.label_path,
                f.internal_number, f.name AS filter_name,
                d.overall_length_mm, d.overall_width_mm, d.overall_height_mm
         FROM tooling_items t
         JOIN tooling_types tt ON tt.id = t.tooling_type_id
         LEFT JOIN tooling_locations tl ON tl.id = t.location_id
         LEFT JOIN filters f ON f.id = t.primary_filter_id
         LEFT JOIN tooling_dimensions d ON d.tooling_item_id = t.id
         WHERE t.id = ?`,
        [id],
      );
      if (!t) throw notFound(`Tooling #${id} not found`);
      const payload = await payloadFor('tooling', t.tooling_id, req);
      const reg = await ensureCode('TOOLING', t.id, t.tooling_id, { payload, targetUrl: `/t/${encodeURIComponent(t.tooling_id)}` });
      const barcode = t.barcode ? await barcodeSvg(t.barcode, { height: 28, scale: 1 }).catch(() => '') : '';
      labels.push({
        code: t.tooling_id,
        title: t.tooling_id,
        type: t.type_name,
        filter: t.internal_number ? `${t.internal_number}` : '-',
        location: t.full_code ?? 'not stored',
        status: t.status,
        qty: t.quantity,
        serial: t.serial_number,
        dimensions: [t.overall_length_mm, t.overall_width_mm, t.overall_height_mm].filter((v) => v !== null).join(' x '),
        qr: await qrSvg(payload, { width: 220, margin: 1 }),
        barcode,
        registry_id: reg.id,
      });
    } else {
      const l = await db.one('SELECT * FROM tooling_locations WHERE id = ?', [id]);
      if (!l) throw notFound(`Location #${id} not found`);
      const payload = await payloadFor('location', l.full_code, req);
      const reg = await ensureCode('LOCATION', l.id, l.full_code, { payload, targetUrl: `/loc/${encodeURIComponent(l.full_code)}` });
      labels.push({
        code: l.full_code,
        title: l.full_code,
        type: l.kind,
        filter: l.label_path ?? '',
        location: l.label_path ?? '',
        status: l.status,
        qty: l.occupancy_items,
        serial: null,
        dimensions: l.capacity_items ? `capacity ${l.capacity_items}` : '',
        qr: await qrSvg(payload, { width: 260, margin: 1 }),
        barcode: await barcodeSvg(l.full_code, { height: 30, scale: 1 }).catch(() => ''),
        registry_id: reg.id,
      });
    }
  }

  const w = Number(template.width_mm);
  const h = Number(template.height_mm);
  const font = Number(template.font_scale || 1);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Labels - ${esc(labels[0]?.code ?? '')}</title>
<style>
  @page { size: A4; margin: 8mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; margin: 0; color: #0b1220; }
  .sheet { display: flex; flex-wrap: wrap; gap: 3mm; }
  .label { width: ${w}mm; height: ${h}mm; border: 0.3mm dashed #9aa5b1; padding: ${2.2 * font}mm; position: relative; overflow: hidden; page-break-inside: avoid; background: #fff; }
  .brand { font-size: ${2.6 * font}mm; font-weight: 800; letter-spacing: .06em; color: #1d4ed8; text-transform: uppercase; }
  .code { font-size: ${5.4 * font}mm; font-weight: 800; line-height: 1.05; margin-top: ${0.6 * font}mm; letter-spacing: -0.01em; }
  .row { font-size: ${2.5 * font}mm; line-height: 1.25; }
  .row b { color: #475569; font-weight: 700; text-transform: uppercase; font-size: ${2 * font}mm; letter-spacing: .04em; }
  .grid { display: flex; gap: 2mm; align-items: flex-end; }
  .codes { margin-left: auto; text-align: center; }
  .codes svg, .codes img { height: ${Math.min(h * 0.55, 22)}mm; width: auto; }
  .bc svg { height: ${4.5 * font}mm; width: 100%; }
  .status { position: absolute; right: ${2 * font}mm; top: ${2 * font}mm; font-size: ${2 * font}mm; font-weight: 700; padding: .4mm 1.2mm; border-radius: 1mm; background: #e2e8f0; }
  .hint { position: fixed; bottom: 0; left: 0; right: 0; background: #0f172a; color: #fff; padding: 2mm 4mm; font-size: 3mm; }
  @media print { .hint { display: none; } .label { border-color: transparent; } }
</style></head><body>
<div class="hint">${labels.length} label(s) · ${esc(template.name)} (${w}×${h}mm) · print at 100% scale (Ctrl/Cmd + P) or choose "Save as PDF".</div>
<div class="sheet">${labels
    .map(
      (l) => `<div class="label">
  <div class="grid">
    <div style="min-width:0;flex:1">
      <div class="brand">${esc(cfg.company_logo_text || cfg.company_name || 'PUREPOWER')}</div>
      <div class="code">${esc(l.title)}</div>
      ${template.show_type ? `<div class="row"><b>Type</b><br>${esc(l.type)}</div>` : ''}
      ${template.show_filter && l.filter && l.filter !== '-' ? `<div class="row"><b>Filter</b><br>${esc(l.filter)}</div>` : ''}
      ${template.show_location ? `<div class="row"><b>Location</b><br>${esc(l.location)}</div>` : ''}
      ${template.show_dimensions && l.dimensions ? `<div class="row"><b>Size</b><br>${esc(l.dimensions)} mm</div>` : ''}
      ${template.show_status ? `<div class="row"><b>Status</b><br>${esc(l.status)}${l.qty && Number(l.qty) > 1 ? ` × ${esc(l.qty)}` : ''}</div>` : ''}
      ${l.serial ? `<div class="row"><b>S/N</b><br>${esc(l.serial)}</div>` : ''}
      ${l.barcode ? `<div class="bc">${l.barcode}</div>` : ''}
    </div>
    <div class="codes">${l.qr}</div>
  </div>
</div>`,
    )
    .join('')}</div>
</body></html>`;
  await markPrinted(labels.map((l) => l.registry_id), 1);
  return { html, count: labels.length, template };
}
