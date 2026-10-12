/**
 * Navigation engine tests. Pure logic — no server, no browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../public/shared/routing.js';
import { createGuide, routeLatLngs, turnAngle, spokenMetres } from '../public/shared/guidance.js';
import { nodeLatLng, nearestNode, onGround, groundBounds, toUnits, geo, metresBetween } from '../public/shared/mela-map.js';

/** Points every `step` metres along the route, like a GPS trace. */
function walk(result, step = 8) {
  const pts = routeLatLngs(result);
  const out = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    const n = Math.max(1, Math.round(metresBetween(a, b) / step));
    for (let k = 0; k < n; k += 1) out.push({ lat: a.lat + ((b.lat - a.lat) * k) / n, lng: a.lng + ((b.lng - a.lng) * k) / n });
  }
  out.push(pts[pts.length - 1]);
  return out;
}

test('geo and toUnits are inverses', () => {
  for (const [x, y] of [[0, 0], [500, 350], [1000, 700], [123.4, 567.8]]) {
    const back = toUnits(geo(x, y).lat, geo(x, y).lng);
    assert.ok(Math.abs(back.x - x) < 0.05 && Math.abs(back.y - y) < 0.05, `${x},${y} -> ${back.x},${back.y}`);
  }
});

test('nearestNode snaps a GPS fix to the right landmark', () => {
  const p = nodeLatLng('ghat_sangam');
  const near = nearestNode(p.lat + 0.0001, p.lng - 0.0001);
  assert.equal(near.node.id, 'ghat_sangam');
  assert.ok(near.metres < 20);
});

test('onGround tells the mela from somewhere else', () => {
  const b = groundBounds();
  assert.ok(onGround((b.north + b.south) / 2, (b.east + b.west) / 2));
  assert.ok(!onGround(19.0728, 72.8826), 'Mumbai is not on the mela ground');
});

test('a full walk ends in "arrived", with remaining distance falling', () => {
  const r = route('gate_2', 'ghat_sangam');
  const guide = createGuide(r, 'en');
  let last = Infinity;
  let p;
  let rises = 0;
  for (const fix of walk(r)) {
    p = guide.update(fix);
    if (p.remainingMetres > last + 2) rises += 1;
    last = p.remainingMetres;
    assert.equal(p.offRoute, false, 'walking the route is never off-route');
  }
  assert.equal(rises, 0, 'remaining distance only goes down');
  assert.equal(p.arrived, true);
  assert.match(p.text, /arrived at Sangam Ghat/);
  assert.equal(p.minutesLeft, 0);
});

test('instructions name the landmark and the turn, in each language', () => {
  const r = route('gate_2', 'ghat_sangam');
  const start = nodeLatLng(r.path[0]);
  const en = createGuide(r, 'en').update(start);
  assert.match(en.text, /^In \d+ m at .+, (go straight|keep (left|right)|turn (sharp )?(left|right)|turn around) towards .+/);
  assert.match(createGuide(r, 'hi').update(start).text, /मीटर बाद .+ पर/);
  assert.match(createGuide(r, 'mr').update(start).text, /मीटरनंतर .+ येथे/);
});

test('turn direction is right-handed: east then south is a right turn', () => {
  // j_cw -> j_c runs east along the spine; j_c -> police_1 goes south.
  assert.ok(turnAngle('j_cw', 'j_c', 'police_1') > 45);
  assert.ok(turnAngle('j_ce', 'j_c', 'police_1') < -45);
  assert.ok(Math.abs(turnAngle('j_cw', 'j_c', 'j_ce')) < 15);
});

test('wandering away is reported as off-route', () => {
  const r = route('gate_2', 'ghat_sangam');
  const guide = createGuide(r, 'en');
  const s = nodeLatLng(r.path[0]);
  guide.update(s);
  const away = guide.update({ lat: s.lat, lng: s.lng + 0.003 }); // ~300 m east
  assert.equal(away.offRoute, true);
  assert.ok(away.offByMetres > 200);
});

test('GPS accuracy widens the off-route threshold', () => {
  const r = route('gate_2', 'ghat_sangam');
  const guide = createGuide(r, 'en');
  const s = nodeLatLng(r.path[0]);
  const fix = { lat: s.lat, lng: s.lng + 0.0006, accuracy: 120 }; // ~60 m off, but GPS says ±120
  assert.equal(guide.update(fix).offRoute, false);
});

