// Groth16 verification for proofs made by Sunspot (gnark, BN254), in pure JavaScript with
// @noble/curves: no WASM, no native code, so it runs wherever the package does.
//
// This mirrors gnark's `groth16.Verify` for BN254 as the Solana verifier program implements it,
// commitments included: the circuit uses one Pedersen commitment (gnark's BSB22 range checks),
// which the proof carries with a proof of knowledge. Byte layouts are gnark's raw (uncompressed,
// big-endian) encodings; G2 coordinates are written imaginary part first, as on Ethereum.
import { bn254 } from '@noble/curves/bn254';
import { sha256 } from '@noble/hashes/sha256';

const { Fp12, Fr } = bn254.fields;
const G1 = bn254.G1.ProjectivePoint;
const G2 = bn254.G2.ProjectivePoint;
type G1Point = ReturnType<typeof G1.fromAffine>;
type G2Point = ReturnType<typeof G2.fromAffine>;

/** A gnark verifying key, as `WriteRawTo` serialises it (the `.vk` Sunspot writes). */
export interface GnarkVerifyingKey {
  alpha: G1Point;
  beta: G2Point;
  gamma: G2Point;
  delta: G2Point;
  /** K[0] for the constant one, then one per public input, then one per commitment. */
  k: G1Point[];
  /** Per commitment: the (1-based) public inputs it commits to, hashed in with the commitment. */
  publicAndCommitmentCommitted: number[][];
  /** Per commitment: the Pedersen verifying key, G and G^(-σ) in G2. */
  commitmentKeys: Array<{ g: G2Point; gSigmaNeg: G2Point }>;
  /** Public inputs the circuit has (the commitments are not counted). */
  publicInputCount: number;
}

/** A gnark proof, as `WriteRawTo` serialises it: A, B, C, the commitments and their proof of knowledge. */
export interface GnarkProof {
  ar: G1Point;
  bs: G2Point;
  krs: G1Point;
  commitments: G1Point[];
  commitmentBytes: Uint8Array[];
  commitmentPok: G1Point;
}

export class MalformedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedError';
  }
}

export function parseGnarkVerifyingKey(bytes: Uint8Array): GnarkVerifyingKey {
  const r = new Reader(bytes, 'verifying key');
  const alpha = r.g1();
  r.g1(); // beta in G1: the verifier does not use it
  const beta = r.g2();
  const gamma = r.g2();
  r.g1(); // delta in G1
  const delta = r.g2();
  const k = r.many(() => r.g1());
  const publicAndCommitmentCommitted = r.many(() => r.many(() => r.u64()));
  const commitmentKeys = r.many(() => ({ g: r.g2(), gSigmaNeg: r.g2() }));
  r.end();
  if (commitmentKeys.length !== publicAndCommitmentCommitted.length) {
    throw new MalformedError('verifying key: commitment keys and committed inputs disagree');
  }
  const publicInputCount = k.length - 1 - commitmentKeys.length;
  if (publicInputCount < 0) throw new MalformedError('verifying key: too few K points');
  return { alpha, beta, gamma, delta, k, publicAndCommitmentCommitted, commitmentKeys, publicInputCount };
}

export function parseGnarkProof(bytes: Uint8Array): GnarkProof {
  const r = new Reader(bytes, 'proof');
  const ar = r.g1();
  const bs = r.g2();
  const krs = r.g1();
  const count = r.u32();
  const commitmentBytes: Uint8Array[] = [];
  const commitments: G1Point[] = [];
  for (let i = 0; i < count; i++) {
    commitmentBytes.push(bytes.subarray(r.offset, r.offset + 64));
    commitments.push(r.g1());
  }
  const commitmentPok = r.g1();
  r.end();
  return { ar, bs, krs, commitments, commitmentBytes, commitmentPok };
}

/** Sunspot's public witness file: a 12-byte header (the input count as u32 and u64, big-endian) then the inputs. */
export const PUBLIC_WITNESS_HEADER = 12;

/** The public inputs of a Sunspot `.pw` file, or null when the bytes are not one. */
export function splitPublicWitness(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < PUBLIC_WITNESS_HEADER || (bytes.length - PUBLIC_WITNESS_HEADER) % 32 !== 0) return null;
  const n = (bytes.length - PUBLIC_WITNESS_HEADER) / 32;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0) !== n || v.getUint32(4) !== 0 || v.getUint32(8) !== n) return null;
  return bytes.subarray(PUBLIC_WITNESS_HEADER);
}

/**
 * gnark's Groth16 check: the Pedersen proof of knowledge for the commitments, then
 * e(A, B) · e(-α, β) · e(Kx, -γ) · e(C, -δ) = 1 with Kx = K0 + Σ xᵢ·Kᵢ₊₁ + Σ commitments, where
 * the public inputs are extended with the hash of each commitment. Returns false for a proof
 * that does not verify; throws MalformedError when the inputs cannot be interpreted at all.
 */
