/**
 * Accounts and access: three kinds of people, three ways in.
 *
 * Its own server and data file, because the lockout tests deliberately trip
 * rate limits that would get in the way of the other suites.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4300 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = mkdtempSync(path.join(tmpdir(), 'km-auth-'));
const KEY = 'KM-AUTH-TEST-KEY1';
const DEMO = 'demo-pass-123';
const ADMIN = 'admin-pass-123';

let server;

async function api(method, url, { token, body } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const login = (body) => api('POST', '/api/auth/login', { body });
const adminLogin = () => login({ role: 'admin', username: 'admin', password: ADMIN, securityKey: KEY });

before(async () => {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), KM_DATA_FILE: path.join(DIR, 'data.json'), KM_QUIET: '1', ANTHROPIC_API_KEY: '',
      KM_ADMIN_KEY: KEY, KM_DEMO_PASSWORD: DEMO, KM_ADMIN_PASSWORD: ADMIN,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

after(() => {
  server?.kill();
  rmSync(DIR, { recursive: true, force: true });
});

test('the old open doors are shut', async () => {
  assert.equal((await api('GET', '/api/auth/staff')).status, 404);
  assert.equal((await api('POST', '/api/auth/otp/verify', { body: { phone: '9000000001', code: '123456' } })).status, 404);
});

test('the control room needs username, password and the security key', async () => {
  assert.equal((await login({ role: 'admin', username: 'admin', password: ADMIN })).status, 401);
  assert.equal((await login({ role: 'admin', username: 'admin', password: ADMIN, securityKey: 'KM-WRONG-WRONG-XX' })).status, 401);
  assert.equal((await login({ role: 'admin', username: 'admin', password: 'nope', securityKey: KEY })).status, 401);
  const ok = await adminLogin();
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.role, 'admin');
  assert.equal(ok.data.user.passwordHash, undefined);
  assert.equal(ok.data.user.token, undefined);
  // The same message whichever part was wrong.
  const a = await login({ role: 'admin', username: 'admin', password: ADMIN, securityKey: 'x' });
  const b = await login({ role: 'admin', username: 'admin', password: 'not-it', securityKey: KEY });
  assert.equal(a.data.message, b.data.message);
});

test('with the key, an admin can use any username and password — saved the first time', async () => {
  const mine = { role: 'admin', username: '  Saif Naik ', password: 'chai', securityKey: KEY };
  // Without the key, a new username gets nowhere and nothing is created.
  assert.equal((await login({ ...mine, securityKey: '' })).status, 401);
  const first = await login(mine);
  assert.equal(first.status, 200);
  assert.equal(first.data.created, true);
  assert.equal(first.data.user.displayName, 'Saif Naik');
  // Next time: same pair (any case and spacing of the username) works...
  const again = await login({ ...mine, username: 'saif   naik' });
  assert.equal(again.status, 200);
  assert.equal(again.data.created, false);
  assert.equal(again.data.user.id, first.data.user.id);
  // ...a different password for that username does not, even with the key.
  assert.equal((await login({ ...mine, password: 'coffee' })).status, 401);
  // And the key is still needed every time.
  assert.equal((await login({ ...mine, securityKey: 'KM-NOPE-NOPE-NOPE' })).status, 401);
  // Too-short passwords are refused rather than saved.
  assert.equal((await login({ ...mine, username: 'other', password: 'ab' })).status, 400);
});

test('nobody else reaches control-room endpoints', async () => {
  const guest = (await api('POST', '/api/auth/guest', { body: { displayName: 'G' } })).data;
  const vol = await login({ role: 'volunteer', phone: '9000000001', password: DEMO });
  assert.equal(vol.status, 200);
  assert.equal((await api('GET', '/api/staff/volunteers')).status, 401);
  assert.equal((await api('GET', '/api/staff/volunteers', { token: guest.token })).status, 403);
  assert.equal((await api('GET', '/api/staff/volunteers', { token: vol.data.token })).status, 403);
  assert.equal((await api('GET', '/api/staff/volunteers', { token: (await adminLogin()).data.token })).status, 200);
});

test('a new admin account needs the security key', async () => {
  const body = { displayName: 'Second', username: 'second', password: 'long-enough-pw' };
  assert.equal((await api('POST', '/api/auth/admin/register', { body })).status, 403);
  const made = await api('POST', '/api/auth/admin/register', { body: { ...body, securityKey: KEY } });
  assert.equal(made.status, 201);
  assert.equal(made.data.user.role, 'admin');
  assert.equal((await api('POST', '/api/auth/admin/register', { body: { ...body, securityKey: KEY } })).status, 409);
  assert.equal((await api('POST', '/api/auth/admin/register', { body: { ...body, username: 'third', password: 'abc', securityKey: KEY } })).status, 400);
});

test('a new volunteer cannot log in until an admin approves them', async () => {
  const reg = await api('POST', '/api/auth/register', {
    body: { role: 'volunteer', displayName: 'Nisha', phone: '+91 98111 22333', password: 'helping-hands', skills: ['first_aid'], languages: ['hi'] },
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.data.pending, true);
  assert.equal(reg.data.token, undefined, 'no session before approval');

  const creds = { role: 'volunteer', phone: '9811122333', password: 'helping-hands' };
  const waiting = await login(creds);
  assert.equal(waiting.status, 403);
  assert.equal(waiting.data.error, 'pending');
  assert.equal(waiting.data.token, undefined);

  const admin = (await adminLogin()).data.token;
  const list = (await api('GET', '/api/staff/volunteers', { token: admin })).data.volunteers;
  const nisha = list.find((v) => v.displayName === 'Nisha');
  assert.equal(nisha.status, 'pending');
  assert.equal(list[0].status, 'pending', 'pending requests are listed first');
  // Pending volunteers are not offered alerts.
  const roster = (await api('GET', '/api/sos/volunteers', { token: admin })).data;
  assert.ok(!JSON.stringify(roster).includes('Nisha'));

  assert.equal((await api('POST', `/api/staff/volunteers/${nisha.id}/approve`, { token: admin })).status, 200);
  assert.equal((await api('POST', `/api/staff/volunteers/${nisha.id}/approve`, { token: admin })).status, 409);
  // Approved: now they can log in and see their tasks.
  const ok = await login(creds);
  assert.equal(ok.status, 200);
  assert.equal((await api('GET', '/api/sos/tasks', { token: ok.data.token })).status, 200);

  // Disabling signs them out at once.
  assert.equal((await api('POST', `/api/staff/volunteers/${nisha.id}/disable`, { token: admin })).status, 200);
  assert.equal((await api('GET', '/api/auth/me', { token: ok.data.token })).status, 401);
  assert.equal((await login(creds)).data.error, 'disabled');

  assert.equal((await api('POST', `/api/staff/volunteers/${nisha.id}/enable`, { token: admin })).status, 200);
  assert.equal((await login(creds)).status, 200);
});

test('a rejected volunteer cannot sign in', async () => {
  await api('POST', '/api/auth/register', { body: { role: 'volunteer', displayName: 'Ravi', phone: '9822200000', password: 'password-1' } });
  const admin = (await adminLogin()).data.token;
  const ravi = (await api('GET', '/api/staff/volunteers', { token: admin })).data.volunteers.find((v) => v.displayName === 'Ravi');
  assert.equal((await api('POST', `/api/staff/volunteers/${ravi.id}/reject`, { token: admin })).status, 200);
  assert.equal((await login({ role: 'volunteer', phone: '9822200000', password: 'password-1' })).status, 403);
});

test('signing out ends a staff session', async () => {
  const { token } = (await login({ role: 'volunteer', phone: '9000000002', password: DEMO })).data;
  assert.equal((await api('GET', '/api/auth/me', { token })).status, 200);
  assert.equal((await api('POST', '/api/auth/logout', { token })).status, 200);
  assert.equal((await api('GET', '/api/auth/me', { token })).status, 401);
});

test('pilgrims: register with phone and PIN, then log in on another phone', async () => {
  const reg = await api('POST', '/api/auth/register', { body: { role: 'pilgrim', displayName: 'Kamla', phone: '9700000001', password: '4821' } });
  assert.equal(reg.status, 201);
  assert.equal(reg.data.user.guest, false);
  assert.equal((await api('POST', '/api/auth/register', { body: { role: 'pilgrim', phone: '9700000001', password: '1111' } })).status, 409);
  assert.equal((await api('POST', '/api/auth/register', { body: { role: 'pilgrim', phone: '9700000002', password: 'abcd' } })).status, 400);
  assert.equal((await login({ role: 'pilgrim', phone: '9700000001', password: '0000' })).status, 401);
  const again = await login({ role: 'pilgrim', phone: '9700000001', password: '4821' });
  assert.equal(again.status, 200);
  assert.equal(again.data.user.id, reg.data.user.id);
  // A pilgrim number does not open the volunteer door.
  assert.equal((await login({ role: 'volunteer', phone: '9700000001', password: '4821' })).status, 401);
});

test('a guest who saves their account keeps their family group', async () => {
  const g = (await api('POST', '/api/auth/guest', { body: { displayName: 'Mohan' } })).data;
  const group = (await api('POST', '/api/groups', { token: g.token, body: { name: 'Mohan family' } })).data;
  const saved = await api('POST', '/api/auth/register', { token: g.token, body: { role: 'pilgrim', phone: '9700000099', password: '2468' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.upgraded, true);
  assert.equal(saved.data.user.id, g.user.id);
  const other = (await login({ role: 'pilgrim', phone: '9700000099', password: '2468' })).data;
  assert.equal(other.user.id, g.user.id);
  const id = group.group?.id;
  if (id) assert.equal((await api('GET', `/api/groups/${id}/members`, { token: other.token })).status, 200);
});

test('the security key signs a volunteer or pilgrim straight in, no registration', async () => {
  // Wrong key: nothing.
  assert.equal((await api('POST', '/api/auth/key-login', { body: { role: 'volunteer', displayName: 'Meera', securityKey: 'KM-NOPE' } })).status, 401);
  // Right key: an active volunteer at once — tasks, not a waiting room.
  const v = await api('POST', '/api/auth/key-login', { body: { role: 'volunteer', displayName: 'Meera', phone: '9833300001', securityKey: KEY } });
  assert.equal(v.status, 200);
  assert.equal(v.data.user.role, 'volunteer');
  assert.equal(v.data.user.status, 'active');
  assert.equal((await api('GET', '/api/sos/tasks', { token: v.data.token })).status, 200);
  // ...but still not the control room's queue.
  assert.equal((await api('GET', '/api/sos', { token: v.data.token })).status, 403);
  // Same phone next time: the same account.
  const again = await api('POST', '/api/auth/key-login', { body: { role: 'volunteer', displayName: 'Meera J', phone: '9833300001', securityKey: KEY } });
  assert.equal(again.data.user.id, v.data.user.id);
  // A pending registration that uses the key is approved by it.
  await api('POST', '/api/auth/register', { body: { role: 'volunteer', displayName: 'Waiting Wali', phone: '9833300002', password: 'password-9' } });
  const w = await api('POST', '/api/auth/key-login', { body: { role: 'volunteer', phone: '9833300002', securityKey: KEY } });
  assert.equal(w.data.user.status, 'active');
  // Pilgrims too.
  const p = await api('POST', '/api/auth/key-login', { body: { role: 'pilgrim', displayName: 'Devi', securityKey: KEY } });
  assert.equal(p.status, 201);
  assert.equal(p.data.user.role, 'pilgrim');
  assert.equal((await api('POST', '/api/sos', { token: p.data.token, body: { idempotencyKey: `k-${Date.now()}`, kind: 'other', nodeId: 'gate_2' } })).status, 201);
});

test('just the key: the same phone is the same volunteer', async () => {
  const one = await api('POST', '/api/auth/key-login', { body: { role: 'volunteer', securityKey: KEY, deviceId: 'phone-aaa' } });
  assert.equal(one.status, 200);
  assert.match(one.data.user.displayName, /^Volunteer \d+$/);
  const again = await api('POST', '/api/auth/key-login', { body: { role: 'volunteer', securityKey: KEY, deviceId: 'phone-aaa' } });
  assert.equal(again.data.user.id, one.data.user.id);
  const other = await api('POST', '/api/auth/key-login', { body: { role: 'volunteer', securityKey: KEY, deviceId: 'phone-bbb' } });
  assert.notEqual(other.data.user.id, one.data.user.id);
  assert.equal((await api('POST', '/api/auth/key-login', { body: { role: 'volunteer', securityKey: 'nope', deviceId: 'phone-aaa' } })).status, 401);
  const pilgrim = await api('POST', '/api/auth/key-login', { body: { role: 'pilgrim', securityKey: KEY } });
  assert.equal(pilgrim.status, 201);
});

test('wrong passwords lock that account, not everyone', async () => {
  const wrong = { role: 'volunteer', phone: '9000000003', password: 'guess' };
  let last;
  for (let i = 0; i < 9; i += 1) last = await login(wrong);
  assert.equal(last.status, 429);
  // Even the right password waits now.
  assert.equal((await login({ ...wrong, password: DEMO })).status, 429);
  // Another volunteer on the same network is unaffected.
  assert.equal((await login({ role: 'volunteer', phone: '9000000004', password: DEMO })).status, 200);
});

test('guessing the security key locks the admin sign-up', async () => {
  let last;
  for (let i = 0; i < 7; i += 1) last = await api('POST', '/api/auth/admin/check-key', { body: { securityKey: `KM-GUES-S${i}` } });
  assert.equal(last.status, 429);
  assert.equal((await api('POST', '/api/auth/admin/check-key', { body: { securityKey: KEY } })).status, 429);
});

test('the key works however a phone types it: lowercase, spaces, long dashes', async () => {
  // KEY is KM-AUTH-TEST-KEY1.
  const typed = ['km-auth-test-key1', ' KM-AUTH-TEST-KEY1 ', 'KM–AUTH—TEST‑KEY1', 'km auth-test-key1'.replace(' ', '-'), '"KM-AUTH-TEST-KEY1"'];
  for (const securityKey of typed) {
    assert.equal((await api('POST', '/api/auth/key-login', { body: { role: 'pilgrim', securityKey } })).status, 201, securityKey);
  }
  assert.equal((await api('POST', '/api/auth/key-login', { body: { role: 'volunteer', securityKey: 'km-auth-test-key1', deviceId: 'phone-typed' } })).status, 200);
  assert.equal((await login({ role: 'admin', username: 'admin', password: ADMIN, securityKey: ' km–auth-test-key1' })).status, 200);
  // The letters and numbers still have to be right.
  assert.equal((await api('POST', '/api/auth/key-login', { body: { role: 'pilgrim', securityKey: 'KM-AUTH-TEST-KEY2' } })).status, 401);
  assert.equal((await api('POST', '/api/auth/key-login', { body: { role: 'pilgrim', securityKey: 'KMAUTHTESTKEY1' } })).status, 401);
});
