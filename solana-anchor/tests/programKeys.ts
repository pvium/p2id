import { strict as assert } from 'assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { derivePath } from 'ed25519-hd-key';
import { deriveProgramKey, loadProgramKey, PROGRAM_ROLES, programKeyPath, writeProgramKey, type ProgramKeyReleases, type ProgramRole } from '../scripts/lib/programKeys';

describe('deterministic program keys', () => {
  const seed = '07'.repeat(32);
  const manifest: ProgramKeyReleases = {
    stackCircuit: 2,
    programKeyDerivation: { version: 1, releases: { router: 1, policy: 1, implementation: 1 } },
    circuits: { '2': { programKeyReleases: { verifier: 1, zkVerifier: 1 } }, '3': { programKeyReleases: { verifier: 2, zkVerifier: 2 } } },
  };

  it('matches the published SLIP-0010 Ed25519 hardened derivation vector', () => {
    // https://github.com/satoshilabs/slips/blob/master/slip-0010.md#test-vector-1-for-ed25519
    assert.equal(derivePath("m/0'/1'", '000102030405060708090a0b0c0d0e0f').key.toString('hex'),
      'b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2');
  });

  it('pins our path and derived seed against an independent HMAC-SHA512 calculation', () => {
    assert.equal(programKeyPath('sandbox', 'router', 1), "m/44'/501'/7472'/0'/0'/1'");
    assert.equal(Buffer.from(deriveProgramKey(seed, 'sandbox', 'router', 1).secretKey.slice(0, 32)).toString('hex'),
      '98ccc28f1c8d93e79114b2c8482c3202410a406cf5aa7e243676cdc3719af037');
  });

  it('separates every role, environment, release and master seed reproducibly', () => {
    const addresses = new Set<string>();
    for (const environment of ['sandbox', 'production'] as const)
      for (const role of Object.keys(PROGRAM_ROLES) as ProgramRole[])
        for (const release of [1, 2]) {
          const key = deriveProgramKey(seed, environment, role, release);
          assert(key.publicKey.equals(deriveProgramKey(seed, environment, role, release).publicKey));
          addresses.add(key.publicKey.toBase58());
        }
    assert.equal(addresses.size, 20);
    assert(!deriveProgramKey(seed, 'sandbox', 'router', 1).publicKey.equals(deriveProgramKey('08'.repeat(32), 'sandbox', 'router', 1).publicKey));
  });

  it('rejects malformed seeds and invalid release indices', () => {
    for (const invalid of ['', 'secret', 'ff', 'g'.repeat(64)])
      assert.throws(() => deriveProgramKey(invalid, 'sandbox', 'router', 1), /32-byte hex seed/);
    for (const invalid of [0, -1, 1.5, NaN, 0x80000000])
      assert.throws(() => deriveProgramKey(seed, 'sandbox', 'router', invalid), /Program key release/);
  });

  it('requires scoped seeds, preserves legacy IDs when unset, and selects pinned circuit releases', () => {
    const names = ['SOL_PROGRAM_MASTER_SEED', 'SOL_PROGRAM_MASTER_SEED_SANDBOX', 'SOL_PROGRAM_MASTER_SEED_PROD'];
    const saved = names.map((name) => process.env[name]);
    try {
      process.env.SOL_PROGRAM_MASTER_SEED = seed;
      delete process.env.SOL_PROGRAM_MASTER_SEED_SANDBOX;
      delete process.env.SOL_PROGRAM_MASTER_SEED_PROD;
      assert.equal(loadProgramKey(manifest, 'sandbox', 'router'), undefined);
      process.env.SOL_PROGRAM_MASTER_SEED_SANDBOX = seed;
      assert.equal(loadProgramKey(manifest, 'production', 'router'), undefined);
      assert(loadProgramKey(manifest, 'sandbox', 'verifier', 3)!.publicKey.equals(deriveProgramKey(seed, 'sandbox', 'verifier', 2).publicKey));
      assert(loadProgramKey(manifest, 'sandbox', 'verifier', 2)!.publicKey.equals(deriveProgramKey(seed, 'sandbox', 'verifier', 1).publicKey));
      assert.throws(() => loadProgramKey(manifest, 'sandbox', 'verifier', 99), /missing the program key release/);
      assert.throws(() => loadProgramKey({ ...manifest, programKeyDerivation: undefined }, 'sandbox', 'router'), /pin programKeyDerivation/);
    } finally {
      names.forEach((name, i) => {
        if (saved[i] === undefined) delete process.env[name];
        else process.env[name] = saved[i];
      });
    }
  });

  it('writes private key files reproducibly and refuses to overwrite another program ID', () => {
    const directory = mkdtempSync(join(tmpdir(), 'p2id-program-keys-test-'));
    try {
      const path = join(directory, 'nested', 'router.json');
      const key = deriveProgramKey(seed, 'sandbox', 'router', 1);
      writeProgramKey(path, key);
      const before = readFileSync(path, 'utf8');
      assert.equal(statSync(path).mode & 0o777, 0o600);
      writeProgramKey(path, key);
      assert.equal(readFileSync(path, 'utf8'), before);
      assert.throws(() => writeProgramKey(path, deriveProgramKey(seed, 'sandbox', 'router', 2)), /Refusing to replace/);
      assert.equal(readFileSync(path, 'utf8'), before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('previews without writes, prepares all five keys, and reruns without changing IDs', function () {
    this.timeout(20000);
    const directory = mkdtempSync(join(tmpdir(), 'p2id-derive-cli-test-'));
    const output = join(directory, 'programs');
    const zkPath = join(directory, 'sunspot', 'verifier.json');
    const env = { ...process.env, SOL_PROGRAM_MASTER_SEED_SANDBOX: seed,
      SOL_PROGRAM_KEYPAIR_DIR_SANDBOX: output, SOL_ZK_VERIFIER_KEYPAIR_SANDBOX: zkPath };
    const run = (...args: string[]) => execFileSync(process.execPath,
      ['-r', 'ts-node/register', resolve(__dirname, '../scripts/derive-program-keys.ts'), 'sandbox', ...args],
      { cwd: resolve(__dirname, '..'), env, encoding: 'utf8' });
    try {
      const preview = run();
      assert.equal(preview.trim().split('\n').length, 5);
      assert(!preview.includes(seed));
      assert(!existsSync(output));
      assert(!existsSync(zkPath));
      run('--write');
      const files = ['p2id_router', 'p2id_policy', 'p2id_vault', 'p2id_solana_verifier'].map((name) => join(output, `${name}-keypair.json`));
      for (const path of [...files, zkPath]) assert.equal(statSync(path).mode & 0o777, 0o600);
      const before = [...files, zkPath].map((path) => readFileSync(path, 'utf8'));
      run('--write');
      assert.deepEqual([...files, zkPath].map((path) => readFileSync(path, 'utf8')), before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('checks all output conflicts before writing the first key', function () {
    this.timeout(10000);
    const directory = mkdtempSync(join(tmpdir(), 'p2id-derive-conflict-test-'));
    const output = join(directory, 'programs');
    const zkPath = join(directory, 'sunspot.json');
    try {
      writeProgramKey(zkPath, deriveProgramKey(seed, 'sandbox', 'zkVerifier', 2));
      assert.throws(() => execFileSync(process.execPath,
        ['-r', 'ts-node/register', resolve(__dirname, '../scripts/derive-program-keys.ts'), 'sandbox', '--write'],
        { cwd: resolve(__dirname, '..'), stdio: 'pipe', env: { ...process.env,
          SOL_PROGRAM_MASTER_SEED_SANDBOX: seed, SOL_PROGRAM_KEYPAIR_DIR_SANDBOX: output,
          SOL_ZK_VERIFIER_KEYPAIR_SANDBOX: zkPath } }), /Refusing to replace/);
      assert(!existsSync(output));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
