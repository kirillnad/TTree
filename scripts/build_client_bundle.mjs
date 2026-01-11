import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_DIR = path.join(REPO_ROOT, 'client');
const SRC_DIR = path.join(CLIENT_DIR, 'src');

const entryBoot = path.join(SRC_DIR, 'boot.js');
const entryApp = path.join(SRC_DIR, 'app.js');

async function buildOne({ entry, outfile }) {
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    sourcemap: false,
    treeShaking: true,
    define: {
      'process.env.NODE_ENV': '"production"',
    },
    // Keep TipTap bundle as a separate on-demand module (huge, no shared singletons with app state).
    external: ['/outline/tiptap.bundle.js'],
    logLevel: 'info',
  });
}

await buildOne({ entry: entryBoot, outfile: path.join(CLIENT_DIR, 'boot.js') });
await buildOne({ entry: entryApp, outfile: path.join(CLIENT_DIR, 'app.js') });
