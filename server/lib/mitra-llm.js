/**
 * Optional language-model help for Mitra. Everything here is an upgrade:
 * with no ANTHROPIC_API_KEY, or a slow or failing call, Mitra answers exactly
 * as it does offline.
 *
 * The model is used in two narrow ways, and in neither can it invent a place,
 * a route, a time or a number:
 *
 *  1. chooseIntent — for wording the rules did not understand, the model
 *     picks ONE intent and at most one place/facility from fixed lists. The
 *     answer is then computed by the normal engine. Anything off-list is
 *     thrown away.
 *  2. rephrase — makes an already-computed answer read more naturally. It is
 *     told to keep every fact, and is never used for emergencies.
 *
 * `fetchImpl` is injectable so this can be tested without a network or a key.
 */

import { CHOOSABLE } from '../../public/shared/mitra.js';

const API = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

async function callModel({ system, user, key, model, fetchImpl = fetch, timeoutMs = 2500, maxTokens = 200 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs); // never make a pilgrim wait
  try {
    const response = await fetchImpl(API, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (data.stop_reason === 'refusal') return null;
    const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    return text || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const INTENT_HELP = {
  nearest: 'find the nearest facility of a type (needs slot)',
  route_to: 'directions to a named place (needs place)',
  crowd_at: 'how crowded a named place is (needs place)',
  crowd_overall: 'where it is crowded in general',
  best_ghat: 'which bathing ghat is least crowded',
  schedule: 'when an event happens',
  family: 'where their family or group members are',
  where_am_i: 'where they are now',
  notices: 'announcements or news',
  helplines: 'emergency phone numbers',
  lost_item: 'they lost a belonging (phone, bag...)',
  capabilities: 'what the assistant can do',
  sos: 'an emergency happening now (needs kind)',
};

/**
 * @returns {Promise<{intent: string, place?: string, slot?: string, kind?: string}|null>}
 */
export async function chooseIntent(text, { lang = 'hi', key, model, fetchImpl, timeoutMs } = {}) {
  if (!key || !text) return null;
  const system = [
    'You route messages from pilgrims at a large religious gathering in India to a fixed set of intents.',
    'Messages may be in Hindi, Marathi, English or romanised Hindi.',
    'Reply with ONE line of JSON only, no prose: {"intent": "...", "place": "...", "slot": "...", "kind": "..."}.',
    'Use null for fields that do not apply. If nothing fits, use {"intent": "unknown"}.',
    `Intents: ${CHOOSABLE.intents.map((i) => `${i} = ${INTENT_HELP[i]}`).join('; ')}.`,
    `Slots: ${CHOOSABLE.slots.join(', ')}.`,
    `Places (use the id): ${CHOOSABLE.places.map((p) => `${p.id} = ${p.name}`).join('; ')}.`,
    'Kinds for sos: lost_person, lost_self, medical, crowd_crush, other.',
  ].join('\n');
  const out = await callModel({ system, user: `Language: ${lang}\nMessage: ${text}`, key, model, fetchImpl, timeoutMs, maxTokens: 80 });
  if (!out) return null;
  let parsed;
  try {
    parsed = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
  // Only ever accept values from the lists.
  if (!CHOOSABLE.intents.includes(parsed?.intent)) return null;
  const choice = { intent: parsed.intent };
  if (CHOOSABLE.places.some((p) => p.id === parsed.place)) choice.place = parsed.place;
  if (CHOOSABLE.slots.includes(parsed.slot)) choice.slot = parsed.slot;
  if (['lost_person', 'lost_self', 'medical', 'crowd_crush', 'other'].includes(parsed.kind)) choice.kind = parsed.kind;
  return choice;
}

/** Rephrase a computed answer. Returns null to keep the original. */
export async function rephrase(answer, question, { lang = 'hi', key, model, fetchImpl, timeoutMs } = {}) {
  if (!key || !answer) return null;
  const system =
    'You rephrase pre-computed answers for pilgrims at a large religious gathering. ' +
    'Many have low literacy. Use short, simple sentences in the requested language. ' +
    'Keep every place name, distance, time and number exactly as given. ' +
    'Do not add any place, distance, time, number or fact that is not in the given answer. ' +
    'Do not add greetings or offers of further help. Reply with the rephrased answer only.';
  return callModel({ system, user: `Language: ${lang}\nUser asked: ${question}\nComputed answer: ${answer}`, key, model, fetchImpl, timeoutMs });
}
