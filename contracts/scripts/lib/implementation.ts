// Deploying a later vault implementation through the factory (deployVaultImplementation): what the
// operator script and the tests share.
import { artifacts, ethers } from 'hardhat';
import type { Signer } from 'ethers';
import { readFileSync } from 'fs';
import { join } from 'path';
import { readContract, validateImplementation, type Layout } from './storageLayout';

const root = join(__dirname, '..', '..');

/** Full creation code of `contractName` bound to `factory`: bytecode + abi.encode(factory). */
export async function implementationCreationCode(contractName: string, factory: string): Promise<string> {
  const artifact = await artifacts.readArtifact(contractName);
  const iface = new ethers.Interface(artifact.abi);
  return ethers.concat([artifact.bytecode, iface.encodeDeploy([factory])]);
}

/** The pre-registration checks: storage layout against the base snapshot, hook, no delegatecall/selfdestruct. */
export function validateCandidate(contractName: string): { errors: string[]; warnings: string[] } {
  const snapshot: Layout = JSON.parse(readFileSync(join(root, 'storage', 'P2IDVault.layout.json'), 'utf8'));
  const findings = validateImplementation(snapshot, readContract(root, contractName));
  return {
    errors: findings.filter((f) => f.level === 'error').map((f) => f.message),
    warnings: findings.filter((f) => f.level === 'warning').map((f) => f.message),
  };
}

export interface ImplementationPlan {
  contractName: string;
  creationCode: string;
  /** Where the factory will put it (CREATE2 under its IMPLEMENTATION_SALT); the same on every chain of the environment. */
  address: string;
  alreadyDeployed: boolean;
  alreadyRegistered: boolean;
  /** Calldata for `factory.deployVaultImplementation(creationCode, makeDefault)`, for a multisig owner. */
  calldata: string;
}

export async function planImplementation(factoryAddress: string, contractName: string, makeDefault: boolean): Promise<ImplementationPlan> {
  const { errors } = validateCandidate(contractName);
  if (errors.length) throw new Error(`${contractName} is not a safe implementation:\n  ${errors.join('\n  ')}`);
  const factory = await ethers.getContractAt('PviumP2IdVaultFactory', factoryAddress);
  const creationCode = await implementationCreationCode(contractName, factoryAddress);
  const address = await factory.implementationFor(ethers.keccak256(creationCode));
  return {
    contractName,
    creationCode,
    address,
    alreadyDeployed: (await ethers.provider.getCode(address)) !== '0x',
    alreadyRegistered: await factory.isRegisteredImplementation(address),
    calldata: factory.interface.encodeFunctionData('deployVaultImplementation', [creationCode, makeDefault]),
  };
}

/** Deploy and propose through the factory as `owner` (the factory owner). Returns the implementation address. */
export async function deployImplementation(factoryAddress: string, contractName: string, makeDefault: boolean, owner: Signer): Promise<string> {
  const plan = await planImplementation(factoryAddress, contractName, makeDefault);
  const factory = await ethers.getContractAt('PviumP2IdVaultFactory', factoryAddress, owner);
  const tx = await factory.deployVaultImplementation(plan.creationCode, makeDefault);
  await tx.wait();
  if ((await ethers.provider.getCode(plan.address)) === '0x') throw new Error(`no code at ${plan.address} after deployVaultImplementation`);
  return plan.address;
}
