/** /api/auth — login, logout, me, password change, active sessions. */
import express from 'express';
import config from '../config.js';
import db from '../db/index.js';
import { asyncRoute, badRequest, unauthorized } from '../lib/errors.js';
import { validate, str } from '../lib/validate.js';
import { audit } from '../services/audit.js';
import { login, readToken, invalidateSession, invalidateUserSessions, changePassword, sessionCookieOptions, newCsrfToken } from '../services/auth.js';
import { requireAuth, requirePermission, clientIp } from '../middleware/index.js';

const router = express.Router();
const TOKEN_TTL_SECONDS = Math.floor(config.session.ttlMs / 1000);

router.post(
  '/login',
  asyncRoute(async (req, res) => {
    const { username, password } = validate(
      {
        username: [str, { required: true, max: 60, lower: true, trim: true }],
        password: [str, { required: true, max: 200 }],
      },
      { username: req.body?.username, password: req.body?.password },
    );
    const result = await login({ username, password: String(req.body?.password ?? ''), ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.cookie(config.session.cookieName, result.cookie, { ...sessionCookieOptions(TOKEN_TTL_SECONDS) });
    res.cookie(config.session.csrfCookieName, result.csrf, { ...sessionCookieOptions(TOKEN_TTL_SECONDS), httpOnly: false });
    await audit({ user: { id: null, username }, ip: clientIp(req), route: 'POST /api/auth/login' }, { action: 'login', entityType: 'session', entityLabel: username, summary: 'Signed in' });
    const me = await db.one(
      `SELECT u.id, u.username, u.full_name, u.email, u.department, u.language, u.must_change_password, r.code AS role_code, r.name AS role_name
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.username = ?`,
      [username],
    );
    const perms = await db.all(
      'SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id JOIN roles r ON r.id = rp.role_id WHERE r.code = ?',
      [me.role_code],
    );
    res.json({
      user: { ...me, permissions: perms.map((p) => p.code) },
      mustChangePassword: !!me.must_change_password,
      csrfToken: result.csrf,
      expiresAt: result.expiresAt,
    });
  }),
);

router.post(
  '/logout',
  asyncRoute(async (req, res) => {
    const data = readToken(req.cookies?.[config.session.cookieName]);
    if (data) {
      const sessionId = Number(String(data.s).split('.')[0]);
      if (sessionId) await invalidateSession(sessionId);
    }
    res.clearCookie(config.session.cookieName, { path: '/' });
    res.clearCookie(config.session.csrfCookieName, { path: '/' });
    res.json({ ok: true });
  }),
);

router.get(
  '/me',
  asyncRoute(async (req, res) => {
    if (!req.user) throw unauthorized('Not signed in');
    res.json({
      user: {
        id: req.user.id,
        username: req.user.username,
        full_name: req.user.full_name,
        email: req.user.email,
        department: req.user.department,
        language: req.user.language,
        must_change_password: req.user.must_change_password,
        role: req.user.role_code,
        role_name: req.user.role_name,
        permissions: [...req.user.permissions],
      },
    });
  }),
);

router.post(
  '/csrf',
  asyncRoute(async (req, res) => {
    const token = newCsrfToken();
    res.cookie(config.session.csrfCookieName, token, { ...sessionCookieOptions(TOKEN_TTL_SECONDS), httpOnly: false });
    res.json({ csrfToken: token });
  }),
);

router.put(
  '/password',
  requireAuth,
  asyncRoute(async (req, res) => {
    const { current_password, new_password } = validate(
      {
        current_password: [str, { max: 200 }],
        new_password: [str, { required: true, min: 8, max: 200 }],
      },
      req.body,
    );
    if (new_password.length < 8) throw badRequest('New password must be at least 8 characters');
    await changePassword(req.user.id, current_password, new_password);
    await audit(req.ctx, { action: 'password_change', entityType: 'user', entityId: req.user.id, entityLabel: req.user.username, summary: 'Password changed, other sessions revoked' });
    res.clearCookie(config.session.cookieName, { path: '/' });
    res.clearCookie(config.session.csrfCookieName, { path: '/' });
    res.json({ ok: true, message: 'Password updated - please sign in again' });
  }),
);

router.get(
  '/sessions',
  requireAuth,
  asyncRoute(async (req, res) => {
    const rows = await db.all(
      `SELECT s.id, s.created_at, s.expires_at, s.last_seen_at, s.ip, s.user_agent,
              (s.token_hash = ?) AS is_current
       FROM app_sessions s WHERE s.user_id = ? AND s.revoked_at IS NULL ORDER BY s.last_seen_at DESC LIMIT 30`,
      [req.user.tokenHash ?? '', req.user.id],
    );
    res.json({ items: rows });
  }),
);

router.delete(
  '/sessions/:id',
  requireAuth,
  asyncRoute(async (req, res) => {
    const sessionId = Number(req.params.id);
    const own = await db.one('SELECT id, user_id FROM app_sessions WHERE id = ?', [sessionId]);
    if (!own) throw badRequest('Session not found');
    if (own.user_id !== req.user.id && !req.user.permissions.has('*')) throw unauthorized('Not your session');
    await invalidateSession(sessionId);
    res.json({ ok: true });
  }),
);

export default router;
