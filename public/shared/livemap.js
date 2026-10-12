/**
 * The live map: real street or satellite tiles with the mela graph on top.
 *
 * Same render(view) contract as the drawn map in mapview.js, so the app can
 * switch between them freely. The drawn map stays as the fallback: it needs
 * no network at all, and this one needs tiles for its background.
 *
 * What is drawn on top of the tiles is ours, not the tile provider's: crowd
 * levels on each path (colour AND weight AND dash, as on the drawn map, for
 * sun glare and colour blindness), landmarks, the crowd-aware route, family
 * members, and the phone's own position with its accuracy and heading. The
 * tiles are only a picture underneath — routing never depends on them, so a
 * temporary mela road missing from the basemap does not matter.
 *
 * Needs Leaflet loaded as a classic script (window.L), served from our own
 * origin at /vendor/leaflet/.
 */

import { NODES, EDGES, NODE_BY_ID, CROWD, nodeLatLng, groundBounds } from './mela-map.js';
import { levelFor } from './routing.js';
import { placeName } from './i18n.js';
import { esc, initial } from './dom.js';

export const liveMapAvailable = () => typeof window !== 'undefined' && typeof window.L !== 'undefined';

const CROWD_COLOUR = { 1: '#2F7A52', 2: '#E0A32E', 3: '#D2691E', 4: '#7A1B12' };
// Risk 0–3. Never vermilion: that colour is reserved for SOS.
const PRESSURE_COLOUR = { 0: '#2F7A52', 1: '#E0A32E', 2: '#D2691E', 3: '#7A1B12' };

const TYPE_STYLE = {
  ghat: { fill: '#1B5A66', icon: 'M4 14q4-3 8 0t8 0M4 9q4-3 8 0t8 0' },
  medical: { fill: '#A33B57', icon: 'M12 6v12M6 12h12' },
  police: { fill: '#0F3B44', icon: 'M12 4l6 2.5v5c0 3.6-2.6 6.4-6 7.5-3.4-1.1-6-3.9-6-7.5v-5z' },
  toilet: { fill: '#6B6257', icon: 'M12 5.5a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2zM9 11h6M12 10v8M10 18h4' },
  water: { fill: '#2F7A52', icon: 'M12 5c3 4 4.5 5.8 4.5 8a4.5 4.5 0 0 1-9 0c0-2.2 1.5-4 4.5-8z' },
  food: { fill: '#D9822B', icon: 'M5 11h14a7 7 0 0 1-14 0zM9 6v3M15 6v3' },
  camp: { fill: '#8A6A3F', icon: 'M4 18L12 6l8 12zM12 6v12' },
  gate: { fill: '#0F3B44', icon: 'M7 19v-8a5 5 0 0 1 10 0v8' },
};

