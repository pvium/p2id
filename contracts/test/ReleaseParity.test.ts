import { expect } from 'chai';
import { ethers } from 'hardhat';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  circuitRelease, circuitVersions, deployVerifierSet, predictStack, stackCircuitVersion, vaultImplementationReleases,
} from '../scripts/lib/deterministic';
import { implementationCreationCode } from '../scripts/lib/implementation';

// Released source files are never edited: a changed contract or a new circuit version is a new
// file and a new entry in contracts/releases.json. These tests hold that to account by rebuilding
// every recorded deployment from this checkout and comparing addresses.
const DEPLOYMENTS = join(__dirname, '..', 'deployments');
const records = readdirSync(DEPLOYMENTS).filter((f) => f.endsWith('.json')).map((file) => ({ file, r: JSON.parse(readFileSync(join(DEPLOYMENTS, file), 'utf8')) }));
const keysOf = (r: any) => r.privyKeys.map((k: any) => ({ x: BigInt(k.x), y: BigInt(k.y) }));
const lower = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.toLowerCase()]));

describe('release parity: this checkout rebuilds what is deployed', function () {
  this.timeout(120_000);

  it('releases.json names an existing contract pair and vk hash for every circuit version, and the current circuit is one of them', async () => {
    for (const v of circuitVersions()) {
      const release = circuitRelease(v);
      expect(release.vkHash, `circuit v${v} vkHash`).to.match(/^0x[0-9a-f]{64}$/);
      await ethers.getContractFactory(release.verifier); // throws when the artifact is missing
      expect((await ethers.getContractFactory(release.zkVerifier.split(':')[0] + ':RelationsLib')).bytecode).to.not.equal('0x');
    }
    const current = JSON.parse(readFileSync(join(__dirname, '..', '..', 'circuit', 'version.json'), 'utf8'));
    expect(circuitRelease(current.circuitVersion).vkHash).to.equal(current.vkSha256);
  });

  for (const { file, r } of records.filter((x) => x.r.kind !== 'verifier-set')) {
    it(`${file}: the stack (factory, policy, base vault, first verifier set)`, async () => {
      expect(r.config.circuitVersion).to.equal(stackCircuitVersion(r.scheme));
      expect(r.config.vkHash).to.equal(circuitRelease(r.config.circuitVersion).vkHash);
      const predicted = await predictStack({
        owner: r.config.owner, scheme: r.scheme, circuitVersion: r.config.circuitVersion, vkHash: r.config.vkHash,
        signerKeys: keysOf(r), attester: r.config.attester, alphaAttester: r.config.alphaAttester,
        policyChangeDelay: r.config.policyChangeDelay, minRefundWindow: r.config.minRefundWindow, maxRefundWindow: r.config.maxRefundWindow,
      });
      const recorded = Object.fromEntries(Object.keys(predicted).map((k) => [k, r[k]]));
      expect(lower(predicted as any)).to.deep.equal(lower(recorded));
      expect(ethers.keccak256((await ethers.getContractFactory('PviumP2IDVaultProxy')).bytecode)).to.equal(r.vaultInitCodeHash);
    });
  }

  for (const { file, r } of records.filter((x) => x.r.kind === 'verifier-set')) {
    it(`${file}: the circuit v${r.circuitVersion} verifier set`, async () => {
      expect(r.vkHash).to.equal(circuitRelease(r.circuitVersion).vkHash);
      const predicted = await deployVerifierSet({
        scheme: r.scheme, owner: r.config.owner, circuitVersion: r.circuitVersion, vkHash: r.vkHash, signerKeys: keysOf(r), attester: r.config.attester,
      }, null);
      const recorded = Object.fromEntries(Object.keys(predicted).map((k) => [k, r[k]]));
      expect(lower(predicted as any)).to.deep.equal(lower(recorded));
    });
  }

  it('every prepared vault implementation Safe batch carries the creation code this checkout builds', async () => {
    const iface = (await ethers.getContractFactory('PviumP2IdVaultFactory')).interface;
    let checked = 0;
    for (const { r } of records.filter((x) => x.r.kind !== 'verifier-set')) {
      for (const impl of vaultImplementationReleases(r.scheme)) {
        const batchFile = join(DEPLOYMENTS, 'safe', `${r.scheme}.${r.environment}.${r.chainId}.${impl.label}-propose.json`);
        if (!existsSync(batchFile)) continue;
        const batch = JSON.parse(readFileSync(batchFile, 'utf8'));
        expect(batch.transactions).to.have.length(1);
        expect(batch.transactions[0].to.toLowerCase()).to.equal(r.factory.toLowerCase());
        expect(batch.transactions[0].data, batchFile).to.equal(
          iface.encodeFunctionData('deployVaultImplementation', [await implementationCreationCode(impl.contract, r.factory), impl.makeDefault]));
        checked++;
      }
    }
    expect(checked).to.be.greaterThan(0);
  });
});
