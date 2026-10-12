import {
  request, requestCached, enqueue, outbox, pendingCount, flushOutbox,
  getToken, getUser, setSession, clearSession, onStateChange, state, cache, cached, newIdempotencyKey,
  isSimulatedOffline, setSimulatedOffline, meshInfo, clearSentOlderThan,
} from '/shared/api.js';
import { esc, initial, connectLive, debounce, toast, dialog, buzz } from '/shared/dom.js';
import { icon, PLACE_COLOUR } from '/shared/icons.js';
import { mountThemeSwitch } from '/shared/theme.js';
import { t, sign, lang, setLang, LANGS, placeName, relativeTime } from '/shared/i18n.js';
import { NODES, NODE_BY_ID, CROWD, nodeLatLng, nearestNode, metresBetween } from '/shared/mela-map.js';
import { route, directions, nearest } from '/shared/routing.js';
import { createMap, crowdLegendHTML } from '/shared/mapview.js';
import { createLiveMap, liveMapAvailable } from '/shared/livemap.js';
import { createLocator } from '/shared/location.js';
import { createGuide, routeLatLngs, spokenMetres, planFrom } from '/shared/guidance.js';
import { respond, suggestions as mitraSuggestions, HELPLINES } from '/shared/mitra.js';

const $ = (sel) => document.querySelector(sel);

const app = {
  user: getUser(),
  page: 'home',
  you: localStorage.getItem('km.place') || 'gate_2',
  flags: cached('flags', {}),
  group: cached('group', null),
  members: cached('members', []),
  schedule: cached('schedule', []),
  notices: cached('notices', []),
  myAlerts: cached('myAlerts', []),
  routeTo: null,
  thread: [],
  warnings: cached('warnings', []),
  reunions: [],
  beacon: null,
  gps: null,          // last position fix on this phone (never sent as-is)
  gpsStatus: 'off',
  nav: null,          // the walk in progress, if any
  arrivedAt: null,
  voice: localStorage.getItem('km.voice') !== '0',
};

let sosSheet = null;
let started = false;

/** English or Hindi copy for strings that only exist in those two. */
const say = (en, hi) => (lang() === 'en' ? en : hi);

/* ------------------------------------------------------------- boot ---- */

let themeSwitches = [];
let installPrompt = null;
let offlineReady = false;

const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

/**
 * The install card. Shown when the browser can install the app (or on an
 * iPhone, with instructions), until it is installed or dismissed.
 */
