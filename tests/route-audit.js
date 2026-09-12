/**
 * Route audit - "no button goes nowhere".
 *
 * Parses the mount table in server/app.js plus every router.<method>() handler in
 * server/routes/*.js, then checks that each /api/... URL called from public/js/*.js
 * resolves to a real endpoint with the right HTTP method.
 *
 *   node tests/route-audit.js        (also: npm run test:routes)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ---------------------------------------------------------------- server */
/** Template literal -> a concrete-ish path: each ${...} becomes "1" (an id), a trailing query string is dropped. */
function flatten(literal) {
  let out = '';
  for (let i = 0; i < literal.length; i++) {
    /* eslint-disable no-continue */
    if (literal[i] === '$' && literal[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      while (j < literal.length && depth) {
        if (literal[j] === '{') depth++;
        else if (literal[j] === '}') depth--;
        j++;
      }
      // a template that starts a path segment is an id; one appended to a path is a query string
      if (out.endsWith('/')) out += '1';
      else break;
      i = j - 1;
    } else out += literal[i];
  }
  return out.split('?')[0];
}
const appSrc = read('server/app.js').replace(/\s+/g, ' '); // mounts are written across several lines
const mounts = []; // [parentVar, prefix, childRouterVar]
for (const m of appSrc.matchAll(/(\w+)\.use\(\s*(?:'([^']*)'|"([^"]*)")\s*,\s*(?:rateLimiter\([^)]*\)\s*,\s*)?(\w+)\)/g)) {
  mounts.push([m[1], m[2] ?? m[3] ?? '', m[4]]);
}
for (const m of appSrc.matchAll(/(\w+)\.use\(\s*(\w+Router|\w*api|\w*Api)\s*\)/g)) {
  mounts.push([m[1], '', m[2]]); // mounted without a prefix
}
const routerFile = new Map();
for (const m of appSrc.matchAll(/import\s+(\w+)\s+from\s+'\.\/routes\/([\w.-]+)\.js'/g)) routerFile.set(m[1], `server/routes/${m[2]}.js`);

function resolvePrefix(parentVar, prefix, seen = 0) {
  if (parentVar === 'app' || seen > 6) return prefix;
  const parent = mounts.find(([, , child]) => child === parentVar);
  if (!parent) return prefix;
  return resolvePrefix(parent[0], parent[1] + prefix, seen + 1);
}

const addRoute = (method, pattern, file) => {
  const clean = pattern.replace(/\\\//g, '/');
  const rx = new RegExp(
    '^' +
      clean
        .split('/')
        .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/\(.*\)$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('/') +
      '\\/?$',
  );
  table.push({ method, pattern: clean, file, rx });
};

const table = [];
for (const [parent, prefix, child] of mounts) {
  const file = routerFile.get(child);
  if (!file) continue;
  const full = resolvePrefix(parent, prefix);
  const src = read(file).replace(/\s+/g, ' ');
  for (const r of src.matchAll(/router\.(get|post|put|patch|delete|all)\(\s*(?:'([^']+)'|`([^`]+)`)/g)) {
    const method = (r[1] ?? 'GET').toUpperCase();
    const sub = (r[2] ?? r[3] ?? '').replace(/\\\//g, '/');
    const methods = method === 'ALL' ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] : [method];
    for (const m of methods) addRoute(m, (full + sub).replace(/\/+/g, '/').replace(/\/$/, '') || '/', path.basename(file));
  }
}

/* app-level + api-level routes declared inline in server/app.js (health, meta, manifest…) */
for (const m of appSrc.matchAll(/\bapp\.(get|post|put|delete)\(\s*'([^']+)'/g)) addRoute(m[1].toUpperCase(), m[2], 'app.js');
for (const m of appSrc.matchAll(/\bapi\.(get|post|put|delete)\(\s*'([^']+)'/g)) addRoute(m[1].toUpperCase(), '/api' + m[2], 'app.js');

/* -------------------------------------------------------------- client */
const clientDir = 'public/js';
const calls = [];
for (const file of fs.readdirSync(path.join(ROOT, clientDir))) {
  if (!file.endsWith('.js')) continue;
  const src = read(path.join(clientDir, file));
  for (const m of src.matchAll(/api\.(get|post|put|patch|del|upload|download)\(\s*(`[^`]*`|'[^']*')/g)) {
    const name = m[1];
    const url = flatten(m[2].slice(1, -1));
    const method = name === 'del' ? 'DELETE' : name === 'upload' ? 'POST' : name === 'download' ? 'GET' : name.toUpperCase();
    calls.push({ file, method, url, api: `api.${name}` });
  }
  for (const m of src.matchAll(/(?:downloadWith|fetch)\(\s*(`[^`]*`|'[^']*')/g)) {
    const url = flatten(m[1].slice(1, -1));
    if (url.startsWith('/api/')) calls.push({ file, method: 'GET', url, api: 'download/fetch' });
  }
}

/* ----------------------------------------------------------- cross-check */
const find = (method, url) => {
  const exact = table.find((r) => r.method === method && r.rx.test(url));
  if (exact) return exact;
  return table.find((r) => r.rx.test(url)) ?? null;
};

const problems = [];
const seen = new Set();
for (const c of calls) {
  if (!c.url.startsWith('/api/')) continue;
  const key = `${c.method} ${c.url}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const hit = find(c.method, c.url);
  if (!hit) problems.push(`${c.file}: ${c.method} ${c.url} -> no route at all`);
  else if (hit.method !== c.method) problems.push(`${c.file}: ${c.method} ${c.url} -> only ${hit.method} ${hit.pattern} exists (${hit.file})`);
}

console.log(`${table.length} server endpoints, ${seen.size} distinct frontend calls`);
if (problems.length) {
  console.log(`\nPROBLEMS (${problems.length}):`);
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
console.log('every frontend API call resolves to a real endpoint ✓');
