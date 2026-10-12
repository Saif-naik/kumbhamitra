import { request, setSession, getToken, getUser, clearSession, onStateChange, state } from '/shared/api.js';
import { NODES, NODE_BY_ID, nodeLatLng } from '/shared/mela-map.js';
import { route } from '/shared/routing.js';
import { esc, initial, connectLive, debounce, toast, ago, buzz } from '/shared/dom.js';
import { icon } from '/shared/icons.js';
import { mountThemeSwitch } from '/shared/theme.js';

mountThemeSwitch(document.getElementById('theme-switch'));

const KIND_ICON = { lost_person: 'family', lost_self: 'user', medical: 'medical', crowd_crush: 'crowd', other: 'info' };
document.querySelectorAll('[data-icon]').forEach((el) => el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon, { size: 20 })));

const $ = (s) => document.querySelector(s);

const view = {
  alerts: [],
  flags: {},
  from: localStorage.getItem('km.queue.from') || 'j_c',
  selected: null,
  roster: [],
  me: null,
  lastSync: null,
  live: false,
  seen: new Set(),
  fresh: new Set(),
  busy: new Set(),
  gps: null,          // this volunteer's live position (stays on the device)
  gpsStatus: 'off',
  guide: null,        // turn-by-turn to the selected alert, when GPS is on
  guideFor: null,
  lastSpoken: '',
};

const SKILL_LABEL = {
  medical: 'Medical',
  first_aid: 'First aid',
  child_care: 'Child protection',
  women_safety: "Women's safety",
  general: 'General',
};

const LANGUAGE_LABEL = { hi: 'Hindi', mr: 'Marathi', en: 'English', ur: 'Urdu', bho: 'Bhojpuri', ta: 'Tamil', pa: 'Punjabi' };


const KIND_LABEL = {
  lost_person: 'Someone is missing',
  lost_self: 'Pilgrim is lost',
  medical: 'Medical',
  crowd_crush: 'Dangerous crowd',
  other: 'Other',
};

/** How often an open claim is renewed while this console is on the job. */
const CLAIM_HEARTBEAT_MS = 3 * 60_000;

/**
 * The dispatch queue belongs to the control room: only admins get past here.
 * Volunteers see only their own tasks, on /volunteer/.
 */
const goLogin = (reason = '') => location.replace(`/admin/login.html${reason ? `?${reason}=1` : ''}`);

