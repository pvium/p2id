import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';

describe('P2IDVault fee approval audit reproductions', function () {
  async function setup() {
    const [admin, payer, wallet, treasury] = await ethers.getSigners();
    const identity = ethers.id('fee-approval-audit');
    const verifier = await ethers.deployContract('MockIdentityVerifier');
    const policy = await ethers.deployContract('MockAuditDeferredFeePolicy');
    const token = await ethers.deployContract('MockAuditFeeApprovalToken');
    const v = await verifier.getAddress();
    await policy.allow(v, true);
    await policy.setFee(100, treasury.address);
    const factory = await ethers.deployContract('PviumP2IdVaultFactory', [admin.address,
      ethers.id('audit'), await policy.getAddress(), v, 86400, 86400, 86400, ethers.ZeroAddress]);
    await factory.setAlpha(await verifier.vkHash(), false);
    await factory.deploy(identity);
    const vault = await ethers.getContractAt('P2IDVault', await factory.vaultFor(identity));
    await token.mint(payer.address, 20000n);
    await token.connect(payer).approve(await vault.getAddress(), 20000n);
    for (let i = 0; i < 2; i++) {
      await vault.connect(payer).fund(await token.getAddress(), 10000n, ethers.ZeroHash, 86400, ethers.ZeroHash);
    }
    const proof = ethers.AbiCoder.defaultAbiCoder().encode(['address', 'bytes32', 'uint64'],
      [wallet.address, identity, 1000]);
    await vault.refreshProof(v, proof);
    return { payer, wallet, treasury, policy, token, vault, v };
  }

  // Regressions for the audit findings on the former approve/pull hand-off. The vault now moves the
  // fee and announces it in one atomic self-call and never grants an allowance, so a token whose
  // approve misbehaves cannot expose other deposits or block a claim.
  it('no allowance is ever granted: a policy cannot spend other deposits later, even with a token whose zero-approve fails', async () => {
    const { payer, wallet, treasury, policy, token, vault, v } = await setup();
    await token.setMode(1);
    await vault.sweepDeposits(v, await token.getAddress(), [0]);
    expect(await token.balanceOf(wallet.address)).to.equal(9900n);
    expect(await token.balanceOf(treasury.address)).to.equal(100n);
    expect(await token.allowance(await vault.getAddress(), await policy.getAddress())).to.equal(0n);
    await expect(policy.pullLater(await token.getAddress(), await vault.getAddress(), treasury.address, 1n)).to.be.reverted;
    expect(await token.balanceOf(await vault.getAddress())).to.equal(10000n);
    expect(await vault.trackedTotal(await token.getAddress())).to.equal(10000n);
    await time.increase(86401);
    await vault.connect(payer).refund(1);
    expect(await token.balanceOf(payer.address)).to.equal(10000n);
  });

  it('a malformed approve response is irrelevant: approve is never called and the claim pays the fee', async () => {
    const { wallet, treasury, token, vault, v } = await setup();
    await token.setMode(2);
    await vault.sweepDeposits(v, await token.getAddress(), [0]);
    expect((await vault.deposits(0)).consumed).to.equal(true);
    expect(await token.balanceOf(wallet.address)).to.equal(9900n);
    expect(await token.balanceOf(treasury.address)).to.equal(100n);
  });

  it('a policy that reverts receives nothing: the transfer is undone with the call', async () => {
    const { wallet, treasury, policy, token, vault, v } = await setup();
    await policy.setMode(5);
    await vault.sweepDeposits(v, await token.getAddress(), [0]);
    expect(await token.balanceOf(wallet.address)).to.equal(10000n);
    expect(await token.balanceOf(treasury.address)).to.equal(0n);
    expect(await token.balanceOf(await policy.getAddress())).to.equal(0n);
  });
});
