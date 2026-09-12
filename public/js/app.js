/** App shell + router + the four floor screens (dashboard, search, scan, login). */
import { api, meta, loadMeta, qs, statusInfo, download } from './api.js';
import { h, render, card, button, badge, statusBadge, grid, statTile, table, kv, empty, spinner, errorBox, notice, tabs, barChart, meter, toast, modal, form, formDialog, when, mm, UnitToggle, photoGrid } from './ui.js';
import { openScanner, decodeImageFile } from './scan.js';
import { state, NAV, BIG_BUTTONS, can, bootstrap, login, logout, parseHash, go, openFilter, openTooling, openLocation, statusCounts, scanAndGo, scanMove } from './store.js';
import { catalogViews } from './views-catalog.js';
import { warehouseViews } from './views-warehouse.js';
import { opsViews } from './views-ops.js';
import { adminViews } from './views-admin.js';

const ROUTES = {
  '/': { view: DashboardView, nav: 'dashboard', title: 'dashboard' },
  '/login': { view: LoginView, nav: null, title: 'sign in', public: true },
  '/search': { view: SearchView, nav: 'search', title: 'search' },
  '/scan': { view: ScanView, nav: 'scan', title: 'scan' },
};
for (const [path, def] of Object.entries({ ...catalogViews, ...warehouseViews, ...opsViews, ...adminViews })) {
  ROUTES[path] = def;
}

const tabKey = (href) => (href === '#/' ? 'dashboard' : String(href).replace('#/', ''));

/* ------------------------------------------------------------------ shell */
function topbar() {
  const user = state.user;
  const right = h('div', { class: 'who' });
  if (!user) {
    right.appendChild(h('a', { href: '#/login' }, 'sign in'));
  } else {
    right.appendChild(h('b', null, user.full_name || user.username));
    right.appendChild(h('span', null, user.role_name || user.role));
    const links = h('div', null);
    links.appendChild(h('a', { class: 'tiny', href: '#/account' }, 'account'));
    links.appendChild(document.createTextNode(' · '));
    const out = h('a', { class: 'tiny', href: '#' }, 'sign out');
    out.addEventListener('click', async (e) => {
      e.preventDefault();
      await logout();
      toast('signed out');
    });
    links.appendChild(out);
    right.appendChild(links);
  }
  const bell = h('button', { class: 'btn small ghost', title: 'alerts' }, `🔔${state.counts.unread_notifications ? ` ${state.counts.unread_notifications}` : ''}`);
  bell.addEventListener('click', () => go('/notifications'));
  return h(
    'header',
    { class: 'topbar' },
    h('a', { class: 'brand', href: '#/', title: 'dashboard' }, h('span', { class: 'logo' }, 'SP'), h('span', null, meta.data?.app?.name || 'Sistemi Purepower')),
    h('span', { class: 'spacer' }),
    bell,
    right,
  );
}

function navNode(active) {
  const box = h('aside', { class: 'sidenav' });
  for (const section of NAV) {
    box.appendChild(h('h4', null, section.group));
    for (const item of section.items) {
      if (item.perm && !can(item.perm)) continue; // hidden when the API would refuse anyway
      const a = h('a', { href: item.href });
      if (item.key === active) a.className = 'on';
      a.appendChild(h('span', null, item.icon));
      a.appendChild(h('span', null, item.label));
      const count = item.countKey ? Number(state.counts[item.countKey] || 0) : 0;
      if (count) a.appendChild(h('span', { class: 'count' }, String(count)));
      box.appendChild(a);
    }
  }
  return box;
}

function barNode(active) {
  const nav = h('nav', { class: 'tabbar', 'aria-label': 'main' });
  for (const item of BIG_BUTTONS) {
    const a = h('a', { href: item.href });
    if (tabKey(item.href) === active) a.className = 'on';
    a.appendChild(h('span', null, item.icon));
    a.appendChild(document.createTextNode(item.label));
    nav.appendChild(a);
  }
  const more = h('a', { href: '#/menu' });
  more.appendChild(h('span', null, '⋯'));
  more.appendChild(document.createTextNode('more'));
  more.addEventListener('click', (e) => {
    e.preventDefault();
    openMenu();
  });
  nav.appendChild(more);
  return nav;
}

