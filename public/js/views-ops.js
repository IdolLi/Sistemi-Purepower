/** Operations screens: maintenance + damage, tooling requests, production orders. */
import { api, qs, meta, statusInfo } from './api.js';
import {
  h, card, button, buttons, badge, statusBadge, grid, statTile, table, kv, pager, empty, spinner, errorBox, notice, tabs,
  meter, form, formDialog, modal, confirmDialog, toast, photoGrid, lightbox, when, dateOnly, daysUntil, mm, sizeString,
  UnitToggle, unitPreference, barChart, printHtml,
} from './ui.js';
import { state, can, go, back, openFilter, openTooling, openLocation, moveTool, reportDamage, pickTooling, pickFilter, downloadWith, statusCounts } from './store.js';
import { openScanner } from './scan.js';

export const opsViews = {
  '/maintenance': { view: MaintenanceView, nav: 'maintenance', title: 'maintenance' },
  '/requests': { view: RequestsView, nav: 'requests', title: 'tooling requests' },
  '/production': { view: (m, r) => (r.segments[1] ? OrderDetailView(m, r) : ProductionView(m, r)), nav: 'production', title: 'production' },
};

/* ============================================================= maintenance */
async function MaintenanceView(mount, route) {
  const st = { tab: route.query.tab || 'due', q: '', status: '', size: 50, page: 1 };
  let active = st.tab;
  const body = h('div', null);
  const tabNode = h('div', null);
  const TABS = [
    { key: 'due', label: '⏰ due & overdue' },
    { key: 'jobs', label: '🛠 jobs' },
    { key: 'damage', label: '🩹 damage' },
    { key: 'metrics', label: '📊 cost & delay' },
  ];
  const vocab = await api.get('/api/maintenance/vocab').catch(() => ({}));

  const paint = async () => {
    tabNode.replaceChildren(...tabs(TABS, active, (key) => ((active = key), history.replaceState(null, '', `#/maintenance${qs({ tab: key })}`), paint())).children);
    body.replaceChildren(spinner('loading…'));
    try {
      body.replaceChildren(await ({ due: dueTab, jobs: jobsTab, damage: damageTab, metrics: metricsTab })[active]());
    } catch (err) {
      body.replaceChildren(errorBox(err));
    }
  };

  async function dueTab() {
    const d = await api.get('/api/maintenance/due?days=21');
    const toolRow = (t, extra) => ({ ...t, ...(extra || {}) });
    return h(
      'div',
      null,
      h(
        'div',
        { class: 'tiles' },
        statTile({ label: 'overdue', value: d.overdue.length, tone: d.overdue.length ? 'danger' : 'ok', sub: 'maintenance is past its date' }),
        statTile({ label: `due within ${d.window_days} days`, value: d.upcoming.length, tone: d.upcoming.length ? 'warn' : 'ok' }),
        statTile({ label: 'near the cycle limit', value: d.cycle_limits.length, tone: d.cycle_limits.length ? 'warn' : 'ok', sub: 'inspect or rebuild' }),
      ),
      card(
        { title: 'overdue', subtitle: 'these tools should not go back on a machine without a check', actions: can('maintenance.manage') ? button('＋ schedule a job', { kind: 'primary small', onClick: () => scheduleDialog() }) : null },
        table(
          [
            { label: 'tooling', render: (t) => h('b', { class: 'code' }, t.tooling_id) },
            { label: 'name', key: 'name' },
            { label: 'category', render: (t) => `${t.icon || ''} ${t.type_name || ''}` },
            { label: 'was due', render: (t) => badge(`${dateOnly(t.next_maintenance_date)} (${Math.abs(Number(t.days_left))}d late)`, 'danger') },
            { label: 'shelf', render: (t) => t.location_code || '—' },
            { label: 'cycles', render: (t) => (t.max_cycles ? `${t.total_cycles}/${t.max_cycles}` : String(t.total_cycles ?? 0)) },
            {
              label: '',
              render: (t) =>
                can('maintenance.manage')
                  ? h('button', { class: 'btn small primary', onclick: () => scheduleDialog(t) }, 'schedule')
                  : null,
            },
          ],
          d.overdue.map((t) => toolRow(t)),
          { onRowOpen: (t) => openTooling(t.tooling_id), emptyText: 'nothing overdue — good' },
        ),
      ),
      h(
        'div',
        { class: 'two-col' },
        card(
          { title: 'coming up', subtitle: `next ${d.window_days} days` },
          table(
            [
              { label: 'tooling', render: (t) => h('a', { class: 'code', href: `#/tooling/${encodeURIComponent(t.tooling_id)}` }, t.tooling_id) },
              { label: 'due in', render: (t) => badge(`${t.days_left}d`, Number(t.days_left) <= 3 ? 'warn' : '') },
              { label: 'date', render: (t) => dateOnly(t.next_maintenance_date) },
              { label: 'shelf', render: (t) => t.location_code || '—' },
            ],
            d.upcoming,
            { onRowOpen: (t) => openTooling(t.tooling_id) },
          ),
        ),
        card(
          { title: 'cycle limits', subtitle: 'tools that used most of their planned life' },
          table(
            [
              { label: 'tooling', render: (t) => h('a', { class: 'code', href: `#/tooling/${encodeURIComponent(t.tooling_id)}` }, t.tooling_id) },
              { label: 'name', key: 'name' },
              { label: 'used', render: (t) => meter(Number(t.total_cycles || 0), Number(t.max_cycles || 1), `${t.total_cycles}/${t.max_cycles} (${t.used_pct}%)`) },
              { label: 'shelf', render: (t) => t.location_code || '—' },
            ],
            d.cycle_limits,
            { onRowOpen: (t) => openTooling(t.tooling_id) },
          ),
        ),
      ),
    );
  }

  async function jobsTab() {
    const out = await api.get(`/api/maintenance${qs({ ...st, page_size: undefined })}`);
    return card(
      {
        title: `maintenance jobs (${out.pagination.total})`,
        subtitle: 'every job keeps the condition before and after, plus photos',
        actions: buttons([
          can('maintenance.manage') ? button('＋ schedule a job', { kind: 'primary small', onClick: () => scheduleDialog() }) : null,
          button('⬇ excel', { kind: 'ghost small', onClick: () => downloadWith('/api/export/maintenance.xlsx', 'maintenance.xlsx') }),
        ]),
      },
      h(
        'div',
        { class: 'filters' },
        sel('status', 'status', (vocab.maintenance_statuses || ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'DEFERRED', 'CANCELLED']).map((s) => ({ value: s, label: s.replace(/_/g, ' ').toLowerCase() }))),
        sel('kind', 'kind', (vocab.maintenance_types || []).map((s) => ({ value: s, label: s.replace(/_/g, ' ').toLowerCase() }))),
      ),
      table(
        [
          { label: 'planned', render: (m) => h('span', { class: 'nowrap' }, dateOnly(m.scheduled_date) || '—') },
          { label: 'done', render: (m) => dateOnly(m.completed_date) || '—' },
          { label: 'tooling', render: (m) => h('b', { class: 'code' }, m.tooling_id) },
          { label: 'name', render: (m) => h('span', { class: 'tiny' }, m.tooling_name) },
          { label: 'kind', render: (m) => badge(String(m.kind).toLowerCase()) },
          { label: 'priority', render: (m) => badge(String(m.priority).toLowerCase(), m.priority === 'URGENT' ? 'danger' : m.priority === 'HIGH' ? 'warn' : '') },
          { label: 'status', render: (m) => badge(String(m.status).replace(/_/g, ' ').toLowerCase(), m.status === 'COMPLETED' ? 'ok' : m.status === 'IN_PROGRESS' ? 'warn' : '') },
          { label: 'work', render: (m) => h('span', { class: 'tiny muted' }, (m.work_description || '').slice(0, 90)) },
          { label: 'technician', render: (m) => m.technician || '—' },
          { label: 'downtime', render: (m) => (m.downtime_hours ? `${m.downtime_hours} h` : '') },
          { label: 'cost', render: (m) => (m.cost ? `${m.cost}` : '') },
          { label: 'shelf', render: (m) => (m.location_code ? h('span', { class: 'tiny code' }, m.location_code) : '') },
        ],
        out.items,
        { onRowOpen: (m) => jobDialog(m.id), emptyText: 'no jobs with these filters' },
      ),
      pager(out.pagination, (page) => ((st.page = page), paint())),
    );
    function sel(key, label, options) {
      const el = h('select', null, h('option', { value: '' }, `— ${label} —`), ...options.map((o) => h('option', { value: o.value }, o.label)));
      el.value = st[key] || '';
      el.addEventListener('change', () => ((st[key] = el.value), (st.page = 1), paint()));
      return h('div', { class: 'field' }, h('label', null, label), el);
    }
  }

  async function jobDialog(id) {
    const job = await api.get(`/api/maintenance/${id}`);
    const m = job.record || job;
    const beforeIds = String(m.before_image_ids || '').split(',').map(Number).filter(Boolean);
    const beforeImgs = (job.images || []).filter((i) => beforeIds.includes(Number(i.id)));
    const afterImgs = (job.images || []).filter((i) => !beforeIds.includes(Number(i.id)));
    const dialog = modal({
      title: `maintenance job #${m.id}`,
      subtitle: `${m.tooling_id} · ${m.kind} · ${m.status}`,
      wide: true,
      body: h(
        'div',
        null,
        kv([
          ['tool', m.tooling_id],
          ['planned', dateOnly(m.scheduled_date)],
          ['completed', dateOnly(m.completed_date) || 'not yet'],
          ['technician', m.technician],
          ['priority', m.priority],
          ['condition before', m.condition_before],
          ['condition after', m.condition_after],
          ['parts replaced', m.parts_replaced],
          ['downtime', m.downtime_hours ? `${m.downtime_hours} h` : null],
          ['cost', m.cost],
          ['next maintenance after this job', dateOnly(m.next_maintenance_date)],
        ]),
        h('p', null, m.work_description || ''),
        m.findings ? h('p', { class: 'small muted' }, `findings: ${m.findings}`) : null,
        beforeImgs.length || afterImgs.length
          ? h(
              'div',
              { class: 'two-col' },
              card({ dense: true, title: 'before photos' }, photoGrid(beforeImgs, { onOpen: (img) => lightbox(img.url, img.caption) })),
              card({ dense: true, title: 'after photos' }, photoGrid(afterImgs, { onOpen: (img) => lightbox(img.url, img.caption) })),
            )
          : notice('info', 'no before/after photos attached to this job yet'),
        job.damage_report
          ? h(
              'div',
              null,
              h('div', { class: 'group-title' }, 'linked damage report'),
              table(
                [
                  { label: 'report', render: (d) => h('b', { class: 'code' }, d.report_no) },
                  { label: 'kind', key: 'damage_type' },
                  { label: 'severity', render: (d) => badge(String(d.severity).toLowerCase(), d.severity === 'HIGH' || d.severity === 'CRITICAL' ? 'danger' : 'warn') },
                  { label: 'what', render: (d) => h('span', { class: 'tiny' }, d.description) },
                  { label: 'status', render: (d) => badge(String(d.status).toLowerCase()) },
                ],
                [job.damage_report],
              ),
            )
          : null,
      ),
      actions: buttons([
        can('maintenance.manage') && m.status !== 'COMPLETED'
          ? button('mark complete', {
              kind: 'primary',
              onClick: async () => {
                dialog.close();
                await completeJob(m);
              },
            })
          : null,
        can('maintenance.manage')
          ? button('attach photos', {
              kind: 'ghost',
              onClick: async () => {
                dialog.close();
                await jobPhotos(m);
              },
            })
          : null,
        button('open the tool', { kind: 'ghost', onClick: () => (dialog.close(), openTooling(m.tooling_id)) }),
      ]),
    });
  }

  async function completeJob(m) {
    const values = await formDialog({
      title: 'complete the job',
      subtitle: `${m.tooling_id} · ${m.kind}`,
      wide: true,
      fields: [
        { key: 'completed_date', label: 'done on', type: 'date', required: true, initial: new Date().toISOString().slice(0, 10) },
        { key: 'technician', label: 'technician', initial: m.technician },
        { key: 'findings', label: 'findings', type: 'textarea', wide: true, placeholder: 'light scoring on the left face, polished, no dimension change' },
        { key: 'condition_after', label: 'condition after', type: 'select', options: (vocab.conditions || meta.data?.condition_ratings || []).map((c) => ({ value: typeof c === 'string' ? c : c.code, label: typeof c === 'string' ? c.toLowerCase() : c.code })) },
        { key: 'parts_replaced', label: 'parts replaced' },
        { key: 'cost', label: 'cost', type: 'number', min: 0 },
        { key: 'downtime_hours', label: 'downtime (h)', type: 'number', min: 0 },
        { key: 'next_maintenance_date', label: 'next maintenance due', type: 'date', help: 'empty = computed from the interval on the tool' },
        { key: 'return_to_service', label: 'set the tool back to AVAILABLE', type: 'checkbox', initial: true },
        { key: 'reset_cycles', label: 'reset the cycle counter (rebuild)', type: 'checkbox' },
      ],
    });
    if (!values) return;
    try {
      const out = await api.post(`/api/maintenance/${m.id}/complete`, values);
      toast(out.message || 'job completed — the tool is back in service', 'ok', 6000);
      statusCounts();
      paint();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function jobPhotos(m) {
    const values = await formDialog({
      title: 'job photos',
      fields: [
        { key: 'stage', label: 'stage', type: 'select', required: true, options: ['BEFORE', 'AFTER'], initial: 'BEFORE', empty: false },
        { key: 'files', label: 'images', type: 'photo', camera: true, wide: true },
      ],
    });
    if (!values?.files?.length) return;
    const fd = new FormData();
    fd.append('stage', values.stage);
    for (const file of values.files) fd.append('files', file);
    try {
      await api.upload(`/api/maintenance/${m.id}/photos`, fd);
      toast('photos attached', 'ok');
      paint();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function scheduleDialog(tool) {
    const picked = tool || (await pickTooling({ title: 'which tool needs maintenance?' }));
    if (!picked) return;
    const values = await formDialog({
      title: `schedule maintenance for ${picked.tooling_id}`,
      wide: true,
      fields: [
        { key: 'kind', label: 'kind', type: 'select', required: true, options: (vocab.maintenance_types || ['PREVENTIVE', 'CORRECTIVE', 'INSPECTION', 'CLEANING', 'REPAIR', 'REPLACEMENT', 'CALIBRATION']).map((s) => ({ value: s, label: s.replace(/_/g, ' ') })), initial: 'PREVENTIVE', empty: false },
        { key: 'scheduled_date', label: 'planned for', type: 'date', required: true, initial: new Date().toISOString().slice(0, 10) },
        { key: 'priority', label: 'priority', type: 'select', options: (vocab.priorities || ['LOW', 'NORMAL', 'HIGH', 'URGENT']).map((s) => ({ value: s, label: s.toLowerCase() })), initial: 'NORMAL', empty: false },
        { key: 'technician', label: 'who will do it' },
        { key: 'work_description', label: 'what to do', type: 'textarea', wide: true },
        { key: 'condition_before', label: 'condition now', type: 'select', options: (vocab.conditions || []).map((c) => ({ value: c, label: String(c).toLowerCase() })) },
        { key: 'next_maintenance_date', label: 'next due after this job', type: 'date' },
      ],
    });
    if (!values) return;
    try {
      await api.post('/api/maintenance', { tooling_item_id: picked.id, ...values });
      toast('job scheduled', 'ok');
      statusCounts();
      paint();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function damageTab() {
    const out = await api.get(`/api/maintenance/damage${qs({ status: '', open_only: '', size: 100 })}`);
    return h(
      'div',
      null,
      card(
        {
          title: `condition & damage reports (${out.pagination.total})`,
          subtitle: 'a report can quarantine the tool and open a repair job automatically',
          actions: buttons([
            can('tooling.inspect') ? button('📷 report damage (scan first)', { kind: 'primary small', onClick: () => scanDamage() }) : null,
            can('tooling.inspect') ? button('＋ report on a tool', { kind: 'ghost small', onClick: () => pickTooling({ title: 'which tool is damaged?' }).then((t) => t && reportDamage(t).then(() => paint())) }) : null,
          ]),
        },
        table(
          [
            { label: 'report', render: (d) => h('b', { class: 'code' }, d.report_no) },
            { label: 'tool', render: (d) => h('a', { class: 'code', href: `#/tooling/${encodeURIComponent(d.tooling_id)}` }, d.tooling_id) },
            { label: 'kind', render: (d) => badge(String(d.damage_type).replace(/_/g, ' ').toLowerCase(), 'danger') },
            { label: 'severity', render: (d) => badge(String(d.severity).toLowerCase(), d.severity === 'CRITICAL' || d.severity === 'HIGH' ? 'danger' : 'warn') },
            { label: 'what happened', render: (d) => h('span', { class: 'tiny' }, (d.description || '').slice(0, 120)) },
            { label: 'found at', render: (d) => d.location_note || d.location_code || '—' },
            { label: 'photos', render: (d) => (d.photo_count ? badge(`${d.photo_count}`, 'ok') : '—') },
            { label: 'status', render: (d) => badge(String(d.status).toLowerCase(), d.status === 'OPEN' ? 'danger' : d.status === 'IN_REPAIR' ? 'warn' : 'ok') },
            { label: 'by', render: (d) => d.reported_by_name || '' },
            { label: 'when', render: (d) => h('span', { class: 'tiny muted nowrap' }, when(d.reported_at)) },
          ],
          out.items,
          { onRowOpen: (d) => damageDialog(d.id), emptyText: 'no damage reports' },
        ),
      ),
    );
  }

  async function damageDialog(id) {
    const d = await api.get(`/api/maintenance/damage/${id}`);
    const r = d.report;
    const dialog = modal({
      title: r.report_no,
      subtitle: `${r.tooling_id} · ${r.damage_type} · ${r.severity}`,
      wide: true,
      body: h(
        'div',
        null,
        photoGrid((d.images || []).map((i) => ({ ...i, url: i.url || `/api/files/images/${i.id}` })), { onOpen: (img) => lightbox(img.url, img.caption) }),
        h('p', null, r.description || ''),
        kv([
          ['tool status', r.tooling_status],
          ['shelf', r.location_code || '—'],
          ['found at', r.location_note],
          ['reported by', r.reported_by_name],
          ['when', when(r.reported_at)],
          ['linked maintenance', r.maintenance_status ? `${r.maintenance_status}${r.technician ? ` · ${r.technician}` : ''}` : 'none'],
          ['repair request', r.request_id ? `#${r.request_id}` : null],
          ['resolution', r.resolution],
          ['resolved at', r.resolved_at ? when(r.resolved_at) : null],
        ]),
      ),
      actions: buttons([
        can('maintenance.manage') && r.status !== 'RESOLVED'
          ? button('resolve', {
              kind: 'primary',
              onClick: async () => {
                const values = await formDialog({
                  title: 'resolve the report',
                  fields: [
                    { key: 'status', label: 'outcome', type: 'select', required: true, options: ['RESOLVED', 'IGNORED', 'CONVERTED'], initial: 'RESOLVED', empty: false },
                    { key: 'resolution', label: 'what was done', type: 'textarea', required: true, wide: true, placeholder: 'welded and re-ground, dimensions checked against the drawing, back in service' },
                    { key: 'set_status', label: 'tool status after', type: 'select', required: true, options: ['AVAILABLE', 'MAINTENANCE', 'DAMAGED', 'RETIRED', 'MISSING'], initial: 'AVAILABLE', empty: false },
                  ],
                });
                if (!values) return;
                try {
                  await api.post(`/api/maintenance/damage/${id}/resolve`, values);
                  toast('report closed', 'ok');
                  dialog.close();
                  paint();
                } catch (err) {
                  toast(err.message, 'error', 9000);
                }
              },
            })
          : null,
        button('open the tool', { kind: 'ghost', onClick: () => (dialog.close(), openTooling(r.tooling_id)) }),
        can('files.manage')
          ? button('add photos', {
              kind: 'ghost',
              onClick: async () => {
                const values = await formDialog({ title: 'photos for this report', fields: [{ key: 'files', label: 'images', type: 'photo', camera: true, wide: true }] });
                if (!values?.files?.length) return;
                const fd = new FormData();
                for (const file of values.files) fd.append('files', file);
                await api.upload(`/api/maintenance/damage/${id}/photos`, fd);
                dialog.close();
                paint();
              },
            })
          : null,
      ]),
    });
  }

  async function scanDamage() {
    const s = await openScanner({ title: 'scan the damaged tool' });
    if (!s) return;
    try {
      const rec = await api.get(`/api/tooling/code/${encodeURIComponent(s.code.replace(/^SP:T:/, ''))}`);
      await reportDamage(rec.tool);
      paint();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function metricsTab() {
    const m = await api.get('/api/maintenance/metrics?days=120');
    return h(
      'div',
      null,
      h(
        'div',
        { class: 'two-col' },
        card({ title: 'jobs by kind', subtitle: `last ${m.days} days` }, barChart(m.by_type.map((t) => ({ label: String(t.kind).replace(/_/g, ' ').toLowerCase(), value: Number(t.jobs) })))),
        card({ title: 'open jobs by priority' }, barChart(m.open_by_priority.map((t) => ({ label: String(t.priority).toLowerCase(), value: Number(t.jobs), color: t.priority === 'URGENT' ? 'var(--danger)' : t.priority === 'HIGH' ? 'var(--warn)' : undefined })))),
      ),
      h(
        'div',
        { class: 'two-col' },
        card({ title: 'per month', subtitle: 'jobs, downtime and cost' }, table([{ label: 'month', key: 'month' }, { label: 'jobs', key: 'jobs' }, { label: 'downtime h', render: (r) => Number(r.downtime_hours).toFixed(1) }, { label: 'cost', render: (r) => Number(r.cost).toFixed(0) }], m.by_month)),
        card({ title: 'by technician', subtitle: 'average delay between planned and done' }, table([{ label: 'technician', key: 'technician' }, { label: 'jobs', key: 'jobs' }, { label: 'avg delay (days)', render: (r) => Number(r.avg_delay_days ?? 0).toFixed(1) }], m.by_technician)),
      ),
    );
  }

  const node = h(
    'div',
    null,
    h(
      'div',
      { class: 'section-title' },
      h('h1', null, 'maintenance'),
      h('span', { class: 'sub' }, 'intervals, condition reports, damage, downtime and cost'),
      h('span', { class: 'grow' }),
      can('tooling.inspect') ? button('📷 report damage', { kind: 'danger small', onClick: () => scanDamage() }) : null,
    ),
    tabNode,
    body,
  );
  await paint();
  return node;
}

/* ======================================================= tooling requests */
async function RequestsView(mount, route) {
  const st = { status: route.query.status || '', mine: '', page: 1, size: 30 };
  const body = h('div', null);
  const vocab = await api.get('/api/maintenance/vocab').catch(() => ({}));
  const FLOW = { PENDING: ['APPROVED', 'REJECTED', 'CANCELLED'], APPROVED: ['IN_PRODUCTION', 'CANCELLED', 'REJECTED'], IN_PRODUCTION: ['COMPLETED', 'CANCELLED'], REJECTED: ['PENDING'], CANCELLED: ['PENDING'], COMPLETED: [] };

  async function paint() {
    body.replaceChildren(spinner('loading requests…'));
    try {
      const [out, stats] = await Promise.all([api.get(`/api/maintenance/requests${qs(st)}`), api.get('/api/maintenance/requests/stats').catch(() => null)]);
      body.replaceChildren(render(out, stats));
    } catch (err) {
      body.replaceChildren(errorBox(err));
    }
  }

  function render(out, stats) {
    const byStatus = Object.fromEntries((stats?.by_status || []).map((s) => [s.status, Number(s.c ?? s.count)]));
    const tiles = h(
      'div',
      { class: 'tiles' },
      ...['PENDING', 'APPROVED', 'IN_PRODUCTION', 'COMPLETED', 'REJECTED'].map((s) =>
        statTile({
          label: s.replace(/_/g, ' ').toLowerCase(),
          value: byStatus[s] ?? out.items.filter((r) => r.status === s).length,
          tone: s === 'PENDING' ? 'warn' : s === 'COMPLETED' ? 'ok' : s === 'REJECTED' ? 'danger' : '',
          href: `#/requests?status=${s}`,
        }),
      ),
    );
    const chips = h(
      'div',
      { class: 'chips' },
      ...['', 'PENDING', 'APPROVED', 'IN_PRODUCTION', 'COMPLETED', 'REJECTED', 'CANCELLED'].map((s) =>
        h(
          'button',
          {
            class: `chip ${st.status === s ? 'on' : ''}`,
            type: 'button',
            onclick: () => ((st.status = s), (st.page = 1), history.replaceState(null, '', `#/requests${qs(st)}`), paint()),
          },
          s ? s.replace(/_/g, ' ').toLowerCase() : 'all',
        ),
      ),
      h('button', { class: `chip ${st.mine === '1' ? 'on' : ''}`, type: 'button', onclick: () => ((st.mine = st.mine === '1' ? '' : '1'), paint()) }, 'mine only'),
    );
    return h(
      'div',
      null,
      h(
        'div',
        { class: 'section-title' },
        h('h1', null, 'tooling requests'),
        h('span', { class: 'sub' }, 'ask for a tool → engineering checks whether it already exists → make it or reject it'),
        h('span', { class: 'grow' }),
        can('requests.manage') ? button('＋ new request', { kind: 'primary', onClick: () => newRequest() }) : null,
      ),
      tiles,
      chips,
      card(
        { title: `requests (${out.pagination.total})`, subtitle: 'the “do we already have this?” check is part of the flow' },
        table(
          [
            { label: 'request', render: (r) => h('b', { class: 'code' }, r.request_no) },
            { label: 'what', render: (r) => h('div', null, r.title, r.description ? h('div', { class: 'tiny muted' }, String(r.description).slice(0, 110)) : null) },
            { label: 'filter', render: (r) => (r.filter_number ? h('a', { class: 'code', href: `#/filters/${encodeURIComponent(r.filter_number)}` }, r.filter_number) : '—') },
            { label: 'category', render: (r) => (r.type_name ? `${r.icon || ''} ${r.type_name}` : '—') },
            { label: 'qty', key: 'quantity' },
            { label: 'priority', render: (r) => badge(String(r.priority).toLowerCase(), r.priority === 'URGENT' ? 'danger' : r.priority === 'HIGH' ? 'warn' : '') },
            { label: 'target', render: (r) => (r.target_date ? h('span', { class: `tiny ${daysUntil(r.target_date) < 0 ? 'danger-text' : 'muted'}` }, `${dateOnly(r.target_date)} (${daysUntil(r.target_date)}d)`) : '—') },
            { label: 'already have?', render: (r) => (r.existing_tool_code ? badge(`reuse ${r.existing_tool_code}`, 'ok') : r.checked_existing ? badge('checked - nothing exists', 'warn') : badge('not checked')) },
            { label: 'status', render: (r) => badge(String(r.status).replace(/_/g, ' ').toLowerCase(), r.status === 'COMPLETED' ? 'ok' : r.status === 'REJECTED' ? 'danger' : r.status === 'PENDING' ? 'warn' : '') },
            { label: 'requested by', render: (r) => h('span', { class: 'tiny' }, r.requested_by_name || '') },
            { label: 'created', render: (r) => h('span', { class: 'tiny muted nowrap' }, when(r.created_at)) },
          ],
          out.items,
          { onRowOpen: (r) => requestDialog(r), emptyText: 'no requests in this state' },
        ),
        pager(out.pagination, (page) => ((st.page = page), paint())),
      ),
    );
  }

  async function newRequest(prefillTitle = '') {
    const picked = await pickFilter({ title: 'which filter needs new tooling? (optional)' });
    const types = await api.get('/api/tooling/types/list').then((r) => r.items.map((t) => ({ value: t.id, label: `${t.icon || ''} ${t.name}` })));
    const values = await formDialog({
      title: 'new tooling request',
      wide: true,
      fields: [
        { key: 'title', label: 'what do you need', required: true, wide: true, placeholder: 'Housing for the new Ø76 filter, 3-letter logo', initial: prefillTitle },
        { key: 'description', label: 'details', type: 'textarea', wide: true, placeholder: 'dimensions, letters, why the existing one cannot be reused' },
        { key: 'tooling_type_id', label: 'tooling category', type: 'select', options: types },
        { key: 'priority', label: 'priority', type: 'select', options: ['LOW', 'NORMAL', 'HIGH', 'URGENT'], initial: 'NORMAL', empty: false },
        { key: 'quantity', label: 'how many pieces', type: 'number', min: 1, initial: 1 },
        { key: 'target_date', label: 'needed by', type: 'date' },
        { key: 'requested_for_dept', label: 'department', placeholder: 'engineering / production / quality' },
        { key: 'estimate_cost', label: 'estimated cost', type: 'number', min: 0 },
      ],
    });
    if (!values) return;
    try {
      const out = await api.post('/api/maintenance/requests', { ...values, filter_id: picked?.id });
      toast(`request ${out.request_no} submitted — engineering will check for an existing tool`, 'ok', 7000);
      statusCounts();
      paint();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function requestDialog(r) {
    const nextSteps = FLOW[r.status] || [];
    const dialog = modal({
      title: r.request_no,
      subtitle: r.title,
      wide: true,
      body: h(
        'div',
        null,
        kv([
          ['status', r.status],
          ['priority', r.priority],
          ['needed by', dateOnly(r.target_date)],
          ['category', r.type_name],
          ['quantity', r.quantity],
          ['department', r.requested_for_dept],
          ['requested by', r.requested_by_name],
          ['assigned to', r.assigned_to_name],
          ['approved by', r.approved_by_name],
          ['estimate', r.estimate_cost],
          ['actual cost', r.actual_cost],
          ['existing tool answer', r.existing_tool_code ? `${r.existing_tool_code}${r.existing_tool_location ? ` at ${r.existing_tool_location}` : ''}` : 'no reuse linked'],
          ['created tool', r.created_tooling_id_code],
          ['rejection reason', r.rejection_reason],
        ]),
        r.description ? h('p', { class: 'small' }, r.description) : null,
        h(
          'div',
          { class: 'btn-grid', style: 'margin-top:10px' },
          nextSteps.includes('REJECTED')
            ? button('♻ we already have this tool', {
                kind: 'primary',
                onClick: async () => {
                  const tool = await pickTooling({ title: 'which existing tool answers this request?' });
                  if (!tool) return;
                  try {
                    await api.post(`/api/maintenance/requests/${r.id}/link-existing`, { tooling_item_id: tool.id });
                    toast(`${tool.tooling_id} linked — no new manufacturing needed`, 'ok', 7000);
                    dialog.close();
                    paint();
                  } catch (err) {
                    toast(err.message, 'error', 9000);
                  }
                },
              })
            : null,
          r.status === 'APPROVED'
            ? button('🛠 it was made - register the tool', {
                kind: 'primary',
                onClick: async () => {
                  const values = await formDialog({
                    title: 'create the tooling record',
                    subtitle: 'the request becomes a real register entry, including the location you fill in',
                    wide: true,
                    fields: [
                      { key: 'name', label: 'name', required: true, initial: r.title, wide: true },
                      { key: 'quantity', label: 'pieces made', type: 'number', min: 1, initial: r.quantity || 1 },
                      { key: 'external_location', label: 'where it will live', placeholder: 'TR-R02-RK05-S03 or Tool room A' },
                      { key: 'material', label: 'material' },
                    ],
                  });
                  if (!values) return;
                  try {
                    const out = await api.post(`/api/maintenance/requests/${r.id}/create-tooling`, values);
                    toast(`${out.tooling?.tool?.tooling_id || out.tooling?.tooling_id || 'tool'} created${out.location_applied ? ' and shelved' : ''}`, 'ok', 7000);
                    dialog.close();
                    paint();
                  } catch (err) {
                    toast(err.message, 'error', 9000);
                  }
                },
              })
            : null,
          ...nextSteps
            .filter((s) => s !== 'REJECTED' || r.status !== 'PENDING')
            .map((s) =>
              button(`${s === 'REJECTED' ? 'reject' : s === 'APPROVED' ? 'approve' : s === 'IN_PRODUCTION' ? 'start making it' : s === 'COMPLETED' ? 'mark completed' : 'cancel'}`, {
                kind: s === 'REJECTED' || s === 'CANCELLED' ? 'danger' : 'ghost',
                onClick: async () => {
                  const needsReason = s === 'REJECTED' || s === 'CANCELLED';
                  const values = needsReason
                    ? await formDialog({ title: `${s.toLowerCase()} this request`, fields: [{ key: 'reason', label: 'why', type: 'textarea', required: true, wide: true }, { key: 'note', label: 'note (internal)', type: 'text', wide: true }] })
                    : { status: s };
                  if (!values) return;
                  try {
                    await api.post(`/api/maintenance/requests/${r.id}/status`, { ...values, status: s });
                    toast(`request ${s.toLowerCase()}`, 'ok');
                    dialog.close();
                    paint();
                  } catch (err) {
                    toast(err.message, 'error', 9000);
                  }
                },
              }),
            ),
        ),
      ),
      actions: h('div', { class: 'btn-row end' }, button('close', { kind: 'ghost', onClick: () => dialog.close() })),
    });
  }

  if (route.query.prefill) newRequest(route.query.prefill);
  await paint();
  return h('div', null, body);
}

/* =============================================================== production */
async function ProductionView(mount, route) {
  const st = { q: route.query.q || '', status: route.query.status || '', availability: route.query.blocked === '1' ? 'blocked' : route.query.availability || '', priority: route.query.priority || '', open: '', page: Number(route.query.page || 1), size: 25, sort: 'planned_start_at', dir: 'desc' };
  let mode = route.query.mode || 'list';
  const body = h('div', null);
  const tabNode = h('div', null);
  const TABS = [
    { key: 'list', label: '📋 orders' },
    { key: 'board', label: '🗂 board' },
    { key: 'blocked', label: '⛔ blocked' },
  ];

  const paint = async () => {
    tabNode.replaceChildren(...tabs(TABS, mode, (key) => ((mode = key), history.replaceState(null, '', `#/production${qs({ mode })}`), paint())).children);
    body.replaceChildren(spinner('loading orders…'));
    try {
      body.replaceChildren(mode === 'board' ? await boardTab() : mode === 'blocked' ? await blockedTab() : await listTab());
    } catch (err) {
      body.replaceChildren(errorBox(err));
    }
  };

  async function listTab() {
    const params = { ...st };
    if (mode === 'blocked') params.availability = 'blocked';
    const out = await api.get(`/api/production${qs(params)}`);
    const search = h('input', { type: 'search', placeholder: 'order number, filter, customer, machine, line…', value: st.q, autocapitalize: 'characters' });
    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => ((st.q = search.value.trim()), (st.page = 1), paint()), 300);
    });
    return h(
      'div',
      null,
      card(
        {
          title: 'production orders',
          subtitle: 'readiness is computed from the live tooling register, not typed by hand',
          actions: buttons([
            can('production.update') ? button('＋ new order', { kind: 'primary small', onClick: () => newOrder() }) : null,
            button('⬇ excel', { kind: 'ghost small', onClick: () => downloadWith('/api/export/production.xlsx', 'production.xlsx') }),
          ]),
        },
        h('div', { class: 'scan-manual-row' }, search),
        h(
          'div',
          { class: 'filters' },
          sel('status', 'status', ['DRAFT', 'PLANNED', 'READY', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED']),
          sel('availability', 'tooling', [
            { value: 'ready', label: 'ready to run' },
            { value: 'blocked', label: 'blocked by tooling' },
            { value: 'unchecked', label: 'never checked' },
          ]),
          sel('priority', 'priority', ['URGENT', 'HIGH', 'NORMAL', 'LOW']),
          sel('open', 'only open', [{ value: '1', label: 'not finished yet' }]),
        ),
        table(
          [
            { label: 'order', render: (o) => h('div', null, h('b', { class: 'code' }, o.po_number), h('div', { class: 'tiny muted' }, o.customer_ref || '')) },
            { label: 'filter', render: (o) => h('a', { class: 'code', href: `#/filters/${encodeURIComponent(o.filter_number)}` }, o.filter_number) },
            { label: 'qty', render: (o) => h('div', null, `${o.quantity_produced}/${o.quantity_ordered}`, meter(Number(o.quantity_produced || 0), Number(o.quantity_ordered || 1), `${o.progress ?? ''}`)) },
            { label: 'planned', render: (o) => h('span', { class: 'tiny nowrap' }, `${dateOnly(o.planned_start_at)} → ${dateOnly(o.planned_end_at) || '—'}`) },
            { label: 'line / machine', render: (o) => h('span', { class: 'tiny' }, [o.line, o.machine].filter(Boolean).join(' · ')) },
            { label: 'priority', render: (o) => badge(String(o.priority).toLowerCase(), o.priority === 'URGENT' ? 'danger' : o.priority === 'HIGH' ? 'warn' : '') },
            { label: 'status', render: (o) => badge(String(o.status).replace(/_/g, ' ').toLowerCase(), o.status === 'IN_PROGRESS' ? 'warn' : o.status === 'COMPLETED' ? 'ok' : o.status === 'ON_HOLD' ? 'danger' : '') },
            { label: 'tooling', render: (o) => badge(o.availability_status === 'READY' ? 'READY' : o.availability_status === 'NOT_READY' ? 'BLOCKED' : 'unchecked', o.availability_status === 'READY' ? 'ok' : o.availability_status === 'NOT_READY' ? 'danger' : '') },
            { label: 'tools out', render: (o) => `${o.tools_taken ?? 0}/${o.tool_rows ?? 0}` },
            { label: 'why blocked', render: (o) => h('span', { class: 'tiny muted' }, (o.blocking_reason || '').slice(0, 90)) },
          ],
          out.items,
          { onRowOpen: (o) => go(`/production/${o.id}`), emptyText: 'no orders match' },
        ),
        pager(out.pagination, (page) => ((st.page = page), paint())),
      ),
    );
    function sel(key, label, options) {
      const opts = options.map((o) => (typeof o === 'string' ? { value: o, label: o.replace(/_/g, ' ').toLowerCase() } : o));
      const el = h('select', null, h('option', { value: '' }, `— ${label} —`), ...opts.map((o) => h('option', { value: o.value }, o.label)));
      el.value = st[key] || '';
      el.addEventListener('change', () => ((st[key] = el.value), (st.page = 1), paint()));
      return h('div', { class: 'field' }, h('label', null, label), el);
    }
  }

  async function boardTab() {
    const b = await api.get('/api/production/board');
    return h(
      'div',
      null,
      b.late_count ? notice('warn', `${b.late_count} order(s) are due today or already late`) : null,
      h(
        'div',
        { class: 'board' },
        ...b.columns.map((col) =>
          h(
            'div',
            { class: 'board-col' },
            h('div', { class: 'board-head' }, h('b', null, col.status.replace(/_/g, ' ').toLowerCase()), h('span', { class: 'count' }, String(col.items.length))),
            ...col.items.map((o) =>
              h(
                'div',
                { class: `board-card ${o.availability_status === 'NOT_READY' ? 'blocked' : ''}`, onclick: () => go(`/production/${o.id}`) },
                h('div', null, h('b', { class: 'code' }, o.po_number), h('span', { class: 'grow' }), badge(String(o.priority).toLowerCase(), o.priority === 'URGENT' ? 'danger' : '')),
                h('div', { class: 'small' }, `${o.filter_number} · ${o.quantity_produced}/${o.quantity_ordered} pcs`),
                h('div', { class: 'tiny muted' }, `${o.line || ''} ${o.machine || ''} · ${dateOnly(o.planned_start_at)}`),
                o.availability_status === 'NOT_READY' ? h('div', { class: 'tiny danger-text' }, `⛔ ${(o.blocking_reason || 'tooling not ready').slice(0, 80)}`) : h('div', { class: 'tiny ok-text' }, `✅ tools out ${o.tools_out ?? 0}`),
              ),
            ),
            col.items.length ? null : h('p', { class: 'tiny muted pad' }, 'nothing here'),
          ),
        ),
      ),
      b.blocked.length
        ? card(
            { title: `blocked by tooling (${b.blocked.length})`, subtitle: 'these cannot start — the reason is exact' },
            table(
              [
                { label: 'order', render: (o) => h('a', { class: 'code', href: `#/production/${o.id}` }, o.po_number) },
                { label: 'filter', render: (o) => h('span', { class: 'code' }, o.filter_number) },
                { label: 'planned', render: (o) => dateOnly(o.planned_start_at) },
                { label: 'why', render: (o) => h('span', { class: 'tiny' }, o.blocking_reason || '') },
              ],
              b.blocked,
              { onRowOpen: (o) => go(`/production/${o.id}`) },
            ),
          )
        : null,
    );
  }

  async function blockedTab() {
    st.availability = 'blocked';
    const out = await api.get(`/api/production${qs(st)}`);
    st.availability = '';
    return card(
      { title: `orders blocked by tooling (${out.pagination.total})`, subtitle: 'open one to see which exact tool is the problem' },
      table(
        [
          { label: 'order', render: (o) => h('b', { class: 'code' }, o.po_number) },
          { label: 'filter', render: (o) => h('a', { class: 'code', href: `#/filters/${encodeURIComponent(o.filter_number)}` }, o.filter_number) },
          { label: 'planned', render: (o) => dateOnly(o.planned_start_at) },
          { label: 'blocking reason', render: (o) => h('span', { class: 'small danger-text' }, o.blocking_reason || 'not recorded') },
          { label: 'last check', render: (o) => (o.availability_checked_at ? h('span', { class: 'tiny muted' }, when(o.availability_checked_at)) : 'never') },
        ],
        out.items,
        { onRowOpen: (o) => go(`/production/${o.id}`) },
      ),
    );
  }

  async function newOrder() {
    const picked = await pickFilter({ title: 'which filter are we producing?' });
    if (!picked) return;
    const values = await formDialog({
      title: 'new production order',
      subtitle: picked.internal_number,
      wide: true,
      fields: [
        { key: 'po_number', label: 'order number', placeholder: 'leave empty to generate', pattern: '^[A-Za-z0-9._/-]{2,60}$' },
        { key: 'quantity_ordered', label: 'pieces ordered', type: 'number', required: true, min: 1, initial: 500 },
        { key: 'priority', label: 'priority', type: 'select', options: ['LOW', 'NORMAL', 'HIGH', 'URGENT'], initial: 'NORMAL', empty: false },
        { key: 'line', label: 'line', placeholder: 'Line 2' },
        { key: 'machine', label: 'machine', placeholder: 'Press 3' },
        { key: 'planned_start_at', label: 'planned start', type: 'datetime', required: true },
        { key: 'planned_end_at', label: 'planned end', type: 'datetime' },
        { key: 'customer_ref', label: 'customer reference' },
        { key: 'notes', label: 'notes', type: 'textarea', wide: true },
      ],
    });
    if (!values) return;
    try {
      const out = await api.post('/api/production', { ...values, filter_id: picked.id });
      const ready = out.readiness?.ready;
      toast(`order ${out.order.po_number} created · tooling ${ready ? 'READY ✅' : 'BLOCKED ⛔'}`, ready ? 'ok' : 'error', 8000);
      statusCounts();
      go(`/production/${out.order.id}`);
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
      h('h1', null, 'production'),
      h('span', { class: 'sub' }, 'can this order start? the app answers with the tooling register'),
      h('span', { class: 'grow' }),
      can('production.update') ? button('＋ new order', { kind: 'primary small', onClick: () => newOrder() }) : null,
    ),
    tabNode,
    body,
  );
  await paint();
  return node;
}

/* ---------------------------------------------------------- order detail */
async function OrderDetailView(mount, route) {
  const id = Number(route.segments[1]);
  const box = h('div', null, spinner('checking the tooling for this order…'));
  let v = null;

  async function reload() {
    box.replaceChildren(spinner('checking the tooling for this order…'));
    try {
      v = await api.get(`/api/production/${id}${qs({ unit: unitPreference() })}`);
      box.replaceChildren(node2(v));
    } catch (err) {
      box.replaceChildren(errorBox(err));
    }
  }

  function node2(view) {
    const o = view.order;
    const r = view.readiness;
    const picked = new Set((v?.tools || []).filter((t) => t.status === 'TAKEN').map((t) => t.tooling_item_id));
    const sel = new Set();
    const selectedIds = () => [...sel];

    const head = h(
      'div',
      { class: 'section-title' },
      h(
        'div',
        null,
        h('div', { class: 'chips' }, badge(String(o.status).replace(/_/g, ' ').toLowerCase(), o.status === 'IN_PROGRESS' ? 'warn' : o.status === 'COMPLETED' ? 'ok' : ''), badge(String(o.priority).toLowerCase(), o.priority === 'URGENT' ? 'danger' : ''), badge(o.availability_status === 'READY' ? 'tooling READY' : 'tooling BLOCKED', o.availability_status === 'READY' ? 'ok' : 'danger')),
        h('h1', { class: 'code mono-title' }, o.po_number),
        h('div', { class: 'sub' }, `${o.filter_number} · ${o.quantity_produced}/${o.quantity_ordered} pcs · ${o.line || 'no line'} ${o.machine || ''}`),
      ),
      h('span', { class: 'grow' }),
      buttons([
        button('back', { kind: 'ghost small', onClick: () => (history.length > 1 ? back() : go('/production')) }),
        button('🏷 order label', { kind: 'ghost small', onClick: () => printOrderLabel(o) }),
        can('production.update') ? button('re-check readiness', { kind: 'ghost small', onClick: () => recheck() }) : null,
        can('production.update') ? button('edit', { kind: 'ghost small', onClick: () => editOrder(o) }) : null,
      ]),
    );

    const gate = h(
      'div',
      { class: `banner ${r.ready ? 'ready' : 'blocked'}` },
      h('div', { style: 'font-size:30px' }, r.ready ? '✅' : '⛔'),
      h(
        'div',
        { class: 'grow' },
        h('div', { class: 'big' }, r.ready ? 'PRODUCTION READY' : 'PRODUCTION BLOCKED'),
        h(
          'div',
          { class: 'why' },
          r.ready
            ? `every mandatory tool is available · checked ${when(r.checked_at)}`
            : h(
                'ul',
                null,
                r.blockers.map((b) => h('li', null, h('b', null, String(b.type).replace(/_/g, ' ')), ` ${b.tooling_type ? `[${b.tooling_type}]` : ''} — ${b.message}`, b.tooling_id ? h('a', { class: 'code', href: `#/tooling/${encodeURIComponent(b.tooling_id)}` }, ` ${b.tooling_id}`) : null)),
              ),
        ),
        r.warnings?.length ? h('p', { class: 'tiny muted' }, `${r.warnings.length} warning(s): ${r.warnings.slice(0, 4).map((w) => `${w.code} on ${w.tooling_id}`).join(', ')}`) : null,
      ),
      h(
        'div',
        { class: 'btn-col' },
        can('production.update') && o.status !== 'IN_PROGRESS' && o.status !== 'COMPLETED' ? button('▶ start the order', { kind: r.ready ? 'primary' : 'ghost', disabled: !r.ready, onClick: () => startOrder(o, r) }) : null,
        can('tooling.move') ? button('📷 scan tools out', { kind: 'ghost', onClick: () => scanTake() }) : null,
      ),
    );

    async function recheck() {
      const out = await api.post(`/api/production/${id}/check-readiness?record=1`, {});
      const why = (out.blockers || []).map((b) => b.message).join('; ');
      toast(out.ready ? 'READY ✅ — the tooling is complete' : `still blocked: ${why}`, out.ready ? 'ok' : 'error', 8000);
      reload();
    }

    const toolsCard = card(
      {
        title: `tooling for this order (${(view.tools || []).length})`,
        subtitle: 'take them to the machine here; returning them writes the movement + cycle counters',
        actions: buttons([
          can('production.update') ? button('auto-assign from the filter', { kind: 'primary small', onClick: () => autoAssign() }) : null,
          can('production.update') ? button('＋ add a tool', { kind: 'ghost small', onClick: () => addTool() }) : null,
          can('tooling.move') ? button('take selected', { kind: 'ghost small', onClick: () => takeSelected() }) : null,
          can('tooling.move') ? button('return selected', { kind: 'ghost small', onClick: () => returnSelected() }) : null,
          can('tooling.reserve') ? button('reserve selected', { kind: 'ghost small', onClick: () => reserveSelected() }) : null,
        ]),
      },
      h(
        'div',
        { class: 'tool-lines' },
        ...view.tools.map((t) => {
          const line = h('div', { class: 'tool-line' });
          line.appendChild(
            h('input', {
              type: 'checkbox',
              class: 'pick',
              checked: picked.has(t.tooling_item_id),
              onchange: (e) => (e.target.checked ? sel.add(t.tooling_item_id) : sel.delete(t.tooling_item_id)),
              'aria-label': `select ${t.tooling_id}`,
            }),
          );
          line.appendChild(
            t.primary_image_id
              ? h('img', { class: 'thumb', src: `/api/files/images/${t.primary_image_id}`, alt: '', loading: 'lazy', onclick: () => lightbox(`/api/files/images/${t.primary_image_id}`, t.tooling_id) })
              : h('span', { class: 'thumb none' }, t.icon || '🧿'),
          );
          const main = h('div', { class: 'grow' });
          main.appendChild(h('div', { class: 'line-1' }, h('a', { class: 'code big-code', href: `#/tooling/${encodeURIComponent(t.tooling_id)}` }, t.tooling_id), statusBadge(t.tool_status), badge(String(t.status).toLowerCase(), t.status === 'RETURNED' ? 'ok' : t.status === 'TAKEN' ? 'warn' : '')));
          main.appendChild(h('div', { class: 'line-2' }, t.name));
          main.appendChild(
            h(
              'div',
              { class: 'line-3' },
              h('span', { class: `where ${t.location_code ? 'ok' : 'bad'}` }, t.location_code ? `📍 ${t.location_code}` : t.external_location ? `📍 ${t.external_location}` : '📍 no shelf recorded'),
              t.dimensions_mm?.length ? h('span', { class: 'tiny muted' }, ` · ${sizeString({ overall_length_mm: t.dimensions_mm.length, overall_width_mm: t.dimensions_mm.width, overall_height_mm: t.dimensions_mm.height })}`) : null,
              t.max_cycles ? h('span', { class: 'tiny muted' }, ` · ${t.total_cycles}/${t.max_cycles} cycles`) : null,
              t.cycle_count ? h('span', { class: 'tiny ok-text' }, ` · ${t.cycle_count} this order`) : null,
            ),
          );
          line.appendChild(main);
          line.appendChild(
            h(
              'div',
              { class: 'line-actions' },
              can('tooling.move') && t.status !== 'TAKEN' ? button('take', { kind: 'primary small', onClick: () => take([t.tooling_item_id]) }) : null,
              can('tooling.move') && t.status === 'TAKEN' ? button('return', { kind: 'ghost small', onClick: () => returnTools([t.tooling_item_id], t) }) : null,
              h('button', { class: 'btn small ghost', onclick: () => (t.location_pk ? openLocation(t.location_pk) : openTooling(t.tooling_id)) }, t.location_pk ? 'where' : 'open'),
              can('production.update') ? h('button', { class: 'chip-x', title: 'remove from this order', onclick: () => removeTool(t) }, '×') : null,
            ),
          );
          return line;
        }),
        view.tools.length ? null : notice('warn', 'no tooling is attached to this order yet — auto-assign from the filter to pull in everything it needs'),
      ),
    );

    const readinessCard = card(
      { title: 'readiness by category', subtitle: 'what the gate actually looked at' },
      r.tooling.length
        ? h(
            'div',
            { class: 'req-blocks' },
            ...r.tooling.map((req) =>
              h(
                'div',
                { class: `req ${req.state === 'OK' ? 'ok' : 'danger'}` },
                h('header', null, h('div', null, h('b', null, `${req.icon || ''} ${req.type_name}`), h('div', { class: 'tiny muted' }, `${req.quantity_required} needed${req.is_mandatory ? '' : ' (optional)'}`)), badge(req.state.toLowerCase(), req.state === 'OK' ? 'ok' : 'danger')),
                h(
                  'div',
                  { class: 'tool-lines' },
                  ...req.options.map((op) =>
                    h(
                      'div',
                      { class: 'list-item' },
                      h('span', { class: 'grow' }, h('b', { class: 'code' }, op.tooling_id), h('div', { class: 'tiny muted' }, `${op.location || 'no shelf'} · ${op.status}${op.cycles ? ` · ${op.cycles.total}/${op.cycles.max} cycles` : ''}`), op.issues.length ? h('div', { class: 'tiny warn-text' }, op.issues.map((i) => i.message).join(' · ')) : null),
                      statusBadge(op.status),
                    ),
                  ),
                  req.options.length ? null : h('p', { class: 'tiny muted pad' }, 'nothing of this category is linked to the filter'),
                ),
              ),
            ),
          )
        : notice('warn', 'the filter has no tooling requirements defined yet, so nothing can be checked'),
    );

    const progressCard = card(
      {
        title: 'progress',
        subtitle: `${o.quantity_produced} of ${o.quantity_ordered} pcs · ${o.quantity_remaining} still to run`,
        actions: buttons([
          can('production.update') ? button('＋ batch', { kind: 'primary small', onClick: () => addBatch() }) : null,
          can('production.update') && o.status === 'IN_PROGRESS' ? button('complete the order', { kind: 'ghost small', onClick: () => completeOrder(o) }) : null,
          can('production.update') ? button('receive into stock', { kind: 'ghost small', onClick: () => receive(o) }) : null,
        ]),
      },
      meter(Number(o.quantity_produced || 0), Number(o.quantity_ordered || 1), `${o.progress_pct}% done`),
      h('div', { style: 'height:10px' }),
      table(
        [
          { label: 'batch', render: (b) => h('b', { class: 'code' }, b.batch_number) },
          { label: 'started', render: (b) => (b.started_at ? when(b.started_at) : '—') },
          { label: 'good', render: (b) => h('b', { class: 'ok-text' }, String(b.good_qty)) },
          { label: 'scrap', render: (b) => (Number(b.scrap_qty) ? h('b', { class: 'danger-text' }, String(b.scrap_qty)) : '0') },
          { label: 'operator', key: 'operator_name' },
          { label: 'notes', render: (b) => h('span', { class: 'tiny muted' }, b.notes || '') },
        ],
        view.batches || [],
        { emptyText: 'no batches logged' },
      ),
    );

    const historyCard = card(
      { title: 'order history' },
      h(
        'div',
        { class: 'timeline' },
        ...(view.history || []).slice(0, 40).map((hh) =>
          h(
            'div',
            { class: 'tl' },
            h('span', { class: 'dot' }),
            h('div', null, h('b', null, String(hh.event_type).replace(/_/g, ' ').toLowerCase()), hh.quantity ? ` ${hh.quantity} pcs` : '', h('div', { class: 'when' }, `${hh.username || ''} · ${when(hh.created_at)}${hh.note ? ` · ${hh.note}` : ''}`)),
          ),
        ),
      ),
      (view.history || []).length ? null : empty('nothing logged yet'),
    );

    const facts = card(
      { title: 'the order' },
      kv([
        ['filter', h('a', { class: 'code', href: `#/filters/${encodeURIComponent(o.filter_number)}` }, o.filter_number)],
        ['name', o.filter_name],
        ['ordered', o.quantity_ordered],
        ['produced', o.quantity_produced],
        ['remaining', o.quantity_remaining],
        ['line', o.line],
        ['machine', o.machine],
        ['planned start', o.planned_start_at ? new Date(o.planned_start_at).toLocaleString() : '—'],
        ['planned end', o.planned_end_at ? new Date(o.planned_end_at).toLocaleString() : '—'],
        ['started', o.started_at ? when(o.started_at) : null],
        ['completed', o.completed_at ? when(o.completed_at) : null],
        ['customer ref', o.customer_ref],
        ['created by', o.created_by_name],
        ['tools taken / returned', `${o.tools_taken ?? 0} / ${o.tools_returned ?? 0}`],
      ]),
      o.notes ? h('p', { class: 'small muted' }, o.notes) : null,
    );

    return h('div', null, head, gate, h('div', { class: 'two-col' }, facts, progressCard), toolsCard, h('div', { class: 'two-col' }, readinessCard, historyCard));
  }

  async function take(toolingIds) {
    if (!toolingIds.length) return toast('tick at least one tool', 'error');
    try {
      const out = await api.post(`/api/production/${id}/take`, { tooling_item_ids: toolingIds, note: 'taken from the order screen' });
      const refused = (out.refused || []).filter((x) => x.error);
      toast(refused.length ? `taken ${out.taken?.length ?? 0}, refused ${refused.length}: ${refused[0].error}` : `${out.taken?.length ?? 0} tool(s) taken — go to the shelf and get them`, refused.length ? 'error' : 'ok', 8000);
      reload();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function takeSelected() {
    const ids = [...sel];
    await take(ids);
  }

  async function returnSelected() {
    const ids = [...sel];
    if (!ids.length) return toast('tick the tools you brought back', 'error');
    await returnTools(ids);
  }

  async function returnTools(toolingIds, one) {
    const values = await formDialog({
      title: 'return tools',
      subtitle: toolingIds.length === 1 && one ? `${one.tooling_id} · ${one.name}` : `${toolingIds.length} tool(s)`,
      fields: [
        { key: 'location', label: 'shelf / box they go back to', placeholder: 'scan the shelf or type TR-R02-RK05-S03', wide: true, help: 'empty = back to the shelf recorded on each tool' },
        { key: 'cycles', label: 'cycles run on this order', type: 'number', min: 0 },
        { key: 'produced_qty', label: 'pieces produced with them', type: 'number', min: 0 },
        { key: 'note', label: 'note', type: 'text', wide: true },
      ],
    });
    if (!values) return;
    try {
      const out = await api.post(`/api/production/${id}/return`, { tooling_item_ids: toolingIds, ...values });
      const problems = (out.problems || []).filter(Boolean);
      toast(out.all_returned ? 'every tool is back on its shelf ✅' : `returned ${out.returned?.length ?? 0}${problems.length ? ` · ${problems.length} problem(s): ${problems[0].error || problems[0].message || ''}` : ''}`, problems.length ? 'error' : 'ok', 8000);
      statusCounts();
      reload();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function scanTake() {
    const s = await openScanner({ title: 'scan a tool on its shelf' });
    if (!s) return;
    try {
      const tool = await api.get(`/api/tooling/code/${encodeURIComponent(s.code.replace(/^SP:T:/, ''))}`);
      const onOrder = (v.tools || []).find((t) => t.tooling_item_id === tool.tool.id);
      if (!onOrder) {
        if (!(await confirmDialog(`${tool.tool.tooling_id} is not on this order — add it and take it?`, { confirmLabel: 'add + take' }))) return;
        await api.post(`/api/production/${id}/tools`, { tooling_item_ids: [tool.tool.id], required: false });
      }
      await api.post(`/api/production/${id}/take`, { tooling_item_ids: [tool.tool.id], note: `scanned at ${s.method}` });
      toast(`${tool.tool.tooling_id} taken`, 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function autoAssign() {
    try {
      const out = await api.post(`/api/production/${id}/auto-assign`, {});
      toast(`${out.assigned ?? out.added ?? 0} tool(s) attached from the filter definition`, 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function addTool() {
    const picked = await pickTooling({ title: 'which tool does this order need?' });
    if (!picked) return;
    try {
      await api.post(`/api/production/${id}/tools`, { tooling_item_ids: [picked.id], required: true });
      toast('added to the order', 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function removeTool(t) {
    if (!(await confirmDialog(`remove ${t.tooling_id} from this order?`, { danger: true, confirmLabel: 'remove' }))) return;
    await api.del(`/api/production/${id}/tools/${t.id}`);
    reload();
  }

  async function reserveSelected() {
    const ids = [...sel];
    if (!ids.length) return toast('tick the tools to reserve', 'error');
    try {
      const out = await api.post(`/api/production/${id}/reserve`, { tooling_item_ids: ids, note: 'reserved from the order screen' });
      toast(out.all_ok ? 'reserved — nobody else can take them' : `some refused: ${out.results.find((x) => !x.ok)?.error || ''}`, out.all_ok ? 'ok' : 'error', 8000);
      reload();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function startOrder(o, r) {
    if (!r.ready) return toast('the tooling gate says blocked — fix the reason first', 'error');
    if (!(await confirmDialog(`start ${o.po_number}? the attached tools will be marked as reserved`, { confirmLabel: 'start' }))) return;
    try {
      await api.post(`/api/production/${id}/start`, {});
      toast('order started', 'ok');
      statusCounts();
      reload();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function addBatch() {
    const values = await formDialog({
      title: 'log a batch',
      subtitle: `${v.order.quantity_produced} / ${v.order.quantity_ordered} so far`,
      fields: [
        { key: 'quantity', label: 'pieces in this batch', type: 'number', required: true, min: 1, initial: 100 },
        { key: 'good_qty', label: 'good pieces', type: 'number', min: 0 },
        { key: 'scrap_qty', label: 'scrap', type: 'number', min: 0, initial: 0 },
        { key: 'started_at', label: 'started at', type: 'datetime' },
        { key: 'notes', label: 'notes', type: 'text', wide: true },
      ],
    });
    if (!values) return;
    try {
      await api.post(`/api/production/${id}/batches`, values);
      toast('batch logged and the order progress updated', 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function completeOrder(o) {
    const values = await formDialog({
      title: 'complete the order',
      subtitle: `${o.quantity_produced} pcs produced so far`,
      fields: [
        { key: 'produced_qty', label: 'total good pieces', type: 'number', min: 0, initial: o.quantity_produced },
        { key: 'receive_to_stock', label: 'receive the finished parts into stock', type: 'checkbox', initial: true },
        { key: 'note', label: 'note', type: 'text', wide: true },
      ],
    });
    if (!values) return;
    try {
      const out = await api.post(`/api/production/${id}/complete`, values);
      toast(`order completed${out.received ? ` · ${out.received.quantity ?? ''} pcs into stock` : ''}`, 'ok', 7000);
      statusCounts();
      reload();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function receive(o) {
    const values = await formDialog({
      title: 'receive finished goods',
      fields: [
        { key: 'quantity', label: 'pieces', type: 'number', required: true, min: 1, initial: Math.max(1, Number(o.quantity_remaining || o.quantity_ordered)) },
        { key: 'note', label: 'note', type: 'text', wide: true },
      ],
    });
    if (!values) return;
    try {
      const out = await api.post(`/api/production/${id}/receive`, values);
      toast(`received ${out.quantity ?? values.quantity} pcs`, 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  async function editOrder(o) {
    const values = await formDialog({
      title: `edit ${o.po_number}`,
      wide: true,
      fields: [
        { key: 'quantity_ordered', label: 'pieces ordered', type: 'number', min: 1 },
        { key: 'quantity_produced', label: 'pieces produced', type: 'number', min: 0 },
        { key: 'priority', label: 'priority', type: 'select', options: ['LOW', 'NORMAL', 'HIGH', 'URGENT'] },
        { key: 'status', label: 'status', type: 'select', options: ['DRAFT', 'PLANNED', 'READY', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED'] },
        { key: 'line', label: 'line' },
        { key: 'machine', label: 'machine' },
        { key: 'planned_start_at', label: 'planned start', type: 'datetime' },
        { key: 'planned_end_at', label: 'planned end', type: 'datetime' },
        { key: 'customer_ref', label: 'customer ref' },
        { key: 'notes', label: 'notes', type: 'textarea', wide: true },
      ],
      initial: o,
    });
    if (!values) return;
    try {
      await api.put(`/api/production/${id}`, values);
      toast('saved', 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  }

  function printOrderLabel(o) {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${o.po_number}</title><style>
      body{font:14px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;margin:14mm}
      h1{font-size:30px;margin:0 0 2px;letter-spacing:.02em}
      .sub{color:#475569;margin:0 0 14px}
      .box{border:2px solid #0f172a;padding:6mm;border-radius:3mm;max-width:150mm}
      .row{display:flex;gap:12mm;align-items:center;margin-top:4mm}
      img{height:34mm}
      table{border-collapse:collapse} td{padding:2mm 3mm 2mm 0;vertical-align:top} td b{display:block;font-size:9px;text-transform:uppercase;color:#475569}
      .state{font-weight:800;color:${o.availability_status === 'READY' ? '#15803d' : '#b91c1c'}}
      @media print{body{margin:6mm}}
    </style></head><body><div class="box">
      <h1>${o.po_number}</h1>
      <p class="sub">Sistemi Purepower — production traveller</p>
      <div class="row">
        <table>
          <tr><td><b>filter</b>${o.filter_number}</td><td><b>quantity</b>${o.quantity_ordered} pcs</td></tr>
          <tr><td><b>line / machine</b>${o.line || '-'} · ${o.machine || '-'}</td><td><b>planned</b>${dateOnly(o.planned_start_at)} → ${dateOnly(o.planned_end_at) || '-'}</td></tr>
          <tr><td><b>customer ref</b>${o.customer_ref || '-'}</td><td class="state"><b>tooling</b>${o.availability_status === 'READY' ? 'READY' : 'BLOCKED'}</td></tr>
        </table>
        <img src="/api/labels/qr?kind=order&code=${encodeURIComponent(o.po_number)}" alt="order QR">
      </div>
    </div></body></html>`;
    printHtml(html);
  }

  await reload();
  return box;
}

export { MaintenanceView, RequestsView, ProductionView, OrderDetailView };
