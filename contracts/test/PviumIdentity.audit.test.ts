import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { readFileSync } from 'fs';
import { join } from 'path';
import { deployVerifier } from './helpers/deployVerifier';

const DAY = 86400;
const GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
const GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

async function fixture() {
  const [admin, payer] = await ethers.getSigners();
  const { verifier } = await deployVerifier();
  const proof = readFileSync(join(__dirname, 'fixtures/email.proof'));
  const raw = readFileSync(join(__dirname, 'fixtures/email.public_inputs'));
  const inputs = Array.from({ length: raw.length / 32 }, (_, i) =>
    ethers.hexlify(raw.subarray(i * 32, (i + 1) * 32)));
  const merge = (i: number) => (BigInt(inputs[i]) << 128n) | BigInt(inputs[i + 1]);
  const x = merge(2), y = merge(4);
  const gate = await ethers.deployContract('PviumIdentity', [
    await verifier.getAddress(), 1, ethers.id('test.vk'), admin.address, [x, GX], [y, GY],
  ]);
  return { admin, payer, verifier, proof, inputs, x, y, gate, identity: ethers.toBeHex(merge(7), 32) };
}

// Audit findings on signer revocation, and the behaviour that resolves them.
describe('PviumIdentity audit: signer revocation', function () {
  it('the sole remaining signer can be revoked: a freeze, until a replacement proposal matures', async () => {
    const { gate, proof, inputs, x, y } = await loadFixture(fixture);
    await gate.removeSignerKey(GX, GY);
    expect(await gate.keySetRevision()).to.equal(1n);
    await expect(gate.removeSignerKey(x, y)).to.emit(gate, 'SignerKeyRemoved').withArgs(x, y);
    expect(await gate.signerKeyCount()).to.equal(0n);
    expect(await gate.keySetRevision()).to.equal(2n);
    await expect(gate.verifyAttestation(proof, inputs)).to.be.revertedWithCustomError(gate, 'UnknownSigner');
    await gate.proposeSignerKey(x, y, 'https://example.invalid/jwks', 'replacement');
    await time.increase(7 * DAY);
    await gate.activateSignerKey(x, y);
    expect((await gate.verifyAttestation(proof, inputs)).identityHash).to.not.equal(ethers.ZeroHash);
    expect(await gate.keySetRevision()).to.equal(2n); // adding a key revokes nothing
  });

  it('revoking a signer also voids the wallet a vault cached from its proofs; re-proving restores it', async () => {
    const { admin, payer, gate, proof, inputs, x, y, identity } = await loadFixture(fixture);
    const adapter = await ethers.deployContract('PviumVerifier', [await gate.getAddress(), admin.address, []]);
    const v = await adapter.getAddress();
    const policy = await ethers.deployContract('PviumP2IDPolicy', [admin.address, [v]]);
    const factory = await ethers.deployContract('PviumP2IdVaultFactory', [
      admin.address, ethers.id('audit.revocation'), await policy.getAddress(), v, DAY, DAY, 90 * DAY,
     ethers.ZeroAddress]);
    await factory.setAlpha(await (await ethers.getContractAt('IP2IDVerifier', await factory.defaultVerifier())).vkHash(), false); // this suite exercises the ordinary (post-alpha) paths
    await factory.deploy(identity);
    const vault = await ethers.getContractAt('P2IDVault', await factory.vaultFor(identity));
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(['bytes', 'bytes32[]'], [proof, inputs]);
    await vault.refreshProof(v, encoded);
    const wallet = await vault.owner(v);
    expect(await vault.ownerRevision(v)).to.equal(0n);

    await gate.removeSignerKey(x, y);
    expect(await adapter.revision()).to.equal(1n);
    await expect(gate.verifyAttestation(proof, inputs)).to.be.revertedWithCustomError(gate, 'UnknownSigner');
    await expect(vault.refreshProof(v, encoded)).to.be.revertedWithCustomError(gate, 'UnknownSigner');

    // Nothing is paid to the cached wallet any more: neither deposits nor direct transfers.
    const token = await ethers.deployContract('MockERC20');
    const t = await token.getAddress();
    await token.mint(payer.address, 100n);
    await token.connect(payer).approve(await vault.getAddress(), 100n);
    await vault.connect(payer).fund(t, 100n, ethers.ZeroHash, DAY, ethers.ZeroHash);
    await expect(vault.sweep(v, t, 0)).to.be.revertedWithCustomError(vault, 'OwnerRevoked');
    await expect(vault.sweepDeposits(v, t, [0])).to.be.revertedWithCustomError(vault, 'OwnerRevoked');
    await token.mint(await vault.getAddress(), 50n);
    await expect(vault.sweepUntracked(t)).to.be.revertedWithCustomError(vault, 'OwnerRevoked');
    expect(await token.balanceOf(wallet)).to.equal(0n);

    // The key is trusted again after the notice period; the latest proof (same iat) re-establishes
    // the owner: the void cache pays nobody, but older proofs stay retired.
    await gate.proposeSignerKey(x, y, 'https://example.invalid/jwks', 'restored');
    await time.increase(7 * DAY);
    await gate.activateSignerKey(x, y);
    await expect(vault.refreshProof(v, encoded)).to.emit(vault, 'OwnerRefreshed');
    expect(await vault.ownerRevision(v)).to.equal(1n);
    await vault.sweep(v, t, 0);
    expect(await token.balanceOf(wallet)).to.equal(150n);
  });
});

