/**
 * Where the phone is.
 *
 * Two sources behind one interface:
 *
 *  - GPS, via watchPosition. The raw fix is used on the device only — for the
 *    blue dot and for turn-by-turn. What goes to the server is the nearest
 *    landmark, exactly as before (see app.js). A precise trail of a stranger's
 *    movements is a stalking and trafficking risk with no operational payoff.
 *
 *  - A simulated walk along a route, for demos and for anyone testing away from
 *    the ground. It is always labelled as simulated in the interface, never
 *    passed off as a real fix.
 *
 * Both call onFix({lat, lng, accuracy, heading, source}).
 */

import { onGround, metresBetween } from './mela-map.js';

const WALK_SPEED = 1.3; // metres per second, an unhurried adult walk

function bearing(a, b) {
  const y = Math.sin(((b.lng - a.lng) * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180);
  const x = Math.cos((a.lat * Math.PI) / 180) * Math.sin((b.lat * Math.PI) / 180)
    - Math.sin((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.cos(((b.lng - a.lng) * Math.PI) / 180);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * @param {{onFix: Function, onStatus?: (status: string, detail?: any) => void}} handlers
 * status: 'locating' | 'gps' | 'outside' | 'denied' | 'unavailable' | 'sim' | 'off'
 */
export function createLocator({ onFix, onStatus = () => {} }) {
  let watchId = null;
  let simTimer = null;
  let last = null;
  let mode = 'off';

  function stopGps() {
    if (watchId !== null) navigator.geolocation?.clearWatch(watchId);
    watchId = null;
  }

  function stopSim() {
    clearInterval(simTimer);
    simTimer = null;
  }

  function startGps() {
    stopSim();
    if (!('geolocation' in navigator)) {
      mode = 'off';
      onStatus('unavailable');
      return;
    }
    stopGps();
    mode = 'gps';
    onStatus('locating');
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lng, accuracy, heading } = pos.coords;
        // Heading is only reported while moving; work it out from the last
        // fix otherwise, so the arrow still points the way they are walking.
        const derived = last && metresBetween(last, { lat, lng }) > 4 ? bearing(last, { lat, lng }) : last?.heading ?? null;
        const fix = { lat, lng, accuracy, heading: Number.isFinite(heading) ? heading : derived, source: 'gps' };
        last = fix;
        if (!onGround(lat, lng, 1500)) {
          onStatus('outside', fix);
          return;
        }
        onStatus('gps', fix);
        onFix(fix);
      },
      (err) => {
        onStatus(err.code === 1 ? 'denied' : 'unavailable', err);
        if (err.code === 1) { stopGps(); mode = 'off'; }
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 }
    );
  }

  /**
   * Walk the given points at walking pace, sped up `speedup` times so a demo
   * does not take forty minutes. Calls onDone at the end.
   */
  function simulate(points, { speedup = 10, intervalMs = 500, onDone } = {}) {
    stopGps();
    stopSim();
    if (!points || points.length < 2) return;
    mode = 'sim';
    onStatus('sim');
    let seg = 0;
    let along = 0;
    const stepMetres = WALK_SPEED * speedup * (intervalMs / 1000);

    const emit = () => {
      const a = points[seg];
      const b = points[seg + 1];
      const len = metresBetween(a, b) || 1;
      const t = Math.min(1, along / len);
      const fix = {
        lat: a.lat + (b.lat - a.lat) * t,
        lng: a.lng + (b.lng - a.lng) * t,
        accuracy: 5,
        heading: bearing(a, b),
        source: 'sim',
      };
      last = fix;
      onFix(fix);
    };

    emit();
    simTimer = setInterval(() => {
      along += stepMetres;
      while (seg < points.length - 1 && along >= metresBetween(points[seg], points[seg + 1])) {
        along -= metresBetween(points[seg], points[seg + 1]);
        seg += 1;
      }
      if (seg >= points.length - 1) {
        const end = points[points.length - 1];
        onFix({ lat: end.lat, lng: end.lng, accuracy: 5, heading: last?.heading ?? null, source: 'sim' });
        stopSim();
        mode = 'off';
        onDone?.();
        return;
      }
      emit();
    }, intervalMs);
  }

  return {
    startGps,
    simulate,
    stop() { stopGps(); stopSim(); mode = 'off'; onStatus('off'); },
    stopSim,
    get mode() { return mode; },
    get last() { return last; },
  };
}
