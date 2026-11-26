import { IdentityType, identityHash, resolveIdentityType, type IdentityTypeName } from '@pvium/p2id-core';
import { sha256 } from '@noble/hashes/sha256';
import { decodeClaim, type P256PublicKey, type PublicInputs } from './publicInputs.js';
import { parseP256PublicKeyPem } from './signer.js';
import { parseSolanaVerifyingKey, solanaVerifyingKey, verifyProof, verifySolanaProof } from './verify.js';
import { AttestationSigner, PVIUM_ENVIRONMENTS, type PviumEnvironmentName } from './environments.js';
import { CIRCUITS, CIRCUIT_VERSIONS, SOLANA_CIRCUITS } from './vk.js';
import type { GnarkVerifyingKey } from './solana/groth16.js';

/** Which chain's verifier a proof was made for: Ethereum (UltraHonk) or Solana (Groth16, via Sunspot). */
export type AttestationNetwork = 'ethereum' | 'solana';

/** What Pvium's resolution API returns for an identity: the proof plus the address it binds. */
export interface Attestation {
  /** Proof bytes, or base64 of them. */
  proof: Uint8Array | string;
  /**
   * Public inputs: raw bytes, base64 of them, or the hex fields. For a Solana attestation this is
   * Sunspot's public witness (the same fields behind a 12-byte header), as the prover returns it.
   */
  publicInputs: PublicInputs | string;
  /** Solana attestations also carry the public witness under this name; either is accepted. */
  publicWitness?: Uint8Array | string;
  /** The wallet address the proof binds to the identity, exactly as linked in Privy. */
  wallet: string;
  /** Which chain the proof was made for. Omitted means Ethereum. */
  network?: AttestationNetwork;
  /** Circuit version that produced the proof, as reported by the prover. Selects the
   *  verification key; when absent, `vkHash` selects it, and failing both every supported
   *  version is tried (newest first). */
  circuitVersion?: number;
  /**
   * sha256 of the verification key the prover used; must match the bundled key when present.
   * On Solana it also tells which environment's trusted setup the proof is under.
   */
  vkHash?: string;
}

/**
 * Who is trusted to have signed the token behind an attestation.
 *
 * - `AttestationSigner.Production` / `AttestationSigner.Sandbox` (or the strings `'production'` /
 *   `'sandbox'`): Pvium's Privy apps, keys pinned in the SDK, JWKS consulted only for a key
 *   rotated in after this release (see environments.ts).
 * - a JWKS URL (`https://…/jwks.json`) or `{ jwksUrl }`: any JWKS; every P-256 key it serves
 *   is accepted. For self-hosted provers under your own Privy app.
 * - a SPKI PEM string, or raw `{ x, y }`: one specific key.
 */
export type Signer = AttestationSigner | PviumEnvironmentName | string | { jwksUrl: string } | P256PublicKey;

export interface VerifyIdentityInput {
  attestation: Attestation;
  signer: Signer;
  identityType: IdentityType | IdentityTypeName;
  identityValue: string;
  /**
   * Solana only: verify under this Sunspot verifying key (gnark's raw `.vk` bytes) instead of the
   * keys bundled for Pvium's environments. For a self-hosted trusted setup.
   */
  solanaVerifyingKey?: Uint8Array;
}

export type VerifyIdentityResult =
  | {
      valid: true;
      /** The wallet address, now proven to be linked to the identity in the same Privy account. */
      wallet: string;
      /** When Privy issued the token the proof was made from (unix seconds). Freshness is your policy. */
      issuedAt: number;
      /** The circuit version whose verification key accepted the proof. */
      circuitVersion: number;
      /** The chain the proof was verified for; the wallet is an address on it. */
      network: AttestationNetwork;
    }
  | { valid: false; reason: string };

/**
 * Does this attestation prove that `identityValue` (of `identityType`) and `attestation.wallet`
 * belong to the same Privy user, signed by `signer`? On success the wallet is returned as a
 * trusted value together with the attestation time.
 */
export async function verifyIdentity(input: VerifyIdentityInput): Promise<VerifyIdentityResult> {
  return verifyIdentityFor(input, CIRCUIT_VERSIONS);
}

