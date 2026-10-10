// Verify a recorded deployment's contracts on the chain's block explorer.
//
//   yarn verify --network baseSepolia                       # every deployments/*.<chainId>.json for that chain
//   DEPLOYMENT=deployments/pvium.vault.v1.sandbox.84532.json yarn verify --network baseSepolia
//   VAULTS=0xabc…,0xdef… yarn verify --network bsc          # also vault proxies (no constructor args)
//   VAULT=0xabc… yarn verify:vault --network base           # only the given vault(s), linked to their implementation
//   DRY_RUN=1 yarn verify --network base                    # plan only: no explorer calls
//
// Reads each contract's address and constructor arguments from the deployment record (written by
// deploy-deterministic.ts), asks the explorer whether the address is already verified, and submits
// only what is not. One ETHERSCAN_API_KEY (contracts/.env) covers every chain through the
// Etherscan V2 API. A record must come from the build being verified: the explorer compares the
// compiled bytecode with what is on chain, so an older record needs its own commit checked out.
import { ethers, network, run } from 'hardhat';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const DEPLOYMENTS = join(__dirname, '..', 'deployments');
const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';

interface Target {
  name: string;
  contract: string; // fully qualified, so same-named artifacts can never be confused
  address: string;
  args: unknown[];
  libraries?: Record<string, string>;
}

export function targetsOf(r: any): Target[] {
  const z = ethers.ZeroAddress;
  const keys: { x: string; y: string }[] = r.privyKeys; // already sorted as the constructor received them
  const attester: string = r.config.attester;
  return [
    { name: 'RelationsLib', contract: 'src/PviumZKVerifier.sol:RelationsLib', address: r.relationsLib, args: [] },
    { name: 'ZKTranscriptLib', contract: 'src/PviumZKVerifier.sol:ZKTranscriptLib', address: r.transcriptLib, args: [] },
    {
      name: 'PviumZKVerifier', contract: 'src/PviumZKVerifier.sol:PviumZKVerifier', address: r.zkVerifier, args: [],
      libraries: { RelationsLib: r.relationsLib, ZKTranscriptLib: r.transcriptLib },
    },
    {
      name: 'PviumIdentity', contract: 'src/PviumIdentity.sol:PviumIdentity', address: r.pviumIdentity,
      args: [r.zkVerifier, r.config.circuitVersion, ...(r.config.vkHash === undefined ? [] : [r.config.vkHash]), r.config.owner, keys.map((k) => k.x), keys.map((k) => k.y)],
    },
    {
      name: 'PviumVerifier', contract: 'src/PviumVerifier.sol:PviumVerifier', address: r.pviumVerifier,
      args: [r.pviumIdentity, r.config.owner, attester.toLowerCase() === z ? [] : [attester]],
    },
    { name: 'PviumP2IDPolicy', contract: 'src/PviumP2IDPolicy.sol:PviumP2IDPolicy', address: r.policy, args: [r.config.owner, [r.pviumVerifier]] },
    {
      name: 'PviumP2IdVaultFactory', contract: 'src/PviumP2IdVaultFactory.sol:PviumP2IdVaultFactory', address: r.factory,
      args: [r.config.owner, ethers.id(r.scheme), r.policy, r.pviumVerifier, r.config.policyChangeDelay, r.config.minRefundWindow, r.config.maxRefundWindow, ...(r.config.alphaAttester === undefined ? [] : [r.config.alphaAttester])],
    },
    {
      name: 'P2IDVault', contract: r.baseImplementationContract ?? 'src/P2IDVault.sol:P2IDVault',
      // The factory creates its base implementation as its first CREATE in the constructor.
      address: r.baseImplementation ?? ethers.getCreateAddress({ from: r.factory, nonce: 1 }), args: [r.factory],
    },
  ];
}

