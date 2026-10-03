// Verify a recorded deployment's contracts on the chain's block explorer.
//
//   yarn verify --network baseSepolia                       # every deployments/*.<chainId>.json for that chain
//   DEPLOYMENT=deployments/pvium.vault.v1.sandbox.84532.json yarn verify --network baseSepolia
//   VAULTS=0xabc…,0xdef… yarn verify --network bsc          # also vault proxies (no constructor args)
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

/** Whether the explorer already has source for `address`; null when it could not be asked. */
async function isVerified(chainId: bigint, address: string, apiKey: string): Promise<boolean | null> {
  const url = `${ETHERSCAN_V2}?chainid=${chainId}&module=contract&action=getsourcecode&address=${address}&apikey=${apiKey}`;
  try {
    const res = await fetch(url);
    const body = (await res.json()) as { status: string; message: string; result: any };
    if (body.status !== '1' || !Array.isArray(body.result)) return null;
    const entry = body.result[0] ?? {};
    return typeof entry.SourceCode === 'string' && entry.SourceCode.length > 0;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  const targets: Target[] = [];
  for (const file of files) {
    const record = JSON.parse(readFileSync(file, 'utf8'));
    if (BigInt(record.chainId) !== chainId) throw new Error(`${file} is for chain ${record.chainId}, not ${chainId}`);
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
  for (const v of (process.env.VAULTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    targets.push(vaultTarget(v));
  }

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
    if (verified === true) {
      console.log(`${label}  already verified, skipped`);
      continue;
    }
    if (verified === null) console.log(`${label}  could not check verification status; submitting anyway`);
    try {
      await run('verify:verify', { address: t.address, constructorArguments: t.args, libraries: t.libraries, contract: t.contract });
      console.log(`${label}  verified`);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (/already verified/i.test(msg)) {
        console.log(`${label}  already verified, skipped`);
      } else {
        failed++;
        console.error(`${label}  FAILED: ${msg.split('\n')[0]}`);
      }
    }
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