const TILES = {
  street: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: { maxZoom: 19, maxNativeZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' },
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    options: { maxZoom: 19, maxNativeZoom: 18, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' },
  },
};

const ll = (id) => { const p = nodeLatLng(id); return [p.lat, p.lng]; };

/**
 * @param {HTMLElement} container
 * @param {{onNodeClick?: Function, onEdgeClick?: (edge, level) => void, onUserPan?: Function,
 *          onTilesFailing?: (failing: boolean) => void, layer?: 'street'|'satellite'}} options
 */
export function createLiveMap(container, { onNodeClick, onEdgeClick, onUserPan, onTilesFailing, layer = 'street', labelLang = null } = {}) {
  // Consoles are in English whatever language the pilgrim app last used.
  const label = (node) => (labelLang ? placeName(node, labelLang) : placeName(node));
  const L = window.L;
  container.innerHTML = '';
  const holder = document.createElement('div');
  holder.className = 'live-map';
  holder.setAttribute('role', 'region');
  holder.setAttribute('aria-label', 'Live map of the mela ground');
  container.appendChild(holder);

  const b = groundBounds();
  const ground = L.latLngBounds([b.south, b.west], [b.north, b.east]);

  const map = L.map(holder, {
    // Keep people on the ground: panning to the next city is never useful.
    maxBounds: ground.pad(0.8),
    maxBoundsViscosity: 0.8,
    minZoom: 13.5,
    maxZoom: 19,
    zoomSnap: 0.5,
    zoomControl: true,
    tap: true,
  });
  map.fitBounds(ground, { padding: [8, 8] });
  map.attributionControl.setPrefix(false);

  // Order of drawing, bottom to top.
  for (const [name, z] of [['kmPressure', 405], ['kmEdges', 410], ['kmRoute', 420], ['kmNodes', 430], ['kmPins', 440], ['kmYou', 450]]) {
    map.createPane(name).style.zIndex = z;
  }
  const groups = {
    pressure: L.layerGroup().addTo(map),
    edges: L.layerGroup().addTo(map),
    route: L.layerGroup().addTo(map),
    nodes: L.layerGroup().addTo(map),
    pins: L.layerGroup().addTo(map),
    you: L.layerGroup().addTo(map),
  };

  // Tiles, with a watch on failures so the app can say "no map pictures —
  // paths still shown" instead of leaving a grey void with no explanation.
  let tiles = null;
  let failures = 0;
  let loaded = 0;
  function setLayer(name) {
    const def = TILES[name] ?? TILES.street;
    if (tiles) map.removeLayer(tiles);
    failures = 0;
    loaded = 0;
    tiles = L.tileLayer(def.url, { ...def.options, crossOrigin: true }).addTo(map);
    tiles.on('tileerror', () => { failures += 1; if (failures >= 4 && loaded === 0) onTilesFailing?.(true); });
    tiles.on('tileload', () => { loaded += 1; if (loaded === 1) onTilesFailing?.(false); });
    holder.dataset.layer = name;
  }
  setLayer(layer);

  // Labels only once there is room for them.
  const zoomClass = () => holder.classList.toggle('lm-zoomed-out', map.getZoom() < 15.5);
  map.on('zoomend', zoomClass);
  zoomClass();

  // A pan or pinch by the user switches off follow-me until they ask again.
  map.on('dragstart', () => onUserPan?.());

  // Landmarks. Drawn once — they never move.
  for (const node of NODES) {
    if (node.type === 'junction') {
      L.circleMarker(ll(node.id), {
        pane: 'kmNodes', radius: 4, color: '#FDF6E9', weight: 2, fillColor: '#B9A886', fillOpacity: 1, interactive: false,
      }).addTo(groups.nodes);
      continue;
    }
    const style = TYPE_STYLE[node.type] ?? TYPE_STYLE.gate;
    const icon = L.divIcon({
      className: 'lm-node-wrap',
      iconSize: [34, 34],
      iconAnchor: [17, 17],
      html: `<span class="lm-node" style="background:${style.fill}">
               <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${style.icon}"/></svg>
             </span><span class="lm-label">${esc(label(node))}</span>`,
    });
    const marker = L.marker(ll(node.id), { icon, pane: 'kmNodes', title: label(node), alt: label(node), keyboard: true, riseOnHover: true });
    if (onNodeClick) marker.on('click', () => onNodeClick(node));
    marker.addTo(groups.nodes);
  }

  let routeKey = '';

  function render(view = {}) {
    const {
      flags = {}, routeResult = null, you = null, gps = null, members = [], alerts = [], highlight = [],
      pressure = [], volunteers = [], selectedEdge = null, origin = null,
    } = view;
    const onRoute = new Set((routeResult?.edges ?? []).map((e) => e.id));

    groups.edges.clearLayers();
    for (const edge of EDGES) {
      const level = levelFor(edge, flags);
      const line = L.polyline([ll(edge.a), ll(edge.b)], {
        pane: 'kmEdges',
        color: CROWD_COLOUR[level],
        weight: level === 1 ? 5 : level === 2 ? 7 : 9,
        dashArray: level === 4 ? '2 12' : level === 3 ? '18 8' : null,
        lineCap: 'round',
        opacity: onRoute.size && !onRoute.has(edge.id) ? 0.45 : 0.92,
        interactive: false,
      });
      line.addTo(groups.edges);

      if (selectedEdge === edge.id) {
        L.polyline([ll(edge.a), ll(edge.b)], { pane: 'kmEdges', color: '#1B52C4', weight: 16, opacity: 0.35, lineCap: 'round', interactive: false }).addTo(groups.edges);
      }

      // A wide invisible line on top so a path is easy to hit with a finger
      // or a mouse — the visible line is only 5–9 px.
      if (onEdgeClick) {
        const hit = L.polyline([ll(edge.a), ll(edge.b)], {
          pane: 'kmEdges', color: '#000', weight: 26, opacity: 0, interactive: true, className: 'lm-edge-hit',
        });
        hit.bindTooltip(`${NODE_BY_ID[edge.a].name.en} → ${NODE_BY_ID[edge.b].name.en}: ${CROWD[level].en}`, { sticky: true, direction: 'top' });
        hit.on('click', () => onEdgeClick(edge, level));
        hit.addTo(groups.edges);
      }
    }

    // Crowd pressure, for the control room: a circle per landmark sized by how
    // full it is, coloured by risk. Aggregate head-counts only — no person.
    groups.pressure.clearLayers();
    for (const p of pressure) {
      if (!p.count || !NODE_BY_ID[p.nodeId]) continue;
      const colour = PRESSURE_COLOUR[p.risk] ?? PRESSURE_COLOUR[0];
      L.circle(ll(p.nodeId), {
        pane: 'kmPressure',
        radius: 60 + Math.min(1.2, p.load) * 220,
        color: colour, weight: p.risk >= 2 ? 3 : 1.5,
        fillColor: colour, fillOpacity: p.risk >= 3 ? 0.38 : 0.22,
        dashArray: p.risk >= 3 ? null : '6 6',
        interactive: false,
      }).addTo(groups.pressure);
    }

    groups.route.clearLayers();
    if (routeResult?.path?.length > 1) {
      const pts = routeResult.path.map(ll);
      L.polyline(pts, { pane: 'kmRoute', color: '#0F3B44', weight: 14, opacity: 0.3, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(groups.route);
      L.polyline(pts, { pane: 'kmRoute', color: '#F2A03C', weight: 7, opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(groups.route);
    }
    // From where they are standing to where the route starts: dashed, because
    // it is "make your way to", not a mapped path.
    if (origin && routeResult?.path?.length) {
      L.polyline([[origin.lat, origin.lng], ll(routeResult.path[0])], {
        pane: 'kmRoute', color: '#F2A03C', weight: 5, opacity: 0.95, dashArray: '2 10', lineCap: 'round', interactive: false,
      }).addTo(groups.route);
    }
    for (const id of highlight) {
      if (!NODE_BY_ID[id]) continue;
      L.circleMarker(ll(id), { pane: 'kmRoute', radius: 24, color: '#F2A03C', weight: 4, fillColor: '#F2A03C', fillOpacity: 0.25, interactive: false }).addTo(groups.route);
    }

    groups.pins.clearLayers();
    members.forEach((m, index) => {
      if (!m.nodeId || !NODE_BY_ID[m.nodeId]) return;
      const icon = L.divIcon({
        className: 'lm-member-wrap',
        iconSize: [34, 44],
        iconAnchor: [17 - ((index % 3) - 1) * 22, 50],
        html: `<span class="lm-member" title="${esc(m.label)}">${initial(m.label)}</span>`,
      });
      L.marker(ll(m.nodeId), { icon, pane: 'kmPins', keyboard: false, title: m.label }).addTo(groups.pins);
    });
    // Volunteers on duty: green when free, grey when on a job.
    volunteers.forEach((v, index) => {
      if (!v.nodeId || !NODE_BY_ID[v.nodeId]) return;
      const icon = L.divIcon({
        className: 'lm-vol-wrap', iconSize: [28, 28], iconAnchor: [14 - ((index % 3) - 1) * 18, -6],
        html: `<span class="lm-vol" data-busy="${v.busy ? '1' : '0'}" title="${esc(v.displayName)}">${initial(v.displayName)}</span>`,
      });
      L.marker(ll(v.nodeId), { icon, pane: 'kmPins', keyboard: false, title: `${v.displayName} — ${v.busy ? 'on a job' : 'free'}` }).addTo(groups.pins);
    });

    for (const a of alerts) {
      if (!a.nodeId || !NODE_BY_ID[a.nodeId]) continue;
      const icon = L.divIcon({
        className: 'lm-alert-wrap', iconSize: [30, 30], iconAnchor: [15, 46],
        html: `<span class="lm-alert" data-status="${esc(a.status)}">!</span>`,
      });
      L.marker(ll(a.nodeId), { icon, pane: 'kmPins', keyboard: false }).addTo(groups.pins);
    }

    drawYou(gps, you);

    // When a new route appears, show all of it once.
    const key = routeResult?.path?.join('>') ?? '';
    if (key && key !== routeKey && !view.following) fitRoute(routeResult);
    routeKey = key;
  }

  /** Just the position marker — cheap enough to call on every GPS fix. */
  function drawYou(gps, you) {
    groups.you.clearLayers();
    if (gps) {
      // A real (or clearly-simulated) fix: dot, accuracy ring, and which way
      // they are facing.
      if (gps.accuracy && gps.accuracy > 8) {
        L.circle([gps.lat, gps.lng], { pane: 'kmYou', radius: gps.accuracy, color: '#1B52C4', weight: 1, fillColor: '#1B52C4', fillOpacity: 0.1, interactive: false }).addTo(groups.you);
      }
      const heading = Number.isFinite(gps.heading) ? gps.heading : null;
      const icon = L.divIcon({
        className: 'lm-you-wrap', iconSize: [44, 44], iconAnchor: [22, 22],
        html: `<span class="lm-you ${gps.source === 'sim' ? 'is-sim' : ''}">
                 ${heading !== null ? `<i class="lm-heading" style="transform:rotate(${heading}deg)"></i>` : ''}
                 <b></b></span>`,
      });
      L.marker([gps.lat, gps.lng], { icon, pane: 'kmYou', keyboard: false, interactive: false }).addTo(groups.you);
    } else if (you && NODE_BY_ID[you]) {
      // No GPS: show the place they chose, marked as chosen rather than measured.
      const icon = L.divIcon({ className: 'lm-you-wrap', iconSize: [44, 44], iconAnchor: [22, 22], html: '<span class="lm-you is-chosen"><b></b></span>' });
      L.marker(ll(you), { icon, pane: 'kmYou', keyboard: false, interactive: false }).addTo(groups.you);
    }
  }

  function fitRoute(result) {
    if (!result?.path?.length) return;
    map.fitBounds(L.latLngBounds(result.path.map(ll)), { padding: [40, 40], maxZoom: 17 });
  }

  return {
    render,
    updateYou: drawYou,
    setLayer,
    fitRoute,
    fitGround() { map.fitBounds(ground, { padding: [8, 8] }); },
    /**
     * Keep the walker in view. With `ahead` (the next landmark), frame both,
     * so the place they are walking to is always on screen — a dot on an
     * unlabelled road tells a pilgrim nothing.
     */
    follow(fix, zoom = 17.5, ahead = null) {
      if (ahead) {
        // Extra room at the bottom: the navigation bar and SOS button float
        // over the lower part of the map, and the walker's dot must not
        // disappear under them.
        map.fitBounds(L.latLngBounds([[fix.lat, fix.lng], [ahead.lat, ahead.lng]]), {
          paddingTopLeft: [48, 48], paddingBottomRight: [48, 170], maxZoom: zoom, animate: true, duration: 0.5,
        });
        return;
      }
      map.setView([fix.lat, fix.lng], Math.max(map.getZoom(), zoom), { animate: true, duration: 0.5 });
    },
    invalidate() { map.invalidateSize(); },
    get leaflet() { return map; },
  };
}
