/**
 * Prototype auth.
 *
 * Every user gets a random bearer token that is separate from their id.
 * Staff (volunteers and admins) get one only by logging in with a password
 * (and, for admins, the security key); their sessions expire. The
 * id is not secret — it appears in group member lists and alert records — so
 * it must never double as a credential. (Earlier versions used the id as the
 * token, which meant anyone who could see a member list could act as that
 * member.)
 *
 * Still NOT field-ready: tokens never expire and are stored in plain text.
 * Before real use, replace this with signed short-lived access tokens plus a
 * refresh token, and put phone OTP behind it. The rest of the codebase only
 * ever reads `req.user`, so that swap is local to this file.
 *
 * Guest is deliberately a real account, not a null user. Someone who never
 * receives an OTP still needs to be able to press the red button, and an SOS
 * from an anonymous device is still an SOS.
 */

import crypto from 'node:crypto';
import { find, all, update } from '../db/store.js';

export function mintToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Give any pilgrim created before tokens existed a token of their own. Staff
 * get theirs only by logging in.
 */
export function ensureTokens() {
  for (const user of all('users')) {
    if (!user.token && user.role === 'pilgrim') update('users', user.id, { token: mintToken() });
  }
}

/** What a client may see about a user: never the token or any password hash. */
export function publicUser(user) {
  if (!user) return null;
  const { token, tokenExpiresAt, passwordHash, ...rest } = user;
  return { ...rest, hasPassword: Boolean(passwordHash) };
}

/** How long a staff session lasts before logging in again. Pilgrims never expire: SOS must always work. */
export const STAFF_SESSION_HOURS = 12;

/**
 * Hand out a session token. Staff sessions expire; while one is still valid
 * a new login reuses it (so a volunteer's phone and laptop can both stay in)
 * and pushes the expiry forward.
 */
export function issueToken(user) {
  const staff = user.role === 'volunteer' || user.role === 'admin';
  const valid = user.token && (!user.tokenExpiresAt || Date.parse(user.tokenExpiresAt) > Date.now());
  const token = valid ? user.token : mintToken();
  update('users', user.id, {
    token,
    tokenExpiresAt: staff ? new Date(Date.now() + STAFF_SESSION_HOURS * 3_600_000).toISOString() : null,
    lastLoginAt: new Date().toISOString(),
  });
  return token;
}

export function revokeToken(user) {
  update('users', user.id, { token: null, tokenExpiresAt: null });
}

export function authenticate(req, _res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  let user = token ? find('users', (u) => u.token === token) : null;
  // Expired staff sessions, and staff who are pending, rejected or disabled,
  // are not signed in: a volunteer gets in only once an admin approves them.
  if (user?.tokenExpiresAt && Date.parse(user.tokenExpiresAt) <= Date.now()) user = null;
  if (user && user.role !== 'pilgrim' && (user.status ?? 'active') !== 'active') user = null;
  req.user = user;
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'sign_in_required' });
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'sign_in_required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'wrong_role', need: roles });
    }
    // A volunteer waiting for approval never sees alerts or a child's details.
    if (req.user.role !== 'pilgrim' && (req.user.status ?? 'active') !== 'active') {
      return res.status(403).json({ error: 'pending', message: 'Waiting for the control room to approve you.' });
    }
    next();
  };
}
