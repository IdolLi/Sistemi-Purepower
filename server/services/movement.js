/**
 * Tooling movement engine (spec §15, §17, §32, §35).
 * Every physical action is recorded in `tooling_movements` (append-only) inside a
 * transaction that also updates the tool's current location/status and, where relevant,
 * the production order tooling line, reservations, occupancy counters and cycle counters.
 */
import db from '../db/index.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';
import { audit } from './audit.js';
import { refreshOccupancy } from '../seeds/demo.js';
import { refreshSetStatuses } from '../seeds/demo.js';

export const MOVEMENT_TYPES = ['TAKE', 'MOVE', 'RETURN', 'TRANSFER', 'STATUS_CHANGE', 'SCRAP', 'INVENTORY_CHECK', 'RESERVE', 'RELEASE'];

async function findLocation(exec, ref) {
  if (ref === null || ref === undefined || ref === '') return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && numeric > 0) {
    const byId = await exec.one('SELECT * FROM tooling_locations WHERE id = ?', [numeric]);
    if (byId) return byId;
  }
  const code = String(ref).trim().toUpperCase();
  const byCode = await exec.one('SELECT * FROM tooling_locations WHERE full_code = ? OR code = ?', [code, code]);
  if (byCode) return byCode;
  const box = await exec.one(
    `SELECT l.* FROM tooling_locations l JOIN warehouse_boxes b ON b.id = l.ref_id JOIN warehouse_shelves s ON s.id = b.shelf_id
     WHERE UPPER(CONCAT(s.code, '-', b.code)) = ? OR UPPER(b.code) = ? LIMIT 1`,
    [code, code],
  );
  if (box) return box;
  throw notFound(`Storage location "${ref}" was not found. Scan the shelf QR code or check the location code.`);
}

/**
 * Core movement action.
 * @param {object} p { tooling, action, location, external, order, qty, reason, note, ctx }
 */
