/**
 * A volunteer's own page: the tasks the control room has given them.
 *
 * Volunteers no longer pick from the whole queue — the control room assigns
 * each alert to one person (admin/queue.js). This page shows only what is
 * yours, with the same live map and turn-by-turn guidance as the pilgrim app,
 * a notification the moment a task arrives, notices, and the wristband lookup
 * for the child someone brings you.
 */

import { request, setSession, getToken, getUser, clearSession, onStateChange, state } from '/shared/api.js';
import { NODES, NODE_BY_ID, CROWD, nodeLatLng, nearestNode } from '/shared/mela-map.js';
import { route, directions } from '/shared/routing.js';
import { crowdLegendHTML } from '/shared/mapview.js';
import { createMapSwitch } from '/shared/mapswitch.js';
import { createLocator } from '/shared/location.js';
import { createGuide, spokenMetres, planFrom } from '/shared/guidance.js';
import { esc, initial, connectLive, debounce, toast, ago, buzz } from '/shared/dom.js';
import { icon } from '/shared/icons.js';
import { mountThemeSwitch } from '/shared/theme.js';

mountThemeSwitch(document.getElementById('theme-switch'));
document.querySelectorAll('[data-icon]').forEach((el) => el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon, { size: 20 })));

const $ = (s) => document.querySelector(s);

const KIND_ICON = { lost_person: 'family', lost_self: 'user', medical: 'medical', crowd_crush: 'crowd', other: 'info' };
const KIND_LABEL = {
  lost_person: 'Someone is missing',
  lost_self: 'Pilgrim is lost',
  medical: 'Medical',
  crowd_crush: 'Dangerous crowd',
  other: 'Other',
  board: 'Task for all volunteers',
};
const SKILL_LABEL = { medical: 'Medical', first_aid: 'First aid', child_care: 'Child protection', women_safety: "Women's safety", general: 'General' };

/** Assigned tasks are held while this page is open; it renews them. */
const HEARTBEAT_MS = 3 * 60_000;

const view = {
  tasks: [],
  flags: {},
  from: localStorage.getItem('km.vol.from') || 'police_1',
  selected: null,
  pending: false,
  loadedOnce: false,
  seen: new Set(),
  fresh: new Set(),
  busy: new Set(),
  lastSync: null,
  live: false,
  gps: null,
  gpsStatus: 'off',
  guide: null,
  guideFor: null,
  guideProgress: null,
  lastSpoken: '',
};
let map = null;
let locator = null;

const active = () => view.tasks.filter((t) => t.status === 'claimed');

/* ------------------------------------------------------------ sign-in --- */

const goLogin = (reason = '') => location.replace(`/volunteer/login.html${reason ? `?${reason}=1` : ''}`);

/** Volunteers only. Offline, the last known volunteer stays — a dead spot must not sign anyone out mid-task. */
async function ensureSignedIn() {
  if (!getToken()) { goLogin(); return null; }
  try {
    const { user } = await request('/api/auth/me');
    if (user.role !== 'volunteer') { clearSession(); goLogin(); return null; }
    setSession(getToken(), user);
    return user;
  } catch (err) {
    if (err.offline && getUser()) return getUser();
    clearSession();
    goLogin('expired');
    return null;
  }
}

async function signOut() {
  if (active().length && !confirm('You still have a task. If you sign out it stays yours until it times out. Sign out anyway?')) return;
  try { await request('/api/auth/logout', { method: 'POST' }); } catch { /* ends here anyway */ }
  clearSession();
  goLogin('signedout');
}

/* --------------------------------------------------------------- boot --- */

