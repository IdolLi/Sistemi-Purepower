/** Shared state, tiny hash router helpers and cross-view actions. */
import { api, loadMeta, meta, statusInfo, download } from './api.js';
import { h, toast, modal, formDialog, errorBox, spinner, notice } from './ui.js';
import { openScanner, resolveScan } from './scan.js';

export const state = {
  user: null,
  permissions: new Set(),
  counts: {},
  offline: !navigator.onLine,
  route: { path: '/', params: {}, query: {} },
};

export const NAV = [
  { group: 'floor', items: [{ href: '#/', label: 'Dashboard', icon: '🏠', key: 'dashboard' }, { href: '#/search', label: 'Search', icon: '🔎', key: 'search' }, { href: '#/scan', label: 'Scan', icon: '📷', key: 'scan' }] },
  {
    group: 'records',
    items: [
      { href: '#/filters', label: 'Filters', icon: '🧫', key: 'filters' },
      { href: '#/tooling', label: 'Tooling', icon: '🧿', key: 'tooling' },
      { href: '#/locations', label: 'Locations', icon: '🗄', key: 'locations' },
      { href: '#/inventory', label: 'Inventory', icon: '📦', key: 'inventory' },
      { href: '#/movements', label: 'Movements', icon: '🚚', key: 'movements' },
    ],
  },
  {
    group: 'work',
    items: [
      { href: '#/production', label: 'Production', icon: '🏭', key: 'production' },
      { href: '#/maintenance', label: 'Maintenance', icon: '🛠', key: 'maintenance' },
      { href: '#/requests', label: 'Tooling requests', icon: '📝', key: 'requests' },
      { href: '#/labels', label: 'Labels', icon: '🏷', key: 'labels' },
      { href: '#/reports', label: 'Reports', icon: '📊', key: 'reports' },
      { href: '#/importexport', label: 'Import / export', icon: '🔁', key: 'importexport' },
    ],
  },
  {
    group: 'admin',
    items: [
      { href: '#/notifications', label: 'Alerts', icon: '🔔', key: 'notifications' },
      { href: '#/audit', label: 'Audit log', icon: '🕵️', key: 'audit', perm: 'audit.read' },
      { href: '#/admin', label: 'Settings & users', icon: '⚙️', key: 'admin', perm: 'users.read' },
    ],
  },
];

export const BIG_BUTTONS = [
  { href: '#/search', label: 'SEARCH', icon: '🔎' },
  { href: '#/scan', label: 'SCAN', icon: '📷' },
  { href: '#/inventory', label: 'INVENTORY', icon: '📦' },
  { href: '#/tooling', label: 'TOOLING', icon: '🧿' },
  { href: '#/locations', label: 'LOCATIONS', icon: '🗄' },
];

/**
 * Client-side mirror of server/lib/permissions.js. The server is the real boundary; this
 * only decides what is worth showing. Reads marked here are never unlocked by the generic
 * "*.read" wildcard, so admin-only screens disappear for floor roles.
 */
const RESTRICTED_READS = new Set(['users.read', 'roles.read', 'permissions.read', 'settings.read', 'backups.read', 'environment.read', 'audit.read']);

export function can(permission) {
  if (!permission) return true;
  const set = state.permissions;
  if (set.has('*') || set.has(permission)) return true;
  if (permission.endsWith('.read') && !RESTRICTED_READS.has(permission)) {
    const module = permission.split('.')[0];
    return set.has(`${module}.read`) || set.has('*.read');
  }
  return false;
}

export async function bootstrap() {
  await loadMeta();
  state.user = meta.data?.user ?? null;
  state.permissions = new Set(state.user?.permissions ?? []);
  return meta.data;
}

export async function login(username, password) {
  const out = await api.post('/api/auth/login', { username, password });
  await loadMeta(true);
  state.user = out.user;
  state.permissions = new Set(out.user?.permissions ?? []);
  return out;
}

export async function logout() {
  await api.post('/api/auth/logout', {});
  state.user = null;
  state.permissions = new Set();
  location.hash = '#/login';
}

