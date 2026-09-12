/** Filter catalogue + tooling register screens. The filter overview is the core screen of the whole app. */
import { api, qs, meta, statusInfo } from './api.js';
import {
  h, card, button, buttons, badge, statusBadge, pill, grid, statTile, table, kv, pager, empty, spinner, errorBox, notice, tabs,
  meter, form, formDialog, modal, confirmDialog, toast, photoGrid, lightbox, when, dateOnly, daysUntil, mm, sizeString,
  UnitToggle, unitPreference, setUnit, printHtml, barChart,
} from './ui.js';
import { state, can, go, back, openFilter, openTooling, openLocation, moveTool, reportDamage, pickTooling, pickFilter, downloadWith, statusCounts } from './store.js';
import { openScanner } from './scan.js';

export const catalogViews = {
  '/filters': { view: (m, r) => (r.segments[1] ? FilterOverviewView(m, r) : FilterListView(m, r)), nav: 'filters', title: 'filters' },
  '/tooling': { view: (m, r) => (r.segments[1] ? ToolDetailView(m, r) : ToolingListView(m, r)), nav: 'tooling', title: 'tooling' },
  '/compare': { view: CompareView, nav: 'tooling', title: 'compare tooling' },
};

/* =========================================================== filters list */
async function FilterListView(mount, route) {
  const st = {
    q: route.query.q || '',
    type: route.query.type || '',
    brand: route.query.brand || '',
    status: route.query.status || '',
    vehicle: route.query.vehicle || '',
    family: route.query.family || '',
    missing_tooling: route.query.missing_tooling === '1' ? '1' : '',
    has_tooling: route.query.has_tooling || '',
    page: Number(route.query.page || 1),
    size: 25,
    sort: route.query.sort || 'internal_number',
    dir: route.query.dir || 'asc',
  };
  const body = h('div', null, spinner('loading the catalogue…'));
  const search = h('input', { type: 'search', placeholder: 'number, OEM, name, vehicle, tooling id…', value: st.q, autocapitalize: 'characters' });
  const select = (key, label, options) => {
    const el = h(
      'select',
      { name: key },
      h('option', { value: '' }, `— ${label.toLowerCase()} —`),
      ...options.map((o) => h('option', { value: o.value }, o.label)),
    );
    el.value = st[key] || '';
    el.addEventListener('change', () => {
      st[key] = el.value;
      st.page = 1;
      reload();
    });
    return h('div', { class: 'field' }, h('label', null, label), el);
  };
  const types = (meta.data?.filter_types || []).map((t) => ({ value: t.code, label: `${t.icon || ''} ${t.name}` }));
  const brands = (meta.data?.brands || []).map((b) => ({ value: b.code, label: b.name }));
  const families = await api.get('/api/filters/families').then((r) => r.items.map((f) => ({ value: f.code, label: `${f.name} (${f.filter_count})` }))).catch(() => []);
  const statusOptions = ['ACTIVE', 'DEVELOPMENT', 'INACTIVE', 'DISCONTINUED', 'OBSOLETE'].map((s) => ({ value: s, label: s.replace('_', ' ').toLowerCase() }));

  const filters = h(
    'div',
    { class: 'filters' },
    select('type', 'type', types),
    select('brand', 'brand', brands),
    select('status', 'status', statusOptions),
    select('family', 'family', families),
    select('missing_tooling', 'only missing tooling', [{ value: '1', label: 'yes — I need tooling for these' }]),
    select('has_tooling', 'linked to tooling', [{ value: '1', label: 'has tooling' }, { value: '0', label: 'no tooling yet' }]),
  );
  const vehicleField = h('div', { class: 'field' }, h('label', null, 'vehicle'), h('input', { type: 'search', placeholder: 'Golf 1.6 TDI, CR-V…', value: st.vehicle }));
  vehicleField.querySelector('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      st.vehicle = e.target.value.trim();
      st.page = 1;
      reload();
    }
  });
  filters.appendChild(vehicleField);

  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      st.q = search.value.trim();
      st.page = 1;
      reload();
    }, 280);
  });

  async function reload() {
    body.replaceChildren(spinner('searching…'));
    try {
      const out = await api.get(`/api/filters${qs(st)}`);
      body.replaceChildren(listNode(out));
    } catch (err) {
      body.replaceChildren(errorBox(err));
    }
    history.replaceState(null, '', `#/filters${qs(st)}`);
  }

  function listNode(out) {
    const rows = out.items || [];
    const cols = [
      { label: 'filter', render: (f) => h('div', null, h('b', { class: 'code' }, f.internal_number), f.product_number ? h('div', { class: 'tiny muted' }, f.product_number) : null) },
      { label: 'name', render: (f) => h('div', null, f.name || '-', f.family_name ? h('div', { class: 'tiny muted' }, `family ${f.family_name}`) : null) },
      { label: 'type', render: (f) => h('span', { class: 'badge' }, `${f.type_icon || ''} ${f.type_name}`) },
      { label: 'brand', key: 'brand_name' },
      { label: 'tooling', render: (f) => badge(`${f.tooling_count} linked`, f.tooling_count ? 'ok' : 'warn') },
      { label: 'vehicles', key: 'application_count' },
      { label: 'oem/xref', key: 'xref_count' },
      { label: 'status', render: (f) => badge(f.status, f.status === 'ACTIVE' ? 'ok' : f.status === 'OBSOLETE' ? 'danger' : '') },
      { label: 'updated', render: (f) => h('span', { class: 'tiny muted nowrap' }, when(f.updated_at)) },
    ];
    return h(
      'div',
      null,
      table(cols, rows, { onRowOpen: (f) => openFilter(f.internal_number), emptyText: 'no filter matches those filters' }),
      pager(out.pagination, (page) => ((st.page = page), reload())),
    );
  }

  const newFilter = async () => {
    const values = await formDialog({
      title: 'new filter model',
      subtitle: 'the number becomes the key everything else hangs off',
      wide: true,
      submitLabel: 'create',
      fields: filterFields(),
    });
    if (!values) return;
    try {
      const created = await api.post('/api/filters', values);
      toast(`filter ${created.internal_number} created`, 'ok');
      statusCounts();
      openFilter(created.internal_number);
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  };

  const node = h(
    'div',
    null,
    h(
      'div',
      { class: 'section-title' },
      h('h1', null, 'filter catalogue'),
      h('span', { class: 'sub' }, 'every filter model with its tooling, vehicles and sizes'),
      h('span', { class: 'grow' }),
      can('filters.create') ? button('＋ new filter', { kind: 'primary', onClick: newFilter }) : null,
    ),
    card({ dense: true }, h('div', { class: 'scan-manual-row' }, search, button('search', { kind: 'ghost', onClick: () => ((st.q = search.value.trim()), (st.page = 1), reload()) })), filters),
    body,
  );
  await reload();
  return node;
}

function filterFields(values = {}) {
  const types = (meta.data?.filter_types || []).map((t) => ({ value: t.code, label: `${t.icon || ''} ${t.name}` }));
  const brands = (meta.data?.brands || []).map((b) => ({ value: b.code, label: b.name }));
  return [
    { key: 'internal_number', label: 'internal filter number', required: true, placeholder: 'FP-0427', help: 'the number printed on the box', wide: false },
    { key: 'product_number', label: 'product / article number', placeholder: 'PP-1042' },
    { key: 'name', label: 'name', placeholder: 'Oil filter spin-on Ø76', wide: true },
    { key: 'filter_type', label: 'filter type', type: 'select', required: true, options: types },
    { key: 'brand', label: 'brand', type: 'select', options: brands },
    { key: 'family', label: 'tooling family', placeholder: 'create or reuse a family', help: 'shared tooling family, e.g. SPIN76' },
    { key: 'status', label: 'status', type: 'select', options: ['ACTIVE', 'DEVELOPMENT', 'INACTIVE', 'DISCONTINUED', 'OBSOLETE'], initial: 'ACTIVE' },
    { key: 'description', label: 'description', type: 'textarea', wide: true },
    { key: 'notes', label: 'internal notes', type: 'textarea', wide: true },
    { key: 'is_active', label: 'active (searchable on the floor)', type: 'checkbox', initial: true },
  ];
}