test('jitter near a junction does not flip the leg backwards', () => {
  const r = route('gate_2', 'ghat_sangam');
  const guide = createGuide(r, 'en');
  const fixes = walk(r);
  const mid = Math.floor(fixes.length / 2);
  let leg = -1;
  for (let i = 0; i <= mid; i += 1) leg = guide.update(fixes[i]).leg;
  // Bounce a couple of metres back and forth.
  for (let k = 0; k < 6; k += 1) {
    const back = guide.update(fixes[mid - (k % 2)]);
    assert.ok(back.leg >= leg - 1);
  }
});

test('a one-node route is arrived immediately', () => {
  const r = route('police_1', 'police_1');
  const p = createGuide(r, 'en').update(nodeLatLng('police_1'));
  assert.equal(p.arrived, true);
});

test('spoken distances round like people speak', () => {
  assert.equal(spokenMetres(12), 10);
  assert.equal(spokenMetres(147), 150);
  assert.equal(spokenMetres(612), 600);
});

/* ------------------------------------------- standing between landmarks -- */

import { planFrom } from '../public/shared/guidance.js';
import { EDGES } from '../public/shared/mela-map.js';

const lerp = (a, b, t) => ({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });

test('from mid-road, the plan never starts at a landmark that makes the trip longer', () => {
  // Try a spot along every path; find cases where the nearest landmark is the
  // wrong place to start, and check planFrom avoids it.
  let better = 0;
  for (const edge of EDGES) {
    for (const t of [0.3, 0.45, 0.6]) {
      const here = lerp(nodeLatLng(edge.a), nodeLatLng(edge.b), t);
      const plan = planFrom(here.lat, here.lng, 'ghat_sangam');
      const near = nearestNode(here.lat, here.lng);
      const naive = route(near.node.id, 'ghat_sangam');
      const naiveMinutes = naive.minutes + near.metres / 1.1 / 60;
      assert.ok(plan.minutes <= naiveMinutes + 1e-9, `${edge.id}@${t}`);
      if (plan.startId !== near.node.id && plan.minutes < naiveMinutes - 0.5) better += 1;
    }
  }
  assert.ok(better > 0, 'there are real spots where the nearest landmark is the wrong start');
});

test('with an origin, the first instruction is from where you stand', () => {
  const a = nodeLatLng('gate_2');
  const b = nodeLatLng('camp_b');
  const here = lerp(a, b, 0.5); // halfway up the road to Sector B Camp
  const plan = planFrom(here.lat, here.lng, 'ghat_sangam');
  const guide = createGuide(plan.result, 'en', { origin: here });
  const p = guide.update(here);
  assert.equal(p.offRoute, false);
  assert.match(p.text, new RegExp(`at ${plan.result.path.length > 1 ? '.+' : 'Sangam Ghat'}`));
  assert.ok(p.remainingMetres > plan.result.metres - 5, 'remaining includes the walk to the route');
  assert.notEqual(p.nextId, 'gate_2', 'never sends you back to the gate behind you');
});

test('a curving road that bulges 80 m off the straight line is not "off route"', () => {
  const r = route('gate_2', 'camp_b');
  const guide = createGuide(r, 'en');
  const a = nodeLatLng('gate_2');
  const b = nodeLatLng('camp_b');
  // Perpendicular unit offset, in degrees, for ~80 m.
  const dLat = b.lat - a.lat;
  const dLng = b.lng - a.lng;
  const len = metresBetween(a, b);
  const perp = { lat: -dLng * (80 / len), lng: dLat * (80 / len) };
  for (let i = 0; i <= 40; i += 1) {
    const t = i / 40;
    const bulge = Math.sin(Math.PI * t); // 0 at the ends, 1 in the middle
    const p = guide.update({ lat: a.lat + dLat * t + perp.lat * bulge, lng: a.lng + dLng * t + perp.lng * bulge });
    assert.equal(p.offRoute, false, `step ${i}`);
  }
});

test('walking away from the route sideways is "off route"', () => {
  const r = route('gate_2', 'ghat_sangam');
  const guide = createGuide(r, 'en');
  const a = nodeLatLng('gate_2');
  guide.update(a);
  let off = false;
  // Walk 10 m at a time due south-east, away from everything on this route.
  for (let i = 1; i <= 25 && !off; i += 1) {
    off = guide.update({ lat: a.lat - 0.00007 * i, lng: a.lng + 0.00007 * i }).offRoute;
  }
  assert.equal(off, true);
});
