/**
 * Small hand-rolled validation layer.
 * Every API input goes through a schema so that nothing unvalidated reaches SQL.
 */
import { badRequest } from './errors.js';

const EMPTY = [undefined, null, ''];

export const str = (opts = {}) => (value, field, out, errors) => {
  let v = value;
  if (EMPTY.includes(v)) {
    if (opts.required) errors.push(`${field} is required`);
    else out[field] = opts.default !== undefined ? opts.default : null;
    return;
  }
  v = String(v).trim();
  // strip control chars, keep printable text (HTML escaping happens at render time)
  v = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  if (opts.upper) v = v.toUpperCase();
  if (opts.lower) v = v.toLowerCase();
  if (opts.min && v.length < opts.min) errors.push(`${field} must be at least ${opts.min} characters`);
  if (opts.max && v.length > opts.max) errors.push(`${field} must be at most ${opts.max} characters`);
  if (opts.pattern && !opts.pattern.test(v)) errors.push(`${field} format is invalid${opts.hint ? ` (${opts.hint})` : ''}`);
  if (errors.length) return;
  out[field] = v;
};

export const num = (opts = {}) => (value, field, out, errors) => {
  if (EMPTY.includes(value)) {
    if (opts.required) errors.push(`${field} is required`);
    else out[field] = opts.default !== undefined ? opts.default : null;
    return;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    errors.push(`${field} must be a number`);
    return;
  }
  if (opts.int && !Number.isInteger(n)) {
    errors.push(`${field} must be a whole number`);
    return;
  }
  if (opts.min !== undefined && n < opts.min) {
    errors.push(`${field} must be >= ${opts.min}`);
    return;
  }
  if (opts.max !== undefined && n > opts.max) {
    errors.push(`${field} must be <= ${opts.max}`);
    return;
  }
  out[field] = n;
};

export const bool = (opts = {}) => (value, field, out) => {
  if (typeof value === 'boolean') out[field] = value;
  else if (value === 'true' || value === 1 || value === '1') out[field] = true;
  else if (value === 'false' || value === 0 || value === '0') out[field] = false;
  else out[field] = opts.default !== undefined ? opts.default : false;
};

export const date = (opts = {}) => (value, field, out, errors) => {
  if (EMPTY.includes(value)) {
    if (opts.required) errors.push(`${field} is required`);
    else out[field] = null;
    return;
  }
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/.test(s)) {
    errors.push(`${field} must be a date (YYYY-MM-DD)`);
    return;
  }
  out[field] = s.length <= 10 ? s : s.replace('T', ' ').slice(0, 19);
};

export const oneOf = (values, opts = {}) => (value, field, out, errors) => {
  if (EMPTY.includes(value)) {
    if (opts.required) errors.push(`${field} is required`);
    else out[field] = opts.default !== undefined ? opts.default : null;
    return;
  }
  const v = String(value).trim();
  const upper = (x) => String(x).toUpperCase();
  if (!values.includes(v)) {
    const folded = values.find((x) => upper(x) === upper(v));
    if (folded === undefined) {
      errors.push(`${field} must be one of: ${values.join(', ')}`);
      return;
    }
    out[field] = folded;
    return;
  }
  out[field] = v;
};

export const idRef = (opts = {}) => (value, field, out, errors) => {
  if (EMPTY.includes(value)) {
    if (opts.required) errors.push(`${field} is required`);
    else out[field] = null;
    return;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    errors.push(`${field} must be a positive id`);
    return;
  }
  out[field] = n;
};

export const idList = (opts = {}) => (value, field, out, errors) => {
  let raw = value;
  if (EMPTY.includes(raw)) raw = [];
  if (typeof raw === 'string') raw = raw.split(',');
  if (!Array.isArray(raw)) {
    errors.push(`${field} must be a list of ids`);
    return;
  }
  const ids = [];
  for (const item of raw) {
    const n = Number(item?.id ?? item);
    if (!Number.isInteger(n) || n <= 0) {
      errors.push(`${field} contains an invalid id`);
      return;
    }
    if (!ids.includes(n)) ids.push(n);
  }
  if (opts.required && ids.length === 0) {
    errors.push(`${field} must contain at least one id`);
    return;
  }
  out[field] = ids;
};

export const text = (opts = {}) => (value, field, out, errors) => {
  if (EMPTY.includes(value)) {
    out[field] = opts.default !== undefined ? opts.default : null;
    return;
  }
  let v = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  if (opts.max && v.length > opts.max) {
    errors.push(`${field} must be at most ${opts.max} characters`);
    return;
  }
  out[field] = v.trim() === '' ? null : v;
};

export const object = (opts = {}) => (value, field, out, errors) => {
  if (EMPTY.includes(value)) {
    out[field] = opts.default !== undefined ? opts.default : null;
    return;
  }
  let obj = value;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      errors.push(`${field} must be valid JSON`);
      return;
    }
  }
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    errors.push(`${field} must be an object`);
    return;
  }
  out[field] = obj;
};

/**
 * Apply a field map to an input object.
 * @returns validated object (only provided/valid fields)
 */
export function validate(schema, input, { partial = false } = {}) {
  const out = {};
  const errors = [];
  const src = input || {};
  for (const [field, rule] of Object.entries(schema)) {
    if (partial && !(field in src)) continue;
    const fn = resolveValidator(rule);
    const opts = Array.isArray(rule) ? rule[1] || {} : {};
    fn(src[field], opts.as || field, out, errors);
  }
  if (errors.length) throw badRequest('Validation failed', errors.slice(0, 12));
  return out;
}

/**
 * Accepts either a bare validator (`str`), a curried validator (`str({max: 10})`)
 * or the tuple form used by the route schemas (`[str, { max: 10 }]`).
 */
function resolveValidator(rule) {
  if (Array.isArray(rule)) {
    const [base, opts = {}] = rule;
    if (typeof base !== 'function') throw new Error('schema rule must be a validator function');
    if (base.length <= 1) {
      const curried = base(opts);
      if (typeof curried === 'function') return curried;
    }
    return (value, field, out, errors) => base(value, field, out, errors, opts);
  }
  if (typeof rule !== 'function') throw new Error('schema rule must be a validator function');
  if (rule.length <= 1) {
    const curried = rule();
    if (typeof curried === 'function') return curried;
  }
  return rule;
}

/** Parse + validate query string pagination/sort. */
export function parseListQuery(query, { sortable = ['id', 'created_at', 'updated_at'], defaultSort = 'id', max = 200 } = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const size = Math.min(max, Math.max(1, Number.parseInt(query.page_size || query.limit, 10) || 25));
  const sort = sortable.includes(query.sort) ? query.sort : defaultSort;
  const dir = String(query.dir || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  return { page, size, offset: (page - 1) * size, sort, dir, sortable };
}

/** Build "?,?,?" for an IN() clause. */
export function inPlaceholders(values) {
  if (!Array.isArray(values) || values.length === 0) return 'NULL';
  return values.map(() => '?').join(',');
}

export const escapeLike = (value) => String(value).replace(/[\\%_]/g, (m) => `\\${m}`);
