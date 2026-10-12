/**
 * Light / dark / automatic, on every screen.
 *
 * One choice per device, shared by the pilgrim app, both consoles and the
 * landing page (localStorage "km.theme"). "Automatic" follows the phone's own
 * setting and changes with it. The colours themselves live in styles.css as
 * tokens; this only sets <html data-theme> and the browser bar colour.
 */

import { icon } from './icons.js';

const KEY = 'km.theme';
const THEMES = ['auto', 'light', 'dark'];
const dark = window.matchMedia?.('(prefers-color-scheme: dark)');

const LABEL = {
  title: { en: 'Appearance', hi: 'दिखावट', mr: 'दिसणे' },
  auto: { en: 'Automatic', hi: 'अपने-आप', mr: 'आपोआप' },
  light: { en: 'Light', hi: 'हल्का', mr: 'फिकट' },
  dark: { en: 'Dark', hi: 'गहरा', mr: 'गडद' },
  autoHint: { en: 'Follows your phone', hi: 'फ़ोन की सेटिंग जैसा', mr: 'फोनच्या सेटिंगप्रमाणे' },
  lightHint: { en: 'Best in bright sun', hi: 'तेज़ धूप में अच्छा', mr: 'उन्हात चांगले' },
  darkHint: { en: 'Easier at night', hi: 'रात में आरामदायक', mr: 'रात्री सोयीचे' },
};
const GLYPH = { auto: 'contrast', light: 'sun', dark: 'moon' };

export function getTheme() {
  try {
    const t = localStorage.getItem(KEY);
    return THEMES.includes(t) ? t : 'auto';
  } catch { return 'auto'; }
}

/** Is dark actually showing right now (after "automatic" is resolved)? */
export function isDark() {
  const t = getTheme();
  return t === 'dark' || (t === 'auto' && Boolean(dark?.matches));
}

function paint() {
  const t = getTheme();
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  // The phone's own status/address bar follows along.
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = isDark() ? '#0A2A30' : '#0F3B44';
  window.dispatchEvent(new CustomEvent('km:theme', { detail: { theme: t, dark: isDark() } }));
}

export function setTheme(t) {
  try { localStorage.setItem(KEY, THEMES.includes(t) ? t : 'auto'); } catch { /* not saved, still applied */ }
  paint();
}

// Follow the phone when on "automatic", and other tabs when changed there.
dark?.addEventListener?.('change', () => { if (getTheme() === 'auto') paint(); });
window.addEventListener('storage', (e) => { if (e.key === KEY) paint(); });
paint();

/**
 * A round button that opens a three-way menu. `getLang` returns 'hi' | 'mr' |
 * 'en' at the moment of rendering, so the menu follows the app's language.
 *
 * @param {HTMLElement} container
 * @param {{getLang?: () => string, variant?: 'on-brand' | 'plain'}} [options]
 */
export function mountThemeSwitch(container, { getLang = () => 'en', variant = 'on-brand' } = {}) {
  const render = () => {
    const lang = getLang();
    const L = (k) => LABEL[k][lang] ?? LABEL[k].en;
    const current = getTheme();
    const open = container.querySelector('.theme-menu') && !container.querySelector('.theme-menu').hidden;
    container.classList.add('theme-switch');
    container.innerHTML = `
      <button class="theme-btn theme-btn-${variant}" aria-haspopup="true" aria-expanded="${open}"
        aria-label="${L('title')}: ${L(current)}" title="${L('title')}: ${L(current)}">
        ${icon(GLYPH[current], { size: 18 })}
      </button>
      <div class="theme-menu" role="menu" ${open ? '' : 'hidden'}>
        <div class="theme-menu-title">${L('title')}</div>
        ${THEMES.map((t) => `
          <button role="menuitemradio" aria-checked="${t === current}" data-theme-choice="${t}">
            ${icon(GLYPH[t], { size: 20 })}
            <span><b>${L(t)}</b><small>${L(`${t}Hint`)}</small></span>
            ${t === current ? icon('check', { size: 18, cls: 'theme-tick' }) : ''}
          </button>`).join('')}
      </div>`;
    const button = container.querySelector('.theme-btn');
    const menu = container.querySelector('.theme-menu');
    const close = () => { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); };
    button.onclick = (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      button.setAttribute('aria-expanded', String(!menu.hidden));
      if (!menu.hidden) menu.querySelector('[aria-checked="true"]')?.focus();
    };
    menu.querySelectorAll('[data-theme-choice]').forEach((b) => {
      b.onclick = () => { setTheme(b.dataset.themeChoice); close(); render(); };
    });
    menu.onkeydown = (e) => { if (e.key === 'Escape') { close(); button.focus(); } };
    if (!container.dataset.bound) {
      container.dataset.bound = '1';
      document.addEventListener('click', (e) => {
        const m = container.querySelector('.theme-menu');
        if (m && !container.contains(e.target)) { m.hidden = true; container.querySelector('.theme-btn')?.setAttribute('aria-expanded', 'false'); }
      });
    }
  };
  render();
  return { render };
}
