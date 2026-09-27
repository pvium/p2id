// Write per-directory package.json module markers so Node interprets each build correctly,
// regardless of the root package.json "type". Run by `yarn build` after the two tsc passes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  ['dist/esm', { type: 'module' }],
  ['dist/cjs', { type: 'commonjs' }],
];

for (const [dir, pkg] of targets) {
  const abs = join(root, dir);
  mkdirSync(abs, { recursive: true });
  writeFileSync(join(abs, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
}