function openMenu() {
  const dialog = modal({
    title: 'everything else',
    wide: true,
    body: (() => {
      const box = h('div', { class: 'btn-grid' });
      for (const section of NAV) {
        for (const item of section.items) {
          if (item.href === '#/' || BIG_BUTTONS.some((b) => b.href === item.href)) continue;
          if (item.perm && !can(item.perm)) continue;
          box.appendChild(h('a', { class: 'btn ghost big', href: item.href, onclick: () => dialog.close() }, `${item.icon} ${item.label}`));
        }
      }
      return box;
    })(),
    actions: h('div', { class: 'btn-row end' }, button('close', { kind: 'ghost', onClick: () => dialog.close() })),
  });
}

function shellMount() {
  const app = h('div', { class: 'app' });
  if (!navigator.onLine) app.appendChild(h('div', { class: 'offline' }, 'offline — the data on screen may be stale, changes will not be saved'));
  app.appendChild(topbar());
  app.appendChild(h('div', { class: 'shell' }, navNode('dashboard'), h('main', { class: 'main', id: 'main', tabindex: '-1' })));
  app.appendChild(barNode('dashboard'));
  return app;
}

let appEl = null;
let mainEl = null;

function repaintChrome(active) {
  if (!appEl) return;
  const side = appEl.querySelector('.sidenav');
  if (side) side.replaceWith(navNode(active));
  const bar = appEl.querySelector('.tabbar');
  if (bar) bar.replaceWith(barNode(active));
}

