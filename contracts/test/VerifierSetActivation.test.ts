import { expect } from 'chai';
import { ethers } from 'hardhat';
import { impersonateAccount, setBalance, stopImpersonatingAccount, time } from '@nomicfoundation/hardhat-network-helpers';
import { createPublicKey } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CURRENT_SCHEME, deployStack, deployVerifierSet, type StackParams } from '../scripts/lib/deterministic';
import { ownerTx, readStatus, type ActivationStep } from '../scripts/lib/verifierSet';

const DAY = 24 * 3600;

/**
 * A later circuit version's verifier set is deployed next to an existing stack (deploy-verifier.ts)
 * and activated by the owner step by step (verifier-activate.ts). Addresses of the factory and
 * policy never change; the recorded status follows the chain.
 */
describe('verifier set for a later circuit version: deploy next to the stack, then activate', function () {
  this.timeout(120_000);

  it('deploys without touching the stack, and each owner step moves the status forward', async () => {
    const jwk = createPublicKey(readFileSync(join(__dirname, 'fixtures', 'privy_es256_public.pem'))).export({ format: 'jwk' });
    const key = { x: BigInt('0x' + Buffer.from(jwk.x!, 'base64url').toString('hex')), y: BigInt('0x' + Buffer.from(jwk.y!, 'base64url').toString('hex')) };
    const [deployer] = await ethers.getSigners();
    const owner = ethers.getAddress('0x00000000000000000000000000000000000a11ce'); // stands in for the Safe
    const p: StackParams = {
      owner, scheme: CURRENT_SCHEME, circuitVersion: 1, vkHash: ethers.id('circuit v1 vk'), signerKeys: [key],
      attester: '0x0000000000000000000000000000000000000A77', policyChangeDelay: 7 * DAY, minRefundWindow: DAY, maxRefundWindow: 90 * DAY,
    };
    const stack = await deployStack(p, deployer);
    const v2VkHash = ethers.id('circuit v2 vk');
    const set = await deployVerifierSet({ ...p, circuitVersion: 2, vkHash: v2VkHash }, deployer);

    // new identity + verifier; the stack's factory and policy are untouched
    expect(set.pviumVerifier).to.not.equal(stack.pviumVerifier);
    expect(set.pviumIdentity).to.not.equal(stack.pviumIdentity);
    const factory = await ethers.getContractAt('PviumP2IdVaultFactory', stack.factory);
    expect(await factory.defaultVerifier()).to.equal(stack.pviumVerifier);
    expect(await (await ethers.getContractAt('PviumIdentity', set.pviumIdentity)).circuitVersion()).to.equal(2n);
    // deterministic: deploying again is a no-op with the same addresses
    expect(await deployVerifierSet({ ...p, circuitVersion: 2, vkHash: v2VkHash }, deployer)).to.deep.equal(set);

    const record = { ...set, factory: stack.factory, policy: stack.policy, vkHash: v2VkHash, circuitVersion: 2 };
    let status = await readStatus(record);
    expect(status).to.include({ approved: false, alpha: true, isDefault: false, defaultProposedEta: null });

    // Steps that do not apply yet say why instead of producing a transaction.
    expect(await ownerTx(record, status, 'propose-default')).to.equal('approve it in the policy first');
    expect(await ownerTx(record, status, 'activate-default')).to.equal('not proposed as the default yet (propose-default)');

    // The owner (the Safe on production) sends each step's transaction exactly as the scripts print it.
    await impersonateAccount(owner);
    await setBalance(owner, ethers.parseEther('1'));
    const safe = await ethers.getSigner(owner);
    const send = async (step: ActivationStep) => {
      const tx = await ownerTx(record, status, step);
      expect(typeof tx, `${step}: ${tx}`).to.equal('object');
      if (typeof tx === 'string') return;
      await (await safe.sendTransaction({ to: tx.to, data: tx.data, value: 0 })).wait();
      status = await readStatus(record);
    };
    try {
      // a non-owner sending the same calldata is refused
      const approve = await ownerTx(record, status, 'approve');
      if (typeof approve === 'string') throw new Error(approve);
      await expect(deployer.sendTransaction({ to: approve.to, data: approve.data })).to.be.reverted;

      await send('approve');
      expect(status.approved).to.equal(true);
      expect(await ownerTx(record, status, 'approve')).to.equal('already approved in the policy');

      await send('release-alpha');
      expect(status.alpha).to.equal(false);

      await send('propose-default');
      expect(status.defaultProposedEta).to.be.a('number');
      expect(await ownerTx(record, status, 'activate-default')).to.match(/^notice runs until /);

      await time.increase(14 * DAY + 1);
      await send('activate-default');
      expect(status.isDefault).to.equal(true);
      expect(await factory.defaultVerifier()).to.equal(set.pviumVerifier);
      expect(await factory.policy()).to.equal(stack.policy); // still the same stack
    } finally {
      await stopImpersonatingAccount(owner);
    }
  });
});
