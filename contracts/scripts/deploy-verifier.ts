// Deploy a new circuit version's verifier set next to an existing P2ID stack. Deploys and checks
// on chain only: no owner transaction is sent. The factory, policy and every P2ID address stay.
//
//   PREDICT=1 yarn deploy:verifier --network base   # print the addresses, send nothing
//   yarn deploy:verifier --network base             # deploy, read back, record
//
// Reads the chain's stack record (deployments/<scheme>.<environment>.<chainId>.json) for the factory
// and policy, and circuit/version.json for the circuit version and vk hash being deployed. Owner,
// constraint attester and Privy keys come from contracts/.env (OWNER_*, ATTESTER_*,
// PRIVY_SIGNER_KEYS_*), falling back to the stack record's values; use the same values on every
// chain of an environment so the verifier set gets the same addresses everywhere.
//
// Deploys (deterministically, skipping anything already there): RelationsLib, ZKTranscriptLib,
// PviumZKVerifier (this build's vk compiled in), PviumIdentity, PviumVerifier; reads them back;
// writes deployments/<scheme>.<environment>.circuit-v<N>.<chainId>.json with the addresses and the
// verifier's activation status. Activation is the owner's (`yarn verifier:activate`): this script
// prints the approval transaction and writes it as a Safe Transaction Builder batch.
import { ethers, network } from 'hardhat';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { envFor, environmentOf } from '../deploy.config';
import { deployVerifierSet, hasCode, sortedKeys, type VerifierSetParams } from './lib/deterministic';
import { ownerTx, printStatus, readStatus, safeBatchFile, verifierSetFile, writeRecord, writeSafeBatch } from './lib/verifierSet';

const ROOT = join(__dirname, '..', '..');
const DEPLOYMENTS = join(__dirname, '..', 'deployments');
const P2ID_JSON = join(ROOT, 'sdks', 'node', 'p2id-core', 'src', 'p2id.json');

function parseKeys(value: string): { kid: string; x: bigint; y: bigint }[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const m = /^([^:]+):(0x[0-9a-fA-F]{64}):(0x[0-9a-fA-F]{64})$/.exec(entry);
    if (!m) throw new Error(`PRIVY_SIGNER_KEYS: bad entry "${entry}" (expected kid:0x<x>:0x<y>)`);
    return { kid: m[1], x: BigInt(m[2]), y: BigInt(m[3]) };
  });
}