/* ------------------------------------------------------------- dashboard */
async function DashboardView() {
  const [dash, charts, alerts] = await Promise.all([
    api.get('/api/stats/dashboard'),
    api.get('/api/stats/dashboard/charts?days=30').catch(() => ({ movements_per_day: [], shelf_fill: [], top_filters: [] })),
    api.get('/api/stats/alerts?limit=12').catch(() => ({ items: [] })),
  ]);
  const t = dash.tiles;
  const statusCount = (code) => (dash.tooling_by_status.find((s) => s.status === code)?.count ?? 0);
  const tiles = [
    statTile({ label: 'filters', value: t.filters.active, sub: `${t.filters.total} total`, href: '#/filters', icon: '🧫' }),
    statTile({ label: 'tooling items', value: t.tooling.total, sub: `${t.tooling.pieces} physical pieces`, href: '#/tooling', icon: '🧿' }),
    statTile({ label: 'out of the tool room', value: t.out_now, sub: 'awaiting return', tone: t.out_now > 0 ? 'warn' : 'ok', href: '#/movements?tab=out', icon: '🚚' }),
    statTile({ label: 'blocked orders', value: t.blocked_orders, sub: 'tooling not ready', tone: t.blocked_orders > 0 ? 'danger' : 'ok', href: '#/production?blocked=1', icon: '⛔' }),
    statTile({ label: 'open damage reports', value: t.open_damage, tone: t.open_damage > 0 ? 'danger' : 'ok', href: '#/maintenance?tab=damage', icon: '🩹' }),
    statTile({ label: 'maintenance due (14d)', value: t.maintenance_due, sub: `${t.maintenance_overdue} overdue`, tone: t.maintenance_overdue > 0 ? 'danger' : 'warn', href: '#/maintenance', icon: '🛠' }),
    statTile({ label: 'cycle limit warnings', value: t.cycle_warnings, tone: t.cycle_warnings ? 'warn' : '', href: '#/tooling', icon: '♻️' }),
    statTile({ label: 'missing tools', value: t.missing, tone: t.missing ? 'danger' : 'ok', href: '#/tooling?status=MISSING', icon: '❓' }),
    statTile({ label: 'tools with no shelf', value: t.unassigned_locations, sub: 'need a location', tone: t.unassigned_locations ? 'warn' : 'ok', href: '#/inventory?tab=unassigned', icon: '🗄' }),
    statTile({ label: 'low stock items', value: t.low_stock, tone: t.low_stock ? 'warn' : 'ok', href: '#/inventory?tab=stock', icon: '📦' }),
    statTile({ label: 'shelf capacity', value: `${t.locations.occupied}/${t.locations.capacity}`, sub: `${t.locations.used} of ${t.locations.total} places hold tools`, href: '#/locations', icon: '📊' }),
    statTile({ label: 'sets complete', value: `${t.sets.complete}/${t.sets.total}`, tone: t.sets.complete === t.sets.total ? 'ok' : 'warn', href: '#/tooling?tab=sets', icon: '🧩' }),
  ];
  const fill = t.locations.capacity ? Math.round((t.locations.occupied / t.locations.capacity) * 100) : 0;
  const ready = t.blocked_orders === 0;

  const banner = h(
    'div',
    { class: `banner ${ready ? 'ready' : 'blocked'}` },
    h('div', { style: 'font-size:26px' }, ready ? '✅' : '⚠️'),
    h(
      'div',
      null,
      h('div', { class: 'big' }, ready ? 'production can start' : `${t.blocked_orders} order(s) blocked by tooling`),
      h(
        'div',
        { class: 'why' },
        ready
          ? `${t.orders.running} running · ${t.orders.planned} planned · ${statusCount('AVAILABLE')} tools available now`
          : 'open the order to see exactly which tool is missing, damaged or in maintenance',
      ),
    ),
    h('span', { class: 'grow' }),
    button(ready ? 'orders' : 'resolve', { href: '#/production', kind: ready ? 'ghost' : 'danger' }),
  );

  const alertList = h('div', { class: 'list' });
  if (!alerts.items.length) alertList.appendChild(empty('no alerts', 'maintenance, damage and blocked orders land here'));
  for (const a of alerts.items.slice(0, 8)) {
    const row = h('div', { class: 'list-item' });
    row.appendChild(h('span', { style: 'font-size:18px' }, a.severity === 'critical' ? '🔴' : a.severity === 'warning' ? '🟠' : '🔵'));
    row.appendChild(h('div', { class: 'grow' }, h('b', null, a.title), h('div', { class: 'small muted' }, a.message)));
    row.appendChild(h('span', { class: 'tiny muted nowrap' }, when(a.created_at)));
    if (a.link) row.addEventListener('click', () => (location.hash = a.link));
    alertList.appendChild(row);
  }

  const timeline = h('div', { class: 'timeline' });
  for (const a of dash.recent_activity.slice(0, 8)) {
    timeline.appendChild(
      h(
        'div',
        { class: 'tl' },
        h('span', { class: 'dot' }),
        h('div', null, h('div', null, a.summary || a.action), h('span', { class: 'when' }, `${a.username} · ${when(a.created_at)}`)),
      ),
    );
  }

  return h(
    'div',
    null,
    h(
      'div',
      { class: 'section-title' },
      h('h1', null, `hello${state.user ? ` ${state.user.full_name?.split(' ')[0] || state.user.username}` : ''}`),
      h('span', { class: 'sub' }, `refreshed ${when(dash.generated_at)} · ${dash.took_ms} ms`),
      h('span', { class: 'grow' }),
      button('🔎 search', { href: '#/search', kind: 'ghost' }),
      button('📷 scan', { kind: 'primary', onClick: () => scanAndGo() }),
    ),
    banner,
    h('div', { class: 'tiles' }, tiles),
    grid(
      2,
      card(
        { title: 'tooling by status', subtitle: 'the whole register, live' },
        barChart(dash.tooling_by_status.map((s) => ({ label: statusInfo(s.status).label, value: s.count, color: statusInfo(s.status).color, icon: statusInfo(s.status).dot }))),
      ),
      card(
        { title: 'shelf fill', subtitle: `${fill}% of the planned capacity holds something` },
        meter(t.locations.occupied, t.locations.capacity || 1, `${t.locations.occupied} of ${t.locations.capacity} places filled`),
        h('div', { style: 'height:10px' }),
        table(
          [
            { label: 'shelf', render: (r) => h('span', { class: 'code' }, r.full_code || '-') },
            { label: 'used', render: (r) => `${r.occupancy_items ?? 0}/${r.capacity_items ?? 0}` },
            { label: 'fill', render: (r) => meter(Number(r.occupancy_items || 0), Number(r.capacity_items || 1), `${r.fill_pct}%`) },
          ],
          (charts.shelf_fill || []).filter((s) => Number(s.fill_pct) > 0).slice(0, 8),
        ),
      ),
    ),
    grid(
      2,
      card(
        { title: 'alerts', subtitle: `${alerts.items.length} to look at`, actions: button('all', { kind: 'ghost', small: true, onClick: () => go('/notifications') }) },
        alertList,
      ),
      card(
        { title: 'movements per day', subtitle: 'last 14 days' },
        barChart((charts.movements_per_day || []).slice(-14).map((d) => ({ label: String(d.day).slice(5), value: Number(d.total) }))),
        h('div', { style: 'height:10px' }),
        kv([
          ['pieces produced (30d)', t.batches_30d.good],
          ['scrap (30d)', t.batches_30d.scrap],
          ['orders completed (7d)', t.orders.completed_week],
          ['open tooling requests', dash.requests_by_status.reduce((a, r) => a + (r.status === 'PENDING' || r.status === 'APPROVED' || r.status === 'IN_PRODUCTION' ? r.count : 0), 0)],
        ]),
      ),
      card(
        { title: 'latest movements', actions: button('history', { kind: 'ghost', small: true, onClick: () => go('/movements') }) },
        table(
          [
            { label: 'when', render: (m) => h('span', { class: 'nowrap' }, when(m.created_at)) },
            { label: 'tool', render: (m) => h('a', { class: 'code', href: `#/tooling/${encodeURIComponent(m.tooling_id)}` }, m.tooling_id) },
            { label: 'action', render: (m) => badge(m.movement_type, m.movement_type === 'TAKE' ? 'warn' : m.movement_type === 'RETURN' ? 'ok' : '') },
            { label: 'to', render: (m) => m.to_location_code || m.note || '-' },
            { label: 'by', key: 'username' },
          ],
          dash.recent_movements,
        ),
      ),
      card({ title: 'what changed', actions: button('audit log', { kind: 'ghost', small: true, onClick: () => go('/audit') }) }, timeline),
      card(
        { title: 'filters that need the most tooling', subtitle: 'check these first when planning capacity' },
        table(
          [
            { label: 'filter', render: (r) => h('a', { class: 'code', href: `#/filters/${encodeURIComponent(r.internal_number)}` }, r.internal_number) },
            { label: 'name', key: 'name' },
            { label: 'tools', key: 'tooling_count' },
          ],
          (charts.top_filters || []).slice(0, 8),
          { onRowOpen: (r) => openFilter(r.internal_number) },
        ),
      ),
    ),
  );
}

