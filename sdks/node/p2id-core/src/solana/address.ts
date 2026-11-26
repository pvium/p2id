import { sha256 } from '@noble/hashes/sha256';
import type { IdentityType } from '../identity.js';
import type { IdentityTypeName } from '../identityNames.js';
import {
  assertEnvironment, identityHash, p2idScheme, P2ID_SCHEME,
  type P2IDEnvironment, type P2IDSchemeName, type P2IDSolanaFactory, type P2IDSolanaFactoryParams, type P2IDSolanaVerifier,
} from '../scheme.js';
import { findProgramAddress, fromBase58, toBase58, type Pubkey } from './pda.js';

/**
 * P2ID on Solana. The same identity commitment as on EVM seeds a vault owned by the router program:
 *
 *   factory  = PDA(["p2id.factory.v1", scheme, authority, paramsHash], router)
 *   vault    = PDA(["p2id.vault.v1", factory, identityHash],           router)
 *   deposit  = PDA(["p2id.deposit.v1", vault, depositId_le_u64],       router)
 *
 * The factory address commits to who administers it and to every parameter it was initialized
 * with, as the EVM factory's CREATE2 address commits to its constructor arguments, so a deployment
 * is reproducible from `(router, authority, params)` and the vault PDA includes it. The programs
 * have one id on every cluster; each Pvium environment (`production` on mainnet, `sandbox` on
 * devnet) has its own factory, because its verifier keys differ.
 */

export const SOLANA_SEEDS = {
  factory: 'p2id.factory.v1',
  vault: 'p2id.vault.v1',
  deposit: 'p2id.deposit.v1',
  vaultMint: 'p2id.vault-mint.v1',
  verifier: 'p2id.verifier.v1',
  implAuthority: 'p2id.impl-authority.v1',
  policy: 'p2id.policy.v1',
  policyMint: 'p2id.policy-mint.v1',
} as const;

/** Domain of the factory parameter commitment. */
export const FACTORY_PARAMS_PREFIX = 'p2id.factory.params.v1';
/** Domain of what a constraint signer signs on Solana. */
export const CONSTRAINT_PREFIX = 'p2id.constraint.sol.v1';
/** Domain of an alpha attester's approval. */
export const ALPHA_PREFIX = 'p2id.alpha.sol.v1';

export const SYSTEM_PROGRAM_ID: Pubkey = '11111111111111111111111111111111';
export const TOKEN_PROGRAM_ID: Pubkey = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID: Pubkey = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN_PROGRAM_ID: Pubkey = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const INSTRUCTIONS_SYSVAR_ID: Pubkey = 'Sysvar1nstructions1111111111111111111111111';

export interface SolanaSchemeOptions {
  /** Address scheme; defaults to the current one (`P2ID_SCHEME`). */
  scheme?: P2IDSchemeName | string;
}

export interface SolanaEnvironmentOptions extends SolanaSchemeOptions {
  /** Pvium environment; defaults to `production`. Use `sandbox` on devnet. */
  environment?: P2IDEnvironment;
  /** Derive against another factory than the environment's (e.g. a local deployment). */
  factory?: Pubkey;
}

/** The scheme's Solana program ids. */
export function solanaPrograms(options: SolanaSchemeOptions = {}): { router: Pubkey; policy: Pubkey; implementation: Pubkey } {
  return p2idScheme(options.scheme).solana.programs;
}

/** The recorded factory of an environment, or null when none is recorded in this release. */
export function solanaFactory(options: Omit<SolanaEnvironmentOptions, 'factory'> = {}): P2IDSolanaFactory | null {
  const env = options.environment ?? 'production';
  assertEnvironment(env);
  return p2idScheme(options.scheme).solana.factories[env];
}

function factoryOf(options: SolanaEnvironmentOptions): Pubkey {
  if (options.factory) return options.factory;
  const recorded = solanaFactory(options);
  if (!recorded) {
    throw new Error(`scheme ${options.scheme ?? P2ID_SCHEME} has no ${options.environment ?? 'production'} Solana factory in this release yet; pass \`factory\` explicitly`);
  }
  return recorded.address;
}

/**
 * The commitment to a factory's parameters other than its authority:
 * sha256("p2id.factory.params.v1" ‖ nKeys_u8 ‖ signerKey_1 ‖ … ‖ defaultVerifier ‖ policy
 *        ‖ defaultImplementation ‖ alphaAttester ‖ circuitVersion_be_u16 ‖ vkHash
 *        ‖ minRefundWindow_be_i64 ‖ maxRefundWindow_be_i64)
 */
