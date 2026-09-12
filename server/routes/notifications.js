/** /api/notifications — alerts for the current user (spec §35). */
import express from 'express';
import db from '../db/index.js';
import { asyncRoute, badRequest } from '../lib/errors.js';
import { validate, bool, idList } from '../lib/validate.js';
import { requirePermission } from '../middleware/index.js';
import { listNotifications, markRead, dismiss, computeAlerts, ALERT_KINDS } from '../services/notifications.js';
import { dueAlerts } from '../services/maintenance.js';

const router = express.Router();

router.get('/', requirePermission('notifications.read'), asyncRoute(async (req, res) => {
  res.json(
    await listNotifications({
      user_id: req.user.id,
      role_code: req.user.role_code,
      kind: req.query.kind ?? null,
      unread_only: req.query.unread === '1',
      limit: Number(req.query.limit || 50),
      q: req.query.q ?? null,
    }),
  );
}));

/** Force a re-evaluation of the derived alerts (the dashboard does this on demand). */
router.post('/refresh', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const out = await computeAlerts();
  await dueAlerts({ days: Number(req.body?.days || 14) });
  res.json(out);
}));

router.post('/read', requirePermission('notifications.read'), asyncRoute(async (req, res) => {
  const data = validate({ ids: [idList, {}], all: [bool, { default: false }] }, req.body ?? {});
  if (!data.all && !data.ids.length) throw badRequest('Provide ids[] or all:true');
  res.json(await markRead(data.all ? null : data.ids, req.ctx, data.all));
}));

router.post('/:id/read', requirePermission('notifications.read'), asyncRoute(async (req, res) => {
  res.json(await markRead([Number(req.params.id)], req.ctx));
}));

router.delete('/:id', requirePermission('notifications.manage'), asyncRoute(async (req, res) => {
  res.json(await dismiss(req.params.id, req.ctx));
}));

router.get('/kinds', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const counts = await db.all(
    `SELECT kind, severity, COUNT(*) AS c FROM notifications WHERE resolved_at IS NULL GROUP BY kind, severity ORDER BY c DESC`,
  );
  res.json({ kinds: ALERT_KINDS, counts });
}));

export default router;