/** Which bundled Ethereum circuit versions may have produced `att`, or why none can. */
function candidateVersions(att: Attestation, supported: readonly number[]): number[] | string {
  const describe = supported.length === 1 ? `version ${supported[0]}` : `versions ${supported.join(', ')}`;
  if (att.circuitVersion !== undefined) {
    if (!supported.includes(att.circuitVersion)) {
      return `attestation is for circuit version ${att.circuitVersion}; this verifier supports ${describe}`;
    }
    if (att.vkHash !== undefined && att.vkHash.toLowerCase() !== CIRCUITS[att.circuitVersion].vkSha256) {
      return `attestation was produced by a different build of circuit version ${att.circuitVersion} than this SDK verifies`;
    }
    return [att.circuitVersion];
  }
  if (att.vkHash !== undefined) {
    const v = supported.find((n) => CIRCUITS[n].vkSha256 === att.vkHash!.toLowerCase());
    return v === undefined ? `attestation was produced by a circuit build this verifier does not support (${describe})` : [v];
  }
  return [...supported].reverse(); // no metadata: try each, newest first
}

interface SolanaCandidate {
  circuitVersion: number;
  vk: GnarkVerifyingKey;
}

/**
 * Which bundled Solana verifying keys may have produced `att`, or why none can. A key belongs to
 * one environment's trusted setup, so a signer naming an environment restricts the keys to it: a
 * proof under the sandbox setup never backs a production attestation.
 */
export function solanaCandidates(att: Attestation, supported: readonly number[], signer: Signer, custom?: Uint8Array): SolanaCandidate[] | string {
  const versions = att.circuitVersion === undefined ? [...supported].reverse() : [att.circuitVersion];
  if (att.circuitVersion !== undefined && !supported.includes(att.circuitVersion)) {
    const describe = supported.length === 1 ? `version ${supported[0]}` : `versions ${supported.join(', ')}`;
    return `attestation is for circuit version ${att.circuitVersion}; this verifier supports ${describe}`;
  }
  const vkHash = att.vkHash?.toLowerCase();
  if (custom) {
    if (vkHash !== undefined && vkHash !== toHex(sha256(custom))) return 'attestation was not produced for the given Solana verifying key';
    const vk = parseSolanaVerifyingKey(custom);
    return versions.map((circuitVersion) => ({ circuitVersion, vk }));
  }
  const signerEnv = typeof signer === 'string' && signer in PVIUM_ENVIRONMENTS ? (signer as PviumEnvironmentName) : undefined;
  const environments: PviumEnvironmentName[] = signerEnv ? [signerEnv] : ['production', 'sandbox'];
  const all = environments.flatMap((env) =>
    versions.filter((v) => SOLANA_CIRCUITS[env][v]).map((v) => ({ env, circuitVersion: v, vkSha256: SOLANA_CIRCUITS[env][v].vkSha256 })),
  );
  const matching = vkHash === undefined ? all : all.filter((c) => c.vkSha256 === vkHash);
  if (matching.length === 0) {
    const other = (['production', 'sandbox'] as const).find((env) => Object.values(SOLANA_CIRCUITS[env]).some((c) => c.vkSha256 === vkHash));
    if (other && signerEnv && other !== signerEnv) {
      return `attestation was proven under the ${other} Solana trusted setup; signer is ${signerEnv}`;
    }
    if (all.length === 0) {
      const where = signerEnv ? ` for the ${signerEnv} environment` : '';
      return `no Solana verifying key is bundled${where} for circuit ${versions.length === 1 ? `version ${versions[0]}` : `versions ${supported.join(', ')}`}`;
    }
    return 'attestation was produced by a Solana verifier build this SDK does not know';
  }
  return matching.map((c) => ({ circuitVersion: c.circuitVersion, vk: solanaVerifyingKey(c.env, c.circuitVersion) }));
}

