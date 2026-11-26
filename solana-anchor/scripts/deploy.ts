// Deploy the P2ID stack to a Solana cluster and bring it up to the current release.
//
//   yarn deploy --cluster localnet            # sandbox, local validator: defaults, nothing recorded
//   yarn deploy --cluster devnet              # sandbox
//   yarn deploy --cluster mainnet             # production
//
// The cluster decides the environment (deploy.config.ts). Everything environment-specific is read
// with that suffix from solana-anchor/.env (see .env.example): the Privy keys (shared with
// contracts/.env), the authority (a Squads vault), the alpha attester. The stack is built from
// releases.json: the circuit version the factory is initialized with, the policy rate, the program
// crates and the Sunspot artifact, and the authority settings every cluster of the environment should
// have now.
//
// Steps, each skipped when the cluster already has it, so the command is re-runnable at any time and
// is also how a cluster picks up a new release:
//   1. the Sunspot verifier program (deploy, burn its upgrade authority)
//   2. the P2ID verifier built in front of it (P2ID_ZK_VERIFIER=<its id> anchor build; deploy; burn),
//      checked on-chain to front exactly that program
//   3. the policy, router and implementation programs (deploy; burn the implementation's authority)
//   4. the policy PDA, then the factory PDA (initialize_factory refuses an upgradeable verifier or
//      implementation), then the router's upgrade authority is burned
//   5. authority transactions worked out from what the cluster still lacks: bind the policy to the
//      factory, the environment's alpha attester and constraint signers. Sent when the deployer is the
//      authority; otherwise written to deployments/squads/ as unsigned instructions to import.
// A record of the cluster is written to deployments/<scheme>.<environment>.<cluster>.json (not for a
// local validator) and every cluster of an environment must give the same factory PDA.
//
//   --predict      print the addresses without touching the cluster
//   --plan         read the cluster and write the authority files, send nothing
//   --skip-build   do not rebuild the verifier (its .so must already front the Sunspot program)
//   --stack-only   stop after the factory
//   --finalize-policy  also burn the policy program's upgrade authority
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { AnchorProvider, BN, Idl, Program, Wallet } from '@coral-xyz/anchor';
import {
  Connection, Keypair, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, Transaction, TransactionInstruction,
} from '@solana/web3.js';
import { clusterOf, envFor, loadEnv, requireEnvFor, type Environment } from '../deploy.config';

const ROOT = resolve(__dirname, '..');
const DEPLOYMENTS = join(ROOT, 'deployments');
const SQUADS = join(DEPLOYMENTS, 'squads');
const DAY = 24 * 3600;

// Seeds (programs/p2id_router/src/state.rs, programs/p2id_policy/src/lib.rs).
const FACTORY_SEED = Buffer.from('p2id.factory.v1');
const VERIFIER_SEED = Buffer.from('p2id.verifier.v1');
const IMPL_AUTHORITY_SEED = Buffer.from('p2id.impl-authority.v1');
const POLICY_SEED = Buffer.from('p2id.policy.v1');
const FACTORY_PARAMS_PREFIX = Buffer.from('p2id.factory.params.v1');
const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
// Privy's production token-signing key, the local validator's default when no keys are configured.
const LOCAL_PRIVY_KEY = {
  kid: 'local-default',
  x: Buffer.from('lbnZ0Y--2fXDuKq0ZicXk1Ob4svIanCQ3ZL032AIUN4', 'base64url'),
  y: Buffer.from('Os_zTTMZ1EoDr92BhHTTVR4rN-4v8CnOrB7nSSTuuBM', 'base64url'),
};

interface PrivyKey { kid: string; x: Buffer; y: Buffer }
/** The Sunspot program of one environment: sandbox keys come from `sunspot setup`, production keys
 *  from the ceremony, so the two environments have different verifying keys, programs and vkHashes. */
interface ZkVerifierArtifact { vkHash: string | null; vk: string; so: string; keypair: string }
interface Release {
  scheme: string;
  stackCircuit: number;
  policyFeeBps: number;
  programs: { router: string; policy: string; implementation: string };
  circuits: Record<string, { verifierProgram: string; zkVerifier: Record<Environment, ZkVerifierArtifact> }>;
  environments: Record<Environment, { alphaAttester: string | null; constraintSigners: string[]; retiredConstraintSigners: string[] }>;
}
interface Params {
  authority: PublicKey;
  alphaAttester: PublicKey;
  signerKeys: PrivyKey[];
  circuitVersion: number;
  vkHash: Buffer;
  policyFeeBps: number;
  minRefundWindow: number;
  maxRefundWindow: number;
}
type Flags = { cluster: string; predict: boolean; plan: boolean; skipBuild: boolean; stackOnly: boolean; finalizePolicy: boolean };

