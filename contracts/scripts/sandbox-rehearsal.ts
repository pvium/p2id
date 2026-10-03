// End-to-end rehearsal of a deployed stack with the committed sample proof (a real Privy sandbox
// token for test-9988@privy.io): fund the identity's P2ID through the factory and by a plain
// transfer, check an unattested claim is refused while the circuit is in alpha, then claim with an
// alpha attestation and confirm the proven wallet was paid.
//
//   yarn hardhat run scripts/sandbox-rehearsal.ts                        # local: deploys a throwaway stack first
//   yarn hardhat run scripts/sandbox-rehearsal.ts --network baseSepolia  # the recorded sandbox deployment
//
// On a real network the signer must be the factory's alpha attester (the owner unless
// ALPHA_ATTESTER_* was set), and pays two small native transfers plus the claim (~4.6M gas).
import { ethers, network } from 'hardhat';
import { createPublicKey } from 'crypto';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { CURRENT_SCHEME, deployStack } from './lib/deterministic';

const ROOT = join(__dirname, '..');
const FIX = join(ROOT, 'test', 'fixtures');
const NATIVE = ethers.ZeroAddress;
const AMOUNT = ethers.parseEther('0.00001');

async function stackFactory(): Promise<string> {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== 31337) {
    const dir = join(ROOT, 'deployments');
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(`.${chainId}.json`)) : [];
    if (files.length !== 1) throw new Error(`expected one deployment record for chain ${chainId}, found ${files.length}: deploy first`);
    return JSON.parse(readFileSync(join(dir, files[0]), 'utf8')).factory;
  }
  const [signer] = await ethers.getSigners();
  const version = JSON.parse(readFileSync(join(ROOT, '..', 'circuit', 'version.json'), 'utf8'));
  const jwk = createPublicKey(readFileSync(join(FIX, 'privy_es256_public.pem'))).export({ format: 'jwk' });
  const key = { x: BigInt('0x' + Buffer.from(jwk.x!, 'base64url').toString('hex')), y: BigInt('0x' + Buffer.from(jwk.y!, 'base64url').toString('hex')) };
  const a = await deployStack({
    owner: signer.address, scheme: CURRENT_SCHEME, circuitVersion: version.circuitVersion, vkHash: version.vkSha256,
    signerKeys: [key], attester: ethers.ZeroAddress, policyChangeDelay: 7 * 86400, minRefundWindow: 86400, maxRefundWindow: 90 * 86400,
    salt: ethers.id('sandbox-rehearsal'),
  }, signer);
  return a.factory;
}

