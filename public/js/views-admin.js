/** Back-office screens: reports, import/export, label printing, alerts, audit log, account and administration. */
import { api, qs, meta, download } from './api.js';
import {
  h, card, button, buttons, badge, grid, statTile, table, kv, pager, empty, spinner, errorBox, notice, tabs,
  meter, form, formDialog, modal, confirmDialog, toast, lightbox, when, dateOnly, printHtml, unitPreference, setUnit, barChart,
} from './ui.js';
import { state, can, go, back, openFilter, openTooling, openLocation, statusCounts, downloadWith } from './store.js';
import { openScanner } from './scan.js';

export const adminViews = {
  '/reports': { view: ReportsView, nav: 'reports', title: 'reports' },
  '/importexport': { view: ImportExportView, nav: 'importexport', title: 'import & export' },
  '/labels': { view: LabelsView, nav: 'labels', title: 'labels' },
  '/notifications': { view: NotificationsView, nav: 'alerts', title: 'alerts' },
  '/audit': { view: AuditView, nav: 'audit', title: 'audit log' },
  '/account': { view: AccountView, nav: null, title: 'account' },
  '/admin': { view: AdminView, nav: 'admin', title: 'settings' },
};

/* ================================================================== reports */
async function ReportsView(mount, route) {
  const defs = await api.get('/api/reports');
  const box = h('div', null);
  let chosen = route.query.report || defs.items[0]?.code;
  let last = null;

  const filters = { days: '90', q: '', type: '', status: '', warehouse_id: '' };
  const bar = h('div', { class: 'filters' });
  for (const key of ['days', 'q']) {
    const el =
      key === 'days'
        ? h(
            'select',
            null,
            ...['7', '30', '90', '180', '365'].map((v) => h('option', { value: v, selected: v === filters.days }, `last ${v} days`)),
          )
        : h('input', { type: 'search', placeholder: 'code, name, shelf…' });
    el.addEventListener(key === 'days' ? 'change' : 'keydown', (e) => {
      if (key === 'q' && e.key !== 'Enter') return;
      filters[key] = el.value;
      if (last) load();
    });
    bar.appendChild(h('div', { class: 'field' }, h('label', null, key === 'q' ? 'search' : 'period'), el));
  }

  async function load() {
    box.replaceChildren(spinner('running the report…'));
    try {
      const rep = await api.get(`/api/reports/${chosen}/data${qs(filters)}`);
      last = rep;
      box.replaceChildren(renderReport(rep));
    } catch (err) {
      box.replaceChildren(errorBox(err));
    }
  }

  function renderReport(rep) {
    const cols = (rep.columns || []).map((c) => ({
      label: String(c).replace(/_/g, ' '),
      render: (row) => {
        const v = row[c];
        if (v === null || v === undefined || v === '') return '—';
        if (c === 'code' || /_id$/.test(c)) return h('span', { class: 'code' }, String(v));
        if (/date|_at$/.test(c)) return h('span', { class: 'tiny nowrap' }, String(v).replace('T', ' ').slice(0, 16));
        return String(v);
      },
    }));
    return card(
      {
        title: `${rep.name} — ${rep.count} row(s)`,
        subtitle: `generated ${when(rep.generated_at)}${rep.days ? ` · window ${rep.days} days` : ''}`,
        actions: buttons([
          can('reports.export')
            ? button('pdf', {
                kind: 'ghost small',
                onClick: () => downloadWith(`/api/reports/${rep.code}.pdf${qs(filters)}`, `${rep.code}.pdf`),
              })
            : null,
          can('reports.export')
            ? button('excel', {
                kind: 'ghost small',
                onClick: () => downloadWith(`/api/reports/${rep.code}.xlsx${qs(filters)}`, `${rep.code}.xlsx`),
              })
            : null,
          can('reports.export')
            ? button('csv', {
                kind: 'ghost small',
                onClick: () => downloadWith(`/api/reports/${rep.code}.csv${qs(filters)}`, `${rep.code}.csv`),
              })
            : null,
          button('print', { kind: 'ghost small', onClick: () => printReport(rep) }),
        ]),
      },
      rep.count
        ? table(cols, rep.rows.slice(0, 300), {
            onRowOpen: (row) => {
              if (row.location) openLocation(row.location);
              else if (row.code && /-/.test(String(row.code))) openTooling(row.code);
            },
          })
        : empty('this report has no rows for those filters', 'widen the period or clear the search'),
      rep.count > 300 ? h('p', { class: 'tiny muted' }, `showing the first 300 of ${rep.count} rows — export for the full list`) : null,
    );
  }

  function printReport(rep) {
    const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const cols = rep.columns || [];
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(rep.name)}</title><style>
      body{font:11px/1.35 -apple-system,Segoe UI,Roboto,sans-serif;margin:10mm;color:#0f172a}
      h1{font-size:18px;margin:0}.sub{color:#475569;margin:2px 0 10px}
      table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #cbd5e1;padding:3px 5px;text-align:left;vertical-align:top}
      th{background:#f1f5f9;font-size:9px;text-transform:uppercase;letter-spacing:.04em}
      tr:nth-child(even) td{background:#f8fafc}@page{size:A4 landscape;margin:8mm}
    </style></head><body><h1>${esc(rep.name)}</h1>
      <p class="sub">Sistemi Purepower · ${esc(rep.count)} rows · generated ${esc(new Date(rep.generated_at).toLocaleString())}${rep.filters ? ` · filters ${esc(JSON.stringify(rep.filters))}` : ''}</p>
      <table><thead><tr>${cols.map((c) => `<th>${esc(String(c).replace(/_/g, ' '))}</th>`).join('')}</tr></thead>
      <tbody>${rep.rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>
    </body></html>`;
    printHtml(html);
  }

  const node = h(
    'div',
    null,
    h(
      'div',
      { class: 'section-title' },
      h('h1', null, 'reports'),
      h('span', { class: 'sub' }, 'eight standard reports, each as PDF, Excel or CSV'),
      h('span', { class: 'grow' }),
      can('reports.export') ? button('⬇ full data bundle', { kind: 'ghost small', onClick: () => downloadWith('/api/export/bundle/all', 'purepower-export-bundle.json') }) : null,
    ),
    h(
      'div',
      { class: 'tiles' },
      ...defs.items.map((r) =>
        h(
          'button',
          {
            class: `tile report ${chosen === r.code ? 'on' : ''}`,
            type: 'button',
            onclick: () => {
              chosen = r.code;
              history.replaceState(null, '', `#/reports?report=${r.code}`);
              load();
            },
          },
          h('span', { class: 'icon' }, { Tooling: '🧿', Warehouse: '🏬', Production: '🏭', Engineering: '📐', Quality: '🔬' }[r.group] || '📄'),
          h('span', { class: 'label' }, r.name),
          h('span', { class: 'sub' }, r.description),
          badge(String(r.group).toLowerCase()),
        ),
      ),
    ),
    bar,
    box,
  );
  await load();
  return node;
}

