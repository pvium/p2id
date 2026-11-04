// End-to-end rehearsal of the V2 vault release on a local chain, with the real Honk verifier and
// the committed sample proof (test-9988@privy.io): deploy a V1 stack, pay the identity's P2ID
// under V1, prove ownership, deploy and register P2IDVaultV2 through the factory, upgrade the
// existing vault with the owner's proof, then refund and claim under V2.
//
//   yarn hardhat node                                                  # terminal 1
//   yarn hardhat run scripts/v2-rehearsal.ts --network localhost       # terminal 2
//   yarn hardhat run scripts/v2-rehearsal.ts                           # or in-process, no node needed
//
// Local chains only (31337): the factory is deployed with a one-second notice instead of 14 days,
// time is advanced with evm_increaseTime, and the proven wallet is impersonated to sign the upgrade.
import { ethers, network } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { createPublicKey } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CURRENT_SCHEME, deployStack } from './lib/deterministic';
import { deployImplementation } from './lib/implementation';

const ROOT = join(__dirname, '..');
const FIX = join(ROOT, 'test', 'fixtures');
const NATIVE = ethers.ZeroAddress;
const Z = ethers.ZeroHash;
const AMOUNT = ethers.parseEther('0.001');
const NOTICE = 1;
const ALPHA_TYPES = { AlphaAuthorization: [
  { name: 'vault', type: 'address' }, { name: 'caller', type: 'address' }, { name: 'callHash', type: 'bytes32' },
  { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'epoch', type: 'uint256' },
] };

const step = (s: string) => console.log(`  ok   ${s}`);
function check(condition: boolean, message: string) { if (!condition) throw new Error(message); }
/** In-process Hardhat returns a hex string; localhost JSON-RPC may wrap it in { data, ... }. */
function revertData(error: any): string | undefined {
  const data = error.data ?? error.error?.data ?? error.info?.error?.data;
  return typeof data === 'string' ? data : typeof data?.data === 'string' ? data.data : undefined;
}
/** Expect `call` (a staticCall) to revert with the named custom error of `contract`. */
async function expectRevert(call: Promise<unknown>, contract: any, name: string, what: string) {
  const selector = contract.interface.getError(name)!.selector;
  try { await call; } catch (e: any) {
    if (revertData(e)?.startsWith(selector)) { step(`${what}: refused (${name})`); return; }
    throw new Error(`${what}: reverted, but not with ${name}: ${e.message}`);
  }
  throw new Error(`${what}: expected revert ${name}, call succeeded`);
}

