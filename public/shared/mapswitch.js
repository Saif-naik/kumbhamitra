/**
 * Live-or-drawn map for the consoles.
 *
 * The volunteer queue and the control room both want the same thing: the
 * live tile map when it works, the drawn map when it does not (no network,
 * Leaflet failed to load), and a toggle between them. This wraps both behind
 * one render(view), with the choice remembered per screen.
 */

import { createMap } from './mapview.js';
import { createLiveMap, liveMapAvailable } from './livemap.js';

const read = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* fine */ } };

/**
 * @param {{toolbar: HTMLElement, live: HTMLElement, simple: HTMLElement, note?: HTMLElement,
 *          storageKey: string, onNodeClick?: Function, onEdgeClick?: Function}} options
 */
export function createMapSwitch({ toolbar, live, simple, note, storageKey, onNodeClick, onEdgeClick }) {
  const state = {
    mode: read(`${storageKey}.mode`, 'live'),
    layer: read(`${storageKey}.layer`, 'street'),
    liveMap: null,
    simpleMap: null,
    tilesFailing: false,
    lastView: {},
  };

  const useLive = () => state.mode === 'live' && liveMapAvailable();

  function ensure() {
    if (useLive() && !state.liveMap) {
      state.liveMap = createLiveMap(live, {
        layer: state.layer,
        labelLang: 'en',
        onNodeClick,
        onEdgeClick,
        onTilesFailing: (failing) => { state.tilesFailing = failing; renderNote(); },
      });
    }
    if (!useLive() && !state.simpleMap) {
      state.simpleMap = createMap(simple, { onNodeClick, onEdgeClick });
    }
  }

  function renderNote() {
    if (!note) return;
    const show = useLive() && state.tilesFailing;
    note.textContent = show ? 'Map pictures need internet. Paths, alerts and routes are still shown.' : '';
    note.classList.toggle('hidden', !show);
  }

  function renderToolbar() {
    const seg = (items, current, attr) => items
      .map(([value, label]) => `<button data-${attr}="${value}" aria-pressed="${current === value}">${label}</button>`).join('');
    toolbar.innerHTML = `
      ${liveMapAvailable() ? `<div class="seg" role="group" aria-label="Map type">${seg([['live', 'Live map'], ['simple', 'Simple map']], state.mode, 'mode')}</div>` : ''}
      ${useLive() ? `<div class="seg" role="group" aria-label="Map layer">${seg([['street', 'Street'], ['satellite', 'Satellite']], state.layer, 'layer')}</div>` : ''}
      <span class="map-toolbar-slot"></span>`;
    toolbar.querySelectorAll('[data-mode]').forEach((b) => {
      b.onclick = () => { state.mode = b.dataset.mode; write(`${storageKey}.mode`, state.mode); render(state.lastView); };
    });
    toolbar.querySelectorAll('[data-layer]').forEach((b) => {
      b.onclick = () => {
        state.layer = b.dataset.layer;
        write(`${storageKey}.layer`, state.layer);
        state.liveMap?.setLayer(state.layer);
        renderToolbar();
      };
    });
  }

  function render(view = {}) {
    state.lastView = view;
    ensure();
    const isLive = useLive();
    live.hidden = !isLive;
    simple.hidden = isLive;
    if (!toolbar.dataset.mode || toolbar.dataset.mode !== `${state.mode}:${state.layer}`) {
      toolbar.dataset.mode = `${state.mode}:${state.layer}`;
      renderToolbar();
      if (isLive) requestAnimationFrame(() => state.liveMap?.invalidate());
    }
    renderNote();
    (isLive ? state.liveMap : state.simpleMap).render(view);
  }

  return {
    render,
    get live() { return useLive() ? state.liveMap : null; },
    /** Where screen-specific buttons (e.g. My location) go in the toolbar. */
    get slot() { return toolbar.querySelector('.map-toolbar-slot'); },
  };
}
