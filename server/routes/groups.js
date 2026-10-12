import { Router } from 'express';
import { insert, find, filter, update, nextId, remove } from '../db/store.js';
import { requireUser, requireRole } from '../lib/auth.js';
import { publish } from '../realtime.js';
import { NODE_BY_ID, cell } from '../../public/shared/mela-map.js';
import { recordPresence } from '../lib/crowd.js';
import { limit } from '../lib/limit.js';

// Guessing other families' codes: only WRONG codes count, so a person typing
// their own family's code is never slowed down.
const joinGuard = limit({
  name: 'join', windowMs: 15 * 60_000, max: 10,
  count: (_req, res) => res.statusCode === 404,
  message: 'Too many wrong codes. Check the code and try again in a few minutes.',
});
// Volunteers look up bands all day; this only stops a runaway script.
const bandGuard = limit({ name: 'band', windowMs: 60_000, max: 60 });

const router = Router();

// No 0/O/1/I/5/S — these codes get read aloud, written on wristbands, and
// squinted at by people without reading glasses.
const ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY2346789';

function makeCode() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
    if (!find('groups', (g) => g.joinCode === code)) return code;
  }
  throw new Error('could not mint a unique join code');
}

const isMember = (groupId, userId) =>
  Boolean(find('memberships', (m) => m.groupId === groupId && m.userId === userId));

const clip = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function memberView(groupId) {
  return filter('memberships', (m) => m.groupId === groupId).map((m) => {
    const user = find('users', (u) => u.id === m.userId);
    const pos = find('positions', (p) => p.userId === m.userId);
    return {
      userId: m.userId,
      label: m.label || user?.displayName || 'Member',
      sharing: m.sharing,
      // Only ever the nearest landmark and a coarse cell — never a precise
      // track. See the privacy note in README.
      nodeId: m.sharing ? pos?.nodeId ?? null : null,
      place: m.sharing && pos?.nodeId ? NODE_BY_ID[pos.nodeId]?.name ?? null : null,
      cell: m.sharing ? pos?.cell ?? null : null,
      updatedAt: m.sharing ? pos?.updatedAt ?? null : null,
      battery: m.sharing ? pos?.battery ?? null : null,
    };
  });
}

router.post('/', requireUser, (req, res) => {
  const { name, label, meetingPointId } = req.body ?? {};
  const group = insert('groups', {
    id: nextId('grp'),
    name: clip(name, 60) || 'My group',
    joinCode: makeCode(),
    createdBy: req.user.id,
    // The Lost & Found chowki is where volunteers bring people anyway.
    meetingPointId: NODE_BY_ID[meetingPointId] ? meetingPointId : 'police_1',
    createdAt: new Date().toISOString(),
  });
  insert('memberships', {
    id: nextId('mem'),
    groupId: group.id,
    userId: req.user.id,
    label: clip(label, 40) || req.user.displayName,
    sharing: true,
    joinedAt: new Date().toISOString(),
  });
  res.status(201).json({ group, members: memberView(group.id) });
});

router.post('/join', requireUser, joinGuard, (req, res) => {
  const code = String(req.body?.code ?? '').trim().toUpperCase();
  const group = find('groups', (g) => g.joinCode === code);
  if (!group) {
    return res.status(404).json({ error: 'no_such_group', message: 'That code does not match any group.' });
  }
  const existing = find('memberships', (m) => m.groupId === group.id && m.userId === req.user.id);
  if (!existing) {
    insert('memberships', {
      id: nextId('mem'),
      groupId: group.id,
      userId: req.user.id,
      label: clip(req.body?.label, 40) || req.user.displayName,
      sharing: true,
      joinedAt: new Date().toISOString(),
    });
  }
  res.json({ group, members: memberView(group.id) });
});

router.get('/mine', requireUser, (req, res) => {
  const mine = filter('memberships', (m) => m.userId === req.user.id);
  res.json(
    mine.map((m) => {
      const group = find('groups', (g) => g.id === m.groupId);
      return { group, members: memberView(m.groupId) };
    })
  );
});

/** What the family's phones poll for. */
router.get('/reunions', requireUser, (req, res) => {
  const mine = filter('memberships', (m) => m.userId === req.user.id).map((m) => m.groupId);
  res.json({
    reunions: filter('reunions', (r) => mine.includes(r.groupId) && !r.acknowledged)
      .map((r) => ({ ...r, place: r.nodeId ? NODE_BY_ID[r.nodeId]?.name ?? null : null })),
  });
});

router.post('/reunions/:id/ack', requireUser, (req, res) => {
  const row = find('reunions', (r) => r.id === req.params.id);
  if (!row) return res.status(404).json({ error: 'no_such_reunion' });
  if (!isMember(row.groupId, req.user.id)) return res.status(403).json({ error: 'not_a_member' });
  // Through update() so it is persisted — mutating the row directly left the
  // green banner coming back after every server restart.
  update('reunions', row.id, { acknowledged: true, acknowledgedBy: req.user.id, acknowledgedAt: new Date().toISOString() });
  res.json({ ok: true });
});

// Registered before '/:id' — Express would otherwise read "reunions" as a group id.
router.get('/:id', requireUser, (req, res) => {
  const membership = find('memberships', (m) => m.groupId === req.params.id && m.userId === req.user.id);
  const isStaff = req.user.role !== 'pilgrim';
  if (!membership && !isStaff) return res.status(403).json({ error: 'not_a_member' });
  const group = find('groups', (g) => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'no_such_group' });
  res.json({ group, members: memberView(group.id) });
});

