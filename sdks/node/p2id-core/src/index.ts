// P2ID protocol core: no proof verification here, and no heavy dependencies, so it is safe in
// browsers. Verifying attestations lives in @pvium/p2id-verifier.
export { IdentityType, isDeprecatedIdentityType, HASH_PREFIX, isCaseInsensitive, completeIdentityValue, normalizeIdentityValue, toHex } from './identity.js';
export { IDENTITY_TYPE_BY_NAME, P2ID_TYPE_NAMES, identityTypeName, resolveIdentityType } from './identityNames.js';
export type { IdentityTypeName, P2IDTypeName } from './identityNames.js';
export { identityHash, p2idAddress, p2idAddressForHash, p2idFundingVerifier, p2idVerifier, p2idScheme, checksumAddress, P2ID_SCHEME, P2ID_SCHEMES } from './p2id.js';
export type { P2IDAddressInput, P2IDEnvironment, P2IDScheme, P2IDSchemeName } from './p2id.js';
export { CONSTRAINT_DOMAIN, ANY_REGISTERED_SIGNER, constraintCommitment, constraintClaimSignature, constraintTypedData } from './constraint.js';
export type { ConstraintTerms } from './constraint.js';
