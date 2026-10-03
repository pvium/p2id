import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import { time, setBalance } from '@nomicfoundation/hardhat-network-helpers';
import { createPublicKey } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { deployIdentityProof, deployVerifier } from './helpers/deployVerifier';

describe('PviumP2IDVaultProxy real-proof upgrade cost and atomicity', function () {
  this.timeout(120_000);

  it('verifies once, applies the result atomically, and an under-gassed upgrade changes nothing', async () => {
    const fixtures = join(__dirname, 'fixtures');
    const raw = readFileSync(join(fixtures, 'email.public_inputs'));
    const words: string[] = [];
    for (let i = 0; i < raw.length; i += 32) words.push(ethers.hexlify(raw.subarray(i, i + 32)));
    const id = ethers.toBeHex((BigInt(words[7]) << 128n) | BigInt(words[8]), 32);
    const wallet = ethers.getAddress(ethers.toBeHex(BigInt(words[1]), 20));
    const proof = ethers.AbiCoder.defaultAbiCoder().encode(['bytes', 'bytes32[]'],
      [readFileSync(join(fixtures, 'email.proof')), words]);
    const jwk = createPublicKey(readFileSync(join(fixtures, 'privy_es256_public.pem'))).export({ format: 'jwk' });
    const x = BigInt(ethers.hexlify(Buffer.from(jwk.x!, 'base64url')));
    const y = BigInt(ethers.hexlify(Buffer.from(jwk.y!, 'base64url')));
    const honk = await deployVerifier();
    const identity = await deployIdentityProof(await honk.verifier.getAddress(), x, y);
    const [admin] = await ethers.getSigners();
    const verifier = await ethers.deployContract('PviumVerifier', [await identity.getAddress(), admin.address, []]);
    const V = await verifier.getAddress();
    const policy = await ethers.deployContract('MockFeePolicy');
    await policy.allow(V, true);
    const DAY = 86400;
    const factory = await ethers.deployContract('PviumP2IdVaultFactory', [admin.address,
      ethers.id('pvium.vault.v1'), await policy.getAddress(), V, 7 * DAY, DAY, 30 * DAY, ethers.ZeroAddress]);
    await factory.setAlpha(await (await ethers.getContractAt('IP2IDVerifier', await factory.defaultVerifier())).vkHash(), false); // this suite exercises the ordinary (post-alpha) paths
    await factory.deploy(id);
    const address = await factory.vaultFor(id);
    const vault = await ethers.getContractAt('P2IDVault', address);
    const proxy = await ethers.getContractAt('PviumP2IDVaultProxy', address);
    const v2 = await ethers.deployContract('MockVaultV2', [await factory.getAddress()]);
    const target = await v2.getAddress();
    await factory.proposeImplementation(target);
    await time.increase(14 * DAY);
    await factory.registerImplementation();
    await setBalance(wallet, ethers.parseEther('100'));
    const signer = await ethers.getImpersonatedSigner(wallet);
    try {
      let snapshot = await network.provider.send('evm_snapshot');
      const refresh = await (await vault.refreshProof(V, proof, { gasLimit: 6_000_000 })).wait();
      await network.provider.send('evm_revert', [snapshot]);
      snapshot = await network.provider.send('evm_snapshot');
      const upgrade = await proxy.connect(signer).upgradeTo(id, target, proof, { gasLimit: 12_000_000 });
      await expect(upgrade).to.emit(proxy, 'Upgraded').withArgs(target)
        .and.to.emit(vault, 'OwnerRefreshed').withArgs(V, wallet, BigInt(words[6]));
      const full = await upgrade.wait();
      expect(await vault.owner(V)).to.equal(wallet);
      expect(await proxy.lastUpgrade()).to.deep.equal([wallet, BigInt(words[6])]);
      expect(full!.gasUsed).to.be.lessThan(refresh!.gasUsed * 13n / 10n); // one proof verification, not two
      console.log(`      single refresh gas: ${refresh!.gasUsed}; upgrade gas: ${full!.gasUsed}`);
      await network.provider.send('evm_revert', [snapshot]);
      await expect(proxy.connect(signer).upgradeTo(id, target, proof, { gasLimit: 3_000_000 })).to.be.reverted;
      expect(await proxy.implementation()).to.equal(await factory.baseImplementation());
      expect(await proxy.lastUpgrade()).to.deep.equal([ethers.ZeroAddress, 0n]);
      expect(await vault.owner(V)).to.equal(ethers.ZeroAddress);
    } finally {
      await network.provider.send('hardhat_stopImpersonatingAccount', [wallet]);
    }
  });
});