async function ensureSignedIn() {
  if (!getToken()) { goLogin(); return null; }
  try {
    const { user } = await request('/api/auth/me');
    if (user.role !== 'admin') { clearSession(); goLogin(); return null; }
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
  try { await request('/api/auth/logout', { method: 'POST' }); } catch { /* the session ends here anyway */ }
  clearSession();
  goLogin('signedout');
}

async function boot() {
  const me = await ensureSignedIn();
  if (!me) return;
  window.addEventListener('km:unauthorised', () => { clearSession(); goLogin('expired'); });

  $('#me-chip').innerHTML = `<span class="me-avatar">${initial(me.displayName)}</span><span class="me-name">${esc(me.displayName)}${me.role === 'admin' ? ' · admin' : ''}</span>`;
  document.body.classList.add('admin-view');
  $('#me-chip').title = me.displayName;
  $('#sign-out').innerHTML = `${icon('logout', { size: 18 })}<span>Sign out</span>`;
  $('#sign-out').onclick = signOut;
  if (me.nodeId && NODE_BY_ID[me.nodeId] && !localStorage.getItem('km.queue.from')) view.from = me.nodeId;
  setupNotifications();

  const where = $('#where');
  where.innerHTML = NODES.filter((n) => n.type !== 'junction')
    .map((n) => `<option value="${n.id}">I am at ${esc(n.name.en)}</option>`)
    .join('');
  if (!NODE_BY_ID[view.from] || NODE_BY_ID[view.from].type === 'junction') view.from = 'police_1';
  where.value = view.from;
  where.onchange = () => setFrom(where.value);


  onStateChange(renderConnection);

  // Tasks for every volunteer.
  $('#board-place').innerHTML = '<option value="">Anywhere</option>' + NODES.filter((n) => n.type !== 'junction')
    .map((n) => `<option value="${n.id}">${esc(n.name.en)}</option>`).join('');
  $('#board-post').onclick = postBoardTask;
  $('#board-title').onkeydown = (e) => { if (e.key === 'Enter') postBoardTask(); };
  // One-to-one messages.
  $('#chat-send').onclick = sendChat;
  $('#chat-input').onkeydown = (e) => { if (e.key === 'Enter') sendChat(); };

  // Browsers only allow sound after a tap. Make the first tap anywhere count,
  // and offer an explicit button so the volunteer knows the tone is on.
  $('#sound').onclick = () => { unlockAudio(); ping(); renderSound(); };
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  renderSound();

  await refresh();
  refreshComms();
  connectRealtime();
  setInterval(refresh, 10_000); // polling backs up the socket, never the reverse
  setInterval(heartbeatClaims, CLAIM_HEARTBEAT_MS);
  setInterval(renderConnection, 5000);
}

function setFrom(nodeId) {
  view.from = nodeId;
  $('#where').value = NODE_BY_ID[nodeId]?.type === 'junction' ? $('#where').value : nodeId;
  localStorage.setItem('km.queue.from', nodeId);
  refresh();
}

/* ------------------------------------------------- talking to volunteers */

/** Unread replies per volunteer, the open thread, and the task board. */
async function refreshComms() {
  try {
    const [{ unread }, { tasks }] = await Promise.all([request('/api/messages'), request('/api/messages/board')]);
    view.unread = unread;
    view.board = tasks;
    renderBoard();
    if (view.chatWith) await loadChat();
    renderRoster();
  } catch { /* keep what is on screen */ }
}

function openChat(id) {
  view.chatWith = id;
  $('#chat-panel').hidden = false;
  loadChat();
  $('#chat-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => $('#chat-input').focus(), 300);
}

async function loadChat() {
  const v = view.roster.find((x) => x.id === view.chatWith);
  $('#chat-title').textContent = v ? `Messages with ${v.displayName}` : 'Messages';
  try {
    const { messages } = await request(`/api/messages?with=${encodeURIComponent(view.chatWith)}`);
    view.chat = messages;
    renderChat();
    if (view.unread?.[view.chatWith]) {
      await request('/api/messages/read', { method: 'POST', body: { with: view.chatWith } });
      view.unread[view.chatWith] = 0;
      renderRoster();
    }
  } catch { /* keep */ }
}

function renderChat() {
  const box = $('#chat-thread');
  box.innerHTML = view.chat?.length
    ? view.chat.map((m) => `
        <div class="chat-msg" data-from="${m.from === 'control' ? 'me' : 'them'}">
          <span class="chat-bubble">${esc(m.text)}</span>
          <span class="chat-meta">${m.from === 'control' ? esc(m.authorName) : 'Volunteer'} · ${new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${m.from === 'control' && m.readAt ? ' · seen' : ''}</span>
        </div>`).join('')
    : '<p style="color:var(--ash);margin:0">No messages yet. Write the first one below — it arrives on their page with a notification.</p>';
  box.scrollTop = box.scrollHeight;
}

async function sendChat() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text || !view.chatWith) return;
  $('#chat-send').disabled = true;
  try {
    await request('/api/messages', { method: 'POST', body: { to: view.chatWith, text } });
    input.value = '';
    await loadChat();
  } catch (err) {
    toast(err.data?.message ?? 'Message not sent. Check the connection.', { tone: 'warn' });
  } finally {
    $('#chat-send').disabled = false;
  }
}

function renderBoard() {
  const box = $('#board-list');
  const tasks = view.board ?? [];
  box.innerHTML = tasks.length
    ? tasks.map((t) => `
        <div class="board-item" data-status="${esc(t.status)}">
          <div class="board-head">
            <b>${esc(t.title)}</b>
            <span class="chip" data-tone="${t.status === 'done' ? 'resolved' : t.helpers.length >= t.needed ? 'resolved' : 'queued'}" style="font-size:12px">${t.status === 'done' ? 'done' : `${t.helpers.length} of ${t.needed} helping`}</span>
          </div>
          ${t.detail ? `<p class="board-detail">${esc(t.detail)}</p>` : ''}
          <p class="board-meta">${t.place ? `${esc(t.place.en)} · ` : ''}posted ${new Date(t.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${t.helpers.length ? ` · ${esc(t.helpers.map((h) => h.name).join(', '))}` : ''}</p>
          ${t.status === 'open' ? `<div class="board-actions">
            <button class="btn btn-sm btn-done" data-board-done="${esc(t.id)}">Mark done</button>
            <button class="btn btn-sm" data-board-remove="${esc(t.id)}">Remove</button>
          </div>` : ''}
        </div>`).join('')
    : '<p style="color:var(--ash);margin:0">No tasks posted.</p>';
  box.querySelectorAll('[data-board-done]').forEach((b) => { b.onclick = () => boardAction(b.dataset.boardDone, 'done'); });
  box.querySelectorAll('[data-board-remove]').forEach((b) => { b.onclick = () => boardAction(b.dataset.boardRemove, 'remove'); });
}