async function boot() {
  const me = await ensureSignedIn();
  if (!me) return;
  window.addEventListener('km:unauthorised', () => { clearSession(); goLogin('expired'); });

  $('#me-chip').innerHTML = `<span class="me-avatar">${initial(me.displayName)}</span><span class="me-name">${esc(me.displayName)}</span>`;
  $('#me-chip').title = me.displayName;
  $('#sign-out').innerHTML = `${icon('logout', { size: 18 })}<span>Sign out</span>`;
  $('#sign-out').onclick = signOut;
  setPending(me.status === 'pending');
  setupNotifications();

  const where = $('#where');
  where.innerHTML = NODES.filter((n) => n.type !== 'junction')
    .map((n) => `<option value="${n.id}">I am at ${esc(n.name.en)}</option>`).join('');
  if (!NODE_BY_ID[view.from] || NODE_BY_ID[view.from].type === 'junction') view.from = 'police_1';
  where.value = view.from;
  where.onchange = () => { stopGps(); setFrom(where.value); };

  map = createMapSwitch({
    toolbar: $('#map-toolbar'),
    live: $('#map-live'),
    simple: $('#map-simple'),
    note: $('#map-note'),
    storageKey: 'km.vol.map',
    onNodeClick: (node) => { stopGps(); setFrom(node.id); },
  });
  $('#vol-locate').onclick = () => (locator?.mode === 'gps' ? stopGps() : startGps());
  $('#legend').innerHTML = crowdLegendHTML(CROWD);

  $('#band-go').onclick = lookupBand;
  const band = $('#band-code');
  band.oninput = () => { band.value = band.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); };
  band.onkeydown = (e) => { if (e.key === 'Enter') lookupBand(); };

  $('#chat-send').onclick = sendChat;
  $('#chat-thread').addEventListener('pointerdown', markRead);
  $('#chat-input').addEventListener('focus', markRead);
  $('#chat-input').onkeydown = (e) => { if (e.key === 'Enter') sendChat(); };

  $('#sound').onclick = () => { unlockAudio(); ping(); renderSound(); };
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  renderSound();
  onStateChange(renderConnection);

  await refresh();
  refreshComms();
  connectRealtime();
  setInterval(refresh, 10_000);
  setInterval(heartbeat, HEARTBEAT_MS);
  setInterval(renderConnection, 5000);
}

function setFrom(nodeId) {
  view.from = nodeId;
  if (NODE_BY_ID[nodeId]?.type !== 'junction') $('#where').value = nodeId;
  localStorage.setItem('km.vol.from', nodeId);
  // The control room sees roughly where each volunteer is, to pick who goes.
  request('/api/auth/me', { method: 'PATCH', body: { nodeId } }).catch(() => {});
  refresh();
}

/* ------------------------------------------------------------ pending --- */

/**
 * A registered volunteer waits for approval with the map, crowd and notices;
 * tasks (which carry children's details) come once the control room says yes.
 */
function setPending(pending) {
  view.pending = pending;
  document.body.classList.toggle('is-pending', pending);
  const box = $('#pending-panel');
  box.hidden = !pending;
  if (pending) {
    box.innerHTML = `
      <span class="pending-icon">${icon('clock', { size: 26 })}</span>
      <span><b>Waiting for the control room to approve you</b>
      You can already use the live map, see crowded areas and read notices.
      Tasks appear here by themselves once you are approved — no need to sign in again.</span>`;
  }
}

async function checkApproval() {
  try {
    const { user } = await request('/api/auth/me');
    if (user.status !== 'pending') {
      setSession(getToken(), user);
      setPending(false);
      toast('You are approved. The control room can now give you tasks.');
      await refresh();
    }
  } catch { /* handled elsewhere */ }
}

/* ------------------------------------------------------------- data ----- */

async function refreshNotices() {
  try {
    const { notices } = await request('/api/content/notices');
    $('#vol-notices').innerHTML = notices.length
      ? notices.map((n) => `
          <div class="notice" data-severity="${esc(n.severity)}" style="margin-bottom:8px">
            ${n.severity !== 'info' ? `<span class="notice-label">${esc(n.severity)}</span>` : ''}
            ${esc(n.body?.en || n.body?.hi)}
            ${n.body?.hi && n.body.hi !== n.body.en ? `<span style="display:block;font-size:14px;opacity:.8" lang="hi">${esc(n.body.hi)}</span>` : ''}
          </div>`).join('')
      : '<p style="color:var(--ash);margin:0">No notices right now.</p>';
  } catch { /* keep the last ones */ }
}

async function refresh() {
  refreshNotices();
  try { view.flags = (await request('/api/map/flags')).flags; } catch { /* keep */ }
  if (view.pending) {
    view.lastSync = Date.now();
    render();
    checkApproval();
    return;
  }
  try {
    const { tasks } = await request(`/api/sos/tasks?from=${encodeURIComponent(view.from)}`);
    view.tasks = tasks;
    view.lastSync = Date.now();
    noticeNewTasks();
  } catch (err) {
    if (err.data?.error === 'pending') setPending(true);
    // Otherwise keep the last tasks on screen: a volunteer in a dead spot
    // still needs to see where they were going.
  }
  render();
}

