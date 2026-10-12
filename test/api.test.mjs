/**
 * End-to-end API tests.
 *
 * Boots the real server on a spare port against a throwaway data file, so it
 * never touches your demo database. Run with `npm test`. Needs nothing beyond
 * Node 18+ and the two runtime dependencies.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3900 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = mkdtempSync(path.join(tmpdir(), 'km-test-'));

let server;
// Known credentials for the seeded staff, so tests can sign in like people do.
const CREDS = { KM_ADMIN_KEY: 'KM-TEST-TEST-TEST', KM_DEMO_PASSWORD: 'demo-pass-123', KM_ADMIN_PASSWORD: 'admin-pass-123' };

async function api(method, url, { token, body } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, headers: res.headers };
}

const guest = async (name = 'Test') => (await api('POST', '/api/auth/guest', { body: { displayName: name, language: 'en' } })).data;
const key = () => `test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

before(async () => {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), KM_DATA_FILE: path.join(DIR, 'data.json'), KM_QUIET: '1', ANTHROPIC_API_KEY: '', ...CREDS },
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

let staff;
const vol = (i = 0) => staff.filter((s) => s.role === 'volunteer')[i];
const admin = () => staff.find((s) => s.role === 'admin');
/** The control room gives an alert to a volunteer. */
const assign = (id, v) => api('POST', `/api/sos/${id}/assign`, { token: admin().token, body: { volunteerId: v.id } });

