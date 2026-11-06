import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';

const DAY = 86400;
const ID = ethers.id('reference-recipient');
const REF = ethers.id('invoice-42');
const Z = ethers.ZeroHash;

async function fixture() {
  const [admin, payer, recipient] = await ethers.getSigners();
  // A reference must work without requiring constraint support from the verifier.
  const verifier = await ethers.deployContract('MockNoConstraintVerifier');
  const alternate = await ethers.deployContract('MockNoConstraintVerifier');
  const policy = await ethers.deployContract('PviumP2IDPolicy', [
    admin.address, [await verifier.getAddress(), await alternate.getAddress()],
  ]);
  const factory = await ethers.deployContract('PviumP2IdVaultFactory', [
    admin.address, ethers.id('pvium.vault.v1'), await policy.getAddress(),
    await verifier.getAddress(), 7 * DAY, DAY, 30 * DAY,
   ethers.ZeroAddress]);
  await factory.setAlpha(await (await ethers.getContractAt('IP2IDVerifier', await factory.defaultVerifier())).vkHash(), false); // this suite exercises the ordinary (post-alpha) paths
  const vault = await ethers.getContractAt('P2IDVault', await factory.vaultFor(ID));
  const token = await ethers.deployContract('MockERC20');
  return { payer, recipient, verifier, alternate, factory, vault, token };
}

describe('Funding references', function () {
  for (const entry of ['vault', 'factory'] as const) {
    for (const method of ['fund', 'fundWith'] as const) {
      for (const asset of ['native', 'ERC-20'] as const) {
        it(`${entry}.${method} forwards ${asset} references without changing refunds or claims`, async () => {
          const { payer, recipient, verifier, alternate, factory, vault, token } = await loadFixture(fixture);
          const selectedVerifier = await (method === 'fundWith' ? alternate : verifier).getAddress();
          const tokenAddress = asset === 'native' ? ethers.ZeroAddress : await token.getAddress();
          const target = entry === 'factory' ? factory : vault;
          if (entry === 'vault') await factory.deploy(ID);
          if (asset === 'ERC-20') {
            await token.mint(payer.address, 200n);
            await token.connect(payer).approve(await target.getAddress(), 200n);
          }

          const args: (string | bigint | number)[] = [];
          if (entry === 'factory') args.push(ID);
          if (method === 'fundWith') args.push(selectedVerifier);
          args.push(tokenAddress, 100n, Z, DAY, REF);

          // Reusing a ref is allowed: it is neither a constraint nor an idempotency key.
          for (const depositId of [0, 1]) {
            const tx = await (target.connect(payer) as any)[method](
              ...args, { value: asset === 'native' ? 100n : 0n },
            );
            await expect(tx).to.emit(vault, 'Funded').withArgs(
              depositId, payer.address, tokenAddress, 100n, selectedVerifier, Z, DAY, 0, REF,
            );
            const deposit = await vault.deposits(depositId);
            expect(deposit.funder).to.equal(payer.address);
            expect(deposit.verifier).to.equal(selectedVerifier);
            expect(deposit.constraint).to.equal(Z);
          }
          expect(await vault.constraintDeposit(REF, payer.address)).to.deep.equal([false, 0n]);

          await time.increase(DAY + 1);
          const refund = () => vault.connect(payer).refund(0);
          if (asset === 'native') {
            await expect(refund).to.changeEtherBalances([vault, payer], [-100n, 100n]);
          } else {
            await expect(refund).to.changeTokenBalances(token, [vault, payer], [-100n, 100n]);
          }

          // The remaining deposit is still claimable after the refund window, with no ref evidence.
          const proof = ethers.AbiCoder.defaultAbiCoder().encode(
            ['address', 'bytes32', 'uint64'], [recipient.address, ID, 1000],
          );
          const claim = () => vault.refreshProofAndSweep(selectedVerifier, proof, tokenAddress, 0);
          if (asset === 'native') {
            await expect(claim).to.changeEtherBalances([vault, recipient], [-100n, 100n]);
          } else {
            await expect(claim).to.changeTokenBalances(token, [vault, recipient], [-100n, 100n]);
          }
          expect(await vault.trackedTotal(tokenAddress)).to.equal(0n);
        });
      }
    }
  }
});
