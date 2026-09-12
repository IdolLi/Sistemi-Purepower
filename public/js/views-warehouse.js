/** Warehouse screens: inventory + counts, the storage map / location tree, and movement history. */
import { api, qs, meta, statusInfo } from './api.js';
import {
  h, card, button, buttons, badge, statusBadge, grid, statTile, table, kv, pager, empty, spinner, errorBox, notice, tabs,
  meter, form, formDialog, modal, confirmDialog, toast, lightbox, when, dateOnly, daysUntil, mm, sizeString, UnitToggle,
  unitPreference, printHtml, barChart,
} from './ui.js';
import { state, can, go, back, openFilter, openTooling, openLocation, moveTool, reportDamage, pickTooling, pickFilter, downloadWith, statusCounts } from './store.js';
import { openScanner } from './scan.js';

export const warehouseViews = {
  '/inventory': { view: InventoryView, nav: 'inventory', title: 'inventory' },
  '/locations': { view: (m, r) => (r.segments[1] ? LocationDetailView(m, r) : LocationsView(m, r)), nav: 'locations', title: 'locations' },
  '/movements': { view: MovementsView, nav: 'movements', title: 'movements' },
};

/* ============================================================== inventory */
async function InventoryView(mount, route) {
  const st = { tab: route.query.tab || 'stock', q: route.query.q || '', low: route.query.low || '', page: Number(route.query.page || 1), size: 30 };
  const body = h('div', null);
  const tabNode = h('div', null);
  const TABS = [
    { key: 'stock', label: '📦 finished goods' },
    { key: 'counts', label: '🧮 stock counts' },
    { key: 'unassigned', label: '🗄 tools with no shelf' },
    { key: 'bins', label: '📍 stock bins' },
  ];
  let active = st.tab;

  const paint = async () => {
    tabNode.replaceChildren(...tabs(TABS, active, (key) => ((active = key), history.replaceState(null, '', `#/inventory${qs({ ...st, tab: key })}`), paint())).children);
    body.replaceChildren(spinner('loading…'));
    try {
      body.replaceChildren(await builders[active]());
    } catch (err) {
      body.replaceChildren(errorBox(err));
    }
  };

  const builders = { stock: stockTab, counts: countsTab, unassigned: unassignedTab, bins: binsTab };

  async function stockTab() {
    const [out, summary] = await Promise.all([api.get(`/api/inventory${qs(st)}`), api.get('/api/inventory/summary').catch(() => null)]);
    const tiles = h(
      'div',
      { class: 'tiles' },
      statTile({ label: 'stock items', value: summary?.totals?.items ?? out.pagination.total, sub: 'tracked SKUs' }),
      statTile({ label: 'pieces on hand', value: summary?.totals?.units ?? 0, sub: 'finished filters' }),
      statTile({ label: 'below reorder level', value: summary?.totals?.low_count ?? 0, tone: summary?.totals?.low_count ? 'warn' : 'ok', href: '#/inventory?low=1' }),
      statTile({ label: 'out of stock', value: summary?.totals?.out_count ?? 0, tone: summary?.totals?.out_count ? 'danger' : 'ok', href: '#/inventory?low=1' }),
    );
    const search = h('input', { type: 'search', placeholder: 'sku, filter number, name…', value: st.q, autocapitalize: 'characters' });
    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => ((st.q = search.value.trim()), (st.page = 1), paint()), 280);
    });
    return h(
      'div',
      null,
      tiles,
      summary?.by_type?.length ? card({ title: 'pieces by filter type' }, barChart(summary.by_type.map((t) => ({ label: t.filter_type, value: Number(t.units) })))) : null,
      card({ dense: true }, search),
      card(
        {
          title: 'stock levels',
          subtitle: 'low stock sorts first so people notice it',
          actions: buttons([
            can('inventory.update') ? button('＋ stock movement', { kind: 'primary small', onClick: () => stockMovement() }) : null,
            can('inventory.update') ? button('⇄ transfer', { kind: 'ghost small', onClick: () => transferStock() }) : null,
            button('⬇ csv', { kind: 'ghost small', onClick: () => downloadWith('/api/export/stock.csv', 'stock.csv') }),
          ]),
        },
        table(
          [
            { label: 'sku', render: (r) => h('b', { class: 'code' }, r.sku) },
            { label: 'name', render: (r) => h('div', null, r.name || '', r.filter_number ? h('div', { class: 'tiny muted' }, r.filter_number) : null) },
            { label: 'type', render: (r) => (r.filter_type ? badge(`${r.icon || ''} ${r.filter_type}`) : String(r.item_kind).toLowerCase()) },
            { label: 'on hand', render: (r) => h('b', null, String(r.on_hand)) },
            { label: 'reserved', render: (r) => String(r.reserved ?? 0) },
            { label: 'available', render: (r) => h('b', { class: Number(r.available) > 0 ? 'ok-text' : 'danger-text' }, String(r.available)) },
            { label: 'reorder at', render: (r) => String(r.reorder_level ?? 0) },
            { label: 'bins', render: (r) => String(r.location_count ?? 0) },
            { label: 'state', render: (r) => badge(String(r.status).replace(/_/g, ' ').toLowerCase(), r.status === 'HEALTHY' ? 'ok' : r.status === 'OUT_OF_STOCK' ? 'danger' : 'warn') },
            { label: 'last change', render: (r) => (r.last_movement ? h('span', { class: 'tiny muted nowrap' }, when(r.last_movement)) : '—') },
            {
              label: '',
              render: (r) => h('a', { class: 'btn small ghost', href: r.ref_id ? `#/filters/${encodeURIComponent(r.filter_number || r.ref_id)}` : '#/inventory', onclick: (e) => { if (r.ref_id && r.filter_number) { e.preventDefault(); openFilter(r.filter_number); } } }, 'filter'),
            },
          ],
          out.items,
          { onRowOpen: (r) => showStockItem(r) },
        ),
        pager(out.pagination, (page) => ((st.page = page), paint())),
      ),
    );
  }

  async function showStockItem(row) {
    const detail = await api.get(`/api/inventory/items/${row.id}`);
    const dialog = modal({
      title: row.sku,
      subtitle: row.name || '',
      wide: true,
      body: h(
        'div',
        null,
        grid(3, statTile({ label: 'on hand', value: detail.totals.on_hand }), statTile({ label: 'reserved', value: detail.totals.reserved }), statTile({ label: 'damaged', value: detail.totals.damaged, tone: detail.totals.damaged ? 'danger' : 'ok' })),
        table(
          [
            { label: 'bin', render: (s) => h('b', { class: 'code' }, s.location_code || 'unsorted') },
            { label: 'qty', key: 'quantity' },
            { label: 'reserved', key: 'reserved_qty' },
            { label: 'damaged', key: 'damaged_qty' },
            { label: 'lot', key: 'lot_ref' },
          ],
          detail.stock,
          { emptyText: 'no stock rows — nothing on hand' },
        ),
      ),
      actions: buttons([
        can('inventory.update')
          ? button('record a movement', {
              kind: 'primary',
              onClick: async () => {
                dialog.close();
                await stockMovement({ sku: row.sku });
                paint();
              },
            })
          : null,
        button('close', { kind: 'ghost', onClick: () => dialog.close() }),
      ]),
    });
  }

  async function stockMovement(initial = {}) {
    const values = await formDialog({
      title: 'stock movement',
      subtitle: 'receipts, issues and corrections — always written as a transaction',
      wide: true,
      fields: [
        { key: 'filter_number', label: 'filter number (or sku)', required: true, placeholder: 'FP-0427', initial: initial.filter_number || initial.sku },
        { key: 'txn_type', label: 'kind', type: 'select', required: true, options: ['RECEIPT', 'ISSUE', 'ADJUSTMENT', 'TRANSFER', 'SCRAP', 'CYCLE_COUNT'], initial: 'RECEIPT' },
        { key: 'quantity', label: 'pieces', type: 'number', required: true, min: 0, initial: 10 },
        { key: 'location', label: 'stock bin', placeholder: 'FIN-01 or TR-R01-RK02-S01', help: 'a shelf code works — it is reused as a stock bin' },
        { key: 'lot_ref', label: 'lot / batch' },
        { key: 'reference_no', label: 'reference (delivery, order)' },
        { key: 'reason', label: 'reason', type: 'select', options: ['PRODUCTION', 'SALE', 'DAMAGE', 'RECOUNT', 'TRANSFER', 'SCRAP', 'SAMPLE', 'CORRECTION', 'OTHER'] },
        { key: 'note', label: 'note', type: 'text', wide: true },
      ],
    });
    if (!values) return;
    try {
      const out = await api.post('/api/inventory/transactions', values);
      toast(`${out.before} → ${out.after} pcs of ${out.item.sku}`, 'ok', 6000);
      paint();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function transferStock() {
    const values = await formDialog({
      title: 'transfer stock',
      fields: [
        { key: 'filter_number', label: 'filter number / sku', required: true },
        { key: 'quantity', label: 'pieces', type: 'number', required: true, min: 1 },
        { key: 'from', label: 'from bin', required: true, placeholder: 'FIN-01' },
        { key: 'to', label: 'to bin', required: true, placeholder: 'TR-R02-RK01-S03' },
        { key: 'note', label: 'note', type: 'text', wide: true },
      ],
    });
    if (!values) return;
    try {
      const out = await api.post('/api/inventory/transfer', values);
      toast(`${out.quantity} pcs ${out.from} → ${out.to}`, 'ok');
      paint();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function countsTab() {
    const out = await api.get('/api/inventory/counts');
    return h(
      'div',
      null,
      card(
        {
          title: 'stock counts',
          subtitle: 'split counts: two people count independently, a mismatch becomes a dispute, then one click applies the correction',
          actions: can('inventory.manage') ? button('＋ open a count', { kind: 'primary small', onClick: () => newCount() }) : null,
        },
        table(
          [
            { label: 'count', render: (c) => h('b', { class: 'code' }, c.count_no) },
            { label: 'title', key: 'title' },
            { label: 'bin', render: (c) => c.location_code || 'plant wide' },
            { label: 'method', render: (c) => badge(String(c.method).toLowerCase()) },
            { label: 'lines', render: (c) => `${c.counted_lines}/${c.line_count}` },
            { label: 'variance', render: (c) => (Number(c.total_variance) ? badge(`${c.total_variance} pcs`, 'danger') : badge('none', 'ok')) },
            { label: 'state', render: (c) => badge(String(c.status).toLowerCase(), c.status === 'OPEN' ? 'warn' : c.status === 'CLOSED' ? 'ok' : '') },
            { label: 'by', render: (c) => `${c.counter_a_name || ''}${c.counter_b_name ? ` + ${c.counter_b_name}` : ''}` },
            { label: 'started', render: (c) => h('span', { class: 'tiny muted nowrap' }, when(c.started_at)) },
          ],
          out.items,
          { onRowOpen: (c) => openCountDialog(c.id), emptyText: 'no counts recorded yet' },
        ),
      ),
    );
  }

  async function newCount() {
    const values = await formDialog({
      title: 'open a stock count',
      subtitle: 'leave the bin empty to count the whole plant',
      fields: [
        { key: 'title', label: 'what are we counting', required: true, placeholder: 'October panel-filter cycle count', wide: true },
        { key: 'location', label: 'bin / shelf code', placeholder: 'FIN-01' },
        { key: 'method', label: 'method', type: 'select', options: ['FULL', 'SPLIT', 'A_ONLY', 'B_ONLY'], initial: 'SPLIT' },
        { key: 'notes', label: 'notes', type: 'text', wide: true },
      ],
    });
    if (!values) return;
    try {
      const out = await api.post('/api/inventory/counts', values);
      toast(`${out.count_no} opened with ${out.lines} line(s)`, 'ok');
      paint();
      openCountDialog(out.id);
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function openCountDialog(id) {
    const render2 = async () => {
      const d = await api.get(`/api/inventory/counts/${id}`);
      const counter = d.count.method === 'B_ONLY' ? 'B' : 'A';
      const body = h(
        'div',
        null,
        grid(
          4,
          statTile({ label: 'lines', value: d.summary.lines }),
          statTile({ label: 'counted', value: d.summary.counted, sub: `${d.summary.pending} to go` }),
          statTile({ label: 'variance', value: d.summary.variance, tone: d.summary.variance ? 'danger' : 'ok', sub: `${d.summary.variances} line(s) differ` }),
          statTile({ label: 'system total', value: d.summary.system_qty, sub: `counted ${d.summary.counted_qty}` }),
        ),
        d.count.status === 'OPEN' && can('inventory.manage')
          ? h(
              'div',
              { class: 'btn-row', style: 'margin-bottom:10px' },
              button('📷 scan a line then type the count', {
                kind: 'primary small',
                onClick: async () => {
                  const s = await openScanner({ title: 'scan the tool / shelf, then enter the count' });
                  if (!s) return;
                  const values = await formDialog({ title: `count for ${s.code}`, fields: [{ key: 'qty', label: 'pieces you can see', type: 'number', required: true, min: 0 }, { key: 'note', label: 'note', type: 'text' }], initial: { code: s.code } });
                  if (!values) return;
                  try {
                    await api.post(`/api/inventory/counts/${id}/scan`, { code: s.code, qty: values.qty, note: values.note, counter });
                    toast('counted', 'ok');
                    render2();
                  } catch (err) {
                    toast(err.message, 'error', 9000);
                  }
                },
              }),
              button('apply counted numbers to stock', {
                kind: 'ghost small',
                onClick: async () => {
                  if (!(await confirmDialog('apply every counted line as a stock correction?', { confirmLabel: 'apply' }))) return;
                  const out = await api.post(`/api/inventory/counts/${id}/apply`, {});
                  toast(`${out.applied} line(s) applied`, 'ok');
                  render2();
                },
              }),
              button('close the count', {
                kind: 'ghost small',
                onClick: async () => {
                  const out = await api.post(`/api/inventory/counts/${id}/close`, {});
                  toast(`count ${out.status.toLowerCase()}`, 'ok');
                  dialog.close();
                  paint();
                },
              }),
            )
          : null,
        table(
          [
            { label: 'sku', render: (l) => h('b', { class: 'code' }, l.sku) },
            { label: 'bin', render: (l) => l.location_code || '—' },
            { label: 'system', key: 'system_qty' },
            { label: 'A', key: 'counted_a' },
            { label: 'B', key: 'counted_b' },
            { label: 'counted', render: (l) => (l.counted_qty === null ? '—' : String(l.counted_qty)) },
            { label: 'variance', render: (l) => (l.variance ? badge(`${l.variance > 0 ? '+' : ''}${l.variance}`, 'danger') : l.counted_qty === null ? '' : badge('0', 'ok')) },
            { label: 'state', render: (l) => badge(String(l.status).toLowerCase(), l.status === 'DISPUTED' ? 'danger' : l.status === 'APPLIED' ? 'ok' : '') },
            {
              label: '',
              render: (l) =>
                d.count.status === 'OPEN' && can('inventory.manage')
                  ? h(
                      'button',
                      {
                        class: 'btn small ghost',
                        onclick: async () => {
                          const values = await formDialog({ title: `count ${l.sku}`, subtitle: `system says ${l.system_qty} pcs`, fields: [{ key: 'qty', label: 'pieces counted', type: 'number', required: true, min: 0 }, { key: 'counter', label: 'which counter', type: 'select', options: ['A', 'B'], initial: counter }, { key: 'note', label: 'note', type: 'text', wide: true }] });
                          if (!values) return;
                          await api.post(`/api/inventory/counts/${id}/lines/${l.id}`, values);
                          render2();
                        },
                      },
                      'enter',
                    )
                  : null,
              },
          ],
          d.lines,
          { emptyText: 'this count has no lines — the bin may hold nothing' },
        ),
      );
      dialog.box.querySelector('.modal-body').replaceChildren(body);
    };
    const dialog = modal({ title: 'stock count', wide: true, body: spinner('loading the count…'), actions: null });
    await render2();
    dialog.onClose = () => paint();
  }

  async function unassignedTab() {
    const out = await api.get('/api/tooling?no_location=1&page_size=100');
    return card(
      { title: 'tools with no shelf recorded', subtitle: `${out.pagination.total} item(s) — these are the ones people cannot find` },
      table(
        [
          { label: 'tooling', render: (t) => h('b', { class: 'code' }, t.tooling_id) },
          { label: 'name', key: 'name' },
          { label: 'category', render: (t) => t.type_name },
          { label: 'status', render: (t) => statusBadge(t.status) },
          { label: 'qty', key: 'quantity' },
          {
            label: 'fix it',
            render: (t) =>
              can('tooling.move')
                ? h(
                    'button',
                    { class: 'btn small primary', onclick: async () => { const s = await suggestFor(t); if (s) { await api.post(`/api/tooling/${t.id}/move`, { action: 'MOVE', location_id: s.id, reason: 'ASSIGNED', note: `suggested: ${s.why || 'nearest matching shelf'}` }); toast(`${t.tooling_id} → ${s.full_code}`, 'ok'); paint(); } } },
                    'assign a free shelf',
                  )
                : null,
          },
        ],
        out.items,
        { onRowOpen: (t) => openTooling(t.tooling_id) },
      ),
    );
  }

  async function suggestFor(tool) {
    const out = await api.get(`/api/warehouse/suggest${qs({ tooling_id: tool.id })}`);
    if (!out.items.length) {
      toast('no free shelf found — create one in LOCATIONS first', 'error', 8000);
      return null;
    }
    return out.items[0];
  }

  async function binsTab() {
    const [bins, occ] = await Promise.all([api.get('/api/inventory/locations'), api.get('/api/warehouse/occupancy').catch(() => ({ items: [] }))]);
    return h(
      'div',
      null,
      card(
        { title: 'stock bins', subtitle: 'finished-goods places; the app reuses a tooling shelf code when you type one', actions: can('inventory.manage') ? button('＋ new bin', { kind: 'ghost small', onClick: () => newBin() }) : null },
        table(
          [
            { label: 'code', render: (b) => h('b', { class: 'code' }, b.code) },
            { label: 'name', key: 'name' },
            { label: 'kind', render: (b) => badge(String(b.location_type || '').toLowerCase()) },
            { label: 'capacity', render: (b) => (b.capacity ? b.capacity : '—') },
            { label: 'items', key: 'item_count' },
            { label: 'pieces', key: 'total_qty' },
            { label: 'active', render: (b) => (b.is_active ? badge('yes', 'ok') : badge('no')) },
          ],
          bins.items,
        ),
      ),
      occ.items?.length
        ? card({ title: 'shelf fill across the plant', subtitle: 'from the tooling hierarchy — full shelves first' }, table(
            [
              { label: 'shelf', render: (r) => h('a', { class: 'code', href: `#/locations/${r.id}` }, r.full_code) },
              { label: 'kind', render: (r) => badge(String(r.kind).toLowerCase()) },
              { label: 'used', render: (r) => `${r.occupancy_items}/${r.capacity_items}` },
              { label: 'fill', render: (r) => meter(Number(r.occupancy_items || 0), Number(r.capacity_items || 1), `${r.fill_pct}%`) },
            ],
            occ.items.slice(0, 30),
            { onRowOpen: (r) => openLocation(r.id) },
          ))
        : null,
    );
  }

  async function newBin() {
    const values = await formDialog({
      title: 'new stock bin',
      fields: [
        { key: 'code', label: 'code', required: true, placeholder: 'FIN-02' },
        { key: 'name', label: 'name', placeholder: 'Finished goods aisle 2' },
        { key: 'location_type', label: 'kind', type: 'select', options: ['BIN', 'RACK', 'SHELF', 'BOX', 'FLOOR', 'OFFSITE', 'QUARANTINE'], initial: 'BIN' },
        { key: 'capacity', label: 'capacity (pieces)', type: 'number', min: 0 },
        { key: 'warehouse', label: 'warehouse code' },
      ],
    });
    if (!values) return;
    try {
      await api.post('/api/inventory/locations', values);
      toast('bin created', 'ok');
      paint();
    } catch (err) {
      toast(err.message, 'error', 8000);
    }
  }

  const node = h(
    'div',
    null,
    h(
      'div',
      { class: 'section-title' },
      h('h1', null, 'inventory'),
      h('span', { class: 'sub' }, 'finished goods, stock bins and split counts'),
      h('span', { class: 'grow' }),
      can('inventory.update') ? button('📷 scan a count line', { kind: 'ghost small', onClick: () => { active = 'counts'; paint(); } }) : null,
    ),
    tabNode,
    body,
  );
  await paint();
  return node;
}

/* ================================================== locations / storage map */
async function LocationsView(mount, route) {
  const body = h('div', null, spinner('reading the warehouse…'));
  const [warehouses, kinds] = await Promise.all([api.get('/api/warehouse/warehouses').then((r) => r.items), api.get('/api/warehouse/locations/levels').catch(() => ({ items: [] }))]);
  let selected = Number(route.query.warehouse || warehouses[0]?.id) || null;
  let mode = route.query.mode || 'map';
  const search = h('input', { type: 'search', placeholder: 'search a shelf code, e.g. TR-R02 or RK05', autocapitalize: 'characters' });

  async function paint() {
    body.replaceChildren(
      h(
        'div',
        null,
        h(
          'div',
          { class: 'tiles' },
          ...warehouses.map((w) =>
            statTile({
              label: w.name,
              value: `${w.item_count ?? 0} tools`,
              sub: `${w.rows_count ?? 0} rows · ${w.racks_count ?? 0} racks · ${w.shelves_count ?? 0} shelves · ${w.boxes_count ?? 0} boxes${w.fill_pct !== null ? ` · ${w.fill_pct}% full` : ''}`,
              tone: w.fill_pct >= 90 ? 'danger' : w.fill_pct >= 70 ? 'warn' : 'ok',
              icon: w.warehouse_type === 'TOOL_ROOM' ? '🧿' : '🏬',
            }),
          ),
        ),
        h(
          'div',
          { class: 'btn-row', style: 'margin-top:10px' },
          ...warehouses.map((w) =>
            h(
              'button',
              { class: `btn ${w.id === selected ? 'primary' : 'ghost'}`, onclick: () => ((selected = w.id), history.replaceState(null, '', `#/locations${qs({ warehouse: w.id, mode })}`), paint()) },
              `${w.code} · ${w.name}`,
            ),
          ),
          h('span', { class: 'grow' }),
          h('div', { class: 'seg' }, ...['map', 'tree', 'fill'].map((m) => h('button', { class: `seg-btn ${m === mode ? 'on' : ''}`, onclick: () => ((mode = m), history.replaceState(null, '', `#/locations${qs({ warehouse: selected, mode: m })}`), paintSection()) }, m))),
        ),
        h('div', { id: 'loc-section' }, spinner('loading…')),
      ),
    );
    await paintSection();
  }

  async function paintSection() {
    const section = document.getElementById('loc-section');
    if (!section) return;
    section.replaceChildren(spinner('building the view…'));
    try {
      if (mode === 'map') section.replaceChildren(await mapFor(selected));
      else if (mode === 'tree') section.replaceChildren(await treeFor(selected));
      else section.replaceChildren(await fillFor(selected));
    } catch (err) {
      section.replaceChildren(errorBox(err));
    }
  }

  async function mapFor(warehouseId) {
    const map = await api.get(`/api/warehouse/warehouses/${warehouseId}/map`);
    const legend = h(
      'div',
      { class: 'legend' },
      ...[['empty', 'nothing on it'], ['part', 'space left'], ['nearly', 'almost full'], ['full', 'no room'], ['over', 'more than planned']].map(([tone, label]) => h('span', { class: `key ${tone}` }, label)),
    );
    const wrap = h('div', { class: 'map' }, legend);
    for (const row of map.rows) {
      const rowBox = h(
        'div',
        { class: 'map-row' },
        h(
          'div',
          { class: 'map-row-head' },
          h('b', { class: 'code' }, row.code),
          h('span', { class: 'small muted' }, row.label || ''),
          row.fill_pct !== null ? badge(`${row.occupancy}/${row.capacity ?? '?'} places · ${row.fill_pct}%`, row.fill_pct >= 90 ? 'danger' : row.fill_pct >= 70 ? 'warn' : 'ok') : null,
        ),
      );
      for (const rack of row.racks) {
        const rackBox = h(
          'div',
          { class: 'map-rack' },
          h('div', { class: 'map-rack-head' }, h('b', { class: 'code' }, rack.code), h('span', { class: 'tiny muted' }, rack.full_code || ''), rack.fill_pct !== null ? badge(`${rack.fill_pct}%`, rack.fill_pct >= 90 ? 'danger' : rack.fill_pct >= 70 ? 'warn' : '') : null),
          h(
            'div',
            { class: 'cells' },
            ...rack.shelves.map((s) => {
              const tone = s.fill_pct === null ? 'empty' : s.fill_pct >= 100 ? 'over' : s.fill_pct >= 90 ? 'full' : s.fill_pct >= 70 ? 'nearly' : s.occupancy_items > 0 ? 'part' : 'empty';
              const cell = h(
                'button',
                {
                  class: `cell ${tone}`,
                  title: `${s.full_code} · ${s.occupancy_items ?? 0}/${s.capacity_items ?? '?'} · ${s.status || ''}`,
                  onclick: () => (s.location_id ? openLocation(s.location_id) : openLocationByCode(s.full_code)),
                },
                h('span', { class: 'cell-code' }, s.code),
                h('span', { class: 'cell-qty' }, String(s.occupancy_items ?? 0)),
                s.capacity_items ? h('span', { class: 'cell-bar' }, h('span', { style: `width:${Math.min(100, s.fill_pct || 0)}%` })) : null,
              );
              return cell;
            }),
          ),
        );
        rowBox.appendChild(rackBox);
      }
      if (!row.racks.length) rowBox.appendChild(notice('warn', 'this row has no racks yet'));
      wrap.appendChild(rowBox);
    }
    if (!map.rows.length) wrap.appendChild(notice('warn', 'this warehouse has no rows yet — generate a layout or add one by hand'));
    return card(
      {
        title: `${map.warehouse.name} — visual storage map`,
        subtitle: `${map.totals?.locations ?? 0} places, ${map.totals?.items ?? 0} tools on them · tap a shelf`,
        actions: buttons([
          can('locations.manage') ? button('⚡ generate a layout', { kind: 'primary small', onClick: () => autoGenerate(map.warehouse) }) : null,
          can('locations.manage') ? button('＋ add a row', { kind: 'ghost small', onClick: async () => { const nodes = await api.get(`/api/warehouse/locations?kind=WAREHOUSE&warehouse_id=${map.warehouse.id}`); const parent = nodes.items[0]; if (!parent) return toast('the warehouse has no location node yet', 'error'); addLevel({ code: map.warehouse.code }, 'ROW', 'WAREHOUSE', parent.id); } }) : null,
          can('locations.manage') ? button('↻ recalculate occupancy', { kind: 'ghost small', onClick: async () => (await api.post('/api/warehouse/recalculate', {}), toast('recalculated', 'ok'), paint()) }) : null,
        ]),
      },
      wrap,
    );
  }

  async function openLocationByCode(code) {
    const out = await api.get(`/api/warehouse/locations/resolve/${encodeURIComponent(code)}`);
    openLocation(out.location.id);
  }

  async function treeFor(warehouseId) {
    const tree = await api.get(`/api/warehouse/locations/tree${qs({ warehouse_id: warehouseId, max_depth: 4 })}`);
    const wrap = h('div', { class: 'tree' });
    const renderNode = (node) => {
      const li = h('li', null);
      const row = h(
        'div',
        { class: 'node' },
        h('a', { class: 'code', href: `#/locations/${node.id}` }, node.full_code),
        h('span', { class: 'small grow' }, node.label_path && node.label_path !== node.full_code ? node.label_path.replace(`${node.full_code} `, '') : ''),
        node.capacity_items ? meter(Number(node.occupancy_items || 0), Number(node.capacity_items), `${node.occupancy_items ?? 0}/${node.capacity_items}`) : badge(`${node.items_total ?? 0} tool(s)`),
        badge(String(node.kind).toLowerCase()),
        h('button', { class: 'btn small ghost', onclick: () => openLocation(node.id) }, 'open'),
      );
      li.appendChild(row);
      const kids = node.children || [];
      if (kids.length) li.appendChild(h('ul', null, ...kids.map(renderNode)));
      return li;
    };
    for (const wh of tree.warehouses || []) {
      const ul = h('ul', null, ...(wh.children || []).map(renderNode));
      wrap.appendChild(h('div', { class: 'group-title' }, `${wh.code} · ${wh.name} — ${wh.items_total ?? 0} tool(s) in ${wh.child_count ?? 0} places`));
      wrap.appendChild(ul);
    }
    return card(
      { title: 'hierarchy', subtitle: `Warehouse → Row → Rack → Shelf → Box · ${tree.total_locations} nodes`, actions: can('locations.manage') ? button('＋ add a level', { kind: 'ghost small', onClick: () => addLevel(wh0(), 'ROW', 'WAREHOUSE', wh0()?.location_id ?? wh0()?.id) }) : null },
      wrap.children.length ? wrap : empty('no locations yet', 'generate a layout to get rows, racks and shelves in one go'),
    );
    function wh0() {
      return warehouses.find((w) => w.id === warehouseId) || warehouses[0];
    }
  }

  async function fillFor(warehouseId) {
    const occ = await api.get(`/api/warehouse/occupancy${qs({ warehouse_id: warehouseId })}`);
    return card(
      { title: 'shelf fill', subtitle: `${occ.summary.total_used} of ${occ.summary.total_capacity} planned places hold a tool · ${occ.summary.full} full, ${occ.summary.free} nearly empty` },
      grid(3, statTile({ label: 'full', value: occ.summary.full, tone: occ.summary.full ? 'danger' : 'ok' }), statTile({ label: 'nearly full', value: occ.summary.nearly_full, tone: 'warn' }), statTile({ label: 'free space', value: occ.summary.free, sub: 'shelves under 20%' })),
      table(
        [
          { label: 'place', render: (r) => h('a', { class: 'code', href: `#/locations/${r.id}` }, r.full_code) },
          { label: 'kind', render: (r) => badge(String(r.kind).toLowerCase()) },
          { label: 'used', render: (r) => `${r.occupancy_items}/${r.capacity_items}` },
          { label: 'fill', render: (r) => meter(Number(r.occupancy_items || 0), Number(r.capacity_items || 1), `${r.fill_pct}%`) },
          { label: 'status', render: (r) => badge(String(r.status).toLowerCase(), r.status === 'AVAILABLE' ? 'ok' : '') },
        ],
        occ.items,
        { onRowOpen: (r) => openLocation(r.id) },
      ),
    );
  }

  async function autoGenerate(warehouse) {
    const values = await formDialog({
      title: 'generate a storage layout',
      subtitle: `creates codes like ${warehouse.level_prefix || warehouse.code}-R01-RK01-S01 and never overwrites an existing shelf`,
      fields: [
        { key: 'rows', label: 'rows', type: 'number', min: 1, max: 40, initial: 4 },
        { key: 'racksPerRow', label: 'racks per row', type: 'number', min: 1, max: 60, initial: 6 },
        { key: 'shelvesPerRack', label: 'shelves per rack', type: 'number', min: 1, max: 30, initial: 4 },
        { key: 'boxesPerShelf', label: 'boxes per shelf', type: 'number', min: 0, max: 20, initial: 0 },
        { key: 'capacityPerShelf', label: 'tool places per shelf', type: 'number', min: 1, initial: 8 },
        { key: 'dryRun', label: 'dry run (show what would be created)', type: 'checkbox' },
      ],
    });
    if (!values) return;
    try {
      const out = await api.post('/api/warehouse/locations/auto-generate', {
        warehouse: warehouse.code,
        rows: values.rows,
        racks_per_row: values.racksPerRow,
        shelves_per_rack: values.shelvesPerRack,
        boxes_per_shelf: values.boxesPerShelf,
        capacity_per_shelf: values.capacityPerShelf || undefined,
        dry_run: values.dryRun ? 1 : 0,
      });
      toast(out.dry_run ? `${out.would_create} place(s) planned` : `${out.created} created, ${out.skipped} already existed`, 'ok', 6000);
      if (!out.dry_run) {
        location.hash = `#/locations?warehouse=${warehouse.id}&mode=map&t=${Date.now()}`;
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      }
      paint();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function addLevel(warehouse, kind, parentKind, parentId) {
    const values = await formDialog({
      title: `new ${kind.toLowerCase()}`,
      subtitle: `inside ${warehouse?.code ?? 'the warehouse'}`,
      fields: [
        { key: 'kind', label: 'level', type: 'select', required: true, options: (levels.length ? levels : [{ kind: 'ROW', name: 'Row' }, { kind: 'RACK', name: 'Rack' }, { kind: 'SHELF', name: 'Shelf' }, { kind: 'BOX', name: 'Box' }]).map((l) => ({ value: l.kind, label: `${l.name || l.kind} (${l.nodes ?? '?'})` })), initial: kind },
        { key: 'parent_location_id', label: 'parent location id', type: 'number', required: true, initial: parentId, help: 'id of the warehouse/row/rack it belongs to — open the parent screen to add a child instead' },
        { key: 'code', label: 'code', required: true, placeholder: 'R05' },
        { key: 'label', label: 'human label', placeholder: 'Aisle 5, near the press' },
        { key: 'capacity_items', label: 'how many tools fit', type: 'number', min: 0, initial: 8 },
        { key: 'max_weight_kg', label: 'max weight (kg)', type: 'number' },
        { key: 'level_no', label: 'level / bay number', type: 'number', min: 0 },
        { key: 'side', label: 'side', type: 'select', options: ['LEFT', 'RIGHT', 'FRONT', 'BACK', 'CENTER'] },
        { key: 'description', label: 'description', type: 'text', wide: true },
      ],
    });
    if (!values) return;
    try {
      const created = await api.post('/api/warehouse/locations', values);
      toast(`${created.full_code ?? created.location?.full_code ?? values.code} created`, 'ok');
      paint();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  const levels = kinds?.items || kinds?.levels || [];

  const node = h(
    'div',
    null,
    h(
      'div',
      { class: 'section-title' },
      h('h1', null, 'locations'),
      h('span', { class: 'sub' }, 'every tool has exactly one place — this is the map of the tool room'),
      h('span', { class: 'grow' }),
      button('📷 scan a shelf', { kind: 'primary small', onClick: async () => { const s = await openScanner({ title: 'scan the shelf label' }); if (s) openLocationByCode(s.code.replace(/^SP:L:/, '')); } }),
    ),
    card({ dense: true }, search),
    body,
  );
  search.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const q = search.value.trim();
    if (!q) return;
    const out = await api.get(`/api/warehouse/search${qs({ q })}`);
    const box = document.getElementById('loc-section') || body;
    box.replaceChildren(
      card(
        { title: `${out.count} place(s) matching “${q}”` },
        table(
          [
            { label: 'code', render: (l) => h('b', { class: 'code' }, l.full_code) },
            { label: 'path', render: (l) => l.label_path || '' },
            { label: 'kind', render: (l) => badge(String(l.kind).toLowerCase()) },
            { label: 'tools', render: (l) => String(l.direct_items ?? l.occupancy_items ?? 0) },
            { label: 'fill', render: (l) => (l.fill_pct !== null ? meter(Number(l.occupancy_items || 0), Number(l.capacity_items || 1), `${l.fill_pct}%`) : '—') },
            { label: 'warehouse', render: (l) => l.warehouse_code || '' },
          ],
          out.items,
          { onRowOpen: (l) => openLocation(l.id) },
        ),
      ),
    );
  });
  await paint();
  return node;
}

/* ------------------------------------------------------- location detail */
async function LocationDetailView(mount, route) {
  const refRaw = route.segments[1];
  const box = h('div', null, spinner('loading the place…'));
  let id = Number(refRaw);
  if (!Number.isInteger(id) || id <= 0) {
    const out = await api.get(`/api/warehouse/locations/resolve/${encodeURIComponent(refRaw)}`).catch(() => null);
    if (!out) {
      return card({ title: 'unknown location' }, notice('error', `no shelf or box is called “${refRaw}”`), button('back to the map', { kind: 'ghost', onClick: () => go('/locations') }));
    }
    id = out.location.id;
  }
  let d = null;

  async function reload() {
    box.replaceChildren(spinner('loading the place…'));
    try {
      d = await api.get(`/api/warehouse/locations/${id}${qs({ deep: 1 })}`);
      box.replaceChildren(node2(d));
    } catch (err) {
      box.replaceChildren(errorBox(err));
    }
  }

  function node2(detail) {
    const loc = detail.location;
    const items = detail.items || [];
    const tone = loc.fill_pct === null ? '' : loc.fill_pct >= 100 ? 'bad' : loc.fill_pct >= 70 ? 'warn' : 'ok';
    const fill = h('div', { class: `big-code center code-hero ${tone}` }, loc.full_code);
    const head = h(
      'div',
      { class: 'section-title' },
      h(
        'div',
        null,
        h('div', { class: 'chips' }, badge(String(loc.kind).toLowerCase()), badge(String(loc.status || 'available').toLowerCase(), loc.status === 'AVAILABLE' ? 'ok' : 'warn'), loc.warehouse_code ? badge(loc.warehouse_code) : null),
        h('h1', { class: 'code mono-title' }, loc.full_code),
        h('div', { class: 'sub' }, loc.label_path || loc.label || ''),
      ),
      h('span', { class: 'grow' }),
      buttons([
        button('back', { kind: 'ghost small', onClick: () => (history.length > 1 ? back() : go('/locations')) }),
        button('🏷 print shelf labels', { kind: 'ghost small', onClick: () => printShelf(loc) }),
        can('locations.manage') ? button('edit', { kind: 'ghost small', onClick: () => editLoc(loc) }) : null,
        can('locations.manage') ? button('📦 move everything out', { kind: 'ghost small', onClick: () => moveContents(loc) }) : null,
      ]),
    );

    const stats = h(
      'div',
      { class: 'tiles' },
      statTile({ label: 'tools here', value: items.length, sub: `${detail.counts?.pieces ?? 0} physical pieces` }),
      statTile({ label: 'capacity', value: loc.capacity_items ?? 'not set', sub: loc.fill_pct !== null ? `${loc.fill_pct}% full` : 'no capacity planned', tone: tone === 'bad' ? 'danger' : tone === 'warn' ? 'warn' : 'ok' }),
      statTile({ label: 'sub-places', value: detail.counts?.children ?? (detail.children || []).length, sub: 'children in the hierarchy' }),
      statTile({ label: 'free space', value: loc.capacity_items ? Math.max(0, Number(loc.capacity_items) - Number(loc.occupancy_items || 0)) : '—', sub: 'tools could be put here' }),
    );

    const labelBox = card(
      { title: 'the label on this place', subtitle: 'scan it from the phone to open this screen' },
      h('div', { class: 'code-boxes' }, h('img', { src: `/api/warehouse/locations/${loc.id}/qr`, alt: 'QR' }), h('img', { src: `/api/warehouse/locations/${loc.id}/barcode`, alt: 'barcode' })),
      h('p', { class: 'tiny muted' }, `payload: ${loc.qr_payload || `SP:L:${loc.full_code}`}`),
    );

    const itemsCard = card(
      { title: `what is on this shelf (${items.length})`, actions: can('locations.manage') ? button('＋ park a tool here', { kind: 'primary small', onClick: () => parkTool(loc) }) : null },
      table(
        [
          { label: 'photo', render: (t) => (t.primary_image_id ? h('img', { class: 'thumb', src: `/api/files/images/${t.primary_image_id}`, alt: '', loading: 'lazy' }) : h('span', { class: 'thumb none' }, '🧿')) },
          { label: 'tooling', render: (t) => h('div', null, h('b', { class: 'code' }, t.tooling_id), h('div', { class: 'tiny muted' }, t.name)) },
          { label: 'category', render: (t) => `${t.icon || ''} ${t.type_name}` },
          { label: 'size', render: (t) => h('span', { class: 'tiny' }, sizeString(t, ['overall_length_mm', 'overall_width_mm', 'overall_height_mm'])) },
          { label: 'status', render: (t) => statusBadge(t.status) },
          { label: 'qty', key: 'quantity' },
          { label: 'filter', render: (t) => (t.filter_number ? h('a', { class: 'code', href: `#/filters/${encodeURIComponent(t.filter_number)}` }, t.filter_number) : '—') },
          {
            label: '',
            render: (t) =>
              can('tooling.move')
                ? h('button', { class: 'btn small ghost', onclick: async () => { await moveTool({ id: t.id, tooling_id: t.tooling_id, name: t.name, location_code: loc.full_code }, { mode: 'TAKE' }); reload(); } }, 'take')
                : null,
          },
        ],
        items,
        { onRowOpen: (t) => openTooling(t.tooling_id), emptyText: 'nothing is stored here right now' },
      ),
    );

    const childrenCard = (detail.children || []).length
      ? card(
          { title: `${detail.children.length} place(s) below this one`, actions: can('locations.manage') ? button('＋ add a child', { kind: 'primary small', onClick: () => addChild(loc) }) : null },
          h(
            'div',
            { class: 'cells wrap' },
            ...detail.children.map((c) =>
              h(
                'button',
                {
                  class: `cell ${c.fill_pct === null ? (c.items_total || c.occupancy_items ? 'part' : 'empty') : c.fill_pct >= 100 ? 'over' : c.fill_pct >= 70 ? 'nearly' : c.occupancy_items ? 'part' : 'empty'}`,
                  onclick: () => openLocation(c.id),
                  title: `${c.full_code} · ${c.occupancy_items ?? 0}/${c.capacity_items ?? '?'} · ${c.status}`,
                },
                h('span', { class: 'cell-code' }, c.code),
                h('span', { class: 'cell-qty' }, String(c.occupancy_items ?? 0)),
                c.capacity_items ? h('span', { class: 'cell-bar' }, h('span', { style: `width:${Math.min(100, c.fill_pct || 0)}%` })) : null,
              ),
            ),
          ),
        )
      : null;

    const stockCard = (detail.stock || []).length
      ? card(
          { title: 'finished goods stored here', subtitle: 'stock rows that reuse this shelf code' },
          table([{ label: 'sku', render: (s) => h('b', { class: 'code' }, s.sku) }, { label: 'name', key: 'name' }, { label: 'pieces', render: (s) => h('b', null, String(s.quantity)) }, { label: 'unit', key: 'unit' }], detail.stock),
        )
      : null;

    const movesCard = (detail.recent_movements || []).length
      ? card(
          { title: 'recent movements in and out of here' },
          table(
            [
              { label: 'when', render: (m) => h('span', { class: 'tiny nowrap' }, when(m.created_at)) },
              { label: 'tool', render: (m) => h('a', { class: 'code', href: `#/tooling/${encodeURIComponent(m.tooling_id)}` }, m.tooling_id) },
              { label: 'action', render: (m) => badge(m.movement_type, m.movement_type === 'TAKE' ? 'warn' : 'ok') },
              { label: 'by', key: 'username' },
            ],
            detail.recent_movements,
          ),
        )
      : null;

    return h('div', null, head, fill, stats, h('div', { class: 'two-col' }, itemsCard, h('div', { class: 'stack' }, labelBox, childrenCard, stockCard)), movesCard);
  }

  async function printShelf(loc) {
    const out = await api.post('/api/labels/sheet', { kind: 'location', ids: [loc.id] });
    printHtml(out.html);
    toast(`${out.count} label(s) ready`, 'ok');
  }

  async function editLoc(loc) {
    const values = await formDialog({
      title: `edit ${loc.full_code}`,
      fields: [
        { key: 'label', label: 'label' },
        { key: 'capacity_items', label: 'tool places', type: 'number', min: 0, initial: loc.capacity_items },
        { key: 'max_weight_kg', label: 'max weight (kg)', type: 'number', initial: loc.max_weight_kg },
        { key: 'level_no', label: 'level / bay', type: 'number', initial: loc.level_no },
        { key: 'side', label: 'side', type: 'select', options: ['LEFT', 'RIGHT', 'FRONT', 'BACK', 'CENTER'], initial: loc.side },
        { key: 'status', label: 'status', type: 'select', options: ['AVAILABLE', 'FULL', 'MAINTENANCE', 'BLOCKED', 'DISABLED'], initial: loc.status },
        { key: 'description', label: 'description', type: 'textarea', wide: true },
      ],
      initial: loc,
    });
    if (!values) return;
    try {
      await api.put(`/api/warehouse/locations/${loc.id}`, values);
      toast('saved', 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function addChild(loc) {
    const nextKind = { WAREHOUSE: 'ROW', ROW: 'RACK', RACK: 'SHELF', SHELF: 'BOX', BOX: null }[loc.kind];
    if (!nextKind) return toast('a box is the last level — put tools in it instead', 'warn');
    const values = await formDialog({
      title: `new ${nextKind.toLowerCase()} under ${loc.full_code}`,
      fields: [
        { key: 'code', label: 'code', required: true, placeholder: nextKind === 'RACK' ? 'RK07' : nextKind === 'SHELF' ? 'S05' : nextKind === 'BOX' ? 'B03' : 'R05' },
        { key: 'label', label: 'label', placeholder: 'near the press line' },
        { key: 'capacity_items', label: 'places', type: 'number', min: 0, initial: nextKind === 'SHELF' ? 8 : nextKind === 'BOX' ? 4 : 0 },
        { key: 'level_no', label: 'level / bay number', type: 'number' },
        { key: 'side', label: 'side', type: 'select', options: ['LEFT', 'RIGHT', 'FRONT', 'BACK', 'CENTER'] },
      ],
    });
    if (!values) return;
    try {
      await api.post('/api/warehouse/locations', { ...values, kind: nextKind, parent_location_id: loc.id });
      toast('created', 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function parkTool(loc) {
    const picked = await pickTooling({ title: 'which tool goes here?' });
    if (!picked) return;
    try {
      await api.post(`/api/tooling/${picked.id}/move`, { action: 'MOVE', location_id: loc.id, reason: 'ASSIGNED', note: 'parked from the location screen' });
      toast(`${picked.tooling_id} → ${loc.full_code}`, 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function moveContents(loc) {
    const values = await formDialog({
      title: 'move everything out of here',
      subtitle: `${loc.occupancy_items ?? 0} tool(s) will be re-shelved`,
      fields: [
        { key: 'to', label: 'destination shelf code', required: true, placeholder: 'TR-R02-RK05-S03', wide: true },
        { key: 'only_status', label: 'only tools with this status', type: 'select', options: ['AVAILABLE', 'IN_USE', 'MAINTENANCE', 'DAMAGED', 'MISSING', 'RESERVED'] },
        { key: 'note', label: 'note', type: 'text', wide: true, help: 'written to every movement row' },
      ],
    });
    if (!values) return;
    try {
      const out = await api.post(`/api/warehouse/locations/${loc.id}/move-contents`, values);
      toast(`${out.moved} tool(s) moved ${out.from} → ${out.to}`, 'ok', 6000);
      reload();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  await reload();
  return box;
}

/* =============================================================== movements */
async function MovementsView(mount, route) {
  const st = { tab: route.query.tab || 'history', q: route.query.q || '', type: route.query.type || '', days: route.query.days || '', tool: route.query.tool || '', page: Number(route.query.page || 1), size: 50 };
  const body = h('div', null);
  const tabNode = h('div', null);
  const TABS = [
    { key: 'history', label: '🕓 history' },
    { key: 'out', label: '🚚 out now' },
    { key: 'stats', label: '📊 patterns' },
  ];
  let active = st.tab;
  const paint = async () => {
    tabNode.replaceChildren(...tabs(TABS, active, (key) => ((active = key), history.replaceState(null, '', `#/movements${qs({ ...st, tab: key })}`), paint())).children);
    body.replaceChildren(spinner('loading…'));
    try {
      body.replaceChildren(await ({ history: historyTab, out: outTab, stats: statsTab })[active]());
    } catch (err) {
      body.replaceChildren(errorBox(err));
    }
  };

  async function historyTab() {
    const params = { ...st };
    delete params.tab;
    if (params.tool) params.tooling_code = params.tool;
    delete params.tool;
    const out = await api.get(`/api/movements${qs(params)}`);
    const cols = [
      { label: 'when', render: (m) => h('div', null, h('b', { class: 'tiny nowrap' }, when(m.created_at)), h('div', { class: 'tiny muted nowrap' }, dateOnly(m.created_at))) },
      { label: 'action', render: (m) => badge(m.movement_type.replace(/_/g, ' ').toLowerCase(), m.movement_type === 'TAKE' ? 'warn' : m.movement_type === 'RETURN' ? 'ok' : m.movement_type === 'UNDO' ? 'danger' : '') },
      { label: 'tool', render: (m) => h('div', null, h('a', { class: 'code', href: `#/tooling/${encodeURIComponent(m.tooling_id)}` }, m.tooling_id), h('div', { class: 'tiny muted' }, m.tooling_name)) },
      { label: 'category', render: (m) => h('span', { class: 'tiny' }, `${m.icon || ''} ${m.type_name || ''}`) },
      { label: 'from', render: (m) => h('span', { class: 'tiny' }, m.moved_from || '—') },
      { label: 'to', render: (m) => h('span', { class: 'tiny' }, m.moved_to || '—') },
      { label: 'qty', key: 'qty' },
      { label: 'status', render: (m) => (m.status_before !== m.status_after ? h('span', { class: 'tiny' }, `${m.status_before || ''}→${m.status_after || ''}`) : '') },
      { label: 'order', render: (m) => (m.po_number ? h('a', { class: 'code', href: `#/production/${m.production_order_id}` }, m.po_number) : '') },
      { label: 'by', render: (m) => h('span', { class: 'tiny' }, m.user_name || m.username) },
      { label: 'note', render: (m) => h('span', { class: 'tiny muted' }, m.note || '') },
      {
        label: '',
        render: (m) =>
          can('locations.manage')
            ? h(
                'button',
                {
                  class: 'btn small ghost',
                  title: 'undo this scan (writes a correction row, nothing is deleted)',
                  onclick: async () => {
                    if (!(await confirmDialog(`undo the ${m.movement_type} of ${m.tooling_id} at ${when(m.created_at)}?`, { title: 'mis-scan?', confirmLabel: 'undo it' }))) return;
                    try {
                      const out2 = await api.post(`/api/movements/${m.id}/undo`, { reason: 'mis-scan from the movements screen' });
                      toast(`tool put back to ${out2.restored_location || 'its shelf'}`, 'ok');
                      paint();
                    } catch (err) {
                      toast(err.message, 'error', 9000);
                    }
                  },
                },
                'undo',
              )
            : null,
      },
    ];
    const filters = h('div', { class: 'filters' });
    const mk = (key, label, options) => {
      const el = h('select', null, h('option', { value: '' }, `— ${label} —`), ...options.map((o) => h('option', { value: o.value }, o.label)));
      el.value = st[key] || '';
      el.addEventListener('change', () => ((st[key] = el.value), (st.page = 1), paint()));
      return h('div', { class: 'field' }, h('label', null, label), el);
    };
    filters.appendChild(mk('type', 'action', ['TAKE', 'RETURN', 'MOVE', 'TRANSFER', 'SCRAP', 'INVENTORY_CHECK', 'MAINTENANCE', 'DAMAGE', 'MISSING', 'RELEASE', 'UNDO'].map((v) => ({ value: v, label: v.replace(/_/g, ' ').toLowerCase() }))));
    filters.appendChild(mk('days', 'period', [{ value: '1', label: 'today' }, { value: '7', label: 'last 7 days' }, { value: '30', label: 'last 30 days' }, { value: '90', label: 'last quarter' }]));
    return h(
      'div',
      null,
      card({ dense: true }, filters),
      card({ title: `movement history (${out.pagination.total})`, subtitle: 'append-only — a corrected scan adds an UNDO row, the original stays', actions: buttons([can('tooling.move') ? button('＋ manual entry', { kind: 'ghost small', onClick: () => manualEntry() }) : null, button('⬇ csv', { kind: 'ghost small', onClick: () => downloadWith(`/api/movements/export.csv${qs(params)}`, 'movements.csv') })]) }, table(cols, out.items, { emptyText: 'no movements match', onRowOpen: (m) => openTooling(m.tooling_id) }), pager(out.pagination, (page) => ((st.page = page), paint()))),
    );
  }

  async function manualEntry() {
    const tool = await pickTooling({ title: 'which tool?' });
    if (!tool) return;
    const values = await formDialog({
      title: 'manual movement entry',
      subtitle: 'for paper records and corrections — a note is mandatory',
      fields: [
        { key: 'movement_type', label: 'action', type: 'select', required: true, options: ['TAKE', 'RETURN', 'MOVE', 'TRANSFER', 'SCRAP', 'INVENTORY_CHECK', 'MAINTENANCE', 'DAMAGE', 'MISSING', 'RELEASE'], initial: 'MOVE' },
        { key: 'location', label: 'shelf code or where it is', placeholder: 'TR-R02-RK05-S03' },
        { key: 'qty', label: 'pieces', type: 'number', min: 1, initial: 1 },
        { key: 'reason', label: 'reason', type: 'select', options: ['MIS_SCAN', 'CORRECTION', 'AUDIT', 'OTHER'] },
        { key: 'note', label: 'why are we writing this', type: 'textarea', required: true, wide: true },
      ],
    });
    if (!values) return;
    try {
      await api.post('/api/movements', { tooling_item_id: tool.id, ...values });
      toast('movement recorded', 'ok');
      paint();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function outTab() {
    const out = await api.get('/api/movements/out');
    return h(
      'div',
      null,
      card(
        { title: `out of the tool room now (${out.count})`, subtitle: out.note, actions: buttons([button('📷 scan a return', { kind: 'primary small', onClick: () => scanReturn() }), can('tooling.move') ? button('record a return', { kind: 'ghost small', onClick: () => scanReturn() }) : null]) },
        out.overdue ? notice('warn', `${out.overdue} tool(s) have been out for more than 24 hours`) : null,
        table(
          [
            { label: 'tooling', render: (t) => h('div', null, h('a', { class: 'code', href: `#/tooling/${encodeURIComponent(t.tooling_id)}` }, t.tooling_id), h('div', { class: 'tiny muted' }, t.name)) },
            { label: 'category', render: (t) => `${t.icon || ''} ${t.type_name}` },
            { label: 'home shelf', render: (t) => (t.home_location ? h('span', { class: 'code' }, t.home_location) : '—') },
            { label: 'with', render: (t) => h('span', null, t.external_location || t.machine || t.line || 'unknown') },
            { label: 'order', render: (t) => (t.po_number ? h('a', { class: 'code', href: `#/production/${t.order_id}` }, t.po_number) : '—') },
            { label: 'taken', render: (t) => h('span', { class: 'tiny nowrap' }, when(t.taken_at)) },
            { label: 'for', render: (t) => badge(`${t.hours_out} h`, Number(t.hours_out) > 24 ? 'danger' : 'ok') },
            { label: 'by', render: (t) => t.taken_by || '' },
            {
              label: '',
              render: (t) =>
                can('tooling.move')
                  ? h('button', { class: 'btn small primary', onclick: async () => { await moveTool({ id: t.id, tooling_id: t.tooling_id, name: t.name, location_code: t.home_location }, { mode: 'RETURN' }); paint(); } }, 'return it')
                  : null,
            },
          ],
          out.items,
          { onRowOpen: (t) => openTooling(t.tooling_id), emptyText: 'nothing is out — every tool is on its shelf 🎉' },
        ),
      ),
    );
  }

  async function scanReturn() {
    const s = await openScanner({ title: 'scan the tool, then its shelf' });
    if (!s) return;
    const code = s.code.replace(/^SP:T:/, '');
    try {
      const tool = await api.get(`/api/tooling/code/${encodeURIComponent(code)}`);
      await moveTool({ ...tool.tool, id: tool.tool.id }, { mode: 'RETURN' });
      paint();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function statsTab() {
    const s = await api.get('/api/movements/stats?days=30');
    return h(
      'div',
      null,
      h(
        'div',
        { class: 'two-col' },
        card({ title: 'movements by type', subtitle: 'last 30 days' }, barChart(s.by_type.map((t) => ({ label: t.movement_type.replace(/_/g, ' ').toLowerCase(), value: Number(t.events) })))),
        card({ title: 'who moves tools', subtitle: 'logged actions, last 30 days' }, barChart(s.by_user.map((u) => ({ label: u.username || 'unknown', value: Number(u.events) })))),
      ),
      h(
        'div',
        { class: 'two-col' },
        card({ title: 'per day', subtitle: 'takes vs returns' }, barChart(s.by_day.slice(-21).map((d) => ({ label: String(d.day).slice(5), value: Number(d.events) })))),
        card({ title: 'busiest shelves', subtitle: 'arrivals, last 30 days' }, table([{ label: 'shelf', render: (r) => h('b', { class: 'code' }, r.location) }, { label: 'arrivals', key: 'arrivals' }], s.busiest_locations)),
      ),
    );
  }

  const node = h(
    'div',
    null,
    h(
      'div',
      { class: 'section-title' },
      h('h1', null, 'movements'),
      h('span', { class: 'sub' }, 'every take, move and return — with who, when and why'),
      h('span', { class: 'grow' }),
      button('📷 scan', { kind: 'ghost small', onClick: () => scanReturn() }),
    ),
    tabNode,
    body,
  );
  await paint();
  return node;
}

export { InventoryView, LocationsView, LocationDetailView, MovementsView };