export function verifyGroth16(vk: GnarkVerifyingKey, proof: GnarkProof, publicInputs: readonly bigint[]): boolean {
  if (publicInputs.length !== vk.publicInputCount) {
    throw new MalformedError(`expected ${vk.publicInputCount} public inputs, got ${publicInputs.length}`);
  }
  if (publicInputs.some((x) => x < 0n || x >= Fr.ORDER)) throw new MalformedError('public input is not a field element');
  if (proof.commitments.length !== vk.commitmentKeys.length) return false;

  const witness = [...publicInputs];
  const commitmentHashes: number[] = [];
  for (let i = 0; i < vk.commitmentKeys.length; i++) {
    const pre = [...proof.commitmentBytes[i]];
    for (const j of vk.publicAndCommitmentCommitted[i]) pre.push(...fr32(witness[j - 1]));
    const h = hashToFr(Uint8Array.from(pre), 'bsb22-commitment');
    witness.push(h);
    commitmentHashes.push(...fr32(h));
  }

  try {
    if (vk.commitmentKeys.length > 0) {
      // Batched Pedersen proof of knowledge: Π e(Cᵢ·rⁱ, Gᵢ^(-σ)) · e(pok, G) = 1.
      const r = hashToFr(Uint8Array.from(commitmentHashes), 'G16-BSB22');
      const pairs: Array<{ g1: G1Point; g2: G2Point }> = [];
      let ri = 1n;
      for (let i = 0; i < vk.commitmentKeys.length; i++) {
        pairs.push({ g1: i === 0 ? proof.commitments[i] : proof.commitments[i].multiply(ri), g2: vk.commitmentKeys[i].gSigmaNeg });
        ri = Fr.mul(ri, r);
      }
      pairs.push({ g1: proof.commitmentPok, g2: vk.commitmentKeys[0].g });
      if (!Fp12.eql(bn254.pairingBatch(pairs), Fp12.ONE)) return false;
    }
    let kx = vk.k[0];
    for (let i = 0; i < witness.length; i++) if (witness[i] !== 0n) kx = kx.add(vk.k[i + 1].multiply(witness[i]));
    for (const c of proof.commitments) kx = kx.add(c);
    const product = bn254.pairingBatch([
      { g1: proof.ar, g2: proof.bs },
      { g1: vk.alpha.negate(), g2: vk.beta },
      { g1: kx, g2: vk.gamma.negate() },
      { g1: proof.krs, g2: vk.delta.negate() },
    ]);
    return Fp12.eql(product, Fp12.ONE);
  } catch {
    return false; // a point at infinity where none may be, or similar: not a valid proof
  }
}

/** RFC 9380 hash_to_field over Fr with expand_message_xmd(sha256), as gnark-crypto's `fr.Hash`. */
function hashToFr(msg: Uint8Array, domain: string): bigint {
  const dst = new TextEncoder().encode(domain);
  const len = 48; // ceil((254 + 128) / 8)
  const dstPrime = Uint8Array.from([...dst, dst.length]);
  const b0 = sha256(concat(new Uint8Array(64), msg, Uint8Array.from([len >> 8, len & 0xff, 0]), dstPrime));
  let bi = sha256(concat(b0, Uint8Array.from([1]), dstPrime));
  const out = [...bi];
  for (let i = 2; i <= Math.ceil(len / 32); i++) {
    bi = sha256(concat(b0.map((v, j) => v ^ bi[j]), Uint8Array.from([i]), dstPrime));
    out.push(...bi);
  }
  return Fr.create(bytesToBigInt(Uint8Array.from(out.slice(0, len))));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function bytesToBigInt(b: Uint8Array): bigint {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

function fr32(v: bigint): Uint8Array {
  const b = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return b;
}

/** Big-endian reader over gnark's raw encoding. Every point is checked to be on the curve and in the subgroup. */
class Reader {
  offset = 0;
  constructor(private readonly bytes: Uint8Array, private readonly what: string) {}
  private take(n: number): Uint8Array {
    if (this.offset + n > this.bytes.length) throw new MalformedError(`${this.what}: truncated (${this.bytes.length} bytes)`);
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
  u32(): number {
    const b = this.take(4);
    return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  }
  u64(): number {
    const v = bytesToBigInt(this.take(8));
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new MalformedError(`${this.what}: index out of range`);
    return Number(v);
  }
  many<T>(read: () => T): T[] {
    const n = this.u32();
    if (n > 1 << 20) throw new MalformedError(`${this.what}: implausible count ${n}`);
    const out: T[] = [];
    for (let i = 0; i < n; i++) out.push(read());
    return out;
  }
  g1(): G1Point {
    const b = this.take(64);
    try {
      const p = G1.fromAffine({ x: bytesToBigInt(b.subarray(0, 32)), y: bytesToBigInt(b.subarray(32, 64)) });
      p.assertValidity();
      return p;
    } catch (e) {
      throw new MalformedError(`${this.what}: bad G1 point (${(e as Error).message})`);
    }
  }
  g2(): G2Point {
    const b = this.take(128);
    try {
      const p = G2.fromAffine({
        x: { c1: bytesToBigInt(b.subarray(0, 32)), c0: bytesToBigInt(b.subarray(32, 64)) },
        y: { c1: bytesToBigInt(b.subarray(64, 96)), c0: bytesToBigInt(b.subarray(96, 128)) },
      });
      p.assertValidity();
      return p;
    } catch (e) {
      throw new MalformedError(`${this.what}: bad G2 point (${(e as Error).message})`);
    }
  }
  end(): void {
    if (this.offset !== this.bytes.length) throw new MalformedError(`${this.what}: ${this.bytes.length - this.offset} trailing bytes`);
  }
}
