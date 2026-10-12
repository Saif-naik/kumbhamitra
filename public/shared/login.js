/**
 * Sign-in and registration for volunteers and the control room.
 *
 * One script for both pages; <body data-role="volunteer|admin"> decides
 * which. Sessions are stored per screen by api.js (km.vol.* / km.admin.*),
 * so a volunteer and an admin can be signed in side by side in one browser.
 */

import { request, setSession, getToken, clearSession } from './api.js';
import { esc } from './dom.js';
import { icon } from './icons.js';
import { mountThemeSwitch } from './theme.js';

const role = document.body.dataset.role === 'admin' ? 'admin' : 'volunteer';
const HOME = role === 'admin' ? '/admin/' : '/volunteer/';
const $ = (s) => document.querySelector(s);

mountThemeSwitch($('#theme-switch'));
document.querySelectorAll('[data-icon]').forEach((el) => el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon, { size: el.dataset.size ? Number(el.dataset.size) : 20 })));

function showMessage(text, tone = 'error') {
  const box = $('#message');
  box.hidden = !text;
  box.dataset.tone = tone;
  box.innerHTML = text ? `${icon(tone === 'error' ? 'warning' : tone === 'ok' ? 'check' : 'info', { size: 20 })}<span>${esc(text)}</span>` : '';
}

/** Tabs: Log in / Register. */
function setTab(name) {
  document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  showMessage('');
  $(`[data-panel="${name}"] input`)?.focus();
}
document.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });

// Show / hide for password fields.
document.querySelectorAll('[data-reveal]').forEach((b) => {
  const input = document.getElementById(b.dataset.reveal);
  b.innerHTML = icon('eye', { size: 20 });
  b.onclick = () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.innerHTML = icon(show ? 'eyeOff' : 'eye', { size: 20 });
    b.setAttribute('aria-label', show ? 'Hide' : 'Show');
  };
});

async function busy(button, fn) {
  if (button.disabled) return;
  const label = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="spinner" aria-hidden="true"></span>${button.dataset.busy ?? 'Please wait…'}`;
  try { await fn(); } finally { button.disabled = false; button.innerHTML = label; }
}

function errorText(err) {
  if (err.offline) return 'No connection to the server. Check the network and try again.';
  return err.data?.message ?? 'Something went wrong. Try again.';
}

/* -------------------------------------------------------------- log in -- */

if ($('#login-form')) $('#login-form').onsubmit = (e) => {
  e.preventDefault();
  busy($('#login-go'), async () => {
    const body = role === 'admin'
      ? { role, username: $('#login-username').value, password: $('#login-password').value, securityKey: $('#login-key').value }
      : { role, phone: $('#login-phone').value, password: $('#login-password').value };
    try {
      const data = await request('/api/auth/login', { method: 'POST', body });
      setSession(data.token, data.user);
      if (data.created) {
        showMessage(`Saved. Next time sign in as "${body.username.trim()}" with the same password and the security key. Opening the control room…`, 'ok');
        await new Promise((r) => setTimeout(r, 2200));
      } else {
        showMessage('Signed in. Opening…', 'ok');
      }
      location.replace(HOME);
    } catch (err) {
      showMessage(errorText(err), err.data?.error === 'pending' ? 'info' : 'error');
    }
  });
};

/* ------------------------------------------------------------ register -- */

if (role === 'volunteer' && $('#register-form')) {
  $('#register-form').onsubmit = (e) => {
    e.preventDefault();
    const password = $('#reg-password').value;
    if (password !== $('#reg-password2').value) { showMessage('The two passwords do not match.'); return; }
    const picked = (name) => [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
    busy($('#register-go'), async () => {
      try {
        const data = await request('/api/auth/register', {
          method: 'POST',
          body: {
            role: 'volunteer',
            displayName: $('#reg-name').value,
            phone: $('#reg-phone').value,
            password,
            org: $('#reg-org').value,
            skills: picked('skills'),
            languages: picked('languages'),
          },
        });
        if (data.token) { setSession(data.token, data.user); location.replace(HOME); return; }
        $('#register-form').reset();
        setTab('login');
        showMessage('Registered. The control room has to approve you first — log in here once they have.', 'ok');
      } catch (err) {
        showMessage(errorText(err));
      }
    });
  };
} else if ($('#register-form')) {
  $('#register-form').onsubmit = (e) => {
    e.preventDefault();
    const password = $('#reg-password').value;
    if (password !== $('#reg-password2').value) { showMessage('The two passwords do not match.'); return; }
    busy($('#register-go'), async () => {
      try {
        const data = await request('/api/auth/admin/register', {
          method: 'POST',
          body: {
            displayName: $('#reg-name').value,
            username: $('#reg-username').value,
            password,
            securityKey: $('#reg-key').value,
          },
        });
        setSession(data.token, data.user);
        showMessage('Admin account created. Opening the control room…', 'ok');
        location.replace(HOME);
      } catch (err) {
        showMessage(errorText(err));
      }
    });
  };
}

/* ------------------------------------------------------- security key -- */

/** A random id kept on this phone, so the key brings back the same volunteer. */
function deviceId() {
  try {
    let id = localStorage.getItem('km.device');
    if (!id) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem('km.device', id);
    }
    return id;
  } catch { return null; }
}

// Straight in with the control room's key: no registration, no password.
$('#key-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  busy($('#key-go'), async () => {
    try {
      const data = await request('/api/auth/key-login', {
        method: 'POST',
        body: { role, securityKey: $('#key-code').value, deviceId: deviceId() },
      });
      setSession(data.token, data.user);
      showMessage('Key accepted. Opening…', 'ok');
      location.replace(HOME);
    } catch (err) {
      showMessage(errorText(err));
    }
  });
});

/* ------------------------------------------ already signed in? ---------- */

(async () => {
  if (new URLSearchParams(location.search).get('signedout')) {
    showMessage('You have signed out.', 'info');
  } else if (new URLSearchParams(location.search).get('expired')) {
    showMessage('Your session ended. Please sign in again.', 'info');
  }
  if (getToken()) {
    try {
      const { user } = await request('/api/auth/me');
      if (user.role === role) { location.replace(HOME); return; }
      clearSession();
    } catch { clearSession(); }
  }
})();