/** A task that was not here a moment ago: sound, buzz, notification, and select it. */
function noticeNewTasks() {
  const firstLoad = !view.loadedOnce;
  view.loadedOnce = true;
  for (const t of active()) {
    if (view.seen.has(t.id)) continue;
    view.seen.add(t.id);
    if (firstLoad) continue;
    view.fresh.add(t.id);
    setTimeout(() => { view.fresh.delete(t.id); render(); }, 20_000);
    view.selected = t.id;
    ping();
    notifyTask(t);
    toast(`New task: ${KIND_LABEL[t.kind] ?? 'help needed'} at ${t.place?.en ?? 'unknown place'}.`, { ms: 6000 });
  }
  if (!view.tasks.some((t) => t.id === view.selected && t.status === 'claimed')) view.selected = active()[0]?.id ?? null;
  const n = active().length;
  document.title = `${n ? `(${n}) ` : ''}My tasks — Kumbh-a-Mitra volunteer`;
}

async function heartbeat() {
  const mine = active();
  await Promise.all(mine.map((t) => request(`/api/sos/${t.id}/heartbeat`, { method: 'POST' }).catch(() => {})));
}

function connectRealtime() {
  const soon = debounce(refresh, 250);
  const comms = debounce(refreshComms, 250);
  connectLive(['sos', 'flags', 'notices', 'staff', 'messages', 'board'], (msg) => {
    if (msg.type === 'staff') { if (view.pending) checkApproval(); return; }
    if (msg.type === 'messages' || msg.type === 'board') { comms(); return; }
    soon();
  }, {
    onStatus: (connected) => { view.live = connected; renderConnection(); if (connected) soon(); },
  });
}

/* ------------------------------------------------------------ render ---- */

function renderConnection() {
  const ok = state.online && view.live;
  $('#net-dot').dataset.state = ok ? 'online' : 'offline';
  $('#net-dot').setAttribute('aria-label', ok ? 'Live' : 'Reconnecting');
  $('#sync-status').textContent = ok ? `Live · updated ${ago(view.lastSync)}` : `Reconnecting · last update ${ago(view.lastSync)}`;
}

function render() {
  const now = active();
  const done = view.tasks.filter((t) => t.status === 'resolved');
  $('#task-count').hidden = !now.length;
  $('#task-count').textContent = String(now.length);

  $('#tasks').innerHTML = view.pending ? '' : now.length
    ? now.map(taskCard).join('')
    : `<div class="empty task-empty">${icon('check', { size: 30 })}<strong>No task right now</strong>
        The control room will give you one when someone needs help near you. Keep this page open —
        ${'Notification' in window && Notification.permission === 'granted' ? 'you will get a notification.' : 'turn on alerts above to get a notification.'}</div>`;

  $('#done').innerHTML = done.length && !view.pending
    ? `<details class="panel"><summary><b>Finished today (${done.length})</b></summary>
        ${done.slice(0, 10).map((t) => `
          <div class="member">
            <span class="pip" style="background:var(--tulsi)">✓</span>
            <span class="who"><b>${esc(KIND_LABEL[t.kind] ?? t.kind)} — ${esc(t.place?.en ?? 'unknown')}</b>
            <span>${t.resolvedAt ? new Date(t.resolvedAt).toLocaleTimeString() : ''}</span></span>
          </div>`).join('')}
      </details>` : '';

  $('#tasks').querySelectorAll('[data-action]').forEach((b) => { b.onclick = () => act(b.dataset.id, b.dataset.action, b); });
  $('#tasks').querySelectorAll('[data-select]').forEach((b) => {
    b.onclick = () => {
      view.selected = b.dataset.select;
      view.boardTarget = null;
      render();
      if (window.matchMedia('(max-width: 900px)').matches) document.querySelector('.map-frame').scrollIntoView({ behavior: 'smooth' });
    };
  });

  const selected = now.find((t) => t.id === view.selected);
  // An SOS task comes first; otherwise the board task the volunteer picked.
  const target = selected?.nodeId ?? view.boardTarget ?? null;
  map.render({
    flags: view.flags,
    you: view.from,
    gps: view.gps,
    alerts: now,
    routeResult: target ? route(view.from, target, { flags: view.flags }) : null,
    highlight: target ? [target] : [],
    following: Boolean(view.guide),
  });
  updateGuide();
  renderDetail(selected ?? (view.boardTarget ? { kind: 'board', nodeId: view.boardTarget, place: NODE_BY_ID[view.boardTarget]?.name } : null));
  renderConnection();
}