async function main() {
  const environment = environmentOf(network.name);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const scheme: string = process.env.SCHEME ?? JSON.parse(readFileSync(P2ID_JSON, 'utf8')).current;
  const stackFile = join(DEPLOYMENTS, `${scheme}.${environment}.${chainId}.json`);
  if (!existsSync(stackFile)) throw new Error(`no ${environment} stack recorded for chain ${chainId}: ${stackFile}`);
  const stack = JSON.parse(readFileSync(stackFile, 'utf8'));

  const version = JSON.parse(readFileSync(join(ROOT, 'circuit', 'version.json'), 'utf8'));
  const circuitVersion: number = version.circuitVersion;
  const vkHash: string = version.vkSha256;
  if (circuitVersion === stack.config.circuitVersion || vkHash === stack.config.vkHash) {
    throw new Error(`circuit version ${circuitVersion} is the stack's own verifier (${stack.pviumVerifier}); nothing to deploy`);
  }

  const envKeys = envFor('PRIVY_SIGNER_KEYS', environment);
  const keys = envKeys
    ? parseKeys(envKeys)
    : (stack.privyKeys as { kid: string; x: string; y: string }[]).map((k) => ({ kid: k.kid, x: BigInt(k.x), y: BigInt(k.y) }));
  const owner = ethers.getAddress(envFor('OWNER', environment) ?? stack.config.owner);
  const attesterRaw = envFor('ATTESTER', environment) ?? stack.config.attester;
  const attester = attesterRaw.toLowerCase() === 'none' ? ethers.ZeroAddress : ethers.getAddress(attesterRaw);
  const params: VerifierSetParams = { scheme, owner, circuitVersion, vkHash, signerKeys: keys, attester };

  console.log(`${environment} on ${network.name} (chain ${chainId}): circuit version ${circuitVersion}, vk ${vkHash}`);
  console.log(`  stack factory ${stack.factory}, policy ${stack.policy}`);
  console.log(`  owner ${owner}, attester ${attester}, ${keys.length} Privy keys (${keys.map((k) => k.kid).join(', ')})`);

  const predicted = await deployVerifierSet(params, null);
  if (process.env.PREDICT) {
    console.log(JSON.stringify({ predicted: true, circuitVersion, vkHash, ...predicted }, null, 2));
    return;
  }

  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error(`no deployer key for ${environment} (DEPLOYER_KEY_${environment === 'sandbox' ? 'SANDBOX' : 'PROD'})`);
  const set = await deployVerifierSet(params, signer, (m) => console.log(m));

  // Read back what was deployed.
  const fail = (what: string, got: unknown, want: unknown) => { throw new Error(`deployment check failed: ${what} is ${got}, expected ${want}`); };
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  for (const [name, address] of Object.entries(set)) if (!(await hasCode(address))) fail(`code at ${name}`, 'empty', address);
  const identity = await ethers.getContractAt('PviumIdentity', set.pviumIdentity);
  if (!same(await identity.vkHash(), vkHash)) fail('PviumIdentity.vkHash', await identity.vkHash(), vkHash);
  if (Number(await identity.circuitVersion()) !== circuitVersion) fail('PviumIdentity.circuitVersion', await identity.circuitVersion(), circuitVersion);
  if (!same(await identity.owner(), owner)) fail('PviumIdentity.owner', await identity.owner(), owner);
  for (const k of sortedKeys(keys)) if (!(await identity.isSignerKey(k.x, k.y))) fail(`signer key ${k.x.toString(16).slice(0, 12)}…`, 'missing', 'accepted');
  const verifier = await ethers.getContractAt('PviumVerifier', set.pviumVerifier);
  if (!same(await verifier.pviumIdentity(), set.pviumIdentity)) fail('PviumVerifier.pviumIdentity', await verifier.pviumIdentity(), set.pviumIdentity);
  if (!same(await verifier.owner(), owner)) fail('PviumVerifier.owner', await verifier.owner(), owner);
  if (attester !== ethers.ZeroAddress && !(await verifier.isConstraintSigner(attester))) fail('constraint signer', 'not registered', attester);
  console.log('verifier set checks passed');

  const factory = await ethers.getContractAt('PviumP2IdVaultFactory', stack.factory);
  if (!same(await factory.policy(), stack.policy)) fail('factory.policy', await factory.policy(), stack.policy);

  const record: any = {
    kind: 'verifier-set', scheme, environment, network: network.name, chainId, circuitVersion, vkHash,
    privyKeys: sortedKeys(keys).map((k) => ({ kid: keys.find((q) => q.x === k.x && q.y === k.y)?.kid, x: ethers.toBeHex(k.x, 32), y: ethers.toBeHex(k.y, 32) })),
    config: { owner, attester, circuitVersion, vkHash },
    ...set, factory: stack.factory, policy: stack.policy,
  };
  record.status = await readStatus(record);
  const file = verifierSetFile(scheme, environment, circuitVersion, chainId);
  if (chainId !== 31337) writeRecord(file, record);
  console.log(JSON.stringify(record, null, 2));
  console.log(`\nstatus of the circuit v${circuitVersion} verifier on ${network.name}:`);
  printStatus(record.status);

  const policyOwner = await (await ethers.getContractAt('PviumP2IDPolicy', stack.policy)).owner();
  const approve = await ownerTx(record, record.status, 'approve');
  if (typeof approve === 'string') {
    console.log(`\napprove: ${approve}`);
  } else {
    console.log(`\nto activate, the policy owner ${policyOwner} sends:`);
    console.log(`  ${approve.description}\n  to    ${approve.to}\n  value 0\n  data  ${approve.data}`);
    if (chainId !== 31337) {
      const batch = safeBatchFile(record, 'approve');
      writeSafeBatch(batch, chainId, `Approve circuit v${circuitVersion} verifier`, [approve]);
      console.log(`  Safe batch: ${batch} (Safe app > Transaction Builder > drop the file)`);
    }
    console.log(`  or, from the owner key: yarn verifier:activate --network ${network.name}`);
  }
  console.log(`\nverify the sources: yarn verify --network ${network.name}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
