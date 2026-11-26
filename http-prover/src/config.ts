import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { gunzipSync } from 'node:zlib';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SignerSource } from './token.js';

export interface CircuitVersion {
  circuitVersion: number;
  vkSha256: string;
  /** nargo's `hash` of the Ethereum artifact the vk was generated from. */
  circuitHash: string;
  /** nargo's `hash` of the Sunspot (Noir beta.22) artifact the Groth16 keys were generated from. */
  sunspotCircuitHash: string;
}

export interface ProverConfig {
  circuitJson: string;
  vkPath: string;
  /** circuit/version.json copied next to the artifacts by `yarn sync`. */
  versionJson: string;
  bbBin: string;
  /** The resident Sunspot prover (http-prover/sunspotd). */
  sunspotdBin: string;
  /** The ACIR compiled with the Noir release Sunspot reads; `<path>.gz` is the committed form. */
  sunspotAcirPath: string;
  /**
   * The constraint system file sunspotd reads, or compiles from the ACIR and writes for the next
   * start. Unset: cached next to the proving key, named after the ACIR's hash (see sunspotCcsPath).
   */
  sunspotCcsPath?: string;
  /** The environment's Groth16 proving key. Unset: Solana requests are refused. */
  sunspotPkPath?: string;
  /** The matching verifying key (raw gnark encoding, as deployed on-chain); its sha256 is the attestation's vkHash. */
  sunspotVkPath?: string;
  /** Where to fetch the proving / verifying key when the file is missing or does not match its sha256. */
  sunspotPkUrl?: string;
  sunspotPkSha256?: string;
  sunspotVkUrl?: string;
  sunspotVkSha256?: string;
  workDir: string;
  maxConcurrency: number;
  /** Jobs allowed to wait for a slot before new requests get 503. */
  maxQueue: number;
  signer: SignerSource;
  /** Allow plain-http callback URLs (development only). */
  allowHttpCallbacks: boolean;
  /** SQLite file for the callback outbox (":memory:" for tests). */
  dbPath: string;
  /** How often the dispatcher re-tries due callback deliveries. */
  dispatchIntervalMs: number;
}

/** Build config from process.env (loaded from .env via `node --env-file=.env`). */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ProverConfig {
  const jwksUrls = (env.PRIVY_JWKS_URL ?? '').split(',').map((u) => u.trim()).filter(Boolean);
  const signer: SignerSource = jwksUrls.length
    ? { jwksUrls }
    : env.PRIVY_PUBLIC_KEY_PEM_FILE
      ? { pemFile: env.PRIVY_PUBLIC_KEY_PEM_FILE }
      : (() => {
          throw new Error('set PRIVY_JWKS_URL or PRIVY_PUBLIC_KEY_PEM_FILE');
        })();
  const defaultBb = existsSync(join(homedir(), '.bb', 'bb')) ? join(homedir(), '.bb', 'bb') : 'bb';
  return {
    circuitJson: env.CIRCUIT_JSON ?? './circuit/pvium_identity.json',
    vkPath: env.VK_PATH ?? './circuit/vk',
    versionJson: env.CIRCUIT_VERSION_JSON ?? './circuit/version.json',
    bbBin: env.BB_BIN ?? defaultBb,
    sunspotdBin: env.SUNSPOTD_BIN ?? 'sunspotd',
    sunspotAcirPath: env.SUNSPOT_ACIR_PATH ?? './circuit/pvium_identity.sunspot.json',
    sunspotCcsPath: env.SUNSPOT_CCS_PATH || undefined,
    sunspotPkPath: env.SUNSPOT_PK_PATH || (env.SUNSPOT_PK_URL ? './data/sunspot/pvium_identity.pk' : undefined),
    sunspotVkPath: env.SUNSPOT_VK_PATH || (env.SUNSPOT_VK_URL ? './data/sunspot/pvium_identity.vk' : undefined),
    sunspotPkUrl: env.SUNSPOT_PK_URL || undefined,
    sunspotPkSha256: env.SUNSPOT_PK_SHA256?.toLowerCase().replace(/^0x/, '') || undefined,
    sunspotVkUrl: env.SUNSPOT_VK_URL || undefined,
    sunspotVkSha256: env.SUNSPOT_VK_SHA256?.toLowerCase().replace(/^0x/, '') || undefined,
    workDir: env.WORK_DIR ?? tmpdir(),
    maxConcurrency: Math.max(1, Number(env.MAX_CONCURRENCY ?? 1)),
    maxQueue: Math.max(0, Number(env.MAX_QUEUE ?? 20)),
    signer,
    allowHttpCallbacks: env.ALLOW_HTTP_CALLBACKS === 'true',
    dbPath: env.DB_PATH ?? './data/prover.db',
    dispatchIntervalMs: Math.max(1_000, Number(env.DISPATCH_INTERVAL_MS ?? 30_000)),
  };
}

