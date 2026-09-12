# Sistemi Purepower — filter tooling & warehouse register

A production web application for an automotive **filter manufacturer** to manage every piece of
**physical tooling** — rubber-forming housings, gasket housings, letter / number / logo inserts,
cutting tools, molds, fixtures, jigs and templates — linked to the filter models that need them and
tied to **exact warehouse locations**.

The one question it exists to answer, in under five seconds, on a phone standing in the tool room:

> **“We are making filter X — which tools does it need, what do they look like, are they here,
> what condition are they in, which shelf, and can production start?”**

No menus to hunt through, no ERP feel: **scan → see the shelf → go get it**.

---

## Stack

| Layer | Choice |
| --- | --- |
| Runtime | Node.js 20+ / 22, ES modules, zero build step |
| API | Express 4, REST + JSON, session cookie auth, CSRF, RBAC, rate limiting |
| Database | MySQL / MariaDB (mysql2, prepared statements, transactions) — plus a **zero-config embedded MariaDB** for development and demos |
| Frontend | Vanilla HTML5 + CSS3 + ES modules. No framework, no bundler, no transpile |
| Mobile | Mobile-first CSS, installable PWA, phone-camera QR/barcode scanning |
| Files | Multer uploads (photos, CAD, PDFs) with type/extension validation + MIME sniffing |
| Printing | Server-rendered label sheets (QR + Code 128), PDF reports (pdfkit), Excel (exceljs) |

```bash
npm install
npm run db:reset      # migrations + core seed + demo dataset, embedded database (no MySQL needed)
npm start             # http://localhost:3000
```

Sign in with any demo account (change these immediately anywhere real):

| role | username | password |
| --- | --- | --- |
| administrator | `admin` | `Admin#2026` |
| engineering | `engineering` | `Engineer#2026` |
| production planning | `production` | `Production#2026` |
| warehouse / tool room | `warehouse` | `Warehouse#2026` |
| quality control | `quality` | `Quality#2026` |
| sales | `sales` | `Sales#2026` |

For a real deployment set `MYSQL_HOST` (see [.env.example](.env.example)) and run
`npm run db:migrate`; `npm run db:seed` writes the demo dataset, `npm run setup` does both.

---

## What is in the box

**Filters.** Types, sizes in mm (shown as mm / cm / inches by preference), unlimited OEM +
aftermarket cross-references, materials, packaging (box/carton/pallet quantities), vehicle
applications as `Manufacturer → Model → Generation → Years → Engine → Engine code → Fuel → Power`,
tooling requirements per filter type, revisions, drawings and photos.

**Tooling register.** Unique IDs (`PP-H-00452-A` style, prefix configurable), 13 built-in categories
plus your own, per-item dimensions with **custom fields per category**, multiple photos with a primary
image, CAD / PDF attachments, cycle counters against a maximum, condition rating, shelf, serial
number, material, notes, soft archive (never a silent delete), **revisions that never overwrite the
previous record**, tooling sets with an automatically computed COMPLETE / INCOMPLETE state, and
many-to-many filter ↔ tooling links with an exactness level.

**The overview screen** (`#/filters/:ref`) — the most important one: filter facts, dimensions,
cross-references, vehicles it fits, **every required tool with photo, status, shelf and a
take / return / damage action right there**, packaging, stock, sets, the photos and documents, and a
production readiness verdict with the exact blocking reason. Print it as a shop-floor sheet.

**Warehouse.** `Warehouse → Row → Rack → Shelf → Box` with codes like `TR-R02-RK05-S03-B07`, a
visual storage map with per-shelf fill indicators, layout auto-generation, occupancy tracking,
"what is on this shelf", and smart **location suggestions** (nearest free place that fits the size
and the category).

**Movements.** TAKE with a production order, RETURN with a destination scan, MOVE, RESERVE,
RELEASE, DAMAGE, MISSING, INVENTORY_CHECK — every one an append-only history row with user,
timestamp, from/to location, quantity and reason. Mis-scan? Undo writes a correction row; nothing
is deleted.

**Production.** Orders with `READY ✅` / ` PRODUCTION BLOCKED` + the reason, computed live from
the register (status, condition, cycles, reservations, maintenance, missing shelf). Take/return the
tools for an order in one tap, batches, automatic finished-goods receipt, board view.

**Maintenance & quality.** Interval per tool type, due / overdue / cycle-limit alerts, jobs with
before/after photos, condition and damage reports that quarantine the tool and open a repair request
automatically, duplicate detection with a similarity review queue, and the
**"DO WE ALREADY HAVE THIS TOOL?"** check to run before anybody manufactures anything new.

