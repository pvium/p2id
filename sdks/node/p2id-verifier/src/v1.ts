// @pvium/p2id-verifier/v1: the same API as the package root, pinned to circuit version 1. Use it
// to accept only attestations from that circuit; the root accepts every bundled version.
import { verifyIdentityFor, type VerifyIdentityInput, type VerifyIdentityResult } from './verifyIdentity.js';
import { CIRCUITS } from './vk.js';

/** The circuit version this entry point verifies. */
export const CIRCUIT_VERSION = 1;
/** sha256 of circuit version 1's verification key. */
export const VK_SHA256 = CIRCUITS[1].vkSha256;

/** verifyIdentity for circuit version 1 only: attestations from any other version are rejected. */
export function verifyIdentity(input: VerifyIdentityInput): Promise<VerifyIdentityResult> {
  return verifyIdentityFor(input, [CIRCUIT_VERSION]);
}

export type { Attestation, Signer, VerifyIdentityInput, VerifyIdentityResult } from './verifyIdentity.js';
export { decodeClaim, toPublicInputFields, PUBLIC_INPUT_COUNT } from './publicInputs.js';
export type { IdentityClaim, P256PublicKey, PublicInputs } from './publicInputs.js';
export { PVIUM_ENVIRONMENTS, AttestationSigner } from './environments.js';
export type { PviumEnvironment, PviumEnvironmentName } from './environments.js';
export { shutdown, VerifierUnavailableError } from './verify.js';
export { IdentityType } from '@pvium/p2id-core';
export type { IdentityTypeName } from '@pvium/p2id-core';
