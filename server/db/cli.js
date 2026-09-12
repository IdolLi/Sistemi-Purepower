#!/usr/bin/env node
/**
 * Database CLI: migrate / seed / reset / perf / status.
 *   node server/db/cli.js migrate
 *   node server/db/cli.js seed            (demo data, ~12h of typing saved)
 *   node server/db/cli.js reset --seed    (drop everything, migrate, seed)
 *   node server/db/cli.js perf            (large dataset for scale testing)
 *   node server/db/cli.js status
 */
import logger from '../lib/logger.js';
import db, { initDb, closeDb } from './index.js';
import { migrate, resetDatabase, listMigrationFiles, appliedMigrations } from './migrate.js';
import { seedCore } from '../seeds/core.js';
import { seedDemo, refreshOccupancy, refreshSetStatuses } from '../seeds/demo.js';

const args = process.argv.slice(2);
const cmd = (args[0] || 'status').toLowerCase();
const flag = (name) => args.includes(`--${name}`);

async function needsDemoData() {
  const exec = await db.rawDriver.executor();
  const c = await exec.value('SELECT COUNT(*) c FROM filters');
  return Number(c ?? 0) === 0;
}

const commands = {
  async migrate() {
    await migrate();
  },
  async seed() {
    const core = await seedCore({ passwordOverride: process.env.DEMO_PASSWORD || null });
    logger.info('core seed complete (%d roles, %d users)', core.roleIds.size, core.userIds.size);
    if (!flag('core-only')) {
      const has = await (await db.rawDriver.executor()).value('SELECT COUNT(*) c FROM tooling_items');
      if (Number(has) > 0 && !flag('force')) {
        logger.warn('tooling data already present - use "npm run db:reset" for a clean demo dataset, or --force to append');
      } else {
        const stats = await seedDemo({});
        logger.info('demo data ready', stats);
      }
    }
  },
  async reset() {
    logger.warn('dropping all tables in the target database');
    const { dropped } = await resetDatabase();
    logger.info('dropped %d tables', dropped);
    await migrate();
    const core = await seedCore({});
    logger.info('core seed complete (%d roles, %d users)', core.roleIds.size, core.userIds.size);
    const stats = await seedDemo({});
    logger.info('demo data ready', stats);
  },
  async perf() {
    await resetDatabase();
    await migrate();
    await seedCore({});
    const stats = await seedDemo({ perf: true, extraFilters: 40 });
    logger.info('perf dataset ready (this is a large scale test set)', stats);
  },
  async refresh() {
    await refreshSetStatuses();
    await refreshOccupancy();
    logger.info('derived state refreshed (tooling set statuses, shelf occupancy)');
  },
  async status() {
    const exec = await db.rawDriver.executor();
    const applied = await appliedMigrations();
    const tables = listMigrationFiles().length;
    const counts = {};
    for (const t of ['filters', 'tooling_items', 'tooling_movements', 'production_orders', 'users', 'tooling_locations']) {
      try {
        counts[t] = await exec.value(`SELECT COUNT(*) c FROM ${t}`);
      } catch {
        counts[t] = 'n/a';
      }
    }
    logger.info('migrations: %d/%d files applied', applied.size, tables);
    logger.info('row counts: %j', counts);
  },
};

const run = async () => {
  const fn = commands[cmd];
  if (!fn) {
    console.error(`Unknown command "${cmd}". Available: ${Object.keys(commands).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  await initDb();
  try {
    await fn();
  } finally {
    await closeDb();
  }
};

run().catch((err) => {
  logger.error('db cli failed:', err);
  process.exitCode = 1;
});

export { needsDemoData };