/* ============================================== THE filter tooling overview */
async function FilterOverviewView(mount, route) {
  const ref = route.segments[1];
  const box = h('div', null, spinner('building the overview…'));
  let data = null;
  const unit = unitPreference();

  async function reload() {
    box.replaceChildren(spinner('building the overview…'));
    try {
      data = await api.get(`/api/filters/${encodeURIComponent(ref)}/overview${qs({ unit: 'mm' })}`);
      box.replaceChildren(overviewNode(data));
    } catch (err) {
      box.replaceChildren(card({ title: 'cannot open this filter' }, errorBox(err), h('div', { style: 'margin-top:10px' }, button('back to the list', { kind: 'ghost', onClick: () => go('/filters') }))));
    }
  }

  function dimensionRows(dims, fields) {
    const rows = fields
      .map((f) => ({ field: f, value: dims?.[f.key] }))
      .filter((r) => r.value !== null && r.value !== undefined && r.value !== '');
    if (!rows.length) return notice('warn', 'no dimensions recorded yet — the size search and the duplicate detector need them');
    const u = unitPreference();
    return h(
      'table',
      { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, 'dimension'), h('th', null, u), h('th', null, 'other units'))),
      h(
        'tbody',
        null,
        rows.map(({ field, value }) => {
          const numeric = Number.isFinite(Number(value)) && field.unit;
          return h(
            'tr',
            null,
            h('td', null, field.label, field.note ? h('div', { class: 'tiny muted' }, field.note) : null),
            h('td', null, h('b', null, numeric ? mm(value, u) : String(value))),
            h('td', { class: 'tiny muted' }, numeric ? `mm ${Number(value).toFixed(1)} · cm ${(Number(value) / 10).toFixed(2)} · in ${(Number(value) / 25.4).toFixed(3)}` : ''),
          );
        }),
      ),
    );
  }

  function readinessCard(o) {
    const p = o.production;
    const orders = p.open_orders || [];
    const node = h(
      'div',
      { class: `banner ${p.ready ? 'ready' : 'blocked'}` },
      h('div', { style: 'font-size:30px' }, p.ready ? '✅' : '⚠️'),
      h(
        'div',
        { class: 'grow' },
        h('div', { class: 'big' }, p.ready ? 'PRODUCTION READY' : 'PRODUCTION BLOCKED'),
        p.ready
          ? h('div', { class: 'why' }, 'every mandatory tooling category is available for this filter')
          : h(
              'ul',
              { class: 'blockers' },
              p.blockers.map((b) =>
                h(
                  'li',
                  null,
                  h('b', null, b.type.replace(/_/g, ' ')),
                  ' — ',
                  b.message,
                  b.tooling_id ? h('a', { class: 'code', href: `#/tooling/${encodeURIComponent(b.tooling_id)}` }, ` ${b.tooling_id}`) : null,
                ),
              ),
            ),
      ),
    );
    if (orders.length) {
      node.appendChild(
        h(
          'div',
          { class: 'orders-inline' },
          h('div', { class: 'group-title' }, `open production orders (${orders.length})`),
          table(
            [
              { label: 'order', render: (x) => h('a', { class: 'code', href: `#/production/${x.id}` }, x.po_number) },
              { label: 'qty', render: (x) => `${x.quantity_produced ?? 0} / ${x.quantity_ordered}` },
              { label: 'planned', render: (x) => h('span', { class: 'nowrap' }, dateOnly(x.planned_start_at)) },
              { label: 'line', key: 'line' },
              { label: 'state', render: (x) => h('span', null, badge(x.status, x.status === 'IN_PROGRESS' ? 'warn' : ''), ' ', badge(x.availability_status === 'READY' ? 'READY' : x.availability_status, x.availability_status === 'READY' ? 'ok' : 'danger')) },
            ],
            orders,
            { onRowOpen: (x) => go(`/production/${x.id}`) },
          ),
        ),
      );
    }
    return node;
  }

  function toolLine(item, ctx) {
    const row = h('div', { class: 'tool-line' });
    const img = item.primary_image_id
      ? h('img', { class: 'thumb', src: `/api/files/images/${item.primary_image_id}`, alt: '', loading: 'lazy', onclick: () => lightbox(`/api/files/images/${item.primary_image_id}`, item.tooling_id) })
      : h('div', { class: 'thumb none', title: 'no photo' }, item.icon || '🧿');
    row.appendChild(img);
    const main = h('div', { class: 'grow' });
    main.appendChild(
      h(
        'div',
        { class: 'line-1' },
        h('a', { class: 'code big-code', href: `#/tooling/${encodeURIComponent(item.tooling_id)}` }, item.tooling_id),
        statusBadge(item.status),
        item.condition ? badge(item.condition.replace(/_/g, ' ').toLowerCase(), item.condition === 'DAMAGED' ? 'danger' : item.condition === 'WORN' ? 'warn' : '') : null,
        item.quantity > 1 ? badge(`×${item.quantity}`) : null,
        item.compatibility_level && item.compatibility_level !== 'EXACT' ? badge(item.compatibility_level.toLowerCase()) : null,
      ),
    );
    main.appendChild(h('div', { class: 'line-2' }, item.name));
    main.appendChild(
      h(
        'div',
        { class: 'line-3' },
        h(
          'span',
          { class: `where ${item.location ? 'ok' : 'bad'}` },
          item.location ? `📍 ${item.location.code}` : '📍 shelf not recorded',
          item.location?.path ? h('span', { class: 'tiny muted' }, ` · ${item.location.path}`) : null,
          item.location ? null : item.notes && ctx?.showNotes ? h('span', { class: 'tiny muted' }, ` · ${item.notes}`) : null,
        ),
        item.display_dimensions ? h('span', { class: 'tiny' }, ` · ${item.display_dimensions}`) : null,
        item.cycles?.max ? h('span', { class: `tiny ${item.cycles.total / item.cycles.max > 0.85 ? 'danger-text' : 'muted'}` }, ` · ${item.cycles.total}/${item.cycles.max} cycles`) : null,
        item.reserved_qty ? h('span', { class: 'tiny warn-text' }, ` · ${item.reserved_qty} reserved`) : null,
        item.next_maintenance_date ? h('span', { class: `tiny ${daysUntil(item.next_maintenance_date) < 0 ? 'danger-text' : 'muted'}` }, ` · maint. ${daysUntil(item.next_maintenance_date)}d`) : null,
      ),
    );
    row.appendChild(main);
    const acts = h('div', { class: 'line-actions' });
    if (item.location) acts.appendChild(button('where', { kind: 'ghost small', onClick: () => locationRow(item) }));
    if (can('tooling.move')) acts.appendChild(button('take / return', { kind: 'primary small', onClick: () => moveTool({ id: item.id, tooling_id: item.tooling_id, name: item.name, location_code: item.location?.code }) }));
    if (can('tooling.update')) acts.appendChild(button('report damage', { kind: 'danger small', onClick: () => reportDamage({ id: item.id, tooling_id: item.tooling_id, name: item.name }) }));
    row.appendChild(acts);
    return row;
  }

  function locationRow(item) {
    const dialog = modal({
      title: item.location.code,
      subtitle: item.location.path,
      body: h(
        'div',
        null,
        notice('info', 'walk to this place — the label on the shelf matches this code exactly'),
        h('div', { class: 'big-code center', style: 'font-size:34px;letter-spacing:.02em;margin:10px 0' }, item.location.code),
        h('div', { class: 'btn-row' }, button('open the location', { kind: 'ghost', onClick: () => (dialog.close(), openLocation(item.location.id || item.location.code)) })),
      ),
      actions: h('div', { class: 'btn-row end' }, button('close', { kind: 'ghost', onClick: () => dialog.close() })),
    });
  }

  function requirementsCard(o) {
    const wrap = h('div', { class: 'req-blocks' });
    for (const req of o.required_tooling) {
      const tone = req.state === 'OK' ? 'ok' : req.state === 'PARTIAL' ? 'warn' : req.state === 'MAINTENANCE' ? 'warn' : 'danger';
      const icon = req.state === 'OK' ? '✅' : req.state === 'PARTIAL' ? '⚠️' : req.state === 'MAINTENANCE' ? '🛠' : '❌';
      const block = h(
        'div',
        { class: `req ${tone}` },
        h(
          'header',
          null,
          h('div', null, h('b', null, `${icon} ${req.type_name}`), h('div', { class: 'tiny muted' }, `${req.quantity_required} needed${req.is_mandatory ? '' : ' (optional)'}${req.note ? ` · ${req.note}` : ''}`)),
          badge(req.state.toLowerCase(), tone),
          h('span', { class: 'grow' }),
          can('dimensions.manage')
            ? buttons([
                { label: 'require another', kind: 'ghost small', onClick: () => addRequirement(req) },
                { label: 'remove requirement', kind: 'ghost small', onClick: () => removeRequirement(req) },
              ])
            : null,
        ),
      );
      const list = h('div', { class: 'tool-lines' });
      if (!req.items.length) list.appendChild(h('p', { class: 'muted small pad' }, `nothing of this type is linked to the filter — use “link tooling” below or raise a request`));
      for (const item of req.items) list.appendChild(toolLine(item, { showNotes: true }));
      block.appendChild(list);
      wrap.appendChild(block);
    }
    const extra = (o.tooling || []).filter((t) => !o.required_tooling.some((r) => r.type_code === t.type_code));
    if (extra.length) {
      const block = h(
        'div',
        { class: 'req' },
        h('header', null, h('div', null, h('b', null, 'linked tooling not covered by a requirement'), h('div', { class: 'tiny muted' }, 'kept here because it is used for this filter but no requirement row exists yet'))),
        h('div', { class: 'tool-lines' }, extra.map((item) => toolLine(item, {}))),
      );
      wrap.appendChild(block);
    }
    if (!o.required_tooling.length && !extra.length) {
      wrap.appendChild(notice('warn', 'no tooling is defined for this filter yet — add the required categories, then link the physical tools'));
    }
    return wrap;
  }

  async function addRequirement(req) {
    const types = await api.get('/api/tooling/types/list').then((r) => r.items.map((t) => ({ value: t.id, label: `${t.icon || ''} ${t.name}` })));
    const values = await formDialog({
      title: 'required tooling category',
      subtitle: req ? `current: ${req.type_name}` : 'what must exist before this filter can be produced',
      fields: [
        { key: 'tooling_type_id', label: 'category', type: 'select', required: true, options: types, empty: false, initial: req?.tooling_type_id },
        { key: 'quantity_required', label: 'how many pieces', type: 'number', min: 1, initial: req?.quantity_required ?? 1 },
        { key: 'is_mandatory', label: 'mandatory (blocks production if missing)', type: 'checkbox', initial: req ? Boolean(req.is_mandatory) : true },
        { key: 'note', label: 'note', type: 'text', wide: true },
      ],
    });
    if (!values) return;
    try {
      await api.post(`/api/filters/${o.filter.id}/requirements`, values);
      toast('requirement saved', 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'error', 8000);
    }
  }

  async function removeRequirement(req) {
    if (!(await confirmDialog(`remove the “${req.type_name}” requirement from ${o.filter.internal_number}?`, { danger: true, confirmLabel: 'remove' }))) return;
    try {
      await api.del(`/api/filters/${o.filter.id}/requirements/${req.requirement_id}`);
      reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function linkTooling() {
    const picked = await pickTooling({ title: 'which tool does this filter need?' });
    if (!picked) return;
    try {
      await api.post(`/api/filters/${o.filter.id}/tooling`, { tooling_ids: [picked.id], level: 'EXACT' });
      toast(`${picked.tooling_id} linked`, 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'error', 8000);
    }
  }

  async function editFilter() {
    const values = await formDialog({
      title: `edit ${o.filter.internal_number}`,
      wide: true,
      fields: filterFields(o.filter),
      initial: { ...o.filter, filter_type: o.filter.type_code, brand: o.filter.brand_code, family: o.filter.family_code },
      submitLabel: 'save',
    });
    if (!values) return;
    try {
      await api.put(`/api/filters/${o.filter.id}`, values);
      toast('saved', 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function editDimensions() {
    const fields = (meta.data?.dimension_fields?.filter || []).map((f) => ({
      key: f.key,
      label: f.label + (f.unit ? ` (${f.unit})` : ''),
      type: f.unit === 'mm' ? 'number' : f.unit ? 'number' : 'text',
      step: '0.1',
      initial: o.dimensions?.[f.key] ?? '',
      help: f.profiles ? undefined : undefined,
    }));
    const values = await formDialog({ title: 'filter dimensions', subtitle: `enter the numbers in mm (base unit is always mm)`, wide: true, fields, submitLabel: 'save dimensions' });
    if (!values) return;
    try {
      await api.put(`/api/filters/${o.filter.id}/dimensions`, { unit: 'mm', values });
      toast('dimensions saved', 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function addXref() {
    const values = await formDialog({
      title: 'cross reference',
      subtitle: 'OEM / competitor numbers people type into the search box',
      fields: [
        { key: 'ref_number', label: 'number', required: true, placeholder: '06L115562B' },
        { key: 'ref_type', label: 'kind', type: 'select', options: ['OEM', 'COMPETITOR', 'INTERNAL', 'SUPPLIER'], initial: 'OEM' },
        { key: 'brand', label: 'brand', type: 'select', options: (meta.data?.brands || []).map((b) => ({ value: b.code, label: b.name })) },
        { key: 'notes', label: 'note', type: 'text', wide: true },
      ],
    });
    if (!values) return;
    try {
      await api.post(`/api/filters/${o.filter.id}/cross-references`, values);
      reload();
    } catch (err) {
      toast(err.message, 'error', 8000);
    }
  }

  async function addVehicle() {
    const list = h('div', { class: 'list' }, notice('info', 'type at least two characters'));
    const input = h('input', { type: 'search', placeholder: 'manufacturer, model, engine code…' });
    let chosen = null;
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim();
        if (q.length < 2) return;
        list.replaceChildren(spinner('searching vehicles…'));
        try {
          const out = await api.get(`/api/filters/${o.filter.id}/applications/search-vehicle${qs({ q })}`);
          list.replaceChildren(
            ...out.items.map((v) => {
              const row = h('label', { class: `list-item selectable ${chosen === v.id ? 'on' : ''}` }, h('input', { type: 'checkbox', checked: chosen === v.id }), h('div', { class: 'grow' }, h('b', null, `${v.manufacturer} ${v.model}`), h('div', { class: 'tiny muted' }, [v.generation, `${v.year_from}-${v.year_to || ''}`, v.engine, v.engine_code, v.fuel].filter(Boolean).join(' · '))), badge(`${v.used_by} filter(s)`));
              row.addEventListener('click', (e) => {
                e.preventDefault();
                chosen = chosen === v.id ? null : v.id;
                list.querySelectorAll('.list-item').forEach((x) => x.classList.remove('on'));
                if (chosen === v.id) row.classList.add('on');
                row.querySelector('input').checked = chosen === v.id;
              });
              return row;
            }),
          );
        } catch (err) {
          list.replaceChildren(errorBox(err));
        }
      }, 260);
    });
    const dialog = modal({
      title: 'which vehicle does it fit?',
      wide: true,
      body: h('div', null, input, h('div', { style: 'margin-top:10px' }, list), h('p', { class: 'tiny muted' }, 'one at a time from the phone — the tick marks the pick')),
      actions: h(
        'div',
        { class: 'btn-row end' },
        button('cancel', { kind: 'ghost', onClick: () => dialog.close() }),
        button('link it', {
          kind: 'primary',
          onClick: async () => {
            if (!chosen) return toast('pick a vehicle first', 'error');
            try {
              await api.post(`/api/filters/${o.filter.id}/applications`, { vehicle_ids: [chosen], quantity_per_vehicle: 1 });
              dialog.close();
              toast('application linked', 'ok');
              reload();
            } catch (err) {
              toast(err.message, 'error', 8000);
            }
          },
        }),
      ),
    });
    setTimeout(() => input.focus(), 60);
  }

  async function setStock() {
    const values = await formDialog({
      title: 'finished goods stock',
      subtitle: 'a stock movement is written, never a silent overwrite',
      fields: [
        { key: 'txn_type', label: 'what happened', type: 'select', required: true, options: ['RECEIPT', 'ISSUE', 'ADJUSTMENT', 'SCRAP', 'RETURN'], initial: 'RECEIPT' },
        { key: 'quantity', label: 'pieces', type: 'number', required: true, min: 0, initial: 100 },
        { key: 'location_code', label: 'stock location code', placeholder: 'FIN-01', help: 'inventory bin, not the tooling shelf' },
        { key: 'reference_no', label: 'reference (delivery / order)' },
        { key: 'reason', label: 'reason', type: 'select', options: ['PRODUCTION', 'CUSTOMER', 'CORRECTION', 'SAMPLE', 'DAMAGED'] },
        { key: 'note', label: 'note', type: 'text', wide: true },
      ],
    });
    if (!values) return;
    try {
      const out = await api.post(`/api/filters/${o.filter.id}/stock`, values);
      toast(`${out.before} → ${out.after} pcs`, 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function editPackaging() {
    const values = await formDialog({
      title: 'packaging option',
      fields: [
        { key: 'packaging_type', label: 'type', required: true, placeholder: 'BOX / CARTON / PALLET / SLEEVE', initial: 'BOX' },
        { key: 'units_per_pack', label: 'units per pack', type: 'number', min: 1, initial: 12 },
        { key: 'available_packs', label: 'packs available', type: 'number', min: 0, initial: 0 },
        { key: 'notes', label: 'note', type: 'text', wide: true },
      ],
    });
    if (!values) return;
    try {
      await api.put(`/api/filters/${o.filter.id}/packaging`, values);
      toast('packaging saved', 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function printOverview() {
    const f = o.filter;
    const rows = (o.tooling || [])
      .map(
        (t) =>
          `<tr><td><b>${t.tooling_id}</b></td><td>${t.type_name || ''}</td><td>${t.name || ''}</td><td>${t.status}</td><td>${t.where || ''}</td><td>${t.display_dimensions || ''}</td><td>${t.condition || ''}</td></tr>`,
      )
      .join('');
    const dims = o.dimensions ? (o.dimensions.length_mm ? `${o.dimensions.length_mm} × ${o.dimensions.width_mm} × ${o.dimensions.height_mm} mm` : `Ø ${o.dimensions.overall_diameter_mm ?? '?'} mm`) : '—';
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${f.internal_number} tooling list</title><style>
      body{font:12px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;margin:12mm;color:#0f172a}
      h1{font-size:20px;margin:0 0 2px} .sub{color:#475569;margin:0 0 10px}
      table{border-collapse:collapse;width:100%} th,td{border:1px solid #cbd5e1;padding:4px 6px;text-align:left;vertical-align:top}
      th{background:#f1f5f9;font-size:10px;text-transform:uppercase;letter-spacing:.04em}
      .kv{display:flex;gap:18px;flex-wrap:wrap;margin:0 0 12px} .kv div{font-size:11px} .kv b{display:block;font-size:9px;text-transform:uppercase;color:#475569}
      .state{font-weight:700;color:${o.production.ready ? '#15803d' : '#b91c1c'}}
      @page{margin:10mm}
    </style></head><body>
      <h1>${f.internal_number}${f.product_number ? ` · ${f.product_number}` : ''}</h1>
      <p class="sub">${f.name || ''} — ${f.type_name}${f.brand_name ? ` · ${f.brand_name}` : ''}</p>
      <div class="kv">
        <div><b>size</b>${dims}</div>
        <div><b>vehicles</b>${(o.vehicles || []).length}</div>
        <div><b>tooling</b>${(o.tooling || []).length}</div>
        <div><b>stock</b>${o.stock?.finished_filters ?? 0} pcs</div>
        <div class="state"><b>production</b>${o.production.ready ? 'READY' : 'BLOCKED'}</div>
      </div>
      <table><thead><tr><th>tooling id</th><th>category</th><th>name</th><th>status</th><th>where</th><th>size</th><th>condition</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="sub">printed ${new Date().toLocaleString()} · Sistemi Purepower tooling register</p>
    </body></html>`;
    printHtml(html);
  }

  function overviewNode(data) {
    o = data;
    const f = data.filter;
    const d = data.dimensions;
    const sizeShort = d ? (d.length_mm ? `${mm(d.length_mm)} × ${mm(d.width_mm)} × ${mm(d.height_mm)}` : d.overall_diameter_mm ? `Ø ${mm(d.overall_diameter_mm)}` : 'no size') : 'no size';
    const head = h(
      'div',
      { class: 'section-title' },
      h(
        'div',
        null,
        h('div', { class: 'chips' }, badge(f.type_icon ? `${f.type_icon} ${f.type_name}` : f.type_name), f.brand_name ? badge(f.brand_name) : null, badge(f.status, f.status === 'ACTIVE' ? 'ok' : ''), f.family_name ? badge(`family ${f.family_name}`) : null),
        h('h1', { class: 'code mono-title' }, f.internal_number),
        h('div', { class: 'sub' }, `${f.name || ''} · ${sizeShort} · ${(f.tooling_count ?? 0)} tool(s) · ${(f.application_count ?? 0)} vehicle(s)`),
      ),
      h('span', { class: 'grow' }),
      buttons([
        button('back', { kind: 'ghost small', onClick: () => (history.length > 1 ? back() : go('/filters')) }),
        can('filters.update') ? button('edit', { kind: 'ghost small', onClick: editFilter }) : null,
        button('print', { kind: 'ghost small', onClick: printOverview }),
        can('dimensions.manage') ? button('link tooling', { kind: 'primary small', onClick: linkTooling }) : null,
      ]),
    );

    const photo = data.images?.find((i) => i.is_primary) || data.images?.[0];
    const facts = card(
      { title: 'the filter', subtitle: 'sizes are stored in mm and shown in your unit' },
      h(
        'div',
        { class: 'split' },
        photo
          ? h('img', { class: 'hero-photo', src: `/api/files/images/${photo.id}`, alt: photo.caption || f.internal_number, loading: 'lazy', onclick: () => lightbox(`/api/files/images/${photo.id}`, photo.caption || f.internal_number) })
          : h('div', { class: 'hero-photo placeholder' }, 'no photo'),
        h(
          'div',
          { class: 'grow' },
          kv([
            ['dimensions', h('div', null, [d?.length_mm ? `L ${mm(d.length_mm)}` : null, d?.width_mm ? `W ${mm(d.width_mm)}` : null, d?.height_mm ? `H ${mm(d.height_mm)}` : null].filter(Boolean).join(' · ') || 'not recorded')],
            ['diameters', [d?.overall_diameter_mm ? `overall Ø ${mm(d.overall_diameter_mm)}` : null, d?.outer_diameter_mm ? `outer Ø ${mm(d.outer_diameter_mm)}` : null, d?.inner_diameter_mm ? `inner Ø ${mm(d.inner_diameter_mm)}` : null, d?.gasket_diameter_mm ? `gasket Ø ${mm(d.gasket_diameter_mm)} × ${mm(d.gasket_thickness_mm || 0)}` : null].filter(Boolean).join(' · ') || 'not recorded'],
            ['thread', d?.thread_spec || '—'],
            ['weight', d?.weight_grams ? `${d.weight_grams} g` : '—'],
            ['pleats', d?.pleat_count ? `${d.pleat_count} × ${mm(d.pleat_height_mm || 0)} high` : '—'],
            ['media', data.materials?.media_type || '—'],
            ['gasket / rubber', [data.materials?.gasket_material, data.materials?.rubber_material].filter(Boolean).join(' + ') || '—'],
            ['machine', data.materials?.production_machine || '—'],
            ['batch / cycle', data.materials?.standard_batch_qty ? `${data.materials.standard_batch_qty} pcs @ ${data.materials.cycle_time_seconds}s` : '—'],
          ]),
          h('div', { class: 'btn-row', style: 'margin-top:8px' }, UnitToggle(() => reload()), can('dimensions.manage') ? button('edit dimensions', { kind: 'ghost small', onClick: editDimensions }) : null),
        ),
      ),
    );

    const xrefs = card(
      { title: 'cross references', subtitle: `${(data.xrefs || []).length} number(s) people also search for`, actions: can('dimensions.manage') ? button('＋ add', { kind: 'ghost small', onClick: addXref }) : null },
      (data.xrefs || []).length
        ? h(
            'div',
            { class: 'chips' },
            data.xrefs.map((x) =>
              h(
                'span',
                { class: 'chip big' },
                h('a', { href: `#/search?q=${encodeURIComponent(x.ref_number)}`, title: 'search this number' }, h('b', { class: 'code' }, x.ref_number)),
                h('span', { class: 'tiny muted' }, ` ${x.ref_type}${x.brand_name ? ` ${x.brand_name}` : ''}`),
                can('dimensions.manage')
                  ? h('button', { class: 'chip-x', title: 'remove', onclick: async () => (await api.del(`/api/filters/${f.id}/cross-references/${x.id}`), reload()) }, '×')
                  : null,
              ),
            ),
          )
        : empty('no OEM or competitor numbers', 'add them so the search box finds this filter from any brand number'),
    );

    const vehicles = card(
      { title: 'vehicle applications', subtitle: `${(data.vehicles || []).length} fitment(s)`, actions: can('dimensions.manage') ? button('＋ add', { kind: 'ghost small', onClick: addVehicle }) : null },
      (data.vehicles || []).length
        ? table(
            [
              { label: 'manufacturer', key: 'manufacturer' },
              { label: 'model', render: (v) => h('b', null, v.model) },
              { label: 'years', render: (v) => h('span', { class: 'nowrap' }, `${v.year_from ?? ''}${v.year_to ? `–${v.year_to}` : ''}`) },
              { label: 'engine', render: (v) => [v.engine, v.engine_code].filter(Boolean).join(' ') },
              { label: 'fuel', key: 'fuel' },
              { label: 'power', render: (v) => (v.power_hp ? `${v.power_hp} hp` : '') },
              { label: 'per car', render: (v) => (v.quantity_per_vehicle > 1 ? badge(`${v.quantity_per_vehicle} pcs`, 'warn') : '') },
              {
                label: '',
                render: (v) =>
                  can('dimensions.manage')
                    ? h('button', { class: 'chip-x', title: 'unlink', onclick: async () => (await api.del(`/api/filters/${f.id}/applications/${v.id}`), reload()) }, '×')
                    : null,
              },
            ],
            data.vehicles,
            { emptyText: 'no vehicle linked' },
          )
        : empty('no vehicle application yet'),
    );

    const toolingCard = card(
      { title: 'required tooling', subtitle: 'status + exact shelf for every category, live from the register' },
      requirementsCard(data),
    );

    const stockCard = card(
      { title: 'finished goods & packaging', actions: buttons([button('stock movement', { kind: 'ghost small', onClick: setStock }), can('dimensions.manage') ? button('packaging', { kind: 'ghost small', onClick: editPackaging }) : null]) },
      grid(
        2,
        h(
          'div',
          null,
          statTile({ label: 'on hand', value: data.stock?.finished_filters ?? 0, sub: 'pcs in stock' }),
          statTile({ label: 'available', value: data.stock?.available_filters ?? 0, sub: 'after reservations', tone: (data.stock?.available_filters ?? 0) > 0 ? 'ok' : 'danger' }),
        ),
        table(
          [
            { label: 'packaging', render: (p) => h('b', null, p.packaging_type) },
            { label: 'pcs/pack', key: 'units_per_pack' },
            { label: 'packs', key: 'available_packs' },
            { label: 'pieces', render: (p) => Number(p.units_per_pack || 0) * Number(p.available_packs || 0) },
            { label: '', render: (p) => (can('dimensions.manage') ? h('button', { class: 'chip-x', onclick: async () => (await api.del(`/api/filters/${f.id}/packaging/${p.id}`), reload()) }, '×') : null) },
          ],
          data.packaging || [],
          { emptyText: 'no packaging defined' },
        ),
      ),
      (data.stock?.lines || []).length
        ? h('div', null, h('div', { class: 'group-title' }, 'stock lines'), table([{ label: 'sku', key: 'sku' }, { label: 'qty', key: 'quantity' }, { label: 'reserved', key: 'reserved_qty' }, { label: 'reorder at', key: 'reorder_level' }, { label: 'stock rows', key: 'stock_lines' }], data.stock.lines))
        : null,
    );

    const filesCard = card(
      { title: 'photos & drawings', subtitle: `${(data.images || []).length} photo(s), ${(data.documents || []).length} file(s)`, actions: can('files.manage') ? button('upload', { kind: 'ghost small', onClick: () => uploadFilterFiles() }) : null },
      photoGrid((data.images || []).map((i) => ({ ...i, url: `/api/files/images/${i.id}`, src: `/api/files/images/${i.id}` })), { onOpen: (img) => lightbox(img.url, img.caption) }),
      (data.documents || []).length
        ? h(
            'div',
            { class: 'list' },
            data.documents.map((d2) =>
              h(
                'div',
                { class: 'list-item' },
                h('span', null, '📐'),
                h('div', { class: 'grow' }, h('b', null, d2.original_name), h('div', { class: 'tiny muted' }, `${d2.doc_type} · ${(d2.size_bytes / 1024).toFixed(0)} KB · ${dateOnly(d2.created_at)}`)),
                h('a', { class: 'btn small ghost', href: `/api/files/documents/${d2.id}`, target: '_blank', rel: 'noopener' }, 'open'),
              ),
            ),
          )
        : null,
    );

    async function uploadFilterFiles() {
      const values = await formDialog({
        title: 'upload files for this filter',
        fields: [
          { key: 'files', label: 'photos', type: 'photo', camera: true, wide: true, help: 'jpg / png / webp — up to 12 at once' },
          { key: 'caption', label: 'caption', placeholder: 'front side after hardening' },
          { key: 'make_primary', label: 'make the first photo the main one', type: 'checkbox', initial: true },
        ],
      });
      if (!values?.files?.length) return;
      const fd = new FormData();
      for (const file of values.files) fd.append('files', file);
      fd.append('caption', values.caption || '');
      fd.append('view_type', 'DETAIL');
      fd.append('make_primary', values.make_primary ? '1' : '0');
      try {
        await api.upload(`/api/filters/${f.id}/images`, fd);
        toast('photos uploaded', 'ok');
        reload();
      } catch (err) {
        toast(err.message, 'error', 9000);
      }
    }

    const setsCard = (data.sets || []).length
      ? card(
          { title: 'tooling sets', subtitle: 'a set is complete when every member exists' },
          table(
            [
              { label: 'set', render: (s) => h('b', { class: 'code' }, s.code) },
              { label: 'name', key: 'name' },
              { label: 'status', render: (s) => badge(String(s.status).toLowerCase(), s.status === 'COMPLETE' ? 'ok' : 'warn') },
              { label: 'required', key: 'required_count' },
              { label: 'linked', key: 'linked_count' },
              { label: 'available', key: 'available_count' },
            ],
            data.sets,
          ),
        )
      : null;

    return h(
      'div',
      null,
      head,
      readinessCard(data),
      h('div', { class: 'two-col' }, facts, xrefs),
      toolingCard,
      h('div', { class: 'two-col' }, vehicles, setsCard || stockCard),
      setsCard ? stockCard : null,
      h('div', { class: 'two-col' }, filesCard, card({ title: 'dimension search from this size', subtitle: 'find other things with the same measurements' }, dimensionSearchFromFilter(data))),
    );
  }

  function dimensionSearchFromFilter(data) {
    const d = data.dimensions || {};
    const box = h('div', null, notice('info', 'run a size search across the tooling register to reuse existing tools'));
    const btn = button(`search tooling near ${d.length_mm ? `${d.length_mm}×${d.width_mm}×${d.height_mm} mm` : `Ø ${d.overall_diameter_mm ?? '?'} mm`}`, {
      kind: 'primary',
      onClick: async () => {
        btn.disabled = true;
        try {
          const out = await api.get(
            `/api/tooling/dimension-search${qs({ length: d.length_mm, width: d.width_mm, height: d.height_mm, diameter: d.overall_diameter_mm, tolerance: 3, unit: 'mm', limit: 12 })}`,
          );
          box.replaceChildren(
            h('p', { class: 'tiny muted' }, `${out.count ?? out.items?.length ?? 0} match(es) within ±3 mm`),
            table(
              [
                { label: 'tooling', render: (t) => h('a', { class: 'code', href: `#/tooling/${encodeURIComponent(t.tooling_id)}` }, t.tooling_id) },
                { label: 'name', key: 'name' },
                { label: 'size', render: (t) => sizeString(t.dimensions ?? t, ['overall_length_mm', 'overall_width_mm', 'overall_height_mm']) },
                { label: 'match', render: (t) => (t.match_pct ? badge(`${t.match_pct}%`, 'ok') : '') },
                { label: 'status', render: (t) => statusBadge(t.status) },
              ],
              out.items || [],
              { onRowOpen: (t) => openTooling(t.tooling_id) },
            ),
          );
        } catch (err) {
          box.replaceChildren(errorBox(err));
        } finally {
          btn.disabled = false;
        }
      },
    });
    return h('div', null, btn, h('div', { style: 'margin-top:10px' }, box));
  }

  let o = null;
  await reload();
  return box;
}

/* ========================================================== tooling list */
const TABS = [
  { key: 'items', label: '🧿 register' },
  { key: 'sets', label: '🧩 sets' },
  { key: 'duplicates', label: '🔁 duplicates' },
  { key: 'check', label: '🤔 do we have this tool?' },
  { key: 'dimensions', label: '📐 by size' },
  { key: 'deleted', label: '🗑 archived' },
];

async function ToolingListView(mount, route) {
  const st = {
    tab: route.query.tab || 'items',
    q: route.query.q || '',
    type: route.query.type || '',
    status: route.query.status || '',
    brand: route.query.brand || '',
    filter_type: route.query.filter_type || '',
    maintenance_due: route.query.maintenance_due || '',
    cycle_warning: route.query.cycle_warning || '',
    no_location: route.query.no_location || '',
    open_damage: route.query.open_damage || '',
    page: Number(route.query.page || 1),
    size: 30,
    sort: route.query.sort || 'tooling_id',
    dir: route.query.dir || 'asc',
  };
  const body = h('div', null);
  const tabbar = tabs(TABS.map((t) => ({ ...t, count: undefined })), st.tab, (key) => {
    st.tab = key;
    history.replaceState(null, '', `#/tooling${qs(st)}`);
    paint();
  });
  const search = h('input', { type: 'search', placeholder: 'tooling id, name, serial, rubber profile, letter, filter number…', value: st.q, autocapitalize: 'characters' });
  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      st.q = search.value.trim();
      st.page = 1;
      paint();
    }, 280);
  });

  async function paint() {
    tabbar.replaceChildren(...tabs(TABS, st.tab, (key) => ((st.tab = key), history.replaceState(null, '', `#/tooling${qs(st)}`), paint())).children);
    body.replaceChildren(spinner('loading…'));
    try {
      const node = await builders[st.tab]();
      body.replaceChildren(node);
    } catch (err) {
      body.replaceChildren(errorBox(err));
    }
  }

  const builders = {
    items: () => registerTab(false),
    deleted: () => registerTab(true),
    sets: setsTab,
    duplicates: duplicatesTab,
    check: checkTab,
    dimensions: dimensionTab,
  };

  async function registerTab(deleted) {
    const params = { ...st };
    if (deleted) params.deleted = '1';
    delete params.tab;
    const out = await api.get(`/api/tooling${qs(params)}`);
    const cols = [
      {
        label: 'photo',
        render: (t) =>
          t.primary_image_id
            ? h('img', { class: 'thumb', src: `/api/files/images/${t.primary_image_id}`, alt: '', loading: 'lazy' })
            : h('span', { class: 'thumb none' }, t.icon || '—'),
      },
      { label: 'tooling id', render: (t) => h('div', null, h('b', { class: 'code' }, t.tooling_id), h('div', { class: 'tiny muted' }, t.type_name)) },
      { label: 'name', render: (t) => h('div', null, t.name, t.rubber_profile || t.letter_type ? h('div', { class: 'tiny muted' }, [t.rubber_profile && `profile ${t.rubber_profile}`, t.letter_type && `letters ${t.letter_type}`].filter(Boolean).join(' · ')) : null) },
      { label: 'size', render: (t) => h('span', { class: 'tiny' }, sizeString(t, ['overall_length_mm', 'overall_width_mm', 'overall_height_mm'])) },
      { label: 'qty', render: (t) => (t.quantity > 1 ? badge(`×${t.quantity}`, 'warn') : '1') },
      { label: 'status', render: (t) => statusBadge(t.status) },
      { label: 'condition', render: (t) => (t.condition_rating ? badge(t.condition_rating.replace(/_/g, ' ').toLowerCase(), t.condition_rating === 'DAMAGED' ? 'danger' : t.condition_rating === 'WORN' ? 'warn' : 'ok') : '-') },
      {
        label: 'where',
        render: (t) =>
          t.location_code
            ? h('a', { class: 'code', href: `#/locations/${t.location_id}`, onclick: (e) => (e.stopPropagation(), openLocation(t.location_id)) }, t.location_code)
            : t.external_location
              ? h('span', { class: 'tiny' }, t.external_location)
              : h('span', { class: 'tiny danger-text' }, 'no shelf'),
      },
      { label: 'cycles', render: (t) => (t.max_cycles ? meter(Number(t.total_cycles || 0), Number(t.max_cycles), `${t.total_cycles || 0}/${t.max_cycles}`) : String(t.total_cycles ?? 0)) },
      { label: 'main filter', render: (t) => (t.filter_number ? h('a', { class: 'code', href: `#/filters/${encodeURIComponent(t.filter_number)}`, onclick: (e) => (e.stopPropagation(), openFilter(t.filter_number)) }, t.filter_number) : '-') },
      { label: 'maintenance', render: (t) => (t.next_maintenance_date ? h('span', { class: `tiny ${daysUntil(t.next_maintenance_date) < 0 ? 'danger-text' : 'muted'}` }, `${dateOnly(t.next_maintenance_date)} (${daysUntil(t.next_maintenance_date)}d)`) : '-') },
    ];
    const bar = h(
      'div',
      { class: 'filters' },
      chipSelect('type', 'category', (meta.data?.tooling_types || []).map((t) => ({ value: t.code, label: `${t.icon || ''} ${t.name}` }))),
      chipSelect('status', 'status', (meta.data?.tooling_statuses || []).map((s) => ({ value: s.code, label: `${s.dot} ${s.label}` }))),
      chipSelect('maintenance_due', 'maintenance', [{ value: '1', label: 'due in 14 days' }]),
      chipSelect('cycle_warning', 'cycles', [{ value: '1', label: 'near the cycle limit' }]),
      chipSelect('no_location', 'shelf', [{ value: '1', label: 'has no shelf' }]),
      chipSelect('open_damage', 'damage', [{ value: '1', label: 'open damage report' }]),
    );
    return h(
      'div',
      null,
      deleted ? notice('warn', 'archived tooling is hidden from search and links, and can be restored') : null,
      bar,
      table(cols, out.items, { onRowOpen: (t) => openTooling(deleted ? t.id : t.tooling_id), emptyText: 'nothing matches — clear a filter or check the spelling' }),
      pager(out.pagination, (page) => ((st.page = page), paint())),
      deleted
        ? null
        : h(
            'div',
            { class: 'btn-row', style: 'margin-top:10px' },
            can('tooling.create') ? button('＋ new tooling record', { kind: 'primary', onClick: () => newToolingDialog() }) : null,
            can('labels.print') ? button('🏷 print labels for these', { kind: 'ghost', onClick: () => printToolLabels(out.items) }) : null,
            button('⬇ excel', { kind: 'ghost', onClick: () => downloadWith(`/api/export/tooling.xlsx${qs({ q: st.q, type: st.type, status: st.status })}`, 'tooling.xlsx') }),
          ),
    );
  }

  function chipSelect(key, label, options) {
    const el = h('select', null, h('option', { value: '' }, `— ${label} —`), ...options.map((o) => h('option', { value: o.value }, o.label)));
    el.value = st[key] || '';
    el.addEventListener('change', () => {
      st[key] = el.value;
      st.page = 1;
      paint();
    });
    return h('div', { class: 'field' }, h('label', null, label), el);
  }

  async function printToolLabels(items) {
    if (!items?.length) return toast('nothing to print', 'error');
    const values = await formDialog({
      title: 'print labels',
      subtitle: `${items.length} label(s) on this page`,
      fields: [
        { key: 'template_id', label: 'template', type: 'select', options: await api.get('/api/labels/templates?kind=TOOLING').then((r) => r.items.map((t) => ({ value: t.id, label: `${t.name} (${t.width_mm}×${t.height_mm}mm${t.is_default ? ', default' : ''}` }))) },
        { key: 'all_page', label: 'print every label on this page', type: 'checkbox', initial: true },
      ],
    });
    if (!values) return;
    try {
      const out = await api.post('/api/labels/sheet', { kind: 'tooling', ids: items.map((i) => i.id), template_id: values.template_id ? Number(values.template_id) : undefined });
      printHtml(out.html);
      toast(`${out.count} label(s) ready`, 'ok');
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function setsTab() {
    const out = await api.get('/api/tooling/sets/list?limit=100');
    const cards = h('div', { class: 'tiles' });
    for (const s of out.items) {
      const statuses = String(s.item_status || '')
        .split('|')
        .filter(Boolean)
        .map((x) => {
          const [code, status] = x.split(':');
          return { code, status };
        });
      const tone = s.status === 'COMPLETE' ? 'ok' : s.status === 'PARTIAL' ? 'warn' : 'danger';
      cards.appendChild(
        h(
          'div',
          { class: `card set-card ${tone}`, onclick: () => showSet(s.id) },
          h(
            'div',
            { class: 'card-body' },
            h('div', { class: 'line-1' }, h('b', { class: 'code' }, s.code), h('span', { class: 'grow' }), badge(String(s.status).toLowerCase(), tone)),
            h('p', { class: 'small' }, s.name || ''),
            s.filter_number ? h('p', { class: 'tiny' }, 'for filter ', h('a', { class: 'code', href: `#/filters/${encodeURIComponent(s.filter_number)}`, onclick: (e) => (e.stopPropagation(), openFilter(s.filter_number)) }, s.filter_number)) : null,
            meter(Number(s.linked_count ?? statuses.length), Number(s.required_count || statuses.length || 1), `${s.linked_count ?? statuses.length} of ${s.required_count ?? '?'} present`),
            h('div', { class: 'chips', style: 'margin-top:6px' }, statuses.map((x) => badge(x.code, x.status === 'AVAILABLE' ? 'ok' : x.status === 'IN_USE' ? 'warn' : x.status === 'MISSING' || x.status === 'DAMAGED' ? 'danger' : ''))),
          ),
        ),
      );
    }
    return h(
      'div',
      null,
      card(
        {
          title: 'tooling sets',
          subtitle: 'e.g. a housing + 4 insert sets for one filter — auto-marked COMPLETE when every member exists',
          actions: can('tooling_sets.manage') ? button('＋ new set', { kind: 'primary small', onClick: () => newSetDialog(paint) }) : null,
        },
        out.items.length ? cards : empty('no sets yet', 'a set groups the tools that only make sense together'),
      ),
    );
  }

  async function showSet(id) {
    const d = await api.get(`/api/tooling/sets/list/${id}`);
    const dialog = modal({
      title: d.set.code,
      subtitle: `${d.set.name} · ${d.set.status} · ${d.items.length} item(s)`,
      wide: true,
      body: h(
        'div',
        null,
        d.set.filter_number ? h('p', null, 'filter: ', h('a', { class: 'code', href: `#/filters/${encodeURIComponent(d.set.filter_number)}` }, d.set.filter_number)) : null,
        table(
          [
            { label: 'tooling', render: (t) => h('b', { class: 'code' }, t.tooling_id) },
            { label: 'name', key: 'name' },
            { label: 'category', render: (t) => `${t.icon || ''} ${t.type_name}` },
            { label: 'status', render: (t) => statusBadge(t.status) },
            { label: 'shelf', render: (t) => t.location_code || t.external_location || '—' },
          ],
          d.items,
          { onRowOpen: (t) => (dialog.close(), openTooling(t.tooling_id)) },
        ),
        d.requirements.length
          ? h(
              'div',
              null,
              h('div', { class: 'group-title' }, 'requirement coverage'),
              table([{ label: 'category', key: 'type_name' }, { label: 'required', key: 'quantity_required' }, { label: 'have', key: 'have' }], d.requirements),
            )
          : null,
      ),
      actions: h(
        'div',
        { class: 'btn-row end' },
        can('tooling_sets.manage')
          ? button('re-check completeness', {
              kind: 'ghost',
              onClick: async () => {
                await api.post(`/api/tooling/sets/list/${id}/refresh`, {});
                toast('set re-checked', 'ok');
                dialog.close();
                paint();
              },
            })
          : null,
        button('close', { kind: 'ghost', onClick: () => dialog.close() }),
      ),
    });
  }

  async function newSetDialog(after) {
    const values = await formDialog({
      title: 'new tooling set',
      fields: [
        { key: 'code', label: 'set code', required: true, placeholder: 'SET-SPIN76' },
        { key: 'name', label: 'name', placeholder: 'Ø76 spin-on set' },
        { key: 'notes', label: 'notes', type: 'textarea', wide: true },
      ],
    });
    if (!values) return;
    try {
      const created = await api.post('/api/tooling/sets/list', values);
      toast(`set ${created.code} created`, 'ok');
      after?.();
    } catch (err) {
      toast(err.message, 'error', 8000);
    }
  }

  async function duplicatesTab() {
    const box = h('div', null, spinner('reading the open duplicate list…'));
    const draw = async () => {
      const out = await api.get('/api/tooling/duplicates/open');
      box.replaceChildren(
        h(
          'div',
          null,
          notice('info', `similarity threshold ${out.threshold}% — pairs above it need a human decision before new tooling is made`),
          table(
            [
              { label: 'similarity', render: (d) => badge(`${d.similarity_pct}%`, d.similarity_pct >= 97 ? 'danger' : 'warn') },
              {
                label: 'pair',
                render: (d) =>
                  h(
                    'div',
                    null,
                    h('a', { class: 'code', href: `#/tooling/${encodeURIComponent(d.code_a)}` }, d.code_a),
                    ' vs ',
                    h('a', { class: 'code', href: `#/tooling/${encodeURIComponent(d.code_b)}` }, d.code_b),
                    h('div', { class: 'tiny muted' }, `${d.name_a} / ${d.name_b}`),
                    h('div', { class: 'tiny muted' }, `${d.la ?? '?'}×${d.wa ?? '?'}×${d.ha ?? '?'} vs ${d.lb ?? '?'}×${d.wb ?? '?'}×${d.hb ?? '?'}`),
                  ),
              },
              { label: 'why', render: (d) => h('span', { class: 'tiny' }, String(d.reasons || d.reason || '').split(',').join(' · ')) },
              { label: 'shelves', render: (d) => h('span', { class: 'tiny' }, `${d.location_a || '-'} / ${d.location_b || '-'}`) },
              { label: 'status', render: (d) => h('span', null, badge(String(d.status).toLowerCase(), d.status === 'OPEN' ? 'warn' : 'ok')) },
              {
                label: 'decision',
                render: (d) =>
                  can('tooling.update')
                    ? buttons([
                        { label: 'same tool', kind: 'ghost small', onClick: () => review(d.id, 'CONFIRMED_DUPLICATE') },
                        { label: 'not a dup', kind: 'ghost small', onClick: () => review(d.id, 'RESOLVED', '__keep__') },
                        { label: 'ignore', kind: 'ghost small', onClick: () => review(d.id, 'IGNORED') },
                      ])
                    : null,
              },
            ],
            out.items,
            { emptyText: 'no open duplicate flags — the register is clean right now' },
          ),
          h(
            'div',
            { class: 'btn-row', style: 'margin-top:10px' },
            button('🔁 re-scan the whole register', {
              kind: 'primary',
              onClick: async () => {
                box.replaceChildren(spinner('comparing every tool with every tool of the same category…'));
                const r = await api.get('/api/tooling/duplicates/scan?min_similarity=88');
                toast(`scan finished — ${r.flagged} pair(s) flagged`, 'ok');
                draw();
              },
            }),
            button('compare side by side', { kind: 'ghost', onClick: () => go('/compare') }),
          ),
        ),
      );
    };
    async function review(id, status, notes) {
      try {
        await api.post(`/api/tooling/duplicates/${id}/review`, { status, notes: notes ?? 'reviewed from the tooling register' });
        draw();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    await draw();
    return box;
  }

  async function checkTab() {
    const fields = [
      { key: 'length', label: 'length (mm)', type: 'number', step: '0.1' },
      { key: 'width', label: 'width (mm)', type: 'number', step: '0.1' },
      { key: 'height', label: 'height (mm)', type: 'number', step: '0.1' },
      { key: 'diameter', label: 'overall diameter (mm)', type: 'number', step: '0.1' },
      { key: 'tolerance_mm', label: 'tolerance ± mm', type: 'number', step: '0.5', initial: 2 },
      { key: 'tooling_type', label: 'tooling category', type: 'select', options: (meta.data?.tooling_types || []).map((t) => ({ value: t.code, label: t.name })) },
      { key: 'filter_type', label: 'filter type', type: 'select', options: (meta.data?.filter_types || []).map((t) => ({ value: t.code, label: t.name })) },
      { key: 'rubber_profile', label: 'rubber profile', placeholder: 'e.g. P-4' },
      { key: 'letter_type', label: 'letter type', placeholder: 'e.g. A-Z 6mm' },
    ];
    const f = form(fields, { tolerance_mm: 2 });
    const out = h('div', null, notice('info', 'answer this before ordering new tooling: type the size you need and check whether something in the register already fits'));
    const run = async () => {
      out.replaceChildren(spinner('checking the register…'));
      try {
        const values = f.values();
        const r = await api.post('/api/filters/check-existing', { ...values, unit: 'mm' });
        const verdict = h(
          'div',
          { class: `banner ${r.tooling.length || r.similar_filters.length ? 'ready' : 'blocked'}` },
          h('div', { style: 'font-size:28px' }, r.tooling.length || r.similar_filters.length ? '✅' : '🛠'),
          h('div', null, h('div', { class: 'big' }, r.conclusion), h('div', { class: 'why' }, `queried ${JSON.stringify(r.query)}`)),
        );
        const tools = r.tooling.length
          ? table(
              [
                { label: 'tooling', render: (t) => h('a', { class: 'code', href: `#/tooling/${encodeURIComponent(t.tooling_id)}` }, t.tooling_id) },
                { label: 'name', key: 'name' },
                { label: 'size', render: (t) => sizeString(t.dimensions ?? t, ['overall_length_mm', 'overall_width_mm', 'overall_height_mm']) },
                { label: 'match', render: (t) => (t.match_pct ? badge(`${t.match_pct}%`, 'ok') : '') },
                { label: 'status', render: (t) => statusBadge(t.status) },
                { label: 'shelf', render: (t) => t.location?.code || t.location_code || '—' },
              ],
              r.tooling,
            )
          : notice('warn', 'no tooling in the register matches that size');
        const similar = r.similar_filters.length
          ? h(
              'div',
              null,
              h('div', { class: 'group-title' }, 'filters of the same size — their tooling is probably reusable'),
              table(
                [
                  { label: 'filter', render: (x) => h('a', { class: 'code', href: `#/filters/${encodeURIComponent(x.internal_number)}` }, x.internal_number) },
                  { label: 'name', key: 'name' },
                  { label: 'size', render: (x) => [x.length_mm, x.width_mm, x.height_mm].filter((v) => v !== null && v !== undefined).map((v) => mm(v)).join(' × ') },
                  { label: 'tools', key: 'tool_count' },
                  { label: 'list', render: (x) => h('span', { class: 'tiny muted' }, x.tooling || '') },
                ],
                r.similar_filters,
              ),
            )
          : null;
        out.replaceChildren(
          verdict,
          h('div', { style: 'margin-top:10px' }, tools),
          similar,
          r.request_draft
            ? h('div', { class: 'btn-row', style: 'margin-top:10px' }, button('raise a tooling request instead', { kind: 'danger', onClick: () => go('/requests', { prefill: r.request_draft.title }) }))
            : null,
        );
      } catch (err) {
        out.replaceChildren(errorBox(err));
      }
    };
    return card(
      { title: 'do we already have this tool?', subtitle: 'pre-manufacture check against the live register' },
      f.node,
      h('div', { class: 'btn-row', style: 'margin-top:8px' }, button('check', { kind: 'primary', onClick: run })),
      h('div', { style: 'margin-top:12px' }, out),
    );
  }

  async function dimensionTab() {
    const f = form([
      { key: 'length', label: 'length (mm)', type: 'number', step: '0.1' },
      { key: 'width', label: 'width (mm)', type: 'number', step: '0.1' },
      { key: 'height', label: 'height (mm)', type: 'number', step: '0.1' },
      { key: 'diameter', label: 'diameter (mm)', type: 'number', step: '0.1' },
      { key: 'tolerance', label: '± tolerance (mm)', type: 'number', step: '0.5', initial: 2 },
      { key: 'unit', label: 'unit', type: 'select', options: ['mm', 'cm', 'in'], initial: unitPreference() },
      { key: 'type_code', label: 'category', type: 'select', options: (meta.data?.tooling_types || []).map((t) => ({ value: t.code, label: t.name })) },
      { key: 'limit', label: 'max results', type: 'number', initial: 25 },
    ]);
    const out = h('div', null, notice('info', 'the tooling register stores every dimension in mm; enter whatever unit you prefer and it converts'));
    const run = async () => {
      out.replaceChildren(spinner('measuring…'));
      try {
        const r = await api.get(`/api/tooling/dimension-search${qs({ ...f.values(), limit: f.values().limit || 25 })}`);
        out.replaceChildren(
          h('p', { class: 'tiny muted' }, `${r.count ?? r.items?.length ?? 0} item(s)${r.pattern ? ` · ${r.pattern}` : ''}`),
          table(
            [
              { label: 'tooling', render: (t) => h('a', { class: 'code', href: `#/tooling/${encodeURIComponent(t.tooling_id)}` }, t.tooling_id) },
              { label: 'name', key: 'name' },
              { label: 'category', render: (t) => t.type_name || '' },
              { label: 'size', render: (t) => sizeString(t.dimensions ?? t, ['overall_length_mm', 'overall_width_mm', 'overall_height_mm'], f.values().unit) },
              { label: 'match', render: (t) => (t.match_pct ? h('b', null, `${t.match_pct}%`) : '') },
              { label: 'status', render: (t) => statusBadge(t.status) },
              { label: 'shelf', render: (t) => t.location_code || t.location?.code || '—' },
            ],
            r.items || [],
            { onRowOpen: (t) => openTooling(t.tooling_id) },
          ),
        );
      } catch (err) {
        out.replaceChildren(errorBox(err));
      }
    };
    return card({ title: 'find tooling by size', subtitle: '± tolerance in mm, ranked by closeness' }, f.node, h('div', { class: 'btn-row', style: 'margin-top:8px' }, button('search by size', { kind: 'primary', onClick: run })), h('div', { style: 'margin-top:12px' }, out));
  }

  const node = h(
    'div',
    null,
    h(
      'div',
      { class: 'section-title' },
      h('h1', null, 'tooling register'),
      h('span', { class: 'sub' }, 'housings, inserts, cutters, molds, fixtures, jigs, templates'),
      h('span', { class: 'grow' }),
      can('tooling.create') ? button('＋ new tool', { kind: 'primary', onClick: () => newToolingDialog() }) : null,
      button('📷 scan', { kind: 'ghost', onClick: async () => { const s = await openScanner({ title: 'scan a tool label' }); if (s) { const found = await api.post('/api/labels/scan', { code: s.code }); openTooling(found.code); } } }),
    ),
    tabbar,
    card({ dense: true }, search),
    body,
  );
  await paint();
  return node;
}

/* ----------------------------------------------------- new tooling dialog */
export async function newToolingDialog({ primaryFilterId = null, onCreated } = {}) {
  const types = await api.get('/api/tooling/types/list').then((r) => r.items);
  const groups = [...new Set(types.map((t) => t.group_name || 'other'))];
  const options = types.map((t) => ({ value: t.id, label: `${t.icon || ''} ${t.name}${t.id_prefix ? ` (${t.id_prefix})` : ''}` }));
  const fields = [
    { key: 'name', label: 'what is it', required: true, placeholder: 'Housing for Ø76 spin-on, 2-letter logo', wide: true },
    { key: 'tooling_type_id', label: 'category', type: 'select', required: true, options, emptyLabel: '— pick a category —' },
    { key: 'auto_id_type', label: 'auto number from category', type: 'checkbox', initial: true, help: 'leaves the ID to the numbering rule (e.g. H-00452-A)' },
    { key: 'tooling_id', label: 'or force this tooling id', placeholder: 'H-00452-A' },
    { key: 'quantity', label: 'how many physical copies', type: 'number', min: 1, initial: 1 },
    { key: 'primary_filter_id', label: 'primary filter id', type: 'number', initial: primaryFilterId || undefined, help: 'optional — numeric filter id' },
    { key: 'status', label: 'status', type: 'select', options: (meta.data?.tooling_statuses || []).map((s) => ({ value: s.code, label: s.label })), initial: 'AVAILABLE' },
    { key: 'condition_rating', label: 'condition', type: 'select', options: (meta.data?.condition_ratings || []).map((c) => ({ value: typeof c === 'string' ? c : c.code, label: typeof c === 'string' ? c.toLowerCase() : c.code })) },
    { key: 'material', label: 'material', placeholder: '1.2344 hardened tool steel' },
    { key: 'manufacturer', label: 'made by' },
    { key: 'supplier', label: 'supplier' },
    { key: 'serial_number', label: 'serial number' },
    { key: 'weight_grams', label: 'weight (g)', type: 'number', min: 0 },
    { key: 'rubber_profile', label: 'rubber profile', placeholder: 'P-4' },
    { key: 'letter_type', label: 'letter set / size', placeholder: 'A-Z 6 mm' },
    { key: 'logo_ref', label: 'logo reference' },
    { key: 'max_cycles', label: 'max cycles', type: 'number', min: 1, help: 'leave empty if the tool is not cycle limited' },
    { key: 'cycle_warning_pct', label: 'warn at % of life', type: 'number', min: 50, max: 100, initial: 85 },
    { key: 'maintenance_interval_days', label: 'maintenance every (days)', type: 'number', min: 1, initial: 180 },
    { key: 'maintenance_interval_cycles', label: '…or every (cycles)', type: 'number', min: 1 },
    { key: 'cost', label: 'cost', type: 'number', min: 0, step: '0.01' },
    { key: 'manufacturing_date', label: 'manufactured', type: 'date' },
    { key: 'purchase_date', label: 'purchased', type: 'date' },
    { key: 'external_location', label: 'where it physically is now', placeholder: 'Tool room A, or Line 2', wide: true },
    { key: 'notes', label: 'notes', type: 'textarea', wide: true },
  ];
  const values = await formDialog({ title: 'new tooling record', subtitle: `numbering prefixes: ${groups.map((g) => g).join(', ')}`, wide: true, fields, submitLabel: 'create' });
  if (!values) return null;
  const body = { ...values };
  if (body.auto_id_type) delete body.tooling_id;
  if (body.tooling_type_id) body.tooling_type_id = Number(body.tooling_type_id);
  if (body.primary_filter_id) body.primary_filter_id = Number(body.primary_filter_id);
  delete body.auto_id_type;
  try {
    const created = await api.post('/api/tooling', body);
    toast(`${created.tool.tooling_id} created`, 'ok');
    statusCounts();
    onCreated?.(created);
    openTooling(created.tool.tooling_id);
    return created;
  } catch (err) {
    toast(err.message, 'error', 10000);
    return null;
  }
}

/* =========================================================== tool detail */
async function ToolDetailView(mount, route) {
  const ref = route.segments[1];
  const box = h('div', null, spinner('loading the tool…'));
  let d = null;

  async function reload() {
    box.replaceChildren(spinner('loading the tool…'));
    try {
      const path = /^\d+$/.test(ref) ? `/api/tooling/${ref}` : `/api/tooling/code/${encodeURIComponent(ref)}`;
      d = await api.get(`${path}${qs({ unit: unitPreference() })}`);
      box.replaceChildren(detailNode(d));
    } catch (err) {
      box.replaceChildren(card({ title: 'tooling not found' }, errorBox(err), h('div', { style: 'margin-top:10px' }, button('back to the register', { kind: 'ghost', onClick: () => go('/tooling') }))));
    }
  }

  function detailNode(rec) {
    const t = rec.tool;
    const life = rec.life || {};
    const actions = buttons([
      button('back', { kind: 'ghost small', onClick: () => (history.length > 1 ? back() : go('/tooling')) }),
      can('tooling.move') ? button('🚚 take / move / return', { kind: 'primary small', onClick: () => moveTool(t) }) : null,
      can('tooling.update') ? button('🩹 report damage', { kind: 'danger small', onClick: () => reportDamage(t) }) : null,
      can('tooling.update') ? button('edit', { kind: 'ghost small', onClick: () => editTool(t) }) : null,
      can('files.manage') ? button('＋ photos', { kind: 'ghost small', onClick: () => uploadToolPhotos(t) }) : null,
      can('labels.print') ? button('🏷 label', { kind: 'ghost small', onClick: () => showCodes(t) }) : null,
      can('tooling.update') ? button('compare', { kind: 'ghost small', onClick: () => go('/compare', { ids: [t.tooling_id].join(',') }) }) : null,
    ]);

    const where = card(
      { kind: t.location_code ? 'where' : 'where bad' },
      h('div', { class: 'where-label' }, 'where is it'),
      h('div', { class: 'where-code' }, t.location_code || t.external_location || 'NOT RECORDED'),
      t.location_path ? h('div', { class: 'tiny muted center' }, t.location_path) : null,
      h(
        'div',
        { class: 'btn-row center', style: 'justify-content:center;margin-top:8px' },
        t.location_id ? button('open the shelf', { kind: 'ghost small', onClick: () => openLocation(t.location_id) }) : null,
        can('tooling.move') ? button(t.location_id ? 'move it' : 'assign a shelf', { kind: 'primary small', onClick: () => moveTool(t, { mode: t.location_id ? 'MOVE' : 'RETURN' }) }) : null,
      ),
      rec.next_suggested_location?.items?.length
        ? h(
            'div',
            { style: 'margin-top:10px' },
            h('div', { class: 'tiny muted' }, 'suggested free shelves for this size:'),
            h(
              'div',
              { class: 'chips' },
              rec.next_suggested_location.items.slice(0, 4).map((s) =>
                h(
                  'button',
                  {
                    class: 'chip',
                    type: 'button',
                    onclick: async () => {
                      if (!(await confirmDialog(`assign ${s.full_code} to ${t.tooling_id}?`, { confirmLabel: 'assign' }))) return;
                      try {
                        await api.post(`/api/tooling/${t.id}/move`, { action: 'MOVE', location_id: s.id, reason: 'ASSIGNED', note: 'suggested location' });
                        toast('shelf assigned', 'ok');
                        reload();
                      } catch (err) {
                        toast(err.message, 'error', 8000);
                      }
                    },
                  },
                  `${s.full_code} · ${s.free ?? '?'} free`,
                ),
              ),
            ),
          )
        : null,
    );

    const facts = card(
      { title: 'identity', subtitle: `revision ${t.current_revision ?? 1}` },
      kv([
        ['category', `${t.icon || ''} ${t.type_name}`],
        ['material', t.material],
        ['made by', t.manufacturer],
        ['supplier', t.supplier],
        ['serial', t.serial_number],
        ['rubber profile', t.rubber_profile],
        ['letters / logo', [t.letter_type, t.logo_ref].filter(Boolean).join(' + ')],
        ['copies', String(t.quantity)],
        ['reserved', t.reserved_qty ? `${t.reserved_qty} pcs` : '—'],
        ['weight', t.weight_grams ? `${t.weight_grams} g` : null],
        ['built', dateOnly(t.manufacturing_date)],
        ['bought', dateOnly(t.purchase_date)],
        ['cost', t.cost ? `${t.cost}` : null],
        ['last used', t.last_used_at ? when(t.last_used_at) : 'never recorded'],
      ]),
      t.notes ? h('p', { class: 'small muted' }, t.notes) : null,
    );

    const dims = card(
      {
        title: 'dimensions',
        subtitle: 'stored in mm, shown in your unit',
        actions: buttons([UnitToggle(() => reload()), can('tooling.update') ? button('edit', { kind: 'ghost small', onClick: () => editDimensions(t) }) : null]),
      },
      dimensionTable(rec.dimensions, rec.custom_fields),
    );

    const lifeCard = card(
      { title: 'life & usage', subtitle: 'counters only ever move forward' },
      life.max
        ? h(
            'div',
            null,
            meter(Number(life.total), Number(life.max), `${life.total} of ${life.max} cycles (${life.used_pct}% used)`),
            life.exceeded ? notice('error', 'cycle limit exceeded — inspect before the next run') : life.warn ? notice('warn', `only ${life.remaining} cycles left`) : null,
          )
        : notice('info', `${life.total ?? 0} cycles logged — no limit set for this tool`),
      kv([
        ['parts produced', t.total_parts_produced ?? 0],
        ['cycles', life.total ?? 0],
        ['limit', life.max ?? 'none'],
        ['last maintenance', dateOnly(t.last_maintenance_date)],
        ['next maintenance', t.next_maintenance_date ? `${dateOnly(t.next_maintenance_date)} (${daysUntil(t.next_maintenance_date)} days)` : 'not scheduled'],
      ]),
      h(
        'div',
        { class: 'btn-row', style: 'margin-top:8px' },
        can('tooling.move') ? button('log usage', { kind: 'ghost small', onClick: () => logUsage(t) }) : null,
        can('tooling.inspect') ? button('adjust cycle counter', { kind: 'ghost small', onClick: () => adjustCycles(t) }) : null,
        can('tooling.reserve') ? button('reserve for an order', { kind: 'ghost small', onClick: () => reserveTool(t) }) : null,
      ),
    );

    const compat = card(
      {
        title: 'filters this tool is used for',
        subtitle: `${(rec.compatibility || []).length} link(s)`,
        actions: can('compatibility.manage') ? button('＋ link filter', { kind: 'ghost small', onClick: () => linkFilter(t) }) : null,
      },
      table(
        [
          { label: 'filter', render: (c) => h('a', { class: 'code', href: `#/filters/${encodeURIComponent(c.internal_number)}` }, c.internal_number) },
          { label: 'name', key: 'name' },
          { label: 'type', render: (c) => c.type_name },
          { label: 'level', render: (c) => badge(c.is_primary ? 'primary' : c.compatibility_level, c.is_primary ? 'ok' : '') },
          { label: 'note', render: (c) => h('span', { class: 'tiny muted' }, c.note || '') },
          { label: '', render: (c) => (can('compatibility.manage') ? h('button', { class: 'chip-x', onclick: () => unlink(t, c), title: 'unlink' }, '×') : null) },
        ],
        rec.compatibility || [],
        { onRowOpen: (c) => openFilter(c.internal_number), emptyText: 'no filter linked yet — the tool exists but nothing uses it' },
      ),
    );

    const movements = card(
      { title: 'movement history', subtitle: 'nothing is ever deleted, only added to', actions: button('full history', { kind: 'ghost small', onClick: () => go('/movements', { tool: t.tooling_id }) }) },
      table(
        [
          { label: 'when', render: (m) => h('span', { class: 'nowrap tiny' }, when(m.created_at)) },
          { label: 'action', render: (m) => badge(m.movement_type, m.movement_type === 'TAKE' ? 'warn' : m.movement_type === 'RETURN' ? 'ok' : '') },
          { label: 'from', render: (m) => m.from_location_code || m.external_location_before || '—' },
          { label: 'to', render: (m) => m.to_location_code || m.external_location_after || '—' },
          { label: 'qty', key: 'quantity' },
          { label: 'by', render: (m) => m.user_name || m.username },
          { label: 'note', render: (m) => h('span', { class: 'tiny muted' }, m.note || '') },
        ],
        rec.movements || [],
        { emptyText: 'no movements recorded — the tool has not left its shelf' },
      ),
    );

    const maint = card(
      { title: 'maintenance & damage', actions: can('maintenance.create') ? button('＋ schedule', { kind: 'ghost small', onClick: () => scheduleMaintenance(t) }) : null },
      table(
        [
          { label: 'planned', render: (m) => dateOnly(m.scheduled_date) },
          { label: 'done', render: (m) => dateOnly(m.completed_date) || '—' },
          { label: 'type', render: (m) => String(m.maintenance_type || '').replace(/_/g, ' ') },
          { label: 'summary', render: (m) => m.summary || m.description || '' },
          { label: 'by', render: (m) => m.created_by_name || '' },
          { label: 'status', render: (m) => badge(String(m.status).toLowerCase(), m.status === 'COMPLETED' ? 'ok' : m.status === 'OVERDUE' ? 'danger' : 'warn') },
        ],
        rec.maintenance || [],
        { emptyText: 'no maintenance logged' },
      ),
      (rec.damage_reports || []).length
        ? h(
            'div',
            null,
            h('div', { class: 'group-title' }, 'damage reports'),
            table(
              [
                { label: 'report', render: (x) => h('b', { class: 'code' }, x.report_no) },
                { label: 'type', key: 'damage_type' },
                { label: 'severity', render: (x) => badge(String(x.severity).toLowerCase(), ['HIGH', 'CRITICAL'].includes(x.severity) ? 'danger' : 'warn') },
                { label: 'what', render: (x) => h('span', { class: 'tiny' }, x.description) },
                { label: 'status', render: (x) => badge(String(x.status).toLowerCase(), x.status === 'OPEN' ? 'danger' : 'ok') },
              ],
              rec.damage_reports,
            ),
          )
        : null,
    );

    const revisions = card(
      { title: 'revisions', subtitle: 'the record is never overwritten — old versions stay', actions: can('revisions.manage') ? button('＋ new revision', { kind: 'ghost small', onClick: () => newRevision(t) }) : null },
      h(
        'div',
        { class: 'timeline' },
        (rec.revisions || []).map((r) =>
          h(
            'div',
            { class: 'tl' },
            h('span', { class: 'dot' }),
            h(
              'div',
              null,
              h('b', null, `rev ${r.revision_no}`),
              ' · ',
              r.change_summary || '',
              h('div', { class: 'when' }, `${r.created_by_name || ''} · ${when(r.created_at)}${r.designer ? ` · design ${r.designer}` : ''}${r.material ? ` · ${r.material}` : ''}`),
            ),
          ),
        ),
      ),
      (rec.revisions || []).length ? null : empty('no revision snapshots yet'),
    );

    const media = card(
      { title: 'photos, CAD & drawings', subtitle: `${(rec.images || []).length} photo(s) · ${(rec.documents || []).length} file(s)` },
      photoGrid(rec.images || [], { onOpen: (img) => lightbox(img.url, img.caption || img.filename), hint: 'a photo is what stops people making the wrong tool' }),
      (rec.documents || []).length
        ? table(
            [
              { label: 'file', render: (doc) => h('b', null, doc.original_name) },
              { label: 'kind', render: (doc) => badge(String(doc.doc_type).toLowerCase()) },
              { label: 'size', render: (doc) => `${(doc.size_bytes / 1024).toFixed(0)} KB` },
              { label: 'rev', render: (doc) => (doc.version_no ? `v${doc.version_no}` : '') },
              { label: 'added', render: (doc) => h('span', { class: 'tiny muted' }, dateOnly(doc.created_at)) },
              { label: '', render: (doc) => h('a', { class: 'btn small ghost', href: doc.url, target: '_blank', rel: 'noopener' }, 'open') },
            ],
            rec.documents,
          )
        : null,
      can('files.manage')
        ? h(
            'div',
            { class: 'btn-row', style: 'margin-top:8px' },
            button('＋ upload photo', { kind: 'ghost small', onClick: () => uploadToolPhotos(t) }),
            button('＋ upload CAD / drawing', { kind: 'ghost small', onClick: () => uploadToolDocs(t) }),
          )
        : null,
    );

    const dupes = (rec.duplicate_flags?.candidates || []).length
      ? card(
          { title: 'possible duplicates', subtitle: `${rec.duplicate_flags.candidates.length} tool(s) look very similar` },
          table(
            [
              { label: 'tooling', render: (x) => h('a', { class: 'code', href: `#/tooling/${encodeURIComponent(x.tooling_id)}` }, x.tooling_id) },
              { label: 'name', key: 'name' },
              { label: 'similarity', render: (x) => badge(`${x.similarity_pct}%`, x.similarity_pct >= 95 ? 'danger' : 'warn') },
              { label: 'why', render: (x) => h('span', { class: 'tiny muted' }, (x.reasons || []).join(' · ')) },
            ],
            rec.duplicate_flags.candidates,
            { onRowOpen: (x) => (recIds.length === 3 ? toast('compare holds 3 at a time', 'error') : (recIds.push(x.id), toast(`${x.tooling_id} added to the compare tray`, 'ok'))) }
          ),
        )
      : null;

    return h(
      'div',
      null,
      h(
        'div',
        { class: 'section-title' },
        h(
          'div',
          null,
          h('div', { class: 'chips' }, badge(`${t.icon || ''} ${t.type_name}`), statusBadge(t.status), t.condition_rating ? badge(t.condition_rating.replace(/_/g, ' ').toLowerCase(), t.condition_rating === 'DAMAGED' ? 'danger' : '') : null, t.deleted_at ? badge('archived', 'danger') : null),
          h('h1', { class: 'code mono-title' }, t.tooling_id),
          h('div', { class: 'sub' }, t.name),
        ),
        h('span', { class: 'grow' }),
        actions,
      ),
      where,
      h('div', { class: 'two-col' }, facts, dims),
      h('div', { class: 'two-col' }, lifeCard, compat),
      media,
      dupes,
      movements,
      h('div', { class: 'two-col' }, maint, revisions),
      can('tooling.manage')
        ? h(
            'div',
            { class: 'btn-row', style: 'margin-top:14px' },
            t.deleted_at
              ? button('restore this record', {
                  kind: 'primary',
                  onClick: async () => (await api.post(`/api/tooling/${t.id}/restore`, {}), toast('restored', 'ok'), go('/tooling', { deleted: '' }), reload()),
                })
              : button('archive (soft delete)', {
                  kind: 'danger',
                  onClick: async () => {
                    if (!(await confirmDialog(`archive ${t.tooling_id}? links and history stay, the tool disappears from search`, { danger: true, confirmLabel: 'archive' }))) return;
                    await api.del(`/api/tooling/${t.id}`);
                    toast('archived', 'ok');
                    statusCounts();
                    go('/tooling');
                  },
                }),
          )
        : null,
    );
  }

  const recIds = [Number(ref) || null].filter(Boolean);

  function dimensionTable(dims, customFields) {
    if (!dims) return notice('warn', 'no dimensions recorded — add them so the size search and duplicate detector can see this tool');
    const fields = meta.data?.dimension_fields?.tooling || [];
    const groups = {};
    for (const f of fields) {
      const value = dims[f.key];
      if (value === null || value === undefined || value === '') continue;
      (groups[f.group || 'other'] ||= []).push({ label: f.label, value: f.unit === 'mm' ? mm(value) : f.unit ? `${value} ${f.unit}` : String(value) });
    }
    let custom = {};
    try {
      custom = typeof dims.custom_values === 'string' ? JSON.parse(dims.custom_values) : dims.custom_values || {};
    } catch {
      custom = {};
    }
    if (Object.keys(custom).length) groups.custom = Object.entries(custom).map(([k, v]) => ({ label: k, value: String(v) }));
    const nodes = [];
    for (const [group, rows] of Object.entries(groups)) {
      nodes.push(h('div', { class: 'group-title' }, group), h('div', { class: 'dim-grid' }, rows.map((r) => h('div', { class: 'dim' }, h('span', null, r.label), h('b', null, r.value)))));
    }
    if (!nodes.length) return notice('warn', 'no dimension values yet');
    return h('div', null, nodes);
  }

  async function editTool(t) {
    const values = await formDialog({
      title: `edit ${t.tooling_id}`,
      wide: true,
      submitLabel: 'save',
      fields: [
        { key: 'name', label: 'name', required: true, wide: true },
        { key: 'status', label: 'status', type: 'select', options: (meta.data?.tooling_statuses || []).map((s) => ({ value: s.code, label: s.label })) },
        { key: 'condition_rating', label: 'condition', type: 'select', options: (meta.data?.condition_ratings || []).map((c) => ({ value: typeof c === 'string' ? c : c.code, label: typeof c === 'string' ? c.toLowerCase() : c.code })) },
        { key: 'quantity', label: 'physical copies', type: 'number', min: 1 },
        { key: 'material', label: 'material' },
        { key: 'manufacturer', label: 'made by' },
        { key: 'supplier', label: 'supplier' },
        { key: 'serial_number', label: 'serial' },
        { key: 'barcode', label: 'barcode text' },
        { key: 'rubber_profile', label: 'rubber profile' },
        { key: 'letter_type', label: 'letter set' },
        { key: 'logo_ref', label: 'logo ref' },
        { key: 'weight_grams', label: 'weight (g)', type: 'number' },
        { key: 'max_cycles', label: 'max cycles', type: 'number' },
        { key: 'cycle_warning_pct', label: 'warn at %', type: 'number' },
        { key: 'maintenance_interval_days', label: 'maintenance every (days)', type: 'number' },
        { key: 'maintenance_interval_cycles', label: '…or every (cycles)', type: 'number' },
        { key: 'cost', label: 'cost', type: 'number' },
        { key: 'manufacturing_date', label: 'manufactured', type: 'date' },
        { key: 'purchase_date', label: 'purchased', type: 'date' },
        { key: 'external_location', label: 'where it is (if not on a shelf)', wide: true },
        { key: 'notes', label: 'notes', type: 'textarea', wide: true },
      ],
      initial: t,
    });
    if (!values) return;
    try {
      await api.put(`/api/tooling/${t.id}`, values);
      toast('saved — a revision snapshot was taken where it matters', 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function editDimensions(t) {
    const fields = (meta.data?.dimension_fields?.tooling || []).map((f) => ({
      key: f.key,
      label: f.label + (f.unit === 'mm' ? ' (mm)' : f.unit ? ` (${f.unit})` : ''),
      type: f.unit === 'mm' || !f.type ? 'number' : 'text',
      step: '0.01',
      help: f.note,
      wide: Boolean(f.note),
    }));
    const dims = d.dimensions || {};
    const values = await formDialog({
      title: 'tooling dimensions',
      subtitle: 'mm is the base unit — other units are generated everywhere in the app',
      wide: true,
      fields,
      initial: dims,
      submitLabel: 'save dimensions',
    });
    if (!values) return;
    try {
      await api.put(`/api/tooling/${t.id}/dimensions`, { unit: 'mm', values, snapshot: true, change_summary: 'Dimensions updated from the register screen' });
      toast('dimensions saved', 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function setStatus(t) {
    const values = await formDialog({
      title: `change status of ${t.tooling_id}`,
      subtitle: 'status changes write to the movement history too',
      fields: [
        { key: 'status', label: 'new status', type: 'select', required: true, options: (meta.data?.tooling_statuses || []).map((s) => ({ value: s.code, label: `${s.dot} ${s.label}` })) },
        { key: 'reason', label: 'why', type: 'text', wide: true, placeholder: 'crack found at the corner — sent to the welder' },
      ],
      initial: { status: t.status },
    });
    if (!values) return;
    try {
      await api.post(`/api/tooling/${t.id}/status`, values);
      toast('status updated', 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function logUsage(t) {
    const values = await formDialog({
      title: 'log usage',
      fields: [
        { key: 'cycles', label: 'cycles added', type: 'number', min: 0, initial: 1 },
        { key: 'produced_qty', label: 'pieces produced', type: 'number', min: 0 },
        { key: 'production_order_id', label: 'production order id', type: 'number' },
        { key: 'note', label: 'note', type: 'text', wide: true },
      ],
    });
    if (!values) return;
    try {
      await api.post(`/api/tooling/${t.id}/usage`, values);
      toast('usage logged', 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'error', 8000);
    }
  }

  async function adjustCycles(t) {
    const values = await formDialog({
      title: 'adjust the cycle counter',
      subtitle: 'audited: an inventory check found a wrong counter',
      fields: [
        { key: 'cycles', label: 'set total cycles to', type: 'number', min: 0, initial: t.total_cycles },
        { key: 'produced', label: 'set parts produced to', type: 'number', min: 0, initial: t.total_parts_produced },
        { key: 'reset', label: 'reset after a rebuild / re-grind', type: 'checkbox' },
        { key: 'note', label: 'note', type: 'text', wide: true },
      ],
    });
    if (!values) return;
    try {
      const out = await api.post(`/api/tooling/${t.id}/cycles`, values);
      toast(`cycles ${out.before} → ${out.after}`, 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'error', 8000);
    }
  }

  async function reserveTool(t) {
    const orders = await api.get('/api/production?status=PLANNED&limit=50').catch(() => ({ items: [] }));
    const values = await formDialog({
      title: `reserve ${t.tooling_id}`,
      subtitle: 'a reservation blocks anyone else from taking it',
      fields: [
        { key: 'production_order_id', label: 'for production order', type: 'select', required: true, options: (orders.items || []).map((o) => ({ value: o.id, label: `${o.po_number} · ${o.filter_number} · ${dateOnly(o.planned_start_at)}` })) },
        { key: 'qty', label: 'pieces', type: 'number', min: 1, initial: 1 },
        { key: 'planned_start_at', label: 'from', type: 'date' },
        { key: 'planned_end_at', label: 'until', type: 'date' },
        { key: 'note', label: 'note', type: 'text', wide: true },
      ],
    });
    if (!values) return;
    try {
      await api.post(`/api/tooling/${t.id}/reserve`, values);
      toast('reserved', 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function newRevision(t) {
    const values = await formDialog({
      title: `new revision of ${t.tooling_id}`,
      subtitle: 'the old record stays exactly as it was',
      wide: true,
      fields: [
        { key: 'change_summary', label: 'what changed', required: true, type: 'textarea', wide: true, placeholder: 'bore widened by 0.3 mm after the seal leakage complaint' },
        { key: 'designer', label: 'designer' },
        { key: 'manufacturer', label: 'made by' },
        { key: 'material', label: 'material' },
        { key: 'cost', label: 'cost', type: 'number' },
        { key: 'manufacturing_date', label: 'manufactured', type: 'date' },
        { key: 'apply_to_item', label: 'apply material / manufacturer to the live record', type: 'checkbox', initial: true },
      ],
    });
    if (!values) return;
    try {
      await api.post(`/api/tooling/${t.id}/revisions`, values);
      toast('revision created', 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function uploadToolPhotos(t) {
    const values = await formDialog({
      title: 'photos of the tool',
      fields: [
        { key: 'files', label: 'images', type: 'photo', camera: true, wide: true },
        { key: 'view_type', label: 'view', type: 'select', options: ['FRONT', 'BACK', 'SIDE', 'TOP', 'DETAIL', 'IN_USE', 'DAMAGED', 'MEASURING', 'DRAWING'], initial: 'DETAIL' },
        { key: 'caption', label: 'caption', placeholder: 'left forming face after 4 200 cycles' },
        { key: 'make_primary', label: 'make it the main photo', type: 'checkbox', initial: true },
      ],
    });
    if (!values?.files?.length) return;
    const fd = new FormData();
    for (const file of values.files) fd.append('files', file);
    fd.append('view_type', values.view_type || 'DETAIL');
    fd.append('caption', values.caption || '');
    fd.append('make_primary', values.make_primary ? '1' : '0');
    try {
      await api.upload(`/api/tooling/${t.id}/images`, fd);
      toast('photos uploaded', 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function uploadToolDocs(t) {
    const values = await formDialog({
      title: 'CAD / drawing / photo file',
      subtitle: 'pdf, dxf, step, iges, stl, dwg, xlsx and images are accepted',
      fields: [
        { key: 'files', label: 'files', type: 'photo', accept: '.pdf,.dwg,.dxf,.step,.stp,.iges,.igs,.stl,.svg,.xlsx,.xls,.zip,.jpg,.jpeg,.png', multiple: true, wide: true },
        { key: 'doc_type', label: 'kind', type: 'select', options: ['CAD', 'DRAWING', 'PHOTO', 'DOCUMENT', 'MANUAL', 'CERTIFICATE'], initial: 'CAD' },
        { key: 'description', label: 'description', type: 'text', wide: true },
      ],
    });
    if (!values?.files?.length) return;
    const fd = new FormData();
    for (const file of values.files) fd.append('files', file);
    fd.append('doc_type', values.doc_type || 'DOCUMENT');
    fd.append('description', values.description || '');
    try {
      await api.upload(`/api/tooling/${t.id}/documents`, fd);
      toast('file(s) stored', 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function linkFilter(t) {
    const picked = await pickFilter({ title: 'which filter does this tool serve?' });
    if (!picked) return;
    try {
      await api.post(`/api/tooling/${t.id}/filters`, { filter_ids: [picked.id], level: 'EXACT' });
      toast('linked', 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'error', 8000);
    }
  }

  async function unlink(t, link) {
    if (!(await confirmDialog(`unlink ${t.tooling_id} from ${link.internal_number}?`, { danger: true, confirmLabel: 'unlink' }))) return;
    await api.del(`/api/tooling/${t.id}/filters/${link.link_id}`);
    reload();
  }

  async function scheduleMaintenance(t) {
    const values = await formDialog({
      title: 'schedule maintenance',
      subtitle: t.tooling_id,
      fields: [
        { key: 'maintenance_type', label: 'kind', type: 'select', required: true, options: ['PREVENTIVE', 'CORRECTIVE', 'INSPECTION', 'CLEANING', 'REPAIR', 'REPLACEMENT', 'CALIBRATION'], initial: 'PREVENTIVE' },
        { key: 'scheduled_date', label: 'planned for', type: 'date', required: true },
        { key: 'priority', label: 'priority', type: 'select', options: ['LOW', 'NORMAL', 'HIGH', 'URGENT'], initial: 'NORMAL' },
        { key: 'description', label: 'what to do', type: 'textarea', wide: true },
      ],
    });
    if (!values) return;
    try {
      await api.post('/api/maintenance', { tooling_item_id: t.id, ...values });
      toast('maintenance scheduled', 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  function showCodes(t) {
    const dialog = modal({
      title: `labels for ${t.tooling_id}`,
      wide: true,
      body: h(
        'div',
        null,
        h('div', { class: 'code-boxes' }, h('img', { src: `/api/labels/qr?kind=tooling&code=${encodeURIComponent(t.tooling_id)}`, alt: 'QR label' }), h('img', { src: `/api/labels/barcode?code=${encodeURIComponent(t.tooling_id)}`, alt: 'barcode' })),
        h('p', { class: 'tiny muted' }, `QR payload: ${t.qr_payload || `SP:T:${t.tooling_id}`} · barcode: ${t.barcode || t.tooling_id}`),
      ),
      actions: buttons([
        button('print a sheet (this tool only)', {
          kind: 'primary',
          onClick: async () => {
            const out = await api.post('/api/labels/sheet', { kind: 'tooling', ids: [t.id] });
            printHtml(out.html);
          },
        }),
        button('download QR png', { kind: 'ghost', onClick: () => downloadWith(`/api/labels/qr?kind=tooling&code=${encodeURIComponent(t.tooling_id)}&format=png&width=600`, `${t.tooling_id}-qr.png`) }),
        button('close', { kind: 'ghost', onClick: () => dialog.close() }),
      ]),
    });
  }

  await reload();
  return box;
}

/* ================================================================ compare */
async function CompareView(mount, route) {
  let ids = String(route.query.ids || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const body = h('div', null);

  async function draw() {
    if (ids.length < 2) {
      body.replaceChildren(notice('warn', 'pick at least two tools — the tray below fills the list'));
      return;
    }
    body.replaceChildren(spinner('measuring them side by side…'));
    try {
      const out = await api.get(`/api/tooling/compare${qs({ ids: ids.join(','), unit: unitPreference() })}`);
      const cols = out.items;
      const fieldRows = (meta.data?.dimension_fields?.tooling || []).map((f) => {
        const values = cols.map((c) => c.dimensions?.[f.key]);
        if (!values.some((v) => v !== null && v !== undefined && v !== '')) return null;
        const same = new Set(values.map((v) => String(v))).size === 1;
        return h(
          'div',
          { class: `cmp-row ${same ? 'same' : 'diff'}` },
          h('span', { class: 'cmp-label' }, f.label),
          values.map((v, i) => h('span', { class: 'cmp-cell' }, f.unit === 'mm' ? (v === null || v === undefined ? '—' : mm(v)) : v === null || v === undefined ? '—' : String(v), !same && v !== null && v !== undefined ? h('span', { class: 'tiny muted' }, ` (${Number(v) === Number(values[0]) ? 'same as first' : `Δ ${Number(v) - Number(values[0] ?? 0)}`})`) : null)),
        );
      });
      const tray = h(
        'div',
        { class: 'chips' },
        ...cols.map((c) => h('span', { class: 'chip big' }, h('b', { class: 'code' }, c.tool.tooling_id), h('button', { class: 'chip-x', onclick: () => ((ids = ids.filter((x) => x !== c.tool.tooling_id && x !== String(c.tool.id))), draw()) }, '×'))),
      );
      body.replaceChildren(
        card(
          { title: 'side by side', subtitle: `${cols.length} tools · differences are highlighted` },
          h(
            'div',
            { class: 'compare' },
            h(
              'div',
              { class: 'cmp-row head' },
              h('span', { class: 'cmp-label' }, 'tool'),
              cols.map((c) =>
                h(
                  'span',
                  { class: 'cmp-cell center' },
                  c.images?.[0] ? h('img', { class: 'thumb big', src: c.images[0].url || `/api/files/images/${c.images[0].id}`, alt: '', onclick: () => lightbox(c.images[0].url, c.tool.tooling_id) }) : h('span', { class: 'thumb none big' }, '🧿'),
                  h('a', { class: 'code big-code', href: `#/tooling/${encodeURIComponent(c.tool.tooling_id)}` }, c.tool.tooling_id),
                  h('div', { class: 'small' }, c.tool.name),
                  statusBadge(c.tool.status),
                  h('div', { class: 'tiny muted' }, c.location || 'no shelf'),
                ),
              ),
            ),
            fieldRows.filter(Boolean),
            h(
              'div',
              { class: 'cmp-row' },
              h('span', { class: 'cmp-label' }, 'category'),
              cols.map((c) => h('span', { class: 'cmp-cell' }, c.tool.type_name)),
            ),
            h(
              'div',
              { class: 'cmp-row' },
              h('span', { class: 'cmp-label' }, 'condition'),
              cols.map((c) => h('span', { class: 'cmp-cell' }, c.tool.condition_rating || '—')),
            ),
            h(
              'div',
              { class: 'cmp-row' },
              h('span', { class: 'cmp-label' }, 'filters served'),
              cols.map((c) => h('span', { class: 'cmp-cell' }, String(c.filters ?? c.compatibility?.length ?? 0))),
            ),
            h(
              'div',
              { class: 'cmp-row' },
              h('span', { class: 'cmp-label' }, 'cycles'),
              cols.map((c) => h('span', { class: 'cmp-cell' }, `${c.tool.total_cycles ?? 0}${c.tool.max_cycles ? ` / ${c.tool.max_cycles}` : ''}`)),
            ),
          ),
        ),
        out.pairs.length
          ? card(
              { title: 'similarity verdict', subtitle: 'run through the duplicate engine' },
              table(
                [
                  { label: 'pair', render: (p) => `${p.a} ↔ ${p.b}` },
                  { label: 'similarity', render: (p) => badge(`${p.similarity_pct}%`, p.possible_duplicate ? 'danger' : 'ok') },
                  { label: 'why', render: (p) => h('span', { class: 'tiny' }, (p.reasons || []).join(' · ')) },
                ],
                out.pairs,
              ),
            )
          : null,
        tray,
      );
    } catch (err) {
      body.replaceChildren(errorBox(err));
    }
  }

  const addBtn = button('＋ add a tool', {
    kind: 'primary',
    onClick: async () => {
      const picked = await pickTooling({ title: 'add to the comparison' });
      if (!picked) return;
      if (ids.length >= 4) return toast('four at a time is the maximum', 'warn');
      ids.push(picked.tooling_id);
      history.replaceState(null, '', `#/compare?ids=${ids.join(',')}`);
      draw();
    },
  });
  const scanBtn = button('📷 scan one in', {
    kind: 'ghost',
    onClick: async () => {
      const s = await openScanner({ title: 'scan the next tool' });
      if (!s) return;
      ids.push(s.code);
      history.replaceState(null, '', `#/compare?ids=${ids.join(',')}`);
      draw();
    },
  });

  const node = h(
    'div',
    null,
    h('div', { class: 'section-title' }, h('h1', null, 'compare tooling'), h('span', { class: 'sub' }, 'up to four, side by side, dimensions and differences highlighted')),
    h('div', { class: 'btn-row' }, addBtn, scanBtn),
    body,
  );
  await draw();
  return node;
}

export { FilterListView, FilterOverviewView, ToolingListView, ToolDetailView, CompareView };
