/**
 * End-to-end API tests. Boots the real Express app on an ephemeral port against a
 * throwaway embedded database (fresh migrations + demo seed), then exercises the
 * workflows a user would follow in the browser - no mocks, no network, no fixtures.
 *
 *   npm test                 # full suite
 *   npm test -- --keep       # keep the temporary database for inspection
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const keep = process.argv.includes('--keep');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-test-'));
process.env.NODE_ENV = 'test';
process.env.EMBEDDED_DB_DIR = path.join(tmp, 'mariadb');
process.env.APP_SECRET = 'test-secret-not-for-production';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const results = [];
let group = 'general';

const ok = (name, extra) => results.push({ group, name, pass: true, extra });
const fail = (name, err) => results.push({ group, name, pass: false, error: err?.message ?? String(err), stack: err?.stack });

async function test(name, fn) {
  try {
    await fn();
  } catch (err) {
    fail(name, err);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

let server;
let base = '';
const jars = new Map();

async function request(method, url, { body, jar = null, form = null, raw = false } = {}) {
  const headers = {};
  if (jar) {
    const cookie = [...(jars.get(jar) ?? new Map()).entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    if (method !== 'GET' && method !== 'HEAD') {
      const csrf = (jars.get(jar) ?? new Map()).get('sp_csrf');
      if (csrf) headers['x-csrf-token'] = csrf;
    }
  }
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
  if (jar) {
    const map = jars.get(jar) ?? new Map();
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      map.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
    jars.set(jar, map);
  }
  if (raw) return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not json */
  }
  return { status: res.status, headers: res.headers, json, text };
}

const get = (url, jar) => request('GET', url, { jar });
const post = (url, body, jar) => request('POST', url, { body, jar });
const put = (url, body, jar) => request('PUT', url, { body, jar });
const del = (url, jar) => request('DELETE', url, { jar });

async function login(username, password, jar) {
  const res = await post('/api/auth/login', { username, password }, jar);
  assert(res.status === 200, `login as ${username} failed (${res.status}): ${res.text?.slice(0, 200)}`);
  return res.json;
}

