import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checksumAddress, identityHash, p2idAddress, p2idAddressForHash, p2idScheme, P2ID_SCHEME, P2ID_SCHEMES } from '../src/p2id.js';
import { IdentityType, completeIdentityValue, normalizeIdentityValue } from '../src/identity.js';
import { identityTypeName } from '../src/identityNames.js';

// From contracts/test: identityHash('email', 'test-9988@privy.io') and the vault fixture.
const EMAIL_COMMITMENT = '0xbcda0f09fa9732b2bfdea38199486b654a84e8e06085d7e364af8137f8d7deaf';
// Reference vectors produced with ethers.getCreate2Address(factory, salt, initCodeHash).
const FACTORY = '0x1111111111111111111111111111111111111111';
const V1_INIT_CODE_HASH = '0x23dec57677be79edb9ad208117422435778ee00c12d4c56e2edf226d2a57b18a';
const EXPECTED = '0x38aB3Aa9ff0624daA1E73fe539A61e8f147F2FF5';

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

// Released: the production factory is deployed (Base, BSC) and the scheme is frozen.
const V1_PRODUCTION_FACTORY = '0x58982A37b8B0d48A10aB370e000a837cF916526a';
// factory.vaultFor(identityHash('email', 'test-9988@privy.io')) as returned on chain by both Base and BSC.
const V1_PRODUCTION_EMAIL_ADDRESS = '0x9AdcE99AB1f123e7291A2794752b4BA2476328BD';

test('v1 is the current, released scheme', () => {
  assert.equal(P2ID_SCHEME, 'pvium.vault.v1');
  assert.deepEqual(Object.keys(P2ID_SCHEMES), ['pvium.vault.v1']);
  const v1 = p2idScheme('pvium.vault.v1');
  assert.equal(v1.identityDomain, 'p2id.identity.v1');
  assert.equal(v1.vaultInitCodeHash, V1_INIT_CODE_HASH);
  assert.equal(v1.factories.production, V1_PRODUCTION_FACTORY); // released: frozen from here on
  // The sandbox factory is re-recorded after sandbox redeploys.
  if (v1.factories.sandbox !== null) assert.match(v1.factories.sandbox, /^0x[0-9a-fA-F]{40}$/);
  assert.deepEqual(p2idScheme(), v1);
  assert.throws(() => p2idScheme('pvium.vault.v9'), /unknown P2ID scheme "pvium.vault.v9" \(known: pvium.vault.v1\)/);
});

test('p2idAddress reproduces CREATE2 exactly as the factory computes it', async () => {
  assert.equal(p2idAddressForHash(EMAIL_COMMITMENT, { factory: FACTORY }), EXPECTED);
  assert.equal(p2idAddress({ identityType: 'email', identityValue: 'Test-9988@privy.io', factory: FACTORY }), EXPECTED);
  assert.equal(p2idAddress({ identityType: 'email', identityValue: 'test-9988@privy.io', scheme: 'pvium.vault.v1', factory: FACTORY }), EXPECTED);
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
  // production is the default, and matches what the deployed factory returns on chain
  assert.equal(p2idAddress({ identityType: 'email', identityValue: 'test-9988@privy.io' }), V1_PRODUCTION_EMAIL_ADDRESS);
  assert.equal(p2idAddress({ identityType: 'email', identityValue: 'Test-9988@Privy.io', environment: 'production' }), V1_PRODUCTION_EMAIL_ADDRESS);
  assert.throws(() => p2idAddress({ identityType: 'email', identityValue: 'a@b.c', environment: 'staging' as any, factory: FACTORY }),
    /unknown environment "staging"/,
  );
  assert.throws(() => p2idAddressForHash(EMAIL_COMMITMENT, { factory: '0x1234' as `0x${string}` }), /bad factory address/);
  assert.throws(() => p2idAddress({ identityType: 'email', identityValue: 'a@b.c', scheme: 'pvium.vault.v9', factory: FACTORY }), /unknown P2ID scheme/);
});

test('EIP-55 checksum', () => {
  assert.equal(checksumAddress('0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359'), '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359');
  assert.equal(checksumAddress('0xA01b6E60D51eDB3fEB9f86a62b846f4F90070f98'), '0xA01b6E60D51eDB3fEB9f86a62b846f4F90070f98');
});

test('Discord usernames are completed with the #0 discriminator Discord records', () => {
  const full = identityHash(IdentityType.Discord, 'alice#0');
  assert.equal(identityHash(IdentityType.Discord, 'alice'), full);
  assert.equal(identityHash(IdentityType.Discord, 'Alice'), full); // still case-insensitive
  assert.equal(normalizeIdentityValue(IdentityType.Discord, 'Alice'), 'alice#0');
  assert.equal(completeIdentityValue(IdentityType.Discord, 'alice#0'), 'alice#0'); // already appended by the integrator: unchanged
  assert.equal(normalizeIdentityValue(IdentityType.Discord, 'Alice#0'), 'alice#0');
  assert.equal(completeIdentityValue(IdentityType.Discord, 'alice#1234'), 'alice#1234'); // legacy discriminator kept
  assert.notEqual(identityHash(IdentityType.Discord, 'alice#1234'), full);
  assert.equal(completeIdentityValue(IdentityType.Github, 'alice'), 'alice'); // other types untouched
  assert.equal(
    p2idAddress({ identityType: 'discord', identityValue: 'alice', factory: FACTORY }),
    p2idAddress({ identityType: 'discord', identityValue: 'alice#0', factory: FACTORY }),
  );
});
