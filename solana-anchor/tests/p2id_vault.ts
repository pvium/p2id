import * as fs from "fs";
import { createHash } from "crypto";
import { expect } from "chai";
import { AnchorProvider, BN, Idl, Program } from "@coral-xyz/anchor";
import {
  Ed25519Program,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer as splTransfer,
} from "@solana/spl-token";

// Router seeds (programs/p2id_router/src/state.rs) and policy seeds (programs/p2id_policy/src/lib.rs).
const FACTORY_SEED = Buffer.from("p2id.factory.v1");
const VAULT_SEED = Buffer.from("p2id.vault.v1");
const DEPOSIT_SEED = Buffer.from("p2id.deposit.v1");
const VAULT_MINT_SEED = Buffer.from("p2id.vault-mint.v1");
const VERIFIER_SEED = Buffer.from("p2id.verifier.v1");
const IMPL_AUTHORITY_SEED = Buffer.from("p2id.impl-authority.v1");
const POLICY_SEED = Buffer.from("p2id.policy.v1");
const POLICY_MINT_SEED = Buffer.from("p2id.policy-mint.v1");
const FEE_BPS = 25;
const fee = (amount: number) => Math.floor((amount * FEE_BPS) / 10_000);
const net = (amount: number) => amount - fee(amount);
const SCHEME = Buffer.from("pvium.vault.v1");
const IDENTITY_PREFIX = Buffer.from("p2id.identity.v1");
const FACTORY_PARAMS_PREFIX = Buffer.from("p2id.factory.params.v1");
const CONSTRAINT_PREFIX = Buffer.from("p2id.constraint.sol.v1");
const WALLET_TYPE = 12;
const ZERO = new Uint8Array(32);
const NONE = Buffer.alloc(0);
// Privy's production token-signing key (P-256, x || y), as a realistic vector; any key works here.
const PRIVY_KEY = Buffer.concat([
  Buffer.from("lbnZ0Y--2fXDuKq0ZicXk1Ob4svIanCQ3ZL032AIUN4", "base64url"),
  Buffer.from("Os_zTTMZ1EoDr92BhHTTVR4rN-4v8CnOrB7nSSTuuBM", "base64url"),
]);
const OTHER_KEY = Buffer.alloc(64, 9);

type FactoryParams = {
  signerKeys: Buffer[];
  defaultVerifier: PublicKey;
  policy: PublicKey;
  defaultImplementation: PublicKey;
  circuitVersion: number;
  vkHash: Uint8Array;
  minRefundWindow: number;
  maxRefundWindow: number;
};

// Mirrors factory_params_hash in programs/p2id_router/src/hash.rs.
function factoryParamsHash(p: FactoryParams): Buffer {
  const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
  const i64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n)); return b; };
  return createHash("sha256")
    .update(Buffer.concat([
      FACTORY_PARAMS_PREFIX,
      Buffer.from([p.signerKeys.length]),
      ...p.signerKeys,
      p.defaultVerifier.toBuffer(),
      p.policy.toBuffer(),
      p.defaultImplementation.toBuffer(),
      u16(p.circuitVersion),
      Buffer.from(p.vkHash),
      i64(p.minRefundWindow),
      i64(p.maxRefundWindow),
    ]))
    .digest();
}

async function airdrop(provider: AnchorProvider, to: PublicKey, lamports: number): Promise<void> {
  const sig = await provider.connection.requestAirdrop(to, lamports);
  const { blockhash, lastValidBlockHeight } = await provider.connection.getLatestBlockhash();
  await provider.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
}

