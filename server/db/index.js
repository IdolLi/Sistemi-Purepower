/**
 * Database layer.
 *
 * Two interchangeable drivers behind one tiny API so the exact same SQL runs on:
 *   1. a real MySQL / MariaDB server (mysql2 pool)  -> production
 *   2. an embedded MariaDB engine (lite4mariadb)   -> zero-config dev / demo
 *
 * API (identical on plain calls and inside transactions):
 *   all(sql, params)      -> rows[]
 *   one(sql, params)      -> first row or null
 *   value(sql, params)    -> scalar of first column of first row
 *   run(sql, params)      -> { affectedRows, insertId }
 *   tx(async (t) => ...)  -> BEGIN/COMMIT/ROLLBACK wrapper
 *   execScript(sql)       -> multi statement script (migrations)
 */
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import config from '../config.js';
import logger from '../lib/logger.js';

/** Escape an identifier (table/column) that comes from code, never from user input. */
export function id(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${name}`);
  }
  return name
    .split('.')
    .map((part) => `\`${part}\``)
    .join('.');
}

/** "a, b.*" -> "`a`, `b`.*" — only used with code-controlled column lists. */
export function cols(list) {
  return list
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) =>
      c.includes('.')
        ? c
            .split('.')
            .map((p) => (p === '*' ? '*' : `\`${p}\``))
            .join('.')
        : /\*/.test(c)
          ? c
          : `\`${c}\``,
    )
    .join(', ');
}

/** Split a SQL script on ; (migrations contain no strings with semicolons). */
export function splitStatements(script) {
  return script
    .split(/\r?\n/)
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeError(err) {
  const msg = String(err?.message || err || '');
  const wrapped = new Error(msg);
  if (/duplicate entry/i.test(msg)) wrapped.code = 'ER_DUP_ENTRY';
  else if (/foreign key constraint/i.test(msg)) {
    wrapped.code = /child row|foreign key constraint fails/i.test(msg) ? 'ER_NO_REFERENCED_ROW_2' : 'ER_ROW_IS_REFERENCED_2';
  } else if (/check constraint/i.test(msg)) wrapped.code = 'ER_CHECK_CONSTRAINT_VIOLATED';
  if (err?.stack && process.env.SQL_DEBUG) wrapped.stack = err.stack;
  return wrapped;
}

class MysqlDriver {
  name = 'mysql';

  async init() {
    const mysql = await import('mysql2/promise');
    this.mysql = mysql.default ?? mysql;
    this.pool = this.mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      waitForConnections: true,
      connectionLimit: config.db.connectionLimit,
      charset: 'utf8mb4_unicode_ci',
      dateStrings: true,
      supportBigNumbers: true,
      multipleStatements: false,
    });
    await this.pool.query('SELECT 1');
    logger.info(`db: connected to MySQL ${config.db.host}:${config.db.port}/${config.db.database}`);
  }

  async close() {
    if (this.pool) await this.pool.end();
  }

  async statement(conn, sql, params, { raw = false, multi = false } = {}) {
    const prepared = !raw && params.length > 0 && !/^\s*(SHOW|SET|USE|DESCRIBE|EXPLAIN|CALL)\b/i.test(sql);
    let result;
    if (multi) {
      conn.config.multipleStatements = true;
      try {
        result = await conn.query(sql);
      } finally {
        conn.config.multipleStatements = false;
      }
    } else {
      result = prepared ? await conn.execute(sql, params) : await conn.query(sql, params);
    }
    const out = Array.isArray(result) ? result[0] : result;
    if (Array.isArray(out)) return { rows: out, affectedRows: out.length, insertId: null };
    return { rows: [], affectedRows: out?.affectedRows ?? 0, insertId: out?.insertId ?? null };
  }

  makeExecutor(conn) {
    const call = (method, sql, params = [], opts = {}) => this.statement(conn, sql, params, opts);
    return {
      all: async (sql, params) => (await call('all', sql, params)).rows,
      one: async (sql, params) => (await call('one', sql, params)).rows[0] ?? null,
      value: async (sql, params) => {
        const r = await call('value', sql, params);
        const row = r.rows[0];
        return row ? row[Object.keys(row)[0]] : null;
      },
      run: (sql, params) => call('run', sql, params),
      raw: (sql) => call('raw', sql, [], { raw: true }),
      script: (sql) => call('script', sql, [], { raw: true, multi: true }),
    };
  }

  async executor() {
    return this.makeExecutor(this.pool);
  }

  async transaction(fn) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(this.makeExecutor(conn));
      await conn.commit();
      return result;
    } catch (err) {
      try {
        await conn.rollback();
      } catch {
        /* ignore */
      }
      throw err;
    } finally {
      conn.release();
    }
  }

  async execScript(sql) {
    const conn = await this.pool.getConnection();
    try {
      for (const stmt of splitStatements(sql)) await conn.query(stmt);
    } finally {
      conn.release();
    }
  }

  async snapshot() {
    return null; // production backups use mysqldump (see services/backup.js)
  }
}

