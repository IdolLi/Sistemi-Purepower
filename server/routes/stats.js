/** /api/stats — dashboard, alerts, charts (spec §35, §53). All numbers come from live queries. */
import express from 'express';
import db from '../db/index.js';
import { asyncRoute } from '../lib/errors.js';
import { requirePermission } from '../middleware/index.js';
import { computeAlerts } from '../services/notifications.js';

const router = express.Router();

router.get('/dashboard', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const t0 = Date.now();
  const [
    filters,
    tooling,
    statusCounts,
    openDamage,
    dueMaintenance,
    overdueMaintenance,
    cycleWarnings,
    missing,
    outNow,
    blocked,
    lowStock,
    unassigned,
    orders,
    batches,
    locations,
    sets,
    recentMovements,
    recentAudit,
    requests,
    imageless,
  ] = await Promise.all([
    db.one(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN status = 'DEVELOPMENT' THEN 1 ELSE 0 END) AS development FROM filters`,
    ),
    db.one(`SELECT COUNT(*) AS total, COALESCE(SUM(quantity),0) AS pieces, SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS live FROM tooling_items`),
    db.all(`SELECT status, COUNT(*) AS c, SUM(quantity) AS pieces FROM tooling_items WHERE deleted_at IS NULL GROUP BY status`),
    db.value(`SELECT COUNT(*) c FROM tooling_damage_reports WHERE status = 'OPEN'`),
    db.value(`SELECT COUNT(*) c FROM tooling_items WHERE deleted_at IS NULL AND next_maintenance_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 14 DAY)`),
    db.value(`SELECT COUNT(*) c FROM tooling_items WHERE deleted_at IS NULL AND next_maintenance_date < CURDATE()`),
    db.value(`SELECT COUNT(*) c FROM tooling_items WHERE deleted_at IS NULL AND max_cycles IS NOT NULL AND total_cycles * 100 >= max_cycles * cycle_warning_pct`),
    db.value(`SELECT COUNT(*) c FROM tooling_items WHERE deleted_at IS NULL AND status = 'MISSING'`),
    db.value(`SELECT COUNT(*) c FROM tooling_items WHERE deleted_at IS NULL AND status = 'IN_USE'`),
    db.value(`SELECT COUNT(*) c FROM production_orders WHERE availability_status = 'NOT_READY' AND status IN ('PLANNED','READY','IN_PROGRESS')`),
    db.value(
      `SELECT COUNT(*) c FROM inventory_items ii LEFT JOIN (SELECT inventory_item_id, SUM(quantity) q FROM inventory GROUP BY inventory_item_id) t ON t.inventory_item_id = ii.id
       WHERE ii.reorder_level > 0 AND COALESCE(t.q,0) <= ii.reorder_level`,
    ),
    db.value(`SELECT COUNT(*) c FROM tooling_items WHERE deleted_at IS NULL AND status = 'AVAILABLE' AND location_id IS NULL AND (external_location IS NULL OR external_location = '')`),
    db.one(
      `SELECT COUNT(*) AS total, SUM(status IN ('PLANNED','READY')) AS planned, SUM(status = 'IN_PROGRESS') AS running,
              SUM(status = 'COMPLETED' AND completed_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)) AS completed_week
       FROM production_orders`,
    ),
    db.one(
      `SELECT COALESCE(SUM(quantity),0) AS units, COALESCE(SUM(good_qty),0) AS good, COALESCE(SUM(scrap_qty),0) AS scrap
       FROM production_batches WHERE COALESCE(completed_at, started_at) > DATE_SUB(NOW(), INTERVAL 30 DAY)`,
    ),
    db.one(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN occupancy_items > 0 THEN 1 ELSE 0 END) AS used, COALESCE(SUM(capacity_items),0) AS capacity, COALESCE(SUM(occupancy_items),0) AS occupied FROM tooling_locations WHERE kind IN ('SHELF','BOX')`,
    ),
    db.one(`SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'COMPLETE' THEN 1 ELSE 0 END) AS complete FROM tooling_sets`),
    db.all(
      `SELECT m.id, m.movement_type, m.qty, m.username, m.created_at, m.note, t.tooling_id, t.name AS tooling_name, tt.icon,
              m.to_location_code, m.from_location_code
       FROM tooling_movements m JOIN tooling_items t ON t.id = m.tooling_item_id JOIN tooling_types tt ON tt.id = t.tooling_type_id
       ORDER BY m.created_at DESC, m.id DESC LIMIT 12`,
    ),
    db.all(
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.summary, a.username, a.created_at
       FROM audit_logs a ORDER BY a.id DESC LIMIT 12`,
    ),
    db.all(`SELECT status, COUNT(*) AS c FROM tooling_requests GROUP BY status`),
    db.value(`SELECT COUNT(*) c FROM tooling_items t WHERE t.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM tooling_images im WHERE im.owner_type='TOOLING' AND im.owner_id = t.id)`),
  ]);

  const byStatus = Object.fromEntries(statusCounts.map((s) => [s.status, { count: Number(s.c), pieces: Number(s.pieces ?? 0) }]));
  res.json({
    generated_at: new Date().toISOString(),
    took_ms: Date.now() - t0,
    tiles: {
      filters: { total: Number(filters.total ?? 0), active: Number(filters.active ?? 0), development: Number(filters.development ?? 0) },
      tooling: { total: Number(tooling.live ?? 0), pieces: Number(tooling.pieces ?? 0) },
      out_now: Number(outNow ?? 0),
      blocked_orders: Number(blocked ?? 0),
      open_damage: Number(openDamage ?? 0),
      missing: Number(missing ?? 0),
      maintenance_due: Number(dueMaintenance ?? 0),
      maintenance_overdue: Number(overdueMaintenance ?? 0),
      cycle_warnings: Number(cycleWarnings ?? 0),
      low_stock: Number(lowStock ?? 0),
      unassigned_locations: Number(unassigned ?? 0),
      imageless_tooling: Number(imageless ?? 0),
      locations: { total: Number(locations.total ?? 0), used: Number(locations.used ?? 0), capacity: Number(locations.capacity ?? 0), occupied: Number(locations.occupied ?? 0) },
      sets: { total: Number(sets.total ?? 0), complete: Number(sets.complete ?? 0) },
      orders: { total: Number(orders.total ?? 0), planned: Number(orders.planned ?? 0), running: Number(orders.running ?? 0), completed_week: Number(orders.completed_week ?? 0) },
      batches_30d: { units: Number(batches.units ?? 0), good: Number(batches.good ?? 0), scrap: Number(batches.scrap ?? 0) },
    },
    tooling_by_status: ['AVAILABLE', 'IN_USE', 'RESERVED', 'MAINTENANCE', 'DAMAGED', 'MISSING', 'RETIRED'].map((status) => ({
      status,
      count: byStatus[status]?.count ?? 0,
      pieces: byStatus[status]?.pieces ?? 0,
    })),
    requests_by_status: requests.map((r) => ({ status: r.status, count: Number(r.c) })),
    recent_movements: recentMovements,
    recent_activity: recentAudit,
  });
}));

router.get('/dashboard/charts', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const days = Math.min(180, Math.max(7, Number(req.query.days || 30)));
  res.json({
    days,
    movements_per_day: await db.all(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day,
              SUM(movement_type = 'TAKE') AS takes, SUM(movement_type = 'RETURN') AS returns_,
              SUM(movement_type = 'MOVE') AS moves, COUNT(*) AS total
       FROM tooling_movements WHERE created_at > DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d') ORDER BY day`,
      [days],
    ),
    tooling_by_type: await db.all(
      `SELECT tt.name, tt.code, tt.icon, COUNT(t.id) AS items, COALESCE(SUM(t.quantity),0) AS pieces,
              SUM(CASE WHEN t.status = 'AVAILABLE' THEN 1 ELSE 0 END) AS available,
              SUM(CASE WHEN t.status IN ('DAMAGED','MISSING','MAINTENANCE') THEN 1 ELSE 0 END) AS attention
       FROM tooling_types tt LEFT JOIN tooling_items t ON t.tooling_type_id = tt.id AND t.deleted_at IS NULL
       GROUP BY tt.id, tt.name, tt.code, tt.icon, tt.sort_order ORDER BY items DESC, tt.sort_order LIMIT 20`,
    ),
    filters_by_type: await db.all(
      `SELECT ft.name, ft.code, ft.icon, COUNT(f.id) AS filters,
              COALESCE(SUM((SELECT COUNT(*) FROM tooling_compatibility tc JOIN tooling_items ti ON ti.id = tc.tooling_item_id AND ti.deleted_at IS NULL WHERE tc.filter_id = f.id)), 0) AS tooling_links
       FROM filter_types ft LEFT JOIN filters f ON f.filter_type_id = ft.id
       GROUP BY ft.id, ft.name, ft.code, ft.icon, ft.sort_order ORDER BY filters DESC`,
    ),
    production_per_day: await db.all(
      `SELECT DATE_FORMAT(o.completed_at, '%Y-%m-%d') AS day, COUNT(*) AS orders, COALESCE(SUM(o.quantity_produced),0) AS pieces
       FROM production_orders o WHERE o.completed_at > DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY DATE_FORMAT(o.completed_at, '%Y-%m-%d') ORDER BY day`,
      [days],
    ),
    shelf_fill: await db.all(
      `SELECT l.full_code, l.kind, l.capacity_items, l.occupancy_items, ROUND(l.occupancy_items * 100.0 / NULLIF(l.capacity_items,0)) AS fill_pct
       FROM tooling_locations l WHERE l.kind = 'SHELF' AND l.capacity_items IS NOT NULL
       ORDER BY fill_pct DESC LIMIT 40`,
    ),
    maintenance_per_month: await db.all(
      `SELECT DATE_FORMAT(COALESCE(completed_date, scheduled_date), '%Y-%m') AS month, COUNT(*) AS jobs,
              COALESCE(SUM(cost),0) AS cost, COALESCE(SUM(downtime_hours),0) AS downtime_hours
       FROM tooling_maintenance GROUP BY DATE_FORMAT(COALESCE(completed_date, scheduled_date), '%Y-%m') ORDER BY month DESC LIMIT 12`,
    ),
    condition_profile: await db.all(
      `SELECT condition_rating, COUNT(*) AS items FROM tooling_items WHERE deleted_at IS NULL GROUP BY condition_rating
       ORDER BY FIELD(condition_rating,'EXCELLENT','GOOD','FAIR','POOR','CRITICAL')`,
    ),
  });
}));