function renderInstallCard() {
  const box = $('#install-card');
  if (!box) return;
  let dismissed = false;
  try { dismissed = localStorage.getItem('km.installDismissed') === '1'; } catch { /* show it */ }
  const ios = isIOS() && !installPrompt;
  if (isStandalone() || dismissed || (!installPrompt && !ios)) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <div class="install-card">
      <span class="install-icon"><img src="/icons/icon-192.png" alt="" width="44" height="44"></span>
      <span class="install-body">
        <b>${tr({ en: 'Install Kumbh-a-Mitra', hi: 'कुंभ-अ-मित्र इंस्टॉल करें', mr: 'कुंभ-अ-मित्र इंस्टॉल करा' })}</b>
        <span>${ios
          ? tr({ en: 'Tap Share, then "Add to Home Screen". It opens like an app, even with no signal.', hi: 'शेयर दबाएँ, फिर "Add to Home Screen"। ऐप की तरह खुलेगा, बिना नेटवर्क के भी।', mr: 'शेअर दाबा, मग "Add to Home Screen". ॲपसारखे उघडेल, नेटवर्कशिवायही.' })
          : tr({ en: 'Opens like an app, even with no signal.', hi: 'ऐप की तरह खुलेगा, बिना नेटवर्क के भी।', mr: 'ॲपसारखे उघडेल, नेटवर्कशिवायही.' })}</span>
      </span>
      ${ios ? '' : `<button class="btn btn-go btn-sm" id="install-go">${tr({ en: 'Install', hi: 'इंस्टॉल', mr: 'इंस्टॉल' })}</button>`}
      <button class="install-close" id="install-close" aria-label="${tr({ en: 'Not now', hi: 'अभी नहीं', mr: 'आत्ता नको' })}">${icon('close', { size: 18 })}</button>
    </div>`;
  $('#install-go')?.addEventListener('click', async () => {
    const prompt = installPrompt;
    installPrompt = null;
    if (!prompt) return;
    prompt.prompt();
    try { await prompt.userChoice; } catch { /* dismissed */ }
    renderInstallCard();
  });
  $('#install-close').onclick = () => {
    try { localStorage.setItem('km.installDismissed', '1'); } catch { /* fine */ }
    renderInstallCard();
  };
}

function boot() {
  loadMitra();
  // Delivered alerts older than 12 hours are history; drop them so the
  // outbox does not grow for the whole mela. Unsent ones are never touched.
  clearSentOlderThan(12);
  // Light / dark / automatic: in the top bar and on the welcome screen.
  themeSwitches = [
    mountThemeSwitch($('#theme-switch'), { getLang: lang }),
    mountThemeSwitch($('#welcome-theme'), { getLang: lang }),
  ];
  renderWelcomeLangs();
  $('#welcome-start').addEventListener('click', startAsGuest);
  for (const id of ['#welcome-name', '#welcome-phone', '#welcome-pin', '#welcome-pin2', '#welcome-key']) {
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') startAsGuest(); });
  }
  window.addEventListener('km:lang', () => {
    // Guidance mid-walk switches language at the next instruction.
    if (app.nav) { app.nav.guide = createGuide(app.nav.result, lang(), { origin: app.nav.guide.origin }); app.nav.lastKey = ''; }
    renderAll();
  });
  sosSheet = dialog($('#sos-sheet'));

  // The server no longer recognises this phone (the demo database was reset).
  // Anything waiting in the outbox stays there and goes out under the new
  // sign-in, so an alert raised just before this is not lost.
  window.addEventListener('km:unauthorised', () => {
    clearSession();
    app.user = null;
    // A different person may sign in on this phone next; their chat starts empty.
    app.thread = [];
    app.mitraMemory = {};
    saveMitra();
    $('#main').classList.add('hidden');
    $('#welcome').classList.remove('hidden');
    toast(say('Please start again — the server was reset.', 'कृपया फिर से शुरू करें — सर्वर रीसेट हुआ है।'));
  });

  if (getToken() && app.user) {
    showMain();
  } else {
    $('#welcome').classList.remove('hidden');
    $('#main').classList.add('hidden');
  }

  onStateChange(renderNetwork);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    // Only claim "works offline" once the app really is saved on the phone.
    navigator.serviceWorker.ready.then(() => { offlineReady = true; if (app.page === 'home') renderHome(); }).catch(() => {});
  }
  // Install to the home screen. Chrome/Android hand us a prompt to show later;
  // iPhone has none, so we explain the Share → Add to Home Screen steps.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    if (app.page === 'home') renderHome();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    try { localStorage.setItem('km.installDismissed', '1'); } catch { /* fine */ }
    if (app.page === 'home') renderHome();
  });
}

const LANG_SAMPLE = { hi: 'नमस्ते', mr: 'नमस्कार', en: 'Hello' };
const LANG_SHORT = { hi: 'हि', mr: 'म', en: 'EN' };

function renderWelcomeLangs() {
  const box = $('#welcome-langs');
  box.innerHTML = '';
  for (const l of LANGS) {
    const button = document.createElement('button');
    const on = lang() === l.code;
    button.className = 'lang-card';
    button.lang = l.code;
    button.setAttribute('aria-pressed', String(on));
    button.innerHTML = `
      <span class="lang-native">${l.label}</span>
      <span class="lang-sample">${LANG_SAMPLE[l.code]}</span>
      <span class="lang-check">${icon('check', { size: 20 })}</span>`;
    button.addEventListener('click', () => {
      setLang(l.code);
      renderWelcomeLangs();
      renderWelcomeCopy();
      themeSwitches.forEach((s) => s.render());
    });
    box.appendChild(button);
  }
  renderWelcomeCopy();
}

/**
 * Three ways in, guest first. Guest is the default and the fastest: an SOS
 * button behind a login is a safety failure. An account (phone + PIN) only
 * adds one thing — the same identity on another phone.
 */
let welcomeMode = 'guest';
const MODES = {
  guest: { label: { en: 'Guest', hi: 'मेहमान', mr: 'पाहुणे' },
    hint: { en: 'Start straight away. No phone number needed — the red help button works at once.', hi: 'तुरंत शुरू करें। फ़ोन नंबर की ज़रूरत नहीं — लाल मदद बटन तुरंत काम करेगा।', mr: 'लगेच सुरू करा. फोन नंबर लागत नाही — लाल मदत बटण लगेच चालेल.' } },
  new: { label: { en: 'New account', hi: 'नया खाता', mr: 'नवीन खाते' },
    hint: { en: 'Use the same account on another phone. Choose a 4–6 digit PIN you will remember.', hi: 'दूसरे फ़ोन पर भी वही खाता। 4–6 अंकों का ऐसा PIN चुनें जो याद रहे।', mr: 'दुसऱ्या फोनवरही तेच खाते. लक्षात राहील असा 4–6 अंकी PIN निवडा.' } },
  login: { label: { en: 'Log in', hi: 'लॉग इन', mr: 'लॉग इन' },
    hint: { en: 'Already have an account? Enter your number and PIN.', hi: 'पहले से खाता है? अपना नंबर और PIN डालें।', mr: 'आधीच खाते आहे? तुमचा नंबर आणि PIN टाका.' } },
  key: { label: { en: 'Security key', hi: 'सुरक्षा कुंजी', mr: 'सुरक्षा की' },
    hint: { en: 'Have the security key from the control room? Go straight in — no registration.', hi: 'नियंत्रण कक्ष की सुरक्षा कुंजी है? सीधे अंदर जाएँ — कोई पंजीकरण नहीं।', mr: 'नियंत्रण कक्षाची सुरक्षा की आहे? थेट आत जा — नोंदणी नाही.' } },
};

function renderWelcomeCopy() {
  $('#mode-title').textContent = tr({ en: 'How do you want to start?', hi: 'कैसे शुरू करना है?', mr: 'कसे सुरू करायचे?' });
  $('#welcome-modes').innerHTML = Object.entries(MODES).map(([id, m]) =>
    `<button role="tab" data-mode="${id}" aria-selected="${welcomeMode === id}">${tr(m.label)}</button>`).join('');
  $('#welcome-modes').querySelectorAll('[data-mode]').forEach((b) => {
    b.onclick = () => { welcomeMode = b.dataset.mode; showWelcomeError(''); renderWelcomeCopy(); };
  });
  $('#mode-hint').textContent = tr(MODES[welcomeMode].hint);
  $('#field-name').hidden = welcomeMode === 'login' || welcomeMode === 'key';
  $('#field-phone').hidden = welcomeMode === 'guest' || welcomeMode === 'key';
  $('#field-pin').hidden = welcomeMode === 'guest' || welcomeMode === 'key';
  $('#field-key').hidden = welcomeMode !== 'key';
  $('#label-key').textContent = tr({ en: 'Security key', hi: 'सुरक्षा कुंजी', mr: 'सुरक्षा की' });
  $('#field-pin2').hidden = welcomeMode !== 'new';
  $('#label-name').textContent = welcomeMode === 'guest' || welcomeMode === 'key'
    ? tr({ en: 'Your name (optional)', hi: 'आपका नाम (ज़रूरी नहीं)', mr: 'तुमचे नाव (ऐच्छिक)' }) : t('nameAsk');
  $('#label-phone').textContent = tr({ en: 'Mobile number', hi: 'मोबाइल नंबर', mr: 'मोबाइल नंबर' });
  $('#label-pin').textContent = tr({ en: 'PIN (4–6 digits)', hi: 'PIN (4–6 अंक)', mr: 'PIN (4–6 अंक)' });
  $('#label-pin2').textContent = tr({ en: 'PIN again', hi: 'PIN दोबारा', mr: 'PIN पुन्हा' });
  $('#welcome-pin').autocomplete = welcomeMode === 'new' ? 'new-password' : 'current-password';
  $('#welcome-name').placeholder = tr({ en: 'e.g. Asha', hi: 'जैसे: आशा', mr: 'उदा. आशा' });
  const start = {
    guest: sign('start'),
    new: `<span class="sign"><span class="sign-primary">${tr({ en: 'Create account', hi: 'खाता बनाएँ', mr: 'खाते बनवा' })}</span><span class="sign-secondary">${lang() === 'en' ? 'खाता बनाएँ' : 'Create account'}</span></span>`,
    login: `<span class="sign"><span class="sign-primary">${tr({ en: 'Log in', hi: 'लॉग इन करें', mr: 'लॉग इन करा' })}</span><span class="sign-secondary">${lang() === 'en' ? 'लॉग इन करें' : 'Log in'}</span></span>`,
    key: `<span class="sign"><span class="sign-primary">${tr({ en: 'Enter with the key', hi: 'कुंजी से अंदर जाएँ', mr: 'की ने आत जा' })}</span><span class="sign-secondary">${lang() === 'en' ? 'कुंजी से अंदर जाएँ' : 'Enter with the key'}</span></span>`,
  };
  $('#welcome-start-label').innerHTML = start[welcomeMode];
}

function showWelcomeError(text) {
  const box = $('#welcome-error');
  box.hidden = !text;
  box.innerHTML = text ? `${icon('warning', { size: 20 })}<span>${esc(text)}</span>` : '';
}

/** Text in all three languages, falling back to Hindi. */
function tr(o) { return o[lang()] ?? o.hi; }

async function startAsGuest() {
  const button = $('#welcome-start');
  if (button.disabled) return;
  const displayName = $('#welcome-name').value.trim();
  const phone = $('#welcome-phone').value.replace(/\D/g, '');
  const pin = $('#welcome-pin').value.trim();
  showWelcomeError('');

  if (welcomeMode === 'key' && !$('#welcome-key').value.trim()) {
    showWelcomeError(tr({ en: 'Type the security key.', hi: 'सुरक्षा कुंजी लिखें।', mr: 'सुरक्षा की लिहा.' }));
    return;
  }
  if (welcomeMode === 'new' || welcomeMode === 'login') {
    if (phone.length < 10) { showWelcomeError(tr({ en: 'Enter your 10-digit mobile number.', hi: '10 अंकों का मोबाइल नंबर डालें।', mr: '10 अंकी मोबाइल नंबर टाका.' })); return; }
    if (!/^\d{4,6}$/.test(pin)) { showWelcomeError(tr({ en: 'The PIN is 4 to 6 digits.', hi: 'PIN 4 से 6 अंकों का होता है।', mr: 'PIN 4 ते 6 अंकी असतो.' })); return; }
    if (welcomeMode === 'new' && pin !== $('#welcome-pin2').value.trim()) { showWelcomeError(tr({ en: 'The two PINs do not match.', hi: 'दोनों PIN एक जैसे नहीं हैं।', mr: 'दोन्ही PIN जुळत नाहीत.' })); return; }
  }

  button.disabled = true;
  try {
    const call = {
      guest: () => request('/api/auth/guest', { method: 'POST', body: { displayName, language: lang() } }),
      new: () => request('/api/auth/register', { method: 'POST', body: { role: 'pilgrim', displayName, phone, password: pin, language: lang() } }),
      login: () => request('/api/auth/login', { method: 'POST', body: { role: 'pilgrim', phone, password: pin } }),
      key: () => request('/api/auth/key-login', { method: 'POST', body: { role: 'pilgrim', securityKey: $('#welcome-key').value.trim(), language: lang() } }),
    }[welcomeMode];
    const data = await call();
    // A different person may have used this phone before: start clean.
    if (welcomeMode !== 'guest') { app.thread = []; app.mitraMemory = {}; saveMitra(); }
    setSession(data.token, data.user);
    app.user = data.user;
    $('#welcome-pin').value = '';
    $('#welcome-key').value = '';
    $('#welcome-pin2').value = '';
    showMain();
    flushOutbox();
  } catch (err) {
    showWelcomeError(err.offline
      ? say('Could not reach the server. Check the network and try again.', 'सर्वर से संपर्क नहीं हुआ। नेटवर्क जाँचें और फिर कोशिश करें।')
      : err.data?.message ?? say('That did not work. Try again.', 'यह नहीं हुआ। फिर कोशिश करें।'));
  } finally {
    button.disabled = false;
  }
}

/**
 * Sign out of this phone. A guest has no way back in, so they are told what
 * they will lose and offered to save the account first.
 */
async function signOut() {
  const guest = app.user?.guest;
  const message = guest
    ? say('You are using a guest account. If you sign out, this account and your family group on this phone cannot be recovered. Save your account first if you want to keep them. Sign out anyway?',
      'आप मेहमान खाते में हैं। साइन आउट करने पर यह खाता और इस फ़ोन पर आपका परिवार समूह वापस नहीं मिलेगा। रखना है तो पहले खाता सहेजें। फिर भी साइन आउट करें?')
    : say('Sign out of this phone?', 'इस फ़ोन से साइन आउट करें?');
  if (!confirm(message)) return;
  if (app.nav) endNav();
  try { await request('/api/auth/logout', { method: 'POST' }); } catch { /* the phone forgets it regardless */ }
  clearSession();
  Object.assign(app, { user: null, group: null, members: [], myAlerts: [], reunions: [], thread: [], mitraMemory: {}, routeTo: null, arrivedAt: null });
  cache('group', null); cache('members', []); cache('myAlerts', []);
  saveMitra();
  $('#main').classList.add('hidden');
  $('#welcome').classList.remove('hidden');
  welcomeMode = 'login';
  renderWelcomeLangs();
  window.scrollTo(0, 0);
}

/** The account card on the Family tab: who you are, save a guest account, sign out. */
function accountCardHTML() {
  const u = app.user ?? {};
  const guest = u.guest !== false;
  return `
    <div class="panel account-card">
      <h2 class="panel-title">${icon('user', { size: 20 })}${tr({ en: 'Your account', hi: 'आपका खाता', mr: 'तुमचे खाते' })}</h2>
      <div class="account-row">
        <span class="me-avatar">${initial(u.displayName)}</span>
        <span class="account-body"><b>${esc(u.displayName ?? '')}</b>
          <span>${guest ? tr({ en: 'Guest — only on this phone', hi: 'मेहमान — सिर्फ़ इस फ़ोन पर', mr: 'पाहुणे — फक्त या फोनवर' })
            : `${tr({ en: 'Account', hi: 'खाता', mr: 'खाते' })} · ${esc(u.phone ?? '')}`}</span></span>
      </div>
      ${guest ? `
        <details class="save-account">
          <summary>${icon('lock', { size: 18 })}${tr({ en: 'Save my account — use it on another phone', hi: 'खाता सहेजें — दूसरे फ़ोन पर भी', mr: 'खाते जतन करा — दुसऱ्या फोनवरही' })}</summary>
          <div class="field name-field"><input id="save-phone" type="tel" inputmode="numeric" maxlength="14" aria-label="${tr({ en: 'Mobile number', hi: 'मोबाइल नंबर', mr: 'मोबाइल नंबर' })}" placeholder="${tr({ en: 'Mobile number', hi: 'मोबाइल नंबर', mr: 'मोबाइल नंबर' })}"></div>
          <div class="field name-field"><input id="save-pin" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password" aria-label="PIN" placeholder="PIN (4–6)"></div>
          <div class="field name-field"><input id="save-pin2" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password" aria-label="PIN" placeholder="${tr({ en: 'PIN again', hi: 'PIN दोबारा', mr: 'PIN पुन्हा' })}"></div>
          <button class="btn btn-go" id="save-account">${tr({ en: 'Save account', hi: 'खाता सहेजें', mr: 'खाते जतन करा' })}</button>
        </details>` : ''}
      <button class="setting-row is-quiet" id="sign-out-app">
        <span class="setting-icon">${icon('logout', { size: 22 })}</span>
        <span class="setting-body"><b>${tr({ en: 'Sign out', hi: 'साइन आउट', mr: 'साइन आउट' })}</b></span>
      </button>
    </div>`;
}

function bindAccountCard() {
  $('#sign-out-app')?.addEventListener('click', signOut);
  $('#save-account')?.addEventListener('click', async () => {
    const phone = $('#save-phone').value.replace(/\D/g, '');
    const pin = $('#save-pin').value.trim();
    if (phone.length < 10) { toast(tr({ en: 'Enter your 10-digit mobile number.', hi: '10 अंकों का मोबाइल नंबर डालें।', mr: '10 अंकी मोबाइल नंबर टाका.' }), { tone: 'warn' }); return; }
    if (!/^\d{4,6}$/.test(pin) || pin !== $('#save-pin2').value.trim()) { toast(tr({ en: 'Choose a 4–6 digit PIN and type it twice.', hi: '4–6 अंकों का PIN चुनें और दो बार लिखें।', mr: '4–6 अंकी PIN निवडा आणि दोनदा लिहा.' }), { tone: 'warn' }); return; }
    try {
      const data = await request('/api/auth/register', { method: 'POST', body: { role: 'pilgrim', phone, password: pin, displayName: app.user?.displayName } });
      setSession(data.token, data.user);
      app.user = data.user;
      toast(tr({ en: 'Account saved. Log in with this number and PIN on any phone.', hi: 'खाता सहेजा गया। किसी भी फ़ोन पर इस नंबर और PIN से लॉग इन करें।', mr: 'खाते जतन झाले. कोणत्याही फोनवर या नंबर आणि PIN ने लॉग इन करा.' }));
      renderGroup();
    } catch (err) {
      toast(err.data?.message ?? t('offlineBanner'), { tone: 'warn' });
    }
  });
}

function showMain() {
  $('#welcome').classList.add('hidden');
  $('#main').classList.remove('hidden');
  renderChrome();
  renderAll();
  refresh();
  // Coming back from a sign-out must not stack a second socket and timer.
  if (started) return;
  started = true;
  // Pick location back up if they turned it on before and the permission is
  // still granted — without ever showing a permission prompt unasked.
  if (localStorage.getItem('km.gps') === '1') {
    navigator.permissions?.query({ name: 'geolocation' })
      .then((p) => { if (p.state === 'granted') startGps(); })
      .catch(() => {});
  }
  connectRealtime();
  setInterval(refresh, 30_000);
  // Re-render every minute so "5 min ago" and schedule countdowns stay true
  // even when nothing else changes.
  setInterval(() => { if (app.page === 'home') renderHome(); if (app.page === 'group') renderGroup(); }, 60_000);
  // A phone coming out of a pocket should show the truth at once, not after
  // the next 30-second poll — "is the volunteer still coming?" is the first
  // thing someone checks.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && getToken()) { refresh(); flushOutbox(); }
  });
}

/* ----------------------------------------------------------- chrome ---- */

/**
 * The language control is one compact button that opens a menu of the three
 * languages, each written in its own script — readable by someone who cannot
 * read the other two. Three buttons side by side squeezed the title onto two
 * lines on a phone.
 */
function renderLangMenu() {
  const box = $('#lang-switch');
  const current = LANGS.find((l) => l.code === lang());
  const wasOpen = box.querySelector('.lang-menu') && !box.querySelector('.lang-menu').hidden;
  box.innerHTML = `
    <button class="lang-btn" aria-haspopup="true" aria-expanded="${wasOpen}" aria-label="Language / भाषा">
      ${icon('globe', { size: 18 })}<span class="lang-full" lang="${current.code}">${current.label}</span><span class="lang-short" lang="${current.code}">${LANG_SHORT[current.code]}</span>
    </button>
    <div class="lang-menu" role="menu" ${wasOpen ? '' : 'hidden'}>
      ${LANGS.map((l) => `
        <button role="menuitemradio" aria-checked="${l.code === lang()}" lang="${l.code}" data-lang="${l.code}">
          <span>${l.label}</span>${l.code === lang() ? icon('check', { size: 18 }) : ''}
        </button>`).join('')}
    </div>`;
  const button = box.querySelector('.lang-btn');
  const menu = box.querySelector('.lang-menu');
  const close = () => { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); };
  button.onclick = (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    button.setAttribute('aria-expanded', String(!menu.hidden));
    if (!menu.hidden) menu.querySelector('[aria-checked="true"]')?.focus();
  };
  menu.querySelectorAll('[data-lang]').forEach((b) => {
    b.onclick = () => { close(); setLang(b.dataset.lang); renderChrome(); renderAll(); };
  });
  document.onclick = (e) => { if (!box.contains(e.target)) close(); };
  menu.onkeydown = (e) => { if (e.key === 'Escape') { close(); button.focus(); } };
}

function renderChrome() {
  renderLangMenu();
  themeSwitches.forEach((s) => s.render());

  const tabs = [
    ['home', 'tabHome', 'home'],
    ['map', 'tabMap', 'map'],
    ['group', 'tabGroup', 'family'],
    ['mitra', 'tabMitra', 'chat'],
  ];
  const nav = $('#tabs');
  nav.innerHTML = '';
  for (const [id, key, glyph] of tabs) {
    const button = document.createElement('button');
    button.setAttribute('aria-pressed', String(app.page === id));
    if (app.page === id) button.setAttribute('aria-current', 'page');
    button.innerHTML = `${icon(glyph)}<span>${t(key)}</span>`;
    button.addEventListener('click', () => go(id));
    nav.appendChild(button);
  }

  const airplane = $('#airplane');
  const off = isSimulatedOffline();
  airplane.innerHTML = `${icon('plane', { size: 18 })}${off ? '<span>OFF</span>' : ''}`;
  airplane.setAttribute('aria-pressed', String(off));
  airplane.setAttribute('aria-label', off
    ? 'Demo: this tab has no signal. Tap to restore.'
    : 'Demo: pretend this tab has no signal');
  airplane.onclick = () => { setSimulatedOffline(!isSimulatedOffline()); renderChrome(); renderNetwork(); };

  // Sign out from any screen (it used to be only at the bottom of the Family tab).
  const out = $('#sign-out-top');
  const outLabel = tr({ en: 'Sign out', hi: 'साइन आउट', mr: 'साइन आउट' });
  out.innerHTML = icon('logout', { size: 18 });
  out.setAttribute('aria-label', outLabel);
  out.title = outLabel;
  out.onclick = signOut;

  $('#sos-label').innerHTML = `<span class="sign-primary">${t('sos')}</span><span class="sign-secondary">${lang() === 'en' ? t('sos', 'hi') : t('sos', 'en')}</span>`;
  $('#sos-button').onclick = openSosSheet;
  $('#topbar-title').textContent = t('appName');
}

function go(page) {
  app.page = page;
  for (const id of ['home', 'map', 'group', 'mitra']) {
    $(`#page-${id}`).hidden = id !== page;
  }
  renderChrome();
  if (page === 'map') renderMap();
  if (page === 'group') renderGroup();
  if (page === 'mitra') renderMitra();
  window.scrollTo(0, 0);
}

