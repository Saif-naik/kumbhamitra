/**
 * Client transport.
 *
 * The important part of this file is the outbox.
 *
 * When someone presses the red button, we write the alert to local storage
 * FIRST and only then try the network. The UI reads its state from the outbox,
 * so it can say "waiting to send" honestly instead of showing a checkmark it
 * has not earned. On a mela network, a request that appears to hang is the
 * normal case, not the edge case — the tower is congested, not absent, so
 * `navigator.onLine` is true and the socket still goes nowhere.
 *
 * Every queued item carries an idempotency key minted on the device before any
 * network call. Retries collapse server-side into one alert.
 */

import { startMesh, askForCarry, setOnline as meshSetOnline, mesh, peers as meshPeers } from './mesh.js';

/**
 * Each screen keeps its own sign-in. Tabs on one origin share localStorage,
 * so with a single key, opening the volunteer console beside the pilgrim app
 * (exactly what the demo asks for) overwrote the pilgrim's token, and the
 * pilgrim tab silently carried on as the volunteer — its alert status, group
 * and reunion banner all stopped updating.
 */
// The control room and its volunteer queue (/admin/queue.html) share one
// session; volunteers (/volunteer/) have their own.
const SURFACE = location.pathname.startsWith('/admin') ? 'admin'
  : location.pathname.startsWith('/volunteer') ? 'vol'
  : 'app';
const TOKEN_KEY = SURFACE === 'app' ? 'km.token' : `km.${SURFACE}.token`;
const USER_KEY = SURFACE === 'app' ? 'km.user' : `km.${SURFACE}.user`;
const OUTBOX_KEY = 'km.outbox';
const CACHE_PREFIX = 'km.cache.';

const SIM_KEY = 'km.simulatedOffline';
const listeners = new Set();

export const state = {
  online: navigator.onLine,
  sending: false,
  lastError: null,
  peers: { count: 0, withNetwork: 0 },
};

/**
 * Simulated offline.
 *
 * Switching off real wifi kills every browser tab at once, which makes it
 * impossible to demonstrate one phone carrying another phone's alert. So the
 * app carries its own airplane switch: this one tab behaves as though it has
 * no signal while its neighbours still do. It is a demo affordance and it is
 * labelled as one in the interface.
 */
// Per tab (sessionStorage), not per browser: the point is that this tab loses
// signal while the tab next to it — the "stranger standing nearby" — keeps it.
// In localStorage the switch turned every tab offline at once, so no
// neighbour could ever carry the alert.
export function isSimulatedOffline() {
  try { return sessionStorage.getItem(SIM_KEY) === '1'; } catch { return false; }
}

export function setSimulatedOffline(value) {
  try { sessionStorage.setItem(SIM_KEY, value ? '1' : '0'); } catch { /* demo switch only */ }
  state.online = !value && navigator.onLine;
  meshSetOnline(state.online);
  emit();
  if (!value) flushOutbox();
}

function emit() {
  for (const fn of listeners) fn(state);
}

export function onStateChange(fn) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

window.addEventListener('online', () => { state.online = true; emit(); flushOutbox(); });
window.addEventListener('offline', () => { state.online = false; emit(); });

/* ------------------------------------------------------------- storage -- */

export function getToken() { return localStorage.getItem(TOKEN_KEY); }
export function setSession(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}
export function getUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; }
}
export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/** Last-good-value cache. A stale schedule beats a spinner. */
export function cached(key, fallback = null) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
export function cache(key, value) {
  try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value)); } catch { /* full, ignore */ }
}

/* --------------------------------------------------------------- fetch -- */

const TIMEOUT_MS = 7000;