/** Alert list for the dashboard + the "ALERTS" tile. Recomputes derived alerts first. */
router.get('/alerts', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const refresh = await computeAlerts();
  const { listNotifications } = await import('../services/notifications.js');
  const out = await listNotifications({
    user_id: req.user.id,
    role_code: req.user.role_code,
    kind: req.query.kind ?? null,
    unread_only: req.query.unread === '1',
    limit: Number(req.query.limit || 60),
    q: req.query.q ?? null,
  });
  res.json({ ...out, refresh });
}));

/** Per-module counters, used by the nav tree + "N new" badges. */
router.get('/counts', requirePermission('*.read'), asyncRoute(async (req, res) => {
  const rows = await db.one(`SELECT
      (SELECT COUNT(*) FROM filters WHERE is_active = 1) AS filters,
      (SELECT COUNT(*) FROM tooling_items WHERE deleted_at IS NULL) AS tooling,
      (SELECT COUNT(*) FROM tooling_locations) AS locations,
      (SELECT COUNT(*) FROM tooling_sets) AS sets,
      (SELECT COUNT(*) FROM production_orders WHERE status IN ('PLANNED','READY','IN_PROGRESS')) AS open_orders,
      (SELECT COUNT(*) FROM tooling_maintenance WHERE status IN ('SCHEDULED','IN_PROGRESS')) AS open_maintenance,
      (SELECT COUNT(*) FROM tooling_damage_reports WHERE status = 'OPEN') AS open_damage,
      (SELECT COUNT(*) FROM tooling_requests WHERE status = 'PENDING') AS pending_requests,
      (SELECT COUNT(*) FROM notifications WHERE resolved_at IS NULL AND is_read = 0) AS unread_notifications,
      (SELECT COUNT(*) FROM tooling_movements WHERE created_at > DATE_SUB(NOW(), INTERVAL 1 DAY)) AS movements_24h,
      (SELECT COUNT(*) FROM tooling_images WHERE owner_type = 'TOOLING') AS photos,
      (SELECT COUNT(*) FROM tooling_documents) AS documents,
      (SELECT COUNT(*) FROM audit_logs WHERE created_at > DATE_SUB(NOW(), INTERVAL 1 DAY)) AS audit_24h`);
  res.json({ counts: rows });
}));

export default router;
