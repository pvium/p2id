import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';

// Audit findings on the upgrade gate, and the behaviour that resolves them. The slot-writer case is
// inherent to delegatecall proxies and is documented rather than prevented: registration vets code.
describe('PviumP2IDVaultProxy audit', function () {
  const ID = ethers.id('proxy-audit-identity');
  const DAY = 86400;
  let factory: any, verifier: any, policy: any, proxy: any, vault: any, v2: any;
  let admin: any, current: any, former: any;
  const proof = (wallet: string, iat: number) => ethers.AbiCoder.defaultAbiCoder()
    .encode(['address', 'bytes32', 'uint64'], [wallet, ID, iat]);

  beforeEach(async () => {
    [admin, current, former] = await ethers.getSigners();
    verifier = await ethers.deployContract('MockIdentityVerifier');
    policy = await ethers.deployContract('MockFeePolicy');
    await policy.allow(await verifier.getAddress(), true);
    factory = await ethers.deployContract('PviumP2IdVaultFactory', [admin.address,
      ethers.id('pvium.vault.v1'), await policy.getAddress(), await verifier.getAddress(),
      7 * DAY, DAY, 30 * DAY]);
    await factory.deploy(ID);
    const address = await factory.vaultFor(ID);
    proxy = await ethers.getContractAt('PviumP2IDVaultProxy', address);
    vault = await ethers.getContractAt('P2IDVault', address);
    v2 = await ethers.deployContract('MockVaultV2', [await factory.getAddress()]);
    await factory.proposeImplementation(await v2.getAddress());
    await time.increase(14 * DAY);
    await factory.registerImplementation();
  });

  it('a former wallet cannot undo an upgrade made with a newer proof: upgrades advance the proxy record', async () => {
    await vault.refreshProof(await verifier.getAddress(), proof(former.address, 1000));
    await proxy.connect(current).upgradeTo(ID, await v2.getAddress(), proof(current.address, 2000));
    expect(await vault.latestProofIat(await verifier.getAddress())).to.equal(2000); // the vault saw the proof too
    expect(await vault.owner(await verifier.getAddress())).to.equal(current.address);
    expect(await proxy.lastUpgrade()).to.deep.equal([current.address, 2000n]);
    await expect(proxy.connect(former).upgradeTo(ID, await factory.baseImplementation(), proof(former.address, 1000)))
      .to.be.revertedWithCustomError(proxy, 'ProofTooOld');
    await expect(proxy.connect(former).upgradeTo(ID, await factory.baseImplementation(), proof(former.address, 2000)))
      .to.be.revertedWithCustomError(proxy, 'ProofTooOld'); // equal time, different wallet
    await proxy.connect(current).upgradeTo(ID, await factory.baseImplementation(), proof(current.address, 2000)); // same wallet may
    expect(await proxy.implementation()).to.equal(await factory.baseImplementation());
  });

  it('a default-verifier change keeps the cross-default floor for upgrades', async () => {
    await vault.refreshProof(await verifier.getAddress(), proof(current.address, 2000));
    const next = await ethers.deployContract('MockIdentityVerifier');
    await policy.allow(await next.getAddress(), true);
    await factory.proposeDefaultVerifier(await next.getAddress());
    await time.increase(14 * DAY);
    await factory.activateDefaultVerifier();
    expect(await vault.untrackedProofIat()).to.equal(2000);
    await expect(proxy.connect(former).upgradeTo(ID, await v2.getAddress(), proof(former.address, 1000)))
      .to.be.revertedWithCustomError(proxy, 'ProofTooOld');
    await proxy.connect(current).upgradeTo(ID, await v2.getAddress(), proof(current.address, 2000));
    expect(await proxy.implementation()).to.equal(await v2.getAddress());
  });

  it('refuses future-dated proofs, with the same slack as the vault', async () => {
    const now = await time.latest();
    await expect(proxy.connect(current).upgradeTo(ID, await v2.getAddress(), proof(current.address, now + DAY)))
      .to.be.revertedWithCustomError(proxy, 'ProofFromFuture');
    await proxy.connect(current).upgradeTo(ID, await v2.getAddress(), proof(current.address, now + 10 * 60));
    expect(await proxy.implementation()).to.equal(await v2.getAddress());
  });

  it('documented limitation: a registered implementation can rewrite the slot, so registration must vet code', async () => {
    const unsafe = await ethers.deployContract('MockProxySlotWriter', [await factory.getAddress()]);
    await factory.proposeImplementation(await unsafe.getAddress());
    await time.increase(14 * DAY);
    await factory.registerImplementation();
    await proxy.connect(current).upgradeTo(ID, await unsafe.getAddress(), proof(current.address, 2000));
    const delegated = await ethers.getContractAt('MockProxySlotWriter', await proxy.getAddress());
    // No identity proof or registration: this is an arbitrary caller and an EOA target.
    await delegated.connect(former).overwriteImplementation(former.address);
    expect(await factory.isRegisteredImplementation(former.address)).to.equal(false);
    expect(await proxy.implementation()).to.equal(former.address);
  });

  it('a target that reverts on the owner-proof selector cannot be upgraded to', async () => {
    // The verifier has no hook or permissive fallback. Registration itself does not check compatibility.
    const incompatible = await verifier.getAddress();
    await factory.proposeImplementation(incompatible);
    await time.increase(14 * DAY);
    await factory.registerImplementation();
    await expect(proxy.connect(current).upgradeTo(ID, incompatible, proof(current.address, 2000))).to.be.reverted;
    expect(await proxy.implementation()).to.equal(await factory.baseImplementation());
    expect(await proxy.lastUpgrade()).to.deep.equal([ethers.ZeroAddress, 0n]);
  });

  it('the verified-result hook cannot be called directly, even by a proven owner', async () => {
    const V = await verifier.getAddress();
    await vault.refreshProof(V, proof(current.address, 1000));
    for (const caller of [admin, current, former]) {
      await expect(vault.connect(caller).acceptOwnerProof(V, former.address, 2000))
        .to.be.revertedWithCustomError(vault, 'NotSelf');
    }
    expect(await vault.owner(V)).to.equal(current.address);
    expect(await vault.latestProofIat(V)).to.equal(1000);
    expect(await vault.untrackedProofIat()).to.equal(1000);
  });

  it('the hook refreshes the current verifier revision without changing an opt-in verifier cache', async () => {
    const V = await verifier.getAddress();
    const other = await ethers.deployContract('MockIdentityVerifier');
    const W = await other.getAddress();
    await policy.allow(W, true);
    await vault.refreshProof(W, proof(former.address, 5000));
    await vault.refreshProof(V, proof(current.address, 1000));
    await verifier.setRevision(1);
    await proxy.connect(current).upgradeTo(ID, await v2.getAddress(), proof(current.address, 1000));
    expect(await vault.ownerRevision(V)).to.equal(1);
    expect(await vault.owner(V)).to.equal(current.address);
    expect(await vault.untrackedProofIat()).to.equal(1000);
    expect(await vault.latestProofIat(W)).to.equal(5000);
    expect(await vault.owner(W)).to.equal(former.address);
  });

  it('an implementation whose fallback silently accepts the hook is refused: the acknowledgement is missing', async () => {
    const target = await ethers.deployContract('MockProxyNoopFallback');
    await vault.refreshProof(await verifier.getAddress(), proof(former.address, 1000));
    await factory.proposeImplementation(await target.getAddress());
    await time.increase(14 * DAY);
    await factory.registerImplementation();
    await expect(proxy.connect(current).upgradeTo(ID, await target.getAddress(), proof(current.address, 2000)))
      .to.be.revertedWithCustomError(proxy, 'HookNotAcknowledged').withArgs(await target.getAddress());
    expect(await proxy.implementation()).to.equal(await factory.baseImplementation());
    expect(await proxy.lastUpgrade()).to.deep.equal([ethers.ZeroAddress, 0n]);
    expect(await vault.owner(await verifier.getAddress())).to.equal(former.address); // untouched
  });

  for (const kind of ['short', 'long', 'wrong selector', 'dirty padding']) {
    it(`rejects a ${kind} acknowledgement and rolls back proxy and hook writes`, async () => {
      const V = await verifier.getAddress();
      await proxy.connect(current).upgradeTo(ID, await v2.getAddress(), proof(current.address, 1000));
      const namespace = await vault.nsHash();
      const selector = vault.interface.getFunction('acceptOwnerProof')!.selector;
      const word = kind === 'wrong selector' ? ethers.ZeroHash
        : ethers.concat([selector, '0x' + '00'.repeat(27) + (kind === 'dirty padding' ? '01' : '00')]);
      const length = kind === 'short' ? 4 : kind === 'long' ? 64 : 32;
      const target = await ethers.deployContract('MockProxyHookResponse', [word, length]);
      await factory.proposeImplementation(await target.getAddress());
      await time.increase(14 * DAY);
      await factory.registerImplementation();
      await expect(proxy.connect(current).upgradeTo(ID, await target.getAddress(), proof(current.address, 2000)))
        .to.be.reverted;
      expect(await proxy.implementation()).to.equal(await v2.getAddress());
      expect(await proxy.lastUpgrade()).to.deep.equal([current.address, 1000n]);
      expect(await vault.nsHash()).to.equal(namespace);
      expect(await vault.owner(V)).to.equal(current.address);
      expect(await vault.latestProofIat(V)).to.equal(1000);
    });
  }

  it('a hook that exhausts its gas rolls back an already-written upgrade and preserves the prior record', async () => {
    await proxy.connect(current).upgradeTo(ID, await v2.getAddress(), proof(current.address, 1000));
    const target = await ethers.deployContract('MockProxyFailingHook');
    await factory.proposeImplementation(await target.getAddress());
    await time.increase(14 * DAY);
    await factory.registerImplementation();
    await expect(proxy.connect(current).upgradeTo(ID, await target.getAddress(), proof(current.address, 2000),
      { gasLimit: 1_000_000 })).to.be.reverted;
    expect(await proxy.implementation()).to.equal(await v2.getAddress());
    expect(await proxy.lastUpgrade()).to.deep.equal([current.address, 1000n]);
    expect(await vault.owner(await verifier.getAddress())).to.equal(current.address);
    expect(await vault.latestProofIat(await verifier.getAddress())).to.equal(1000);
  });

  it('an upgrade with a newer proof retires the old wallet in the vault too', async () => {
    const token = await ethers.deployContract('MockERC20');
    await token.mint(await proxy.getAddress(), 100n);
    await vault.refreshProof(await verifier.getAddress(), proof(former.address, 1000));
    await expect(proxy.connect(current).upgradeTo(ID, await v2.getAddress(), proof(current.address, 2000)))
      .to.emit(vault, 'OwnerRefreshed').withArgs(await verifier.getAddress(), current.address, 2000);
    expect(await proxy.lastUpgrade()).to.deep.equal([current.address, 2000n]);
    expect(await vault.owner(await verifier.getAddress())).to.equal(current.address);
    expect(await vault.latestProofIat(await verifier.getAddress())).to.equal(2000);
    await vault.connect(admin).sweepUntracked(await token.getAddress()); // anyone may trigger; it pays the current owner
    expect(await token.balanceOf(current.address)).to.equal(100n);
    expect(await token.balanceOf(former.address)).to.equal(0n);
    await expect(vault.refreshProof(await verifier.getAddress(), proof(former.address, 1000)))
      .to.be.revertedWithCustomError(vault, 'ProofTooOld');
  });

  it('an upgrade is atomic: if the vault cannot apply the proof, nothing changes', async () => {
    const token = await ethers.deployContract('MockERC20');
    await token.mint(await proxy.getAddress(), 100n);
    await vault.refreshProof(await verifier.getAddress(), proof(former.address, 1000));
    await verifier.breakRevision(true);
    await expect(proxy.connect(current).upgradeTo(ID, await v2.getAddress(), proof(current.address, 2000)))
      .to.be.revertedWithCustomError(vault, 'RevisionUnavailable');
    expect(await proxy.implementation()).to.equal(await factory.baseImplementation());
    expect(await proxy.lastUpgrade()).to.deep.equal([ethers.ZeroAddress, 0n]);
    await verifier.breakRevision(false);
    await proxy.connect(current).upgradeTo(ID, await v2.getAddress(), proof(current.address, 2000));
    expect(await vault.owner(await verifier.getAddress())).to.equal(current.address);
    await vault.sweepUntracked(await token.getAddress());
    expect(await token.balanceOf(current.address)).to.equal(100n);
    expect(await token.balanceOf(former.address)).to.equal(0n);
  });

  it('an equal-time proof for a wallet that is not the payout owner cannot upgrade', async () => {
    await vault.refreshProof(await verifier.getAddress(), proof(former.address, 2000));
    await expect(proxy.connect(current).upgradeTo(ID, await v2.getAddress(), proof(current.address, 2000)))
      .to.be.revertedWithCustomError(vault, 'NotOwnerProof').withArgs(former.address);
    expect(await proxy.implementation()).to.equal(await factory.baseImplementation());
    expect(await vault.owner(await verifier.getAddress())).to.equal(former.address);
    await proxy.connect(former).upgradeTo(ID, await v2.getAddress(), proof(former.address, 2000)); // the owner may
    expect(await proxy.implementation()).to.equal(await v2.getAddress());
  });

  it('an implementation reporting an impossible freshness floor cannot block recovery', async () => {
    const incompatible = await ethers.deployContract('MockProxyImpossibleFloor');
    await factory.proposeImplementation(await incompatible.getAddress());
    await time.increase(14 * DAY);
    await factory.registerImplementation();
    await proxy.connect(current).upgradeTo(ID, await incompatible.getAddress(), proof(current.address, 2000));
    expect(await proxy.lastUpgrade()).to.deep.equal([current.address, 2000n]);
    await expect(proxy.connect(former).upgradeTo(ID, await factory.baseImplementation(), proof(former.address, 1500)))
      .to.be.revertedWithCustomError(proxy, 'ProofTooOld'); // the proxy record still holds
    await proxy.connect(current).upgradeTo(ID, await factory.baseImplementation(), proof(current.address, await time.latest()));
    expect(await proxy.implementation()).to.equal(await factory.baseImplementation());
  });

  it('a hostile implementation that plants a far-future upgrade record cannot jam later upgrades', async () => {
    const unsafe = await ethers.deployContract('MockProxySlotWriter', [await factory.getAddress()]);
    await factory.proposeImplementation(await unsafe.getAddress());
    await time.increase(14 * DAY);
    await factory.registerImplementation();
    await proxy.connect(current).upgradeTo(ID, await unsafe.getAddress(), proof(current.address, 2000));
    const delegated = await ethers.getContractAt('MockProxySlotWriter', await proxy.getAddress());
    const slot = ethers.toBeHex(BigInt(ethers.id('pvium.vault.proxy.lastUpgrade')) - 1n, 32);
    const poisoned = (BigInt(2n ** 64n - 1n) << 160n) | BigInt(former.address);
    await delegated.writeSlot(slot, ethers.toBeHex(poisoned, 32));
    expect((await proxy.lastUpgrade())[1]).to.equal(2n ** 64n - 1n);
    // the record is impossible for the gate to have written, so it is ignored: the owner moves away
    await proxy.connect(current).upgradeTo(ID, await factory.baseImplementation(), proof(current.address, 2000));
    expect(await proxy.implementation()).to.equal(await factory.baseImplementation());
    expect(await proxy.lastUpgrade()).to.deep.equal([current.address, 2000n]);
  });

  for (const scenario of ['wrong owner', 'stale floor', 'unreadable owner', 'unreadable floor', 'changed implementation']) {
    it(`post-hook rejection rolls back all writes: ${scenario}`, async () => {
      await proxy.connect(current).upgradeTo(ID, await v2.getAddress(), proof(current.address, 1000));
      const namespace = await vault.nsHash();
      const mode = scenario === 'changed implementation' ? 1
        : scenario === 'unreadable owner' ? 3 : scenario === 'unreadable floor' ? 4 : 0;
      const target = await ethers.deployContract('MockProxyPostconditions', [
        mode, scenario === 'wrong owner' ? former.address : current.address,
        scenario === 'stale floor' ? 1999 : 2000, await factory.initialImplementation(),
      ]);
      await factory.proposeImplementation(await target.getAddress());
      await time.increase(14 * DAY);
      await factory.registerImplementation();
      await expect(proxy.connect(current).upgradeTo(ID, await target.getAddress(), proof(current.address, 2000)))
        .to.be.revertedWithCustomError(proxy, scenario === 'changed implementation'
          ? 'ImplementationChangedDuringHook' : 'HookDidNotApply');
      expect(await proxy.implementation()).to.equal(await v2.getAddress());
      expect(await proxy.lastUpgrade()).to.deep.equal([current.address, 1000n]);
      expect(await vault.nsHash()).to.equal(namespace);
      expect(await vault.owner(await verifier.getAddress())).to.equal(current.address);
      expect(await vault.latestProofIat(await verifier.getAddress())).to.equal(1000);
      // A failed upgrade must not leave the new guard set.
      await proxy.connect(current).upgradeTo(ID, await factory.initialImplementation(), proof(current.address, 2000));
    });
  }

  it('blocks a nested hook upgrade and clears the guard after a successful outer upgrade', async () => {
    const target = await ethers.deployContract('MockProxyPostconditions', [
      2, current.address, 2000, await factory.initialImplementation(),
    ]);
    await factory.proposeImplementation(await target.getAddress());
    await time.increase(14 * DAY);
    await factory.registerImplementation();
    await proxy.connect(current).upgradeTo(ID, await target.getAddress(), proof(current.address, 2000));
    expect(await proxy.implementation()).to.equal(await target.getAddress());
    // The mock asserts the nested call returned UpgradeReentered, even with invalid identity/proof.
    // Its getters deliberately fake the state checks: these are not a sandbox for registered code.
    await proxy.connect(current).upgradeTo(ID, await factory.initialImplementation(), proof(current.address, 2001));
    expect(await proxy.implementation()).to.equal(await factory.initialImplementation());
  });

});
