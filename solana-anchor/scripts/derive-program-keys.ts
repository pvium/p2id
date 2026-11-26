import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { envFor, loadEnv, type Environment } from '../deploy.config';
import { checkProgramKeyFile, loadProgramKey, writeProgramKey, type ProgramRole } from './lib/programKeys';
import { programIdEdits } from './lib/programIds';

const ROOT = resolve(__dirname, '..');

function main() {
  const args = process.argv.slice(2);
  const environment = args[0] as Environment;
  const sync = args[1] === '--sync';
  const write = args[1] === '--write' || sync;
  if (!['sandbox', 'production'].includes(environment) || args.length > 2 || (args[1] && !write))
    throw new Error('usage: yarn keys:derive <sandbox|production> [--write|--sync]');
  loadEnv(ROOT);
  const manifest = JSON.parse(readFileSync(join(ROOT, 'releases.json'), 'utf8'));
  const circuit = manifest.circuits[String(manifest.stackCircuit)];
  const expand = (path: string) => path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
  const directory = expand(envFor('SOL_PROGRAM_KEYPAIR_DIR', environment, { shared: true }) ?? join(ROOT, 'target', 'deploy'));
  const entries: [ProgramRole, string][] = [
    ['router', join(directory, `${manifest.programs.router}-keypair.json`)],
    ['policy', join(directory, `${manifest.programs.policy}-keypair.json`)],
    ['implementation', join(directory, `${manifest.programs.implementation}-keypair.json`)],
    ['verifier', join(directory, `${circuit.verifierProgram}-keypair.json`)],
    ['zkVerifier', expand(envFor('SOL_ZK_VERIFIER_KEYPAIR', environment, { shared: true }) ?? resolve(ROOT, circuit.zkVerifier[environment].keypair))],
  ];
  const keys = entries.map(([role, path]) => {
    const keypair = loadProgramKey(manifest, environment, role);
    if (!keypair) throw new Error(`SOL_PROGRAM_MASTER_SEED_${environment === 'sandbox' ? 'SANDBOX' : 'PROD'} is required`);
    return { role, path, keypair };
  });
  if (new Set(keys.map(({ path }) => resolve(path))).size !== keys.length)
    throw new Error('Program keypair output paths must be distinct');
  if (write) keys.forEach(({ path, keypair }) => checkProgramKeyFile(path, keypair));
  const edits = sync ? programIdEdits(ROOT, {
    [manifest.programs.router]: keys[0].keypair.publicKey,
    [manifest.programs.policy]: keys[1].keypair.publicKey,
    [manifest.programs.implementation]: keys[2].keypair.publicKey,
    [circuit.verifierProgram]: keys[3].keypair.publicKey,
  }, keys[4].keypair.publicKey, environment) : [];
  for (const { role, path, keypair } of keys) {
    if (write) writeProgramKey(path, keypair);
    console.log(`${role}: ${keypair.publicKey.toBase58()}${write ? ` -> ${path}` : ''}`);
  }
  for (const { path, content } of edits) writeFileSync(path, content);
  if (sync) console.log('Synced program declarations, Anchor cluster IDs and the build-time ZK verifier ID. Rebuild before deploying.');
}

try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : 'Program key derivation failed');
  process.exitCode = 1;
}