function renderNetwork() {
  const dot = $('#net-dot');
  const banner = $('#banner');
  if (!dot) return;
  const pending = pendingCount();
  if (pending > 0) {
    dot.dataset.state = 'queued';
    banner.classList.remove('hidden');
    banner.textContent = `${pending} ${t('queuedBanner')}`;
  } else if (!state.online) {
    dot.dataset.state = 'offline';
    banner.classList.remove('hidden');
    banner.textContent = t('offlineBanner');
  } else {
    dot.dataset.state = 'online';
    banner.classList.add('hidden');
  }
  dot.setAttribute('aria-label', {
    online: say('Connected', 'नेटवर्क चालू'),
    offline: say('No network', 'नेटवर्क नहीं'),
    queued: say('Waiting to send', 'भेजने का इंतज़ार'),
  }[dot.dataset.state]);

  // The mesh bar only appears when it is actually doing something — when we
  // have no signal and there are phones nearby that might.
  const bar = $('#mesh-bar');
  const info = meshInfo();
  if (!state.online && info.count > 0) {
    bar.classList.remove('hidden');
    bar.innerHTML = `
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <circle cx="12" cy="12" r="2.4"/><path d="M7.5 7.5a6.4 6.4 0 0 0 0 9M16.5 16.5a6.4 6.4 0 0 0 0-9M4.5 4.5a10.6 10.6 0 0 0 0 15M19.5 19.5a10.6 10.6 0 0 0 0-15"/>
      </svg>
      <span>${lang() === 'en'
        ? `${info.count} phone${info.count > 1 ? 's' : ''} nearby${info.withNetwork ? ` · ${info.withNetwork} can send for you` : ''}`
        : `पास ${info.count} फ़ोन${info.withNetwork ? ` · ${info.withNetwork} आपके लिए भेज सकते हैं` : ''}`}</span>`;
  } else {
    bar.classList.add('hidden');
  }

  renderReunions();
  if (app.page === 'home') renderHome();
}

/** A volunteer has physically found someone from this group. */
function renderReunions() {
  const bar = $('#reunion-bar');
  if (!bar) return;
  if (!app.reunions.length) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  bar.innerHTML = app.reunions.map((r) => `
    <div class="reunion" role="alert">
      <div class="reunion-title">
        ${say('A volunteer has your person', 'स्वयंसेवक को आपका व्यक्ति मिल गया है')}
      </div>
      <div class="reunion-facts">
        ${r.describe ? `${esc(r.describe)} · ` : ''}${r.place ? esc(r.place[lang()] ?? r.place.hi) : ''} · ${esc(r.foundByName)}
      </div>
      <button class="btn btn-on-dark" data-ack="${esc(r.id)}" data-goto="${esc(r.nodeId ?? '')}">
        ${say('Take me there', 'मुझे वहाँ ले चलो')}
      </button>
    </div>`).join('');

  bar.querySelectorAll('[data-ack]').forEach((b) => {
    b.onclick = async () => {
      if (b.dataset.goto) { app.routeTo = b.dataset.goto; go('map'); }
      try { await request(`/api/groups/reunions/${b.dataset.ack}/ack`, { method: 'POST' }); } catch { /* retried on refresh */ }
      app.reunions = app.reunions.filter((r) => r.id !== b.dataset.ack);
      renderReunions();
    };
  });
}

/* ------------------------------------------------------------ data ----- */

async function refresh() {
  const flags = await requestCached('/api/map/flags', 'flags');
  if (flags.data?.flags) { app.flags = flags.data.flags; cache('flags', app.flags); }

  const schedule = await requestCached('/api/content/schedule', 'schedule');
  if (schedule.data?.events) { app.schedule = schedule.data.events; cache('schedule', app.schedule); }

  const notices = await requestCached('/api/content/notices', 'notices');
  if (notices.data?.notices) { app.notices = notices.data.notices; cache('notices', app.notices); }

  try {
    const groups = await request('/api/groups/mine');
    // An empty answer from the server is the truth (left the group, or the
    // database was reset) — do not keep showing a cached group.
    app.group = groups[0]?.group ?? null;
    app.members = groups[0]?.members ?? [];
    cache('group', app.group);
    cache('members', app.members);
  } catch { /* cached values stay on screen */ }

  try {
    const mine = await request('/api/sos/mine');
    app.myAlerts = mine.alerts;
    cache('myAlerts', app.myAlerts);
    const live = mine.alerts.find((a) => a.beacon && a.status === 'claimed');
    showBeacon(live?.beacon ?? null, live?.id ?? null);
  } catch { /* ditto */ }

  const warn = await requestCached('/api/crowd/warnings', 'warnings');
  if (warn.data?.warnings) { app.warnings = warn.data.warnings; cache('warnings', app.warnings); }

  try {
    const reu = await request('/api/groups/reunions');
    app.reunions = reu.reunions ?? [];
  } catch { /* nothing to show */ }

  renderAll();
}

async function pushPosition(nodeId) {
  app.you = nodeId;
  localStorage.setItem('km.place', nodeId);
  renderAll();
  try {
    await request('/api/groups/position', {
      method: 'POST',
      body: { nodeId, battery: await batteryPct() },
    });
  } catch { /* the position will go up with the next successful call */ }
}

async function batteryPct() {
  try {
    const b = await navigator.getBattery?.();
    return b ? Math.round(b.level * 100) : null;
  } catch { return null; }
}

function renderAll() {
  if ($('#main').classList.contains('hidden')) return;
  renderChrome();
  renderHome();
  if (app.page === 'map') renderMap();
  if (app.page === 'group') renderGroup();
  if (app.page === 'mitra') renderMitra();
  renderSosStatus();
  renderNav();
  renderNetwork();
}

/* ------------------------------------------------------------ home ----- */

