/**
 * Browser end-to-end test: drives the real pilgrim app, volunteer queue,
 * control room and wristband page in headless Chrome (or Edge) over the
 * DevTools Protocol, against a throwaway database.
 *
 *   npm run test:browser
 *
 * Finds Chrome/Edge in the usual places, or set CHROME_PATH. Fails on any
 * failed check, uncaught exception or console error.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const project = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((p) => p && fs.existsSync(p));
if (!chrome) {
  console.log('No Chrome or Edge found — set CHROME_PATH to run the browser test.');
  process.exit(0);
}

const PORT = 3955;
const DEBUG = 9355;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'km-e2e-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const results = [];

const CREDS = { KM_ADMIN_KEY: 'KM-E2E0-E2E0-E2E0', KM_DEMO_PASSWORD: 'demo-pass-123', KM_ADMIN_PASSWORD: 'admin-pass-123' };
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: project, env: { ...process.env, PORT: String(PORT), KM_QUIET: '1', KM_DATA_FILE: path.join(tmp, 'data.json'), ANTHROPIC_API_KEY: '', ...CREDS },
  stdio: 'ignore',
});
const browser = spawn(chrome, ['--headless=new', `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${path.join(tmp, 'profile')}`,
  '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });

async function waitFor(url) {
  for (let i = 0; i < 80; i += 1) { try { const r = await fetch(url); if (r.ok) return r; } catch {} await sleep(150); }
  throw new Error(`timeout ${url}`);
}

async function openTab(name, url) {
  const res = await fetch(`http://127.0.0.1:${DEBUG}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
  const { webSocketDebuggerUrl } = await res.json();
  const ws = new WebSocket(webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(`[${name}] exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(`[${name}] console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      const text = msg.params.entry.text + ' ' + (msg.params.entry.url ?? '');
      // Chrome logs a refused WebSocket while the server restarts; not our bug.
      // The 401s from deliberately wrong sign-ins are expected.
      if (!/favicon|401 \(Unauthorized\) \S*\/api\/auth\/(login|key-login)$|403 \(Forbidden\) \S*\/api\/(sos|auth\/login)$/.test(text)) errors.push(`[${name}] log: ${text}`);
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    id += 1; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  const tab = {
    name,
    send,
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(`[${name}] eval failed: ${expr}\n${r.result.exceptionDetails.exception?.description}`);
      return r.result?.result?.value;
    },
    async go(u) { await send('Page.navigate', { url: u }); await sleep(1200); },
    async until(expr, ms = 6000) {
      const end = Date.now() + ms;
      // Mid-navigation the new page may not have its elements yet: not yet, not a failure.
      while (Date.now() < end) {
        try { if (await tab.eval(expr)) return true; } catch { /* page still loading */ }
        await sleep(150);
      }
      return false;
    },
  };
  await tab.go(url);
  return tab;
}