export function factoryParamsHash(params: P2IDSolanaFactoryParams): `0x${string}` {
  if (params.signerKeys.length > 255) throw new Error('too many signer keys');
  const h = sha256.create();
  h.update(utf8(FACTORY_PARAMS_PREFIX));
  h.update(new Uint8Array([params.signerKeys.length]));
  for (const key of params.signerKeys) h.update(hexToBytes(key, 64, 'signer key'));
  h.update(fromBase58(params.defaultVerifier));
  h.update(fromBase58(params.policy));
  h.update(fromBase58(params.defaultImplementation));
  h.update(fromBase58(params.alphaAttester));
  h.update(u16be(params.circuitVersion));
  h.update(hexToBytes(params.vkHash, 32, 'vkHash'));
  h.update(i64be(params.minRefundWindow));
  h.update(i64be(params.maxRefundWindow));
  return hex(h.digest());
}

/** The factory a given authority and parameter set lands at, and the parameter commitment. */
export function factoryAddress(
  input: { authority: Pubkey; params: P2IDSolanaFactoryParams; router?: Pubkey } & SolanaSchemeOptions,
): { address: Pubkey; bump: number; paramsHash: `0x${string}` } {
  const router = input.router ?? solanaPrograms(input).router;
  const paramsHash = factoryParamsHash(input.params);
  const { address, bump } = findProgramAddress(
    [SOLANA_SEEDS.factory, input.scheme ?? P2ID_SCHEME, fromBase58(input.authority), hexToBytes(paramsHash, 32, 'paramsHash')],
    router,
  );
  return { address, bump, paramsHash };
}

/** The fee policy account for an authority and rate (a seed, so a new rate is a new policy). */
export function policyAddress(input: { authority: Pubkey; feeBps: number; router?: Pubkey; policyProgram?: Pubkey } & SolanaSchemeOptions): Pubkey {
  const programs = solanaPrograms(input);
  return findProgramAddress(
    [SOLANA_SEEDS.policy, fromBase58(input.authority), fromBase58(input.router ?? programs.router), u16be(input.feeBps)],
    input.policyProgram ?? programs.policy,
  ).address;
}

/** The policy's fee account for a token mint. */
export function policyMintAddress(policy: Pubkey, mint: Pubkey, options: SolanaSchemeOptions & { policyProgram?: Pubkey } = {}): Pubkey {
  return findProgramAddress([SOLANA_SEEDS.policyMint, fromBase58(policy), fromBase58(mint)], options.policyProgram ?? solanaPrograms(options).policy).address;
}

/** A verifier program's config under a factory: whether it is allowed, its keys, signers and alpha state. */
export function verifierConfigAddress(verifierProgram: Pubkey, options: SolanaEnvironmentOptions = {}): Pubkey {
  return findProgramAddress([SOLANA_SEEDS.verifier, fromBase58(factoryOf(options)), fromBase58(verifierProgram)], solanaPrograms(options).router).address;
}

/** The authority PDA an implementation program signs router calls with. */
export function implAuthorityAddress(options: SolanaSchemeOptions & { implementation?: Pubkey } = {}): Pubkey {
  return findProgramAddress([SOLANA_SEEDS.implAuthority], options.implementation ?? solanaPrograms(options).implementation).address;
}

export interface P2IDSolanaAddressInput extends SolanaEnvironmentOptions {
  identityType: IdentityType | IdentityTypeName;
  /** The identity as the user linked it, e.g. "you@example.com". Case does not matter. */
  identityValue: string;
}

/** The P2ID vault for an identity: where to pay it on Solana, deployed or not. Base58. */
export function p2idAddress(input: P2IDSolanaAddressInput): Pubkey {
  return p2idAddressForHash(identityHash(input.identityType, input.identityValue, input.scheme), input);
}

/** Same, from an identity hash you already have (e.g. from an attestation's claim). */
export function p2idAddressForHash(identityHash: `0x${string}`, options: SolanaEnvironmentOptions = {}): Pubkey {
  return findProgramAddress(
    [SOLANA_SEEDS.vault, fromBase58(factoryOf(options)), hexToBytes(identityHash, 32, 'identityHash')],
    solanaPrograms(options).router,
  ).address;
}