/* ========================================================== import/export */
async function ImportExportView(mount, route) {
  const [kinds, entities] = await Promise.all([
    api.get('/api/import/templates').then((r) => r.kinds),
    api.get('/api/export/entities').then((r) => r.items),
  ]);
  let chosenKind = route.query.kind || kinds[0]?.code || 'filters';
  const importBox = h('div', null);
  const resultBox = h('div', null);

  function renderKinds() {
    importBox.replaceChildren(
      h(
        'div',
        { class: 'chips' },
        ...kinds.map((k) =>
          h(
            'button',
            {
              class: `chip ${chosenKind === k.code ? 'on' : ''}`,
              type: 'button',
              onclick: () => {
                chosenKind = k.code;
                renderKinds();
                resultBox.replaceChildren();
              },
            },
            k.code,
          ),
        ),
      ),
    );
    const spec = kinds.find((k) => k.code === chosenKind);
    if (spec) {
      importBox.appendChild(
        card(
          {
            title: `${spec.title} — column map`,
            subtitle: 'download the template, fill it in, upload it back; nothing is written until every row validates',
            actions: button('⬇ excel template', {
              kind: 'primary small',
              onClick: () => downloadWith(`/api/import/templates/${spec.code}.xlsx`, `import-${spec.code}-template.xlsx`),
            }),
          },
          table(
            [
              { label: 'column in your sheet', render: (c) => h('b', { class: 'code' }, c.label) },
              { label: 'field', render: (c) => h('span', { class: 'tiny' }, c.key) },
              { label: 'type', render: (c) => badge(c.type || 'text') },
              { label: 'required', render: (c) => (c.required ? badge('yes', 'warn') : '—') },
              { label: 'accepted values', render: (c) => (c.lookup ? h('span', { class: 'tiny muted' }, String(c.lookup).slice(0, 140)) : c.values ? h('span', { class: 'tiny muted' }, c.values.join(', ')) : '—') },
            ],
            spec.columns || [],
          ),
        ),
      );
    }
  }

  const fileInput = h('input', { type: 'file', accept: '.xlsx,.csv,.xls', class: 'visually-hidden' });
  const drop = h(
    'div',
    { class: 'dropzone' },
    h('div', null, 'choose an .xlsx or .csv you filled in'),
    buttons([button('validate first', { kind: 'primary small', onClick: () => runImport(false) }), button('import now', { kind: 'danger small', onClick: () => runImport(true) })]),
  );
  drop.appendChild(fileInput);
  drop.addEventListener('click', (e) => {
    if (e.target === drop || e.target.parentNode === drop) fileInput.click();
  });

  async function runImport(dangerous) {
    const file = fileInput.files?.[0];
    if (!file) return toast('choose the filled-in spreadsheet first', 'error');
    const fd = new FormData();
    fd.append('file', file);
    try {
      const out = await api.upload(`/api/import/${chosenKind}${dangerous ? '' : '/validate'}`, fd);
      resultBox.replaceChildren(renderImportResult(out));
      if (dangerous) {
        toast(`${out.written} row(s) written`, 'ok');
        statusCounts();
      }
    } catch (err) {
      toast(err.message, 'error', 9000);
      resultBox.replaceChildren(errorBox(err));
    }
  }

  function renderImportResult(out) {
    const errors = out.errors || [];
    return card(
      { title: out.dry_run ? `dry run — ${out.valid} of ${out.total} row(s) are valid` : `imported ${out.written} of ${out.total} row(s)` },
      out.dry_run ? notice('info', 'this was a check: nothing was written yet') : notice('ok', `${out.written} row(s) created or updated${out.invalid ? `, ${out.invalid} rejected` : ''}`),
      errors.length
        ? table(
            [
              { label: 'sheet row', render: (e) => (e.row ? `#${e.row}` : '—') },
              { label: 'problem', render: (e) => h('span', { class: 'danger-text' }, (e.errors || [e.error]).join(' · ')) },
              { label: 'data', render: (e) => h('span', { class: 'tiny muted' }, JSON.stringify(e.data || e.row_data || {}).slice(0, 160)) },
            ],
            errors,
          )
        : null,
      out.preview?.length ? table((out.columns || Object.keys(out.preview[0])).map((c) => ({ label: c, key: c })), out.preview) : null,
    );
  }

  const exportBox = card(
    { title: 'exports', subtitle: 'everything below honours the same filters as the screens; rows are capped at 5000' },
    grid(
      2,
      ...entities.map((e) =>
        card({
          dense: true,
          title: e.title,
          actions: buttons([
            button('csv', { kind: 'ghost small', onClick: () => downloadWith(`/api/export/${e.code}.csv`, `${e.code}.csv`) }),
            button('excel', { kind: 'ghost small', onClick: () => downloadWith(`/api/export/${e.code}.xlsx`, `${e.code}.xlsx`) }),
          ]),
        }, h('p', { class: 'tiny muted' }, `GET /api/export/${e.code}.csv`)),
      ),
    ),
  );

  let history = h('div', null);
  api
    .get('/api/import/history')
    .then((out) => {
      history.replaceChildren(
        card(
          { title: 'recent imports', subtitle: 'every import is in the audit log' },
          table(
            [
              { label: 'when', render: (r) => h('span', { class: 'tiny nowrap' }, when(r.created_at)) },
              { label: 'who', key: 'username' },
              { label: 'what', render: (r) => h('span', { class: 'small' }, r.summary) },
            ],
            out.items,
          ),
        ),
      );
    })
    .catch(() => {});

  const node = h(
    'div',
    null,
    h(
      'div',
      { class: 'section-title' },
      h('h1', null, 'import & export'),
      h('span', { class: 'sub' }, 'Excel in, Excel out — with row-by-row validation before anything is written'),
    ),
    importBox,
    can('importexport.manage') ? drop : notice('info', 'your role can export but not import'),
    resultBox,
    exportBox,
    history,
  );
  renderKinds();
  return node;
}