/* ------------------------------------------------------------------ login */
async function LoginView() {
  const f = form([
    { key: 'username', label: 'username', required: true, placeholder: 'admin', autocomplete: 'username' },
    { key: 'password', label: 'password', type: 'text', required: true, placeholder: '••••••••', autocomplete: 'current-password' },
  ]);
  const btn = button('sign in', { kind: 'primary big' });
  const submit = async () => {
    f.error(null);
    if (!f.validate()) return;
    const values = f.values();
    btn.disabled = true;
    btn.textContent = 'signing in…';
    try {
      const out = await login(values.username, values.password);
      toast(`welcome ${out.user.full_name || out.user.username}`, 'ok');
      if (out.user.must_change_password) go('/account', { change: 1, first: 1 });
      else if (location.hash.startsWith('#/login')) location.hash = '#/';
      else window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (err) {
      f.error(err.message);
      btn.disabled = false;
      btn.textContent = 'sign in';
    }
  };
  btn.addEventListener('click', submit);
  f.node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });
  const chips = h('div', { class: 'chips', style: 'margin-top:10px' });
  for (const role of ['admin', 'engineering', 'production', 'warehouse', 'quality', 'sales']) {
    chips.appendChild(h('button', { class: 'chip', type: 'button', onclick: () => f.setValues({ username: role }) }, role));
  }
  return h(
    'div',
    { style: 'max-width:520px;margin:5vh auto' },
    card(
      { title: meta.data?.app?.name || 'Sistemi Purepower', subtitle: 'tooling & warehouse register — sign in' },
      f.node,
      h('div', { style: 'margin-top:12px' }, btn),
      chips,
      notice('info', 'every demo account uses the same password format — see README.md. Sessions are httpOnly cookies with CSRF protection.'),
    ),
  );
}

