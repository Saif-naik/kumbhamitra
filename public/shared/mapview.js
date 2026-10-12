/**
 * The map.
 *
 * Drawn as SVG from the graph file, not from tiles. Two reasons, both of them
 * about the field rather than about taste:
 *
 *  - It works with zero network on first launch. Tile packs are the right
 *    answer eventually, but they must be pre-bundled or fetched at a kiosk on
 *    arrival, never lazily, and that is a distribution problem to solve after
 *    the app itself works.
 *  - A mela ground is temporary. The roads are three days old and are not in
 *    any basemap. What pilgrims navigate by is landmarks — the ghat, the
 *    medical tent, sector B — so the map draws landmarks large and paths thin.
 *
 * Crowding is encoded as colour AND stroke weight AND dash, so it survives
 * bright sun, a cracked screen, and colour blindness.
 */

import { NODES, EDGES, NODE_BY_ID, GROUND, CROWD } from './mela-map.js';
import { levelFor } from './routing.js';
import { placeName } from './i18n.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const TYPE_STYLE = {
  ghat:     { fill: '#1B5A66', glyph: 'water',   r: 17 },
  medical:  { fill: '#A33B57', glyph: 'cross',   r: 15 },
  police:   { fill: '#0F3B44', glyph: 'shield',  r: 15 },
  toilet:   { fill: '#6B6257', glyph: 'toilet',  r: 13 },
  water:    { fill: '#2F7A52', glyph: 'drop',    r: 13 },
  food:     { fill: '#D9822B', glyph: 'bowl',    r: 14 },
  camp:     { fill: '#8A6A3F', glyph: 'tent',    r: 15 },
  gate:     { fill: '#0F3B44', glyph: 'gate',    r: 14 },
  junction: { fill: '#B9A886', glyph: null,      r: 7 },
};

const CROWD_COLOUR = { 1: '#2F7A52', 2: '#E0A32E', 3: '#D2691E', 4: '#7A1B12' };

function el(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  return node;
}