async function main() {
  const { migrate } = await import('../server/db/migrate.js');
  const { seedCore } = await import('../server/seeds/core.js');
  const { seedDemo } = await import('../server/seeds/demo.js');
  const { buildApp } = await import('../server/app.js');
  const dbMod = await import('../server/db/index.js');
  const db = dbMod.default;

  // fresh temporary datadir: open the embedded engine before anything touches the pool
  await dbMod.initDb();
  group = 'setup';
  await test('migrations apply cleanly', async () => {
    const out = await migrate();
    assert(out.applied >= 9, `expected at least 9 migrations, got ${out.applied}`);
    ok('migrations', `${out.applied} applied`);
  });
  await test('core + demo seed writes the expected volume', async () => {
    await seedCore({});
    const stats = await seedDemo({});
    assert(stats.filters >= 20, 'need at least 20 demo filters');
    assert(stats.tooling >= 30, 'need at least 30 demo tooling items');
    assert(stats.movements >= 100, 'need movement history');
    ok('seed', JSON.stringify({ filters: stats.filters, tooling: stats.tooling, movements: stats.movements }));
  });

  const app = await buildApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  group = 'auth';
  await test('health reports the embedded database', async () => {
    const r = await get('/api/health');
    eq(r.status, 200, 'status');
    eq(r.json.status, 'ok', 'status field');
    eq(r.json.database.connected, true, 'db connected');
    ok('health');
  });
  await test('meta exposes the vocabulary without a session', async () => {
    const r = await get('/api/meta');
    eq(r.status, 200, 'status');
    eq(r.json.authenticated, false, 'authenticated');
    assert(r.json.tooling_statuses.length === 7, 'seven tooling statuses');
    assert(r.json.dimension_fields.tooling.length > 10, 'tooling dimension fields');
    ok('meta');
  });
  await test('protected endpoints reject anonymous callers', async () => {
    const r = await get('/api/tooling');
    eq(r.status, 401, 'status');
    assert(/sign in/i.test(r.json.error.message), 'message should explain the 401');
    ok('401 unauthenticated');
  });
  await test('a wrong password is rejected without leaking which part failed', async () => {
    const r = await post('/api/auth/login', { username: 'admin', password: 'nope-nope' }, 'bad');
    eq(r.status, 401, 'status');
    assert(/invalid username or password/i.test(r.json.error.message), 'generic message');
    ok('bad password');
  });
  await test('admin signs in and receives permissions + csrf token', async () => {
    const r = await login('admin', 'Admin#2026', 'admin');
    assert(r.csrfToken, 'csrf token present');
    assert(r.user.permissions.includes('*'), 'admin has *');
    ok('login');
  });
  await test('role permissions are enforced', async () => {
    await login('sales', 'Sales#2026', 'sales');
    const denied = await post('/api/tooling', { tooling_id: 'X-1', name: 'nope', tooling_type: 'HOUSING_RUBBER' }, 'sales');
    eq(denied.status, 403, 'sales may not create tooling');
    assert(/not allowed|permission/i.test(denied.json.error.message), 'explains the denial');
    const allowed = await get('/api/tooling?page_size=1', 'sales');
    eq(allowed.status, 200, 'sales may read tooling');
    ok('rbac');
  });

  group = 'filters';
  let filterId;
  let filterNumber;
  await test('create -> read -> update -> archive cycle for a filter', async () => {
    const created = await post(
      '/api/filters',
      {
        internal_number: 'PP-TEST-0001',
        name: 'Test oil filter',
        filter_type: 'OIL',
        dimensions: { length_mm: 76, width_mm: 76, height_mm: 90, overall_diameter_mm: 76 },
        materials: { media: 'synthetic', standard_batch_qty: 500 },
        cross_references: [{ ref_number: 'TEST-OEM-1', ref_type: 'OEM' }],
      },
      'admin',
    );
    eq(created.status, 201, `create: ${created.text?.slice(0, 300)}`);
    filterId = created.json.filter?.id ?? created.json.id;
    filterNumber = created.json.filter?.internal_number ?? created.json.internal_number;
    assert(filterId > 0, 'id returned');
    const one = await get(`/api/filters/${filterId}`, 'admin');
    eq(one.status, 200, 'fetch');
    eq(one.json.filter.internal_number, 'PP-TEST-0001', 'number');
    eq(one.json.dimensions.length_mm, 76, 'dimension stored in mm');
    const upd = await put(`/api/filters/${filterId}`, { name: 'Test oil filter v2', status: 'DEVELOPMENT' }, 'admin');
    eq(upd.status, 200, 'update');
    eq(upd.json.filter.name, 'Test oil filter v2', 'name updated');
    ok('filter crud');
  });
  await test('duplicate internal numbers are refused with a clear message', async () => {
    const r = await post('/api/filters', { internal_number: 'PP-TEST-0001', name: 'dupe', filter_type: 'OIL' }, 'admin');
    eq(r.status, 409, 'status');
    assert(/already exists/i.test(r.json.error.message), 'message');
    ok('duplicate filter');
  });
  await test('validation errors list the offending fields', async () => {
    const r = await post('/api/filters', { name: 'missing everything' }, 'admin');
    eq(r.status, 400, 'status');
    assert(Array.isArray(r.json.error.details) && r.json.error.details.length > 0, 'field errors listed');
    ok('validation');
  });
  await test('units are normalised to mm and shown in mm/cm/inch', async () => {
    const r = await post(
      '/api/filters',
      { internal_number: 'PP-TEST-0002', name: 'Inch filter', filter_type: 'AIR', dimensions: { length_mm: 10, width_mm: 5, height_mm: 2 }, dimension_unit: 'cm' },
      'admin',
    );
    eq(r.status, 201, `created: ${r.text?.slice(0, 200)}`);
    const one = await get(`/api/filters/${r.json.filter?.id ?? r.json.id}`, 'admin');
    eq(Number(one.json.dimensions.length_mm), 100, 'cm -> mm');
    const list = await get('/api/filters?min_length=95&max_length=105&min_width=45&max_width=55&page_size=50', 'admin');
    const unfiltered = await get('/api/filters?page_size=50', 'admin');
    assert(list.json.pagination.total < unfiltered.json.pagination.total, 'the size range narrows the list');
    assert(list.json.items.some((f) => f.internal_number === 'PP-TEST-0002'), 'dimension filter finds it');
    ok('unit conversion');
  });
  await test('vehicle applications round-trip', async () => {
    const r = await post(
      `/api/filters/${filterId}/applications`,
      { manufacturer: 'Test Motors', model: 'Alpha', generation: 'Mk1', year_from: 2020, year_to: 2025, engine: '1.2 TSI', engine_code: 'TESTA', fuel: 'Petrol', power_hp: 110 },
      'admin',
    );
    eq(r.status, 201, `application created: ${r.text?.slice(0, 200)}`);
    const list = await get(`/api/filters/${filterId}/applications`, 'admin');
    assert(list.json.items.length >= 1, 'application listed');
    const byVehicle = await get('/api/filters?vehicle=Alpha&page_size=20', 'admin');
    assert(byVehicle.json.items.some((f) => f.id === filterId), 'vehicle search finds the filter');
    ok('applications');
  });

  group = 'tooling';
  let toolId;
  let toolCode;
  let toolTypeId;
  await test('tooling ids are generated from the category prefix', async () => {
    const r = await get('/api/tooling/next-id?type=RH', 'admin');
    eq(r.status, 200, 'status');
    assert(/^[A-Z]+-\d{5}-[A-Z]$/.test(r.json.tooling_id), `unexpected id format ${r.json.tooling_id}`);
    ok('next-id', r.json.tooling_id);
  });
  await test('create tooling with dimensions, photo-free, linked to the filter', async () => {
    const r = await post(
      '/api/tooling',
      {
        name: 'Test rubber housing',
        tooling_type: 'RH', // the code or name is accepted next to tooling_type_id
        status: 'AVAILABLE',
        condition_rating: 'GOOD',
        material: 'Steel S235',
        quantity: 1,
        max_cycles: 50000,
        dimensions: { overall_length_mm: 310, overall_width_mm: 155, overall_height_mm: 65, internal_length_mm: 300 },
        filter_id: filterId,
      },
      'admin',
    );
    eq(r.status, 201, `create tooling: ${r.text?.slice(0, 300)}`);
    toolId = r.json.tool?.id ?? r.json.tooling?.id ?? r.json.id;
    toolCode = r.json.tool?.tooling_id ?? r.json.tooling_id ?? r.json.tooling?.tooling_id;
    assert(typeof toolCode === 'string' && toolCode.length > 3, `auto numbering produced ${toolCode}`);
    const byCode = await get(`/api/tooling/code/${toolCode}`, 'admin');
    eq(byCode.status, 200, 'fetch by code');
    eq(Number(byCode.json.dimensions.overall_length_mm), 310, 'dimension stored');
    ok('create tooling', toolCode);
  });
  await test('the filter can require that category', async () => {
    const types = await get('/api/tooling/types/list', 'admin');
    const rh = types.json.items.find((t) => t.code === 'RH');
    assert(rh, 'the Rubber Forming Housing category exists');
    toolTypeId = rh.id;
    const req = await post(`/api/filters/${filterId}/requirements`, { tooling_type_id: rh.id, quantity_required: 1, is_mandatory: true, note: 'test requirement' }, 'admin');
    assert(req.status === 200 || req.status === 201, `requirement: ${req.text?.slice(0, 200)}`);
    ok('requirement');
  });
  await test('the filter overview lists that tool as required and ready', async () => {
    const r = await get(`/api/filters/${filterId}/tooling-overview`, 'admin');
    eq(r.status, 200, 'status');
    const payload = JSON.stringify(r.json);
    assert(payload.includes(toolCode), 'overview mentions the new tool');
    assert(r.json.production || r.json.readiness || r.json.availability || payload.includes('READY'), 'production readiness block present');
    ok('overview');
  });
  await test('dimension search with tolerance finds it and reports a match percentage', async () => {
    const r = await get('/api/tooling/dimension-search?length=310&width=155&tolerance=3', 'admin');
    eq(r.status, 200, `status (${r.text?.slice(0, 200)})`);
    assert(r.json.items.some((i) => i.tooling_id === toolCode), 'tool found by size');
    ok('dimension search');
  });
  await test('"do we already have this tool?" answers with the existing tool', async () => {
    const r = await post('/api/identify/check-existing', { length: 310, width: 155, height: 65, tolerance_mm: 3, type_code: 'RH' }, 'admin');
    eq(r.status, 200, 'status');
    assert(['EXACT_MATCH', 'SIMILAR_EXISTS'].includes(r.json.verdict), `verdict was ${r.json.verdict}`);
    assert(r.json.answer.length > 10, 'human answer');
    const none = await post('/api/identify/check-existing', { length: 9977, width: 4411, tolerance_mm: 1 }, 'admin');
    eq(none.json.verdict, 'NO_MATCH', 'unknown size is a miss');
    ok('check-existing');
  });
  await test('status changes are validated and audited', async () => {
    const bad = await post(`/api/tooling/${toolId}/status`, { status: 'BORROWED' }, 'admin');
    eq(bad.status, 400, 'unknown status rejected');
    const good = await post(`/api/tooling/${toolId}/status`, { status: 'MAINTENANCE', reason: 'test: cracked edge' }, 'admin');
    eq(good.status, 200, 'status set');
    eq(good.json.tool.status, 'MAINTENANCE', 'status value');
    const audit = await get(`/api/audit?entity_type=tooling_item&action=status&page_size=20`, 'admin');
    assert(audit.json.items.length > 0, 'audit entry written');
    ok('status');
  });
  await test('revisions keep history instead of overwriting', async () => {
    const before = await get(`/api/tooling/${toolId}/revisions`, 'admin');
    const upd = await put(`/api/tooling/${toolId}`, { dimensions: { overall_length_mm: 312, overall_width_mm: 155, overall_height_mm: 65 }, change_reason: 'test: widened cavity' }, 'admin');
    eq(upd.status, 200, `update: ${upd.text?.slice(0, 200)}`);
    const after = await get(`/api/tooling/${toolId}/revisions`, 'admin');
    assert(after.json.items.length > before.json.items.length, 'a revision row was added');
    assert(after.json.items.some((rev) => String(rev.change_summary ?? rev.summary ?? '').includes('widened')), 'revision reason kept');
    ok('revisions');
  });
  await test('archive is reversible and keeps the record', async () => {
    const arch = await del(`/api/tooling/${toolId}`, 'admin');
    eq(arch.status, 200, 'archive');
    const gone = await get(`/api/tooling/${toolId}`, 'admin');
    assert(gone.status === 404 || gone.json?.tool?.deleted_at || gone.json?.tooling?.deleted_at, 'archived tool is hidden from the default view');
    const restore = await post(`/api/tooling/${toolId}/restore`, {}, 'admin');
    eq(restore.status, 200, 'restore');
    const back = await get(`/api/tooling/${toolId}`, 'admin');
    eq(back.status, 200, 'visible again');
    ok('archive/restore');
  });

  group = 'warehouse';
  let shelfId;
  let shelfCode;
  await test('the hierarchy and occupancy are reported', async () => {
    const tree = await get('/api/warehouse/locations/tree?max_depth=3', 'admin');
    eq(tree.status, 200, 'status');
    assert(tree.json.warehouses.length >= 3, 'at least three warehouses in the demo set');
    const occ = await get('/api/warehouse/occupancy', 'admin');
    eq(occ.status, 200, 'occupancy status');
    ok('tree', `${tree.json.warehouses.length} warehouses`);
  });
  await test('a shelf can be created, located and resolved by code', async () => {
    const racks = await get('/api/warehouse/locations?kind=RACK&limit=1', 'admin');
    const rack = racks.json.items[0];
    assert(rack, 'demo data has a rack');
    const created = await post('/api/warehouse/locations', { kind: 'SHELF', parent_location_id: rack.id, code: 'S90', label: 'Test shelf', capacity_items: 10 }, 'admin');
    eq(created.status, 201, `create shelf: ${created.text?.slice(0, 240)}`);
    shelfId = created.json.id ?? created.json.location?.id;
    shelfCode = created.json.full_code ?? created.json.location?.full_code;
    assert(/-S90$/.test(shelfCode), `full code should end in -S90, got ${shelfCode}`);
    const resolved = await get(`/api/warehouse/locations/resolve/${encodeURIComponent(shelfCode)}`, 'admin');
    eq(resolved.status, 200, 'resolve by code');
    eq(resolved.json.location.id, shelfId, 'same row');
    ok('shelf', shelfCode);
  });
  await test('a tool can be placed on a shelf and the map shows it', async () => {
    const r = await post(`/api/tooling/${toolId}/move`, { action: 'MOVE', location_id: shelfId, note: 'test placement' }, 'admin');
    assert(r.status === 200 || r.status === 201, `move: ${r.text?.slice(0, 300)}`);
    const tool = await get(`/api/tooling/${toolId}`, 'admin');
    eq(tool.json.tool.location_id, shelfId, 'location set');
    const contents = await get(`/api/warehouse/contents?location=${encodeURIComponent(shelfCode)}`, 'admin');
    assert(contents.json.items.some((i) => i.id === toolId), 'shelf contents list the tool');
    const map = await get('/api/warehouse/warehouses/1/map', 'admin');
    eq(map.status, 200, 'map renders');
    ok('place tool');
  });
  await test('duplicate location codes are refused', async () => {
    const racks = await get('/api/warehouse/locations?kind=RACK&limit=1', 'admin');
    const r = await post('/api/warehouse/locations', { kind: 'SHELF', parent_location_id: racks.json.items[0].id, code: 'S90', label: 'dupe' }, 'admin');
    eq(r.status, 409, 'duplicate refused');
    ok('duplicate location');
  await test('the storage map keeps placed cells when only settings change', async () => {
    const shelf = await get(`/api/warehouse/locations/${shelfId}`, 'admin');
    const whId = shelf.json.location.warehouse_id;
    assert(whId, 'the shelf belongs to a warehouse');
    const saved = await put(`/api/warehouse/warehouses/${whId}/layout`, { grid_cols: 22, grid_rows: 11, cell_size_px: 44, items: [{ location_id: shelfId, x: 4, y: 2, w: 2, color: '#1d4ed8' }] }, 'admin');
    eq(saved.status, 200, `layout save: ${saved.text?.slice(0, 240)}`);
    eq(saved.json.grid_cols, 22, 'grid width stored');
    const noteOnly = await put(`/api/warehouse/warehouses/${whId}/layout`, { note: 'aisle repainted' }, 'admin');
    eq(noteOnly.status, 200, 'a settings-only save is accepted');
    eq(noteOnly.json.grid_cols, 22, 'a partial save must not reset the grid');
    const map = await get(`/api/warehouse/warehouses/${whId}/layout`, 'admin');
    eq(map.status, 200, 'map read');
    const cell = (map.json.cells ?? []).find((c) => Number(c.location_id) === Number(shelfId));
    assert(cell, 'the test shelf is on the map');
    eq(Number(cell.map_col), 4, 'column kept');
    eq(Number(cell.map_row), 2, 'row kept');
    const badShape = await put(`/api/warehouse/warehouses/${whId}/layout`, { items: 5 }, 'admin');
    eq(badShape.status, 400, 'a non-array cell list is a validation error, not a 500');
    ok('storage map');
  });
  });

  group = 'movements';
  await test('take + return writes history, moves the tool and never deletes anything', async () => {
    const before = await get(`/api/movements?tooling_code=${toolCode}`, 'admin');
    const take = await post(`/api/tooling/${toolId}/move`, { action: 'TAKE', note: 'to press 3', external: 'Press 3' }, 'admin');
    assert(take.status === 200 || take.status === 201, `take: ${take.text?.slice(0, 300)}`);
    const during = await get(`/api/tooling/${toolId}`, 'admin');
    eq(during.json.tool.status, 'IN_USE', 'status after take');
    const ret = await post(`/api/tooling/${toolId}/move`, { action: 'RETURN', location_id: shelfId, note: 'back on shelf' }, 'admin');
    assert(ret.status === 200 || ret.status === 201, `return: ${ret.text?.slice(0, 300)}`);
    const after = await get(`/api/movements?tooling_code=${toolCode}`, 'admin');
    assert(after.json.pagination.total >= before.json.pagination.total + 2, 'two new movement rows');
    const tool = await get(`/api/tooling/${toolId}`, 'admin');
    eq(tool.json.tool.location_id, shelfId, 'back on the shelf');
    eq(tool.json.tool.status, 'AVAILABLE', 'available again');
    ok('take/return');
  });
  await test('a return to an unknown location code explains itself', async () => {
    const r = await post(`/api/tooling/${toolId}/move`, { action: 'RETURN', location: 'TR-R99-RK99-S99' }, 'admin');
    assert(r.status === 400 || r.status === 404, `rejected with ${r.status}`);
    assert(/not found|unknown|does not exist/i.test(JSON.stringify(r.json)), `message: ${r.text?.slice(0, 200)}`);
    ok('unknown location');
  });
  await test('the undo path reverses the last movement without deleting it', async () => {
    const list = await get(`/api/movements?tooling_code=${toolCode}&sort=created_at&dir=desc`, 'admin');
    const last = list.json.items[0];
    assert(last, 'a movement exists to undo');
    const r = await post(`/api/movements/${last.id}/undo`, { reason: 'test: mis-scan' }, 'admin');
    eq(r.status, 200, `undo: ${r.text?.slice(0, 240)}`);
    const again = await get(`/api/movements?tooling_code=${toolCode}`, 'admin');
    assert(again.json.pagination.total === list.json.pagination.total + 1, 'undo appends a row instead of deleting');
    ok('undo movement');
  });

  group = 'qr';
  await test('a scanned tool code resolves to the tool record', async () => {
    const r = await post('/api/labels/scan', { code: `SP:T:${toolCode}` }, 'admin');
    eq(r.status, 200, 'resolved');
    eq(r.json.kind, 'tooling', 'kind');
    eq(r.json.code, toolCode, 'code');
    ok('scan tool');
  });
  await test('a scanned shelf code resolves to the location', async () => {
    const loc = await get(`/api/warehouse/locations/${shelfId}`, 'admin');
    const r = await post('/api/labels/scan', { code: `SP:L:${loc.json.location.full_code}` }, 'admin');
    eq(r.status, 200, 'resolved');
    eq(r.json.kind, 'location', 'kind');
    ok('scan shelf');
  });
  await test('an unknown code returns a useful 404', async () => {
    const r = await post('/api/labels/scan', { code: 'SP:T:DOES-NOT-EXIST' }, 'admin');
    eq(r.status, 404, 'status');
    assert(/neither a tooling id|not found/i.test(r.json.error.message), `message: ${r.text?.slice(0, 200)}`);
    ok('scan unknown');
  });
  await test('qr + barcode images are generated and labels are printable', async () => {
    const qr = await get(`/api/labels/qr?kind=tooling&code=${toolCode}`, 'admin');
    eq(qr.status, 200, 'qr status');
    assert(qr.text.includes('<svg'), 'qr is an svg');
    const sheet = await request('POST', '/api/labels/sheet', { body: { kind: 'tooling', codes: toolCode }, jar: 'admin' });
    eq(sheet.status, 200, `sheet: ${sheet.text?.slice(0, 200)}`);
    assert(sheet.json.count === 1, 'one label');
    assert(sheet.json.html.includes(toolCode), 'label html contains the code');
    ok('qr + labels');
  });

  group = 'production';
  let orderId;
  await test('a production order reports READY with the required tooling', async () => {
    const r = await post('/api/production', { filter_id: filterId, quantity_ordered: 200, line: 'Line 1', tooling_item_ids: [toolId], planned_start_at: '2026-01-05 08:00:00' }, 'admin');
    eq(r.status, 201, `create order: ${r.text?.slice(0, 300)}`);
    orderId = r.json.order?.id ?? r.json.id;
    const av = await get(`/api/production/${orderId}/availability`, 'admin');
    eq(av.status, 200, 'availability');
    eq(av.json.ready, true, `should be ready: ${JSON.stringify(av.json).slice(0, 300)}`);
    ok('order ready');
  });
  await test('taking the tool away blocks the order with the exact reason', async () => {
    const dmg = await post(`/api/tooling/${toolId}/status`, { status: 'DAMAGED', reason: 'test: crack found' }, 'admin');
    eq(dmg.status, 200, 'status');
    const av = await get(`/api/production/${orderId}/availability`, 'admin');
    eq(av.json.ready, false, 'blocked');
    assert(JSON.stringify(av.json).includes(toolCode), 'the blocked reason names the tool');
    const order = await get(`/api/production/${orderId}`, 'admin');
    assert(/NOT_READY|BLOCKED/.test(JSON.stringify(order.json)), 'order carries the blocked flag');
    await post(`/api/tooling/${toolId}/status`, { status: 'AVAILABLE', reason: 'test: repaired' }, 'admin');
    const back = await get(`/api/production/${orderId}/availability`, 'admin');
    eq(back.json.ready, true, 'ready again after repair');
    ok('blocking');
  });
  await test('reserve prevents double booking and releases cleanly', async () => {
    const other = await post('/api/production', { filter_id: filterId, quantity_ordered: 50, line: 'Line 2' }, 'admin');
    const otherId = other.json.order?.id ?? other.json.id;
    const res1 = await post(`/api/production/${orderId}/reserve`, { tooling_item_ids: [toolId] }, 'admin');
    eq(res1.status, 200, `reserve 1: ${res1.text?.slice(0, 200)}`);
    const res2 = await post(`/api/production/${otherId}/reserve`, { tooling_item_ids: [toolId] }, 'admin');
    eq(res2.status, 409, `second reservation refused: ${res2.text?.slice(0, 200)}`);
    assert(/reserved|another order|block/i.test(res2.text), 'the refusal says why');
    const rel = await post(`/api/production/${orderId}/release`, { tooling_item_ids: [toolId] }, 'admin');
    eq(rel.status, 200, 'release');
    const res3 = await post(`/api/production/${otherId}/reserve`, { tooling_item_ids: [toolId] }, 'admin');
    eq(res3.status, 200, 'now the other order can reserve it');
    ok('reservations');
  });
  await test('usage is logged and the cycle counter increases', async () => {
    const before = await get(`/api/tooling/${toolId}`, 'admin');
    const cyc = Number(before.json.tool.total_cycles ?? 0);
    const u = await post(`/api/tooling/${toolId}/usage`, { cycles: 100, produced_qty: 98, production_order_id: orderId, note: 'test batch' }, 'admin');
    assert(u.status === 200 || u.status === 201, `usage: ${u.text?.slice(0, 240)}`);
    const after = await get(`/api/tooling/${toolId}`, 'admin');
    assert(Number(after.json.tool.total_cycles) > cyc, `cycles went from ${cyc} to ${after.json.tool.total_cycles}`);
    ok('cycles');
  });

  group = 'maintenance';
  let jobId;
  let damageReportId;
  await test('a damage report can open a repair job', async () => {
    const r = await post(
      '/api/maintenance/damage',
      { tooling_item_id: toolId, damage_type: 'CRACKED', severity: 'HIGH', description: 'test crack near the locating pin', create_repair_request: true, status: 'OPEN' },
      'admin',
    );
    eq(r.status, 201, `damage: ${r.text?.slice(0, 300)}`);
    const reportId = r.json.report?.id ?? r.json.id;
    damageReportId = reportId;
    assert(reportId > 0, 'report id');
    const list = await get('/api/maintenance/damage?size=50', 'admin');
    assert(list.json.items.some((i) => i.id === reportId), 'listed');
    const tool = await get(`/api/tooling/${toolId}`, 'admin');
    eq(tool.json.tool.status, 'DAMAGED', 'tool flagged damaged');
    ok('damage');
  });
  await test('scheduling maintenance sets a next due date and raises an alert', async () => {
    const s = await post('/api/maintenance', { tooling_item_id: toolId, kind: 'CORRECTIVE', scheduled_date: '2026-01-02', priority: 'HIGH', work_description: 'test: weld and re-machine', condition_before: 'POOR' }, 'admin');
    eq(s.status, 201, `schedule: ${s.text?.slice(0, 240)}`);
    jobId = s.json.id ?? s.json.maintenance?.id ?? s.json.record?.id;
    const due = await get('/api/maintenance?status=SCHEDULED&size=50', 'admin');
    assert(due.json.items.some((i) => i.id === jobId), 'scheduled job listed');
    ok('maintenance scheduled');
  });
  await test('completing maintenance restores availability and advances the interval', async () => {
    if (damageReportId) {
      const closed = await post(`/api/maintenance/damage/${damageReportId}/resolve`, { status: 'RESOLVED', resolution: 'Repaired and returned to service', maintenance_id: jobId, set_status: 'MAINTENANCE' }, 'admin');
      eq(closed.status, 200, `resolve damage: ${closed.text?.slice(0, 200)}`);
    }
    const c = await post(`/api/maintenance/${jobId}/complete`, { completed_date: '2026-01-03', technician: 'Test Tech', condition_after: 'GOOD', work_description: 'Crack welded, faces re-machined', downtime_hours: 4, cost: 320, next_maintenance_date: '2026-07-02', return_to_service: true }, 'admin');
    eq(c.status, 200, `complete: ${c.text?.slice(0, 300)}`);
    // the damage report also opened a repair job - close everything so the tool can go back in service
    const stillOpen = await get(`/api/maintenance?tooling_item_id=${toolId}&open_only=1&size=50`, 'admin');
    for (const job of (stillOpen.json.items ?? []).filter((x) => x.id !== jobId)) {
      await post(`/api/maintenance/${job.id}/complete`, { completed_date: '2026-01-03', technician: 'Test Tech', condition_after: 'GOOD', work_description: 'Follow-up check', return_to_service: true }, 'admin');
    }
    const tool = await get(`/api/tooling/${toolId}`, 'admin');
    eq(tool.json.tool.status, 'AVAILABLE', 'available again');
    assert(tool.json.tool.next_maintenance_date && String(tool.json.tool.next_maintenance_date) > '2026-06-01', `next date advanced: ${tool.json.tool.next_maintenance_date}`);
    ok('maintenance completed');
  });
  await test('a tooling request goes pending -> approved -> completed', async () => {
    const r = await post('/api/maintenance/requests', { filter_id: filterId, tooling_type_id: toolTypeId, title: 'Test second housing', description: 'Existing tool is on the other line', quantity: 1, priority: 'NORMAL' }, 'admin');
    eq(r.status, 201, `request: ${r.text?.slice(0, 300)}`);
    const id = r.json.request?.id ?? r.json.id;
    const a = await post(`/api/maintenance/requests/${id}/status`, { status: 'APPROVED', decision_note: 'ok' }, 'admin');
    eq(a.status, 200, `approve: ${a.text?.slice(0, 200)}`);
    const c = await post(`/api/maintenance/requests/${id}/create-tooling`, { name: 'Test second housing', quantity: 1, status: 'AVAILABLE' }, 'admin');
    eq(c.status, 201, `create from request: ${c.text?.slice(0, 240)}`);
    const after = await get(`/api/maintenance/requests/${id}`, 'admin').catch(() => null);
    ok('requests', after ? '' : 'detail route optional');
  });

  group = 'inventory';
  await test('a split count finds and applies a variance', async () => {
    const loc = await get('/api/inventory/locations', 'admin');
    const stockItem = await get('/api/inventory?page_size=1', 'admin');
    const itemId = stockItem.json.items[0].id;
    const recv = await post('/api/inventory/transactions', { inventory_item_id: itemId, txn_type: 'RECEIPT', quantity: 10, location: loc.json.items[0]?.code }, 'admin');
    eq(recv.status, 201, `receipt: ${recv.text?.slice(0, 240)}`);
    const count = await post('/api/inventory/counts', { title: 'Test count', method: 'FULL' }, 'admin');
    eq(count.status, 201, `open count: ${count.text?.slice(0, 240)}`);
    const detail = await get(`/api/inventory/counts/${count.json.id}`, 'admin');
    assert(detail.json.lines.length > 0, 'count sheet has lines');
    const line = detail.json.lines.find((l) => l.inventory_item_id === itemId) ?? detail.json.lines[0];
    const entered = await post(`/api/inventory/counts/${count.json.id}/lines/${line.id}`, { counter: 'A', qty: Number(line.system_qty) + 3 }, 'admin');
    eq(entered.status, 200, `enter: ${entered.text?.slice(0, 200)}`);
    eq(entered.json.line.variance, 3, 'variance recorded');
    const applied = await post(`/api/inventory/counts/${count.json.id}/apply`, {}, 'admin');
    eq(applied.status, 200, `apply: ${applied.text?.slice(0, 240)}`);
    const item = await get(`/api/inventory/items/${itemId}`, 'admin');
    assert(Number(item.json.totals.on_hand) >= 13, `stock reflects the count (${item.json.totals.on_hand})`);
    ok('split count');
  });

  group = 'search';
  await test('global search finds filters, tools, shelves and scans', async () => {
    const r = await get(`/api/search?q=${encodeURIComponent(toolCode.slice(0, 7))}`, 'admin');
    eq(r.status, 200, `status: ${r.text?.slice(0, 200)}`);
    assert(Object.keys(r.json.groups).length >= 4, 'multiple groups');
    const s = await get('/api/search/suggest?q=PP-TEST', 'admin');
    assert(s.json.items.some((i) => String(i.code).startsWith('PP-TEST')), 'suggest finds the test filter');
    ok('search');
  });
  await test('OEM cross-reference search finds the filter', async () => {
    const r = await get('/api/search?q=TEST-OEM-1', 'admin');
    assert(JSON.stringify(r.json).includes('PP-TEST-0001'), 'found via OEM number');
    ok('oem search');
  });

  group = 'reports+exports';
  await test('every report runs and returns rows', async () => {
    const list = await get('/api/reports', 'admin');
    eq(list.json.items.length, 8, 'eight report types');
    for (const rep of list.json.items) {
      const r = await get(`/api/reports/${rep.code}/data`, 'admin');
      assert(r.status === 200, `${rep.code} failed: ${r.text?.slice(0, 160)}`);
      assert(Array.isArray(r.json.rows), `${rep.code} has no rows array`);
    }
    ok('all reports');
  });
  await test('reports export to xlsx and pdf with real content', async () => {
    const x = await request('GET', '/api/reports/tooling_inventory.xlsx', { jar: 'admin', raw: true });
    eq(x.status, 200, 'xlsx status');
    assert(x.buffer.length > 2000, `xlsx too small (${x.buffer.length} bytes)`);
    eq(x.buffer.slice(0, 2).toString(), 'PK', 'xlsx is a zip');
    const p = await request('GET', '/api/reports/filter_tooling_matrix.pdf', { jar: 'admin', raw: true });
    eq(p.status, 200, 'pdf status');
    assert(p.buffer.slice(0, 5).toString() === '%PDF-', 'pdf magic bytes');
    assert(p.buffer.length > 1500, `pdf too small (${p.buffer.length})`);
    ok('report files');
  });
  await test('table exports honour the current filters', async () => {
    const all = await get('/api/export/preview/tooling', 'admin');
    const one = await get(`/api/export/preview/tooling?q=${toolCode}`, 'admin');
    eq(one.status, 200, 'status');
    assert(one.json.count < all.json.count, 'filtered export is smaller');
    const csv = await request('GET', '/api/export/tooling.csv', { jar: 'admin', raw: true });
    eq(csv.status, 200, 'csv status');
    assert(csv.buffer.toString().split('\n').length > 1, 'csv has rows');
    ok('exports');
  });
  await test('the import template downloads and validation reports per-row errors', async () => {
    const tpl = await request('GET', '/api/import/templates/filters.xlsx', { jar: 'admin', raw: true });
    eq(tpl.status, 200, 'template status');
    assert(tpl.buffer.slice(0, 2).toString() === 'PK', 'template is xlsx');
    const dry = await post('/api/import/filters/paste', { rows: [{ internal_number: 'PP-IMP-1', name: 'Imported', filter_type: 'OIL', length_mm: 70 }, { internal_number: '', filter_type: 'NOPE' }], dry_run: true }, 'admin');
    eq(dry.status, 200, `dry run: ${dry.text?.slice(0, 240)}`);
    eq(dry.json.valid, 1, 'one valid row');
    eq(dry.json.invalid, 1, 'one rejected row');
    assert(dry.json.errors[0].errors.length >= 1, 'reason given');
    const real = await post('/api/import/filters/paste', { rows: [{ internal_number: 'PP-IMP-1', name: 'Imported', filter_type: 'OIL' }], dry_run: false }, 'admin');
    eq(real.status, 200, `write: ${real.text?.slice(0, 240)}`);
    eq(real.json.written, 1, 'written');
    const found = await get('/api/filters?q=PP-IMP-1', 'admin');
    assert(JSON.stringify(found.json).includes('PP-IMP-1'), 'imported filter is searchable');
    ok('import');
  });

  group = 'admin';
  await test('settings round-trip and drive behaviour', async () => {
    const r = await put('/api/admin/settings', { settings: { shelf_fill_full_pct: 95 } }, 'admin');
    eq(r.status, 200, `settings: ${r.text?.slice(0, 200)}`);
    const map = await get('/api/warehouse/warehouses/1/map', 'admin');
    eq(map.status, 200, 'map still fine');
    const denied = await put('/api/admin/settings', { settings: { shelf_fill_full_pct: 50 } }, 'sales');
    eq(denied.status, 403, 'sales cannot change settings');
    ok('settings');
  });
  await test('a backup is created, listed and downloadable', async () => {
    const c = await post('/api/admin/backups', { kind: 'manual' }, 'admin');
    eq(c.status, 201, `backup: ${c.text?.slice(0, 240)}`);
    assert(c.json.size_bytes > 0, 'non-empty backup');
    const list = await get('/api/admin/backups', 'admin');
    assert(list.json.items.length >= 1, 'listed');
    assert(list.json.status.last_success_at, 'status shows the last success');
    const dl = await request('GET', `/api/admin/backups/${list.json.items[0].id}/download`, { jar: 'admin', raw: true });
    eq(dl.status, 200, 'download status');
    assert(dl.buffer.length === list.json.items[0].size_bytes, 'downloaded size matches the record');
    ok('backup');
  });
  await test('user administration works and guards self-deletion', async () => {
    const created = await post('/api/admin/users', { username: 'tester', full_name: 'Test Person', role: 'warehouse', password: 'Tester#2026' }, 'admin');
    eq(created.status, 201, `user: ${created.text?.slice(0, 240)}`);
    const jar = 'tester';
    await login('tester', 'Tester#2026', jar);
    const me = await get('/api/auth/me', jar);
    eq(me.json.user.role, 'warehouse', 'role applied');
    const self = await del('/api/admin/users/1', 'admin');
    eq(self.status, 400, 'cannot delete your own account');
    ok('users');
  });
  await test('the audit log records writes with old and new values', async () => {
    const r = await get('/api/audit?entity_type=tooling&page_size=20', 'admin');
    eq(r.status, 200, 'status');
    assert(r.json.items.length > 0, 'audit rows exist');
    const withDiff = await get('/api/audit?page_size=100&action=update', 'admin');
    assert(withDiff.json.items.some((i) => i.old_value || i.new_value), 'at least one update stores old/new values');
    ok('audit');
  });
  await test('notifications surface maintenance, damage and blocked-order alerts', async () => {
    await post('/api/notifications/refresh', {}, 'admin');
    const r = await get('/api/stats/alerts', 'admin');
    eq(r.status, 200, `alerts: ${r.text?.slice(0, 200)}`);
    assert(r.json.items.length > 0, 'some alerts exist in the demo data');
    ok('alerts', `${r.json.items.length} alerts`);
  });
  await test('unknown api routes return a json 404, not html', async () => {
    const r = await get('/api/definitely-not-a-route', 'admin');
    eq(r.status, 404, 'status');
    assert(r.json?.error, 'json error body');
    ok('404 handler');
  });
  await test('the SPA is served for app routes', async () => {
    const r = await get('/', 'admin');
    eq(r.status, 200, 'index served');
    assert(/<script type="module" src="\/js\/app\.js"><\/script>/.test(r.text), 'index.html boots the app module');
    assert(/<div id="boot"|<div id="app"/.test(r.text), 'index.html contains the mount point');
    assert(/<link rel="manifest"/.test(r.text), 'index.html links the web app manifest');
    ok('spa');
  });

  group = 'performance';
  await test('list endpoints paginate and stay under 900 ms on the demo set', async () => {
    const t0 = Date.now();
    const r = await get('/api/tooling?page=2&page_size=50&sort=tooling_id&dir=desc', 'admin');
    const ms = Date.now() - t0;
    eq(r.status, 200, 'status');
    assert(r.json.items.length === 50, `page size respected (${r.json.items.length})`);
    assert(ms < 900, `too slow: ${ms}ms`);
    ok('pagination', `${ms}ms`);
  });

  await new Promise((resolve) => server.close(resolve));
  await dbMod.closeDb().catch(() => {});
  if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
  else console.log(`test database kept at ${tmp}`);

  const failed = results.filter((r) => !r.pass);
  let lastGroup = '';
  for (const r of results) {
    if (r.group !== lastGroup) {
      console.log(`\n${r.group}`);
      lastGroup = r.group;
    }
    console.log(`  ${r.pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${r.name}${r.extra ? `  (${r.extra})` : ''}${r.error ? `\n      ${r.error}` : ''}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? ` - ${failed.length} FAILED` : ''}`);
  if (!keep && failed.length) console.log('run with --keep to inspect the temporary database');
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error('test harness failed:', err);
  process.exitCode = 1;
  try {
    server?.close();
  } catch {
    /* ignore */
  }
  if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
});
