/**
 * Mesh relay — carrying an SOS on somebody else's phone.
 *
 * The problem this exists for: at a mela the network does not fail by going
 * away, it fails by becoming congested. Two hundred thousand handsets in one
 * square kilometre, all camped on the same few towers. Your phone shows full
 * bars and nothing moves. That is precisely the moment someone presses the red
 * button, and a queued alert that waits for a tower that will not free up for
 * another forty minutes is a queued alert that is useless.
 *
 * But the person standing four metres away often has a working connection —
 * different carrier, different sector, better angle, a spare band. So instead
 * of waiting, the phone shouts its alert to whatever devices are nearby and
 * asks them to carry it. Any one of them that can reach the server posts it,
 * then shouts back a receipt so the origin phone can stop asking.
 *
 * WHAT THIS IS HONESTLY: on a real handset the transport is Bluetooth LE
 * advertisements or Wi-Fi Aware, which a browser cannot open. Here the
 * transport is BroadcastChannel, which reaches other tabs of this app on the
 * same machine. The protocol on top — discovery, hop counting, carrier
 * election, receipts, loop prevention, the refusal to carry anything but an
 * SOS — is the real thing and would sit unchanged on top of BLE. Swap the four
 * functions at the bottom of this file and nothing above them changes.
 *
 * WHAT IT DELIBERATELY WILL NOT DO: relay anything except an SOS. Not chat,
 * not location, not schedule data. A mesh that carries arbitrary payloads
 * between strangers' phones is a surveillance and malware surface, and none of
 * the rest of the app is worth that. The payload is also capped and the
 * carrier never reads the contents — it posts them and forgets them.
 */

const CHANNEL = 'km-mesh-v1';
const MAX_HOPS = 3;
const BEACON_MS = 4000;
const PEER_TIMEOUT_MS = 12_000;

/**
 * One id per tab, kept across reloads of that tab.
 *
 * In the browser demo each tab stands in for a separate phone. Keeping the id
 * in localStorage gave every tab the same id, and since a device ignores its
 * own messages, tabs never heard each other and nothing was ever relayed. On
 * a real handset there is one app instance, so per-tab is per-device.
 */
const deviceId = (() => {
  const make = () => `dev_${Math.random().toString(36).slice(2, 10)}`;
  try {
    let id = sessionStorage.getItem('km.deviceId');
    if (!id) {
      id = make();
      sessionStorage.setItem('km.deviceId', id);
    }
    return id;
  } catch {
    return make();
  }
})();

export const mesh = {
  deviceId,
  peers: new Map(),          // deviceId -> { lastSeen, online }
  carried: new Set(),        // idempotency keys this device has already posted
  onRelayed: null,           // called when something we originated got through
  onCarried: null,           // called when we carried someone else's alert
  onPeersChanged: null,
};

let channel = null;
let selfOnline = false;
let poster = null;           // injected: (path, payload) => Promise

/* ------------------------------------------------------------ transport -- */
/* Replace these four with BLE / Wi-Fi Aware on a real handset.              */

function openTransport(onMessage) {
  if (typeof BroadcastChannel === 'undefined') return null;
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = (event) => onMessage(event.data);
  return ch;
}

function send(message) {
  if (!channel) return;
  channel.postMessage({ ...message, from: deviceId, at: Date.now() });
}

function closeTransport() {
  channel?.close();
  channel = null;
}

/* ------------------------------------------------------------- protocol -- */

function prunePeers() {
  const now = Date.now();
  let changed = false;
  for (const [id, peer] of mesh.peers) {
    if (now - peer.lastSeen > PEER_TIMEOUT_MS) {
      mesh.peers.delete(id);
      changed = true;
    }
  }
  if (changed) mesh.onPeersChanged?.(peerSummary());
}

function peerSummary() {
  const peers = [...mesh.peers.values()];
  return {
    count: peers.length,
    withNetwork: peers.filter((p) => p.online).length,
  };
}

function handle(message) {
  if (!message || message.from === deviceId) return;

  const peer = mesh.peers.get(message.from) ?? {};
  mesh.peers.set(message.from, { ...peer, lastSeen: Date.now(), online: Boolean(message.online) });
  mesh.onPeersChanged?.(peerSummary());

  if (message.type === 'hello') {
    send({ type: 'hello-back', online: selfOnline });
    return;
  }

  if (message.type === 'carry-request') {
    carryForSomeoneElse(message);
    return;
  }

  if (message.type === 'carry-receipt') {
    mesh.onRelayed?.(message.idempotencyKey, {
      alertId: message.alertId,
      carriedBy: message.from,
      hops: message.hops,
    });
    return;
  }
}

/**
 * Someone nearby cannot reach the server and has asked for help.
 * We only carry it if we ourselves have a working connection, and we only ever
 * carry an SOS.
 */
async function carryForSomeoneElse(message) {
  const { payload, idempotencyKey, hops = 0 } = message;

  if (!selfOnline) return;                       // we are no better off than they are
  if (hops >= MAX_HOPS) return;                  // stop it circulating forever
  if (mesh.carried.has(idempotencyKey)) return;  // we already did this one
  if (message.kind !== 'sos') return;            // nothing else gets a free ride
  if (!payload?.idempotencyKey) return;

  mesh.carried.add(idempotencyKey);

  try {
    const data = await poster('/api/sos', {
      ...payload,
      relay: { hops: hops + 1, carriedBy: deviceId },
    });
    send({
      type: 'carry-receipt',
      idempotencyKey,
      alertId: data?.alert?.id ?? null,
      hops: hops + 1,
      online: selfOnline,
    });
    mesh.onCarried?.({ idempotencyKey, alertId: data?.alert?.id ?? null });
  } catch {
    // Our connection turned out to be no good either. Drop the claim so
    // another phone can pick it up on the next beacon.
    mesh.carried.delete(idempotencyKey);
  }
}

/** Ask the neighbourhood to carry one queued item. */
export function askForCarry(item) {
  if (selfOnline) return;
  send({
    type: 'carry-request',
    kind: item.kind,
    idempotencyKey: item.payload.idempotencyKey,
    payload: item.payload,
    hops: 0,
    online: false,
  });
}

export function setOnline(online) {
  const changed = selfOnline !== online;
  selfOnline = online;
  if (changed) send({ type: 'hello', online: selfOnline });
}

export function peers() {
  return peerSummary();
}

/**
 * @param {(path: string, payload: object) => Promise<any>} postFn
 */
export function startMesh(postFn) {
  poster = postFn;
  channel = openTransport(handle);
  if (!channel) return () => {};

  send({ type: 'hello', online: selfOnline });
  const beacon = setInterval(() => {
    send({ type: 'hello', online: selfOnline });
    prunePeers();
  }, BEACON_MS);

  window.addEventListener('pagehide', closeTransport);
  return () => { clearInterval(beacon); closeTransport(); };
}
