import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { targetsOf, vaultTarget } from '../scripts/verify-deployments';

describe('PviumP2IdVaultFactory proxy deployment and maintenance audit', function () {
  const DAY = 86400;
  const NS = ethers.id('pvium.vault.v1');
  const ID = ethers.id('factory-audit');
  const Z = ethers.ZeroHash;
  let factory: any, verifier: any, policy: any, token: any;
  let admin: any, nextAdmin: any, wallet: any, payer: any;
  const proof = (address: string, iat = 2000) => ethers.AbiCoder.defaultAbiCoder()
    .encode(['address', 'bytes32', 'uint64'], [address, ID, iat]);

  beforeEach(async () => {
    [admin, nextAdmin, wallet, payer] = await ethers.getSigners();
    verifier = await ethers.deployContract('MockIdentityVerifier');
    policy = await ethers.deployContract('PviumP2IDPolicy', [admin.address, [await verifier.getAddress()]]);
    token = await ethers.deployContract('MockERC20');
    factory = await ethers.deployContract('PviumP2IdVaultFactory', [admin.address, NS,
      await policy.getAddress(), await verifier.getAddress(), 7 * DAY, DAY, 30 * DAY, ethers.ZeroAddress]);
    await factory.setAlpha(await (await ethers.getContractAt('IP2IDVerifier', await factory.defaultVerifier())).vkHash(), false); // this suite exercises the ordinary (post-alpha) paths
  });

  async function register(target: string) {
    await factory.proposeImplementation(target);
    await time.increase(14 * DAY);
    await factory.registerImplementation();
  }

  it('permissionless deployment initializes the derived proxy without assigning authority to the deploy caller', async () => {
    const address = await factory.vaultFor(ID);
    await token.mint(address, 100n);
    await factory.connect(payer).deploy(ID);
    const proxy = await ethers.getContractAt('PviumP2IDVaultProxy', address);
    const vault = await ethers.getContractAt('P2IDVault', address);
    expect(await proxy.implementation()).to.equal(await factory.baseImplementation());
    expect(await proxy.factory()).to.equal(await factory.getAddress());
    expect(await vault.saltCommitment()).to.equal(ID);
    expect(await vault.nsHash()).to.equal(NS);
    expect(await vault.owner(await verifier.getAddress())).to.equal(ethers.ZeroAddress);
    await expect(vault.connect(payer).initialize(Z, Z, 0, 0)).to.be.revertedWithCustomError(vault, 'NotFactory');
    const base = await ethers.getContractAt('P2IDVault', await factory.baseImplementation());
    await expect(base.connect(admin).initialize(NS, ID, DAY, 30 * DAY)).to.be.revertedWithCustomError(base, 'NotFactory');
    await vault.refreshProofAndSweep(await verifier.getAddress(), proof(wallet.address), await token.getAddress(), 0);
    expect(await token.balanceOf(wallet.address)).to.equal(100n);
    expect(await token.balanceOf(payer.address)).to.equal(0n);
  });

  it('registration does not switch the default implementation, and deploy does not reset an upgraded proxy', async () => {
    await factory.deploy(ID);
    const address = await factory.vaultFor(ID);
    const proxy = await ethers.getContractAt('PviumP2IDVaultProxy', address);
    const v2 = await ethers.deployContract('MockVaultV2', [await factory.getAddress()]);
    await register(await v2.getAddress());
    await proxy.connect(wallet).upgradeTo(ID, await v2.getAddress(), proof(wallet.address));
    await factory.connect(payer).deploy(ID);
    expect(await proxy.implementation()).to.equal(await v2.getAddress());
    expect(await proxy.lastUpgrade()).to.deep.equal([wallet.address, 2000n]);
    const other = ethers.id('factory-audit-new');
    await factory.deploy(other);
    const fresh = await ethers.getContractAt('PviumP2IDVaultProxy', await factory.vaultFor(other));
    expect(await fresh.implementation()).to.equal(await factory.baseImplementation());
    await expect(factory.revokeImplementation(await factory.baseImplementation()))
      .to.be.revertedWithCustomError(factory, 'InvalidImplementation');
  });

  it('routes ERC-20 and native funding through an upgraded compatible implementation', async () => {
    await factory.deploy(ID);
    const address = await factory.vaultFor(ID);
    const proxy = await ethers.getContractAt('PviumP2IDVaultProxy', address);
    const v2 = await ethers.deployContract('MockVaultV2', [await factory.getAddress()]);
    await register(await v2.getAddress());
    await proxy.connect(wallet).upgradeTo(ID, await v2.getAddress(), proof(wallet.address));
    await token.mint(payer.address, 100n);
    await token.connect(payer).approve(await factory.getAddress(), 100n);
    await factory.connect(payer).fund(ID, await token.getAddress(), 100n, Z, DAY, Z);
    await factory.connect(payer).fund(ID, ethers.ZeroAddress, 50n, Z, DAY, Z, { value: 50n });
    const vault = await ethers.getContractAt('P2IDVault', address);
    expect((await vault.deposits(0)).funder).to.equal(payer.address);
    expect((await vault.deposits(1)).funder).to.equal(payer.address);
    expect(await token.balanceOf(await factory.getAddress())).to.equal(0n);
    expect(await token.allowance(await factory.getAddress(), address)).to.equal(0n);
    await time.increase(DAY + 1);
    await vault.connect(payer).refund(0);
    await expect(vault.connect(payer).refund(1)).to.changeEtherBalances([vault, payer], [-50n, 50n]);
    expect(await token.balanceOf(payer.address)).to.equal(100n);
  });

  it('an implementation bound to another factory cannot be registered, so no vault can be pointed at a foreign policy', async () => {
    const otherPolicy = await ethers.deployContract('PviumP2IDPolicy', [nextAdmin.address, [await verifier.getAddress()]]);
    const otherFactory = await ethers.deployContract('PviumP2IdVaultFactory', [nextAdmin.address, NS,
      await otherPolicy.getAddress(), await verifier.getAddress(), 7 * DAY, DAY, 30 * DAY, ethers.ZeroAddress]);
    await otherFactory.connect(nextAdmin).setAlpha(await (await ethers.getContractAt('IP2IDVerifier', await otherFactory.defaultVerifier())).vkHash(), false); // this suite exercises the ordinary (post-alpha) paths
    await factory.deploy(ID);
    const vault = await ethers.getContractAt('P2IDVault', await factory.vaultFor(ID));
    // Its base implementation is a real vault, but its factory() is the other factory.
    await expect(factory.proposeImplementation(await otherFactory.baseImplementation()))
      .to.be.revertedWithCustomError(factory, 'InvalidImplementation');
    expect(await factory.isRegisteredImplementation(await otherFactory.baseImplementation())).to.equal(false);
    expect(await vault.policy()).to.equal(await policy.getAddress());
    await factory.connect(payer).fund(ID, ethers.ZeroAddress, 1n, Z, DAY, Z, { value: 1n }); // still this factory's vault
  });

  it('restricts maintenance to the accepted owner and preserves pending proposal delays across handover', async () => {
    const v2 = await ethers.deployContract('MockVaultV2', [await factory.getAddress()]);
    const target = await v2.getAddress();
    const operations: [string, any[]][] = [
      ['proposeImplementation', [target]], ['registerImplementation', []], ['cancelImplementationProposal', []],
      ['revokeImplementation', [target]], ['proposePolicy', [await policy.getAddress()]], ['activatePolicy', []],
      ['cancelPolicyProposal', []], ['proposeDefaultVerifier', [await verifier.getAddress()]],
      ['activateDefaultVerifier', []], ['cancelDefaultVerifierProposal', []], ['transferOwnership', [payer.address]],
    ];
    for (const [method, args] of operations) {
      await expect(factory.connect(payer)[method](...args)).to.be.revertedWithCustomError(factory, 'NotOwner');
    }
    await factory.proposeImplementation(target);
    const eta = await factory.proposedImplementationEta();
    await factory.transferOwnership(nextAdmin.address);
    await expect(factory.connect(nextAdmin).registerImplementation()).to.be.revertedWithCustomError(factory, 'NotOwner');
    await factory.connect(nextAdmin).acceptOwnership();
    expect(await factory.pendingOwner()).to.equal(ethers.ZeroAddress);
    expect(await factory.proposedImplementationEta()).to.equal(eta);
    await expect(factory.registerImplementation()).to.be.revertedWithCustomError(factory, 'NotOwner');
    await expect(factory.connect(nextAdmin).registerImplementation()).to.be.revertedWithCustomError(factory, 'TimelockNotElapsed');
    await time.increaseTo(eta);
    await factory.connect(nextAdmin).registerImplementation();
    expect(await factory.isRegisteredImplementation(target)).to.equal(true);
  });

  it('builds explorer targets for the base implementation and vault proxy separately', async () => {
    const record = { factory: await factory.getAddress(), scheme: 'pvium.vault.v1', privyKeys: [],
      config: { owner: admin.address, attester: ethers.ZeroAddress, circuitVersion: 1,
        policyChangeDelay: 7 * DAY, minRefundWindow: DAY, maxRefundWindow: 30 * DAY },
      pviumVerifier: await verifier.getAddress(), policy: await policy.getAddress() };
    const base = targetsOf(record).find((target) => target.name === 'P2IDVault')!;
    expect(base.address).to.equal(await factory.baseImplementation());
    expect(base.args).to.deep.equal([await factory.getAddress()]);
    const target = vaultTarget(await factory.vaultFor(ID));
    expect(target.contract).to.equal('src/PviumP2IDVaultProxy.sol:PviumP2IDVaultProxy');
    expect(target.args).to.deep.equal([]);
  });
});
