// Verify Pvium identity attestations off-chain. Address derivation and identity hashing are in
// @pvium/p2id-core; the identity types are re-exported here for convenience.
export { verifyIdentity } from './verifyIdentity.js';
export type { Attestation, Signer, VerifyIdentityInput, VerifyIdentityResult } from './verifyIdentity.js';
export { decodeClaim, toPublicInputFields, PUBLIC_INPUT_COUNT } from './publicInputs.js';
export type { IdentityClaim, P256PublicKey, PublicInputs } from './publicInputs.js';
export { PVIUM_ENVIRONMENTS, AttestationSigner } from './environments.js';
export type { PviumEnvironment, PviumEnvironmentName } from './environments.js';
export { shutdown } from './verify.js';
export { VK_SHA256, CIRCUIT_VERSION } from './vk.js';
export { IdentityType } from '@pvium/p2id-core';
export type { IdentityTypeName } from '@pvium/p2id-core';