export async function performMovement({ tooling, action, location = null, external = null, production_order_id = null, qty = 1, reason = null, note = null, ctx }) {
  const toolRef = tooling;
  return db.tx(async (exec) => {
    const numeric = Number(toolRef);
    const tool = Number.isInteger(numeric) && numeric > 0
      ? await exec.one('SELECT * FROM tooling_items WHERE id = ? AND deleted_at IS NULL', [numeric])
      : await exec.one('SELECT * FROM tooling_items WHERE UPPER(tooling_id) = ? AND deleted_at IS NULL', [String(toolRef).toUpperCase()]);
    if (!tool) throw notFound(`Tooling ${toolRef} not found`);

    const order = production_order_id ? await exec.one('SELECT * FROM production_orders WHERE id = ?', [Number(production_order_id)]) : null;
    if (production_order_id && !order) throw notFound('Production order not found');

    let toLocation = null;
    if (['MOVE', 'RETURN', 'TRANSFER'].includes(action) && location) toLocation = await findLocation(exec, location);
    if (action === 'TAKE' && !external && !toLocation && !order) {
      throw badRequest('A take needs a destination: select a production order or type a location');
    }
    if (['MOVE', 'RETURN'].includes(action) && !toLocation && !external) {
      throw badRequest('Scanning a destination location (or typing it) is required for this action');
    }
    if (qty > tool.quantity && ['TAKE'].includes(action)) throw conflict(`Only ${tool.quantity} physical piece(s) of ${tool.tooling_id} are registered`);

    const statusBefore = tool.status;
    let statusAfter = tool.status;
    let locationAfter = tool.location_id;
    let externalAfter = tool.external_location;

    switch (action) {
      case 'TAKE':
        statusAfter = order ? 'IN_USE' : 'IN_USE';
        locationAfter = null;
        externalAfter = external ?? (order ? `${order.line || 'Production'} / ${order.po_number}` : 'Production');
        break;
      case 'RETURN':
        statusAfter = 'AVAILABLE';
        locationAfter = toLocation?.id ?? tool.location_id;
        externalAfter = null;
        break;
      case 'MOVE':
      case 'TRANSFER':
        statusAfter = toLocation ? 'AVAILABLE' : statusBefore;
        locationAfter = toLocation?.id ?? null;
        externalAfter = toLocation ? null : external ?? externalAfter;
        break;
      case 'INVENTORY_CHECK':
        statusAfter = statusBefore;
        break;
      case 'SCRAP':
        statusAfter = 'RETIRED';
        locationAfter = toLocation?.id ?? null;
        break;
      case 'MAINTENANCE':
      case 'DAMAGE':
        statusAfter = action === 'MAINTENANCE' ? 'MAINTENANCE' : 'DAMAGED';
        break;
      case 'MISSING':
        statusAfter = 'MISSING';
        break;
      case 'RELEASE':
        statusAfter = 'AVAILABLE';
        break;
      default:
        throw badRequest(`Unsupported movement action: ${action}`);
    }

    const fromLoc = tool.location_id ? await exec.one('SELECT * FROM tooling_locations WHERE id = ?', [tool.location_id]) : null;

    await exec.run(
      `UPDATE tooling_items SET status = ?, location_id = ?, external_location = ?, updated_at = NOW() WHERE id = ?`,
      [statusAfter, locationAfter, externalAfter, tool.id],
    );
    await exec.run(
      `INSERT INTO tooling_movements (tooling_item_id, movement_type, from_location_id, to_location_id, from_location_code, to_location_code,
         external_location, production_order_id, status_before, status_after, qty, reason_code, note, user_id, username, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
      [
        tool.id,
        action,
        fromLoc?.id ?? null,
        toLocation?.id ?? null,
        fromLoc?.full_code ?? null,
        toLocation?.full_code ?? null,
        externalAfter ?? null,
        order?.id ?? null,
        statusBefore,
        statusAfter,
        Math.max(1, Number(qty) || 1),
        reason,
        note,
        ctx?.user?.id ?? null,
        ctx?.user?.username ?? null,
      ],
    );

    if (order) {
      if (action === 'TAKE') {
        await exec.run(
          `INSERT INTO production_order_tools (production_order_id, tooling_item_id, is_required, qty, status, taken_at, cycle_count)
           VALUES (?, ?, 1, ?, 'IN_USE', NOW(), 0)
           ON DUPLICATE KEY UPDATE status = 'IN_USE', taken_at = NOW(), qty = VALUES(qty)`,
          [order.id, tool.id, qty],
        );
        await exec.run('UPDATE tooling_reservations SET status = ' + "'FULFILLED'" + ', released_at = NOW() WHERE tooling_item_id = ? AND production_order_id = ? AND status = ' + "'ACTIVE'", [tool.id, order.id]);
      } else if (action === 'RETURN') {
        await exec.run(
          `UPDATE production_order_tools SET status = 'RETURNED', returned_at = NOW()
           WHERE production_order_id = ? AND tooling_item_id = ?`,
          [order.id, tool.id],
        );
        const stillOut = await exec.value(
          `SELECT COUNT(*) c FROM production_order_tools WHERE production_order_id = ? AND status IN ('RESERVED','IN_USE','PENDING')`,
          [order.id],
        );
        if (!Number(stillOut) && ['READY', 'BLOCKED', 'IN_PROGRESS'].includes(order.status)) {
          await exec.run("UPDATE production_orders SET status = 'IN_PROGRESS' WHERE id = ? AND status <> 'COMPLETED'", [order.id]);
        }
      }
      await refreshReservedFor(exec, tool.id);
    }

    await recomputeSet(exec, tool.tooling_set_id);
    await audit(
      { ...ctx, user: ctx?.user },
      {
        action: `movement.${action.toLowerCase()}`,
        entityType: 'tooling_item',
        entityId: tool.id,
        entityLabel: tool.tooling_id,
        summary: `${action} ${tool.tooling_id}: ${statusBefore} -> ${statusAfter}${fromLoc ? ` from ${fromLoc.full_code}` : ''}${toLocation ? ` to ${toLocation.full_code}` : externalAfter ? ` to ${externalAfter}` : ''}`,
        oldValue: fromLoc?.full_code ?? null,
        newValue: toLocation?.full_code ?? externalAfter ?? null,
        reason,
      },
    );

    return {
      tooling_item_id: tool.id,
      tooling_id: tool.tooling_id,
      name: tool.name,
      action,
      status_before: statusBefore,
      status: statusAfter,
      from: fromLoc?.full_code ?? tool.external_location ?? null,
      to: toLocation?.full_code ?? externalAfter ?? null,
      production_order: order?.po_number ?? null,
      qty: Number(qty) || 1,
    };
  }).then(async (result) => {
    await refreshOccupancy();
    return result;
  });
}

async function refreshReservedFor(exec, toolingId) {
  await exec.run(
    `UPDATE tooling_items t SET t.reserved_qty =
       (SELECT COALESCE(SUM(r.qty),0) FROM tooling_reservations r WHERE r.tooling_item_id = t.id AND r.status = 'ACTIVE')
     WHERE t.id = ?`,
    [Number(toolingId)],
  );
}

async function recomputeSet(exec, setId) {
  if (!setId) return;
  await refreshSetStatuses(exec, { sets: [Number(setId)] });
}

export async function reserveTooling({ tooling, production_order_id, qty = 1, planned_start_at = null, planned_end_at = null, note = null, ctx }) {
  return db.tx(async (exec) => {
    const tool = await loadTool(exec, tooling);
    const order = await exec.one('SELECT * FROM production_orders WHERE id = ?', [Number(production_order_id)]);
    if (!order) throw notFound('Production order not found');
    const foreign = await exec.all(
      `SELECT r.id, r.qty, po.po_number, po.id AS order_id FROM tooling_reservations r
       JOIN production_orders po ON po.id = r.production_order_id
       WHERE r.tooling_item_id = ? AND r.status = 'ACTIVE' AND (r.production_order_id IS NULL OR r.production_order_id <> ?)`,
      [tool.id, order.id],
    );
    if (foreign.length) {
      const list = foreign.map((f) => `${f.po_number} (${f.qty})`).join(', ');
      throw conflict(`${tool.tooling_id} is already reserved for ${list} - release it there first`);
    }
    if (['MAINTENANCE', 'DAMAGED', 'MISSING', 'RETIRED'].includes(tool.status)) {
      throw conflict(`${tool.tooling_id} cannot be reserved while ${tool.status.toLowerCase()}`);
    }
    const active = await exec.value('SELECT COALESCE(SUM(qty),0) q FROM tooling_reservations WHERE tooling_item_id = ? AND status = ' + "'ACTIVE'" + " AND (production_order_id IS NULL OR production_order_id <> ?)", [tool.id, order.id]);
    if (Number(active) + Number(qty) > Number(tool.quantity)) {
      throw conflict(`Not enough copies: ${tool.quantity} registered, ${active} already reserved`);
    }
    await exec.run(
      `INSERT INTO tooling_reservations (tooling_item_id, production_order_id, requested_by, reserved_by, qty, planned_start_at, planned_end_at, status, note)
       VALUES (?,?,?,?,?,?,?, 'ACTIVE', ?)`,
      [tool.id, order.id, ctx?.user?.id ?? null, ctx?.user?.id ?? null, qty, planned_start_at, planned_end_at, note],
    );
    await exec.run(
      `INSERT INTO production_order_tools (production_order_id, tooling_item_id, is_required, qty, status)
       VALUES (?,?,1,?, 'RESERVED')
       ON DUPLICATE KEY UPDATE qty = VALUES(qty), status = IF(status = 'PENDING', 'RESERVED', status)`,
      [order.id, tool.id, qty],
    );
    if (tool.status === 'AVAILABLE') await exec.run("UPDATE tooling_items SET status = 'RESERVED', updated_at = NOW() WHERE id = ?", [tool.id]);
    await refreshReservedFor(exec, tool.id);
    await audit(ctx, { action: 'reserve', entityType: 'tooling_item', entityId: tool.id, entityLabel: tool.tooling_id, summary: `Reserved ${qty}x ${tool.tooling_id} for ${order.po_number}`, newValue: order.po_number });
    return { tooling_id: tool.tooling_id, order: order.po_number, qty };
  });
}

export async function releaseReservation({ reservationId = null, tooling = null, production_order_id = null, note = null, ctx }) {
  return db.tx(async (exec) => {
    let rows = [];
    if (reservationId) {
      rows = await exec.all("SELECT * FROM tooling_reservations WHERE id = ? AND status = 'ACTIVE'", [Number(reservationId)]);
    } else {
      if (!tooling) throw badRequest('Provide reservation id or tooling reference');
      const tool = await loadTool(exec, tooling);
      rows = await exec.all(
        `SELECT * FROM tooling_reservations WHERE tooling_item_id = ? AND status = 'ACTIVE' ${production_order_id ? 'AND production_order_id = ?' : ''}`,
        production_order_id ? [tool.id, Number(production_order_id)] : [tool.id],
      );
    }
    if (!rows.length) throw notFound('No active reservation found');
    for (const r of rows) {
      await exec.run("UPDATE tooling_reservations SET status = 'RELEASED', released_at = NOW(), note = COALESCE(?, note) WHERE id = ?", [note, r.id]);
      await exec.run(
        "UPDATE production_order_tools SET status = 'RELEASED' WHERE production_order_id = ? AND tooling_item_id = ? AND status IN ('RESERVED','PENDING')",
        [r.production_order_id ?? 0, r.tooling_item_id],
      );
      const remaining = await exec.value("SELECT COUNT(*) c FROM tooling_reservations WHERE tooling_item_id = ? AND status = 'ACTIVE'", [r.tooling_item_id]);
      if (!Number(remaining)) {
        const toolRow = await exec.one('SELECT status, location_id FROM tooling_items WHERE id = ?', [r.tooling_item_id]);
        if (toolRow?.status === 'RESERVED') await exec.run("UPDATE tooling_items SET status = 'AVAILABLE', updated_at = NOW() WHERE id = ?", [r.tooling_item_id]);
      }
      await refreshReservedFor(exec, r.tooling_item_id);
      await audit(ctx, { action: 'release', entityType: 'tooling_item', entityId: r.tooling_item_id, summary: `Released reservation #${r.id}${note ? `: ${note}` : ''}` });
    }
    return { released: rows.length };
  });
}

