#!/usr/bin/env node
/**
 * Boot sequence: open the database, apply pending migrations, write the core seed when
 * the schema is fresh, keep the permission catalogue in sync, then listen.
 * Demo data (`npm run db:reset`) is deliberately NOT written on boot.
 */
import config from './config.js';
import db, { initDb, closeDb } from './db/index.js';
import logger from './lib/logger.js';
import { migrate } from './db/migrate.js';
import { seedCore, syncPermissions } from './seeds/core.js';
import { buildApp } from './app.js';

async function prepareDatabase() {
  await initDb();
  await migrate({ quiet: false });
  const users = Number(await db.value('SELECT COUNT(*) c FROM users').catch(() => 0));
  if (users === 0) {
    logger.info('no users yet - writing the core seed (roles, permissions, catalogues, settings)');
    const core = await seedCore({});
    logger.info('core seed complete (%d roles, %d users)', core.roleIds.size, core.userIds.size);
  }
  const sync = await syncPermissions().catch((err) => {
    logger.warn('permission sync skipped: %s', err.message);
    return null;
  });
  if (sync) logger.info('permissions in sync (%d codes, %d added, %d grants added)', sync.permissions, sync.created, sync.grants_added);
  const tooling = Number(await db.value('SELECT COUNT(*) c FROM tooling_items').catch(() => 0));
  if (tooling === 0) {
    logger.warn('the database has no tooling data yet - run "npm run db:reset" to load the demo dataset');
  }
}

async function main() {
  await prepareDatabase();
  const app = await buildApp();
  const server = app.listen(config.port, config.host, () => {
    logger.info('%s - %s listening on http://%s:%d (database: %s)', config.app.name, config.app.module, config.host, config.port, config.db.mode);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error('port %d is already in use - start with PORT=4000 npm start', config.port);
      process.exit(1);
    }
    logger.error('server error: %s', err.message);
  });

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    logger.info('%s received - closing the server', signal);
    server.close();
    try {
      await closeDb();
    } catch (err) {
      logger.warn('database close failed: %s', err.message);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error('unhandled rejection: %s', reason instanceof Error ? reason.stack : String(reason)));
}

main().catch((err) => {
  logger.error('startup failed: %s', err.stack || err.message);
  process.exit(1);
});