async function postBoardTask() {
  const title = $('#board-title').value.trim();
  if (!title) { $('#board-title').focus(); return; }
  $('#board-post').disabled = true;
  try {
    await request('/api/messages/board', {
      method: 'POST',
      body: { title, detail: $('#board-detail').value.trim(), nodeId: $('#board-place').value, needed: Number($('#board-needed').value) || 1 },
    });
    $('#board-title').value = '';
    $('#board-detail').value = '';
    $('#board-needed').value = '1';
    toast('Posted. Every volunteer can see it now.');
    refreshComms();
  } catch (err) {
    toast(err.data?.message ?? 'Not posted. Check the connection.', { tone: 'warn' });
  } finally {
    $('#board-post').disabled = false;
  }
}

async function boardAction(id, action) {
  if (action === 'remove' && !confirm('Remove this task for everyone?')) return;
  try {
    if (action === 'done') await request(`/api/messages/board/${id}/done`, { method: 'POST' });
    else await request(`/api/messages/board/${id}`, { method: 'DELETE' });
  } catch { toast('That did not go through.', { tone: 'warn' }); }
  refreshComms();
}

async function refresh() {
  try {
    const [queue, flags, roster, team] = await Promise.all([
      request(`/api/sos?from=${encodeURIComponent(view.from)}&status=open,claimed,resolved`),
      request('/api/map/flags'),
      request('/api/sos/volunteers'),
      request('/api/staff/volunteers'),
    ]);
    view.team = team.volunteers;
    view.alerts = queue.alerts;
    view.flags = flags.flags;
    view.me = queue.you;
    view.roster = roster.volunteers;
    view.lastSync = Date.now();
    noticeNewAlerts();
  } catch {
    // Keep the last queue on screen. A volunteer in a dead spot still needs to
    // see the alert they were already walking to.
  }
  render();
}

/** Mark alerts that arrived since the last look, and say so in the tab title. */
function noticeNewAlerts() {
  // "First load" means the first successful fetch, not "nothing seen yet":
  // a volunteer who opens an empty queue must still hear about the first alert.
  const firstLoad = !view.loadedOnce;
  view.loadedOnce = true;
  for (const a of view.alerts) {
    if (!view.seen.has(a.id)) {
      view.seen.add(a.id);
      if (!firstLoad && a.status === 'open') {
        view.fresh.add(a.id);
        setTimeout(() => { view.fresh.delete(a.id); render(); }, 15_000);
        notifyAlert(a);
      }
    }
  }
  const waiting = view.alerts.filter((a) => a.status === 'open').length;
  document.title = `${waiting ? `(${waiting}) ` : ''}Volunteer queue — Control room`;
}

/**
 * Keep my claims alive while this console is open.
 *
 * Claims expire after ten minutes so a volunteer who walks away from their
 * phone does not strand an alert. But a volunteer who is still on the job,
 * console open, must not lose it mid-rescue — so the console renews every
 * claim it holds. Close the console and the claim lapses as designed.
 */
async function heartbeatClaims() {
  const mine = view.alerts.filter((a) => a.status === 'claimed' && a.claimedBy === getUser()?.id);
  await Promise.all(mine.map((a) => request(`/api/sos/${a.id}/heartbeat`, { method: 'POST' }).catch(() => {})));
  if (mine.length) refresh();
}

function renderConnection() {
  const dot = $('#net-dot');
  const status = $('#sync-status');
  const ok = state.online && view.live;
  dot.dataset.state = state.online ? (view.live ? 'online' : 'offline') : 'offline';
  dot.setAttribute('aria-label', ok ? 'Live' : 'Reconnecting');
  status.textContent = ok ? `Live · updated ${ago(view.lastSync)}` : `Reconnecting · last update ${ago(view.lastSync)}`;
}