/** verifyIdentity, restricted to the given bundled circuit versions. */
export async function verifyIdentityFor(input: VerifyIdentityInput, supported: readonly number[]): Promise<VerifyIdentityResult> {
  let type: IdentityType;
  try {
    type = resolveIdentityType(input.identityType);
  } catch (e) {
    return { valid: false, reason: (e as Error).message };
  }

  const att = input.attestation;
  const network = att.network ?? 'ethereum';
  if (network !== 'ethereum' && network !== 'solana') return { valid: false, reason: `unknown attestation network "${String(network)}"` };
  const proof = typeof att.proof === 'string' ? fromBase64(att.proof) : att.proof;
  const rawInputs = network === 'solana' ? (att.publicInputs ?? att.publicWitness) : att.publicInputs;
  if (rawInputs === undefined) return { valid: false, reason: 'malformed attestation: no public inputs' };
  const publicInputs = typeof rawInputs === 'string' ? fromBase64(rawInputs) : rawInputs;

  let claim;
  try {
    claim = decodeClaim(publicInputs);
  } catch (e) {
    return { valid: false, reason: `malformed attestation: ${(e as Error).message}` };
  }

  let trusted: P256PublicKey[];
  try {
    trusted = await trustedKeys(input.signer, claim.signer);
  } catch (e) {
    return { valid: false, reason: (e as Error).message };
  }
  if (!trusted.some((k) => k.x === claim.signer.x && k.y === claim.signer.y)) {
    return { valid: false, reason: 'not signed by a trusted key' };
  }
  if (claim.identityType !== type) return { valid: false, reason: 'identity type mismatch' };
  if (identityHash(type, input.identityValue) !== claim.identityHash) {
    return { valid: false, reason: 'identity value mismatch' };
  }
  if (claim.walletHash === null) return { valid: false, reason: 'attestation carries no wallet' };
  if (identityHash(IdentityType.Wallet, att.wallet) !== claim.walletHash) {
    return { valid: false, reason: 'wallet mismatch' };
  }
  // For an EVM wallet the circuit also exposes the address it read from the token; it must agree.
  const w = att.wallet;
  if (w.toLowerCase().startsWith('0x') && claim.wallet !== w.toLowerCase()) {
    return { valid: false, reason: 'wallet mismatch' };
  }

  let proven: number | undefined;
  if (network === 'solana') {
    let candidates: SolanaCandidate[] | string;
    try {
      candidates = solanaCandidates(att, supported, input.signer, input.solanaVerifyingKey);
    } catch (e) {
      return { valid: false, reason: `malformed Solana verifying key: ${(e as Error).message}` };
    }
    if (typeof candidates === 'string') return { valid: false, reason: candidates };
    for (const c of candidates) {
      if (verifySolanaProof({ proof, publicInputs }, c.vk)) {
        proven = c.circuitVersion;
        break;
      }
    }
  } else {
    const versions = candidateVersions(att, supported);
    if (typeof versions === 'string') return { valid: false, reason: versions };
    try {
      for (const version of versions) {
        if (await verifyProof({ proof, publicInputs }, version)) {
          proven = version;
          break;
        }
      }
    } catch (e) {
      return { valid: false, reason: (e as Error).message }; // the backend failed; says so, not "invalid proof"
    }
  }
  if (proven === undefined) return { valid: false, reason: 'invalid proof' };

  return { valid: true, wallet: att.wallet, issuedAt: claim.iat, circuitVersion: proven, network };
}

async function trustedKeys(signer: Signer, claimSigner?: P256PublicKey): Promise<P256PublicKey[]> {
  if (typeof signer === 'string') {
    if (signer in PVIUM_ENVIRONMENTS) {
      const env = PVIUM_ENVIRONMENTS[signer as PviumEnvironmentName];
      const pinned = env.keys;
      // Pinned keys answer without a network call; fall back to the live JWKS only when the
      // attestation names a key we do not know (rotated in after this SDK release).
      if (!claimSigner || pinned.some((k) => k.x === claimSigner.x && k.y === claimSigner.y)) return pinned;
      try {
        return [...pinned, ...(await fetchJwks(env.jwksUrl))];
      } catch {
        return pinned;
      }
    }
    if (/^https?:\/\//i.test(signer)) return fetchJwks(signer);
    if (signer.includes('-----BEGIN')) return [parseP256PublicKeyPem(signer)];
    throw new Error(`unrecognised signer: expected AttestationSigner.Production/Sandbox, a JWKS URL, a PEM, or {x, y}`);
  }
  if ('jwksUrl' in signer) return fetchJwks(signer.jwksUrl);
  return [signer];
}

const jwksCache = new Map<string, { at: number; keys: P256PublicKey[] }>();
const JWKS_TTL_MS = 10 * 60 * 1000;

async function fetchJwks(url: string): Promise<P256PublicKey[]> {
  const hit = jwksCache.get(url);
  if (hit && Date.now() - hit.at < JWKS_TTL_MS) return hit.keys;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: Array<{ kty?: string; crv?: string; x?: string; y?: string }> };
  const keys = (body.keys ?? [])
    .filter((k) => k.kty === 'EC' && k.crv === 'P-256' && k.x && k.y)
    .map((k) => ({ x: b64urlToBigInt(k.x!), y: b64urlToBigInt(k.y!) }));
  if (keys.length === 0) throw new Error('JWKS has no P-256 keys');
  jwksCache.set(url, { at: Date.now(), keys });
  return keys;
}

function fromBase64(s: string): Uint8Array {
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(std.padEnd(std.length + ((4 - (std.length % 4)) % 4), '=')), (c) => c.charCodeAt(0));
}

function b64urlToBigInt(s: string): bigint {
  let v = 0n;
  for (const b of fromBase64(s)) v = (v << 8n) | BigInt(b);
  return v;
}

function toHex(b: Uint8Array): string {
  return '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
