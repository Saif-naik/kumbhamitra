/**
 * Realtime fan-out.
 *
 * Stands in for the Redis pub/sub layer in the architecture. The interface is
 * `publish(topic, payload)` so moving to Redis later means changing this file
 * and nothing else.
 *
 * Note what it does NOT do: the websocket is an accelerator, never the
 * delivery guarantee. Volunteers also poll `GET /api/sos` on an interval, so a
 * dropped socket costs seconds of latency rather than a missed alert. On a
 * congested mela network, sockets drop constantly.
 */

import { WebSocketServer } from 'ws';

const clients = new Set();

// Only topics something actually publishes. An unbounded set lets one client
// grow server memory with junk subscriptions.
const TOPICS = new Set(['sos', 'flags', 'notices', 'beacon', 'crowd', 'reunion', 'staff', 'messages', 'board']);

export function attachRealtime(server) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

  wss.on('connection', (socket) => {
    const client = { socket, topics: new Set(['notices']), alive: true };
    socket.on('pong', () => { client.alive = true; });
    clients.add(client);

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'subscribe' && Array.isArray(msg.topics)) {
          msg.topics.map(String).filter((t) => TOPICS.has(t)).forEach((t) => client.topics.add(t));
          socket.send(JSON.stringify({ type: 'subscribed', topics: [...client.topics] }));
        }
      } catch {
        /* a malformed frame is not worth killing the connection over */
      }
    });

    socket.on('close', () => clients.delete(client));
    socket.on('error', () => clients.delete(client));

    socket.send(JSON.stringify({ type: 'hello', at: Date.now() }));
  });

  // Heartbeat doubles as a reaper. A phone that walked out of coverage never
  // sends a close frame, and without this its socket would sit in the set
  // (and in connectionCount) forever.
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        clients.delete(client);
        try { client.socket.terminate(); } catch { /* already gone */ }
        continue;
      }
      client.alive = false;
      try { client.socket.ping(); } catch { /* reaped next round */ }
    }
    publish('heartbeat', { at: Date.now() });
  }, 25_000);
  heartbeat.unref();
}

export function publish(topic, payload) {
  const frame = JSON.stringify({ type: topic, payload, at: Date.now() });
  for (const client of clients) {
    if (topic === 'heartbeat' || client.topics.has(topic)) {
      if (client.socket.readyState === 1) client.socket.send(frame);
    }
  }
}

export function connectionCount() {
  return clients.size;
}