class EmbeddedDriver {
  name = 'embedded';
  queue = Promise.resolve();
  /** Set to this driver while a transaction is open, so its statements skip the queue. */
  static txStore = new AsyncLocalStorage();

  async init() {
    const { Lite4MariaDB } = await import('lite4mariadb');
    fs.mkdirSync(config.db.embeddedDir, { recursive: true });
    this.lockFile = path.join(config.db.embeddedDir, '.sp-instance.lock');
    this.acquireLock();
    try {
      this.db = await Lite4MariaDB.create({ dataDir: config.db.embeddedDir });
      const version = this.db.query('SELECT VERSION() v')[0]?.v ?? 'embedded';
      logger.info(`db: embedded ${version} (datadir ${config.db.embeddedDir})`);
      if (process.env.EMBEDDED_REPAIR === '1') await this.repairAll();
    } catch (err) {
      this.releaseLock();
      throw err;
    }
  }

  /**
   * The embedded engine is a single-process database: two Node instances sharing the
   * data directory will corrupt InnoDB. Refuse to start while another one is alive.
   */
  acquireLock() {
    if (process.env.EMBEDDED_ALLOW_MULTI === '1') return;
    let current = null;
    try {
      current = fs.readFileSync(this.lockFile, 'utf8');
    } catch {
      /* free */
    }
    if (current) {
      const pid = Number(String(current).split('\n')[0]);
      let alive = false;
      if (pid) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
      }
      if (alive && pid !== process.pid) {
        throw new Error(
          `The embedded database is already open by process ${pid}. Only one instance can use ${config.db.embeddedDir} at a time.\n` +
          `Stop that process first (or point EMBEDDED_DB_DIR at another directory, or set MYSQL_HOST to use a real MySQL server).`,
        );
      }
      logger.warn('removing a stale database lock file left by a previous run (pid %s)', pid || '?');
    }
    fs.writeFileSync(this.lockFile, `${process.pid}\n${new Date().toISOString()}\n`, { mode: 0o600 });
    this.lockHeld = true;
  }

  releaseLock() {
    if (!this.lockHeld) return;
    try {
      fs.rmSync(this.lockFile, { force: true });
    } catch {
      /* ignore */
    }
    this.lockHeld = false;
  }

  /** EMBEDDED_REPAIR=1 npm run db:migrate - fixes indexes after an unclean kill. */
  async repairAll() {
    const tables = this.db.query("SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'");
    for (const { t } of tables.rows ?? tables) {
      try {
        this.db.exec(`REPAIR TABLE \`${t}\``);
        this.db.exec(`OPTIMIZE TABLE \`${t}\``);
      } catch {
        /* views/foreign tables - ignore */
      }
    }
    logger.info('repair + optimize completed for %d table(s)', tables.length);
  }

  async close() {
    if (this.db) await this.db.close();
    this.releaseLock();
  }

  /** Serialise every statement: one in-process engine, no server-side concurrency. */
  enqueue(task) {
    // Inside a transaction this request already owns the engine; running the statement
    // directly is what makes BEGIN/.../COMMIT (and helpers using the global `db`) work.
    if (EmbeddedDriver.txStore.getStore() === this) return Promise.resolve().then(task);
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  statement(sql, params = [], { raw = false, multi = false } = {}) {
    const wantsInsertId = !multi && /^\s*(INSERT|REPLACE)\b/i.test(sql);
    return this.enqueue(() => {
      try {
        const out = multi ? this.db.execMulti(sql) : this.db.exec(sql, params);
        const results = multi ? out : [out];
        const rows = results.flatMap((r) => r.rows ?? []);
        const affectedRows = results.reduce((sum, r) => sum + (r.affected ?? 0), 0);
        let insertId = null;
        if (wantsInsertId) {
          // same tick, same engine -> LAST_INSERT_ID() is still ours
          insertId = this.db.exec('SELECT LAST_INSERT_ID() AS id', []).rows[0]?.id ?? null;
        }
        return { rows, affectedRows, insertId };
      } catch (err) {
        const wrapped = normalizeError(err);
        if (process.env.SQL_DEBUG) wrapped.message += `\nSQL: ${sql.slice(0, 600)}\nPARAMS: ${JSON.stringify(params).slice(0, 400)}`;
        throw wrapped;
      }
    });
  }

  makeExecutor() {
    return {
      all: async (sql, params) => (await this.statement(sql, params)).rows,
      one: async (sql, params) => (await this.statement(sql, params)).rows[0] ?? null,
      value: async (sql, params) => {
        const { rows } = await this.statement(sql, params);
        const row = rows[0];
        return row ? row[Object.keys(row)[0]] : null;
      },
      run: (sql, params) => this.statement(sql, params),
      raw: (sql) => this.statement(sql, [], { raw: true }),
      script: (sql) => this.statement(sql, [], { raw: true, multi: true }),
    };
  }

  async executor() {
    return this.makeExecutor();
  }

  /**
   * The queue is held for the whole transaction so no other request can interleave, while
   * statements belonging to the transaction run straight away on the held engine.
   */
  async transaction(fn) {
    const store = EmbeddedDriver.txStore;
    if (store.getStore() === this) return fn(this.makeExecutor()); // nested -> joins the open transaction

    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const before = this.queue;
    this.queue = before.then(() => gate);
    let done = false;
    try {
      await before.catch(() => {}); // let anything already queued finish first
      return await store.run(this, async () => {
        try {
          await this.statement('BEGIN');
          const result = await fn(this.makeExecutor());
          await this.statement('COMMIT');
          return result;
        } catch (err) {
          await this.statement('ROLLBACK').catch(() => {});
          throw err;
        }
      });
    } finally {
      if (!done) {
        done = true;
        release();
      }
    }
  }

  async execScript(sql) {
    const statements = splitStatements(sql);
    return this.enqueue(() => {
      for (const stmt of statements) {
        try {
          this.db.exec(stmt, []);
        } catch (err) {
          const wrapped = normalizeError(err);
          wrapped.message = `Migration statement failed: ${wrapped.message}\n---\n${stmt.slice(0, 400)}`;
          throw wrapped;
        }
      }
    });
  }

  async snapshot() {
    return this.enqueue(() => this.db.dumpDataDir({ compress: true }));
  }
}

