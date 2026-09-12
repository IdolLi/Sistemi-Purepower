/**
 * Express application wiring: security headers, rate limits, auth, CSRF, routers,
 * static SPA + vendored scanner libraries. Kept separate from index.js so the test
 * suite can mount the app without binding a port.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import config from './config.js';
import db from './db/index.js';
import logger from './lib/logger.js';
import { asyncRoute, notFound as notFoundError } from './lib/errors.js';
import { securityHeaders, requestContext, rateLimiter, authenticate, csrfGuard, requireAuth, notFoundHandler, errorHandler } from './middleware/index.js';
import {
  CONDITION_RATINGS,
  DAMAGE_TYPES,
  FILTER_DIMENSION_FIELDS,
  TOOLING_DIMENSION_FIELDS,
  TOOLING_STATUSES,
  TOOLING_STATUS,
} from './seeds/catalog.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, '..', 'public');

export const VENDOR = {
  '/vendor/jsqr.js': path.resolve('node_modules/jsqr/dist/jsQR.js'),
  '/vendor/zxing.js': path.resolve('node_modules/@zxing/library/umd/index.min.js'),
};

/** Build the fully wired app (called once at boot and by the tests). */
export async function buildApp() {
  const { app, api } = createApp();
  app.use('/api', api);
  app.get(/^(?!\/api|\/vendor|\/assets).*/, (req, res, next) => {
    const index = path.join(PUBLIC_DIR, 'index.html');
    if (!fs.existsSync(index)) return next(notFoundError('public/index.html is missing'));
    return res.type('html').set('Cache-Control', 'no-cache').sendFile(index);
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', 'strong');
  app.use(securityHeaders);
  app.use(requestContext);

  for (const [route, file] of Object.entries(VENDOR)) {
    if (fs.existsSync(file)) app.get(route, (req, res) => res.type('application/javascript').set('Cache-Control', 'public, max-age=604800').sendFile(file));
    else logger.warn('vendor asset missing: %s (run npm install)', file);
  }
  app.use(
    express.static(PUBLIC_DIR, {
      maxAge: config.env === 'production' ? '1h' : 0,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('sw.js')) res.setHeader('Service-Worker-Allowed', '/');
        if (filePath.endsWith('manifest.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json');
      },
    }),
  );

  const api = express.Router();
  api.use(express.json({ limit: '2mb' }));
  api.use(express.urlencoded({ extended: true, limit: '2mb' }));
  api.use(cookieParser(config.secret));
  api.use(rateLimiter({ windowMs: config.rateLimit.apiWindowMs, max: config.rateLimit.apiMax }));
  api.use(authenticate);
  api.use(csrfGuard);

  api.get(
    '/health',
    asyncRoute(async (req, res) => {
      const t0 = Date.now();
      let dbOk = false;
      let dbError = null;
      try {
        dbOk = Number(await db.value('SELECT 1 v')) === 1;
      } catch (err) {
        dbError = err.message;
      }
      res.json({ status: dbOk ? 'ok' : 'degraded', time: new Date().toISOString(), uptime_seconds: Math.round(process.uptime()), query_ms: Date.now() - t0, database: { mode: config.db.mode, connected: dbOk, ...(dbError ? { error: dbError } : {}) }, version: process.env.npm_package_version ?? '1.0.0' });
    }),
  );

  api.get(
    '/meta',
    asyncRoute(async (req, res) => {
      const publicSettings = await db.all('SELECT setting_key, value, value_type, label, group_name FROM app_settings WHERE is_public = 1 ORDER BY group_name, setting_key').catch(() => []);
      const filterTypes = await db.all('SELECT code, name, icon, dimension_profile FROM filter_types WHERE is_active = 1 ORDER BY sort_order').catch(() => []);
      const toolingTypes = await db.all('SELECT code, name, icon, group_name, id_prefix, requires_cycle_tracking, requires_maintenance FROM tooling_types WHERE is_active = 1 ORDER BY sort_order, name').catch(() => []);
      const brands = await db.all('SELECT code, name FROM brands WHERE is_active = 1 ORDER BY name').catch(() => []);
      res.json({
        app: { name: config.app.name, module: config.app.module },
        tooling_statuses: TOOLING_STATUSES.map((s) => ({ code: s, ...TOOLING_STATUS[s] })),
        condition_ratings: CONDITION_RATINGS,
        damage_types: DAMAGE_TYPES,
        filter_types: filterTypes,
        tooling_types: toolingTypes,
        brands,
        dimension_fields: { tooling: TOOLING_DIMENSION_FIELDS, filter: FILTER_DIMENSION_FIELDS },
        settings: Object.fromEntries(publicSettings.map((s) => [s.setting_key, s.value_type === 'number' ? Number(s.value) : s.value])),
        settings_rows: publicSettings,
        csrf: req.cookies?.[config.session.csrfCookieName] ?? null,
        authenticated: !!req.user,
        user: req.user
          ? { id: req.user.id, username: req.user.username, full_name: req.user.full_name, role: req.user.role_code, role_name: req.user.role_name, permissions: req.user.permissions ?? [], department: req.user.department, must_change_password: !!req.user.must_change_password }
          : null,
      });
    }),
  );

  api.use('/auth', rateLimiter({ windowMs: config.rateLimit.loginWindowMs, max: config.rateLimit.loginMax, keyPrefix: 'login' }), authRouter);

  const writesLimiter = rateLimiter({ windowMs: config.rateLimit.writeWindowMs, max: config.rateLimit.writeMax, keyPrefix: 'write' });
  const protectedApi = express.Router();
  protectedApi.use(requireAuth);
  protectedApi.use((req, res, next) => (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? writesLimiter(req, res, next) : next()));
  protectedApi.use('/filters', filtersRouter);
  protectedApi.use('/tooling', toolingRouter);
  protectedApi.use('/warehouse', warehouseRouter);
  protectedApi.use('/production', productionRouter);
  protectedApi.use('/maintenance', maintenanceRouter);
  protectedApi.use('/inventory', inventoryRouter);
  protectedApi.use('/movements', movementsRouter);
  protectedApi.use('/files', filesRouter);
  protectedApi.use('/labels', labelsRouter);
  protectedApi.use('/search', searchRouter);
  protectedApi.use('/stats', statsRouter);
  protectedApi.use('/', miscRouter); // /audit/* + /identify/*
  protectedApi.use('/reports', reportsRouter);
  protectedApi.use('/export', exportRouter);
  protectedApi.use('/import', importRouter);
  protectedApi.use('/notifications', notificationsRouter);
  protectedApi.use('/admin', adminRouter);
  api.use(protectedApi);

  return { app, api };
}

import authRouter from './routes/auth.js';
import filtersRouter from './routes/filters.js';
import toolingRouter from './routes/tooling.js';
import warehouseRouter from './routes/warehouse.js';
import productionRouter from './routes/production.js';
import maintenanceRouter from './routes/maintenance.js';
import inventoryRouter from './routes/inventory.js';
import movementsRouter from './routes/movements.js';
import filesRouter from './routes/files.js';
import labelsRouter from './routes/labels.js';
import searchRouter from './routes/search.js';
import statsRouter from './routes/stats.js';
import miscRouter from './routes/misc.js';
import reportsRouter from './routes/reports.js';
import exportRouter from './routes/export.js';
import importRouter from './routes/import.js';
import notificationsRouter from './routes/notifications.js';
import adminRouter from './routes/admin.js';

export default buildApp;
