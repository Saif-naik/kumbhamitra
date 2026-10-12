import { request, setSession, getToken, getUser, clearSession, onStateChange, state } from '/shared/api.js';
import { EDGES, NODES, NODE_BY_ID, CROWD } from '/shared/mela-map.js';
import { crowdLegendHTML } from '/shared/mapview.js';
import { createMapSwitch } from '/shared/mapswitch.js';
import { esc, initial, connectLive, debounce, toast, ago } from '/shared/dom.js';
import { icon } from '/shared/icons.js';
import { mountThemeSwitch } from '/shared/theme.js';

mountThemeSwitch(document.getElementById('theme-switch'));

document.querySelectorAll('[data-icon]').forEach((el) => el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon, { size: 20 })));

const $ = (s) => document.querySelector(s);

const view = {
  flags: {}, alerts: [], selectedEdge: null, pressure: [], warnings: [], roster: [], notices: [],
  lastSync: null, live: false,
};

const RISK = [
  { label: 'Calm', colour: 'var(--tulsi)' },
  { label: 'Filling', colour: 'var(--busy)' },
  { label: 'Warning', colour: 'var(--heavy)' },
  { label: 'Critical', colour: 'var(--closed-surface)' },
];
let map = null;

const LEVELS = [
  [1, 'Clear', 'var(--clear)'],
  [2, 'Busy', 'var(--busy)'],
  [3, 'Very heavy', 'var(--heavy)'],
  [4, 'Closed', 'var(--closed-surface)'],
];

const KIND_LABEL = {
  lost_person: 'Someone is missing',
  lost_self: 'Pilgrim is lost',
  medical: 'Medical',
  crowd_crush: 'Dangerous crowd',
  other: 'Other',
};
const URGENCY = { crowd_crush: 0, medical: 1, lost_person: 2, lost_self: 3, other: 4 };

const edgeName = (edge) => `${NODE_BY_ID[edge.a].name.en} → ${NODE_BY_ID[edge.b].name.en}`;

const goLogin = (reason = '') => location.replace(`/admin/login.html${reason ? `?${reason}=1` : ''}`);

/** Admins only. Anyone else is sent to the sign-in page (which needs the security key). */
async function ensureAdmin() {
  if (!getToken()) { goLogin(); return null; }
  try {
    const { user } = await request('/api/auth/me');
    if (user.role !== 'admin') { clearSession(); goLogin(); return null; }
    setSession(getToken(), user);
    return user;
  } catch (err) {
    if (err.offline && getUser()?.role === 'admin') return getUser();
    clearSession();
    goLogin('expired');
    return null;
  }
}

async function signOut() {
  try { await request('/api/auth/logout', { method: 'POST' }); } catch { /* ends here anyway */ }
  clearSession();
  goLogin('signedout');
}

async function boot() {
  const me = await ensureAdmin();
  if (!me) return;
  window.addEventListener('km:unauthorised', () => { clearSession(); goLogin('expired'); });
  $('#me-chip').innerHTML = `<span class="me-avatar">${initial(me.displayName)}</span><span class="me-name">${esc(me.displayName)}</span>`;
  $('#sign-out').innerHTML = `${icon('logout', { size: 18 })}<span>Sign out</span>`;
  $('#sign-out').onclick = signOut;

  map = createMapSwitch({
    toolbar: $('#map-toolbar'),
    live: $('#map-live'),
    simple: $('#map-simple'),
    note: $('#map-note'),
    storageKey: 'km.admin.map',
    onEdgeClick: (edge, level) => {
      view.selectedEdge = { edge, level };
      render();
      $('#edge-controls').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
  });
  $('#legend').innerHTML = crowdLegendHTML(CROWD);

  $('#notice-send').onclick = sendNotice;
  for (const id of ['notice-hi', 'notice-mr', 'notice-en']) {
    $(`#${id}`).addEventListener('input', renderNoticeCount);
    $(`#${id}`).addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendNotice(); });
  }
  renderNoticeCount();

  const simNode = $('#sim-node');
  simNode.innerHTML = NODES.filter((n) => n.type !== 'junction')
    .map((n) => `<option value="${n.id}">${esc(n.name.en)}</option>`).join('');
  simNode.value = 'ghat_sangam';
  $('#sim-go').onclick = async () => {
    try {
      await request('/api/crowd/simulate', { method: 'POST', body: { nodeId: simNode.value, people: 2400 } });
      toast(`Simulated crowd arriving at ${NODE_BY_ID[simNode.value].name.en} (demo data).`);
      refresh();
    } catch { toast('Could not run the simulation.', { tone: 'warn' }); }
  };
  $('#sim-clear').onclick = async () => {
    try { await request('/api/crowd/clear', { method: 'POST' }); refresh(); } catch { toast('Could not clear.', { tone: 'warn' }); }
  };
  onStateChange(renderConnection);
  const tick = () => { $('#clock').textContent = new Date().toLocaleTimeString(); renderConnection(); };
  tick();
  setInterval(tick, 1000);

  await refresh();
  connectRealtime();
  setInterval(refresh, 10_000);
}

