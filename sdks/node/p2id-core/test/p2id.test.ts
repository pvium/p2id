import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checksumAddress, identityHash, p2idAddress, p2idAddressForHash, p2idScheme, P2ID_SCHEME, P2ID_SCHEMES } from '../src/p2id.js';
import { IdentityType } from '../src/identity.js';
import { identityTypeName } from '../src/identityNames.js';

// From contracts/test: identityHash('email', 'test-9988@privy.io') and the vault fixture.
const EMAIL_COMMITMENT = '0xbcda0f09fa9732b2bfdea38199486b654a84e8e06085d7e364af8137f8d7deaf';
// Reference vectors produced with ethers.getCreate2Address(factory, salt, initCodeHash).
const FACTORY = '0x1111111111111111111111111111111111111111';
const V1_INIT_CODE_HASH = '0xe6b8d636ef647cfda0770fa7f2a8c93b886399c3d9405ffcb35ef946083a0802';
const V1_EXPECTED = '0x8A80393355203688dB12731f7c1e677ef49Ca87D';
const V2_INIT_CODE_HASH = '0x5d4eab8fb0d7ca20e288e2953f8029d9caca9d58cc098f67b8f88d9723328c1e';
const EXPECTED = '0x892b8f40737C601C86e714c451492909f2ad1D1D';

test('IdentityType.X is the same identity as IdentityType.Twitter and the Privy name', async () => {
  assert.equal(IdentityType.X, IdentityType.Twitter);
  const byEnum = p2idAddress({ identityType: IdentityType.X, identityValue: 'jack', factory: FACTORY });
  assert.equal(p2idAddress({ identityType: IdentityType.Twitter, identityValue: 'jack', factory: FACTORY }), byEnum);
  assert.equal(p2idAddress({ identityType: 'twitter', identityValue: 'Jack', factory: FACTORY }), byEnum);
  assert.equal(p2idAddress({ identityType: 'x', identityValue: 'jack', factory: FACTORY }), byEnum);
  assert.equal(p2idAddress({ identityType: 'twitter', identityValue: 'jack', factory: FACTORY }), byEnum);
  assert.equal(identityTypeName(IdentityType.Twitter), 'x');
});

test('identityHash matches the circuit and contract fixtures, by id or by name, case-insensitively', async () => {
  assert.equal(identityHash('email', 'test-9988@privy.io'), EMAIL_COMMITMENT);
  assert.equal(identityHash(IdentityType.Email, 'TEST-9988@Privy.IO'), EMAIL_COMMITMENT);
  assert.notEqual(identityHash('phone', '+15551234567'), identityHash('phone', '+15551234568'));
});

test('v2 is current; v1 keeps its recorded hash and factory', () => {
  assert.equal(P2ID_SCHEME, 'p2id.vault.v2');
  assert.deepEqual(Object.keys(P2ID_SCHEMES), ['p2id.vault.v1', 'p2id.vault.v2']);
  const v1 = p2idScheme('p2id.vault.v1');
  assert.equal(v1.identityDomain, 'p2id.identity.v1');
  assert.equal(v1.vaultInitCodeHash, V1_INIT_CODE_HASH);
  assert.equal(v1.factories.sandbox, '0x21859137b4979B101079742942c741224529eE6D');
  const v2 = p2idScheme('p2id.vault.v2');
  assert.equal(v2.identityDomain, v1.identityDomain);
  assert.equal(v2.vaultInitCodeHash, V2_INIT_CODE_HASH);
  assert.deepEqual(p2idScheme(), v2);
  assert.throws(() => p2idScheme('p2id.vault.v9'), /unknown P2ID scheme "p2id.vault.v9" \(known: p2id.vault.v1, p2id.vault.v2\)/);
});

test('p2idAddress reproduces CREATE2 exactly as the factory computes it', async () => {
  assert.equal(p2idAddressForHash(EMAIL_COMMITMENT, { factory: FACTORY }), EXPECTED);
  assert.equal(p2idAddress({ identityType: 'email', identityValue: 'Test-9988@privy.io', factory: FACTORY }), EXPECTED);
  assert.equal(p2idAddress({ identityType: 'email', identityValue: 'test-9988@privy.io', scheme: 'p2id.vault.v1', factory: FACTORY }), V1_EXPECTED);
  assert.notEqual(EXPECTED, V1_EXPECTED);
  // a different identity or factory moves the address
  assert.notEqual(p2idAddress({ identityType: 'email', identityValue: 'other@privy.io', factory: FACTORY }), EXPECTED);
  assert.notEqual(p2idAddressForHash(EMAIL_COMMITMENT, { factory: '0x2222222222222222222222222222222222222222' }), EXPECTED);
});

test('the address takes no chain: one factory per environment, and a missing one fails loudly', async () => {
  for (const environment of ['production', 'sandbox'] as const) {
    const recorded = p2idScheme().factories[environment];
    const call = () => p2idAddress({ identityType: 'email', identityValue: 'test-9988@privy.io', environment });
    if (recorded === null) {
      assert.throws(call, new RegExp(`has no ${environment} factory address in this release yet`));
    } else {
      assert.equal(call(), p2idAddressForHash(EMAIL_COMMITMENT, { environment }));
    }
  }
  // production is the default
  if (p2idScheme().factories.production === null) {
    assert.throws(() => p2idAddress({ identityType: 'email', identityValue: 'test-9988@privy.io' }), /no production factory/);
  }
  assert.throws(() => p2idAddress({ identityType: 'email', identityValue: 'a@b.c', environment: 'staging' as any, factory: FACTORY }),
    /unknown environment "staging"/,
  );
  assert.throws(() => p2idAddressForHash(EMAIL_COMMITMENT, { factory: '0x1234' as `0x${string}` }), /bad factory address/);
  assert.throws(() => p2idAddress({ identityType: 'email', identityValue: 'a@b.c', scheme: 'p2id.vault.v9', factory: FACTORY }), /unknown P2ID scheme/);
});

test('EIP-55 checksum', () => {
  assert.equal(checksumAddress('0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359'), '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359');
  assert.equal(checksumAddress('0xA01b6E60D51eDB3fEB9f86a62b846f4F90070f98'), '0xA01b6E60D51eDB3fEB9f86a62b846f4F90070f98');
});
