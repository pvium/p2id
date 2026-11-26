import { expect } from 'chai';
import { rejects } from 'node:assert/strict';
import { ethers, network } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { implementationPlan } from '../scripts/deploy-vault-implementation';

describe('Deterministic implementation deployment', () => {
  let factory: any, admin: any, user: any, code: string, target: string;
  const delay = 14 * 86400;
  beforeEach(async () => {
    [admin, user] = await ethers.getSigners();
    const verifier = await ethers.deployContract('MockIdentityVerifier');
    const policy = await ethers.deployContract('PviumP2IDPolicy', [admin.address, [await verifier.getAddress()]]);
    factory = await ethers.deployContract('PviumP2IdVaultFactory', [
      admin.address, ethers.id('pvium.vault.v1'), await policy.getAddress(), await verifier.getAddress(), 86400, 3600, 86400,
     ethers.ZeroAddress]);
    await factory.setAlpha(await (await ethers.getContractAt('IP2IDVerifier', await factory.defaultVerifier())).vkHash(), false); // this suite exercises the ordinary (post-alpha) paths
    code = (await (await ethers.getContractFactory('MockVaultV2')).getDeployTransaction(await factory.getAddress())).data;
    target = ethers.getCreate2Address(await factory.getAddress(),
      ethers.id('pvium.vault.implementation.v1'), ethers.keccak256(code));
  });

  it('predicts, deploys and proposes atomically, without registering before the delay', async () => {
    expect(await factory.implementationFor(ethers.keccak256(code))).to.equal(target);
    await expect(factory.deployVaultImplementation(code, false)).to.emit(factory, 'ImplementationDeployed')
      .withArgs(target, ethers.keccak256(code));
    expect(await ethers.provider.getCode(target)).not.to.equal('0x');
    expect(await (await ethers.getContractAt('P2IDVault', target)).factory()).to.equal(await factory.getAddress());
    expect(await factory.proposedImplementation()).to.equal(target);
    expect(await factory.isRegisteredImplementation(target)).to.equal(false);
    await expect(factory.registerImplementation()).to.be.revertedWithCustomError(factory, 'TimelockNotElapsed');
    await time.increase(delay);
    await factory.registerImplementation();
    expect(await factory.isRegisteredImplementation(target)).to.equal(true);
    expect(await factory.baseImplementation()).to.equal(await factory.initialImplementation());
  });

  it('changes the default only on activation and preserves existing vaults and address derivation', async () => {
    const oldId = ethers.id('old'), newId = ethers.id('new');
    const predicted = await factory.vaultFor(newId);
    const hash = await factory.initCodeHash();
    const initial = await factory.initialImplementation();
    await factory.deploy(oldId);
    await factory.deployVaultImplementation(code, true);
    expect(await factory.baseImplementation()).to.equal(initial);
    await time.increaseTo(await factory.proposedImplementationEta());
    await factory.registerImplementation();
    expect(await factory.baseImplementation()).to.equal(target);
    await factory.deploy(newId);
    expect(await factory.vaultFor(newId)).to.equal(predicted);
    expect(await factory.initCodeHash()).to.equal(hash);
    expect(await (await ethers.getContractAt('PviumP2IDVaultProxy', predicted)).implementation()).to.equal(target);
    const old = await ethers.getContractAt('PviumP2IDVaultProxy', await factory.vaultFor(oldId));
    expect(await old.implementation()).to.equal(initial);
    expect(await (await ethers.getContractAt('P2IDVault', predicted)).saltCommitment()).to.equal(newId);
    for (const address of [initial, target]) {
      await expect(factory.revokeImplementation(address)).to.be.revertedWithCustomError(factory, 'InvalidImplementation');
    }
    await factory.proposeDefaultImplementation(initial);
    await expect(factory.registerImplementation()).to.be.revertedWithCustomError(factory, 'TimelockNotElapsed');
    await time.increase(delay);
    await factory.registerImplementation();
    expect(await factory.baseImplementation()).to.equal(initial);
    await factory.revokeImplementation(target);
  });

  it('retries without resetting the ETA, and requires cancellation to change a deployment proposal', async () => {
    await factory.deployVaultImplementation(code, true);
    const eta = await factory.proposedImplementationEta();
    await time.increase(100);
    await factory.deployVaultImplementation(code, true);
    expect(await factory.proposedImplementationEta()).to.equal(eta);
    await expect(factory.deployVaultImplementation(code, false)).to.be.revertedWithCustomError(factory, 'ImplementationProposalPending');
    await factory.cancelImplementationProposal();
    expect(await factory.proposedImplementationMakeDefault()).to.equal(false);
    await factory.deployVaultImplementation(code, false);
    expect(await factory.proposedImplementationEta()).to.be.greaterThan(eta);
    await time.increase(delay);
    await factory.registerImplementation();
    await factory.deployVaultImplementation(code, false);
    expect(await factory.proposedImplementationEta()).to.equal(0);
    await factory.deployVaultImplementation(code, true);
    expect(await factory.proposedImplementationMakeDefault()).to.equal(true);
    await expect(factory.registerImplementation()).to.be.revertedWithCustomError(factory, 'TimelockNotElapsed');
  });

  it('rejects nonowners, empty code, failed creation and wrong factory binding', async () => {
    await expect(factory.connect(user).deployVaultImplementation(code, false)).to.be.revertedWithCustomError(factory, 'NotOwner');
    await expect(factory.connect(user).proposeDefaultImplementation(await factory.initialImplementation()))
      .to.be.revertedWithCustomError(factory, 'NotOwner');
    for (const invalid of ['0x', '0x60006000fd', '0x60006000f3',
      (await (await ethers.getContractFactory('P2IDVault')).getDeployTransaction(user.address)).data]) {
      await expect(factory.deployVaultImplementation(invalid, false)).to.be.revertedWithCustomError(factory, 'InvalidImplementation');
      expect(await ethers.provider.getCode(await factory.implementationFor(ethers.keccak256(invalid)))).to.equal('0x');
    }
    expect(await factory.proposedImplementationEta()).to.equal(0);
  });

  it('clears the default flag when replaced by a manual proposal and checks code again on activation', async () => {
    await factory.deployVaultImplementation(code, true);
    const other = await ethers.deployContract('P2IDVault', [await factory.getAddress()]);
    await factory.proposeImplementation(await other.getAddress());
    expect(await factory.proposedImplementationMakeDefault()).to.equal(false);
    await time.increase(delay);
    await network.provider.send('hardhat_setCode', [await other.getAddress(), '0x']);
    await expect(factory.registerImplementation()).to.be.revertedWithCustomError(factory, 'InvalidImplementation');
    expect(await factory.proposedImplementation()).to.equal(await other.getAddress());
  });

  it('builds script calldata from the checked artifact with default=false', async () => {
    const plan = await implementationPlan(await factory.getAddress(), 'MockVaultV2');
    expect(plan.implementation).to.equal(target);
    expect(plan.makeDefault).to.equal(false);
    await admin.sendTransaction({ to: plan.to, data: plan.data });
    expect(await factory.proposedImplementation()).to.equal(target);
    expect(await factory.proposedImplementationMakeDefault()).to.equal(false);
    await rejects(implementationPlan(await factory.getAddress(), 'MockIdentityVerifier'), /missing|slot/);
  });
});
