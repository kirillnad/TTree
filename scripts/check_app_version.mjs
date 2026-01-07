import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const CLIENT_DIR = path.join(REPO_ROOT, 'client');
const SW_PATH = path.join(CLIENT_DIR, 'uploads-sw.js');

async function listFilesRecursive(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    const entries = await fs.readdir(cur, { withFileTypes: true });
    for (const ent of entries) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!ent.isFile()) continue;
      out.push(p);
    }
  }
  return out;
}

function isClientBuildInput(filePath) {
  const rel = path.relative(CLIENT_DIR, filePath).replaceAll(path.sep, '/');
  if (!rel || rel.startsWith('..')) return false;
  if (rel.startsWith('uploads/')) return false;
  if (rel.endsWith('.map')) return false;
  return (
    rel.endsWith('.js') ||
    rel.endsWith('.css') ||
    rel.endsWith('.html') ||
    rel.endsWith('.webmanifest') ||
    rel.endsWith('.ttf') ||
    rel.endsWith('.woff') ||
    rel.endsWith('.woff2') ||
    rel.endsWith('.png') ||
    rel.endsWith('.ico') ||
    rel.endsWith('.svg') ||
    rel.endsWith('.wasm') ||
    rel.endsWith('.data')
  );
}

function normalizeUploadsSwForHash(src) {
  return String(src)
    .replace(/const APP_VERSION = \d+\s*;/, 'const APP_VERSION = __APP_VERSION__;')
    .replace(/const APP_BUILD = ['"][^'"]+['"]\s*;/, "const APP_BUILD = '__APP_BUILD__';");
}

async function computeBuildId() {
  const files = (await listFilesRecursive(CLIENT_DIR)).filter(isClientBuildInput);
  files.sort();
  const hash = crypto.createHash('sha256');
  for (const p of files) {
    const rel = path.relative(CLIENT_DIR, p).replaceAll(path.sep, '/');
    hash.update(rel);
    hash.update('\0');
    if (rel === 'uploads-sw.js') {
      const src = await fs.readFile(p, 'utf8');
      hash.update(normalizeUploadsSwForHash(src));
    } else {
      const buf = await fs.readFile(p);
      hash.update(buf);
    }
    hash.update('\0');
  }
  const digest = hash.digest();
  const hex40 = digest.subarray(0, 5).toString('hex');
  const n = BigInt(`0x${hex40}`);
  return n.toString(36);
}

function extractCurrentSwBuildId(src) {
  const m = src.match(/const APP_BUILD = ['"]([^'"]+)['"]\s*;/);
  return m ? String(m[1]) : '';
}

const expected = await computeBuildId();
const swSrc = await fs.readFile(SW_PATH, 'utf8');
const current = extractCurrentSwBuildId(swSrc);

if (!current) {
  // eslint-disable-next-line no-console
  console.error('client/uploads-sw.js: APP_VERSION not found');
  process.exit(2);
}

if (current !== expected) {
  // eslint-disable-next-line no-console
  console.error(
    `APP_VERSION is stale: current=${current} expected=${expected}. Run: npm run gen:app-version`,
  );
  process.exit(1);
}

// eslint-disable-next-line no-console
console.log('ok', current);
