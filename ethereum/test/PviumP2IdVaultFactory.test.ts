import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CURRENT_SCHEME } from '../scripts/lib/deterministic';

// The namespace the deploy library uses, so a mismatch between it and the SDK record is caught here.
const NS = ethers.id(CURRENT_SCHEME);
const DAY = 86400;
const ID = ethers.id('identity-a');

describe('PviumP2IdVaultFactory', function () {
  let factory: any, idv: any, token: any, policy: any;
  let deployer: any, payer: any, ownerWallet: any;

  const proofFor = (wallet: string, iat: number, identityHash = ID) =>
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'bytes32', 'uint64'],
      [wallet, identityHash, iat],
    );

  /** Offline derivation: keccak256(0xff ‖ factory ‖ identityHash ‖ keccak256(creationCode)). */
  async function deriveOffline(identityHash: string) {
    const creationCode = (await ethers.getContractFactory('PviumP2IDVaultProxy'))
      .bytecode;
    return ethers.getCreate2Address(
      await factory.getAddress(),
      identityHash,
      ethers.keccak256(creationCode),
    );
  }

  beforeEach(async () => {
    [deployer, payer, ownerWallet] = await ethers.getSigners();
    idv = await ethers.deployContract('MockIdentityVerifier');
    token = await ethers.deployContract('MockERC20');
    policy = await ethers.deployContract('PviumP2IDPolicy', [deployer.address, [await idv.getAddress()]]);
    factory = await ethers.deployContract('PviumP2IdVaultFactory', [
      deployer.address,
      NS,
      await policy.getAddress(),
      await idv.getAddress(),
      7 * DAY,
      DAY,
      30 * DAY,
     ethers.ZeroAddress]);
    await factory.setAlpha(await (await ethers.getContractAt('IP2IDVerifier', await factory.defaultVerifier())).vkHash(), false); // this suite exercises the ordinary (post-alpha) paths
  });

  it('the vault address is derivable offline from the factory address and a constant', async () => {
    expect(await factory.p2idVersion()).to.equal('p2id.factory.v1');
    expect(await factory.initCodeHash()).to.equal(
      ethers.keccak256((await ethers.getContractFactory('PviumP2IDVaultProxy')).bytecode),
    );
    const predicted = await factory.vaultFor(ID);
    expect(predicted).to.equal(await deriveOffline(ID));
    expect(await factory.isDeployed(ID)).to.equal(false);
    await expect(factory.deploy(ID))
      .to.emit(factory, 'VaultDeployed')
      .withArgs(ID, predicted);
    expect(await factory.isDeployed(ID)).to.equal(true);
    const vault = await ethers.getContractAt('P2IDVault', predicted);
    expect(await vault.p2idVersion()).to.equal('p2id.vault.v1');
    expect(await vault.saltCommitment()).to.equal(ID);
    expect(await vault.nsHash()).to.equal(NS);
    expect(await vault.defaultVerifier()).to.equal(await idv.getAddress());
    expect(await vault.policy()).to.equal(await policy.getAddress());
    expect(await policy.isVerifierAllowed(await idv.getAddress())).to.equal(true);
    expect(await vault.factory()).to.equal(await factory.getAddress());
    expect(await vault.minRefundWindow()).to.equal(DAY);
    expect(await vault.maxRefundWindow()).to.equal(30 * DAY);
  });

  it('the init code hash the Node SDK ships (sdks/node/p2id-core/src/p2id.json) matches this build', async () => {
    const sdk = JSON.parse(readFileSync(join(__dirname, '..', '..', 'sdks', 'node', 'p2id-core', 'src', 'p2id.json'), 'utf8'));
    expect(sdk.current, 'deploy library and SDK record disagree on the deployment scheme').to.equal(CURRENT_SCHEME);
    expect(await factory.nsHash()).to.equal(ethers.id(sdk.current));
    expect(await factory.initCodeHash()).to.equal(
      sdk.schemes[sdk.current].vaultInitCodeHash,
      'vault bytecode changed: run node sdks/node/p2id-core/scripts/embed-p2id.mjs --update, or add the next pvium.vault.vN entry if this scheme is released',
    );
  });

  it('deploy is idempotent and different identities get different addresses', async () => {
    const a = await factory.vaultFor(ID);
    await factory.deploy(ID);
    await expect(factory.deploy(ID)).to.not.emit(factory, 'VaultDeployed');
    expect(await factory.vaultFor(ID)).to.equal(a);
    expect(await factory.vaultFor(ethers.id('identity-b'))).to.not.equal(a);
  });

  it('the constructor refuses initial settings outside the limits proposeConfig enforces (audit)', async () => {
    const args = async (delay: number, min: number, max: number) =>
      [deployer.address, NS, await policy.getAddress(), await idv.getAddress(), delay, min, max, ethers.ZeroAddress];
    const F = await ethers.getContractFactory('PviumP2IdVaultFactory');
    for (const [delay, min, max, key] of [[0, DAY, 30 * DAY, 0], [31 * DAY, DAY, 30 * DAY, 0], [7 * DAY, 0, 30 * DAY, 1], [7 * DAY, DAY, 400 * DAY, 2], [7 * DAY, 3599, DAY, 1]]) {
      await expect(F.deploy(...await args(delay, min, max))).to.be.revertedWithCustomError(F, 'InvalidConfig').withArgs(key, key === 0 ? delay : key === 1 ? min : max);
    }
    await expect(F.deploy(...await args(7 * DAY, 2 * DAY, DAY))).to.be.revertedWithCustomError(F, 'InvalidRefundWindow');
    await F.deploy(...await args(DAY, 3600, 365 * DAY)); // the limits themselves are accepted
  });

  it('policy delay and refund bounds are changed only through the timelocked config path, within fixed limits, and vaults follow live', async () => {
    const [PolicyDelay, MinWindow, MaxWindow] = [0, 1, 2];
    await factory.deploy(ID);
    const v = await ethers.getContractAt('P2IDVault', await factory.vaultFor(ID));
    expect(await v.maxRefundWindow()).to.equal(BigInt(30 * DAY));

    // owner only, and bounded by constants in the bytecode
    await expect(factory.connect(payer).proposeConfig(MaxWindow, 60 * DAY)).to.be.revertedWithCustomError(factory, 'NotOwner');
    await expect(factory.proposeConfig(PolicyDelay, DAY - 1)).to.be.revertedWithCustomError(factory, 'InvalidConfig');
    await expect(factory.proposeConfig(PolicyDelay, 30 * DAY + 1)).to.be.revertedWithCustomError(factory, 'InvalidConfig');
    await expect(factory.proposeConfig(MinWindow, 3599)).to.be.revertedWithCustomError(factory, 'InvalidConfig');
    await expect(factory.proposeConfig(MaxWindow, 365 * DAY + 1)).to.be.revertedWithCustomError(factory, 'InvalidConfig');

    // waits the current delay; cancellable
    await expect(factory.proposeConfig(MaxWindow, 180 * DAY)).to.emit(factory, 'ConfigProposed');
    expect((await factory.pendingConfig(MaxWindow)).value).to.equal(BigInt(180 * DAY));
    await expect(factory.activateConfig(MaxWindow)).to.be.revertedWithCustomError(factory, 'TimelockNotElapsed');
    await factory.cancelConfig(MaxWindow);
    await expect(factory.activateConfig(MaxWindow)).to.be.revertedWithCustomError(factory, 'NothingProposed');
    await expect(factory.cancelConfig(MaxWindow)).to.be.revertedWithCustomError(factory, 'NothingProposed');

    await factory.proposeConfig(MaxWindow, 180 * DAY);
    await time.increase(7 * DAY + 1);
    await expect(factory.connect(payer).activateConfig(MaxWindow)).to.be.revertedWithCustomError(factory, 'NotOwner');
    await expect(factory.activateConfig(MaxWindow)).to.emit(factory, 'ConfigActivated').withArgs(MaxWindow, 180 * DAY);
    expect(await factory.maxRefundWindow()).to.equal(BigInt(180 * DAY));
    expect(await v.maxRefundWindow()).to.equal(BigInt(180 * DAY)); // an existing vault follows

    // ordering is checked against live values at activation
    await factory.proposeConfig(MinWindow, 200 * DAY);
    await time.increase(7 * DAY + 1);
    await expect(factory.activateConfig(MinWindow)).to.be.revertedWithCustomError(factory, 'InvalidRefundWindow');

    // shortening the delay itself waits the current delay, then applies to later proposals
    await factory.proposeConfig(PolicyDelay, 2 * DAY);
    await time.increase(7 * DAY + 1);
    await factory.activateConfig(PolicyDelay);
    expect(await factory.policyChangeDelay()).to.equal(BigInt(2 * DAY));
    await factory.proposeConfig(MinWindow, 2 * DAY);
    expect((await factory.pendingConfig(MinWindow)).eta - BigInt(await time.latest())).to.equal(BigInt(2 * DAY));
  });

  it('initialize is factory-only and runs once', async () => {
    const [deployer] = await ethers.getSigners();
    const loose = await ethers.deployContract('P2IDVault', [deployer.address]); // an EOA as the "factory"
    await expect(
      loose.connect(payer).initialize(NS, ID),
    ).to.be.revertedWithCustomError(loose, 'NotFactory');
    await loose.initialize(NS, ID);
    await expect(
      loose.initialize(NS, ID),
    ).to.be.revertedWithCustomError(loose, 'AlreadyInitialized');
    await factory.deploy(ID);
    const vault = await ethers.getContractAt(
      'P2IDVault',
      await factory.vaultFor(ID),
    );
    await expect(
      vault.initialize(NS, ID),
    ).to.be.revertedWithCustomError(vault, 'NotFactory');
  });

  it('funds sent before deployment are swept by the owner after deployment', async () => {
    const predicted = await factory.vaultFor(ID);
    await token.mint(predicted, 500n); // e.g. a plain transfer to the derived address
    await factory.deploy(ID);
    const vault = await ethers.getContractAt('P2IDVault', predicted);
    await vault.refreshProofAndSweep(
      await idv.getAddress(),
      proofFor(ownerWallet.address, 1000),
      await token.getAddress(),
      0,
    );
    expect(await token.balanceOf(ownerWallet.address)).to.equal(500n);
  });

  it('fund() deploys on first use, records the payer as funder, and one approval pays any identity', async () => {
    await token.mint(payer.address, 300n);
    await token.connect(payer).approve(await factory.getAddress(), 300n);
    const ID_B = ethers.id('identity-b');
    await factory
      .connect(payer)
      .fund(ID, await token.getAddress(), 100n, ethers.ZeroHash, DAY, ethers.ZeroHash);
    await factory
      .connect(payer)
      .fund(ID_B, await token.getAddress(), 200n, ethers.ZeroHash, DAY, ethers.ZeroHash);
    const vaultA = await ethers.getContractAt(
      'P2IDVault',
      await factory.vaultFor(ID),
    );
    const vaultB = await ethers.getContractAt(
      'P2IDVault',
      await factory.vaultFor(ID_B),
    );
    expect(await token.balanceOf(await vaultA.getAddress())).to.equal(100n);
    expect(await token.balanceOf(await vaultB.getAddress())).to.equal(200n);
    expect(await token.balanceOf(await factory.getAddress())).to.equal(0n);
    expect((await vaultA.deposits(0)).funder).to.equal(payer.address);

    // the payer, not the factory, holds the refund right
    await expect(vaultA.refund(0)).to.be.revertedWithCustomError(
      vaultA,
      'NotFunder',
    );
    await time.increase(DAY + 1);
    await vaultA.connect(payer).refund(0);
    expect(await token.balanceOf(payer.address)).to.equal(100n);
  });

  it('only the factory can call fundFor', async () => {
    await factory.deploy(ID);
    const vault = await ethers.getContractAt(
      'P2IDVault',
      await factory.vaultFor(ID),
    );
    await expect(
      vault.fundFor(
        payer.address,
        await idv.getAddress(),
        await token.getAddress(),
        1n,
        ethers.ZeroHash,
        DAY,
        ethers.ZeroHash,
      ),
    ).to.be.revertedWithCustomError(vault, 'NotFactory');
  });

  it('the launch policy is an owner-managed allowlist with no fee; fundWith picks a verifier', async () => {
    const idv2 = await ethers.deployContract('MockIdentityVerifier');
    const V2 = await idv2.getAddress();
    await expect(policy.connect(payer).approveVerifier(V2, true)).to.be.revertedWithCustomError(policy, 'NotOwner');
    await expect(policy.approveVerifier(payer.address, true)).to.be.revertedWithCustomError(policy, 'InvalidVerifier');
    await expect(policy.approveVerifier(V2, true)).to.emit(policy, 'VerifierApprovalSet').withArgs(V2, true);
    expect(await policy.feeBps(V2, await token.getAddress())).to.equal(0n);
    await expect(policy.collectFee(V2, await token.getAddress(), deployer.address, 1n)).to.be.revertedWithCustomError(policy, 'NotVault'); // only the factory's vaults hand over fees
    expect(factory.setDefaultVerifier).to.equal(undefined); // no instant setter: only the timelocked proposal
    expect(factory.approveVerifier).to.equal(undefined); // the allowlist lives in the policy
    expect(await factory.defaultVerifier()).to.equal(await idv.getAddress());

    await token.mint(payer.address, 10n);
    await token.connect(payer).approve(await factory.getAddress(), 10n);
    await factory.connect(payer).fundWith(ID, V2, await token.getAddress(), 4n, ethers.ZeroHash, DAY, ethers.ZeroHash); // explicit opt-in
    await factory.connect(payer).fund(ID, await token.getAddress(), 6n, ethers.ZeroHash, DAY, ethers.ZeroHash); // default, unchanged
    const vault = await ethers.getContractAt('P2IDVault', await factory.vaultFor(ID));
    expect((await vault.deposits(0)).verifier).to.equal(V2);
    expect((await vault.deposits(1)).verifier).to.equal(await idv.getAddress());
    expect((await vault.deposits(1)).feeBps).to.equal(0n);

    // two-step ownership, on both the factory and the policy
    await factory.transferOwnership(payer.address);
    await expect(factory.connect(deployer).acceptOwnership()).to.be.revertedWithCustomError(factory, 'NotPendingOwner');
    await factory.connect(payer).acceptOwnership();
    expect(await factory.owner()).to.equal(payer.address);
    await expect(factory.proposePolicy(await policy.getAddress())).to.be.revertedWithCustomError(factory, 'NotOwner');
    await policy.transferOwnership(payer.address);
    await policy.connect(payer).acceptOwnership();
    await expect(policy.approveVerifier(V2, false)).to.be.revertedWithCustomError(policy, 'NotOwner');
  });

  it('the constructor requires a policy that allows the default verifier', async () => {
    const F = await ethers.getContractFactory('PviumP2IdVaultFactory');
    const empty = await ethers.deployContract('PviumP2IDPolicy', [deployer.address, []]);
    await expect(F.deploy(deployer.address, NS, await empty.getAddress(), await idv.getAddress(), 7 * DAY, DAY, 30 * DAY, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(F, 'VerifierNotApproved');
    await expect(F.deploy(deployer.address, NS, payer.address, await idv.getAddress(), 7 * DAY, DAY, 30 * DAY, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(F, 'InvalidPolicy');
  });

  it('the policy changes only through a visible timelock, and the new one must allow the default verifier', async () => {
    const V = await idv.getAddress();
    const next = await ethers.deployContract('MockFeePolicy');
    await expect(factory.connect(payer).proposePolicy(await next.getAddress())).to.be.revertedWithCustomError(factory, 'NotOwner');
    await expect(factory.proposePolicy(payer.address)).to.be.revertedWithCustomError(factory, 'InvalidPolicy');
    await expect(factory.activatePolicy()).to.be.revertedWithCustomError(factory, 'NothingProposed');

    const tx = await factory.proposePolicy(await next.getAddress());
    const eta = (await ethers.provider.getBlock((await tx.wait())!.blockNumber))!.timestamp + 7 * DAY;
    await expect(tx).to.emit(factory, 'PolicyProposed').withArgs(await next.getAddress(), eta);
    await expect(factory.activatePolicy()).to.be.revertedWithCustomError(factory, 'TimelockNotElapsed');
    expect(await factory.policy()).to.equal(await policy.getAddress());
    await time.increase(7 * DAY + 1);
    // the new policy does not yet allow the default verifier: activation would strand bare transfers
    await expect(factory.activatePolicy()).to.be.revertedWithCustomError(factory, 'VerifierNotApproved').withArgs(V);
    await next.allow(V, true);
    await expect(factory.activatePolicy()).to.emit(factory, 'PolicyActivated').withArgs(await next.getAddress());
    expect(await factory.policy()).to.equal(await next.getAddress());
    expect(await factory.proposedPolicyEta()).to.equal(0n);

    // every vault follows immediately, including ones deployed before the switch
    await factory.deploy(ID);
    const vault = await ethers.getContractAt('P2IDVault', await factory.vaultFor(ID));
    expect(await vault.policy()).to.equal(await next.getAddress());

    await factory.proposePolicy(await policy.getAddress());
    await expect(factory.cancelPolicyProposal()).to.emit(factory, 'PolicyProposalCancelled');
    await expect(factory.cancelPolicyProposal()).to.be.revertedWithCustomError(factory, 'NothingProposed');
  });

  it('the default verifier changes only after 14 days\' public notice, at any time', async () => {
    expect(await factory.DEFAULT_VERIFIER_DELAY()).to.equal(14n * 86400n);
    expect(await factory.policyChangeDelay()).to.equal(7n * 86400n);
    const idv2 = await ethers.deployContract('MockIdentityVerifier');
    const V2 = await idv2.getAddress();
    await expect(factory.proposeDefaultVerifier(V2)).to.be.revertedWithCustomError(factory, 'VerifierNotApproved');
    await policy.approveVerifier(V2, true);
    await expect(factory.activateDefaultVerifier()).to.be.revertedWithCustomError(factory, 'NothingProposed');
    await expect(factory.connect(payer).proposeDefaultVerifier(V2)).to.be.revertedWithCustomError(factory, 'NotOwner');

    const tx = await factory.proposeDefaultVerifier(V2);
    const eta = (await ethers.provider.getBlock((await tx.wait())!.blockNumber))!.timestamp + 14 * DAY;
    await expect(tx).to.emit(factory, 'DefaultVerifierProposed').withArgs(V2, eta);
    await time.increase(13 * DAY);
    await expect(factory.activateDefaultVerifier()).to.be.revertedWithCustomError(factory, 'TimelockNotElapsed');
    expect(await factory.defaultVerifier()).to.equal(await idv.getAddress()); // unchanged during the notice

    // a revocation during the notice kills the proposal in effect
    await policy.approveVerifier(V2, false);
    await time.increase(DAY + 1);
    await expect(factory.activateDefaultVerifier()).to.be.revertedWithCustomError(factory, 'VerifierNotApproved');
    await policy.approveVerifier(V2, true);
    await expect(factory.activateDefaultVerifier()).to.emit(factory, 'DefaultVerifierActivated').withArgs(V2);
    expect(await factory.defaultVerifier()).to.equal(V2);
    expect(await factory.proposedDefaultEta()).to.equal(0n);

    // cancel path
    await factory.proposeDefaultVerifier(await idv.getAddress());
    await expect(factory.cancelDefaultVerifierProposal()).to.emit(factory, 'DefaultVerifierProposalCancelled');
    await expect(factory.cancelDefaultVerifierProposal()).to.be.revertedWithCustomError(factory, 'NothingProposed');

    // no expiry on the ability to change: a year later it still works, still with 14 days' notice
    await time.increase(365 * DAY);
    await factory.proposeDefaultVerifier(await idv.getAddress());
    await time.increase(14 * DAY);
    await factory.activateDefaultVerifier();
    expect(await factory.defaultVerifier()).to.equal(await idv.getAddress());

    // vaults follow the factory
    const vault = await ethers.getContractAt('P2IDVault', await factory.deploy.staticCall(ID));
    await factory.deploy(ID);
    expect(await vault.defaultVerifier()).to.equal(await idv.getAddress());
  });
});