function render() {
  const open = view.alerts.filter((a) => a.status === 'open');
  const claimed = view.alerts.filter((a) => a.status === 'claimed');
  const mine = claimed.filter((a) => a.claimedBy === getUser()?.id);
  const resolved = view.alerts
    .filter((a) => a.status === 'resolved')
    .sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''));
  const today = new Date().toDateString();
  const resolvedToday = resolved.filter((a) => a.resolvedAt && new Date(a.resolvedAt).toDateString() === today);

  $('#stats').innerHTML = `
    <div class="stat ${open.length ? 'stat-alert' : ''}"><span class="stat-icon">${icon('bell')}</span><b>${open.length}</b><span>waiting</span></div>
    <div class="stat"><span class="stat-icon">${icon('route')}</span><b>${claimed.length}</b><span>being handled</span></div>
    <div class="stat"><span class="stat-icon">${icon('user')}</span><b>${view.roster.filter((v) => !v.busy).length}</b><span>volunteers free</span></div>
    <div class="stat"><span class="stat-icon">${icon('check')}</span><b>${resolvedToday.length}</b><span>resolved today</span></div>`;

  const live = [...mine, ...open, ...claimed.filter((a) => !mine.includes(a))];
  $('#queue').innerHTML = live.length
    ? live.map(card).join('')
    : `<div class="empty"><strong>Nothing waiting</strong>Alerts appear here the moment someone presses the red button.</div>`;

  $('#resolved').innerHTML = resolved.length
    ? `<details class="panel"><summary><b>Recently resolved (${resolved.length})</b></summary>
        ${resolved.slice(0, 8).map((a) => `
          <div class="member">
            <span class="pip" style="background:var(--tulsi)">✓</span>
            <span class="who"><b>${esc(KIND_LABEL[a.kind] ?? a.kind)} — ${esc(a.place?.en ?? 'unknown')}</b>
            <span>${esc(a.resolution?.replace(/_/g, ' ') ?? 'resolved')} · ${a.resolvedAt ? new Date(a.resolvedAt).toLocaleTimeString() : ''}</span></span>
          </div>`).join('')}
      </details>`
    : '';

  $('#queue').querySelectorAll('[data-action]').forEach((b) => {
    b.onclick = () => act(b.dataset.id, b.dataset.action, b);
  });
  $('#queue').querySelectorAll('[data-assign]').forEach((b) => {
    b.onclick = () => assign(b.dataset.assign, b);
  });
  $('#queue').querySelectorAll('[data-select]').forEach((b) => {
    b.onclick = () => {
      view.selected = view.selected === b.dataset.select ? null : b.dataset.select;
      render();
      if (view.selected && window.matchMedia('(max-width: 900px)').matches) $('#detail').scrollIntoView({ behavior: 'smooth' });
    };
  });


  renderDetail();
  renderRoster();
  renderTeam();
  renderConnection();
}

/**
 * The roster exists so a volunteer can hand a job to the right person instead
 * of taking one they are not trained for. It also makes the gap visible: if
 * nobody on duty has medical training and a medical alert is waiting, that is
 * a staffing decision someone needs to make now, not at the debrief.
 */
