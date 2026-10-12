/**
 * Mitra engine tests — what it understands and what it answers. Pure logic,
 * no server, no browser. Includes every misunderstanding the old keyword
 * matcher had, so they cannot come back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { respond, understand, findPlace, norm, HELPLINES, suggestions } from '../public/shared/mitra.js';
import { NODE_BY_ID } from '../public/shared/mela-map.js';
import { chooseIntent, rephrase } from '../server/lib/mitra-llm.js';

const hours = (h) => new Date(Date.now() + h * 3_600_000).toISOString();

const ctx = (extra = {}) => ({
  lang: 'en',
  you: 'gate_2',
  flags: {},
  hasGroup: true,
  warnings: [{ nodeId: 'ghat_sangam', risk: 3, minutesToCritical: 3 }],
  schedule: [
    { title: { en: 'Ganga Aarti', hi: 'गंगा आरती', mr: 'गंगा आरती' }, nodeId: 'ghat_ram', startsAt: hours(2), endsAt: hours(3) },
    { title: { en: 'Bhandara — free meal', hi: 'भंडारा — निःशुल्क भोजन', mr: 'भंडारा' }, nodeId: 'food_1', startsAt: hours(-0.5), endsAt: hours(1) },
  ],
  notices: [{ body: { en: 'Gate 3 closed till noon', hi: 'गेट 3 दोपहर तक बंद', mr: 'गेट 3 दुपारपर्यंत बंद' } }],
  members: [
    { label: 'Papa', sharing: true, nodeId: 'camp_b', updatedAt: hours(-0.1) },
    { label: 'Meena', sharing: false, nodeId: null },
  ],
  ...extra,
});

const intentOf = (text, lang = 'en', extra = {}) => respond(text, ctx({ lang, ...extra })).intent;

/* -------------------------------------------- the old matcher's mistakes -- */

test('"where is the medical post" finds it — it does not raise an emergency', () => {
  const a = respond('where is the medical post', ctx());
  assert.equal(a.intent, 'nearest');
  assert.equal(a.urgent, undefined);
  assert.equal(NODE_BY_ID[a.to].type, 'medical');
  // But it still offers an alert and 108, in case someone is badly hurt.
  assert.ok(a.actions.some((x) => x.type === 'sos'));
  assert.ok(a.actions.some((x) => x.type === 'call' && x.number === '108'));
});

test('"पानी कहाँ है" means water, not family', () => {
  const a = respond('पानी कहाँ है', ctx({ lang: 'hi' }));
  assert.equal(a.intent, 'nearest');
  assert.equal(NODE_BY_ID[a.to].type, 'water');
});

test('"घाट का रास्ता" is the way to a ghat, not a crowd report', () => {
  const a = respond('घाट का रास्ता', ctx({ lang: 'hi' }));
  assert.equal(NODE_BY_ID[a.to].type, 'ghat');
  assert.ok(a.steps.length > 0);
});

test('short English words only match whole words', () => {
  assert.equal(intentOf('that was a great help'), 'unknown');      // not "eat"
  assert.equal(intentOf('sometimes'), 'unknown');                  // not "time"
  assert.equal(intentOf('hindi'), 'unknown');                      // not "hi"
  assert.equal(intentOf('where can i eat'), 'nearest');
});

test('Marathi "हो" (yes) does not fire inside Hindi words', () => {
  assert.notEqual(understand('कहाँ होगा', { memory: { lastPlace: 'ghat_ram' } }).intent, 'go');
});

/* ------------------------------------------------------------ emergencies -- */

test('emergencies are recognised in all three languages', () => {
  for (const [text, lang, kind] of [
    ['my father fainted, need ambulance', 'en', 'medical'],
    ['बेहोश हो गए', 'hi', 'medical'],
    ['i am lost', 'en', 'lost_self'],
    ['मी हरवलो आहे', 'mr', 'lost_self'],
    ['मेरा बेटा खो गया', 'hi', 'lost_person'],
    ['भगदड़ हो रही है', 'hi', 'crowd_crush'],
    ['bachao', 'en', 'other'],
  ]) {
    const a = respond(text, ctx({ lang }));
    assert.equal(a.intent, 'sos', text);
    assert.equal(a.kind, kind, text);
    assert.equal(a.urgent, true);
    assert.ok(a.actions.some((x) => x.type === 'sos' && x.kind === kind));
  }
});

test('a lost phone is not a lost person', () => {
  const a = respond('i lost my phone', ctx());
  assert.equal(a.intent, 'lost_item');
  assert.equal(a.to, 'police_1');
  assert.equal(respond('मेरा बैग खो गया', ctx({ lang: 'hi' })).intent, 'lost_item');
});

test('"help me find a toilet" is not an emergency, "emergency numbers" are numbers', () => {
  assert.equal(intentOf('help me find a toilet'), 'nearest');
  assert.equal(intentOf('emergency numbers'), 'helplines');
});

/* ------------------------------------------------------------------ places -- */

