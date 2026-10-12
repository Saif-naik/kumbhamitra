/**
 * Rate limiting for the SOS path.
 *
 * The important design decision: this limiter NEVER returns 429 for an SOS
 * create. A person mashing the panic button is exactly what a panicking person
 * does, and refusing them is unacceptable. Instead, repeat presses from the
 * same device inside the window are absorbed by the idempotency key in
 * routes/sos.js — they collapse into the one alert that already exists.
 *
 * What we do limit is distinct-alert creation per device, which is the only
 * shape that looks like abuse rather than fear.
 */

const buckets = new Map();

const WINDOW_MS = 60_000;
const MAX_DISTINCT_ALERTS = 8;

export function sosLimiter(req, res, next) {
  if (req.method !== 'POST') return next();

  const key = req.user?.id || req.ip;
  const now = Date.now();
  const bucket = buckets.get(key)?.filter((t) => now - t < WINDOW_MS) ?? [];

  req.sosBudget = {
    used: bucket.length,
    max: MAX_DISTINCT_ALERTS,
    // Called by the route only once an alert is genuinely new.
    spend() {
      bucket.push(now);
      buckets.set(key, bucket);
    },
  };

  if (bucket.length >= MAX_DISTINCT_ALERTS) {
    // Still accept it, but flag it for the console so a human decides.
    req.sosSuspect = true;
  }

  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [key, times] of buckets) {
    const live = times.filter((t) => now - t < WINDOW_MS);
    if (live.length) buckets.set(key, live);
    else buckets.delete(key);
  }
}, WINDOW_MS).unref();
