# Changelog

## 0.12.0 — 2026-10-12

- **Volunteers must be approved before they can log in.** Registering no
  longer signs anyone in. They see "the control room has to approve you
  first", and logging in says they are still waiting until an admin approves.
  (The *Security key* tab still lets a volunteer straight in, because whoever
  holds the key is already trusted.)
- **Approvals moved to the Volunteer queue.** A *Volunteers* panel at the top
  right lists *Waiting for approval* with **Approve / Reject**, and a count
  badge. A sound and a toast mark each new registration. *All volunteers*
  (folded) has *Disable / Enable*. The panel is gone from the control room
  page.
- **No map on the Volunteer queue.** It is now a dispatch screen: alerts and
  assigning, tasks for all, approvals, messages, and alert details (who
  raised it, who has it, a call link, history). The control room and every
  volunteer's own page keep their live maps.
- Tests: 77 unit/API, 107 browser checks (register → cannot log in → approve
  in the queue → logs in).

## 0.11.0 — 2026-10-12

- **Message or call any volunteer from the volunteer queue.** Each volunteer
  under *On duty now* has **Message** and **Call**. *Call* opens the phone
  dialler with their number; volunteers who signed in with only the key have
  no number. *Message* opens a one-to-one thread with read receipts. A red
  count shows unread replies.
