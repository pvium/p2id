// Prove that the vault code deployed on each recorded chain is the code in this build, so that the
// storage layout snapshot (compiled from this build) describes the live vaults and a candidate
// implementation checked against it (CANDIDATE=P2IDVaultV2 yarn layout) is compatible with them.
//
//   yarn verify:bytecode                 # every record under deployments/
//   CHAINS=8453,56 yarn verify:bytecode  # a subset
//
// Per chain: the runtime bytecode at the recorded base implementation must equal the compiled
// P2IDVault except for the factory address immutable; the factory's initCodeHash() must equal
// the compiled proxy creation code hash and the recorded vaultInitCodeHash. Then the compiled
// P2IDVault layout must equal storage/P2IDVault.layout.json. Needs no signer; reads only.
import { artifacts, ethers } from 'hardhat';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { DEPLOY_NETWORKS } from '../deploy.config';
import { compareLayouts, readContract, type Layout } from './lib/storageLayout';

const ROOT = join(__dirname, '..');

function rpcFor(chainId: number): string {
  const entry = Object.values(DEPLOY_NETWORKS).find((n) => n.chainId === chainId);
  if (!entry) throw new Error(`no deploy.config entry for chain ${chainId}`);
  return process.env[entry.rpcEnv] ?? entry.defaultRpc;
}

/** Zero every occurrence of `address` in `hex` so an immutable does not count as a difference. */
function maskAddress(hex: string, address: string): string {
  return hex.toLowerCase().split(address.slice(2).toLowerCase()).join('0'.repeat(40));
}

async function main() {
  const dir = join(ROOT, 'deployments');
  const only = process.env.CHAINS?.split(',').map(Number);
  const records = readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !/circuit-v\d+\./.test(f))
    .map((f) => ({ file: f, record: JSON.parse(readFileSync(join(dir, f), 'utf8')) }))
    .filter(({ record }) => record.baseImplementation && (!only || only.includes(record.chainId)));
  if (!records.length) throw new Error('no deployment records with a base implementation');

  const vault = await artifacts.readArtifact('P2IDVault');
  const proxy = await artifacts.readArtifact('PviumP2IDVaultProxy');
  const proxyInitCodeHash = ethers.keccak256(proxy.bytecode);
  let failed = false;
  const fail = (m: string) => { failed = true; console.log(`  FAIL ${m}`); };
  const ok = (m: string) => console.log(`  ok   ${m}`);

  for (const { file, record } of records) {
    console.log(`${file}: chain ${record.chainId}, factory ${record.factory}`);
    const provider = new ethers.JsonRpcProvider(rpcFor(record.chainId), record.chainId, { staticNetwork: true });
    const onchain = await provider.getCode(record.baseImplementation);
    if (onchain === '0x') { fail(`no code at base implementation ${record.baseImplementation}`); continue; }
    const expected = maskAddress(vault.deployedBytecode, record.factory);
    const actual = maskAddress(onchain, record.factory);
    const occurrences = onchain.toLowerCase().split(record.factory.slice(2).toLowerCase()).length - 1;
    if (actual === expected) ok(`base implementation ${record.baseImplementation}: runtime bytecode equals compiled P2IDVault (${(onchain.length - 2) / 2} bytes, factory immutable ×${occurrences})`);
    else {
      let diff = 0; for (let i = 2; i < Math.max(actual.length, expected.length); i += 2) if (actual.substr(i, 2) !== expected.substr(i, 2)) diff++;
      fail(`base implementation bytecode differs from compiled P2IDVault: ${diff} bytes (on-chain ${(onchain.length - 2) / 2}, compiled ${(vault.deployedBytecode.length - 2) / 2}); build from the release tag`);
    }
    const factory = new ethers.Contract(record.factory, ['function initCodeHash() view returns (bytes32)', 'function initialImplementation() view returns (address)', 'function baseImplementation() view returns (address)'], provider);
    const liveInitCodeHash: string = await factory.initCodeHash();
    if (liveInitCodeHash === proxyInitCodeHash && liveInitCodeHash === record.vaultInitCodeHash) ok(`factory initCodeHash ${liveInitCodeHash.slice(0, 10)}… equals the compiled proxy creation code and the record`);
    else fail(`factory initCodeHash ${liveInitCodeHash} vs compiled proxy ${proxyInitCodeHash} vs record ${record.vaultInitCodeHash}`);
    const initial: string = await factory.initialImplementation();
    const current: string = await factory.baseImplementation();
    if (initial.toLowerCase() === record.baseImplementation.toLowerCase()) ok(`factory.initialImplementation matches the record`);
    else fail(`factory.initialImplementation ${initial} is not the recorded ${record.baseImplementation}`);
    if (current.toLowerCase() !== initial.toLowerCase()) console.log(`  note the factory's current default implementation is ${current}: new vaults no longer start on V1 there`);
  }

  const snapshot: Layout = JSON.parse(readFileSync(join(ROOT, 'storage', 'P2IDVault.layout.json'), 'utf8'));
  const compiled = readContract(ROOT, 'src/P2IDVault.sol:P2IDVault');
  const errors = compareLayouts(snapshot, compiled.layout).filter((f) => f.level === 'error');
  if (errors.length) fail(`compiled P2IDVault layout differs from storage/P2IDVault.layout.json:\n    ${errors.map((e) => e.message).join('\n    ')}`);
  else ok(`compiled P2IDVault layout equals storage/P2IDVault.layout.json (${compiled.layout.storage.length} variables, last '${compiled.layout.storage.at(-1)!.label}' at slot ${compiled.layout.storage.at(-1)!.slot})`);

  if (failed) { console.log('bytecode verification FAILED'); process.exit(1); }
  console.log('bytecode verification passed: the layout snapshot describes the deployed vaults; a candidate that passes `CANDIDATE=<Contract> yarn layout` is compatible with them');
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