/**
 * Read the served circuit version and check the artifacts on disk really are that version's: the vk
 * by sha256 and the circuit by nargo's `hash`, so a half-synced deployment fails at startup instead
 * of minting proofs nobody can verify. The circuit check matters because recompiling the same
 * source does not reproduce the committed artifact (Nargo.toml pulls libraries from git with no
 * lock file): a rebuilt circuit passes the vk check and then proves against a key for a different
 * circuit, which the on-chain verifier rejects.
 */
export function loadCircuitVersion(cfg: ProverConfig): CircuitVersion {
  const v = readVersionJson(cfg);
  const actual = '0x' + createHash('sha256').update(readFileSync(cfg.vkPath)).digest('hex');
  if (actual !== v.vkSha256) {
    throw new Error(`vk at ${cfg.vkPath} hashes to ${actual} but version.json says ${v.vkSha256} (circuit version ${v.circuitVersion})`);
  }
  checkCircuitHash(cfg.circuitJson, v.circuitHash, `circuit version ${v.circuitVersion}`);
  return v;
}

function readVersionJson(cfg: ProverConfig): CircuitVersion {
  const v = JSON.parse(readFileSync(cfg.versionJson, 'utf8')) as Partial<CircuitVersion>;
  for (const key of ['circuitVersion', 'vkSha256', 'circuitHash', 'sunspotCircuitHash'] as const) {
    if (v[key] === undefined) throw new Error(`${cfg.versionJson} has no ${key}`);
  }
  return v as CircuitVersion;
}

/**
 * Compare a nargo artifact's `hash` with the one recorded for the served version. The hash is a
 * 64-bit decimal that JSON.parse would round, so it is read off the raw text.
 */
export function checkCircuitHash(path: string, expected: string, what: string): void {
  const actual = readCircuitHash(path);
  if (actual !== expected) {
    throw new Error(`circuit at ${path} has hash ${actual} but version.json pins ${expected} for ${what}: the artifact was rebuilt. Restore the committed artifact, or treat the rebuild as a new circuit version (bump circuitVersion, regenerate the keys, update version.json)`);
  }
}

/** nargo's `hash` of an artifact, as text (it is a 64-bit decimal JSON.parse would round). */
export function readCircuitHash(path: string): string {
  const m = /"hash"\s*:\s*"?(\d+)"?/.exec(readFileSync(path, 'utf8'));
  if (!m) throw new Error(`${path} has no circuit hash; is it a nargo artifact?`);
  return m[1];
}

/**
 * Where sunspotd keeps the constraint system: SUNSPOT_CCS_PATH, or a file next to the proving key
 * named after the ACIR's hash. Compiling it takes ~15 s and is deterministic, so the first start
 * writes it and later starts read it (~2 s); a different ACIR gets a different name and recompiles.
 * Next to the key means on the data volume in a deployment, and in the sunspot-build.sh output
 * directory locally.
 */
export function sunspotCcsPath(cfg: ProverConfig): string {
  if (cfg.sunspotCcsPath) return cfg.sunspotCcsPath;
  return join(dirname(cfg.sunspotPkPath!), `pvium_identity.${readCircuitHash(cfg.sunspotAcirPath)}.ccs`);
}

/**
 * Confirm the bb binary runs and is the version the circuit was built with. Called at startup so
 * a missing or wrong prover fails the deploy's health check instead of the first user's request.
 */
