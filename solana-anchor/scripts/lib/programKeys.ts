import { Keypair } from '@solana/web3.js';
import { derivePath } from 'ed25519-hd-key';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { envFor, type Environment } from '../../deploy.config';

// Append-only role indices. These and the path format are part of the address scheme.
export const PROGRAM_ROLES = { router: 0, policy: 1, implementation: 2, verifier: 3, zkVerifier: 4 } as const;
export type ProgramRole = keyof typeof PROGRAM_ROLES;
export interface ProgramKeyReleases {
  programKeyDerivation?: {
    version: 1;
    releases: Record<'router' | 'policy' | 'implementation', number>;
  };
  stackCircuit: number;
  circuits: Record<string, { programKeyReleases?: Record<'verifier' | 'zkVerifier', number> }>;
}

export function programKeyPath(environment: Environment, role: ProgramRole, release: number): string {
  if (!Number.isSafeInteger(release) || release < 1 || release >= 0x80000000)
    throw new Error('Program key release must be an integer between 1 and 2147483647');
  if (!(role in PROGRAM_ROLES)) throw new Error('Unknown program key role');
  if (environment !== 'sandbox' && environment !== 'production') throw new Error('Unknown program key environment');
  return `m/44'/501'/7472'/${environment === 'sandbox' ? 0 : 1}'/${PROGRAM_ROLES[role]}'/${release}'`;
}

export function deriveProgramKey(seed: string, environment: Environment, role: ProgramRole, release: number): Keypair {
  const hex = seed.trim().replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex))
    throw new Error('SOL_PROGRAM_MASTER_SEED must be a randomly generated 32-byte hex seed');
  const { key } = derivePath(programKeyPath(environment, role, release), hex);
  return Keypair.fromSeed(key);
}

/** A missing scoped seed preserves existing file-based program IDs. Never use a shared seed. */
export function loadProgramKey(
  manifest: ProgramKeyReleases,
  environment: Environment,
  role: ProgramRole,
  circuitVersion = manifest.stackCircuit,
): Keypair | undefined {
  const seed = envFor('SOL_PROGRAM_MASTER_SEED', environment);
  if (seed === undefined) return undefined;
  if (manifest.programKeyDerivation?.version !== 1)
    throw new Error('releases.json must pin programKeyDerivation.version to 1');
  const release = role === 'verifier' || role === 'zkVerifier'
    ? manifest.circuits[String(circuitVersion)]?.programKeyReleases?.[role]
    : manifest.programKeyDerivation.releases[role];
  if (release === undefined) throw new Error(`releases.json is missing the program key release for ${role}`);
  return deriveProgramKey(seed, environment, role, release);
}

export function checkProgramKeyFile(path: string, keypair: Keypair): void {
  if (existsSync(path)) {
    let current: Keypair;
    try {
      current = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
    } catch {
      throw new Error(`Invalid existing program keypair at ${path}`);
    }
    if (!current.publicKey.equals(keypair.publicKey))
      throw new Error(`Refusing to replace a different program keypair at ${path}; use a separate build directory or archive the old build first`);
  }
}

/** Never overwrite another release's key, or follow symlinks on first creation. */
export function writeProgramKey(path: string, keypair: Keypair): void {
  checkProgramKeyFile(path, keypair);
  if (existsSync(path)) {
    chmodSync(path, 0o600);
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)) + '\n', { mode: 0o600, flag: 'wx' });
}
