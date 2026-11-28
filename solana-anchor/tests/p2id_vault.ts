import * as fs from "fs";
import { createHash, generateKeyPairSync } from "crypto";
import { expect } from "chai";
import { AnchorProvider, BN, Idl, Program } from "@coral-xyz/anchor";
import {
  AccountMeta,
  ComputeBudgetProgram,
  Ed25519Program,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  addExtraAccountMetasForExecute,
  calculateFee,
  createInitializeMintInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeTransferFeeConfigInstruction,
  createInitializeTransferHookInstruction,
  createMint,
  createTransferCheckedWithTransferHookInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getExtraAccountMetaAddress,
  getMint,
  getMintLen,
  getOrCreateAssociatedTokenAccount,
  getTransferFeeConfig,
  mintTo,
  transferChecked,
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
const ALPHA_PREFIX = Buffer.from("p2id.alpha.sol.v1");
const ALPHA_ACTION = { ownerUpdate: 1, settle: 2, sweepUntracked: 3, setImplementation: 4 };
// The backend's alpha attester (ed25519); deterministic so the factory address is stable across runs.
const ATTESTER = Keypair.fromSeed(createHash("sha256").update("p2id test alpha attester").digest());
const WALLET_TYPE = 12;
const ZERO = new Uint8Array(32);
const NONE = Buffer.alloc(0);
// Privy's production token-signing key (P-256, x || y), as a realistic vector; any key works here.
const PRIVY_KEY = Buffer.concat([
  Buffer.from("lbnZ0Y--2fXDuKq0ZicXk1Ob4svIanCQ3ZL032AIUN4", "base64url"),
  Buffer.from("Os_zTTMZ1EoDr92BhHTTVR4rN-4v8CnOrB7nSSTuuBM", "base64url"),
]);
const OTHER_KEY = Buffer.alloc(64, 9); // not a P-256 point: only ever appears inside a witness
// A second genuine P-256 key (x || y), as a rotated Privy key would be.
const SECOND_KEY = (() => {
  const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" }) as { x: string; y: string };
  return Buffer.concat([Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
})();
// A realistic Sunspot proof size; the test verifier accepts anything.
const REAL_SIZE_PROOF = Buffer.alloc(388, 3);
const PROOF_BUFFER_SEED = Buffer.from("p2id.proof.v1");

type FactoryParams = {
  signerKeys: Buffer[];
  defaultVerifier: PublicKey;
  policy: PublicKey;
  defaultImplementation: PublicKey;
  alphaAttester: PublicKey;
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
      p.alphaAttester.toBuffer(),
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

const PROOF = Buffer.alloc(64, 7); // the test ZK backend accepts anything; the verifier program checks the witness
const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const programDataAddress = (program: PublicKey) => pda([program.toBuffer()], BPF_LOADER_UPGRADEABLE);
const readonly = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
/// The program accounts the router inspects when it admits a verifier or implementation.
const programPair = (program: PublicKey) => [program, programDataAddress(program)];

describe("p2id router + vault implementation", () => {
  const provider = AnchorProvider.env();
  const loadIdl = (name: string) => JSON.parse(fs.readFileSync(`target/idl/${name}.json`, "utf8")) as Idl;
  // The router owns every account and holds every balance; the implementation is the user entry point.
  const router: any = new Program(loadIdl("p2id_router"), provider);
  const impl: any = new Program(loadIdl("p2id_vault"), provider);
  const policyProgram: any = new Program(loadIdl("p2id_policy"), provider);
  // The verifier the factory allows is the P2ID verifier program; the Sunspot-shaped ZK backend it
  // fronts is the test verifier, which accepts every proof. Both are the verifier's accounts.
  const verifier: any = new Program(loadIdl("p2id_solana_verifier"), provider);
  const verifierId: PublicKey = verifier.programId;
  const zkVerifierId = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync("target/deploy/test_verifier-keypair.json", "utf8")))
  ).publicKey;
  const verifierAccounts = programPair(zkVerifierId).map(readonly);
  const payer = (provider.wallet as any).payer as Keypair;
  // Registers proofs for claims and gets their rent back when they are presented; funded in before().
  const relayer = Keypair.generate();
  const bufferPda = (registerer: PublicKey, payload: Buffer) =>
    pda([PROOF_BUFFER_SEED, registerer.toBuffer(), createHash("sha256").update(payload).digest()], impl.programId);
  // Store `payload` in a proof buffer the registerer pays for, unless an earlier (failed) claim left it there.
  const registerProof = async (payload: Buffer, registerer: Keypair = relayer) => {
    const buffer = bufferPda(registerer.publicKey, payload);
    if (!(await provider.connection.getAccountInfo(buffer))) {
      await impl.methods
        .registerProof(Array.from(createHash("sha256").update(payload).digest()), payload)
        .accounts({ registerer: registerer.publicKey, proofBuffer: buffer, systemProgram: SystemProgram.programId })
        .signers([registerer])
        .rpc();
    }
    return buffer;
  };
  // The router admits only immutable programs; anchor deploys upgradeable ones, so burn the upgrade
  // authority (solana program set-upgrade-authority --final) of what the factory will reference.
  const finalize = async (program: PublicKey) => {
    const programData = programDataAddress(program);
    const info = await provider.connection.getAccountInfo(programData);
    if (info!.data[12] === 0) return; // already immutable
    const ix = new TransactionInstruction({
      programId: BPF_LOADER_UPGRADEABLE,
      keys: [{ pubkey: programData, isSigner: false, isWritable: true }, { pubkey: payer.publicKey, isSigner: true, isWritable: false }],
      data: Buffer.from([4, 0, 0, 0]), // SetAuthority with no new authority
    });
    await provider.sendAndConfirm(new Transaction().add(ix));
  };
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
    alphaAttester: ATTESTER.publicKey,
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
    p.alphaAttester,
    p.circuitVersion,
    Array.from(p.vkHash),
    new BN(p.minRefundWindow),
    new BN(p.maxRefundWindow),
  ];
  const initAccounts = (f: PublicKey, config: PublicKey, payer: PublicKey, verifierProgram = verifierId, implementation: PublicKey = impl.programId) => ({
    factory: f, verifierConfig: config, payer,
    defaultVerifierProgram: verifierProgram, defaultVerifierProgramData: programDataAddress(verifierProgram),
    defaultImplementationProgram: implementation, defaultImplementationProgramData: programDataAddress(implementation),
    systemProgram: SystemProgram.programId,
  });
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
  // A claim takes its proof by reference: one opaque blob (for the Sunspot verifier: proof || witness)
  // registered first, then named as the buffer and its registerer, with the verifier's own accounts
  // passed through as remaining accounts. No proof pays the cached owner.
  const claimSol = async (id: number, owner: PublicKey, proof: Buffer, pw: Buffer, pre: any[] = []) => {
    const payload = Buffer.concat([proof, pw]);
    const buffer = payload.length ? await registerProof(payload) : null;
    return impl.methods.claimSol(new BN(id))
      .accounts({ ...claimSolAccounts(id, owner), proofBuffer: buffer, registerer: buffer ? relayer.publicKey : null })
      .remainingAccounts(payload.length ? verifierAccounts : []).preInstructions(pre).rpc();
  };
  const refreshProof = (owner: PublicKey, pw: Buffer, pre: any[] = []) =>
    impl.methods
      .refreshProof(Buffer.concat([PROOF, pw]))
      // No registered proof: the proof is inline.
      .accounts({ factory, vault, verifierConfig, owner, verifierProgram: verifierId, instructions: SYSVAR_INSTRUCTIONS_PUBKEY, implAuthority, routerProgram: router.programId, proofBuffer: null, registerer: null })
      .remainingAccounts(verifierAccounts)
      .preInstructions(pre)
      .rpc();
  const sweepSol = (owner: PublicKey, pre: any[] = []) =>
    router.methods.sweepUntrackedSol()
      .accounts({ factory, verifierConfig, vault, owner, policy, policyProgram: policyProgram.programId, instructions: SYSVAR_INSTRUCTIONS_PUBKEY })
      .preInstructions(pre).rpc();
  const moveVault = (to: PublicKey, signer: Keypair, pre: any[] = []) =>
    router.methods.setVaultImplementation(to)
      .accounts({ factory, vault, verifierConfig, owner: signer.publicKey, instructions: SYSVAR_INSTRUCTIONS_PUBKEY })
      .signers([signer]).preInstructions(pre).rpc();
  const ed25519 = (kp: Keypair, message: Buffer) => Ed25519Program.createInstructionWithPrivateKey({ privateKey: kp.secretKey, message });
  // What the backend signs to approve one payout while the verifier is in alpha (router require_alpha_attestation).
  const alphaMessage = (p: { destination: PublicKey; iat: number; action: number; subject?: PublicKey; epoch: number; deadline: number; verifier?: PublicKey }) => {
    const i64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
    const digest = createHash("sha256").update(Buffer.concat([
      factory.toBuffer(), vault.toBuffer(), (p.verifier ?? verifierId).toBuffer(), p.destination.toBuffer(), i64(p.iat),
      Buffer.from([p.action]), (p.subject ?? PublicKey.default).toBuffer(), i64(p.epoch),
    ])).digest();
    return Buffer.concat([ALPHA_PREFIX, i64(p.deadline), digest]);
  };
  const alphaAttest = (p: Parameters<typeof alphaMessage>[0], kp: Keypair = ATTESTER) => ed25519(kp, alphaMessage(p));
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
    for (const program of [impl.programId, verifierId, zkVerifierId]) await finalize(program);
    await airdrop(provider, relayer.publicKey, 2_000_000_000);
    if (!(await provider.connection.getAccountInfo(policy))) {
      await policyProgram.methods
        .initializePolicy(authority, router.programId, FEE_BPS)
        .accounts({ policy, payer: authority, systemProgram: SystemProgram.programId })
        .rpc();
    }
    if (!(await provider.connection.getAccountInfo(factory))) {
      await router.methods
        .initializeFactory(...initArgs(params, paramsHash, authority))
        .accounts(initAccounts(factory, verifierConfig, authority))
        .rpc();
    }
    // PviumP2IDPolicy.setFactory: the policy refuses fees until bound to its factory.
    if ((await policyAccount()).factory.equals(PublicKey.default)) {
      await policyProgram.methods.setFactory().accounts({ policy, authority, factory }).rpc();
    }
    // Every verifier starts in alpha (payouts need the attester's approval); most tests exercise the
    // released verifier, and the alpha test puts it back and releases it again.
    if ((await configAccount()).alpha) {
      await router.methods.setAlpha(false).accounts(verifierAdmin).rpc();
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
    const theirParams = { ...params, policy: stranger.publicKey, circuitVersion: 9 };
    let failed = false;
    try {
      await router.methods
        .initializeFactory(...initArgs(theirParams, paramsHash, authority))
        .accounts(initAccounts(factory, verifierConfig, stranger.publicKey))
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
        .accounts(initAccounts(factoryPda(authority, bogusHash), verifierConfigPda(factoryPda(authority, bogusHash), verifierId), stranger.publicKey))
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
      .accounts(initAccounts(squat, verifierConfigPda(squat, verifierId), stranger.publicKey))
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
      router.methods.activateVerifier()
        .accounts({ factory, verifierConfig: otherConfig, authority, clock: SYSVAR_CLOCK_PUBKEY, verifierProgram: other, verifierProgramData: programDataAddress(other) })
        .rpc(),
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
    await expectFailure(
      router.methods.registerImplementation().accounts({ ...admin, program: candidate, programData: programDataAddress(candidate) }).rpc(),
      "Implementation notice has not elapsed"
    );
    // Only registered implementations can become the default, with or without notice.
    await expectFailure(router.methods.setDefaultImplementation(candidate).accounts(admin).rpc(), "not registered");
    await router.methods.cancelImplementationProposal().accounts(admin).rpc();
    state = await factoryAccount();
    expect(state.proposedImplementationEta.toNumber()).to.equal(0);
    expect(state.implementations.length).to.equal(1);
    expect(state.defaultImplementation.equals(impl.programId)).to.equal(true);
    await router.methods.setDefaultImplementation(impl.programId).accounts(admin).rpc();
  });

  it("admits only immutable programs as implementation and verifier", async () => {
    // test_hook is deployed upgradeable (anchor's default) and stands in for a program whose author
    // could still change it. The squat factory address keeps these attempts away from the real one.
    const upgradeable: PublicKey = hook.programId;
    const stranger = Keypair.generate();
    await airdrop(provider, stranger.publicKey, 2_000_000_000);
    const attempt = (p: FactoryParams, verifierProgram = p.defaultVerifier, implementation = p.defaultImplementation) => {
      const hash = factoryParamsHash(p);
      const f = factoryPda(authority, hash);
      return router.methods
        .initializeFactory(...initArgs(p, hash, authority))
        .accounts(initAccounts(f, verifierConfigPda(f, p.defaultVerifier), stranger.publicKey, verifierProgram, implementation))
        .signers([stranger])
        .rpc();
    };
    await expectFailure(attempt({ ...params, circuitVersion: 11, defaultImplementation: upgradeable }), "Implementation program must be deployed and immutable");
    await expectFailure(attempt({ ...params, circuitVersion: 12, defaultVerifier: upgradeable }), "Verifier program must be deployed and immutable");
    // A program id with no program behind it, and a wrong ProgramData account, are refused too.
    await expectFailure(attempt({ ...params, circuitVersion: 13, defaultImplementation: Keypair.generate().publicKey }), "Implementation program must be deployed and immutable");
    const sneaky = { ...initAccounts(factory, verifierConfig, stranger.publicKey), defaultImplementationProgramData: programDataAddress(verifierId) };
    const hash = factoryParamsHash({ ...params, circuitVersion: 14 });
    await expectFailure(
      router.methods.initializeFactory(...initArgs({ ...params, circuitVersion: 14 }, hash, authority))
        .accounts({ ...sneaky, factory: factoryPda(authority, hash), verifierConfig: verifierConfigPda(factoryPda(authority, hash), verifierId) })
        .signers([stranger]).rpc(),
      "Program data account does not belong"
    );
  });

  it("verifier interface: the verifier returns the attestation and refuses other backends and malformed payloads", async () => {
    const owner = Keypair.generate();
    const iat = 1_700_000_000;
    const payload = Buffer.concat([PROOF, witness(identityHash, owner.publicKey, iat)]);
    const [zkVerifier, zkVerifierData] = programPair(zkVerifierId);
    const attestation = await verifier.methods.verify(payload).accounts({ zkVerifier, zkVerifierData }).view();
    expect(Buffer.from(attestation.signerKey).equals(PRIVY_KEY)).to.equal(true);
    expect(Buffer.from(attestation.identityHash).equals(identityHash)).to.equal(true);
    expect(Buffer.from(attestation.walletHash).equals(Buffer.from(walletHash(owner.publicKey.toBase58())))).to.equal(true);
    expect(attestation.iat.toNumber()).to.equal(iat);

    // The ZK backend is fixed at build time: another program, even an executable one, is refused.
    // (rpc, not view: anchor's view loses the error message of a failed simulation.)
    const [otherProgram, otherData] = programPair(hook.programId);
    await expectFailure(verifier.methods.verify(payload).accounts({ zkVerifier: otherProgram, zkVerifierData: otherData }).rpc(), "Not the ZK verifier");
    await expectFailure(verifier.methods.verify(payload).accounts({ zkVerifier, zkVerifierData: otherData }).rpc(), "ZK verifier program is not immutable");
    // A payload without room for a proof in front of the witness, and a witness with a bad header.
    await expectFailure(verifier.methods.verify(payload.subarray(PROOF.length)).accounts({ zkVerifier, zkVerifierData }).rpc(), "not a Groth16 proof");
    const badHeader = Buffer.from(payload);
    badHeader[PROOF.length + 3] = 12;
    await expectFailure(verifier.methods.verify(badHeader).accounts({ zkVerifier, zkVerifierData }).rpc(), "unexpected layout");
    // Through the implementation, the attestation's signer key must still be one the config accepts.
    const funder = Keypair.generate();
    await airdrop(provider, funder.publicKey, 1_000_000_000);
    const id = await fundSol(funder, 100_000_000, 1);
    await expectFailure(claimSol(id, owner.publicKey, PROOF, witness(identityHash, owner.publicKey, (await chainTime()) + 30, OTHER_KEY)), "does not accept");
    const before = await provider.connection.getBalance(vault);
    await expectFailure(claimSol(id, owner.publicKey, NONE, NONE), "not the cached owner");
    await expectFailure(claimSol(id, owner.publicKey, PROOF, witness(Buffer.alloc(32, 42), owner.publicKey, await chainTime())), "Invalid identity hash");
    await expectFailure(claimSol(id, owner.publicKey, PROOF, witness(identityHash, owner.publicKey, (await chainTime()) + 3600)), "in the future");
    expect(await provider.connection.getBalance(vault)).to.equal(before);
    expect((await depositAccount(id)).consumed).to.equal(false);
    expect((await vaultAccount()).owner.equals(PublicKey.default)).to.equal(true);
    // Leave the vault as found: later tests account for every lamport in it.
    await waitPast((await depositAccount(id)).fundedAt.toNumber() + 1);
    await refundSol(id, funder);
  });

  it("enforces the signer key notice and refuses keys that are not P-256 points", async () => {
    // A 64-byte blob that is not on the curve can never match a token signature: refused up front.
    await expectFailure(router.methods.proposeSignerKey(Array.from(OTHER_KEY)).accounts(verifierAdmin).rpc(), "not a point on the P-256 curve");
    const swapped = Buffer.concat([PRIVY_KEY.subarray(32), PRIVY_KEY.subarray(0, 32)]);
    await expectFailure(router.methods.proposeSignerKey(Array.from(swapped)).accounts(verifierAdmin).rpc(), "not a point on the P-256 curve");
    const freshVerifier = Keypair.generate().publicKey;
    await expectFailure(
      router.methods
        .proposeVerifier(freshVerifier, 4, Array.from(ZERO), [Array.from(OTHER_KEY)])
        .accounts({ factory, verifierConfig: verifierConfigPda(factory, freshVerifier), authority, clock: SYSVAR_CLOCK_PUBKEY, systemProgram: SystemProgram.programId })
        .rpc(),
      "not a point on the P-256 curve"
    );

    await router.methods.proposeSignerKey(Array.from(SECOND_KEY)).accounts(verifierAdmin).rpc();
    let state = await configAccount();
    expect(Buffer.from(state.proposedSignerKey).equals(SECOND_KEY)).to.equal(true);
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
        .accounts({ factory, vault, verifierConfig, instructions: SYSVAR_INSTRUCTIONS_PUBKEY, implAuthority: impostor.publicKey })
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

    // A consumed deposit record is dead weight: anyone may close it, the rent goes back to the funder.
    const closeDeposit = (id: number, to: PublicKey) =>
      router.methods.closeDeposit(new BN(id)).accounts({ vault, deposit: depositPda(id), funder: to }).rpc();
    await expectFailure(closeDeposit(longId, funder.publicKey), "not consumed yet");
    await expectFailure(closeDeposit(shortId, Keypair.generate().publicKey), "Unauthorized");
    const depositRent = (await provider.connection.getAccountInfo(depositPda(shortId)))!.lamports;
    const funderBefore = await provider.connection.getBalance(funder.publicKey);
    await closeDeposit(shortId, funder.publicKey);
    expect(await provider.connection.getAccountInfo(depositPda(shortId))).to.equal(null);
    expect(await provider.connection.getBalance(funder.publicKey)).to.equal(funderBefore + depositRent);
    await expectFailure(refundSol(shortId, funder), "AccountNotInitialized");

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
    const move = moveVault;
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
    const attest = ed25519;
    await expectFailure(claimSol(id, cachedOwner.publicKey, NONE, NONE), "Constraint not satisfied");
    await expectFailure(claimSol(id, cachedOwner.publicKey, NONE, NONE, [attest(Keypair.generate(), message)]), "Constraint not satisfied");
    await expectFailure(claimSol(id, cachedOwner.publicKey, NONE, NONE, [attest(signer, Buffer.concat([CONSTRAINT_PREFIX, factory.toBuffer(), ZERO]))]), "Constraint not satisfied");

    const before = await provider.connection.getBalance(cachedOwner.publicKey);
    await claimSol(id, cachedOwner.publicKey, NONE, NONE, [attest(signer, message)]);
    expect(await provider.connection.getBalance(cachedOwner.publicKey)).to.equal(before + net(100_000_000));

    await router.methods.setConstraintSigner(signer.publicKey, false).accounts(verifierAdmin).rpc();
    expect((await configAccount()).constraintSigners.length).to.equal(0);
  });

  it("claims with a registered real-size proof in one legacy transaction and returns the buffer's rent", async () => {
    const funder = Keypair.generate();
    await airdrop(provider, funder.publicKey, 2_000_000_000);
    const id = await fundSol(funder, 100_000_000, 7200);
    const iat = (await vaultAccount()).latestProofIat.toNumber() + 1;
    const payload = Buffer.concat([REAL_SIZE_PROOF, witness(identityHash, cachedOwner.publicKey, iat)]);
    expect(payload.length).to.equal(752); // a Sunspot proof (388) + witness (364)

    // Registered in its own transaction; the relayer pays the rent.
    const relayerBefore = await provider.connection.getBalance(relayer.publicKey);
    const buffer = await registerProof(payload);
    expect(await provider.connection.getBalance(buffer)).to.be.greaterThan(0);
    const claim = (registerer: PublicKey | null) =>
      impl.methods.claimSol(new BN(id))
        .accounts({ ...claimSolAccounts(id, cachedOwner.publicKey), proofBuffer: buffer, registerer })
        .remainingAccounts(verifierAccounts);

    // The buffer travels with its registerer, who gets the rent back.
    await expectFailure(claim(Keypair.generate().publicKey).rpc(), "belongs to another registerer");
    await expectFailure(claim(null).rpc(), "belongs to another registerer");

    // Presented by reference, the claim is a legacy transaction: the proof bytes are not in it.
    const before = await provider.connection.getBalance(cachedOwner.publicKey);
    const { blockhash, lastValidBlockHeight } = await provider.connection.getLatestBlockhash();
    const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(await claim(relayer.publicKey).instruction());
    tx.sign(payer);
    const raw = tx.serialize();
    expect(raw.length).to.be.at.most(1232);
    const sig = await provider.connection.sendRawTransaction(raw);
    await provider.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    expect(await provider.connection.getBalance(cachedOwner.publicKey)).to.equal(before + net(100_000_000));
    expect((await vaultAccount()).latestProofIat.toNumber()).to.equal(iat);
    expect(await provider.connection.getAccountInfo(buffer)).to.equal(null);
    expect(await provider.connection.getBalance(relayer.publicKey)).to.equal(relayerBefore);
  });

  // Token flows run three times: classic SPL Token, Token-2022 with a transfer fee, Token-2022 with a
  // transfer hook. Everything is asserted from what actually arrives, since Token-2022 may take a cut
  // of every transfer, and the programs record and book arrivals, never what was sent.
  type TokenCase = {
    programId: PublicKey;
    createMint: () => Promise<PublicKey>;
    /** The cut the token program itself takes from a transfer of `amount` (0 for classic SPL Token). */
    transferFee: (mint: PublicKey) => Promise<(amount: number) => number>;
    /** Accounts every transfer of this mint needs beyond the token accounts (a transfer hook's). */
    extras: (mint: PublicKey) => Promise<AccountMeta[]>;
    hookTransfers?: (mint: PublicKey) => Promise<number>;
  };
  const budget = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });
  const hook: any = new Program(loadIdl("test_hook"), provider);
  const counterPda = (mint: PublicKey) => pda([Buffer.from("counter"), mint.toBuffer()], hook.programId);
  const createMint2022 = async (extensions: ExtensionType[], init: (mint: PublicKey) => TransactionInstruction[]) => {
    const mint = Keypair.generate();
    const space = getMintLen(extensions);
    const lamports = await provider.connection.getMinimumBalanceForRentExemption(space);
    const tx = new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space, lamports, programId: TOKEN_2022_PROGRAM_ID }),
      ...init(mint.publicKey),
      createInitializeMintInstruction(mint.publicKey, 6, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
    );
    await provider.sendAndConfirm(tx, [mint]);
    return mint.publicKey;
  };
  const classic: TokenCase = {
    programId: TOKEN_PROGRAM_ID,
    createMint: () => createMint(provider.connection, payer, payer.publicKey, null, 6),
    transferFee: async () => () => 0,
    extras: async () => [],
  };
  const withTransferFee: TokenCase = {
    programId: TOKEN_2022_PROGRAM_ID,
    createMint: () =>
      createMint2022([ExtensionType.TransferFeeConfig], (mint) => [
        createInitializeTransferFeeConfigInstruction(mint, payer.publicKey, payer.publicKey, 100, BigInt(1_000_000_000), TOKEN_2022_PROGRAM_ID),
      ]),
    transferFee: async (mint) => {
      const config = getTransferFeeConfig(await getMint(provider.connection, mint, undefined, TOKEN_2022_PROGRAM_ID))!;
      return (amount) => Number(calculateFee(config.newerTransferFee, BigInt(amount)));
    },
    extras: async () => [],
  };
  const withTransferHook: TokenCase = {
    programId: TOKEN_2022_PROGRAM_ID,
    createMint: async () => {
      const mint = await createMint2022([ExtensionType.TransferHook], (m) => [
        createInitializeTransferHookInstruction(m, payer.publicKey, hook.programId, TOKEN_2022_PROGRAM_ID),
      ]);
      await hook.methods
        .initializeExtraAccountMetaList()
        .accounts({ payer: payer.publicKey, extraAccountMetaList: getExtraAccountMetaAddress(mint, hook.programId), mint, counter: counterPda(mint), systemProgram: SystemProgram.programId })
        .rpc();
      return mint;
    },
    transferFee: async () => () => 0,
    // Resolve the hook's extra accounts the way a wallet would; the programs re-resolve them on-chain.
    extras: async (mint) => {
      const probe = new TransactionInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        keys: [vault, mint, vault, vault].map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
        data: Buffer.alloc(0),
      });
      await addExtraAccountMetasForExecute(provider.connection, probe, hook.programId, vault, mint, vault, vault, 1);
      return probe.keys.slice(4);
    },
    hookTransfers: async (mint) => (await hook.account.counter.fetch(counterPda(mint))).transfers.toNumber(),
  };

  const tokenFlow = (label: string, t: TokenCase) =>
    it(`funds, claims, refunds, sweeps and withdraws ${label}, booking only what arrives`, async () => {
      const funder = Keypair.generate();
      await airdrop(provider, funder.publicKey, 3_000_000_000);
      const mint = await t.createMint();
      const tf = await t.transferFee(mint);
      const extras = await t.extras(mint);
      const P = t.programId;
      const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, P);
      const balance = async (address: PublicKey) => Number((await getAccount(provider.connection, address, undefined, P)).amount);
      const funderAta = (await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, funder.publicKey, false, undefined, undefined, P)).address;
      await mintTo(provider.connection, payer, mint, funderAta, payer, 10_000_000, [], undefined, P);
      const vaultAta = ata(vault);
      const vaultMint = vaultMintPda(mint);
      const policyAta = ata(policy);
      const ownerAta = ata(cachedOwner.publicKey);
      const tracked = async () => (await router.account.vaultMint.fetch(vaultMint)).tracked.toNumber();
      const owedToPolicy = async () => (await policyProgram.account.policyMint.fetch(policyMintPda(mint))).feesOwed.toNumber();
      const base = {
        factory, verifierConfig, vault, vaultMint, policy, policyProgram: policyProgram.programId, mint, vaultTokenAccount: vaultAta,
        implAuthority, routerProgram: router.programId, tokenProgram: P, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      };
      const policyBits = { policyMint: policyMintPda(mint), policyTokenAccount: policyAta };
      const fundToken = async (amount: number, window: number) => {
        const id = nextId++;
        await impl.methods
          .fundToken(new BN(amount), Array.from(ZERO), new BN(window), null, Array.from(ZERO))
          .accounts({ ...base, deposit: depositPda(id), funder: funder.publicKey, funderTokenAccount: funderAta })
          .remainingAccounts(extras).preInstructions([budget]).signers([funder]).rpc();
        return id;
      };

      // Fund: the deposit records what reached the vault's token account, not what the funder sent.
      const id = await fundToken(4_000_000, 7200);
      const received = 4_000_000 - tf(4_000_000);
      expect((await depositAccount(id)).amount.toNumber()).to.equal(received);
      expect(await tracked()).to.equal(received);
      expect(await balance(vaultAta)).to.equal(received);

      // Claim: the cached owner has no token account for this mint; the claim creates it (relayer pays rent).
      await impl.methods
        .claimToken(new BN(id))
        .accounts({ ...base, deposit: depositPda(id), payer: provider.wallet.publicKey, owner: cachedOwner.publicKey, verifierProgram: verifierId, ownerTokenAccount: ownerAta, ...policyBits, instructions: SYSVAR_INSTRUCTIONS_PUBKEY, proofBuffer: null, registerer: null })
        .remainingAccounts(extras).preInstructions([budget]).rpc();
      const ownerGot = net(received) - tf(net(received));
      const policyGot = fee(received) - tf(fee(received));
      expect(await balance(ownerAta)).to.equal(ownerGot);
      expect(await balance(policyAta)).to.equal(policyGot);
      expect(await owedToPolicy()).to.equal(policyGot);
      expect(await tracked()).to.equal(0);

      // Refund after a one-second window, through the router.
      const refundId = await fundToken(1_000_000, 1);
      const received2 = 1_000_000 - tf(1_000_000);
      await waitPast((await depositAccount(refundId)).fundedAt.toNumber() + 1);
      const funderBefore = await balance(funderAta);
      await router.methods
        .refundToken(new BN(refundId))
        .accounts({ factory, vault, deposit: depositPda(refundId), vaultMint, caller: funder.publicKey, mint, vaultTokenAccount: vaultAta, callerTokenAccount: funderAta, tokenProgram: P })
        .remainingAccounts(extras).preInstructions([budget]).signers([funder]).rpc();
      expect(await balance(funderAta)).to.equal(funderBefore + received2 - tf(received2));
      expect(await tracked()).to.equal(0);

      // Tokens sent straight to the vault's token account have no deposit record: untracked sweep (router).
      const direct = await createTransferCheckedWithTransferHookInstruction(provider.connection, funderAta, mint, vaultAta, funder.publicKey, BigInt(2_500_000), 6, [], undefined, P);
      await provider.sendAndConfirm(new Transaction().add(direct), [funder]);
      const untracked = 2_500_000 - tf(2_500_000);
      expect(await balance(vaultAta)).to.equal(untracked);
      await router.methods
        .sweepUntrackedToken()
        .accounts({
          factory, verifierConfig, vault, vaultMint, payer: provider.wallet.publicKey, owner: cachedOwner.publicKey, mint, vaultTokenAccount: vaultAta, ownerTokenAccount: ownerAta,
          policy, policyProgram: policyProgram.programId, ...policyBits, tokenProgram: P, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .remainingAccounts(extras).preInstructions([budget]).rpc();
      expect(await balance(ownerAta)).to.equal(ownerGot + net(untracked) - tf(net(untracked)));
      expect(await balance(vaultAta)).to.equal(0);

      // The authority withdraws the booked token fees (PviumP2IDPolicy.withdrawFees).
      const owed = policyGot + fee(untracked) - tf(fee(untracked));
      expect(await owedToPolicy()).to.equal(owed);
      const withdraw = (amount: number) =>
        policyProgram.methods
          .withdrawFeesToken(new BN(amount))
          .accounts({
            policy, authority, policyMint: policyMintPda(mint), mint, policyTokenAccount: policyAta, toTokenAccount: ata(authority), to: authority,
            tokenProgram: P, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
          })
          .remainingAccounts(extras).preInstructions([budget]).rpc();
      await expectFailure(withdraw(owed + 1), "Insufficient booked fees");
      await withdraw(owed);
      expect(await balance(ata(authority))).to.equal(owed - tf(owed));
      expect(await owedToPolicy()).to.equal(0);
      // fund, claim (fee + payout), fund, refund, direct send, sweep (fee + payout), withdraw
      if (t.hookTransfers) expect(await t.hookTransfers(mint)).to.equal(9);
    });
  tokenFlow("classic SPL tokens", classic);
  tokenFlow("Token-2022 with a transfer fee", withTransferFee);
  tokenFlow("Token-2022 with a transfer hook", withTransferHook);

  it("audit reproduction: a Token-2022 permanent delegate drains a recorded deposit without a proof", async () => {
    const delegate = Keypair.generate();
    const funder = Keypair.generate();
    await airdrop(provider, funder.publicKey, 100_000_000);
    const mint = await createMint2022([ExtensionType.PermanentDelegate], (m) => [
      createInitializePermanentDelegateInstruction(m, delegate.publicKey, TOKEN_2022_PROGRAM_ID),
    ]);
    const funderAta = (await getOrCreateAssociatedTokenAccount(
      provider.connection, payer, mint, funder.publicKey, false, undefined, undefined, TOKEN_2022_PROGRAM_ID,
    )).address;
    const delegateAta = (await getOrCreateAssociatedTokenAccount(
      provider.connection, payer, mint, delegate.publicKey, false, undefined, undefined, TOKEN_2022_PROGRAM_ID,
    )).address;
    const amount = 1_000_000;
    await mintTo(provider.connection, payer, mint, funderAta, payer, amount, [], undefined, TOKEN_2022_PROGRAM_ID);
    const vaultAta = getAssociatedTokenAddressSync(mint, vault, true, TOKEN_2022_PROGRAM_ID);
    const vaultMint = vaultMintPda(mint);
    const id = nextId++;
    await impl.methods.fundToken(new BN(amount), Array.from(ZERO), new BN(7200), null, Array.from(ZERO))
      .accounts({
        factory, verifierConfig, vault, vaultMint, policy, policyProgram: policyProgram.programId,
        mint, vaultTokenAccount: vaultAta, funder: funder.publicKey, funderTokenAccount: funderAta,
        deposit: depositPda(id), implAuthority, routerProgram: router.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).signers([funder]).rpc();

    // Only the delegate signs this SPL instruction: no vault call, identity proof, owner signature,
    // refund authorization, or alpha approval. The router never observes the outgoing transfer.
    await transferChecked(provider.connection, payer, vaultAta, mint, delegateAta, delegate,
      amount, 6, [], undefined, TOKEN_2022_PROGRAM_ID);
    expect((await getAccount(provider.connection, vaultAta, undefined, TOKEN_2022_PROGRAM_ID)).amount).to.equal(0n);
    expect((await getAccount(provider.connection, delegateAta, undefined, TOKEN_2022_PROGRAM_ID)).amount).to.equal(BigInt(amount));
    expect((await router.account.vaultMint.fetch(vaultMint)).tracked.toNumber()).to.equal(amount);
    expect((await depositAccount(id)).consumed).to.equal(false);
  });

  it("sweeps untracked SOL to the cached owner, never touching recorded deposits or rent", async () => {
    const tracked = (await vaultAccount()).trackedSol.toNumber();
    expect(tracked).to.be.greaterThan(0); // the 7200-second deposits from earlier tests
    const sweep = () => sweepSol(cachedOwner.publicKey);
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

  it("alpha: every payout under a verifier in alpha needs the attester's approval of that exact action", async () => {
    const funder = Keypair.generate();
    await airdrop(provider, funder.publicKey, 3_000_000_000);
    const owner = cachedOwner.publicKey;
    const a = await fundSol(funder, 200_000_000, 7200);
    const b = await fundSol(funder, 200_000_000, 7200);
    expect((await configAccount()).alpha).to.equal(false);
    const epoch0 = (await factoryAccount()).alphaEpoch.toNumber();
    const revision0 = (await configAccount()).keySetRevision.toNumber();
    expect((await factoryAccount()).alphaAttester.equals(ATTESTER.publicKey)).to.equal(true);

    // Back into alpha: a flaw was found in the live circuit. Approvals and owners cached while the
    // verifier was released are void; the attester now vets every payout.
    await router.methods.setAlpha(true).accounts(verifierAdmin).rpc();
    expect((await configAccount()).alpha).to.equal(true);
    expect((await configAccount()).keySetRevision.toNumber()).to.equal(revision0 + 1);
    let epoch = (await factoryAccount()).alphaEpoch.toNumber();
    expect(epoch).to.equal(epoch0 + 1);
    await expectFailure(claimSol(a, owner, NONE, NONE), "Owner cache is stale");

    // Re-proving the owner needs the attester's approval of this owner update (owner + iat).
    const iat = (await vaultAccount()).latestProofIat.toNumber() + 1;
    const pw = witness(identityHash, owner, iat);
    const deadline = (await chainTime()) + 120;
    const update = { destination: owner, iat, action: ALPHA_ACTION.ownerUpdate, epoch, deadline };
    await expectFailure(refreshProof(owner, pw), "Verifier is in alpha");
    await expectFailure(refreshProof(owner, pw, [alphaAttest(update, Keypair.generate())]), "Verifier is in alpha");
    await expectFailure(refreshProof(owner, pw, [alphaAttest({ ...update, iat: iat + 1 })]), "Verifier is in alpha");
    await expectFailure(refreshProof(owner, pw, [alphaAttest({ ...update, action: ALPHA_ACTION.settle })]), "Verifier is in alpha");
    await expectFailure(refreshProof(owner, pw, [alphaAttest({ ...update, deadline: (await chainTime()) - 1 })]), "has expired");
    await refreshProof(owner, pw, [alphaAttest(update)]);
    expect((await vaultAccount()).latestProofIat.toNumber()).to.equal(iat);

    // A proofless settlement is bound to its deposit: the approval for one cannot release another.
    const settle = (id: number) => ({ destination: owner, iat, action: ALPHA_ACTION.settle, subject: depositPda(id), epoch, deadline });
    await expectFailure(claimSol(a, owner, NONE, NONE), "Verifier is in alpha");
    await expectFailure(claimSol(a, owner, NONE, NONE, [alphaAttest(settle(b))]), "Verifier is in alpha");
    let before = await provider.connection.getBalance(owner);
    await claimSol(a, owner, NONE, NONE, [alphaAttest(settle(a))]);
    expect(await provider.connection.getBalance(owner)).to.equal(before + net(200_000_000));

    // Untracked sweeps and the implementation move are payouts too.
    await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vault, lamports: 100_000_000 })));
    await expectFailure(sweepSol(owner), "Verifier is in alpha");
    before = await provider.connection.getBalance(owner);
    await sweepSol(owner, [alphaAttest({ destination: owner, iat, action: ALPHA_ACTION.sweepUntracked, epoch, deadline })]);
    expect(await provider.connection.getBalance(owner)).to.equal(before + net(100_000_000));
    await expectFailure(moveVault(impl.programId, cachedOwner), "Verifier is in alpha");
    await moveVault(impl.programId, cachedOwner, [alphaAttest({ destination: owner, iat, action: ALPHA_ACTION.setImplementation, subject: impl.programId, epoch, deadline })]);

    // Rotating the attester voids approvals signed under the old epoch; the new attester's work.
    const attester2 = Keypair.generate();
    await expectFailure(router.methods.setAlphaAttester(PublicKey.default).accounts(admin).rpc(), "nonzero key");
    await router.methods.setAlphaAttester(attester2.publicKey).accounts(admin).rpc();
    expect((await factoryAccount()).alphaAttester.equals(attester2.publicKey)).to.equal(true);
    expect((await factoryAccount()).alphaEpoch.toNumber()).to.equal(epoch + 1);
    await expectFailure(claimSol(b, owner, NONE, NONE, [alphaAttest(settle(b))]), "Verifier is in alpha");
    epoch += 1;
    await expectFailure(claimSol(b, owner, NONE, NONE, [alphaAttest(settle(b))]), "Verifier is in alpha");
    before = await provider.connection.getBalance(owner);
    await claimSol(b, owner, NONE, NONE, [alphaAttest(settle(b), attester2)]);
    expect(await provider.connection.getBalance(owner)).to.equal(before + net(200_000_000));

    // Releasing the verifier bumps the epoch but keeps the owners vetted in alpha: proofless payouts resume unattended.
    await router.methods.setAlpha(false).accounts(verifierAdmin).rpc();
    expect((await configAccount()).alpha).to.equal(false);
    expect((await configAccount()).keySetRevision.toNumber()).to.equal(revision0 + 1);
    expect((await factoryAccount()).alphaEpoch.toNumber()).to.equal(epoch + 1);
    const c = await fundSol(funder, 100_000_000, 7200);
    before = await provider.connection.getBalance(owner);
    await claimSol(c, owner, NONE, NONE);
    expect(await provider.connection.getBalance(owner)).to.equal(before + net(100_000_000));
    await router.methods.setAlphaAttester(ATTESTER.publicKey).accounts(admin).rpc();
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
    const revision = (await configAccount()).keySetRevision.toNumber();
    await router.methods.removeSignerKey(Array.from(PRIVY_KEY)).accounts(verifierAdmin).rpc();
    const state = await configAccount();
    expect(state.signerKeys.length).to.equal(0);
    expect(state.keySetRevision.toNumber()).to.equal(revision + 1);

    await expectFailure(claimWith(PRIVY_KEY), "does not accept");
    // The owner cached under the old key set can no longer be paid without a proof, nor move the vault.
    await expectFailure(claimSol(id, cachedOwner.publicKey, NONE, NONE), "Owner cache is stale");
    await expectFailure(moveVault(impl.programId, cachedOwner), "Owner cache is stale");
    expect((await depositAccount(id)).consumed).to.equal(false);
    // The deposit is still refundable after its window: the router never depends on the implementation for that.
  });

  // A Sunspot proof (~750 bytes) and an alpha approval don't fit one transaction, so the proof is
  // registered in a buffer first and refresh_proof reads it from there.
  describe("registered proofs", () => {
    // A second factory (other terms, so another PDA) with its verifier left in alpha, as a new stack's is.
    const paramsV2: FactoryParams = { ...params, maxRefundWindow: params.maxRefundWindow + 1 };
    const hashV2 = factoryParamsHash(paramsV2);
    const factoryV2 = factoryPda(authority, hashV2);
    const configV2 = verifierConfigPda(factoryV2, verifierId);
    const identityV2 = createHash("sha256").update("buffer@vault.test").digest();
    const vaultV2 = pda([VAULT_SEED, factoryV2.toBuffer(), identityV2], router.programId);
    const relayer = Keypair.generate(); // registers proofs and gets their rent back
    const stranger = Keypair.generate();

    const register = (registerer: Keypair, payload: Buffer, hash = createHash("sha256").update(payload).digest()) =>
      impl.methods
        .registerProof(Array.from(hash), payload)
        .accounts({ registerer: registerer.publicKey, proofBuffer: pda([PROOF_BUFFER_SEED, registerer.publicKey.toBuffer(), hash], impl.programId), systemProgram: SystemProgram.programId })
        .signers([registerer])
        .rpc();
    const refreshAccounts = (owner: PublicKey, proofBuffer: PublicKey | null, registerer: PublicKey | null) => ({
      factory: factoryV2, vault: vaultV2, verifierConfig: configV2, owner, verifierProgram: verifierId,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY, implAuthority, routerProgram: router.programId,
      proofBuffer, registerer,
    });
    const refreshIx = (owner: PublicKey, inline: Buffer, proofBuffer: PublicKey | null, registerer: PublicKey | null) =>
      impl.methods.refreshProof(inline).accounts(refreshAccounts(owner, proofBuffer, registerer))
        .remainingAccounts(verifierAccounts).instruction();
    // The alpha attester's approval of an owner update on the v2 factory's vault.
    const approveOwner = async (owner: PublicKey, iat: number) => {
      const epoch = (await router.account.factory.fetch(factoryV2)).alphaEpoch.toNumber();
      const deadline = (await chainTime()) + 120;
      const i64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
      const digest = createHash("sha256").update(Buffer.concat([
        factoryV2.toBuffer(), vaultV2.toBuffer(), verifierId.toBuffer(), owner.toBuffer(), i64(iat),
        Buffer.from([ALPHA_ACTION.ownerUpdate]), PublicKey.default.toBuffer(), i64(epoch),
      ])).digest();
      return ed25519(ATTESTER, Buffer.concat([ALPHA_PREFIX, i64(deadline), digest]));
    };
    const budget = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });
    const send = async (instructions: TransactionInstruction[]) => {
      const { blockhash, lastValidBlockHeight } = await provider.connection.getLatestBlockhash();
      const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(...instructions);
      tx.sign(payer);
      const raw = tx.serialize();
      const sig = await provider.connection.sendRawTransaction(raw);
      await provider.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      return raw.length;
    };

    before(async () => {
      if (!(await provider.connection.getAccountInfo(factoryV2))) {
        await router.methods
          .initializeFactory(...initArgs(paramsV2, hashV2, authority))
          .accounts(initAccounts(factoryV2, configV2, authority))
          .rpc();
      }
      if (!(await provider.connection.getAccountInfo(vaultV2))) {
        await router.methods.deployVault(Array.from(identityV2))
          .accounts({ factory: factoryV2, vault: vaultV2, payer: authority, systemProgram: SystemProgram.programId })
          .rpc();
      }
      await airdrop(provider, relayer.publicKey, 1_000_000_000);
      await airdrop(provider, stranger.publicKey, 1_000_000_000);
    });

    it("presents a registered real-size proof beside an alpha approval, then returns the buffer's rent", async () => {
      expect((await router.account.verifierConfig.fetch(configV2)).alpha).to.equal(true);
      expect((await router.account.vault.fetch(vaultV2)).implementation.equals(impl.programId)).to.equal(true);
      const owner = Keypair.generate().publicKey;
      const iat = (await chainTime()) - 10;
      const payload = Buffer.concat([REAL_SIZE_PROOF, witness(identityV2, owner, iat)]);
      expect(payload.length).to.equal(752); // a Sunspot proof (388) + witness (364)

      // Inline, the proof and the approval don't fit one transaction.
      const inline = await refreshIx(owner, payload, null, null);
      const approval = await approveOwner(owner, iat);
      const { blockhash, lastValidBlockHeight } = await provider.connection.getLatestBlockhash();
      const tooBig = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(budget, approval, inline);
      tooBig.sign(payer);
      expect(() => tooBig.serialize()).to.throw(/too large/i);

      // Registered first (its own transaction), then presented by reference.
      const relayerBefore = await provider.connection.getBalance(relayer.publicKey);
      await register(relayer, payload);
      const buffer = bufferPda(relayer.publicKey, payload);
      const stored = await impl.account.proofBuffer.fetch(buffer);
      expect(stored.registerer.equals(relayer.publicKey)).to.equal(true);
      expect(Buffer.from(stored.payload).equals(payload)).to.equal(true);
      const rent = await provider.connection.getBalance(buffer);
      expect(rent).to.be.greaterThan(0);

      const size = await send([budget, await approveOwner(owner, iat), await refreshIx(owner, NONE, buffer, relayer.publicKey)]);
      expect(size).to.be.at.most(1232);
      const cached = await router.account.vault.fetch(vaultV2);
      expect(cached.owner.equals(owner)).to.equal(true);
      expect(cached.latestProofIat.toNumber()).to.equal(iat);
      // Closed, and the relayer has its rent back (the provider paid the transaction fees).
      expect(await provider.connection.getAccountInfo(buffer)).to.equal(null);
      expect(await provider.connection.getBalance(relayer.publicKey)).to.equal(relayerBefore);
    });

    it("refuses another registerer, a buffer with an inline proof, and a payload that isn't its hash", async () => {
      const owner = Keypair.generate().publicKey;
      const iat = (await chainTime()) - 5;
      const payload = Buffer.concat([REAL_SIZE_PROOF, witness(identityV2, owner, iat)]);
      await register(relayer, payload);
      const buffer = bufferPda(relayer.publicKey, payload);

      await expectFailure(send([await refreshIx(owner, NONE, buffer, stranger.publicKey)]), "belongs to another registerer");
      await expectFailure(send([await refreshIx(owner, NONE, buffer, null)]), "belongs to another registerer");
      await expectFailure(send([await refreshIx(owner, PROOF, buffer, relayer.publicKey)]), "not both");
      await expectFailure(send([await refreshIx(owner, NONE, null, relayer.publicKey)]), "not both");
      await expectFailure(send([await refreshIx(owner, NONE, null, null)]), "Proof is empty");
      // The address commits to the payload: a hash that isn't the payload's is refused (a hash no
      // buffer uses yet, so the account is created and the program's own check runs).
      const unregistered = createHash("sha256").update(Buffer.alloc(752, 8)).digest();
      await expectFailure(register(relayer, Buffer.alloc(752, 9), unregistered), "does not match its address or hash");
      expect(await provider.connection.getAccountInfo(buffer)).to.not.equal(null);
    });

    it("lets only the registerer close an unused proof, returning its rent", async () => {
      const payload = Buffer.concat([REAL_SIZE_PROOF, witness(identityV2, stranger.publicKey, (await chainTime()) - 1)]);
      await register(relayer, payload);
      const buffer = bufferPda(relayer.publicKey, payload);
      const rent = await provider.connection.getBalance(buffer);
      const close = (signer: Keypair) =>
        impl.methods.closeProof().accounts({ registerer: signer.publicKey, proofBuffer: buffer }).signers([signer]).rpc();

      await expectFailure(close(stranger), "belongs to another registerer");
      const before = await provider.connection.getBalance(relayer.publicKey);
      await close(relayer);
      expect(await provider.connection.getAccountInfo(buffer)).to.equal(null);
      expect(await provider.connection.getBalance(relayer.publicKey)).to.equal(before + rent);
    });
  });
});