function taskCard(t) {
  const place = t.place?.en ?? 'Place unknown';
  const busy = view.busy.has(t.id) ? 'disabled' : '';
  const since = Math.max(0, Math.round((Date.now() - Date.parse(t.assignedAt ?? t.claimedAt)) / 60000));
  const needed = (t.neededSkills ?? []).map((s) => SKILL_LABEL[s] ?? s).join(' or ');
  return `
    <article class="queue-item task-card ${view.fresh.has(t.id) ? 'is-new' : ''} ${view.selected === t.id ? 'is-selected' : ''}" data-kind="${esc(t.kind)}" data-status="claimed">
      <h3 class="queue-title"><span class="kind-icon" data-kind="${esc(t.kind)}">${icon(KIND_ICON[t.kind] ?? 'info', { size: 20 })}</span>${esc(KIND_LABEL[t.kind] ?? t.kind)}${view.fresh.has(t.id) ? ' <span class="new-tag">New</span>' : ''}</h3>
      <div class="facts">
        <b>${esc(place)}</b>${t.walkMinutes != null ? ` · <b>${t.walkMinutes} min</b> walk` : ''} · given ${since} min ago
      </div>
      ${t.subjectLabel ? `<p style="margin:7px 0 0"><b>${esc(t.subjectLabel)}</b></p>` : ''}
      ${t.note ? `<p style="margin:5px 0 0">${esc(t.note)}</p>` : ''}
      ${needed ? `<p style="margin:6px 0 0;font-size:14px;color:var(--ash)">Best with: ${esc(needed)}</p>` : ''}
      <p style="margin:6px 0 0;font-size:15px">Raised by ${esc(t.raiserName)}${t.raiserPhone ? ` · <a href="tel:${esc(t.raiserPhone)}">${esc(t.raiserPhone)}</a>` : ' · no phone number'}</p>
      ${t.beacon ? `<p style="margin:7px 0 0;font-size:15px"><span class="swatch" style="background:${esc(t.beacon.hex)}"></span>
        Look for a <b>${esc(t.beacon.name.en.toLowerCase())}</b> screen held up, and listen for a two-note tone.</p>` : ''}
      <div class="row">
        <button class="btn" data-select="${esc(t.id)}" aria-pressed="${view.selected === t.id}">${icon('navigate', { size: 18 })} Show the way</button>
        <button class="btn" data-action="beacon" data-id="${esc(t.id)}" ${busy}>${t.beacon ? 'Light again' : 'Light their screen'}</button>
        <button class="btn" data-action="release" data-id="${esc(t.id)}" ${busy}>Can't go</button>
        <button class="btn btn-done" data-action="resolve" data-id="${esc(t.id)}" ${busy}>Found / helped</button>
      </div>
    </article>`;
}

function renderDetail(t) {
  const box = $('#detail');
  if (!t) {
    box.innerHTML = `<p style="color:var(--ash);margin:0">When the control room gives you a task, the way there appears here.</p>`;
    return;
  }
  const r = t.nodeId ? route(view.from, t.nodeId, { flags: view.flags }) : null;
  const steps = r?.ok ? directions(r, 'en') : [];
  const p = t.nodeId ? nodeLatLng(t.nodeId) : null;
  box.innerHTML = `
    <h2>${esc(KIND_LABEL[t.kind] ?? t.kind)} — ${esc(t.place?.en ?? 'unknown place')}</h2>
    ${r?.ok ? `<p style="margin:0 0 8px"><b>${r.metres} m · ${r.minutes} min</b>${r.worst >= 3 ? ' — goes through a heavy crowd; no clearer way' : ''}</p>` : ''}
    ${r && !r.ok ? `<p style="margin:0 0 8px;color:var(--closed);font-weight:650">Every path there is closed. Ask the control room.</p>` : ''}
    ${steps.length ? `<ol style="padding-left:20px;margin:0 0 12px">${steps.map((s) => `<li>${esc(s.turn)} — ${esc(s.target)} (${s.metres} m)</li>`).join('')}</ol>` : ''}
    ${p ? `<p style="margin:0"><a class="btn btn-sm" target="_blank" rel="noopener"
      href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=walking">Open in Google Maps ↗</a>
      <span style="font-size:13px;color:var(--ash)"> Google does not know about closed paths or crowds.</span></p>` : ''}`;
}

