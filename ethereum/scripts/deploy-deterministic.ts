// Deploy the P2ID stack at chain-independent addresses.
//
//   npx hardhat run scripts/deploy-deterministic.ts --network baseSepolia     # sandbox
//   npx hardhat run scripts/deploy-deterministic.ts --network base            # production
//   npx hardhat run scripts/deploy-deterministic.ts --network bsc             # production
//
// The network decides the environment (deploy.config.ts): testnets are `sandbox`, mainnets are
// `production`. Everything environment-specific is read with that suffix from ethereum/.env:
//   PRIVY_SIGNER_KEYS_SANDBOX / _PROD  the Privy app's ES256 keys, every key in its JWKS:
//                                    comma-separated `kid:0x<x>:0x<y>` (the initial key set; part
//                                    of every address, so never change it after the first deploy)
//   PRIVY_JWKS_URL_SANDBOX / _PROD   optional, only used when the keys above are unset: a JWKS URL
//                                    or saved jwks.json
//   OWNER_SANDBOX / _PROD            factory registry owner (a Safe at the same address everywhere)
//   ATTESTER_SANDBOX / _PROD         constraint attester, or "none"
//   ALPHA_ATTESTER_SANDBOX / _PROD   alpha attester; omitted uses OWNER
// Shared, optional: DEPLOYER_KEY (or DEPLOYER_KEY_<SUFFIX>), POLICY_CHANGE_DELAY, MIN_REFUND_WINDOW,
// MAX_REFUND_WINDOW (initial values; part of the factory address; later changes go through
// factory.proposeConfig/activateConfig), SCHEME (default: `current` in sdks/node/p2id-core/src/p2id.json), CIRCUIT_VERSION.
//
// The stack is built from the circuit version the scheme's factory was first deployed with
// (ethereum/releases.json: stackCircuit), whatever circuit/version.json says now, so any checkout
// gives the addresses already deployed. After the stack, the chain is brought up to everything in
// ethereum/releases.json: each later circuit version's verifier set is deployed, and the owner
// transactions are worked out from what the chain still lacks (bind the policy to the factory, the
// environment's current alpha attester and constraint signers, approve each later verifier, deploy
// and propose each later vault implementation, register it once its notice has passed). Those are
// sent when the deployer key is the owner; otherwise each is simulated as the owner and written as
// a Safe Transaction Builder batch in deployments/safe/, one per step plus `owner-pending`, which
// holds all of them in order. The command is re-runnable on any chain at any time: what is already
// there is skipped, so it is also how an existing chain picks up a new release.
// STACK_ONLY=1 stops after the stack.
//
// PREDICT=1 prints the addresses without sending anything (with no --network, set P2ID_ENV).
// PLAN=1 reads the chain and writes the owner Safe batches, but sends nothing and needs no key.
//
// Local runs (--network hardhat or localhost) need no .env: unset values default to the sandbox
// Privy JWKS, the first local account as owner, and no attester. Real networks never default.
// Every chain of one environment must end up with the same addresses; the script refuses to
// deploy a configuration that differs from an earlier deployment of the same scheme+environment.
import { artifacts, ethers, network } from 'hardhat';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import {
  envFor,
  environmentOf,
  requireEnvFor,
  type P2IDEnvironment,
} from '../deploy.config';
import {
  checkStack,
  circuitRelease,
  deployStack,
  deployVerifierSet,
  predictStack,
  sortedKeys,
  stackCircuitVersion,
  stackStatus,
  vaultImplementationReleases,
  type StackParams,
} from './lib/deterministic';
import { implementationCreationCode } from './lib/implementation';
import {
  IMPLEMENTATION_SALT,
  laterCircuits,
  syncReleases,
  verifierSetParams,
} from './lib/laterReleases';

const DAY = 24 * 3600;
const SANDBOX_JWKS =
  'https://auth.privy.io/api/v1/apps/cmhc6t92u001tju0cxkxg34on/jwks.json';
const isLocal = () =>
  network.name === 'hardhat' || network.name === 'localhost';
const ROOT = join(__dirname, '..', '..');
const DEPLOYMENTS = join(__dirname, '..', 'deployments');
const P2ID_JSON = join(ROOT, 'sdks', 'node', 'p2id-core', 'src', 'p2id.json');