/* ------------------------------------------------------------------ search */
function resultRow({ icon, img, title, badgeText, line1, line2, trailing, onOpen }) {
  const row = h('div', { class: 'result', role: 'button', tabindex: '0' });
  if (img) row.appendChild(h('img', { src: img, alt: '', loading: 'lazy' }));
  else row.appendChild(h('span', { style: 'font-size:22px' }, icon || '•'));
  const body = h('div', { class: 'grow' });
  const head = h('b', { class: 'code' }, title);
  body.appendChild(head);
  if (badgeText) {
    const b = h('span', { class: 'badge tiny', style: 'margin-left:6px' }, badgeText);
    head.appendChild(b);
  }
  if (line1) body.appendChild(h('div', { class: 'small' }, line1));
  if (line2) body.appendChild(h('div', { class: 'tiny muted' }, line2));
  row.appendChild(body);
  if (trailing) row.appendChild(trailing);
  const open = () => onOpen?.();
  row.addEventListener('click', open);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
  return row;
}

async function SearchView(mount, route) {
  const initial = route.query.q || '';
  let unit = route.query.unit || localStorage.getItem('sp.unit') || 'mm';
  let tolerance = route.query.tolerance || '';
  const input = h('input', { type: 'search', placeholder: 'filter number, OEM, vehicle, tooling id, 82 mm, TR-R02-RK05, QR text…', value: initial, autocapitalize: 'characters', 'aria-label': 'search everything' });
  const suggest = h('ul', { class: 'suggest', hidden: true });
  const results = h('div', null, initial ? spinner('searching…') : empty('type to search everything', 'one box answers filters, tooling, locations, vehicles, dimensions, orders, damage reports and people'));
  const chips = h('div', { class: 'chips' });
  for (const [label, action] of [
    ['🔁 duplicate check', () => go('/tooling', { tab: 'duplicates' })],
    ['🤔 do we have this tool?', () => go('/tooling', { tab: 'check' })],
    ['📐 dimension search', () => go('/tooling', { tab: 'dimensions' })],
    ['📷 scan a label', () => scanAndGo()],
  ]) {
    chips.appendChild(h('button', { class: 'chip', type: 'button', onclick: action }, label));
  }
  const tolInput = h('input', { type: 'number', min: 0, max: 50, step: '0.5', value: tolerance, placeholder: '2' });
  tolInput.addEventListener('change', () => {
    tolerance = tolInput.value;
    if (input.value.trim()) run(input.value.trim());
  });

  function groupsOf(out) {
    const g = out.groups || {};
    const blocks = [];
    const push = (title, items, fn) => {
      if (!items?.length) return;
      const box = h('div', { class: 'results' });
      items.forEach((item, i) => box.appendChild(fn(item, i)));
      blocks.push(h('div', null, h('div', { class: 'group-title' }, title, h('span', { class: 'count' }, String(items.length))), box));
    };
    push('🎯 exact code match', g.scan?.items, (i) => resultRow({ icon: '🎯', title: i.code, line1: `${i.kind}${i.name ? ` · ${i.name}` : ''}`, trailing: h('span', { class: 'btn small primary' }, 'open'), onOpen: () => (i.route ? (location.hash = i.route) : null) }));
    push('🧫 filters', g.filters?.items, (f) =>
      resultRow({
        img: null,
        icon: f.icon || '🧫',
        title: f.internal_number,
        badgeText: f.product_number,
        line1: f.name,
        line2: [f.filter_type, f.brand, f.length_mm ? `${mm(f.length_mm)}×${mm(f.width_mm)}×${mm(f.height_mm)} mm` : null, `${f.tooling_count ?? 0} tool(s)`, `${f.vehicle_count ?? 0} vehicle(s)`].filter(Boolean).join(' · '),
        trailing: badge(f.status || '', f.status === 'ACTIVE' ? 'ok' : ''),
        onOpen: () => openFilter(f.internal_number),
      }),
    );
    push('🧿 tooling', g.tooling?.items, (t) =>
      resultRow({
        img: t.primary_image_id ? `/api/files/images/${t.primary_image_id}` : null,
        icon: t.icon || '🧿',
        title: t.tooling_id,
        badgeText: t.type_code,
        line1: t.name,
        line2: [t.type_name, t.filter_number ? `main filter ${t.filter_number}` : null, t.location_code || t.external_location || 'no shelf assigned'].filter(Boolean).join(' · '),
        trailing: statusBadge(t.status),
        onOpen: () => openTooling(t.tooling_id),
      }),
    );
    push('🗄 storage locations', g.locations?.items, (l) =>
      resultRow({
        icon: '🗄',
        title: l.full_code,
        line1: l.label_path || l.label || l.kind,
        line2: `${l.occupancy_items ?? 0} item(s)${l.capacity_items ? ` of ${l.capacity_items} places` : ''} · ${l.warehouse_name || ''}`,
        trailing: l.capacity_items ? meter(Number(l.occupancy_items || 0), Number(l.capacity_items), `${l.occupancy_items}/${l.capacity_items}`) : null,
        onOpen: () => openLocation(l.id),
      }),
    );
    push('🚗 vehicle applications', g.vehicles?.items, (v) =>
      resultRow({
        icon: '🚗',
        title: `${v.manufacturer} ${v.model}`,
        line1: [v.generation, v.year_from ? `${v.year_from}–${v.year_to || ''}` : null, v.engine, v.engine_code, v.fuel].filter(Boolean).join(' · '),
        line2: `${v.filter_count} filter(s)${v.filters ? ` · ${v.filters}` : ''}`,
        onOpen: () => go('/filters', { vehicle: `${v.manufacturer} ${v.model}` }),
      }),
    );
    const dims = g.dimensions;
    push('📐 dimension matches', dims?.items, (d) =>
      d._group === 'tooling'
        ? resultRow({ img: null, icon: '🧿', title: d.tooling_id, line1: d.name, line2: [d.type_name, [d.overall_length_mm, d.overall_width_mm, d.overall_height_mm].filter((v) => v !== null && v !== undefined).map((v) => mm(v)).join(' × '), d.location_code ? `at ${d.location_code}` : null].filter(Boolean).join(' · '), trailing: statusBadge(d.status), onOpen: () => openTooling(d.tooling_id) })
        : resultRow({ icon: '🧫', title: d.internal_number, line1: d.name, line2: [d.filter_type, [d.length_mm, d.width_mm, d.height_mm].filter((v) => v !== null && v !== undefined).map((v) => mm(v)).join(' × ')].filter(Boolean).join(' · '), trailing: badge(d.match_pct ? `${d.match_pct}% match` : 'size', 'ok'), onOpen: () => openFilter(d.internal_number) }),
    );
    push('🏭 production orders', g.orders?.items, (o) =>
      resultRow({
        icon: '🏭',
        title: o.po_number,
        line1: `${o.filter_number} · ${o.quantity_ordered} pcs · ${o.line || ''} ${o.machine || ''}`.trim(),
        line2: o.blocking_reason || 'tooling ready',
        trailing: badge(o.availability_status === 'READY' ? 'READY' : 'BLOCKED', o.availability_status === 'READY' ? 'ok' : 'danger'),
        onOpen: () => go(`/production/${o.id}`),
      }),
    );
    push('🩹 damage reports', g.damage?.items, (d) =>
      resultRow({ icon: '🩹', title: d.report_no, line1: `${d.tooling_id} · ${d.damage_type}`, line2: d.description, trailing: badge(d.severity, ['CRITICAL', 'HIGH'].includes(d.severity) ? 'danger' : 'warn'), onOpen: () => go('/maintenance', { tab: 'damage' }) }),
    );
    push('👷 people', g.people?.items, (p) => resultRow({ icon: '👷', title: p.full_name, line1: `@${p.username} · ${p.role_name || p.role}`, line2: [p.department, p.actions_7d ? `${p.actions_7d} logged actions in 7 days` : null].filter(Boolean).join(' · ') }));
    if (dims?.pattern) blocks.push(h('p', { class: 'tiny muted' }, `looking for ${dims.pattern}`));
    return blocks;
  }

  async function run(q) {
    if (!q) return;
    history.replaceState(null, '', `#/search${qs({ q, unit, tolerance: tolerance || undefined })}`);
    results.replaceChildren(spinner('searching everything…'));
    try {
      const out = await api.get(`/api/search${qs({ q, unit, tolerance: tolerance || undefined })}`);
      const blocks = groupsOf(out);
      const head = h('div', { class: 'section-title' }, h('h2', null, `${out.count} match(es) for “${out.query}”`), h('span', { class: 'sub tiny' }, `${out.took_ms} ms`), h('span', { class: 'grow' }), UnitToggle((next) => ((unit = next), run(input.value.trim()))));
      results.replaceChildren(h('div', null, head, blocks.length ? blocks : notice('warn', `nothing matched “${q}”. try a shorter number, or the OEM/catalogue code.`)));
    } catch (err) {
      results.replaceChildren(errorBox(err));
    }
  }

  let timer = null;
  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearTimeout(timer);
    if (q.length < 2) {
      suggest.setAttribute('hidden', '');
      return;
    }
    timer = setTimeout(async () => {
      try {
        const out = await api.get(`/api/search/suggest${qs({ q, limit: 10 })}`);
        if (!out.items.length) {
          suggest.setAttribute('hidden', '');
          return;
        }
        const kids = out.items.map((item) => {
          const li = h('li', null, h('span', { class: 'kind' }, item.kind), h('span', { class: 'code' }, item.code), h('span', { class: 'muted small' }, item.label));
          if (item.badge) li.appendChild(statusBadge(item.badge));
          li.addEventListener('mousedown', (e) => {
            e.preventDefault();
            suggest.setAttribute('hidden', '');
            if (item.kind === 'filter') openFilter(item.code);
            else if (item.kind === 'tooling') openTooling(item.code);
            else if (item.kind === 'location') openLocation(item.id);
            else if (item.kind === 'order') go(`/production/${item.id}`);
            else if (item.kind === 'xref') openFilter(item.code);
            else {
              input.value = item.code;
              run(item.code);
            }
          });
          return li;
        });
        const enter = h('li', { class: 'muted tiny' }, '↵ enter searches everything');
        enter.addEventListener('mousedown', (e) => {
          e.preventDefault();
          suggest.setAttribute('hidden', '');
          run(input.value.trim());
        });
        suggest.replaceChildren(...kids, enter);
        suggest.removeAttribute('hidden');
      } catch {
        suggest.setAttribute('hidden', '');
      }
    }, 200);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      suggest.setAttribute('hidden', '');
      run(input.value.trim());
    }
  });

  const filters = h('div', { class: 'filters', style: 'margin-top:10px' });
  filters.appendChild(h('div', { class: 'field' }, h('label', null, 'size tolerance (mm)'), tolInput));
  filters.appendChild(h('div', { class: 'field' }, h('label', null, 'dimension unit'), UnitToggle((next) => ((unit = next), run(input.value.trim())))));
  filters.appendChild(h('div', { class: 'field' }, h('label', null, 'shortcuts'), chips));

  const node = h(
    'div',
    null,
    h('div', { class: 'section-title' }, h('h1', null, 'search everything'), h('span', { class: 'sub' }, 'one box, every entity · debounced · also accepts scanned QR/barcode text')),
    card({ dense: true }, h('div', { style: 'position:relative' }, input, suggest), filters),
    results,
  );
  if (initial) run(initial);
  else setTimeout(() => input.focus(), 80);
  return node;
}

