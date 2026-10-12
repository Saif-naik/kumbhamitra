/**
 * Volunteer approvals and access, for the control room only.
 *
 * A volunteer who registers is pending until an admin approves them here.
 * Rejecting or disabling also ends any session they have, at once.
 */

import { Router } from 'express';
import { filter, find, update, insert, nextId } from '../db/store.js';
import { requireRole, publicUser, revokeToken } from '../lib/auth.js';
import { publish } from '../realtime.js';
import { NODE_BY_ID } from '../../public/shared/mela-map.js';

const router = Router();
router.use(requireRole('admin'));

const view = (u) => {
  const { displayName, id, phone, org, skills, languages, status, createdAt, lastLoginAt, nodeId } = publicUser(u);
  return {
    id, displayName, phone, org, skills, languages,
    status: status ?? 'active',
    viaKey: Boolean(u.viaKey),
    createdAt, lastLoginAt: lastLoginAt ?? null,
    place: nodeId ? NODE_BY_ID[nodeId]?.name ?? null : null,
  };
};

router.get('/volunteers', (_req, res) => {
  const rank = { pending: 0, active: 1, disabled: 2, rejected: 3 };
  res.json({
    volunteers: filter('users', (u) => u.role === 'volunteer')
      .map(view)
      .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || a.displayName.localeCompare(b.displayName)),
  });
});

const ACTIONS = {
  approve: { from: ['pending', 'rejected'], to: 'active' },
  reject: { from: ['pending'], to: 'rejected' },
  disable: { from: ['active'], to: 'disabled' },
  enable: { from: ['disabled'], to: 'active' },
};

router.post('/volunteers/:id/:action', (req, res) => {
  const action = ACTIONS[req.params.action];
  if (!action) return res.status(404).json({ error: 'unknown_action' });
  const user = find('users', (u) => u.id === req.params.id && u.role === 'volunteer');
  if (!user) return res.status(404).json({ error: 'no_such_volunteer' });
  const status = user.status ?? 'active';
  if (!action.from.includes(status)) {
    return res.status(409).json({ error: 'wrong_state', message: `This volunteer is ${status}.` });
  }
  update('users', user.id, { status: action.to, reviewedBy: req.user.id, reviewedAt: new Date().toISOString() });
  if (action.to !== 'active') revokeToken(user);

  // Leave a trail: who let whom in, and when.
  insert('alertEvents', {
    id: nextId('evt'), alertId: null, kind: `volunteer_${req.params.action}`,
    actorId: req.user.id, detail: { volunteerId: user.id }, at: new Date().toISOString(),
  });
  publish('staff', { event: `volunteer_${req.params.action}`, id: user.id });
  res.json({ volunteer: view(find('users', (u) => u.id === user.id)) });
});

export default router;
