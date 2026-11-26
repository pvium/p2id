import { strict as assert } from 'assert';
import { existsSync, readFileSync, statSync } from 'fs';
import { utils } from '@coral-xyz/anchor';
import { Keypair } from '@solana/web3.js';
import { loadDeployer, privateKey, withDeployerFile } from '../scripts/lib/deployer';

describe('deployer private key', () => {
  const seed = Buffer.alloc(32, 7);
  const expected = Keypair.fromSeed(seed);

  it('isolates environment keys and refuses shared or other-environment fallbacks', () => {
    const names = ['SOL_DEPLOYER_PRIVATE_KEY', 'SOL_DEPLOYER_PRIVATE_KEY_SANDBOX', 'SOL_DEPLOYER_PRIVATE_KEY_PROD'];
    const saved = names.map((name) => process.env[name]);
    try {
      const productionSeed = Buffer.alloc(32, 8);
      process.env.SOL_DEPLOYER_PRIVATE_KEY = seed.toString('hex');
      process.env.SOL_DEPLOYER_PRIVATE_KEY_SANDBOX = seed.toString('hex');
      process.env.SOL_DEPLOYER_PRIVATE_KEY_PROD = productionSeed.toString('hex');
      assert(loadDeployer('sandbox').publicKey.equals(expected.publicKey));
      assert(loadDeployer('production').publicKey.equals(Keypair.fromSeed(productionSeed).publicKey));
      delete process.env.SOL_DEPLOYER_PRIVATE_KEY_PROD;
      assert.throws(() => loadDeployer('production'), /SOL_DEPLOYER_PRIVATE_KEY_PROD is required/);
      process.env.SOL_DEPLOYER_PRIVATE_KEY_PROD = productionSeed.toString('hex');
      process.env.SOL_DEPLOYER_PRIVATE_KEY_SANDBOX = '';
      assert.throws(() => loadDeployer('sandbox'), /SOL_DEPLOYER_PRIVATE_KEY_SANDBOX is required/);
    } finally {
      names.forEach((name, i) => {
        if (saved[i] === undefined) delete process.env[name];
        else process.env[name] = saved[i];
      });
    }
  });

  it('derives the same public key from seeds and Solana secret keys', () => {
    for (const value of [
      seed.toString('hex'),
      `0x${seed.toString('hex')}`,
      utils.bytes.bs58.encode(seed),
      utils.bytes.bs58.encode(expected.secretKey),
    ]) {
      assert(privateKey(value).publicKey.equals(expected.publicKey));
    }
  });

  it('rejects invalid input without exposing it in errors', () => {
    for (const value of ['invalid-private-key!', '111', utils.bytes.bs58.encode(Buffer.alloc(64, 7))]) {
      assert.throws(() => privateKey(value), (error: Error) =>
        error.message.startsWith('SOL_DEPLOYER_PRIVATE_KEY must be') && !error.message.includes(value));
    }
  });

  it('restricts the CLI file permissions and removes it after success or failure', () => {
    for (const fail of [false, true]) {
      let temporaryPath = '';
      const run = () => withDeployerFile(expected, (path) => {
        temporaryPath = path;
        assert.equal(statSync(path).mode & 0o777, 0o600);
        const restored = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
        assert(restored.publicKey.equals(expected.publicKey));
        if (fail) throw new Error('CLI failed');
      });
      if (fail) assert.throws(run, /CLI failed/);
      else run();
      assert.equal(existsSync(temporaryPath), false);
    }
  });
});