interface PrivyKey {
  kid: string;
  x: bigint;
  y: bigint;
}

/** GET a JSON document, retrying timeouts and 5xx/429 responses (Privy's JWKS endpoint has transient 500/504s). */
async function fetchJson(url: string, attempts = 5): Promise<unknown> {
  let last = '';
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) return await res.json();
      last = `HTTP ${res.status}`;
      if (res.status < 500 && res.status !== 429) break; // 4xx other than 429 will not fix itself
    } catch (err) {
      last = (err as Error).message;
    }
    if (i < attempts) {
      const wait = 2000 * 2 ** (i - 1);
      console.log(
        `fetching ${url}: ${last}, retrying in ${
          wait / 1000
        }s (${i}/${attempts})`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error(
    `fetching ${url}: ${last} after ${attempts} attempts. Nothing was deployed. Retry later, or point PRIVY_JWKS_URL_* at a saved jwks.json.`,
  );
}

/** Keys written in .env as comma-separated `kid:0x<x>:0x<y>` entries. */
function parsePrivyKeys(name: string, value: string): PrivyKey[] {
  const keys = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const m = /^([^:]+):(0x[0-9a-fA-F]{64}):(0x[0-9a-fA-F]{64})$/.exec(entry);
      if (!m)
        throw new Error(
          `${name}: bad entry "${entry}" (expected kid:0x<64 hex x>:0x<64 hex y>)`,
        );
      return { kid: m[1], x: BigInt(m[2]), y: BigInt(m[3]) };
    });
  if (keys.length === 0) throw new Error(`${name} has no keys`);
  return keys;
}

/** Every ES256 signing key in a Privy JWKS, from a URL or a saved jwks.json. */
async function loadPrivyKeys(source: string): Promise<PrivyKey[]> {
  let body: unknown;
  if (/^https?:\/\//.test(source)) {
    body = await fetchJson(source);
  } else {
    body = JSON.parse(readFileSync(source, 'utf8'));
  }
  const keys = (body as { keys?: any[] }).keys;
  if (!Array.isArray(keys))
    throw new Error(`${source} is not a JWKS (no "keys" array)`);
  const ec = keys.filter(
    (k) =>
      k.kty === 'EC' &&
      k.crv === 'P-256' &&
      (k.use === undefined || k.use === 'sig'),
  );
  if (ec.length === 0) throw new Error(`${source} has no P-256 signing keys`);
  const hex = (b64: string) =>
    BigInt('0x' + Buffer.from(b64, 'base64url').toString('hex'));
  return ec.map((k) => ({
    kid: String(k.kid ?? ''),
    x: hex(k.x),
    y: hex(k.y),
  }));
}

function address(value: string, name: string): string {
  if (!ethers.isAddress(value))
    throw new Error(`${name} is not an address: ${value}`);
  return ethers.getAddress(value);
}

/** Required per-environment setting; on a local chain, a sandbox default instead (reported). */
async function setting(
  name: string,
  environment: P2IDEnvironment,
  localDefault: () => Promise<string> | string,
): Promise<string> {
  const v = envFor(name, environment);
  if (v !== undefined) return v;
  if (!isLocal() || environment !== 'sandbox')
    return requireEnvFor(name, environment);
  const d = await localDefault();
  console.log(`(local run) ${name}_SANDBOX not set, using ${d}`);
  return d;
}

