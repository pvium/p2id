// Which Solana clusters the P2ID stack is deployed to, and which Pvium environment each belongs to.
//
// An environment is a Privy app: `sandbox` for devnet (and a local validator), `production` for
// mainnet. Each has its own signing keys, authority and attester, so each is its own stack: the same
// program ids everywhere (the program keypairs are what they are), but a factory PDA of its own.
//
// Settings are read from solana-anchor/.env. Per-environment values carry a suffix, _SANDBOX or
// _PROD, so a devnet run can never pick up production keys or authorities, and vice versa. The Privy
// keys are the same for the EVM and Solana stacks of an environment, so PRIVY_SIGNER_KEYS_* and
// PRIVY_JWKS_URL_* fall back to contracts/.env when solana-anchor/.env does not set them. See .env.example.
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseEnv } from 'util';

export type Environment = 'sandbox' | 'production';

export interface Cluster {
  environment: Environment;
  /** Env var holding the RPC URL; `defaultRpc` is used when it is unset. */
  rpcEnv: string;
  defaultRpc: string;
  /** A local validator: unset settings default, nothing is recorded. */
  local?: boolean;
}

/** Add a cluster here (one line) to make `--cluster <name>` available to the deploy script. */
export const CLUSTERS = {
  localnet: { environment: 'sandbox', rpcEnv: 'SOL_RPC_URL_LOCALNET', defaultRpc: 'http://127.0.0.1:8899', local: true },
  devnet: { environment: 'sandbox', rpcEnv: 'SOL_RPC_URL_DEVNET', defaultRpc: 'https://api.devnet.solana.com' },
  mainnet: { environment: 'production', rpcEnv: 'SOL_RPC_URL_MAINNET', defaultRpc: 'https://api.mainnet-beta.solana.com' },
} as const satisfies Record<string, Cluster>;

export type ClusterName = keyof typeof CLUSTERS;

export const ENV_SUFFIX: Record<Environment, string> = { sandbox: 'SANDBOX', production: 'PROD' };

/** Settings shared with the EVM stack of the same environment (same Privy app). */
const SHARED_WITH_EVM = ['PRIVY_SIGNER_KEYS', 'PRIVY_JWKS_URL'];

/** Load solana-anchor/.env, then the Privy settings from contracts/.env where still unset. Values are never printed. */
export function loadEnv(root: string): void {
  const own = join(root, '.env');
  if (existsSync(own)) process.loadEnvFile(own);
  const evm = join(root, '..', 'contracts', '.env');
  if (!existsSync(evm)) return;
  const parsed = parseEnv(readFileSync(evm, 'utf8'));
  for (const name of SHARED_WITH_EVM) {
    for (const suffix of Object.values(ENV_SUFFIX)) {
      const key = `${name}_${suffix}`;
      if ((process.env[key] === undefined || process.env[key] === '') && parsed[key]) process.env[key] = parsed[key];
    }
  }
}

/**
 * Read `${name}_${SUFFIX}` for the environment. Settings that must never be shared between
 * environments (authority, attester, Privy keys) are required in that form; `shared: true` settings
 * (deployer keypair, windows) fall back to the plain `${name}`.
 */
export function envFor(name: string, environment: Environment, opts: { shared?: boolean } = {}): string | undefined {
  const scoped = process.env[`${name}_${ENV_SUFFIX[environment]}`];
  if (scoped !== undefined && scoped !== '') return scoped;
  if (opts.shared) {
    const plain = process.env[name];
    if (plain !== undefined && plain !== '') return plain;
  }
  return undefined;
}

export function requireEnvFor(name: string, environment: Environment): string {
  const v = envFor(name, environment);
  if (v === undefined) {
    throw new Error(`${name}_${ENV_SUFFIX[environment]} is required for the ${environment} environment (solana-anchor/.env)`);
  }
  return v;
}

export function clusterOf(name: string): Cluster & { name: ClusterName } {
  const cluster = (CLUSTERS as Record<string, Cluster>)[name];
  if (!cluster) throw new Error(`unknown cluster "${name}": one of ${Object.keys(CLUSTERS).join(', ')} (deploy.config.ts)`);
  return { ...cluster, name: name as ClusterName };
}