function glyphPath(kind, x, y, size) {
  const s = size;
  const g = el('g', { transform: `translate(${x} ${y})`, fill: 'none', stroke: '#fff', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  const add = (name, attrs) => g.appendChild(el(name, attrs));
  switch (kind) {
    case 'water':
      add('path', { d: `M ${-s} 2 q ${s / 2} -6 ${s} 0 q ${s / 2} 6 ${s} 0`, });
      add('path', { d: `M ${-s} ${-6} q ${s / 2} -6 ${s} 0 q ${s / 2} 6 ${s} 0` });
      break;
    case 'cross':
      add('path', { d: `M 0 ${-s} L 0 ${s} M ${-s} 0 L ${s} 0`, 'stroke-width': 3.4 });
      break;
    case 'shield':
      add('path', { d: `M 0 ${-s} L ${s * 0.8} ${-s * 0.4} L ${s * 0.6} ${s * 0.8} L 0 ${s} L ${-s * 0.6} ${s * 0.8} L ${-s * 0.8} ${-s * 0.4} Z` });
      break;
    case 'drop':
      add('path', { d: `M 0 ${-s} C ${s * 0.9} ${-s * 0.1} ${s * 0.6} ${s} 0 ${s} C ${-s * 0.6} ${s} ${-s * 0.9} ${-s * 0.1} 0 ${-s} Z` });
      break;
    case 'toilet':
      add('circle', { cx: 0, cy: -s * 0.55, r: s * 0.28 });
      add('path', { d: `M 0 ${-s * 0.2} L 0 ${s * 0.5} M ${-s * 0.5} ${s * 0.1} L ${s * 0.5} ${s * 0.1} M ${-s * 0.35} ${s} L ${s * 0.35} ${s}` });
      break;
    case 'bowl':
      add('path', { d: `M ${-s} ${-s * 0.1} a ${s} ${s} 0 0 0 ${s * 2} 0 Z` });
      add('path', { d: `M ${-s * 0.4} ${-s * 0.8} L ${-s * 0.4} ${-s * 0.3} M ${s * 0.4} ${-s * 0.8} L ${s * 0.4} ${-s * 0.3}` });
      break;
    case 'tent':
      add('path', { d: `M ${-s} ${s * 0.7} L 0 ${-s * 0.8} L ${s} ${s * 0.7} Z` });
      add('path', { d: `M 0 ${-s * 0.8} L 0 ${s * 0.7}` });
      break;
    case 'gate':
      add('path', { d: `M ${-s * 0.8} ${s} L ${-s * 0.8} ${-s * 0.3} a ${s * 0.8} ${s * 0.8} 0 0 1 ${s * 1.6} 0 L ${s * 0.8} ${s}` });
      break;
    default:
      return null;
  }
  return g;
}

export function createMap(container, options = {}) {
  const { onNodeClick, onEdgeClick, interactive = true } = options;

  container.innerHTML = '';
  const svg = el('svg', {
    viewBox: `0 0 ${GROUND.width} ${GROUND.height}`,
    width: '100%',
    role: 'group',
    'aria-label': 'Map of the mela ground',
    class: 'map-svg',
    style: 'display:block;background:var(--map-bg);border-radius:14px;touch-action:manipulation',
  });
  container.appendChild(svg);

  const layers = {};
  for (const name of ['river', 'edges', 'route', 'nodes', 'pins', 'labels']) {
    layers[name] = el('g', { 'data-layer': name });
    svg.appendChild(layers[name]);
  }

  // The river is the one piece of permanent geography and the thing every
  // pilgrim orients by. It gets drawn first and never moves.
  layers.river.appendChild(
    el('path', {
      d: `M -20 44 C 180 16, 380 70, 520 40 C 680 6, 860 66, 1020 34 L 1020 -30 L -20 -30 Z`,
      fill: '#8FBFC4',
    })
  );
  layers.river.appendChild(
    el('path', {
      d: `M -20 44 C 180 16, 380 70, 520 40 C 680 6, 860 66, 1020 34`,
      fill: 'none',
      stroke: '#5E9AA2',
      'stroke-width': 3,
    })
  );
  const riverLabel = el('text', {
    x: 60, y: 30, fill: '#2C5F66', 'font-size': 17, 'font-style': 'italic', 'font-family': 'inherit',
  });
  riverLabel.textContent = 'Ganga';
  layers.river.appendChild(riverLabel);

  function render(view = {}) {
    const { flags = {}, routeResult = null, you = null, members = [], alerts = [], highlight = [] } = view;

    layers.edges.innerHTML = '';
    layers.route.innerHTML = '';
    layers.nodes.innerHTML = '';
    layers.pins.innerHTML = '';
    layers.labels.innerHTML = '';

    const routeEdgeIds = new Set((routeResult?.edges ?? []).map((e) => e.id));

    for (const edge of EDGES) {
      const a = NODE_BY_ID[edge.a];
      const b = NODE_BY_ID[edge.b];
      const level = levelFor(edge, flags);
      const line = el('line', {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        stroke: CROWD_COLOUR[level],
        'stroke-width': level === 1 ? 5 : level === 2 ? 7 : level === 3 ? 9 : 9,
        'stroke-linecap': 'round',
        'stroke-dasharray': level === 4 ? '3 11' : level === 3 ? '20 7' : null,
        opacity: routeEdgeIds.size && !routeEdgeIds.has(edge.id) ? 0.4 : 0.95,
        'data-edge': edge.id,
      });
      layers.edges.appendChild(line);

      if (interactive && onEdgeClick) {
        const hit = el('line', {
          x1: a.x, y1: a.y, x2: b.x, y2: b.y,
          stroke: 'transparent', 'stroke-width': 26,
          style: 'cursor:pointer', 'data-edge': edge.id,
        });
        hit.addEventListener('click', () => onEdgeClick(edge, level));
        const title = el('title');
        title.textContent = `${a.name.en} → ${b.name.en}: ${CROWD[level].en}`;
        hit.appendChild(title);
        layers.edges.appendChild(hit);
      }
    }

    if (routeResult?.path?.length > 1) {
      const points = routeResult.path.map((id) => `${NODE_BY_ID[id].x},${NODE_BY_ID[id].y}`).join(' ');
      layers.route.appendChild(
        el('polyline', {
          points, fill: 'none', stroke: '#0F3B44', 'stroke-width': 14,
          'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.22,
        })
      );
      layers.route.appendChild(
        el('polyline', {
          points, fill: 'none', stroke: '#F2A03C', 'stroke-width': 6,
          'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        })
      );
    }

    const highlightSet = new Set(highlight);

    for (const node of NODES) {
      const style = TYPE_STYLE[node.type] ?? TYPE_STYLE.junction;
      const group = el('g', { style: interactive && onNodeClick ? 'cursor:pointer' : null });

      if (highlightSet.has(node.id)) {
        group.appendChild(el('circle', { cx: node.x, cy: node.y, r: style.r + 9, fill: '#F2A03C', opacity: 0.45 }));
      }

      group.appendChild(
        el('circle', {
          cx: node.x, cy: node.y, r: style.r,
          fill: style.fill, stroke: '#FDF6E9', 'stroke-width': node.type === 'junction' ? 2 : 3,
        })
      );

      if (style.glyph) {
        const glyph = glyphPath(style.glyph, node.x, node.y, style.r * 0.52);
        if (glyph) group.appendChild(glyph);
      }

      if (node.type !== 'junction') {
        const label = el('text', {
          x: node.x, y: node.y + style.r + 16,
          'text-anchor': 'middle', 'font-size': 15, 'font-weight': 600,
          fill: '#3C3227', 'font-family': 'inherit',
          stroke: '#F0E3CB', 'stroke-width': 4, 'paint-order': 'stroke',
        });
        label.textContent = placeName(node);
        layers.labels.appendChild(label);
      }

      if (onNodeClick && interactive && node.type !== 'junction') {
        // Reachable by keyboard and named for screen readers, not just a
        // coloured circle that only works with a mouse or finger.
        group.setAttribute('tabindex', '0');
        group.setAttribute('role', 'button');
        group.setAttribute('aria-label', placeName(node));
        group.setAttribute('class', 'map-node');
        group.addEventListener('click', () => onNodeClick(node));
        group.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNodeClick(node); }
        });
      } else if (onNodeClick && interactive) {
        group.addEventListener('click', () => onNodeClick(node));
      }
      layers.nodes.appendChild(group);
    }

    // Family members, labelled. A dot with no name is useless when three
    // relatives are on the ground at once.
    members.forEach((m, index) => {
      if (!m.nodeId) return;
      const node = NODE_BY_ID[m.nodeId];
      if (!node) return;
      const offset = ((index % 3) - 1) * 24;
      const x = node.x + offset;
      const y = node.y - 34;
      const pin = el('g');
      pin.appendChild(el('path', {
        d: `M ${x} ${y + 20} L ${x - 8} ${y + 6} L ${x + 8} ${y + 6} Z`, fill: '#0F3B44',
      }));
      pin.appendChild(el('circle', { cx: x, cy: y - 6, r: 15, fill: '#0F3B44', stroke: '#FDF6E9', 'stroke-width': 3 }));
      const initial = el('text', {
        x, y: y + 1, 'text-anchor': 'middle', 'font-size': 16, 'font-weight': 700,
        fill: '#FDF6E9', 'font-family': 'inherit',
      });
      initial.textContent = (m.label || '?').trim().charAt(0).toUpperCase();
      pin.appendChild(initial);
      layers.pins.appendChild(pin);
    });

    for (const alert of alerts) {
      if (!alert.nodeId) continue;
      const node = NODE_BY_ID[alert.nodeId];
      if (!node) continue;
      const pin = el('g');
      pin.appendChild(el('circle', {
        cx: node.x, cy: node.y - 30, r: 17,
        fill: alert.status === 'claimed' ? '#D9822B' : '#C02E22',
        stroke: '#FDF6E9', 'stroke-width': 3,
      }));
      const mark = el('text', {
        x: node.x, y: node.y - 23, 'text-anchor': 'middle',
        'font-size': 20, 'font-weight': 800, fill: '#fff', 'font-family': 'inherit',
      });
      mark.textContent = '!';
      pin.appendChild(mark);
      layers.pins.appendChild(pin);
    }

    if (you && NODE_BY_ID[you]) {
      const node = NODE_BY_ID[you];
      layers.pins.appendChild(el('circle', { cx: node.x, cy: node.y, r: 26, fill: '#F2A03C', opacity: 0.35 }));
      layers.pins.appendChild(el('circle', { cx: node.x, cy: node.y, r: 11, fill: '#F2A03C', stroke: '#0F3B44', 'stroke-width': 4 }));
    }
  }

  return { svg, render };
}

export function crowdLegendHTML(labels = CROWD) {
  return `
    <div class="legend">
      <span><i style="background:${CROWD_COLOUR[1]}"></i>${labels[1].hi} · ${labels[1].en}</span>
      <span><i style="background:${CROWD_COLOUR[2]}"></i>${labels[2].hi} · ${labels[2].en}</span>
      <span><i style="background:${CROWD_COLOUR[3]}"></i>${labels[3].hi} · ${labels[3].en}</span>
      <span><i style="background:${CROWD_COLOUR[4]}"></i>${labels[4].hi} · ${labels[4].en}</span>
    </div>`;
}
