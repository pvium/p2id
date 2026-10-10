import { sha256 } from '@noble/hashes/sha256';
/**
 * Identity types. The numeric value is the protocol's type id (it is what gets hashed), so it
 * must match circuit/src/identity.nr and never change.
 */
export enum IdentityType {
  Email = 0,
  Phone = 1,
  Google = 2,
  Twitter = 3,
  /** Alias of `Twitter`: the platform's current name. Same id, same addresses. */
  X = 3,
  Discord = 4,
  Github = 5,
  Linkedin = 6,
  Apple = 7,
  Telegram = 8,
  Tiktok = 9,
  Instagram = 10,
  Farcaster = 11,
  Wallet = 12,
}

/** Domain-separation prefix baked into the circuit's identity hash. */
export const HASH_PREFIX = 'p2id.identity.v1';

/** Types whose value is ASCII-lowercased before hashing: everything except phone numbers and
 *  wallet addresses (matches CASE_INSENSITIVE in circuit/src/identity.nr). */
export function isCaseInsensitive(type: IdentityType): boolean {
  return type !== IdentityType.Wallet && type !== IdentityType.Phone;
}

/**
 * Complete a value to the form the identity provider records. Discord stores migrated (unique)
 * usernames with the discriminator `#0` (`alice#0`), and that full form is what a proof hashes,
 * so a bare Discord username gets `#0` appended. A value that already has a discriminator
 * (`alice#0`, or a legacy `alice#1234`) is left as is. Every other type is unchanged.
 */
export function completeIdentityValue(type: IdentityType, value: string): string {
  return type === IdentityType.Discord && !value.includes('#') ? `${value}#0` : value;
}

/**
 * The value as it is hashed: completed (see completeIdentityValue), then the protocol's
 * normalisation: ASCII-lowercase for case-insensitive types and for EVM (`0x…`) wallet
 * addresses; base58 (Solana) addresses are left untouched.
 */
export function normalizeIdentityValue(type: IdentityType, value: string): string {
  const complete = completeIdentityValue(type, value);
  const lower = isCaseInsensitive(type) || (type === IdentityType.Wallet && complete.startsWith('0x'));
  return lower ? complete.replace(/[A-Z]/g, (c) => c.toLowerCase()) : complete;
}

/**
 * `sha256(HASH_PREFIX || type || normalize(value))`, exactly as the circuit computes it.
 * This is the routing salt a payer uses to address an identity, and the value a proof's
 * `identityHash` output is compared against.
 */
export function identityHash(type: IdentityType, value: string, domain: string = HASH_PREFIX): `0x${string}` {
  const enc = new TextEncoder();
  const prefix = enc.encode(domain);
  const body = enc.encode(normalizeIdentityValue(type, value));
  if (body.length < 1 || body.length > 128) throw new Error('identity value must be 1..128 bytes');
  const preimage = new Uint8Array(prefix.length + 1 + body.length);
  preimage.set(prefix, 0);
  preimage[prefix.length] = type;
  preimage.set(body, prefix.length + 1);
  return toHex(sha256(preimage));
}

export function toHex(bytes: Uint8Array): `0x${string}` {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return `0x${s}`;
}
