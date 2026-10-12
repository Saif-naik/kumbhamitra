/**
 * Static checks on the browser code — fast, no server, no browser.
 *
 *  - every `import { x } from '...'` names a file that exists and exports x
 *  - every #id a page script looks up exists in its page (or is created by it)
 *  - no page has an inline <script>: the Content-Security-Policy blocks them
 *  - every file the service worker precaches exists
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'public');
const read = (p) => fs.readFileSync(p, 'utf8');

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return jsFiles(p);
    return d.name.endsWith('.js') && d.name !== 'sw.js' ? [p] : [];
  });
}

function exportsOf(file) {
  const src = read(file);
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) m[1].split(',').forEach((n) => names.add(n.trim().split(/\s+as\s+/).pop()));
  return names;
}

test('every import resolves to a real export', () => {
  const problems = [];
  for (const file of jsFiles(pub)) {
    for (const m of read(file).matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
      const spec = m[2];
      const target = spec.startsWith('/') ? path.join(pub, spec) : path.resolve(path.dirname(file), spec);
      if (!fs.existsSync(target)) { problems.push(`${path.relative(root, file)}: missing module ${spec}`); continue; }
      const have = exportsOf(target);
      for (const name of m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
        if (!have.has(name)) problems.push(`${path.relative(root, file)}: ${spec} has no export "${name}"`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('every #id a page script uses exists, and no page has an inline script', () => {
  const pages = {
    'app/app.js': 'app/index.html',
    'app/wristband.js': 'app/wristband.html',
    'volunteer/volunteer.js': 'volunteer/index.html',
    'admin/queue.js': 'admin/queue.html',
    'admin/admin.js': 'admin/index.html',
  };
  const problems = [];
  for (const [js, html] of Object.entries(pages)) {
    const src = read(path.join(pub, js));
    const page = read(path.join(pub, html));
    const ids = new Set([...page.matchAll(/id="([^"]+)"/g), ...src.matchAll(/id="([^"$]+)"/g)].map((m) => m[1]));
    const used = new Set([
      ...[...src.matchAll(/\$\('#([\w-]+)/g)].map((m) => m[1]),
      ...[...src.matchAll(/getElementById\('([\w-]+)'\)/g)].map((m) => m[1]),
    ]);
    for (const id of used) if (!ids.has(id)) problems.push(`${js}: #${id} is not in ${html}`);
  }
  for (const html of ['index.html', 'volunteer/login.html', 'admin/login.html', ...Object.values(pages)]) {
    if (/<script(?![^>]*\bsrc=)[^>]*>/.test(read(path.join(pub, html)))) problems.push(`${html}: inline <script>`);
  }
  assert.deepEqual(problems, []);
});

test('every file the service worker precaches exists', () => {
  const sw = read(path.join(pub, 'sw.js'));
  const shell = [...sw.slice(sw.indexOf('const SHELL'), sw.indexOf('];', sw.indexOf('const SHELL'))).matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(shell.length > 10);
  const missing = shell.filter((p) => {
    if (p === '/' || p.endsWith('/')) return !fs.existsSync(path.join(pub, p, 'index.html'));
    if (p.startsWith('/vendor/leaflet/')) return !fs.existsSync(path.join(root, 'node_modules/leaflet/dist', p.replace('/vendor/leaflet/', '')));
    return !fs.existsSync(path.join(pub, p));
  });
  assert.deepEqual(missing, []);
});
