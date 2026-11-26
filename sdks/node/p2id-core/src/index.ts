// P2ID protocol core: no proof verification here, and no heavy dependencies, so it is safe in
// browsers. Verifying attestations lives in @pvium/p2id-verifier.
//
// The root export is the chain-agnostic protocol (identity types, hashing, schemes) plus the EVM
// functions under their original names. Solana lives in '@pvium/p2id-core/solana' and EVM, for
// symmetry, also in '@pvium/p2id-core/evm'.
export { IdentityType, isDeprecatedIdentityType, HASH_PREFIX, isCaseInsensitive, completeIdentityValue, normalizeIdentityValue, toHex } from './identity.js';
export { IDENTITY_TYPE_BY_NAME, P2ID_TYPE_NAMES, identityTypeName, resolveIdentityType } from './identityNames.js';
export type { IdentityTypeName, P2IDTypeName } from './identityNames.js';
export { identityHash, p2idScheme, P2ID_SCHEME, P2ID_SCHEMES } from './scheme.js';
export type { P2IDEnvironment, P2IDScheme, P2IDSchemeName, P2IDSolanaScheme, P2IDSolanaFactory, P2IDSolanaFactoryParams, P2IDSolanaVerifier } from './scheme.js';
export { p2idAddress, p2idAddressForHash, p2idFundingVerifier, p2idVerifier, checksumAddress } from './evm/address.js';
export type { P2IDAddressInput } from './evm/address.js';
export { CONSTRAINT_DOMAIN, ANY_REGISTERED_SIGNER, constraintCommitment, constraintClaimSignature, constraintTypedData } from './evm/constraint.js';
export type { ConstraintTerms } from './evm/constraint.js';