async function act(id, action, button) {
  if (action === 'resolve' && !confirm('Mark this person as found / helped? The task will close.')) return;
  if (action === 'release' && !confirm('Hand this task back to the control room so they can send someone else?')) return;
  view.busy.add(id);
  if (button) button.disabled = true;
  try {
    const data = await request(`/api/sos/${id}/${action}`, { method: 'POST', body: action === 'resolve' ? { resolution: 'helped_in_person' } : {} });
    if (action === 'beacon' && data.beacon) toast(`Their screen is now ${data.beacon.name.en.toLowerCase()}. Look for it held up high.`);
    if (action === 'resolve') toast('Well done. The family and the control room can see it is closed.');
    if (action === 'release') toast('Handed back. The control room will send someone else.');
  } catch (err) {
    toast(err.data?.message ?? (err.offline ? 'No connection. Try again in a moment.' : 'That did not go through. Try again.'), { tone: 'warn', ms: 4500 });
  } finally {
    view.busy.delete(id);
  }
  refresh();
}

/* ---------------------------------------- messages and the task board --- */

/**
 * What the control room sends this volunteer: one-to-one messages (with a
 * reply box) and the board of jobs for every volunteer. Anything new makes
 * the same sound, buzz and notification as a task.
 */
async function refreshComms() {
  if (view.pending) return;
  try {
    const [{ messages, unread }, { tasks }] = await Promise.all([request('/api/messages'), request('/api/messages/board')]);
    const firstLoad = view.chat == null;
    const newMessages = firstLoad ? [] : messages.filter((m) => m.from === 'control' && !view.chat.some((x) => x.id === m.id));
    const newBoard = view.board == null ? [] : tasks.filter((t) => t.status === 'open' && !view.board.some((x) => x.id === t.id));
    view.chat = messages;
    view.unread = unread;
    view.board = tasks;
    renderChat();
    renderBoard();
    for (const m of newMessages) {
      ping();
      toast(`Message from the control room: ${m.text}`, { ms: 7000 });
      notify('Message from the control room', m.text, `msg-${m.id}`);
    }
    for (const t of newBoard) {
      ping();
      toast(`New task for all volunteers: ${t.title}`, { ms: 6000 });
      notify('New task for all volunteers', t.title, `job-${t.id}`);
    }
  } catch { /* pending, offline: keep what is shown */ }
}

function renderChat() {
  const box = $('#chat-thread');
  const list = view.chat ?? [];
  box.innerHTML = list.length
    ? list.map((m) => `
        <div class="chat-msg" data-from="${m.from === 'volunteer' ? 'me' : 'them'}">
          <span class="chat-bubble">${esc(m.text)}</span>
          <span class="chat-meta">${m.from === 'control' ? `Control room · ${esc(m.authorName)}` : 'You'} · ${new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>`).join('')
    : '<p style="color:var(--ash);margin:0">No messages yet. The control room can write to you here.</p>';
  box.scrollTop = box.scrollHeight;
  $('#msg-count').hidden = !view.unread;
  $('#msg-count').textContent = view.unread ? `${view.unread} new` : '';
}

/** Reading the thread (looking at it, or replying) marks it read for the control room. */
async function markRead() {
  if (!view.unread) return;
  view.unread = 0;
  renderChat();
  try { await request('/api/messages/read', { method: 'POST' }); } catch { /* next time */ }
}

async function sendChat() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  $('#chat-send').disabled = true;
  try {
    await request('/api/messages', { method: 'POST', body: { text } });
    input.value = '';
    await markRead();
    await refreshComms();
  } catch (err) {
    toast(err.data?.message ?? 'Not sent. Check the connection.', { tone: 'warn' });
  } finally {
    $('#chat-send').disabled = false;
  }
}

