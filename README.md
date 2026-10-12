# Kumbh-a-Mitra

An offline-resilient companion app for mass religious gatherings: crowd-aware
navigation, opt-in family location sharing, a multilingual assistant, and an
SOS path that a volunteer console picks up in real time.

This repository is a **working prototype**, not a shipped product. Everything in
it runs. Some of it is deliberately simplified, and the list of exactly what is
simplified is at the bottom of this file — read that section before you show
this to anyone who might mistake it for production software.

## What's in it

| Screen | What it does |
|---|---|
| **Pilgrim app** (`/app/`) | Live street/satellite map with GPS and turn-by-turn voice guidance that re-routes when a path closes; nearest toilet, water, medical post, lost & found and least crowded ghat; family group with coarse location sharing and printable QR wristbands; **Mitra**, an assistant in Hindi, Marathi and English that works offline and remembers the conversation; and the red **I need help** button, which queues offline and hops to nearby phones when there is no signal. |
| **Volunteer — My tasks** (`/volunteer/`) | The tasks the control room has given *you*: a notification the moment one arrives, the live map with GPS turn-by-turn to the person (around closed paths and crowds), light their screen, *Can't go* / *Found*, wristband lookup and notices. Sign in with phone + password, register, or use the Security key tab (just the key — this phone is remembered as the same volunteer). |
| **Control room** (`/admin/`) and its **Volunteer queue** (`/admin/queue.html`) | Admins only. The queue is where every alert is **assigned to a volunteer** (best first: trained, free, nearest). The control room itself: Restricted: username + password **+ security key**. Approve, reject or disable volunteers, switch between Control room and Volunteer queue with one tap, crush prediction from anonymous head-counts, close or reopen paths by clicking the live map, crowd-pressure circles, every volunteer's position, notices in three languages. |

The start page asks **who are you?** — pilgrim, volunteer or admin — and each
has its own way in. Pilgrims can start as a guest (the help button is never
behind a login) or make an account with phone + PIN to use it on another phone.

Every screen has **light, dark and automatic** themes, works on a 360 px phone,
and can be installed to the home screen. The app keeps working with no network:
map, routing, Mitra and the SOS outbox all run on the phone.

---

## Run it on your laptop

You need **Node.js 18 or newer** and nothing else. No database, no Docker, no
Android Studio, no API keys.

**1. Check Node is installed.** Open Terminal (macOS/Linux) or PowerShell
(Windows) and run:

```bash
node -v
```

If you see something like `v22.x.x`, you are fine. If you see "command not
found", install Node from <https://nodejs.org> — take the LTS version — then
close and reopen the terminal.

**2. Go into the project folder and install.**

```bash
cd kumbhamitra
npm install
```

This takes about twenty seconds and downloads two packages.

**3. Start it.**

```bash
npm start
```

You will see:

```
  Kumbh-a-Mitra is running.

  Pilgrim app     http://localhost:3000/app/
  Volunteer       http://localhost:3000/volunteer/login.html
  Admin console   http://localhost:3000/admin/login.html
```

### Signing in the first time

On first start the server creates the **admin security key** and passwords for
the demo accounts, prints them once, and saves them to
`server/db/FIRST-RUN-CREDENTIALS.txt` (git-ignored — keep it private, delete
it once you have noted them). Only hashes are kept in the database.

| Who | Where | Sign in with |
|---|---|---|
| Admin | `/admin/login.html` | **the security key** plus any username and password you choose — saved the first time, the same pair needed after that. (The generated `admin` login also works.) |
| Any volunteer, no registration | `/volunteer/login.html` → Security key | just the security key — active at once |
| Pilgrim, no registration | `/app/` → Security key | the security key |
| Demo volunteers | `/volunteer/login.html` | phone `9000000001` … `9000000008` (Sunita, Imran, Lata, Ramesh, Fatima, Arjun, Kavita, Gurpreet) and the demo password |
| New volunteer | `/volunteer/login.html` → Register | can log in only after an admin approves them in the Volunteer queue |
| Pilgrim | `/app/` | Guest (no sign-up), or New account / Log in with phone + 4–6 digit PIN |

To choose them yourself instead, set these before the first start (or before
`npm run reset`): `KM_ADMIN_KEY`, `KM_ADMIN_PASSWORD`, `KM_DEMO_PASSWORD`.
If `KM_ADMIN_KEY` is set it always wins over the stored key.