export function checkBb(cfg: ProverConfig, expectedVersion = builtWithBb(cfg)): string {
  let out: string;
  try {
    out = execFileSync(cfg.bbBin, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  } catch (e) {
    throw new Error(`bb not runnable at "${cfg.bbBin}" (${(e as Error).message}). Install it for this user: ~/.bb/bbup -v ${expectedVersion}, then set BB_BIN to its absolute path or unset it to use ~/.bb/bb`);
  }
  // Exact match: "5.0.0" must not accept "5.0.0-nightly.…", whose proofs and vks differ.
  if (out !== expectedVersion) {
    throw new Error(`bb at "${cfg.bbBin}" is version "${out}" but the circuit was built with ${expectedVersion}`);
  }
  return out;
}

/** The Barretenberg version recorded with the circuit artifacts (circuit/version.json, `barretenberg`). */
export function builtWithBb(cfg: ProverConfig): string {
  const v = JSON.parse(readFileSync(cfg.versionJson, 'utf8')) as { barretenberg?: string };
  if (!v.barretenberg) throw new Error(`${cfg.versionJson} does not name the barretenberg version the circuit was built with`);
  return v.barretenberg;
}

/**
 * The committed artifact is `<circuitJson>.gz` (stripped, ~4.6 MB). bb needs a plain file, so
 * inflate it next to the archive on first start if the plain file is missing.
 */
export function ensureCircuitJson(cfg: ProverConfig): void {
  if (existsSync(cfg.circuitJson)) return;
  const gz = cfg.circuitJson + '.gz';
  if (!existsSync(gz)) throw new Error(`circuit not found: neither ${cfg.circuitJson} nor ${gz} exists (run yarn sync)`);
  writeFileSync(cfg.circuitJson, gunzipSync(readFileSync(gz)));
}

/** Solana proving is on when a proving key is configured (a path, or a URL to fetch it from). */
export function solanaEnabled(cfg: ProverConfig): boolean {
  return cfg.sunspotPkPath !== undefined;
}

/**
 * Make sure the Solana artifacts are in place before the daemon starts: inflate the committed ACIR,
 * fetch the proving and verifying keys when they are missing or do not hash to what is expected.
 * The proving key is gigabytes, so it is never in the image: it lives on a volume and is pulled
 * once from SUNSPOT_PK_URL, then checked by sha256 against SUNSPOT_PK_SHA256 on every start (a
 * key from the wrong setup would mint proofs the deployed verifier rejects). The ACIR's hash must be
 * the one the keys were generated from, same reasoning as for the Ethereum circuit. Returns the vk hash.
 */
export async function ensureSunspotArtifacts(cfg: ProverConfig): Promise<{ vkHash?: string }> {
  if (!solanaEnabled(cfg)) return {};
  ensureInflated(cfg.sunspotAcirPath, 'Sunspot ACIR (run yarn sync)');
  const v = readVersionJson(cfg);
  checkCircuitHash(cfg.sunspotAcirPath, v.sunspotCircuitHash, `the Sunspot keys of circuit version ${v.circuitVersion}`);
  await ensureArtifact('proving key', cfg.sunspotPkPath!, cfg.sunspotPkUrl, cfg.sunspotPkSha256);
  if (cfg.sunspotVkPath === undefined) {
    throw new Error('set SUNSPOT_VK_PATH (or SUNSPOT_VK_URL) to the verifying key matching the proving key: its hash identifies the key set in every Solana attestation');
  }
  await ensureArtifact('verifying key', cfg.sunspotVkPath, cfg.sunspotVkUrl, cfg.sunspotVkSha256);
  return { vkHash: '0x' + (await sha256File(cfg.sunspotVkPath)) };
}

function ensureInflated(path: string, what: string): void {
  if (existsSync(path)) return;
  const gz = path + '.gz';
  if (!existsSync(gz)) throw new Error(`${what} not found: neither ${path} nor ${gz} exists`);
  writeFileSync(path, gunzipSync(readFileSync(gz)));
}

async function ensureArtifact(what: string, path: string, url?: string, sha256?: string): Promise<void> {
  if (existsSync(path)) {
    if (!sha256) return;
    const actual = await sha256File(path);
    if (actual === sha256) return;
    if (!url) throw new Error(`Sunspot ${what} at ${path} hashes to ${actual}, expected ${sha256}`);
    console.log(`Sunspot ${what} at ${path} hashes to ${actual}, expected ${sha256}: refetching`);
  } else if (!url) {
    throw new Error(`Sunspot ${what} not found at ${path} (set its URL to fetch it, or put the file there)`);
  }
  console.log(`fetching Sunspot ${what} from ${url} to ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  const partial = path + '.part';
  const res = await fetch(url!);
  if (!res.ok || !res.body) throw new Error(`fetching Sunspot ${what}: ${url} returned ${res.status}`);
  const hash = createHash('sha256');
  await pipeline(res.body as unknown as NodeJS.ReadableStream, async function* (source) {
    for await (const chunk of source) { hash.update(chunk as Buffer); yield chunk; }
  }, createWriteStream(partial));
  const actual = hash.digest('hex');
  if (sha256 && actual !== sha256) throw new Error(`fetched Sunspot ${what} hashes to ${actual}, expected ${sha256}`);
  renameSync(partial, path);
  console.log(`Sunspot ${what} ready (sha256 ${actual})`);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), async function* (source) { for await (const c of source) hash.update(c as Buffer); });
  return hash.digest('hex');
}
