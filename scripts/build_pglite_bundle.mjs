import esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, '..');
const entry = path.join(repoRoot, 'client', 'offline', 'pglite_bundle_entry.js');
const outDir = path.join(repoRoot, 'client', 'offline');
const outFile = path.join(outDir, 'pglite.bundle.js');

await esbuild.build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  sourcemap: false,
  target: ['es2020'],
  minify: true,
  legalComments: 'none',
});

// Copy PGlite runtime assets (wasm + data) so the browser can load them.
// The bundled JS expects these files to be available alongside the served scripts.
const pgliteDist = path.join(repoRoot, 'node_modules', '@electric-sql', 'pglite', 'dist');
await fs.mkdir(outDir, { recursive: true });
await fs.copyFile(path.join(pgliteDist, 'pglite.wasm'), path.join(outDir, 'pglite.wasm'));
await fs.copyFile(path.join(pgliteDist, 'pglite.data'), path.join(outDir, 'pglite.data'));

// eslint-disable-next-line no-console
console.log(`Built ${path.relative(repoRoot, outFile)}`);