/* -------------------------------------------------------------------- scan */
async function ScanView() {
  const status = h('div', null);
  const manual = h('input', { type: 'text', placeholder: '…or type what the label says', autocapitalize: 'characters' });
  const lookup = async (code) => {
    if (!code) return;
    status.replaceChildren(spinner('looking it up…'));
    try {
      const found = await api.post('/api/labels/scan', { code });
      status.replaceChildren(notice('ok', `found ${found.kind} ${found.code}${found.name ? ` — ${found.name}` : ''}`));
      setTimeout(() => {
        if (found.kind === 'tooling') openTooling(found.code);
        else if (found.kind === 'location') openLocation(found.id ?? found.code);
        else if (found.kind === 'filter') openFilter(found.code);
        else if (found.id) go(`/production/${found.id}`);
      }, 300);
    } catch (err) {
      status.replaceChildren(errorBox(err));
    }
  };
  const goBtn = button('go', { kind: 'primary' });
  goBtn.addEventListener('click', () => lookup(manual.value.trim()));
  manual.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') lookup(manual.value.trim());
  });

  const cameraBtn = button('📷 open the camera', { kind: 'primary big' });
  cameraBtn.addEventListener('click', async () => {
    const out = await scanAndGo({ title: 'scan tool or shelf label' });
    if (out?.code) status.replaceChildren(notice('ok', `scanned ${out.code}`));
  });
  const photoBtn = button('🖼 decode a photo', { kind: 'ghost big' });
  photoBtn.addEventListener('click', async () => {
    const fileInput = h('input', { type: 'file', accept: 'image/*', style: 'display:none' });
    fileInput.addEventListener('change', async () => {
      if (!fileInput.files?.[0]) return;
      status.replaceChildren(spinner('decoding the photo…'));
      try {
        const code = await decodeImageFile(fileInput.files[0]);
        manual.value = code;
        lookup(code);
      } catch (err) {
        status.replaceChildren(errorBox(err));
      }
    });
    status.replaceChildren(
      h('div', null, 'pick a photo of the label — QR and barcodes both work', fileInput),
      h('div', { style: 'margin-top:8px' }, button('choose photo', { kind: 'ghost small', onClick: () => fileInput.click() })),
    );
  });
  const moveBtn = button('🚚 scan → record a movement', { kind: 'ghost' });
  moveBtn.addEventListener('click', () => scanMove());

  const secure = window.isSecureContext;
  const hasCam = Boolean(navigator.mediaDevices?.getUserMedia);
  const gridBox = h('div', { class: 'btn-grid' }, cameraBtn, photoBtn);
  return h(
    'div',
    null,
    h('div', { class: 'section-title' }, h('h1', null, 'scan a label'), h('span', { class: 'sub' }, 'every tool and every shelf carries a QR; tools also get a Code-128 barcode')),
    card({ kind: 'hero' }, h('p', null, 'scan a tool label to open its record, or scan the shelf label to see what is missing from it.'), gridBox, !secure ? notice('warn', 'the browser opens the camera only over https or on localhost — photo decode and typing still work') : null, !hasCam ? notice('warn', 'no camera here (desktop?) — use a photo or type the code') : null),
    card({ title: 'typed code', dense: true }, h('div', { class: 'scan-manual-row' }, manual, goBtn), status),
    card({ title: 'or jump straight to a movement', subtitle: 'scan tool + shelf and record it', dense: true }, moveBtn),
  );
}

