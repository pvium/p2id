// After a stack exists on a chain: bring it up to everything the scheme has released since its
// factory and to the environment's current owner settings (contracts/releases.json). Shared by
// deploy-deterministic.ts and the tests.
import { ethers } from 'hardhat';
import type { Signer } from 'ethers';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import {
  circuitRelease, circuitVersions, deployVerifierSet, environmentSettings, hasCode, vaultImplementationReleases,
  type StackAddresses, type StackParams,
} from './deterministic';
import { planImplementation } from './implementation';
import {
  DEPLOYMENTS, deployRecordedVerifierSet, ownerTx, readStatus, recordApprovedVerifier, safeBatchFile, verifierSetFile, writeRecord, writeSafeBatch,
} from './verifierSet';

/** keccak256("pvium.vault.implementation.v1"): PviumP2IdVaultFactory.IMPLEMENTATION_SALT, for offline prediction. */
export const IMPLEMENTATION_SALT = ethers.id('pvium.vault.implementation.v1');
export const laterCircuits = (stackCircuit: number) => circuitVersions().filter((v) => v > stackCircuit);
export const verifierSetParams = (p: StackParams, circuitVersion: number) => ({
  scheme: p.scheme, salt: p.salt, owner: p.owner, circuitVersion, vkHash: circuitRelease(circuitVersion).vkHash, signerKeys: p.signerKeys, attester: p.attester,
});

/** One transaction only a contract's owner can send. Steps sharing a `label` form one Safe batch. */
export interface OwnerStep {
  /** Names the step's Safe batch file: <scheme>.<environment>.<chainId>.<label>.json. */
  label: string;
  /** Safe batch title. */
  title: string;
  description: string;
  to: string;
  value: '0';
  data: string;
  file: string;
  /** Bookkeeping once it is on chain (refresh a record). */
  after?: () => Promise<void>;
}

export interface SyncResult {
  /** Owner transactions still to be sent (written as Safe batches): empty when the chain is up to date. */
  pending: OwnerStep[];
  /** Owner transactions this run sent, because the signer is the owner. */
  sent: OwnerStep[];
  /** What a deployment run still has to deploy (only with `signer === null`). */
  undeployed: string[];
  /** The Safe batch holding every pending transaction, in order; null when none or on a local chain. */
  combinedBatch: string | null;
}

export function ownerPendingFile(scheme: string, environment: string, chainId: number): string {
  return join(DEPLOYMENTS, 'safe', `${scheme}.${environment}.${chainId}.owner-pending.json`);
}

/**
 * Bring a deployed stack up to date:
 *  - bind the launch policy to its factory (once);
 *  - set the environment's current alpha attester and constraint signers where a chain still has
 *    the values it was deployed with;
 *  - deploy each later circuit version's verifier set and approve it in the policy;
 *  - deploy and propose each later vault implementation through the factory, and register it once
 *    the factory's notice has passed.
 * Contracts are deployed by `signer`. Owner transactions are sent when `signer` is that contract's
 * owner; otherwise they are simulated as the owner and written as Safe Transaction Builder
 * batches: one per step, plus one holding all of them in order (owner-pending). With
 * `signer === null` nothing is sent at all: the chain is read and the batches are written.
 * Re-runnable at any time: whatever is already deployed, set, approved, proposed or registered is
 * skipped, so the pending batch is always exactly what is left.
 */
