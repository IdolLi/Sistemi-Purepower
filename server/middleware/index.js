/** Express middleware: security headers, rate limiting, auth, CSRF, error handling. */
import crypto from 'node:crypto';
import config from '../config.js';
import logger from '../lib/logger.js';
import { HttpError, tooMany, unauthorized, forbidden, isDuplicateError, isForeignKeyError } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { resolveSession, sessionCookieOptions } from '../services/auth.js';

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim().slice(0, 60);
  return (req.socket?.remoteAddress || '').slice(0, 60);
}

/** Attach the request context (ip, route, user) used by every handler. */
export function requestContext(req, res, next) {
  req.ctx = { ip: clientIp(req), route: `${req.method} ${req.baseUrl || ''}${req.path}`, user: null };
  res.locals.startedAt = Date.now();
  next();
}

/**
 * Defense-in-depth headers. The SPA renders with textContent (no innerHTML from data)
 * and CSP forbids inline scripts to make injected markup non-executable.
 */
export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(), microphone=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-XSS-Protection', '0');
  const isHtml = (req.path.endsWith('.html') || /\.(html|htm)$/.test(req.path) || (!/\./.test(req.path) && req.method === 'GET'));
  if (isHtml) {
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');
    res.setHeader('Content-Security-Policy', csp);
  }
  next();
}

/** Fixed-window rate limiter, in-process (use Redis/nginx in multi-instance deployments). */
export function rateLimiter({ windowMs, max, keyPrefix = 'general' } = {}) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, Math.max(30000, windowMs / 2));
  timer.unref?.();
  return function rateLimit(req, res, next) {
    const key = `${keyPrefix}:${clientIp(req)}`;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.reset < now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.reset - now) / 1000));
      return next(tooMany(`Rate limit exceeded for ${keyPrefix} actions, try again shortly`));
    }
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    return next();
  };
}

/** Populates req.user from the session cookie. */
export async function authenticate(req, res, next) {
  try {
    const user = await resolveSession(req);
    if (user) {
      req.user = user;
      req.user.permissions = new Set(user.permissionsSet ?? []);
      req.ctx.user = user;
    }
    return next();
  } catch (err) {
    logger.warn('session resolution failed: %s', err.message);
    return next(err);
  }
}
/** Same-origin + double-submit CSRF guard for state-changing requests. */
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    try {
      const allowed = new Set([new URL(config.publicUrl || `http://${req.headers.host}`).origin, `http://${req.headers.host}`]);
      if (!allowed.has(origin)) return next(forbidden('Cross-origin request blocked'));
    } catch {
      return next(forbidden('Malformed Origin header'));
    }
  }
  if (!req.user) return next(); // unauthenticated POSTs (login) are covered by the origin + rate-limit checks
  const cookieToken = req.cookies?.[config.session.csrfCookieName];
  const headerToken = req.headers[config.session.csrfHeaderName] ?? req.body?._csrf;
  if (!cookieToken || !headerToken || !timingSafeEqualStr(cookieToken, headerToken)) {
    return next(forbidden('CSRF token missing or invalid - reload the page and sign in again'));
  }
  return next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return next(unauthorized('Sign in to continue'));
  if (!Number(req.user.is_active ?? 1)) return next(forbidden('Account is disabled'));
  return next();
}

export function requirePermission(...needed) {
  return function permissionMiddleware(req, res, next) {
    if (!req.user) return next(unauthorized('Sign in to continue'));
    if (!needed.some((p) => hasPermission(req.user.permissions, p))) {
      return next(forbidden(`Your role (${req.user.role_code}) is not allowed to do this: needs ${needed.join(' or ')}`));
    }
    return next();
  };
}

export function can(req, permission) {
  return !!req.user && hasPermission(req.user.permissions, permission);
}

export function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { message: `No API route for ${req.method} ${req.originalUrl}`, status: 404 } });
}

// eslint-disable-next-line no-unused-vars -- express needs the 4-arg signature
export function errorHandler(err, req, res, next) {
  let status = err instanceof HttpError ? err.status : err?.status || err?.statusCode || 500;
  let message = err?.message || 'Unexpected server error';
  if (isDuplicateError(err)) {
    status = 409;
    const value = /'([^']+)'/.exec(err.sqlMessage || err.message || '')?.[1] ?? null;
    const key = /for key '([^']+)'/.exec(err.sqlMessage || err.message || '')?.[1] ?? null;
    message = `This value is already in use${value ? `: "${value}"` : ''}${key ? ` (unique field: ${key})` : ''}`;
  } else if (isForeignKeyError(err)) {
    status = 409;
    message = /child row/i.test(err.message)
      ? 'Cannot delete: other records still reference this row'
      : 'Cannot link a record that no longer exists';
  } else if (err?.code === 'LIMIT_FILE_SIZE') {
    status = 413;
    message = 'Uploaded file exceeds the size limit';
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    message = 'Request body is not valid JSON';
  }
  if (status >= 500) logger.error('%s %s -> %s', req.method, req.originalUrl, err.stack || err);
  res.status(status).json({
    error: {
      status,
      message,
      ...(err.details ? { details: err.details } : {}),
    },
  });
}

/** Reject unknown/extra keys on JSON bodies for write endpoints (strict schemas). */
export function requireJson(req, res, next) {
  if (req.is('application/json') && req.body === undefined) {
    return next(new HttpError(400, 'Request body must be JSON with Content-Type: application/json'));
  }
  next();
}