Open <http://localhost:3000> in your browser. Stop the server with `Ctrl+C`.

To start over with a clean database: `npm run reset`.

### Commands

| Command | What it does |
|---|---|
| `npm start` | Run the server on <http://localhost:3000> |
| `npm run dev` | Same, restarting when server files change |
| `npm run reset` | Clear the database and reseed the demo volunteers, schedule and notices |
| `npm test` | Static checks, API, accounts and access, navigation and Mitra tests — a few seconds, throwaway database |
| `npm run test:browser` | Drives every screen in headless Chrome or Edge (if installed), including GPS navigation, the mesh relay and both themes |
| `npm run check` | Both of the above |

Optional settings: `PORT`, `ANTHROPIC_API_KEY` and `MITRA_MODEL` (see
below), `KM_DATA_FILE` (use a different data file), `KM_QUIET=1` (no
request log), `KM_ADMIN_KEY` / `KM_ADMIN_PASSWORD` / `KM_DEMO_PASSWORD`
(see *Signing in the first time*).

What changed in this version, and why: [CHANGELOG.md](CHANGELOG.md).

---

## The seven-minute walkthrough

Do these in order. Each one demonstrates a specific design decision.

**1. An alert travels.** Open the pilgrim app in one browser window and the
volunteer queue in another, side by side (sign in as a demo volunteer — Lata,
`9000000003`, is trained in child protection). In the app, press the big red button,
pick *Someone is missing*, type a description, confirm. It lands in the
volunteer queue within a second, with a walking time from wherever the volunteer
says they are. Claim it, then resolve it, and watch the app update.

**2. The map re-routes.** In the pilgrim app, go to the map and tap Sangam Ghat
— you get a route and turn-by-turn landmarks. Now open the control room, click
the path between *Sangam Approach* and *Sangam Ghat*, and mark it **Closed**.
Go back to the app and route to Sangam Ghat again: it now goes the long way via
Hanuman Ghat. Nobody refreshed anything.

**3. It survives the network dying.** Turn off your wifi. The app keeps working
— map, routing, the assistant, the whole thing. Press the red button while
offline. It says **waiting to send**, not *sent*, because it has not been sent.
Turn wifi back on; it delivers itself and the status changes.

**4. Pressing it ten times makes one alert.** Press the red button repeatedly.
One alert appears in the queue, not ten. The idempotency key is minted on the
device before any network call.

**5. Walk there like Google Maps, but crowd-aware.** Map tab → tap Sangam
Ghat → **Start**. You get a turn arrow, spoken directions and a minutes-left
bar; on a laptop it plays a labelled demo walk. While it walks, close a path
on the way from the control room — the route changes and it says "New
route". On a phone at the ground, press **My location** first and it follows
your real GPS.

**6. Mitra answers with no server, and remembers the conversation.** Go to the
Mitra tab, turn wifi off, and ask "toilet kahan hai". Then "wahan bheed hai?",
"koi aur?", "kitni door?", "chalo" — each refers to the last place, and "chalo"
starts walking. Try "which ghat is least crowded" after simulating a crowd at
Sangam from the control room, or "emergency numbers" for tap-to-call buttons.
It all runs on the phone: the same engine (`shared/mitra.js`) runs on the
server, so the two can never disagree about a route.

**7. Light or dark, and installable.** The half-circle button in any top bar
switches Light / Dark / Automatic; the choice follows you to every screen. On
Home, **Install** adds the app to the home screen.

---

## The five things that make this different

Each one answers the same question: **what happens when the network and the
user's literacy both fail at the same time?** That is the actual condition at a
mela, and almost no app is built for it.

### 1. Phone-to-phone SOS relay

At a Kumbh the network does not fail by going away. It fails by congesting —
two hundred thousand handsets on a few towers. Your phone shows full bars and
nothing moves. That is exactly when someone presses the red button, and an
alert queued for a tower that will not clear for forty minutes is useless.

So when the tower will not answer, the phone shouts the alert to devices around
it and asks them to carry it. Any phone with a working connection posts it and
shouts back a receipt. **The alert leaves the device even though the device has
no signal.** The volunteer console shows "arrived via 2 nearby phones", which
also tells the control room that sector's tower is down.

It refuses to relay anything except an SOS — not chat, not location, not
schedules. A mesh that carries arbitrary payloads between strangers' phones is a
malware and surveillance surface, and nothing else in the app is worth that.