test('health and security headers', async () => {
  const { status, data, headers } = await api('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.match(headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('x-powered-by'), null);
  // The old demo endpoint that handed out every staff token is gone.
  assert.equal((await api('GET', '/api/auth/staff')).status, 404);
  staff = [];
  for (const phone of ['9000000001', '9000000002', '9000000003']) {
    const r = await api('POST', '/api/auth/login', { body: { role: 'volunteer', phone, password: CREDS.KM_DEMO_PASSWORD } });
    assert.equal(r.status, 200);
    staff.push({ ...r.data.user, token: r.data.token });
  }
  const a = await api('POST', '/api/auth/login', { body: { role: 'admin', username: 'admin', password: CREDS.KM_ADMIN_PASSWORD, securityKey: CREDS.KM_ADMIN_KEY } });
  assert.equal(a.status, 200);
  staff.push({ ...a.data.user, token: a.data.token });
  assert.ok(vol(2) && admin());
});

test('a guest token is a secret, not the user id', async () => {
  const g = await guest('  Asha   Devi  ');
  assert.ok(g.token.length >= 30);
  assert.notEqual(g.token, g.user.id);
  assert.equal(g.user.token, undefined, 'token must not be echoed inside the user object');
  assert.equal(g.user.displayName, 'Asha Devi');
  // The id alone no longer authenticates.
  assert.equal((await api('GET', '/api/auth/me', { token: g.user.id })).status, 401);
  assert.equal((await api('GET', '/api/auth/me', { token: g.token })).status, 200);
});

test('malformed JSON is a 400, not a 500', async () => {
  const res = await fetch(`${BASE}/api/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(res.status, 400);
});

test('ten presses with one key make one alert', async () => {
  const g = await guest();
  const k = key();
  const results = await Promise.all(Array.from({ length: 10 }, () =>
    api('POST', '/api/sos', { token: g.token, body: { idempotencyKey: k, kind: 'medical', nodeId: 'ghat_sangam' } })));
  const ids = new Set(results.map((r) => r.data.alert.id));
  assert.equal(ids.size, 1);
  assert.equal(results.filter((r) => r.status === 201).length, 1);
});

test('a junk raisedAt does not break the alert', async () => {
  const g = await guest();
  const { status, data } = await api('POST', '/api/sos', { token: g.token, body: { idempotencyKey: key(), raisedAt: 'yesterday-ish', relay: { hops: 9999 } } });
  assert.equal(status, 201);
  assert.ok(!Number.isNaN(Date.parse(data.alert.raisedAt)));
  assert.equal(data.alert.meshHops, 16);
});

test('only the control room assigns, and only the assigned volunteer acts', async () => {
  const g = await guest();
  const { data } = await api('POST', '/api/sos', { token: g.token, body: { idempotencyKey: key(), kind: 'lost_self', nodeId: 'gate_2' } });
  const id = data.alert.id;
  // Volunteers cannot see the whole queue, take an alert, or assign one.
  assert.equal((await api('GET', '/api/sos', { token: vol(0).token })).status, 403);
  assert.equal((await api('GET', '/api/sos/volunteers', { token: vol(0).token })).status, 403);
  assert.equal((await api('POST', `/api/sos/${id}/claim`, { token: vol(0).token })).status, 403);
  assert.equal((await api('POST', `/api/sos/${id}/assign`, { token: vol(0).token, body: { volunteerId: vol(0).id } })).status, 403);
  // The control room gives it to volunteer 0.
  const given = await assign(id, vol(0));
  assert.equal(given.status, 200);
  assert.equal(given.data.alert.claimedBy, vol(0).id);
  assert.ok(given.data.alert.timeline.some((e) => e.kind === 'assigned'));
  // It is on their task list and nobody else's.
  const mine = (await api('GET', '/api/sos/tasks?from=gate_2', { token: vol(0).token })).data.tasks;
  assert.ok(mine.some((t) => t.id === id && t.walkMinutes != null));
  assert.ok(!(await api('GET', '/api/sos/tasks', { token: vol(1).token })).data.tasks.some((t) => t.id === id));
  // Another volunteer cannot act on it.
  assert.equal((await api('POST', `/api/sos/${id}/beacon`, { token: vol(1).token })).status, 403);
  assert.equal((await api('POST', `/api/sos/${id}/resolve`, { token: vol(1).token })).status, 403);
  assert.equal((await api('POST', `/api/sos/${id}/release`, { token: vol(1).token })).status, 403);
  assert.equal((await api('POST', `/api/sos/${id}/heartbeat`, { token: vol(0).token })).status, 200);
  assert.equal((await api('POST', `/api/sos/${id}/release`, { token: vol(0).token })).status, 200);
});

test('a stranger cannot switch off someone else\'s beacon', async () => {
  const owner = await guest();
  const stranger = await guest();
  const { data } = await api('POST', '/api/sos', { token: owner.token, body: { idempotencyKey: key(), nodeId: 'ghat_ram' } });
  const id = data.alert.id;
  await assign(id, vol(0));
  assert.equal((await api('POST', `/api/sos/${id}/beacon`, { token: vol(0).token })).status, 200);
  assert.equal((await api('POST', `/api/sos/${id}/beacon/off`, { token: stranger.token })).status, 403);
  assert.equal((await api('POST', `/api/sos/${id}/beacon/off`, { token: owner.token })).status, 200);
  // Resolving twice is refused rather than rewriting the record.
  assert.equal((await api('POST', `/api/sos/${id}/resolve`, { token: vol(0).token })).status, 200);
  assert.equal((await api('POST', `/api/sos/${id}/resolve`, { token: vol(0).token })).status, 409);
});

test('group members are private to the group', async () => {
  const a = await guest('A');
  const outsider = await guest('Outsider');
  const { data } = await api('POST', '/api/groups', { token: a.token, body: { name: 'Fam', meetingPointId: 'nowhere' } });
  assert.equal(data.group.meetingPointId, 'police_1');
  assert.match(data.group.joinCode, /^[ACDEFGHJKLMNPQRTUVWXY2346789]{6}$/);
  assert.equal((await api('GET', `/api/groups/${data.group.id}/members`, { token: outsider.token })).status, 403);
  assert.equal((await api('GET', `/api/groups/${data.group.id}/members`, { token: a.token })).status, 200);
  assert.equal((await api('GET', `/api/groups/${data.group.id}/members`, { token: vol(0).token })).status, 200);
});

test('reunion acknowledgement is members-only and sticks', async () => {
  const a = await guest('Parent');
  const outsider = await guest();
  const { data } = await api('POST', '/api/groups', { token: a.token, body: { name: 'Fam' } });
  const found = await api('POST', '/api/groups/band/found', { token: vol(2).token, body: { code: data.group.joinCode, nodeId: 'police_1', describe: '<b>boy</b>, 8' } });
  assert.equal(found.status, 201);
  const id = found.data.reunion.id;
  assert.equal((await api('POST', `/api/groups/reunions/${id}/ack`, { token: outsider.token })).status, 403);
  assert.equal((await api('POST', `/api/groups/reunions/${id}/ack`, { token: a.token })).status, 200);
  const after = await api('GET', '/api/groups/reunions', { token: a.token });
  assert.equal(after.data.reunions.length, 0);
});

test('leaving a group removes the membership', async () => {
  const a = await guest();
  const { data } = await api('POST', '/api/groups', { token: a.token, body: {} });
  assert.equal((await api('POST', `/api/groups/${data.group.id}/leave`, { token: a.token })).status, 200);
  assert.deepEqual((await api('GET', '/api/groups/mine', { token: a.token })).data, []);
});

test('flags: unknown paths refused, clearing restores the baseline', async () => {
  const t = admin().token;
  assert.equal((await api('PUT', '/api/map/flags/e999', { token: t, body: { level: 4 } })).status, 404);
  assert.equal((await api('PUT', '/api/map/flags/e04', { token: t, body: { level: 9 } })).status, 400);
  assert.equal((await api('PUT', '/api/map/flags/e04', { token: t, body: { level: 4 } })).status, 200);
  let r = await api('GET', '/api/map/route?from=j_c&to=ghat_sangam&lang=en');
  assert.ok(!r.data.path.includes('j_river_c') || r.data.path.indexOf('ghat_sangam') !== r.data.path.indexOf('j_river_c') + 1);
  assert.equal((await api('DELETE', '/api/map/flags/e04', { token: t })).status, 200);
  const flags = (await api('GET', '/api/map/flags')).data.flags;
  assert.equal(flags.e04, undefined);
  r = await api('GET', '/api/map/route?from=j_river_c&to=ghat_sangam');
  assert.equal(r.data.ok, true);
  assert.equal(r.data.worst, 2, 'e04 is busy by default, not clear');
});

test('notices: validated, filled across languages, withdrawable', async () => {
  const t = admin().token;
  assert.equal((await api('POST', '/api/content/notices', { token: t, body: { body: {} } })).status, 400);
  assert.equal((await api('POST', '/api/content/notices', { token: vol(0).token, body: { body: { en: 'x' } } })).status, 403);
  const { status, data } = await api('POST', '/api/content/notices', { token: t, body: { severity: 'bogus', body: { en: 'Gate 3 closed', evil: 'x' } } });
  assert.equal(status, 201);
  assert.equal(data.notice.severity, 'info');
  assert.equal(data.notice.body.hi, 'Gate 3 closed');
  assert.equal(data.notice.body.evil, undefined);
  assert.equal((await api('DELETE', `/api/content/notices/${data.notice.id}`, { token: t })).status, 200);
  const list = (await api('GET', '/api/content/notices')).data.notices;
  assert.ok(!list.some((n) => n.id === data.notice.id));
});

test('the live socket never carries user ids, names or tokens', async () => {
  const g = await guest('Secret Name');
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const frames = [];
  await new Promise((resolve) => ws.on('open', resolve));
  ws.on('message', (raw) => frames.push(String(raw)));
  ws.send(JSON.stringify({ type: 'subscribe', topics: ['sos', 'beacon', 'junk-topic'] }));
  await new Promise((r) => setTimeout(r, 100));
  const { data } = await api('POST', '/api/sos', { token: g.token, body: { idempotencyKey: key(), kind: 'lost_person', subjectLabel: 'girl in red', nodeId: 'camp_b' } });
  await assign(data.alert.id, vol(0));
  await api('POST', `/api/sos/${data.alert.id}/beacon`, { token: vol(0).token });
  await new Promise((r) => setTimeout(r, 200));
  ws.close();

  const subscribed = JSON.parse(frames.find((f) => f.includes('"subscribed"')));
  assert.ok(!subscribed.topics.includes('junk-topic'));
  const live = frames.filter((f) => f.includes('"sos"') || f.includes('"beacon"')).join('\n');
  assert.ok(live.includes(data.alert.id), 'alert id should be announced');
  for (const secret of [g.token, g.user.id, 'Secret Name', 'girl in red']) {
    assert.ok(!live.includes(secret), `socket leaked ${secret}`);
  }
});

test('assistant uses the shared engine, with memory and the caller group', async () => {
  const { status, data } = await api('POST', '/api/assistant/ask', { body: { text: 'toilet kahan hai', lang: 'xx', from: 'j_c' } });
  assert.equal(status, 200);
  assert.equal(data.intent, 'nearest');
  assert.ok(data.actions.some((x) => x.type === 'navigate'));
  assert.equal(data.say, data.text);
  // Follow-up with the memory the phone sends back.
  const followUp = await api('POST', '/api/assistant/ask', { body: { text: 'how far', lang: 'en', from: 'j_c', memory: data.memory } });
  assert.equal(followUp.data.intent, 'distance');
  assert.equal(followUp.data.to, data.to);
  // Junk memory is ignored, not trusted.
  const junk = await api('POST', '/api/assistant/ask', { body: { text: 'how far', lang: 'en', memory: { lastPlace: '../../etc' } } });
  assert.equal(junk.data.intent, 'unknown');
  // Family comes from the caller's own group on the server.
  const parent = await guest('Parent');
  const { data: g } = await api('POST', '/api/groups', { token: parent.token, body: {} });
  const child = await guest('Chhotu');
  await api('POST', '/api/groups/join', { token: child.token, body: { code: g.group.joinCode, label: 'Chhotu' } });
  await api('POST', '/api/groups/position', { token: child.token, body: { nodeId: 'camp_c' } });
  const fam = await api('POST', '/api/assistant/ask', { token: parent.token, body: { text: 'where is chhotu', lang: 'en' } });
  assert.equal(fam.data.intent, 'family');
  assert.equal(fam.data.to, 'camp_c');
});

test('guessing group codes is slowed down, typing your own is not', async () => {
  const owner = await guest('Owner');
  const { data } = await api('POST', '/api/groups', { token: owner.token, body: {} });
  const guesser = await guest('Guesser');
  // A correct code is never counted against anyone.
  for (let i = 0; i < 12; i += 1) {
    assert.equal((await api('POST', '/api/groups/join', { token: guesser.token, body: { code: data.group.joinCode } })).status, 200);
  }
  const stranger = await guest('Stranger');
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await api('POST', '/api/groups/join', { token: stranger.token, body: { code: 'ZZZZZ' + i } })).status, 404);
  }
  const blocked = await api('POST', '/api/groups/join', { token: stranger.token, body: { code: 'ZZZZZZ' } });
  assert.equal(blocked.status, 429);
  assert.ok(blocked.data.retryAfter > 0);
});

test('the assistant is rate limited per user, and SOS never is', async () => {
  const chatty = await guest('Chatty');
  let last;
  for (let i = 0; i < 41; i += 1) {
    last = await api('POST', '/api/assistant/ask', { token: chatty.token, body: { text: 'toilet', lang: 'en' } });
  }
  assert.equal(last.status, 429);
  // Someone else is unaffected.
  const other = await guest('Other');
  assert.equal((await api('POST', '/api/assistant/ask', { token: other.token, body: { text: 'toilet', lang: 'en' } })).status, 200);
  // And the rate-limited person can still raise an alert.
  const sos = await api('POST', '/api/sos', { token: chatty.token, body: { idempotencyKey: key(), kind: 'medical', nodeId: 'gate_2' } });
  assert.equal(sos.status, 201);
});

test('the control room messages one volunteer, and only that volunteer sees it', async () => {
  const a = admin().token;
  // Volunteers cannot message each other: a volunteer always writes to the control room.
  const sent = await api('POST', '/api/messages', { token: a, body: { to: vol(0).id, text: '  Please go to   Gate 2 ' } });
  assert.equal(sent.status, 201);
  assert.equal(sent.data.message.text, 'Please go to Gate 2');
  const mine = (await api('GET', '/api/messages', { token: vol(0).token })).data;
  assert.ok(mine.messages.some((m) => m.text === 'Please go to Gate 2' && m.from === 'control'));
  assert.ok(mine.unread >= 1);
  assert.ok(!(await api('GET', '/api/messages', { token: vol(1).token })).data.messages.some((m) => m.text === 'Please go to Gate 2'));
  // Reply, and the control room sees one unread from that volunteer.
  assert.equal((await api('POST', '/api/messages', { token: vol(0).token, body: { text: 'On my way', to: vol(1).id } })).status, 201);
  assert.equal((await api('GET', '/api/messages', { token: a })).data.unread[vol(0).id], 1);
  assert.ok(!(await api('GET', '/api/messages', { token: vol(1).token })).data.messages.some((m) => m.text === 'On my way'), 'a reply never goes to another volunteer');
  await api('POST', '/api/messages/read', { token: a, body: { with: vol(0).id } });
  assert.equal((await api('GET', '/api/messages', { token: a })).data.unread[vol(0).id], undefined);
  // Pilgrims and strangers get nothing.
  const g = await guest();
  assert.equal((await api('GET', '/api/messages', { token: g.token })).status, 403);
  assert.equal((await api('POST', '/api/messages', { token: g.token, body: { to: vol(0).id, text: 'hi' } })).status, 403);
  assert.equal((await api('POST', '/api/messages', { token: a, body: { to: vol(0).id, text: '   ' } })).status, 400);
});

test('tasks for all volunteers: posted by the control room, picked up by anyone', async () => {
  const a = admin().token;
  assert.equal((await api('POST', '/api/messages/board', { token: vol(0).token, body: { title: 'x' } })).status, 403);
  const { data } = await api('POST', '/api/messages/board', { token: a, body: { title: 'Two people to Gate 3', nodeId: 'gate_3', needed: 2 } });
  const id = data.task.id;
  for (const v of [vol(0), vol(1)]) {
    assert.ok((await api('GET', '/api/messages/board', { token: v.token })).data.tasks.some((t) => t.id === id));
  }
  const help = await api('POST', `/api/messages/board/${id}/help`, { token: vol(1).token });
  assert.equal(help.data.helping, true);
  assert.equal(help.data.task.helpers.length, 1);
  // Tapping again takes it back.
  assert.equal((await api('POST', `/api/messages/board/${id}/help`, { token: vol(1).token })).data.helping, false);
  assert.equal((await api('POST', `/api/messages/board/${id}/done`, { token: a })).data.task.status, 'done');
  assert.equal((await api('POST', `/api/messages/board/${id}/help`, { token: vol(0).token })).status, 404);
  assert.equal((await api('DELETE', `/api/messages/board/${id}`, { token: a })).status, 200);
  const g = await guest();
  assert.equal((await api('GET', '/api/messages/board', { token: g.token })).status, 403);
});