async function main() {
  const [signer] = await ethers.getSigners();
  const raw = readFileSync(join(FIX, 'email.public_inputs'));
  const inputs = Array.from({ length: raw.length / 32 }, (_, i) => ethers.hexlify(raw.subarray(i * 32, (i + 1) * 32)));
  const identityHash = ethers.toBeHex((BigInt(inputs[7]) << 128n) | BigInt(inputs[8]), 32);
  const wallet = ethers.getAddress(ethers.toBeHex(BigInt(inputs[1]), 20));
  const iat = BigInt(inputs[6]);
  const proof = ethers.AbiCoder.defaultAbiCoder().encode(['bytes', 'bytes32[]'], [readFileSync(join(FIX, 'email.proof')), inputs]);

  const factory = await ethers.getContractAt('PviumP2IdVaultFactory', await stackFactory());
  const V = await factory.defaultVerifier();
  const verifier = await ethers.getContractAt('PviumVerifier', V);
  const vkHash = await verifier.vkHash();
  const vaultAddress = await factory.vaultFor(identityHash);
  const vault = await ethers.getContractAt('P2IDVault', vaultAddress);
  const step = (s: string) => console.log(`  ok   ${s}`);
  console.log(`${network.name}: factory ${await factory.getAddress()}, P2ID ${vaultAddress} for test-9988@privy.io, pays ${wallet}`);

  if (!(await factory.isAlpha(vkHash))) throw new Error('the default verifier key is not in alpha');
  const attester = await factory.defaultAttester();
  if (attester.toLowerCase() !== signer.address.toLowerCase()) throw new Error(`signer ${signer.address} is not the alpha attester ${attester}`);
  step(`circuit key ${vkHash.slice(0, 10)}… is in alpha; attester is the signer`);

  // 1. fund: a recorded deposit through the factory (deploys the vault on first use), and a plain transfer
  const minWindow = await factory.minRefundWindow();
  await (await factory.fund(identityHash, NATIVE, AMOUNT, ethers.ZeroHash, minWindow, ethers.id('rehearsal'), { value: AMOUNT })).wait();
  await (await signer.sendTransaction({ to: vaultAddress, value: AMOUNT })).wait();
  if ((await ethers.provider.getCode(vaultAddress)) === '0x') throw new Error('vault not deployed by fund()');
  step(`funded ${ethers.formatEther(AMOUNT)} through the factory and ${ethers.formatEther(AMOUNT)} by plain transfer`);
  const proxy = await ethers.getContractAt('PviumP2IDVaultProxy', vaultAddress);
  if ((await proxy.implementation()) !== (await factory.baseImplementation())) throw new Error('vault is not on the base implementation');
  step('vault is a proxy on the base implementation');

  // 2. an ordinary claim is refused while the key is in alpha
  let refused = false;
  try { await vault.refreshProofAndSweep.staticCall(V, proof, NATIVE, 0); } catch (e: any) { refused = /AlphaAuthorizationRequired/.test(e.message ?? '') || e.data === vault.interface.getError('AlphaAuthorizationRequired')!.selector; }
  if (!refused) throw new Error('an unattested claim was not refused');
  step('unattested claim refused (AlphaAuthorizationRequired)');

  // 3. the attested claim
  const action = vault.interface.encodeFunctionData('refreshProofAndSweep', [V, proof, NATIVE, 0]);
  const nonce = BigInt(ethers.hexlify(ethers.randomBytes(16)));
  const deadline = BigInt((await ethers.provider.getBlock('latest'))!.timestamp + 900);
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const signature = await signer.signTypedData(
    { name: 'PviumAlpha', version: '1', chainId, verifyingContract: await factory.getAddress() },
    { AlphaAuthorization: [
      { name: 'vault', type: 'address' }, { name: 'caller', type: 'address' }, { name: 'callHash', type: 'bytes32' },
      { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'epoch', type: 'uint256' },
    ] },
    { vault: vaultAddress, caller: signer.address, callHash: ethers.keccak256(action), nonce, deadline, epoch: await factory.alphaEpoch() },
  );
  const before = await ethers.provider.getBalance(wallet);
  const owed = (await vault.trackedTotal(NATIVE)) + (await vault.untrackedBalance(NATIVE));
  const rc = await (await vault.refreshProofAndSweepWithAttestation(V, proof, NATIVE, 0, { nonce, deadline, signature })).wait();
  const paid = (await ethers.provider.getBalance(wallet)) - before;
  if (paid !== owed) throw new Error(`wallet received ${paid}, expected ${owed}`);
  if ((await vault.owner(V)) !== wallet) throw new Error('vault owner is not the proven wallet');
  if ((await vault.latestProofIat(V)) !== iat) throw new Error('vault did not record the proof issue time');
  step(`attested claim paid ${ethers.formatEther(paid)} to ${wallet} (gas ${rc!.gasUsed})`);

  // 4. the attestation is single use
  let replayed = true;
  try { await vault.refreshProofAndSweepWithAttestation.staticCall(V, proof, NATIVE, 0, { nonce, deadline, signature }); } catch { replayed = false; }
  if (replayed) throw new Error('the attestation was accepted twice');
  step('attestation cannot be replayed');
  if ((await ethers.provider.getBalance(vaultAddress)) !== 0n) throw new Error('vault still holds funds');
  console.log('rehearsal passed');
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
