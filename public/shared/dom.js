/**
 * Small browser helpers shared by the pilgrim app and both consoles.
 *
 * `esc` is the important one. Names, notices, group labels and "who is
 * missing" descriptions are typed by strangers and then rendered on other
 * people's screens. Anything that did not come from our own code goes through
 * esc() before it touches innerHTML — a notice that runs script on a
 * volunteer's console is a safety bug, not a cosmetic one.
 */

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

/** First letter for an avatar pip, safe to drop into markup. */
export function initial(value) {
  return esc((String(value ?? '').trim().charAt(0) || '?').toUpperCase());
}

/**
 * Live updates over the socket.
 *
 * The socket is an accelerator; every screen also polls. So this is built to
 * fail quietly: malformed frames are ignored, reconnects back off with jitter
 * (thousands of phones reconnecting in lockstep is how a recovering tower gets
 * knocked over again), and bursts of messages collapse into one callback.
 *
 * @param {string[]} topics
 * @param {(msg: {type: string, payload: any}) => void} onMessage
 * @param {{onStatus?: (connected: boolean) => void}} [options]
 */
export function connectLive(topics, onMessage, { onStatus } = {}) {
  let socket = null;
  let delay = 2000;
  let stopped = false;

  const open = () => {
    if (stopped) return;
    try {
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    } catch {
      retry();
      return;
    }
    socket.onopen = () => {
      delay = 2000;
      onStatus?.(true);
      socket.send(JSON.stringify({ type: 'subscribe', topics }));
    };
    socket.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (!msg || ['hello', 'subscribed', 'heartbeat'].includes(msg.type)) return;
      try { onMessage(msg); } catch (err) { console.error(err); }
    };
    socket.onclose = () => { onStatus?.(false); retry(); };
    socket.onerror = () => { try { socket.close(); } catch { /* closing anyway */ } };
  };

  const retry = () => {
    if (stopped) return;
    setTimeout(open, delay + Math.random() * delay);
    delay = Math.min(delay * 2, 30_000);
  };

  // A phone coming back from the lock screen should not wait out a backoff.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && socket?.readyState === WebSocket.CLOSED) {
      delay = 2000;
      open();
    }
  });

  open();
  return { close() { stopped = true; socket?.close(); } };
}

/** Run `fn` at most once per `ms`, trailing — for refreshes triggered by bursts. */
export function debounce(fn, ms = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** One toast at a time, announced to screen readers. */
let toastTimer;
export function toast(message, { tone = 'info', ms = 3200 } = {}) {
  let node = document.querySelector('.toast');
  if (!node) {
    node = document.createElement('div');
    node.className = 'toast';
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    document.body.appendChild(node);
  }
  node.dataset.tone = tone;
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), ms);
}

/** "12s ago", for console freshness indicators. */
export function ago(timestamp) {
  if (!timestamp) return 'never';
  const s = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/**
 * Make an overlay behave like a dialog: Escape and a backdrop tap close it,
 * focus moves in on open and goes back to where it was on close.
 */
export function dialog(overlay, { onClose } = {}) {
  let returnTo = null;
  const close = () => {
    overlay.classList.add('hidden');
    document.removeEventListener('keydown', onKey);
    returnTo?.focus?.();
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  return {
    open() {
      returnTo = document.activeElement;
      overlay.classList.remove('hidden');
      document.addEventListener('keydown', onKey);
      requestAnimationFrame(() => overlay.querySelector('button, input, select')?.focus());
    },
    close,
    get isOpen() { return !overlay.classList.contains('hidden'); },
  };
}

/**
 * Vibrate if the browser will allow it. Browsers refuse vibration until the
 * page has had a tap; asking anyway only fills the console with warnings.
 */
export function buzz(pattern) {
  try {
    if (!navigator.vibrate) return;
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    navigator.vibrate(pattern);
  } catch { /* vibration is a bonus */ }
}
