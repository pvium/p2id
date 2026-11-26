// @pvium/p2id-core/evm: P2ID on EVM chains. The root export re-exports all of this under the same
// names, so existing imports keep working; this entry point exists for symmetry with ./solana.
export { p2idAddress, p2idAddressForHash, p2idFundingVerifier, p2idVerifier, checksumAddress } from './address.js';
export type { P2IDAddressInput } from './address.js';
export { CONSTRAINT_DOMAIN, ANY_REGISTERED_SIGNER, constraintCommitment, constraintClaimSignature, constraintTypedData } from './constraint.js';
export type { ConstraintTerms } from './constraint.js';
export { identityHash, p2idScheme, P2ID_SCHEME, P2ID_SCHEMES } from '../scheme.js';
export type { P2IDEnvironment, P2IDScheme, P2IDSchemeName } from '../scheme.js';