async function configFor(
  environment: P2IDEnvironment,
  scheme: string,
  circuitVersion: number,
) {
  // The initial key set comes from .env (PRIVY_SIGNER_KEYS_*). A JWKS is only a fallback, and on a
  // real network only when explicitly configured.
  const suffix = environment === 'sandbox' ? 'SANDBOX' : 'PROD';
  const inline = envFor('PRIVY_SIGNER_KEYS', environment);
  let jwks: string;
  let keys: PrivyKey[];
  if (inline !== undefined) {
    jwks = `.env PRIVY_SIGNER_KEYS_${suffix}`;
    keys = parsePrivyKeys(`PRIVY_SIGNER_KEYS_${suffix}`, inline);
  } else {
    jwks = await setting('PRIVY_JWKS_URL', environment, () => SANDBOX_JWKS);
    keys = await loadPrivyKeys(jwks);
  }
  const owner = address(
    await setting(
      'OWNER',
      environment,
      async () => (await ethers.getSigners())[0].address,
    ),
    `OWNER for ${environment}`,
  );
  const attesterRaw = await setting('ATTESTER', environment, () => 'none');
  const attester =
    attesterRaw.toLowerCase() === 'none'
      ? ethers.ZeroAddress
      : address(attesterRaw, `ATTESTER for ${environment}`);
  const alphaAttesterRaw = envFor('ALPHA_ATTESTER', environment);
  const alphaAttester =
    alphaAttesterRaw === undefined
      ? owner
      : address(alphaAttesterRaw, `ALPHA_ATTESTER for ${environment}`);
  if (alphaAttester === ethers.ZeroAddress)
    throw new Error('ALPHA_ATTESTER must be nonzero; omit it to use OWNER');
  const num = (name: string, fallback: number) =>
    Number(envFor(name, environment, { shared: true }) ?? fallback);
  const params: StackParams = {
    owner,
    scheme,
    circuitVersion,
    vkHash: circuitRelease(circuitVersion).vkHash,
    signerKeys: keys.map(({ x, y }) => ({ x, y })),
    attester,
    alphaAttester,
    policyChangeDelay: num('POLICY_CHANGE_DELAY', 7 * DAY),
    minRefundWindow: num('MIN_REFUND_WINDOW', DAY),
    maxRefundWindow: num('MAX_REFUND_WINDOW', 90 * DAY),
  };
  return { params, keys, jwks };
}

/** Earlier deployments of this scheme+environment (any chain); they fix what the addresses must be. */
function earlierRecords(
  scheme: string,
  environment: P2IDEnvironment,
): { file: string; record: any }[] {
  if (!existsSync(DEPLOYMENTS)) return [];
  return readdirSync(DEPLOYMENTS)
    .filter(
      (f) => f.startsWith(`${scheme}.${environment}.`) && f.endsWith('.json'),
    )
    .map((file) => ({
      file,
      record: JSON.parse(readFileSync(join(DEPLOYMENTS, file), 'utf8')),
    }));
}

