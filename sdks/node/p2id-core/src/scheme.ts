import { identityHash as hashIdentity } from './identity.js';
import { resolveIdentityType, type IdentityTypeName } from './identityNames.js';
import type { IdentityType } from './identity.js';
import { P2ID_SCHEME, P2ID_SCHEMES, type P2IDScheme, type P2IDSchemeName } from './p2idConstants.js';

export { P2ID_SCHEME, P2ID_SCHEMES };
export type { P2IDScheme, P2IDSchemeName };
export type { P2IDSolanaScheme, P2IDSolanaFactory, P2IDSolanaFactoryParams, P2IDSolanaVerifier } from './p2idConstants.js';

/** A Pvium environment: `production` (mainnets) or `sandbox` (testnets). Each has its own factories. */
export type P2IDEnvironment = 'production' | 'sandbox';

export function assertEnvironment(env: string): asserts env is P2IDEnvironment {
  if (env !== 'production' && env !== 'sandbox') throw new Error(`unknown environment "${env}"`);
}

/**
 * The constants of an address scheme; defaults to the current one.
 *
 * A scheme (`pvium.vault.v1`, or a later `pvium.vault.vN`) fixes everything an address depends on:
 * the identity domain, and per chain family the factory and what it derives vaults from (the vault
 * creation-code hash on EVM, the router program and factory parameters on Solana). Schemes are
 * history: a change that moves addresses ships as the next scheme and becomes `P2ID_SCHEME`;
 * earlier schemes stay in `P2ID_SCHEMES` so addresses people were already given can be derived,
 * and claimed, forever.
 */
export function p2idScheme(name: P2IDSchemeName | string = P2ID_SCHEME): P2IDScheme {
  const s = (P2ID_SCHEMES as Record<string, P2IDScheme>)[name];
  if (!s) throw new Error(`unknown P2ID scheme "${name}" (known: ${Object.keys(P2ID_SCHEMES).join(', ')})`);
  return s;
}

/**
 * The identity commitment: `sha256(identityDomain ‖ byte(typeId) ‖ normalize(value))`. It is the
 * value proofs bind, the CREATE2 salt of the identity's EVM vault and a seed of its Solana vault,
 * so the same identity has one commitment on every chain.
 */
export function identityHash(
  type: IdentityType | IdentityTypeName,
  value: string,
  scheme: P2IDSchemeName | string = P2ID_SCHEME,
): `0x${string}` {
  return hashIdentity(resolveIdentityType(type), value, p2idScheme(scheme).identityDomain);
}
