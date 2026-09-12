/** Thin API client: JSON + CSRF + upload + download helpers. No framework, no build step. */

const CSRF_COOKIE = 'sp_csrf';

export const meta = { data: null };

function readCookie(name) {
  const hit = document.cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details ?? null;
  }
}

async function parse(res) {
  const type = res.headers.get('content-type') || '';
  if (type.includes('json')) return res.json().catch(() => null);
  if (type.startsWith('text/') || type.includes('svg') || type.includes('xml')) return res.text();
  return res.blob();
}

export async function request(method, url, body, { form = false, headers = {}, signal } = {}) {
  const opts = { method, headers: { ...headers }, credentials: 'same-origin', signal };
  if (body !== undefined && body !== null) {
    if (form) {
      opts.body = body; // FormData: browser sets the multipart boundary
    } else {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }
  if (method !== 'GET' && method !== 'HEAD') {
    const token = readCookie(CSRF_COOKIE);
    if (token) opts.headers['x-csrf-token'] = token;
  }
  const res = await fetch(url, opts);
  const payload = await parse(res);
  if (!res.ok) {
    const err = payload && typeof payload === 'object' && payload.error ? payload.error : {};
    throw new ApiError(res.status, err.message || (typeof payload === 'string' ? payload.slice(0, 160) : `Request failed (${res.status})`), err.details ?? null);
  }
  return payload;
}

export const api = {
  get: (url, opts) => request('GET', url, null, opts),
  post: (url, body, opts) => request('POST', url, body ?? {}, opts),
  put: (url, body, opts) => request('PUT', url, body ?? {}, opts),
  patch: (url, body, opts) => request('PATCH', url, body ?? {}, opts),
  del: (url, opts) => request('DELETE', url, undefined, opts),
  upload: (url, formData) => request('POST', url, formData, { form: true }),
};

/** Trigger a browser download for an authenticated endpoint (blob, so the cookie rides along). */
export async function download(url, filenameHint) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    let message = `Download failed (${res.status})`;
    try {
      const body = await res.json();
      message = body?.error?.message || message;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, message);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') || '';
  const match = /filename="?([^"]+)"?/i.exec(disposition);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = match?.[1] || filenameHint || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/** Query string builder that drops empty values. */
export function qs(params) {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    usp.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const out = usp.toString();
  return out ? `?${out}` : '';
}

export function debounce(fn, ms = 260) {
  let timer = null;
  return (...args) =>
    new Promise((resolve, reject) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args).then(resolve, reject), ms);
    });
}

/** Load the shared vocabulary once; every screen reads its words from here. */
export async function loadMeta(force = false) {
  if (meta.data && !force) return meta.data;
  meta.data = await api.get('/api/meta');
  return meta.data;
}

export function statusInfo(code) {
  const entry = (meta.data?.tooling_statuses || []).find((s) => s.code === code);
  return entry || { code, label: code || 'unknown', color: '#64748b', dot: '⚪' };
}