let driver = null;

export async function initDb() {
  if (driver) return driver;
  if (config.db.mode === 'mysql') {
    driver = new MysqlDriver();
  } else {
    driver = new EmbeddedDriver();
  }
  try {
    await driver.init();
  } catch (err) {
    if (config.db.mode === 'mysql') {
      logger.error(`Could not connect to MySQL (${err.message}). Set MYSQL_* env vars or run with DB_MODE=embedded.`);
    }
    driver = null;
    throw err;
  }
  return driver;
}

export function getDriver() {
  if (!driver) throw new Error('Database not initialised - call initDb() first');
  return driver;
}

export async function closeDb() {
  if (driver) {
    await driver.close();
    driver = null;
  }
}

const forward = (method) => async (sql, params) => {
  const exec = await getDriver().executor();
  return exec[method](sql, params ?? []);
};

/** Query helpers bound to a fresh executor on each call (pool-safe). */
export const db = {
  all: forward('all'),
  one: forward('one'),
  value: forward('value'),
  run: forward('run'),
  raw: forward('raw'),
  tx: (fn) => getDriver().transaction(fn),
  execScript: (sql) => getDriver().execScript(sql),
  snapshot: () => getDriver().snapshot(),
  get embedded() {
    return getDriver().name === 'embedded';
  },
  get rawDriver() {
    return getDriver();
  },
};

export default db;