function renderBoard() {
  const me = getUser()?.id;
  const tasks = view.board ?? [];
  const open = tasks.filter((t) => t.status === 'open');
  $('#board-count').hidden = !open.length;
  $('#board-count').textContent = String(open.length);
  const box = $('#board-list');
  box.innerHTML = tasks.length
    ? tasks.map((t) => {
      const helping = t.helpers.some((h) => h.id === me);
      return `
        <div class="board-item" data-status="${esc(t.status)}" data-helping="${helping}">
          <div class="board-head">
            <b>${esc(t.title)}</b>
            <span class="chip" data-tone="${t.status === 'done' ? 'resolved' : t.helpers.length >= t.needed ? 'resolved' : 'queued'}" style="font-size:12px">${t.status === 'done' ? 'done' : `${t.helpers.length} of ${t.needed} helping`}</span>
          </div>
          ${t.detail ? `<p class="board-detail">${esc(t.detail)}</p>` : ''}
          <p class="board-meta">${t.place ? `${esc(t.place.en)} · ` : ''}${t.helpers.length ? esc(t.helpers.map((h) => (h.id === me ? 'you' : h.name)).join(', ')) : 'nobody yet'}</p>
          ${t.status === 'open' ? `<div class="board-actions">
            ${t.nodeId ? `<button class="btn btn-sm" data-board-way="${esc(t.nodeId)}">${icon('navigate', { size: 16 })} Show the way</button>` : ''}
            <button class="btn btn-sm ${helping ? '' : 'btn-go'}" data-board-help="${esc(t.id)}">${helping ? "I can't now" : "I'll help"}</button>
          </div>` : ''}
        </div>`;
    }).join('')
    : '<p style="color:var(--ash);margin:0">No tasks for everyone right now.</p>';
  box.querySelectorAll('[data-board-help]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const { helping } = await request(`/api/messages/board/${b.dataset.boardHelp}/help`, { method: 'POST' });
        toast(helping ? 'Thanks — the control room can see you are helping.' : 'Okay, you are off this task.');
      } catch (err) { toast(err.data?.message ?? 'That did not go through.', { tone: 'warn' }); }
      refreshComms();
    };
  });
  box.querySelectorAll('[data-board-way]').forEach((b) => {
    b.onclick = () => {
      view.selected = null;
      view.boardTarget = b.dataset.boardWay;
      render();
      document.querySelector('.map-frame').scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
  });
}

function notify(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const options = { body, tag, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: '/volunteer/' } };
  try {
    if (swReg?.showNotification) swReg.showNotification(title, options);
    else new Notification(title, options);
  } catch { /* the toast and sound still work */ }
}

/* ------------------------------------------------------- band lookup ---- */

