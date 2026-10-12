/**
 * The SOS path.
 *
 * Rules this file exists to enforce:
 *
 *  1. An alert is never lost and never duplicated. The device mints an
 *     idempotency key BEFORE it touches the network, so a retry after a
 *     timeout — or ten panicked presses — resolves to one alert.
 *  2. Every state change is appended to sos_events and nothing is ever
 *     rewritten. If a family asks what happened, there is an answer.
 *  3. A claim expires. Two volunteers running to the same person while a third
 *     alert goes unread is the failure mode that kills this feature, so a
 *     claim that goes quiet returns to the queue automatically.
 *  4. Nothing here depends on the assistant, the map tiles, or the sync layer.
 */

import { Router } from 'express';
import { insert, find, filter, update, nextId, all } from '../db/store.js';
import { requireUser, requireRole } from '../lib/auth.js';
import { NODE_BY_ID } from '../../public/shared/mela-map.js';
import { route } from '../../public/shared/routing.js';
import { edgeFlags } from '../db/store.js';
import { publish } from '../realtime.js';

const router = Router();

const CLAIM_MINUTES = 10;
/** An assigned task waits longer: the volunteer has to see it and get moving. */
const ASSIGN_MINUTES = 20;
const KINDS = ['lost_person', 'lost_self', 'medical', 'crowd_crush', 'other'];

/** Which training actually helps, per kind of emergency. */
const SKILL_FOR_KIND = {
  medical: ['medical', 'first_aid'],
  crowd_crush: ['medical', 'first_aid'],
  lost_person: ['child_care', 'women_safety'],
  lost_self: ['general'],
  other: ['general'],
};

/**
 * Find-me colours.
 *
 * "I am at Sangam Ghat" is useless when Sangam Ghat has forty thousand people
 * standing shoulder to shoulder. So when a volunteer gets close, the lost
 * person's phone fills the screen with one saturated colour and they hold it
 * up; the volunteer is told to look for that colour. A bright rectangle held
 * overhead is visible across a crowd in a way a face is not.
 *
 * Six colours, chosen to stay distinguishable in daylight and to survive the
 * most common colour blindness — no red/green pair, and each has a distinct
 * lightness so they differ even in greyscale. A name in the local language goes
 * with each, because the volunteer has to say it out loud.
 */
const BEACON_COLOURS = [
  { id: 'blue',    hex: '#1B52C4', hi: 'नीला',  mr: 'निळा',  en: 'Blue' },
  { id: 'orange',  hex: '#F2731F', hi: 'नारंगी', mr: 'नारिंगी', en: 'Orange' },
  { id: 'white',   hex: '#FFFFFF', hi: 'सफ़ेद',  mr: 'पांढरा', en: 'White' },
  { id: 'magenta', hex: '#C21E7A', hi: 'गुलाबी', mr: 'गुलाबी', en: 'Pink' },
  { id: 'yellow',  hex: '#FFD119', hi: 'पीला',  mr: 'पिवळा', en: 'Yellow' },
  { id: 'black',   hex: '#101010', hi: 'काला',  mr: 'काळा',  en: 'Black' },
];

function logEvent(alertId, kind, actorId, detail = {}) {
  return insert('alertEvents', {
    id: nextId('evt'),
    alertId,
    kind,
    actorId: actorId ?? null,
    detail,
    at: new Date().toISOString(),
  });
}

/**
 * Tell connected screens that an alert changed.
 *
 * The socket fans out to every connected client, pilgrims included, so the
 * frame carries only what a screen needs to decide whether to re-fetch: no
 * names, phone numbers, places or user ids. Volunteers and the control room
 * pull the full record over the authenticated API.
 */
function announce(event, alert) {
  publish('sos', { event, alertId: alert.id, status: alert.status, kind: alert.kind });
}

function expand(alert) {
  const raiser = find('users', (u) => u.id === alert.userId);
  const claimer = alert.claimedBy ? find('users', (u) => u.id === alert.claimedBy) : null;
  const group = alert.groupId ? find('groups', (g) => g.id === alert.groupId) : null;
  return {
    ...alert,
    place: alert.nodeId ? NODE_BY_ID[alert.nodeId]?.name ?? null : null,
    raiserName: raiser?.displayName ?? 'Unknown',
    raiserPhone: raiser?.phone ?? null,
    claimerName: claimer?.displayName ?? null,
    groupName: group?.name ?? null,
    groupCode: group?.joinCode ?? null,
    timeline: filter('alertEvents', (e) => e.alertId === alert.id).sort((a, b) => a.at.localeCompare(b.at)),
  };
}