function renderRoster() {
  const box = $('#roster');
  if (!box) return;
  const free = view.roster.filter((v) => !v.busy).length;

  // Is any open alert waiting for a skill nobody free has?
  const freeSkills = new Set(view.roster.filter((v) => !v.busy).flatMap((v) => v.skills));
  const gaps = [...new Set(view.alerts
    .filter((a) => a.status === 'open')
    .filter((a) => !(a.neededSkills ?? []).some((s) => freeSkills.has(s)))
    .flatMap((a) => a.neededSkills ?? []))];

  box.innerHTML = `
    <p style="font-size:14px;color:var(--ash);margin:0 0 9px">
      ${free} of ${view.roster.length} free right now
    </p>
    ${gaps.length ? `<div class="notice" data-severity="warning" style="margin:0 0 10px;font-size:15px">
      <span class="notice-label">Staffing gap</span>
      An alert needs ${esc(gaps.map((s) => SKILL_LABEL[s] ?? s).join(' or '))} and nobody free has that training.
    </div>` : ''}
    ${view.roster.map((v) => `
      <div class="member">
        <span class="pip" style="background:${v.busy ? '#6B6257' : 'var(--tulsi-surface)'}">${initial(v.displayName)}</span>
        <span class="who">
          <b>${esc(v.displayName)}${v.id === getUser()?.id ? ' <span class="you-tag">you</span>' : ''}</b>
          <span>
            ${esc(v.skills.map((s) => SKILL_LABEL[s] ?? s).join(', '))}
            ${v.languages?.length ? ` · ${esc(v.languages.map((l) => LANGUAGE_LABEL[l] ?? l).join('/'))}` : ''}
            ${v.place ? ` · ${esc(v.place.en)}` : ''}
          </span>
        </span>
        <span class="chip" data-tone="${v.busy ? 'claimed' : 'resolved'}" style="font-size:12px">
          ${v.busy ? 'on a task' : 'free'}
        </span>
        <span class="member-actions">
          <button class="btn btn-sm" data-chat="${esc(v.id)}" aria-label="Message ${esc(v.displayName)}">${icon('chat', { size: 16 })}<span>Message</span>${view.unread?.[v.id] ? `<span class="unread-dot">${view.unread[v.id]}</span>` : ''}</button>
          ${v.phone
            ? `<a class="btn btn-sm" href="tel:${esc(v.phone)}" aria-label="Call ${esc(v.displayName)}">${icon('phone', { size: 16 })}<span>Call</span></a>`
            : `<span class="btn btn-sm is-disabled" title="This volunteer signed in with the security key and gave no number">${icon('phone', { size: 16 })}<span>No number</span></span>`}
        </span>
      </div>`).join('')}`;
  box.querySelectorAll('[data-chat]').forEach((b) => { b.onclick = () => openChat(b.dataset.chat); });
}

/**
 * Volunteer approvals. Someone who registers cannot log in until an admin
 * approves them here; approved volunteers can be disabled (signed out at
 * once) and enabled again.
 */
const TEAM_SKILL = { medical: 'Medical', first_aid: 'First aid', child_care: 'Child protection', women_safety: "Women's safety", general: 'General' };
function renderTeam() {
  const box = $('#team');
  const team = view.team ?? [];
  const pending = team.filter((v) => v.status === 'pending');
  $('#team-count').textContent = pending.length ? `${pending.length} waiting` : '';
  $('#team-count').hidden = !pending.length;
  const row = (v) => {
    const actions = {
      pending: [['approve', 'Approve', 'btn-done'], ['reject', 'Reject', 'btn-quiet']],
      active: [['disable', 'Disable', 'btn-quiet']],
      disabled: [['enable', 'Enable', '']],
      rejected: [['approve', 'Approve', '']],
    }[v.status] ?? [];
    return `
      <div class="team-row" data-status="${esc(v.status)}">
        <span class="me-avatar">${initial(v.displayName)}</span>
        <span class="team-body">
          <b>${esc(v.displayName)} <span class="status-pill" data-status="${esc(v.status)}">${esc(v.status === 'pending' ? 'waiting' : v.status)}</span></b>
          <span>${esc((v.skills ?? []).map((s) => TEAM_SKILL[s] ?? s).join(', '))}${v.org ? ` · ${esc(v.org)}` : ''}${v.phone ? ` · ${esc(v.phone)}` : v.viaKey ? ' · signed in with the key' : ''}</span>
        </span>
        <span class="team-actions">${actions.map(([a, label, cls]) => `<button class="btn btn-sm ${cls}" data-team="${esc(v.id)}" data-action="${a}">${label}</button>`).join('')}</span>
      </div>`;
  };
  const others = team.filter((v) => v.status !== 'pending');
  box.innerHTML = team.length
    ? `<p class="team-sub">Waiting for approval</p>${pending.length ? pending.map(row).join('') : '<p style="color:var(--ash);margin:0 0 6px;font-size:14px">Nobody waiting.</p>'}
       <details class="team-all"><summary class="team-sub">All volunteers (${others.length})</summary>${others.map(row).join('')}</details>`
    : '<p style="color:var(--ash);margin:0">No volunteers yet.</p>';
  box.querySelectorAll('[data-team]').forEach((b) => {
    b.onclick = async () => {
      const action = b.dataset.action;
      if ((action === 'disable' || action === 'reject') && !confirm(`${action === 'disable' ? 'Disable' : 'Reject'} this volunteer? They will not be able to log in.`)) return;
      b.disabled = true;
      try {
        await request(`/api/staff/volunteers/${b.dataset.team}/${action}`, { method: 'POST' });
        toast({ approve: 'Approved — they can log in now.', reject: 'Request rejected.', disable: 'Disabled and signed out.', enable: 'Access restored.' }[action]);
        refresh();
      } catch (err) {
        b.disabled = false;
        toast(err.data?.message ?? 'That did not go through.', { tone: 'warn' });
      }
    };
  });
}

