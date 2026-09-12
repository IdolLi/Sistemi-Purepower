/** Shared route helpers: list responses, filter builders, unit conversion, file meta. */
import { parseListQuery, escapeLike } from '../lib/validate.js';
import { badRequest } from '../lib/errors.js';

/**
 * Build a WHERE clause + params from an array of [sql, value] conditions.
 * `where('a = ?', 5, 'b IS NULL')` -> { sql: 'WHERE a = ? AND b IS NULL', params: [5] }
 */
export function where(...parts) {
  const conditions = [];
  const params = [];
  for (let i = 0; i < parts.length; i += 2) {
    const clause = parts[i];
    if (!clause) continue;
    conditions.push(clause);
    if (i + 1 < parts.length && parts[i + 1] !== undefined) params.push(parts[i + 1]);
  }
  return { sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

export function searchClause(term) {
  const like = `%${escapeLike(String(term).trim())}%`;
  return like;
}

/** Whitelisted ORDER BY builder. */
export function orderBy(query, sortable, defaultSort = 'id', defaultDir = 'asc') {
  const parsed = parseListQuery(query, { sortable, defaultSort });
  return { ...parsed, orderSql: `ORDER BY \`${parsed.sort}\` ${parsed.dir}` };
}

export function listResult({ items, total, page, size }) {
  return {
    items,
    pagination: {
      page,
      page_size: size,
      total,
      pages: Math.max(1, Math.ceil(total / size)),
      has_more: page * size < total,
    },
  };
}

/** mm -> requested display unit. */
export const UNIT_FACTORS = { mm: 1, cm: 0.1, inch: 1 / 25.4, in: 1 / 25.4 };

export function convertFromMm(valueMm, unit) {
  if (valueMm === null || valueMm === undefined) return null;
  const factor = UNIT_FACTORS[String(unit || 'mm').toLowerCase()] ?? 1;
  const v = Number(valueMm) * factor;
  return Math.round(v * 1000) / 1000;
}

export function toMm(value, unit) {
  const factor = UNIT_FACTORS[String(unit || 'mm').toLowerCase()] ?? 1;
  return Math.round((Number(value) / factor) * 1000) / 1000;
}

export function assertUnit(unit) {
  if (unit && !UNIT_FACTORS[String(unit).toLowerCase()]) throw badRequest('unit must be one of: mm, cm, inch');
  return unit || 'mm';
}

export function requireId(raw, label = 'id') {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`${label} must be a positive integer`);
  return n;
}

/** Shallow "did anything change" check used before writing revisions. */
export function changedKeys(before, after, keys) {
  return keys.filter((k) => String(before?.[k] ?? '') !== String(after?.[k] ?? ''));
}

export function csv(v) {
  if (v === null || v === undefined || v === '') return [];
  if (Array.isArray(v)) return v;
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function asIntOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