/* --------------------------------------------------------------- routing */
export function parseHash(hash = location.hash) {
  const raw = String(hash || '').replace(/^#/, '') || '/';
  const [path, search] = raw.split('?');
  const segments = path.split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const query = Object.fromEntries(new URLSearchParams(search || ''));
  return { path: `/${segments.join('/')}`, segments, query };
}

export function go(path, query) {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    usp.set(key, String(value));
  }
  const qs = usp.toString();
  const next = `#${path}${qs ? `?${qs}` : ''}`;
  if (location.hash === next) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = next;
}

export const back = () => history.length > 1 && history.back();

/* ------------------------------------------------------ cross-view jumps */
export const openFilter = (ref, query) => go(`/filters/${encodeURIComponent(ref)}`, query);
export const openTooling = (ref, query) => go(`/tooling/${encodeURIComponent(ref)}`, query);
export const openLocation = (id, query) => go(`/locations/${id}`, query);

export async function statusCounts() {
  try {
    const r = await api.get('/api/stats/counts');
    state.counts = r.counts || {};
  } catch {
    /* keep the previous numbers */
  }
  return state.counts;
}

/* --------------------------------------------------------------- actions */
/** Scan and jump straight to whatever was scanned. */
export async function scanAndGo({ title } = {}) {
  const scanned = await openScanner({ title });
  if (!scanned) return null;
  let target;
  try {
    target = await resolveScan(api, scanned.code);
  } catch (err) {
    toast(err.message, 'error', 7000);
    return { error: err };
  }
  if (target.kind === 'tooling') openTooling(target.code);
  else if (target.kind === 'location') openLocation(target.id);
  else if (target.kind === 'filter') openFilter(target.code);
  else if (target.kind === 'order') go(`/production/${target.id}`);
  return target;
}

/** Scan a tool label and go straight to the movement dialog (the floor shortcut). */
export async function scanMove() {
  const scanned = await openScanner({ title: 'scan the tool you are moving' });
  if (!scanned) return null;
  const code = String(scanned.code || '').replace(/^SP:T:/, '');
  try {
    const rec = await api.get(`/api/tooling/code/${encodeURIComponent(code)}`);
    const tool = rec.tool || rec;
    return await moveTool(tool, { mode: tool.status === 'IN_USE' ? 'RETURN' : 'TAKE' });
  } catch (err) {
    toast(err.message, 'error', 8000);
    return null;
  }
}

/** TAKE / RETURN / MOVE dialog for a tool. `mode` preselects the action. */
export async function moveTool(tool, { mode = 'MOVE', locations } = {}) {
  const actions = [
    { value: 'TAKE', label: mode === 'TAKE' ? 'TAKE (I am removing it)' : 'Take - I am removing it' },
    { value: 'RETURN', label: 'Return - put it back on a shelf' },
    { value: 'MOVE', label: 'Move - change its shelf' },
  ];
  const fields = [
    { key: 'action', label: 'what are you doing', type: 'select', options: actions, required: true },
    { key: 'location', label: 'destination shelf / box code', type: 'text', placeholder: 'scan or type, e.g. TR-R02-RK05-S03', help: 'leave empty when you are taking it to a machine', wide: true },
    { key: 'external', label: 'or where it is now', type: 'text', placeholder: 'Line 2, press 3, QC bench…' },
    { key: 'qty', label: 'quantity', type: 'number', min: 1, initial: 1 },
    { key: 'reason', label: 'reason', type: 'select', options: ['PRODUCTION', 'MAINTENANCE', 'INSPECTION', 'CHANGE_SHELF', 'SCRAP', 'OTHER'], initial: 'PRODUCTION' },
    { key: 'production_order_id', label: 'production order id', type: 'number', min: 1, help: 'optional - links the movement to the order' },
    { key: 'note', label: 'note', type: 'text', placeholder: 'batch changeover, for the audit trail', wide: true },
  ];
  const values = await formDialog({
    title: `Movement - ${tool.tooling_id}`,
    subtitle: `${tool.name}${locations && locations.length ? ` · currently ${tool.location_code || tool.external_location || 'unassigned'}` : ''}`,
    fields,
    initial: { action: mode, qty: 1, location: mode === 'RETURN' ? tool.location_code || '' : '' },
    submitLabel: 'record movement',
  });
  if (!values) return null;
  const payload = {
    action: values.action,
    location: values.location || null,
    external: values.external || null,
    qty: Number(values.qty) || 1,
    reason: values.reason || null,
    note: values.note || null,
    production_order_id: values.production_order_id ? Number(values.production_order_id) : null,
  };
  if (!payload.location && payload.action !== 'TAKE' && !payload.external) {
    toast('say where it goes: scan the shelf label or write where it is now', 'error');
    return moveTool(tool, { mode: values.action, locations });
  }
  const dialog = modal({ title: 'recording…', body: spinner('writing the movement + history row'), actions: null });
  try {
    const out = await api.post(`/api/tooling/${tool.id || tool}/move`, payload);
    toast(`${out.movement.movement_type} recorded${out.movement.to_location_code ? ` → ${out.movement.to_location_code}` : ''}`, 'ok');
    dialog.close();
    return out;
  } catch (err) {
    dialog.close();
    const again = await formDialog({
      title: 'that movement was refused',
      subtitle: err.message,
      fields,
      initial: values,
      submitLabel: 'try again',
    });
    if (again) return moveTool(tool, { mode: again.action, locations });
    return null;
  }
}

