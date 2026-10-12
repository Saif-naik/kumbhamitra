import { Router } from 'express';
import { pressureMap, warnings, simulateInflow, clearSimulation, pressureFor } from '../lib/crowd.js';
import { NODE_BY_ID } from '../../public/shared/mela-map.js';
import { requireRole } from '../lib/auth.js';
import { publish } from '../realtime.js';

const router = Router();

/** Everything, for the control room map. */
router.get('/pressure', (_req, res) => {
  res.json({ pressure: pressureMap(), at: new Date().toISOString() });
});

/** Only what needs a human decision. This is what phones poll. */
router.get('/warnings', (_req, res) => {
  res.json({
    warnings: warnings().map((w) => ({ ...w, place: NODE_BY_ID[w.nodeId]?.name ?? null })),
    at: new Date().toISOString(),
  });
});

router.post('/simulate', requireRole('admin'), (req, res) => {
  const { nodeId, people = 2200 } = req.body ?? {};
  if (!NODE_BY_ID[nodeId]) return res.status(400).json({ error: 'unknown_place' });
  const result = simulateInflow(nodeId, Number(people));
  console.log(`  ~~ simulated ${people} people arriving at ${nodeId} (demo)`);
  publish('crowd', { event: 'pressure_changed', pressure: result, simulated: true });
  res.json({ pressure: result, simulated: true });
});

router.post('/clear', requireRole('admin'), (_req, res) => {
  clearSimulation();
  publish('crowd', { event: 'cleared' });
  res.json({ cleared: true });
});

router.get('/pressure/:nodeId', (req, res) => {
  if (!NODE_BY_ID[req.params.nodeId]) return res.status(404).json({ error: 'unknown_place' });
  res.json({ pressure: pressureFor(req.params.nodeId) });
});

export default router;