export async function syncReleases(o: {
  environment: string; networkName: string; chainId: number; params: StackParams;
  keys: { kid?: string; x: bigint; y: bigint }[]; addresses: StackAddresses; signer: Signer | null;
  log?: (message: string) => void;
}): Promise<SyncResult> {
  const { environment, chainId, params, addresses, signer } = o;
  const scheme = params.scheme;
  const log = o.log ?? (() => {});
  const recorded = chainId !== 31337;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const stepFile = (label: string) => join(DEPLOYMENTS, 'safe', `${scheme}.${environment}.${chainId}.${label}.json`);
  const steps: OwnerStep[] = [];
  const undeployed: string[] = [];
  const settings = environmentSettings(environment);

  const factory = await ethers.getContractAt('PviumP2IdVaultFactory', addresses.factory);
  const policy = await ethers.getContractAt('PviumP2IDPolicy', addresses.policy);

  // The launch policy takes fees only from its factory's vaults; until bound it refuses every fee.
  if ((await policy.factory()) === ethers.ZeroAddress) {
    steps.push({
      label: 'set-factory', title: 'Bind the policy to its factory', file: stepFile('set-factory'), to: addresses.policy, value: '0',
      data: policy.interface.encodeFunctionData('setFactory', [addresses.factory]),
      description: `policy.setFactory(${addresses.factory}): the policy accepts fees from this factory's vaults`,
    });
  }

  if (settings.alphaAttester && !same(await factory.defaultAttester(), settings.alphaAttester)) {
    steps.push({
      label: 'rotate-attester', title: 'Rotate alpha attester', file: stepFile('rotate-attester'), to: addresses.factory, value: '0',
      data: factory.interface.encodeFunctionData('setDefaultAttester', [settings.alphaAttester]),
      description: `factory.setDefaultAttester(${settings.alphaAttester}): replaces ${await factory.defaultAttester()}; invalidates outstanding alpha authorizations`,
    });
  }

  // Verifier sets: the stack's own, then one per later circuit version.
  const verifiers: { circuitVersion: number; address: string }[] = [{ circuitVersion: params.circuitVersion, address: addresses.pviumVerifier }];
  for (const version of laterCircuits(params.circuitVersion)) {
    log(`\ncircuit v${version} verifier set`);
    const setParams = verifierSetParams(params, version);
    if (signer === null) {
      const predicted = await deployVerifierSet(setParams, null);
      const missing: string[] = [];
      for (const [name, address] of Object.entries(predicted)) if (!(await hasCode(address))) missing.push(name);
      if (missing.length) {
        log(`  not deployed yet (${missing.join(', ')}): a deployment run deploys it; its owner steps follow`);
        undeployed.push(`circuit v${version} verifier set (${missing.join(', ')})`);
        continue;
      }
    }
    const record = await deployRecordedVerifierSet({
      params: setParams, keys: o.keys, stack: addresses, environment, networkName: o.networkName, chainId, signer, write: signer !== null, log,
    });
    verifiers.push({ circuitVersion: version, address: record.pviumVerifier });
    const approve = await ownerTx(record, record.status, 'approve');
    if (typeof approve === 'string') {
      log(`  approve: ${approve}`);
    } else {
      steps.push({
        label: `circuit-v${version}.approve`, title: `Approve circuit v${version} verifier`, file: safeBatchFile(record, 'approve'),
        to: approve.to, value: '0', data: approve.data, description: approve.description,
        after: async () => {
          for (let i = 0; i < 30 && !(record.status = await readStatus(record)).approved; i++) await new Promise((r) => setTimeout(r, 2000));
          if (!record.status.approved) throw new Error(`circuit v${version}: the approval was sent but the policy does not show it yet; re-run to continue`);
          if (recorded) writeRecord(verifierSetFile(scheme, environment, version, chainId), record);
        },
      });
    }
    if (recorded && signer !== null) log(`  ${recordApprovedVerifier(record)}`);
  }

  // Constraint signers, on every verifier: additions before removals, so a verifier is never left without one.
  for (const v of verifiers) {
    const verifier = await ethers.getContractAt(circuitRelease(v.circuitVersion).verifier, v.address);
    const set = (signerAddress: string, allowed: boolean): OwnerStep => ({
      label: 'rotate-constraint-signer', title: 'Rotate constraint signer', file: stepFile('rotate-constraint-signer'), to: v.address, value: '0',
      data: verifier.interface.encodeFunctionData('setConstraintSigner', [signerAddress, allowed]),
      description: `circuit v${v.circuitVersion} verifier ${v.address}: ${allowed ? 'add' : 'remove'} constraint signer ${signerAddress}`,
    });
    for (const s of settings.constraintSigners ?? []) if (!(await verifier.isConstraintSigner(s))) steps.push(set(s, true));
    for (const s of settings.retiredConstraintSigners ?? []) if (await verifier.isConstraintSigner(s)) steps.push(set(s, false));
  }

  // Vault implementations. The factory holds one proposal at a time, so only the first one that is
  // not registered yet moves in a run.
  for (const impl of vaultImplementationReleases(scheme)) {
    log(`\nvault implementation ${impl.contract}`);
    const plan = await planImplementation(addresses.factory, impl.contract, impl.makeDefault);
    if (plan.alreadyRegistered) {
      log(`  ${plan.address} is registered`);
      continue;
    }
    const proposed: string = await factory.proposedImplementation();
    const eta = Number(await factory.proposedImplementationEta());
    if (eta !== 0 && same(proposed, plan.address)) {
      const now = Number((await ethers.provider.getBlock('latest'))!.timestamp);
      if (now < eta) {
        log(`  ${plan.address} is proposed; it can be registered after ${new Date(eta * 1000).toISOString()} (run again then)`);
      } else {
        steps.push({
          label: `${impl.label}-register`, title: `${impl.contract}: register`, file: stepFile(`${impl.label}-register`), to: addresses.factory, value: '0',
          data: factory.interface.encodeFunctionData('registerImplementation', []),
          description: `factory.registerImplementation(): registers ${impl.contract} at ${plan.address}${impl.makeDefault ? ' and makes it the implementation new vaults start on' : ''}; existing vaults stay on theirs until their owner upgrades`,
        });
      }
    } else if (eta !== 0) {
      log(`  the factory has another proposal pending (${proposed}); ${impl.contract} can be proposed once that is registered or cancelled`);
    } else {
      steps.push({
        label: `${impl.label}-propose`, title: `${impl.contract}: deploy and propose`, file: stepFile(`${impl.label}-propose`), to: addresses.factory, value: '0',
        data: plan.calldata,
        description: `factory.deployVaultImplementation(creationCode, ${impl.makeDefault}): deploys ${impl.contract} at ${plan.address} (creationCodeHash ${ethers.keccak256(plan.creationCode)}) and proposes it${impl.makeDefault ? ' as the default implementation for new vaults' : ''}. Starts the notice; changes nothing until registerImplementation().`,
      });
    }
    break;
  }

  // Send what this signer owns; everything else is simulated as its owner and left for the Safe.
  const ownerOf = async (to: string): Promise<string> => new ethers.Contract(to, ['function owner() view returns (address)'], ethers.provider).owner();
  const me = signer === null ? null : await signer.getAddress();
  const pending: OwnerStep[] = [];
  const sent: OwnerStep[] = [];
  if (steps.length) log('\nowner steps');
  for (const step of steps) {
    const owner = await ownerOf(step.to);
    if (signer !== null && me !== null && same(owner, me)) {
      await (await signer.sendTransaction({ to: step.to, data: step.data })).wait();
      if (step.after) await step.after();
      log(`  sent     ${step.description}`);
      sent.push(step);
      continue;
    }
    try {
      await ethers.provider.call({ from: owner, to: step.to, data: step.data });
    } catch (err) {
      throw new Error(`owner step would revert when sent by ${owner}: ${step.description}\n  ${(err as Error).message}`);
    }
    log(`  pending  ${step.description}\n           owner ${owner} sends to ${step.to}`);
    pending.push(step);
  }

  let combinedBatch: string | null = null;
  if (recorded) {
    const byFile = new Map<string, OwnerStep[]>();
    for (const step of pending) byFile.set(step.file, [...(byFile.get(step.file) ?? []), step]);
    for (const [file, group] of byFile) writeSafeBatch(file, chainId, group[0].title, group);
    const combined = ownerPendingFile(scheme, environment, chainId);
    if (pending.length) {
      writeSafeBatch(combined, chainId, `P2ID ${environment}: ${pending.length} pending owner transaction${pending.length === 1 ? '' : 's'}`, pending);
      combinedBatch = combined;
      log(`\nSafe batch with all ${pending.length} pending owner transactions, in order:\n  ${combined}\n  (Safe app > Transaction Builder > drop the file; the same transactions are also written one file per step)`);
    } else if (existsSync(combined)) {
      unlinkSync(combined); // nothing is pending any more: a stale batch must not be signed again
    }
  }
  if (!pending.length && !undeployed.length) log('\nnothing pending: this chain has everything in contracts/releases.json');
  return { pending, sent, undeployed, combinedBatch };
}
