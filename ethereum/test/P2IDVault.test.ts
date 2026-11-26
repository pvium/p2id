import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';

const NS = ethers.id('p2id.ns.v1');
const COMMIT = ethers.id('commitment');
const DAY = 24 * 3600;
const Z = ethers.ZeroHash;

describe('P2IDVault', function () {
  this.timeout(120_000);

  let vault: any, token: any, other: any, idv: any, idv2: any, factory: any, policy: any;
  let V: string, V2: string;
  let deployer: any, alice: any, spammer: any, ownerWallet: any;

  /** Mock proof: (wallet, identityHash, iat). */
  const proofFor = (wallet: string, iat: number, identityHash = COMMIT) =>
    ethers.AbiCoder.defaultAbiCoder().encode(['address', 'bytes32', 'uint64'], [wallet, identityHash, iat]);
  /** Constraint struct; the mock accepts the signature "ok". */
  const OK = ethers.hexlify(ethers.toUtf8Bytes('ok'));
  const constraintOf = (commitment: string, signature = OK) => ({ commitment, signature });

  async function fundAs(signer: any, tok: any, amount: bigint, constraint = Z, window = DAY) {
    await tok.mint(signer.address, amount);
    await tok.connect(signer).approve(await vault.getAddress(), amount);
    const tx = await vault.connect(signer).fund(await tok.getAddress(), amount, constraint, window, ethers.ZeroHash);
    const rc = await tx.wait();
    const ev = rc!.logs.map((l: any) => { try { return vault.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === 'Funded');
    return Number(ev.args.depositId);
  }

  beforeEach(async () => {
    [deployer, alice, spammer, ownerWallet] = await ethers.getSigners();
    idv = await ethers.deployContract('MockIdentityVerifier');
    idv2 = await ethers.deployContract('MockIdentityVerifier');
    V = await idv.getAddress();
    V2 = await idv2.getAddress();
    token = await ethers.deployContract('MockERC20');
    other = await ethers.deployContract('MockERC20');
    policy = await ethers.deployContract('PviumP2IDPolicy', [deployer.address, [V]]);
    factory = await ethers.deployContract('PviumP2IdVaultFactory', [deployer.address, NS, await policy.getAddress(), V, 7 * DAY, DAY, 30 * DAY, ethers.ZeroAddress]);
    await factory.setAlpha(await (await ethers.getContractAt('IP2IDVerifier', await factory.defaultVerifier())).vkHash(), false); // this suite exercises the ordinary (post-alpha) paths
    await factory.deploy(COMMIT);
    vault = await ethers.getContractAt('P2IDVault', await factory.vaultFor(COMMIT));
  });

  it('refreshProofAndSweep claims in one call: owner set, default bucket and bare transfers paid', async () => {
    await fundAs(alice, token, 100n);
    await token.mint(await vault.getAddress(), 5n);
    await expect(vault.sweep(V, await token.getAddress(), 0)).to.be.revertedWithCustomError(vault, 'OwnerNotInitialized');

    await vault.refreshProofAndSweep(V, proofFor(ownerWallet.address, 1000), await token.getAddress(), 0);
    expect(await vault.owner(V)).to.equal(ownerWallet.address);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(105n);
    expect(await vault.bucketTotal(V, Z, await token.getAddress())).to.equal(0n);
    expect((await vault.deposits(0)).consumed).to.equal(true);
  });

  it('the vault pins its own commitment when verifying', async () => {
    await expect(vault.refreshProof(V, proofFor(ownerWallet.address, 1000, ethers.id('someone-else'))))
      .to.be.revertedWithCustomError(idv, 'MockIdentityMismatch');
  });

  it('spam deposits in another token do not affect sweeping this token', async () => {
    await fundAs(alice, token, 100n);
    await vault.refreshProof(V, proofFor(ownerWallet.address, 1000));
    const withoutSpam = await vault.sweep.estimateGas(V, await token.getAddress(), 0);
    for (let i = 0; i < 50; i++) await fundAs(spammer, other, 1n);

    const gas = await vault.sweep.estimateGas(V, await token.getAddress(), 0);
    await vault.sweep(V, await token.getAddress(), 0);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(100n);
    expect(await vault.bucketDepositCount(V, Z, await token.getAddress())).to.equal(1n);
    expect(gas).to.be.at.most(withoutSpam + 500n); // unrelated buckets add no per-deposit work
    expect(gas).to.be.lessThan(180_000n); // includes proxy and pinned-key/cache revision checks
  });

  it('bounded sweep walks the bucket in pages via the cursor', async () => {
    for (let i = 0; i < 10; i++) await fundAs(alice, token, 10n);
    await vault.refreshProof(V, proofFor(ownerWallet.address, 1000));

    await vault.sweep(V, await token.getAddress(), 4);
    expect(await vault.bucketCursor(V, Z, await token.getAddress())).to.equal(4n);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(40n);
    expect(await vault.bucketTotal(V, Z, await token.getAddress())).to.equal(60n);
    await vault.sweep(V, await token.getAddress(), 4);
    await vault.sweep(V, await token.getAddress(), 4);
    expect(await vault.bucketCursor(V, Z, await token.getAddress())).to.equal(10n);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(100n);
  });

  it('sweepDeposits by id skips spam in the same bucket and leaves the rest refundable', async () => {
    const good = await fundAs(alice, token, 100n);
    const spam1 = await fundAs(spammer, token, 1n);
    const spam2 = await fundAs(spammer, token, 1n);
    await vault.refreshProof(V, proofFor(ownerWallet.address, 1000));

    await vault.sweepDeposits(V, await token.getAddress(), [good]);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(100n);
    expect((await vault.deposits(spam1)).consumed).to.equal(false);
    await expect(vault.sweepDeposits(V, await token.getAddress(), [good])).to.be.revertedWithCustomError(vault, 'DepositConsumed');

    await time.increase(DAY + 1);
    await vault.connect(spammer).refund(spam2);
    expect(await token.balanceOf(spammer.address)).to.equal(1n);
    expect(await token.balanceOf(await vault.getAddress())).to.equal(1n);
  });

  it('a plain sweep never pays out constrained deposits; a constrained sweep needs proof + constraint', async () => {
    const constraint = ethers.id('screening:policy-1:payee');
    await fundAs(alice, token, 100n);
    await fundAs(alice, token, 40n, constraint);
    await vault.refreshProof(V, proofFor(ownerWallet.address, 1000));

    expect(await vault.trackedTotal(await token.getAddress())).to.equal(140n);
    expect(await vault.sweepable(V, await token.getAddress())).to.equal(100n);
    await vault.sweep(V, await token.getAddress(), 0);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(100n);
    expect(await token.balanceOf(await vault.getAddress())).to.equal(40n);
    expect(await vault.trackedTotal(await token.getAddress())).to.equal(40n);

    // constraint evidence rejected by the verifier -> sweep reverts
    await expect(vault.sweepBucket(V, constraintOf(constraint, '0x'), await token.getAddress(), proofFor(ownerWallet.address, 1000), 0))
      .to.be.revertedWithCustomError(idv, 'MockConstraintFailed');
    // wrong identity in the proof -> verifier rejects (vault pins saltCommitment)
    await expect(vault.sweepBucket(V, constraintOf(constraint), await token.getAddress(), proofFor(ownerWallet.address, 1000, ethers.id('x')), 0))
      .to.be.revertedWithCustomError(idv, 'MockIdentityMismatch');
    // funds go to the wallet the proof resolves to
    await vault.connect(spammer).sweepBucket(V, constraintOf(constraint), await token.getAddress(), proofFor(ownerWallet.address, 1000), 0);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(140n);
    expect(await vault.trackedTotal(await token.getAddress())).to.equal(0n);
  });

  it('a partial sweep pays only what it consumed plus untracked surplus, so later refunds stay funded', async () => {
    const d0 = await fundAs(alice, token, 10n);
    const d1 = await fundAs(spammer, token, 20n);
    await fundAs(alice, token, 30n);
    await token.mint(await vault.getAddress(), 7n);
    await vault.refreshProof(V, proofFor(ownerWallet.address, 1000));

    await vault.sweep(V, await token.getAddress(), 1);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(17n);
    expect(await token.balanceOf(await vault.getAddress())).to.equal(50n);
    await time.increase(DAY + 1);
    await vault.connect(spammer).refund(d1);
    expect(await token.balanceOf(spammer.address)).to.equal(20n);
    await vault.sweep(V, await token.getAddress(), 0);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(47n);
    expect(await vault.bucketTotal(V, Z, await token.getAddress())).to.equal(0n);
    expect((await vault.deposits(d0)).consumed).to.equal(true);
  });

  it('sweepUntracked takes bare transfers only and leaves deposits untouched', async () => {
    const d = await fundAs(alice, token, 100n);
    await token.mint(await vault.getAddress(), 9n);
    await vault.refreshProof(V, proofFor(ownerWallet.address, 1000));
    expect(await vault.untrackedBalance(await token.getAddress())).to.equal(9n);
    expect(await vault.sweepable(V, await token.getAddress())).to.equal(109n);
    await vault.sweepUntracked(await token.getAddress());
    expect(await token.balanceOf(ownerWallet.address)).to.equal(9n);
    expect((await vault.deposits(d)).consumed).to.equal(false);
    await other.mint(await vault.getAddress(), 3n);
    await vault.sweepUntracked(await other.getAddress());
    expect(await other.balanceOf(ownerWallet.address)).to.equal(3n);
  });

  it('sweepDeposits rejects ids from another bucket or token; buckets key on the constraint', async () => {
    const c1 = ethers.id('c1'), c2 = ethers.id('c2');
    const constrained = await fundAs(alice, token, 5n, c1);
    await fundAs(alice, token, 7n, c2);
    const otherTok = await fundAs(alice, other, 5n);
    await vault.refreshProof(V, proofFor(ownerWallet.address, 1000));
    await expect(vault.sweepDeposits(V, await token.getAddress(), [constrained])).to.be.revertedWithCustomError(vault, 'DepositNotInBucket');
    await expect(vault.sweepDeposits(V, await token.getAddress(), [otherTok])).to.be.revertedWithCustomError(vault, 'DepositNotInBucket');
    await expect(vault.sweepDeposits(V, await token.getAddress(), [99])).to.be.revertedWithCustomError(vault, 'DepositNotInBucket');
    await vault.sweepBucket(V, constraintOf(c1), await token.getAddress(), proofFor(ownerWallet.address, 1000), 0);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(5n); // c2's bucket untouched
    expect(await vault.bucketTotal(V, c2, await token.getAddress())).to.equal(7n);
  });

  it('sweepBucket refuses the default bucket: it is only reachable through sweep()', async () => {
    await fundAs(alice, token, 10n);
    await expect(vault.sweepBucket(V, constraintOf(Z, '0x'), await token.getAddress(), proofFor(ownerWallet.address, 1000), 0))
      .to.be.revertedWithCustomError(vault, 'ConstraintRequired');
    await expect(vault.sweepBucketDeposits(V, constraintOf(Z, '0x'), await token.getAddress(), [0], proofFor(ownerWallet.address, 1000)))
      .to.be.revertedWithCustomError(vault, 'ConstraintRequired');
  });

  it('a funder can use a constraint once; other funders are unaffected', async () => {
    const c = ethers.id('screened');
    await fundAs(alice, token, 10n, c);
    expect(await vault.constraintDeposit(c, alice.address)).to.deep.equal([true, 0n]);
    expect(await vault.constraintDeposit(c, spammer.address)).to.deep.equal([false, 0n]);
    await expect(fundAs(alice, token, 10n, c)).to.be.revertedWithCustomError(vault, 'ConstraintUsed').withArgs(0);
    await expect(fundAs(alice, token, 10n, ethers.id('screened-2'))).to.not.be.reverted; // a fresh one is fine
    await fundAs(spammer, token, 1n, c); // someone else copying it only adds their own money to the bucket
    // the constraint stays used after the deposit is refunded or claimed
    await time.increase(DAY + 1);
    await vault.connect(alice).refund(0);
    await expect(fundAs(alice, token, 10n, c)).to.be.revertedWithCustomError(vault, 'ConstraintUsed').withArgs(0);
    await vault.sweepBucket(V, constraintOf(c), await token.getAddress(), proofFor(ownerWallet.address, 1000), 0);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(1n); // spammer's copy; alice's was refunded
    await expect(fundAs(alice, token, 10n, c)).to.be.revertedWithCustomError(vault, 'ConstraintUsed').withArgs(0);
  });

  it('a verifier revision change voids the cached owner until a proof is presented again', async () => {
    await fundAs(alice, token, 10n);
    await vault.refreshProof(V, proofFor(ownerWallet.address, 1000));
    await idv.setRevision(1);
    await expect(vault.sweep(V, await token.getAddress(), 0)).to.be.revertedWithCustomError(vault, 'OwnerRevoked');
    await expect(vault.sweepUntracked(await token.getAddress())).to.be.revertedWithCustomError(vault, 'OwnerRevoked');
    expect(await vault.sweepable(V, await token.getAddress())).to.equal(10n); // deposits still count; untracked does not
    // a proof the ratchet retired stays retired; the latest one (same age) re-establishes the owner
    await expect(vault.refreshProof(V, proofFor(spammer.address, 999))).to.be.revertedWithCustomError(vault, 'ProofTooOld');
    await expect(vault.refreshProof(V, proofFor(ownerWallet.address, 1000))).to.emit(vault, 'OwnerRefreshed');
    expect(await vault.ownerRevision(V)).to.equal(1n);
    await vault.sweep(V, await token.getAddress(), 0);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(10n);
  });

  it('a wallet the owner moved away from cannot come back through an unrelated revocation', async () => {
    await fundAs(alice, token, 10n);
    await vault.refreshProof(V, proofFor(spammer.address, 1000)); // the old wallet, later compromised
    await vault.refreshProof(V, proofFor(ownerWallet.address, 2000)); // rotated away from it
    await idv.setRevision(1); // e.g. a retired key was revoked
    await expect(vault.refreshProofAndSweep(V, proofFor(spammer.address, 1000), await token.getAddress(), 0))
      .to.be.revertedWithCustomError(vault, 'ProofTooOld');
    await vault.refreshProofAndSweep(V, proofFor(ownerWallet.address, 2000), await token.getAddress(), 0);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(10n);
    expect(await token.balanceOf(spammer.address)).to.equal(0n);
  });

  it('after a revision change, a same-age proof restores only the recorded wallet; another wallet needs a newer proof', async () => {
    await fundAs(alice, token, 10n);
    await vault.refreshProof(V, proofFor(ownerWallet.address, 1000));
    await idv.setRevision(1);
    await vault.refreshProof(V, proofFor(spammer.address, 1000)); // same age, different wallet: verified, but not the owner
    expect(await vault.owner(V)).to.equal(ownerWallet.address);
    await expect(vault.sweep(V, await token.getAddress(), 0)).to.be.revertedWithCustomError(vault, 'OwnerRevoked'); // still void
    await expect(vault.refreshProofAndSweep(V, proofFor(spammer.address, 1000), await token.getAddress(), 0))
      .to.be.revertedWithCustomError(vault, 'OwnerRevoked'); // the combined path pays nobody either
    await vault.refreshProof(V, proofFor(ownerWallet.address, 1000)); // the recorded wallet re-validates
    expect(await vault.ownerRevision(V)).to.equal(1n);
    await vault.sweep(V, await token.getAddress(), 0);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(10n);
    expect(await token.balanceOf(spammer.address)).to.equal(0n);
    await vault.refreshProof(V, proofFor(spammer.address, 1001)); // a newer proof moves the owner as always
    expect(await vault.owner(V)).to.equal(spammer.address);
  });

  it('a proof issued in the future is refused, so a forged issue time cannot poison the ratchets', async () => {
    const now = await time.latest();
    await expect(vault.refreshProof(V, proofFor(ownerWallet.address, now + 3600))).to.be.revertedWithCustomError(vault, 'ProofFromFuture');
    await vault.refreshProof(V, proofFor(ownerWallet.address, now + 60));
  });

  it('re-proving the owner retires older proofs for constrained sweeps too', async () => {
    const c = ethers.id('screened');
    await fundAs(alice, token, 10n, c);
    await vault.refreshProof(V, proofFor(ownerWallet.address, 2000)); // rotated away from a compromised wallet
    await expect(vault.sweepBucket(V, constraintOf(c), await token.getAddress(), proofFor(spammer.address, 1000), 0))
      .to.be.revertedWithCustomError(vault, 'ProofTooOld');
    await vault.sweepBucket(V, constraintOf(c), await token.getAddress(), proofFor(ownerWallet.address, 2000), 0);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(10n);
  });

  it('a sweep visits at most MAX_SWEEP_PAGE records, so any bucket can be swept in pages', async () => {
    const T = await token.getAddress();
    expect(await vault.MAX_SWEEP_PAGE()).to.equal(100n);
    for (let i = 0; i < 120; i++) await fundAs(alice, token, 1n);
    await vault.refreshProof(V, proofFor(ownerWallet.address, 1000));
    const [, consumed] = await vault.sweep.staticCall(V, T, 0);
    expect(consumed).to.equal(100n); // 0 means one full page, not everything
    await vault.sweep(V, T, 0);
    expect(await vault.bucketCursor(V, Z, T)).to.equal(100n);
    await vault.sweep(V, T, 1_000_000); // above the cap: capped, not reverted
    expect(await vault.bucketCursor(V, Z, T)).to.equal(120n);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(120n);
  });

  it('bucketDepositIds is paged', async () => {
    const T = await token.getAddress();
    for (let i = 0; i < 5; i++) await fundAs(alice, token, 1n);
    expect(await vault.bucketDepositIds(V, Z, T, 0, 0)).to.deep.equal([0n, 1n, 2n, 3n, 4n]);
    expect(await vault.bucketDepositIds(V, Z, T, 1, 2)).to.deep.equal([1n, 2n]);
    expect(await vault.bucketDepositIds(V, Z, T, 3, 10)).to.deep.equal([3n, 4n]);
    expect(await vault.bucketDepositIds(V, Z, T, 5, 0)).to.deep.equal([]);
    expect(await vault.bucketDepositCount(V, Z, T)).to.equal(5n);
  });

  it('a verifier whose revision() cannot be read gets no proofless claims and no new proofs', async () => {
    await fundAs(alice, token, 10n);
    await vault.refreshProof(V, proofFor(ownerWallet.address, 1000));
    await idv.breakRevision(true);
    await expect(vault.sweep(V, await token.getAddress(), 0)).to.be.revertedWithCustomError(vault, 'OwnerRevoked');
    await expect(vault.sweepUntracked(await token.getAddress())).to.be.revertedWithCustomError(vault, 'OwnerRevoked');
    await expect(vault.refreshProof(V, proofFor(ownerWallet.address, 1001))).to.be.revertedWithCustomError(vault, 'RevisionUnavailable');
    await expect(vault.connect(alice).refund(0)).to.be.revertedWithCustomError(vault, 'RefundNotReady'); // refunds never ask
    await idv.breakRevision(false);
    await vault.sweep(V, await token.getAddress(), 0);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(10n);
  });

  it('a page visits a fixed number of records even when they are already consumed', async () => {
    for (let i = 0; i < 6; i++) await fundAs(spammer, token, 1n, Z, DAY);
    await fundAs(alice, token, 50n);
    await time.increase(DAY + 1);
    for (let i = 0; i < 6; i++) await vault.connect(spammer).refund(i);
    await vault.refreshProof(V, proofFor(ownerWallet.address, 1000));
    await vault.sweep(V, await token.getAddress(), 4); // visits 4 refunded records, consumes none
    expect(await vault.bucketCursor(V, Z, await token.getAddress())).to.equal(4n);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(0n);
    await vault.sweep(V, await token.getAddress(), 4); // visits the last 2 refunded + alice's
    expect(await vault.bucketCursor(V, Z, await token.getAddress())).to.equal(7n);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(50n);
  });

  it('re-submitting the current owner proof is a no-op instead of a revert', async () => {
    await vault.refreshProof(V, proofFor(ownerWallet.address, 1000));
    await expect(vault.refreshProof(V, proofFor(ownerWallet.address, 1000))).to.not.be.reverted; // e.g. front-run copy
    expect(await vault.owner(V)).to.equal(ownerWallet.address);
  });

  it('a claim with a newer proof moves the owner and retires older proofs, without refreshProof', async () => {
    const c = ethers.id('screened');
    await fundAs(alice, token, 10n, c);
    await fundAs(alice, token, 5n);
    await vault.refreshProof(V, proofFor(spammer.address, 1000)); // old wallet, later compromised
    await expect(vault.sweepBucket(V, constraintOf(c), await token.getAddress(), proofFor(ownerWallet.address, 2000), 0))
      .to.emit(vault, 'OwnerRefreshed').withArgs(V, ownerWallet.address, 2000);
    expect(await vault.owner(V)).to.equal(ownerWallet.address);
    expect(await vault.latestProofIat(V)).to.equal(2000n);
    await expect(vault.refreshProof(V, proofFor(spammer.address, 1000))).to.be.revertedWithCustomError(vault, 'ProofTooOld');
    await vault.sweep(V, await token.getAddress(), 0);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(15n);
    expect(await token.balanceOf(spammer.address)).to.equal(0n);
  });

  it('owner moves only with a newer proof; a same-age proof for another wallet keeps the owner', async () => {
    await vault.refreshProof(V, proofFor(ownerWallet.address, 1000));
    await vault.refreshProof(V, proofFor(alice.address, 1000)); // e.g. another wallet slot of the same token
    expect(await vault.owner(V)).to.equal(ownerWallet.address);
    await vault.refreshProof(V, proofFor(alice.address, 1001));
    expect(await vault.owner(V)).to.equal(alice.address);
  });

  // ------------------------------------------------------------------ verifier registry

  it('deposits name their verifier; only factory-approved verifiers are accepted', async () => {
    await token.mint(alice.address, 10n);
    await token.connect(alice).approve(await vault.getAddress(), 10n);
    await expect(vault.connect(alice).fundWith(V2, await token.getAddress(), 10n, Z, DAY, ethers.ZeroHash))
      .to.be.revertedWithCustomError(vault, 'VerifierNotApproved').withArgs(V2);
    await policy.approveVerifier(V2, true);
    await vault.connect(alice).fundWith(V2, await token.getAddress(), 10n, Z, DAY, ethers.ZeroHash);
    expect((await vault.deposits(0)).verifier).to.equal(V2);
    expect(await vault.bucketTotal(V2, Z, await token.getAddress())).to.equal(10n);
    expect(await vault.bucketTotal(V, Z, await token.getAddress())).to.equal(0n);
  });

  it('each verifier has its own owner, ratchet and buckets; only the default verifier takes untracked funds', async () => {
    await policy.approveVerifier(V2, true);
    await fundAs(alice, token, 100n); // default verifier (V)
    await token.mint(alice.address, 40n);
    await token.connect(alice).approve(await vault.getAddress(), 40n);
    await vault.connect(alice).fundWith(V2, await token.getAddress(), 40n, Z, DAY, ethers.ZeroHash);
    await token.mint(await vault.getAddress(), 7n); // bare transfer

    // a proof under V does not unlock V2's bucket
    await vault.refreshProof(V, proofFor(ownerWallet.address, 1000));
    await expect(vault.sweep(V2, await token.getAddress(), 0)).to.be.revertedWithCustomError(vault, 'OwnerNotInitialized');
    expect(await vault.sweepable(V, await token.getAddress())).to.equal(107n);
    expect(await vault.sweepable(V2, await token.getAddress())).to.equal(40n);

    await vault.refreshProofAndSweep(V2, proofFor(spammer.address, 5000), await token.getAddress(), 0);
    expect(await token.balanceOf(spammer.address)).to.equal(40n); // V2's bucket only, no untracked
    expect(await vault.owner(V2)).to.equal(spammer.address);
    expect(await vault.owner(V)).to.equal(ownerWallet.address);
    await vault.sweep(V, await token.getAddress(), 0);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(107n);
  });

  it('revoking a verifier freezes claims under it but not refunds; re-approving resumes', async () => {
    await policy.approveVerifier(V2, true);
    await token.mint(alice.address, 10n);
    await token.connect(alice).approve(await vault.getAddress(), 10n);
    await vault.connect(alice).fundWith(V2, await token.getAddress(), 10n, Z, DAY, ethers.ZeroHash);
    await vault.refreshProof(V2, proofFor(ownerWallet.address, 1000));

    await policy.approveVerifier(V2, false);
    await expect(vault.sweep(V2, await token.getAddress(), 0)).to.be.revertedWithCustomError(vault, 'VerifierNotApproved');
    await expect(vault.refreshProof(V2, proofFor(ownerWallet.address, 2000))).to.be.revertedWithCustomError(vault, 'VerifierNotApproved');
    await expect(vault.sweepDeposits(V2, await token.getAddress(), [0])).to.be.revertedWithCustomError(vault, 'VerifierNotApproved');
    await policy.approveVerifier(V2, true);
    await vault.sweep(V2, await token.getAddress(), 0);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(10n);

    await token.mint(alice.address, 5n);
    await token.connect(alice).approve(await vault.getAddress(), 5n);
    await vault.connect(alice).fundWith(V2, await token.getAddress(), 5n, Z, DAY, ethers.ZeroHash);
    await policy.approveVerifier(V2, false);
    await time.increase(DAY + 1);
    await vault.connect(alice).refund(1); // still refundable while frozen
    expect(await token.balanceOf(alice.address)).to.equal(5n);
  });

});