async function refresh() {
  try {
    const [flags, queue, pressure, roster, notices] = await Promise.all([
      request('/api/map/flags'),
      request('/api/sos?status=open,claimed'),
      request('/api/crowd/pressure'),
      request('/api/sos/volunteers'),
      request('/api/content/notices'),
    ]);
    view.flags = flags.flags;
    view.alerts = queue.alerts;
    view.pressure = pressure.pressure;
    view.warnings = pressure.pressure.filter((p) => p.risk >= 2)
      .sort((a, b) => b.risk - a.risk || (a.minutesToCritical ?? 999) - (b.minutesToCritical ?? 999));
    view.roster = roster.volunteers;
    view.notices = notices.notices;
    view.lastSync = Date.now();
  } catch { /* keep the last picture */ }
  render();
}

function renderConnection() {
  const ok = state.online && view.live;
  $('#net-dot').dataset.state = ok ? 'online' : 'offline';
  $('#net-dot').setAttribute('aria-label', ok ? 'Live' : 'Reconnecting');
  $('#sync-status').textContent = ok ? `Live · updated ${ago(view.lastSync)}` : `Reconnecting · last update ${ago(view.lastSync)}`;
}

function render() {
  const open = view.alerts.filter((a) => a.status === 'open');
  const flagged = Object.entries(view.flags);
  const closed = flagged.filter(([, f]) => f.level === 4).length;
  const heavy = flagged.filter(([, f]) => f.level === 3).length;
  const critical = view.warnings.filter((w) => w.risk >= 3);

  $('#stats').innerHTML = `
    <div class="stat ${open.length ? 'stat-alert' : ''}"><span class="stat-icon">${icon('bell')}</span><b>${open.length}</b><span>alerts waiting</span></div>
    <div class="stat"><span class="stat-icon">${icon('route')}</span><b>${view.alerts.length - open.length}</b><span>being handled</span></div>
    <div class="stat"><span class="stat-icon">${icon('crowd')}</span><b>${heavy}</b><span>paths very heavy</span></div>
    <div class="stat"><span class="stat-icon">${icon('flag')}</span><b>${closed}</b><span>paths closed</span></div>
    <div class="stat ${view.warnings.length ? 'stat-warn' : ''}"><span class="stat-icon">${icon('warning')}</span><b>${view.warnings.length}</b><span>crush warnings</span></div>
    <div class="stat"><span class="stat-icon">${icon('family')}</span><b>${view.roster.filter((v) => !v.busy).length}/${view.roster.length}</b><span>volunteers free</span></div>`;

  // One line across the top for the thing that cannot wait.
  $('#critical-bar').classList.toggle('hidden', !critical.length);
  $('#critical-bar').innerHTML = critical.length
    ? `<b>Critical crowd:</b> ${critical.map((w) => esc(NODE_BY_ID[w.nodeId]?.name.en ?? w.nodeId)).join(', ')} — close an approach now.`
    : '';

  renderCrush();

  map.render({
    flags: view.flags,
    alerts: view.alerts,
    highlight: view.warnings.map((w) => w.nodeId),
    // Live map only: crowd pressure circles and where each volunteer is.
    pressure: view.pressure,
    volunteers: view.roster,
    selectedEdge: view.selectedEdge?.edge.id ?? null,
  });

  // The control room sees everything ranked by urgency alone, then by wait.
  const ranked = view.alerts.slice().sort((a, b) =>
    (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1)
    || (URGENCY[a.kind] ?? 9) - (URGENCY[b.kind] ?? 9)
    || a.receivedAt.localeCompare(b.receivedAt));

  $('#alerts').innerHTML = ranked.length
    ? ranked.slice(0, 10).map((a) => {
        const waited = Math.max(0, Math.round((Date.now() - new Date(a.receivedAt)) / 60000));
        return `
        <div class="member">
          <span class="pip" style="background:${a.status === 'open' ? 'var(--vermilion)' : 'var(--marigold-deep)'}">!</span>
          <span class="who">
            <b>${esc(KIND_LABEL[a.kind] ?? a.kind)} — ${esc(a.place?.en ?? 'unknown')}</b>
            <span>${a.status === 'open' ? `<b class="stale">waiting ${waited} min</b>` : `with ${esc(a.claimerName)}`}
              ${a.subjectLabel ? ` · ${esc(a.subjectLabel)}` : ''}${a.meshHops ? ` · via ${a.meshHops} phone${a.meshHops > 1 ? 's' : ''} (tower down?)` : ''}</span>
          </span>
        </div>`;
      }).join('') + (ranked.length > 10 ? `<p style="color:var(--ash);margin:8px 0 0">and ${ranked.length - 10} more…</p>` : '')
    : `<p style="color:var(--ash);margin:0">Nothing open.</p>`;

  $('#flag-list').innerHTML = flagged.length
    ? flagged.map(([edgeId, f]) => {
        const edge = EDGES.find((e) => e.id === edgeId);
        if (!edge) return '';
        return `<div class="member">
          <span class="pip" style="background:${LEVELS[f.level - 1][2]};font-size:14px">${f.level}</span>
          <span class="who"><b>${esc(edgeName(edge))}</b><span>${LEVELS[f.level - 1][1]} · set ${new Date(f.at).toLocaleTimeString()}</span></span>
          <button class="btn btn-sm" data-clear="${esc(edgeId)}" title="Back to its normal crowding">Reset</button>
        </div>`;
      }).join('')
    : `<p style="color:var(--ash);margin:0">No paths flagged. The map is showing baseline crowding only.</p>`;

  $('#flag-list').querySelectorAll('[data-clear]').forEach((b) => {
    b.onclick = () => clearFlag(b.dataset.clear);
  });

  renderNotices();
  renderEdgeControls();
}