function flags(): Flags {
  const args = process.argv.slice(2);
  const take = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 1).length > 0 : false; };
  const i = args.indexOf('--cluster');
  if (i < 0 || !args[i + 1]) throw new Error('usage: deploy.ts --cluster <localnet|devnet|mainnet> [--predict] [--plan] [--skip-build] [--stack-only] [--finalize-policy]');
  const cluster = args.splice(i, 2)[1];
  const f = { cluster, predict: take('--predict'), plan: take('--plan'), skipBuild: take('--skip-build'), stackOnly: take('--stack-only'), finalizePolicy: take('--finalize-policy') };
  if (args.length) throw new Error(`unknown arguments: ${args.join(' ')}`);
  return f;
}

const log = (m: string) => console.log(m);
const pda = (seeds: Buffer[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];
const programDataAddress = (program: PublicKey) => pda([program.toBuffer()], BPF_LOADER_UPGRADEABLE);
const sha256 = (...parts: Buffer[]) => createHash('sha256').update(Buffer.concat(parts)).digest();
const hex = (b: Buffer | Uint8Array | number[]) => '0x' + Buffer.from(b).toString('hex');
const expand = (p: string) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);
const keypairFile = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(expand(p), 'utf8'))));
const i64be = (n: number) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n)); return b; };
const u16be = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };

/** Mirrors factory_params_hash in programs/p2id_router/src/hash.rs. */
function factoryParamsHash(p: Params, verifier: PublicKey, policy: PublicKey, implementation: PublicKey): Buffer {
  return sha256(
    FACTORY_PARAMS_PREFIX, Buffer.from([p.signerKeys.length]), ...p.signerKeys.map((k) => Buffer.concat([k.x, k.y])),
    verifier.toBuffer(), policy.toBuffer(), implementation.toBuffer(), p.alphaAttester.toBuffer(),
    u16be(p.circuitVersion), p.vkHash, i64be(p.minRefundWindow), i64be(p.maxRefundWindow),
  );
}

/** Keys written in .env as comma-separated `kid:0x<x>:0x<y>` entries (the contracts/.env format). */
function parsePrivyKeys(name: string, value: string): PrivyKey[] {
  const keys = value.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const m = /^([^:]+):0x([0-9a-fA-F]{64}):0x([0-9a-fA-F]{64})$/.exec(entry);
    if (!m) throw new Error(`${name}: bad entry (expected kid:0x<64 hex x>:0x<64 hex y>)`);
    return { kid: m[1], x: Buffer.from(m[2], 'hex'), y: Buffer.from(m[3], 'hex') };
  });
  if (keys.length === 0) throw new Error(`${name} has no keys`);
  return keys;
}

/** Every ES256 signing key of a Privy JWKS, from a URL or a saved jwks.json. */
async function loadJwks(source: string): Promise<PrivyKey[]> {
  const body = /^https?:\/\//.test(source)
    ? await (await fetch(source, { signal: AbortSignal.timeout(15_000) })).json()
    : JSON.parse(readFileSync(source, 'utf8'));
  const keys = (body as { keys?: any[] }).keys;
  if (!Array.isArray(keys)) throw new Error(`${source} is not a JWKS (no "keys" array)`);
  const ec = keys.filter((k) => k.kty === 'EC' && k.crv === 'P-256' && (k.use === undefined || k.use === 'sig'));
  if (ec.length === 0) throw new Error(`${source} has no P-256 signing keys`);
  return ec.map((k) => ({ kid: String(k.kid ?? ''), x: Buffer.from(k.x, 'base64url'), y: Buffer.from(k.y, 'base64url') }));
}

/** Keys in a canonical order, so the JWKS order never changes the factory PDA. */
const sortedKeys = (keys: PrivyKey[]) => [...keys].sort((a, b) => Buffer.compare(Buffer.concat([a.x, a.y]), Buffer.concat([b.x, b.y])));

function pubkey(value: string, name: string): PublicKey {
  try { return new PublicKey(value); } catch { throw new Error(`${name} is not a base58 public key`); }
}

