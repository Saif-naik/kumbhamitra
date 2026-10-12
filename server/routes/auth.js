import { Router } from 'express';
import { insert, find, filter, update, nextId } from '../db/store.js';
import { requireUser, mintToken, publicUser, issueToken, revokeToken } from '../lib/auth.js';
import { hashSecret, verifySecret, verifyAdminKey } from '../lib/secrets.js';
import { NODE_BY_ID } from '../../public/shared/mela-map.js';
import { limit } from '../lib/limit.js';
import { publish } from '../realtime.js';

/**
 * Accounts for the three kinds of people who use this:
 *
 *  - Pilgrims: guest first (no phone, no password — the SOS button must never
 *    sit behind a login), or an account with phone + PIN so the same identity
 *    works on another phone. A guest can turn into an account later and keep
 *    their group and history.
 *  - Volunteers: register with phone + password, skills and languages, then
 *    wait: they can log in only once an admin approves them in the volunteer
 *    queue, because a volunteer sees missing children's details and
 *    locations. (The security key lets a volunteer straight in — whoever
 *    holds it is already trusted.)
 *  - Admins: the security key is what lets you in. Any username and password
 *    may be used: the first sign-in with the key saves them, and after that
 *    the same pair is needed.
 *
 * Passwords and PINs are stored only as scrypt hashes (lib/secrets.js).
 * Wrong attempts are rate limited per account; error messages do not say
 * whether an account exists.
 */

const router = Router();

const LANGUAGES = ['hi', 'mr', 'en'];
const SKILLS = ['medical', 'first_aid', 'child_care', 'women_safety', 'general'];
const SPOKEN = ['hi', 'mr', 'en', 'ur', 'bho', 'ta', 'pa', 'bn', 'gu', 'te'];

const cleanName = (value, fallback) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || fallback;
const cleanLang = (value) => (LANGUAGES.includes(value) ? value : 'hi');
/** Indian mobile number: keep the last 10 digits. */
const cleanPhone = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
};
/** Usernames are free text, matched without regard to case or extra spaces. */
const cleanUsername = (value) => String(value ?? '').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 40);
const ADMIN_MIN_PASSWORD = 4;
const bad = (res, status, error, message) => res.status(status).json({ error, message });

// Guest sign-up is the path to the SOS button, so it must never turn a real
// person away. Behind a carrier NAT a whole crowd shares one IP; the ceiling
// is high enough to stop only a scripted flood.
const guestGuard = limit({ name: 'guest', windowMs: 10 * 60_000, max: Number(process.env.KM_GUEST_LIMIT) || 500, key: (req) => req.ip });

// Wrong passwords: per account (so one attacker cannot lock out a crowd
// behind the same IP), plus a generous per-IP ceiling.
const loginGuard = limit({
  name: 'login', windowMs: 15 * 60_000, max: 8,
  key: (req) => `${req.body?.role}:${cleanPhone(req.body?.phone) ?? cleanUsername(req.body?.username)}`,
  count: (_req, res) => res.statusCode === 401,
  message: 'Too many wrong attempts. Wait a few minutes and try again.',
});
const loginIpGuard = limit({
  name: 'login-ip', windowMs: 15 * 60_000, max: 200, key: (req) => req.ip,
  count: (_req, res) => res.statusCode === 401,
  message: 'Too many wrong attempts from this network. Wait a few minutes.',
});
// Every wrong admin sign-in might be a guess at the security key.
const adminLoginGuard = limit({
  name: 'admin-login', windowMs: 30 * 60_000, max: 10, key: (req) => req.ip,
  count: (_req, res) => res.statusCode === 401,
  message: 'Too many wrong attempts. The control room sign-in is locked for this network for a while.',
});
const adminOnly = (guard) => (req, res, next) => (req.body?.role === 'admin' ? guard(req, res, next) : next());
const keyLoginGuard = limit({
  name: 'key-login', windowMs: 30 * 60_000, max: 10, key: (req) => req.ip,
  count: (_req, res) => res.statusCode === 401,
  message: 'Too many wrong security keys. Wait a while before trying again.',
});
const registerGuard = limit({ name: 'register', windowMs: 10 * 60_000, max: 50, key: (req) => req.ip });
const adminKeyGuard = limit({
  name: 'admin-key', windowMs: 30 * 60_000, max: 5, key: (req) => req.ip,
  count: (_req, res) => res.statusCode === 401 || res.statusCode === 403,
  message: 'Too many wrong attempts. The admin area is locked for this network for a while.',
});