/** Condition / damage report with photos, straight from the tool card. */
export async function reportDamage(tool, metaInfo = meta.data) {
  const fields = [
    { key: 'damage_type', label: 'damage type', type: 'select', required: true, options: (metaInfo?.damage_types || []).map((d) => ({ value: d, label: d.replace(/_/g, ' ') })) },
    { key: 'severity', label: 'severity', type: 'select', options: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], initial: 'MEDIUM' },
    { key: 'description', label: 'what is wrong', type: 'textarea', required: true, wide: true, placeholder: 'crack on the left forming face, 30 mm, part is still usable with a witness mark' },
    { key: 'location_note', label: 'where it was found', type: 'text', placeholder: 'press 3, after batch 44' },
    { key: 'create_repair_request', label: 'open a maintenance job for it', type: 'checkbox', initial: true },
    { key: 'quarantine', label: 'set the tool to DAMAGED so production is blocked', type: 'checkbox', initial: true },
    { key: 'photos', label: 'photos (before)', type: 'photo', camera: true, wide: true, help: 'the camera opens on phones' },
  ];
  const values = await formDialog({ title: `Damage report - ${tool.tooling_id}`, subtitle: tool.name, fields, submitLabel: 'report it' });
  if (!values) return null;
  const fd = new FormData();
  fd.append('damage_type', values.damage_type);
  fd.append('severity', values.severity || 'MEDIUM');
  fd.append('description', values.description);
  fd.append('location_note', values.location_note || '');
  fd.append('tooling_item_id', String(tool.id));
  fd.append('create_repair_request', values.create_repair_request ? 'true' : 'false');
  fd.append('quarantine', values.quarantine ? 'true' : 'false');
  (values.photos || []).forEach((file) => fd.append('photos', file));
  try {
    const out = await api.upload('/api/maintenance/damage', fd);
    toast(`damage report ${out.report_no} recorded${out.maintenance_id ? ` · maintenance job #${out.maintenance_id} opened` : ''}${out.tooling_status && out.tooling_status !== tool.status ? ` · tool is now ${out.tooling_status.toLowerCase()}` : ''}`, 'ok', 7000);
    statusCounts();
    return out;
  } catch (err) {
    toast(err.message, 'error', 8000);
    return null;
  }
}