function claimMinutesLeft(alert) {
  if (!alert.claimExpiresAt) return null;
  return Math.max(0, Math.round((new Date(alert.claimExpiresAt) - Date.now()) / 60000));
}

/**
 * Who to send, best first: the right training, free, then the shortest walk
 * from where each volunteer last was.
 */
function rankVolunteers(alert) {
  const needed = alert.neededSkills ?? [];
  return view.roster.map((v) => {
    const r = v.nodeId && alert.nodeId ? route(v.nodeId, alert.nodeId, { flags: view.flags }) : null;
    return { ...v, walk: r?.ok ? r.minutes : null, fit: needed.some((s) => (v.skills ?? []).includes(s)) };
  }).sort((a, b) => (b.fit - a.fit) || (a.busy - b.busy) || ((a.walk ?? 999) - (b.walk ?? 999)));
}

function assignOptions(alert) {
  const ranked = rankVolunteers(alert);
  if (!ranked.length) return '<option value="">No volunteers on duty</option>';
  return ranked.map((v, i) => `<option value="${esc(v.id)}" ${(alert.claimedBy ? v.id === alert.claimedBy : i === 0) ? 'selected' : ''}>${esc(v.displayName)}${v.walk != null ? ` · ${v.walk} min away` : ''}${v.fit ? ' · trained ✓' : ''} · ${v.busy ? 'on a task' : 'free'}</option>`).join('');
}

async function assign(id, button) {
  const select = document.querySelector(`[data-assign-for="${id}"]`);
  const volunteerId = select?.value;
  if (!volunteerId) return;
  view.busy.add(id);
  button.disabled = true;
  try {
    const { alert } = await request(`/api/sos/${id}/assign`, { method: 'POST', body: { volunteerId } });
    toast(`Assigned to ${alert.claimerName}. It is on their task page now.`);
  } catch (err) {
    toast(err.data?.message ?? 'That did not go through. Try again.', { tone: 'warn' });
  } finally {
    view.busy.delete(id);
  }
  refresh();
}

