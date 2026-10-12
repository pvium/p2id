import { expect } from 'chai';
import { ethers } from 'hardhat';
import { readFileSync } from 'fs';
import { join } from 'path';
import { deployIdentityProof, deployVerifier } from './helpers/deployVerifier';
import { createPublicKey } from 'crypto';

const NS = ethers.id('p2id.email.v1');
const DAY = 24 * 3600;
const POLICY = ethers.id('kyc:basic;sanctions:ofac;v1');
const fixtures = join(__dirname, 'fixtures');
const EMAIL_COMMITMENT = '0xbcda0f09fa9732b2bfdea38199486b654a84e8e06085d7e364af8137f8d7deaf'; // identityHash('email','test-9988@privy.io')
const LINKED_WALLET = '0xA01b6E60D51eDB3fEB9f86a62b846f4F90070f98';

function proofBytes(name: string): string {
  const proof = readFileSync(join(fixtures, `${name}.proof`));
  const raw = readFileSync(join(fixtures, `${name}.public_inputs`));
  const words: string[] = [];
  for (let i = 0; i < raw.length; i += 32) words.push('0x' + raw.subarray(i, i + 32).toString('hex'));
  return ethers.AbiCoder.defaultAbiCoder().encode(['bytes', 'bytes32[]'], [proof, words]);
}

const NO_CONSTRAINT = { commitment: ethers.ZeroHash, signature: '0x' };
const constraintOf = (commitment: string, signature = '0x') => ({ commitment, signature });
/** Claim-time constraint signature: the commitment's preimage (signer, policyHash, salt) plus the EIP-712 signature. */
const chosen = (signer: string, policyHash: string, salt: string, sig: string) =>
  ethers.AbiCoder.defaultAbiCoder().encode(['address', 'bytes32', 'bytes32', 'bytes'], [signer, policyHash, salt, sig]);
const SALT1 = ethers.id('salt');
/** Registered-signer mode (signer address(0)) for the sample payee, POLICY and SALT1. */
const registered = (sig: string) => chosen(ethers.ZeroAddress, POLICY, SALT1, sig);

