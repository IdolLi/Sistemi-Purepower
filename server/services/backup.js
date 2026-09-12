/**
 * Backups (spec §55). The embedded engine can snapshot its own data directory; a real
 * MySQL server is dumped with mysqldump (or a generated INSERT dump as a fallback).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import config from '../config.js';
import db from '../db/index.js';
import logger from '../lib/logger.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from './audit.js';

const BACKUP_DIR = config.backupDir;
const SAFE = /^[A-Za-z0-9._-]+$/;

export function backupFiles() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => /(\.sql\.gz|\.tar\.gz|\.dump\.gz)$/.test(f) && SAFE.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { filename: f, size_bytes: st.size, modified_at: st.mtime.toISOString(), path: path.join(BACKUP_DIR, f) };
    })
    .sort((a, b) => (a.modified_at < b.modified_at ? 1 : -1));
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
}

/** MySQL: INSERT dump generated from the live schema (no external binaries required). */
async function dumpMysqlSql(outPath) {
  const exec = await db.rawDriver.executor();
  const tables = (
    await exec.all("SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME")
  ).map((r) => r.t);
  const lines = [
    `-- Sistemi Purepower SQL dump`,
    `-- generated ${new Date().toISOString()} against ${config.db.host}:${config.db.port}/${config.db.database}`,
    `SET FOREIGN_KEY_CHECKS=0;`,
    '',
  ];
  for (const table of tables) {
    const create = await exec.value(`SHOW CREATE TABLE \`${table}\``);
    const ddl = typeof create === 'object' ? Object.values(create)[1] : create;
    lines.push(`DROP TABLE IF EXISTS \`${table}\`;`, `${ddl};`, '');
    let offset = 0;
    const size = 500;
    for (;;) {
      const rows = await exec.all(`SELECT * FROM \`${table}\` LIMIT ${size} OFFSET ${offset}`);
      if (!rows.length) break;
      const cols = Object.keys(rows[0]);
      lines.push(
        `INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(',')}) VALUES`,
        rows
          .map((r) => `(${cols.map((c) => {
            const v = r[c];
            if (v === null || v === undefined) return 'NULL';
            if (v instanceof Date) return `'${v.toISOString().slice(0, 19).replace('T', ' ')}'`;
            if (typeof v === 'number' || typeof v === 'boolean') return String(v);
            if (Buffer.isBuffer(v)) return `0x${v.toString('hex')}`;
            return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
          })})`)
          .join(',\n'),
        ';',
      );
      if (rows.length < size) break;
      offset += size;
    }
    lines.push('');
  }
  lines.push('SET FOREIGN_KEY_CHECKS=1;');
  await fs.promises.writeFile(outPath, zlib.gzipSync(Buffer.from(lines.join('\n'), 'utf8')));
  return { engine: 'mysql-sql-dump', tables: tables.length };
}

async function runMysqldump(outPath, gzPath) {
  const args = ['-h', config.db.host, '-P', String(config.db.port), '-u', config.db.user, '--single-transaction', '--routines', '--events', '--skip-lock-tables', config.db.database];
  if (config.db.password) args.unshift(`--password=${config.db.password}`);
  const gzip = fs.createWriteStream(gzPath);
  const child = spawn('mysqldump', args, { env: { ...process.env, MYSQL_PWD: config.db.password || '' } });
  let stderr = '';
  child.stderr.on('data', (b) => {
    stderr += b.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });
  child.stdout.pipe(gzip);
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  await new Promise((r) => gzip.end(r));
  if (code !== 0) {
    await fs.promises.rm(gzPath, { force: true });
    if (fs.existsSync(outPath)) await fs.promises.rm(outPath, { force: true });
    const err = new Error(`mysqldump exited with ${code}: ${stderr.slice(0, 300) || 'is mysqldump installed on the server?'}`);
    err.details = { stderr: stderr.slice(0, 500) };
    throw err;
  }
  await fs.promises.rm(outPath, { force: true });
  return { engine: 'mysqldump' };
}

export async function createBackup({ ctx = null, kind = 'manual' } = {}) {
  const filename = `backup-${stamp()}-${kind}${db.embedded ? '.tar.gz' : '.sql.gz'}`;
  const filePath = path.join(BACKUP_DIR, filename);
  await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
  const t0 = Date.now();
  let meta = {};
  let status = 'SUCCESS';
  let message = '';
  try {
    if (db.embedded) {
      const snapshot = await db.snapshot();
      if (!snapshot) throw new Error('The embedded engine did not return a snapshot');
      const buffer = Buffer.isBuffer(snapshot) ? snapshot : Buffer.from(snapshot);
      await fs.promises.writeFile(filePath, buffer);
      meta = { engine: 'embedded-snapshot', bytes: buffer.length };
    } else {
      const gzPath = `${filePath}.tmp.gz`;
      try {
        await runMysqldump(filePath, gzPath);
        meta = { engine: 'mysqldump' };
      } catch (err) {
        logger.warn('mysqldump failed (%s) - falling back to an in-process SQL dump', err.message);
        meta = await dumpMysqlSql(gzPath);
        await fs.promises.rename(gzPath, filePath);
        message = `mysqldump was not usable (${err.message.slice(0, 120)}) - dumped with the built-in writer instead`;
      } finally {
        await fs.promises.rm(`${filePath}.tmp.gz`, { force: true }).catch(() => {});
      }
    }
  } catch (err) {
    status = 'FAILED';
    message = err.message;
    await db.run(
      `INSERT INTO database_backups (filename, file_path, size_bytes, kind, status, engine, message, created_by) VALUES (?,?,?,?,?,?,?,?)`,
      [filename, filePath, 0, kind, status, db.embedded ? 'embedded' : 'mysql', message.slice(0, 480), ctx?.user?.id ?? null],
    );
    throw err;
  }
  const st = await fs.promises.stat(filePath);
  await db.run(
    `INSERT INTO database_backups (filename, file_path, size_bytes, kind, status, engine, message, created_by) VALUES (?,?,?,?,?,?,?,?)`,
    [filename, filePath, st.size, kind, status, meta.engine ?? 'unknown', message.slice(0, 480) || `${Math.round(st.size / 1024)} KB in ${Date.now() - t0} ms`, ctx?.user?.id ?? null],
  );
  await pruneBackups(ctx);
  await audit(ctx, { action: 'backup', entityType: 'backup', entityLabel: filename, summary: `Backup created (${(st.size / 1024).toFixed(0)} KB)` });
  return { filename, size_bytes: st.size, duration_ms: Date.now() - t0, engine: meta.engine, message: message || null };
}