function card(alert) {
  const isMine = alert.claimedBy === getUser()?.id;
  const place = alert.place ? alert.place.en : 'Place unknown';
  const waited = Math.max(0, Math.round((Date.now() - new Date(alert.receivedAt)) / 60000));
  const needed = (alert.neededSkills ?? []).map((s) => SKILL_LABEL[s] ?? s).join(' or ');
  const busy = view.busy.has(alert.id) ? 'disabled' : '';
  const left = isMine ? claimMinutesLeft(alert) : null;

  return `
    <article class="queue-item ${view.fresh.has(alert.id) ? 'is-new' : ''} ${view.selected === alert.id ? 'is-selected' : ''}"
             data-kind="${esc(alert.kind)}" data-status="${esc(alert.status)}" aria-label="${esc(KIND_LABEL[alert.kind] ?? alert.kind)} at ${esc(place)}">
      <h3 class="queue-title"><span class="kind-icon" data-kind="${esc(alert.kind)}">${icon(KIND_ICON[alert.kind] ?? 'info', { size: 20 })}</span>${esc(KIND_LABEL[alert.kind] ?? alert.kind)}${view.fresh.has(alert.id) ? ' <span class="new-tag">New</span>' : ''}</h3>
      <div class="facts">
        ${esc(place)} ·
        waiting ${waited} min
        ${alert.groupCode ? ` · band ${esc(alert.groupCode)}` : ''}
      </div>

      ${needed ? `<div style="margin-top:7px;display:flex;gap:5px;flex-wrap:wrap">
        <span class="chip" data-tone="queued" style="font-size:12.5px">
          Needs ${esc(needed)}
        </span>
        ${alert.raiserLanguage ? `<span class="chip" style="font-size:12.5px">Speaks ${esc(LANGUAGE_LABEL[alert.raiserLanguage] ?? alert.raiserLanguage)}</span>` : ''}
      </div>` : ''}

      ${alert.meshHops > 0 ? `<p style="margin:7px 0 0;font-size:14px;color:var(--river-mid)">
        Arrived via ${alert.meshHops} nearby phone${alert.meshHops > 1 ? 's' : ''} — this person had no signal.
      </p>` : ''}

      ${alert.subjectLabel ? `<p style="margin:7px 0 0"><b>${esc(alert.subjectLabel)}</b></p>` : ''}
      ${alert.note ? `<p style="margin:5px 0 0">${esc(alert.note)}</p>` : ''}
      ${alert.suspect ? `<p style="margin:6px 0 0;color:var(--marigold-deep)">Many alerts from this device — check before dispatching.</p>` : ''}

      ${alert.beacon ? `<p style="margin:7px 0 0;font-size:15px">
        <span class="swatch" style="background:${esc(alert.beacon.hex)}"></span>
        Look for a <b>${esc(alert.beacon.name.en.toLowerCase())}</b> screen held up, and listen for a two-note tone.
      </p>` : ''}

      ${left != null ? `<p class="claim-timer ${left <= 2 ? 'is-low' : ''}">
        Held for you for ${left} more min — kept alive while this screen is open.
      </p>` : ''}

      <div class="row">
        <span class="chip" data-tone="${esc(alert.status)}">${alert.status === 'open' ? 'Waiting — not assigned' : `Assigned to ${esc(alert.claimerName)}`}</span>
        <span style="flex:1"></span>
        <button class="btn" data-select="${esc(alert.id)}" aria-pressed="${view.selected === alert.id}">Details</button>
        ${alert.status === 'claimed' ? `<button class="btn" data-action="release" data-id="${esc(alert.id)}" ${busy}>Take back</button>` : ''}
      </div>
      <div class="assign-row">
        <label class="sr-only" for="assign-${esc(alert.id)}">Assign to</label>
        <select id="assign-${esc(alert.id)}" class="assign-select" data-assign-for="${esc(alert.id)}">${assignOptions(alert)}</select>
        <button class="btn btn-go" data-assign="${esc(alert.id)}" ${busy}>${alert.status === 'open' ? 'Assign' : 'Reassign'}</button>
      </div>
    </article>`;
}

function renderDetail() {
  const alert = view.alerts.find((a) => a.id === view.selected);
  const box = $('#detail');
  if (!alert) {
    box.innerHTML = `<p style="color:var(--ash);margin:0">Tap <b>Details</b> on an alert to see who raised it and its history.</p>`;
    return;
  }
  const holder = alert.claimedBy ? rankVolunteers(alert).find((v) => v.id === alert.claimedBy) : null;
  box.innerHTML = `
    <h2>${esc(KIND_LABEL[alert.kind] ?? alert.kind)} — ${esc(alert.place?.en ?? 'unknown place')}</h2>
    ${alert.nodeId ? googleLink(alert.nodeId) : ''}
    <p style="margin:0 0 6px">Raised by ${esc(alert.raiserName)}${alert.raiserPhone ? ` · <a href="tel:${esc(alert.raiserPhone)}">${esc(alert.raiserPhone)}</a>` : ' · guest, no phone'}</p>
    ${holder ? `<p style="margin:0 0 8px">Assigned to <b>${esc(holder.displayName)}</b>${holder.walk != null ? ` · about ${holder.walk} min away` : ''}${holder.phone ? ` · <a href="tel:${esc(holder.phone)}">call</a>` : ''}</p>` : '<p style="margin:0 0 8px;color:var(--marigold-deep);font-weight:650">Not assigned yet — pick a volunteer on the card.</p>'}
    <h2 style="font-size:16px">History</h2>
    <ul class="timeline">
      ${alert.timeline.map((e) => `<li><time>${new Date(e.at).toLocaleTimeString()}</time> ${esc(e.kind.replace(/_/g, ' '))}</li>`).join('')}
    </ul>`;
}