async function main() {
  check(Number((await ethers.provider.getNetwork()).chainId) === 31337, 'this rehearsal runs on a local chain only (chainId 31337)');
  const [owner, payer, refunder, stranger] = await ethers.getSigners();

  // ------------------------------------------------------------ the proof fixture
  const raw = readFileSync(join(FIX, 'email.public_inputs'));
  const inputs = Array.from({ length: raw.length / 32 }, (_, i) => ethers.hexlify(raw.subarray(i * 32, (i + 1) * 32)));
  const identityHash = ethers.toBeHex((BigInt(inputs[7]) << 128n) | BigInt(inputs[8]), 32);
  const wallet = ethers.getAddress(ethers.toBeHex(BigInt(inputs[1]), 20));
  const iat = BigInt(inputs[6]);
  const proof = ethers.AbiCoder.defaultAbiCoder().encode(['bytes', 'bytes32[]'], [readFileSync(join(FIX, 'email.proof')), inputs]);

  // ------------------------------------------------------------ 1. the V1 stack
  const version = JSON.parse(readFileSync(join(ROOT, '..', 'circuit', 'version.json'), 'utf8'));
  const jwk = createPublicKey(readFileSync(join(FIX, 'privy_es256_public.pem'))).export({ format: 'jwk' });
  const key = { x: BigInt('0x' + Buffer.from(jwk.x!, 'base64url').toString('hex')), y: BigInt('0x' + Buffer.from(jwk.y!, 'base64url').toString('hex')) };
  const stack = await deployStack({
    owner: owner.address, scheme: CURRENT_SCHEME, circuitVersion: version.circuitVersion, vkHash: version.vkSha256,
    signerKeys: [key], attester: ethers.ZeroAddress, policyChangeDelay: 7 * 86400, minRefundWindow: 86400, maxRefundWindow: 90 * 86400,
    defaultVerifierDelay: NOTICE, salt: ethers.id(`v2-rehearsal-${Date.now()}`),
  }, owner);
  const factory = await ethers.getContractAt('PviumP2IdVaultFactory', stack.factory);
  const V1 = await factory.baseImplementation();
  const V = await factory.defaultVerifier();
  const vkHash = await (await ethers.getContractAt('PviumVerifier', V)).vkHash();
  check(await factory.isAlpha(vkHash), 'the circuit key should start in alpha, as in production');
  check((await factory.defaultAttester()) === owner.address, 'the owner should be the alpha attester');
  const chainId = (await ethers.provider.getNetwork()).chainId;
  async function attest(vault: string, caller: string, data: string) {
    const nonce = BigInt(ethers.hexlify(ethers.randomBytes(16)));
    const deadline = BigInt((await time.latest()) + 900);
    const signature = await owner.signTypedData({ name: 'PviumAlpha', version: '1', chainId, verifyingContract: stack.factory }, ALPHA_TYPES,
      { vault, caller, callHash: ethers.keccak256(data), nonce, deadline, epoch: await factory.alphaEpoch() });
    return { nonce, deadline, signature };
  }
  console.log(`${network.name}: factory ${stack.factory}, V1 ${V1}, notice ${NOTICE}s, circuit key in alpha`);

  // ------------------------------------------------------------ 2. pay the identity under V1
  const vaultAddress = await factory.vaultFor(identityHash);
  const vault = await ethers.getContractAt('P2IDVaultV2', vaultAddress); // the V2 ABI is a superset; V1 calls work through it
  const proxy = await ethers.getContractAt('PviumP2IDVaultProxy', vaultAddress);
  const minWindow = await factory.minRefundWindow();
  await (await factory.connect(payer).fund(identityHash, NATIVE, AMOUNT, Z, minWindow, ethers.id('v1 deposit 0'), { value: AMOUNT })).wait(); // deposit 0
  await (await vault.connect(payer).fund(NATIVE, AMOUNT * 2n, Z, minWindow, ethers.id('v1 deposit 1'), { value: AMOUNT * 2n })).wait();   // deposit 1
  await (await stranger.sendTransaction({ to: vaultAddress, value: AMOUNT })).wait();                                                        // untracked
  check((await proxy.implementation()) === V1, 'the vault should start on V1');
  step(`P2ID ${vaultAddress} deployed on V1 by the first payment; two deposits and a plain transfer recorded`);
  await expectRevert(vault.connect(stranger).refund.staticCall(0), vault, 'NotFunder', 'V1: a stranger refunding deposit 0');
  let v1HasRefunder = true;
  try { await vault.connect(payer).fundWithRefunder.staticCall(V, NATIVE, AMOUNT, Z, minWindow, refunder.address, Z, { value: AMOUNT }); } catch (e: any) {
    check(revertData(e) === '0x', `V1 fundWithRefunder must revert without data, got ${JSON.stringify(e.data)}: ${e.message}`);
    v1HasRefunder = false;
  }
  check(!v1HasRefunder, 'V1 must not expose fundWithRefunder');
  step('V1: fundWithRefunder does not exist yet (reverts with no data)');

  // the owner proves under alpha, which caches the proven wallet without sweeping
  const refresh = vault.interface.encodeFunctionData('refreshProof', [V, proof]);
  await (await vault.connect(owner).refreshProofWithAttestation(V, proof, await attest(vaultAddress, owner.address, refresh))).wait();
  check((await vault.owner(V)) === wallet && (await vault.latestProofIat(V)) === iat, 'the proof should set the owner cache');
  step(`V1: real proof accepted under attestation; owner ${wallet}, iat ${iat}`);

  // ------------------------------------------------------------ 3. release V2
  const V2 = await deployImplementation(stack.factory, 'P2IDVaultV2', true, owner);
  check((await factory.proposedImplementation()) === V2, 'V2 should be proposed as the default');
  step(`V2 deployed through the factory at ${V2} and proposed (notice ${NOTICE}s)`);
  await time.increase(NOTICE + 1);
  await (await factory.registerImplementation()).wait();
  check(await factory.isRegisteredImplementation(V2), 'V2 should be registered');
  check((await factory.baseImplementation()) === V2, 'V2 should be the default for new vaults');
  check((await proxy.implementation()) === V1, 'the existing vault must stay on V1 until its owner moves it');
  step('V2 registered and default; the existing vault is still on V1');
  const freshId = ethers.id(`fresh-identity-${Date.now()}`);
  await (await factory.deploy(freshId)).wait();
  check((await (await ethers.getContractAt('PviumP2IDVaultProxy', await factory.vaultFor(freshId))).implementation()) === V2, 'a new vault should start on V2');
  step('a vault deployed after the release starts on V2');

  // ------------------------------------------------------------ 4. the owner upgrades the existing vault
  await network.provider.send('hardhat_impersonateAccount', [wallet]);
  await network.provider.send('hardhat_setBalance', [wallet, ethers.toBeHex(ethers.parseEther('1'))]);
  const ownerWallet = await ethers.getImpersonatedSigner(wallet);
  const upgrade = proxy.interface.encodeFunctionData('upgradeTo', [identityHash, V2, proof]);
  await expectRevert(proxy.connect(ownerWallet).upgradeTo.staticCall(identityHash, V2, proof), proxy, 'AlphaAuthorizationRequired', 'upgrade without attestation');
  await expectRevert(proxy.connect(stranger).upgradeToWithAttestation.staticCall(identityHash, V2, proof, await attest(vaultAddress, stranger.address, upgrade)), proxy, 'NotOwner', 'upgrade by a non-owner');
  const rc = await (await proxy.connect(ownerWallet).upgradeToWithAttestation(identityHash, V2, proof, await attest(vaultAddress, wallet, upgrade))).wait();
  check((await proxy.implementation()) === V2, 'the vault should now run V2');
  check((await factory.vaultFor(identityHash)) === vaultAddress, 'the P2ID address must not change');
  const d0 = await vault.deposits(0), d1 = await vault.deposits(1);
  check(d0.funder === payer.address && d0.amount === AMOUNT && !d0.consumed, 'deposit 0 should be intact');
  check(d1.funder === payer.address && d1.amount === AMOUNT * 2n && !d1.consumed, 'deposit 1 should be intact');
  check((await vault.depositRefunder(0)) === ethers.ZeroAddress, 'V1 deposits carry no refunder');
  check((await vault.owner(V)) === wallet && (await vault.latestProofIat(V)) === iat, 'the owner cache should survive the upgrade');
  check((await vault.trackedTotal(NATIVE)) === AMOUNT * 3n && (await vault.untrackedBalance(NATIVE)) === AMOUNT, 'balances should survive the upgrade');
  step(`existing vault upgraded to V2 by the proven wallet (gas ${rc!.gasUsed}); deposits, owner cache and balances intact`);

  // ------------------------------------------------------------ 5. pay under V2 with a refunder
  await (await vault.connect(payer).fundWithRefunder(V, NATIVE, AMOUNT, Z, minWindow, refunder.address, ethers.id('v2 deposit 2'), { value: AMOUNT })).wait(); // deposit 2
  const contractPayer = await ethers.deployContract('MockContractPayer');
  await (await contractPayer.connect(stranger).payNative(vaultAddress, refunder.address, V, minWindow, { value: AMOUNT })).wait();                             // deposit 3
  check((await vault.depositRefunder(2)) === refunder.address && (await vault.depositRefunder(3)) === refunder.address, 'the refunder should be recorded');
  check((await vault.deposits(2)).funder === payer.address && (await vault.deposits(3)).funder === contractPayer.target, 'the payer stays the funder of record');
  step(`V2: an EOA and a contract payer (${contractPayer.target}) each paid naming ${refunder.address} as refunder`);
  await (await vault.connect(payer).fund(NATIVE, AMOUNT, Z, minWindow, ethers.id('v2 deposit 4 refund'), { value: AMOUNT })).wait(); // deposit 4
  await (await vault.connect(payer).fundWithRefunder(V, NATIVE, AMOUNT, Z, minWindow, refunder.address, ethers.id('v2 deposit 5 claim'), { value: AMOUNT })).wait(); // deposit 5
  for (const id of [4, 5]) {
    const deposit = await vault.deposits(id);
    check(deposit.funder === payer.address && deposit.amount === AMOUNT && !deposit.consumed && deposit.verifier === V, `post-upgrade deposit ${id} should be recorded`);
  }
  check((await vault.depositRefunder(4)) === NATIVE && (await vault.depositRefunder(5)) === refunder.address, 'post-upgrade deposits should retain their refund recipients');
  step('V2: funded a plain deposit for refund and a deposit with a named refunder for claim');

  // ------------------------------------------------------------ 6. refund
  await expectRevert(vault.connect(refunder).refund.staticCall(2), vault, 'RefundNotReady', 'refund before the window');
  await time.increase(Number(minWindow) + 1);
  await expectRevert(vault.connect(stranger).refund.staticCall(2), vault, 'NotFunderOrRefunder', 'V2: a stranger refunding deposit 2');
  await expectRevert(vault.connect(payer).refund.staticCall(2), vault, 'NotFunderOrRefunder', 'V2: the payer refunding a deposit with a refunder');
  await expectRevert(vault.connect(refunder).refund.staticCall(1), vault, 'NotFunderOrRefunder', 'V2: the refunder refunding a plain deposit');
  const refunderBefore = await ethers.provider.getBalance(refunder.address);
  let gas = 0n;
  for (const id of [2, 3]) { const r = await (await vault.connect(refunder).refund(id)).wait(); gas += r!.gasUsed * r!.gasPrice; }
  check((await ethers.provider.getBalance(refunder.address)) - refunderBefore + gas === AMOUNT * 2n, 'the refunder should receive both deposits');
  const payerBefore = await ethers.provider.getBalance(payer.address);
  const r1 = await (await vault.connect(payer).refund(1)).wait();
  check((await ethers.provider.getBalance(payer.address)) - payerBefore + r1!.gasUsed * r1!.gasPrice === AMOUNT * 2n, 'the payer should receive the V1 deposit');
  await expectRevert(vault.connect(refunder).refund.staticCall(4), vault, 'NotFunderOrRefunder', 'V2: named refunder refunding a plain post-upgrade deposit');
  const v2PayerBefore = await ethers.provider.getBalance(payer.address);
  const v2Refund = await (await vault.connect(payer).refund(4)).wait();
  check((await ethers.provider.getBalance(payer.address)) - v2PayerBefore + v2Refund!.gasUsed * v2Refund!.gasPrice === AMOUNT, 'the payer should receive the plain V2 deposit');
  for (const id of [1, 2, 3, 4]) {
    check((await vault.deposits(id)).consumed, `refunded deposit ${id} should be consumed`);
    await expectRevert(vault.connect(stranger).sweepDeposits.staticCall(V, NATIVE, [id]), vault, 'DepositConsumed', `claim of refunded deposit ${id}`);
  }
  step('refunds: the refunder recovered V2 deposits 2 and 3; the payer recovered V1 deposit 1 and V2 deposit 4');

  // ------------------------------------------------------------ 7. claim
  const walletBefore = await ethers.provider.getBalance(wallet);
  const r2 = await (await vault.connect(stranger).sweepDeposits(V, NATIVE, [0])).wait(); // deposit 0 only, proofless on the cached owner
  check((await ethers.provider.getBalance(wallet)) - walletBefore === AMOUNT, 'the owner should receive V1 deposit 0');
  const v2Claim = await (await vault.connect(stranger).sweepDeposits(V, NATIVE, [5])).wait();
  check((await ethers.provider.getBalance(wallet)) - walletBefore === AMOUNT * 2n, 'the owner should receive V1 deposit 0 and post-upgrade V2 deposit 5');
  check((await vault.deposits(0)).consumed && (await vault.deposits(5)).consumed && (await vault.trackedTotal(NATIVE)) === 0n, 'claimed deposits should be consumed and tracked funds exhausted');
  check((await vault.untrackedBalance(NATIVE)) === AMOUNT, 'the plain transfer should remain for sweepUntracked');
  const r3 = await (await vault.connect(stranger).sweepUntracked(NATIVE)).wait();      // the plain transfer
  check((await ethers.provider.getBalance(wallet)) - walletBefore === AMOUNT * 3n, 'the owner should be paid deposits 0 and 5 and the plain transfer');
  check((await ethers.provider.getBalance(vaultAddress)) === 0n && (await vault.trackedTotal(NATIVE)) === 0n, 'the vault should be empty');
  step(`claims: V1 and post-upgrade V2 deposits plus the plain transfer paid ${ethers.formatEther(AMOUNT * 3n)} to ${wallet} (gas ${r2!.gasUsed + v2Claim!.gasUsed + r3!.gasUsed})`);
  await expectRevert(vault.connect(payer).refund.staticCall(0), vault, 'DepositConsumed', 'refund of a claimed deposit');
  await expectRevert(vault.connect(refunder).refund.staticCall(5), vault, 'DepositConsumed', 'refund of a claimed post-upgrade V2 deposit');
  console.log('V2 rehearsal passed');
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
