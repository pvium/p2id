import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { deployImplementation, planImplementation, validateCandidate } from '../scripts/lib/implementation';

const DAY = 86400;

/** The operator path for a later implementation: checks, factory CREATE2, proposal, registration, upgrade. */
describe('deploy-implementation script', function () {
  let factory: any, deployer: any, ownerWallet: any;
  const ID = ethers.id('impl-script-identity');
  const proofFor = (wallet: string, iat: number) => ethers.AbiCoder.defaultAbiCoder().encode(['address', 'bytes32', 'uint64'], [wallet, ID, iat]);

  beforeEach(async () => {
    [deployer, ownerWallet] = await ethers.getSigners();
    const idv = await ethers.deployContract('MockIdentityVerifier');
    const policy = await ethers.deployContract('MockFeePolicy');
    await policy.allow(await idv.getAddress(), true);
    factory = await ethers.deployContract('PviumP2IdVaultFactory', [deployer.address, ethers.id('pvium.vault.v1'), await policy.getAddress(), await idv.getAddress(), 7 * DAY, DAY, 30 * DAY, ethers.ZeroAddress]);
    await factory.setAlpha(await (await ethers.getContractAt('IP2IDVerifier', await factory.defaultVerifier())).vkHash(), false); // this suite exercises the ordinary (post-alpha) paths
  });

  it('refuses an unsafe candidate before touching the chain', async () => {
    expect(validateCandidate('MockIdentityVerifier').errors.length).to.be.greaterThan(0);
    await expect(planImplementation(await factory.getAddress(), 'MockIdentityVerifier', false)).to.be.rejectedWith(/not a safe implementation/);
  });

  it('deploys through the factory at the predicted address, proposes, registers, and vaults can upgrade to it', async () => {
    const F = await factory.getAddress();
    const plan = await planImplementation(F, 'MockVaultAppends', false);
    expect(plan.alreadyDeployed).to.equal(false);
    const address = await deployImplementation(F, 'MockVaultAppends', false, deployer);
    expect(address).to.equal(plan.address);
    expect(await factory.proposedImplementation()).to.equal(address);
    expect((await planImplementation(F, 'MockVaultAppends', false)).alreadyDeployed).to.equal(true);
    await time.increase(14 * DAY);
    await factory.registerImplementation();
    expect(await factory.isRegisteredImplementation(address)).to.equal(true);
    const impl = await ethers.getContractAt('P2IDVault', address);
    expect(await impl.factory()).to.equal(F); // bound to this factory, as the creation code encoded it

    await factory.deploy(ID);
    const proxy = await ethers.getContractAt('PviumP2IDVaultProxy', await factory.vaultFor(ID));
    await proxy.connect(ownerWallet).upgradeTo(ID, address, proofFor(ownerWallet.address, 1000));
    expect(await proxy.implementation()).to.equal(address);
  });
});