async function act(id, action, button) {
  if (action === 'release' && !confirm('Take this alert back from the volunteer? It goes back to waiting.')) return;
  view.busy.add(id);
  if (button) button.disabled = true;
  try {
    const data = await request(`/api/sos/${id}/${action}`, {
      method: 'POST',
      body: action === 'resolve' ? { resolution: 'helped_in_person' } : {},
    });
    if (action === 'beacon' && data.beacon) {
      toast(`Their screen is now ${data.beacon.name.en.toLowerCase()}. Look for it held up high.`);
    }
    if (action === 'claim') view.selected = id;
  } catch (err) {
    toast(err.data?.message ?? (err.offline
      ? 'No connection. It will update on the next refresh.'
      : 'That did not go through. Try again.'), { tone: 'warn', ms: 4500 });
  } finally {
    view.busy.delete(id);
  }
  refresh();
}

function connectRealtime() {
  const soon = debounce(refresh, 250);
  const comms = debounce(refreshComms, 250);
  connectLive(['sos', 'flags', 'staff', 'messages', 'board'], (msg) => {
    if (msg.type === 'staff') {
      if (msg.payload?.event === 'volunteer_registered') {
        ping();
        toast('New volunteer registration — approve or reject it under Volunteers.', { ms: 6000 });
      }
      soon();
      return;
    }
    if (msg.type === 'messages' || msg.type === 'board') { comms(); return; }
    if (msg.type === 'sos' && msg.payload?.event === 'created') ping();
    soon();
  }, {
    onStatus: (connected) => { view.live = connected; renderConnection(); if (connected) soon(); },
  });
}

/* ------------------------------------------------------------- GPS ----- */

/** Hand-off to Google Maps — useful for the street part of a walk, blind to closures. */
function googleLink(nodeId) {
  const p = nodeLatLng(nodeId);
  return `<p style="margin:0 0 8px"><a class="btn btn-sm" target="_blank" rel="noopener"
    href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=walking">Open in Google Maps ↗</a>
    <span style="font-size:13px;color:var(--ash)"> Google does not know about closed paths or crowds.</span></p>`;
}

/* ------------------------------------------------------ notifications --- */

/**
 * System notifications for new alerts, so a volunteer with the queue in a
 * background tab — or the phone in a pocket with the page open — still finds
 * out. They go through the service worker where possible (Android Chrome only
 * shows them that way) and fall back to the page. Closed-page push needs a
 * push service and is not part of this prototype.
 */
let swReg = null;
function setupNotifications() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then((r) => { swReg = r; }).catch(() => {});
  }
  const button = $('#notify');
  const renderButton = () => {
    if (!('Notification' in window)) { button.hidden = true; return; }
    const p = Notification.permission;
    button.innerHTML = `${icon(p === 'granted' ? 'bellOn' : 'bell', { size: 18 })}<span>${p === 'granted' ? 'Alerts on' : p === 'denied' ? 'Alerts blocked' : 'Turn on alerts'}</span>`;
    button.setAttribute('aria-pressed', String(p === 'granted'));
    button.title = p === 'denied' ? 'Notifications are blocked for this site in your browser settings.' : 'Get a notification for every new alert';
  };
  button.onclick = async () => {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') await Notification.requestPermission();
    unlockAudio();
    renderButton();
    if (Notification.permission === 'granted') toast('You will be notified of new alerts while this page is open.');
  };
  renderButton();
}

function notifyAlert(alert) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const title = `New alert: ${KIND_LABEL[alert.kind] ?? 'Help needed'}`;
  const body = [
    alert.place?.en ?? 'Place unknown',
    null,
    alert.skillMatch ? 'matches your training' : null,
  ].filter(Boolean).join(' · ');
  const options = {
    body,
    tag: `alert-${alert.id}`,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    requireInteraction: alert.kind === 'medical' || alert.kind === 'crowd_crush',
    data: { url: '/admin/queue.html' },
  };
  try {
    if (swReg?.showNotification) swReg.showNotification(title, options);
    else new Notification(title, options);
  } catch { /* the sound and the on-screen card still work */ }
}

/* ------------------------------------------------------------ sound ----- */

let audio = null;
function unlockAudio() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch { /* no audio on this device */ }
  renderSound();
}

function renderSound() {
  const on = audio?.state === 'running';
  const button = $('#sound');
  button.textContent = on ? 'Sound on' : 'Turn on sound';
  button.setAttribute('aria-pressed', String(on));
}

/** A short two-tone. Volunteers are not looking at the screen. */
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
  } catch { /* audio needs a user gesture in some browsers */ }
  buzz(200);
}

boot();