/**
 * Guest sign-in. No phone, no OTP, no SMS dependency.
 *
 * This is the primary path, not the fallback. During the event the cell towers
 * are congested precisely when the app is most needed, so an OTP that has to
 * arrive over SMS is a single point of failure sitting in front of the panic
 * button. A guest can do everything except recover their account on a new
 * handset — and can turn into a full account at any time.
 */
router.post('/guest', guestGuard, (req, res) => {
  const { displayName, language } = req.body ?? {};
  const user = insert('users', {
    id: nextId('usr'),
    displayName: cleanName(displayName, 'Guest'),
    role: 'pilgrim',
    language: cleanLang(language),
    guest: true,
    token: mintToken(),
    createdAt: new Date().toISOString(),
  });
  res.status(201).json({ token: user.token, user: publicUser(user) });
});

/**
 * Register a pilgrim or a volunteer.
 *
 * Pilgrim: phone + 4–6 digit PIN. If the request comes from a guest, the
 * guest account itself becomes the full account (same group, same alerts).
 * Volunteer: phone + password (8+), skills and languages; pending until the
 * control room approves.
 */
router.post('/register', registerGuard, async (req, res) => {
  const body = req.body ?? {};
  const role = body.role === 'volunteer' ? 'volunteer' : 'pilgrim';
  const phone = cleanPhone(body.phone);
  const password = String(body.password ?? '');
  if (!phone) return bad(res, 400, 'bad_phone', 'Enter a 10-digit mobile number.');

  if (role === 'pilgrim') {
    if (!/^\d{4,6}$/.test(password)) return bad(res, 400, 'bad_pin', 'Choose a PIN of 4 to 6 digits.');
    const taken = find('users', (u) => u.role === 'pilgrim' && u.phone === phone && u.id !== req.user?.id);
    if (taken) return bad(res, 409, 'phone_taken', 'This number already has an account. Log in instead.');
    const passwordHash = await hashSecret(password);
    // A guest saving their account keeps everything.
    if (req.user?.role === 'pilgrim' && req.user.guest) {
      update('users', req.user.id, {
        phone, passwordHash, guest: false,
        displayName: cleanName(body.displayName, req.user.displayName),
      });
      return res.json({ token: req.user.token, user: publicUser(find('users', (u) => u.id === req.user.id)), upgraded: true });
    }
    const user = insert('users', {
      id: nextId('usr'),
      displayName: cleanName(body.displayName, 'Pilgrim'),
      role: 'pilgrim',
      language: cleanLang(body.language),
      phone,
      passwordHash,
      guest: false,
      token: mintToken(),
      createdAt: new Date().toISOString(),
    });
    return res.status(201).json({ token: user.token, user: publicUser(user) });
  }

  // Volunteer
  if (password.length < 8) return bad(res, 400, 'weak_password', 'Use a password of at least 8 characters.');
  const name = cleanName(body.displayName, '');
  if (!name) return bad(res, 400, 'name_required', 'Enter your full name.');
  if (find('users', (u) => u.role === 'volunteer' && u.phone === phone)) {
    return bad(res, 409, 'phone_taken', 'This number is already registered. Log in, or ask the control room.');
  }
  const skills = (Array.isArray(body.skills) ? body.skills : []).filter((s) => SKILLS.includes(s));
  const languages = (Array.isArray(body.languages) ? body.languages : []).filter((l) => SPOKEN.includes(l));
  const user = insert('users', {
    id: nextId('vol'),
    displayName: name,
    role: 'volunteer',
    phone,
    passwordHash: await hashSecret(password),
    status: 'pending',
    org: cleanName(body.org, '') || null,
    skills: skills.length ? skills : ['general'],
    languages: languages.length ? languages : ['hi'],
    language: languages[0] ?? 'hi',
    onDuty: true,
    createdAt: new Date().toISOString(),
  });
  publish('staff', { event: 'volunteer_registered', id: user.id });
  // No session until the control room approves: a volunteer sees missing
  // children's details.
  res.status(201).json({ pending: true, user: publicUser(user) });
});

