import { Router } from 'express';
import { all, insert, nextId, remove, find } from '../db/store.js';
import { requireRole } from '../lib/auth.js';
import { publish } from '../realtime.js';

const router = Router();

/**
 * Schedule and notices are cached on-device and only ever refreshed
 * opportunistically. A stale schedule is survivable; a blocking fetch on a
 * dead network is not.
 */
router.get('/schedule', (_req, res) => {
  res.json({
    events: all('schedule').slice().sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
    fetchedAt: new Date().toISOString(),
  });
});

router.get('/notices', (_req, res) => {
  const now = Date.now();
  res.json({
    notices: all('notices').filter((n) => !n.endsAt || new Date(n.endsAt).getTime() > now),
    fetchedAt: new Date().toISOString(),
  });
});

const SEVERITIES = ['info', 'warning', 'urgent'];
const clip = (v) => (v ? String(v).trim().slice(0, 280) : '');

router.post('/notices', requireRole('admin'), (req, res) => {
  const { severity = 'info', body: raw } = req.body ?? {};
  // Keep only the three known languages, as plain strings. The pages render
  // these as text, but nothing else belongs in a notice either.
  const body = { hi: clip(raw?.hi), mr: clip(raw?.mr), en: clip(raw?.en) };
  if (!body.en && !body.hi && !body.mr) {
    return res.status(400).json({ error: 'body_required', message: 'Write the notice in at least one language.' });
  }
  // A notice written in only one language still reaches everyone: Marathi
  // readers can read Devanagari Hindi, and everyone gets something.
  body.hi ||= body.mr || body.en;
  body.mr ||= body.hi;
  body.en ||= body.hi;
  const notice = insert('notices', {
    id: nextId('ntc'),
    severity: SEVERITIES.includes(severity) ? severity : 'info',
    body,
    startsAt: new Date().toISOString(),
    endsAt: req.body?.endsAt ?? null,
    createdBy: req.user.id,
  });
  publish('notices', notice);
  res.status(201).json({ notice });
});

/** Withdraw a notice. A stale "Sangam is closed" is worse than no notice. */
router.delete('/notices/:id', requireRole('admin'), (req, res) => {
  if (!find('notices', (n) => n.id === req.params.id)) {
    return res.status(404).json({ error: 'no_such_notice' });
  }
  remove('notices', req.params.id);
  publish('notices', { id: req.params.id, withdrawn: true });
  res.json({ withdrawn: req.params.id });
});

export default router;
