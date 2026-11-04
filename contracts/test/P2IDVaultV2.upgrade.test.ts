import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { join } from 'path';
import { readContract } from '../scripts/lib/storageLayout';

const NS = ethers.id('pvium.vault.v1');
const ID = ethers.id('existing-user');
const ID_NEW = ethers.id('new-user');
const DAY = 86400;
const Z = ethers.ZeroHash;
const NATIVE = ethers.ZeroAddress;
/** The notice this factory is deployed with. Production factories use 14 days; the value is an immutable. */
const NOTICE = 1;
const alphaTypes = { AlphaAuthorization: [
  { name: 'vault', type: 'address' }, { name: 'caller', type: 'address' },
  { name: 'callHash', type: 'bytes32' }, { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' }, { name: 'epoch', type: 'uint256' },
] };

/**
 * The first live vault change. P2IDVaultV2 adds fundWithRefunder: the payer stays the funder of
 * record and names a refunder, the one account that may recover the deposit after its window and
 * the one paid. Everything else is V1: the funder refunds a plain deposit, nobody else can trigger
 * a refund, fundFor stays factory-only, constraints are reserved per funder.
 * This suite walks the release path end to end on a factory whose notice is one second:
 * deploy the V1 stack, deploy V2 through the factory, propose, wait, register as default, then
 * check a new vault, an existing vault whose owner upgrades, and one whose owner never does.
 */
describe('P2IDVaultV2 release: registration, new vaults, existing vaults upgrading', function () {
  let deployer: any, payer: any, ownerWallet: any, refunder: any, stranger: any, attester: any;
  let idv: any, V: string, K: string, policy: any, factory: any, token: any, T: string;
  let v2Code: string, V2: string, V1: string;

  const proofFor = (wallet: string, iat: number, id = ID) =>
    ethers.AbiCoder.defaultAbiCoder().encode(['address', 'bytes32', 'uint64'], [wallet, id, iat]);

  beforeEach(async () => {
    [deployer, payer, ownerWallet, refunder, stranger, attester] = await ethers.getSigners();
    idv = await ethers.deployContract('MockIdentityVerifier');
    V = await idv.getAddress(); K = await idv.vkHash();
    policy = await ethers.deployContract('MockFeePolicy');
    await policy.allow(V, true);
    factory = await ethers.deployContract('PviumP2IdVaultFactory', [deployer.address, NS, await policy.getAddress(), V, 7 * DAY, DAY, 30 * DAY, attester.address, NOTICE]);
    token = await ethers.deployContract('MockERC20'); T = await token.getAddress();
    V1 = await factory.baseImplementation();
    // exactly what `IMPLEMENTATION=P2IDVaultV2 yarn implementation` sends: the creation code bound to this factory
    v2Code = (await (await ethers.getContractFactory('P2IDVaultV2')).getDeployTransaction(await factory.getAddress())).data;
    V2 = await factory.implementationFor(ethers.keccak256(v2Code));
  });

  /** Deploy V2 through the factory, propose it (optionally as the default for new vaults), wait out the notice, register. */
  async function releaseV2(makeDefault = true) {
    await factory.deployVaultImplementation(v2Code, makeDefault);
    await time.increase(NOTICE + 1);
    await factory.registerImplementation();
  }
  async function fundV1(vault: any, amount: bigint, from = payer) {
    await token.mint(from.address, amount);
    await token.connect(from).approve(await vault.getAddress(), amount);
    return vault.connect(from).fund(T, amount, Z, DAY, Z);
  }
  async function mintAndApprove(to: any, spender: string, amount: bigint) {
    await token.mint(to.address, amount);
    await token.connect(to).approve(spender, amount);
  }
  async function vaultAt(id: string) {
    await factory.deploy(id);
    const address = await factory.vaultFor(id);
    return { vault: await ethers.getContractAt('P2IDVaultV2', address), proxy: await ethers.getContractAt('PviumP2IDVaultProxy', address) };
  }
  async function authorization(vault: string, caller: string, data: string) {
    const domain = { name: 'PviumAlpha', version: '1', chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await factory.getAddress() };
    const payload = { vault, caller, callHash: ethers.keccak256(data), nonce: BigInt(ethers.hexlify(ethers.randomBytes(32))), deadline: (await time.latest()) + DAY, epoch: await factory.alphaEpoch() };
    return { nonce: payload.nonce, deadline: payload.deadline, signature: await attester.signTypedData(domain, alphaTypes, payload) };
  }
  /** Spend from `signer` and return the native balance delta net of gas. */
  async function nativeDelta(signer: any, send: () => Promise<any>) {
    const before = await ethers.provider.getBalance(signer.address);
    const receipt = await (await send()).wait();
    return (await ethers.provider.getBalance(signer.address)) - before + receipt!.gasUsed * receipt!.gasPrice;
  }

  it('storage: V2 appends depositRefunder after the last V1 variable and changes nothing before it', () => {
    const root = join(__dirname, '..');
    const current = readContract(root, 'src/P2IDVault.sol:P2IDVault').layout.storage.map((v) => [v.label, v.slot, v.offset]);
    const candidate = readContract(root, 'P2IDVaultV2').layout.storage.map((v) => [v.label, v.slot, v.offset]);
    expect(candidate.slice(0, current.length)).to.deep.equal(current);
    expect(candidate.slice(current.length)).to.deep.equal([['depositRefunder', String(current.length), 0]]);
    expect(current[current.length - 1][0]).to.equal('ownerAlphaRevision');
  });

  it('the notice is an immutable fixed at factory deployment, within [1 second, 30 days]', async () => {
    expect(await factory.DEFAULT_VERIFIER_DELAY()).to.equal(BigInt(NOTICE));
    expect(await factory.MAX_DEFAULT_VERIFIER_DELAY()).to.equal(BigInt(30 * DAY));
    const F = await ethers.getContractFactory('PviumP2IdVaultFactory');
    const args = (notice: number) => [deployer.address, NS, policy.target, V, 7 * DAY, DAY, 30 * DAY, attester.address, notice];
    await expect(F.deploy(...args(0))).to.be.revertedWithCustomError(F, 'InvalidDefaultVerifierDelay').withArgs(0);
    await expect(F.deploy(...args(30 * DAY + 1))).to.be.revertedWithCustomError(F, 'InvalidDefaultVerifierDelay').withArgs(30 * DAY + 1);
    const production = await F.deploy(...args(14 * DAY));
    expect(await production.DEFAULT_VERIFIER_DELAY()).to.equal(BigInt(14 * DAY));
    expect(F.interface.getFunction('setDefaultVerifierDelay')).to.equal(null); // no setter, ever
  });

  it('the factory deploys P2IDVaultV2 at its predicted address, accepts it, and registers it as the default only after the notice', async () => {
    await expect(factory.deployVaultImplementation(v2Code, true))
      .to.emit(factory, 'ImplementationDeployed').withArgs(V2, ethers.keccak256(v2Code))
      .and.to.emit(factory, 'ImplementationProposed');
    expect(await factory.proposedImplementation()).to.equal(V2);
    // the ETA is proposal time + the factory's immutable notice (with one second, the next block already satisfies it;
    // P2IDVaultProxy.test.ts covers TimelockNotElapsed on a 14-day factory)
    const proposedAt = (await ethers.provider.getBlock('latest'))!.timestamp;
    expect(await factory.proposedImplementationEta()).to.equal(BigInt(proposedAt + NOTICE));
    expect(await factory.isRegisteredImplementation(V2)).to.equal(false);
    expect(await factory.baseImplementation()).to.equal(V1); // nothing changes during the notice

    await time.increase(NOTICE + 1);
    await expect(factory.connect(stranger).registerImplementation()).to.be.revertedWithCustomError(factory, 'NotOwner');
    await expect(factory.registerImplementation())
      .to.emit(factory, 'ImplementationRegistered').withArgs(V2)
      .and.to.emit(factory, 'DefaultImplementationActivated').withArgs(V2);
    expect(await factory.isRegisteredImplementation(V2)).to.equal(true);
    expect(await factory.baseImplementation()).to.equal(V2);
    // V1 stays registered and remains the original: vaults can keep it or come back to it
    expect(await factory.isRegisteredImplementation(V1)).to.equal(true);
    expect(await factory.initialImplementation()).to.equal(V1);
    await expect(factory.revokeImplementation(V1)).to.be.revertedWithCustomError(factory, 'InvalidImplementation');

    // the registered code is the compatibility surface the factory checks for
    const impl = await ethers.getContractAt('P2IDVaultV2', V2);
    expect(await impl.factory()).to.equal(await factory.getAddress());
    expect(await impl.p2idVersion()).to.equal('p2id.vault.v1');
    expect(await impl.supportsAlphaGuard()).to.equal(true);
    await expect(impl.initialize(NS, ID)).to.be.revertedWithCustomError(impl, 'NotFactory'); // the raw implementation is inert
    // and the address derivation is untouched: the proxy code did not change
    expect(await factory.initCodeHash()).to.equal(ethers.keccak256((await ethers.getContractFactory('PviumP2IDVaultProxy')).bytecode));
  });

  it('a vault deployed after the release starts on V2: a contract payer names a refunder, who alone recovers unclaimed deposits', async () => {
    await factory.setAlpha(K, false);
    await releaseV2();
    const { vault, proxy } = await vaultAt(ID_NEW);
    expect(await proxy.implementation()).to.equal(V2);

    // a contract that could never call refund() itself pays and names `refunder`; it stays the funder of record
    const contractPayer = await ethers.deployContract('MockContractPayer');
    await token.mint(contractPayer.target, 100n);
    await expect(contractPayer.pay(vault.target, refunder.address, V, T, 100n, DAY))
      .to.emit(vault, 'Funded').withArgs(0, contractPayer.target, T, 100n, V, Z, DAY, 0, Z);
    await expect(contractPayer.payNative(vault.target, refunder.address, V, DAY, { value: ethers.parseEther('1') }))
      .to.emit(vault, 'Funded').withArgs(1, contractPayer.target, NATIVE, ethers.parseEther('1'), V, Z, DAY, 0, Z);
    // an EOA may name a refunder too; plain fund, a zero refunder and the factory path all keep the payer
    await mintAndApprove(payer, vault.target, 100n);
    await expect(vault.connect(payer).fundWithRefunder(V, T, 50n, Z, DAY, refunder.address, Z))
      .to.emit(vault, 'Funded').withArgs(2, payer.address, T, 50n, V, Z, DAY, 0, Z);
    await vault.connect(payer).fund(T, 20n, Z, DAY, Z);
    await vault.connect(payer).fundWithRefunder(V, T, 30n, Z, DAY, ethers.ZeroAddress, Z);
    await mintAndApprove(payer, factory.target, 10n);
    await factory.connect(payer).fund(ID_NEW, T, 10n, Z, DAY, Z);
    expect(await Promise.all([0, 1, 2, 3, 4, 5].map((i) => vault.depositRefunder(i))))
      .to.deep.equal([refunder.address, refunder.address, refunder.address, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress]);
    expect(await Promise.all([0, 1, 2, 3, 4, 5].map(async (i) => (await vault.deposits(i)).funder)))
      .to.deep.equal([contractPayer.target, contractPayer.target, payer.address, payer.address, payer.address, payer.address]);
    expect(await vault.trackedTotal(T)).to.equal(210n);
    expect(await vault.trackedTotal(NATIVE)).to.equal(ethers.parseEther('1'));

    // the payee claims one deposit as usual; the rest wait out their window
    await vault.refreshProof(V, proofFor(ownerWallet.address, 1000, ID_NEW));
    await vault.connect(stranger).sweepDeposits(V, T, [3]);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(20n);
    await expect(vault.connect(refunder).refund(0)).to.be.revertedWithCustomError(vault, 'RefundNotReady');
    await time.increase(DAY + 1);

    // a named refunder is the only account that can refund, and is the one paid; the funder gave the right away
    await expect(vault.connect(stranger).refund(0)).to.be.revertedWithCustomError(vault, 'NotRefunder');
    await expect(vault.connect(payer).refund(2)).to.be.revertedWithCustomError(vault, 'NotRefunder');
    await expect(vault.connect(refunder).refund(0)).to.emit(vault, 'Refunded').withArgs(0, refunder.address, T, 100n);
    await expect(vault.connect(refunder).refund(2)).to.emit(vault, 'Refunded').withArgs(2, refunder.address, T, 50n);
    expect(await nativeDelta(refunder, () => vault.connect(refunder).refund(1))).to.equal(ethers.parseEther('1'));
    // a plain deposit refunds as in V1: the funder, nobody else
    await expect(vault.connect(refunder).refund(4)).to.be.revertedWithCustomError(vault, 'NotRefunder');
    await expect(vault.connect(payer).refund(3)).to.be.revertedWithCustomError(vault, 'DepositConsumed'); // claimed
    await expect(vault.connect(payer).refund(4)).to.emit(vault, 'Refunded').withArgs(4, payer.address, T, 30n);
    await expect(vault.connect(payer).refund(5)).to.emit(vault, 'Refunded').withArgs(5, payer.address, T, 10n);
    await expect(vault.connect(refunder).refund(0)).to.be.revertedWithCustomError(vault, 'DepositConsumed');
    expect(await token.balanceOf(refunder.address)).to.equal(150n);
    expect(await token.balanceOf(payer.address)).to.equal(40n);
    expect(await token.balanceOf(stranger.address)).to.equal(0n);
    expect(await token.balanceOf(contractPayer.target)).to.equal(0n);
    expect(await vault.trackedTotal(T)).to.equal(0n);
    expect(await token.balanceOf(vault.target)).to.equal(0n);
  });

  it('a refunder changes nothing about claims, constraints or fundFor: the payer stays the funder for all of them', async () => {
    await factory.setAlpha(K, false);
    await policy.setFee(100, deployer.address);
    await releaseV2();
    const { vault } = await vaultAt(ID_NEW);
    const C = ethers.id('screening approval for one payment');
    // a constrained deposit with a refunder reserves the constraint for the payer, not the refunder
    await mintAndApprove(payer, vault.target, 1000n);
    await vault.connect(payer).fundWithRefunder(V, T, 1000n, C, DAY, refunder.address, Z);
    expect(await vault.constraintDeposit(C, payer.address)).to.deep.equal([true, 0n]);
    expect(await vault.constraintDeposit(C, refunder.address)).to.deep.equal([false, 0n]);
    await mintAndApprove(payer, vault.target, 1n);
    await expect(vault.connect(payer).fund(T, 1n, C, DAY, Z)).to.be.revertedWithCustomError(vault, 'ConstraintUsed').withArgs(0);
    await expect(vault.connect(payer).fundWithRefunder(V, T, 1n, C, DAY, stranger.address, Z)).to.be.revertedWithCustomError(vault, 'ConstraintUsed').withArgs(0);
    // nobody can pin a deposit on someone else: fundFor is still the factory's alone
    await expect(vault.connect(stranger).fundFor(payer.address, V, T, 1n, Z, DAY, Z)).to.be.revertedWithCustomError(vault, 'NotFactory');
    // the owner claims it with the constraint approval, fee frozen at funding; then there is nothing to refund
    await vault.refreshProof(V, proofFor(ownerWallet.address, 1000, ID_NEW));
    await vault.connect(stranger).sweepBucket(V, { commitment: C, signature: ethers.hexlify(ethers.toUtf8Bytes('ok')) }, T, proofFor(ownerWallet.address, 1000, ID_NEW), 0);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(990n);
    expect(await token.balanceOf(deployer.address)).to.equal(10n);
    await time.increase(DAY + 1);
    await expect(vault.connect(refunder).refund(0)).to.be.revertedWithCustomError(vault, 'DepositConsumed');
  });

  it('an existing vault keeps V1 rules until its owner upgrades; then fundWithRefunder is available and everything else is intact', async () => {
    await factory.setAlpha(K, false);
    const { vault, proxy } = await vaultAt(ID); // deployed before the release: V1
    expect(await proxy.implementation()).to.equal(V1);
    await fundV1(vault, 100n); // deposit 0
    await vault.connect(payer).fund(NATIVE, ethers.parseEther('2'), Z, DAY, Z, { value: ethers.parseEther('2') }); // deposit 1
    await vault.refreshProof(V, proofFor(ownerWallet.address, 2000));
    // V1 has no refunder entry point: the call reverts with no data, so the SDK must fall back or warn
    await mintAndApprove(payer, vault.target, 1n);
    await expect(vault.connect(payer).fundWithRefunder(V, T, 1n, Z, DAY, refunder.address, Z)).to.be.revertedWithoutReason();
    await time.increase(DAY + 1);
    await expect(vault.connect(stranger).refund(0)).to.be.revertedWithCustomError(vault, 'NotFunder');

    await releaseV2();
    // the release touches no existing proxy: still V1, still V1 rules, and deploy() does not reset it
    expect(await proxy.implementation()).to.equal(V1);
    await factory.deploy(ID);
    expect(await proxy.implementation()).to.equal(V1);
    await expect(vault.connect(payer).fundWithRefunder(V, T, 1n, Z, DAY, refunder.address, Z)).to.be.revertedWithoutReason();

    // only the identity owner moves the vault, with a proof at least as fresh as the one the vault holds
    await expect(proxy.connect(stranger).upgradeTo(ID, V2, proofFor(ownerWallet.address, 2000))).to.be.revertedWithCustomError(proxy, 'NotOwner');
    await expect(proxy.connect(deployer).upgradeTo(ID, V2, proofFor(ownerWallet.address, 2000))).to.be.revertedWithCustomError(proxy, 'NotOwner');
    await expect(proxy.connect(ownerWallet).upgradeTo(ID, V2, proofFor(ownerWallet.address, 1999))).to.be.revertedWithCustomError(proxy, 'ProofTooOld');
    await expect(proxy.connect(ownerWallet).upgradeTo(ID, V2, proofFor(ownerWallet.address, 2000))).to.emit(proxy, 'Upgraded').withArgs(V2);
    expect(await proxy.implementation()).to.equal(V2);
    expect(await factory.vaultFor(ID)).to.equal(vault.target); // same P2ID address

    // storage survived: deposits, totals, owner cache, identity binding, balances; V1 deposits have no refunder
    const d0 = await vault.deposits(0);
    expect([d0.funder, d0.token, d0.amount, d0.consumed, d0.verifier]).to.deep.equal([payer.address, T, 100n, false, V]);
    const d1 = await vault.deposits(1);
    expect([d1.funder, d1.token, d1.amount, d1.consumed]).to.deep.equal([payer.address, NATIVE, ethers.parseEther('2'), false]);
    expect([await vault.depositRefunder(0), await vault.depositRefunder(1)]).to.deep.equal([ethers.ZeroAddress, ethers.ZeroAddress]);
    expect(await vault.trackedTotal(T)).to.equal(100n);
    expect(await vault.trackedTotal(NATIVE)).to.equal(ethers.parseEther('2'));
    expect(await vault.owner(V)).to.equal(ownerWallet.address);
    expect(await vault.latestProofIat(V)).to.equal(2000n);
    expect(await vault.nsHash()).to.equal(NS);
    expect(await vault.saltCommitment()).to.equal(ID);
    expect(await vault.p2idVersion()).to.equal('p2id.vault.v1');
    expect(await token.balanceOf(vault.target)).to.equal(100n);
    expect(await ethers.provider.getBalance(vault.target)).to.equal(ethers.parseEther('2'));

    // refunds of V1 deposits are unchanged: the funder, only the funder, after the window
    await expect(vault.connect(stranger).refund(0)).to.be.revertedWithCustomError(vault, 'NotRefunder');
    await expect(vault.connect(payer).refund(0)).to.emit(vault, 'Refunded').withArgs(0, payer.address, T, 100n);
    expect(await token.balanceOf(payer.address)).to.equal(101n);
    // the owner cache carried over: a proofless sweep still pays the owner
    expect(await nativeDelta(ownerWallet, () => vault.connect(ownerWallet).sweep(V, NATIVE, 0))).to.equal(ethers.parseEther('2'));
    expect(await vault.trackedTotal(T)).to.equal(0n);
    expect(await vault.trackedTotal(NATIVE)).to.equal(0n);
    // the new entry point works on the upgraded vault, and the factory path still works through it
    await expect(vault.connect(payer).fundWithRefunder(V, T, 1n, Z, DAY, refunder.address, Z)).to.emit(vault, 'Funded').withArgs(2, payer.address, T, 1n, V, Z, DAY, 0, Z);
    expect(await vault.depositRefunder(2)).to.equal(refunder.address);
    await mintAndApprove(payer, factory.target, 3n);
    await factory.connect(payer).fund(ID, T, 3n, Z, DAY, Z);
    expect((await vault.deposits(3)).funder).to.equal(payer.address);
    expect(await vault.depositRefunder(3)).to.equal(ethers.ZeroAddress);

    // the owner can move back to V1 (still registered). Downgrade hazard: V1 ignores the refunder table,
    // so a refunder named under V2 loses the right and the payer regains it
    await proxy.connect(ownerWallet).upgradeTo(ID, V1, proofFor(ownerWallet.address, 2000));
    expect(await proxy.implementation()).to.equal(V1);
    await time.increase(DAY + 1);
    await expect(vault.connect(refunder).refund(2)).to.be.revertedWithCustomError(vault, 'NotFunder');
    await vault.connect(payer).refund(2);
    expect(await token.balanceOf(payer.address)).to.equal(101n); // 101 after refund(0), minus the 1 funded, plus its refund
  });

  it('preserves claim history, constrained funds, frozen fees and direct transfers across an upgrade', async () => {
    await factory.setAlpha(K, false);
    await policy.setFee(100, deployer.address);
    await idv.setRevision(7);
    const { vault, proxy } = await vaultAt(ID);
    const c = ethers.id('pre-upgrade-constraint');
    await token.mint(payer.address, 10000n);
    await token.connect(payer).approve(vault.target, 10000n);
    for (const [amount, constraint] of [[1000n, Z], [2000n, Z], [3000n, c], [4000n, Z]] as const) {
      await vault.connect(payer).fund(T, amount, constraint, DAY, Z);
    }
    const proof = proofFor(ownerWallet.address, 2000);
    await vault.refreshProof(V, proof);
    await vault.connect(stranger).sweep(V, T, 1);
    await time.increase(DAY + 1);
    await vault.connect(payer).refund(3);
    await token.connect(payer).transfer(vault.target, 500n);
    await payer.sendTransaction({ to: vault.target, value: 500n });
    async function snapshot() {
      return {
        deposits: await Promise.all([0, 1, 2, 3].map(async id => Array.from(await vault.deposits(id)))),
        binding: [await vault.nsHash(), await vault.saltCommitment(), await vault.factory()],
        cache: [await vault.owner(V), await vault.latestProofIat(V), await vault.ownerRevision(V),
          await vault.ownerVkHash(V), await vault.ownerAlphaRevision(V), await vault.untrackedProofIat()],
        buckets: await Promise.all([Z, c].map(async constraint =>
          [await vault.bucketTotal(V, constraint, T), await vault.bucketCursor(V, constraint, T)])),
        constraint: Array.from(await vault.constraintDeposit(c, payer.address)),
        total: await vault.trackedTotal(T),
        surplus: [await vault.untrackedBalance(T), await vault.untrackedBalance(NATIVE)],
        balances: [await token.balanceOf(vault.target), await ethers.provider.getBalance(vault.target)],
      };
    }
    const before = await snapshot();
    expect(before.buckets[0]).to.deep.equal([2000n, 1n]);
    expect(before.total).to.equal(5000n);
    await releaseV2();
    await proxy.connect(ownerWallet).upgradeTo(ID, V2, proof);
    expect(await snapshot()).to.deep.equal(before);
    // Only the mock quote changes: existing deposits must retain their original fee.
    await policy.setFee(0, deployer.address);
    const ownerTokens = await token.balanceOf(ownerWallet.address);
    const ownerNative = await ethers.provider.getBalance(ownerWallet.address);
    const feeRecipientTokens = await token.balanceOf(deployer.address);
    await expect(vault.connect(stranger).refund(0)).to.be.revertedWithCustomError(vault, 'NotRefunder');
    await expect(vault.connect(payer).refund(0)).to.be.revertedWithCustomError(vault, 'DepositConsumed');
    await expect(vault.connect(payer).refund(3)).to.be.revertedWithCustomError(vault, 'DepositConsumed');
    await expect(vault.sweepBucket(V, { commitment: c, signature: '0x' }, T, proof, 0))
      .to.be.revertedWithCustomError(idv, 'MockConstraintFailed');
    await vault.connect(stranger).sweep(V, T, 1); // resumes at id 1 and includes direct transfer
    expect((await vault.deposits(2)).consumed).to.equal(false);
    await vault.connect(stranger).sweepBucket(V, { commitment: c, signature: ethers.hexlify(ethers.toUtf8Bytes('ok')) }, T, proof, 0);
    await vault.connect(stranger).sweepUntracked(NATIVE);
    expect((await token.balanceOf(ownerWallet.address)) - ownerTokens).to.equal(5450n);
    expect((await ethers.provider.getBalance(ownerWallet.address)) - ownerNative).to.equal(500n);
    expect((await token.balanceOf(deployer.address)) - feeRecipientTokens).to.equal(50n);
    expect(await token.balanceOf(payer.address)).to.equal(3500n);
    expect(await token.balanceOf(stranger.address)).to.equal(0n);
    expect(await vault.trackedTotal(T)).to.equal(0n);
    expect(await token.balanceOf(vault.target)).to.equal(0n);
    expect(await ethers.provider.getBalance(vault.target)).to.equal(0n);
    await expect(vault.sweepDeposits(V, T, [1])).to.be.revertedWithCustomError(vault, 'DepositConsumed');
    await expect(vault.connect(payer).fund(T, 1n, c, DAY, Z)).to.be.revertedWithCustomError(vault, 'ConstraintUsed').withArgs(2);
    await token.connect(payer).approve(vault.target, 100n);
    await expect(vault.connect(payer).fund(T, 100n, Z, DAY, Z)).to.emit(vault, 'Funded')
      .withArgs(4, payer.address, T, 100n, V, Z, DAY, 0, Z);
  });

  it('audit finding closed: nobody but the funder can send an expired deposit back ahead of the owner\'s claim', async () => {
    await factory.setAlpha(K, false);
    const { vault, proxy } = await vaultAt(ID);
    await fundV1(vault, 100n);
    await vault.refreshProof(V, proofFor(ownerWallet.address, 2000));
    await time.increase(DAY + 1);
    await releaseV2();
    await proxy.connect(ownerWallet).upgradeTo(ID, V2, proofFor(ownerWallet.address, 2000));
    // The payer has not asked for a refund. No third party, and not the owner either, can trigger one.
    await expect(vault.connect(stranger).refund(0)).to.be.revertedWithCustomError(vault, 'NotRefunder');
    await expect(vault.connect(ownerWallet).refund(0)).to.be.revertedWithCustomError(vault, 'NotRefunder');
    await vault.connect(ownerWallet).sweepDeposits(V, T, [0]);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(100n);
    expect(await token.balanceOf(payer.address)).to.equal(0n);
    await expect(vault.connect(payer).refund(0)).to.be.revertedWithCustomError(vault, 'DepositConsumed');
  });

  it('a vault whose owner never upgrades runs V1 indefinitely after V2 is the default, next to V2 vaults', async () => {
    await factory.setAlpha(K, false);
    const { vault: old, proxy: oldProxy } = await vaultAt(ID);
    await fundV1(old, 40n);
    await releaseV2();
    const { proxy: fresh } = await vaultAt(ID_NEW);
    expect(await oldProxy.implementation()).to.equal(V1);
    expect(await fresh.implementation()).to.equal(V2);
    await time.increase(DAY + 1);
    await expect(old.connect(stranger).refund(0)).to.be.revertedWithCustomError(old, 'NotFunder');
    await expect(old.connect(payer).fundWithRefunder(V, T, 1n, Z, DAY, refunder.address, Z)).to.be.revertedWithoutReason();
    await old.connect(payer).refund(0);
    expect(await token.balanceOf(payer.address)).to.equal(40n);
  });

  it('a vault never proven can be moved to V2 with any valid owner proof, which becomes its owner proof', async () => {
    await factory.setAlpha(K, false);
    const { vault, proxy } = await vaultAt(ID);
    await fundV1(vault, 10n);
    await releaseV2(false); // opt-in registration without changing the default
    expect(await factory.baseImplementation()).to.equal(V1);
    await proxy.connect(ownerWallet).upgradeTo(ID, V2, proofFor(ownerWallet.address, 500));
    expect(await proxy.implementation()).to.equal(V2);
    expect(await vault.owner(V)).to.equal(ownerWallet.address);
    await vault.connect(stranger).sweep(V, T, 0);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(10n);
  });

  it('with alpha on, as in production: the upgrade needs the attester, V2 keeps the alpha guard, and refunds never need attestation', async () => {
    expect(await factory.isAlpha(K)).to.equal(true);
    const { vault, proxy } = await vaultAt(ID);
    await fundV1(vault, 100n);
    // Business authorization replay protection must survive an implementation change too.
    const oldProof = proofFor(ownerWallet.address, await time.latest());
    const oldAction = vault.interface.encodeFunctionData('refreshProof', [V, oldProof]);
    const oldAuthorization = await authorization(vault.target, stranger.address, oldAction);
    await vault.connect(stranger).refreshProofWithAttestation(V, oldProof, oldAuthorization);
    expect(await vault.alphaNonceUsed(oldAuthorization.nonce)).to.equal(true);
    await releaseV2();
    const iat = await time.latest();
    const proof = proofFor(ownerWallet.address, iat);
    const data = proxy.interface.encodeFunctionData('upgradeTo', [ID, V2, proof]);
    await expect(proxy.connect(ownerWallet).upgradeTo(ID, V2, proof)).to.be.revertedWithCustomError(proxy, 'AlphaAuthorizationRequired');
    await expect(proxy.connect(ownerWallet).upgradeToWithAttestation(ID, V2, proof, await authorization(vault.target, stranger.address, data)))
      .to.be.revertedWithCustomError(factory, 'InvalidAlphaAuthorization'); // signed for another caller
    const a = await authorization(vault.target, ownerWallet.address, data);
    await expect(proxy.connect(ownerWallet).upgradeToWithAttestation(ID, V2, proof, a)).to.emit(proxy, 'Upgraded').withArgs(V2);
    expect(await proxy.alphaUpgradeNonceUsed(a.nonce)).to.equal(true);
    expect(await vault.alphaNonceUsed(oldAuthorization.nonce)).to.equal(true);
    await expect(vault.connect(stranger).refreshProofWithAttestation(V, oldProof, oldAuthorization))
      .to.be.revertedWithCustomError(vault, 'AlphaNonceAlreadyUsed').withArgs(oldAuthorization.nonce);
    expect(await vault.owner(V)).to.equal(ownerWallet.address); // the upgrade proof was applied under attestation

    // the new implementation still enforces alpha on proof-verifying methods
    await expect(vault.refreshProof(V, proofFor(ownerWallet.address, iat + 1))).to.be.revertedWithCustomError(vault, 'AlphaAuthorizationRequired');
    // proofless paths need no attestation: the cached owner is swept, and the named refunder refunds
    await mintAndApprove(payer, vault.target, 5n);
    await vault.connect(payer).fundWithRefunder(V, T, 5n, Z, DAY, refunder.address, Z);
    await vault.connect(stranger).sweepDeposits(V, T, [0]);
    expect(await token.balanceOf(ownerWallet.address)).to.equal(100n);
    await time.increase(DAY + 1);
    await expect(vault.connect(stranger).refund(1)).to.be.revertedWithCustomError(vault, 'NotRefunder');
    await expect(vault.connect(refunder).refund(1)).to.emit(vault, 'Refunded').withArgs(1, refunder.address, T, 5n);
    expect(await token.balanceOf(refunder.address)).to.equal(5n);
  });
});