test('place nicknames and typos', () => {
  assert.equal(findPlace('sangham ghat')?.id, 'ghat_sangam');
  assert.equal(findPlace('hanumaan ghat')?.id, 'ghat_hanuman');
  assert.equal(findPlace('take me to the bus stand')?.id, 'gate_1');
  assert.equal(findPlace('railway station')?.id, 'gate_2');
  assert.equal(findPlace('gate number 3')?.id, 'gate_3');
  assert.equal(findPlace('भंडारा')?.id, 'food_1');
  assert.equal(findPlace('sangam approach')?.id, 'j_river_c', 'the longer name wins');
});

test('Devanagari spellings with and without nukta match', () => {
  assert.equal(norm('भीड़'), norm('भीड'));
  assert.equal(respond('संगम पर भीड है?', ctx({ lang: 'hi' })).intent, 'crowd_at');
  assert.equal(respond('संगम पर भीड़ है?', ctx({ lang: 'hi' })).intent, 'crowd_at');
});

test('already standing at the nearest one', () => {
  const a = respond('where is the exit', ctx());
  assert.match(a.text, /already at Gate 2/);
});

/* ------------------------------------------------------------------ crowds -- */

test('a packed place says so and offers a calmer one of the same kind', () => {
  const a = respond('is sangam crowded?', ctx());
  assert.equal(a.intent, 'crowd_at');
  assert.equal(a.crowd.state, 'packed');
  assert.match(a.text, /Do not go there now/);
  assert.equal(NODE_BY_ID[a.to].type, 'ghat');
  assert.notEqual(a.to, 'ghat_sangam');
  assert.ok(a.actions.some((x) => x.type === 'navigate' && x.to === a.to));
});

test('least crowded ghat puts crowd before distance and names the one to avoid', () => {
  const a = respond('which ghat is least crowded', ctx());
  assert.equal(a.intent, 'best_ghat');
  assert.notEqual(a.to, 'ghat_sangam');
  assert.match(a.text, /Avoid Sangam Ghat/);
  assert.equal(respond('कौन सा घाट खाली है', ctx({ lang: 'hi' })).intent, 'best_ghat');
  assert.equal(respond('कोणता घाट कमी गर्दीचा आहे', ctx({ lang: 'mr' })).intent, 'best_ghat');
});

test('a closed path into a place is reported', () => {
  const a = respond('is ram ghat crowded', ctx({ flags: { e03: { level: 4 } }, warnings: [] }));
  assert.match(a.text, /closed/);
});

test('overall crowd picture', () => {
  assert.match(respond('where is it crowded', ctx()).text, /Sangam Ghat/);
  assert.match(respond('where is it crowded', ctx({ warnings: [] })).text, /No crowd warnings/);
});

/* -------------------------------------------------------------- follow-ups -- */

test('conversation memory: there / another / how far / let us go', () => {
  let memory = {};
  const step = (text) => {
    const a = respond(text, ctx({ memory }));
    memory = a.memory;
    return a;
  };
  const first = step('nearest toilet');
  assert.equal(NODE_BY_ID[first.to].type, 'toilet');
  const crowd = step('is it crowded there?');
  assert.equal(crowd.intent, 'crowd_at');
  assert.equal(crowd.crowdOf, first.to);
  const other = step('another one');
  assert.equal(other.intent, 'another');
  assert.equal(NODE_BY_ID[other.to].type, 'toilet');
  assert.notEqual(other.to, first.to);
  const far = step('how far?');
  assert.equal(far.intent, 'distance');
  assert.equal(far.to, other.to);
  const go = step('chalo');
  assert.equal(go.intent, 'go');
  assert.equal(go.autostart, true);
  assert.equal(go.to, other.to);
});

test('"another" runs out honestly', () => {
  let memory = {};
  let last;
  for (const text of ['nearest medical post', 'another', 'another']) {
    last = respond(text, ctx({ memory }));
    memory = last.memory;
  }
  assert.match(last.text, /last medical post/);
});

/* ------------------------------------------------------- people and times -- */

test('family: a member by name, a hidden member, everyone, and no group', () => {
  const papa = respond('where is papa', ctx());
  assert.equal(papa.intent, 'family');
  assert.equal(papa.to, 'camp_b');
  assert.match(papa.text, /Papa is at Sector B Camp/);
  assert.match(respond('where is meena', ctx()).text, /not sharing/);
  assert.match(respond('मेरा परिवार कहाँ है', ctx({ lang: 'hi' })).text, /Papa/);
  assert.match(respond('where is my family', ctx({ hasGroup: false, members: [] })).text, /not made a family group/);
});

test('schedule: a named event, and what is on now', () => {
  const aarti = respond('when is the aarti', ctx());
  assert.match(aarti.text, /Ganga Aarti — in 2 h, at Ram Ghat/);
  assert.equal(aarti.to, 'ghat_ram');
  assert.match(respond('भंडारा कब है', ctx({ lang: 'hi' })).text, /अभी चल रहा है/);
});