describe('PviumVerifier: real ZK proof + signed constraint commitment', function () {
  this.timeout(180_000);

  let pviumIdentity: any, verifier: any, verifierNoSigner: any, vault: any, token: any, factory: any;
  let payer: any, attester: any, stranger: any, admin: any;

  /** EIP-712 signature over Constraint(bytes32 commitment) in `v`'s domain. */
  async function signConstraint(signer: any, v: any, commitment: string, chainId?: bigint) {
    const domain = { name: 'PviumVerifier', version: '1', chainId: chainId ?? (await ethers.provider.getNetwork()).chainId, verifyingContract: await v.getAddress() };
    return signer.signTypedData(domain, { Constraint: [{ name: 'commitment', type: 'bytes32' }] }, { commitment });
  }

  before(async () => {
    [payer, attester, stranger, admin] = await ethers.getSigners();
    const honk = await (await deployVerifier()).verifier.getAddress();
    const jwk = createPublicKey(readFileSync(join(fixtures, 'privy_es256_public.pem'))).export({ format: 'jwk' });
    const x = BigInt('0x' + Buffer.from(jwk.x!, 'base64url').toString('hex'));
    const y = BigInt('0x' + Buffer.from(jwk.y!, 'base64url').toString('hex'));
    pviumIdentity = await deployIdentityProof(honk, x, y);
    verifier = await ethers.deployContract('PviumVerifier', [await pviumIdentity.getAddress(), admin.address, [attester.address]]);
    verifierNoSigner = await ethers.deployContract('PviumVerifier', [await pviumIdentity.getAddress(), ethers.ZeroAddress, []]);
  });

  beforeEach(async () => {
    token = await ethers.deployContract('MockERC20');
    const policy = await ethers.deployContract('PviumP2IDPolicy', [admin.address, [await verifier.getAddress(), await verifierNoSigner.getAddress()]]);
    factory = await ethers.deployContract('PviumP2IdVaultFactory', [admin.address, NS, await policy.getAddress(), await verifier.getAddress(), 7 * DAY, DAY, 30 * DAY, ethers.ZeroAddress]);
    await factory.connect(admin).setAlpha(await (await ethers.getContractAt('IP2IDVerifier', await factory.defaultVerifier())).vkHash(), false); // this suite exercises the ordinary (post-alpha) paths
    await factory.deploy(EMAIL_COMMITMENT);
    vault = await ethers.getContractAt('P2IDVault', await factory.vaultFor(EMAIL_COMMITMENT));
  });

  it('getIdentityWallet returns the wallet and iat for a valid proof of the expected identity', async () => {
    const [wallet, iat] = await verifier.getIdentityWallet(EMAIL_COMMITMENT, proofBytes('email'), NO_CONSTRAINT);
    expect(wallet).to.equal(LINKED_WALLET);
    expect(iat).to.equal(1789240094n);
  });

  it('a valid proof for a different identity reverts', async () => {
    await expect(verifier.getIdentityWallet(ethers.id('someone-else'), proofBytes('email'), NO_CONSTRAINT))
      .to.be.revertedWithCustomError(verifier, 'IdentityMismatch');
  });

  it('a tampered proof reverts rather than returning address(0)', async () => {
    const bad = ethers.getBytes(proofBytes('email'));
    bad[400] ^= 1;
    await expect(verifier.getIdentityWallet(EMAIL_COMMITMENT, ethers.hexlify(bad), NO_CONSTRAINT)).to.be.reverted;
  });

  it('claims a vault with a real proof and pays the wallet the proof resolves to', async () => {
    await token.mint(await vault.getAddress(), 250n);
    await expect(vault.refreshProofAndSweep(await verifier.getAddress(), proofBytes('email'), await token.getAddress(), 0))
      .to.emit(vault, 'OwnerRefreshed').withArgs(await verifier.getAddress(), LINKED_WALLET, 1789240094n);
    expect(await token.balanceOf(LINKED_WALLET)).to.equal(250n);
  });

  it('alpha requires an independent signature even for a real proof and bare token transfers', async () => {
    await factory.connect(admin).setDefaultAttester(attester.address);
    await factory.connect(admin).setAlpha(await (await ethers.getContractAt('IP2IDVerifier', await factory.defaultVerifier())).vkHash(), true);
    const proxy = await ethers.getContractAt('PviumP2IDVaultProxy', await vault.getAddress());
    const data = vault.interface.encodeFunctionData('refreshProofAndSweep', [await verifier.getAddress(), proofBytes('email'), await token.getAddress(), 0]);
    await token.mint(await vault.getAddress(), 250n);
    await expect(vault.refreshProofAndSweep(await verifier.getAddress(), proofBytes('email'), await token.getAddress(), 0))
      .to.be.revertedWithCustomError(vault, 'AlphaAuthorizationRequired');
    const deadline = (await ethers.provider.getBlock('latest'))!.timestamp + DAY;
    const domain = { name: 'PviumAlpha', version: '1', chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await factory.getAddress() };
    const types = { AlphaAuthorization: [
      { name: 'vault', type: 'address' }, { name: 'caller', type: 'address' },
      { name: 'callHash', type: 'bytes32' }, { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' }, { name: 'epoch', type: 'uint256' },
    ] };
    const nonce = BigInt(ethers.hexlify(ethers.randomBytes(32)));
    const signature = await attester.signTypedData(domain, types, {
      vault: await vault.getAddress(), caller: payer.address, callHash: ethers.keccak256(data),
      nonce, deadline, epoch: await factory.alphaEpoch(),
    });
    await vault.executeWithAttestation(data, { nonce, deadline, signature });
    expect(await token.balanceOf(LINKED_WALLET)).to.equal(250n);
  });

  it('the vault rejects a valid proof for a different identity', async () => {
    await factory.deploy(ethers.id('someone-else'));
    const otherVault = await ethers.getContractAt('P2IDVault', await factory.vaultFor(ethers.id('someone-else')));
    await expect(otherVault.refreshProof(await verifier.getAddress(), proofBytes('email'))).to.be.revertedWithCustomError(verifier, 'IdentityMismatch');
  });

  it('a constrained deposit needs the proof and the registered signer over the commitment', async () => {
    const commitment = await verifier.constraintCommitment(ethers.ZeroAddress, POLICY, EMAIL_COMMITMENT, SALT1);
    await token.mint(payer.address, 100n);
    await token.connect(payer).approve(await vault.getAddress(), 100n);
    await vault.connect(payer).fund(await token.getAddress(), 100n, commitment, DAY, ethers.ZeroHash);
    await vault.refreshProofAndSweep(await verifier.getAddress(), proofBytes('email'), await token.getAddress(), 0);
    expect(await token.balanceOf(LINKED_WALLET)).to.equal(0n); // protected

    // attester signs the commitment as EIP-712 typed data in this verifier's domain
    const good = await signConstraint(attester, verifier, commitment);
    const bad = await signConstraint(stranger, verifier, commitment);
    expect(ethers.recoverAddress(await verifier.constraintDigest(commitment), good)).to.equal(attester.address);
    await expect(vault.sweepBucket(await verifier.getAddress(), constraintOf(commitment, registered(bad)), await token.getAddress(), proofBytes('email'), 0))
      .to.be.revertedWithCustomError(verifier, 'InvalidConstraintSigner');
    await expect(vault.sweepBucket(await verifier.getAddress(), constraintOf(commitment), await token.getAddress(), proofBytes('email'), 0))
      .to.be.revertedWithCustomError(verifier, 'MalformedSignature');
    await expect(vault.sweepBucket(await verifier.getAddress(), constraintOf(commitment, good), await token.getAddress(), proofBytes('email'), 0))
      .to.be.revertedWithCustomError(verifier, 'MalformedSignature'); // a bare signature without the preimage
    await expect(vault.sweepBucket(await verifier.getAddress(), constraintOf(ethers.id('other-commitment'), registered(good)), await token.getAddress(), proofBytes('email'), 0))
      .to.be.revertedWithCustomError(verifier, 'ConstraintMismatch'); // the preimage is for a different commitment

    await vault.connect(stranger).sweepBucket(await verifier.getAddress(), constraintOf(commitment, registered(good)), await token.getAddress(), proofBytes('email'), 0);
    expect(await token.balanceOf(LINKED_WALLET)).to.equal(100n);
  });

  it('a constraint signature is bound to the chain and the verifier', async () => {
    const commitment = await verifier.constraintCommitment(ethers.ZeroAddress, POLICY, EMAIL_COMMITMENT, SALT1);
    const otherChain = await signConstraint(attester, verifier, commitment, 8453n);
    await expect(verifier.getIdentityWallet(EMAIL_COMMITMENT, proofBytes('email'), constraintOf(commitment, registered(otherChain))))
      .to.be.revertedWithCustomError(verifier, 'InvalidConstraintSigner');
    const otherVerifier = await ethers.deployContract('PviumVerifier', [await pviumIdentity.getAddress(), admin.address, [attester.address]]);
    const forOther = await signConstraint(attester, otherVerifier, commitment);
    await expect(verifier.getIdentityWallet(EMAIL_COMMITMENT, proofBytes('email'), constraintOf(commitment, registered(forOther))))
      .to.be.revertedWithCustomError(verifier, 'InvalidConstraintSigner');
    const personalSign = await attester.signMessage(ethers.getBytes(commitment)); // the old scheme
    await expect(verifier.getIdentityWallet(EMAIL_COMMITMENT, proofBytes('email'), constraintOf(commitment, registered(personalSign))))
      .to.be.revertedWithCustomError(verifier, 'InvalidConstraintSigner');
  });

  it('the owner manages the signer set; a signer can only release funds to the proven wallet', async () => {
    expect(await verifier.owner()).to.equal(admin.address);
    expect(await verifier.isConstraintSigner(attester.address)).to.equal(true);
    expect(await verifier.constraintSignerCount()).to.equal(1n);
    const commitment = await verifier.constraintCommitment(ethers.ZeroAddress, POLICY, EMAIL_COMMITMENT, SALT1);
    // a second signer, then the first is revoked
    await expect(verifier.connect(stranger).setConstraintSigner(stranger.address, true)).to.be.revertedWithCustomError(verifier, 'NotOwner');
    await expect(verifier.connect(admin).setConstraintSigner(stranger.address, true)).to.emit(verifier, 'ConstraintSignerSet').withArgs(stranger.address, true);
    await verifier.connect(admin).setConstraintSigner(attester.address, false);
    expect(await verifier.constraintSignerCount()).to.equal(1n);
    const byOld = await signConstraint(attester, verifier, commitment);
    await expect(verifier.getIdentityWallet(EMAIL_COMMITMENT, proofBytes('email'), constraintOf(commitment, registered(byOld))))
      .to.be.revertedWithCustomError(verifier, 'InvalidConstraintSigner');
    const byNew = await signConstraint(stranger, verifier, commitment);
    const [wallet] = await verifier.getIdentityWallet(EMAIL_COMMITMENT, proofBytes('email'), constraintOf(commitment, registered(byNew)));
    expect(wallet).to.equal(LINKED_WALLET); // whoever signs, the wallet comes from the proof
    // revoking the last signer leaves registered-signer commitments unclaimable until one is
    // added again; constraints stay supported, since a payer can always name its own signer
    await verifier.connect(admin).setConstraintSigner(stranger.address, false);
    expect(await verifier.supportsConstraints()).to.equal(true);
    await expect(verifier.getIdentityWallet(EMAIL_COMMITMENT, proofBytes('email'), constraintOf(commitment, registered(byNew))))
      .to.be.revertedWithCustomError(verifier, 'ConstraintsUnsupported');
    await expect(verifier.connect(admin).setConstraintSigner(ethers.ZeroAddress, true)).to.be.revertedWithCustomError(verifier, 'InvalidSigner');
    await verifier.connect(admin).setConstraintSigner(attester.address, true);
    const [again] = await verifier.getIdentityWallet(EMAIL_COMMITMENT, proofBytes('email'), constraintOf(commitment, registered(await signConstraint(attester, verifier, commitment))));
    expect(again).to.equal(LINKED_WALLET);
  });

  it('ownership moves in two steps, and address(0) as owner freezes the signer set', async () => {
    await verifier.connect(admin).transferOwnership(stranger.address);
    expect(await verifier.owner()).to.equal(admin.address); // not yet
    await expect(verifier.connect(admin).acceptOwnership()).to.be.revertedWithCustomError(verifier, 'NotPendingOwner');
    await expect(verifier.connect(stranger).acceptOwnership()).to.emit(verifier, 'OwnershipTransferred').withArgs(admin.address, stranger.address);
    await expect(verifier.connect(admin).setConstraintSigner(admin.address, true)).to.be.revertedWithCustomError(verifier, 'NotOwner');
    await verifier.connect(stranger).transferOwnership(admin.address);
    await verifier.connect(admin).acceptOwnership();

    const frozen = await ethers.deployContract('PviumVerifier', [await pviumIdentity.getAddress(), ethers.ZeroAddress, [attester.address]]);
    expect(await frozen.supportsConstraints()).to.equal(true);
    await expect(frozen.connect(admin).setConstraintSigner(stranger.address, true)).to.be.revertedWithCustomError(frozen, 'NotOwner');
    await expect(frozen.connect(stranger).acceptOwnership()).to.be.revertedWithCustomError(frozen, 'NotPendingOwner');
  });

  it('constraints are always supported: a verifier with no registered signer still takes payer-chosen-signer deposits', async () => {
    expect(await verifier.supportsConstraints()).to.equal(true);
    expect(await verifierNoSigner.supportsConstraints()).to.equal(true);
    await token.mint(payer.address, 10n);
    await token.connect(payer).approve(await vault.getAddress(), 10n);
    const commitment = await verifierNoSigner.constraintCommitment(stranger.address, POLICY, EMAIL_COMMITMENT, ethers.id('salt'));
    await vault.connect(payer).fundWith(await verifierNoSigner.getAddress(), await token.getAddress(), 10n, commitment, DAY, ethers.ZeroHash);
    const sig = await signConstraint(stranger, verifierNoSigner, commitment);
    await vault.sweepBucket(await verifierNoSigner.getAddress(), constraintOf(commitment, chosen(stranger.address, POLICY, ethers.id('salt'), sig)),
      await token.getAddress(), proofBytes('email'), 0);
    expect(await token.balanceOf(LINKED_WALLET)).to.equal(10n);
  });

  it('a verifier without a constraint signer refuses registered-signer constraints but still proves identity', async () => {
    const [wallet] = await verifierNoSigner.getIdentityWallet(EMAIL_COMMITMENT, proofBytes('email'), NO_CONSTRAINT);
    expect(wallet).to.equal(LINKED_WALLET);
    const c = await verifierNoSigner.constraintCommitment(ethers.ZeroAddress, POLICY, EMAIL_COMMITMENT, SALT1);
    await expect(verifierNoSigner.getIdentityWallet(EMAIL_COMMITMENT, proofBytes('email'), constraintOf(c, registered(await signConstraint(attester, verifierNoSigner, c)))))
      .to.be.revertedWithCustomError(verifierNoSigner, 'ConstraintsUnsupported');
  });

  describe('payer-chosen signer: the commitment names its signer', () => {
    const SALT = ethers.id('payment-42');
    async function fundConstrained(commitment: string, amount = 100n) {
      await token.mint(payer.address, amount);
      await token.connect(payer).approve(await vault.getAddress(), amount);
      await vault.connect(payer).fund(await token.getAddress(), amount, commitment, DAY, ethers.ZeroHash);
    }

    it('the commitment is keccak256(abi.encode("p2id.constraint.v1", signer, policyHash, identityHash, salt))', async () => {
      const expected = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
        ['string', 'address', 'bytes32', 'bytes32', 'bytes32'], ['p2id.constraint.v1', stranger.address, POLICY, EMAIL_COMMITMENT, SALT]));
      expect(await verifier.constraintCommitment(stranger.address, POLICY, EMAIL_COMMITMENT, SALT)).to.equal(expected);
      expect(await verifier.CONSTRAINT_DOMAIN()).to.equal('p2id.constraint.v1');
    });

    it('releases to the proven wallet with the chosen signer, who needs no registration', async () => {
      expect(await verifier.isConstraintSigner(stranger.address)).to.equal(false);
      const commitment = await verifier.constraintCommitment(stranger.address, POLICY, EMAIL_COMMITMENT, SALT);
      await fundConstrained(commitment);
      const sig = await signConstraint(stranger, verifier, commitment);
      await vault.connect(attester).sweepBucket(await verifier.getAddress(), constraintOf(commitment, chosen(stranger.address, POLICY, SALT, sig)),
        await token.getAddress(), proofBytes('email'), 0);
      expect(await token.balanceOf(LINKED_WALLET)).to.equal(100n);
    });

    it('no other signer can satisfy it: not a registered signer, not a different chosen signer', async () => {
      const commitment = await verifier.constraintCommitment(stranger.address, POLICY, EMAIL_COMMITMENT, SALT);
      // a registered signer's bare signature, and its signature presented as registered-signer mode:
      // the commitment names `stranger`, so the address(0) preimage cannot reproduce it
      const byRegistered = await signConstraint(attester, verifier, commitment);
      await expect(verifier.getIdentityWallet(EMAIL_COMMITMENT, proofBytes('email'), constraintOf(commitment, byRegistered)))
        .to.be.revertedWithCustomError(verifier, 'MalformedSignature');
      await expect(verifier.getIdentityWallet(EMAIL_COMMITMENT, proofBytes('email'), constraintOf(commitment, chosen(ethers.ZeroAddress, POLICY, SALT, byRegistered))))
        .to.be.revertedWithCustomError(verifier, 'ConstraintMismatch');
      // the registered signer claiming to be the chosen one: the preimage no longer matches
      const byAttester = await signConstraint(attester, verifier, commitment);
      await expect(verifier.getIdentityWallet(EMAIL_COMMITMENT, proofBytes('email'), constraintOf(commitment, chosen(attester.address, POLICY, SALT, byAttester))))
        .to.be.revertedWithCustomError(verifier, 'ConstraintMismatch');
      // the right preimage with someone else's signature
      await expect(verifier.getIdentityWallet(EMAIL_COMMITMENT, proofBytes('email'), constraintOf(commitment, chosen(stranger.address, POLICY, SALT, byAttester))))
        .to.be.revertedWithCustomError(verifier, 'InvalidConstraintSigner');
    });

    it('the commitment binds the payee, the policy and the salt', async () => {
      const otherPayee = await verifier.constraintCommitment(stranger.address, POLICY, ethers.id('someone-else'), SALT);
      const sig = await signConstraint(stranger, verifier, otherPayee);
      // the verifier recomputes with the vault's identityHash, so another payee's approval does not match
      await expect(verifier.getIdentityWallet(EMAIL_COMMITMENT, proofBytes('email'), constraintOf(otherPayee, chosen(stranger.address, POLICY, SALT, sig))))
        .to.be.revertedWithCustomError(verifier, 'ConstraintMismatch');
      const commitment = await verifier.constraintCommitment(stranger.address, POLICY, EMAIL_COMMITMENT, SALT);
      const good = await signConstraint(stranger, verifier, commitment);
      for (const [policy, salt] of [[ethers.id('other policy'), SALT], [POLICY, ethers.id('other salt')]]) {
        await expect(verifier.getIdentityWallet(EMAIL_COMMITMENT, proofBytes('email'), constraintOf(commitment, chosen(stranger.address, policy, salt, good))))
          .to.be.revertedWithCustomError(verifier, 'ConstraintMismatch');
      }
    });

    it('a contract signer approves through ERC-1271', async () => {
      const wallet1271 = await ethers.deployContract('MockERC1271Signer', [stranger.address]);
      const signerAddr = await wallet1271.getAddress();
      const commitment = await verifier.constraintCommitment(signerAddr, POLICY, EMAIL_COMMITMENT, SALT);
      const sig = await signConstraint(stranger, verifier, commitment); // the contract accepts its owner's signature
      const [wallet] = await verifier.getIdentityWallet(EMAIL_COMMITMENT, proofBytes('email'), constraintOf(commitment, chosen(signerAddr, POLICY, SALT, sig)));
      expect(wallet).to.equal(LINKED_WALLET);
      const byOther = await signConstraint(attester, verifier, commitment);
      await expect(verifier.getIdentityWallet(EMAIL_COMMITMENT, proofBytes('email'), constraintOf(commitment, chosen(signerAddr, POLICY, SALT, byOther))))
        .to.be.revertedWithCustomError(verifier, 'InvalidConstraintSigner');
    });

    it('a registered contract signer approves registered-signer constraints by naming itself (ERC-1271)', async () => {
      const safe = await ethers.deployContract('MockERC1271Signer', [stranger.address]);
      const safeAddr = await safe.getAddress();
      await verifier.connect(admin).setConstraintSigner(safeAddr, true);
      const commitment = await verifier.constraintCommitment(ethers.ZeroAddress, POLICY, EMAIL_COMMITMENT, SALT1);
      const approval = await signConstraint(stranger, verifier, commitment); // the contract accepts its owner's signature
      const named = (approver: string, sig: string) => ethers.AbiCoder.defaultAbiCoder().encode(['address', 'bytes'], [approver, sig]);
      const [wallet] = await verifier.getIdentityWallet(EMAIL_COMMITMENT, proofBytes('email'), constraintOf(commitment, registered(named(safeAddr, approval))));
      expect(wallet).to.equal(LINKED_WALLET);
      // the same approval naming a contract that is not registered, or a registered one that did not approve
      const unregistered = await ethers.deployContract('MockERC1271Signer', [stranger.address]);
      await expect(verifier.getIdentityWallet(EMAIL_COMMITMENT, proofBytes('email'), constraintOf(commitment, registered(named(await unregistered.getAddress(), approval)))))
        .to.be.revertedWithCustomError(verifier, 'InvalidConstraintSigner');
      await expect(verifier.getIdentityWallet(EMAIL_COMMITMENT, proofBytes('email'), constraintOf(commitment, registered(named(safeAddr, await signConstraint(payer, verifier, commitment))))))
        .to.be.revertedWithCustomError(verifier, 'InvalidConstraintSigner');
      // an EOA signer may also name itself
      const [w2] = await verifier.getIdentityWallet(EMAIL_COMMITMENT, proofBytes('email'),
        constraintOf(commitment, registered(named(attester.address, await signConstraint(attester, verifier, commitment)))));
      expect(w2).to.equal(LINKED_WALLET);
      // once revoked, it can no longer approve
      await verifier.connect(admin).setConstraintSigner(safeAddr, false);
      await expect(verifier.getIdentityWallet(EMAIL_COMMITMENT, proofBytes('email'), constraintOf(commitment, registered(named(safeAddr, approval)))))
        .to.be.revertedWithCustomError(verifier, 'InvalidConstraintSigner');
    });

    it('one approval covers every deposit funded with the same commitment: uniqueness is the payer\'s salt', async () => {
      const commitment = await verifier.constraintCommitment(stranger.address, POLICY, EMAIL_COMMITMENT, SALT);
      for (const funder of [payer, attester]) {
        await token.mint(funder.address, 50n);
        await token.connect(funder).approve(await vault.getAddress(), 50n);
        await vault.connect(funder).fund(await token.getAddress(), 50n, commitment, DAY, ethers.ZeroHash);
      }
      const sig = await signConstraint(stranger, verifier, commitment);
      await vault.sweepBucket(await verifier.getAddress(), constraintOf(commitment, chosen(stranger.address, POLICY, SALT, sig)), await token.getAddress(), proofBytes('email'), 0);
      expect(await token.balanceOf(LINKED_WALLET)).to.equal(100n);
      // a different salt is a different commitment: the same approval does not carry over
      const other = await verifier.constraintCommitment(stranger.address, POLICY, EMAIL_COMMITMENT, ethers.id('payment-43'));
      await expect(verifier.getIdentityWallet(EMAIL_COMMITMENT, proofBytes('email'), constraintOf(other, chosen(stranger.address, POLICY, ethers.id('payment-43'), sig))))
        .to.be.revertedWithCustomError(verifier, 'InvalidConstraintSigner');
    });

    it('malformed constraint signatures revert as malformed', async () => {
      const commitment = await verifier.constraintCommitment(stranger.address, POLICY, EMAIL_COMMITMENT, SALT);
      for (const bad of ['0x', '0x' + '11'.repeat(64), '0x' + '11'.repeat(66), '0x' + '11'.repeat(159)]) {
        await expect(verifier.getIdentityWallet(EMAIL_COMMITMENT, proofBytes('email'), constraintOf(commitment, bad)))
          .to.be.revertedWithCustomError(verifier, 'MalformedSignature');
      }
    });
  });
});
