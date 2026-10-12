import { keccak_256 } from '@noble/hashes/sha3';
import { toHex } from './identity.js';

/** Domain tag of a constraint commitment. */
export const CONSTRAINT_DOMAIN = 'p2id.constraint.v1';

/** `signer` value meaning "any of the verifier's registered constraint signers". */
export const ANY_REGISTERED_SIGNER = '0x0000000000000000000000000000000000000000';

type Hex = `0x${string}`;

export interface ConstraintTerms {
  /** Who may approve: an address chosen by the payer, or ANY_REGISTERED_SIGNER (the default). */
  signer?: string;
  /** What the payee must satisfy, as the signer defines it (32 bytes). */
  policyHash: string;
  /** The payee's identityHash (32 bytes): the constraint only applies to this payee's vault. */
  identityHash: string;
  /** Makes the commitment unique per payment, e.g. a hash of an idempotency key (32 bytes). */
  salt: string;
}

/**
 * The constraint commitment a payer funds with:
 * `keccak256(abi.encode("p2id.constraint.v1", signer, policyHash, identityHash, salt))`.
 * Pass it as `constraint` to `fund` / `fundWith`, and give `signer`, `policyHash` and `salt` to the
 * payee so they can claim.
 */
export function constraintCommitment(terms: ConstraintTerms): Hex {
  const tag = new TextEncoder().encode(CONSTRAINT_DOMAIN);
  return toHex(keccak_256(concat(
    word(5n * 32n), // offset of the string, after five head words
    address(terms.signer ?? ANY_REGISTERED_SIGNER),
    bytes32(terms.policyHash, 'policyHash'),
    bytes32(terms.identityHash, 'identityHash'),
    bytes32(terms.salt, 'salt'),
    word(BigInt(tag.length)),
    padRight(tag),
  )));
}

/**
 * The `signature` field of the claim-time `Constraint { commitment, signature }`:
 * `abi.encode(address signer, bytes32 policyHash, bytes32 salt, bytes signature)`, where `signature`
 * is the signer's EIP-712 signature over the commitment (see constraintTypedData).
 *
 * For a registered-signer constraint (no `signer`), pass `approver` when the approving registered
 * signer is a contract (ERC-1271), or to name an EOA signer explicitly: the signature is then
 * `abi.encode(address approver, bytes approval)`.
 */
export function constraintClaimSignature(
  terms: Omit<ConstraintTerms, 'identityHash'> & { signature: string; approver?: string },
): Hex {
  const isRegistered = (terms.signer ?? ANY_REGISTERED_SIGNER).toLowerCase() === ANY_REGISTERED_SIGNER;
  if (terms.approver !== undefined && !isRegistered) throw new Error('approver applies to registered-signer constraints only');
  let sig = hexBytes(terms.signature, 'signature');
  if (terms.approver !== undefined) {
    sig = concat(address(terms.approver), word(2n * 32n), word(BigInt(sig.length)), padRight(sig));
  }
  return toHex(concat(
    address(terms.signer ?? ANY_REGISTERED_SIGNER),
    bytes32(terms.policyHash, 'policyHash'),
    bytes32(terms.salt, 'salt'),
    word(4n * 32n), // offset of the bytes, after four head words
    word(BigInt(sig.length)),
    padRight(sig),
  ));
}

/**
 * What a constraint signer signs: EIP-712 `Constraint(bytes32 commitment)` in the verifier's domain.
 * Pass the fields to `signTypedData` (ethers, viem, wallets).
 */
export function constraintTypedData(input: { verifier: string; chainId: number | bigint; commitment: string }) {
  return {
    domain: { name: 'PviumVerifier', version: '1', chainId: BigInt(input.chainId), verifyingContract: input.verifier },
    types: { Constraint: [{ name: 'commitment', type: 'bytes32' }] },
    primaryType: 'Constraint' as const,
    message: { commitment: toHex(bytes32(input.commitment, 'commitment')) },
  };
}

function hexBytes(value: string, name: string): Uint8Array {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(value)) throw new Error(`${name} must be 0x-prefixed hex bytes`);
  const out = new Uint8Array((value.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(value.slice(2 + 2 * i, 4 + 2 * i), 16);
  return out;
}

function bytes32(value: string, name: string): Uint8Array {
  const b = hexBytes(value, name);
  if (b.length !== 32) throw new Error(`${name} must be 32 bytes`);
  return b;
}

function address(value: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`bad signer address ${value}`);
  return concat(new Uint8Array(12), hexBytes(value, 'signer'));
}

function word(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0 && n > 0n; i--, n >>= 8n) out[i] = Number(n & 0xffn);
  return out;
}

function padRight(b: Uint8Array): Uint8Array {
  return concat(b, new Uint8Array((32 - (b.length % 32)) % 32));
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