/** Raise an alert. This is the one endpoint that must never be clever. */
router.post('/', requireUser, (req, res) => {
  const { idempotencyKey, kind = 'lost_self', note, subjectLabel, nodeId, groupId, raisedAt, relay } = req.body ?? {};

  if (!idempotencyKey || String(idempotencyKey).length < 8 || String(idempotencyKey).length > 80) {
    return res.status(400).json({ error: 'idempotency_key_required' });
  }

  const existing = find('alerts', (a) => a.idempotencyKey === idempotencyKey);
  if (existing) {
    // A retry, not a new emergency. Reply 200 with the same alert so the device
    // can stop retrying and show a true "sent" state.
    return res.json({ alert: expand(existing), duplicate: true });
  }

  // Only attach a group the raiser actually belongs to — the group's band code
  // is shown to volunteers on the alert card.
  const ownGroup = groupId && find('memberships', (m) => m.groupId === groupId && m.userId === req.user.id);
  // A device clock can be wrong or the field can be junk; never let it break
  // the timeline sort.
  const raisedTime = Date.parse(raisedAt);
  const raisedIso = Number.isFinite(raisedTime) ? new Date(raisedTime).toISOString() : null;

  const alert = insert('alerts', {
    id: nextId('sos'),
    idempotencyKey: String(idempotencyKey),
    userId: req.user.id,
    groupId: ownGroup ? groupId : null,
    kind: KINDS.includes(kind) ? kind : 'other',
    note: note ? String(note).slice(0, 400) : null,
    subjectLabel: subjectLabel ? String(subjectLabel).slice(0, 80) : null,
    nodeId: NODE_BY_ID[nodeId] ? nodeId : req.user.nodeId ?? null,
    status: 'open',
    claimedBy: null,
    claimedAt: null,
    claimExpiresAt: null,
    resolvedAt: null,
    resolution: null,
    suspect: Boolean(req.sosSuspect),
    meshHops: Math.max(0, Math.min(Number(relay?.hops) || 0, 16)),
    beacon: null,
    raisedAt: raisedIso ?? new Date().toISOString(),
    receivedAt: new Date().toISOString(),
  });

  req.sosBudget?.spend();

  if (raisedIso && raisedIso !== alert.receivedAt) {
    logEvent(alert.id, 'queued_on_device', req.user.id, { raisedAt: raisedIso });
  }

  // If this alert reached us by hopping across other people's phones rather
  // than over the network, that fact belongs in the record — both because it
  // explains a delay and because it tells the control room the tower in that
  // sector is not working.
  if (alert.meshHops) {
    logEvent(alert.id, 'relayed_via_mesh', null, {
      hops: alert.meshHops,
      carriedBy: relay.carriedBy ?? null,
      originOffline: true,
    });
    console.log(`  ~> SOS ${alert.id} arrived via ${alert.meshHops} phone hop(s), origin had no network`);
  }

  logEvent(alert.id, 'received', req.user.id, { kind: alert.kind, nodeId: alert.nodeId });

  announce('created', alert);
  console.log(`  !! SOS ${alert.id} (${alert.kind}) from ${req.user.displayName}`);

  res.status(201).json({ alert: expand(alert), duplicate: false });
});

/**
 * Only the volunteer on a task (or the control room) may act on it. A
 * volunteer sees and touches nothing but what they were given.
 */
function ownsTask(req, alert) {
  return req.user.role === 'admin' || alert.claimedBy === req.user.id;
}
const notYours = (res) => res.status(403).json({ error: 'not_your_task', message: 'This task is not assigned to you.' });

/** Walking time and training fit for one alert, from where someone stands. */
function decorate(a, fromId, user) {
  const full = expand(a);
  if (a.nodeId) {
    const r = route(fromId, a.nodeId, { flags: edgeFlags() });
    full.walkMinutes = r.ok ? r.minutes : null;
    full.walkMetres = r.ok ? r.metres : null;
  }
  const wanted = SKILL_FOR_KIND[a.kind] ?? ['general'];
  full.neededSkills = wanted;
  full.skillMatch = wanted.some((s) => (user.skills ?? []).includes(s));
  return full;
}

/**
 * A volunteer's own tasks: what the control room assigned them, plus what
 * they finished in the last twelve hours.
 */