/** The record of deposit `id` of a vault (`Funded` carries the id; the vault's `deposit_seq` is the next one). */
export function depositAddress(vault: Pubkey, id: number | bigint, options: SolanaSchemeOptions = {}): Pubkey {
  return findProgramAddress([SOLANA_SEEDS.deposit, fromBase58(vault), u64le(id)], solanaPrograms(options).router).address;
}

/** A vault's per-mint record (tracked token balance). */
export function vaultMintAddress(vault: Pubkey, mint: Pubkey, options: SolanaSchemeOptions = {}): Pubkey {
  return findProgramAddress([SOLANA_SEEDS.vaultMint, fromBase58(vault), fromBase58(mint)], solanaPrograms(options).router).address;
}

/** The associated token account of an owner for a mint (classic SPL Token unless `tokenProgram` says Token-2022). */
export function associatedTokenAddress(owner: Pubkey, mint: Pubkey, tokenProgram: Pubkey = TOKEN_PROGRAM_ID): Pubkey {
  return findProgramAddress([fromBase58(owner), fromBase58(tokenProgram), fromBase58(mint)], ASSOCIATED_TOKEN_PROGRAM_ID).address;
}

/**
 * The verifier new payments should fund under in an environment: the newest circuit version's,
 * as recorded for the scheme. Null when none is recorded. A deposit is claimed through the
 * verifier it was funded under, so record it with the payment.
 */
export function p2idFundingVerifier(
  options: Omit<SolanaEnvironmentOptions, 'factory'> = {},
): { circuitVersion: number; verifier: P2IDSolanaVerifier } | null {
  const env = options.environment ?? 'production';
  assertEnvironment(env);
  const recorded = p2idScheme(options.scheme).solana.verifiers[env];
  const newest = Object.keys(recorded).map(Number).sort((a, b) => b - a)[0];
  return newest === undefined ? null : { circuitVersion: newest, verifier: recorded[String(newest)] };
}

/** The verifier of one circuit version in an environment, or null when not recorded. */
export function p2idVerifier(circuitVersion: number, options: Omit<SolanaEnvironmentOptions, 'factory'> = {}): P2IDSolanaVerifier | null {
  const env = options.environment ?? 'production';
  assertEnvironment(env);
  return p2idScheme(options.scheme).solana.verifiers[env][String(circuitVersion)] ?? null;
}

export interface FundInput extends SolanaEnvironmentOptions {
  /** The payee's identity commitment, `identityHash(type, value)`. */
  identityHash: `0x${string}`;
  /** The vault's next deposit id: its `deposit_seq` (0 for a vault that does not exist yet). */
  depositId: number | bigint;
  /** Who pays. */
  funder: Pubkey;
  /** The verifier program to fund under; defaults to the newest recorded for the environment. */
  verifierProgram?: Pubkey;
  /** The factory's policy account; defaults to the recorded factory's. Required with a custom `factory`. */
  policy?: Pubkey;
  /** Token mint for `fund_token`; omit for SOL. */
  mint?: Pubkey;
  /** The mint's token program: classic SPL Token (default) or Token-2022. */
  tokenProgram?: Pubkey;
}

export interface FundSolAccounts {
  factory: Pubkey;
  verifierConfig: Pubkey;
  vault: Pubkey;
  deposit: Pubkey;
  policy: Pubkey;
  policyProgram: Pubkey;
  funder: Pubkey;
  implAuthority: Pubkey;
  routerProgram: Pubkey;
  systemProgram: Pubkey;
}

export interface FundTokenAccounts extends FundSolAccounts {
  vaultMint: Pubkey;
  mint: Pubkey;
  funderTokenAccount: Pubkey;
  vaultTokenAccount: Pubkey;
  tokenProgram: Pubkey;
  associatedTokenProgram: Pubkey;
}

/**
 * Every account the implementation program's `fund_sol` (no `mint`) or `fund_token` instruction
 * takes, named as the Anchor client expects them, plus the program to call. The caller adds the
 * arguments (`amount`, `constraint`, `refund_window`, `refunder`, `reference`) and signs as `funder`.
 */
