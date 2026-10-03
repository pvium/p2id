import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';

const DAY = 86400;
const ID = ethers.id('alpha identity');
const types = { AlphaAuthorization: [
  { name: 'vault', type: 'address' }, { name: 'caller', type: 'address' },
  { name: 'callHash', type: 'bytes32' }, { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' }, { name: 'epoch', type: 'uint256' },
] };

describe('alpha proof acceptance by verification key', () => {
  let admin: any, attester: any, recipient: any, attacker: any;
  let verifier: any, factory: any, policy: any, vault: any, proxy: any, token: any;
  let V: string, T: string, K: string, proof: string;
  beforeEach(async () => {
    [admin, attester, recipient, attacker] = await ethers.getSigners();
    verifier = await ethers.deployContract('MockIdentityVerifier');
    V = await verifier.getAddress(); K = await verifier.vkHash();
    token = await ethers.deployContract('MockERC20'); T = await token.getAddress();
    policy = await ethers.deployContract('PviumP2IDPolicy', [admin.address, [V]]);
    factory = await ethers.deployContract('PviumP2IdVaultFactory', [admin.address, ethers.id('pvium.vault.v1'), policy.target, V, DAY, 0, DAY, attester.address]);
    await factory.deploy(ID);
    vault = await ethers.getContractAt('P2IDVault', await factory.vaultFor(ID));
    proxy = await ethers.getContractAt('PviumP2IDVaultProxy', vault.target);
    proof = ethers.AbiCoder.defaultAbiCoder().encode(['address', 'bytes32', 'uint64'], [recipient.address, ID, await time.latest()]);
    await token.mint(admin.address, 100n); await token.approve(vault.target, 100n);
    await vault.fund(T, 100n, ethers.ZeroHash, 0, ethers.ZeroHash);
  });
  const action = (name: string, args: any[]) => vault.interface.encodeFunctionData(name, args);
  async function authorization(data: string, overrides: any = {}, signer?: any) {
    const domain = { name: 'PviumAlpha', version: '1', chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await factory.getAddress() };
    const payload = { vault: await vault.getAddress(), caller: admin.address, callHash: ethers.keccak256(data), nonce: BigInt(ethers.hexlify(ethers.randomBytes(32))), deadline: await time.latest() + DAY, epoch: await factory.alphaEpoch(), ...overrides };
    return { nonce: payload.nonce, deadline: payload.deadline, signature: await (signer ?? attester).signTypedData(domain, types, payload) };
  }
  async function execute(data: string) { return vault.executeWithAttestation(data, await authorization(data)); }

  it('requires attestation on all four proof-verifying business methods', async () => {
    const c = { commitment: ethers.id('constraint'), signature: ethers.hexlify(ethers.toUtf8Bytes('ok')) };
    const cases: [string, any[]][] = [
      ['refreshProof', [V, proof]], ['refreshProofAndSweep', [V, proof, T, 0]],
      ['sweepBucket', [V, c, T, proof, 0]], ['sweepBucketDeposits', [V, c, T, [0], proof]],
    ];
    for (const [name, args] of cases) {
      await expect(vault[name](...args)).to.be.revertedWithCustomError(vault, 'AlphaAuthorizationRequired');
      await expect(vault[name + 'WithAttestation'](...args, { nonce: 0, deadline: 0, signature: '0x' })).to.be.revertedWithCustomError(vault, 'AlphaAuthorizationRequired');
      const wrong = await authorization(action('withdrawFees', [V, T]));
      await expect(vault[name + 'WithAttestation'](...args, wrong)).to.be.revertedWithCustomError(factory, 'InvalidAlphaAuthorization');
    }
  });
  it('allows ordinary cached sweeps of recorded and direct funds after an attested proof', async () => {
    await execute(action('refreshProof', [V, proof]));
    await token.mint(vault.target, 25n);
    expect(await vault.sweep.staticCall(V, T, 0)).to.deep.equal([125n, 1n]);
    await vault.connect(attacker).sweep(V, T, 0);
    await token.mint(vault.target, 10n); await vault.sweepUntracked(T);
    await admin.sendTransaction({ to: vault.target, value: 7n }); await vault.sweepUntracked(ethers.ZeroAddress);
    expect(await token.balanceOf(recipient.address)).to.equal(135n);
    expect(await vault.withdrawFees(V, T)).not.to.equal(undefined);
    for (const name of ['sweepWithAttestation', 'sweepUntrackedWithAttestation', 'sweepDepositsWithAttestation', 'withdrawFeesWithAttestation']) {
      expect(vault.interface.fragments.some((f: any) => f.name === name)).to.equal(false);
    }
  });
  it('allows an ordinary explicit-deposit sweep with a trusted cache', async () => {
    await execute(action('refreshProof', [V, proof]));
    await vault.sweepDeposits(V, T, [0]);
    expect(await token.balanceOf(recipient.address)).to.equal(100n);
  });
  it('every key is in alpha until released: shared across verifiers with the same key, separate for other keys', async () => {
    const same = await ethers.deployContract('MockIdentityVerifier');
    const other = await ethers.deployContract('MockIdentityVerifier');
    const otherKey = ethers.id('mock.vk.v2'); await other.setVkHash(otherKey);
    await policy.approveVerifier(same.target, true); await policy.approveVerifier(other.target, true);
    await expect(vault.refreshProof(same.target, proof)).to.be.revertedWithCustomError(vault, 'AlphaAuthorizationRequired');
    // a key nobody has configured (a new circuit) needs attestation from its first proof
    expect(await factory.isAlpha(otherKey)).to.equal(true);
    expect(await factory.isAlpha(ethers.id('never seen'))).to.equal(true);
    await expect(vault.refreshProof(other.target, proof)).to.be.revertedWithCustomError(vault, 'AlphaAuthorizationRequired');
    // releasing one key releases only that key
    await factory.setAlpha(otherKey, false);
    expect(await factory.isAlpha(otherKey)).to.equal(false);
    await vault.refreshProof(other.target, proof);
    await expect(vault.refreshProof(same.target, proof)).to.be.revertedWithCustomError(vault, 'AlphaAuthorizationRequired');
    await factory.setAlpha(K, false);
    await vault.refreshProof(V, proof);
    // back into alpha: attestation required again, and the revision moves so released-era caches are void
    const before = await factory.alphaRevision(otherKey);
    await factory.setAlpha(otherKey, true);
    expect(await factory.alphaRevision(otherKey)).to.equal(before + 1n);
    await expect(vault.refreshProof(other.target, proof)).to.be.revertedWithCustomError(vault, 'AlphaAuthorizationRequired');
  });
  it('invalidates cached owners when alpha is enabled, requiring an attested revalidation', async () => {
    await factory.setAlpha(K, false); await vault.refreshProof(V, proof);
    await factory.setAlpha(K, true);
    await expect(vault.sweep(V, T, 0)).to.be.revertedWithCustomError(vault, 'OwnerRevoked');
    await expect(vault.sweepDeposits(V, T, [0])).to.be.revertedWithCustomError(vault, 'OwnerRevoked');
    await expect(vault.sweepUntracked(T)).to.be.revertedWithCustomError(vault, 'OwnerRevoked');
    await execute(action('refreshProof', [V, proof]));
    await vault.sweep(V, T, 0);
    expect(await token.balanceOf(recipient.address)).to.equal(100n);
  });
  it('invalidates caches if a verifier changes its pinned key; equal-time proof for another wallet cannot revive the old cache', async () => {
    await execute(action('refreshProof', [V, proof]));
    await verifier.setVkHash(ethers.id('mock.changed.key'));
    await expect(vault.sweep(V, T, 0)).to.be.revertedWithCustomError(vault, 'OwnerRevoked');
    const different = ethers.AbiCoder.defaultAbiCoder().encode(['address', 'bytes32', 'uint64'], [attacker.address, ID, await vault.latestProofIat(V)]);
    // the changed key is a new key, so it starts in alpha; release it to exercise the ordinary path
    await expect(vault.refreshProof(V, different)).to.be.revertedWithCustomError(vault, 'AlphaAuthorizationRequired');
    await factory.setAlpha(ethers.id('mock.changed.key'), false);
    await vault.refreshProof(V, different);
    await expect(vault.sweep(V, T, 0)).to.be.revertedWithCustomError(vault, 'OwnerRevoked');
    await vault.refreshProof(V, proof); await vault.sweep(V, T, 0);
    expect(await token.balanceOf(recipient.address)).to.equal(100n);
  });
  it('accepts random nonces in either order, rejects replay and binds the nonce to the signature', async () => {
    const data = action('refreshProof', [V, proof]);
    const a = await authorization(data, { nonce: (1n << 255n) + 5n });
    const b = await authorization(data, { nonce: 7n });
    await vault.executeWithAttestation(data, a); await vault.executeWithAttestation(data, b);
    await expect(vault.executeWithAttestation(data, a)).to.be.revertedWithCustomError(vault, 'AlphaNonceAlreadyUsed');
    const c = await authorization(data);
    await expect(vault.executeWithAttestation(data, { ...c, nonce: c.nonce ^ 1n })).to.be.revertedWithCustomError(factory, 'InvalidAlphaAuthorization');
  });
  it('binds caller, method parameters, chain, factory, vault and expiry', async () => {
    const data = action('refreshProof', [V, proof]); const a = await authorization(data);
    await expect(vault.connect(attacker).executeWithAttestation(data, a)).to.be.revertedWithCustomError(factory, 'InvalidAlphaAuthorization');
    await expect(vault.refreshProofAndSweepWithAttestation(V, proof, T, 0, a)).to.be.revertedWithCustomError(factory, 'InvalidAlphaAuthorization');
    for (const overrides of [{ vault: attacker.address }, { callHash: ethers.ZeroHash }]) {
      await expect(vault.executeWithAttestation(data, await authorization(data, overrides))).to.be.revertedWithCustomError(factory, 'InvalidAlphaAuthorization');
    }
    const domain = { name: 'PviumAlpha', version: '1', chainId: 1n, verifyingContract: factory.target };
    const sig = await attester.signTypedData(domain, types, { vault: vault.target, caller: admin.address, callHash: ethers.keccak256(data), nonce: a.nonce, deadline: a.deadline, epoch: await factory.alphaEpoch() });
    await expect(vault.executeWithAttestation(data, { ...a, signature: sig })).to.be.revertedWithCustomError(factory, 'InvalidAlphaAuthorization');
    await time.increaseTo(a.deadline + 1);
    await expect(vault.executeWithAttestation(data, a)).to.be.revertedWithCustomError(factory, 'AlphaAuthorizationExpired');
  });
  it('keeps funding constraints mandatory and binds their evidence into the alpha approval', async () => {
    const c = { commitment: ethers.id('constraint'), signature: ethers.hexlify(ethers.toUtf8Bytes('ok')) };
    await token.mint(admin.address, 30n); await token.approve(vault.target, 30n);
    await vault.fund(T, 30n, c.commitment, 0, ethers.ZeroHash);
    const data = action('sweepBucketDeposits', [V, c, T, [1], proof]); const a = await authorization(data);
    await expect(vault.sweepBucketDepositsWithAttestation(V, { ...c, signature: '0x' }, T, [1], proof, a)).to.be.revertedWithCustomError(factory, 'InvalidAlphaAuthorization');
    await vault.executeWithAttestation(data, a);
    expect(await token.balanceOf(recipient.address)).to.equal(30n);
    await vault.sweep(V, T, 0); expect(await token.balanceOf(recipient.address)).to.equal(130n);
  });
  it('rolls nonce consumption back on failure and rejects nested proof acceptance during payout', async () => {
    const data = action('refreshProof', [V, '0x']); const a = await authorization(data);
    await expect(vault.executeWithAttestation(data, a)).to.be.reverted;
    expect(await vault.alphaNonceUsed(a.nonce)).to.equal(false);
    const receiver = await ethers.deployContract('MockReentrantWallet');
    const receiverProof = ethers.AbiCoder.defaultAbiCoder().encode(['address', 'bytes32', 'uint64'], [receiver.target, ID, await time.latest()]);
    await admin.sendTransaction({ to: vault.target, value: 10n });
    await receiver.arm(vault.target, action('sweepUntracked', [ethers.ZeroAddress]));
    await expect(execute(action('refreshProofAndSweep', [V, receiverProof, ethers.ZeroAddress, 0]))).to.be.revertedWithCustomError(vault, 'NativeTransferFailed');
    expect(await vault.owner(V)).to.equal(ethers.ZeroAddress);
  });
  it('allows only owner status changes and signer rotation invalidates outstanding signatures', async () => {
    const data = action('refreshProof', [V, proof]); const a = await authorization(data);
    await expect(factory.connect(attacker).setAlpha(K, false)).to.be.revertedWithCustomError(factory, 'NotOwner');
    await expect(factory.setAlpha(ethers.ZeroHash, true)).to.be.revertedWithCustomError(factory, 'InvalidVkHash');
    await factory.setDefaultAttester(recipient.address);
    await expect(vault.executeWithAttestation(data, a)).to.be.revertedWithCustomError(factory, 'InvalidAlphaAuthorization');
    await vault.executeWithAttestation(data, await authorization(data, {}, recipient));
  });
  it('only the configured attester key counts: other signers and malformed signatures are refused', async () => {
    const data = action('refreshProof', [V, proof]);
    // a signature from a key that was never the attester, even the factory owner or the vault owner
    for (const who of [attacker, admin, recipient]) {
      await expect(vault.executeWithAttestation(data, await authorization(data, {}, who))).to.be.revertedWithCustomError(factory, 'InvalidAlphaAuthorization');
    }
    const good = await authorization(data);
    // malformed: wrong length, bad recovery id, high s (the EIP-2 half), flipped bit
    const sig = ethers.Signature.from(good.signature);
    // ethers refuses to build a high-s signature, so assemble the bytes directly: (r, N - s, flipped v)
    const highS = ethers.concat([sig.r, ethers.toBeHex(ethers.N - BigInt(sig.s), 32), sig.v === 27 ? '0x1c' : '0x1b']);
    const badV = ethers.concat([sig.r, sig.s, '0x1d']);
    const flipped = ethers.toBeHex(BigInt(good.signature) ^ 1n, 65);
    for (const bad of [good.signature.slice(0, -2), good.signature + '00', badV, highS, flipped]) {
      await expect(vault.executeWithAttestation(data, { ...good, signature: bad })).to.be.revertedWithCustomError(factory, 'InvalidAlphaAuthorization');
    }
    await vault.executeWithAttestation(data, good); // the genuine one still works: nothing above consumed its nonce
    expect(await vault.owner(V)).to.equal(recipient.address);
  });

  it('the attester is owner-controlled and never zero; the proxy upgrade honours the same key', async () => {
    await expect(factory.connect(attacker).setDefaultAttester(attacker.address)).to.be.revertedWithCustomError(factory, 'NotOwner');
    await expect(factory.setDefaultAttester(ethers.ZeroAddress)).to.be.revertedWithCustomError(factory, 'InvalidAlphaAuthorization');
    expect(await factory.defaultAttester()).to.equal(attester.address);
    const target = await ethers.deployContract('MockVaultV2', [factory.target]);
    await factory.proposeImplementation(target.target); await time.increase(14 * DAY); await factory.registerImplementation();
    const data = proxy.interface.encodeFunctionData('upgradeTo', [ID, target.target, proof]);
    await expect(proxy.connect(recipient).upgradeToWithAttestation(ID, target.target, proof, { nonce: 1, deadline: 0, signature: '0x' }))
      .to.be.revertedWithCustomError(proxy, 'AlphaAuthorizationRequired');
    await expect(proxy.connect(recipient).upgradeToWithAttestation(ID, target.target, proof, await authorization(data, { caller: recipient.address }, attacker)))
      .to.be.revertedWithCustomError(factory, 'InvalidAlphaAuthorization');
    await proxy.connect(recipient).upgradeToWithAttestation(ID, target.target, proof, await authorization(data, { caller: recipient.address }));
    expect(await proxy.implementation()).to.equal(target.target);
  });

  it('guards upgrade proofs by the default verifier key and records an attested cache in the new implementation', async () => {
    const target = await ethers.deployContract('MockVaultV2', [factory.target]);
    await factory.proposeImplementation(target.target); await time.increase(14 * DAY); await factory.registerImplementation();
    const data = proxy.interface.encodeFunctionData('upgradeTo', [ID, target.target, proof]);
    await expect(proxy.connect(recipient).upgradeTo(ID, target.target, proof)).to.be.revertedWithCustomError(proxy, 'AlphaAuthorizationRequired');
    const a = await authorization(data, { caller: recipient.address });
    await proxy.connect(recipient).upgradeToWithAttestation(ID, target.target, proof, a);
    await expect(proxy.connect(recipient).upgradeToWithAttestation(ID, target.target, proof, a)).to.be.reverted;
    await vault.sweep(V, T, 0); expect(await token.balanceOf(recipient.address)).to.equal(100n);
    expect(await proxy.alphaUpgradeNonceUsed(a.nonce)).to.equal(true);
    expect(await vault.alphaNonceUsed(a.nonce)).to.equal(false);
  });
  it('rejects generic wrappers around proofless methods, funding, refunds, hooks and nested wrappers', async () => {
    for (const data of [action('sweep', [V, T, 0]), action('withdrawFees', [V, T]), action('refund', [0]), action('acceptOwnerProof', [V, recipient.address, 0]), vault.interface.encodeFunctionData('executeWithAttestation', ['0x', { nonce: 0, deadline: 0, signature: '0x' }])]) {
      await expect(vault.executeWithAttestation(data, { nonce: 0, deadline: 0, signature: '0x' })).to.be.revertedWithCustomError(vault, 'InvalidAlphaCall');
    }
  });
});
