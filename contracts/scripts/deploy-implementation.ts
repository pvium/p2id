// Deploy a later vault implementation through the factory and propose it for registration.
//
//   IMPLEMENTATION=P2IDVaultV2 yarn implementation --network bsc                 # deploy + propose (14-day notice)
//   IMPLEMENTATION=P2IDVaultV2 MAKE_DEFAULT=1 yarn implementation --network bsc  # …and make it what new vaults start on
//   IMPLEMENTATION=P2IDVaultV2 PREDICT=1 yarn implementation --network bsc       # checks + address + calldata, nothing sent
//   REGISTER=1 yarn implementation --network bsc                                 # after the notice: registerImplementation()
//
// The factory is read from deployments/<scheme>.<env>.<chainId>.json (or FACTORY=0x…). The signer
// must be the factory owner; when it is not (a multisig), the script prints the calldata to submit.
// Before anything is sent the candidate passes the same checks as `CANDIDATE=<name> yarn layout`.
import { ethers, network } from 'hardhat';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { deployImplementation, planImplementation, validateCandidate } from './lib/implementation';

const DEPLOYMENTS = join(__dirname, '..', 'deployments');

async function factoryAddress(): Promise<string> {
  if (process.env.FACTORY) return ethers.getAddress(process.env.FACTORY);
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const files = existsSync(DEPLOYMENTS) ? readdirSync(DEPLOYMENTS).filter((f) => f.endsWith(`.${chainId}.json`)) : [];
  if (files.length !== 1) throw new Error(`expected one deployment record for chain ${chainId} in ${DEPLOYMENTS}, found ${files.length}; set FACTORY=0x…`);
  return JSON.parse(readFileSync(join(DEPLOYMENTS, files[0]), 'utf8')).factory;
}

async function main() {
  const factoryAt = await factoryAddress();
  const factory = await ethers.getContractAt('PviumP2IdVaultFactory', factoryAt);
  const [signer] = await ethers.getSigners();
  const isOwner = signer && (await factory.owner()).toLowerCase() === (await signer.getAddress()).toLowerCase();

  if (process.env.REGISTER === '1') {
    const eta = Number(await factory.proposedImplementationEta());
    if (eta === 0) throw new Error('nothing proposed');
    console.log(`proposed ${await factory.proposedImplementation()}, registrable from ${new Date(eta * 1000).toISOString()}`);
    if (!isOwner) return console.log(`calldata for the owner: ${factory.interface.encodeFunctionData('registerImplementation', [])}`);
    await (await factory.connect(signer).registerImplementation()).wait();
    return console.log('registered');
  }

  const name = process.env.IMPLEMENTATION;
  if (!name) throw new Error('set IMPLEMENTATION=<contract name> (or REGISTER=1)');
  const makeDefault = process.env.MAKE_DEFAULT === '1';
  const { warnings } = validateCandidate(name);
  for (const w of warnings) console.log(`warn  ${w}`);
  const plan = await planImplementation(factoryAt, name, makeDefault);
  console.log(`${name} -> ${plan.address} on ${network.name} (factory ${factoryAt})${plan.alreadyDeployed ? ', already deployed' : ''}${plan.alreadyRegistered ? ', already registered' : ''}`);
  if (process.env.PREDICT === '1' || !isOwner) {
    if (!isOwner && process.env.PREDICT !== '1') console.log('signer is not the factory owner; submit this from the owner:');
    console.log(`  to:   ${factoryAt}\n  data: ${plan.calldata}`);
    return;
  }
  const address = await deployImplementation(factoryAt, name, makeDefault, signer);
  const eta = Number(await factory.proposedImplementationEta());
  console.log(`deployed ${address}; proposed${makeDefault ? ' as default' : ''}, registrable from ${new Date(eta * 1000).toISOString()} with REGISTER=1`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
