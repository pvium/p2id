// Internal re-exports for the SDK's own tests. Not part of the public API.
export { IdentityType, identityHash } from '@pvium/p2id-core';
export { decodeClaim, toPublicInputFields } from './publicInputs.js';
export { parseP256PublicKeyPem } from './signer.js';
export { verifyProof, shutdown, verifySolanaProof, solanaVerifyingKey, parseSolanaVerifyingKey } from './verify.js';
export { parseGnarkProof, parseGnarkVerifyingKey, splitPublicWitness, verifyGroth16, MalformedError } from './solana/groth16.js';
export { SOLANA_CIRCUITS } from './vk.js';
export { solanaCandidates } from './verifyIdentity.js';