**Everyday tools.** One global search (filter, OEM number, cross-ref, tooling ID, vehicle,
dimension, shelf code, QR/barcode payload, order number, person), scan screen, big four buttons on
the phone (SEARCH / SCAN / INVENTORY / TOOLING / LOCATIONS), inventory with stock levels and
split counts, tooling requests with an approval flow, tool + shelf label printing, dashboards with
charts and 9+ alert types, 8 reports (PDF / Excel / CSV), Excel import with per-row validation,
and an immutable audit log with old and new values.

---

## Architecture

```
server/
  app.js              express wiring: security headers, rate limits, auth, routers, SPA + vendor assets
  config.js           every knob, .env loader, embedded-vs-MySQL switch
  db/
    index.js          driver switch + query helpers (db.all/one/value/run/tx), pid lockfile for embedded
    migrate.js        checksummed, idempotent migration runner
    migrations/       001_auth … 009_tooling_diameter (normalised schema, FKs, indexes)
    cli.js            npm run db:migrate | db:seed | db:reset | db:perf
  lib/                validate.js (schema validation), errors.js, logger.js, csv.js, files.js
  middleware/         securityHeaders (CSP etc), authenticate (session + CSRF), requirePermission, rateLimiter
  routes/             17 resource routers, thin: parse + validate + delegate
  services/           the domain: tooling, filters, locations, movement, availability, maintenance,
                      notifications, reports (+ import), export, labels, storage, audit, backup, auth
  seeds/              catalog.js (types, statuses, permissions, settings), core.js, demo.js, perf.js
public/
  index.html          app shell (no inline scripts — the CSP is 'self' only)
  css/app.css         mobile-first design system, dark mode, print rules
  js/
    api.js            fetch wrapper, CSRF, ApiError, /api/meta cache, unit formatting
    ui.js             DOM helpers: elements, forms, tables, modals, toasts, photos, charts
    store.js          session state, navigation model, RBAC gate, shared workflows (move, damage, pickers)
    scan.js           camera + photo decoding (jsQR + ZXing), resolveScan for every payload format
    app.js            hash router, shell, dashboard / search / scan / login
    views-catalog.js  filters, the tooling overview, tooling register, tool detail, compare
    views-warehouse.js inventory + stock counts, storage map / hierarchy tree, movement history
    views-ops.js      maintenance + damage, tooling requests, production orders + order detail
    views-admin.js    reports, import/export, labels, alerts, audit log, account, administration
tests/run.js          end-to-end API suite against a throwaway embedded database
```

Design rules the code follows: **routes stay thin** (validation + permission + call), all SQL is
parameterised, every mutation goes through a service that writes an audit row inside the same
transaction, derived state (availability, set completeness, occupancy, open damage counters, cycle
warnings) is **recomputed, never trusted from the client**, and the frontend has no build step so the
files in `public/` are exactly what the browser runs.

## Database

Normalised MySQL/MariaDB schema in `server/db/migrations/` — roughly 40 tables: catalogue
(`filter_types`, `brands`, `tooling_types`, `label_templates`, `custom_dimension_fields`), filters
(`filters`, `filter_dimensions`, `filter_cross_references`, `filter_materials`, `filter_packaging`,
`filter_images/documents`, `filter_tooling_requirements`), tooling (`tooling_items`,
`tooling_dimensions`, `tooling_images`, `tooling_documents`, `tooling_compatibility`,
`tooling_sets` + members, `tooling_revisions`, `duplicate_checks`), warehouse (`warehouses`,
`warehouse_rows/racks/shelves/boxes`, `tooling_locations`, `tooling_movements`,
`tooling_reservations`), production (`production_orders`, `production_order_tools`,
`production_batches`, `production_history`, `tooling_usage_history`), quality
(`tooling_maintenance`, `tooling_damage_reports`), requests (`tooling_requests`), inventory
(`inventory_items`, `inventory`, `inventory_transactions`, `inventory_counts` + lines), and the
platform tables (`users`, `roles`, `permissions`, `role_permissions`, `app_sessions`, `audit_logs`,
`app_settings`, `notifications`, `database_backups`, `ai_feature_requests`).

Indexes cover the hot paths: search prefixes, `tooling_items(status, tooling_type_id)`,
`tooling_movements(tooling_item_id, created_at)`, `tooling_locations(full_code)`, dimension ranges,
plus `FULLTEXT` on the description columns used by global search. `npm run db:perf` generates a
large synthetic set to verify that claim (10k filters / 100k+ movements scale linearly on the demo
box).