**Be honest about this in your demo.** On a real handset the transport is
Bluetooth LE or Wi-Fi Aware, which a browser cannot open. Here it is
`BroadcastChannel`, so it relays between browser tabs. The protocol on top —
discovery, hop counting, carrier election, receipts, loop prevention, the
payload restriction — is real and would sit unchanged on BLE. Swap the four
transport functions at the bottom of `public/shared/mesh.js` and nothing above
them changes. Judges respect that framing far more than a vague claim, and one
of them will ask.

### 2. Printed wristbands for people with no phone

The people most likely to get lost at a mela are small children and very old
relatives — exactly the people who do not own a handset. A phone-first design
silently excludes them.

So the app prints a wristband carrying the group's join code as a QR. A
volunteer finds a crying six-year-old, scans or types six characters, and
immediately sees who the family is and where they were last seen. No account,
no app, no battery on the child's side. **The paper is the device.**

The QR encoder is written from scratch (`public/shared/qr.js`) rather than
pulled from a CDN, because a script that fails to load leaves a blank square on
a child's wrist. It uses error correction level H — 30% of the code can be
destroyed and it still scans, which matters after three days of a wristband
getting wet and muddy at a riverbank.

### 3. Crush prediction that needs no surveillance

A crowd crush does not begin when density is high. It begins when density is
high **and still rising**. By the time it is visible on a CCTV monitor it is
too late to do anything but treat casualties. The preventable window is the few
minutes before, and the only thing that fits in that window is a decision to
close one approach and open another.

The control room gets density, rate of change, and **minutes until movement
stops**, ranked worst-first, with a one-tap "close approach" on each row.
Pilgrims heading that way get a warning and a different route.

The part worth showing judges is the privacy design. When a phone reports its
position, the server increments a counter for `(landmark, minute)` and throws
the identity away immediately. The density table has **no user column at all**,
so it cannot be turned into a movement history for any individual even by
someone with full database access. Crowd safety does not require surveillance,
and building it this way means nobody ever has to be trusted not to look.

Verify it yourself: `server/db/data.json` → `densityLog`.

### 4. The find-me beacon

"I am at Sangam Ghat" is useless when Sangam Ghat holds forty thousand people
standing shoulder to shoulder. The volunteer is two minutes away and still
cannot find the person.

So the volunteer taps **Light their screen**. The lost person's phone fills
edge to edge with one saturated colour and plays a rising two-note tone, with
one instruction: hold your phone up high. The volunteer is told which colour to
look for. A bright rectangle held overhead is visible across a crowd in a way a
face is not.

Six colours, each assigned to only one live beacon at a time so two never
clash, chosen to stay distinct in daylight and to survive the common forms of
colour blindness — no red/green pair, and each has a different lightness so
they differ even in greyscale. The colour is named in the pilgrim's own
language, because the volunteer has to say it out loud.

### 5. Volunteers are not interchangeable

Eight volunteers with real skills and languages: a nurse, a physician,
Childline and Mahila Suraksha volunteers, NSS students, Khalsa Aid seva.

A collapsed diabetic needs medical training. A frightened eight-year-old needs
child protection. A Tamil-speaking family at a north Indian mela needs someone
who can talk to them. Dispatching purely by distance sends a first-aid
volunteer to a cardiac case while a trained nurse walks past the other way.

So each volunteer's queue ranks on **skill match first, urgency second**. That
ordering is deliberate and worth defending out loud: the queue answers "what
should *I* do next". Putting a cardiac arrest at the top of a child-protection
volunteer's screen does not get anyone to the patient faster — it spends the
attention of the one person who could have reached the lost child. The control
room still sees everything ranked by urgency alone.

The roster also makes staffing gaps visible: if nobody on duty has medical
training and a medical alert is waiting, that is a decision someone needs to
make now, not at the debrief.

---

## Demo script for judges — 90 seconds

Have three windows open: pilgrim app, volunteer queue, control room (signed in
— see *Signing in the first time*).

1. **"The network is the enemy, not the absence of it."** Press the aeroplane
   button in the app — that tab now behaves as though it has no signal while
   its neighbours still do. Press the red button. It says *waiting to send*.
2. Open a second pilgrim tab (this is "a stranger standing nearby"). Within
   seconds the first tab reports **sent — carried by 1 nearby phone**, and the
   volunteer queue shows *arrived via 1 nearby phone*.
3. **"Not everyone has a phone."** Group tab → Print a wristband. In the
   volunteer console, type the six characters into *Found someone?* — the
   family appears instantly. Tap *I have them* and watch the green banner
   arrive on the pilgrim's screen.
