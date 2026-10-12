import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { seedIfEmpty } from './db/seed.js';
import { flush, all } from './db/store.js';
import { attachRealtime, connectionCount } from './realtime.js';
import { authenticate, ensureTokens } from './lib/auth.js';
import { ensureSecrets, normalizeKey } from './lib/secrets.js';
import { sosLimiter } from './lib/rate-limit.js';

import authRoutes from './routes/auth.js';
import groupRoutes from './routes/groups.js';
import sosRoutes from './routes/sos.js';
import mapRoutes from './routes/map.js';
import contentRoutes from './routes/content.js';
import assistantRoutes from './routes/assistant.js';
import crowdRoutes from './routes/crowd.js';
import staffRoutes from './routes/staff.js';
import messageRoutes from './routes/messages.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, '..', 'public');
const PORT = process.env.PORT || 3000;
const QUIET = process.env.KM_QUIET === '1';

// Map tile servers the live map may load images from. Street tiles from
// OpenStreetMap, satellite from Esri. Both are fine for a prototype; a real
// deployment must run its own tile server or ship pre-bundled tiles (OSM's
// usage policy forbids heavy use, and the ground has no signal anyway).
const TILE_HOSTS = ['https://tile.openstreetmap.org', 'https://server.arcgisonline.com'];

seedIfEmpty();
ensureTokens();
ensureSecrets({ quiet: QUIET });

const app = express();
app.disable('x-powered-by');
// Behind a host's proxy (Render, Railway…) the visitor's address is in
// X-Forwarded-For; without this every phone would share the proxy's address
// and one rate limit.
if (process.env.RENDER || process.env.KM_TRUST_PROXY) app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));

/**
 * Baseline security headers, without pulling in a dependency.
 *
 * The CSP allows inline styles (the pages use them heavily) but no inline or
 * third-party scripts, which is what actually stops an injected name or notice
 * from running code. `connect-src` includes ws/wss for the live socket, and
 * the Anthropic call happens server-side, so the browser never needs it.
 */
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  // Geolocation is allowed for the live map; the phone's GPS fix never leaves
  // the device — only the nearest landmark is sent (see app.js, useGps).
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(self), microphone=(self)');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      // Tile hosts appear in connect-src too: the service worker fetches
      // tiles to cache them, and a worker's fetch counts as a connection.
      `img-src 'self' data: ${TILE_HOSTS.join(' ')}; connect-src 'self' ws: wss: ${TILE_HOSTS.join(' ')}; ` +
      "frame-ancestors 'none'; base-uri 'self'"
  );
  next();
});

// Tiny request log. Useful while you are learning what the app is doing.
app.use((req, _res, next) => {
  if (!QUIET && req.path.startsWith('/api')) {
    console.log(`  ${req.method} ${req.path}`);
  }
  next();
});

app.use(authenticate);

app.get('/api/health', (_req, res) =>
  res.json({
    ok: true,
    at: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    liveConnections: connectionCount(),
    openAlerts: all('alerts').filter((a) => a.status === 'open').length,
    // Where the security key comes from — never the key. 'generated' on a host
    // means KM_ADMIN_KEY was left empty and nobody knows the key.
    securityKey: process.env.KM_ADMIN_KEY ? { source: 'KM_ADMIN_KEY', length: normalizeKey(process.env.KM_ADMIN_KEY).length } : { source: 'generated' },
  })
);

app.use('/api/auth', authRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/sos', sosLimiter, sosRoutes);
app.use('/api/map', mapRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/assistant', assistantRoutes);
app.use('/api/crowd', crowdRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/messages', messageRoutes);

app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'not_found', path: req.path });
  }
  next();
});

// The Android app (a Trusted Web Activity) opens full-screen only when this
// site vouches for it: the app's package name and signing-key fingerprint.
app.get('/.well-known/assetlinks.json', (_req, res) => {
  const fingerprints = String(process.env.KM_ANDROID_SHA256 ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  res.json(fingerprints.length ? [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: process.env.KM_ANDROID_PACKAGE || 'com.kumbhamitra.app', sha256_cert_fingerprints: fingerprints },
  }] : []);
});

// Leaflet is served from our own origin, never a CDN: the map code has to load
// on a phone with no signal, and the service worker can only cache what we serve.
app.use('/vendor/leaflet', express.static(path.join(HERE, '..', 'node_modules', 'leaflet', 'dist'), {
  maxAge: '7d',
  immutable: true,
}));

app.use(
  express.static(PUBLIC_DIR, {
    setHeaders(res, filePath) {
      // Code and pages always revalidate (cheap with ETags), so a fix reaches
      // phones on the next load instead of whenever a browser cache expires.
      // The service worker in particular must never be served stale, or users
      // get stuck on an old build with no way out.
      if (/\.(html|js|css|json)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
      else res.setHeader('Cache-Control', 'public, max-age=86400');
    },
  })
);

app.use((err, _req, res, _next) => {
  // Malformed JSON from a client is their problem, not a server error.
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'bad_json', message: 'Request body is not valid JSON.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'too_large' });
  }
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

const server = http.createServer(app);
attachRealtime(server);

server.listen(PORT, () => {
  if (QUIET) return;
  console.log('');
  console.log('  Kumbh-a-Mitra is running.');
  console.log('');
  console.log(`  Start here      http://localhost:${PORT}/`);
  console.log(`  Pilgrim app     http://localhost:${PORT}/app/`);
  console.log(`  Volunteers      http://localhost:${PORT}/volunteer/login.html`);
  console.log(`  Control room    http://localhost:${PORT}/admin/login.html   (needs the security key)`);
  console.log('');
  console.log('  Open the pilgrim app and the volunteer queue side by side,');
  console.log('  then press the red button. Ctrl+C to stop.');
  console.log('');
});

/**
 * Writes are debounced, so an alert raised in the last 120 ms before Ctrl+C
 * would otherwise exist only in memory. Flush before exiting.
 */
function shutdown(signal) {
  if (!QUIET) console.log(`\n  ${signal} — saving and stopping.`);
  try { flush(); } catch (err) { console.error('  final save failed:', err.message); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
