// Vault implementation pre-deployment check (compile first: `yarn compile`).
//
//   yarn layout                          # the base P2IDVault still matches storage/P2IDVault.layout.json
//   UPDATE=1 yarn layout                 # rewrite that snapshot from the current build (before the base is deployed)
//   CANDIDATE=MyVaultV2 yarn layout      # check layout, hook ABI and selected source-level hazards
//
// The snapshot is the storage layout of the base P2IDVault every proxy starts on. Once a factory is
// deployed it must never change, and candidates must preserve it. Also compare candidates against any later layouts
// users may upgrade from; passing these checks does not establish behavioral safety.
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { compareLayouts, readContract, validateImplementation, type Layout } from './lib/storageLayout';

const root = join(__dirname, '..');
const SNAPSHOT = join(root, 'storage', 'P2IDVault.layout.json');

function main() {
  const update = process.env.UPDATE === '1';
  const candidate = process.env.CANDIDATE;
  const base = readContract(root, 'src/P2IDVault.sol:P2IDVault');

  if (update) {
    writeFileSync(SNAPSHOT, JSON.stringify(base.layout, null, 2) + '\n');
    console.log(`wrote ${SNAPSHOT} (${base.layout.storage.length} variables)`);
  }
  const snapshot: Layout = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  let failed = false;
  const report = (name: string, findings: { level: string; message: string }[]) => {
    for (const f of findings) console.log(`  ${f.level === 'error' ? 'ERROR' : 'warn '} ${f.message}`);
    const errors = findings.filter((f) => f.level === 'error').length;
    console.log(`${name}: ${errors === 0 ? 'ok' : errors + ' error(s)'}`);
    if (errors) failed = true;
  };
  report('P2IDVault vs snapshot', compareLayouts(snapshot, base.layout));
  if (candidate) {
    const contract = readContract(root, candidate);
    report(`${candidate} vs snapshot`, validateImplementation(snapshot, contract));
    report(`${candidate} vs current P2IDVault`, compareLayouts(base.layout, contract.layout));
  }
  if (failed) process.exit(1);
}
main();
