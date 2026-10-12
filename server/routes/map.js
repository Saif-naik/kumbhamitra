import { Router } from 'express';
import { NODES, EDGES, GROUND, CROWD } from '../../public/shared/mela-map.js';
import { route, directions, nearest } from '../../public/shared/routing.js';
import { edgeFlags, setEdgeFlag, clearEdgeFlag } from '../db/store.js';
import { requireRole } from '../lib/auth.js';
import { publish } from '../realtime.js';

const router = Router();

/**
 * The full graph, for a device that has not cached it yet. Served once, then
 * the app never asks again — everything after this is the flags endpoint,
 * which is a few hundred bytes.
 */
router.get('/graph', (_req, res) => {
  res.json({ ground: GROUND, nodes: NODES, edges: EDGES, crowdLevels: CROWD });
});

/** The only thing that changes minute to minute. Keep it small. */
router.get('/flags', (_req, res) => {
  res.json({ flags: edgeFlags(), at: new Date().toISOString() });
});

const EDGE_IDS = new Set(EDGES.map((e) => e.id));

router.put('/flags/:edgeId', requireRole('admin'), (req, res) => {
  if (!EDGE_IDS.has(req.params.edgeId)) {
    return res.status(404).json({ error: 'unknown_path' });
  }
  const level = Number(req.body?.level);
  if (![1, 2, 3, 4].includes(level)) {
    return res.status(400).json({ error: 'bad_level', message: 'Level must be 1, 2, 3 or 4.' });
  }
  const flag = setEdgeFlag(req.params.edgeId, level, req.user.id);
  publish('flags', { edgeId: req.params.edgeId, ...flag });
  res.json({ edgeId: req.params.edgeId, ...flag });
});

/**
 * Remove a flag. This is not the same as setting level 1: some paths are busy
 * by default (a ghat approach on a festival day), and "clear the flag" should
 * put them back to that baseline rather than mark them as empty.
 */
router.delete('/flags/:edgeId', requireRole('admin'), (req, res) => {
  if (!EDGE_IDS.has(req.params.edgeId)) {
    return res.status(404).json({ error: 'unknown_path' });
  }
  clearEdgeFlag(req.params.edgeId);
  publish('flags', { edgeId: req.params.edgeId, level: null, cleared: true });
  res.json({ edgeId: req.params.edgeId, cleared: true });
});

/**
 * Server-side routing. The app routes locally too — this exists so the
 * assistant and the volunteer console use the exact same implementation.
 */
router.get('/route', (req, res) => {
  const { from, to, avoidCrowds = '1' } = req.query;
  const result = route(from, to, { flags: edgeFlags(), avoidCrowds: avoidCrowds !== '0' });
  const lang = req.query.lang || req.user?.language || 'hi';
  res.json({ ...result, steps: directions(result, lang) });
});

router.get('/nearest/:type', (req, res) => {
  const from = req.query.from || req.user?.nodeId || 'j_c';
  const best = nearest(from, req.params.type, { flags: edgeFlags() });
  if (!best) return res.status(404).json({ error: 'nothing_reachable' });
  const lang = req.query.lang || req.user?.language || 'hi';
  res.json({ node: best.node, ...best.result, steps: directions(best.result, lang) });
});

export default router;