export async function request(path, { method = 'GET', body, timeout = TIMEOUT_MS } = {}) {
  if (isSimulatedOffline()) {
    const error = new Error('network_slow');
    error.offline = true;
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(path, {
      method,
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      // The server no longer knows this token (database reset, or a token
      // from before tokens were separated from ids). Let the page decide how
      // to sign in again rather than failing every call forever.
      if (response.status === 401 && getToken()) {
        window.dispatchEvent(new CustomEvent('km:unauthorised'));
      }
      const error = new Error(data.message || data.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    if (!state.online) { state.online = true; emit(); }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      // Timed out. On this network that usually means congestion, not a dead
      // link, so we treat it as offline for UI purposes and keep retrying.
      state.online = false;
      emit();
      const error = new Error('network_slow');
      error.offline = true;
      throw error;
    }
    if (err.status === undefined) { state.online = false; emit(); }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch with a cached fallback, for anything non-critical. */
export async function requestCached(path, cacheKey) {
  try {
    const data = await request(path);
    cache(cacheKey, data);
    return { data, fresh: true };
  } catch {
    return { data: cached(cacheKey), fresh: false };
  }
}

/* -------------------------------------------------------------- outbox -- */

export function outbox() {
  try { return JSON.parse(localStorage.getItem(OUTBOX_KEY)) ?? []; } catch { return []; }
}
function writeOutbox(items) {
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(items));
  emit();
}

export function newIdempotencyKey() {
  const rand = crypto.getRandomValues(new Uint8Array(8));
  return `${Date.now().toString(36)}-${[...rand].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Put an item in the durable outbox and try to send it.
 * Returns the local record immediately — the caller must never wait for the
 * network before telling the user something happened.
 */
export function enqueue(path, payload, { kind = 'generic' } = {}) {
  const item = {
    localId: newIdempotencyKey(),
    path,
    kind,
    payload: { ...payload, idempotencyKey: payload.idempotencyKey ?? newIdempotencyKey() },
    status: 'queued',
    attempts: 0,
    queuedAt: new Date().toISOString(),
    serverId: null,
  };
  writeOutbox([...outbox(), item]);
  flushOutbox();
  return item;
}

let flushing = false;
let backoff = 1000;

export async function flushOutbox() {
  if (flushing) return;
  const pending = outbox().filter((i) => i.status !== 'sent');
  if (!pending.length) return;

  flushing = true;
  state.sending = true;
  emit();

  for (const item of pending) {
    try {
      const data = await request(item.path, { method: 'POST', body: item.payload });
      const items = outbox().map((i) =>
        i.localId === item.localId
          ? { ...i, status: 'sent', sentAt: new Date().toISOString(), serverId: data.alert?.id ?? null }
          : i
      );
      writeOutbox(items);
      backoff = 1000;
    } catch (err) {
      const items = outbox().map((i) =>
        i.localId === item.localId
          ? { ...i, attempts: i.attempts + 1, lastError: err.message, status: 'queued' }
          : i
      );
      writeOutbox(items);
      // We cannot reach the tower. Before sleeping, ask the phones around us
      // whether any of them can. This is the whole point of the mesh: the
      // alert leaves the device even though the device has no signal.
      if (item.kind === 'sos') askForCarry(item);

      // Exponential backoff with jitter. Thousands of phones retrying in
      // lockstep is how you finish off an already-congested tower.
      backoff = Math.min(backoff * 2, 30_000);
      const jitter = Math.random() * backoff * 0.4;
      setTimeout(flushOutbox, backoff + jitter);
      break;
    }
  }

  flushing = false;
  state.sending = false;
  emit();
}

/** Anything still waiting to reach the server. */
export function pendingCount() {
  return outbox().filter((i) => i.status !== 'sent').length;
}

export function clearSentOlderThan(hours = 12) {
  const cutoff = Date.now() - hours * 3_600_000;
  writeOutbox(outbox().filter((i) => i.status !== 'sent' || new Date(i.queuedAt).getTime() > cutoff));
}

/* ---------------------------------------------------------------- mesh -- */

/** A neighbour got one of our alerts through. Close it out honestly. */
mesh.onRelayed = (idempotencyKey, info) => {
  const items = outbox().map((i) =>
    i.payload.idempotencyKey === idempotencyKey
      ? { ...i, status: 'sent', sentAt: new Date().toISOString(), serverId: info.alertId,
          deliveredBy: 'mesh', meshHops: info.hops }
      : i
  );
  writeOutbox(items);
};

mesh.onCarried = (info) => {
  state.lastCarried = info;
  emit();
};

mesh.onPeersChanged = (summary) => {
  state.peers = summary;
  emit();
};

export function meshInfo() {
  return { deviceId: mesh.deviceId, ...meshPeers() };
}

// Only pilgrim phones take part in the mesh. A carried alert is posted under
// the carrier's account, so a console tab carrying one would file a pilgrim's
// emergency as raised by "Control Room" — and consoles are not phones in the
// crowd anyway.
if (SURFACE === 'app') startMesh((path, payload) => request(path, { method: 'POST', body: payload }));
state.online = !isSimulatedOffline() && navigator.onLine;
meshSetOnline(state.online);

setInterval(flushOutbox, 15_000);
