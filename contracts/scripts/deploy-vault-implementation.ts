// Full creation code includes constructor arguments. Dry-run by default; EXECUTE=1 broadcasts.
import { ethers } from 'hardhat';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { readContract, validateImplementation, compareLayouts, Layout } from './lib/storageLayout';

export async function implementationPlan(factoryAddress: string, candidate: string, makeDefault = false) {
  const root = join(__dirname, '..');
  const baseline: Layout = JSON.parse(readFileSync(join(root, 'storage/P2IDVault.layout.json'), 'utf8'));
  const contract = readContract(root, candidate);
  const current = readContract(root, 'src/P2IDVault.sol:P2IDVault');
  const findings = [...validateImplementation(baseline, contract), ...compareLayouts(current.layout, contract.layout)];
  for (const finding of findings) {
    if (finding.level === 'warning') console.warn(finding.message);
  }
  const errors = findings.filter((f) => f.level === 'error');
  if (errors.length) throw new Error(errors.map((f) => f.message).join('\n'));
  const address = ethers.getAddress(factoryAddress);
  const implementation = await ethers.getContractFactory(candidate);
  // Vault implementations use constructor(address factory).
  const creationCode = (await implementation.getDeployTransaction(address)).data;
  const creationCodeHash = ethers.keccak256(creationCode);
  const factory = await ethers.getContractAt('PviumP2IdVaultFactory', address);
  const salt = await factory.IMPLEMENTATION_SALT();
  const predicted = ethers.getCreate2Address(address, salt, creationCodeHash);
  if (predicted !== await factory.implementationFor(creationCodeHash)) throw new Error('Prediction mismatch');
  return {
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    factory: address, candidate, constructorArguments: [address], creationCodeHash, salt,
    implementation: predicted, makeDefault,
    to: address,
    data: factory.interface.encodeFunctionData('deployVaultImplementation', [creationCode, makeDefault]),
  };
}

async function main() {
  const address = process.env.FACTORY;
  const candidate = process.env.CANDIDATE;
  if (!address || !candidate) throw new Error('Set FACTORY and CANDIDATE');
  const flag = process.env.MAKE_DEFAULT ?? 'false';
  if (!['true', 'false'].includes(flag)) throw new Error('MAKE_DEFAULT must be true or false');
  const action = process.env.ACTION ?? 'deploy';
  if (!['deploy', 'activate'].includes(action)) throw new Error('ACTION must be deploy or activate');
  const plan = await implementationPlan(address, candidate, flag === 'true');
  const factory = await ethers.getContractAt('PviumP2IdVaultFactory', plan.factory);
  if (action === 'activate') {
    if (await factory.proposedImplementation() !== plan.implementation ||
        await factory.proposedImplementationMakeDefault() !== plan.makeDefault) {
      throw new Error('Pending proposal does not match candidate and MAKE_DEFAULT');
    }
    const eta = await factory.proposedImplementationEta();
    const block = await ethers.provider.getBlock('latest');
    if (!eta || BigInt(block!.timestamp) < eta) throw new Error('Registration delay has not elapsed');
    plan.data = factory.interface.encodeFunctionData('registerImplementation');
  }
  // Simulate with the actual owner as sender, including when preparing calldata for a multisig.
  const owner = await factory.owner();
  await ethers.provider.call({ from: owner, to: plan.to, data: plan.data });
  const output = { ...plan, action, owner };
  if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ ...output, data: process.env.OUT ? '(saved to OUT)' : output.data }, null, 2));
  if (process.env.EXECUTE !== '1') {
    console.log('Dry run. Set EXECUTE=1 to broadcast, or submit the saved to/data from the factory owner.');
    return;
  }
  const [signer] = await ethers.getSigners();
  if (!signer || await signer.getAddress() !== owner) throw new Error('Signer is not the factory owner');
  const tx = await signer.sendTransaction({ to: plan.to, data: plan.data });
  await tx.wait();
  console.log('Transaction:', tx.hash);
  console.log('Implementation:', plan.implementation);
  console.log('Registered:', await factory.isRegisteredImplementation(plan.implementation));
  console.log('Proposal ETA:', (await factory.proposedImplementationEta()).toString());
  console.log('New-vault implementation:', await factory.baseImplementation());
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