async function lookupBand() {
  const input = $('#band-code');
  const box = $('#band-result');
  const code = input.value.trim().toUpperCase();
  if (code.length !== 6) {
    box.innerHTML = `<p style="color:var(--ash);margin:10px 0 0">The code on the band has six characters.</p>`;
    input.focus();
    return;
  }
  box.innerHTML = `<p style="color:var(--ash);margin:10px 0 0">Looking up ${esc(code)}…</p>`;
  try {
    const data = await request('/api/groups/band/lookup', { method: 'POST', body: { code } });
    const sharing = data.members.filter((m) => m.nodeId);
    box.innerHTML = `
      <div style="margin-top:12px;border-top:1px solid var(--line);padding-top:12px">
        <p style="margin:0 0 8px"><b>${esc(data.group.name)}</b> · band ${esc(data.group.joinCode)}</p>
        ${sharing.length ? sharing.map((m) => `
          <div class="member">
            <span class="pip">${initial(m.label)}</span>
            <span class="who"><b>${esc(m.label)}</b><span>${m.place ? esc(m.place.en) : 'place unknown'}</span></span>
            <button class="btn btn-sm" data-band-goto="${esc(m.nodeId)}">Show route</button>
          </div>`).join('') : `<p style="color:var(--ash);margin:0">Nobody in this group is sharing a location right now.</p>`}
        ${data.meetingPoint ? `<p style="margin:10px 0 0;font-size:15px">Their agreed meeting point is <b>${esc(data.meetingPoint.name.en)}</b>.</p>` : ''}
        <div class="field" style="margin-top:12px;flex-wrap:wrap">
          <input id="band-desc" maxlength="120" aria-label="Who do you have?" placeholder="Who do you have? e.g. boy, ~8, red shirt" style="min-width:200px">
          <button class="btn btn-done" id="band-found">I have them — tell the family</button>
        </div>
      </div>`;
    box.querySelectorAll('[data-band-goto]').forEach((b) => {
      b.onclick = () => {
        const target = b.dataset.bandGoto;
        map.render({ flags: view.flags, you: view.from, gps: view.gps, routeResult: route(view.from, target, { flags: view.flags }), highlight: [target] });
        document.querySelector('.map-frame').scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
    });
    $('#band-found').onclick = async () => {
      $('#band-found').disabled = true;
      try {
        await request('/api/groups/band/found', { method: 'POST', body: { code, nodeId: view.from, describe: $('#band-desc').value.trim() } });
        box.innerHTML = `<p style="margin:12px 0 0;color:var(--tulsi);font-weight:650" role="status">Family notified. Stay where you are until they arrive.</p>`;
        input.value = '';
      } catch {
        $('#band-found').disabled = false;
        toast('Could not notify the family — check the connection and try again.', { tone: 'warn' });
      }
    };
  } catch (err) {
    box.innerHTML = `<p style="margin:10px 0 0;color:var(--closed)" role="alert">
      ${err.status === 404 ? 'No group has that code. Check the band again — letters like O, I and S are never used.' : err.data?.error === 'pending' ? 'Available once the control room approves you.' : 'Lookup failed. Check the connection.'}</p>`;
  }
}

/* -------------------------------------------------------------- GPS ----- */

/** Your position stays on this phone; only the nearest landmark is shared with the control room. */
function startGps() {
  locator ??= createLocator({
    onFix(fix) {
      view.gps = fix;
      const near = nearestNode(fix.lat, fix.lng);
      if (near && near.metres < 150 && near.node.id !== view.from) setFrom(near.node.id);
      map.live?.updateYou(fix, view.from);
      updateGuide();
      const next = view.guideProgress?.nextId;
      if (view.guide && next && !view.guideProgress.arrived) map.live?.follow(fix, 17.5, nodeLatLng(next));
      renderGps();
    },
    onStatus(status) {
      view.gpsStatus = status;
      if (['outside', 'denied', 'unavailable'].includes(status)) { view.gps = null; map.live?.updateYou(null, view.from); }
      renderGps();
    },
  });
  locator.startGps();
  renderGps();
}

function stopGps() {
  if (locator?.mode !== 'gps') return;
  locator.stop();
  Object.assign(view, { gps: null, gpsStatus: 'off', guide: null });
  map.live?.updateYou(null, view.from);
  renderGps();
  renderGuide(null);
}

function renderGps() {
  const on = locator?.mode === 'gps';
  $('#vol-locate').setAttribute('aria-pressed', String(on));
  $('#vol-locate').textContent = on ? 'GPS on' : 'My location';
  const text = {
    locating: 'Finding your location…',
    gps: view.gps ? `Location found · ±${Math.round(view.gps.accuracy)} m` : '',
    outside: 'You are not at the mela ground — set where you are by hand.',
    denied: 'Location permission is off — set where you are by hand.',
    unavailable: 'Could not get your location — set where you are by hand.',
  }[view.gpsStatus] ?? '';
  const box = $('#vol-gps');
  box.textContent = text;
  box.dataset.tone = ['outside', 'denied', 'unavailable'].includes(view.gpsStatus) ? 'warn' : 'info';
  box.classList.toggle('hidden', !text);
}

/** Turn-by-turn to the selected task while GPS is on; re-planned when you stray or a path closes. */
function updateGuide() {
  const t = active().find((x) => x.id === view.selected);
  if (!view.gps || view.gpsStatus !== 'gps' || !t?.nodeId) {
    Object.assign(view, { guide: null, guideFor: null });
    renderGuide(null);
    return;
  }
  const plan = planFrom(view.gps.lat, view.gps.lng, t.nodeId, { flags: view.flags });
  const planned = plan?.result ?? { ok: false, path: [] };
  const rest = view.guide?.path.join('>') ?? '';
  if (!view.guide || view.guideFor !== t.id || !rest.endsWith(planned.path.join('>'))) {
    view.guide = planned.ok ? createGuide(planned, 'en', { origin: view.gps }) : null;
    view.guideFor = t.id;
    view.lastSpoken = '';
  }
  if (!view.guide) { renderGuide({ text: 'Every path there is closed. Ask the control room.', angle: null }); return; }
  const p = view.guide.update(view.gps);
  view.guideProgress = p;
  if (p.offRoute) { view.guide = planned.ok ? createGuide(planned, 'en', { origin: view.gps }) : null; view.lastSpoken = ''; }
  if (p.stepKey !== view.lastSpoken) {
    view.lastSpoken = p.stepKey;
    if (audio?.state === 'running') speak(p.text);
  }
  renderGuide(p);
}

function renderGuide(p) {
  const box = $('#vol-guide');
  if (!p) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const turn = p.angle != null && !p.arrived ? `transform:rotate(${p.angle}deg)` : '';
  box.innerHTML = `
    <div class="nav-arrow" style="${turn}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${p.arrived ? 'M6 21V4h10l-1.5 3.5L16 11H8v10z' : 'M12 2.5 19 10h-4.5v11.5h-5V10H5z'}"/></svg>
    </div>
    <div class="nav-text">
      ${p.toNextMetres != null && !p.arrived ? `<b>${spokenMetres(p.toNextMetres)} m</b>` : ''}
      <span>${esc(p.text)}</span>
      ${p.remainingMetres != null && !p.arrived ? `<span class="nav-sub">${p.remainingMetres} m to the task · about ${p.minutesLeft} min</span>` : ''}
    </div>`;
}

function speak(text) {
  try {
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-IN';
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch { /* voice is a bonus */ }
}

/* ----------------------------------------------------- notifications ---- */

let swReg = null;
function setupNotifications() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').then((r) => { swReg = r; }).catch(() => {});
  const button = $('#notify');
  const renderButton = () => {
    if (!('Notification' in window)) { button.hidden = true; return; }
    const p = Notification.permission;
    button.innerHTML = `${icon(p === 'granted' ? 'bellOn' : 'bell', { size: 18 })}<span>${p === 'granted' ? 'Alerts on' : p === 'denied' ? 'Alerts blocked' : 'Turn on alerts'}</span>`;
    button.setAttribute('aria-pressed', String(p === 'granted'));
    button.title = p === 'denied' ? 'Notifications are blocked for this site in your browser settings.' : 'Get a notification when you are given a task';
  };
  button.onclick = async () => {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') await Notification.requestPermission();
    unlockAudio();
    renderButton();
    render();
    if (Notification.permission === 'granted') toast('You will be notified the moment you are given a task (keep this page open).');
  };
  renderButton();
}

function notifyTask(t) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const options = {
    body: [t.place?.en ?? 'Place unknown', t.walkMinutes != null ? `${t.walkMinutes} min walk` : null, t.subjectLabel].filter(Boolean).join(' · '),
    tag: `task-${t.id}`,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    requireInteraction: true,
    data: { url: '/volunteer/' },
  };
  try {
    if (swReg?.showNotification) swReg.showNotification(`New task: ${KIND_LABEL[t.kind] ?? 'Help needed'}`, options);
    else new Notification(`New task: ${KIND_LABEL[t.kind] ?? 'Help needed'}`, options);
  } catch { /* the sound and the card still work */ }
}

/* ------------------------------------------------------------ sound ----- */

let audio = null;
function unlockAudio() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch { /* no audio */ }
  renderSound();
}

function renderSound() {
  const on = audio?.state === 'running';
  $('#sound').textContent = on ? 'Sound on' : 'Turn on sound';
  $('#sound').setAttribute('aria-pressed', String(on));
}

function ping() {
  try {
    if (!audio || audio.state !== 'running') return;
    const now = audio.currentTime;
    [0, 0.18].forEach((offset, i) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.connect(gain); gain.connect(audio.destination);
      osc.frequency.value = i ? 1175 : 880;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.25, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.35);
      osc.start(now + offset); osc.stop(now + offset + 0.36);
    });
  } catch { /* needs a gesture */ }
  buzz(300);
}

boot();