router.get('/tasks', requireRole('volunteer', 'admin'), (req, res) => {
  const fromId = NODE_BY_ID[req.query.from] ? req.query.from : req.user.nodeId || 'j_c';
  const since = Date.now() - 12 * 3_600_000;
  const rows = filter('alerts', (a) => a.claimedBy === req.user.id && (
    a.status === 'claimed' || (a.status === 'resolved' && Date.parse(a.resolvedAt ?? 0) > since)
  )).map((a) => decorate(a, fromId, req.user))
    .sort((a, b) => (a.status === b.status ? (b.assignedAt ?? b.claimedAt ?? '').localeCompare(a.assignedAt ?? a.claimedAt ?? '') : a.status === 'claimed' ? -1 : 1));
  res.json({ tasks: rows, from: fromId });
});

/** The dispatch queue — the control room's alone. Open first, then training fit and walking time. */
router.get('/', requireRole('admin'), (req, res) => {
  const fromId = req.query.from || req.user.nodeId || 'j_c';
  const flags = edgeFlags();
  const statuses = String(req.query.status ?? 'open,claimed').split(',');
  const mySkills = req.user.skills ?? [];
  const myLanguages = req.user.languages ?? [req.user.language];

  const rows = filter('alerts', (a) => statuses.includes(a.status)).map((a) => {
    const full = expand(a);
    if (a.nodeId) {
      const r = route(fromId, a.nodeId, { flags });
      full.walkMinutes = r.ok ? r.minutes : null;
      full.walkMetres = r.ok ? r.metres : null;
    }

    const wanted = SKILL_FOR_KIND[a.kind] ?? ['general'];
    full.neededSkills = wanted;
    full.skillMatch = wanted.some((s) => mySkills.includes(s));

    // Does anyone on duty actually have the right training for this? If not,
    // the console says so rather than quietly letting it sit in a queue.
    const raiser = find('users', (u) => u.id === a.userId);
    full.raiserLanguage = raiser?.language ?? null;
    full.languageMatch = raiser?.language ? myLanguages.includes(raiser.language) : true;

    return full;
  });

  rows.sort((a, b) => {
    const rank = { open: 0, claimed: 1, resolved: 2, cancelled: 3 };
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];

    // Skill match outranks urgency, and that ordering is deliberate.
    // This list answers "what should I do next", personally. Putting a cardiac
    // arrest at the top of a child-protection volunteer's screen does not get
    // anyone to the patient faster — it just spends the attention of the one
    // person who could have reached the lost child. The control room still
    // sees every alert ranked by urgency alone.
    if (a.skillMatch !== b.skillMatch) return a.skillMatch ? -1 : 1;

    const urgency = { crowd_crush: 0, medical: 1, lost_person: 2, lost_self: 3, other: 4 };
    if (urgency[a.kind] !== urgency[b.kind]) return urgency[a.kind] - urgency[b.kind];

    if (a.languageMatch !== b.languageMatch) return a.languageMatch ? -1 : 1;

    return (a.walkMinutes ?? 999) - (b.walkMinutes ?? 999);
  });

  res.json({ alerts: rows, from: fromId, you: { skills: mySkills, languages: myLanguages } });
});

/** Who is on duty, what they are trained in, and whether they are free. */
router.get('/volunteers', requireRole('admin'), (_req, res) => {
  const busy = new Set(filter('alerts', (a) => a.status === 'claimed').map((a) => a.claimedBy));
  res.json({
    volunteers: filter('users', (u) => u.role === 'volunteer' && (u.status ?? 'active') === 'active').map((u) => ({
      id: u.id,
      displayName: u.displayName,
      org: u.org ?? null,
      phone: u.phone ?? null,
      skills: u.skills ?? [],
      languages: u.languages ?? [],
      nodeId: u.nodeId ?? null,
      place: u.nodeId ? NODE_BY_ID[u.nodeId]?.name ?? null : null,
      busy: busy.has(u.id),
    })),
  });
});

/** What the person who pressed the button can see about their own alerts. */
router.get('/mine', requireUser, (req, res) => {
  res.json({
    alerts: filter('alerts', (a) => a.userId === req.user.id)
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .map(expand),
  });
});

router.get('/:id', requireUser, (req, res) => {
  const alert = find('alerts', (a) => a.id === req.params.id);
  if (!alert) return res.status(404).json({ error: 'no_such_alert' });
  if (alert.userId !== req.user.id && req.user.role === 'pilgrim') {
    return res.status(403).json({ error: 'not_yours' });
  }
  res.json({ alert: expand(alert) });
});