4. **"Finding one person among forty thousand."** Claim the alert, tap *Light
   their screen*. The pilgrim's phone goes solid blue and sings.
5. **"Preventing the crush instead of treating it."** Control room → simulate
   arrivals at Sangam Ghat. The panel says *critical in 3 minutes*. Tap **Close
   approach**, then route to Sangam Ghat in the app — it goes the long way.
6. Close on the privacy line: open `densityLog` in the data file and show there
   is no user column. "We predict crushes without tracking anybody."


---

## What is where

```
server/
  index.js              Express entrypoint, wires everything together
  realtime.js           WebSocket fan-out (stands in for Redis pub/sub)
  lib/auth.js           Random bearer tokens, staff session expiry, role guards
  lib/secrets.js        Password hashing (scrypt), admin security key, first-run credentials
  lib/rate-limit.js     SOS abuse limiting that never refuses a real alert
  lib/limit.js          Rate limits for sign-up, join codes, assistant (never SOS)
  routes/auth.js        Guest, register and log in for pilgrims, volunteers and admins
  routes/staff.js       Admin only: approve, reject, disable, enable volunteers
  routes/groups.js      Join codes, membership, coarse position sharing
  routes/sos.js         The safety-critical path — read this one first
  routes/map.js         Graph download, crowd flags, server-side routing
  routes/content.js     Schedule and notices
  routes/assistant.js   Mitra on the server: same engine + optional model help
  lib/mitra-llm.js      Model helpers: pick an intent from a fixed list, rephrase
  db/store.js           JSON-file storage (swap for Postgres; same interface)
  db/schema.sql         The real Postgres + PostGIS model this maps onto
  db/seed.js            Demo staff accounts, schedule, notices

public/
  index.html            Landing page with the three entry points
  sw.js                 Service worker — cache-first shell
  shared/mela-map.js    The ground as a graph: landmarks and paths
  shared/routing.js     Crowd-aware Dijkstra + landmark directions
  shared/mitra.js       Mitra's engine: understanding, memory, answers (hi/mr/en)
  shared/api.js         Transport + the durable outbox
  shared/i18n.js        All interface strings
  shared/mapview.js     SVG map renderer (offline fallback)
  shared/livemap.js     Live map: Leaflet tiles + the graph on top
  shared/guidance.js    Turn-by-turn engine (pure, unit-tested)
  shared/location.js    GPS and simulated-walk position sources
  shared/mapswitch.js   Live-or-drawn map switch for the consoles
  shared/dom.js         Escaping, live socket, toasts, dialogs
  shared/icons.js       The icon set and place colours used on every screen
  shared/theme.js       Light / dark / automatic switch (shared by every screen)
  shared/theme-boot.js  Applies the saved theme before the page paints
  shared/styles.css     The visual system
  app/                  Pilgrim app
  volunteer/            Volunteer queue
  admin/                Control room

test/
  api.test.mjs          API tests (npm test)
  guidance.test.mjs     Navigation engine tests (npm test)
  mitra.test.mjs        Mitra engine and model-helper tests (npm test)
  browser.e2e.mjs       Headless-browser end-to-end test (npm run test:browser)
```

`shared/` is imported by both the browser and the server. That is deliberate:
the phone and the server route with the same code, so an answer cannot differ
between them, and the assistant physically cannot invent a route.

---

## Design decisions worth knowing about

**The SOS path shares almost nothing with the rest of the app.** It does not
depend on the assistant, the map tiles, the sync layer, or being signed in with
a phone number. A bug in the schedule screen cannot reach it.

**Guest sign-in is the primary path, not the fallback.** SMS delivery is worst
exactly when the ground is busiest, so an OTP in front of the panic button is a
single point of failure.

**The outbox writes to disk before it touches the network.** The user is told
"waiting to send" when that is what is happening. A checkmark the app has not
earned is worse than an honest queue.

**Routing minimises time through a crowd, not distance.** A 600 m walk down an
empty lane beats a 200 m shove through a packed ghat approach.

**Directions are landmarks, never street names.** Mela roads are three days old
and are in no basemap.

**Positions are stored as the nearest landmark, not a GPS trail.** There is no
movement-history table, and `schema.sql` says why: reuniting a family needs a
coarse last-known place, and a precise trail of a stranger's movements is a
stalking and trafficking risk with no operational payoff. Sharing is per-member
and revocable in one tap. A volunteer sees an alert's location only while it is
open.