export function vaultTarget(address: string): Target {
  return { name: 'PviumP2IDVaultProxy', contract: 'src/PviumP2IDVaultProxy.sol:PviumP2IDVaultProxy',
    address: ethers.getAddress(address), args: [] };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Refuse anything that is not a P2ID vault proxy, naming it when it is a recorded stack contract. */
async function checkIsVault(address: string, records: any[]): Promise<string> {
  const known = records.flatMap((r) => Object.entries(r).filter(([, v]) => typeof v === 'string' && v.toLowerCase() === address.toLowerCase()).map(([k]) => `${k} of ${r.scheme}/${r.environment}`));
  const proxy = new ethers.Contract(address, ['function implementation() view returns (address)', 'function factory() view returns (address)'], ethers.provider);
  try {
    const [impl, factory] = await Promise.all([proxy.implementation(), proxy.factory()]);
    const owner = records.find((r) => r.factory?.toLowerCase() === String(factory).toLowerCase());
    if (!owner) throw new Error(`its factory ${factory} is not in any deployment record for this chain`);
    return impl as string;
  } catch (err) {
    const what = known.length ? `it is the ${known.join(', ')}, not a vault` : `it does not answer implementation()/factory() like a P2ID vault proxy (${(err as Error).message.split('\n')[0]})`;
    throw new Error(`${address}: ${what}. Use \`yarn verify\` for stack contracts.`);
  }
}

/** Ask the explorer to treat a verified ERC-1967 proxy as a proxy of `implementation` (Read/Write as Proxy). */
async function linkProxy(chainId: bigint, address: string, implementation: string, apiKey: string): Promise<string> {
  const body = new URLSearchParams({ module: 'contract', action: 'verifyproxycontract', address, expectedimplementation: implementation });
  const res = await (await fetch(`${ETHERSCAN_V2}?chainid=${chainId}&apikey=${apiKey}`, { method: 'POST', body })).json() as { status: string; result: string };
  if (res.status !== '1') return `proxy link not submitted: ${res.result}`;
  for (let i = 0; i < 6; i++) {
    await sleep(3000);
    const check = await (await fetch(`${ETHERSCAN_V2}?chainid=${chainId}&module=contract&action=checkproxyverification&guid=${res.result}&apikey=${apiKey}`)).json() as { status: string; result: string };
    if (check.status === '1' || !/pending|in queue/i.test(check.result)) return check.result;
  }
  return 'proxy link submitted; still pending on the explorer';
}
const RATE_LIMITED = /rate limit|max calls per sec/i;

/** Whether the explorer has an exact source match for `address`; null when it could not be asked.
 *  A "similar match" (source the explorer borrowed from another contract with the same runtime
 *  code, e.g. an earlier build differing only in its constructor) does not count: it can show
 *  source that is not what was deployed, so it is resubmitted for an exact match. */
async function isVerified(chainId: bigint, address: string, apiKey: string): Promise<boolean | null> {
  const url = `${ETHERSCAN_V2}?chainid=${chainId}&module=contract&action=getsourcecode&address=${address}&apikey=${apiKey}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url);
      const body = (await res.json()) as { status: string; message: string; result: any };
      if (body.status === '1' && Array.isArray(body.result)) {
        const entry = body.result[0] ?? {};
        return typeof entry.SourceCode === 'string' && entry.SourceCode.length > 0 && !entry.SimilarMatch;
      }
      if (!RATE_LIMITED.test(`${body.message} ${body.result}`)) return null;
    } catch {
      return null;
    }
    await sleep(1500 * attempt); // rate limited: back off and ask again
  }
  return null;
}

/** Submit through hardhat-verify, retrying when the explorer rate-limits the burst of calls it makes. */
async function submit(t: Target): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      // force: our own check found no exact match, so submit even if the plugin's check is
      // satisfied by a similar match.
      await run('verify:verify', { address: t.address, constructorArguments: t.args, libraries: t.libraries, contract: t.contract, force: true });
      return;
    } catch (err) {
      if (attempt >= 5 || !RATE_LIMITED.test((err as Error).message ?? '')) throw err;
      await sleep(2000 * attempt);
    }
  }
}

async function main() {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const dryRun = process.env.DRY_RUN === '1';
  const apiKey = process.env.ETHERSCAN_API_KEY ?? '';
  if (!dryRun && (apiKey === '' || apiKey.startsWith('<'))) {
    throw new Error('ETHERSCAN_API_KEY is not set in contracts/.env (one key covers every chain through the Etherscan V2 API)');
  }

  const files = process.env.DEPLOYMENT
    ? [process.env.DEPLOYMENT]
    : existsSync(DEPLOYMENTS)
      ? readdirSync(DEPLOYMENTS).filter((f) => f.endsWith(`.${chainId}.json`)).map((f) => join(DEPLOYMENTS, f))
      : [];
  if (files.length === 0) throw new Error(`no deployment record for chain ${chainId} (${network.name}) in ${DEPLOYMENTS}; set DEPLOYMENT=<file>`);

  const vaultsOnly = process.env.VAULTS_ONLY === '1';
  const targets: Target[] = [];
  const records: any[] = [];
  for (const file of files) {
    const record = JSON.parse(readFileSync(file, 'utf8'));
    if (BigInt(record.chainId) !== chainId) throw new Error(`${file} is for chain ${record.chainId}, not ${chainId}`);
    records.push(record);
    if (vaultsOnly) continue;
    console.log(`record ${file}: ${record.scheme} / ${record.environment}`);
    targets.push(...targetsOf(record));
  }
  for (const spec of (process.env.IMPLEMENTATIONS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [contract, address] = spec.split('@');
    if (!contract?.includes(':') || !address) throw new Error(`IMPLEMENTATIONS entries look like src/File.sol:Name@0xaddress, got "${spec}"`);
    // Implementations take the factory as their only constructor argument (see deployVaultImplementation).
    const factoryAddress = files.length ? JSON.parse(readFileSync(files[0], 'utf8')).factory : undefined;
    targets.push({ name: contract.split(':')[1], contract, address: ethers.getAddress(address), args: [factoryAddress] });
  }
  const vaultImpls = new Map<string, string>();
  for (const v of `${process.env.VAULTS ?? ''},${process.env.VAULT ?? ''}`.split(',').map((s) => s.trim()).filter(Boolean)) {
    const t = vaultTarget(v);
    vaultImpls.set(t.address, await checkIsVault(t.address, records));
    targets.push(t);
  }
  if (vaultsOnly && vaultImpls.size === 0) throw new Error('set VAULT=0x… (or VAULTS=0x…,0x…) to the vault address(es) to verify');

  let failed = 0;
  for (const t of targets) {
    const label = `${t.name.padEnd(22)} ${t.address}`;
    if ((await ethers.provider.getCode(t.address)) === '0x') {
      console.log(`${label}  no code on ${network.name}, skipped`);
      continue;
    }
    if (dryRun) {
      console.log(`${label}  would verify with args ${JSON.stringify(t.args)}${t.libraries ? ' and libraries ' + JSON.stringify(t.libraries) : ''}`);
      continue;
    }
    const verified = await isVerified(chainId, t.address, apiKey);
    let ok = verified === true;
    if (ok) {
      console.log(`${label}  already verified, skipped`);
    } else {
      if (verified === null) console.log(`${label}  could not check verification status; submitting anyway`);
      try {
        await submit(t);
        console.log(`${label}  verified`);
        ok = true;
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        if (/already verified/i.test(msg)) {
          console.log(`${label}  already verified, skipped`);
          ok = true;
        } else {
          failed++;
          console.error(`${label}  FAILED: ${msg.split('\n')[0]}`);
        }
      }
    }
    // A vault proxy is also linked to its implementation, so the explorer offers Read/Write as Proxy.
    const impl = vaultImpls.get(t.address);
    if (ok && impl) console.log(`${label}  proxy of ${impl}: ${await linkProxy(chainId, t.address, impl, apiKey)}`);
    await sleep(1000); // explorer rate limit
  }
  if (failed > 0) throw new Error(`${failed} contract(s) failed verification`);
  console.log('done');
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