function renderHome() {
  const noticeBox = $('#notices');

  // Crush warnings come first and look different from ordinary notices. A
  // pilgrim heading for that ghat has a few minutes to change their mind.
  const crush = app.warnings
    .filter((w) => w.risk >= 2)
    .slice(0, 2)
    .map((w) => {
      const place = w.place ? (w.place[lang()] ?? w.place.hi) : w.nodeId;
      const soon = w.minutesToCritical != null
        ? tr({ en: ` Packed in about ${w.minutesToCritical} min.`, hi: ` लगभग ${w.minutesToCritical} मिनट में पूरा भर जाएगा।`, mr: ` सुमारे ${w.minutesToCritical} मिनिटांत पूर्ण भरेल.` })
        : '';
      return `<div class="alert-card" data-tone="crush" role="alert">
        <span class="alert-icon">${icon('crowd')}</span>
        <span class="alert-body">
          <b>${tr({ en: 'Crowd building at', hi: 'भीड़ बढ़ रही है:', mr: 'गर्दी वाढत आहे:' })} ${esc(place)}</b>
          <span>${w.risk >= 3
            ? tr({ en: 'Do not go there now.', hi: 'अभी वहाँ मत जाइए।', mr: 'आत्ता तिथे जाऊ नका.' })
            : tr({ en: 'Go later or by another route.', hi: 'बाद में जाइए या दूसरा रास्ता लीजिए।', mr: 'नंतर जा किंवा दुसरा मार्ग घ्या.' })}${soon}</span>
        </span>
      </div>`;
    }).join('');

  // Urgent notices first. Severity is shown by a label and an icon as well as
  // colour, and never in vermilion — that colour belongs to the SOS button.
  const rank = { urgent: 0, warning: 1, info: 2 };
  noticeBox.innerHTML = crush + app.notices
    .slice()
    .sort((a, b) => (rank[a.severity] ?? 2) - (rank[b.severity] ?? 2))
    .map((n) => {
      const sev = n.severity ?? 'info';
      const label = sev === 'urgent' ? tr({ en: 'Urgent', hi: 'ज़रूरी', mr: 'तातडीचे' }) : sev === 'warning' ? tr({ en: 'Warning', hi: 'चेतावनी', mr: 'इशारा' }) : tr({ en: 'Notice', hi: 'सूचना', mr: 'सूचना' });
      return `<div class="alert-card" data-tone="${esc(sev)}" ${sev === 'urgent' ? 'role="alert"' : ''}>
        <span class="alert-icon">${icon(sev === 'info' ? 'megaphone' : 'warning')}</span>
        <span class="alert-body">
          <span class="alert-label">${label}</span>
          <span>${esc(n.body?.[lang()] || n.body?.hi || n.body?.en)}</span>
        </span>
      </div>`;
    })
    .join('');

  // The welcome card: who, where, and how we know where.
  const youNode = NODE_BY_ID[app.you];
  const name = app.user?.displayName && app.user.displayName !== 'Guest' ? app.user.displayName : '';
  const fromGps = app.gpsStatus === 'gps' && app.gps;
  $('#here').innerHTML = `
    <div class="hero-greet">${esc(tr({ en: 'Namaste', hi: 'नमस्ते', mr: 'नमस्कार' }))}${name ? `, ${esc(name)}` : ''}</div>
    <div class="hero-label">${t('whereAmI')}</div>
    <div class="hero-place">${icon('pin', { size: 26 })}<span>${placeName(youNode)}</span></div>
    <div class="hero-row">
      <span class="hero-chip">${icon(fromGps ? 'signal' : 'pin', { size: 15 })}
        ${fromGps ? tr({ en: 'From GPS', hi: 'GPS से', mr: 'GPS वरून' }) : tr({ en: 'Chosen by you', hi: 'आपकी चुनी जगह', mr: 'तुम्ही निवडलेले' })}</span>
      <button class="hero-btn" id="change-place">${t('setPlace')} ${icon('chevron', { size: 16 })}</button>
    </div>
    ${offlineReady ? `<div class="hero-offline">${icon('check', { size: 15 })}${tr({ en: 'Saved on this phone — works with no signal', hi: 'इस फ़ोन पर सहेजा — बिना नेटवर्क के भी चलेगा', mr: 'या फोनवर जतन — नेटवर्कशिवायही चालेल' })}</div>` : ''}`;
  $('#change-place').onclick = () => go('map');
  renderInstallCard();

  $('#find-title').textContent = tr({ en: 'Find nearby', hi: 'पास में ढूँढें', mr: 'जवळ शोधा' });

  // Big tiles, two per row: each says what, where, and how long to walk.
  const quick = [
    ['toilet', 'nearestToilet', 'toilet'],
    ['water', 'nearestWater', 'water'],
    ['medical', 'nearestMedical', 'medical'],
    ['police', 'nearestPolice', 'police'],
  ];
  const tiles = quick.map(([type, key, glyph]) => {
    const best = nearest(app.you, type, { flags: app.flags });
    return { title: t(key), sub: best ? placeName(best.node) : '—', minutes: best?.result.minutes, to: best?.node.id, glyph, colour: PLACE_COLOUR[type] };
  });

  // The least crowded ghat, from the same engine Mitra uses.
  const ghat = respond('which ghat is least crowded', mitraContext());
  if (ghat.intent === 'best_ghat' && ghat.to) {
    const r = route(app.you, ghat.to, { flags: app.flags });
    tiles.push({
      title: tr({ en: 'Least crowded ghat', hi: 'कम भीड़ वाला घाट', mr: 'कमी गर्दीचा घाट' }),
      sub: placeName(NODE_BY_ID[ghat.to]),
      minutes: r.ok ? r.minutes : null,
      to: ghat.to,
      glyph: 'ghat',
      colour: PLACE_COLOUR.ghat,
    });
  }
  tiles.push({
    title: tr({ en: 'Ask Mitra', hi: 'मित्र से पूछें', mr: 'मित्राला विचारा' }),
    sub: tr({ en: 'Type or speak', hi: 'लिखें या बोलें', mr: 'लिहा किंवा बोला' }),
    glyph: 'chat',
    colour: '#B8752A',
    page: 'mitra',
  });

  const box = $('#quick-actions');
  box.innerHTML = tiles.map((tile, i) => `
    <button class="tile" data-tile="${i}" ${tile.to || tile.page ? '' : 'disabled'}>
      <span class="tile-icon" style="background:${tile.colour}">${icon(tile.glyph, { size: 26 })}</span>
      <span class="tile-title">${esc(tile.title)}</span>
      <span class="tile-sub">${esc(tile.sub)}</span>
      ${tile.minutes != null ? `<span class="tile-time">${icon('clock', { size: 14 })}${tile.minutes} ${tr({ en: 'min', hi: 'मिनट', mr: 'मिनिटे' })}</span>` : ''}
    </button>`).join('');
  box.querySelectorAll('[data-tile]').forEach((b) => {
    const tile = tiles[Number(b.dataset.tile)];
    b.onclick = () => {
      if (tile.page) { go(tile.page); return; }
      if (tile.to) { app.routeTo = tile.to; app.arrivedAt = null; go('map'); }
    };
  });

  const upcoming = app.schedule
    .filter((e) => new Date(e.endsAt).getTime() > Date.now())
    .slice(0, 3);
  $('#next-events').innerHTML = `
    <h2 class="panel-title">${icon('clock', { size: 20 })}${t('schedule')}</h2>
    ${upcoming.length ? `<ol class="timeline-list">${upcoming.map((e) => {
      const { text } = whenLabel(e.startsAt);
      const now = new Date(e.startsAt).getTime() <= Date.now();
      return `<li class="${now ? 'is-now' : ''}">
        <span class="tl-dot"></span>
        <span class="tl-body">
          <span class="tl-when">${text}</span>
          <b>${esc(e.title[lang()] ?? e.title.hi)}</b>
          ${e.nodeId ? `<span class="tl-place">${icon('pin', { size: 14 })}${placeName(NODE_BY_ID[e.nodeId])}</span>` : ''}
        </span>
        ${e.nodeId ? `<button class="icon-btn" data-goto="${esc(e.nodeId)}" aria-label="${esc(t('takeMeTo'))} ${esc(placeName(NODE_BY_ID[e.nodeId]))}">${icon('navigate', { size: 20 })}</button>` : ''}
      </li>`;
    }).join('')}</ol>` : `<p style="color:var(--ash);margin:0">—</p>`}
  `;
  $('#next-events').querySelectorAll('[data-goto]').forEach((b) => {
    b.onclick = () => { app.routeTo = b.dataset.goto; app.arrivedAt = null; go('map'); };
  });
}

/** Countdown wording for a schedule item, including the one already running. */
function whenLabel(startsAt) {
  const mins = Math.round((new Date(startsAt) - Date.now()) / 60000);
  if (mins <= 0) return { pip: '●', text: say('happening now', 'अभी चल रहा है') };
  if (mins < 60) return { pip: `${mins}′`, text: say(`in ${mins} min`, `${mins} मिनट में`) };
  const hrs = Math.round(mins / 60);
  return { pip: `${hrs}h`, text: say(`in ${hrs} h`, `${hrs} घंटे में`) };
}

/* ------------------------------------------------------------- map ----- */

const stored = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
const store = (key, value) => { try { localStorage.setItem(key, value); } catch { /* fine */ } };

const mapState = {
  mode: stored('km.mapMode', 'live'),       // 'live' (tiles) or 'simple' (drawn, fully offline)
  layer: stored('km.mapLayer', 'street'),   // 'street' or 'satellite'
  live: null,
  simple: null,
  following: true,
  tilesFailing: false,
};
let locator = null;
let lastPush = 0;
let pushTimer = null;

const useLive = () => mapState.mode === 'live' && liveMapAvailable();
const activeMap = () => (useLive() ? mapState.live : mapState.simple);

/** The next landmark on the walk, for framing the map. */
const aheadOf = () => (app.nav?.progress?.nextId ? nodeLatLng(app.nav.progress.nextId) : null);

function onMapNodeClick(node) {
  if (app.nav) return; // mid-walk, a stray tap must not change the destination
  if (node.id === app.you && !app.gps) return;
  askDestination(node);
}

function ensureMaps() {
  if (useLive() && !mapState.live) {
    mapState.live = createLiveMap($('#map-live'), {
      layer: mapState.layer,
      onNodeClick: onMapNodeClick,
      onUserPan: () => { if (app.nav) { mapState.following = false; renderRecenter(); } },
      onTilesFailing: (failing) => { mapState.tilesFailing = failing; renderGpsStatus(); },
    });
  }
  if (!useLive() && !mapState.simple) {
    mapState.simple = createMap($('#map-simple'), { onNodeClick: onMapNodeClick });
  }
}

function renderMapToolbar() {
  const live = useLive();
  $('#map-mode').hidden = !liveMapAvailable();
  $('#map-mode').innerHTML = [['live', t('liveMap')], ['simple', t('simpleMap')]]
    .map(([mode, label]) => `<button data-mode="${mode}" aria-pressed="${mapState.mode === mode}">${label}</button>`).join('');
  $('#map-layer').hidden = !live;
  $('#map-layer').innerHTML = [['street', t('street')], ['satellite', t('satellite')]]
    .map(([layer, label]) => `<button data-layer="${layer}" aria-pressed="${mapState.layer === layer}">${label}</button>`).join('');
  const locating = locator?.mode === 'gps';
  $('#locate-me').innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="3.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7.5"/></svg> ${t('locateMe')}`;
  $('#locate-me').setAttribute('aria-pressed', String(locating));

  $('#map-mode').querySelectorAll('[data-mode]').forEach((b) => {
    b.onclick = () => { mapState.mode = b.dataset.mode; store('km.mapMode', mapState.mode); renderMap(); };
  });
  $('#map-layer').querySelectorAll('[data-layer]').forEach((b) => {
    b.onclick = () => { mapState.layer = b.dataset.layer; store('km.mapLayer', mapState.layer); mapState.live?.setLayer(mapState.layer); renderMapToolbar(); };
  });
  $('#locate-me').onclick = () => {
    if (locator?.mode === 'gps') {
      if (app.gps) { mapState.following = true; mapState.live?.follow(app.gps); }
      return;
    }
    startGps();
  };
}

function renderGpsStatus() {
  const box = $('#gps-status');
  if (!box) return;
  const status = app.gpsStatus;
  let text = '';
  let tone = 'info';
  if (app.nav?.sim) { text = t('demoWalk'); tone = 'demo'; }
  else if (status === 'locating') text = t('gpsLocating');
  else if (status === 'gps' && app.gps) text = `${t('gpsOn')} · ±${Math.round(app.gps.accuracy)} m`;
  else if (status === 'denied') { text = t('gpsDenied'); tone = 'warn'; }
  else if (status === 'unavailable') { text = t('gpsUnavailable'); tone = 'warn'; }
  else if (status === 'outside') { text = t('gpsOutside'); tone = 'warn'; }
  if (useLive() && mapState.tilesFailing) text = text ? `${text} · ${t('tilesOffline')}` : t('tilesOffline');
  box.textContent = text;
  box.dataset.tone = tone;
  box.classList.toggle('hidden', !text);
}

function renderRecenter() {
  const button = $('#recenter');
  if (!button) return;
  const show = useLive() && app.gps && !mapState.following;
  button.classList.toggle('hidden', !show);
  button.setAttribute('aria-label', t('recenter'));
  button.title = t('recenter');
  button.onclick = () => { mapState.following = true; if (app.gps) mapState.live?.follow(app.gps, 17.5, aheadOf()); renderRecenter(); };
}

function renderMap() {
  if (!$('#place-select').options.length || $('#place-select').dataset.lang !== lang()) {
    $('#place-select').dataset.lang = lang();
    $('#place-select').innerHTML = NODES.filter((n) => n.type !== 'junction')
      .map((n) => `<option value="${n.id}">${placeName(n)}${lang() === 'en' ? '' : ` — ${n.name.en}`}</option>`)
      .join('');
    $('#place-select').onchange = () => { stopGpsIfWatching(); pushPosition($('#place-select').value); };
    $('#map-legend').innerHTML = crowdLegendHTML(CROWD);
  }
  $('#map-place-title').textContent = t('whereAmI');
  $('#place-select').value = app.you;

  ensureMaps();
  const live = useLive();
  $('#map-live').hidden = !live;
  $('#map-simple').hidden = live;
  if (live) requestAnimationFrame(() => mapState.live?.invalidate());

  renderMapToolbar();
  renderGpsStatus();
  renderRecenter();

  const planned = app.nav
    ? { result: app.nav.result, origin: app.nav.guide.origin }
    : app.routeTo ? planTo(app.routeTo) : null;
  const result = planned?.result ?? null;

  activeMap().render({
    flags: app.flags,
    you: app.you,
    gps: live ? app.gps : null,
    routeResult: result,
    origin: live ? planned?.origin ?? null : null,
    members: app.members.filter((m) => m.userId !== app.user?.id),
    highlight: app.nav ? [app.nav.to] : app.routeTo ? [app.routeTo] : [],
    following: Boolean(app.nav) && mapState.following,
  });
  if (live && app.nav && mapState.following && app.gps) mapState.live.follow(app.gps, 17.5, aheadOf());

  renderRouteCard(result, planned?.origin ?? null);
}

function renderRouteCard(result, origin = null) {
  const card = $('#route-card');

  if (app.arrivedAt && !app.routeTo && !app.nav) {
    card.classList.remove('hidden');
    card.innerHTML = `
      <h2>${t('arrivedTitle')}</h2>
      <p style="font-size:20px;font-weight:650;margin:0">${placeName(NODE_BY_ID[app.arrivedAt])}</p>
      <button class="btn" id="clear-route" style="margin-top:10px">${t('close')}</button>`;
    $('#clear-route').onclick = () => { app.arrivedAt = null; renderMap(); };
    return;
  }

  // While walking, the banner and bottom bar carry the guidance.
  if (!result || app.nav) { card.classList.add('hidden'); return; }

  card.classList.remove('hidden');
  const dest = NODE_BY_ID[app.routeTo];

  if (app.routeTo === app.you && !app.gps) {
    card.innerHTML = `
      <h2>${placeName(dest)}</h2>
      <p style="margin:0">${say('You are here.', 'आप यहीं हैं।')}</p>
      <button class="btn" id="clear-route" style="margin-top:10px">${t('close')}</button>`;
    $('#clear-route').onclick = () => { app.routeTo = null; renderMap(); };
    return;
  }

  const steps = directions(result, lang());
  const target = nodeLatLng(app.routeTo);
  // Include the walk from where they stand to where the route starts, so this
  // matches what the navigation bar will say once they press Start.
  const walk = origin && result.path.length ? metresBetween(origin, nodeLatLng(result.path[0])) : 0;
  const totalMetres = Math.round(result.metres + walk);
  const totalMinutes = Math.max(1, Math.round(result.minutes + walk / 1.1 / 60));
  const google = `https://www.google.com/maps/dir/?api=1&destination=${target.lat},${target.lng}&travelmode=walking`;
  // `worst` is the most crowded path the route still uses. The router has
  // already picked the least crowded way; if it is still heavy, there was no
  // better option and the pilgrim should know before setting off.
  card.innerHTML = `
    <h2>${t('takeMeTo')} ${placeName(dest)}</h2>
    <p style="font-size:20px;font-weight:650;margin:0">
      ${totalMetres} ${t('metres')} · ${totalMinutes} ${t('minutesWalk')}
    </p>
    ${result.ok && result.worst >= 3 ? `<p class="route-warn">${say(
      'Part of the way is very crowded, and there is no quieter route. Keep to the side and go slowly.',
      'रास्ते का एक हिस्सा बहुत भीड़ वाला है और दूसरा शांत रास्ता नहीं है। किनारे-किनारे धीरे चलिए।')}</p>` : ''}
    ${!result.ok ? `<p class="route-closed">${say(
      'Every way there is closed right now. Do not go — ask a volunteer or try later.',
      'वहाँ के सभी रास्ते अभी बंद हैं। अभी मत जाइए — स्वयंसेवक से पूछिए या बाद में जाइए।')}</p>` : ''}
    ${result.ok ? `
      <button class="act act-primary" id="nav-start" style="margin:12px 0 8px">
        <svg class="glyph" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2 4.5 20.3l.7.7L12 18l6.8 3 .7-.7z"/></svg>
        <span class="body"><span class="sign-primary">${t('navStart')}</span>
        <span class="meta">${say('Step-by-step, with voice', 'हर मोड़ पर बोलकर बताएगा')}</span></span>
      </button>
      <details class="route-details"><summary>${say('All steps', 'सभी मोड़')} (${steps.length})</summary>
        <ol class="route-steps">
          ${steps.map((s) => `<li>${esc(s.turn)} — <b>${esc(s.target)}</b> (${s.metres} ${t('metres')})</li>`).join('')}
        </ol>
      </details>` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;align-items:center">
      <a class="btn" href="${google}" target="_blank" rel="noopener" id="open-google">${t('openGoogle')} ↗</a>
      ${result.ok ? `<button class="btn" id="arrived">${say('I have arrived', 'मैं पहुँच गया')}</button>` : ''}
      <button class="btn btn-quiet" id="clear-route">${t('close')}</button>
    </div>
    <p style="font-size:13px;color:var(--ash);margin:6px 0 0">${t('googleWarn')}</p>
  `;
  $('#clear-route').onclick = () => { app.routeTo = null; renderMap(); };
  $('#nav-start')?.addEventListener('click', startNav);
  // Arriving is the moment the pilgrim definitely knows where they are, so it
  // is the cheapest accurate position update we will ever get.
  $('#arrived')?.addEventListener('click', () => {
    const to = app.routeTo;
    app.routeTo = null;
    pushPosition(to);
    toast(say(`Your place is now ${dest.name.en}`, `अब आपकी जगह: ${placeName(dest)}`));
  });
}