**Join codes avoid `0 O 1 I 5 S`.** They get read aloud, written on wristbands,
and squinted at without reading glasses.

**Crowding is colour *and* line weight *and* dash pattern.** Bright sun, cracked
screens, colour blindness.

**Claims expire.** Two volunteers running to the same person while a third alert
goes unread is the failure mode that kills this feature.

---

## Optional: give Mitra a language model

Everything works without this. If you set an API key, Mitra gets two narrow
upgrades, each with a 2.5-second timeout and a fall back to the offline answer:

- **Understanding odd wording.** When the rules do not understand a message,
  the model may pick ONE intent and one place from fixed lists. The answer is
  then computed by the normal engine; anything off-list is discarded.
- **Natural phrasing** of the computed answer (never for emergencies).

```bash
ANTHROPIC_API_KEY=sk-ant-... npm start
```

The facts are computed **before** the model sees them. It never writes a
route, a place, a time or a phone number. Set `MITRA_MODEL` to
change the model; it has to answer within the 2.5-second budget.

---

## What is real and what is a stub

Be honest about this with anyone you show it to.

| Piece | Status |
|---|---|
| Crowd-aware routing, landmark directions | Real, runs on device and server |
| Offline outbox, idempotency, retry with backoff | Real |
| SOS lifecycle, claim expiry, append-only audit trail | Real |
| Group join codes, coarse position sharing, sharing toggle | Real |
| Offline intent matching in Hindi / Marathi / English | Real |
| Live updates to consoles and app | Real (WebSocket + polling backup) |
| Storage | JSON file. `schema.sql` is the Postgres model to move to |
| Auth token | Random per-user secret, separate from the user id. Staff sessions expire after 12 hours and end on sign-out or when an admin disables the account; pilgrim tokens do not expire |
| Accounts | Real: pilgrims (phone + PIN, or guest), volunteers (phone + password; alerts after admin approval), admins (security key + their own username and password). scrypt hashes, per-account lockout after 8 wrong tries, admin-key lockout after 5 |
| Phone verification | Not done — nothing proves a phone number is yours (no SMS). Fine for a demo; production needs OTP or the mela's own staff directory |
| Map | Real street/satellite tiles (OSM, Esri) under the graph, with a drawn offline fallback. The demo ground's coordinates are illustrative |
| GPS & turn-by-turn | Real, in the pilgrim app (voice in hi/mr/en) and the volunteer queue (guidance to the alert). Re-routes when a path closes. Only the nearest landmark leaves the phone |
| Console live maps | Real: control room clicks paths on the live map, sees crowd-pressure circles and every volunteer; volunteers see alerts, colleagues and their own GPS |
| Map tiles in production | Not solved — the public OSM/Esri servers are fine for a demo, not for a mela. Needs a self-hosted or pre-bundled tile set |
| Push notifications | Volunteers get system notifications for new alerts while the queue is open (even in a background tab). Closed-app push needs FCM plus an SMS fallback |
| Crowd data | Aggregate head-counts from the app, plus manual flags. No CCTV feed |
| Crush prediction | Real maths on real counts, but tuned on guessed capacities — needs calibration against actual ground data |
| Mesh relay | Protocol is real; transport is BroadcastChannel (tabs), not Bluetooth |
| QR encoder | Real, verified bit-for-bit against a reference library |
| Wristband reunification | Real, and audited on every lookup |
| Find-me beacon | Real |
| Skill-based dispatch | Real |

## Before this could be used by anyone

Three of these are not engineering tasks, and they matter more than the code.

1. **A guaranteed responder.** An SOS button with nobody on the other end is
   worse than no button, because it manufactures false assurance. The mela
   administration or police control room has to be on board *before* this
   ships — and if they are, the right architecture is to integrate with their
   existing control room rather than run a parallel one. That decision changes
   the console design substantially, so settle it early.
2. **A security review of the location and missing-person features.** They are
   abusable. The permission model here is a starting point, not a clearance.
3. **Field testing with actual elderly users on actual budget handsets**, on the
   ground, in daylight, with the network degraded. Everything about this
   interface is a hypothesis until then.

Then: real auth, Postgres, push, app distribution small enough to install at the
venue (Android Go, sideloadable, QR posters), pre-bundled offline map tiles, and
load testing against a peak that arrives all at once on a shahi snan morning.
