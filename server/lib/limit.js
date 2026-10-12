/**
 * Small fixed-window rate limits for the endpoints that can be abused.
 *
 * Never used on the SOS path (see rate-limit.js for why that one only flags).
 *
 * Keys are per USER wherever there is one, not per IP: at a mela thousands
 * of phones sit behind a handful of carrier NAT addresses, and a per-IP limit
 * would lock out a crowd because of one bad actor. Where there is no user
 * yet (guest sign-up) the per-IP ceiling is set high enough to stop a
 * scripted flood without ever touching real people.
 */

const buckets = new Map();

/**
 * @param {{name: string, windowMs: number, max: number, key?: (req) => string,
 *          message?: string, count?: (req, res) => boolean}} options
 *   `count` decides after the response whether this request counts (e.g.
 *   only failed join attempts). Without it, every request counts.
 */
export function limit({ name, windowMs, max, key = (req) => req.user?.id ?? req.ip, message, count }) {
  return (req, res, next) => {
    const id = `${name}:${key(req)}`;
    const now = Date.now();
    let bucket = buckets.get(id);
    if (!bucket || now - bucket.start >= windowMs) {
      bucket = { start: now, hits: 0 };
      buckets.set(id, bucket);
    }
    if (bucket.hits >= max) {
      const retryAfter = Math.ceil((bucket.start + windowMs - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'too_many', retryAfter, message: message ?? 'Too many requests. Please wait a moment.' });
    }
    if (count) {
      res.on('finish', () => { if (count(req, res)) bucket.hits += 1; });
    } else {
      bucket.hits += 1;
    }
    next();
  };
}

/** Forget expired windows so the map cannot grow without bound. */
setInterval(() => {
  const now = Date.now();
  for (const [id, bucket] of buckets) if (now - bucket.start > 60 * 60_000) buckets.delete(id);
}, 10 * 60_000).unref();