/**
 * Which path to shut when a landmark is filling.
 *
 * The main approach is the path from a junction (where the crowd is coming
 * from), not, say, the riverbank walk between two ghats. Prefer paths that
 * are open, lead in from a junction, and are busy by default.
 */
function approachFor(nodeId) {
  return EDGES
    .filter((e) => e.a === nodeId || e.b === nodeId)
    .filter((e) => (view.flags[e.id]?.level ?? 0) < 4)
    .map((e) => {
      const other = NODE_BY_ID[e.a === nodeId ? e.b : e.a];
      return { edge: e, score: (other.type === 'junction' ? 10 : 0) + e.base };
    })
    .sort((a, b) => b.score - a.score)[0]?.edge ?? null;
}

/**
 * The crush list.
 *
 * Ordered so the thing that will go wrong soonest is at the top, and each row
 * carries the one action that actually helps: shut the approach. A warning with
 * no button next to it is a warning nobody acts on at four in the morning.
 */
function renderCrush() {
  const box = $('#crush-list');
  if (!box) return;

  const rows = view.pressure
    .filter((p) => p.risk >= 1 && p.count > 0)
    .sort((a, b) => b.risk - a.risk || b.load - a.load)
    .slice(0, 6);

  if (!rows.length) {
    box.innerHTML = `<p style="color:var(--ash);margin:0">
      No pressure anywhere. Numbers appear here as phones report which landmark they are near.</p>`;
    return;
  }

  box.innerHTML = rows.map((p) => {
    const node = NODE_BY_ID[p.nodeId];
    const risk = RISK[p.risk];
    const approach = p.risk >= 2 ? approachFor(p.nodeId) : null;
    const pct = Math.min(100, Math.round(p.load * 100));
    return `
      <div class="member" style="align-items:flex-start">
        <span class="pip" style="background:${risk.colour};font-size:12px" aria-label="${pct}% full">${pct}</span>
        <span class="who">
          <b>${esc(node?.name.en ?? p.nodeId)} — ${risk.label}</b>
          <span class="meter" aria-hidden="true"><i style="width:${pct}%;background:${risk.colour}"></i></span>
          <span>
            about ${p.count} people, ${p.capacity} is the limit
            ${p.trend > 0 ? ` · rising ${p.trend}/min` : p.trend < 0 ? ` · easing ${-p.trend}/min` : ' · steady'}
            ${p.minutesToCritical != null ? ` · <b>packed in ~${p.minutesToCritical} min</b>` : ''}
          </span>
        </span>
        ${approach
          ? `<button class="btn btn-sm" data-close-approach="${approach.id}" title="Close ${esc(edgeName(approach))}">
               Close approach<span class="btn-sub">${esc(NODE_BY_ID[approach.a === p.nodeId ? approach.b : approach.a].name.en)} side</span>
             </button>`
          : ''}
      </div>`;
  }).join('');

  box.querySelectorAll('[data-close-approach]').forEach((b) => {
    b.onclick = () => setLevel(b.dataset.closeApproach, 4);
  });
}

