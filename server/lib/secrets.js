/**
 * Passwords, PINs and the admin security key.
 *
 * Nothing secret is ever stored as given: everything goes through scrypt with
 * a random salt, and is compared in constant time. The plain values exist
 * only in the person's head — or, for the demo accounts and the first admin
 * security key, in a local credentials file printed once at first start.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { raw, all, update, flush, dataFile } from '../db/store.js';

const scrypt = promisify(crypto.scrypt);
const KEYLEN = 64;

export async function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(secret), salt, KEYLEN);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function hashSecretSync(secret) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(secret), salt, KEYLEN);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifySecret(secret, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt$') || secret == null) return false;
  const [, salt, expected] = stored.split('$');
  const got = await scrypt(String(secret), Buffer.from(salt, 'base64'), KEYLEN);
  const want = Buffer.from(expected, 'base64');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** Readable, hard to guess: KM-7Q4X-PW2N-H8TD (no 0/O/1/I/5/S). */
function generateKey(groups = 3) {
  const alphabet = 'ACDEFGHJKLMNPQRTUVWXY2346789';
  const part = () => Array.from(crypto.randomBytes(4), (b) => alphabet[b % alphabet.length]).join('');
  return ['KM', ...Array.from({ length: groups }, part)].join('-');
}

function generatePassword() {
  return crypto.randomBytes(9).toString('base64url');
}

/**
 * The admin security key. Set KM_ADMIN_KEY to choose it; otherwise one is
 * generated at first start, stored only as a hash, and shown once.
 */
export async function verifyAdminKey(key) {
  if (!key) return false;
  const fromEnv = process.env.KM_ADMIN_KEY;
  if (fromEnv) {
    const a = crypto.createHash('sha256').update(String(key).trim()).digest();
    const b = crypto.createHash('sha256').update(fromEnv).digest();
    return crypto.timingSafeEqual(a, b);
  }
  return verifySecret(String(key).trim(), raw().secrets?.adminKeyHash);
}

/** Demo volunteer phone numbers, by seeded id. */
export const DEMO_PHONES = {
  vol_sunita: '9000000001',
  vol_imran: '9000000002',
  vol_lata: '9000000003',
  vol_ramesh: '9000000004',
  vol_fatima: '9000000005',
  vol_arjun: '9000000006',
  vol_kavita: '9000000007',
  vol_gurpreet: '9000000008',
};

/**
 * Run at start-up. Makes sure there is an admin security key and that the
 * seeded demo staff can actually log in, and writes anything newly created
 * to FIRST-RUN-CREDENTIALS.txt next to the data file (gitignored).
 */
export function ensureSecrets({ quiet = false } = {}) {
  const db = raw();
  db.secrets ??= {};
  const created = [];

  if (!process.env.KM_ADMIN_KEY && !db.secrets.adminKeyHash) {
    const key = generateKey();
    db.secrets.adminKeyHash = hashSecretSync(key);
    created.push(`Admin security key:      ${key}`);
  }

  const staff = all('users').filter((u) => (u.role === 'volunteer' || u.role === 'admin') && !u.passwordHash);
  if (staff.length) {
    const volPassword = process.env.KM_DEMO_PASSWORD || generatePassword();
    const adminPassword = process.env.KM_ADMIN_PASSWORD || generatePassword();
    let volunteersCreated = false;
    for (const u of staff) {
      if (u.role === 'volunteer') {
        update('users', u.id, {
          phone: u.phone ?? DEMO_PHONES[u.id] ?? null,
          passwordHash: hashSecretSync(volPassword),
          status: 'active',
          token: null,
        });
        volunteersCreated = true;
      } else {
        update('users', u.id, {
          username: u.username ?? 'admin',
          passwordHash: hashSecretSync(adminPassword),
          status: 'active',
          token: null,
        });
        created.push(`Admin login:             username "${u.username ?? 'admin'}", password ${process.env.KM_ADMIN_PASSWORD ? '(from KM_ADMIN_PASSWORD)' : adminPassword}`);
      }
    }
    if (volunteersCreated) {
      created.push(`Demo volunteers:         phone 9000000001 … 9000000008, password ${process.env.KM_DEMO_PASSWORD ? '(from KM_DEMO_PASSWORD)' : volPassword}`);
    }
  }

  flush();
  if (!created.length) return;

  const file = path.join(path.dirname(dataFile()), 'FIRST-RUN-CREDENTIALS.txt');
  const text = [
    'Kumbh-a-Mitra — credentials created on first start',
    `(${new Date().toISOString()})`,
    '',
    ...created,
    '',
    'Keep this file private. Delete it once you have stored these somewhere safe.',
    'Set KM_ADMIN_KEY to choose your own security key.',
    '',
  ].join('\n');
  try { fs.appendFileSync(file, `${text}\n`); } catch { /* still printed below */ }
  if (!quiet) {
    console.log('');
    console.log('  First start — credentials created (also saved to');
    console.log(`  ${file}):`);
    for (const line of created) console.log(`    ${line}`);
    console.log('');
  }
}