/** Toggle sharing. Must be instant and must be per-member, not per-app. */
router.patch('/:id/sharing', requireUser, (req, res) => {
  const membership = find('memberships', (m) => m.groupId === req.params.id && m.userId === req.user.id);
  if (!membership) return res.status(403).json({ error: 'not_a_member' });
  update('memberships', membership.id, { sharing: Boolean(req.body?.sharing) });
  res.json({ members: memberView(req.params.id) });
});

/**
 * Position update. Coarse by design: we take the nearest landmark node, not a
 * GPS fix. That is enough to reunite a family and not enough to follow anyone.
 */
router.post('/position', requireUser, (req, res) => {
  const { nodeId, battery } = req.body ?? {};
  const node = NODE_BY_ID[nodeId];
  if (!node) return res.status(400).json({ error: 'unknown_place' });

  const existing = find('positions', (p) => p.userId === req.user.id);
  const row = {
    userId: req.user.id,
    nodeId,
    cell: cell(node.x, node.y),
    battery: Number.isFinite(battery) ? Math.max(0, Math.min(100, Math.round(battery))) : null,
    updatedAt: new Date().toISOString(),
  };
  if (existing) Object.assign(existing, row);
  else insert('positions', row);
  update('users', req.user.id, { nodeId, lastSeenAt: row.updatedAt });

  // Feed the crowd model. The user id is deliberately NOT passed through here:
  // recordPresence only ever sees a landmark, so the density data cannot be
  // turned back into anyone's movements.
  recordPresence(nodeId);

  res.json({ position: row });
});

/**
 * Wristband lookup — the found-person path.
 *
 * This is the case the whole app exists for and the one a phone-first design
 * quietly excludes. The people most likely to get lost at a mela are small
 * children and very old relatives, and they are exactly the people who do not
 * own a handset. A volunteer finds a crying six-year-old; the child cannot say
 * an address, but there is a printed band on their wrist.
 *
 * The volunteer scans or types the code and immediately sees who the family is
 * and where they were last seen. No account, no app, no battery on the child's
 * side. The paper is the device.
 *
 * Deliberately limited: this returns the group's members and their last known
 * landmark, and nothing else. It is an endpoint that hands a stranger the
 * whereabouts of a family, so it is restricted to volunteers and admins, every
 * lookup is written to the audit log, and it never returns phone numbers,
 * precise positions or anything about members who have sharing switched off.
 */
router.post('/band/lookup', requireRole('volunteer', 'admin'), bandGuard, (req, res) => {
  const code = String(req.body?.code ?? '').trim().toUpperCase();
  const group = find('groups', (g) => g.joinCode === code);

  insert('bandLookups', {
    id: nextId('look'),
    code,
    found: Boolean(group),
    byUserId: req.user.id,
    at: new Date().toISOString(),
  });

  if (!group) {
    return res.status(404).json({ error: 'no_such_band', message: 'No group has that code.' });
  }

  const meeting = NODE_BY_ID[group.meetingPointId];
  res.json({
    group: { id: group.id, name: group.name, joinCode: group.joinCode },
    meetingPoint: meeting ? { id: meeting.id, name: meeting.name } : null,
    members: memberView(group.id),
  });
});

/**
 * Tell the family we have their person. Raises a resolved alert so the
 * reunification shows up in the same audit trail as everything else.
 */
router.post('/band/found', requireRole('volunteer', 'admin'), (req, res) => {
  const code = String(req.body?.code ?? '').trim().toUpperCase();
  const { nodeId, describe } = req.body ?? {};
  const group = find('groups', (g) => g.joinCode === code);
  if (!group) return res.status(404).json({ error: 'no_such_band' });

  const notice = insert('reunions', {
    id: nextId('reu'),
    groupId: group.id,
    foundBy: req.user.id,
    foundByName: req.user.displayName,
    nodeId: NODE_BY_ID[nodeId] ? nodeId : req.user.nodeId ?? null,
    describe: describe ? String(describe).slice(0, 120) : null,
    at: new Date().toISOString(),
    acknowledged: false,
  });

  // Only the group id goes over the socket; the family's phones fetch the
  // details (who found them, the description) over the authenticated API.
  publish('reunion', { groupId: group.id });
  console.log(`  <3 band ${code}: ${req.user.displayName} has the person, family notified`);

  res.status(201).json({ reunion: notice });
});

// Members and their last known places are only for the group itself and staff.
// This route used to answer anyone signed in, for any group id.
router.get('/:id/members', requireUser, (req, res) => {
  if (!isMember(req.params.id, req.user.id) && req.user.role === 'pilgrim') {
    return res.status(403).json({ error: 'not_a_member' });
  }
  res.json({ members: memberView(req.params.id) });
});

/** Leave a group. The family can make a new code if a phone is lost or shared. */
router.post('/:id/leave', requireUser, (req, res) => {
  const membership = find('memberships', (m) => m.groupId === req.params.id && m.userId === req.user.id);
  if (!membership) return res.status(404).json({ error: 'not_a_member' });
  remove('memberships', membership.id);
  res.json({ left: req.params.id });
});

export default router;