describe('PviumZKVerifier audit: adversarial encodings', function () {
  this.timeout(180_000);

  it('binds every public input and rejects field-modulus aliases', async () => {
    const { verifier, proof, inputs } = await loadFixture(fixture);
    for (let i = 0; i < inputs.length; i++) {
      const changed = [...inputs];
      changed[i] = ethers.toBeHex(BigInt(inputs[i]) ^ 1n, 32);
      await expect(verifier.verify(proof, changed), `changed public input ${i}`).to.be.reverted;
      changed[i] = ethers.toBeHex(BigInt(inputs[i]) + P, 32);
      await expect(verifier.verify(proof, changed), `noncanonical public input ${i}`).to.be.reverted;
    }
  });

  it('rejects high bits discarded by the wrapper casts and hash-coordinate joins', async () => {
    const { gate, proof, inputs } = await loadFixture(fixture);
    for (const [i, width] of [[0, 8], [1, 160], [6, 64], [2, 128], [4, 128], [7, 128], [9, 128]]) {
      const changed = [...inputs];
      changed[i] = ethers.toBeHex(BigInt(inputs[i]) + (1n << BigInt(width)), 32);
      await expect(gate.verifyAttestation(proof, changed), `truncated public input ${i}`).to.be.reverted;
    }
  });

  it('rejects out-of-range pairing limbs, point coordinates and proof scalars', async () => {
    const { verifier, proof, inputs } = await loadFixture(fixture);
    // Layout: 8 pairing limbs, 10 G1 commitments, then the Libra sum scalar.
    for (const [word, value] of [[0, 1n << 136n], [1, 1n << 120n], [8, Q], [28, P]] as const) {
      const changed = Buffer.from(proof);
      Buffer.from(ethers.getBytes(ethers.toBeHex(value, 32))).copy(changed, word * 32);
      await expect(verifier.verify(changed, inputs), `out-of-range proof word ${word}`).to.be.reverted;
    }
    await expect(verifier.verify(Buffer.alloc(proof.length), inputs)).to.be.reverted;
  });

  it('rejects a one-bit mutation in every serialized proof word', async () => {
    const { verifier, proof, inputs } = await loadFixture(fixture);
    for (let offset = 0; offset < proof.length; offset += 32) {
      const changed = Buffer.from(proof);
      changed[offset + 31] ^= 1;
      await expect(verifier.verify(changed, inputs), `proof word ${offset / 32}`).to.be.reverted;
    }
    console.log(`      rejected ${proof.length / 32} individual proof-word mutations`);
  });
});

