import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, '..');
const entry = path.join(repoRoot, 'client', 'outline', 'tiptap_bundle_entry.js');
const outFile = path.join(repoRoot, 'client', 'outline', 'tiptap.bundle.js');

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

// eslint-disable-next-line no-console
console.log(`Built ${path.relative(repoRoot, outFile)}`);

