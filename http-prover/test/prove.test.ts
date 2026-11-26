import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeNetwork, solanaIat, SUNSPOT_PW_LEN } from '../src/attestation.js';
import { configFromEnv, solanaEnabled, sunspotCcsPath } from '../src/config.js';
import { PUBLIC_INPUT_COUNT, PUBLIC_INPUT_IAT } from '../src/identity.js';
import { SunspotDaemon } from '../src/sunspotd.js';

test('defaults to Ethereum and accepts only Ethereum or Solana networks', () => {
  assert.equal(normalizeNetwork(undefined), 'ethereum');
  assert.equal(normalizeNetwork('SOLANA'), 'solana');
  assert.equal(normalizeNetwork('ethereum'), 'ethereum');
  assert.throws(() => normalizeNetwork('polygon'), /network must be one of/);
  assert.throws(() => normalizeNetwork(2), /network must be one of/);
});

test('Solana proving is on only when a proving key is configured', () => {
  const base = { PRIVY_PUBLIC_KEY_PEM_FILE: 'unused' };
  assert.equal(solanaEnabled(configFromEnv(base)), false);
  assert.equal(solanaEnabled(configFromEnv({ ...base, SUNSPOT_PK_PATH: '/keys/x.pk' })), true);
  const fetched = configFromEnv({ ...base, SUNSPOT_PK_URL: 'https://example.invalid/x.pk', SUNSPOT_PK_SHA256: '0xABCD' });
  assert.equal(solanaEnabled(fetched), true);
  assert.equal(fetched.sunspotPkPath, './data/sunspot/pvium_identity.pk');
  assert.equal(fetched.sunspotPkSha256, 'abcd');
});

/** A Sunspot public witness with the given iat: 12-byte header, 11 big-endian 32-byte fields. */
function publicWitness(iat: number): Buffer {
  const pw = Buffer.alloc(SUNSPOT_PW_LEN);
  pw.writeUInt32BE(PUBLIC_INPUT_COUNT, 0);
  pw.writeBigUInt64BE(BigInt(PUBLIC_INPUT_COUNT), 4);
  pw.writeBigUInt64BE(BigInt(iat), 12 + PUBLIC_INPUT_IAT * 32 + 24);
  return pw;
}

test('reads the iat out of a Sunspot public witness and rejects other layouts', () => {
  assert.equal(solanaIat(publicWitness(1789240094)), 1789240094);
  assert.throws(() => solanaIat(publicWitness(1).subarray(1)), /public witness size/);
  const badHeader = publicWitness(1);
  badHeader.writeUInt32BE(10, 0);
  assert.throws(() => solanaIat(badHeader), /public witness header/);
});

test('sunspotd client: starts the daemon once, matches responses by id, fails pending requests when it dies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pvium-sunspotd-test-'));
  try {
    // A stand-in daemon speaking the protocol: ready line, then one response per request line.
    const daemon = join(dir, 'sunspotd.mjs');
    await writeFile(daemon, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
if (args[args.indexOf('--pk') + 1] !== ${JSON.stringify(join(dir, 'k.pk'))}) { console.log(JSON.stringify({ ready: false, error: 'wrong pk' })); process.exit(1); }
if (args[args.indexOf('--ccs') + 1] !== ${JSON.stringify(join(dir, 'pvium_identity.42.ccs'))}) { console.log(JSON.stringify({ ready: false, error: 'ccs not cached next to the key by ACIR hash: ' + args.join(' ') })); process.exit(1); }
console.log(JSON.stringify({ ready: true, constraints: 7, publicInputs: 11, loadMs: 1, ccs: 'read' }));
for await (const line of createInterface({ input: process.stdin })) {
  const req = JSON.parse(line);
  if (req.ping) { console.log(JSON.stringify({ id: req.id, pong: true })); continue; }
  if (req.witness === Buffer.from('die').toString('base64')) process.exit(3);
  const w = Buffer.from(req.witness, 'base64').toString();
  console.log(JSON.stringify({ id: req.id, proof: Buffer.from('proof:' + w).toString('base64'), publicWitness: Buffer.from('pw:' + w).toString('base64'), ms: 5 }));
}
`);
    await chmod(daemon, 0o755);
    await writeFile(join(dir, 'acir.json'), '{"noir_version":"t","hash":"42","abi":{},"bytecode":""}');
    const cfg = {
      ...configFromEnv({ PRIVY_PUBLIC_KEY_PEM_FILE: 'unused', SUNSPOT_PK_PATH: join(dir, 'k.pk') }),
      sunspotdBin: daemon, sunspotAcirPath: join(dir, 'acir.json'), workDir: dir,
    };
    const client = new SunspotDaemon(cfg);
    assert.equal(sunspotCcsPath(cfg), join(dir, 'pvium_identity.42.ccs'));
    assert.equal(sunspotCcsPath({ ...cfg, sunspotCcsPath: '/x/y.ccs' }), '/x/y.ccs');
    const info = await client.start();
    assert.equal(info.constraints, 7);
    assert.equal(info.ccs, 'read');
    assert.equal(await client.start(), info, 'second start is a no-op');
    const [a, b] = await Promise.all([client.prove(Buffer.from('w1')), client.prove(Buffer.from('w2'))]);
    assert.equal(a.proof.toString(), 'proof:w1');
    assert.equal(b.publicWitness.toString(), 'pw:w2');
    // The daemon dies mid-request: that request fails, the next one restarts the daemon.
    await assert.rejects(() => client.prove(Buffer.from('die')), /sunspotd exited/);
    assert.equal(client.running, false);
    const c = await client.prove(Buffer.from('w3'));
    assert.equal(c.proof.toString(), 'proof:w3');
    await client.close();
    assert.equal(client.running, false);

    const wrong = new SunspotDaemon({ ...cfg, sunspotPkPath: join(dir, 'other.pk') });
    await assert.rejects(() => wrong.start(), /wrong pk/);
    await wrong.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
