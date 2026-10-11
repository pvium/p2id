// Activate a deployed circuit version's verifier set: the owner steps, and its recorded status.
//
//   yarn verifier:activate --network base                          # status + the next owner transactions
//   STEPS=approve yarn verifier:activate --network base             # approve in the policy
//   STEPS=approve,release-alpha yarn verifier:activate --network base
//   STEPS=propose-default yarn verifier:activate --network base     # 14-day notice starts
//   STEPS=activate-default yarn verifier:activate --network base    # after the notice
//
// Steps: approve (policy.approveVerifier: payers can fundWith it, its deposits are claimable),
// release-alpha (factory.setAlpha(vkHash, false)), propose-default / activate-default (make it the
// verifier fund() deposits and bare transfers use). When the deployer key is the owner the steps
// are sent; otherwise (a Safe) nothing is sent: the raw transactions are printed and written as one
// Safe Transaction Builder batch to propose and sign in the Safe app. Either way the status in
// deployments/<scheme>.<environment>.circuit-v<N>.<chainId>.json is refreshed from the chain.
// CIRCUIT_VERSION selects the verifier set (default: circuit/version.json).
import { ethers, network } from 'hardhat';
import { readFileSync } from 'fs';
import { join } from 'path';
import { environmentOf } from '../deploy.config';
import {
  STEPS, ownerTx, printStatus, readRecord, readStatus, safeBatchFile, verifierSetFile, writeRecord, writeSafeBatch,
  type ActivationStep, type OwnerTx,
} from './lib/verifierSet';

const ROOT = join(__dirname, '..', '..');

async function main() {
  const environment = environmentOf(network.name);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const scheme: string = process.env.SCHEME ?? JSON.parse(readFileSync(join(ROOT, 'sdks', 'node', 'p2id-core', 'src', 'p2id.json'), 'utf8')).current;
  const circuitVersion = Number(process.env.CIRCUIT_VERSION ?? JSON.parse(readFileSync(join(ROOT, 'circuit', 'version.json'), 'utf8')).circuitVersion);
  const file = verifierSetFile(scheme, environment, circuitVersion, chainId);
  const record = readRecord(file);

  const requested = (process.env.STEPS ?? '').split(',').map((s) => s.trim()).filter(Boolean) as ActivationStep[];
  for (const s of requested) if (!STEPS.includes(s)) throw new Error(`unknown step "${s}" (steps: ${STEPS.join(', ')})`);

  let status = await readStatus(record);
  console.log(`circuit v${circuitVersion} verifier ${record.pviumVerifier} on ${network.name} (factory ${record.factory})`);
  printStatus(status);

  const policyOwner = await (await ethers.getContractAt('PviumP2IDPolicy', record.policy)).owner();
  const factoryOwner = await (await ethers.getContractAt('PviumP2IdVaultFactory', record.factory)).owner();
  const ownerOf = (tx: OwnerTx) => (tx.to.toLowerCase() === record.policy.toLowerCase() ? policyOwner : factoryOwner);
  const [signer] = await ethers.getSigners();

  // Without STEPS: show what each remaining step would send, nothing more.
  const steps = requested.length ? requested : STEPS;
  const pending: OwnerTx[] = [];
  for (const step of steps) {
    const tx = await ownerTx(record, status, step);
    if (typeof tx === 'string') {
      console.log(`\n${step}: ${tx}`);
      continue;
    }
    const owner = ownerOf(tx);
    if (requested.length && signer && signer.address.toLowerCase() === owner.toLowerCase()) {
      console.log(`\n${step}: sending from the owner key ${owner}\n  ${tx.description}`);
      await (await signer.sendTransaction({ to: tx.to, data: tx.data })).wait();
      status = await readStatus(record); // later steps depend on earlier ones (propose needs approve)
      console.log('  done');
    } else {
      console.log(`\n${step}: owner ${owner} sends\n  ${tx.description}\n  to    ${tx.to}\n  value 0\n  data  ${tx.data}`);
      pending.push(tx);
    }
  }

  if (requested.length && pending.length && chainId !== 31337) {
    const batch = safeBatchFile(record, pending.map((t) => t.step).join('+'));
    writeSafeBatch(batch, chainId, `Circuit v${circuitVersion} verifier: ${pending.map((t) => t.step).join(', ')}`, pending);
    console.log(`\nSafe batch for ${pending.map((t) => t.step).join(', ')}: ${batch}`);
    console.log('  Safe app > Transaction Builder > drop the file > create batch > sign; rerun this command after it executes to record the new status.');
  } else if (!requested.length) {
    console.log('\nnothing sent (no STEPS). Set STEPS=<step>[,<step>] to send from the owner key or write a Safe batch.');
  }

  record.status = await readStatus(record);
  if (chainId !== 31337) writeRecord(file, record);
  console.log(`\nrecorded status in ${file}`);
  printStatus(record.status);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
