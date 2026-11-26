// Check a real proof against the deployed verifier of a cluster, by simulation (nothing is sent).
//
//   yarn verify-proof --cluster <localnet|devnet|mainnet> --proof <file.json>
//
// `file.json` is what circuit/scripts/sunspot-prove.sh writes (or an http-prover Solana attestation):
// base64 `proof` and `publicWitness`, and the wallet and hashes the proof should attest. The script
// calls the P2ID verifier's `verify` with proof || publicWitness, naming the Sunspot program it fronts,
// and compares the attestation it returns with the file. This is the whole on-chain verification path
// (adapter -> Sunspot Groth16 verifier) without a vault, so it needs no alpha approval and no funds.
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { AnchorProvider, Idl, Program, Wallet } from '@coral-xyz/anchor';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { clusterOf, loadEnv } from '../deploy.config';

import { loadDeployer } from './lib/deployer';
import { loadProgramKey } from './lib/programKeys';

const ROOT = resolve(__dirname, '..');
const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const IDENTITY_PREFIX = Buffer.from('p2id.identity.v1');
const WALLET_TYPE = 12;
const ATTESTATION_LEN = 64 + 32 + 32 + 8;

function flags() {
  const args = process.argv.slice(2);
  const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const cluster = value('--cluster');
  const proof = value('--proof');
  if (!cluster || !proof) { console.error('usage: verify-proof --cluster <name> --proof <file.json>'); process.exit(2); }
  return { cluster, proof };
}

const hex = (b: Buffer | Uint8Array) => '0x' + Buffer.from(b).toString('hex');
const identityHash = (type: number, value: string) =>
  createHash('sha256').update(Buffer.concat([IDENTITY_PREFIX, Buffer.from([type]), Buffer.from(value, 'utf8')])).digest();

async function main() {
  const f = flags();
  const cluster = clusterOf(f.cluster);
  loadEnv(ROOT);
  const rpc = process.env[cluster.rpcEnv] ?? cluster.defaultRpc;
  const connection = new Connection(rpc, 'confirmed');
  // The simulation needs a funded fee payer (an unknown account is refused as AccountNotFound), so
  // use the deployer keypair; the transaction is never sent or signed.
  const payer = loadDeployer(cluster.environment);
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: 'confirmed' });

  const doc = JSON.parse(readFileSync(resolve(f.proof), 'utf8'));
  const proof = Buffer.from(doc.proof, 'base64');
  const pw = Buffer.from(doc.publicWitness ?? doc.publicInputs, 'base64');
  const release = JSON.parse(readFileSync(join(ROOT, 'releases.json'), 'utf8'));
  const circuit = release.circuits[String(doc.circuitVersion ?? release.stackCircuit)];
  const zkEntry = circuit.zkVerifier[cluster.environment];
  let zkVerifier: PublicKey;
  if (doc.zkVerifier) zkVerifier = new PublicKey(doc.zkVerifier);
  else {
    const derived = loadProgramKey(release, cluster.environment, 'zkVerifier', doc.circuitVersion ?? release.stackCircuit);
    if (derived) zkVerifier = derived.publicKey;
    else {
      const kp = JSON.parse(readFileSync(resolve(ROOT, process.env.SOL_ZK_VERIFIER_KEYPAIR ?? zkEntry.keypair), 'utf8'));
      zkVerifier = Keypair.fromSecretKey(Uint8Array.from(kp)).publicKey;
    }
  }
  const idl = JSON.parse(readFileSync(join(ROOT, 'target', 'idl', `${circuit.verifierProgram}.json`), 'utf8')) as Idl;
  const verifier: any = new Program(idl, provider);
  const zkProgramData = PublicKey.findProgramAddressSync([zkVerifier.toBytes()], BPF_LOADER_UPGRADEABLE)[0];

  console.log(`cluster ${cluster.name} (${rpc})`);
  console.log(`P2ID verifier ${verifier.programId.toBase58()} -> Sunspot program ${zkVerifier.toBase58()}`);
  console.log(`payload: ${proof.length}-byte proof + ${pw.length}-byte public witness`);

  const ix = await verifier.methods.verify(Buffer.concat([proof, pw]))
    .accounts({ zkVerifier, zkVerifierData: zkProgramData }).instruction();
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })).add(ix);
  tx.feePayer = provider.wallet.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const sim = await connection.simulateTransaction(tx, undefined, false);
  if (sim.value.err) {
    console.error('refused:', JSON.stringify(sim.value.err));
    for (const l of sim.value.logs ?? []) console.error('  ' + l);
    process.exit(1);
  }
  const ret = sim.value.returnData;
  if (!ret || ret.programId !== verifier.programId.toBase58()) throw new Error('verifier returned no attestation');
  const data = Buffer.from(ret.data[0], 'base64');
  if (data.length !== ATTESTATION_LEN) throw new Error(`attestation is ${data.length} bytes, expected ${ATTESTATION_LEN}`);
  const attestation = {
    signerKey: data.subarray(0, 64),
    identityHash: data.subarray(64, 96),
    walletHash: data.subarray(96, 128),
    iat: Number(data.readBigInt64LE(128)),
  };
  console.log(`accepted in ${sim.value.unitsConsumed} compute units`);
  console.log(`  signer key    ${hex(attestation.signerKey)}`);
  console.log(`  identity hash ${hex(attestation.identityHash)}`);
  console.log(`  wallet hash   ${hex(attestation.walletHash)}`);
  console.log(`  iat           ${attestation.iat} (${new Date(attestation.iat * 1000).toISOString()})`);

  const problems: string[] = [];
  if (doc.identityHash && hex(attestation.identityHash) !== doc.identityHash) problems.push(`identity hash differs from the file's ${doc.identityHash}`);
  if (doc.walletHash && hex(attestation.walletHash) !== doc.walletHash) problems.push(`wallet hash differs from the file's ${doc.walletHash}`);
  if (doc.iat && attestation.iat !== doc.iat) problems.push(`iat differs from the file's ${doc.iat}`);
  if (doc.wallet) {
    const expected = identityHash(WALLET_TYPE, doc.wallet);
    if (!expected.equals(attestation.walletHash)) problems.push(`wallet hash is not sha256("p2id.identity.v1" || 12 || "${doc.wallet}")`);
    else console.log(`  wallet        ${doc.wallet} (hash matches: this proof pays that wallet)`);
  }
  if (problems.length) { for (const p of problems) console.error('MISMATCH: ' + p); process.exit(1); }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
