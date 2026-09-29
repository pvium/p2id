import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';

const NS = ethers.id('pvium.vault.v1');
const ID = ethers.id('proxy-identity');
const DAY = 86400;
const Z = ethers.ZeroHash;

/** Every P2ID address is a PviumP2IDVaultProxy: constant creation code, owner-gated upgrades. */
describe('PviumP2IDVaultProxy', function () {
  let factory: any, policy: any, idv: any, V: string, token: any, vault: any, proxy: any, v2: any;
  let deployer: any, payer: any, ownerWallet: any, stranger: any;

  const proofFor = (wallet: string, iat: number, id = ID) =>
    ethers.AbiCoder.defaultAbiCoder().encode(['address', 'bytes32', 'uint64'], [wallet, id, iat]);

  beforeEach(async () => {
    [deployer, payer, ownerWallet, stranger] = await ethers.getSigners();
    idv = await ethers.deployContract('MockIdentityVerifier');
    V = await idv.getAddress();
    policy = await ethers.deployContract('MockFeePolicy');
    await policy.allow(V, true);
    factory = await ethers.deployContract('PviumP2IdVaultFactory', [deployer.address, NS, await policy.getAddress(), V, 7 * DAY, DAY, 30 * DAY]);
    token = await ethers.deployContract('MockERC20');
    await factory.deploy(ID);
    vault = await ethers.getContractAt('P2IDVault', await factory.vaultFor(ID));
    proxy = await ethers.getContractAt('PviumP2IDVaultProxy', await factory.vaultFor(ID));
    v2 = await ethers.deployContract('MockVaultV2', [await factory.getAddress()]);
  });

  async function fund(amount: bigint, from = payer) {
    await token.mint(from.address, amount);
    await token.connect(from).approve(await vault.getAddress(), amount);
    await vault.connect(from).fund(await token.getAddress(), amount, Z, DAY, Z);
  }

  it('a deployed vault is a proxy on the base implementation, derived from the proxy creation code', async () => {
    const creationCode = (await ethers.getContractFactory('PviumP2IDVaultProxy')).bytecode;
    expect(await factory.initCodeHash()).to.equal(ethers.keccak256(creationCode));
    expect(await proxy.implementation()).to.equal(await factory.baseImplementation());
    expect(await proxy.factory()).to.equal(await factory.getAddress());
    expect(await factory.isRegisteredImplementation(await factory.baseImplementation())).to.equal(true);
    // the vault ABI works through the proxy, and the implementation itself is bound to the factory
    expect(await vault.p2idVersion()).to.equal('p2id.vault.v1');
    expect(await vault.nsHash()).to.equal(NS);
    expect(await vault.saltCommitment()).to.equal(ID);
    const impl = await ethers.getContractAt('P2IDVault', await factory.baseImplementation());
    expect(await impl.factory()).to.equal(await factory.getAddress());
    await expect(impl.initialize(NS, ID, DAY, 30 * DAY)).to.be.revertedWithCustomError(impl, 'NotFactory'); // the raw implementation is inert
  });

  it('funds, claims, refunds and plain sends all work through the proxy', async () => {
    await fund(100n);
    await payer.sendTransaction({ to: await vault.getAddress(), value: ethers.parseEther('0.2') });
    const sender = await ethers.deployContract('MockNativeSender'); // 2300-gas transfer stipend
    await sender.send(await vault.getAddress(), { value: ethers.parseEther('0.1') });
    expect(await vault.untrackedBalance(ethers.ZeroAddress)).to.equal(ethers.parseEther('0.3'));
    await vault.refreshProofAndSweep(V, proofFor(ownerWallet.address, 1000), await token.getAddress(), 0);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(100n);
    const before = await ethers.provider.getBalance(ownerWallet.address);
    await vault.connect(payer).sweepUntracked(ethers.ZeroAddress);
    expect((await ethers.provider.getBalance(ownerWallet.address)) - before).to.equal(ethers.parseEther('0.3'));
    await fund(5n);
    await time.increase(DAY + 1);
    await vault.connect(payer).refund(1);
    expect(await token.balanceOf(payer.address)).to.equal(5n);
  });

  it('implementations are registered by the factory owner after 14 days, and can be revoked at once', async () => {
    const V2 = await v2.getAddress();
    await expect(factory.connect(stranger).proposeImplementation(V2)).to.be.revertedWithCustomError(factory, 'NotOwner');
    await expect(factory.proposeImplementation(stranger.address)).to.be.revertedWithCustomError(factory, 'InvalidImplementation');
    await expect(factory.proposeImplementation(await factory.baseImplementation())).to.be.revertedWithCustomError(factory, 'InvalidImplementation');
    await expect(factory.registerImplementation()).to.be.revertedWithCustomError(factory, 'NothingProposed');
    await expect(factory.proposeImplementation(V2)).to.emit(factory, 'ImplementationProposed');
    await expect(factory.registerImplementation()).to.be.revertedWithCustomError(factory, 'TimelockNotElapsed');
    await factory.cancelImplementationProposal();
    await expect(factory.registerImplementation()).to.be.revertedWithCustomError(factory, 'NothingProposed');
    await factory.proposeImplementation(V2);
    await time.increase(14 * DAY);
    await expect(factory.registerImplementation()).to.emit(factory, 'ImplementationRegistered').withArgs(V2);
    expect(await factory.isRegisteredImplementation(V2)).to.equal(true);
    await expect(factory.revokeImplementation(await factory.baseImplementation())).to.be.revertedWithCustomError(factory, 'InvalidImplementation');
    await expect(factory.revokeImplementation(V2)).to.emit(factory, 'ImplementationRevoked').withArgs(V2);
    expect(await factory.isRegisteredImplementation(V2)).to.equal(false);
  });

  it('only the identity owner, with a fresh proof, can move the vault, and only to a registered implementation', async () => {
    const V2 = await v2.getAddress();
    const T = await token.getAddress();
    await fund(100n);
    await vault.refreshProof(V, proofFor(ownerWallet.address, 2000)); // current owner proof
    // registry gate
    await expect(proxy.connect(ownerWallet).upgradeTo(ID, V2, proofFor(ownerWallet.address, 2000)))
      .to.be.revertedWithCustomError(proxy, 'NotRegisteredImplementation');
    await factory.proposeImplementation(V2);
    await time.increase(14 * DAY);
    await factory.registerImplementation();
    // identity gate: the proof must be for the identity this address was derived from
    const other = ethers.id('someone-else');
    await expect(proxy.connect(ownerWallet).upgradeTo(other, V2, proofFor(ownerWallet.address, 2000, other)))
      .to.be.revertedWithCustomError(proxy, 'NotVaultOf');
    // owner gate: the proven wallet must be the caller
    await expect(proxy.connect(stranger).upgradeTo(ID, V2, proofFor(ownerWallet.address, 2000)))
      .to.be.revertedWithCustomError(proxy, 'NotOwner');
    // freshness gate: a proof the vault retired cannot move it
    await expect(proxy.connect(stranger).upgradeTo(ID, V2, proofFor(stranger.address, 1000)))
      .to.be.revertedWithCustomError(proxy, 'ProofTooOld');
    // the factory owner has no special path
    await expect(proxy.connect(deployer).upgradeTo(ID, V2, proofFor(ownerWallet.address, 2000)))
      .to.be.revertedWithCustomError(proxy, 'NotOwner');

    await expect(proxy.connect(ownerWallet).upgradeTo(ID, V2, proofFor(ownerWallet.address, 2000)))
      .to.emit(proxy, 'Upgraded').withArgs(V2);
    expect(await proxy.implementation()).to.equal(V2);
    await expect(proxy.connect(ownerWallet).upgradeTo(ID, V2, proofFor(ownerWallet.address, 2000)))
      .to.be.revertedWithCustomError(proxy, 'SameImplementation');

    // storage survived: deposit, owner cache and balances are intact, and the new code is live
    const asV2 = await ethers.getContractAt('MockVaultV2', await vault.getAddress());
    expect(await asV2.version2()).to.equal(2);
    expect(await vault.owner(V)).to.equal(ownerWallet.address);
    expect(await vault.trackedTotal(T)).to.equal(100n);
    expect(await token.balanceOf(await vault.getAddress())).to.equal(100n);
    await vault.sweep(V, T, 0);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(100n);

    // a revoked implementation keeps running where it is, and the vault can move to a registered one
    await factory.revokeImplementation(V2);
    expect(await asV2.version2()).to.equal(2);
    await proxy.connect(ownerWallet).upgradeTo(ID, await factory.baseImplementation(), proofFor(ownerWallet.address, 2000));
    expect(await proxy.implementation()).to.equal(await factory.baseImplementation());
  });

  it('a vault never proven can be upgraded with any valid owner proof, which also becomes its owner proof', async () => {
    const V2 = await v2.getAddress();
    await factory.proposeImplementation(V2);
    await time.increase(14 * DAY);
    await factory.registerImplementation();
    await proxy.connect(ownerWallet).upgradeTo(ID, V2, proofFor(ownerWallet.address, 500)); // never claimed: any valid proof by the owner
    expect(await proxy.implementation()).to.equal(V2);
    expect(await vault.owner(V)).to.equal(ownerWallet.address); // the upgrade proof is presented to the vault as well
  });
});