/* --------------------------------------------------------------- router */
let lastHash = '';

async function renderRoute() {
  const { path, segments, query } = parseHash();
  state.route = { path, params: {}, query };
  const key = `/${segments[0] || ''}`;
  const def = ROUTES[key] || null;
  document.title = `${def?.title || (segments[0] ? decodeURIComponent(segments[0]) : 'dashboard')} · ${meta.data?.app?.name || 'Sistemi Purepower'}`;
  if (!state.user && !def?.public) {
    state.user = null;
    state.permissions = new Set();
    location.hash = '#/login';
    return;
  }
  const navActive = def?.nav ?? (key === '/' ? 'dashboard' : segments[0]);
  repaintChrome(navActive);
  if (!mainEl) mainEl = appEl.querySelector('.main');
  mainEl.replaceChildren(spinner('loading…'));
  try {
    const node = await (def?.view || (() => notFound(path)))(mainEl, { path, segments, query, params: {} });
    if (node) mainEl.replaceChildren(node);
    mainEl.scrollTo?.(0, 0);
  } catch (err) {
    if (err?.status === 401) {
      toast('your session expired', 'error');
      state.user = null;
      state.permissions = new Set();
      location.hash = '#/login';
      return;
    }
    mainEl.replaceChildren(errorBox(err));
  }
  // hash changes to the same path but different query still need a re-render
}

