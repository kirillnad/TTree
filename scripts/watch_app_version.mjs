import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const CLIENT_DIR = path.join(REPO_ROOT, 'client');

const IGNORE_BASENAME = 'uploads-sw.js';
const DEBOUNCE_MS = 400;
const SELF_WRITE_IGNORE_MS = 1500;

let pendingTimer = null;
let running = false;
let ignoreUntil = 0;

function log(...args) {
  // eslint-disable-next-line no-console
  console.log('[watch:app-version]', ...args);
}

function listDirsRecursive(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    out.push(cur);
    const entries = fs.readdirSync(cur, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      stack.push(path.join(cur, ent.name));
    }
  }
  return out;
}

function shouldIgnoreEvent(filePath) {
  const now = Date.now();
  if (now < ignoreUntil) return true;
  if (!filePath) return false;
  const base = path.basename(filePath);
  // We *do* want manual edits to uploads-sw.js to bump the version,
  // but we must ignore the write that our generator itself performs (self loop).
  if (base === IGNORE_BASENAME && now < ignoreUntil) return true;
  return false;
}

function runGen() {
  if (running) return;
  running = true;
  ignoreUntil = Date.now() + SELF_WRITE_IGNORE_MS;

  const child = spawn(process.execPath, ['scripts/gen_app_version.mjs', '--write'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += String(d);
  });
  child.stderr.on('data', (d) => {
    stderr += String(d);
  });

  child.on('exit', (code) => {
    running = false;
    if (code === 0) {
      const line = stdout.trim().split('\n').slice(-1)[0] || '';
      log('gen ok', line);
      return;
    }
    log('gen failed', { code, stderr: stderr.trim() || stdout.trim() });
  });
}

function scheduleRun(filePath) {
  if (shouldIgnoreEvent(filePath)) return;
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    runGen();
  }, DEBOUNCE_MS);
}

function watchDir(dir) {
  const watcher = fs.watch(dir, { persistent: true }, (eventType, filename) => {
    const filePath = filename ? path.join(dir, String(filename)) : '';
    scheduleRun(filePath);
  });
  watcher.on('error', (err) => {
    log('watch error', { dir, message: err?.message || String(err) });
  });
  return watcher;
}

log('start', { dir: CLIENT_DIR });
const dirs = listDirsRecursive(CLIENT_DIR);
dirs.forEach(watchDir);
log('watching', { dirs: dirs.length });

