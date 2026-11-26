import { Barretenberg, UltraHonkVerifierBackend } from '@aztec/bb.js';
import { CIRCUITS, CIRCUIT_VERSION, SOLANA_CIRCUITS } from './vk.js';
import { toPublicInputFields, type PublicInputs } from './publicInputs.js';
import type { PviumEnvironmentName } from './environments.js';
import { MalformedError, parseGnarkProof, parseGnarkVerifyingKey, verifyGroth16, type GnarkVerifyingKey } from './solana/groth16.js';

export interface ProofBundle {
  /** Raw proof bytes as produced by `bb prove -t evm` (or bb.js with verifierTarget 'evm'). */
  proof: Uint8Array;
  publicInputs: PublicInputs;
}

const vkCache = new Map<number, Uint8Array>();
/** A circuit version's UltraHonk verification key (EVM / keccak transcript), bundled with the package. */
export function verificationKey(circuitVersion: number = CIRCUIT_VERSION): Uint8Array {
  let vk = vkCache.get(circuitVersion);
  if (!vk) {
    const entry = CIRCUITS[circuitVersion];
    if (!entry) throw new Error(`circuit version ${circuitVersion} is not bundled with this release`);
    vk = Uint8Array.from(atob(entry.vkBase64), (c) => c.charCodeAt(0));
    vkCache.set(circuitVersion, vk);
  }
  return vk;
}

let apiPromise: Promise<Barretenberg> | undefined;
async function backend(): Promise<UltraHonkVerifierBackend> {
  apiPromise ??= Barretenberg.new({ threads: 1 });
  return new UltraHonkVerifierBackend(await apiPromise);
}

/** Release the Barretenberg WASM instance. Call when your process is done verifying. */
export async function shutdown(): Promise<void> {
  if (apiPromise) {
    const api = await apiPromise;
    apiPromise = undefined;
    await api.destroy();
  }
}

/**
 * Cryptographic check only: is this a valid proof for the given version of the Pvium identity
 * circuit (default: the newest) with these public inputs? Says nothing about who signed the
 * token or whether it has expired.
 */
export async function verifyProof(bundle: ProofBundle, circuitVersion: number = CIRCUIT_VERSION): Promise<boolean> {
  const publicInputs = toPublicInputFields(bundle.publicInputs);
  const verificationKey_ = verificationKey(circuitVersion);
  let v: UltraHonkVerifierBackend;
  try {
    v = await backend();
  } catch (e) {
    throw new VerifierUnavailableError(e);
  }
  try {
    return await v.verifyProof(
      { proof: bundle.proof, publicInputs, verificationKey: verificationKey_ },
      { verifierTarget: 'evm' },
    );
  } catch {
    // bb.js throws on a malformed or tampered proof (e.g. a point that is not on the curve)
    // as well as returning false: either way the proof did not verify. Environment failures
    // (WASM cannot load, no threads or shared memory) surface when the backend is created above.
    return false;
  }
}

// ---- Solana: Sunspot (gnark Groth16) proofs, verified in pure JavaScript. No backend to start or shut down.

const solanaVkCache = new Map<string, GnarkVerifyingKey>();
/** A bundled Solana verifying key, parsed once: the environment's trusted setup for a circuit version. */
export function solanaVerifyingKey(environment: PviumEnvironmentName, circuitVersion: number): GnarkVerifyingKey {
  const entry = SOLANA_CIRCUITS[environment]?.[circuitVersion];
  if (!entry) throw new Error(`no Solana verifying key is bundled for circuit version ${circuitVersion} (${environment})`);
  let vk = solanaVkCache.get(entry.vkSha256);
  if (!vk) {
    vk = parseGnarkVerifyingKey(Uint8Array.from(atob(entry.vkBase64), (c) => c.charCodeAt(0)));
    solanaVkCache.set(entry.vkSha256, vk);
  }
  return vk;
}

/** Parse a Sunspot `.vk` (gnark's raw encoding) you hold yourself, e.g. from a self-hosted setup. */
export function parseSolanaVerifyingKey(bytes: Uint8Array): GnarkVerifyingKey {
  return parseGnarkVerifyingKey(bytes);
}

/**
 * Cryptographic check only: is this a valid Groth16 proof under `vk` for these public inputs
 * (the 11 fields, or Sunspot's public witness file)? Malformed bytes count as an invalid proof.
 */
export function verifySolanaProof(bundle: ProofBundle, vk: GnarkVerifyingKey): boolean {
  try {
    const fields = toPublicInputFields(bundle.publicInputs).map((h) => BigInt(h));
    return verifyGroth16(vk, parseGnarkProof(bundle.proof), fields);
  } catch (e) {
    if (e instanceof MalformedError) return false;
    throw e;
  }
}

/** The proof could not be checked at all: the Barretenberg WASM backend failed in this environment. */
export class VerifierUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`proof verifier unavailable in this environment: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = 'VerifierUnavailableError';
  }
}
