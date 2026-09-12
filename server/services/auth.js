/**
 * Authentication: bcrypt password hashing, stateless signed session cookie backed by a
 * `app_sessions` row (so sessions can be revoked), double-submit CSRF token and
 * permission loading. Session lookups are cached for a few seconds to keep the hot path
 * to one index lookup per request at most.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import config from '../config.js';
import db from '../db/index.js';
import { HttpError, unauthorized, forbidden } from '../lib/errors.js';

const sessionCache = new Map();
const SESSION_CACHE_MS = 5000;
const LOGIN_LOCK_AFTER = 8;
const LOGIN_LOCK_MINUTES = 10;

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sign = (payload) => crypto.createHmac('sha256', config.secret).update(payload).digest('base64url');
const timingSafeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
};

export function createToken(sessionId, expiresAt) {
  const payload = b64url(JSON.stringify({ s: sessionId, e: expiresAt }));
  return `${payload}.${sign(payload)}`;
}

export function readToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!timingSafeEqual(sig ?? '', sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.s || !data.e || new Date(data.e).getTime() < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

export const hashFor = (random) => crypto.createHash('sha256').update(`${config.secret}.${random}`).digest('hex');

export async function findUser(username) {
  return db.one('SELECT * FROM users WHERE username = ? AND is_active = 1', [username]);
}

export async function login({ username, password, ip, userAgent }) {
  const user = await db.one('SELECT * FROM users WHERE username = ?', [String(username || '').toLowerCase().trim()]);
  if (!user) {
    // constant-ish time: still run bcrypt against a dummy hash
    await bcrypt.compare(String(password || ''), '$2b$10$C6UzMDM.H6dfC/fBWZ5O0eYn6RqUxGNuXLUYxHnRQOZl0dy0k7SbG');
    throw unauthorized('Invalid username or password');
  }
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    throw new HttpError(423, `Account temporarily locked after repeated failed logins. Try again after ${user.locked_until}`);
  }
  if (!Number(user.is_active)) throw forbidden('Account is disabled - contact an administrator');
  const ok = await bcrypt.compare(String(password || ''), user.password_hash);
  if (!ok) {
    const failed = Number(user.failed_attempts || 0) + 1;
    const lock = failed >= LOGIN_LOCK_AFTER ? new Date(Date.now() + LOGIN_LOCK_MINUTES * 60000).toISOString().slice(0, 19).replace('T', ' ') : null;
    await db.run('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?', [failed, lock, user.id]);
    throw unauthorized(lock ? 'Account locked due to repeated failed logins' : 'Invalid username or password');
  }
  if (user.must_change_password && !/^\d+$/.test(String(password))) {
    // allow the first login but flag it so the UI forces a change
  }
  const expiresAt = new Date(Date.now() + config.session.ttlMs).toISOString().slice(0, 19).replace('T', ' ');
  const random = crypto.randomBytes(24).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(`${config.secret}.${random}`).digest('hex');
  const res = await db.run(
    'INSERT INTO app_sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES (?,?,?,?,?)',
    [tokenHash, user.id, ip ?? null, String(userAgent || '').slice(0, 255), expiresAt],
  );
  await db.run('UPDATE users SET failed_attempts=0, locked_until=NULL, last_login_at=NOW() WHERE id=?', [user.id]);
  const sessionId = res.insertId ?? 0;
  return {
    cookie: createToken(`${sessionId}.${tokenHash.slice(0, 16)}`, expiresAt),
    csrf: newCsrfToken(),
    sessionId,
    expiresAt,
    mustChangePassword: Number(user.must_change_password) === 1,
  };
}

/** Random per-login CSRF token, delivered in a JS-readable cookie and echoed in a header. */
export function newCsrfToken() {
  return crypto.randomBytes(16).toString('hex');
}

async function loadPermissions(roleId) {
  const rows = await db.all(
    `SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`,
    [roleId],
  );
  return new Set(rows.map((r) => r.code));
}

/**
 * Resolve the request user from the session cookie.
 * @returns {Promise<null|object>} request user object (no password hash)
 */
/** sha256("<secret>.<random>") derived from the signed cookie payload (no secret leak). */
export function sessionHashPrefix(token) {
  const data = readToken(token);
  if (!data) return { sessionId: null, hashPrefix: null };
  const [sessionId, hashPrefix] = String(data.s).split('.');
  return { sessionId: Number(sessionId), hashPrefix };
}

export async function resolveSession(req) {
  const token = req.cookies?.[config.session.cookieName];
  if (!token) return null;
  const data = readToken(token);
  if (!data) return null;
  const [sessionId, hashPrefix] = String(data.s).split('.');
  const cached = sessionCache.get(sessionId);
  if (cached && Date.now() - cached.at < SESSION_CACHE_MS) return cached.user;

  const session = await db.one('SELECT * FROM app_sessions WHERE id = ? AND revoked_at IS NULL', [Number(sessionId)]);
  if (!session) return null;
  if (!String(session.token_hash).startsWith(hashPrefix)) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) return null;
  const user = await db.one(
    `SELECT u.id, u.username, u.full_name, u.email, u.department, u.language, u.must_change_password, u.is_active, u.role_id,
            r.code AS role_code, r.name AS role_name
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.id = ? AND u.is_active = 1`,
    [session.user_id],
  );
  if (!user) return null;
  user.permissions = [...(await loadPermissions(user.role_id))];
  user.permissionsSet = user.permissions;
  user.is_active = Number(user.is_active ?? 1);
  user.sessionId = session.id;
  user.tokenHash = session.token_hash;
  user.expiresAt = session.expires_at;
  user.createdAt = session.created_at;
  // refresh last_seen without blocking the response
  db.run('UPDATE app_sessions SET last_seen_at = NOW() WHERE id = ?', [session.id]).catch(() => {});
  sessionCache.set(sessionId, { user, at: Date.now() });
  db.run('DELETE FROM app_sessions WHERE expires_at < DATE_SUB(NOW(), INTERVAL 7 DAY)').catch(() => {});
  return user;
}

export function invalidateSession(sessionId) {
  // the cache is keyed by the raw session id string, so drop every entry for this session
  for (const key of [...sessionCache.keys()]) {
    if (String(key) === String(sessionId) || String(key).startsWith(`${sessionId}.`)) sessionCache.delete(key);
  }
  return db.run('UPDATE app_sessions SET revoked_at = NOW() WHERE id = ?', [Number(sessionId)]);
}

export function invalidateUserSessions(userId) {
  for (const key of [...sessionCache.keys()]) sessionCache.delete(key);
  return db.run('UPDATE app_sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [Number(userId)]);
}

export async function setPassword(userId, newPassword) {
  if (String(newPassword).length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  const hash = await bcrypt.hash(String(newPassword), 10);
  await db.run('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = NOW() WHERE id = ?', [hash, userId]);
  await invalidateUserSessions(userId);
}

export async function changePassword(userId, currentPassword, newPassword) {
  const user = await db.one('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw unauthorized();
  if (user.must_change_password !== 1 && !(await bcrypt.compare(String(currentPassword || ''), user.password_hash))) {
    throw new HttpError(400, 'Current password is incorrect');
  }
  await setPassword(userId, newPassword);
}

export function sessionCookieOptions(maxAgeSeconds) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.session.secureCookies,
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

export function clearCache() {
  sessionCache.clear();
}
