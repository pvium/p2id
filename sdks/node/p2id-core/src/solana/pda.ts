// Program-derived addresses without @solana/web3.js: sha256 over the seeds, the program id and the
// "ProgramDerivedAddress" marker, taking the first bump (255 downwards) whose result is not a
// point on ed25519, exactly as the runtime does. Keys are base58 strings in and out.
import { sha256 } from '@noble/hashes/sha256';
import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';

const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');
export const MAX_SEEDS = 16;
export const MAX_SEED_LENGTH = 32;

/** A Solana public key or program id as base58 text. */
export type Pubkey = string;

export function toBase58(bytes: Uint8Array): Pubkey {
  return base58.encode(bytes);
}

/** Decode a base58 key, requiring `length` bytes (32 for a public key). */
export function fromBase58(value: string, length = 32): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(value);
  } catch {
    throw new Error(`not a base58 key: ${value}`);
  }
  if (bytes.length !== length) throw new Error(`expected a ${length}-byte key, got ${bytes.length} bytes: ${value}`);
  return bytes;
}

/** True when the 32 bytes decode to a point on ed25519, i.e. could be a wallet rather than a PDA. */
export function isOnCurve(point: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(point);
    return true;
  } catch {
    return false;
  }
}

function seedBytes(seed: Uint8Array | string): Uint8Array {
  const bytes = typeof seed === 'string' ? new TextEncoder().encode(seed) : seed;
  if (bytes.length > MAX_SEED_LENGTH) throw new Error(`seed is ${bytes.length} bytes; the maximum is ${MAX_SEED_LENGTH}`);
  return bytes;
}

/** The address for these exact seeds (including a bump), or null when it lands on the curve. */
export function createProgramAddress(seeds: Array<Uint8Array | string>, programId: Pubkey): Pubkey | null {
  if (seeds.length > MAX_SEEDS) throw new Error(`${seeds.length} seeds; the maximum is ${MAX_SEEDS}`);
  const h = sha256.create();
  for (const seed of seeds) h.update(seedBytes(seed));
  h.update(fromBase58(programId));
  h.update(PDA_MARKER);
  const out = h.digest();
  return isOnCurve(out) ? null : toBase58(out);
}

/** The canonical program-derived address for the seeds: the highest bump that is off the curve. */
export function findProgramAddress(seeds: Array<Uint8Array | string>, programId: Pubkey): { address: Pubkey; bump: number } {
  for (let bump = 255; bump >= 0; bump--) {
    const address = createProgramAddress([...seeds, new Uint8Array([bump])], programId);
    if (address) return { address, bump };
  }
  throw new Error('no program address found for these seeds');
}
