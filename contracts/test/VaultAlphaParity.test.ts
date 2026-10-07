import { expect } from 'chai';
import { ethers } from 'hardhat';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
const baseline: { sourceSha256: string; abi: string[]; businessBodySha256: Record<string, string>; otherSourceSha256: string } = JSON.parse(readFileSync(join(__dirname, 'fixtures/vault-before-alpha.json'), 'utf8'));
import { impersonateAccount, setBalance, stopImpersonatingAccount, time } from '@nomicfoundation/hardhat-network-helpers';

describe('single vault: pre-alpha behavior regression', () => {
  it('preserves original business bodies and all source outside the forwarding layer', () => {
    const alpha = readFileSync(join(__dirname, '../src/P2IDVault.sol'), 'utf8');
    const hash = (source: string) => createHash('sha256').update(source).digest('hex');
    const extract = (source: string, name: string) => {
      const start = source.indexOf('    function ' + name + '(');
      expect(start, name).to.be.greaterThan(0);
      const opening = source.indexOf('{', start);
      let end = opening + 1, depth = 1;
      while (depth) { if (source[end] === '{') depth++; if (source[end] === '}') depth--; end++; }
      return { start, end, body: source.slice(opening + 1, end - 1) };
    };
    for (const [name, expected] of Object.entries(baseline.businessBodySha256)) {
      expect(hash(extract(alpha, '_' + name).body), name).to.equal(expected);
      const wrapper = extract(alpha, name).body.trim();
      if (['sweep', 'sweepUntracked', 'sweepDeposits'].includes(name)) {
        expect(wrapper).to.match(new RegExp('^return _' + name + '\\('));
      } else {
        expect(wrapper).to.match(new RegExp('^(return )?' + name + 'WithAttestation\\('));
        expect(wrapper).to.contain('AlphaAttestation(0, 0, hex"")');
      }
    }
    const start = alpha.indexOf('    // ------------------------------------------------------------------ alpha authorization');
    const end = alpha.indexOf('    // ------------------------------------------------------------------ funding', start);
    let originalCode = alpha.slice(0, start) + alpha.slice(end);
    for (const name of Object.keys(baseline.businessBodySha256)) {
      const fn = extract(originalCode, name);
      originalCode = originalCode.slice(0, fn.start) + originalCode.slice(fn.end);
    }
    originalCode = originalCode.replaceAll('bytes memory proof', 'bytes calldata proof')
      .replaceAll('IP2IDVerifier.Constraint memory constraint', 'IP2IDVerifier.Constraint calldata constraint')
      .replaceAll('uint256[] memory depositIds', 'uint256[] calldata depositIds');
    originalCode = originalCode.replace(/(function _present\([\s\S]*?)IP2IDVerifier.Constraint calldata constraint/, '$1IP2IDVerifier.Constraint memory constraint');
    originalCode = originalCode.replace('bool fresh = _ownerFresh(verifier);', 'bool fresh = ownerRevision[verifier] == rev;');
    originalCode = originalCode.replace(/        if \(wallet == owner\[verifier\] && iat == latestProofIat\[verifier\]\) \{[\s\S]*?        }\n/, '');
    originalCode = originalCode.replace(/        if \(!ok \|\| ownerRevision\[verifier\] != rev\) return false;[\s\S]*?        } catch \{ return false; }/, '        return ok && ownerRevision[verifier] == rev;');
    expect(hash(originalCode)).to.equal(baseline.otherSourceSha256);
  });

  it('retains every original ABI entry without changing arguments, returns, events or errors', async () => {
    const alpha = (await ethers.getContractFactory('P2IDVault')).interface;
    const entries = new Set(alpha.fragments.map((fragment) => fragment.format('full')));
    for (const fragment of baseline.abi) expect(entries.has(fragment), fragment).to.equal(true);
  });

  it('preserves funding, cached ownership, ordinary and constrained sweeps, refunds and balances with alpha off', async () => {
    const [admin, recipient] = await ethers.getSigners();
    const verifier = await ethers.deployContract('MockIdentityVerifier');
    const V = await verifier.getAddress();
    const token = await ethers.deployContract('MockERC20');
    const T = await token.getAddress();
    const policy = await ethers.deployContract('PviumP2IDPolicy', [admin.address, [V]]);
    const factory = await ethers.deployContract('PviumP2IdVaultFactory', [admin.address, ethers.id('pvium.vault.v1'), await policy.getAddress(), V, 86400, 0, 86400, ethers.ZeroAddress]);
    await factory.setAlpha(await (await ethers.getContractAt('IP2IDVerifier', await factory.defaultVerifier())).vkHash(), false); // this suite exercises the ordinary (post-alpha) paths
    expect(await factory.isAlpha(await (await ethers.getContractAt('IP2IDVerifier', await factory.defaultVerifier())).vkHash())).to.equal(false);
    const identity = ethers.id('parity identity');
    const constraint = { commitment: ethers.id('parity constraint'), signature: ethers.hexlify(ethers.toUtf8Bytes('ok')) };
    const proof = ethers.AbiCoder.defaultAbiCoder().encode(['address', 'bytes32', 'uint64'], [recipient.address, identity, await time.latest()]);
    const vaults = await Promise.all(['P2IDVault'].map((name) => ethers.deployContract(name, [factory.target])));
    const f = await factory.getAddress();
    await impersonateAccount(f);
    await setBalance(f, ethers.parseEther('1'));
    try {
      const signer = await ethers.getSigner(f);
      for (const vault of vaults) await vault.connect(signer).getFunction('initialize')(ethers.id('pvium.vault.v1'), identity, 0, 86400);
    } finally {
      await stopImpersonatingAccount(f);
    }
    for (const vault of vaults) {
      await token.mint(admin.address, 170n);
      await token.approve(vault.target, 170n);
      await vault.getFunction('fund')(T, 100n, ethers.ZeroHash, 0, ethers.ZeroHash);
      await vault.getFunction('fundWith')(V, T, 30n, constraint.commitment, 0, ethers.ZeroHash);
      await vault.getFunction('fund')(T, 40n, ethers.ZeroHash, 0, ethers.ZeroHash);
      await token.mint(vault.target, 20n);
      await vault.getFunction('refreshProof')(V, proof);
      expect(await vault.getFunction('owner')(V)).to.equal(recipient.address);
      expect(await vault.getFunction('latestProofIat')(V)).to.equal(await vaults[0].getFunction('latestProofIat')(V));
      expect(await vault.getFunction('sweep').staticCall(V, T, 1)).to.deep.equal([120n, 1n]);
      await vault.getFunction('sweep')(V, T, 1);
      expect(await vault.getFunction('sweepBucketDeposits').staticCall(V, constraint, T, [1], proof)).to.equal(30n);
      await vault.getFunction('sweepBucketDeposits')(V, constraint, T, [1], proof);
      await vault.getFunction('refund')(2);
      expect(await vault.getFunction('trackedTotal')(T)).to.equal(0n);
      expect(await vault.getFunction('untrackedBalance')(T)).to.equal(0n);
      expect(await token.balanceOf(vault.target)).to.equal(0n);
      for (const id of [0, 1, 2]) expect((await vault.getFunction('deposits')(id)).consumed).to.equal(true);
    }
    expect(await token.balanceOf(recipient.address)).to.equal(150n);
  });
});