## Codes and QR payloads

Every tool, shelf, filter and order can be scanned. Payloads are short and self-describing so a
generic scanner still lands somewhere sensible:

| payload | means |
| --- | --- |
| `SP:T:<tooling_id>` | a tool |
| `SP:L:<full_code>` | a shelf / box location |
| `SP:F:<internal_number>` | a filter |
| `SP:P:<po_number>` | a production order |
| `<base_url>/t/<code>` | pretty URL form, also accepted |
| anything else | free text: resolved as tooling → location → filter → order, in that order |

Barcodes are Code 128 of the bare code. `/api/labels/qr?kind=tooling&code=…&format=png&width=…` and
`/api/labels/barcode?code=…` render the graphics; `POST /api/labels/scan` resolves one.

## Security

bcrypt password hashing, HTTP-only `SameSite=Lax` session cookies with signed tokens and a
server-side session table (revocable, expiring, visible in the account screen), a per-login CSRF
token checked on every mutating request plus an Origin check, role-based permissions enforced in the
API (138 codes; the UI only hides what the server already refuses), strict input validation on every
route, parameterised SQL everywhere, output escaped by construction (the frontend builds DOM nodes,
never HTML strings), `CSP script-src 'self'` + `X-Content-Type-Options` + `Referrer-Policy` +
`Permissions-Policy: camera=(self)`, upload type/extension/MIME sniffing with size caps, rate limits
for API / writes / logins, audit log that is append-only, and no secrets in the repo.
Every role also holds a `*.read` wildcard for the operational data, but it deliberately does not open
the administration plane: `users.read`, `roles.read`, `settings.read`, `backups.read`, `environment.read`
and `audit.read` must be granted explicitly (`server/lib/permissions.js`), and the client hides those
screens with the same rule.
`DEMO_PASSWORD` and `SQL_DEBUG` exist for development and are documented as such.

## Backup

`#/admin?tab=backups` shows the last successful run, the age, how many are kept and the schedule you
intend to run; `POST /api/admin/backups` creates one (mysqldump for MySQL, a consistent snapshot for
the embedded engine), files are downloadable and deletable from the same screen, and the retention
count is a setting. Point a cron or systemd timer at that endpoint in production.

## Tests

```bash
npm test              # route audit + the full API suite (real app, ephemeral port, throwaway database)
npm run test:api -- --keep   # the suite only, keeping its temporary database for inspection
npm run test:routes   # only checks that every /api/ call in public/js exists on the server
npm run test:api      # only the end-to-end API suite
```

The suite covers auth/CSRF/RBAC, filter and tooling CRUD with validation errors, dimensions and
unit conversion, cross-references, vehicle applications, the tooling overview and availability gate,
movements (take / return / undo, reservation conflicts), maintenance completion + damage → repair
chain, duplicate detection, the "do we already have this tool" check, stock counts, labels + QR
resolution, report generation (PDF/Excel/CSV byte-level checks), import validation, audit
immutability, the SPA shell and a pagination/latency budget - 56 checks, all of them against real
SQL and real HTTP responses. `tests/route-audit.js` additionally parses `server/app.js` + every
`server/routes/*.js` file and refuses to pass while any URL called from `public/js` has no endpoint,
so no button or form can quietly point at nothing.

## Troubleshooting

* **"another process is using the embedded database"** — only one process may own
  `.data/mariadb`. Stop the server before running `npm run db:reset` or a second node script.
* **embedded engine will not start after a crash** — `EMBEDDED_REPAIR=1 npm run db:migrate` once, or
  `rm -rf .data/mariadb && npm run db:reset` to reseed the demo data.
* **camera does not open** — browsers only allow it over https or `localhost`; photo decoding and
  typing the code always work.
* **labels print blank / mis-scaled** — print at 100 % with no browser margins; the sheet is
  generated for the template's physical size.
* **500 on the first request after a redeploy** — the migrations run at boot; check `npm run
  db:migrate` output and `LOG_LEVEL=debug`.

## Deliberate scope notes

* The embedded MariaDB driver (`lite4mariadb`) exists so the app is runnable and demo-able with zero
  setup; production is expected to use `MYSQL_HOST`. This is why `db:reset` is fast and safe to repeat.
* AI features are *designed for*, not required: photo-similarity and OCR hooks are stored as
  `ai_feature_requests` rows and duplicate detection already runs on geometry, so a model can be
  attached without a schema change.
* The frontend has no build step on purpose: a warehouse tablet should be able to run the app from a
  git checkout.