router.post('/:id/claim', requireRole('admin'), (req, res) => {
  const alert = find('alerts', (a) => a.id === req.params.id);
  if (!alert) return res.status(404).json({ error: 'no_such_alert' });

  if (alert.status === 'claimed' && alert.claimedBy !== req.user.id) {
    return res.status(409).json({
      error: 'already_claimed',
      message: 'Another volunteer is already on this one.',
      alert: expand(alert),
    });
  }
  if (alert.status === 'resolved' || alert.status === 'cancelled') {
    return res.status(409).json({ error: 'already_closed', alert: expand(alert) });
  }

  update('alerts', alert.id, {
    status: 'claimed',
    claimedBy: req.user.id,
    claimedAt: new Date().toISOString(),
    claimExpiresAt: new Date(Date.now() + CLAIM_MINUTES * 60_000).toISOString(),
  });
  logEvent(alert.id, 'claimed', req.user.id);
  announce('claimed', alert);
  res.json({ alert: expand(alert) });
});

/**
 * The control room gives an alert to a volunteer. It goes straight onto that
 * volunteer's task page (and phone notification); handing it to someone else
 * later simply moves it.
 */
router.post('/:id/assign', requireRole('admin'), (req, res) => {
  const alert = find('alerts', (a) => a.id === req.params.id);
  if (!alert) return res.status(404).json({ error: 'no_such_alert' });
  if (alert.status === 'resolved' || alert.status === 'cancelled') {
    return res.status(409).json({ error: 'already_closed', message: 'This alert is already closed.' });
  }
  const volunteer = find('users', (u) => u.id === req.body?.volunteerId && u.role === 'volunteer' && (u.status ?? 'active') === 'active');
  if (!volunteer) return res.status(400).json({ error: 'no_such_volunteer', message: 'Pick an active volunteer.' });
  const now = new Date();
  update('alerts', alert.id, {
    status: 'claimed',
    claimedBy: volunteer.id,
    claimedAt: now.toISOString(),
    assignedBy: req.user.id,
    assignedAt: now.toISOString(),
    claimExpiresAt: new Date(now.getTime() + ASSIGN_MINUTES * 60_000).toISOString(),
  });
  logEvent(alert.id, 'assigned', req.user.id, { volunteerId: volunteer.id, volunteerName: volunteer.displayName });
  announce('assigned', alert);
  res.json({ alert: expand(find('alerts', (a) => a.id === alert.id)) });
});

/** Extend a claim you are still actively working. */
router.post('/:id/heartbeat', requireRole('volunteer', 'admin'), (req, res) => {
  const alert = find('alerts', (a) => a.id === req.params.id);
  if (!alert || alert.claimedBy !== req.user.id) return res.status(404).json({ error: 'not_your_claim' });
  const minutes = alert.assignedAt ? ASSIGN_MINUTES : CLAIM_MINUTES;
  update('alerts', alert.id, { claimExpiresAt: new Date(Date.now() + minutes * 60_000).toISOString() });
  res.json({ alert: expand(alert) });
});

router.post('/:id/release', requireRole('volunteer', 'admin'), (req, res) => {
  const alert = find('alerts', (a) => a.id === req.params.id);
  if (!alert) return res.status(404).json({ error: 'no_such_alert' });
  if (alert.status !== 'claimed') {
    return res.status(409).json({ error: 'not_claimed', alert: expand(alert) });
  }
  // Only the volunteer on the job (or the control room) can hand it back.
  // Otherwise a mis-tap on someone else's card silently strands the person
  // that volunteer is already walking towards.
  if (alert.claimedBy !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'not_your_claim', message: 'Only the volunteer on this alert can hand it back.' });
  }
  update('alerts', alert.id, { status: 'open', claimedBy: null, claimedAt: null, claimExpiresAt: null, assignedBy: null, assignedAt: null });
  logEvent(alert.id, 'unclaimed', req.user.id, { reason: req.user.role === 'admin' ? 'taken_back' : 'released' });
  announce('released', alert);
  res.json({ alert: expand(alert) });
});

/**
 * Light the beacon.
 *
 * The volunteer is close but cannot see the person. This picks a colour that
 * no other live beacon is using, tells the raiser's phone to fill the screen
 * with it and sound a rising tone, and tells the volunteer what to look and
 * listen for. The colour is deliberately chosen last-minute and per-alert so
 * two beacons in the same area never clash.
 */
