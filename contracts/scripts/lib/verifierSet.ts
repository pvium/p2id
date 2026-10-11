// Shared by deploy-verifier.ts and verifier-activate.ts: a circuit version's verifier-set record,
// its on-chain activation status, and the owner transactions that move it forward.
import { ethers } from 'hardhat';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

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
export function writeSafeBatch(file: string, chainId: number, name: string, txs: OwnerTx[]): void {
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

export function printStatus(s: VerifierStatus): void {
  console.log(`  approved in policy: ${s.approved ? 'yes' : 'no'}`);
  console.log(`  alpha:              ${s.alpha ? 'yes (claims need an alpha attestation)' : 'released'}`);
  console.log(`  default verifier:   ${s.isDefault ? 'yes' : s.defaultProposedEta ? `proposed, activatable after ${new Date(s.defaultProposedEta * 1000).toISOString()}` : 'no'}`);
}