/**
 * The route to `to` from where the person is. With a GPS fix on the ground
 * that is their exact spot — usually partway along a road — so the plan picks
 * the best landmark to join the route at, not just the nearest (which can be
 * behind them). Without GPS it is the place they chose.
 */
function planTo(to) {
  if (app.gpsStatus === 'gps' && app.gps) {
    const plan = planFrom(app.gps.lat, app.gps.lng, to, { flags: app.flags });
    if (plan) return { result: plan.result, origin: app.gps };
  }
  return { result: route(app.you, to, { flags: app.flags }), origin: null };
}

function askDestination(node) {
  app.routeTo = node.id;
  app.arrivedAt = null;
  renderMap();
  $('#route-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ------------------------------------------------------------ location --- */

function ensureLocator() {
  locator ??= createLocator({ onFix, onStatus: onGpsStatus });
  return locator;
}

function startGps() {
  store('km.gps', '1');
  ensureLocator().startGps();
  mapState.following = true;
  renderMapToolbar();
}

/** Choosing a place by hand means the person knows better than the GPS. */
function stopGpsIfWatching() {
  if (locator?.mode === 'gps') {
    locator.stop();
    store('km.gps', '0');
    app.gps = null;
    app.gpsStatus = 'off';
  }
}

function onGpsStatus(status) {
  if (status === 'sim') return; // the demo walk reports itself
  app.gpsStatus = status;
  if (status === 'outside' || status === 'denied' || status === 'unavailable') {
    if (!app.nav?.sim) app.gps = null;
  }
  if (app.page === 'map') { renderGpsStatus(); renderMapToolbar(); }
}

/**
 * Every position, real or simulated.
 *
 * The raw fix moves the dot and drives turn-by-turn on this phone. The only
 * thing sent to the server is the nearest landmark, and at most every 20 s —
 * enough for the family to find you, not enough to trace you.
 */
function onFix(fix) {
  const first = !app.gps;
  app.gps = fix;

  const near = nearestNode(fix.lat, fix.lng);
  if (near && near.metres < 150 && near.node.id !== app.you) {
    app.you = near.node.id;
    store('km.place', app.you);
    schedulePositionPush();
    if (app.page === 'home') renderHome();
  }

  if (app.nav) navUpdate(fix);
  // Arriving at the end of a demo walk clears the simulated dot; do not
  // draw it straight back.
  if (!app.gps) return;

  if (app.page === 'map') {
    if (useLive()) {
      mapState.live.updateYou(fix, app.you);
      if (mapState.following && (app.nav || first)) mapState.live.follow(fix, app.nav ? 17.5 : 16.5, app.nav ? aheadOf() : null);
      renderGpsStatus();
      renderRecenter();
    } else {
      renderMap();
    }
  }
}

function schedulePositionPush() {
  clearTimeout(pushTimer);
  const wait = Math.max(0, 20_000 - (Date.now() - lastPush));
  pushTimer = setTimeout(async () => {
    lastPush = Date.now();
    try {
      await request('/api/groups/position', { method: 'POST', body: { nodeId: app.you, battery: await batteryPct() } });
    } catch { /* goes up with the next one */ }
  }, wait);
}

/* ---------------------------------------------------------- navigation --- */

/**
 * Walk me there.
 *
 * On the ground with GPS, guidance follows the real fix. Anywhere else —
 * a laptop demo, someone testing from home — it plays a simulated walk along
 * the route and says so on screen, rather than pretending.
 */
function startNav() {
  const to = app.routeTo;
  if (!to) return;
  const onSite = app.gpsStatus === 'gps' && app.gps;
  const { result, origin } = planTo(to);
  if (!result.ok || result.path.length < 2) {
    toast(say('No open way there right now.', 'अभी वहाँ जाने का कोई खुला रास्ता नहीं है।'), { tone: 'warn' });
    return;
  }

  app.nav = { to, result, guide: createGuide(result, lang(), { origin: onSite ? origin : null }), sim: !onSite, lastKey: '', offCount: 0, progress: null };
  app.arrivedAt = null;
  mapState.following = true;
  document.body.classList.add('is-navigating');
  speak(app.nav.guide.start);

  if (onSite) {
    navUpdate(app.gps);
  } else {
    if (app.gpsStatus === 'outside') toast(t('gpsOutside'));
    ensureLocator().simulate(routeLatLngs(result), { speedup: demoSpeedup(result.metres) });
  }
  renderMap();
  renderNav();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** Fast enough that a demo walk takes about 45 seconds, whatever the distance. */
const demoSpeedup = (metres) => Math.max(6, Math.min(60, metres / (1.3 * 45)));

function navUpdate(fix) {
  const n = app.nav;
  if (!n) return;
  const p = n.guide.update(fix);
  n.progress = p;

  if (p.stepKey !== n.lastKey) {
    n.lastKey = p.stepKey;
    if (app.voice) speak(p.text);
    if (p.phase === 'near') buzz(150);
  }

  // A real walker off the line for three fixes in a row gets a new route.
  // (One bad fix in a crowd of steel and bodies is normal; three is not.)
  if (!n.sim && p.offRoute) {
    n.offCount += 1;
    if (n.offCount >= 3) { n.offCount = 0; reroute('offroute'); return; }
  } else {
    n.offCount = 0;
  }

  if (p.arrived) { finishNav(); return; }
  renderNav();
}

/**
 * Re-plan from where they are now. Called when they leave the route, and
 * whenever the control room changes a path while they are walking — the
 * whole point of a live crowd map is that the route changes before they
 * reach the closed approach, not after.
 */
function reroute(reason) {
  const n = app.nav;
  if (!n) return;
  const fix = app.gps ?? locator?.last;
  const plan = fix ? planFrom(fix.lat, fix.lng, n.to, { flags: app.flags }) : null;
  const result = plan?.result ?? route(app.you, n.to, { flags: app.flags });

  if (!result.ok) {
    toast(say('The way ahead is closed and there is no other route. Stop and ask a volunteer.',
      'आगे का रास्ता बंद है और दूसरा रास्ता नहीं है। रुकिए और स्वयंसेवक से पूछिए।'), { tone: 'warn', ms: 6000 });
    if (app.voice) speak(say('The way ahead is closed. Stop and ask a volunteer.', 'आगे का रास्ता बंद है। रुकिए और स्वयंसेवक से पूछिए।'));
    return;
  }

  // Still the same way (the new plan is just the rest of the old one)? Then
  // nothing to tell them.
  const unchanged = n.result.path.join('>').endsWith(result.path.join('>'));
  if (reason === 'flags' && unchanged) return;

  n.result = result;
  n.guide = createGuide(result, lang(), { origin: fix ? { lat: fix.lat, lng: fix.lng } : null });
  n.lastKey = '';
  const message = t(reason === 'flags' ? 'navRerouted' : 'navOffRoute');
  toast(message);
  if (app.voice) speak(message);
  buzz([120, 80, 120]);

  if (n.sim && fix) {
    ensureLocator().simulate([{ lat: fix.lat, lng: fix.lng }, ...routeLatLngs(result)], { speedup: demoSpeedup(result.metres) });
  } else if (fix) {
    navUpdate(fix);
  }
  if (app.page === 'map') renderMap();
  renderNav();
}

function finishNav() {
  const n = app.nav;
  if (!n) return;
  const dest = n.to;
  if (app.voice) speak(n.guide.update(nodeLatLng(dest)).text);
  buzz([100, 60, 100, 60, 250]);
  if (n.sim) locator?.stopSim();
  app.nav = null;
  app.routeTo = null;
  app.arrivedAt = dest;
  if (n.sim) app.gps = null; // the simulated dot goes away with the walk
  document.body.classList.remove('is-navigating');
  renderNav();
  pushPosition(dest);
}

function endNav() {
  if (!app.nav) return;
  if (app.nav.sim) { locator?.stopSim(); app.gps = null; }
  app.nav = null;
  document.body.classList.remove('is-navigating');
  speechSynthesis?.cancel?.();
  renderNav();
  if (app.page === 'map') renderMap();
}

const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 19 10h-4.5v11.5h-5V10H5z"/></svg>';
const FLAG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V4h10l-1.5 3.5L16 11H8v10z"/></svg>';

/** The banner across the top and the bar above the SOS button, on every tab. */
function renderNav() {
  const top = $('#nav-top');
  const bottom = $('#nav-bottom');
  const n = app.nav;
  if (!n || !n.progress) {
    top.classList.add('hidden');
    bottom.classList.add('hidden');
    return;
  }
  const p = n.progress;
  top.classList.remove('hidden');
  bottom.classList.remove('hidden');

  // The arrow is the instruction for anyone who cannot read the sentence.
  $('#nav-arrow').innerHTML = p.arrived ? FLAG : ARROW;
  $('#nav-arrow').style.transform = p.angle === null || p.arrived ? '' : `rotate(${p.angle}deg)`;
  $('#nav-dist').textContent = p.arrived ? '' : `${spokenMetres(p.toNextMetres)} ${t('metres')}`;
  $('#nav-instr').textContent = p.text;

  const eta = new Date(Date.now() + p.minutesLeft * 60_000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const km = p.remainingMetres >= 1000 ? `${(p.remainingMetres / 1000).toFixed(1)} km` : `${p.remainingMetres} ${t('metres')}`;
  $('#nav-summary').innerHTML = `<b>${p.minutesLeft} ${say('min', 'मिनट')}</b>
    <span>${km} · ${say('arrive', 'पहुँचेंगे')} ${eta}</span>
    ${n.sim ? `<span class="nav-demo">${t('demoWalk')}</span>` : ''}`;
  $('#nav-voice').setAttribute('aria-pressed', String(app.voice));
  $('#nav-voice').setAttribute('aria-label', t('voice'));
  $('#nav-voice').innerHTML = app.voice
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9zM16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9zM17 9l5 6M22 9l-5 6"/></svg>';
  $('#nav-voice').onclick = () => {
    app.voice = !app.voice;
    store('km.voice', app.voice ? '1' : '0');
    if (!app.voice) speechSynthesis?.cancel?.();
    renderNav();
  };
  $('#nav-end').textContent = t('navEnd');
  $('#nav-end').onclick = endNav;
}

/* ----------------------------------------------------------- group ----- */

/** A steady colour per person, so the same relative looks the same everywhere. */
const AVATAR = ['#1B5A66', '#2F7A52', '#8A6A3F', '#B8752A', '#5B4B8A', '#A33B57'];
function avatarColour(label) {
  let h = 0;
  for (const ch of String(label ?? '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR[h % AVATAR.length];
}

function renderGroup() {
  const box = $('#group-body');

  if (!app.group) {
    box.innerHTML = `
      <div class="empty-hero">
        <span class="empty-icon">${icon('family', { size: 40 })}</span>
        <strong>${t('groupEmpty')}</strong>
        <span>${t('groupEmptyHelp')}</span>
      </div>
      <button class="act act-primary" id="make-group">
        <span class="glyph">${icon('family', { size: 30 })}</span>
        <span class="body">${sign('groupMake')}</span>
      </button>
      <div class="or-divider"><span>${tr({ en: 'or', hi: 'या', mr: 'किंवा' })}</span></div>
      <div class="panel">
        <h2 class="panel-title">${icon('qr', { size: 20 })}<label for="join-code">${t('groupJoin')}</label></h2>
        <div class="field" style="margin:0">
          <input id="join-code" maxlength="6" autocapitalize="characters" autocomplete="off" spellcheck="false"
                 placeholder="A C D 2 3 4" class="code-input">
          <button class="btn btn-go" id="join-go" aria-label="${esc(t('groupJoin'))}">${icon('chevron')}</button>
        </div>
      </div>`;
    $('#make-group').onclick = createGroup;
    $('#join-go').onclick = joinGroup;
    const input = $('#join-code');
    // Uppercase as they type and drop spaces/dashes, so "acd 234" and
    // "ACD-234" both work the way they were read off the band.
    input.oninput = () => { input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); };
    input.onkeydown = (e) => { if (e.key === 'Enter') joinGroup(); };
    box.insertAdjacentHTML('beforeend', accountCardHTML());
    bindAccountCard();
    return;
  }

  const me = app.members.find((m) => m.userId === app.user?.id);
  const meeting = NODE_BY_ID[app.group.meetingPointId];
  const canShare = typeof navigator.share === 'function';

  box.innerHTML = `
    <div class="code-card">
      <div class="code-card-label">${icon('family', { size: 18 })}${t('groupCode')}</div>
      <div class="code-card-code" aria-label="${esc(app.group.joinCode.split('').join(' '))}">${esc(app.group.joinCode)}</div>
      <div class="code-card-actions">
        <button class="code-card-btn" id="copy-code">${icon(canShare ? 'share' : 'copy', { size: 18 })}
          ${canShare ? say('Share code', 'कोड भेजें') : say('Copy code', 'कोड कॉपी करें')}</button>
        <a class="code-card-btn" href="/app/wristband.html">${icon('wristband', { size: 18 })}${say('Wristband', 'कलाई पट्टी')}</a>
      </div>
      <p class="code-card-help">${say('Write it on a wristband for children and elders who have no phone.',
        'जिनके पास फ़ोन नहीं है — बच्चों और बुज़ुर्गों — की कलाई पर यह कोड लिख दें।')}</p>
    </div>

    <div class="panel">
      <h2 class="panel-title">${icon('family', { size: 20 })}${t('groupTitle')} <span class="count-pill">${app.members.length}</span></h2>
      <ul class="people">
      ${app.members.map((m) => {
        const isMe = m.userId === app.user?.id;
        const stale = m.updatedAt && Date.now() - new Date(m.updatedAt) > 1_800_000;
        const lowBattery = !isMe && m.battery != null && m.battery <= 15;
        return `
        <li class="person">
          <span class="avatar" style="background:${avatarColour(m.label)}">${initial(m.label)}
            <i class="presence" data-on="${Boolean(m.sharing && m.nodeId)}"></i></span>
          <span class="person-body">
            <b>${esc(m.label)}${isMe ? ` <span class="you-tag">${say('you', 'आप')}</span>` : ''}</b>
            <span class="person-status ${stale ? 'stale' : ''}">
              ${m.sharing
                ? (m.place ? `${icon('pin', { size: 14 })}${esc(m.place[lang()] ?? m.place.hi)} · ${relativeTime(m.updatedAt)}` : '—')
                : `${icon('eyeOff', { size: 14 })}${t('notSharing')}`}
            </span>
            ${lowBattery ? `<span class="battery-low">${icon('battery', { size: 14 })}${say(`Battery ${m.battery}% — may go quiet soon`, `बैटरी ${m.battery}% — फ़ोन बंद हो सकता है`)}</span>` : ''}
          </span>
          ${m.sharing && m.nodeId && !isMe
            ? `<button class="icon-btn" data-goto="${esc(m.nodeId)}" aria-label="${esc(t('takeMeTo'))} ${esc(m.label)}">${icon('navigate', { size: 20 })}</button>` : ''}
        </li>`;
      }).join('')}
      </ul>
    </div>

    <div class="panel meet-card">
      <span class="meet-icon">${icon('flag', { size: 24 })}</span>
      <span class="meet-body">
        <span class="meet-label">${t('meetingPoint')}</span>
        <b>${placeName(meeting)}</b>
      </span>
      <button class="icon-btn" data-goto="${esc(app.group.meetingPointId)}" aria-label="${esc(t('takeMeTo'))} ${esc(placeName(meeting))}">${icon('navigate', { size: 20 })}</button>
    </div>

    <div class="settings-list">
      <button class="setting-row" id="toggle-sharing" role="switch" aria-checked="${Boolean(me?.sharing)}">
        <span class="setting-icon">${icon(me?.sharing ? 'eye' : 'eyeOff', { size: 22 })}</span>
        <span class="setting-body">
          <b>${me?.sharing ? t('sharingOn') : t('sharingOff')}</b>
          <span>${me?.sharing ? t('stopSharing') : t('startSharing')}</span>
        </span>
        <span class="switch" aria-hidden="true"><i></i></span>
      </button>
      <a class="setting-row" href="/app/wristband.html">
        <span class="setting-icon">${icon('wristband', { size: 22 })}</span>
        <span class="setting-body">
          <b>${say('Print a wristband', 'कलाई पट्टी छापें')}</b>
          <span>${say('For children and elders with no phone', 'बच्चों और बुज़ुर्गों के लिए — बिना फ़ोन के')}</span>
        </span>
        ${icon('chevron', { size: 20, cls: 'setting-chevron' })}
      </a>
      <button class="setting-row is-quiet" id="leave-group">
        <span class="setting-icon">${icon('leave', { size: 22 })}</span>
        <span class="setting-body"><b>${say('Leave this group', 'इस समूह से निकलें')}</b></span>
      </button>
    </div>`;

  box.insertAdjacentHTML('beforeend', accountCardHTML());
  bindAccountCard();

  box.querySelectorAll('[data-goto]').forEach((b) => {
    b.onclick = () => { app.routeTo = b.dataset.goto; go('map'); };
  });

  $('#copy-code').onclick = async () => {
    const code = app.group.joinCode;
    const text = say(`Join our family group on Kumbh-a-Mitra: ${code}`, `कुंभ-अ-मित्र पर हमारे परिवार समूह से जुड़ें: ${code}`);
    try {
      if (canShare) await navigator.share({ text });
      else { await navigator.clipboard.writeText(code); toast(say('Code copied', 'कोड कॉपी हो गया')); }
    } catch { /* share sheet dismissed, or clipboard blocked — the code is on screen */ }
  };

  $('#toggle-sharing').onclick = async () => {
    try {
      const data = await request(`/api/groups/${app.group.id}/sharing`, {
        method: 'PATCH', body: { sharing: !me?.sharing },
      });
      app.members = data.members;
      cache('members', app.members);
      renderGroup();
    } catch { toast(t('offlineBanner'), { tone: 'warn' }); }
  };

  $('#leave-group').onclick = async () => {
    if (!confirm(say('Leave this group? Your family will no longer see where you are.',
      'समूह छोड़ें? आपका परिवार अब आपकी जगह नहीं देख पाएगा।'))) return;
    try {
      await request(`/api/groups/${app.group.id}/leave`, { method: 'POST' });
      app.group = null;
      app.members = [];
      cache('group', null);
      cache('members', []);
      renderGroup();
    } catch { toast(t('offlineBanner'), { tone: 'warn' }); }
  };
}

async function createGroup() {
  try {
    const data = await request('/api/groups', {
      method: 'POST',
      body: { name: app.user?.displayName ? `${app.user.displayName}'s group` : 'My group', label: app.user?.displayName },
    });
    app.group = data.group;
    app.members = data.members;
    cache('group', app.group);
    cache('members', app.members);
    await pushPosition(app.you);
    renderGroup();
  } catch { toast(t('offlineBanner'), { tone: 'warn' }); }
}

async function joinGroup() {
  const code = $('#join-code').value.trim().toUpperCase();
  if (code.length !== 6) {
    toast(say('The code has 6 characters.', 'कोड में 6 अक्षर होते हैं।'));
    return;
  }
  try {
    const data = await request('/api/groups/join', { method: 'POST', body: { code, label: app.user?.displayName } });
    app.group = data.group;
    app.members = data.members;
    cache('group', app.group);
    cache('members', app.members);
    await pushPosition(app.you);
    renderGroup();
  } catch (err) {
    const text = err.message === 'network_slow' ? t('offlineBanner')
      : err.status === 429 ? say('Too many wrong codes. Check the code and try again in a few minutes.', 'बहुत बार गलत कोड। कोड जाँचें और कुछ मिनट बाद फिर कोशिश करें।')
      : say('That code did not match.', 'यह कोड नहीं मिला।');
    toast(text, { tone: 'warn' });
  }
}

/* ----------------------------------------------------------- mitra ----- */

/**
 * The conversation is kept on this phone only (localStorage), so it survives
 * closing the app — and Clear wipes it. Nothing about it is stored on the
 * server; each question is sent on its own, with the small "last place"
 * memory needed for follow-ups like "is it crowded there?".
 */
const MITRA_KEY = 'km.mitra';
const MITRA_KEEP = 40;

function loadMitra() {
  try {
    const saved = JSON.parse(localStorage.getItem(MITRA_KEY) ?? 'null');
    if (saved?.thread) { app.thread = saved.thread.slice(-MITRA_KEEP); app.mitraMemory = saved.memory ?? {}; }
  } catch { /* start fresh */ }
  app.mitraMemory ??= {};
}

function saveMitra() {
  try { localStorage.setItem(MITRA_KEY, JSON.stringify({ thread: app.thread.slice(-MITRA_KEEP), memory: app.mitraMemory })); } catch { /* full */ }
}

const ML = {
  navigate: { en: 'Start walking', hi: 'चलना शुरू करें', mr: 'चालायला सुरू करा' },
  map: { en: 'Show on map', hi: 'नक्शे पर दिखाएँ', mr: 'नकाशावर दाखवा' },
  sos: { en: 'Raise an alert', hi: 'मदद बुलाएँ', mr: 'मदत बोलवा' },
  group: { en: 'Open family', hi: 'परिवार खोलें', mr: 'कुटुंब उघडा' },
  call: { en: 'Call', hi: 'कॉल करें', mr: 'कॉल करा' },
  steps: { en: 'Steps', hi: 'मोड़', mr: 'वळणे' },
  replay: { en: 'Read aloud', hi: 'सुनाएँ', mr: 'ऐकवा' },
  clear: { en: 'Clear chat', hi: 'बातचीत मिटाएँ', mr: 'संभाषण पुसा' },
  sub: { en: 'Works without network', hi: 'बिना नेटवर्क के भी', mr: 'नेटवर्कशिवायही' },
  listening: { en: 'Listening… tap to stop', hi: 'सुन रहा हूँ… रोकने के लिए दबाएँ', mr: 'ऐकत आहे… थांबवण्यासाठी दाबा' },
  crowd: {
    clear: { en: 'Clear', hi: 'भीड़ नहीं', mr: 'गर्दी नाही' },
    busy: { en: 'Busy', hi: 'भीड़', mr: 'गर्दी' },
    heavy: { en: 'Very crowded', hi: 'भारी भीड़', mr: 'खूप गर्दी' },
    filling: { en: 'Filling fast', hi: 'तेज़ी से भर रहा', mr: 'वेगाने भरत आहे' },
    packed: { en: 'Packed', hi: 'पूरा भरा', mr: 'पूर्ण भरले' },
    closed: { en: 'Closed', hi: 'बंद', mr: 'बंद' },
  },
};
const ml = (entry) => entry[lang()] ?? entry.hi;
const CROWD_TONE = { 1: 'var(--tulsi)', 2: 'var(--busy)', 3: 'var(--heavy)', 4: 'var(--closed-surface)' };

function mitraBubble(m, i) {
  if (m.from === 'me') return `<div class="bubble" data-from="me">${esc(m.text)}</div>`;
  const actions = (m.actions ?? []).filter((a) => a.type !== 'call');
  const calls = (m.actions ?? []).filter((a) => a.type === 'call');
  const callLabel = (n) => m.calls?.find((c) => c.number === n)?.label
    ?? HELPLINES.find((h) => h.number === n)?.label[lang()] ?? '';
  return `
    <div class="bubble ${m.urgent ? 'is-urgent' : ''}" data-from="mitra">
      <div class="bubble-text">${esc(m.greeting ? t('mitraHello') : m.text)}</div>
      ${m.crowd ? `<div class="crowd-meter" data-level="${m.crowd.level}" aria-label="${esc(ml(ML.crowd[m.crowd.state] ?? ML.crowd.busy))}">
          <i style="width:${m.crowd.level * 25}%;background:${CROWD_TONE[m.crowd.level]}"></i>
          <span>${esc(ml(ML.crowd[m.crowd.state] ?? ML.crowd.busy))}</span>
        </div>` : ''}
      ${m.steps?.length ? `<details class="bubble-steps"><summary>${ml(ML.steps)} (${m.steps.length})</summary>
          <ol class="steps">${m.steps.map((s) => `<li>${esc(s.turn)} — <b>${esc(s.target)}</b> (${s.metres} m)</li>`).join('')}</ol>
        </details>` : ''}
      ${calls.length ? `<div class="bubble-calls">${calls.map((a) => `
          <a class="call-btn" href="tel:${esc(a.number)}"><b>${esc(a.number)}</b><span>${esc(callLabel(a.number))}</span></a>`).join('')}</div>` : ''}
      ${actions.length ? `<div class="bubble-actions">${actions.map((a, k) => `
          <button class="btn btn-sm ${a.type === 'navigate' ? 'btn-go' : ''} ${a.type === 'sos' ? 'btn-sos' : ''}" data-msg="${i}" data-act="${k}">
            ${ml(ML[a.type] ?? ML.map)}</button>`).join('')}</div>` : ''}
      <div class="bubble-foot">
        ${m.offline ? `<span>${t('mitraOffline')}</span>` : '<span></span>'}
        <button class="link-btn" data-replay="${i}" aria-label="${ml(ML.replay)}">🔊 ${ml(ML.replay)}</button>
      </div>
    </div>`;
}

function renderMitra() {
  const thread = $('#thread');
  // The greeting is stored as a marker, not text, so it follows the language.
  if (!app.thread.length) app.thread.push({ from: 'mitra', greeting: true });

  $('#mitra-sub').textContent = ml(ML.sub);
  $('#mitra-clear').textContent = ml(ML.clear);
  $('#mitra-voice').setAttribute('aria-pressed', String(app.voice));
  $('#mitra-voice').setAttribute('aria-label', t('voice'));
  $('#mitra-voice').innerHTML = app.voice
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9zM16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9zM17 9l5 6M22 9l-5 6"/></svg>';
  $('#mitra-voice').onclick = () => {
    app.voice = !app.voice;
    localStorage.setItem('km.voice', app.voice ? '1' : '0');
    if (!app.voice) speechSynthesis?.cancel?.();
    renderMitra();
  };
  $('#mitra-clear').onclick = () => {
    app.thread = [];
    app.mitraMemory = {};
    saveMitra();
    renderMitra();
  };

  const lastMitra = [...app.thread].reverse().find((m) => m.from === 'mitra');
  thread.innerHTML = app.thread.map((m, i) => mitraBubble(m, i)).join('');

  thread.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = () => runMitraAction(app.thread[Number(b.dataset.msg)].actions.filter((a) => a.type !== 'call')[Number(b.dataset.act)]);
  });
  thread.querySelectorAll('[data-replay]').forEach((b) => {
    b.onclick = () => { const m = app.thread[Number(b.dataset.replay)]; speak(m.greeting ? t('mitraHello') : m.text); };
  });

  // Follow-up chips for the latest answer; the starter questions otherwise.
  const chips = !lastMitra?.greeting && lastMitra?.followups?.length ? lastMitra.followups : mitraSuggestions(lang());
  $('#quick-asks').innerHTML = chips.map((c, i) => `<button data-ask="${i}">${esc(c.label)}</button>`).join('');
  $('#quick-asks').querySelectorAll('[data-ask]').forEach((b) => {
    b.onclick = () => ask(chips[Number(b.dataset.ask)].text);
  });

  $('#mitra-input').placeholder = t('mitraPlaceholder');
  $('#mitra-send').onclick = () => {
    const value = $('#mitra-input').value.trim();
    if (value) { $('#mitra-input').value = ''; ask(value); }
  };
  $('#mitra-input').onkeydown = (e) => { if (e.key === 'Enter') $('#mitra-send').click(); };
  $('#mic-label').innerHTML = recogniser ? `<span class="sign-primary">${ml(ML.listening)}</span>` : sign('mitraListen');
  $('#mitra-mic').classList.toggle('is-listening', Boolean(recogniser));
  $('#mitra-mic').onclick = listen;
  // The page scrolls, not the thread. Bring the newest answer into view, but
  // only when there is a conversation — not on first opening the tab.
  if (app.thread.length > 1) thread.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function runMitraAction(action) {
  if (!action) return;
  if (action.type === 'navigate' && action.to) {
    app.routeTo = action.to;
    app.arrivedAt = null;
    go('map');
    startNav();
  } else if (action.type === 'map' && action.to) {
    if (action.to !== app.you) app.routeTo = action.to;
    go('map');
  } else if (action.type === 'sos') {
    openSosSheet(action.kind);
  } else if (action.type === 'group') {
    go('group');
  }
}

/** Everything the engine needs, from what this phone already knows. */
function mitraContext() {
  return {
    lang: lang(),
    you: app.you,
    gps: app.gpsStatus === 'gps' && Boolean(app.gps),
    flags: app.flags,
    warnings: app.warnings,
    schedule: app.schedule,
    notices: app.notices,
    members: app.members
      .filter((m) => m.userId !== app.user?.id)
      .map((m) => ({ label: m.label, sharing: m.sharing, nodeId: m.nodeId, updatedAt: m.updatedAt })),
    hasGroup: Boolean(app.group),
    memory: app.mitraMemory,
  };
}

/**
 * Ask Mitra. The phone answers first — instantly, with no network — using
 * the shared engine. If the server is reachable it may improve the wording,
 * or understand a sentence the phone did not; the user has been helped
 * before that comes back.
 */
async function ask(text) {
  const memoryBefore = { ...app.mitraMemory };
  app.thread.push({ from: 'me', text });
  const answer = respond(text, mitraContext());
  const local = { from: 'mitra', ...answer, offline: true };
  delete local.memory;
  app.mitraMemory = answer.memory;
  app.thread.push(local);
  saveMitra();
  renderMitra();
  if (app.voice) speak(local.text);

  if (local.urgent) {
    openSosSheet(local.kind);
    return;
  }
  if (local.autostart && local.to) {
    runMitraAction({ type: 'navigate', to: local.to });
    return;
  }

  try {
    const data = await request('/api/assistant/ask', {
      method: 'POST',
      body: { text, lang: lang(), from: app.you, memory: memoryBefore, gps: mitraContext().gps },
    });
    const index = app.thread.indexOf(local);
    if (index === -1 || !data?.text) return;
    // The server understood something the phone did not: take its whole answer.
    if (local.intent === 'unknown' && data.intent && data.intent !== 'unknown') {
      const { memory, say: _say, from: _from, llm: _llm, ...rest } = data;
      app.thread[index] = { from: 'mitra', ...rest };
      if (memory) app.mitraMemory = memory;
    } else if (data.polished && data.intent === local.intent) {
      // Same answer, nicer words. Keep the phone's buttons and steps.
      app.thread[index] = { ...local, text: String(data.text), offline: false };
    } else {
      return;
    }
    saveMitra();
    if (app.page === 'mitra') renderMitra();
  } catch { /* the local answer stands, which is the designed behaviour */ }
}

function speak(text) {
  try {
    if (!('speechSynthesis' in window)) return;
    const utterance = new SpeechSynthesisUtterance(String(text).replace(/<[^>]+>/g, ''));
    utterance.lang = { hi: 'hi-IN', mr: 'mr-IN', en: 'en-IN' }[lang()];
    utterance.rate = 0.95; // a touch slower: noisy ground, many first-time users
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  } catch { /* voice is a bonus, never a requirement */ }
}

/**
 * Speak instead of typing. The words appear in the box as they are heard, so
 * the person can see they were understood, and the question goes as soon as
 * they stop. Tap again to stop listening.
 */
let recogniser = null;
function listen() {
  if (recogniser) { recogniser.stop(); return; }
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    toast(say('This browser cannot listen. Type instead.', 'यह ब्राउज़र सुन नहीं सकता। लिखकर पूछें।'));
    return;
  }
  speechSynthesis?.cancel?.();
  const r = new Recognition();
  r.lang = { hi: 'hi-IN', mr: 'mr-IN', en: 'en-IN' }[lang()];
  r.interimResults = true;
  r.maxAlternatives = 1;
  let finalText = '';
  r.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const piece = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += piece; else interim += piece;
    }
    $('#mitra-input').value = (finalText + interim).trim();
  };
  r.onerror = (e) => {
    if (e.error !== 'aborted' && e.error !== 'no-speech') toast(say('Did not catch that.', 'सुनाई नहीं दिया।'));
  };
  r.onend = () => {
    recogniser = null;
    const heard = finalText.trim() || $('#mitra-input').value.trim();
    $('#mitra-input').value = '';
    if (app.page === 'mitra') renderMitra();
    if (heard) ask(heard);
  };
  recogniser = r;
  try { r.start(); } catch { recogniser = null; }
  renderMitra();
}

/* ------------------------------------------------------------- sos ----- */

const SOS_KINDS = [
  ['lost_person', 'sosLostPerson', 'family'],
  ['lost_self', 'sosLostSelf', 'user'],
  ['medical', 'sosMedical', 'medical'],
  ['crowd_crush', 'sosCrowd', 'crowd'],
  ['other', 'sosOther', 'info'],
];

const KIND_KEY = { lost_person: 'sosLostPerson', lost_self: 'sosLostSelf', medical: 'sosMedical', crowd_crush: 'sosCrowd', other: 'sosOther' };

function openSosSheet(preKind) {
  const body = $('#sos-sheet-body');

  const kindButtons = SOS_KINDS.map(([id, key, path]) => `
    <button class="act ${preKind === id ? 'act-primary' : ''}" data-kind="${id}">
      <span class="glyph sos-kind-icon">${icon(path, { size: 26 })}</span>
      <span class="body"><span class="sign-primary">${t(key)}</span><span class="sign-secondary">${t(key, lang() === 'en' ? 'hi' : 'en')}</span></span>
    </button>`).join('');

  const live = app.myAlerts.filter((a) => a.status === 'open' || a.status === 'claimed');

  body.innerHTML = `
    <h2 id="sos-title" style="margin:0 0 4px;font-size:24px">${t('sosPick')}</h2>
    <p style="color:var(--ash);margin:0 0 14px">${NODE_BY_ID[app.you] ? placeName(NODE_BY_ID[app.you]) : ''}</p>
    ${live.length ? `<div class="notice" style="margin-bottom:12px">
      ${live.some((a) => a.status === 'claimed') ? t('sosClaimed') : t('sosSent')}.
      ${say('You do not need to press again for the same thing.', 'उसी बात के लिए दोबारा दबाने की ज़रूरत नहीं है।')}
    </div>` : ''}
    ${kindButtons}
    <button class="btn" id="sos-close" style="width:100%;margin-top:6px">${t('close')}</button>`;

  body.querySelectorAll('[data-kind]').forEach((b) => {
    b.onclick = () => confirmSos(b.dataset.kind);
  });
  $('#sos-close').onclick = () => sosSheet.close();
  if (!sosSheet.isOpen) sosSheet.open();
  else body.querySelector('button')?.focus();
}

function confirmSos(kind) {
  const body = $('#sos-sheet-body');
  const needsWho = kind === 'lost_person';
  body.innerHTML = `
    <h2 id="sos-title" style="margin:0 0 10px;font-size:24px">${t(KIND_KEY[kind] ?? 'sosOther')}</h2>
    ${needsWho ? `<div class="field" style="margin:0 0 12px">
      <input id="sos-who" maxlength="80" aria-label="${esc(t('sosWho'))}" placeholder="${esc(t('sosWho'))}">
    </div>` : ''}
    <div class="panel" style="background:var(--sand);border:0">
      <p style="margin:0"><b>${placeName(NODE_BY_ID[app.you])}</b></p>
      <p style="margin:4px 0 0;font-size:15px;color:var(--ash)">
        ${say('A volunteer near you will be alerted with this place.', 'आपके पास के स्वयंसेवक को यह जगह भेजी जाएगी।')}
        <button class="link-btn" id="sos-wrong-place">${say('Wrong place?', 'जगह गलत है?')}</button>
      </p>
    </div>
    <button class="sos-button" id="sos-confirm" style="margin-top:12px">
      <span class="sign"><span class="sign-primary">${t('sos')}</span><span class="sign-secondary">${t('sos', lang() === 'en' ? 'hi' : 'en')}</span></span>
    </button>
    <button class="btn" id="sos-back" style="width:100%;margin-top:10px">${t('back')}</button>`;

  $('#sos-back').onclick = () => openSosSheet(kind);
  $('#sos-wrong-place').onclick = () => { sosSheet.close(); go('map'); $('#place-select')?.focus(); };
  const send = () => {
    const subjectLabel = needsWho ? $('#sos-who')?.value.trim() : null;
    raiseSos(kind, subjectLabel);
  };
  $('#sos-confirm').onclick = send;
  $('#sos-who')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  (needsWho ? $('#sos-who') : $('#sos-confirm')).focus();
}

/**
 * One idempotency key per kind of emergency for ten minutes.
 *
 * A frightened person goes through the sheet again because nothing seems to
 * be happening. Without this, each pass would mint a new key and raise a new
 * alert; with it, the second pass resolves to the alert that already exists.
 * A different kind of emergency, or the same kind after the first alert was
 * closed, still gets its own alert.
 */
const SOS_REUSE_MS = 10 * 60_000;

function sosKeyFor(kind) {
  try {
    const saved = JSON.parse(localStorage.getItem(`km.sosKey.${kind}`) ?? 'null');
    if (saved && Date.now() - saved.at < SOS_REUSE_MS) {
      const sent = outbox().find((i) => i.payload.idempotencyKey === saved.key);
      const closed = sent?.serverId && app.myAlerts.some((a) => a.id === sent.serverId && (a.status === 'resolved' || a.status === 'cancelled'));
      if (!closed) return { key: saved.key, reused: true };
    }
  } catch { /* storage unreadable — mint a fresh key */ }
  const key = newIdempotencyKey();
  try { localStorage.setItem(`km.sosKey.${kind}`, JSON.stringify({ key, at: Date.now() })); } catch { /* fine */ }
  return { key, reused: false };
}

/**
 * Raise the alert.
 *
 * Note the order: enqueue (which writes to storage synchronously) then close
 * the sheet then render. The user gets a truthful state in one frame whether
 * or not there is a network. Nothing here awaits the server.
 */
function raiseSos(kind, subjectLabel) {
  const { key, reused } = sosKeyFor(kind);
  const alreadyQueued = outbox().some((i) => i.payload.idempotencyKey === key);

  if (!alreadyQueued) {
    enqueue('/api/sos', {
      idempotencyKey: key,
      kind,
      subjectLabel: subjectLabel || null,
      nodeId: app.you,
      groupId: app.group?.id ?? null,
      raisedAt: new Date().toISOString(),
    }, { kind: 'sos' });
  }

  sosSheet.close();
  renderSosStatus();
  renderNetwork();
  buzz([90, 60, 90]);
  toast(reused
    ? say('Already sent — help is on the way. Stay where you are.', 'पहले ही भेज दिया है — मदद आ रही है। यहीं रुकिए।')
    : pendingCount() ? t('sosQueued') : t('sosSending'));
  flushOutbox().then(() => { refresh(); });
}

function renderSosStatus() {
  const box = $('#sos-status');
  if (!box) return;

  const queued = outbox().filter((i) => i.kind === 'sos' && i.status !== 'sent');
  const live = app.myAlerts.filter((a) => a.status === 'open' || a.status === 'claimed');

  if (!queued.length && !live.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');

  const meshed = outbox().filter((i) => i.kind === 'sos' && i.deliveredBy === 'mesh');

  const rows = [
    ...meshed.slice(-1).map((i) => ({
      tone: 'resolved',
      text: lang() === 'en'
        ? `Sent — carried by ${i.meshHops} nearby phone${i.meshHops > 1 ? 's' : ''}`
        : `भेज दिया — पास के ${i.meshHops} फ़ोन से होकर`,
    })),
    ...queued.map(() => ({ tone: 'queued', text: t('sosQueued') })),
    ...live.map((a) => ({
      tone: a.status,
      text: a.status === 'claimed' ? t('sosClaimed') : t('sosSent'),
      id: a.id,
    })),
  ];

  box.innerHTML = rows.map((r) => `
    <div class="panel" style="margin-bottom:8px;display:flex;align-items:center;gap:10px;padding:10px 13px">
      <span class="chip" data-tone="${r.tone}">${r.text}</span>
      <span style="flex:1"></span>
      ${r.id ? `<button class="btn" data-cancel="${r.id}" style="min-height:38px;padding:5px 12px;font-size:15px">${t('sosCancel')}</button>` : ''}
    </div>`).join('');

  box.querySelectorAll('[data-cancel]').forEach((b) => {
    b.onclick = async () => {
      try {
        await request(`/api/sos/${b.dataset.cancel}/cancel`, { method: 'POST' });
        refresh();
      } catch { toast(t('offlineBanner')); }
    };
  });
}

/* ---------------------------------------------------------- beacon ----- */

let beaconTone = null;

/**
 * Fill the screen with one colour and sing.
 *
 * The volunteer is already within a minute's walk but cannot pick this person
 * out of a crowd. So the phone becomes a flag: one saturated colour edge to
 * edge, held above the head, plus a rising two-note tone that carries further
 * than a shout and is distinct from a ringtone.
 *
 * The instruction on screen is written for someone who may not read well: it
 * names the colour in their own language and says the one thing they must do.
 */
function showBeacon(beacon, alertId) {
  const panel = $('#beacon');
  if (!panel) return;

  if (!beacon) {
    panel.classList.add('hidden');
    stopTone();
    releaseWake();
    app.beacon = null;
    return;
  }
  if (app.beacon?.colour === beacon.colour && !panel.classList.contains('hidden')) return;

  app.beacon = beacon;
  const name = beacon.name[lang()] ?? beacon.name.hi;
  const onDark = ['blue', 'magenta', 'black'].includes(beacon.colour);

  panel.style.background = beacon.hex;
  panel.style.color = onDark ? '#FFFFFF' : '#101010';
  panel.classList.remove('hidden');

  $('#beacon-text').textContent = lang() === 'en'
    ? 'Hold your phone up high'
    : 'अपना फ़ोन ऊपर उठाइए';
  $('#beacon-sub').textContent = lang() === 'en'
    ? `A volunteer is looking for a ${name.toLowerCase()} screen. Do not move from here.`
    : `स्वयंसेवक ${name} रंग की स्क्रीन ढूँढ रहे हैं। यहीं रुकिए।`;

  $('#beacon-off').onclick = async () => {
    showBeacon(null);
    if (alertId) {
      try { await request(`/api/sos/${alertId}/beacon/off`, { method: 'POST' }); } catch { /* fine */ }
    }
  };

  startTone();
  holdWake();
  $('#beacon-off').focus();
  buzz([200, 120, 200, 120, 400]);
}

/**
 * Keep the screen on while the beacon is lit. A phone held overhead dims after
 * thirty seconds and locks after a minute, and a dark rectangle is exactly
 * what the volunteer cannot see.
 */
let wakeLock = null;
async function holdWake() {
  try {
    if (!wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* battery saver or an unsupported browser — the colour still works */ }
}
function releaseWake() {
  try { wakeLock?.release(); } catch { /* already released */ }
  wakeLock = null;
}
// The browser drops the lock when the tab is hidden; take it back on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && app.beacon) holdWake();
});

/** Two rising notes, repeating. Deliberately unlike any ringtone. */
function startTone() {
  stopTone();
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    gain.connect(ctx.destination);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.connect(gain);
    osc.start();

    let step = 0;
    const tick = () => {
      const now = ctx.currentTime;
      osc.frequency.setValueAtTime(step % 2 ? 1320 : 880, now);
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.32, now + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
      step += 1;
    };
    tick();
    beaconTone = { ctx, osc, timer: setInterval(tick, 700) };
  } catch { /* audio can be blocked until the user taps; the colour still works */ }
}

