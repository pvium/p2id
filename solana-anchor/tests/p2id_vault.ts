import * as fs from "fs";
import { createHash } from "crypto";
import { expect } from "chai";
import { AnchorProvider, BN, Idl, Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";

const FACTORY_SEED = Buffer.from("p2id-factory");
const VAULT_SEED = Buffer.from("p2id-vault");
const DEPOSIT_SEED = Buffer.from("p2id-deposit");
const SCHEME = Buffer.from("pvium.vault.v1");
const IDENTITY_PREFIX = Buffer.from("p2id.identity.v1");
const WALLET_TYPE = 12;
const ZERO_HASH = new Uint8Array(32);

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

function witness(identityHash: Uint8Array, wallet: string, iat: number): Buffer {
  const values: Buffer[] = [];
  values.push(field(new Uint8Array(32)));
  values.push(field(new Uint8Array(32)));
  values.push(field(new Uint8Array(32)));
  values.push(field(new Uint8Array(32)));
  values.push(field(new Uint8Array(32)));
  values.push(field(new Uint8Array(32)));
  values.push(field(new Uint8Array(new BN(iat).toArray("be", 8))));
  values.push(field(identityHash.subarray(0, 16)));
  values.push(field(identityHash.subarray(16, 32)));
  const hash = walletHash(wallet);
  values.push(field(hash.subarray(0, 16)));
  values.push(field(hash.subarray(16, 32)));

  const count = Buffer.alloc(4);
  count.writeUInt32BE(11);
  const wideCount = Buffer.alloc(8);
  wideCount.writeBigUInt64BE(11n);
  return Buffer.concat([count, wideCount, ...values]);
}

describe("p2id_vault factory and vault PDAs", () => {
  const provider = AnchorProvider.env();
  const idl = JSON.parse(fs.readFileSync("target/idl/p2id_vault.json", "utf8")) as Idl;
  const program: any = new Program(idl as Idl, provider);
  const verifierId = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(fs.readFileSync("target/deploy/test_verifier-keypair.json", "utf8"))
    )
  ).publicKey;
  const policy = Keypair.generate().publicKey;
  const factory = pda([FACTORY_SEED, SCHEME], program.programId);

  const identityHash = createHash("sha256").update("study@vault.test").digest();
  let vault: PublicKey;

  const vaultAccount = () => program.account.vault.fetch(vault);
  const depositAccount = (id: number) =>
    program.account.deposit.fetch(
      pda([DEPOSIT_SEED, vault.toBuffer(), Buffer.from(new BN(id).toArray("le", 8))], program.programId)
    );

  before(async () => {
    vault = pda([VAULT_SEED, identityHash], program.programId);
    if (!(await provider.connection.getAccountInfo(factory))) {
      await program.methods
        .initializeFactory(
          verifierId,
          policy,
          0,
          2,
          Array.from(ZERO_HASH),
          new BN(3600),
          new BN(86400)
        )
        .accounts({ factory, authority: provider.wallet.publicKey, systemProgram: SystemProgram.programId })
        .rpc();
    }
  });

  it("derives one vault PDA per identity and deploys it permissionlessly", async () => {
    const payer = Keypair.generate();
    await provider.connection.requestAirdrop(payer.publicKey, 2_000_000_000);

    if (!(await provider.connection.getAccountInfo(vault))) {
      await program.methods
        .deployVault(Array.from(identityHash))
        .accounts({ factory, vault, payer: payer.publicKey, systemProgram: SystemProgram.programId })
        .signers([payer])
        .rpc();
    }

    const account = await vaultAccount();
    expect(account.identityHash).to.deep.equal(Array.from(identityHash));
    expect(account.factory.equals(factory)).to.equal(true);
  });

  it("enforces the verifier change notice", async () => {
    const other = Keypair.generate().publicKey;
    await program.methods
      .proposeVerifier(other)
      .accounts({ factory, authority: provider.wallet.publicKey, clock: SYSVAR_CLOCK_PUBKEY })
      .rpc();

    let failed = false;
    try {
      await program.methods
        .activateVerifier()
        .accounts({ factory, authority: provider.wallet.publicKey, clock: SYSVAR_CLOCK_PUBKEY })
        .rpc();
    } catch (error: any) {
      failed = true;
      expect(error.message).to.include("Verifier change notice has not elapsed");
    }
    expect(failed).to.equal(true);

    await program.methods
      .cancelVerifierProposal()
      .accounts({ factory, authority: provider.wallet.publicKey, clock: SYSVAR_CLOCK_PUBKEY })
      .rpc();
  });

  it("funds and refunds native deposits without a proof", async () => {
    const funder = Keypair.generate();
    await provider.connection.requestAirdrop(funder.publicKey, 5_000_000_000);
    const before = await provider.connection.getBalance(funder.publicKey);

    await program.methods
      .fundSol(new BN(1_000_000_000), Array.from(ZERO_HASH), new BN(7200), null)
      .accounts({
        factory,
        vault,
        deposit: pda([DEPOSIT_SEED, vault.toBuffer(), Buffer.from(new BN(0).toArray("le", 8))], program.programId),
        funder: funder.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([funder])
      .rpc();

    const deposit = await depositAccount(0);
    expect(deposit.amount.toNumber()).to.equal(1_000_000_000);
    expect(deposit.verifier.equals(verifierId)).to.equal(true);

    await program.methods
      .refundSol(new BN(0))
      .accounts({
        factory,
        vault,
        deposit: pda([DEPOSIT_SEED, vault.toBuffer(), Buffer.from(new BN(0).toArray("le", 8))], program.programId),
        caller: funder.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([funder])
      .rpc();

    expect((await depositAccount(0)).consumed).to.equal(true);
    const after = await provider.connection.getBalance(funder.publicKey);
    expect(after).to.be.greaterThan(before - 200_000_000);
  });

  it("binds the proof to the vault identity and wallet, then blocks replay", async () => {
    const funder = Keypair.generate();
    const owner = Keypair.generate();
    await provider.connection.requestAirdrop(funder.publicKey, 3_000_000_000);
    await provider.connection.requestAirdrop(owner.publicKey, 3_000_000_000);

    await program.methods
      .fundSol(new BN(500_000_000), Array.from(ZERO_HASH), new BN(7200), null)
      .accounts({
        factory,
        vault,
        deposit: pda([DEPOSIT_SEED, vault.toBuffer(), Buffer.from(new BN(1).toArray("le", 8))], program.programId),
        funder: funder.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([funder])
      .rpc();

    const clock = await provider.connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
    const iat = Number(clock!.data.readBigInt64LE(32));
    const wallet = owner.publicKey.toBase58();
    const proof = Buffer.alloc(64, 7);
    const pw = witness(identityHash, wallet, iat);
    const deposit = pda([DEPOSIT_SEED, vault.toBuffer(), Buffer.from(new BN(1).toArray("le", 8))], program.programId);
    const accounts = {
      factory,
      vault,
      deposit,
      owner: owner.publicKey,
      verifierProgram: verifierId,
      policy,
      systemProgram: SystemProgram.programId,
    };

    await program.methods
      .claimSol(new BN(1), wallet, proof, pw)
      .accounts(accounts)
      .signers([owner])
      .rpc();

    const claimedVault = await vaultAccount();
    expect(claimedVault.owner.equals(owner.publicKey)).to.equal(true);
    expect(claimedVault.latestProofIat.toNumber()).to.equal(iat);
    expect((await depositAccount(1)).consumed).to.equal(true);

    await program.methods
      .fundSol(new BN(500_000_000), Array.from(ZERO_HASH), new BN(7200), null)
      .accounts({
        factory,
        vault,
        deposit: pda([DEPOSIT_SEED, vault.toBuffer(), Buffer.from(new BN(2).toArray("le", 8))], program.programId),
        funder: funder.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([funder])
      .rpc();

    let replayFailed = false;
    try {
      await program.methods
        .claimSol(new BN(2), wallet, proof, pw)
        .accounts({
          factory,
          vault,
          deposit: pda([DEPOSIT_SEED, vault.toBuffer(), Buffer.from(new BN(2).toArray("le", 8))], program.programId),
          owner: owner.publicKey,
          verifierProgram: verifierId,
          policy,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
    } catch (error: any) {
      replayFailed = true;
      expect(error.message).to.include("Proof is stale or not newer");
    }
    expect(replayFailed).to.equal(true);
  });
});