async function main() {
  const f = flags();
  const cluster = clusterOf(f.cluster);
  const environment = cluster.environment;
  const local = cluster.local === true;
  loadEnv(ROOT);
  const release: Release = JSON.parse(readFileSync(join(ROOT, 'releases.json'), 'utf8'));
  const scheme = release.scheme;
  const circuitVersion = release.stackCircuit;
  const circuit = release.circuits[String(circuitVersion)];
  if (!circuit) throw new Error(`releases.json has no circuit ${circuitVersion}`);
  const zk = circuit.zkVerifier[environment];
  if (!zk) throw new Error(`releases.json circuit ${circuitVersion} has no ${environment} zkVerifier entry`);

  // 1. Everything the addresses depend on is resolved before touching the cluster.
  const deployer = keypairFile(envFor('SOL_DEPLOYER_KEYPAIR', environment, { shared: true }) ?? '~/.config/solana/id.json');
  const setting = (name: string, localDefault: () => string): string => {
    const v = envFor(name, environment);
    if (v !== undefined) return v;
    if (!local) return requireEnvFor(name, environment);
    const d = localDefault();
    log(`(local run) ${name}_SANDBOX not set, using ${d}`);
    return d;
  };
  let privyJwks: string;
  let keys: PrivyKey[];
  const inline = envFor('PRIVY_SIGNER_KEYS', environment);
  const jwksUrl = envFor('PRIVY_JWKS_URL', environment);
  if (inline !== undefined) {
    privyJwks = `.env PRIVY_SIGNER_KEYS_${environment === 'sandbox' ? 'SANDBOX' : 'PROD'}`;
    keys = parsePrivyKeys(privyJwks, inline);
  } else if (jwksUrl !== undefined) {
    privyJwks = jwksUrl;
    keys = await loadJwks(jwksUrl);
  } else if (local) {
    log('(local run) no Privy keys configured, using the built-in key');
    privyJwks = 'built-in local key';
    keys = [LOCAL_PRIVY_KEY];
  } else {
    throw new Error(`PRIVY_SIGNER_KEYS_${environment === 'sandbox' ? 'SANDBOX' : 'PROD'} (or PRIVY_JWKS_URL_*) is required`);
  }
  keys = sortedKeys(keys);
  const authority = pubkey(setting('SOL_AUTHORITY', () => deployer.publicKey.toBase58()), 'SOL_AUTHORITY');
  const alphaRaw = envFor('SOL_ALPHA_ATTESTER', environment);
  const alphaAttester = alphaRaw === undefined ? authority : pubkey(alphaRaw, 'SOL_ALPHA_ATTESTER');
  // The verifying key hash is part of the factory PDA. It comes from the vk file (SOL_VK_FILE, or the
  // environment's artifact from releases.json) and is recorded in releases.json the first time.
  let vkHash: Buffer;
  const vkFile = envFor('SOL_VK_FILE', environment, { shared: true }) ?? (existsSync(resolve(ROOT, zk.vk)) ? resolve(ROOT, zk.vk) : undefined);
  if (vkFile !== undefined) {
    vkHash = sha256(readFileSync(expand(vkFile)));
    if (zk.vkHash !== null && zk.vkHash !== hex(vkHash)) {
      throw new Error(`${vkFile} hashes to ${hex(vkHash)}, but releases.json records ${zk.vkHash} for circuit ${circuitVersion} (${environment})`);
    }
    if (zk.vkHash === null && !f.predict && !local) {
      zk.vkHash = hex(vkHash);
      writeFileSync(join(ROOT, 'releases.json'), JSON.stringify(release, null, 2) + '\n');
      log(`recorded circuit ${circuitVersion} ${environment} vkHash ${hex(vkHash)} in releases.json: commit it`);
    }
  } else if (zk.vkHash !== null) {
    vkHash = Buffer.from(zk.vkHash.slice(2), 'hex');
  } else if (local) {
    log('(local run) circuit vkHash unknown, using zero');
    vkHash = Buffer.alloc(32);
  } else {
    throw new Error(`releases.json has no ${environment} vkHash for circuit ${circuitVersion}: build the Sunspot verifier (circuit/scripts/sunspot-build.sh ${environment}) or set SOL_VK_FILE`);
  }
  const num = (name: string, fallback: number) => Number(envFor(name, environment, { shared: true }) ?? fallback);
  const params: Params = {
    authority, alphaAttester, signerKeys: keys, circuitVersion, vkHash, policyFeeBps: release.policyFeeBps,
    minRefundWindow: num('MIN_REFUND_WINDOW', DAY), maxRefundWindow: num('MAX_REFUND_WINDOW', 90 * DAY),
  };

  // Program ids: the keypairs, which must match the ids declared in the sources (IDL `address`).
  const keypairDir = envFor('SOL_PROGRAM_KEYPAIR_DIR', environment, { shared: true }) ?? join(ROOT, 'target', 'deploy');
  const idlOf = (crate: string) => JSON.parse(readFileSync(join(ROOT, 'target', 'idl', `${crate}.json`), 'utf8')) as Idl;
  const programOf = (crate: string) => {
    const kp = keypairFile(join(keypairDir, `${crate}-keypair.json`));
    const declared = (idlOf(crate) as any).address as string;
    if (declared !== kp.publicKey.toBase58()) {
      throw new Error(`${crate}: keypair ${kp.publicKey.toBase58()} is not the id declared in its source (${declared}); the program must be built for its keypair`);
    }
    return { crate, id: kp.publicKey, keypair: join(keypairDir, `${crate}-keypair.json`), so: join(ROOT, 'target', 'deploy', `${crate}.so`) };
  };
  const router = programOf(release.programs.router);
  const policyProgram = programOf(release.programs.policy);
  const implementation = programOf(release.programs.implementation);
  const verifier = programOf(circuit.verifierProgram);
  let zkSo = envFor('SOL_ZK_VERIFIER_SO', environment, { shared: true }) ?? resolve(ROOT, zk.so);
  let zkKeypairPath = envFor('SOL_ZK_VERIFIER_KEYPAIR', environment, { shared: true }) ?? resolve(ROOT, zk.keypair);
  if (!existsSync(expand(zkKeypairPath))) {
    if (!local) throw new Error(`Sunspot verifier keypair not found at ${zkKeypairPath} (releases.json / SOL_ZK_VERIFIER_KEYPAIR)`);
    log('(local run) no Sunspot verifier artifact, using the test verifier program as the ZK backend');
    zkSo = join(ROOT, 'target', 'deploy', 'test_verifier.so');
    zkKeypairPath = join(ROOT, 'target', 'deploy', 'test_verifier-keypair.json');
  }
  const zkVerifier = keypairFile(zkKeypairPath).publicKey;

  const policy = pda([POLICY_SEED, authority.toBuffer(), router.id.toBuffer(), u16be(params.policyFeeBps)], policyProgram.id);
  const paramsHash = factoryParamsHash(params, verifier.id, policy, implementation.id);
  const factory = pda([FACTORY_SEED, Buffer.from('pvium.vault.v1'), authority.toBuffer(), paramsHash], router.id);
  const verifierConfig = pda([VERIFIER_SEED, factory.toBuffer(), verifier.id.toBuffer()], router.id);
  const implAuthority = pda([IMPL_AUTHORITY_SEED], implementation.id);
  const summary = {
    scheme, environment, cluster: cluster.name, privyJwks,
    privyKeys: keys.map((k) => ({ kid: k.kid, x: hex(k.x), y: hex(k.y) })),
    config: {
      authority: authority.toBase58(), alphaAttester: alphaAttester.toBase58(), circuitVersion, vkHash: hex(vkHash),
      policyFeeBps: params.policyFeeBps, minRefundWindow: params.minRefundWindow, maxRefundWindow: params.maxRefundWindow,
    },
    programs: {
      router: router.id.toBase58(), policy: policyProgram.id.toBase58(), implementation: implementation.id.toBase58(),
      verifier: verifier.id.toBase58(), zkVerifier: zkVerifier.toBase58(),
    },
    paramsHash: hex(paramsHash), factory: factory.toBase58(), verifierConfig: verifierConfig.toBase58(),
    policyPda: policy.toBase58(), implAuthority: implAuthority.toBase58(),
  };
  log(`${environment} on ${cluster.name}: ${keys.length} Privy keys (${keys.map((k) => k.kid).join(', ')}), authority ${authority.toBase58()}, deployer ${deployer.publicKey.toBase58()}`);
  if (f.predict) {
    log(JSON.stringify({ ...summary, predicted: true }, null, 2));
    return;
  }

  // Same scheme + environment must mean the same factory on every cluster.
  if (existsSync(DEPLOYMENTS)) {
    for (const file of readdirSync(DEPLOYMENTS).filter((n) => n.startsWith(`${scheme}.${environment}.`) && n.endsWith('.json'))) {
      const record = JSON.parse(readFileSync(join(DEPLOYMENTS, file), 'utf8'));
      if (record.factory !== summary.factory) {
        const message = `deployments/${file} has factory ${record.factory}; this run would give ${summary.factory}. Every ${environment} cluster must match: something differs (Privy keys, authority, attester, windows, vkHash or program ids).`;
        if (local) log(`warning: ${message}`);
        else throw new Error(message);
      }
    }
  }

  // 2. The cluster.
  const rpc = process.env[cluster.rpcEnv] || cluster.defaultRpc;
  const connection = new Connection(rpc, 'confirmed');
  const provider = new AnchorProvider(connection, new Wallet(deployer), { commitment: 'confirmed' });
  const routerProgram: any = new Program(idlOf(router.crate), provider);
  const policyAnchor: any = new Program(idlOf(policyProgram.crate), provider);
  const verifierAnchor: any = new Program(idlOf(verifier.crate), provider);
  const plan = f.plan;
  if (plan) log('--plan: reading the cluster; nothing is sent');
  const genesisHash = await connection.getGenesisHash();

  type Status = 'missing' | 'upgradeable' | 'immutable' | 'foreign';
  const programStatus = async (id: PublicKey): Promise<{ status: Status; authority?: PublicKey }> => {
    const info = await connection.getAccountInfo(id);
    if (!info || !info.executable) return { status: 'missing' };
    if (!info.owner.equals(BPF_LOADER_UPGRADEABLE)) return { status: 'immutable' }; // legacy loaders have no upgrade path
    const data = await connection.getAccountInfo(programDataAddress(id));
    if (!data) return { status: 'foreign' };
    if (data.data[12] === 0) return { status: 'immutable' };
    return { status: 'upgradeable', authority: new PublicKey(data.data.subarray(13, 45)) };
  };
  const cli = (args: string[], env: NodeJS.ProcessEnv = {}) => {
    log(`$ ${args.join(' ')}`);
    execFileSync(args[0], args.slice(1), { stdio: 'inherit', cwd: ROOT, env: { ...process.env, ...env } });
  };
  const deployerPath = expand(envFor('SOL_DEPLOYER_KEYPAIR', environment, { shared: true }) ?? '~/.config/solana/id.json');
  const deployProgram = async (label: string, id: PublicKey, so: string, keypair: string) => {
    const { status } = await programStatus(id);
    if (status !== 'missing') { log(`${label} ${id.toBase58()}: already deployed (${status})`); return; }
    if (plan) { log(`${label} ${id.toBase58()}: not deployed; a deployment run would deploy ${so}`); return; }
    if (!existsSync(expand(so))) throw new Error(`${label}: ${so} not found (build first)`);
    cli(['solana', 'program', 'deploy', expand(so), '--program-id', expand(keypair), '--url', rpc, '--keypair', deployerPath, '--upgrade-authority', deployerPath, '--commitment', 'confirmed']);
  };
  const finalize = async (label: string, id: PublicKey) => {
    const { status, authority: current } = await programStatus(id);
    if (status === 'immutable') { log(`${label}: immutable`); return; }
    if (status !== 'upgradeable') throw new Error(`${label} ${id.toBase58()}: ${status}, cannot burn its upgrade authority`);
    if (plan) { log(`${label}: upgradeable; a deployment run would burn its upgrade authority`); return; }
    if (!current!.equals(deployer.publicKey)) throw new Error(`${label}: upgrade authority is ${current!.toBase58()}, not the deployer; burn it from there`);
    const ix = new TransactionInstruction({
      programId: BPF_LOADER_UPGRADEABLE,
      keys: [{ pubkey: programDataAddress(id), isSigner: false, isWritable: true }, { pubkey: deployer.publicKey, isSigner: true, isWritable: false }],
      data: Buffer.from([4, 0, 0, 0]), // SetAuthority with no new authority
    });
    await provider.sendAndConfirm(new Transaction().add(ix));
    log(`${label}: upgrade authority burned`);
  };

  // 3. Sunspot verifier, then the P2ID verifier in front of it.
  await deployProgram('ZK verifier (Sunspot)', zkVerifier, zkSo, zkKeypairPath);
  await finalize('ZK verifier (Sunspot)', zkVerifier);
  if ((await programStatus(verifier.id)).status === 'missing' && !plan && !f.skipBuild) {
    cli(['anchor', 'build', '-p', verifier.crate], { P2ID_ZK_VERIFIER: zkVerifier.toBase58() });
  }
  await deployProgram('P2ID verifier', verifier.id, verifier.so, verifier.keypair);
  if ((await programStatus(verifier.id)).status !== 'missing') {
    // The verifier refuses any backend but the one baked in at build time: simulate a call naming a
    // stranger (must be refused as the wrong backend) and one naming the Sunspot program (must not be).
    // A program deployed this slot is invokable from the next one, so the probe retries briefly.
    const probe = async (zk: PublicKey): Promise<'wrong-backend' | 'other'> => {
      for (let attempt = 0; ; attempt++) {
        const ix = await verifierAnchor.methods.verify(Buffer.alloc(400)).accounts({ zkVerifier: zk, zkVerifierData: programDataAddress(zk) }).instruction();
        const tx = new Transaction().add(ix);
        tx.feePayer = deployer.publicKey;
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        const sim = await connection.simulateTransaction(tx);
        const logs = sim.value.logs ?? [];
        if (logs.some((l) => l.includes('Not the ZK verifier'))) return 'wrong-backend';
        if (logs.some((l) => l.includes('AnchorError'))) return 'other';
        if (attempt >= 10) throw new Error(`P2ID verifier ${verifier.id.toBase58()} could not be simulated: ${JSON.stringify(sim.value.err)} ${logs.join(' | ')}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    };
    if ((await probe(Keypair.generate().publicKey)) !== 'wrong-backend' || (await probe(zkVerifier)) === 'wrong-backend') {
      throw new Error(`P2ID verifier ${verifier.id.toBase58()} does not front ${zkVerifier.toBase58()}: rebuild it with P2ID_ZK_VERIFIER set to that id`);
    }
    log(`P2ID verifier fronts ${zkVerifier.toBase58()}`);
  }
  await finalize('P2ID verifier', verifier.id);

  // 4. Policy, router, implementation programs; the implementation's authority is burned at once.
  await deployProgram('policy program', policyProgram.id, policyProgram.so, policyProgram.keypair);
  await deployProgram('router program', router.id, router.so, router.keypair);
  await deployProgram('implementation program', implementation.id, implementation.so, implementation.keypair);
  await finalize('implementation program', implementation.id);
  if (f.finalizePolicy) await finalize('policy program', policyProgram.id);

  // 5. Policy PDA, factory PDA, then the router is frozen.
  const policyState = await policyAnchor.account.policyConfig.fetchNullable(policy);
  if (policyState) {
    log(`policy ${policy.toBase58()}: initialized`);
  } else if (plan) {
    log(`policy ${policy.toBase58()}: not initialized; a deployment run would initialize it`);
  } else {
    await policyAnchor.methods.initializePolicy(authority, router.id, params.policyFeeBps)
      .accounts({ policy, payer: deployer.publicKey, systemProgram: SystemProgram.programId }).rpc();
    log(`policy ${policy.toBase58()}: initialized (${params.policyFeeBps} bps, authority ${authority.toBase58()})`);
  }
  const factoryState = await routerProgram.account.factory.fetchNullable(factory);
  if (factoryState) {
    log(`factory ${factory.toBase58()}: initialized`);
  } else if (plan) {
    log(`factory ${factory.toBase58()}: not initialized; a deployment run would initialize it`);
  } else {
    await routerProgram.methods
      .initializeFactory(
        authority, Array.from(paramsHash), keys.map((k) => Array.from(Buffer.concat([k.x, k.y]))), verifier.id, policy, implementation.id,
        alphaAttester, circuitVersion, Array.from(vkHash), new BN(params.minRefundWindow), new BN(params.maxRefundWindow),
      )
      .accounts({
        factory, verifierConfig, payer: deployer.publicKey,
        defaultVerifierProgram: verifier.id, defaultVerifierProgramData: programDataAddress(verifier.id),
        defaultImplementationProgram: implementation.id, defaultImplementationProgramData: programDataAddress(implementation.id),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    log(`factory ${factory.toBase58()}: initialized (circuit v${circuitVersion}, verifier ${verifier.id.toBase58()})`);
  }
  if (await routerProgram.account.factory.fetchNullable(factory)) await finalize('router program', router.id);

  // 6. Authority transactions: what the environment should have now and the cluster lacks.
  const pending: { label: string; programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }[] = [];
  const authorityTx = async (label: string, ix: TransactionInstruction) => {
    if (!plan && deployer.publicKey.equals(authority)) {
      await provider.sendAndConfirm(new Transaction().add(ix));
      log(`${label}: sent`);
      return;
    }
    pending.push({ label, programId: ix.programId.toBase58(), accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), data: ix.data.toString('base64') });
    log(`${label}: to be sent by the authority ${authority.toBase58()}`);
  };
  if (!f.stackOnly && (await routerProgram.account.factory.fetchNullable(factory))) {
    const live = await routerProgram.account.factory.fetch(factory);
    const config = await routerProgram.account.verifierConfig.fetch(verifierConfig);
    const policyLive = await policyAnchor.account.policyConfig.fetch(policy);
    if (policyLive.factory.equals(PublicKey.default)) {
      await authorityTx('bind-policy', await policyAnchor.methods.setFactory().accounts({ policy, authority, factory }).instruction());
    }
    const wanted = release.environments[environment];
    const admin = { factory, authority, clock: SYSVAR_CLOCK_PUBKEY };
    const verifierAdmin = { ...admin, verifierConfig };
    if (wanted.alphaAttester && !live.alphaAttester.equals(new PublicKey(wanted.alphaAttester))) {
      await authorityTx('set-alpha-attester', await routerProgram.methods.setAlphaAttester(new PublicKey(wanted.alphaAttester)).accounts(admin).instruction());
    }
    const signers: PublicKey[] = config.constraintSigners;
    for (const s of wanted.constraintSigners) {
      if (!signers.some((k) => k.equals(new PublicKey(s)))) {
        await authorityTx(`add-constraint-signer-${s.slice(0, 8)}`, await routerProgram.methods.setConstraintSigner(new PublicKey(s), true).accounts(verifierAdmin).instruction());
      }
    }
    for (const s of wanted.retiredConstraintSigners) {
      if (signers.some((k) => k.equals(new PublicKey(s)))) {
        await authorityTx(`remove-constraint-signer-${s.slice(0, 8)}`, await routerProgram.methods.setConstraintSigner(new PublicKey(s), false).accounts(verifierAdmin).instruction());
      }
    }
    if (pending.length) {
      mkdirSync(SQUADS, { recursive: true });
      const file = join(SQUADS, `${scheme}.${environment}.${cluster.name}.authority-pending.json`);
      writeFileSync(file, JSON.stringify({ authority: authority.toBase58(), cluster: cluster.name, instructions: pending }, null, 2) + '\n');
      log(`wrote ${pending.length} authority instruction(s) to ${file}: import them into Squads in order`);
    }
  }

  // 7. The record.
  const status: Record<string, unknown> = { checkedAt: new Date().toISOString(), genesisHash };
  for (const [name, id] of Object.entries({ zkVerifier, verifier: verifier.id, policyProgram: policyProgram.id, router: router.id, implementation: implementation.id })) {
    status[name] = (await programStatus(id)).status;
  }
  const liveFactory = await routerProgram.account.factory.fetchNullable(factory);
  if (liveFactory) {
    const config = await routerProgram.account.verifierConfig.fetch(verifierConfig);
    const policyLive = await policyAnchor.account.policyConfig.fetchNullable(policy);
    Object.assign(status, {
      factoryAuthority: liveFactory.authority.toBase58(), alphaAttester: liveFactory.alphaAttester.toBase58(), alphaEpoch: liveFactory.alphaEpoch.toNumber(),
      defaultVerifier: liveFactory.defaultVerifier.toBase58(), implementations: liveFactory.implementations.map((k: PublicKey) => k.toBase58()),
      verifierAllowed: config.allowed, verifierAlpha: config.alpha, keySetRevision: config.keySetRevision.toNumber(),
      constraintSigners: config.constraintSigners.map((k: PublicKey) => k.toBase58()),
      policyBound: policyLive ? policyLive.factory.equals(factory) : false, pendingAuthorityInstructions: pending.length,
    });
  } else {
    status.factory = 'not initialized';
  }
  const record = { ...summary, status };
  if (!local) {
    mkdirSync(DEPLOYMENTS, { recursive: true });
    const file = join(DEPLOYMENTS, `${scheme}.${environment}.${cluster.name}.json`);
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
    log(`wrote deployments/${scheme}.${environment}.${cluster.name}.json: commit it`);
  }
  log(JSON.stringify(record, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
