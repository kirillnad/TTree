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
  // Anything under /uploads is user data, not part of the app build.
  if (rel.startsWith('uploads/')) return false;
  // Bundled client sources (not shipped as-is).
  if (rel.startsWith('src/')) return false;
  // Unit tests are not shipped to the browser.
  if (rel.endsWith('.spec.js') || rel.endsWith('.test.js')) return false;
  // Ignore source maps if any.
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
  // Avoid self-referential hashing: ignore the dynamic lines that this script updates.
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
  // 64-bit prefix gives ~13 base36 chars (still short, much lower collision risk).
  const hex64 = digest.subarray(0, 8).toString('hex');
  const n = BigInt(`0x${hex64}`);
  return n.toString(36);
}

function parseSwVersion(src) {
  const vMatch = src.match(/const APP_VERSION = (\d+)\s*;/);
  const bMatch = src.match(/const APP_BUILD = ['"]([^'"]+)['"]\s*;/);
  return {
    version: vMatch ? Number(vMatch[1]) : null,
    build: bMatch ? String(bMatch[1]) : '',
  };
}

async function updateServiceWorkerBuildId(buildId) {
  const src = await fs.readFile(SW_PATH, 'utf8');
  const cur = parseSwVersion(src);
  const currentBuild = cur.build || '';
  const currentVersion = Number.isFinite(cur.version) ? cur.version : null;

  // Only bump the ordinal version if the build hash actually changed.
  const nextVersion = currentBuild && currentBuild === buildId ? currentVersion : (currentVersion ?? 0) + 1;

  let next = src;
  if (/const APP_VERSION = \d+\s*;/.test(next)) {
    next = next.replace(/const APP_VERSION = \d+\s*;/, `const APP_VERSION = ${nextVersion};`);
  } else {
    throw new Error('Failed to update APP_VERSION (numeric) in client/uploads-sw.js');
  }

  if (/const APP_BUILD = ['"][^'"]+['"]\s*;/.test(next)) {
    next = next.replace(/const APP_BUILD = ['"][^'"]+['"]\s*;/, `const APP_BUILD = '${buildId}';`);
  } else {
    throw new Error('Failed to update APP_BUILD in client/uploads-sw.js');
  }
  await fs.writeFile(SW_PATH, next, 'utf8');
  return { buildId, version: nextVersion, changed: currentBuild !== buildId };
}

const args = new Set(process.argv.slice(2));
const write = args.has('--write');

const buildId = await computeBuildId();
// eslint-disable-next-line no-console
console.log(buildId);

if (write) {
  const res = await updateServiceWorkerBuildId(buildId);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(res));
}