// Synthetic proofs isolate revision/freshness transitions; these are not ZK-forgery tests.
describe('Signer revision recovery: follow-up audit', function () {
  async function revisionFixture() {
    const [admin, payer, oldWallet, newWallet] = await ethers.getSigners();
    const verifier = await ethers.deployContract('MockIdentityVerifier');
    const v = await verifier.getAddress();
    const policy = await ethers.deployContract('PviumP2IDPolicy', [admin.address, [v]]);
    const factory = await ethers.deployContract('PviumP2IdVaultFactory', [
      admin.address, ethers.id('audit.revision'), await policy.getAddress(), v, DAY, DAY, 90 * DAY,
     ethers.ZeroAddress]);
    await factory.setAlpha(await (await ethers.getContractAt('IP2IDVerifier', await factory.defaultVerifier())).vkHash(), false); // this suite exercises the ordinary (post-alpha) paths
    const identity = ethers.id('revision-recipient');
    await factory.deploy(identity);
    const vault = await ethers.getContractAt('P2IDVault', await factory.vaultFor(identity));
    const token = await ethers.deployContract('MockERC20');
    const proof = (wallet: string, iat: number) => ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'bytes32', 'uint64'], [wallet, identity, iat],
    );
    return { payer, oldWallet, newWallet, verifier, v, vault, token, proof };
  }

  it('an unrelated signer removal does not let a previously superseded wallet proof replay', async () => {
    const { payer, oldWallet, newWallet, verifier, v, vault, token, proof } = await loadFixture(revisionFixture);
    await vault.refreshProof(v, proof(oldWallet.address, 1000));
    await vault.refreshProof(v, proof(newWallet.address, 2000));
    await expect(vault.refreshProof(v, proof(oldWallet.address, 1000)))
      .to.be.revertedWithCustomError(vault, 'ProofTooOld');
    await token.mint(payer.address, 100n);
    await token.connect(payer).approve(await vault.getAddress(), 100n);
    await vault.connect(payer).fund(await token.getAddress(), 100n, ethers.ZeroHash, DAY, ethers.ZeroHash);

    // Both historical attestations stay cryptographically valid under signer A; removing signer B
    // bumps the revision, which voids the cached owner but keeps the freshness ratchet.
    await verifier.setRevision(1);
    await expect(vault.connect(oldWallet).refreshProof(v, proof(oldWallet.address, 1000)))
      .to.be.revertedWithCustomError(vault, 'ProofTooOld');
    await expect(vault.sweep(v, await token.getAddress(), 0)).to.be.revertedWithCustomError(vault, 'OwnerRevoked');
    await vault.refreshProof(v, proof(newWallet.address, 2000)); // the latest proof re-establishes its owner
    await vault.sweep(v, await token.getAddress(), 0);
    expect(await token.balanceOf(oldWallet.address)).to.equal(0n);
    expect(await token.balanceOf(newWallet.address)).to.equal(100n);
    expect(await vault.latestProofIat(v)).to.equal(2000n);
  });

  it('a forged issue time can hold the freshness floor at most 15 minutes ahead of the chain', async () => {
    const { oldWallet, newWallet, verifier, v, vault, token, proof } = await loadFixture(revisionFixture);
    const now = await time.latest();
    await expect(vault.refreshProof(v, proof(oldWallet.address, now + 16 * 60)))
      .to.be.revertedWithCustomError(vault, 'ProofFromFuture');
    const future = now + 14 * 60; // the most a forged token can claim
    await vault.refreshProof(v, proof(oldWallet.address, future));
    await verifier.setRevision(1); // revoke the compromised source of the future timestamp
    await token.mint(await vault.getAddress(), 100n);
    await expect(vault.sweepUntracked(await token.getAddress())).to.be.revertedWithCustomError(vault, 'OwnerRevoked');
    // The honest owner's next token is held to the forged floor, for at most the slack.
    await expect(vault.refreshProof(v, proof(newWallet.address, await time.latest())))
      .to.be.revertedWithCustomError(vault, 'ProofTooOld');
    await time.increaseTo(future + 1); // a different wallet needs a strictly newer proof
    await vault.refreshProof(v, proof(newWallet.address, await time.latest()));
    expect(await vault.owner(v)).to.equal(newWallet.address);
    await vault.sweepUntracked(await token.getAddress());
    expect(await token.balanceOf(newWallet.address)).to.equal(100n);
  });

  it('after an unrelated revision change, an equal-time proof re-validates only the recorded wallet', async () => {
    const { payer, oldWallet, newWallet, verifier, v, vault, token, proof } = await loadFixture(revisionFixture);
    await vault.refreshProof(v, proof(newWallet.address, 2000));
    await vault.refreshProof(v, proof(oldWallet.address, 2000));
    expect(await vault.owner(v)).to.equal(newWallet.address); // equal time preserves the owner

    await token.mint(payer.address, 100n);
    await token.connect(payer).approve(await vault.getAddress(), 100n);
    await vault.connect(payer).fund(await token.getAddress(), 100n, ethers.ZeroHash, DAY, ethers.ZeroHash);
    await token.mint(await vault.getAddress(), 50n);

    // A still-accepted signer authenticated both wallets at the same second; another key is removed.
    await verifier.setRevision(1);
    await vault.connect(oldWallet).refreshProof(v, proof(oldWallet.address, 2000)); // verified, but not the owner
    expect(await vault.owner(v)).to.equal(newWallet.address);
    await expect(vault.connect(oldWallet).sweep(v, await token.getAddress(), 0)).to.be.revertedWithCustomError(vault, 'OwnerRevoked');
    await expect(vault.connect(oldWallet).refreshProofAndSweep(v, proof(oldWallet.address, 2000), await token.getAddress(), 0))
      .to.be.revertedWithCustomError(vault, 'OwnerRevoked');
    await vault.refreshProof(v, proof(newWallet.address, 2000)); // the recorded wallet re-validates with the same proof
    await vault.sweep(v, await token.getAddress(), 0);
    expect(await token.balanceOf(newWallet.address)).to.equal(150n);
    expect(await token.balanceOf(oldWallet.address)).to.equal(0n);
  });

  it('refreshProofAndSweep pays nobody while the cached wallet is void, whoever presents the proof', async () => {
    const { payer, oldWallet, newWallet, verifier, v, vault, token, proof } = await loadFixture(revisionFixture);
    await vault.refreshProof(v, proof(oldWallet.address, 2000));
    await token.mint(payer.address, 100n);
    await token.connect(payer).approve(await vault.getAddress(), 100n);
    await vault.connect(payer).fund(await token.getAddress(), 100n, ethers.ZeroHash, DAY, ethers.ZeroHash);
    await verifier.setRevision(1);
    await expect(vault.sweep(v, await token.getAddress(), 0))
      .to.be.revertedWithCustomError(vault, 'OwnerRevoked');

    // An equal-time proof for another wallet verifies but does not restore the void cache, so the
    // combined entry point has no owner to pay either.
    await expect(vault.refreshProofAndSweep(v, proof(newWallet.address, 2000), await token.getAddress(), 0))
      .to.be.revertedWithCustomError(vault, 'OwnerRevoked');
    expect(await vault.ownerRevision(v)).to.equal(0n);
    expect(await token.balanceOf(oldWallet.address)).to.equal(0n);
    // A newer proof moves the owner and is paid in the same call.
    await vault.refreshProofAndSweep(v, proof(newWallet.address, 2001), await token.getAddress(), 0);
    expect(await vault.ownerRevision(v)).to.equal(1n);
    expect(await token.balanceOf(newWallet.address)).to.equal(100n);
    expect(await token.balanceOf(oldWallet.address)).to.equal(0n);
  });
});
