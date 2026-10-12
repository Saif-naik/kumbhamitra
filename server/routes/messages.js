/**
 * The control room and its volunteers talking to each other.
 *
 *  - Messages: one thread per volunteer. The control room writes to one
 *    volunteer at a time; the volunteer replies to the control room (any
 *    admin sees the reply).
 *  - The task board: jobs for every volunteer ("two people to Gate 3 at
 *    five"), which any volunteer can say they will help with.
 *
 * The live socket reaches every screen, pilgrims included, so it only says
 * "something changed" — never who, or what was written. Screens fetch the
 * rest over the authenticated API.
 */

import { Router } from 'express';
import { insert, find, filter, update, remove, nextId } from '../db/store.js';
import { requireRole } from '../lib/auth.js';
import { publish } from '../realtime.js';
import { NODE_BY_ID } from '../../public/shared/mela-map.js';
import { limit } from '../lib/limit.js';

const router = Router();
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const staffOnly = requireRole('volunteer', 'admin');
const writeGuard = limit({ name: 'messages', windowMs: 60_000, max: 30, message: 'Too many messages in a minute. Wait a moment.' });

const isVolunteer = (id) => find('users', (u) => u.id === id && u.role === 'volunteer');
const view = (m) => ({ ...m, place: m.nodeId ? NODE_BY_ID[m.nodeId]?.name ?? null : null });

/* ------------------------------------------------------------ messages -- */

/**
 * A volunteer gets their own thread. The control room gets one volunteer's
 * thread with ?with=<id>, or (without it) the unread count per volunteer.
 */
router.get('/', staffOnly, (req, res) => {
  if (req.user.role === 'volunteer') {
    const thread = filter('messages', (m) => m.volunteerId === req.user.id).sort((a, b) => a.at.localeCompare(b.at));
    return res.json({ messages: thread, unread: thread.filter((m) => m.from === 'control' && !m.readAt).length });
  }
  if (req.query.with) {
    const thread = filter('messages', (m) => m.volunteerId === req.query.with).sort((a, b) => a.at.localeCompare(b.at));
    return res.json({ messages: thread });
  }
  const unread = {};
  for (const m of filter('messages', (x) => x.from === 'volunteer' && !x.readAt)) unread[m.volunteerId] = (unread[m.volunteerId] ?? 0) + 1;
  res.json({ unread });
});

/** Control room → one volunteer (body.to), or a volunteer → the control room. */
router.post('/', staffOnly, writeGuard, (req, res) => {
  const text = clip(req.body?.text, 500);
  if (!text) return res.status(400).json({ error: 'empty', message: 'Write a message first.' });
  const toControl = req.user.role === 'volunteer';
  const volunteerId = toControl ? req.user.id : req.body?.to;
  const volunteer = isVolunteer(volunteerId);
  if (!volunteer) return res.status(400).json({ error: 'no_such_volunteer', message: 'Pick a volunteer.' });
  const message = insert('messages', {
    id: nextId('msg'),
    volunteerId,
    from: toControl ? 'volunteer' : 'control',
    authorId: req.user.id,
    authorName: req.user.displayName,
    text,
    at: new Date().toISOString(),
    readAt: null,
  });
  publish('messages', { event: 'new' });
  res.status(201).json({ message });
});

/** Mark a thread read: a volunteer reads the control room's messages, an admin a volunteer's replies. */
router.post('/read', staffOnly, (req, res) => {
  const volunteerId = req.user.role === 'volunteer' ? req.user.id : req.body?.with;
  const from = req.user.role === 'volunteer' ? 'control' : 'volunteer';
  const now = new Date().toISOString();
  for (const m of filter('messages', (x) => x.volunteerId === volunteerId && x.from === from && !x.readAt)) update('messages', m.id, { readAt: now });
  publish('messages', { event: 'read' });
  res.json({ ok: true });
});

/* ---------------------------------------------------------- task board -- */

/** Every volunteer sees the open jobs; finished ones stay for twelve hours. */
router.get('/board', staffOnly, (_req, res) => {
  const since = Date.now() - 12 * 3_600_000;
  res.json({
    tasks: filter('board', (t) => t.status === 'open' || Date.parse(t.doneAt ?? 0) > since)
      .sort((a, b) => (a.status === b.status ? b.createdAt.localeCompare(a.createdAt) : a.status === 'open' ? -1 : 1))
      .map(view),
  });
});

router.post('/board', requireRole('admin'), writeGuard, (req, res) => {
  const title = clip(req.body?.title, 120);
  if (!title) return res.status(400).json({ error: 'empty', message: 'Say what needs doing.' });
  const task = insert('board', {
    id: nextId('job'),
    title,
    detail: clip(req.body?.detail, 400) || null,
    nodeId: NODE_BY_ID[req.body?.nodeId] ? req.body.nodeId : null,
    needed: Math.min(50, Math.max(1, Number(req.body?.needed) || 1)),
    helpers: [],
    status: 'open',
    createdBy: req.user.id,
    createdAt: new Date().toISOString(),
    doneAt: null,
  });
  publish('board', { event: 'new' });
  res.status(201).json({ task: view(task) });
});

/** A volunteer says "I'll help" — or takes it back. */
router.post('/board/:id/help', requireRole('volunteer'), (req, res) => {
  const task = find('board', (t) => t.id === req.params.id);
  if (!task || task.status !== 'open') return res.status(404).json({ error: 'no_such_task', message: 'This task is no longer open.' });
  const helping = task.helpers.some((h) => h.id === req.user.id);
  const helpers = helping
    ? task.helpers.filter((h) => h.id !== req.user.id)
    : [...task.helpers, { id: req.user.id, name: req.user.displayName, at: new Date().toISOString() }];
  update('board', task.id, { helpers });
  publish('board', { event: 'help' });
  res.json({ task: view(find('board', (t) => t.id === task.id)), helping: !helping });
});

router.post('/board/:id/done', requireRole('admin'), (req, res) => {
  const task = find('board', (t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'no_such_task' });
  update('board', task.id, { status: 'done', doneAt: new Date().toISOString() });
  publish('board', { event: 'done' });
  res.json({ task: view(find('board', (t) => t.id === task.id)) });
});

router.delete('/board/:id', requireRole('admin'), (req, res) => {
  if (!remove('board', req.params.id)) return res.status(404).json({ error: 'no_such_task' });
  publish('board', { event: 'removed' });
  res.json({ ok: true });
});

export default router;
