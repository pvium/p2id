// Shared by deploy-verifier.ts and verifier-activate.ts: a circuit version's verifier-set record,
// its on-chain activation status, and the owner transactions that move it forward.
import { ethers } from 'hardhat';
import type { Signer } from 'ethers';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { circuitRelease, deployVerifierSet, hasCode, sortedKeys, type VerifierSetParams } from './deterministic';

export const DEPLOYMENTS = join(__dirname, '..', '..', 'deployments');

export interface OwnerTx {
  step: ActivationStep;
  description: string;
  to: string;
  value: '0';
  data: string;
}

/** The owner steps, in order. Only `approve` is needed for payers to use the verifier (fundWith). */
export type ActivationStep = 'approve' | 'release-alpha' | 'propose-default' | 'activate-default';
export const STEPS: ActivationStep[] = ['approve', 'release-alpha', 'propose-default', 'activate-default'];

export interface VerifierStatus {
  checkedAt: string;
  /** policy.isVerifierAllowed: payers can fundWith it and its deposits are claimable. */
  approved: boolean;
  /** factory.isAlpha(vkHash): proof-carrying claims need an alpha attestation while true. */
  alpha: boolean;
  /** factory.defaultVerifier: fund() deposits and bare transfers use it. */
  isDefault: boolean;
  /** A pending default-verifier proposal for it, and when it can be activated (unix seconds). */
  defaultProposedEta: number | null;
}

export function verifierSetFile(scheme: string, environment: string, circuitVersion: number, chainId: number): string {
  return join(DEPLOYMENTS, `${scheme}.${environment}.circuit-v${circuitVersion}.${chainId}.json`);
}