function renderEdgeControls() {
  const box = $('#edge-controls');
  if (!view.selectedEdge) {
    box.innerHTML = `<p style="color:var(--ash);margin:0">No path selected. Click any coloured path on the map.</p>`;
    return;
  }
  const { edge } = view.selectedEdge;
  const flagged = view.flags[edge.id];
  const current = flagged?.level ?? edge.base;
  box.innerHTML = `
    <p style="margin:0 0 4px;font-size:18px"><b>${esc(edgeName(edge))}</b></p>
    <p style="margin:0 0 10px;font-size:14px;color:var(--ash)">
      Normally ${LEVELS[edge.base - 1][1].toLowerCase()}${flagged ? ` · now set to ${LEVELS[flagged.level - 1][1].toLowerCase()}` : ''}
    </p>
    <div style="display:flex;gap:8px;flex-wrap:wrap" role="group" aria-label="Crowd level">
      ${LEVELS.map(([level, label, colour]) => `
        <button class="btn" data-level="${level}" aria-pressed="${current === level}"
          style="${current === level ? `background:${colour};color:#fff;border-color:${colour}` : ''}">
          ${label}
        </button>`).join('')}
      ${flagged ? `<button class="btn btn-quiet" id="edge-reset">Back to normal</button>` : ''}
    </div>`;
  box.querySelectorAll('[data-level]').forEach((b) => {
    b.onclick = () => setLevel(edge.id, Number(b.dataset.level));
  });
  $('#edge-reset')?.addEventListener('click', () => clearFlag(edge.id));
}

async function setLevel(edgeId, level) {
  try {
    await request(`/api/map/flags/${edgeId}`, { method: 'PUT', body: { level } });
    view.flags[edgeId] = { level, at: new Date().toISOString() };
    const edge = EDGES.find((e) => e.id === edgeId);
    if (level === 4) toast(`${edgeName(edge)} closed. Phones are re-routing.`);
    render();
  } catch {
    toast('Could not save that. Check the server is running.', { tone: 'warn' });
  }
}

/** Remove a flag so the path returns to its normal crowding, not to "clear". */
async function clearFlag(edgeId) {
  try {
    await request(`/api/map/flags/${edgeId}`, { method: 'DELETE' });
    delete view.flags[edgeId];
    render();
  } catch {
    toast('Could not reset that path.', { tone: 'warn' });
  }
}

function renderNoticeCount() {
  const longest = Math.max(...['notice-hi', 'notice-mr', 'notice-en'].map((id) => $(`#${id}`).value.length));
  $('#notice-count').textContent = `${longest}/280`;
  $('#notice-count').classList.toggle('stale', longest > 240);
}

async function sendNotice() {
  const hi = $('#notice-hi').value.trim();
  const mr = $('#notice-mr').value.trim();
  const en = $('#notice-en').value.trim();
  const severity = $('#notice-severity').value;
  if (!hi && !mr && !en) {
    toast('Write the notice in at least one language.');
    $('#notice-hi').focus();
    return;
  }
  if (severity === 'urgent' && !confirm('Send as URGENT to every phone on the ground?')) return;
  const button = $('#notice-send');
  button.disabled = true;
  try {
    await request('/api/content/notices', { method: 'POST', body: { severity, body: { hi, mr, en } } });
    for (const id of ['notice-hi', 'notice-mr', 'notice-en']) $(`#${id}`).value = '';
    renderNoticeCount();
    toast('Notice sent.');
    refresh();
  } catch {
    toast('Notice not sent. Check the server is running.', { tone: 'warn' });
  } finally {
    button.disabled = false;
  }
}

function renderNotices() {
  const box = $('#notice-list');
  box.innerHTML = view.notices.length
    ? view.notices.map((n) => `
        <div class="notice" data-severity="${esc(n.severity)}" style="display:flex;gap:10px;align-items:flex-start;margin-bottom:8px">
          <span style="flex:1;min-width:0">
            ${n.severity !== 'info' ? `<span class="notice-label">${esc(n.severity)}</span>` : ''}
            ${esc(n.body?.en || n.body?.hi)}
            ${n.body?.hi && n.body.hi !== n.body.en ? `<span style="display:block;font-size:14px;opacity:.8">${esc(n.body.hi)}</span>` : ''}
          </span>
          <button class="btn btn-sm" data-withdraw="${esc(n.id)}">Withdraw</button>
        </div>`).join('')
    : `<p style="color:var(--ash);margin:0">No live notices.</p>`;
  box.querySelectorAll('[data-withdraw]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Withdraw this notice from every phone?')) return;
      try {
        await request(`/api/content/notices/${b.dataset.withdraw}`, { method: 'DELETE' });
        refresh();
      } catch { toast('Could not withdraw it.', { tone: 'warn' }); }
    };
  });
}

function connectRealtime() {
  // Several changes often land together (an alert claimed, a flag set); one
  // refresh covers them all.
  const soon = debounce(refresh, 300);
  connectLive(['sos', 'flags', 'notices', 'crowd', 'staff'], (msg) => {
    if (msg.type === 'staff' && msg.payload?.event === 'volunteer_registered') toast('New volunteer registration — approve it in the Volunteer queue.');
    soon();
  }, {
    onStatus: (connected) => { view.live = connected; renderConnection(); if (connected) soon(); },
  });
}

boot();