async function main() {
  // 1. Everything the addresses depend on is resolved before touching the chain: the Privy keys
  //    first (the only remote input), then the rest of the configuration. A failure here means
  //    nothing was sent.
  const environment = environmentOf(network.name);
  const p2id = JSON.parse(readFileSync(P2ID_JSON, 'utf8'));
  const scheme: string = process.env.SCHEME ?? p2id.current;
  // The SDK derives addresses with the vault proxy's creation-code hash, which must be this
  // build's. While the scheme is unreleased (no production factory) a stale hash is refreshed
  // here, and a sandbox factory recorded under the old hash is dropped so this run records the
  // new one. Once released, a different hash means the proxy changed: that is a new scheme.
  const proxyHash = ethers.keccak256(
    (await artifacts.readArtifact('PviumP2IDVaultProxy')).bytecode,
  );
  const entry = p2id.schemes[scheme];
  if (entry && entry.vaultInitCodeHash !== proxyHash) {
    if (entry.factories.production !== null) {
      throw new Error(
        `the vault proxy now hashes to ${proxyHash}, but ${scheme} is released (production factory ${entry.factories.production}) and frozen at ${entry.vaultInitCodeHash}: a proxy change is a new scheme`,
      );
    }
    entry.vaultInitCodeHash = proxyHash;
    entry.factories.sandbox = null;
    if (process.env.PREDICT) {
      console.log(
        `vaultInitCodeHash in sdks/node/p2id-core/src/p2id.json is stale (now ${proxyHash}); a deployment run refreshes it`,
      );
    } else {
      writeFileSync(P2ID_JSON, JSON.stringify(p2id, null, 2) + '\n');
      console.log(
        `refreshed ${scheme} vaultInitCodeHash to ${proxyHash} in sdks/node/p2id-core/src/p2id.json (sandbox factory will be re-recorded)`,
      );
    }
  }
  const circuitVersion = Number(
    process.env.CIRCUIT_VERSION ?? stackCircuitVersion(scheme),
  );
  const { params, keys, jwks } = await configFor(
    environment,
    scheme,
    circuitVersion,
  );
  console.log(
    `${environment} on ${network.name}: ${keys.length} Privy keys (${keys
      .map((k) => k.kid)
      .join(', ')}), owner ${params.owner}`,
  );

  const predicted = await predictStack(params);
  const summary = {
    scheme,
    environment,
    privyJwks: jwks,
    privyKeys: sortedKeys(keys).map((k) => ({
      kid: keys.find((q) => q.x === k.x && q.y === k.y)?.kid,
      x: '0x' + k.x.toString(16).padStart(64, '0'),
      y: '0x' + k.y.toString(16).padStart(64, '0'),
    })),
    config: {
      owner: params.owner,
      attester: params.attester,
      alphaAttester: params.alphaAttester,
      circuitVersion: params.circuitVersion,
      vkHash: params.vkHash,
      policyChangeDelay: params.policyChangeDelay,
      minRefundWindow: params.minRefundWindow,
      maxRefundWindow: params.maxRefundWindow,
    },
  };
  if (process.env.PREDICT) {
    const laterVerifierSets: Record<string, unknown> = {};
    for (const v of laterCircuits(circuitVersion))
      laterVerifierSets[`circuit-v${v}`] = await deployVerifierSet(
        verifierSetParams(params, v),
        null,
      );
    const vaultImplementations: Record<string, string> = {};
    for (const impl of vaultImplementationReleases(scheme)) {
      vaultImplementations[impl.contract] = ethers.getCreate2Address(
        predicted.factory,
        IMPLEMENTATION_SALT,
        ethers.keccak256(
          await implementationCreationCode(impl.contract, predicted.factory),
        ),
      );
    }
    console.log(
      JSON.stringify(
        {
          ...summary,
          predicted: true,
          ...predicted,
          laterVerifierSets,
          vaultImplementations,
        },
        null,
        2,
      ),
    );
    return;
  }

  // Same scheme + environment must mean the same addresses on every chain.
  const recorded: string | null =
    p2id.schemes[scheme]?.factories?.[environment] ?? null;
  if (recorded && recorded.toLowerCase() !== predicted.factory.toLowerCase()) {
    throw new Error(
      `this ${environment} configuration gives factory ${predicted.factory}, but sdks/node/p2id-core/src/p2id.json records ${recorded} for ${scheme}. ` +
        'Something differs from the configuration that was recorded (owner, attester, delays, or the Privy JWKS keys).',
    );
  }
  for (const { file, record } of earlierRecords(scheme, environment)) {
    if (record.factory.toLowerCase() !== predicted.factory.toLowerCase()) {
      const keysNow = JSON.stringify(summary.privyKeys.map((k) => k.x));
      const keysThen = JSON.stringify(
        (record.privyKeys ?? []).map((k: any) => k.x),
      );
      const hint =
        keysNow !== keysThen
          ? 'the Privy JWKS keys changed since then'
          : JSON.stringify(record.config) !== JSON.stringify(summary.config)
          ? 'owner, attester or delays differ'
          : 'same configuration, so the contract code changed since that deployment. If that stack is superseded (nothing recorded in p2id.json, no funds sent to it), move the file out of deployments/ and run again';
      const message = `deployments/${file} has factory ${record.factory}; this run would give ${predicted.factory} (${hint}). Every ${environment} chain must match.`;
      if (isLocal()) console.log(`warning: ${message}`);
      else throw new Error(message);
    }
  }

  const plan = process.env.PLAN === '1';
  const [deployer] = await ethers.getSigners();
  if (!plan && !deployer) {
    throw new Error(
      `no deployer key for ${environment}: set DEPLOYER_KEY or DEPLOYER_KEY_${
        environment === 'sandbox' ? 'SANDBOX' : 'PROD'
      } ` + 'to a private key (0x followed by 64 hex characters)',
    );
  }
  const signer = plan ? null : deployer;
  if (plan) console.log('PLAN=1: reading the chain; no transaction is sent');

  // 2. What is already on this chain (e.g. from an interrupted run): those steps are skipped.
  const status = await stackStatus(predicted);
  const present = Object.entries(status)
    .filter(([, v]) => v)
    .map(([k]) => k);
  const missing = Object.entries(status)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  console.log(
    present.length === 0
      ? 'nothing deployed yet on this chain'
      : missing.length === 0
      ? 'the stack is already deployed on this chain'
      : `already deployed, will skip: ${present.join(', ')}`,
  );
  if (plan && missing.length) {
    console.log(
      `a deployment run would deploy: ${missing.join(
        ', ',
      )}\nthen the later verifier sets, and it would write the owner transactions as Safe batches. Nothing to plan until the stack exists.`,
    );
    return;
  }

  // 3. Deploy what is missing, one contract at a time. The read-back checks compare the chain with
  //    the configuration the stack is deployed with, so they run when this run completed it; a
  //    stack that was already there may since have had its attester, signers or default changed.
  const addresses =
    signer === null
      ? predicted
      : await deployStack(params, signer, (m) => console.log(m));
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  // The second constant of the address formula, read back from the deployed factory: the hash of
  // the vault *proxy's* creation code (not the vault implementation's).
  const deployedFactory = await ethers.getContractAt(
    'PviumP2IdVaultFactory',
    addresses.factory,
  );
  if (missing.length) {
    await checkStack(
      params,
      addresses,
      p2id.schemes[scheme]?.vaultInitCodeHash,
    );
    const record = {
      ...summary,
      network: network.name,
      chainId,
      ...addresses,
      baseImplementationContract: 'src/P2IDVault.sol:P2IDVault',
      vaultInitCodeHash: await deployedFactory.initCodeHash(),
      vaultProxyContract: 'src/PviumP2IDVaultProxy.sol:PviumP2IDVaultProxy',
    };
    if (chainId !== 31337) {
      mkdirSync(DEPLOYMENTS, { recursive: true });
      writeFileSync(
        join(DEPLOYMENTS, `${scheme}.${environment}.${chainId}.json`),
        JSON.stringify(record, null, 2) + '\n',
      );
    }
    console.log(JSON.stringify(record, null, 2));
    console.log(`\nwiring checks passed (${environment})`);
  } else {
    const expectedHash = p2id.schemes[scheme]?.vaultInitCodeHash;
    if (
      expectedHash &&
      (await deployedFactory.initCodeHash()) !== expectedHash
    ) {
      throw new Error(
        `factory ${
          addresses.factory
        } reports initCodeHash ${await deployedFactory.initCodeHash()}, not ${expectedHash} (sdks/node/p2id-core/src/p2id.json)`,
      );
    }
    if (
      chainId !== 31337 &&
      !existsSync(join(DEPLOYMENTS, `${scheme}.${environment}.${chainId}.json`))
    ) {
      throw new Error(
        `the stack is on chain ${chainId} but deployments/${scheme}.${environment}.${chainId}.json is missing: restore the record (it is committed with the deployment)`,
      );
    }
  }

  // 4. Record the factory for the SDK. Only when nothing is recorded yet: a recorded address that
  //    differs was refused above, and one that matches needs nothing. Not for local chains.
  if (!plan && chainId !== 31337 && recorded === null) {
    p2id.schemes[scheme].factories[environment] = addresses.factory;
    writeFileSync(P2ID_JSON, JSON.stringify(p2id, null, 2) + '\n');
    console.log(
      `recorded ${environment} factory ${addresses.factory} in sdks/node/p2id-core/src/p2id.json: rebuild the SDK and commit it`,
    );
  }

  // 5. Everything the scheme has released since its factory, and the environment's owner settings.
  if (process.env.STACK_ONLY === '1') {
    console.log('\nSTACK_ONLY=1: stopped after the stack');
    return;
  }
  const result = await syncReleases({
    environment,
    networkName: network.name,
    chainId,
    params,
    keys,
    addresses,
    signer,
    log: (m) => console.log(m),
  });
  if (result.undeployed.length)
    console.log(
      `\na deployment run (without PLAN=1) would deploy: ${result.undeployed.join(
        '; ',
      )}`,
    );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