export function readRecord(file: string): any {
  if (!existsSync(file)) throw new Error(`no verifier-set record ${file}; deploy it first (yarn deploy:verifier)`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeRecord(file: string, record: any): void {
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
}

/** Read the verifier's activation state from the chain. */
export async function readStatus(r: { factory: string; policy: string; pviumVerifier: string; vkHash: string }): Promise<VerifierStatus> {
  const policy = await ethers.getContractAt('PviumP2IDPolicy', r.policy);
  const factory = await ethers.getContractAt('PviumP2IdVaultFactory', r.factory);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const proposed = await factory.proposedDefaultVerifier();
  const eta = Number(await factory.proposedDefaultEta());
  return {
    checkedAt: new Date().toISOString(),
    approved: await policy.isVerifierAllowed(r.pviumVerifier),
    alpha: await factory.isAlpha(r.vkHash),
    isDefault: same(await factory.defaultVerifier(), r.pviumVerifier),
    defaultProposedEta: eta !== 0 && same(proposed, r.pviumVerifier) ? eta : null,
  };
}

/** The owner transaction for `step`, or why it does not apply now. */
export async function ownerTx(r: any, status: VerifierStatus, step: ActivationStep): Promise<OwnerTx | string> {
  const policy = await ethers.getContractAt('PviumP2IDPolicy', r.policy);
  const factory = await ethers.getContractAt('PviumP2IdVaultFactory', r.factory);
  const tx = (to: string, data: string, description: string): OwnerTx => ({ step, description, to, value: '0', data });
  switch (step) {
    case 'approve':
      if (status.approved) return 'already approved in the policy';
      return tx(r.policy, policy.interface.encodeFunctionData('approveVerifier', [r.pviumVerifier, true]),
        `policy.approveVerifier(${r.pviumVerifier}, true): payers can fundWith the circuit v${r.circuitVersion} verifier`);
    case 'release-alpha':
      if (!status.alpha) return 'already released from alpha';
      return tx(r.factory, factory.interface.encodeFunctionData('setAlpha', [r.vkHash, false]),
        `factory.setAlpha(${r.vkHash}, false): claims under circuit v${r.circuitVersion} no longer need an alpha attestation`);
    case 'propose-default':
      if (status.isDefault) return 'already the default verifier';
      if (status.defaultProposedEta !== null) return `already proposed; activate after ${new Date(status.defaultProposedEta * 1000).toISOString()}`;
      if (!status.approved) return 'approve it in the policy first';
      return tx(r.factory, factory.interface.encodeFunctionData('proposeDefaultVerifier', [r.pviumVerifier]),
        `factory.proposeDefaultVerifier(${r.pviumVerifier}): starts the 14-day notice`);
    case 'activate-default': {
      if (status.isDefault) return 'already the default verifier';
      if (status.defaultProposedEta === null) return 'not proposed as the default yet (propose-default)';
      const now = Number((await ethers.provider.getBlock('latest'))!.timestamp);
      if (now < status.defaultProposedEta) return `notice runs until ${new Date(status.defaultProposedEta * 1000).toISOString()}`;
      return tx(r.factory, factory.interface.encodeFunctionData('activateDefaultVerifier', []),
        `factory.activateDefaultVerifier(): fund() deposits and bare transfers move to circuit v${r.circuitVersion}`);
    }
  }
}

/** Write a Safe Transaction Builder batch (Safe app > Transaction Builder > drag the file in). */
export function writeSafeBatch(file: string, chainId: number, name: string, txs: { description: string; to: string; value: string; data: string }[]): void {
  mkdirSync(join(DEPLOYMENTS, 'safe'), { recursive: true });
  const batch = {
    version: '1.0',
    chainId: String(chainId),
    createdAt: Date.now(),
    meta: { name, description: txs.map((t) => t.description).join('; ') },
    transactions: txs.map((t) => ({ to: t.to, value: t.value, data: t.data })),
  };
  writeFileSync(file, JSON.stringify(batch, null, 2) + '\n');
}

export function safeBatchFile(record: any, label: string): string {
  return join(DEPLOYMENTS, 'safe', `${record.scheme}.${record.environment}.circuit-v${record.circuitVersion}.${record.chainId}.${label}.json`);
}

const P2ID_JSON = join(__dirname, '..', '..', '..', 'sdks', 'node', 'p2id-core', 'src', 'p2id.json');

/**
 * Once the policy approves a verifier, record it in the core SDK's p2id.json (verifiers.<env>.<N>),
 * so clients fund new payments under it (p2idFundingVerifier). Every chain of an environment must
 * give the same address; a different one already recorded is an error. Returns what it did.
 */
export function recordApprovedVerifier(record: any): string {
  if (!record.status?.approved) return 'not approved in the policy yet: not recorded in p2id.json';
  const cfg = JSON.parse(readFileSync(P2ID_JSON, 'utf8'));
  const scheme = cfg.schemes[record.scheme];
  if (!scheme) throw new Error(`p2id.json has no scheme ${record.scheme}`);
  scheme.verifiers ??= { production: {}, sandbox: {} };
  const env = (scheme.verifiers[record.environment] ??= {});
  const key = String(record.circuitVersion);
  const existing: string | undefined = env[key];
  if (existing && existing.toLowerCase() !== record.pviumVerifier.toLowerCase()) {
    throw new Error(`p2id.json records ${existing} as the ${record.environment} circuit v${key} verifier, not ${record.pviumVerifier}: every chain of an environment must match`);
  }
  if (existing) return `p2id.json already records it as the ${record.environment} circuit v${key} verifier`;
  env[key] = record.pviumVerifier;
  writeFileSync(P2ID_JSON, JSON.stringify(cfg, null, 2) + '\n');
  return `recorded in sdks/node/p2id-core/src/p2id.json as the ${record.environment} circuit v${key} verifier: rebuild the SDK and commit it`;
}

export function printStatus(s: VerifierStatus): void {
  console.log(`  approved in policy: ${s.approved ? 'yes' : 'no'}`);
  console.log(`  alpha:              ${s.alpha ? 'yes (claims need an alpha attestation)' : 'released'}`);
  console.log(`  default verifier:   ${s.isDefault ? 'yes' : s.defaultProposedEta ? `proposed, activatable after ${new Date(s.defaultProposedEta * 1000).toISOString()}` : 'no'}`);
}

/**
 * Deploy (or find) a circuit version's verifier set next to a stack, read it back, and record it
 * with its activation status. No owner transaction is sent. Used by deploy-verifier.ts for one
 * version and by deploy-deterministic.ts for every version released after the stack's own.
 * With `signer === null` nothing is sent: the set must already be deployed, and it is read back.
 * `write: false` leaves the record file alone.
 */
export async function deployRecordedVerifierSet(o: {
  params: VerifierSetParams;
  keys: { kid?: string; x: bigint; y: bigint }[];
  stack: { factory: string; policy: string };
  environment: string;
  networkName: string;
  chainId: number;
  signer: Signer | null;
  write?: boolean;
  log?: (message: string) => void;
}): Promise<any> {
  const { params: p, keys, stack, chainId } = o;
  const log = o.log ?? (() => {});
  // Whether this run creates the verifier: its initial constraint signer is only guaranteed then (the owner may rotate it later).
  const fresh = !(await hasCode((await deployVerifierSet(p, null)).pviumVerifier, { reads: 1 }));
  const set = await deployVerifierSet(p, o.signer, log);

  const fail = (what: string, got: unknown, want: unknown) => { throw new Error(`deployment check failed: ${what} is ${got}, expected ${want}`); };
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  for (const [name, address] of Object.entries(set)) if (!(await hasCode(address))) fail(`code at ${name}`, 'empty', address);
  const identity = await ethers.getContractAt('PviumIdentity', set.pviumIdentity);
  if (!same(await identity.vkHash(), p.vkHash)) fail('PviumIdentity.vkHash', await identity.vkHash(), p.vkHash);
  if (Number(await identity.circuitVersion()) !== p.circuitVersion) fail('PviumIdentity.circuitVersion', await identity.circuitVersion(), p.circuitVersion);
  if (!same(await identity.owner(), p.owner)) fail('PviumIdentity.owner', await identity.owner(), p.owner);
  for (const k of sortedKeys(keys)) if (!(await identity.isSignerKey(k.x, k.y))) fail(`signer key ${k.x.toString(16).slice(0, 12)}…`, 'missing', 'accepted');
  const verifier = await ethers.getContractAt(circuitRelease(p.circuitVersion).verifier, set.pviumVerifier);
  if (!same(await verifier.pviumIdentity(), set.pviumIdentity)) fail('PviumVerifier.pviumIdentity', await verifier.pviumIdentity(), set.pviumIdentity);
  if (!same(await verifier.owner(), p.owner)) fail('PviumVerifier.owner', await verifier.owner(), p.owner);
  if (fresh && p.attester !== ethers.ZeroAddress && !(await verifier.isConstraintSigner(p.attester))) fail('constraint signer', 'not registered', p.attester);
  const factory = await ethers.getContractAt('PviumP2IdVaultFactory', stack.factory);
  if (!same(await factory.policy(), stack.policy)) fail('factory.policy', await factory.policy(), stack.policy);
  log(`circuit v${p.circuitVersion} verifier set checks passed`);

  const record: any = {
    kind: 'verifier-set', scheme: p.scheme, environment: o.environment, network: o.networkName, chainId,
    circuitVersion: p.circuitVersion, vkHash: p.vkHash,
    privyKeys: sortedKeys(keys).map((k) => ({ kid: keys.find((q) => q.x === k.x && q.y === k.y)?.kid, x: ethers.toBeHex(k.x, 32), y: ethers.toBeHex(k.y, 32) })),
    config: { owner: p.owner, attester: p.attester, circuitVersion: p.circuitVersion, vkHash: p.vkHash },
    ...set, factory: stack.factory, policy: stack.policy,
  };
  record.status = await readStatus(record);
  if (chainId !== 31337 && o.write !== false) writeRecord(verifierSetFile(p.scheme, o.environment, p.circuitVersion, chainId), record);
  return record;
}