/** Log in as a pilgrim (phone + PIN), volunteer (phone + password) or admin (username + password + key). */
router.post('/login', loginIpGuard, adminOnly(adminLoginGuard), loginGuard, async (req, res) => {
  const body = req.body ?? {};
  const role = ['pilgrim', 'volunteer', 'admin'].includes(body.role) ? body.role : 'pilgrim';
  const wrong = () => bad(res, 401, 'wrong_credentials', role === 'admin'
    ? 'Username, password or security key is wrong.'
    : role === 'pilgrim' ? 'Phone number or PIN is wrong.' : 'Phone number or password is wrong.');

  if (role === 'admin') {
    // The security key is the gate. Without it nothing else is looked at.
    if (!(await verifyAdminKey(body.securityKey))) return wrong();
    const username = cleanUsername(body.username);
    const password = String(body.password ?? '');
    if (!username) return bad(res, 400, 'bad_username', 'Enter a username — any name you like.');
    if (password.length < ADMIN_MIN_PASSWORD) return bad(res, 400, 'weak_password', `Choose a password of at least ${ADMIN_MIN_PASSWORD} characters.`);
    let user = find('users', (u) => u.role === 'admin' && u.username === username);
    let created = false;
    if (!user) {
      // First time with this username: the key holder chooses their own login.
      user = insert('users', {
        id: nextId('adm'),
        displayName: cleanName(body.username, username),
        role: 'admin',
        username,
        passwordHash: await hashSecret(password),
        status: 'active',
        language: 'en',
        skills: [],
        languages: ['hi', 'en'],
        createdAt: new Date().toISOString(),
      });
      created = true;
    } else if (!(await verifySecret(password, user.passwordHash))) {
      return wrong();
    }
    if ((user.status ?? 'active') !== 'active') return bad(res, 403, 'disabled', 'This admin account is disabled.');
    return res.json({ token: issueToken(user), user: publicUser(find('users', (u) => u.id === user.id)), created });
  }

  const phone = cleanPhone(body.phone);
  const user = phone ? find('users', (u) => u.role === role && u.phone === phone) : null;
  if (!user || !(await verifySecret(body.password, user.passwordHash))) return wrong();
  if (role === 'volunteer') {
    const status = user.status ?? 'active';
    if (status === 'pending') return bad(res, 403, 'pending', 'Your registration is waiting for the control room to approve it. You can log in once it is approved.');
    if (status !== 'active') return bad(res, 403, 'disabled', 'This volunteer account is not active. Contact the control room.');
  }
  res.json({ token: issueToken(user), user: publicUser(find('users', (u) => u.id === user.id)) });
});

/**
 * Straight in with the security key — no registration, no password.
 *
 * The same key that guards the control room. Whoever holds it is trusted by
 * the control room, so a volunteer who signs in this way is active at once.
 * With a phone number, it is the same account every time (an existing
 * registration is signed in and approved); without one, the same name is.
 * Pilgrims get an account on this phone, like a guest with a name.
 */
