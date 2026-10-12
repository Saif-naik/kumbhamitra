/**
 * Mitra, server side.
 *
 * The same engine as the phone (public/shared/mitra.js), so the two can never
 * disagree about a route or a place. The server adds what the phone may not
 * have: the freshest crowd warnings and flags, the family group's latest
 * positions, and — only if ANTHROPIC_API_KEY is set — a language model that
 * can (a) pick an intent for wording the rules missed and (b) rephrase the
 * computed answer. The model never writes a route, a place or a number.
 */

import { Router } from 'express';
import { respond, CHOOSABLE } from '../../public/shared/mitra.js';
import { NODE_BY_ID } from '../../public/shared/mela-map.js';
import { edgeFlags, all, filter, find } from '../db/store.js';
import { warnings } from '../lib/crowd.js';
import { chooseIntent, rephrase } from '../lib/mitra-llm.js';
import { limit } from '../lib/limit.js';

// Not safety-critical, and can cost money with a model key. Per user (or IP
// for anonymous calls). The phone answers offline anyway, so a 429 here
// never leaves anyone without an answer.
const askGuard = limit({ name: 'ask', windowMs: 60_000, max: 40 });

const router = Router();
const LANGS = ['hi', 'mr', 'en'];

/** Only remember things that are real ids — the client sends this back to us. */
function cleanMemory(raw) {
  const memory = {};
  if (raw && typeof raw === 'object') {
    if (NODE_BY_ID[raw.lastPlace]) memory.lastPlace = raw.lastPlace;
    if (CHOOSABLE.slots.includes(raw.lastSlot)) memory.lastSlot = raw.lastSlot;
    if (Array.isArray(raw.tried)) memory.tried = raw.tried.filter((id) => NODE_BY_ID[id]).slice(0, 10);
  }
  return memory;
}

function contextFor(user, { lang, fromId, memory, gps }) {
  const groupId = user ? filter('memberships', (m) => m.userId === user.id)[0]?.groupId : null;
  const members = groupId
    ? filter('memberships', (m) => m.groupId === groupId && m.userId !== user.id).map((m) => {
        const pos = find('positions', (p) => p.userId === m.userId);
        const person = find('users', (u) => u.id === m.userId);
        return {
          label: m.label || person?.displayName || 'Member',
          sharing: Boolean(m.sharing),
          nodeId: m.sharing ? pos?.nodeId ?? null : null,
          updatedAt: m.sharing ? pos?.updatedAt ?? null : null,
        };
      })
    : [];
  const now = Date.now();
  return {
    lang,
    you: fromId,
    gps,
    flags: edgeFlags(),
    warnings: warnings(),
    schedule: all('schedule'),
    notices: all('notices').filter((n) => !n.endsAt || new Date(n.endsAt).getTime() > now),
    members,
    hasGroup: Boolean(groupId),
    memory,
    now,
  };
}

router.post('/ask', askGuard, async (req, res) => {
  const body = req.body ?? {};
  const text = String(body.text ?? '').slice(0, 300);
  const requested = body.lang ?? req.user?.language;
  const lang = LANGS.includes(requested) ? requested : 'hi';
  const fromId = NODE_BY_ID[body.from] ? body.from : req.user?.nodeId && NODE_BY_ID[req.user.nodeId] ? req.user.nodeId : 'j_c';
  const ctx = contextFor(req.user, { lang, fromId, memory: cleanMemory(body.memory), gps: Boolean(body.gps) });

  const key = process.env.ANTHROPIC_API_KEY;
  const model = process.env.MITRA_MODEL;

  let answer = respond(text, ctx);

  // Words the rules did not catch: let the model choose from the known list.
  if (answer.intent === 'unknown' && key) {
    const choice = await chooseIntent(text, { lang, key, model });
    if (choice) {
      const chosen = respond(text, ctx, { force: choice });
      if (chosen.intent !== 'unknown') answer = { ...chosen, chosenByModel: true };
    }
  }

  // Natural wording, never for emergencies.
  if (key && !answer.urgent && answer.intent !== 'unknown') {
    const better = await rephrase(answer.text, text, { lang, key, model });
    if (better) answer = { ...answer, text: better, polished: true };
  }

  res.json({ ...answer, say: answer.text, from: fromId, llm: Boolean(key) });
});

export default router;