test('where am I, announcements, helplines', () => {
  assert.match(respond('where am i', ctx()).text, /Gate 2/);
  assert.match(respond('where am i', ctx({ gps: true })).text, /from your GPS/);
  const news = respond('any announcements', ctx());
  assert.match(news.text, /Gate 3 closed/);
  assert.match(news.text, /Sangam Ghat is packed/, 'crowd warnings lead the announcements');
  const help = respond('helpline', ctx());
  assert.deepEqual(help.actions.filter((x) => x.type === 'call').map((x) => x.number), HELPLINES.map((h) => h.number));
  assert.deepEqual(HELPLINES.map((h) => h.number), ['112', '108', '1098', '181']);
});

test('small talk and the unknown get useful suggestions', () => {
  assert.equal(intentOf('namaste', 'hi'), 'greet');
  assert.equal(intentOf('धन्यवाद', 'hi'), 'thanks');
  assert.equal(intentOf('what can you do'), 'capabilities');
  const lost = respond('blah blah', ctx());
  assert.equal(lost.intent, 'unknown');
  assert.equal(lost.followups.length, suggestions('en').length);
});

/* ------------------------------------------------------- it cannot invent -- */

test('every place it ever points to is a real landmark', () => {
  const questions = [
    'nearest toilet', 'water', 'food', 'police', 'ghat', 'exit', 'camp', 'medical', 'is sangam crowded',
    'which ghat is least crowded', 'when is the aarti', 'where is papa', 'i lost my phone', 'sangham ghat',
  ];
  for (const lang of ['en', 'hi', 'mr']) {
    for (const q of questions) {
      const a = respond(q, ctx({ lang }));
      if (a.to) assert.ok(NODE_BY_ID[a.to], `${q} -> ${a.to}`);
      for (const act of a.actions) if (act.to) assert.ok(NODE_BY_ID[act.to], `${q} action -> ${act.to}`);
    }
  }
});

test('answers come back in the language asked', () => {
  assert.match(respond('nearest toilet', ctx({ lang: 'hi' })).text, /सबसे पास शौचालय/);
  assert.match(respond('nearest toilet', ctx({ lang: 'mr' })).text, /जवळचे स्वच्छतागृह/);
});

test('a forced intent (from the model) is only used for unknown wording, and only with real ids', () => {
  const forced = respond('mujhe nahaane jaana hai yaar', ctx(), { force: { intent: 'best_ghat' } });
  assert.equal(forced.intent, 'best_ghat');
  const fake = respond('qwerty', ctx(), { force: { intent: 'route_to', place: 'atlantis' } });
  assert.equal(fake.intent, 'unknown', 'a made-up place id is ignored');
  const ignored = respond('nearest toilet', ctx(), { force: { intent: 'helplines' } });
  assert.equal(ignored.intent, 'nearest', 'rules win when they understood');
});

/* ------------------------------------------------- language-model helper -- */

const fakeFetch = (reply, { ok = true, stop = 'end_turn' } = {}) => async () => ({
  ok,
  json: async () => ({ stop_reason: stop, content: [{ type: 'text', text: reply }] }),
});

test('chooseIntent accepts only listed intents and places', async () => {
  assert.deepEqual(
    await chooseIntent('x', { key: 'k', fetchImpl: fakeFetch('{"intent":"route_to","place":"ghat_ram","slot":null}') }),
    { intent: 'route_to', place: 'ghat_ram' },
  );
  assert.deepEqual(
    await chooseIntent('x', { key: 'k', fetchImpl: fakeFetch('Sure! {"intent":"nearest","slot":"water","place":"moon_base"}') }),
    { intent: 'nearest', slot: 'water' },
    'an invented place is dropped',
  );
  assert.equal(await chooseIntent('x', { key: 'k', fetchImpl: fakeFetch('{"intent":"book_a_hotel"}') }), null);
  assert.equal(await chooseIntent('x', { key: 'k', fetchImpl: fakeFetch('not json at all') }), null);
  assert.equal(await chooseIntent('x', { key: 'k', fetchImpl: fakeFetch('{}', { ok: false }) }), null);
  assert.equal(await chooseIntent('x', { key: 'k', fetchImpl: fakeFetch('{"intent":"sos"}', { stop: 'refusal' }) }), null);
  assert.equal(await chooseIntent('x', { fetchImpl: fakeFetch('{"intent":"nearest"}') }), null, 'no key, no call');
});

test('chooseIntent gives up quickly on a slow network', async () => {
  const slow = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const started = Date.now();
  assert.equal(await chooseIntent('x', { key: 'k', fetchImpl: slow, timeoutMs: 100 }), null);
  assert.ok(Date.now() - started < 1000);
});

test('rephrase returns the model text, or null to keep the original', async () => {
  assert.equal(await rephrase('A', 'q', { key: 'k', fetchImpl: fakeFetch('B') }), 'B');
  assert.equal(await rephrase('A', 'q', { key: 'k', fetchImpl: fakeFetch('', {}) }), null);
  assert.equal(await rephrase('A', 'q', { fetchImpl: fakeFetch('B') }), null);
});