async function loadTool(exec, ref) {
  const numeric = Number(ref);
  const tool = Number.isInteger(numeric) && numeric > 0
    ? await exec.one('SELECT * FROM tooling_items WHERE id = ? AND deleted_at IS NULL', [numeric])
    : await exec.one('SELECT * FROM tooling_items WHERE UPPER(tooling_id) = ? AND deleted_at IS NULL', [String(ref).toUpperCase()]);
  if (!tool) throw notFound(`Tooling ${ref} not found`);
  return tool;
}

export async function logUsage({ tooling, production_order_id = null, cycles = 1, produced_qty = 0, note = null, ctx }) {
  const tool = await loadTool(await db.rawDriver.executor(), tooling);
  await db.run(
    `INSERT INTO tooling_usage_history (tooling_item_id, production_order_id, filter_id, event_type, cycles, quantity, produced_qty, operator_id, operator_name, note)
     VALUES (?,?,?,?,?,?,?, ?, ?, ?)`,
    [tool.id, production_order_id, tool.primary_filter_id, 'USAGE', cycles, produced_qty, produced_qty, ctx?.user?.id ?? null, ctx?.user?.full_name ?? null, note],
  );
  await db.run(
    'UPDATE tooling_items SET total_cycles = total_cycles + ?, total_parts_produced = total_parts_produced + ?, last_used_at = NOW(), updated_at = NOW() WHERE id = ?',
    [cycles, produced_qty, tool.id],
  );
  if (production_order_id) {
    await db.run(
      `UPDATE production_order_tools SET cycle_count = cycle_count + ?, produced_qty = produced_qty + ?
       WHERE production_order_id = ? AND tooling_item_id = ?`,
      [cycles, produced_qty, Number(production_order_id), tool.id],
    );
  }
  return db.one('SELECT COUNT(*) usages, COALESCE(SUM(cycles),0) cycles FROM tooling_usage_history WHERE tooling_item_id = ?', [tool.id]);
}