/** Pick a filter from a searchable dialog (used by orders, requests, compatibility). */
export function pickFilter({ title = 'which filter?' } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'search', placeholder: 'number, OEM, name, vehicle…', autocapitalize: 'characters' });
    const list = h('div', { class: 'list' }, notice('info', 'type at least two characters'));
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) return;
      timer = setTimeout(async () => {
        list.replaceChildren(spinner('searching…'));
        try {
          const r = await api.get(`/api/filters?${new URLSearchParams({ q, page_size: 20 }).toString()}`);
          list.replaceChildren(
            ...(r.items.length
              ? r.items.map((f) =>
                  h(
                    'div',
                    { class: 'list-item selectable', onclick: () => (dialog.close(), resolve(f)) },
                    h('div', { class: 'grow' }, h('b', { class: 'code' }, f.internal_number), h('div', { class: 'small muted' }, f.name || ''), h('div', { class: 'tiny muted' }, `${f.type_name || ''} ${f.brand_name ? `· ${f.brand_name}` : ''} · ${f.tooling_count ?? 0} tool(s) · ${f.application_count ?? 0} vehicle(s)`)),
                    statusBadgeFor(f.status),
                  ),
                )
              : [notice('warn', `nothing matched "${q}"`)]),
          );
        } catch (err) {
          list.replaceChildren(errorBox(err));
        }
      }, 240);
    });
    const dialog = modal({
      title,
      body: h('div', null, input, h('div', { style: 'margin-top:10px' }, list)),
      actions: h('div', { class: 'btn-row end' }, h('button', { class: 'btn ghost', onclick: () => (dialog.close(), resolve(null)) }, 'cancel')),
      onClose: () => resolve(null),
      wide: true,
    });
    setTimeout(() => input.focus(), 60);
  });
}

function statusBadgeFor(code) {
  if (!code) return null;
  const known = (meta.data?.tooling_statuses || []).some((s) => s.code === code);
  if (known) {
    const info = statusInfo(code);
    return h('span', { class: 'badge status', style: `--badge-color:${info.color}` }, `${info.dot} ${info.label}`);
  }
  return h('span', { class: 'badge' }, code);
}

/** Pick tooling (for reservations, sets, families, order tool lists). */
export function pickTooling({ title = 'which tool?', filterId = null } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'search', placeholder: 'tooling id, name, size…', autocapitalize: 'characters' });
    const list = h('div', { class: 'list' }, notice('info', 'type at least two characters, or scan'));
    let timer = null;
    const search = async (q) => {
      list.replaceChildren(spinner('searching…'));
      try {
        const params = new URLSearchParams({ q, page_size: 20 });
        if (filterId) params.set('compatible_with_filter', String(filterId));
        const r = await api.get(`/api/tooling?${params.toString()}`);
        list.replaceChildren(
          ...(r.items.length
            ? r.items.map((t) =>
                h(
                  'div',
                  { class: 'list-item selectable', onclick: () => (dialog.close(), resolve(t)) },
                  h('div', { class: 'grow' }, h('b', { class: 'code' }, t.tooling_id), h('div', { class: 'small' }, t.name), h('div', { class: 'tiny muted' }, `${t.type_name} · ${t.location_code || t.external_location || 'no location'}`)),
                  statusBadgeFor(t.status),
                ),
              )
            : [notice('warn', `nothing matched "${q}"`)]),
        );
      } catch (err) {
        list.replaceChildren(errorBox(err));
      }
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) return;
      timer = setTimeout(() => search(q), 240);
    });
    const scanBtn = h('button', {
      class: 'btn ghost',
      onclick: async () => {
        const scanned = await openScanner({ title: 'scan the tool label' });
        if (!scanned) return;
        try {
          const found = await resolveScan(api, scanned.code);
          if (found.kind !== 'tooling') return toast('that code is not a tool label', 'error');
          const r = await api.get(`/api/tooling/code/${encodeURIComponent(found.code)}`);
          dialog.close();
          resolve(r.tool || r);
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    }, '📷 scan');
    const dialog = modal({
      title,
      body: h('div', null, input, h('div', { class: 'btn-row', style: 'margin:8px 0' }, scanBtn), h('div', { class: 'list' }, list)),
      actions: h('div', { class: 'btn-row end' }, h('button', { class: 'btn ghost', onclick: () => (dialog.close(), resolve(null)) }, 'cancel')),
      onClose: () => resolve(null),
      wide: true,
    });
    setTimeout(() => input.focus(), 60);
  });
}

/** Download helper used by every export button. */
export async function downloadWith(url, hint) {
  try {
    toast('preparing the file…');
    await download(url, hint);
  } catch (err) {
    toast(err.message, 'error', 8000);
  }
}

export { statusInfo };
