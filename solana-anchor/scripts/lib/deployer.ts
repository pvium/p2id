import { utils } from '@coral-xyz/anchor';
import { Keypair } from '@solana/web3.js';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { requireEnvFor, type Environment } from '../../deploy.config';

/** Accept a base58 seed/secret key or a 32-byte hex seed; never echo secret input. */
export function privateKey(value: string): Keypair {
  try {
    const raw = value.trim();
    const bytes = /^(?:0x)?[0-9a-fA-F]{64}$/.test(raw)
      ? Buffer.from(raw.replace(/^0x/, ''), 'hex')
      : utils.bytes.bs58.decode(raw);
    if (bytes.length === 32) return Keypair.fromSeed(bytes);
    if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  } catch {
    // Decoder errors may contain the input, so replace them with a fixed message.
  }
  throw new Error('SOL_DEPLOYER_PRIVATE_KEY must be a base58 32-byte seed or 64-byte secret key, or a 32-byte hex seed');
}

export function loadDeployer(environment: Environment): Keypair {
  return privateKey(requireEnvFor('SOL_DEPLOYER_PRIVATE_KEY', environment));
}

/** Solana CLI requires a wallet file. Keep it private and remove it even when the CLI fails. */
export function withDeployerFile<T>(deployer: Keypair, run: (path: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'p2id-deployer-'));
  try {
    const path = join(directory, 'keypair.json');
    writeFileSync(path, JSON.stringify(Array.from(deployer.secretKey)), { mode: 0o600 });
    return run(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
