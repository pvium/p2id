import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeNetwork } from '../src/attestation.js';
import { configFromEnv } from '../src/config.js';
import { runSunspot } from '../src/prove.js';

test('defaults to Ethereum and accepts only Ethereum or Solana networks', () => {
  assert.equal(normalizeNetwork(undefined), 'ethereum');
  assert.equal(normalizeNetwork('SOLANA'), 'solana');
  assert.equal(normalizeNetwork('ethereum'), 'ethereum');
  assert.throws(() => normalizeNetwork('polygon'), /network must be one of/);
  assert.throws(() => normalizeNetwork(2), /network must be one of/);
});

test('runs Sunspot with isolated output paths and returns Groth16 artifacts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pvium-sunspot-test-'));
  try {
    const acirPath = join(dir, 'circuit.json');
    const fullAcirPath = join(dir, 'full-circuit.json');
    const ccsPath = join(dir, 'circuit.ccs');
    const pkPath = join(dir, 'circuit.pk');
    const witnessPath = join(dir, 'fixture.pw');
    const sunspotPath = join(dir, 'sunspot.mjs');
    const publicWitness = Buffer.from('sunspot serialized public witness');

    await Promise.all([
      writeFile(acirPath, '{}'),
      writeFile(fullAcirPath, '{"debug_symbols":[]}'),
      writeFile(ccsPath, 'ccs'),
      writeFile(pkPath, 'pk'),
      writeFile(witnessPath, publicWitness),
      writeFile(
        sunspotPath,
        `#!/usr/bin/env node
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const [command, acir, witness, ccs, pk] = process.argv.slice(2);
if (command !== 'prove' || acir !== ${JSON.stringify(fullAcirPath)} ||
    !existsSync(witness) || !existsSync(ccs) || pk !== ${JSON.stringify(pkPath)}) process.exit(2);
const base = ccs.slice(0, -'.ccs'.length);
writeFileSync(base + '.proof', Buffer.from('groth16-proof'));
copyFileSync(${JSON.stringify(witnessPath)}, base + '.pw');
`,
      ),
    ]);
    await chmod(sunspotPath, 0o755);

    const cfg = {
      ...configFromEnv({ PRIVY_PUBLIC_KEY_PEM_FILE: 'unused' }),
      circuitJson: acirPath,
      sunspotBin: sunspotPath,
      sunspotAcirPath: fullAcirPath,
      sunspotCcsPath: ccsPath,
      sunspotPkPath: pkPath,
      workDir: dir,
    };
    const bundle = await runSunspot(cfg, Buffer.from('noirjs-witness'));

    assert.equal(bundle.proof.toString(), 'groth16-proof');
    assert.deepEqual(bundle.publicWitness, publicWitness);
    assert.deepEqual(bundle.publicInputs, publicWitness);
    const remaining = await readdir(dir);
    assert.deepEqual(remaining.sort(), ['circuit.ccs', 'circuit.json', 'circuit.pk', 'fixture.pw', 'full-circuit.json', 'sunspot.mjs']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