export function fundAccounts(input: FundInput & { mint?: undefined }): { program: Pubkey; accounts: FundSolAccounts };
export function fundAccounts(input: FundInput & { mint: Pubkey }): { program: Pubkey; accounts: FundTokenAccounts };
export function fundAccounts(input: FundInput): { program: Pubkey; accounts: FundSolAccounts | FundTokenAccounts } {
  const programs = solanaPrograms(input);
  const recorded = input.factory ? null : solanaFactory(input);
  const factory = factoryOf(input);
  const verifierProgram = input.verifierProgram ?? p2idFundingVerifier(input)?.verifier.program;
  if (!verifierProgram) throw new Error(`no verifier is recorded for the ${input.environment ?? 'production'} environment; pass \`verifierProgram\``);
  const policy = input.policy ?? recorded?.params.policy;
  if (!policy) throw new Error('pass `policy` with a custom factory');
  const vault = p2idAddressForHash(input.identityHash, input);
  const accounts: FundSolAccounts = {
    factory,
    verifierConfig: verifierConfigAddress(verifierProgram, { ...input, factory }),
    vault,
    deposit: depositAddress(vault, input.depositId, input),
    policy,
    policyProgram: programs.policy,
    funder: input.funder,
    implAuthority: implAuthorityAddress(input),
    routerProgram: programs.router,
    systemProgram: SYSTEM_PROGRAM_ID,
  };
  if (!input.mint) return { program: programs.implementation, accounts };
  const tokenProgram = input.tokenProgram ?? TOKEN_PROGRAM_ID;
  return {
    program: programs.implementation,
    accounts: {
      ...accounts,
      vaultMint: vaultMintAddress(vault, input.mint, input),
      mint: input.mint,
      funderTokenAccount: associatedTokenAddress(input.funder, input.mint, tokenProgram),
      vaultTokenAccount: associatedTokenAddress(vault, input.mint, tokenProgram),
      tokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    },
  };
}

/**
 * What a constraint signer signs to release a constrained deposit on Solana:
 * `"p2id.constraint.sol.v1" ‖ factory ‖ commitment`, verified by the Ed25519 program in the
 * claiming transaction. The commitment is the same 32 bytes as on EVM (`constraintCommitment`).
 */
export function constraintMessage(input: { factory: Pubkey; commitment: `0x${string}` }): Uint8Array {
  return concat(utf8(CONSTRAINT_PREFIX), fromBase58(input.factory), hexToBytes(input.commitment, 32, 'commitment'));
}

/** Actions an alpha approval names. */
export const ALPHA_ACTION = { ownerUpdate: 1, claim: 2, sweepUntracked: 3, setImplementation: 4 } as const;

/**
 * What the factory's alpha attester signs to approve one payout while a verifier is in alpha:
 * `"p2id.alpha.sol.v1" ‖ deadline_le_i64 ‖ sha256(factory ‖ vault ‖ verifier ‖ destination ‖ iat_le_i64 ‖ action ‖ subject ‖ epoch_le_u64)`.
 * `subject` is the deposit for a claim, the mint (zero for SOL) for a sweep, the program for an
 * implementation change, and zero for an owner update.
 */
export function alphaApprovalMessage(input: {
  factory: Pubkey; vault: Pubkey; verifier: Pubkey; destination: Pubkey;
  iat: number | bigint; action: number; subject?: Pubkey; epoch: number | bigint; deadline: number | bigint;
}): Uint8Array {
  const digest = sha256(concat(
    fromBase58(input.factory), fromBase58(input.vault), fromBase58(input.verifier), fromBase58(input.destination),
    i64le(input.iat), new Uint8Array([input.action]), input.subject ? fromBase58(input.subject) : new Uint8Array(32), i64le(input.epoch),
  ));
  return concat(utf8(ALPHA_PREFIX), i64le(input.deadline), digest);
}

export { toBase58, fromBase58 };

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function hex(bytes: Uint8Array): `0x${string}` {
  let s = '0x';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s as `0x${string}`;
}

function hexToBytes(value: string, length: number, name: string): Uint8Array {
  const h = value.startsWith('0x') ? value.slice(2) : value;
  if (h.length !== length * 2 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error(`${name} must be ${length} bytes of hex, got ${value}`);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function u16be(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error(`not a u16: ${n}`);
  return new Uint8Array([n >> 8, n & 0xff]);
}

function i64be(n: number | bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, BigInt(n), false);
  return out;
}

function i64le(n: number | bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, BigInt(n), true);
  return out;
}

function u64le(n: number | bigint): Uint8Array {
  const v = BigInt(n);
  if (v < 0n || v > 0xffffffffffffffffn) throw new Error(`not a u64: ${n}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
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
