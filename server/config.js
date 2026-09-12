/**
 * Central configuration.
 * Everything can be overridden with environment variables so the same code runs
 * against a production MySQL server or the embedded (dev/demo) database engine.
 */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '..');

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}


/**
 * Zero-dependency .env loader: reads KEY=VALUE lines from the file named by
 * ENV_FILE (default: .env in the project root) without overriding real
 * environment variables, so containers/CI keep priority over the local file.
 */
function loadDotEnv() {
  const file = process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.join(ROOT_DIR, '.env');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { file, loaded: false };
  }
  let applied = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);
    if (value) {
      process.env[key] = value;
      applied += 1;
    }
  }
  return { file, loaded: true, applied };
}

const dotEnv = loadDotEnv();

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT_DIR, '.data');

/**
 * DB_MODE:
 *   - "mysql"    -> real MySQL / MariaDB server through mysql2 (recommended for production)
 *   - "embedded" -> in-process MariaDB (WASM build, package: lite4mariadb). Used when no
 *                   MySQL server is reachable so the app is runnable out of the box.
 * If MYSQL_HOST is provided, DB_MODE defaults to "mysql".
 */
let dbMode = (process.env.DB_MODE || '').toLowerCase();
if (!dbMode) dbMode = process.env.MYSQL_HOST ? 'mysql' : 'embedded';

/** Secret used to sign session cookies. Generated + persisted on first boot in dev. */
function loadSecret() {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  const file = path.join(DATA_DIR, 'app-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(file, secret, { mode: 0o600 });
    } catch {
      /* in-memory only: sessions will not survive a restart */
    }
    return secret;
  }
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: envInt('PORT', 3000),
  host: process.env.HOST || '0.0.0.0',
  publicUrl: process.env.PUBLIC_URL || '',
  db: {
    mode: dbMode,
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: envInt('MYSQL_PORT', 3306),
    user: process.env.MYSQL_USER || 'sistemi',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'sistemi_tooling',
    connectionLimit: envInt('MYSQL_POOL_SIZE', 10),
    embeddedDir: process.env.EMBEDDED_DB_DIR || path.join(DATA_DIR, 'mariadb'),
  },
  dataDir: DATA_DIR,
  uploadDir: path.join(DATA_DIR, 'uploads'),
  backupDir: path.join(DATA_DIR, 'backups'),
  exportDir: path.join(DATA_DIR, 'exports'),
  secret: loadSecret(),
  session: {
    cookieName: 'sp_session',
    csrfCookieName: 'sp_csrf',
    csrfHeaderName: 'x-csrf-token',
    ttlMs: envInt('SESSION_TTL_HOURS', 16) * 3600 * 1000,
    secureCookies: process.env.SECURE_COOKIES === '1' || (process.env.NODE_ENV === 'production' && process.env.SECURE_COOKIES !== '0'),
  },
  uploads: {
    maxImageBytes: envInt('MAX_IMAGE_BYTES', 8 * 1024 * 1024),
    maxDocBytes: envInt('MAX_DOC_BYTES', 64 * 1024 * 1024),
    imageTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    docTypes: [
      'application/pdf',
      'image/svg+xml',
      'application/step',
      'application/x-step',
      'model/step',
      'model/stl',
      'application/sla',
      'model/vnd.flatpak',
      'application/octet-stream',
      'image/vnd.dxf',
      'application/dxf',
      'text/plain',
      'application/zip',
      'application/x-zip-compressed',
      'application/vnd.solidworks',
    ],
    imageExt: ['.jpg', '.jpeg', '.png', '.webp', '.gif'],
    docExt: ['.pdf', '.step', '.stp', '.stl', '.sldprt', '.sldasm', '.dxf', '.dwg', '.zip', '.txt', '.csv', '.svg'],
  },
  rateLimit: {
    apiWindowMs: 60 * 1000,
    apiMax: envInt('RATE_LIMIT_API_MAX', 600),
    loginWindowMs: 15 * 60 * 1000,
    loginMax: envInt('RATE_LIMIT_LOGIN_MAX', 20),
    writeWindowMs: 60 * 1000,
    writeMax: envInt('RATE_LIMIT_WRITE_MAX', 120),
  },
  pagination: { default: 25, max: 200 },
  envFile: dotEnv,
  app: {
    name: 'Sistemi Purepower',
    module: 'Filter Tooling & Warehouse',
    demoPrefix: 'PP',
  },
};

export const isEmbedded = () => config.db.mode !== 'mysql';

for (const dir of [config.dataDir, config.uploadDir, config.backupDir, config.exportDir]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore: created lazily */
  }
}

export default config;