function notFound(path) {
  return h('div', null, card({ title: 'no such screen' }, notice('error', `nothing is mounted at #${path}`)), button('back to the dashboard', { href: '#/', kind: 'primary' }));
}

/* ---------------------------------------------------------------- start */
export async function start() {
  try {
    await bootstrap();
  } catch (err) {
    document.body.replaceChildren(
      h('div', { style: 'padding:30px;max-width:640px;margin:0 auto' }, card({ title: 'the server is not reachable' }, errorBox(err), button('retry', { kind: 'primary', onClick: () => location.reload() }))),
    );
    return;
  }
  if (!location.hash || location.hash === '#') location.hash = state.user ? '#/' : '#/login';
  appEl = shellMount();
  document.body.replaceChildren(appEl);
  mainEl = appEl.querySelector('.main');
  statusCounts().then(() => repaintChrome(parseHash().segments[0] || 'dashboard'));
  window.addEventListener('hashchange', () => {
    const next = location.hash;
    if (next === lastHash) return;
    lastHash = next;
    renderRoute();
  });
  window.addEventListener('online', () => location.reload());
  lastHash = location.hash;
  await renderRoute();
  if (state.user?.must_change_password && !location.hash.startsWith('#/account')) go('/account', { change: 1, first: 1 });
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

start();