async function pruneBackups(ctx) {
  const keep = Number(await db.value("SELECT value FROM app_settings WHERE setting_key = 'backup_keep_count'")) || 10;
  const files = backupFiles();
  const dbRows = await db.all('SELECT * FROM database_backups WHERE status = ? ORDER BY created_at DESC, id DESC', ['SUCCESS']);
  const survivors = dbRows.slice(0, keep);
  const survivorNames = new Set(survivors.map((r) => r.filename));
  for (const row of dbRows.slice(keep)) {
    await db.run('DELETE FROM database_backups WHERE id = ?', [row.id]);
    const p = path.join(BACKUP_DIR, path.basename(row.filename));
    await fs.promises.rm(p, { force: true }).catch(() => {});
  }
  for (const f of files) {
    if (!survivorNames.has(f.filename) && !dbRows.some((r) => r.filename === f.filename)) {
      // orphan file with no record: keep it but note it in the UI listing
      f.orphan = true;
    }
  }
  void ctx;
  return { keep, removed: Math.max(0, dbRows.length - keep) };
}

export async function listBackups() {
  const rows = await db.all(`SELECT b.*, u.full_name AS created_by_name FROM database_backups b LEFT JOIN users u ON u.id = b.created_by ORDER BY b.id DESC LIMIT 60`);
  const last = rows.find((r) => r.status === 'SUCCESS') ?? null;
  const keep = Number(await db.value("SELECT value FROM app_settings WHERE setting_key = 'backup_keep_count'")) || 10;
  const schedule = await db.value("SELECT value FROM app_settings WHERE setting_key = 'backup_schedule'");
  return {
    items: rows.map((r) => {
      const onDisk = fs.existsSync(path.join(BACKUP_DIR, path.basename(r.filename)));
      return { ...r, exists_on_disk: onDisk, size_kb: Math.round(Number(r.size_bytes) / 102.4) / 10, download_url: onDisk ? `/api/admin/backups/${r.id}/download` : null };
    }),
    files: backupFiles().map((f) => ({ filename: f.filename, size_bytes: f.size_bytes, modified_at: f.modified_at, orphan: !rows.some((r) => r.filename === f.filename) })),
    status: {
      engine: db.embedded ? 'embedded-mariadb' : 'mysql',
      last_success_at: last?.created_at ?? null,
      last_filename: last?.filename ?? null,
      age_hours: last ? Math.round((Date.now() - new Date(String(last.created_at).replace(' ', 'T') + 'Z').getTime()) / 3600000) : null,
      count: rows.length,
      total_bytes: rows.reduce((s, r) => s + Number(r.size_bytes ?? 0), 0),
      keep,
      schedule: schedule ?? null,
      scheduled_note: 'Set a cron/systemd timer for the production host, e.g. `curl -X POST -b cookies.txt http://localhost:3000/api/admin/backups` (backup_schedule records the intended cadence).',
    },
  };
}

export async function resolveBackupFile(idOrName) {
  const numeric = Number(idOrName);
  const row = Number.isInteger(numeric) && numeric > 0 ? await db.one('SELECT * FROM database_backups WHERE id = ?', [numeric]) : null;
  const filename = row?.filename ?? String(idOrName);
  if (!SAFE.test(filename)) throw badRequest('Unsafe backup name');
  const filePath = path.join(BACKUP_DIR, path.basename(filename));
  if (!fs.existsSync(filePath)) throw notFound(`Backup file ${filename} is not on disk (it may have been pruned)`);
  return { row, filename, filePath, size: fs.statSync(filePath).size };
}

export async function deleteBackup(id, ctx) {
  const row = await db.one('SELECT * FROM database_backups WHERE id = ?', [Number(id)]);
  if (!row) throw notFound('Backup record not found');
  const filePath = path.join(BACKUP_DIR, path.basename(row.filename));
  await fs.promises.rm(filePath, { force: true });
  await db.run('DELETE FROM database_backups WHERE id = ?', [row.id]);
  await audit(ctx, { action: 'delete', entityType: 'backup', entityId: row.id, entityLabel: row.filename, summary: `Deleted backup ${row.filename}` });
  return { ok: true };
}
