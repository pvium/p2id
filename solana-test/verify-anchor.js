const {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  Keypair,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} = require("@solana/web3.js");
const { createHash } = require("node:crypto");
const DATA = require("./data.json");

const fs = require("fs");
const os = require("os");

// Load your local system wallet instead of a blank random keypair
const secretKeyString = fs.readFileSync(
  `${os.homedir()}/.config/solana/id.json`,
  "utf8",
);
const secretKeyUint8 = Uint8Array.from(JSON.parse(secretKeyString));
const unresolvedPayer = Keypair.fromSecretKey(secretKeyUint8);

// 1. Connect to your running localnet validator
const rpcUrl = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(rpcUrl).hostname)) {
  throw new Error(
    "Solana test clients only allow a local validator RPC endpoint",
  );
}
const connection = new Connection(rpcUrl, "confirmed");

// Configure these to the deployed P2ID verifier program and the Sunspot verifier it fronts.
if (!process.env.P2ID_ANCHOR_PROGRAM_ID) {
  throw new Error(
    "set P2ID_ANCHOR_PROGRAM_ID to the deployed P2ID verifier program address",
  );
}
const anchorProgramId = new PublicKey(process.env.P2ID_ANCHOR_PROGRAM_ID);
if (!process.env.SUNSPOT_VERIFIER_PROGRAM_ID) {
  throw new Error(
    "set SUNSPOT_VERIFIER_PROGRAM_ID to the deployed Sunspot verifier address",
  );
}
const verifierProgramId = new PublicKey(
  process.env.SUNSPOT_VERIFIER_PROGRAM_ID,
);
// The Sunspot program's ProgramData account (upgradeable loader); the verifier checks it has no
// upgrade authority before trusting the program.
const BPF_LOADER_UPGRADEABLE = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);
const verifierProgramData = PublicKey.findProgramAddressSync(
  [verifierProgramId.toBytes()],
  BPF_LOADER_UPGRADEABLE,
)[0];
// Borsh layout of the attestation the verifier returns.
const ATTESTATION_LEN = 64 + 32 + 32 + 8;

async function runTest() {
  const payer = await unresolvedPayer;

  console.log(`Preparing local payer ${payer.publicKey.toBase58()}...`);
  try {
    const airdropSig = await connection.requestAirdrop(
      payer.publicKey,
      2000000000,
    ); // 2 SOL
    await connection.confirmTransaction(airdropSig, "confirmed");
  } catch (error) {
    console.warn(
      "Local airdrop failed; continuing with the payer's existing balance:",
      error,
    );
  }

  if (DATA.network !== "solana") {
    throw new Error(
      'data.json must contain a Solana attestation ("network": "solana")',
    );
  }
  const publicWitnessBase64 = DATA.publicWitness ?? DATA.publicInputs;
  if (
    typeof DATA.proof !== "string" ||
    typeof publicWitnessBase64 !== "string"
  ) {
    throw new Error(
      "data.json must contain base64 proof and public witness fields",
    );
  }

  const proof = Buffer.from(DATA.proof.trim(), "base64");
  const publicWitness = Buffer.from(publicWitnessBase64.trim(), "base64");
  if (proof.length === 0 || publicWitness.length === 0) {
    throw new Error(
      "proof and public witness must decode to non-empty byte arrays",
    );
  }

  const vec = (bytes) => {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  // The verifier interface: verify(proof) where, for the Sunspot-backed verifier, `proof` is the
  // Groth16 proof followed by the public witness, exactly the bytes the Sunspot program takes.
  const discriminator = createHash("sha256")
    .update("global:verify")
    .digest()
    .subarray(0, 8);
  const anchorInstructionData = Buffer.concat([
    discriminator,
    vec(Buffer.concat([proof, publicWitness])),
  ]);

  console.log(
    `Invoking the P2ID verifier with ${proof.length + publicWitness.length} proof bytes...`,
  );

  const verifyInstruction = new TransactionInstruction({
    keys: [
      { pubkey: verifierProgramId, isSigner: false, isWritable: false },
      { pubkey: verifierProgramData, isSigner: false, isWritable: false },
    ],
    programId: anchorProgramId,
    data: anchorInstructionData,
  });

  const transaction = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }))
    .add(verifyInstruction);

  try {
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [payer],
      { commitment: "confirmed" },
    );
    const confirmed = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 1,
    });
    const returnData = confirmed?.meta?.returnData;
    const returnBytes = returnData
      ? Buffer.from(returnData.data[0], returnData.data[1])
      : Buffer.alloc(0);
    if (
      confirmed?.meta?.err ||
      returnData?.programId !== anchorProgramId.toBase58() ||
      returnBytes.length !== ATTESTATION_LEN
    ) {
      throw new Error("The verifier did not return an attestation");
    }
    const attestation = {
      signerKey: returnBytes.subarray(0, 64).toString("hex"),
      identityHash: returnBytes.subarray(64, 96).toString("hex"),
      walletHash: returnBytes.subarray(96, 128).toString("hex"),
      iat: Number(returnBytes.readBigInt64LE(128)),
    };
    console.log(
      `\n✅ SUCCESS! The Sunspot verifier accepted the proof; attestation:`,
    );
    console.log(attestation);
    console.log(`Transaction Signature: ${signature}`);
  } catch (error) {
    console.error("\n❌ TRANSACTION FAILED!");
    console.error("The P2ID verifier call or its Sunspot verifier CPI failed.");
    console.error(error);
    process.exitCode = 1;
  }
}

runTest();