router.post('/:id/beacon', requireRole('volunteer', 'admin'), (req, res) => {
  const alert = find('alerts', (a) => a.id === req.params.id);
  if (!alert) return res.status(404).json({ error: 'no_such_alert' });
  if (alert.status !== 'claimed') {
    return res.status(409).json({ error: 'claim_first', message: 'Claim the alert before lighting the beacon.' });
  }
  if (!ownsTask(req, alert)) return notYours(res);

  const inUse = new Set(
    filter('alerts', (a) => a.id !== alert.id && a.status === 'claimed' && a.beacon)
      .map((a) => a.beacon.colour)
  );
  const colour = BEACON_COLOURS.find((c) => !inUse.has(c.id)) ?? BEACON_COLOURS[0];

  const beacon = {
    colour: colour.id,
    hex: colour.hex,
    name: { hi: colour.hi, mr: colour.mr, en: colour.en },
    litBy: req.user.id,
    litByName: req.user.displayName,
    at: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3 * 60_000).toISOString(),
  };

  update('alerts', alert.id, { beacon });
  logEvent(alert.id, 'beacon_lit', req.user.id, { colour: colour.id });
  announce('beacon', alert);
  publish('beacon', { alertId: alert.id, beacon });

  res.json({ beacon, alert: expand(alert) });
});

router.post('/:id/beacon/off', requireUser, (req, res) => {
  const alert = find('alerts', (a) => a.id === req.params.id);
  if (!alert) return res.status(404).json({ error: 'no_such_alert' });
  if (alert.userId !== req.user.id && req.user.role === 'pilgrim') {
    return res.status(403).json({ error: 'not_yours' });
  }
  update('alerts', alert.id, { beacon: null });
  logEvent(alert.id, 'beacon_off', req.user.id);
  publish('beacon', { alertId: alert.id, beacon: null });
  res.json({ alert: expand(alert) });
});

router.post('/:id/resolve', requireRole('volunteer', 'admin'), (req, res) => {
  const alert = find('alerts', (a) => a.id === req.params.id);
  if (!alert) return res.status(404).json({ error: 'no_such_alert' });
  if (alert.status === 'resolved' || alert.status === 'cancelled') {
    return res.status(409).json({ error: 'already_closed', alert: expand(alert) });
  }
  if (!ownsTask(req, alert)) return notYours(res);
  const resolution = String(req.body?.resolution ?? 'reunited').slice(0, 40);
  update('alerts', alert.id, {
    status: 'resolved',
    resolvedAt: new Date().toISOString(),
    resolution,
    beacon: null,
  });
  logEvent(alert.id, 'resolved', req.user.id, { resolution });
  announce('resolved', alert);
  publish('beacon', { alertId: alert.id, beacon: null });
  res.json({ alert: expand(alert) });
});

/** The person who raised it can stand it down themselves. */
router.post('/:id/cancel', requireUser, (req, res) => {
  const alert = find('alerts', (a) => a.id === req.params.id);
  if (!alert) return res.status(404).json({ error: 'no_such_alert' });
  if (alert.userId !== req.user.id && req.user.role === 'pilgrim') {
    return res.status(403).json({ error: 'not_yours' });
  }
  if (alert.status === 'resolved' || alert.status === 'cancelled') {
    return res.json({ alert: expand(alert) });
  }
  update('alerts', alert.id, { status: 'cancelled', resolvedAt: new Date().toISOString(), resolution: 'cancelled_by_user', beacon: null });
  logEvent(alert.id, 'cancelled', req.user.id);
  announce('cancelled', alert);
  publish('beacon', { alertId: alert.id, beacon: null });
  res.json({ alert: expand(alert) });
});

/**
 * Claims that go quiet fall back into the queue, and beacons switch off when
 * they expire — a phone left flashing and beeping in someone's pocket for an
 * hour drains the battery they need to be found by.
 */
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const alert of all('alerts')) {
    if (alert.beacon?.expiresAt && new Date(alert.beacon.expiresAt).getTime() <= now) {
      update('alerts', alert.id, { beacon: null });
      logEvent(alert.id, 'beacon_off', null, { reason: 'expired' });
      publish('beacon', { alertId: alert.id, beacon: null });
      announce('beacon', alert);
    }
    if (alert.status !== 'claimed' || !alert.claimExpiresAt) continue;
    if (new Date(alert.claimExpiresAt).getTime() > now) continue;
    update('alerts', alert.id, { status: 'open', claimedBy: null, claimedAt: null, claimExpiresAt: null, assignedBy: null, assignedAt: null });
    logEvent(alert.id, 'unclaimed', null, { reason: 'claim_expired' });
    announce('released', alert);
    console.log(`  .. SOS ${alert.id} claim expired, back in the queue`);
  }
}, 30_000);
sweeper.unref();

export default router;