- **Tasks for all volunteers.** The control room posts a job (what, details,
  where, how many people). Every volunteer sees it and can tap **I'll help**
  (or *I can't now*). The queue shows who is helping. *Mark done* and
  *Remove* are there too.
- **On the volunteer's My tasks page:** a *Messages from the control room*
  panel with a reply box, and a *Tasks for all volunteers* panel with *I'll
  help* and *Show the way* (route on the live map, with steps). New messages
  and new tasks come with a sound, a buzz, a toast and a notification.
- **Removed from the volunteer queue:** *Notices from the control room* and
  *Found someone? (band lookup)*. Both stay on the volunteer page. *Needs
  someone* stays, for assigning SOS alerts.
- Server: `/api/messages` (one-to-one threads; a volunteer can only ever
  write to the control room) and `/api/messages/board`. The live socket only
  says that something changed, never who or what.
- Tests: 77 unit/API, 104 browser checks.

## 0.10.2 — 2026-10-12

- Back to the 0.10.0 sign-in pages. The volunteer page has *Log in*,
  *Register* and *Security key*. The pilgrim app has *Guest*, *New account*,
  *Log in* and *Security key*, and *Save my account* is back on the Family tab.
- **The Security key option now asks for the key only**, on both pages: no
  name, no phone. The phone keeps a random device id, so the same phone comes
  back as the same volunteer (shown as *Volunteer 1*, *Volunteer 2*, …).
- Tests: 75 unit/API, 95 browser checks.

## 0.10.0 — 2026-10-12

- **The volunteer queue belongs to the control room.** It moved to
  `/admin/queue.html`, behind the admin sign-in, next to the control room
  (one-tap switch). Every alert has an **Assign** box. It lists volunteers
  best first: right training, then free, then shortest walk from where they
  last were. *Reassign* and *Take back* are there too.
- **Volunteers get their own page, My tasks** (`/volunteer/`). It shows
  only what the control room gave them:
  - a sound, a buzz and a notification the moment a task arrives;
  - the same live street/satellite map as the other screens, with GPS
    turn-by-turn to the person, re-routed around closed paths and crowds;
  - route steps and a Google Maps hand-off;
  - *Light their screen*, *Can't go* (hand back) and *Found / helped*;
  - the wristband lookup and control-room notices.
  The task is kept while the page is open.
- **Server rules to match:** volunteers can no longer list all alerts, take
  one, or touch someone else's task (403). New `POST /api/sos/:id/assign`
  (admin) and `GET /api/sos/tasks` (the volunteer's own).
- **Security key sign-in for volunteers and pilgrims.** A *Security key*
  tab on the volunteer sign-in page and a *Security key* option on the
  pilgrim welcome screen. It's the same key as the control room: in at once,
  no registration. A volunteer with the key is active straight away, the
  same phone gets the same account, and a pending registration is approved
  by it. Wrong keys are locked out after 10 tries per network.
- Tests: 74 unit/API, 93 browser checks (assign → task appears →
  beacon → wristband → resolve, key sign-in, queue is admin-only).

## 0.9.1 — 2026-10-12

- **Admins switch screens in one tap.** Both the control room and the
  volunteer queue have a *Control room | Volunteer queue* switch. The admin's
  queue (`/volunteer/?admin`) uses the control-room session, so it never
  takes over a volunteer signed in in the same browser. Before, it did, and
  the volunteer sign-in page kept bouncing into the admin's session.
- **Volunteers get in straight away.** Registering signs them in to their own
  page with the live map, crowd levels and control-room notices. A banner
  says they are waiting for approval. Alerts, the wristband lookup and the
  roster stay hidden until an admin approves, then switch on by themselves —
  no second sign-in. The server enforces this: a pending volunteer gets
  `403 pending` from every alert endpoint.
- **Notices on the volunteer page** for every volunteer.
- **Admin sign-in: the security key is what counts.** Any username and
  password can be used with the key. The first time they are saved, and after
  that the same pair is needed. Usernames ignore case and extra spaces.
  Passwords need 4+ characters. 10 wrong admin sign-ins lock the page for
  that network for 30 minutes. The separate *New admin* form is gone.
- Tests: 73 unit/API, 85 browser checks (screen switching, the pending →
  approved flow, any-username admin sign-in).

## 0.9.0 — 2026-10-12

Three kinds of people, three ways in — and the control room is locked.

### Accounts

- **"Who are you?"** The start page now sends pilgrims to the app,
  volunteers to the volunteer sign-in page, and admins to the control-room
  sign-in page (marked *Restricted*).
- **Pilgrims** choose *Guest*, *New account* or *Log in* on the welcome
  screen. Guest stays the default, so the red help button is never behind a
  login. An account is a phone number + 4–6 digit PIN, so the same family
  group works on another phone. A guest can save their account later from the
  Family tab and keeps everything. *Sign out* warns a guest that the account
  cannot be recovered.
- **Volunteers** register with name, phone, password, training, languages
  and organisation. They stay *pending* until the control room approves them,
  because they will see missing children's details. Pending, rejected and
  disabled volunteers cannot sign in and are never offered alerts.
- **Admins** sign in with username, password **and the security key**. A new
  admin account can only be created with the key. The key is made on first
  start (or taken from `KM_ADMIN_KEY`), stored only as a hash, and written
  once to `server/db/FIRST-RUN-CREDENTIALS.txt`.
- **Control room → Volunteers panel:** approve, reject, disable (signs them
  out at once) and enable. Every decision is logged. A toast appears the
  moment someone registers.
- **Admins can open the volunteer queue** with their control-room session
  (the *Volunteer queue* button in the header).

### Volunteer queue

- **Notifications:** *Turn on alerts* asks for permission, then every new
  alert raises a system notification. Medical and crowd-crush alerts stay on
  screen until dismissed. Tapping one brings the queue back.
- Fixed: a volunteer who opened an empty queue was not alerted to the first
  alert that arrived.
- The header shows who is signed in, with *Sign out*.

### Security

- Removed `GET /api/auth/staff`, which handed every staff token to anyone,
  and the OTP stub with its fixed code `123456`.
- Passwords and PINs are hashed with scrypt. Checks are timing-safe, and the
  error never says which part was wrong.
- Lockouts: 8 wrong passwords lock that one account for 15 minutes (not the
  whole network, since thousands of phones share an IP); 5 wrong security keys
  lock admin sign-up for that network for 30 minutes.
- Staff sessions expire after 12 hours.

### Tests

- New `test/auth.test.mjs` (11 tests): the key is required, nobody else
  reaches control-room endpoints, the approval flow, disabling signs out,
  pilgrim register / log in / guest upgrade, both lockouts.
- The browser test signs in through the real pages, including a wrong
  password and a wrong security key. 72 unit/API tests, 79 browser checks.

## 0.8.0 — 2026-10-12

Final polish: fixes, safety limits, installability, and documentation.

### Fixed

- **Wristband page on phones:** the band preview overlapped (the code ran
  into the "show this to any volunteer" text) because it was laid out at its
  printed width. It now stacks on a phone and still prints at 190 mm. The
  page has the new look: header with back button, three-step "how it works",
  and a big − / + stepper. The band itself always stays white paper with dark
  ink, whatever the theme.
- **The SOS outbox never cleaned up:** delivered alerts stayed in the
  phone's storage forever. Delivered items older than 12 hours are now pruned
  at start-up; undelivered ones are never touched.

### Safety limits

- `server/lib/limit.js`: small rate limits for the endpoints that can be
  abused — assistant (40/min per user), wrong group-join codes (10 per 15 min
  per user; correct codes never count), wristband lookups (60/min per
  volunteer), OTP (10 per 10 min per number), and a very high flood ceiling
  on guest sign-up (500 per 10 min per IP, `KM_GUEST_LIMIT`).
- Limits are per user, not per IP, wherever possible: at a mela thousands of
  phones share a few carrier-NAT addresses. **SOS is never limited**, and a
  test proves a rate-limited user can still raise an alert.

### Installable and honest about offline

- **Install card** on Home: one-tap install where the browser supports it,
  Share → "Add to Home Screen" steps on iPhone, dismissable, hidden once
  installed.
- **"Saved on this phone — works with no signal"** appears only once the
  service worker really has the app cached.

### Developer experience

- `test/static.test.mjs` is now part of `npm test`: imports resolve to real
  exports, every `#id` a script uses exists in its page, no inline scripts
  (the CSP would block them), every precached file exists.
- `npm run check` runs everything. README gains a feature overview and a
  table of commands.
- Tests: 61 in `npm test`, 68 browser checks.

## 0.7.0 — 2026-10-11

Light, dark and automatic themes on every screen.

### What you get

- A **theme button** (sun / moon / half-circle) in the pilgrim app's top bar
  and welcome screen, both console headers and the landing page. Three
  choices, named in the app's language: **Light** (best in bright sun),
  **Dark** (easier at night), **Automatic** (follows the phone's own setting,
  and changes with it).
- **One choice per device**, shared by the app, volunteer queue, control room
  and landing page, and kept between visits. Other open tabs follow at once.
- **No white flash:** `shared/theme-boot.js` applies the saved theme before
  the page paints. The phone's address/status bar colour follows too.
- **Printing is always light**, so wristbands print properly from dark mode.

### How it is built

- Every colour in `styles.css` now names its job rather than its hue: `--bg`
  (page), `--card`, `--ink` (text), `--brand` (teal bars), `--on-brand`,
  `--primary` (solid buttons), named tints, and map tokens. Before, the same
  teal was both text and bar colour, and the same cream both page and text on
  teal, so a theme could not change one without breaking the other.
- Light values reproduce the existing look. The dark palette keeps the
  identity — deep river-at-night surfaces, the same marigold, vermilion still
  only for SOS.
- **Maps follow the theme:** street tiles get a night treatment (satellite
  left as is), the drawn offline map uses the map tokens, Leaflet's zoom and
  attribution controls become cards.
- Text on marigold stays dark in both themes; white text sits on darker
  "surface" versions of red and green.

### Contrast

- Measured, not eyeballed: every main text/background pair meets WCAG AA
  (4.5:1 for text, 3:1 for large labels) in both themes. This caught one
  failure in the *existing* light theme — amber labels were 2.93:1 — now
  4.15:1. In dark: primary buttons 4.71, body text 13–15, muted text 7.4+.

### Tests

- Browser suite now 66 checks: the menu, Dark actually changes the page
  colour, the choice carries to another screen before paint, Automatic
  follows the phone both ways, and Escape closes the menu.

## 0.6.0 — 2026-10-11

A visual refresh across every screen. Same palette and rules — no webfonts,
local script first, vermilion only for SOS — with softer depth, one icon
set, and clearer hierarchy.

### Fixed

- **The volunteer queue overflowed sideways on phones** (the band-code
  input refused to shrink, pushing the page to 455 px on a 360 px screen).
  Every page now fits at 360 and 390 px.
- **The map drew medical posts in vermilion**, the colour reserved for the
  SOS button. Medical is now a deep rose on both maps and on Home.
- **The SOS sheet repeated English** on English screens; the second line is
  now Hindi, as on every other control.
- The app title wrapped onto two lines on phones.

### Pilgrim app

- **Top bar:** logo with the network dot as a badge, one-line title, airplane
  icon button, and a compact **language menu** (each language in its own
  script) instead of three squeezed buttons.
- **Welcome:** teal hero with river waves, numbered steps, language cards
  showing each script with a check mark, larger name field, and three
  plain promises (no phone number, works offline, red button always there).
- **Home:** a welcome card with your place and how it is known (GPS or
  chosen); alert cards with icons; a **2-column tile grid** — nearest toilet,
  water, medical post, lost & found, **least crowded ghat** (from Mitra's
  engine) and **Ask Mitra** — each with place and walking time; the schedule
  as a timeline with a "happening now" marker and navigate buttons.
- **Family:** teal code card with Share and Wristband buttons; people with a
  steady colour each and a presence dot; meeting-point card; settings rows
  with a real on/off switch for sharing.
- **SOS sheet:** grab handle and calm icon tiles; the red stays on the send
  button.
- Tab bar as a floating card with an active marker; softer chat bubbles.

### Landing page and consoles

- **Landing:** hero, three role cards, four "what makes it different" cards,
  and numbered demo steps; responsive from phone to desktop.
- **Volunteer queue and control room:** branded header (logo links home),
  stat tiles with icons, icons on panel titles, and a kind icon on each
  alert card.

### Platform

- `shared/icons.js`: one 24 px icon set used across the app and consoles,
  plus the shared place colours.
- **Installable icons:** PNG 180/192/512 and a maskable 512 for Android and
  iOS home screens (rendered from the logo), registered in the manifest.
- Browser suite now 60 checks (tiles, language menu, icons); fixed a check
  that had been passing vacuously after the notice markup changed.

## 0.5.0 — 2026-10-11

Mitra, rebuilt. One engine (`shared/mitra.js`) now runs on the phone and the
server; it still cannot invent a place, route, time or number.

### Understands more, and misunderstands less

- **Fixed misunderstandings** in the old keyword matcher:
  - "where is the medical post" raised an emergency → now finds the post
    (and still offers an alert button and 108);
  - "पानी कहाँ है" was answered as "where is my family" → now water;
  - "घाट का रास्ता" gave a crowd report → now the way to the nearest ghat;
  - short English words matched inside others ("eat" in "great", "bus" in
    "business", "hi" in "hindi") → whole words only.
- Devanagari spelling variants (ड़/ड, ँ/ं, Devanagari digits) match.
- Place nicknames ("sangam", "bus stand", "station", "gate number 2",
  "bhandara") and typos ("sangham ghat").
- A lost phone or bag goes to Lost & Found, not an SOS for a lost person.

### Remembers the conversation

- "Is it crowded there?", "how far?", "another one", "take me there / chalo"
  all refer to the last place. "Chalo" starts turn-by-turn straight away.

### New things to ask

- **Is a place crowded?** Live level from crowd warnings and closed paths,
  with a calmer place of the same kind offered when it is packed.
- **Which ghat is least crowded?** Crowd first, then walking time; names the
  ghats to avoid.
- **Where is Papa?** A family member by name, or the whole group.
- **Where am I?** With the nearest toilet, water and medical post.
- **Any announcements?** Crowd warnings first, then control-room notices.
- **Emergency numbers:** 112, 108, 1098, 181 as tap-to-call buttons.
- **Event times** by name ("when is the aarti", "भंडारा कब है").
- Greetings, thanks, "what can you do", and a helpful answer (with
  suggestions) when it does not understand.

### A better chat

- Answers carry buttons: **Start walking**, **Show on map**, **Raise an
  alert**, **Open family**, and call buttons.
- **Follow-up chips** after each answer; starter questions on an empty chat.
- **Crowd meter** on crowd answers; steps folded away under "Steps".
- **Voice:** live transcript while you speak, sends when you stop, tap to
  stop; "Read aloud" on every answer; voice on/off in the header; a slightly
  slower speaking rate.
- **Kept on this phone** across visits (localStorage, last 40 messages), with
  **Clear chat**. Cleared automatically if the phone is signed out. Nothing is
  stored on the server.
- The greeting follows the chosen language.

### Server and model

- `routes/assistant.js` uses the shared engine with the freshest flags, crowd
  warnings and the caller's own family group. Memory sent by the phone is
  validated (only real landmark ids are kept).
- `lib/mitra-llm.js` (only with `ANTHROPIC_API_KEY`): the model may pick one
  intent and place from fixed lists for wording the rules missed, and may
  rephrase answers — never emergencies. Off-list values are discarded;
  timeouts and errors fall back to the offline answer.
- Removed `shared/intents.js` (replaced by `shared/mitra.js`).

### Tests

- `test/mitra.test.mjs`: 27 tests covering every old misunderstanding,
  emergencies in three languages, memory, crowds, family, schedule,
  helplines, "it cannot invent", and the model helper with a fake network
  (including a model that tries to answer off-list).
- `npm test` now runs 56 tests; the browser suite 58 checks.

## 0.4.1 — 2026-10-11

Navigating from wherever you are standing, not just from a landmark.

- **Starts from your exact spot.** Before, a route always began at the
  nearest landmark — which could be behind you, so the first instruction
  sent you back the way you came. Now the app tries the few nearest
  landmarks and joins the route at whichever makes the whole trip quickest,
  counting the walk to reach it (`planFrom` in `shared/guidance.js`).
- **First instruction is from where you stand** ("In 500 m at Sector B Camp,
  keep right…"), with a dashed line on the map from your dot to the route.
- **Winding roads no longer count as "off route".** The lines between
  landmarks are straight and real roads bend. You are now off route only if
  you are far from the line *and* walking away from the next landmark (or
  more than 250 m away). Before, drifting 45 m to one side triggered
  re-routing even when heading the right way.
- The route card's distance and time now include the walk to the route, so
  they match the navigation bar.
- Same planner for volunteers walking to an alert.
- 4 new tests (29 in `npm test`), including a road that bulges 80 m off the
  straight line without being called off-route.

## 0.4.0 — 2026-10-11

Live map in the volunteer queue and the control room.

### Volunteer queue

- **Live street/satellite map** with alert pins, the route to the selected
  alert, and other volunteers' positions (green free, grey on a job), so
  nobody walks to a job a colleague is closer to. Live/Simple switch, as in
  the app.
- **My location (GPS):** "where you are" follows the volunteer's GPS, so the
  queue's walking times are always from where they really are. Choosing a
  place by hand switches GPS off.
- **Turn-by-turn to the alert** while GPS is on: arrow, distance, metres to
  the alert and minutes, spoken once sound is on. Re-plans when the
  volunteer leaves the route or a path ahead closes. The map follows the
  volunteer and keeps the next landmark in view.
- **Open in Google Maps** for each alert.
- Fixed two `#map-holder` leftovers that would have thrown when tapping
  Route on a narrow screen or Show route on a wristband lookup.

### Control room

- **Live map where you click a path to close or reopen it** (wide invisible
  hit lines make paths easy to click; hover shows the path and its level).
  The selected path is highlighted.
- **Crowd-pressure circles** per landmark, sized by how full it is and
  coloured by risk — aggregate head-counts only.
- **Every volunteer on the map**, free or on a job.

### Shared

- `shared/mapswitch.js` — live-or-drawn map controller used by both
  consoles (remembers the choice per screen, falls back to the drawn map
  when Leaflet or tiles are unavailable).
- Console maps label landmarks in English regardless of the pilgrim app's
  language.
- Browser suite now 55 checks.

## 0.3.0 — 2026-10-11

Live map and turn-by-turn navigation in the pilgrim app.

### Live map

- **Real street and satellite maps** (OpenStreetMap / Esri imagery) under the
  mela graph, using Leaflet served from our own server (`/vendor/leaflet`),
  not a CDN. Crowd levels, landmarks, family members and the route are drawn
  on top. Paths keep the colour + weight + dash encoding.
- **Live map / Simple map** switch. The drawn map stays as the fully offline
  fallback, and the app says plainly when map pictures can't load ("paths
  and directions still work").
- The demo ground is placed on the south bank of the Yamuna just upstream of
  the Sangam, so the river runs along the top as in the drawing. Coordinates
  are illustrative: a real mela would survey each landmark (`lat`/`lng` on
  the node now overrides the projection).
- Tiles you have looked at are cached (up to 800) so the map around you
  still has a picture after the network drops. There is no bulk download —
  OSM's tile policy forbids it; production needs its own tiles.

### GPS

- **My location** button: blue dot, accuracy ring and walking direction.
- **Privacy is unchanged:** the GPS fix stays on the phone. Only the nearest
  landmark is sent, at most every 20 s, as before.
- Your place updates itself as you walk, so "nearest toilet" on Home is
  always from where you actually are.
- Off the mela ground (e.g. a laptop demo), the app says so instead of
  showing a dot in another city.
- Location resumes on the next visit only if permission is still granted —
  the app never pops a permission prompt unasked.

### Turn-by-turn navigation

- **Start** on any route: a banner with a big turn arrow (readable without
  reading) and the instruction in Hindi, Marathi or English — "In 350 m at
  Tent Crossing, keep right towards Toilets (North)". Landmarks, never
  street names.
- **Voice prompts** at each turn, with vibration as a turn approaches; mute
  button.
- Bottom bar: minutes left (crowd-adjusted), distance and arrival time, plus
  End. The SOS button stays visible throughout.
- The map follows you and frames the next landmark so it is always on
  screen; pan freely and tap "Back to me" to resume.
- **Live re-routing:** if the control room closes a path ahead while you are
  walking, the route changes immediately with a spoken "New route". Walking
  off the route also re-routes (after three consecutive off-route fixes, so a
  single bad fix in a crowd does not).
- **Demo walk:** away from the ground, Start plays a simulated walk (about
  45 s, clearly labelled "Demo walk — simulated position").
- Arrival: spoken, recorded as your new place, "You have arrived" card.
- **Open in Google Maps** hand-off on every route, with a note that Google
  does not know about closed paths or crowds.
- The banner stays on every tab, so Mitra or the family list can be open
  mid-walk.

### Under the hood

- `shared/guidance.js` — pure navigation engine (progress along the route,
  turn angles, instructions in three languages, off-route and arrival).
- `shared/location.js` — GPS and simulated-walk position sources.
- `shared/livemap.js` — Leaflet renderer with the same `render(view)`
  contract as the drawn map.
- `mela-map.js` gains `toUnits`, `nodeLatLng`, `nearestNode`, `onGround`,
  `groundBounds`, `metresBetween`.
- Security policy allows the two tile hosts (images, and the service worker's
  tile fetches) and geolocation for this origin only.
- Tests: 11 new navigation-engine unit tests (`npm test` now runs 25);
  browser suite now 50 checks, including GPS navigation with a path closed
  mid-walk.

## 0.2.0 — 2026-10-11

Security fixes, demo-breaking bug fixes, a frontend pass across all three
screens, and the project's first automated tests.

### Security

- **Tokens are no longer user ids.** The bearer token used to be the user id,
  and user ids were visible to others: in group member lists, and in every
  SOS/beacon frame broadcast to *all* WebSocket clients. Anyone connected could
  collect tokens and act as other people, including cancelling their SOS. Each
  user now gets a random secret token. Existing databases are migrated on
  start; old sessions are asked to sign in again.
- **The live socket carries no personal data.** SOS frames now contain only
  `{event, alertId, status, kind}`; beacon and reunion frames carry no user ids,
  names, phone numbers or descriptions. Screens fetch details over the
  authenticated API.
- **Stored XSS fixed.** Names, group labels, notices, "who is missing"
  descriptions and Mitra replies were inserted with `innerHTML` unescaped.
  Everything user-supplied now goes through `esc()` (`public/shared/dom.js`).
- **Content-Security-Policy** and other security headers on every response
  (no inline or third-party scripts). The wristband page's inline script moved
  to `app/wristband.js`.
- Authorisation fixes:
  - `GET /api/groups/:id/members` answered any signed-in user for any group.
    It is now limited to group members and staff.
  - Any user could switch off any beacon. Only the alert's owner or staff can now.
  - Any volunteer could release another volunteer's claim. Only the claimer or
    an admin can now.
  - Reunion acknowledgements are limited to the group's members.
- Input validation: name/label/notice lengths, language codes, notice
  severity, battery range, meeting point, mesh hop count, `raisedAt`, and
  idempotency key length. Malformed JSON returns 400 instead of 500.
- The service worker no longer caches personal API responses (your alerts,
  your group) where the next user of a shared handset could be served them.
- WebSocket: only known topics can be subscribed, frames are size-capped, and
  dead sockets are reaped.

### Bugs that broke the demo

- **Opening the volunteer console broke the pilgrim app.** All screens shared
  one `localStorage` token, so the console overwrote the pilgrim's sign-in.
  After that, the pilgrim tab acted as the volunteer: its SOS status stopped
  updating and the group and reunion banner disappeared. Each screen now keeps
  its own session.
- **The phone-to-phone relay never worked between tabs.** The device id and
  the ✈ "no signal" switch were both in `localStorage`. Every tab had the same
  device id (and a device ignores its own messages), and the switch turned
  every tab offline at once. Both are now per-tab.
- **Pressing through the SOS flow twice raised two alerts.** The README says
  ten presses make one alert, but each pass minted a new idempotency key. The
  same kind of emergency now reuses its key for 10 minutes unless the first
  alert was closed.
- **Claims expired mid-rescue.** Claims lapse after 10 minutes, but the console
  never sent the heartbeat that renews them. The volunteer console now renews
  its claims while open and shows how long each one holds.
- **Misleading safety copy.** The route card and Mitra said "this route avoids
  a heavy crowd" when the route actually *went through* one. They now say so
  plainly and advise going slowly.
- Clearing a path flag set the path to "clear" instead of back to its normal
  crowding (some approaches are busy by default). There is now
  `DELETE /api/map/flags/:edgeId`, and the control room's **Reset** uses it.
- **Close approach** shut whichever path was listed first. For Sangam Ghat that
  was the riverbank walk, not the approach. It now picks the path coming in
  from the junction and names it on the button.
- Reunion acknowledgements were never saved, so the green banner came back
  after a restart.
- Beacons never switched off despite having an expiry. Expired beacons now go
  dark, and cancelling or resolving an alert switches its beacon off.
- Events already running showed as "-30 min".
- The demo schedule went stale a day after seeding. It now rolls forward on
  start.
- Unknown edge ids were accepted as flags.
- The service worker served the app shell cache-first with a fixed version, so
  code changes never reached installed phones. It is now stale-while-revalidate.
- Data file writes are atomic (temp file + rename) and flushed on Ctrl+C, so a
  crash mid-write can no longer wipe the database.
- Leaving a group (new), or a group deleted server-side, no longer leaves a
  stale cached group on screen.

### Pilgrim app

- Notices show severity (Urgent / Warning) as a label, urgent ones first, and
  never in vermilion (reserved for SOS).
- Route card: **I have arrived** updates your place, plus a "you are here" state
  and a clear "every way is closed — do not go" message.
- Family: **Share / Copy code**, **Leave this group**, a low-battery warning for
  members (≤15%), a "you" tag, and forgiving code entry (spaces and dashes are
  ignored).
- Mitra: **Show on map** on route answers, escaped replies, the server's answer
  replaces the right bubble, and the newest answer scrolls into view.
- The SOS sheet is a real dialog: Escape or a backdrop tap closes it, focus is
  managed, there is a "Wrong place?" link, and it tells you when help is
  already on the way.
- Beacon: holds a screen wake lock so the phone doesn't dim while held up,
  and focuses the "Found me" button.
- Schedule items have **Take me to**; the place list follows the language.
- Coming back to the app (unlocking the phone) refreshes immediately.
- Accessibility: skip link, live regions for status and banners, labelled
  inputs, `aria-pressed` and `aria-current` on toggles and tabs, keyboard-
  operable map landmarks, and announced toasts.

### Volunteer queue

- Live/reconnecting indicator with "updated Ns ago".
- Turn on sound (browsers block audio until a tap), a two-tone ping and a
  vibration for new alerts, a "(2)" count in the tab title, and a highlight on
  new cards.
- Claim countdown, automatic renewal, double-click protection, and a confirm
  before closing an alert.
- Your own jobs are listed first; resolved alerts move to a collapsible
  **Recently resolved** list; "resolved today" really is today.
- A **staffing gap** warning when an open alert needs a skill no free volunteer
  has.
- Language names instead of codes, tap-to-call for the raiser's phone, a
  clearer timeline, and your location is remembered.

### Control room

- **Live on phones now** list, with **Withdraw** (`DELETE /api/content/notices/:id`).
- Notices take Hindi, Marathi and English; empty languages are filled from the
  others. Character counter, Ctrl+Enter to send, and a confirm before urgent
  ones.
- A critical-crowd bar across the top, fill meters on crush rows, and open
  alerts ranked by urgency with the time waited and the subject.
- Path panel shows the normal level and has **Back to normal**.
- Realtime refreshes are debounced (they previously fired on every heartbeat).

### Platform

- `npm test`: 14 API tests against a throwaway database (auth, idempotency,
  permissions, socket privacy, flags, notices, assistant).
- `npm run test:browser`: 42 end-to-end checks in headless Chrome/Edge across
  all four pages, including the mesh relay and XSS attempts.
- `GET /api/health` reports uptime, live connections and open alerts.
- `MITRA_MODEL` overrides the rephrasing model; `KM_DATA_FILE` points at a
  different data file; `KM_QUIET=1` silences request logs.
- The rephrasing call ignores error responses and refusals instead of
  surfacing them.
- Favicon and theme colour on every page; manifest gains a description and a
  wristband shortcut.