router.post('/key-login', keyLoginGuard, async (req, res) => {
  const body = req.body ?? {};
  const role = body.role === 'volunteer' ? 'volunteer' : 'pilgrim';
  if (!(await verifyAdminKey(body.securityKey))) return bad(res, 401, 'bad_key', 'That security key is not correct.');
  const name = cleanName(body.displayName, '');
  const phone = cleanPhone(body.phone);
  // Just the key is enough. The phone remembers a random device id, so the
  // same phone is the same volunteer next time.
  const device = String(body.deviceId ?? '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64) || null;

  if (role === 'volunteer') {
    let user = phone
      ? find('users', (u) => u.role === 'volunteer' && u.phone === phone)
      : device
        ? find('users', (u) => u.role === 'volunteer' && u.keyDevice === device)
        : name ? find('users', (u) => u.role === 'volunteer' && u.viaKey && !u.phone && u.displayName.toLowerCase() === name.toLowerCase()) : null;
    if (user && user.status === 'disabled') return bad(res, 403, 'disabled', 'This volunteer account is disabled. Contact the control room.');
    if (!user) {
      const skills = (Array.isArray(body.skills) ? body.skills : []).filter((s) => SKILLS.includes(s));
      user = insert('users', {
        id: nextId('vol'),
        displayName: name || (phone ? `Volunteer ${phone.slice(-4)}` : `Volunteer ${filter('users', (u) => u.role === 'volunteer' && u.viaKey).length + 1}`),
        role: 'volunteer',
        phone,
        keyDevice: device,
        status: 'active',
        viaKey: true,
        org: null,
        skills: skills.length ? skills : ['general'],
        languages: ['hi'],
        language: 'hi',
        onDuty: true,
        createdAt: new Date().toISOString(),
      });
      publish('staff', { event: 'volunteer_registered', id: user.id });
    } else if (user.status !== 'active') {
      update('users', user.id, { status: 'active', reviewedAt: new Date().toISOString(), reviewedBy: 'security_key' });
    }
    return res.json({ token: issueToken(find('users', (u) => u.id === user.id)), user: publicUser(find('users', (u) => u.id === user.id)) });
  }

  const user = insert('users', {
    id: nextId('usr'),
    displayName: name || 'Pilgrim',
    role: 'pilgrim',
    language: cleanLang(body.language),
    guest: true,
    viaKey: true,
    token: mintToken(),
    createdAt: new Date().toISOString(),
  });
  res.status(201).json({ token: user.token, user: publicUser(user) });
});

/**
 * Create an admin account. Needs the admin security key — without it, nobody
 * can make themselves an admin.
 */
router.post('/admin/register', adminKeyGuard, async (req, res) => {
  const body = req.body ?? {};
  if (!(await verifyAdminKey(body.securityKey))) return bad(res, 403, 'bad_key', 'That security key is not correct.');
  const username = cleanUsername(body.username);
  if (!username) return bad(res, 400, 'bad_username', 'Enter a username — any name you like.');
  if (String(body.password ?? '').length < ADMIN_MIN_PASSWORD) return bad(res, 400, 'weak_password', `Choose a password of at least ${ADMIN_MIN_PASSWORD} characters.`);
  if (find('users', (u) => u.role === 'admin' && u.username === username)) return bad(res, 409, 'username_taken', 'That username is taken.');
  const user = insert('users', {
    id: nextId('adm'),
    displayName: cleanName(body.displayName, cleanName(body.username, username)),
    role: 'admin',
    username,
    passwordHash: await hashSecret(body.password),
    status: 'active',
    language: 'en',
    skills: [],
    languages: ['hi', 'en'],
    createdAt: new Date().toISOString(),
  });
  res.status(201).json({ token: issueToken(user), user: publicUser(find('users', (u) => u.id === user.id)) });
});

/** Check an admin key before showing the admin sign-up form (rate limited). */
router.post('/admin/check-key', adminKeyGuard, async (req, res) => {
  if (!(await verifyAdminKey(req.body?.securityKey))) return bad(res, 403, 'bad_key', 'That security key is not correct.');
  res.json({ ok: true });
});

router.post('/logout', requireUser, (req, res) => {
  // A guest who logs out cannot get back in, so their token is left alone and
  // only the phone forgets it. Accounts and staff lose the session.
  if (!(req.user.role === 'pilgrim' && req.user.guest)) revokeToken(req.user);
  res.json({ ok: true });
});

router.get('/me', requireUser, (req, res) => res.json({ user: publicUser(req.user) }));

router.patch('/me', requireUser, (req, res) => {
  const { displayName, language, nodeId } = req.body ?? {};
  const patch = {};
  if (displayName) patch.displayName = cleanName(displayName, req.user.displayName);
  if (LANGUAGES.includes(language)) patch.language = language;
  if (NODE_BY_ID[nodeId]) patch.nodeId = nodeId;
  res.json({ user: publicUser(update('users', req.user.id, patch)) });
});

export default router;
