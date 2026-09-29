import { expect } from 'chai';
import { readFileSync } from 'fs';
import { join } from 'path';
import { compareLayouts, readContract, validateImplementation, type Layout } from '../scripts/lib/storageLayout';

const root = join(__dirname, '..');
const snapshot: Layout = JSON.parse(readFileSync(join(root, 'storage', 'P2IDVault.layout.json'), 'utf8'));
const errors = (f: { level: string; message: string }[]) => f.filter((x) => x.level === 'error').map((x) => x.message);

/** Every proxy starts on the base vault; anything registered later must keep its storage layout. */
describe('vault implementation storage layout', function () {
  it('the base P2IDVault matches the committed snapshot', () => {
    const base = readContract(root, 'src/P2IDVault.sol:P2IDVault');
    expect(errors(compareLayouts(snapshot, base.layout))).to.deep.equal([]);
    expect(base.layout.storage.length).to.equal(snapshot.storage.length);
  });

  it('implementations that keep the layout and append pass; the base has no delegatecall or selfdestruct', () => {
    for (const name of ['MockVaultV2', 'MockVaultAppends', 'MockProxySlotWriter']) {
      const f = validateImplementation(snapshot, readContract(root, name));
      expect(errors(f), name).to.deep.equal([]);
    }
    const base = readContract(root, 'src/P2IDVault.sol:P2IDVault');
    expect(base.unsafeCalls).to.deep.equal([]);
    expect(base.immutables).to.deep.equal(['P2IDVault.factory']);
  });

  it('a variable inserted, retyped or removed is an error; a rename is a warning', () => {
    const shifted: Layout = JSON.parse(JSON.stringify(snapshot));
    shifted.storage = [{ label: 'inserted', slot: '0', offset: 0, type: 't_uint256', contract: 'X' }, ...shifted.storage.map((v) => ({ ...v, slot: String(Number(v.slot) + 1) }))];
    expect(errors(compareLayouts(snapshot, shifted)).length).to.be.greaterThan(0);

    const retyped: Layout = JSON.parse(JSON.stringify(snapshot));
    const idx = retyped.storage.findIndex((v) => v.label === 'nsHash');
    retyped.storage[idx] = { ...retyped.storage[idx], type: 't_uint256' };
    expect(errors(compareLayouts(snapshot, retyped))).to.have.length(1);

    const removed: Layout = JSON.parse(JSON.stringify(snapshot));
    removed.storage = removed.storage.filter((v) => v.label !== 'deposits');
    expect(errors(compareLayouts(snapshot, removed))).to.have.length(1);

    const renamed: Layout = JSON.parse(JSON.stringify(snapshot));
    renamed.storage[idx] = { ...renamed.storage[idx], label: 'namespaceHash' };
    const f = compareLayouts(snapshot, renamed);
    expect(errors(f)).to.deep.equal([]);
    expect(f.filter((x) => x.level === 'warning')).to.have.length(1);
  });

  it('an implementation without the hook, or with a proxy-reserved selector, is refused', () => {
    const noHook = readContract(root, 'MockIdentityVerifier'); // any contract that is not a vault
    expect(errors(validateImplementation(snapshot, noHook)).some((m) => m.includes('acceptOwnerProof'))).to.equal(true);
    const bad = readContract(root, 'MockVaultV2');
    bad.abi = [...bad.abi, { type: 'function', name: 'upgradeTo', inputs: [{ type: 'bytes32' }, { type: 'address' }, { type: 'bytes' }], outputs: [] }];
    expect(errors(validateImplementation(snapshot, bad)).some((m) => m.includes('answered by the proxy'))).to.equal(true);
  });
});