/* ================================================================= labels */
async function LabelsView(mount, route) {
  const st = { kind: route.query.kind || 'tooling', codes: '', template: route.query.template || '', copies: '' };
  const preview = h('div', { class: 'label-preview' }, empty('pick what to print', 'search a tool, scan a label, or type shelf codes'));
  const tplNode = h('div', null);

  async function loadTemplates() {
    const out = await api.get(`/api/labels/templates${qs({ kind: st.kind })}`);
    const tpls = out.items || [];
    if (!st.template) st.template = tpls.find((t) => t.is_default)?.id ?? tpls[0]?.id ?? '';
    tplNode.replaceChildren(
      card(
        {
          title: `${st.kind} label templates`,
          subtitle: 'size, what is shown and how many per sheet — printing always uses the template in force',
          actions: can('labels.manage') ? button('＋ new template', { kind: 'ghost small', onClick: () => newTemplate() }) : null,
        },
        h(
          'div',
          { class: 'chips' },
          ...tpls.map((t) =>
            h(
              'button',
              {
                class: `chip ${Number(st.template) === t.id ? 'on' : ''}`,
                type: 'button',
                onclick: () => ((st.template = t.id), loadTemplates()),
              },
              `${t.name} · ${t.width_mm}×${t.height_mm}mm · ${t.columns_per_row}×${t.rows_per_page}`,
            ),
          ),
        ),
        tpls.length
          ? table(
              [
                { label: 'name', render: (t) => h('b', null, t.name) },
                { label: 'kind', render: (t) => badge(String(t.kind).toLowerCase()) },
                { label: 'size mm', render: (t) => `${t.width_mm} × ${t.height_mm}` },
                { label: 'grid', render: (t) => `${t.columns_per_row} × ${t.rows_per_page}` },
                { label: 'shows', render: (t) => ['show_logo', 'show_type', 'show_filter', 'show_location', 'show_dimensions', 'show_status'].filter((k) => t[k]).map((k) => badge(k.replace('show_', ''))).length ? h('span', { class: 'chips inline' }, ...['logo', 'category', 'filter', 'shelf', 'size', 'status'].filter((_, i) => t[['show_logo', 'show_type', 'show_filter', 'show_location', 'show_dimensions', 'show_status'][i]]).map((x) => badge(x))) : 'codes + QR' },
                { label: 'font', render: (t) => `${Number(t.font_scale ?? 1).toFixed(2)}×` },
                { label: 'default', render: (t) => (t.is_default ? badge('yes', 'ok') : '') },
                {
                  label: '',
                  render: (t) =>
                    can('labels.manage')
                      ? h(
                          'button',
                          { class: 'btn small ghost', onclick: async () => { st.template = t.id; loadTemplates(); } },
                          'use',
                        )
                      : null,
                },
              ],
              tpls,
            )
          : empty('no templates for this kind', 'create one to change the label size or contents'),
      ),
    );
  }

  async function newTemplate() {
    const values = await formDialog({
      title: 'label template',
      wide: true,
      fields: [
        { key: 'name', label: 'name', required: true, placeholder: 'Small shelf tag' },
        { key: 'kind', label: 'for', type: 'select', required: true, options: [{ value: 'TOOLING', label: 'tools' }, { value: 'LOCATION', label: 'shelves' }], initial: st.kind === 'tooling' ? 'TOOLING' : 'LOCATION' },
        { key: 'width_mm', label: 'width (mm)', type: 'number', min: 10, max: 400, initial: 70 },
        { key: 'height_mm', label: 'height (mm)', type: 'number', min: 5, max: 400, initial: 40 },
        { key: 'columns_per_row', label: 'labels per row', type: 'number', min: 1, max: 10, initial: 3 },
        { key: 'rows_per_page', label: 'rows per sheet', type: 'number', min: 1, max: 30, initial: 8 },
        { key: 'font_scale', label: 'font scale', type: 'number', min: 0.5, max: 3, initial: 1 },
        { key: 'show_logo', label: 'show the company logo', type: 'checkbox', initial: true },
        { key: 'show_type', label: 'show the category', type: 'checkbox', initial: true },
        { key: 'show_filter', label: 'show the filter number', type: 'checkbox', initial: true },
        { key: 'show_location', label: 'show the shelf code', type: 'checkbox', initial: true },
        { key: 'show_dimensions', label: 'show the size', type: 'checkbox' },
        { key: 'show_status', label: 'show the status', type: 'checkbox' },
        { key: 'is_default', label: 'make this the default for its kind', type: 'checkbox' },
      ],
    });
    if (!values) return;
    try {
      await api.post('/api/labels/templates', values);
      toast('template created', 'ok');
      loadTemplates();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  function payload(kind, codes) {
    const body = { kind, ids: [], codes };
    if (st.template) body.template_id = Number(st.template);
    return body;
  }

  async function render(html, note) {
    const frame = h('iframe', { class: 'print-frame', title: 'label preview' });
    frame.srcdoc = html.replace('<head>', '<head><base href="/">');
    preview.replaceChildren(
      h(
        'div',
        null,
        note ? notice('info', note) : null,
        h(
          'div',
          { class: 'btn-row' },
          button('🖨 print', { kind: 'primary small', onClick: () => printHtml(html) }),
          can('labels.manage') ? button('mark these as printed', { kind: 'ghost small', onClick: () => toast('printing is already recorded in the audit log', 'info') }) : null,
        ),
        frame,
      ),
    );
  }

  async function printPicked() {
    preview.replaceChildren(spinner('making labels…'));
    try {
      const wanted = Number(st.copies || 20);
      let ids = [];
      if (!st.codes) {
        if (st.kind === 'tooling') {
          const out = await api.get(`/api/tooling${qs({ sort: 'tooling_id', page_size: wanted })}`);
          ids = out.items.map((t) => t.id);
        } else {
          const out = await api.get(`/api/warehouse/locations${qs({ kind: 'SHELF', limit: wanted })}`);
          ids = out.items.slice(0, wanted).map((l) => l.id);
        }
      }
      const out = await api.post('/api/labels/sheet', {
        kind: st.kind,
        ids,
        codes: st.codes || undefined,
        template_id: st.template ? Number(st.template) : undefined,
      });
      await render(out.html, `${out.count} ${st.kind} label(s) using “${out.template?.name ?? 'the default template'}” — print at 100% scale, no margins`);
    } catch (err) {
      preview.replaceChildren(errorBox(err));
    }
  }

  const codes = h('textarea', { rows: 2, placeholder: 'one code per line, e.g. H-00452-A or TR-R02-RK05-S03-B07 — leave empty to print the newest ones', value: st.codes });
  codes.addEventListener('input', () => (st.codes = codes.value.trim()));
  const copies = h('input', { type: 'number', min: 1, max: 200, value: 20 });
  copies.addEventListener('change', () => (st.copies = copies.value));

  async function scanAndAdd() {
    const s = await openScanner({ title: 'scan a tool or shelf label' });
    if (!s) return;
    try {
      const found = await api.post('/api/labels/scan', { code: s.code });
      codes.value = `${codes.value ? `${codes.value.trim()}\n` : ''}${found.code}`;
      st.codes = codes.value.trim();
      toast(`added ${found.code} (${found.kind})`, 'ok');
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  const node = h(
    'div',
    null,
    h(
      'div',
      { class: 'section-title' },
      h('h1', null, 'labels'),
      h('span', { class: 'sub' }, 'every tool and every shelf gets a QR + Code-128 label with the logo on it'),
      h('span', { class: 'grow' }),
      button('📷 scan and add to the sheet', { kind: 'ghost small', onClick: () => scanAndAdd() }),
    ),
    h(
      'div',
      { class: 'chips' },
      ...[['tooling', 'tool labels'], ['location', 'shelf labels']].map(([k, label]) =>
        h(
          'button',
          {
            class: `chip ${st.kind === k ? 'on' : ''}`,
            type: 'button',
            onclick: () => ((st.kind = k), history.replaceState(null, '', `#/labels?kind=${k}`), loadTemplates(), printPicked()),
          },
          label,
        ),
      ),
    ),
    tplNode,
    card(
      {
        title: 'print a sheet',
        actions: buttons([
          button('🖨 make the labels', { kind: 'primary small', onClick: () => printPicked() }),
          can('labels.print') ? button('first roll: everything not printed yet', { kind: 'ghost small', onClick: async () => { const out = await api.post('/api/labels/sheet/unprinted', { kind: st.kind, limit: Number(st.copies || 60), template_id: st.template ? Number(st.template) : undefined }); render(out.html, `${out.count} label(s)`); } }) : null,
        ]),
      },
      h(
        'div',
        { class: 'filters' },
        h('div', { class: 'field wide' }, h('label', null, 'codes'), codes),
        h('div', { class: 'field' }, h('label', null, 'how many'), copies),
      ),
      preview,
    ),
  );
  await loadTemplates();
  return node;
}

/* =========================================================== notifications */
async function NotificationsView(mount, route) {
  const st = { kind: route.query.kind || '', unread: route.query.unread || '', limit: 80 };
  const body = h('div', null, spinner('loading alerts…'));

  const paint = async () => {
    body.replaceChildren(spinner('loading alerts…'));
    try {
      const [out, kRes] = await Promise.all([api.get(`/api/notifications${qs(st)}`), api.get('/api/notifications/kinds')]);
      const byKind = kRes.counts.reduce((a, x) => ({ ...a, [x.kind]: (a[x.kind] || 0) + Number(x.c) }), {});
      body.replaceChildren(
        h(
          'div',
          null,
          h(
            'div',
            { class: 'tiles' },
            statTile({ label: 'unread', value: out.counts.unread, tone: out.counts.unread ? 'warn' : 'ok' }),
            statTile({ label: 'critical', value: out.counts.critical, tone: out.counts.critical ? 'danger' : 'ok' }),
            statTile({ label: 'open alerts', value: out.counts.total }),
          ),
          h(
            'div',
            { class: 'chips' },
            h('button', { class: `chip ${st.kind === '' && st.unread === '' ? 'on' : ''}`, type: 'button', onclick: () => ((st.kind = ''), (st.unread = ''), paint()) }, 'all'),
            h('button', { class: `chip ${st.unread === '1' ? 'on' : ''}`, type: 'button', onclick: () => ((st.unread = st.unread === '1' ? '' : '1'), paint()) }, 'unread only'),
            ...(kRes.kinds || []).map((k) => h('button', { class: `chip ${st.kind === k ? 'on' : ''}`, type: 'button', onclick: () => ((st.kind = st.kind === k ? '' : k), paint()) }, `${k.replace(/_/g, ' ')}${byKind[k] ? ` (${byKind[k]})` : ''}`)),
          ),
          card(
            {
              title: `alerts (${out.items.length})`,
              subtitle: 'these are computed from the live register, not typed in - fix the cause and the alert disappears',
              actions: buttons([
                can('notifications.read') ? button('mark all read', { kind: 'ghost small', onClick: () => markAll() }) : null,
                can('notifications.read') ? button('recompute now', { kind: 'ghost small', onClick: () => refreshAlerts() }) : null,
              ]),
            },
            out.items.length
              ? h(
                  'div',
                  { class: 'list' },
                  ...out.items.map((n) => {
                    const row = h('div', { class: `list-item alert ${n.is_read ? '' : 'unread'}` });
                    row.appendChild(h('span', { class: 'sev', 'data-sev': String(n.severity).toLowerCase() }, n.severity === 'critical' ? '🔴' : n.severity === 'warning' ? '🟠' : '🔵'));
                    const main = h('div', { class: 'grow' });
                    main.appendChild(h('b', null, n.title));
                    main.appendChild(h('div', { class: 'small muted' }, n.message || ''));
                    main.appendChild(h('div', { class: 'tiny muted' }, `${n.kind.replace(/_/g, ' ')} · ${when(n.created_at)}${n.actor_name ? ` · ${n.actor_name}` : ''}`));
                    row.appendChild(main);
                    const actions = h('div', { class: 'line-actions' });
                    if (n.link) actions.appendChild(h('a', { class: 'btn small primary', href: n.link }, 'open'));
                    if (!n.is_read) actions.appendChild(button('read', { kind: 'ghost small', onClick: () => markRead(n) }));
                    if (can('notifications.manage')) actions.appendChild(button('dismiss', { kind: 'ghost small', onClick: () => dismiss(n) }));
                    row.appendChild(actions);
                    return row;
                  }),
                )
              : empty('no open alerts', 'nothing is overdue, missing or blocked right now'),
          ),
        ),
      );
    } catch (err) {
      body.replaceChildren(errorBox(err));
    }
  };

  async function markRead(n) {
    await api.post(`/api/notifications/${n.id}/read`, {});
    statusCounts();
    paint();
  }
  async function markAll() {
    const out = await api.post('/api/notifications/read', { all: true });
    toast(`${out.marked ?? 'all'} marked as read`, 'ok');
    statusCounts();
    paint();
  }
  async function dismiss(n) {
    await api.del(`/api/notifications/${n.id}`);
    toast('dismissed until the next sweep', 'ok');
    statusCounts();
    paint();
  }
  async function refreshAlerts() {
    const out = await api.post('/api/notifications/refresh', {});
    toast(`${out.created} new, ${out.resolved} cleared`, 'ok');
    statusCounts();
    paint();
  }

  const node = h(
    'div',
    null,
    h(
      'div',
      { class: 'section-title' },
      h('h1', null, 'alerts'),
      h('span', { class: 'sub' }, 'overdue maintenance, missing tools, blocked orders, duplicate tooling…'),
    ),
    body,
  );
  await paint();
  return node;
}

/* ==================================================== audit log (read only) */
async function AuditView(mount, route) {
  const st = { q: route.query.q || '', entity_type: route.query.entity_type || '', action: route.query.action || '', from: route.query.from || '', to: route.query.to || '', page: 1, size: 50 };
  const body = h('div', null, spinner('reading the log…'));

  async function paint() {
    body.replaceChildren(spinner('reading the log…'));
    try {
      const [out, stats] = await Promise.all([api.get(`/api/audit${qs(st)}`), api.get('/api/audit/stats').catch(() => null)]);
      const cols = [
        { label: 'when', render: (a) => h('span', { class: 'tiny nowrap' }, when(a.created_at)) },
        { label: 'who', render: (a) => h('div', null, a.username || 'system', h('div', { class: 'tiny muted' }, a.role_code || '')) },
        { label: 'did', render: (a) => badge(String(a.action).toLowerCase()) },
        { label: 'what', render: (a) => h('div', null, badge(String(a.entity_type).replace(/_/g, ' ')), a.entity_label ? h('span', { class: 'code tiny' }, ` ${a.entity_label}`) : null) },
        { label: 'summary', render: (a) => h('span', { class: 'small' }, a.summary || '') },
        { label: 'field', render: (a) => (a.field_name ? h('span', { class: 'tiny' }, a.field_name) : '') },
        { label: 'reason', render: (a) => h('span', { class: 'tiny muted' }, a.reason || '') },
        { label: 'ip', render: (a) => h('span', { class: 'tiny muted' }, a.ip || '') },
      ];
      body.replaceChildren(
        h(
          'div',
          null,
          stats
            ? card({ title: `what the log holds`, subtitle: `${stats.total} rows, never edited, never deleted` }, barChart(stats.by_action.slice(0, 10).map((b) => ({ label: b.action, value: Number(b.c) }))))
            : null,
          card({ dense: true }, searchForm()),
          card(
            {
              title: 'audit trail',
              actions: buttons([
                can('audit.read')
                  ? button('⬇ csv', {
                      kind: 'ghost small',
                      onClick: () => downloadWith(`/api/audit/export.csv${qs(st)}`, 'audit.csv'),
                    })
                  : null,
              ]),
            },
            table(cols, out.items, { onRowOpen: (a) => showRow(a), emptyText: 'nothing matches' }),
            pager(out.pagination, (page) => ((st.page = page), paint())),
          ),
        ),
      );
    } catch (err) {
      body.replaceChildren(errorBox(err));
    }
  }

  function searchForm() {
    const node = h('div', { class: 'filters' });
    const q = h('input', { type: 'search', placeholder: 'tool, order number, person, words in the note…', value: st.q });
    let timer = null;
    q.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => ((st.q = q.value.trim()), (st.page = 1), paint()), 350);
    });
    node.appendChild(h('div', { class: 'field wide' }, h('label', null, 'search'), q));
    for (const [key, label, options] of [
      ['entity_type', 'record type', ['tooling_item', 'filter', 'tooling_location', 'movement', 'maintenance', 'damage_report', 'tooling_request', 'production_order', 'inventory_item', 'user', 'settings', 'duplicate_check', 'file', 'tooling_set', 'warehouse', 'label', 'import', 'session', 'vehicle', 'vehicle_application']],
      ['action', 'action', ['create', 'update', 'delete', 'archive', 'restore', 'move', 'take', 'return', 'status_change', 'maintenance_schedule', 'maintenance_complete', 'damage_report', 'damage_resolve', 'request_approve', 'request_reject', 'cycle_log', 'usage_log', 'reserve', 'release', 'label_print', 'export', 'import', 'login', 'logout']],
    ]) {
      const el = h('select', null, h('option', { value: '' }, `— ${label} —`), ...options.map((v) => h('option', { value: v }, v.replace(/_/g, ' '))));
      el.value = st[key] || '';
      el.addEventListener('change', () => ((st[key] = el.value), (st.page = 1), paint()));
      node.appendChild(h('div', { class: 'field' }, h('label', null, label), el));
    }
    for (const key of ['from', 'to']) {
      const el = h('input', { type: 'date', value: st[key] || '' });
      el.addEventListener('change', () => ((st[key] = el.value), (st.page = 1), paint()));
      node.appendChild(h('div', { class: 'field' }, h('label', null, key === 'from' ? 'from date' : 'to date'), el));
    }
    return node;
  }

  function showRow(a) {
    modal({
      title: `${a.action} · ${a.entity_type}`,
      subtitle: a.summary || '',
      body: h(
        'div',
        null,
        kv([
          ['id', a.id],
          ['at', when(a.created_at)],
          ['who', `${a.username || 'system'}${a.user_name ? ` (${a.user_name})` : ''}`],
          ['record', a.entity_label || a.entity_id],
          ['ip', a.ip],
          ['route', a.route],
          ['reason', a.reason],
        ]),
        a.field_name
          ? h(
              'div',
              { class: 'compare' },
              h('div', { class: 'cmp old' }, h('h4', null, 'before'), h('p', null, String(a.old_value ?? ''))),
              h('div', { class: 'cmp new' }, h('h4', null, 'after'), h('p', null, String(a.new_value ?? ''))),
            )
          : null,
      ),
    });
  }

  const node = h(
    'div',
    null,
    h(
      'div',
      { class: 'section-title' },
      h('h1', null, 'audit log'),
      h('span', { class: 'sub' }, 'who changed what, when, from where — including the old and new value'),
    ),
    body,
  );
  await paint();
  return node;
}

/* ================================================================ account */
async function AccountView() {
  const box = h('div', { class: 'two-col' });
  const me = await api.get('/api/auth/me').catch(() => ({ user: state.user }));
  const user = me.user || me;
  const sessions = await api.get('/api/auth/sessions').catch(() => ({ items: [] }));

  const profile = card(
    { title: 'your profile', subtitle: 'used on every record you touch' },
    kv([
      ['name', user.full_name],
      ['username', user.username],
      ['role', user.role_name || user.role_code],
      ['department', user.department],
      ['email', user.email],
      ['phone', user.phone],
      ['language', user.language],
      ['last sign-in', user.last_login_at ? when(user.last_login_at) : 'now'],
      ['must change password', user.must_change_password ? badge('yes', 'warn') : 'no'],
    ]),
    h(
      'div',
      { class: 'btn-row', style: 'margin-top:10px' },
      button('unit preference', { kind: 'ghost small', onClick: () => chooseUnits() }),
      user.permissions?.length ? button(`your permissions (${user.permissions.length})`, { kind: 'ghost small', onClick: () => showPermissions(user.permissions) }) : null,
    ),
  );

  const security = card(
    { title: 'password & sessions', subtitle: 'sessions die after inactivity; you can close the others' },
    h('div', { class: 'btn-row' }, button('change password', { kind: 'primary small', onClick: () => changePassword() })),
    table(
      [
        { label: 'device', render: (s) => h('span', { class: 'tiny' }, String(s.user_agent || '').slice(0, 60)) },
        { label: 'ip', key: 'ip' },
        { label: 'signed in', render: (s) => h('span', { class: 'tiny nowrap' }, when(s.created_at)) },
        { label: 'last seen', render: (s) => h('span', { class: 'tiny nowrap' }, when(s.last_seen_at)) },
        { label: '', render: (s) => (s.is_current ? badge('this device', 'ok') : h('button', { class: 'btn small ghost', onclick: () => revoke(s) }, 'sign out')) },
      ],
      sessions.items || [],
    ),
  );

  box.replaceChildren(profile, security);
  return h(
    'div',
    null,
    h('div', { class: 'section-title' }, h('h1', null, 'account'), h('span', { class: 'sub' }, `${user.username || ''} · ${user.role_name || user.role_code || ''}`)),
    box,
  );

  function chooseUnits() {
    const current = unitPreference();
    const dialog = modal({
      title: 'measurement units',
      subtitle: 'the database always stores millimetres; this only changes what you see',
      body: h(
        'div',
        { class: 'btn-grid' },
        ...[['mm', 'millimetres'], ['cm', 'centimetres'], ['inch', 'inches']].map(([u, label]) =>
          h(
            'button',
            {
              class: `btn ${current === u ? 'primary' : 'ghost'}`,
              onclick: () => {
                setUnit(u);
                toast(`dimensions now shown in ${label}`, 'ok');
                dialog.close();
                location.reload();
              },
            },
            label,
          ),
        ),
      ),
    });
  }

  function showPermissions(perms) {
    const grouped = perms.reduce((a, code) => {
      const mod = String(code).split('.')[0];
      (a[mod] ||= []).push(code);
      return a;
    }, {});
    modal({
      title: 'your permissions',
      body: h(
        'div',
        null,
        ...Object.entries(grouped).map(([mod, list]) => h('div', { class: 'stack' }, h('h4', null, mod), h('div', { class: 'chips inline' }, ...list.sort().map((c) => badge(c))))),
      ),
    });
  }

  async function changePassword() {
    const values = await formDialog({
      title: 'change password',
      fields: [
        { key: 'current_password', label: 'current password', type: 'password' },
        { key: 'new_password', label: 'new password', type: 'password', required: true, wide: true, help: 'at least 10 characters, letters and digits' },
        { key: 'confirm', label: 'repeat the new password', type: 'password', required: true, wide: true },
      ],
    });
    if (!values) return;
    if (values.new_password !== values.confirm) return toast('the two new passwords do not match', 'error');
    try {
      await api.put('/api/auth/password', { current_password: values.current_password || undefined, new_password: values.new_password });
      toast('password changed - sign in again', 'ok');
      setTimeout(() => go('/login'), 1200);
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function revoke(s) {
    await api.del(`/api/auth/sessions/${s.id}`);
    toast('that session is closed', 'ok');
    box.replaceChildren(spinner('reloading…'));
    const fresh = await api.get('/api/auth/sessions').catch(() => ({ items: [] }));
    sessions.items = fresh.items || [];
    security.replaceChildren(...security.children.length ? [] : []);
    go('/account');
  }
}

/* =============================================================== admin hub */
async function AdminView(mount, route) {
  const tabsDef = [
    { key: 'users', label: '👥 people' },
    { key: 'roles', label: '🔐 roles' },
    { key: 'settings', label: '⚙ settings' },
    { key: 'fields', label: '📐 custom fields' },
    { key: 'backups', label: '💾 backups' },
    { key: 'environment', label: '🩺 environment' },
  ];
  let active = route.query.tab || 'users';
  const body = h('div', null);
  const tabNode = h('div', null);

  const paint = async () => {
    tabNode.replaceChildren(
      ...tabs(
        tabsDef,
        active,
        (key) => ((active = key), history.replaceState(null, '', `#/admin?tab=${key}`), paint()),
      ).children,
    );
    body.replaceChildren(spinner('loading…'));
    try {
      body.replaceChildren(await ({ users: usersTab, roles: rolesTab, settings: settingsTab, fields: fieldsTab, backups: backupsTab, environment: envTab })[active]());
    } catch (err) {
      body.replaceChildren(errorBox(err));
    }
  };

  /* ---- users ---- */
  async function usersTab() {
    const [out, roles] = await Promise.all([api.get('/api/admin/users'), api.get('/api/admin/roles').catch(() => ({ roles: [] }))]);
    return card(
      {
        title: `people (${out.items.length})`,
        subtitle: 'sign-in accounts, roles and what they last did',
        actions: can('users.manage') ? button('＋ add a person', { kind: 'primary small', onClick: () => newUser(roles.roles) }) : null,
      },
      table(
        [
          { label: 'username', render: (u) => h('b', { class: 'code' }, u.username) },
          { label: 'name', key: 'full_name' },
          { label: 'role', render: (u) => badge(String(u.role_code || '').replace(/_/g, ' '), u.role_code === 'admin' ? 'danger' : '') },
          { label: 'department', key: 'department' },
          { label: 'email', render: (u) => h('span', { class: 'tiny' }, u.email || '') },
          { label: 'language', key: 'language' },
          { label: 'last sign-in', render: (u) => (u.last_login_at ? h('span', { class: 'tiny nowrap' }, when(u.last_login_at)) : h('span', { class: 'tiny muted' }, 'never')) },
          { label: 'sessions', render: (u) => String(u.live_sessions ?? 0) },
          { label: 'actions (30d)', render: (u) => String(u.actions_30d ?? 0) },
          { label: 'state', render: (u) => (u.is_active ? badge('active', 'ok') : badge('disabled')) },
          {
            label: '',
            render: (u) =>
              can('users.manage')
                ? h(
                    'div',
                    { class: 'line-actions' },
                    h('button', { class: 'btn small ghost', onclick: () => editUser(u) }, 'edit'),
                    h('button', { class: 'btn small ghost', onclick: () => setPassword(u) }, 'password'),
                    h('button', { class: 'btn small ghost', onclick: () => showUserLog(u) }, 'log'),
                  )
                : null,
          },
        ],
        out.items,
      ),
    );
  }

  async function showUserLog(u) {
    const out = await api.get(`/api/audit${qs({ user_id: u.id, size: 30, entity_type: '' })}`).catch(() => null);
    if (!out) return;
    modal({
      title: `${u.username} — last actions`,
      wide: true,
      body: table(
        [
          { label: 'when', render: (a) => h('span', { class: 'tiny nowrap' }, when(a.created_at)) },
          { label: 'action', render: (a) => badge(String(a.action).toLowerCase()) },
          { label: 'record', render: (a) => `${a.entity_type}${a.entity_label ? ` ${a.entity_label}` : ''}` },
          { label: 'summary', render: (a) => a.summary || '' },
        ],
        out.items,
        { emptyText: 'nothing recorded' },
      ),
    });
  }

  async function newUser(roles) {
    const values = await formDialog({
      title: 'add a person',
      wide: true,
      fields: [
        { key: 'username', label: 'username', required: true, pattern: '^[a-z0-9._-]{2,60}$' },
        { key: 'full_name', label: 'full name', required: true },
        { key: 'role', label: 'role', type: 'select', required: true, options: (roles || []).map((r) => ({ value: r.code, label: `${r.name} (${r.user_count})` })), empty: false },
        { key: 'password', label: 'initial password', type: 'password', required: true, wide: true, help: 'at least 8 characters; they will be asked to change it' },
        { key: 'email', label: 'email', type: 'email' },
        { key: 'phone', label: 'phone' },
        { key: 'department', label: 'department' },
        { key: 'language', label: 'language', type: 'select', options: [{ value: 'en', label: 'English' }, { value: 'sq', label: 'Alpine' }, { value: 'de', label: 'German' }], initial: 'en' },
        { key: 'must_change_password', label: 'force a password change at first sign-in', type: 'checkbox', initial: true },
      ],
    });
    if (!values) return;
    try {
      const out = await api.post('/api/admin/users', values);
      toast(`${out.username} created`, 'ok');
      paint();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function editUser(u) {
    const values = await formDialog({
      title: `edit ${u.username}`,
      wide: true,
      fields: [
        { key: 'full_name', label: 'full name', required: true },
        { key: 'email', label: 'email', type: 'email' },
        { key: 'phone', label: 'phone' },
        { key: 'department', label: 'department' },
        { key: 'language', label: 'language' },
        { key: 'is_active', label: 'allowed to sign in', type: 'checkbox' },
      ],
      initial: { ...u, is_active: Boolean(u.is_active) },
    });
    if (!values) return;
    try {
      await api.put(`/api/admin/users/${u.id}`, values);
      toast('saved', 'ok');
      paint();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function setPassword(u) {
    const values = await formDialog({
      title: `new password for ${u.username}`,
      fields: [
        { key: 'password', label: 'password', type: 'password', required: true, wide: true },
        { key: 'must_change', label: 'they must change it at first sign-in', type: 'checkbox', initial: true },
      ],
    });
    if (!values) return;
    try {
      const out = await api.post(`/api/admin/users/${u.id}/password`, values);
      toast(`password set${out.sessions_revoked ? ' and their sessions were closed' : ''}`, 'ok');
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  /* ---- roles ---- */
  async function rolesTab() {
    const out = await api.get('/api/admin/roles');
    const modules = out.modules || [];
    return h(
      'div',
      null,
      card(
        {
          title: 'roles',
          subtitle: 'what each job may do — the API refuses anything else, the menus just hide it',
          actions: can('users.manage') ? button('⟳ re-sync the permission list', { kind: 'ghost small', onClick: () => syncPermissions() }) : null,
        },
        table(
          [
            { label: 'code', render: (r) => h('b', { class: 'code' }, r.code) },
            { label: 'name', key: 'name' },
            { label: 'people', render: (r) => String(r.user_count) },
            { label: 'permissions', render: (r) => String(r.permission_count) },
            { label: 'for', render: (r) => h('span', { class: 'tiny muted' }, r.description || '') },
            { label: 'system', render: (r) => (r.is_system ? badge('built in', 'ok') : '') },
            {
              label: '',
              render: (r) =>
                can('users.manage')
                  ? h('button', { class: 'btn small ghost', onclick: () => editRole(r, out.permissions) }, 'edit rights')
                  : null,
            },
          ],
          out.roles,
        ),
      ),
      h(
        'div',
        { class: 'tiles' },
        ...modules.map((mod) => statTile({ label: mod, value: out.permissions.filter((p) => p.module === mod).length, sub: 'permissions in this module' })),
      ),
    );
  }

  async function editRole(role, permissions) {
    const have = new Set(role.permissions || []);
    const boxes = [];
    const groups = permissions.reduce((a, p) => ((a[p.module] ||= []).push(p), a), {});
    const node = h(
      'div',
      null,
      ...Object.entries(groups).map(([mod, list]) => {
        const listBox = h('div', { class: 'chips inline wrap' });
        for (const p of list) {
          const cb = h('input', { type: 'checkbox', checked: have.has(p.code) });
          cb.dataset.code = p.code;
          boxes.push(cb);
          listBox.appendChild(h('label', { class: 'chip-check', title: p.description || '' }, cb, h('span', null, p.code)));
        }
        return h('div', { class: 'stack' }, h('h4', null, mod), listBox);
      }),
    );
    const dialog = modal({
      title: `${role.name} — permissions`,
      subtitle: `${have.size} of ${permissions.length} checked`,
      wide: true,
      body: node,
      actions: buttons([
        can('users.manage')
          ? button('save', {
              kind: 'primary',
              onClick: async () => {
                const codes = boxes.filter((b) => b.checked).map((b) => b.dataset.code);
                try {
                  await api.put(`/api/admin/roles/${role.code}/permissions`, { permissions: [], codes: codes.join(',') });
                  toast(`${codes.length} permission(s) saved for ${role.code}`, 'ok');
                  dialog.close();
                  paint();
                } catch (err) {
                  toast(err.message, 'error', 9000);
                }
              },
            })
          : null,
        button('close', { kind: 'ghost', onClick: () => dialog.close() }),
      ]),
    });
  }

  async function syncPermissions() {
    try {
      const out = await api.post('/api/admin/permissions/sync', {});
      toast(`${out.added ?? 0} added · ${out.renamed?.length ?? 0} renamed · ${out.removed?.length ?? out.removed ?? 0} removed`, 'ok', 8000);
      paint();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  /* ---- settings ---- */
  async function settingsTab() {
    const out = await api.get('/api/admin/settings');
    const groups = out.groups || [];
    const byGroup = groups.map((g) => ({ group: g, items: out.items.filter((i) => i.group_name === g) }));
    const others = out.items.filter((i) => !i.group_name);
    if (others.length) byGroup.push({ group: 'other', items: others });
    const editors = new Map();
    const node = h(
      'div',
      null,
      ...byGroup.map((g) =>
        card(
          { title: g.group },
          h(
            'div',
            { class: 'stack' },
            ...g.items.map((s) => {
              let input;
              if (s.value_type === 'boolean') {
                input = h('input', { type: 'checkbox', checked: ['1', 'true', 'yes', 'on'].includes(String(s.value).toLowerCase()) });
              } else if (s.value_type === 'select') {
                input = h('select', null, ...String(s.options ?? '').split(',').filter(Boolean).map((o) => h('option', { value: o, selected: o === s.value }, o)));
              } else if (s.value_type === 'number') {
                input = h('input', { type: 'number', value: s.value ?? '' });
              } else {
                input = h('input', { type: 'text', value: s.value ?? '' });
              }
              editors.set(s.setting_key, { input, type: s.value_type });
              return h(
                'div',
                { class: 'setting-row' },
                h('div', { class: 'grow' }, h('b', null, s.label || s.setting_key), h('div', { class: 'tiny muted' }, `${s.setting_key}${s.description ? ` · ${s.description}` : ''}`)),
                input,
              );
            }),
          ),
        ),
      ),
    );
    return card(
      {
        title: 'settings',
        subtitle: 'how strict the app is about cycles, maintenance windows, units and demo data',
        actions: buttons([
          can('settings.manage')
            ? button('save changes', {
                kind: 'primary small',
                onClick: async () => {
                  const values = {};
                  for (const [key, { input, type }] of editors) {
                    if (type === 'boolean') values[key] = input.checked ? '1' : '0';
                    else if (input.value !== undefined && input.value !== null) values[key] = String(input.value);
                  }
                  try {
                    const saved = await api.put('/api/admin/settings', { settings: values });
                    toast(`${saved.changed?.length ?? 0} setting(s) saved${saved.rejected?.length ? `, ${saved.rejected.length} refused` : ''}`, 'ok');
                    meta.data = saved.items ? { ...meta.data, settings: saved.items } : meta.data;
                  } catch (err) {
                    toast(err.message, 'error', 9000);
                  }
                },
              })
            : null,
          can('settings.manage') ? button('clear the server cache', { kind: 'ghost small', onClick: async () => (await api.post('/api/admin/cache/clear', {}), toast('cache cleared', 'ok')) }) : null,
        ]),
      },
      node.children.length ? node : empty('no settings exposed to your role'),
    );
  }

  /* ---- custom dimension fields ---- */
  async function fieldsTab() {
    const out = await api.get('/api/admin/fields?entity=TOOLING');
    return h(
      'div',
      null,
      card(
        { title: 'built-in measurements', subtitle: 'always available on every tool and filter' },
        table(
          [
            { label: 'field', render: (f) => h('b', null, f.label) },
            { label: 'key', render: (f) => h('span', { class: 'code tiny' }, f.key) },
            { label: 'unit', render: (f) => badge(f.unit || '—') },
            { label: 'applies to', render: (f) => (f.applies_to ? badge(f.applies_to) : '—') },
          ],
          out.builtin,
        ),
      ),
      card(
        {
          title: `custom fields (${out.custom.length})`,
          subtitle: 'add one and every tool of that category grows the input — nothing is thrown away',
          actions: can('dimensions.manage') ? button('＋ add a field', { kind: 'primary small', onClick: () => addField() }) : null,
        },
        table(
          [
            { label: 'label', render: (f) => h('b', null, f.label) },
            { label: 'key', render: (f) => h('span', { class: 'code tiny' }, f.field_key) },
            { label: 'type', render: (f) => badge(f.data_type || 'decimal') },
            { label: 'unit', render: (f) => f.unit || '—' },
            { label: 'category', render: (f) => (f.applies_to_name ? badge(`${f.applies_to_code} ${f.applies_to_name}`) : 'every tooling type') },
            { label: 'in use by', render: (f) => `${f.used_by} tool(s)` },
            { label: 'state', render: (f) => (f.is_active ? badge('active', 'ok') : badge('off')) },
            {
              label: '',
              render: (f) =>
                can('dimensions.manage')
                  ? h(
                      'button',
                      {
                        class: 'btn small ghost',
                        onclick: async () => {
                          await api.del(`/api/admin/fields/${f.id}`);
                          toast('removed from the form (stored values are kept)', 'ok');
                          paint();
                        },
                      },
                      'retire',
                    )
                  : null,
            },
          ],
          out.custom,
          { emptyText: 'no custom fields yet' },
        ),
      ),
    );
  }

  async function addField() {
    const values = await formDialog({
      title: 'add a custom measurement',
      fields: [
        { key: 'label', label: 'what to call it', required: true, wide: true, placeholder: 'Bead groove diameter' },
        { key: 'field_key', label: 'key', placeholder: 'bead_groove_diameter' },
        { key: 'unit', label: 'unit', type: 'select', options: ['mm', 'cm', 'inch', 'g', 'kg', 'shore_a', 'text'], initial: 'mm' },
        { key: 'data_type', label: 'kind', type: 'select', options: ['decimal', 'int', 'text', 'bool'], initial: 'decimal' },
        { key: 'entity', label: 'applies to', type: 'select', options: [{ value: 'TOOLING', label: 'tooling' }, { value: 'FILTER', label: 'filters' }], initial: 'TOOLING' },
        { key: 'applies_to_type', label: 'only for this category', placeholder: 'HOUSING_RUBBER (empty = all)', wide: true },
      ],
    });
    if (!values) return;
    try {
      await api.post('/api/admin/fields', values);
      toast('field added — it now appears on the tool form', 'ok');
      paint();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  /* ---- backups ---- */
  async function backupsTab() {
    const b = await api.get('/api/admin/backups');
    const s = b.status;
    const age = s.last_success_at ? `${s.age_hours ?? '?'} h ago` : 'never';
    return h(
      'div',
      null,
      card(
        {
          title: 'database backup',
          subtitle: `engine ${s.engine} · ${s.count} snapshot(s) kept, ${Math.round((s.total_bytes || 0) / 1024 / 1024)} MB total · last run ${age}`,
          actions: buttons([
            can('backups.manage')
              ? button('run a backup now', {
                  kind: 'primary small',
                  onClick: async () => {
                    try {
                      const out = await api.post('/api/admin/backups', { note: 'from the admin screen' });
                      toast(`${out.filename} (${Math.round(Number(out.size_bytes || 0) / 1024)} kB)`, 'ok');
                      paint();
                    } catch (err) {
                      toast(err.message, 'error', 9000);
                    }
                  },
                })
              : null,
            can('backups.manage') && (b.files || []).length
              ? button(`folder: ${b.dir || 'backups'}`, { kind: 'ghost small', onClick: () => toast(`${(b.files || []).length} file(s) on disk in ${b.dir}`, 'info', 7000) }) : null,
          ]),
        },
        grid(
          3,
          statTile({ label: 'last backup', value: s.last_success_at ? dateOnly(s.last_success_at) : 'never', sub: age, tone: s.last_success_at ? 'ok' : 'warn' }),
          statTile({ label: 'scheduled', value: s.schedule || 'not configured', sub: s.scheduled_note || '', tone: s.schedule ? 'ok' : 'warn' }),
          statTile({ label: 'keep', value: s.keep, sub: 'how many snapshots are kept' }),
        ),
        table(
          [
            { label: 'file', render: (r) => h('span', { class: 'code tiny' }, r.filename) },
            { label: 'kind', render: (r) => badge(String(r.kind).toLowerCase()) },
            { label: 'state', render: (r) => badge(String(r.status).toLowerCase(), r.status === 'SUCCESS' ? 'ok' : 'danger') },
            { label: 'size', render: (r) => `${Math.round(Number(r.size_bytes || 0) / 1024)} kB` },
            { label: 'engine', render: (r) => String(r.engine || '') },
            { label: 'when', render: (r) => h('span', { class: 'tiny nowrap' }, when(r.created_at)) },
            { label: 'by', render: (r) => r.created_by_name || 'system' },
            { label: 'note', render: (r) => h('span', { class: 'tiny muted' }, (r.message || '').slice(0, 80)) },
            { label: 'on disk', render: (r) => (r.exists_on_disk === false ? badge('missing', 'danger') : badge('yes', 'ok')) },
            {
              label: '',
              render: (r) =>
                can('backups.manage')
                  ? h(
                      'div',
                      { class: 'line-actions' },
                      r.download_url ? h('a', { class: 'btn small ghost', href: r.download_url, download: '' }, 'download') : null,
                      button('delete', {
                        kind: 'ghost small',
                        onClick: async () => {
                          if (!(await confirmDialog(`remove ${r.filename} from disk?`, { danger: true, confirmLabel: 'delete' }))) return;
                          await api.del(`/api/admin/backups/${r.id}`);
                          toast('removed', 'ok');
                          paint();
                        },
                      }),
                    )
                  : null,
            },
          ],
          b.items,
          { emptyText: 'no backups yet - create one before you trust the data' },
        ),
      ),
    );
  }

  /* ---- environment ---- */
  async function envTab() {
    const e = await api.get('/api/admin/environment');
    const health = await api.get('/api/health').catch(() => ({}));
    return h(
      'div',
      null,
      h(
        'div',
        { class: 'tiles' },
        statTile({ label: 'filters', value: e.counts.filters, href: '#/filters' }),
        statTile({ label: 'tooling', value: e.counts.tooling, href: '#/tooling' }),
        statTile({ label: 'locations', value: e.counts.locations, href: '#/locations' }),
        statTile({ label: 'movements', value: e.counts.movements, href: '#/movements' }),
        statTile({ label: 'vehicle applications', value: e.counts.vehicles }),
        statTile({ label: 'audit rows', value: e.counts.audit_rows, href: '#/audit' }),
      ),
      h(
        'div',
        { class: 'two-col' },
        card(
          { title: 'app' },
          kv([
            ['name', e.app.name],
            ['module', e.app.module],
            ['environment', e.app.env],
            ['version', e.app.version],
            ['health', health?.status || '—'],
            ['database mode', health?.database?.mode || e.database.mode],
          ]),
        ),
        card(
          { title: 'server' },
          kv([
            ['node', e.server.node],
            ['pid', e.server.pid],
            ['uptime', `${Math.floor(e.server.uptime_seconds / 3600)} h ${Math.round((e.server.uptime_seconds % 3600) / 60)} min`],
            ['memory', `${e.server.memory_mb} MB`],
          ]),
        ),
      ),
      h(
        'div',
        { class: 'two-col' },
        card(
          { title: 'database' },
          kv([
            ['mode', e.database.mode],
            ['host', e.database.host],
            ['port', e.database.port || 'embedded'],
            ['name', e.database.name],
            ['version', e.database.version],
          ]),
        ),
        card(
          { title: 'limits & flags', actions: can('settings.manage') ? button('clear caches', { kind: 'ghost small', onClick: async () => (await api.post('/api/admin/cache/clear', {}), toast('session + permission caches cleared', 'ok')) }) : null },
          kv([
            ['image upload', `${e.limits.upload_image_mb} MB`],
            ['file upload', `${e.limits.upload_doc_mb} MB`],
            ['page size max', e.limits.page_size],
            ['api rate limit', `${e.limits.rate_limit_api} requests / window`],
            ['sql debug', e.flags.sql_debug ? 'on' : 'off'],
            ['demo password override', e.flags.demo_password ? 'on (development only)' : 'off'],
          ]),
        ),
      ),
    );
  }

  const node = h(
    'div',
    null,
    h(
      'div',
      { class: 'section-title' },
      h('h1', null, 'administration'),
      h('span', { class: 'sub' }, 'people, permissions, settings, custom fields, backups, environment'),
    ),
    tabNode,
    body,
  );
  await paint();
  return node;
}

export { ReportsView, ImportExportView, LabelsView, NotificationsView, AuditView, AccountView, AdminView };
