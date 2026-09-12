/**
 * Migration runner: applies server/db/migrations/*.sql in filename order,
 * recording each applied file in `schema_migrations`. Idempotent + transactional
 * (per file, which is enough for DDL on MySQL/MariaDB).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import db from './index.js';
import logger from '../lib/logger.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export function listMigrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

export async function appliedMigrations() {
  await db.execScript(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    filename VARCHAR(255) NOT NULL UNIQUE,
    checksum CHAR(64) NOT NULL,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    duration_ms INT NOT NULL DEFAULT 0
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  const rows = await db.all('SELECT filename, checksum FROM schema_migrations');
  return new Map(rows.map((r) => [r.filename, r.checksum]));
}

export async function migrate({ quiet = false } = {}) {
  const applied = await appliedMigrations();
  const files = listMigrationFiles();
  let count = 0;
  for (const file of files) {
    const full = path.join(MIGRATIONS_DIR, file);
    const sql = fs.readFileSync(full, 'utf8');
    const checksum = hash(sql);
    if (applied.has(file)) {
      if (applied.get(file) !== checksum && !quiet) {
        logger.warn('migration %s changed on disk after being applied (checksum mismatch)', file);
      }
      continue;
    }
    const t0 = Date.now();
    await db.execScript(sql);
    await db.run('INSERT INTO schema_migrations (filename, checksum, duration_ms) VALUES (?,?,?)', [file, checksum, Date.now() - t0]);
    count += 1;
    if (!quiet) logger.info('applied %s (%dms)', file, Date.now() - t0);
  }
  if (!quiet) logger.info(count ? `migrations complete: ${count} applied` : 'migrations complete: already up to date');
  return { applied: count, files: files.length };
}

function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export async function resetDatabase() {
  const exec = await db.rawDriver.executor();
  const rows = await exec.all(
    "SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'",
  );
  const tables = rows.map((r) => r.t);
  if (!tables.length) return { dropped: 0 };
  await exec.run('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of tables) await exec.run(`DROP TABLE IF EXISTS \`${t.replace(/`/g, '')}\``);
  await exec.run('SET FOREIGN_KEY_CHECKS = 1');
  return { dropped: tables.length };
}
