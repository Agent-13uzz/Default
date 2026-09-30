'use strict';
const crypto = require('node:crypto');
const { getModule } = require('./modules');

const LEVELS = { none: 0, read: 1, write: 2, admin: 3 };

/**
 * Role based permission templates. Each role grants a level per tool group,
 * with optional per-module overrides. Admins can do everything, including
 * company-level administration (users, integrations, webhooks, API keys).
 */
const ROLES = {
  admin: {
    label: 'Company Admin',
    groups: { core: 'admin', project_management: 'admin', quality_safety: 'admin', financials: 'admin', preconstruction: 'admin', resource: 'admin' },
  },
  manager: {
    label: 'Project Manager',
    groups: { core: 'write', project_management: 'write', quality_safety: 'write', financials: 'write', preconstruction: 'write', resource: 'write' },
  },
  superintendent: {
    label: 'Superintendent',
    groups: { core: 'write', project_management: 'write', quality_safety: 'write', financials: 'read', preconstruction: 'read', resource: 'write' },
    modules: { budget: 'none', prime_contracts: 'none', invoices: 'none' },
  },
  subcontractor: {
    label: 'Subcontractor',
    groups: { core: 'read', project_management: 'read', quality_safety: 'write', financials: 'none', preconstruction: 'none', resource: 'none' },
    modules: { rfis: 'write', submittals: 'write', meetings: 'read', incidents: 'read', daily_logs: 'none', timesheets: 'write' },
  },
  viewer: {
    label: 'Read Only',
    groups: { core: 'read', project_management: 'read', quality_safety: 'read', financials: 'none', preconstruction: 'read', resource: 'read' },
  },
};

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function permissionFor(user, moduleKey) {
  if (!user) return 'none';
  const role = ROLES[user.role] || ROLES.viewer;
  const mod = getModule(moduleKey);
  if (!mod) return 'none';
  let level = (role.modules && role.modules[moduleKey]) || role.groups[mod.group] || 'none';
  // API keys with a read-only scope can never write.
  if (user.apiScope === 'read' && LEVELS[level] > LEVELS.read) level = 'read';
  return level;
}

function can(user, moduleKey, needed) {
  return LEVELS[permissionFor(user, moduleKey)] >= LEVELS[needed];
}

function permissionMatrix(user) {
  const { MODULES } = require('./modules');
  const out = {};
  for (const m of MODULES) out[m.key] = permissionFor(user, m.key);
  return out;
}

function createAuth(db) {
  const SESSION_DAYS = 14;

  function createSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, expires);
    return token;
  }

  function destroySession(token) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  function createApiKey(userId, name, scopes = 'read') {
    const key = `ks_live_${crypto.randomBytes(24).toString('base64url')}`;
    const info = db.prepare('INSERT INTO api_keys (name, prefix, key_hash, scopes, user_id) VALUES (?, ?, ?, ?, ?)')
      .run(name, key.slice(0, 12), sha256(key), scopes === 'write' ? 'write' : 'read', userId);
    return { id: Number(info.lastInsertRowid), key };
  }

  function userFromToken(token) {
    if (!token) return null;
    if (token.startsWith('ks_live_')) {
      const row = db.prepare(`SELECT u.*, k.scopes AS api_scope, k.id AS api_key_id FROM api_keys k
        JOIN users u ON u.id = k.user_id WHERE k.key_hash = ? AND u.active = 1`).get(sha256(token));
      if (!row) return null;
      db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.api_key_id);
      return publicUser(row, { apiScope: row.api_scope, viaApiKey: true });
    }
    const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`).get(sha256(token), new Date().toISOString());
    return row ? publicUser(row) : null;
  }

  function publicUser(row, extra = {}) {
    return { id: row.id, email: row.email, name: row.name, title: row.title, role: row.role, company_id: row.company_id, ...extra };
  }

  /** Express middleware – populates req.user or responds 401. */
  function authenticate(req, res, next) {
    const header = req.get('authorization') || '';
    let token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token && req.get('x-api-key')) token = req.get('x-api-key');
    // Allow token in query for GET-only resources such as file downloads and image previews.
    if (!token && req.method === 'GET' && req.query.access_token) token = String(req.query.access_token);
    const user = userFromToken(token);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    req.user = user;
    req.token = token;
    next();
  }

  function requireAdmin(req, res, next) {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Company admin permission required' });
    if (req.user.apiScope === 'read' && req.method !== 'GET') return res.status(403).json({ error: 'API key is read-only' });
    next();
  }

  function canAccessProject(user, projectId) {
    if (!user) return false;
    if (user.role === 'admin') return !!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
    return !!db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, user.id);
  }

  return { createSession, destroySession, createApiKey, userFromToken, authenticate, requireAdmin, canAccessProject, publicUser };
}

module.exports = { ROLES, LEVELS, hashPassword, verifyPassword, permissionFor, permissionMatrix, can, createAuth, sha256 };
