import { expect } from 'chai';
import { ethers } from 'hardhat';
import { impersonateAccount, setBalance, stopImpersonatingAccount, time } from '@nomicfoundation/hardhat-network-helpers';

const NS = ethers.id('pvium.vault.v1');
const ID = ethers.id('identity');
const DAY = 24 * 3600;
const Z = ethers.ZeroHash;

/**
 * Fees and gating come from the factory's policy; the vault bounds what any policy can do.
 * These tests use a policy whose rate, recipient and failure modes can be changed at will.
 */
describe('P2IDVault fees and policy limits', function () {
  let factory: any, policy: any, vault: any, token: any, idv: any, V: string;
  let deployer: any, payer: any, ownerWallet: any, treasury: any, operator: any;

  const proofFor = (wallet: string, iat: number) =>
    ethers.AbiCoder.defaultAbiCoder().encode(['address', 'bytes32', 'uint64'], [wallet, ID, iat]);
  const OK = ethers.hexlify(ethers.toUtf8Bytes('ok'));

  async function fund(amount: bigint, constraint = Z, verifier = V, from = payer) {
    await token.mint(from.address, amount);
    await token.connect(from).approve(await vault.getAddress(), amount);
    const rc = await (await vault.connect(from).fundWith(verifier, await token.getAddress(), amount, constraint, DAY, ethers.ZeroHash)).wait();
    const ev = rc!.logs.map((l: any) => { try { return vault.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === 'Funded');
    return Number(ev.args.depositId);
  }

  beforeEach(async () => {
    [deployer, payer, ownerWallet, treasury, operator] = await ethers.getSigners();
    idv = await ethers.deployContract('MockIdentityVerifier');
    V = await idv.getAddress();
    token = await ethers.deployContract('MockERC20');
    policy = await ethers.deployContract('MockFeePolicy');
    await policy.allow(V, true);
    factory = await ethers.deployContract('PviumP2IdVaultFactory', [deployer.address, NS, await policy.getAddress(), V, 7 * DAY, DAY, 30 * DAY, ethers.ZeroAddress]);
    await factory.setAlpha(await (await ethers.getContractAt('IP2IDVerifier', await factory.defaultVerifier())).vkHash(), false); // this suite exercises the ordinary (post-alpha) paths
    await factory.deploy(ID);
    vault = await ethers.getContractAt('P2IDVault', await factory.vaultFor(ID));
  });

  it('a fee is taken on claim at the rate fixed when the deposit was made and handed to the policy with the claimer', async () => {
    await policy.setFee(50, treasury.address); // 0.5%
    const d = await fund(10_000n);
    expect((await vault.deposits(d)).feeBps).to.equal(50n);

    await policy.setFee(100, treasury.address); // raised later: must not re-price the deposit
    await expect(vault.connect(operator).refreshProofAndSweep(V, proofFor(ownerWallet.address, 1000), await token.getAddress(), 0))
      .to.emit(vault, 'Claimed').withArgs(d, ownerWallet.address, 10_000n, 50n)
      .and.to.emit(vault, 'FeeCollected').withArgs(V, await token.getAddress(), operator.address, 50n, await policy.getAddress())
      .and.to.emit(vault, 'Swept').withArgs(V, await token.getAddress(), 9_950n, 50n, ownerWallet.address, 1n);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(9_950n);
    // the policy got the fee in the same transaction and knows which verifier earned it and who claimed
    expect(await token.balanceOf(treasury.address)).to.equal(50n);
    expect(await policy.collected(V, await token.getAddress())).to.equal(50n);
    expect(await policy.claimerFees(operator.address, await token.getAddress())).to.equal(50n);
    // nothing is left behind in the vault, and no allowance was ever granted
    expect(await token.balanceOf(await vault.getAddress())).to.equal(0n);
    expect(await token.allowance(await vault.getAddress(), await policy.getAddress())).to.equal(0n);
  });

  it('a fee the policy refuses at claim time is paid to the recipient: the vault keeps no fees', async () => {
    await policy.setFee(50, treasury.address);
    const d = await fund(10_000n);
    await policy.setMode(5); // collectFee reverts: the transfer made in the same step is undone
    await expect(vault.refreshProofAndSweep(V, proofFor(ownerWallet.address, 1000), await token.getAddress(), 0))
      .to.emit(vault, 'Claimed').withArgs(d, ownerWallet.address, 10_000n, 50n)
      .and.to.emit(vault, 'Swept').withArgs(V, await token.getAddress(), 10_000n, 0n, ownerWallet.address, 1n)
      .and.not.to.emit(vault, 'FeeCollected');
    expect(await token.balanceOf(ownerWallet.address)).to.equal(10_000n);
    expect(await token.balanceOf(treasury.address)).to.equal(0n);
    expect(await token.balanceOf(await policy.getAddress())).to.equal(0n);
    expect(await token.balanceOf(await vault.getAddress())).to.equal(0n);
  });

  it('the fee hand-off grants no allowance, so a policy can never reach other deposits (audit: residual approval)', async () => {
    await policy.setFee(100, treasury.address);
    const kept = await fund(10_000n); // stays in the vault
    const claimed = await fund(10_000n);
    await vault.refreshProof(V, proofFor(ownerWallet.address, 1000));
    await vault.sweepDeposits(V, await token.getAddress(), [claimed]);
    expect(await token.balanceOf(treasury.address)).to.equal(100n);
    expect(await token.allowance(await vault.getAddress(), await policy.getAddress())).to.equal(0n);
    // whatever the policy tries afterwards, it cannot pull from the vault
    await expect(token.connect(payer).transferFrom(await vault.getAddress(), payer.address, 1n)).to.be.reverted;
    await time.increase(DAY + 1);
    await vault.connect(payer).refund(kept);
    expect(await token.balanceOf(payer.address)).to.equal(10_000n);
  });

  it('only this vault can call pushFeeToPolicy', async () => {
    await fund(1_000n);
    await expect(vault.connect(payer).pushFeeToPolicy(await policy.getAddress(), V, await token.getAddress(), payer.address, 1n))
      .to.be.revertedWithCustomError(vault, 'NotSelf');
  });

  it('under a transfer-tax token the policy is told and books what actually arrived, not the nominal fee', async () => {
    const tax = await ethers.deployContract('MockTaxERC20'); // 10% burned on every transfer
    await policy.setFee(100, treasury.address);
    await tax.mint(payer.address, 10_000n);
    await tax.connect(payer).approve(await vault.getAddress(), 10_000n);
    await vault.connect(payer).fundWith(V, await tax.getAddress(), 10_000n, Z, DAY, ethers.ZeroHash);
    expect((await vault.deposits(0)).amount).to.equal(9_000n); // what arrived is what is recorded
    await expect(vault.refreshProofAndSweep(V, proofFor(ownerWallet.address, 1000), await tax.getAddress(), 0))
      .to.emit(vault, 'FeeCollected').withArgs(V, await tax.getAddress(), deployer.address, 81n, await policy.getAddress()) // 90 sent, 81 received
      .and.to.emit(vault, 'Swept').withArgs(V, await tax.getAddress(), 8_910n, 90n, ownerWallet.address, 1n); // nominal fee charged
    expect(await policy.collected(V, await tax.getAddress())).to.equal(81n);
    expect(await tax.balanceOf(await vault.getAddress())).to.equal(0n);
  });

  it('no policy can charge more than the factory\'s fixed MAX_FEE_BPS (1%)', async () => {
    expect(await factory.MAX_FEE_BPS()).to.equal(100n);
    await policy.setFee(5_000, treasury.address); // asks for 50%
    const d = await fund(10_000n);
    expect((await vault.deposits(d)).feeBps).to.equal(100n);
    await token.mint(await vault.getAddress(), 1_000n); // bare transfer, quoted at sweep time: capped too
    await vault.refreshProofAndSweep(V, proofFor(ownerWallet.address, 1000), await token.getAddress(), 0);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(10_890n); // 11_000 - 1%
    expect(await policy.collected(V, await token.getAddress())).to.equal(110n);
  });

  it('refunds never pay a fee', async () => {
    await policy.setFee(100, treasury.address);
    const d = await fund(10_000n);
    await time.increase(DAY + 1);
    await vault.connect(payer).refund(d);
    expect(await token.balanceOf(payer.address)).to.equal(10_000n);
    expect(await token.balanceOf(treasury.address)).to.equal(0n);
  });

  it('a failing policy can never block a claim: a failed quote means no fee, and a failed collection means no fee is taken', async () => {
    await policy.setFee(100, treasury.address);
    await policy.setMode(1); // fee queries revert
    const reverted = await fund(1_000n);
    expect((await vault.deposits(reverted)).feeBps).to.equal(0n);
    await policy.setMode(2); // fee queries burn all gas they are given
    const gasBomb = await fund(1_000n);
    expect((await vault.deposits(gasBomb)).feeBps).to.equal(0n);

    await policy.setMode(0);
    const priced = await fund(1_000n); // quoted normally: 1%
    await policy.setMode(5); // collectFee reverts
    await expect(vault.refreshProofAndSweep(V, proofFor(ownerWallet.address, 1000), await token.getAddress(), 0))
      .not.to.emit(vault, 'FeeCollected');
    expect(await token.balanceOf(ownerWallet.address)).to.equal(3_000n); // claim unaffected, nothing withheld
    expect((await vault.deposits(priced)).feeBps).to.equal(100n);
    expect(await token.balanceOf(await policy.getAddress())).to.equal(0n);

    const bomb = await fund(1_000n);
    await policy.setMode(6); // collectFee burns all the gas it is given: the stipend bounds it
    const tx = await vault.sweepDeposits(V, await token.getAddress(), [bomb]);
    const rc = await tx.wait();
    expect(rc!.gasUsed).to.be.lessThan(600_000n);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(4_000n);
    expect(await token.balanceOf(await vault.getAddress())).to.equal(0n);
  });

  it('the policy splits fees as it chooses, e.g. between a verifier operator and the protocol', async () => {
    await policy.setFee(50, treasury.address);
    await policy.setOperator(V, operator.address, 7_000); // 70% to the verifier's operator
    await fund(100_000n);
    await vault.refreshProofAndSweep(V, proofFor(ownerWallet.address, 1000), await token.getAddress(), 0);
    expect(await token.balanceOf(operator.address)).to.equal(350n);
    expect(await token.balanceOf(treasury.address)).to.equal(150n);
  });

  it('under the launch policy no fee is charged; it still accepts fees and lets its owner withdraw them', async () => {
    const launch = await ethers.deployContract('PviumP2IDPolicy', [deployer.address, [V]]);
    const f = await ethers.deployContract('PviumP2IdVaultFactory', [deployer.address, NS, await launch.getAddress(), V, 7 * DAY, DAY, 30 * DAY, ethers.ZeroAddress]);
    await f.setAlpha(await (await ethers.getContractAt('IP2IDVerifier', await f.defaultVerifier())).vkHash(), false); // this suite exercises the ordinary (post-alpha) paths
    await f.deploy(ID);
    const v = await ethers.getContractAt('P2IDVault', await f.vaultFor(ID));
    await token.mint(payer.address, 1_000n);
    await token.connect(payer).approve(await v.getAddress(), 1_000n);
    await v.connect(payer).fund(await token.getAddress(), 1_000n, Z, DAY, ethers.ZeroHash);
    await v.refreshProofAndSweep(V, proofFor(ownerWallet.address, 1000), await token.getAddress(), 0);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(1_000n);
    expect(await token.balanceOf(await v.getAddress())).to.equal(0n);

    // only vaults of the configured factory can hand over fees; before setFactory nothing is accepted
    await expect(launch.connect(payer).collectFee(V, await token.getAddress(), operator.address, 1n)).to.be.revertedWithCustomError(launch, 'NotVault');
    await expect(launch.connect(payer).setFactory(await f.getAddress())).to.be.revertedWithCustomError(launch, 'NotOwner');
    await expect(launch.setFactory(payer.address)).to.be.revertedWithCustomError(launch, 'InvalidFactory'); // not a contract
    await expect(launch.setFactory(await token.getAddress())).to.be.revertedWithCustomError(launch, 'InvalidFactory'); // not a factory
    await expect(launch.setFactory(await factory.getAddress())).to.be.revertedWithCustomError(launch, 'InvalidFactory'); // a factory, but one that names another policy
    await expect(launch.setFactory(await f.getAddress())).to.emit(launch, 'FactorySet').withArgs(await f.getAddress()); // names this policy
    await expect(launch.setFactory(await f.getAddress())).to.be.revertedWithCustomError(launch, 'FactoryAlreadySet');
    expect(await launch.isVault(await v.getAddress())).to.equal(true);
    expect(await launch.isVault(payer.address)).to.equal(false);
    expect(await launch.isVault(await vault.getAddress())).to.equal(false); // a vault of another factory
    await token.mint(await launch.getAddress(), 30n);
    await expect(launch.connect(payer).collectFee(V, await token.getAddress(), operator.address, 1n)).to.be.revertedWithCustomError(launch, 'NotVault'); // real tokens, still refused
    // a genuine vault call books only what arrived (impersonate the vault to call directly)
    await impersonateAccount(await v.getAddress());
    await setBalance(await v.getAddress(), ethers.parseEther('1'));
    const asVault = launch.connect(await ethers.getSigner(await v.getAddress()));
    await expect(asVault.collectFee(V, await token.getAddress(), operator.address, 31n)).to.be.revertedWithCustomError(launch, 'FeeNotReceived'); // more than arrived
    await expect(asVault.collectFee(V, await token.getAddress(), operator.address, 20n))
      .to.emit(launch, 'FeeReceived').withArgs(await v.getAddress(), V, await token.getAddress(), operator.address, 20n);
    await asVault.collectFee(V, await token.getAddress(), operator.address, 10n);
    expect(await launch.feesOwed(V, await token.getAddress())).to.equal(30n);
    expect(await launch.accounted(await token.getAddress())).to.equal(30n);
    await expect(asVault.collectFee(V, await token.getAddress(), operator.address, 1n)).to.be.revertedWithCustomError(launch, 'FeeNotReceived'); // all booked
    await expect(asVault.collectFee(V, ethers.ZeroAddress, operator.address, 5n, { value: 4n })).to.be.revertedWithCustomError(launch, 'NativeValueMismatch');
    await asVault.collectFee(V, ethers.ZeroAddress, operator.address, 5n, { value: 5n });
    await stopImpersonatingAccount(await v.getAddress());

    // only the owner withdraws, and never more than is owed per verifier
    await expect(launch.connect(payer).withdrawFees(V, await token.getAddress(), treasury.address, 1n)).to.be.revertedWithCustomError(launch, 'NotOwner');
    await expect(launch.withdrawFees(V, await token.getAddress(), treasury.address, 31n)).to.be.revertedWithCustomError(launch, 'InsufficientFees');
    await expect(launch.withdrawFees(V, await token.getAddress(), treasury.address, 30n))
      .to.emit(launch, 'FeeWithdrawn').withArgs(V, await token.getAddress(), treasury.address, 30n);
    expect(await token.balanceOf(treasury.address)).to.equal(30n);
    expect(await launch.accounted(await token.getAddress())).to.equal(0n);
    await expect(launch.withdrawFees(V, ethers.ZeroAddress, treasury.address, 5n)).to.changeEtherBalance(treasury, 5n);
  });

  it('a policy proposed on a factory can bind to it before activation', async () => {
    const next = await ethers.deployContract('PviumP2IDPolicy', [deployer.address, [V]]);
    await expect(next.setFactory(await factory.getAddress())).to.be.revertedWithCustomError(next, 'InvalidFactory');
    await factory.proposePolicy(await next.getAddress());
    await expect(next.setFactory(await factory.getAddress())).to.emit(next, 'FactorySet');
    expect(await next.isVault(await vault.getAddress())).to.equal(true);
  });

  it('the vault never holds fees: after a claim nothing is left and bare transfers are the only untracked funds', async () => {
    await policy.setFee(50, treasury.address);
    await fund(10_000n);
    await vault.refreshProofAndSweep(V, proofFor(ownerWallet.address, 1000), await token.getAddress(), 0);
    expect(await token.balanceOf(await vault.getAddress())).to.equal(0n);
    expect(await token.balanceOf(treasury.address)).to.equal(50n);
    expect(await vault.untrackedBalance(await token.getAddress())).to.equal(0n);
    await token.mint(await vault.getAddress(), 1_000n);
    expect(await vault.untrackedBalance(await token.getAddress())).to.equal(1_000n);
    await vault.sweepUntracked(await token.getAddress()); // quoted at sweep time, 0.5%
    expect(await token.balanceOf(ownerWallet.address)).to.equal(9_950n + 995n);
    expect(await token.balanceOf(treasury.address)).to.equal(55n);
  });

  it('constrained buckets are charged too, at each deposit\'s own rate', async () => {
    const c = ethers.id('screened');
    await policy.setFee(20, treasury.address);
    const a = await fund(5_000n, c);
    await policy.setFee(40, treasury.address);
    const b = await fund(5_000n, c, V, operator); // a second funder: the same commitment, its own deposit
    await expect(vault.sweepBucket(V, { commitment: c, signature: OK }, await token.getAddress(), proofFor(ownerWallet.address, 1000), 0))
      .to.emit(vault, 'Claimed').withArgs(a, ownerWallet.address, 5_000n, 10n)
      .and.to.emit(vault, 'Claimed').withArgs(b, ownerWallet.address, 5_000n, 20n);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(9_970n);
  });

  it('a constrained deposit is refused under a verifier that cannot satisfy constraints', async () => {
    const none = await ethers.deployContract('MockNoConstraintVerifier');
    await policy.allow(await none.getAddress(), true);
    await token.mint(payer.address, 10n);
    await token.connect(payer).approve(await vault.getAddress(), 10n);
    await expect(vault.connect(payer).fundWith(await none.getAddress(), await token.getAddress(), 10n, ethers.id('c'), DAY, ethers.ZeroHash))
      .to.be.revertedWithCustomError(vault, 'ConstraintsUnsupported').withArgs(await none.getAddress());
    // a contract that is not a verifier at all does not say it supports constraints either
    await policy.allow(await token.getAddress(), true);
    await expect(vault.connect(payer).fundWith(await token.getAddress(), await token.getAddress(), 10n, ethers.id('c'), DAY, ethers.ZeroHash))
      .to.be.revertedWithCustomError(vault, 'ConstraintsUnsupported');
  });

  it('gating: disallowing a non-default verifier freezes claims under it (refunds still work); the default cannot be frozen', async () => {
    const other = await ethers.deployContract('MockIdentityVerifier');
    const O = await other.getAddress();
    await policy.allow(O, true);
    const d = await fund(1_000n, Z, O);
    await vault.refreshProof(O, proofFor(ownerWallet.address, 1000));
    await policy.allow(O, false);
    await expect(vault.sweep(O, await token.getAddress(), 0)).to.be.revertedWithCustomError(vault, 'VerifierNotApproved');
    await time.increase(DAY + 1);
    await vault.connect(payer).refund(d);
    expect(await token.balanceOf(payer.address)).to.equal(1_000n);

    await fund(500n); // under the default
    await vault.refreshProof(V, proofFor(ownerWallet.address, 1000));
    await policy.allow(V, false);
    await vault.sweep(V, await token.getAddress(), 0); // still claimable
    expect(await token.balanceOf(ownerWallet.address)).to.equal(500n);
  });
});
