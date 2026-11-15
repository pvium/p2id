const {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  Keypair,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} = require("@solana/web3.js");
const fs = require("node:fs");
const os = require("node:os");
const DATA = require("./data.json");

const secretKeyString = fs.readFileSync(
  `${os.homedir()}/.config/solana/id.json`,
  "utf8",
);
const unresolvedPayer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(secretKeyString)),
);
const rpcUrl = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(rpcUrl).hostname)) {
  throw new Error(
    "Solana test clients only allow a local validator RPC endpoint",
  );
}
const connection = new Connection(rpcUrl, "confirmed");

if (!process.env.VERIFIER_PROGRAM_ID) {
  throw new Error(
    "set VERIFIER_PROGRAM_ID to the deployed Sunspot verifier address",
  );
}
const verifierProgramId = new PublicKey(process.env.VERIFIER_PROGRAM_ID);

async function runTest() {
  const payer = await unresolvedPayer;
  try {
    const airdropSignature = await connection.requestAirdrop(
      payer.publicKey,
      2000000000,
    );
    await connection.confirmTransaction(airdropSignature, "confirmed");
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

  const verifierInstruction = new TransactionInstruction({
    keys: [],
    programId: verifierProgramId,
    data: Buffer.concat([proof, publicWitness]),
  });
  const transaction = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }))
    .add(verifierInstruction);

  const signature = await sendAndConfirmTransaction(
    connection,
    transaction,
    [payer],
    { commitment: "confirmed" },
  );
  console.log(`Direct Sunspot verifier transaction succeeded: ${signature}`);
}

runTest().catch((error) => {
  console.error("Direct Sunspot verifier call failed:");
  console.error(error);
  process.exitCode = 1;
});
