// Embed the P2ID address schemes from src/p2id.json into src/p2idConstants.ts. Run by `yarn build`;
// the .ts is generated and gitignored. When the Hardhat artifact for the vault proxy is present
// (../../contracts compiled), the CURRENT scheme's init code hash is recomputed from it and must
// match. `--update` rewrites it, but only while that scheme is unreleased (no production factory
// recorded): a released scheme is frozen, and a vault change then needs a new scheme entry with its own salt name (e.g. pvium.vault.v2).
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const jsonPath = join(root, 'src', 'p2id.json');
const cfg = JSON.parse(readFileSync(jsonPath, 'utf8'));
const current = cfg.schemes[cfg.current];
if (!current) throw new Error(`src/p2id.json: current scheme "${cfg.current}" is not defined`);
for (const [name, s] of Object.entries(cfg.schemes)) {
  if (!/^pvium\.vault\.v[1-9][0-9]*$/.test(name)) throw new Error(`bad scheme name "${name}" (expected pvium.vault.vN)`);
  if (!/^0x[0-9a-f]{64}$/.test(s.vaultInitCodeHash)) throw new Error(`${name}: bad vaultInitCodeHash`);
  for (const env of ['production', 'sandbox']) {
    const f = s.factories?.[env];
    if (f === undefined) throw new Error(`${name}: factories.${env} missing (use null until deployed)`);
    if (f !== null && !/^0x[0-9a-fA-F]{40}$/.test(f)) throw new Error(`${name}: bad factories.${env}`);
    for (const [version, v] of Object.entries(s.verifiers?.[env] ?? {})) {
      if (!/^[1-9][0-9]*$/.test(version)) throw new Error(`${name}: verifiers.${env} key "${version}" is not a circuit version`);
      if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${name}: bad verifiers.${env}.${version}`);
    }
  }
}

// --- Solana: program ids, recorded factories and verifiers per environment -----------------------
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isKey = (v) => typeof v === 'string' && BASE58.test(v) && base58.decode(v).length === 32;
const pda = (seeds, programId) => {
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256.create();
    for (const seed of seeds) h.update(seed);
    h.update(new Uint8Array([bump]));
    h.update(base58.decode(programId));
    h.update(new TextEncoder().encode('ProgramDerivedAddress'));
    const out = h.digest();
    try { ed25519.ExtendedPoint.fromHex(out); } catch { return base58.encode(out); }
  }
  throw new Error('no PDA');
};
const hexBytes = (h) => Uint8Array.from(h.replace(/^0x/, '').match(/../g).map((b) => parseInt(b, 16)));
const u16be = (n) => new Uint8Array([n >> 8, n & 0xff]);
const i64be = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(n)); return b; };
const paramsHashOf = (p) => {
  const h = sha256.create();
  h.update(new TextEncoder().encode('p2id.factory.params.v1'));
  h.update(new Uint8Array([p.signerKeys.length]));
  for (const k of p.signerKeys) h.update(hexBytes(k));
  for (const k of [p.defaultVerifier, p.policy, p.defaultImplementation, p.alphaAttester]) h.update(base58.decode(k));
  h.update(u16be(p.circuitVersion));
  h.update(hexBytes(p.vkHash));
  h.update(i64be(p.minRefundWindow));
  h.update(i64be(p.maxRefundWindow));
  return '0x' + Buffer.from(h.digest()).toString('hex');
};
const factoryOf = (schemeName, sol, f) =>
  pda([Buffer.from('p2id.factory.v1'), Buffer.from(schemeName), base58.decode(f.authority), hexBytes(f.paramsHash)], sol.programs.router);

// `--update`: take the factories and verifiers from solana-anchor/deployments/<scheme>.<env>.<cluster>.json,
// written by `yarn deploy` there. Production entries freeze once recorded, like the EVM factory.
const deployments = join(root, '..', '..', '..', 'solana-anchor', 'deployments');
if (process.argv.includes('--update') && existsSync(deployments)) {
  const sol = current.solana;
  for (const file of readdirSync(deployments).filter((f) => f.startsWith(`${cfg.current}.`) && f.endsWith('.json'))) {
    const rec = JSON.parse(readFileSync(join(deployments, file), 'utf8'));
    const env = rec.environment;
    if (!['production', 'sandbox'].includes(env) || rec.scheme !== cfg.current) continue;
    const factory = {
      address: rec.factory, authority: rec.config.authority, paramsHash: rec.paramsHash, policyFeeBps: rec.config.policyFeeBps,
      params: {
        signerKeys: rec.privyKeys.map((k) => '0x' + k.x.replace(/^0x/, '') + k.y.replace(/^0x/, '')),
        defaultVerifier: rec.programs.verifier, policy: rec.policyPda, defaultImplementation: rec.programs.implementation,
        alphaAttester: rec.config.alphaAttester, circuitVersion: rec.config.circuitVersion, vkHash: rec.config.vkHash,
        minRefundWindow: rec.config.minRefundWindow, maxRefundWindow: rec.config.maxRefundWindow,
      },
    };
    const verifier = { program: rec.programs.verifier, zkVerifier: rec.programs.zkVerifier, vkHash: rec.config.vkHash };
    const frozen = env === 'production' && sol.factories.production !== null;
    if (frozen && sol.factories.production.address !== factory.address) {
      throw new Error(`${file}: production factory ${factory.address} differs from the recorded ${sol.factories.production.address}; a new stack is a new scheme entry`);
    }
    for (const [name, want] of [['router', rec.programs.router], ['policy', rec.programs.policy], ['implementation', rec.programs.implementation]]) {
      if (sol.programs[name] !== want) throw new Error(`${file}: ${name} program ${want} differs from ${sol.programs[name]} in src/p2id.json`);
    }
    sol.factories[env] = factory;
    sol.verifiers[env][String(rec.config.circuitVersion)] = verifier;
    console.log(`recorded ${env} Solana factory ${factory.address} and circuit ${rec.config.circuitVersion} verifier from ${file}`);
  }
  writeFileSync(jsonPath, JSON.stringify(cfg, null, 2) + '\n');
}

for (const [name, s] of Object.entries(cfg.schemes)) {
  const sol = s.solana;
  if (!sol) throw new Error(`${name}: solana block missing`);
  for (const k of ['router', 'policy', 'implementation']) {
    if (!isKey(sol.programs?.[k])) throw new Error(`${name}: solana.programs.${k} is not a base58 program id`);
  }
  for (const env of ['production', 'sandbox']) {
    const f = sol.factories?.[env];
    if (f === undefined) throw new Error(`${name}: solana.factories.${env} missing (use null until deployed)`);
    if (f !== null) {
      for (const k of ['address', 'authority']) if (!isKey(f[k])) throw new Error(`${name}: solana.factories.${env}.${k} is not a base58 key`);
      const want = paramsHashOf(f.params);
      if (want !== f.paramsHash) throw new Error(`${name}: solana.factories.${env}.paramsHash is ${f.paramsHash} but the params hash to ${want}`);
      const at = factoryOf(name, sol, f);
      if (at !== f.address) throw new Error(`${name}: solana.factories.${env} records ${f.address} but authority + params derive ${at}`);
    }
    for (const [version, v] of Object.entries(sol.verifiers?.[env] ?? {})) {
      if (!/^[1-9][0-9]*$/.test(version)) throw new Error(`${name}: solana.verifiers.${env} key "${version}" is not a circuit version`);
      if (!isKey(v.program) || !isKey(v.zkVerifier)) throw new Error(`${name}: solana.verifiers.${env}.${version} programs must be base58 keys`);
      if (!/^0x[0-9a-f]{64}$/.test(v.vkHash)) throw new Error(`${name}: solana.verifiers.${env}.${version}.vkHash must be 32 bytes of lowercase hex`);
    }
  }
}

const artifact = join(root, '..', '..', '..', 'contracts', 'artifacts', 'src', 'PviumP2IDVaultProxy.sol', 'PviumP2IDVaultProxy.json');
if (existsSync(artifact)) {
  const { bytecode } = JSON.parse(readFileSync(artifact, 'utf8'));
  const hex = bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode;
  const bytes = Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)));
  const actual = '0x' + Buffer.from(keccak_256(bytes)).toString('hex');
  if (actual !== current.vaultInitCodeHash) {
    // Only a mainnet factory freezes a scheme: sandbox stacks are redeployed freely while the
    // vault is still changing, and their recorded factory is simply re-predicted.
    if (current.factories.production !== null) {
      throw new Error(
        `the vault proxy now hashes to ${actual}, but ${cfg.current} is released (production factory ${current.factories.production}) and frozen at ` +
          `${current.vaultInitCodeHash}. A vault change moves every address: add a new scheme entry with its own salt name (e.g. pvium.vault.v2) to src/p2id.json and make it current.`,
      );
    }
    if (!process.argv.includes('--update')) {
      throw new Error(`vault proxy artifact hashes to ${actual} but ${cfg.current} says ${current.vaultInitCodeHash}; run node scripts/embed-p2id.mjs --update`);
    }
    current.vaultInitCodeHash = actual;
    // A sandbox factory built with the previous proxy cannot deploy this creation code.
    current.factories.sandbox = null;
    writeFileSync(jsonPath, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`updated ${cfg.current} vaultInitCodeHash -> ${actual}`);
  }
}

const schemes = Object.fromEntries(
  Object.entries(cfg.schemes).map(([name, s]) => [name, {
    identityDomain: s.identityDomain, vaultInitCodeHash: s.vaultInitCodeHash, factories: s.factories,
    verifiers: { production: s.verifiers?.production ?? {}, sandbox: s.verifiers?.sandbox ?? {} },
    solana: {
      programs: s.solana.programs,
      factories: { production: s.solana.factories.production, sandbox: s.solana.factories.sandbox },
      verifiers: { production: s.solana.verifiers?.production ?? {}, sandbox: s.solana.verifiers?.sandbox ?? {} },
    },
  }]),
);
const out = `// GENERATED by scripts/embed-p2id.mjs from src/p2id.json — do not edit.
export interface P2IDScheme {
  /** Domain prefix of the identity hash this scheme salts vaults with, e.g. "p2id.identity.v1". */
  identityDomain: string;
  /** keccak256 of the P2IDVault creation code; with the factory address it fixes every vault address. */
  vaultInitCodeHash: \`0x\${string}\`;
  /**
   * The PviumP2IdVaultFactory per Pvium environment. Deployed through the deterministic deployment
   * proxy, so within an environment it has one address on every EVM chain. "production" is the
   * mainnet stack, "sandbox" the testnet stack (a different Privy app and key set). Null until
   * that environment's first deployment is recorded.
   */
  factories: { production: \`0x\${string}\` | null; sandbox: \`0x\${string}\` | null };
  /**
   * The factory policy's approved verifiers per environment, keyed by the circuit version they
   * verify. Same address on every chain of an environment. The newest is what new payments
   * should fund under; older ones stay listed so their deposits can be claimed.
   */
  verifiers: { production: Readonly<Record<string, \`0x\${string}\`>>; sandbox: Readonly<Record<string, \`0x\${string}\`>> };
  /** The scheme's Solana stack. */
  solana: P2IDSolanaScheme;
}
/** What a Solana factory's address commits to besides its authority (initialize_factory arguments). */
export interface P2IDSolanaFactoryParams {
  /** P-256 token-signing keys accepted at initialization, each x ‖ y as 64 bytes of hex. */
  signerKeys: readonly \`0x\${string}\`[];
  /** The verifier program the factory starts with (its first default). */
  defaultVerifier: string;
  /** The fee policy account. */
  policy: string;
  /** The vault implementation program the factory starts with. */
  defaultImplementation: string;
  /** The backend's alpha attester key. */
  alphaAttester: string;
  /** The circuit version the default verifier verifies, and the sha256 of its verifying key. */
  circuitVersion: number;
  vkHash: \`0x\${string}\`;
  /** Bounds, in seconds, on a deposit's refund window. */
  minRefundWindow: number;
  maxRefundWindow: number;
}
/** A deployed Solana factory: its address and what the address commits to. */
export interface P2IDSolanaFactory {
  address: string;
  authority: string;
  paramsHash: \`0x\${string}\`;
  params: P2IDSolanaFactoryParams;
  policyFeeBps: number;
}
/** A verifier program of one circuit version: the adapter the factory accepts, the zk program behind it, its vk hash. */
export interface P2IDSolanaVerifier {
  program: string;
  zkVerifier: string;
  /** sha256 of the verifying key the zk program was generated from; what attestations for it carry as vkHash. */
  vkHash: \`0x\${string}\`;
}
export interface P2IDSolanaScheme {
  /** The router (owns factories, vaults and deposits), fee policy and vault implementation programs. Same id on every cluster. */
  programs: { router: string; policy: string; implementation: string };
  /** The factory per Pvium environment: "production" on mainnet, "sandbox" on devnet. Null until recorded. */
  factories: { production: P2IDSolanaFactory | null; sandbox: P2IDSolanaFactory | null };
  /** The verifier of each circuit version per environment (Solana verifying keys differ per environment). */
  verifiers: { production: Readonly<Record<string, P2IDSolanaVerifier>>; sandbox: Readonly<Record<string, P2IDSolanaVerifier>> };
}
/** Every P2ID address scheme this release can derive, keyed by domain. Older schemes stay forever. */
export const P2ID_SCHEMES = ${JSON.stringify(schemes, null, 2)} as const satisfies Record<string, P2IDScheme>;
export type P2IDSchemeName = keyof typeof P2ID_SCHEMES;
/** The scheme new payments should use. */
export const P2ID_SCHEME = '${cfg.current}' as const satisfies P2IDSchemeName;
`;
writeFileSync(join(root, 'src', 'p2idConstants.ts'), out);
console.log(`embedded P2ID schemes: ${Object.keys(cfg.schemes).join(', ')} (current ${cfg.current}; EVM production ${current.factories.production ?? 'not deployed'}, sandbox ${current.factories.sandbox ?? 'not deployed'}; Solana production ${current.solana.factories.production?.address ?? 'not deployed'}, sandbox ${current.solana.factories.sandbox?.address ?? 'not deployed'})`);