function check(label, ok) { results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}`); }

try {
  await waitFor(`${BASE}/api/health`);
  await waitFor(`http://127.0.0.1:${DEBUG}/json/version`);

  // ---------------------------------------------------------------- pilgrim
  const app = await openTab('pilgrim', `${BASE}/app/`);
  check('welcome screen renders three languages', await app.eval(`document.querySelectorAll('#welcome-langs button').length === 3`));
  check('welcome offers guest, new account, log in and security key', await app.eval(`document.querySelectorAll('#welcome-modes [data-mode]').length === 4 && document.querySelector('#welcome-modes [aria-selected="true"]').dataset.mode === 'guest'`));
  await app.eval(`document.querySelector('[data-mode="login"]').click()`);
  await app.eval(`document.querySelector('[data-mode="key"]').click()`);
  check('the security key option asks only for the key', await app.eval(`!document.querySelector('#field-key').hidden && document.querySelector('#field-name').hidden && document.querySelector('#field-phone').hidden`));
  await app.eval(`document.querySelector('[data-mode="login"]').click()`);
  check('log in mode asks for phone and PIN', await app.eval(`!document.querySelector('#field-phone').hidden && !document.querySelector('#field-pin').hidden && document.querySelector('#field-name').hidden`));
  await app.eval(`document.querySelector('#welcome-phone').value = '9999999999'; document.querySelector('#welcome-pin').value = '1234'; document.querySelector('#welcome-start').click()`);
  check('a wrong pilgrim login says so and stays on the welcome screen', await app.until(`!document.querySelector('#welcome-error').hidden && !document.querySelector('#welcome').classList.contains('hidden')`));
  await app.eval(`document.querySelector('[data-mode="guest"]').click()`);
  await app.eval(`document.querySelector('#welcome-langs button:nth-child(3)').click()`); // English
  await app.eval(`document.querySelector('#welcome-name').value = '<img src=x onerror="window.__pwned=1">Ravi'`);
  await app.eval(`document.querySelector('#welcome-start').click()`);
  check('guest sign-in opens the main app', await app.until(`!document.querySelector('#main').classList.contains('hidden')`));
  check('a sign-out button is in the top bar', await app.eval(`document.querySelector('#sign-out-top')?.getAttribute('aria-label') === 'Sign out' && document.querySelector('#sign-out-top').offsetParent !== null`));
  // Cancelling the "are you sure?" keeps the person signed in.
  await app.eval(`window.confirm = () => false; document.querySelector('#sign-out-top').click()`);
  check('cancelling sign-out keeps you in the app', await app.eval(`!document.querySelector('#main').classList.contains('hidden') && !!localStorage.getItem('km.token')`));
  check('home shows the facility tiles, least crowded ghat and Ask Mitra', await app.until(`document.querySelectorAll('#quick-actions .tile').length === 6`));
  check('the language menu opens and lists three languages', await app.eval(`(document.querySelector('.lang-btn').click(), !document.querySelector('.lang-menu').hidden && document.querySelectorAll('.lang-menu [data-lang]').length === 3)`));
  await app.eval(`document.querySelector('.lang-btn').click()`);
  check('the PWA icons exist', await app.eval(`Promise.all(['/icons/icon-192.png','/icons/icon-512.png','/icons/icon-maskable-512.png'].map(u => fetch(u).then(r => r.ok && r.headers.get('content-type') === 'image/png'))).then(a => a.every(Boolean))`));
  check('schedule panel lists events', await app.until(`document.querySelectorAll('#next-events .timeline-list li').length > 0`));

  await app.eval(`[...document.querySelectorAll('#tabs button')][1].click()`);
  check('live map opens with real tiles', await app.until(`!!document.querySelector('#map-live .leaflet-container')`));
  check('live map draws every path of the ground', await app.until(`document.querySelectorAll('#map-live .leaflet-overlay-pane path, #map-live .leaflet-kmEdges-pane path').length >= 43`));
  check('live-map landmarks are keyboard-focusable', await app.eval(`document.querySelectorAll('#map-live .lm-node-wrap[tabindex="0"]').length > 10`));
  await app.eval(`[...document.querySelectorAll('#map-live .lm-node-wrap')].find(m => m.title === 'Sangam Ghat').dispatchEvent(new MouseEvent('click', {bubbles:true}))`);
  check('tapping a landmark shows a route card with Start', await app.until(`!!document.querySelector('#route-card #nav-start')`));
  check('route card offers Google Maps hand-off', await app.eval(`(document.querySelector('#open-google')?.href ?? '').startsWith('https://www.google.com/maps/dir/?api=1&destination=25.')`));
  await app.eval(`document.querySelector('[data-mode="simple"]').click()`);
  check('simple (offline) map still works', await app.until(`document.querySelectorAll('#map-simple svg [data-edge]').length > 40 && document.querySelector('#map-live').hidden`));
  await app.eval(`document.querySelector('[data-mode="live"]').click()`);
  await app.eval(`document.querySelector('#clear-route')?.click()`);

  await app.eval(`[...document.querySelectorAll('#tabs button')][2].click()`);
  await app.eval(`document.querySelector('#make-group').click()`);
  check('creating a group shows a 6-character code', await app.until(`/^[A-Z0-9]{6}$/.test(document.querySelector('#group-body .code-card-code')?.textContent.trim() ?? '')`));
  const code = await app.eval(`document.querySelector('#group-body .code-card-code').textContent.trim()`);
  check('member name with HTML is shown as text, not markup', await app.eval(`!document.querySelector('#group-body img') && document.querySelector('#group-body').textContent.includes('<img')`));

  await app.eval(`[...document.querySelectorAll('#tabs button')][3].click()`);
  await app.eval(`document.querySelector('#mitra-input').value = 'where is the toilet'; document.querySelector('#mitra-send').click()`);
  check('Mitra answers a toilet question with directions', await app.until(`document.querySelectorAll('#thread .bubble').length >= 3 && !!document.querySelector('#thread .bubble-steps')`));
  check('Mitra answers carry Start walking and Show on map buttons', await app.eval(`document.querySelectorAll('#thread .bubble:last-child [data-act]').length >= 2`));
  await app.eval(`[...document.querySelectorAll('#quick-asks button')].find(b => /crowded there/i.test(b.textContent)).click()`);
  check('follow-up chip uses memory and shows a crowd meter', await app.until(`!!document.querySelector('#thread .bubble:last-child .crowd-meter')`));
  await app.eval(`document.querySelector('#mitra-input').value = 'emergency numbers'; document.querySelector('#mitra-send').click()`);
  check('helplines come as tap-to-call buttons', await app.until(`document.querySelectorAll('#thread a.call-btn[href^="tel:"]').length === 4`));
  check('the chat is kept on the phone', await app.eval(`JSON.parse(localStorage.getItem('km.mitra')).thread.length >= 6`));

  // SOS
  await app.eval(`document.querySelector('#sos-button').click()`);
  check('SOS sheet opens as a dialog', await app.until(`!document.querySelector('#sos-sheet').classList.contains('hidden') && document.querySelector('#sos-sheet [role=dialog]') !== null`));
  await app.eval(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))`);
  check('Escape closes the SOS sheet', await app.until(`document.querySelector('#sos-sheet').classList.contains('hidden')`));
  await app.eval(`document.querySelector('#sos-button').click()`);
  await app.eval(`document.querySelector('[data-kind="lost_person"]').click()`);
  await app.eval(`document.querySelector('#sos-who').value = 'girl, 6, <b>red</b> frock'; document.querySelector('#sos-confirm').click()`);
  check('SOS status appears after raising', await app.until(`!document.querySelector('#sos-status').classList.contains('hidden')`));
  check('outbox delivered the alert', await app.until(`JSON.parse(localStorage.getItem('km.outbox')||'[]').some(i => i.status === 'sent' && i.serverId)`));
  // Press through the flow again: must reuse the same key.
  await app.eval(`document.querySelector('#sos-button').click()`);
  await app.eval(`document.querySelector('[data-kind="lost_person"]').click()`);
  await app.eval(`document.querySelector('#sos-confirm').click()`);
  await sleep(800);

  // -------------------------------------------------------------- volunteer
  // -------------------------------------------------- volunteer: my tasks
  const vol = await openTab('volunteer', `${BASE}/volunteer/`);
  check('the volunteer page sends strangers to sign in', await vol.until(`location.pathname === '/volunteer/login.html' && !!document.querySelector('#login-phone')`));
  await vol.eval(`document.querySelector('#login-phone').value = '9000000099'; document.querySelector('#login-password').value = 'nope-nope'; document.querySelector('#login-go').click()`);
  check('a wrong volunteer password shows an error', await vol.until(`!document.querySelector('#message').hidden && document.querySelector('#message').textContent.length > 5`));
  // Lata Pawar is trained in child protection.
  await vol.eval(`document.querySelector('#login-phone').value = '9000000003'; document.querySelector('#login-password').value = '${CREDS.KM_DEMO_PASSWORD}'; document.querySelector('#login-go').click()`);
  check('a volunteer signs in and lands on My tasks', await vol.until(`location.pathname === '/volunteer/' && (document.querySelector('#me-chip')?.textContent ?? '').includes('Lata')`, 8000));
  check('with no task given, the page says so', await vol.until(`!!document.querySelector('#tasks .task-empty')`));
  check('volunteers cannot read the control room queue', (await vol.eval(`fetch('/api/sos', { headers: { authorization: 'Bearer ' + localStorage.getItem('km.vol.token') } }).then((r) => r.status)`)) === 403);
  check('the volunteer live map is drawn', await vol.until(`!!document.querySelector('#map-live .leaflet-container')`));
  check('volunteer map labels are in English', await vol.until(`[...document.querySelectorAll('#map-live .lm-label')].some(l => l.textContent === 'Lost & Found Chowki')`));
  await vol.eval(`window.confirm = () => true`);

  // ------------------------------------------- control room and its queue
  const admin = await openTab('admin', `${BASE}/admin/`);
  check('the control room sends strangers to its sign-in page', await admin.until(`location.pathname === '/admin/login.html' && !!document.querySelector('#login-key')`));
  const fillAdmin = (k) => admin.eval(`document.querySelector('#login-username').value = 'admin'; document.querySelector('#login-password').value = '${CREDS.KM_ADMIN_PASSWORD}'; document.querySelector('#login-key').value = '${k}'; document.querySelector('#login-go').click()`);
  await fillAdmin('KM-NOPE-NOPE-NOPE');
  check('the right password with the wrong security key is refused', await admin.until(`!document.querySelector('#message').hidden && location.pathname === '/admin/login.html'`));
  await fillAdmin(CREDS.KM_ADMIN_KEY);
  check('password plus security key opens the control room', await admin.until(`location.pathname === '/admin/' && !!document.querySelector('#sign-out')`, 8000));
  check('approvals are no longer on the control room page', await admin.eval(`!document.querySelector('#team')`));
  await admin.eval(`document.querySelector('#view-switch a[href="/admin/queue.html"]').click()`);
  check('admin switches to the volunteer queue', await admin.until(`location.pathname === '/admin/queue.html' && (document.querySelector('#me-chip')?.textContent ?? '').includes('C')`, 8000));
  check('the volunteer queue has no map', await admin.eval(`!document.querySelector('#map-live') && !document.querySelector('.map-frame')`));
  check('the queue lists volunteers for approval', await admin.until(`document.querySelectorAll('#team .team-row').length === 8`));
  check('the queue shows exactly one alert after two passes', await admin.until(`document.querySelectorAll('#queue .queue-item').length === 1`));
  check('subject label is escaped on the queue card', await admin.eval(`!document.querySelector('#queue b b') && document.querySelector('#queue').textContent.includes('<b>red</b>')`));
  check('roster lists eight volunteers', await admin.until(`document.querySelectorAll('#roster .member').length === 8`));
  check('tab title counts waiting alerts', await admin.eval(`document.title.startsWith('(1)')`));
  check('the assign list marks trained volunteers', await admin.until(`[...document.querySelector('[data-assign-for]').options].some(o => o.text.includes('Lata') && o.text.includes('trained'))`));
  await admin.eval(`const s = document.querySelector('[data-assign-for]'); s.value = [...s.options].find(o => o.text.includes('Lata')).value; document.querySelector('[data-assign]').click()`);
  check('the queue shows who the alert is assigned to', await admin.until(`document.querySelector('#queue').textContent.includes('Assigned to Lata')`));
  check('the task lands on the volunteer page at once', await vol.until(`document.querySelectorAll('#tasks .task-card').length === 1`, 8000));
  check('the task is on the volunteer map with the way there', await vol.until(`document.querySelectorAll('#map-live .lm-alert').length === 1 && document.querySelector('#detail').textContent.includes(' m · ')`));
  check('the volunteer tab title counts the task', await vol.eval(`document.title.startsWith('(1)')`));
  check('pilgrim sees "a volunteer is coming"', await app.until(`document.querySelector('#sos-status').textContent.includes('volunteer is coming')`, 8000));
  await vol.eval(`document.querySelector('#tasks [data-action="beacon"]').click()`);
  check('beacon lights the pilgrim screen', await app.until(`!document.querySelector('#beacon').classList.contains('hidden')`, 8000));
  await app.eval(`document.querySelector('#beacon-off').click()`);
  check('pilgrim can switch the beacon off', await app.until(`document.querySelector('#beacon').classList.contains('hidden')`));

  // Wristband path
  await vol.eval(`document.querySelector('#band-code').value = '${code}'; document.querySelector('#band-go').click()`);
  check('band lookup finds the family', await vol.until(`!!document.querySelector('#band-found')`));
  await vol.eval(`document.querySelector('#band-desc').value = 'boy, ~8'; document.querySelector('#band-found').click()`);
  check('family gets the green reunion banner', await app.until(`!document.querySelector('#reunion-bar').classList.contains('hidden')`, 8000));

  await vol.eval(`document.querySelector('#tasks [data-action="resolve"]').click()`);
  check('finishing a task moves it to "finished today"', await vol.until(`document.querySelectorAll('#tasks .task-card').length === 0 && !!document.querySelector('#done details')`));
  check('the queue sees it closed', await admin.until(`document.querySelectorAll('#queue .queue-item').length === 0`));

  // Talking to volunteers: one-to-one messages, a call button, and tasks for everyone.
  check('the queue no longer has notices or the band lookup', await admin.eval(`!document.querySelector('#vol-notices') && !document.querySelector('#band-code')`));
  check('each volunteer has Message and Call', await admin.until(`document.querySelectorAll('#roster [data-chat]').length === 8 && document.querySelectorAll('#roster a[href^="tel:"]').length === 8`));
  await admin.eval(`[...document.querySelectorAll('#roster [data-chat]')].find(b => b.getAttribute('aria-label').includes('Lata')).click()`);
  check('Message opens a thread with that volunteer', await admin.until(`!document.querySelector('#chat-panel').hidden && document.querySelector('#chat-title').textContent.includes('Lata')`));
  await admin.eval(`document.querySelector('#chat-input').value = 'Please check Gate 2 <b>now</b>'; document.querySelector('#chat-send').click()`);
  check('the message reaches the volunteer at once, escaped', await vol.until(`document.querySelector('#chat-thread').textContent.includes('Please check Gate 2 <b>now</b>') && !document.querySelector('#chat-thread b')`, 8000));
  check('the volunteer sees it is new', await vol.eval(`!document.querySelector('#msg-count').hidden`));
  await vol.eval(`document.querySelector('#chat-input').value = 'On my way'; document.querySelector('#chat-send').click()`);
  check('the reply shows in the control room thread', await admin.until(`document.querySelector('#chat-thread').textContent.includes('On my way')`, 8000));
  await admin.eval(`document.querySelector('#board-title').value = 'Two people to Gate 3'; document.querySelector('#board-place').value = 'gate_3'; document.querySelector('#board-needed').value = '2'; document.querySelector('#board-post').click()`);
  check('a task for all volunteers appears on the volunteer page', await vol.until(`document.querySelector('#board-list').textContent.includes('Two people to Gate 3')`, 8000));
  await vol.eval(`document.querySelector('[data-board-help]').click()`);
  check('"I\'ll help" shows in the control room', await admin.until(`document.querySelector('#board-list').textContent.includes('1 of 2 helping') && document.querySelector('#board-list').textContent.includes('Lata')`, 8000));
  await vol.eval(`document.querySelector('[data-board-way]').click()`);
  check('"Show the way" routes the volunteer map to the task', await vol.until(`!!document.querySelector('#map-live .leaflet-kmRoute-pane path') && document.querySelector('#detail').textContent.includes('Task for all volunteers')`));
  await admin.eval(`document.querySelector('#view-switch a[href="/admin/"]').click()`);
  check('admin switches back to the control room', await admin.until(`location.pathname === '/admin/' && document.querySelectorAll('#stats .stat').length === 6`, 8000));
  check('control room renders six stats', await admin.until(`document.querySelectorAll('#stats .stat').length === 6`));
  await admin.eval(`document.querySelector('#sim-go').click()`);
  check('control room live map shows every volunteer', await admin.until(`document.querySelectorAll('#map-live .lm-vol').length === 8`));
  check('simulated crowd draws pressure circles', await admin.until(`document.querySelectorAll('#map-live .leaflet-kmPressure-pane path').length > 0`));
  await admin.eval(`document.querySelectorAll('#map-live .lm-edge-hit')[3].dispatchEvent(new MouseEvent('click', {bubbles: true}))`);
  check('clicking a path on the live map opens its controls', await admin.until(`document.querySelectorAll('#edge-controls [data-level]').length === 4`));
  check('simulated arrivals produce a crush row with Close approach', await admin.until(`!!document.querySelector('[data-close-approach]')`));
  const approach = await admin.eval(`document.querySelector('[data-close-approach]').dataset.closeApproach`);
  check(`Close approach targets the junction path (got ${approach})`, approach === 'e04');
  await admin.eval(`document.querySelector('[data-close-approach]').click()`);
  check('closing shows in flagged paths', await admin.until(`document.querySelector('#flag-list').textContent.includes('Sangam')`));
  await admin.eval(`document.querySelector('#flag-list [data-clear]').click()`);
  check('Reset removes the flag', await admin.until(`document.querySelector('#flag-list').textContent.includes('No paths flagged')`));

  await admin.eval(`window.confirm = () => true; document.querySelector('#notice-en').value = 'Gate 3 is <script>closed</script>'; document.querySelector('#notice-severity').value = 'urgent'; document.querySelector('#notice-send').click()`);
  check('notice appears in "live on phones"', await admin.until(`document.querySelectorAll('#notice-list [data-withdraw]').length >= 1`));
  await app.eval(`[...document.querySelectorAll('#tabs button')][0].click()`);
  check('pilgrim sees the urgent notice, escaped', await app.until(`[...document.querySelectorAll('#notices .alert-card[data-tone="urgent"]')].some(n => n.textContent.includes('<script>closed</script>'))`, 8000));
  await admin.eval(`[...document.querySelectorAll('#notice-list .notice')].find(n => n.textContent.includes('Gate 3')).querySelector('[data-withdraw]').click()`);
  check('withdrawn notice disappears from the pilgrim app', await app.until(`![...document.querySelectorAll('#notices .alert-card')].some(n => n.textContent.includes('Gate 3'))`, 8000));

  // ------------------------------------------------------------- wristband
  const band = await openTab('wristband', `${BASE}/app/wristband.html`);
  check('wristband page renders three QR bands', await band.until(`document.querySelectorAll('.band svg').length === 3`));
  await band.eval(`const c = document.querySelector('#count'); c.value = 500; c.dispatchEvent(new Event('input'))`);
  check('band count is capped at 10', await band.until(`document.querySelectorAll('.band').length === 10`));
  check('the + button stops at 10 bands', await band.eval(`document.querySelector('#count-up').disabled`));
  await band.eval(`document.querySelector('#count-down').click()`);
  check('the − button takes one band away', await band.until(`document.querySelectorAll('.band').length === 9 && document.querySelector('#count').value === '9'`));

  // ------------------------------------------------------ GPS navigation
  {
    const mm = await import(new URL('../public/shared/mela-map.js', import.meta.url));
    const at = (id) => mm.nodeLatLng(id);
    // Chrome pauses geolocation in background tabs; the pilgrim is looking at this one.
    await app.send('Page.bringToFront');
    await app.send('Browser.grantPermissions', { origin: BASE, permissions: ['geolocation'] });
    await app.send('Emulation.setGeolocationOverride', { latitude: at('gate_2').lat, longitude: at('gate_2').lng, accuracy: 10 });
    await app.eval(`[...document.querySelectorAll('#tabs button')][1].click()`);
    await app.eval(`document.querySelector('#locate-me').click()`);
    check('GPS fix on the ground is shown with its accuracy', await app.until(`/±[0-9]+ m/.test(document.querySelector('#gps-status').textContent)`, 12000));
    check('the blue position dot is drawn', await app.until(`!!document.querySelector('#map-live .lm-you:not(.is-chosen)')`));
    await app.eval(`[...document.querySelectorAll('#map-live .lm-node-wrap')].find(m => m.title === 'Sangam Ghat').dispatchEvent(new MouseEvent('click', {bubbles:true}))`);
    await app.until(`!!document.querySelector('#nav-start')`);
    await app.eval(`document.querySelector('#nav-start').click()`);
    check('turn-by-turn banner names a landmark and a distance', await app.until(`/[0-9]+ m/.test(document.querySelector('#nav-dist').textContent) && document.querySelector('#nav-instr').textContent.length > 10`));
    // Walk part of the way: Gate 2 -> Sector B Camp.
    const a = at('gate_2'); const b = at('camp_b');
    for (let k = 1; k <= 5; k += 1) {
      await app.send('Emulation.setGeolocationOverride', { latitude: a.lat + ((b.lat - a.lat) * k) / 6, longitude: a.lng + ((b.lng - a.lng) * k) / 6, accuracy: 8 });
      await sleep(400);
    }
    check('remaining distance falls as you walk', await app.until(`parseFloat(document.querySelector('#nav-summary span').textContent) < 2`, 4000));
    // The control room closes a path ahead.
    const adminToken = (await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'admin', username: 'admin', password: CREDS.KM_ADMIN_PASSWORD, securityKey: CREDS.KM_ADMIN_KEY }) })).json()).token;
    await fetch(`${BASE}/api/map/flags/e18`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ level: 4 }) });
    check('closing a path ahead re-routes mid-walk', await app.until(`(document.querySelector('.toast')?.textContent ?? '').includes('New route')`, 6000));
    await fetch(`${BASE}/api/map/flags/e18`, { method: 'DELETE', headers: { authorization: `Bearer ${adminToken}` } });
    await app.eval(`document.querySelector('#nav-end').click()`);
    check('ending navigation hides the banner', await app.until(`document.querySelector('#nav-top').classList.contains('hidden')`));
    await app.send('Emulation.clearGeolocationOverride');
  }

  // ------------------------------------------------- mesh relay (README demo)
  await app.eval(`document.querySelector('#airplane').click()`);
  check('airplane switch puts this tab offline', await app.until(`document.querySelector('#net-dot').dataset.state !== 'online'`));
  await app.eval(`document.querySelector('#sos-button').click()`);
  await app.eval(`document.querySelector('[data-kind="medical"]').click()`);
  await app.eval(`document.querySelector('#sos-confirm').click()`);
  check('offline SOS says waiting, not sent', await app.until(`document.querySelector('#sos-status').textContent.includes('Waiting for network')`));
  const stranger = await openTab('nearby-phone', `${BASE}/app/`);
  check('a nearby phone carries the alert over the mesh', await app.until(
    `JSON.parse(localStorage.getItem('km.outbox')||'[]').some(i => i.payload.kind === 'medical' && i.deliveredBy === 'mesh')`, 20000));
  await app.eval(`document.querySelector('#airplane').click()`);

  // ------------------------------------------------------- light / dark
  const PAGE_DARK = 'rgb(12, 26, 29)';
  const PAGE_LIGHT = 'rgb(253, 246, 233)';
  const bodyBg = 'getComputedStyle(document.body).backgroundColor';
  await app.eval(`document.querySelector('#theme-switch .theme-btn').click()`);
  check('theme menu offers light, dark and automatic', await app.eval(`document.querySelectorAll('#theme-switch [data-theme-choice]').length === 3`));
  await app.eval(`document.querySelector('#theme-switch [data-theme-choice="dark"]').click()`);
  check('choosing Dark switches the page to dark colours', await app.until(`document.documentElement.dataset.theme === 'dark' && ${bodyBg} === '${PAGE_DARK}'`));
  const volDark = await openTab('volunteer-dark', `${BASE}/volunteer/`);
  check('the choice carries to the volunteer screen before it paints', await volDark.eval(`document.documentElement.dataset.theme === 'dark' && ${bodyBg} === '${PAGE_DARK}'`));
  await app.send('Page.bringToFront');
  await app.eval(`document.querySelector('#theme-switch .theme-btn').click(); document.querySelector('#theme-switch [data-theme-choice="auto"]').click()`);
  await app.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  check('Automatic follows a phone set to dark', await app.until(`!document.documentElement.dataset.theme && ${bodyBg} === '${PAGE_DARK}'`));
  await app.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  check('Automatic follows a phone set to light', await app.until(`${bodyBg} === '${PAGE_LIGHT}'`));
  await app.eval(`document.querySelector('#theme-switch .theme-btn').click()`);
  await app.eval(`document.querySelector('#theme-switch .theme-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  check('Escape closes the theme menu', await app.eval(`document.querySelector('#theme-switch .theme-menu').hidden`));

  // A brand-new volunteer: registers, cannot log in, the admin approves in the queue, then they can.
  await vol.send('Page.bringToFront');
  await vol.eval(`document.querySelector('#sign-out').click()`);
  check('volunteer sign-out returns to the sign-in page', await vol.until(`location.pathname === '/volunteer/login.html' && !document.querySelector('#message').hidden`));
  await vol.eval(`document.querySelector('[data-tab="register"]').click();
    document.querySelector('#reg-name').value = 'Nisha Verma';
    document.querySelector('#reg-phone').value = '9811122333';
    document.querySelector('#reg-password').value = 'helping-hands';
    document.querySelector('#reg-password2').value = 'helping-hands';
    document.querySelector('#register-go').click()`);
  check('registering says to wait for approval and stays on the sign-in page', await vol.until(`location.pathname === '/volunteer/login.html' && document.querySelector('#message').textContent.includes('approve')`, 8000));
  await vol.eval(`document.querySelector('#login-phone').value = '9811122333'; document.querySelector('#login-password').value = 'helping-hands'; document.querySelector('#login-go').click()`);
  check('a waiting volunteer cannot log in', await vol.until(`location.pathname === '/volunteer/login.html' && document.querySelector('#message').textContent.includes('waiting')`));
  await admin.send('Page.bringToFront');
  await admin.eval(`document.querySelector('#view-switch a[href="/admin/queue.html"]').click()`);
  check('the registration waits in the volunteer queue', await admin.until(`location.pathname === '/admin/queue.html' && [...document.querySelectorAll('#team .team-row[data-status="pending"]')].some(r => r.textContent.includes('Nisha')) && !document.querySelector('#team-count').hidden`, 8000));
  await admin.eval(`[...document.querySelectorAll('#team .team-row')].find(r => r.textContent.includes('Nisha')).querySelector('[data-action="approve"]').click()`);
  check('approving moves them out of the waiting list', await admin.until(`![...document.querySelectorAll('#team .team-row[data-status="pending"]')].some(r => r.textContent.includes('Nisha'))`));
  await vol.send('Page.bringToFront');
  await vol.eval(`document.querySelector('#login-go').click()`);
  check('once approved, the volunteer logs in to My tasks', await vol.until(`location.pathname === '/volunteer/' && (document.querySelector('#me-chip')?.textContent ?? '').includes('Nisha') && !!document.querySelector('#tasks .task-empty')`, 8000));

  // The security key: straight in, no registration.
  await vol.eval(`document.querySelector('#sign-out').click()`);
  await vol.until(`location.pathname === '/volunteer/login.html' && !!document.querySelector('[data-tab="key"]')`);
  await vol.eval(`document.querySelector('[data-tab="key"]').click(); document.querySelector('#key-code').value = 'KM-WRONG'; document.querySelector('#key-go').click()`);
  check('the security key tab asks only for the key', await vol.eval(`!document.querySelector('#key-name') && !document.querySelector('#key-phone') && !!document.querySelector('#key-code')`));
  check('a wrong security key is refused on the volunteer page', await vol.until(`!document.querySelector('#message').hidden && location.pathname === '/volunteer/login.html'`));
  await vol.eval(`document.querySelector('#key-code').value = '${CREDS.KM_ADMIN_KEY}'; document.querySelector('#key-go').click()`);
  check('the security key opens My tasks with no registration or approval', await vol.until(`location.pathname === '/volunteer/' && /Volunteer [0-9]+/.test(document.querySelector('#me-chip')?.textContent ?? '') && document.querySelector('#pending-panel')?.hidden === true`, 8000));

  check('no injected markup ever executed', !(await app.eval('window.__pwned')) && !(await vol.eval('window.__pwned')));
} catch (err) {
  errors.push(`driver: ${err.stack}`);
} finally {
  console.log(results.join('\n'));
  console.log(errors.length ? `\nBROWSER ERRORS:\n${errors.join('\n')}` : '\nno browser errors');
  browser.kill(); server.kill();
  await sleep(500);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(results.some((r) => r.startsWith('FAIL')) || errors.length ? 1 : 0);
}