function stopTone() {
  if (!beaconTone) return;
  clearInterval(beaconTone.timer);
  try { beaconTone.osc.stop(); beaconTone.ctx.close(); } catch { /* already gone */ }
  beaconTone = null;
}

/* -------------------------------------------------------- realtime ----- */

/** Is this alert one of ours — either known from the server or still in our outbox? */
function isMine(alertId) {
  return app.myAlerts.some((a) => a.id === alertId) || outbox().some((i) => i.serverId === alertId);
}

function connectRealtime() {
  // Bursts (a simulated crowd, several notices) collapse into one fetch.
  const soon = debounce(refresh, 400);

  connectLive(['flags', 'sos', 'notices', 'beacon', 'crowd', 'reunion'], (msg) => {
    const p = msg.payload ?? {};
    if (msg.type === 'flags' && p.edgeId) {
      // level null means the flag was removed and the path is back to baseline.
      if (p.level == null) delete app.flags[p.edgeId];
      else app.flags[p.edgeId] = { level: p.level };
      cache('flags', app.flags);
      // Someone walking towards a path that was just closed gets a new route
      // now, before they reach it.
      if (app.nav) reroute('flags');
      if (app.page === 'map') renderMap();
      if (app.page === 'home') renderHome();
    }
    // The socket carries no user ids, so "is it mine" is decided by alert id.
    // A brand-new alert of ours is covered by the refresh after the outbox
    // flushes; this catches claims, beacons and resolutions.
    if (msg.type === 'sos' && isMine(p.alertId)) soon();
    if (msg.type === 'beacon' && isMine(p.alertId)) showBeacon(p.beacon ?? null, p.alertId);
    if (msg.type === 'reunion' && p.groupId === app.group?.id) soon();
    if (msg.type === 'crowd' || msg.type === 'notices') soon();
  });
}

boot();