function pda(seeds: Buffer[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

function walletHash(wallet: string): Uint8Array {
  return createHash("sha256")
    .update(Buffer.concat([IDENTITY_PREFIX, Buffer.from([WALLET_TYPE]), Buffer.from(wallet, "utf8")]))
    .digest();
}

function field(value: Uint8Array): Buffer {
  expect(value.length).to.be.at.most(32);
  const out = Buffer.alloc(32);
  out.set(value, 32 - value.length);
  return out;
}

function witness(identityHash: Uint8Array, wallet: PublicKey, iat: number, signerKey: Buffer = PRIVY_KEY): Buffer {
  const values: Buffer[] = [];
  values.push(field(new Uint8Array(32))); // identity_type
  values.push(field(new Uint8Array(32))); // wallet (EVM address; zero for Solana)
  values.push(field(signerKey.subarray(0, 16))); // signer_x_hi
  values.push(field(signerKey.subarray(16, 32))); // signer_x_lo
  values.push(field(signerKey.subarray(32, 48))); // signer_y_hi
  values.push(field(signerKey.subarray(48, 64))); // signer_y_lo
  values.push(field(new Uint8Array(new BN(iat).toArray("be", 8))));
  values.push(field(identityHash.subarray(0, 16)));
  values.push(field(identityHash.subarray(16, 32)));
  const hash = walletHash(wallet.toBase58());
  values.push(field(hash.subarray(0, 16)));
  values.push(field(hash.subarray(16, 32)));

  const count = Buffer.alloc(4);
  count.writeUInt32BE(11);
  const wideCount = Buffer.alloc(8);
  wideCount.writeBigUInt64BE(11n);
  return Buffer.concat([count, wideCount, ...values]);
}

const PROOF = Buffer.alloc(64, 7); // the test verifier accepts anything; the implementation checks the witness

describe("p2id router + vault implementation", () => {
  const provider = AnchorProvider.env();
  const loadIdl = (name: string) => JSON.parse(fs.readFileSync(`target/idl/${name}.json`, "utf8")) as Idl;
  // The router owns every account and holds every balance; the implementation is the user entry point.
  const router: any = new Program(loadIdl("p2id_router"), provider);
  const impl: any = new Program(loadIdl("p2id_vault"), provider);
  const policyProgram: any = new Program(loadIdl("p2id_policy"), provider);
  const verifierId = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync("target/deploy/test_verifier-keypair.json", "utf8")))
  ).publicKey;
  const payer = (provider.wallet as any).payer as Keypair;
  const implAuthority = pda([IMPL_AUTHORITY_SEED], impl.programId);
  // The fee policy is a PolicyConfig of the policy program: (authority, router program, rate) are its seeds.
  const u16be = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
  const policyPda = (bps: number) => pda([POLICY_SEED, provider.wallet.publicKey.toBuffer(), router.programId.toBuffer(), u16be(bps)], policyProgram.programId);
  const policy = policyPda(FEE_BPS);
  const policyMintPda = (mint: PublicKey) => pda([POLICY_MINT_SEED, policy.toBuffer(), mint.toBuffer()], policyProgram.programId);
  const policyAccount = () => policyProgram.account.policyConfig.fetch(policy);
  // The factory authority is a Squads multisig in production; the test uses the provider keypair.
  const authority = provider.wallet.publicKey;
  const params: FactoryParams = {
    signerKeys: [PRIVY_KEY],
    defaultVerifier: verifierId,
    policy,
    defaultImplementation: impl.programId,
    circuitVersion: 2,
    vkHash: ZERO,
    minRefundWindow: 1,
    maxRefundWindow: 86400,
  };
  const paramsHash = factoryParamsHash(params);
  const factoryPda = (auth: PublicKey, hash: Buffer) => pda([FACTORY_SEED, SCHEME, auth.toBuffer(), hash], router.programId);
  const factory = factoryPda(authority, paramsHash);
  const verifierConfigPda = (f: PublicKey, v: PublicKey) => pda([VERIFIER_SEED, f.toBuffer(), v.toBuffer()], router.programId);
  const verifierConfig = verifierConfigPda(factory, verifierId);
  const initArgs = (p: FactoryParams, hash: Buffer, auth: PublicKey) => [
    auth,
    Array.from(hash),
    p.signerKeys.map((k) => Array.from(k)),
    p.defaultVerifier,
    p.policy,
    p.defaultImplementation,
    p.circuitVersion,
    Array.from(p.vkHash),
    new BN(p.minRefundWindow),
    new BN(p.maxRefundWindow),
  ];
  const admin = { factory, authority, clock: SYSVAR_CLOCK_PUBKEY };
  const verifierAdmin = { factory, verifierConfig, authority, clock: SYSVAR_CLOCK_PUBKEY };
  const configAccount = () => router.account.verifierConfig.fetch(verifierConfig);

  const identityHash = createHash("sha256").update("study@vault.test").digest();
  const vault = pda([VAULT_SEED, factory.toBuffer(), identityHash], router.programId);
  const vaultAccount = () => router.account.vault.fetch(vault);
  const factoryAccount = () => router.account.factory.fetch(factory);
  const depositPda = (id: number) => pda([DEPOSIT_SEED, vault.toBuffer(), Buffer.from(new BN(id).toArray("le", 8))], router.programId);
  const depositAccount = (id: number) => router.account.deposit.fetch(depositPda(id));
  const vaultMintPda = (mint: PublicKey) => pda([VAULT_MINT_SEED, vault.toBuffer(), mint.toBuffer()], router.programId);
  let nextId = 0;

  const fundSolAccounts = (id: number, funder: PublicKey, config: PublicKey) => ({
    factory, verifierConfig: config, vault, deposit: depositPda(id), policy, policyProgram: policyProgram.programId,
    funder, implAuthority, routerProgram: router.programId, systemProgram: SystemProgram.programId,
  });
  const fundSol = async (
    funder: Keypair, lamports: number, window: number, constraint: Uint8Array = ZERO,
    refunder: PublicKey | null = null, config: PublicKey = verifierConfig
  ) => {
    const id = nextId++;
    await impl.methods
      .fundSol(new BN(lamports), Array.from(constraint), new BN(window), refunder, Array.from(ZERO))
      .accounts(fundSolAccounts(id, funder.publicKey, config))
      .signers([funder])
      .rpc();
    return id;
  };
  const claimSolAccounts = (id: number, owner: PublicKey) => ({
    factory, verifierConfig, vault, deposit: depositPda(id), owner, verifierProgram: verifierId, policy, policyProgram: policyProgram.programId,
    instructions: SYSVAR_INSTRUCTIONS_PUBKEY, implAuthority, routerProgram: router.programId,
  });
  const claimSol = (id: number, owner: PublicKey, proof: Buffer, pw: Buffer, pre: any[] = []) =>
    impl.methods.claimSol(new BN(id), proof, pw).accounts(claimSolAccounts(id, owner)).preInstructions(pre).rpc();
  const refreshProof = (owner: PublicKey, pw: Buffer) =>
    impl.methods
      .refreshProof(PROOF, pw)
      .accounts({ factory, vault, verifierConfig, owner, verifierProgram: verifierId, implAuthority, routerProgram: router.programId })
      .rpc();
  // Refunds never pass through an implementation: the refunder calls the router.
  const refundSol = (id: number, caller: Keypair) =>
    router.methods
      .refundSol(new BN(id))
      .accounts({ factory, vault, deposit: depositPda(id), caller: caller.publicKey, systemProgram: SystemProgram.programId })
      .signers([caller])
      .rpc();
  const chainTime = async () => {
    const clock = await provider.connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
    return Number(clock!.data.readBigInt64LE(32));
  };
  const waitPast = async (t: number) => {
    while ((await chainTime()) <= t) await new Promise((r) => setTimeout(r, 400));
  };
  const expectFailure = async (call: Promise<unknown>, message: string) => {
    let failed = false;
    try {
      await call;
    } catch (error: any) {
      failed = true;
      expect(error.message).to.include(message);
    }
    expect(failed).to.equal(true);
  };
  let cachedOwner: Keypair; // the vault's owner after the owner-cache test, under the default verifier
  const otherVerifier = Keypair.generate().publicKey; // proposed but never activated

  before(async () => {
    if (!(await provider.connection.getAccountInfo(policy))) {
      await policyProgram.methods
        .initializePolicy(authority, router.programId, FEE_BPS)
        .accounts({ policy, payer: authority, systemProgram: SystemProgram.programId })
        .rpc();
    }
    if (!(await provider.connection.getAccountInfo(factory))) {
      await router.methods
        .initializeFactory(...initArgs(params, paramsHash, authority))
        .accounts({ factory, verifierConfig, payer: authority, systemProgram: SystemProgram.programId })
        .rpc();
    }
    // PviumP2IDPolicy.setFactory: the policy refuses fees until bound to its factory.
    if ((await policyAccount()).factory.equals(PublicKey.default)) {
      await policyProgram.methods.setFactory().accounts({ policy, authority, factory }).rpc();
    }
  });

  it("quotes the policy rate into every deposit and refuses fees before the factory is bound", async () => {
    const state = await policyAccount();
    expect(state.feeBps).to.equal(FEE_BPS);
    expect(state.factory.equals(factory)).to.equal(true);
    expect(state.vaultProgram.equals(router.programId)).to.equal(true);
    await expectFailure(policyProgram.methods.setFactory().accounts({ policy, authority, factory }).rpc(), "Factory already set");
    await expectFailure(
      policyProgram.methods.initializePolicy(authority, router.programId, 101)
        .accounts({ policy: policyPda(101), payer: authority, systemProgram: SystemProgram.programId })
        .rpc(),
      "Fee exceeds MAX_FEE_BPS"
    );
  });

  it("binds the factory PDA to its authority and terms so a stranger cannot squat it", async () => {
    const stranger = Keypair.generate();
    await airdrop(provider, stranger.publicKey, 2_000_000_000);

    const recorded = await factoryAccount();
    expect(recorded.authority.equals(authority)).to.equal(true);
    expect(recorded.seedAuthority.equals(authority)).to.equal(true);
    expect(Buffer.from(recorded.paramsHash).equals(paramsHash)).to.equal(true);
    expect(recorded.version).to.equal(1);
    expect(recorded.defaultImplementation.equals(impl.programId)).to.equal(true);
    expect(recorded.implementations.length).to.equal(1);
    const config = await configAccount();
    expect(config.allowed).to.equal(true);
    expect(config.verifier.equals(verifierId)).to.equal(true);
    expect(config.signerKeys.length).to.equal(1);

    // Our existing factory cannot be re-created with other terms, whoever pays.
    const theirParams = { ...params, policy: stranger.publicKey, defaultImplementation: stranger.publicKey, circuitVersion: 9 };
    let failed = false;
    try {
      await router.methods
        .initializeFactory(...initArgs(theirParams, paramsHash, authority))
        .accounts({ factory, verifierConfig, payer: stranger.publicKey, systemProgram: SystemProgram.programId })
        .signers([stranger])
        .rpc();
    } catch {
      failed = true;
    }
    expect(failed).to.equal(true);

    // A fresh address whose commitment does not match the arguments is refused by the program.
    const bogusHash = factoryParamsHash({ ...params, circuitVersion: 7 });
    await expectFailure(
      router.methods
        .initializeFactory(...initArgs(theirParams, bogusHash, authority))
        .accounts({ factory: factoryPda(authority, bogusHash), verifierConfig: verifierConfigPda(factoryPda(authority, bogusHash), verifierId), payer: stranger.publicKey, systemProgram: SystemProgram.programId })
        .signers([stranger])
        .rpc(),
      "params_hash does not commit"
    );

    // Their terms with their (correct) commitment land at an unrelated address.
    const theirHash = factoryParamsHash(theirParams);
    const squat = factoryPda(authority, theirHash);
    expect(squat.equals(factory)).to.equal(false);
    await router.methods
      .initializeFactory(...initArgs(theirParams, theirHash, authority))
      .accounts({ factory: squat, verifierConfig: verifierConfigPda(squat, verifierId), payer: stranger.publicKey, systemProgram: SystemProgram.programId })
      .signers([stranger])
      .rpc();
    expect((await factoryAccount()).policy.equals(policy)).to.equal(true);
    expect(pda([VAULT_SEED, squat.toBuffer(), identityHash], router.programId).equals(vault)).to.equal(false);
  });

  it("derives one vault PDA per identity and deploys it permissionlessly on the default implementation", async () => {
    const payer = Keypair.generate();
    await airdrop(provider, payer.publicKey, 2_000_000_000);
    if (!(await provider.connection.getAccountInfo(vault))) {
      await router.methods
        .deployVault(Array.from(identityHash))
        .accounts({ factory, vault, payer: payer.publicKey, systemProgram: SystemProgram.programId })
        .signers([payer])
        .rpc();
    }
    const account = await vaultAccount();
    expect(account.identityHash).to.deep.equal(Array.from(identityHash));
    expect(account.factory.equals(factory)).to.equal(true);
    expect(account.implementation.equals(impl.programId)).to.equal(true);
    expect(account.trackedSol.toNumber()).to.equal(0);
  });

  it("transfers the authority in two steps", async () => {
    const next = Keypair.generate();
    await airdrop(provider, next.publicKey, 1_000_000_000);
    await router.methods.transferAuthority(next.publicKey).accounts(admin).rpc();
    expect((await factoryAccount()).authority.equals(authority)).to.equal(true);

    const impostor = Keypair.generate();
    await expectFailure(
      router.methods.acceptAuthority().accounts({ factory, newAuthority: impostor.publicKey }).signers([impostor]).rpc(),
      "not the pending authority"
    );
    await router.methods.acceptAuthority().accounts({ factory, newAuthority: next.publicKey }).signers([next]).rpc();
    expect((await factoryAccount()).authority.equals(next.publicKey)).to.equal(true);

    // The old authority is out; the new one hands it back for the rest of the suite.
    await expectFailure(router.methods.cancelVerifierProposal().accounts(admin).rpc(), "Unauthorized");
    await router.methods.transferAuthority(authority).accounts({ factory, authority: next.publicKey, clock: SYSVAR_CLOCK_PUBKEY }).signers([next]).rpc();
    await router.methods.acceptAuthority().accounts({ factory, newAuthority: authority }).rpc();
    expect((await factoryAccount()).authority.equals(authority)).to.equal(true);
  });

  it("enforces the verifier change notice; revocation is per verifier and never the default", async () => {
    const other = otherVerifier;
    const otherConfig = verifierConfigPda(factory, other);
    await router.methods
      .proposeVerifier(other, 3, Array.from(ZERO), [Array.from(PRIVY_KEY)])
      .accounts({ factory, verifierConfig: otherConfig, authority, clock: SYSVAR_CLOCK_PUBKEY, systemProgram: SystemProgram.programId })
      .rpc();
    const created = await router.account.verifierConfig.fetch(otherConfig);
    expect(created.allowed).to.equal(false);
    expect(created.circuitVersion).to.equal(3);
    expect((await factoryAccount()).proposedVerifier.equals(other)).to.equal(true);

    await expectFailure(
      router.methods.activateVerifier().accounts({ factory, verifierConfig: otherConfig, authority, clock: SYSVAR_CLOCK_PUBKEY }).rpc(),
      "Verifier change notice has not elapsed"
    );
    await router.methods.cancelVerifierProposal().accounts(admin).rpc();

    // The default verifier cannot be revoked; a verifier that was never activated is not "allowed" to revoke.
    await expectFailure(router.methods.revokeVerifier().accounts(verifierAdmin).rpc(), "cannot be revoked");
    await expectFailure(
      router.methods.revokeVerifier().accounts({ ...verifierAdmin, verifierConfig: otherConfig }).rpc(),
      "not allowed by the factory"
    );
    expect((await configAccount()).allowed).to.equal(true);
  });

  it("enforces the policy change notice", async () => {
    // A new rate is a new PolicyConfig address, proposed like a new policy contract on EVM.
    const policy50 = policyPda(50);
    await policyProgram.methods.initializePolicy(authority, router.programId, 50).accounts({ policy: policy50, payer: authority, systemProgram: SystemProgram.programId }).rpc();
    await router.methods.proposePolicy(policy50).accounts(admin).rpc();
    let pending = await factoryAccount();
    expect(pending.proposedPolicy.equals(policy50)).to.equal(true);
    await expectFailure(router.methods.activatePolicy().accounts(admin).rpc(), "Policy change notice has not elapsed");
    await router.methods.cancelPolicyProposal().accounts(admin).rpc();
    pending = await factoryAccount();
    expect(pending.proposedPolicyEta.toNumber()).to.equal(0);
    expect(pending.policy.equals(policy)).to.equal(true);
  });

  it("enforces the implementation notice (EVM proposeImplementation / registerImplementation)", async () => {
    const candidate = Keypair.generate().publicKey; // a program id; nothing about it is checked until vaults move to it
    await router.methods.proposeImplementation(candidate, true).accounts(admin).rpc();
    let state = await factoryAccount();
    expect(state.proposedImplementation.equals(candidate)).to.equal(true);
    expect(state.proposedImplementationMakeDefault).to.equal(true);
    await expectFailure(router.methods.registerImplementation().accounts(admin).rpc(), "Implementation notice has not elapsed");
    // Only registered implementations can become the default, with or without notice.
    await expectFailure(router.methods.setDefaultImplementation(candidate).accounts(admin).rpc(), "not registered");
    await router.methods.cancelImplementationProposal().accounts(admin).rpc();
    state = await factoryAccount();
    expect(state.proposedImplementationEta.toNumber()).to.equal(0);
    expect(state.implementations.length).to.equal(1);
    expect(state.defaultImplementation.equals(impl.programId)).to.equal(true);
    await router.methods.setDefaultImplementation(impl.programId).accounts(admin).rpc();
  });

  it("enforces the signer key notice", async () => {
    await router.methods.proposeSignerKey(Array.from(OTHER_KEY)).accounts(verifierAdmin).rpc();
    let state = await configAccount();
    expect(Buffer.from(state.proposedSignerKey).equals(OTHER_KEY)).to.equal(true);
    await expectFailure(router.methods.activateSignerKey().accounts(verifierAdmin).rpc(), "Signer key notice has not elapsed");
    await expectFailure(router.methods.proposeSignerKey(Array.from(PRIVY_KEY)).accounts(verifierAdmin).rpc(), "already accepted");
    await router.methods.cancelSignerKeyProposal().accounts(verifierAdmin).rpc();
    state = await configAccount();
    expect(state.proposedSignerKeyEta.toNumber()).to.equal(0);
    expect(state.signerKeys.length).to.equal(1);
  });

  it("gates every funding and settlement behind the vault's implementation PDA", async () => {
    const funder = Keypair.generate();
    await airdrop(provider, funder.publicKey, 2_000_000_000);
    const impostor = Keypair.generate(); // signs as if it were an implementation's authority
    const id = nextId;
    await expectFailure(
      router.methods
        .createDepositSol(new BN(100_000_000), Array.from(ZERO), new BN(7200), null, Array.from(ZERO))
        .accounts({ ...fundSolAccounts(id, funder.publicKey, verifierConfig), implAuthority: impostor.publicKey })
        .signers([funder, impostor])
        .rpc(),
      "not the authority PDA of this vault's implementation"
    );
    expect(await provider.connection.getAccountInfo(depositPda(id))).to.equal(null);
    // The real implementation records it; nobody else can settle it.
    await fundSol(funder, 100_000_000, 7200);
    await expectFailure(
      router.methods
        .settleSol(new BN(id), null)
        .accounts({
          factory, verifierConfig, vault, deposit: depositPda(id), owner: funder.publicKey, policy, policyProgram: policyProgram.programId,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY, implAuthority: impostor.publicKey,
        })
        .signers([impostor])
        .rpc(),
      "not the authority PDA of this vault's implementation"
    );
    await expectFailure(
      router.methods
        .setOwnerCache({ owner: impostor.publicKey, iat: new BN(1) })
        .accounts({ factory, vault, verifierConfig, implAuthority: impostor.publicKey })
        .signers([impostor])
        .rpc(),
      "not the authority PDA of this vault's implementation"
    );
    expect((await vaultAccount()).owner.equals(PublicKey.default)).to.equal(true);
  });

  it("refunds a native deposit only after its window has elapsed", async () => {
    const funder = Keypair.generate();
    await airdrop(provider, funder.publicKey, 5_000_000_000);
    const before = await provider.connection.getBalance(funder.publicKey);

    const longId = await fundSol(funder, 1_000_000_000, 7200);
    const deposit = await depositAccount(longId);
    expect(deposit.amount.toNumber()).to.equal(1_000_000_000);
    expect(deposit.verifier.equals(verifierId)).to.equal(true);
    expect(deposit.feeBps).to.equal(FEE_BPS); // quoted from the policy at funding
    expect((await vaultAccount()).trackedSol.toNumber()).to.equal(1_100_000_000); // plus the gating test's deposit

    // The payee has the whole window: the funder cannot take the deposit back yet.
    await expectFailure(refundSol(longId, funder), "Refund window has not elapsed");

    // A one-second window: refundable once the chain clock has passed funded_at + 1.
    const shortId = await fundSol(funder, 1_000_000_000, 1);
    await waitPast((await depositAccount(shortId)).fundedAt.toNumber() + 1);
    await refundSol(shortId, funder);
    expect((await depositAccount(shortId)).consumed).to.equal(true);
    expect((await vaultAccount()).trackedSol.toNumber()).to.equal(1_100_000_000);
    expect(await provider.connection.getBalance(funder.publicKey)).to.be.greaterThan(before - 1_200_000_000);

    // P2IDVaultV2 fundWithRefunder: the named refunder, not the funder, may refund and is paid.
    const refunder = Keypair.generate();
    await airdrop(provider, refunder.publicKey, 1_000_000_000);
    const namedId = await fundSol(funder, 200_000_000, 1, ZERO, refunder.publicKey);
    expect((await depositAccount(namedId)).refunder.equals(refunder.publicKey)).to.equal(true);
    await waitPast((await depositAccount(namedId)).fundedAt.toNumber() + 1);
    await expectFailure(refundSol(namedId, funder), "not this deposit's refunder");
    const refunderBefore = await provider.connection.getBalance(refunder.publicKey);
    await refundSol(namedId, refunder);
    expect(await provider.connection.getBalance(refunder.publicKey)).to.be.greaterThan(refunderBefore + 190_000_000);

    // fundWith: only verifiers the factory allows; the proposed-but-not-activated one is refused.
    await expectFailure(
      fundSol(funder, 100_000_000, 7200, ZERO, null, verifierConfigPda(factory, otherVerifier)),
      "not allowed by the factory"
    );
    nextId--;
  });

  it("pays the proven wallet whoever submits, caches it, and moves only on a newer proof", async () => {
    const funder = Keypair.generate();
    const owner = Keypair.generate(); // never signs anything: the relayer (provider) submits
    await airdrop(provider, funder.publicKey, 3_000_000_000);
    const iat = await chainTime();
    const pw = witness(identityHash, owner.publicKey, iat);

    const first = await fundSol(funder, 500_000_000, 7200);
    await claimSol(first, owner.publicKey, PROOF, pw);
    expect(await provider.connection.getBalance(owner.publicKey)).to.equal(net(500_000_000));
    let state = await vaultAccount();
    expect(state.owner.equals(owner.publicKey)).to.equal(true);
    expect(state.latestProofIat.toNumber()).to.equal(iat);
    expect(state.ownerVerifier.equals(verifierId)).to.equal(true);
    expect(state.ownerRevision.toNumber()).to.equal(1);
    expect((await depositAccount(first)).consumed).to.equal(true);

    // Proofless claim to the cached owner: no new token, no new proof, still no owner signature.
    const second = await fundSol(funder, 500_000_000, 7200);
    await claimSol(second, owner.publicKey, NONE, NONE);
    expect(await provider.connection.getBalance(owner.publicKey)).to.equal(2 * net(500_000_000));

    const third = await fundSol(funder, 500_000_000, 7200);
    const stranger = Keypair.generate();
    await expectFailure(claimSol(third, owner.publicKey, PROOF, witness(identityHash, owner.publicKey, iat - 1)), "Proof is stale");
    await expectFailure(claimSol(third, stranger.publicKey, NONE, NONE), "not the cached owner");
    await expectFailure(claimSol(third, stranger.publicKey, PROOF, witness(identityHash, stranger.publicKey, iat)), "Proof wallet does not match");
    // A proof naming one wallet cannot pay another.
    await expectFailure(claimSol(third, stranger.publicKey, PROOF, witness(identityHash, owner.publicKey, iat + 1)), "Proof wallet does not match");
    expect((await vaultAccount()).owner.equals(owner.publicKey)).to.equal(true);

    // A newer proof naming a new wallet (the user re-linked their wallet) moves the owner.
    await claimSol(third, stranger.publicKey, PROOF, witness(identityHash, stranger.publicKey, iat + 1));
    state = await vaultAccount();
    expect(state.owner.equals(stranger.publicKey)).to.equal(true);
    expect(state.latestProofIat.toNumber()).to.equal(iat + 1);
    expect(state.ownerRevision.toNumber()).to.equal(2);
    cachedOwner = stranger;
  });

  it("refreshes the owner cache without a payout", async () => {
    const iat = (await vaultAccount()).latestProofIat.toNumber() + 1;
    const fresh = Keypair.generate();
    await refreshProof(fresh.publicKey, witness(identityHash, fresh.publicKey, iat));
    expect((await vaultAccount()).owner.equals(fresh.publicKey)).to.equal(true);
    // Back to the previous owner with an even newer proof, so later tests have a funded cached owner.
    await refreshProof(cachedOwner.publicKey, witness(identityHash, cachedOwner.publicKey, iat + 1));
    expect((await vaultAccount()).owner.equals(cachedOwner.publicKey)).to.equal(true);
  });

  it("lets only the cached owner move the vault, and only to a registered implementation", async () => {
    await airdrop(provider, cachedOwner.publicKey, 100_000_000); // fee payer for its own transactions
    const move = (to: PublicKey, signer: Keypair) =>
      router.methods
        .setVaultImplementation(to)
        .accounts({ factory, vault, verifierConfig, owner: signer.publicKey })
        .signers([signer])
        .rpc();
    await expectFailure(move(Keypair.generate().publicKey, cachedOwner), "not registered");
    const stranger = Keypair.generate();
    await airdrop(provider, stranger.publicKey, 100_000_000);
    await expectFailure(move(impl.programId, stranger), "not the cached owner");
    await move(impl.programId, cachedOwner); // the one registered implementation: a no-op move
    expect((await vaultAccount()).implementation.equals(impl.programId)).to.equal(true);
  });

  it("claims stay possible after the refund window until a refund happens", async () => {
    const funder = Keypair.generate();
    await airdrop(provider, funder.publicKey, 2_000_000_000);
    const id = await fundSol(funder, 300_000_000, 1);
    await waitPast((await depositAccount(id)).fundedAt.toNumber() + 1);
    const before = await provider.connection.getBalance(cachedOwner.publicKey);
    await claimSol(id, cachedOwner.publicKey, NONE, NONE);
    expect(await provider.connection.getBalance(cachedOwner.publicKey)).to.equal(before + net(300_000_000));
    await expectFailure(refundSol(id, funder), "Deposit was already consumed");
    await expectFailure(claimSol(id, cachedOwner.publicKey, NONE, NONE), "Deposit was already consumed");
  });

  it("releases constrained deposits only with a constraint signer's ed25519 signature", async () => {
    const funder = Keypair.generate();
    await airdrop(provider, funder.publicKey, 3_000_000_000);
    const commitment = createHash("sha256").update("screened:payee-ok").digest();

    // No constraint signers yet: a constrained deposit could never be released, so it is refused.
    await expectFailure(fundSol(funder, 100_000_000, 7200, commitment), "Constraints are not supported");
    nextId--;

    const signer = Keypair.generate();
    await router.methods.setConstraintSigner(signer.publicKey, true).accounts(verifierAdmin).rpc();
    expect((await configAccount()).constraintSigners.length).to.equal(1);
    const id = await fundSol(funder, 100_000_000, 7200, commitment);

    const message = Buffer.concat([CONSTRAINT_PREFIX, factory.toBuffer(), commitment]);
    const attest = (kp: Keypair, msg: Buffer) => Ed25519Program.createInstructionWithPrivateKey({ privateKey: kp.secretKey, message: msg });
    await expectFailure(claimSol(id, cachedOwner.publicKey, NONE, NONE), "Constraint not satisfied");
    await expectFailure(claimSol(id, cachedOwner.publicKey, NONE, NONE, [attest(Keypair.generate(), message)]), "Constraint not satisfied");
    await expectFailure(claimSol(id, cachedOwner.publicKey, NONE, NONE, [attest(signer, Buffer.concat([CONSTRAINT_PREFIX, factory.toBuffer(), ZERO]))]), "Constraint not satisfied");

    const before = await provider.connection.getBalance(cachedOwner.publicKey);
    await claimSol(id, cachedOwner.publicKey, NONE, NONE, [attest(signer, message)]);
    expect(await provider.connection.getBalance(cachedOwner.publicKey)).to.equal(before + net(100_000_000));

    await router.methods.setConstraintSigner(signer.publicKey, false).accounts(verifierAdmin).rpc();
    expect((await configAccount()).constraintSigners.length).to.equal(0);
  });

  it("funds, claims, refunds and sweeps SPL tokens, creating the payee's token account on demand", async () => {
    const funder = Keypair.generate();
    await airdrop(provider, funder.publicKey, 3_000_000_000);
    const mint = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    const funderAta = await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, funder.publicKey);
    await mintTo(provider.connection, payer, mint, funderAta.address, payer, 10_000_000);
    const vaultAta = getAssociatedTokenAddressSync(mint, vault, true);
    const vaultMint = vaultMintPda(mint);
    const policyAta = getAssociatedTokenAddressSync(mint, policy, true);

    const fundToken = async (amount: number, window: number) => {
      const id = nextId++;
      await impl.methods
        .fundToken(new BN(amount), Array.from(ZERO), new BN(window), null, Array.from(ZERO))
        .accounts({
          factory, verifierConfig, vault, deposit: depositPda(id), vaultMint, policy, policyProgram: policyProgram.programId, funder: funder.publicKey,
          implAuthority, mint, funderTokenAccount: funderAta.address, vaultTokenAccount: vaultAta, routerProgram: router.programId,
          tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        })
        .signers([funder])
        .rpc();
      return id;
    };
    const tokenAccounts = (id: number, owner: PublicKey) => ({
      factory, verifierConfig, vault, deposit: depositPda(id), vaultMint, payer: provider.wallet.publicKey, owner, verifierProgram: verifierId, mint,
      vaultTokenAccount: vaultAta, ownerTokenAccount: getAssociatedTokenAddressSync(mint, owner),
      policy, policyProgram: policyProgram.programId, policyMint: policyMintPda(mint), policyTokenAccount: policyAta,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY, implAuthority, routerProgram: router.programId, tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    });

    const id = await fundToken(4_000_000, 7200);
    expect((await router.account.vaultMint.fetch(vaultMint)).tracked.toNumber()).to.equal(4_000_000);
    expect(Number((await getAccount(provider.connection, vaultAta)).amount)).to.equal(4_000_000);

    // The cached owner has no token account for this mint; the claim creates it (relayer pays rent).
    await impl.methods.claimToken(new BN(id), NONE, NONE).accounts(tokenAccounts(id, cachedOwner.publicKey)).rpc();
    const ownerAta = getAssociatedTokenAddressSync(mint, cachedOwner.publicKey);
    expect(Number((await getAccount(provider.connection, ownerAta)).amount)).to.equal(net(4_000_000));
    expect(Number((await getAccount(provider.connection, policyAta)).amount)).to.equal(fee(4_000_000));
    expect((await policyProgram.account.policyMint.fetch(policyMintPda(mint))).feesOwed.toNumber()).to.equal(fee(4_000_000));
    expect((await router.account.vaultMint.fetch(vaultMint)).tracked.toNumber()).to.equal(0);

    // Refund after a one-second window, through the router.
    const refundId = await fundToken(1_000_000, 1);
    await waitPast((await depositAccount(refundId)).fundedAt.toNumber() + 1);
    await router.methods
      .refundToken(new BN(refundId))
      .accounts({
        factory, vault, deposit: depositPda(refundId), vaultMint, caller: funder.publicKey, mint,
        vaultTokenAccount: vaultAta, callerTokenAccount: funderAta.address, tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([funder])
      .rpc();
    expect(Number((await getAccount(provider.connection, funderAta.address)).amount)).to.equal(6_000_000);

    // Tokens sent straight to the vault's token account have no deposit record: untracked sweep (router).
    await splTransfer(provider.connection, payer, funderAta.address, vaultAta, funder, 2_500_000);
    await router.methods
      .sweepUntrackedToken()
      .accounts({
        factory, verifierConfig, vault, vaultMint, payer: provider.wallet.publicKey, owner: cachedOwner.publicKey, mint,
        vaultTokenAccount: vaultAta, ownerTokenAccount: ownerAta, policy, policyProgram: policyProgram.programId, policyMint: policyMintPda(mint), policyTokenAccount: policyAta,
        tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .rpc();
    expect(Number((await getAccount(provider.connection, ownerAta)).amount)).to.equal(net(4_000_000) + net(2_500_000));
    expect(Number((await getAccount(provider.connection, vaultAta)).amount)).to.equal(0);

    // The authority withdraws the booked token fees (PviumP2IDPolicy.withdrawFees).
    const owed = fee(4_000_000) + fee(2_500_000);
    expect((await policyProgram.account.policyMint.fetch(policyMintPda(mint))).feesOwed.toNumber()).to.equal(owed);
    const withdraw = (amount: number) =>
      policyProgram.methods.withdrawFeesToken(new BN(amount)).accounts({
        policy, authority, policyMint: policyMintPda(mint), mint, policyTokenAccount: policyAta,
        toTokenAccount: getAssociatedTokenAddressSync(mint, authority), to: authority,
        tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).rpc();
    await expectFailure(withdraw(owed + 1), "Insufficient booked fees");
    await withdraw(owed);
    expect(Number((await getAccount(provider.connection, getAssociatedTokenAddressSync(mint, authority))).amount)).to.equal(owed);
    expect((await policyProgram.account.policyMint.fetch(policyMintPda(mint))).feesOwed.toNumber()).to.equal(0);
  });

  it("sweeps untracked SOL to the cached owner, never touching recorded deposits or rent", async () => {
    const tracked = (await vaultAccount()).trackedSol.toNumber();
    expect(tracked).to.be.greaterThan(0); // the 7200-second deposits from earlier tests
    const sweep = () =>
      router.methods.sweepUntrackedSol().accounts({ factory, verifierConfig, vault, owner: cachedOwner.publicKey, policy, policyProgram: policyProgram.programId }).rpc();
    await expectFailure(sweep(), "Nothing untracked to sweep");

    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vault, lamports: 700_000_000 }));
    await provider.sendAndConfirm(tx);
    const before = await provider.connection.getBalance(cachedOwner.publicKey);
    await sweep();
    expect(await provider.connection.getBalance(cachedOwner.publicKey)).to.equal(before + net(700_000_000));
    const rent = await provider.connection.getMinimumBalanceForRentExemption((await provider.connection.getAccountInfo(vault))!.data.length);
    expect(await provider.connection.getBalance(vault)).to.equal(rent + tracked);

    // Every SOL fee so far is booked on the policy; the authority withdraws it all.
    const owed = (await policyAccount()).feesOwedSol.toNumber();
    expect(owed).to.be.greaterThan(fee(700_000_000));
    const treasury = Keypair.generate().publicKey;
    await policyProgram.methods.withdrawFeesSol(new BN(owed)).accounts({ policy, authority, to: treasury }).rpc();
    expect(await provider.connection.getBalance(treasury)).to.equal(owed);
    expect((await policyAccount()).feesOwedSol.toNumber()).to.equal(0);
    const policyRent = await provider.connection.getMinimumBalanceForRentExemption((await provider.connection.getAccountInfo(policy))!.data.length);
    expect(await provider.connection.getBalance(policy)).to.equal(policyRent);
  });

  it("rejects proofs from keys the verifier does not accept; removal is immediate and invalidates the cache", async () => {
    const funder = Keypair.generate();
    await airdrop(provider, funder.publicKey, 3_000_000_000);
    const id = await fundSol(funder, 100_000_000, 7200);
    const owner = Keypair.generate();
    const iat = (await chainTime()) + 60;
    const claimWith = (key: Buffer) => claimSol(id, owner.publicKey, PROOF, witness(identityHash, owner.publicKey, iat, key));

    // A valid-looking proof over a token signed by some other P-256 key.
    await expectFailure(claimWith(OTHER_KEY), "does not accept");

    // Retire the accepted key: takes effect at once and bumps the revision.
    await router.methods.removeSignerKey(Array.from(PRIVY_KEY)).accounts(verifierAdmin).rpc();
    const state = await configAccount();
    expect(state.signerKeys.length).to.equal(0);
    expect(state.keySetRevision.toNumber()).to.equal(1);

    await expectFailure(claimWith(PRIVY_KEY), "does not accept");
    // The owner cached under the old key set can no longer be paid without a proof, nor move the vault.
    await expectFailure(claimSol(id, cachedOwner.publicKey, NONE, NONE), "Owner cache is stale");
    await expectFailure(
      router.methods.setVaultImplementation(impl.programId).accounts({ factory, vault, verifierConfig, owner: cachedOwner.publicKey }).signers([cachedOwner]).rpc(),
      "Owner cache is stale"
    );
    expect((await depositAccount(id)).consumed).to.equal(false);
    // The deposit is still refundable after its window: the router never depends on the implementation for that.
  });
});
