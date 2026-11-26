import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyIdentity, type Attestation } from '../src/index.js';
import * as V1 from '../src/v1.js';
import * as V2 from '../src/v2.js';
import {
  IdentityType,
  MalformedError,
  SOLANA_CIRCUITS,
  decodeClaim,
  identityHash,
  parseGnarkProof,
  parseGnarkVerifyingKey,
  parseSolanaVerifyingKey,
  solanaCandidates,
  solanaVerifyingKey,
  splitPublicWitness,
  toPublicInputFields,
  verifySolanaProof,
} from '../src/internal.test-helpers.js';

// The sample Solana proof: the repository's sample Privy token (sandbox app, email
// test-9988@privy.io) bound to the Solana wallet linked in it, proven under the sandbox trusted
// setup by circuit/scripts/sunspot-prove.sh and synced here with `yarn sync --solana sandbox`.
const root = dirname(fileURLToPath(import.meta.url));
const fixtures = join(root, 'fixtures', 'solana');
const proof = new Uint8Array(readFileSync(join(fixtures, 'sandbox.v2.proof')));
const publicWitness = new Uint8Array(readFileSync(join(fixtures, 'sandbox.v2.pw')));
const sample = JSON.parse(readFileSync(join(fixtures, 'sandbox.v2.json'), 'utf8')) as {
  wallet: string; identityHash: string; walletHash: string; iat: number; vkHash: string; zkVerifier: string; proof: string; publicWitness: string;
};
const vkBytes = new Uint8Array(readFileSync(join(root, '..', 'src', 'circuits', 'solana', 'sandbox.v2.vk')));
const pem = readFileSync(join(root, 'fixtures', 'privy_es256_public.pem'), 'utf8');
const EMAIL = { identityType: 'email', identityValue: 'test-9988@privy.io' } as const;
const attestation: Attestation = { network: 'solana', proof, publicInputs: publicWitness, wallet: sample.wallet, circuitVersion: 2, vkHash: sample.vkHash };

test('the bundled sandbox key is the one the sample proof and the Solana program were built from', () => {
  assert.deepEqual(Object.keys(SOLANA_CIRCUITS.sandbox), ['2']);
  assert.equal(SOLANA_CIRCUITS.sandbox[2].vkSha256, sample.vkHash);
  assert.equal(SOLANA_CIRCUITS.sandbox[2].zkVerifier, sample.zkVerifier);
  assert.deepEqual(Object.keys(SOLANA_CIRCUITS.production), []); // until the production ceremony
  const vk = solanaVerifyingKey('sandbox', 2);
  assert.equal(vk.publicInputCount, 11);
  assert.equal(vk.commitmentKeys.length, 1);
  assert.deepEqual(vk.publicAndCommitmentCommitted, [[]]);
  assert.throws(() => solanaVerifyingKey('production', 2), /no Solana verifying key is bundled for circuit version 2 \(production\)/);
});

test("Sunspot's public witness decodes to the same claim layout as the Ethereum public inputs", () => {
  const fields = splitPublicWitness(publicWitness);
  assert.ok(fields && fields.length === 11 * 32);
  assert.deepEqual(toPublicInputFields(publicWitness), toPublicInputFields(fields!));
  const claim = decodeClaim(publicWitness);
  assert.equal(claim.identityType, IdentityType.Email);
  assert.equal(claim.wallet, null); // a Solana wallet: the circuit's EVM address output is zero
  assert.equal(claim.iat, sample.iat);
  assert.equal(claim.identityHash, sample.identityHash);
  assert.equal(claim.walletHash, sample.walletHash);
  assert.equal(identityHash(IdentityType.Email, 'test-9988@privy.io'), claim.identityHash);
  assert.equal(identityHash(IdentityType.Wallet, sample.wallet), claim.walletHash);
  const bad = new Uint8Array(publicWitness);
  bad[3] = 12; // header says 12 inputs
  assert.equal(splitPublicWitness(bad), null);
  assert.throws(() => toPublicInputFields(bad), /header does not match/);
});

test('verifySolanaProof accepts the sample proof, from the witness file or the hex fields', () => {
  const vk = solanaVerifyingKey('sandbox', 2);
  const t0 = Date.now();
  assert.equal(verifySolanaProof({ proof, publicInputs: publicWitness }, vk), true);
  assert.ok(Date.now() - t0 < 2000, 'pure-JS verification stays well under a second');
  assert.equal(verifySolanaProof({ proof, publicInputs: toPublicInputFields(publicWitness) }, vk), true);
  assert.equal(verifySolanaProof({ proof, publicInputs: publicWitness }, parseSolanaVerifyingKey(vkBytes)), true);
});

test('verifySolanaProof rejects a tampered proof, a changed public input and malformed bytes', () => {
  const vk = solanaVerifyingKey('sandbox', 2);
  for (const at of [10, 100, 250, 300, 380]) {
    const bad = new Uint8Array(proof);
    bad[at] ^= 1;
    assert.equal(verifySolanaProof({ proof: bad, publicInputs: publicWitness }, vk), false, `byte ${at}`);
  }
  const fields = toPublicInputFields(publicWitness);
  fields[6] = '0x' + (BigInt(fields[6]) + 1n).toString(16).padStart(64, '0'); // iat
  assert.equal(verifySolanaProof({ proof, publicInputs: fields }, vk), false);
  assert.equal(verifySolanaProof({ proof: proof.subarray(0, 300), publicInputs: publicWitness }, vk), false);
  assert.equal(verifySolanaProof({ proof: new Uint8Array(readFileSync(join(root, 'fixtures', 'email.proof'))), publicInputs: publicWitness }, vk), false);
  assert.throws(() => parseGnarkProof(proof.subarray(0, 300)), MalformedError);
  assert.throws(() => parseGnarkVerifyingKey(new Uint8Array([...vkBytes, 0])), /trailing bytes/);
  assert.throws(() => parseGnarkVerifyingKey(vkBytes.subarray(0, 1000)), MalformedError);
});

test('verifyIdentity verifies a Solana attestation against the sandbox environment, offline', async () => {
  const r = await verifyIdentity({ attestation, signer: 'sandbox', ...EMAIL });
  assert.deepEqual(r, { valid: true, wallet: sample.wallet, issuedAt: sample.iat, circuitVersion: 2, network: 'solana' });
  // As the prover returns it: base64, with publicWitness beside publicInputs.
  const json = { ...attestation, proof: sample.proof, publicInputs: sample.publicWitness, publicWitness: sample.publicWitness };
  assert.equal((await verifyIdentity({ attestation: json, signer: 'sandbox', ...EMAIL })).valid, true);
  const aliasOnly = { ...json, publicInputs: undefined as unknown as string };
  assert.equal((await verifyIdentity({ attestation: aliasOnly, signer: 'sandbox', ...EMAIL })).valid, true);
  // Without metadata every bundled key is tried.
  const bare: Attestation = { network: 'solana', proof, publicInputs: publicWitness, wallet: sample.wallet };
  assert.equal((await verifyIdentity({ attestation: bare, signer: pem, ...EMAIL })).valid, true);
});

test('a Solana attestation binds its wallet exactly: base58 is case-sensitive', async () => {
  const lower = await verifyIdentity({ attestation: { ...attestation, wallet: sample.wallet.toLowerCase() }, signer: 'sandbox', ...EMAIL });
  assert.deepEqual(lower, { valid: false, reason: 'wallet mismatch' });
  const other = await verifyIdentity({ attestation: { ...attestation, wallet: '11111111111111111111111111111111' }, signer: 'sandbox', ...EMAIL });
  assert.deepEqual(other, { valid: false, reason: 'wallet mismatch' });
  const email = await verifyIdentity({ attestation, signer: 'sandbox', identityType: 'email', identityValue: 'other@privy.io' });
  assert.deepEqual(email, { valid: false, reason: 'identity value mismatch' });
});

test('the key is selected by circuitVersion and vkHash, and an unknown build is refused before verifying', async () => {
  const unknown = await verifyIdentity({ attestation: { ...attestation, vkHash: '0x' + 'ab'.repeat(32) }, signer: 'sandbox', ...EMAIL });
  assert.deepEqual(unknown, { valid: false, reason: 'attestation was produced by a Solana verifier build this SDK does not know' });
  const v1 = await verifyIdentity({ attestation: { ...attestation, circuitVersion: 1, vkHash: undefined }, signer: 'sandbox', ...EMAIL });
  assert.deepEqual(v1, { valid: false, reason: 'no Solana verifying key is bundled for the sandbox environment for circuit version 1' });
  const v9 = await verifyIdentity({ attestation: { ...attestation, circuitVersion: 9 }, signer: 'sandbox', ...EMAIL });
  assert.deepEqual(v9, { valid: false, reason: 'attestation is for circuit version 9; this verifier supports versions 1, 2' });
  const tampered = new Uint8Array(proof);
  tampered[70] ^= 1;
  assert.deepEqual(await verifyIdentity({ attestation: { ...attestation, proof: tampered }, signer: 'sandbox', ...EMAIL }), { valid: false, reason: 'invalid proof' });
});

test("a sandbox proof is not a production attestation: signer 'production' never sees the sandbox key", async () => {
  // The sample token is sandbox-signed, so the signer check fails first...
  const r = await verifyIdentity({ attestation, signer: 'production', ...EMAIL });
  assert.deepEqual(r, { valid: false, reason: 'not signed by a trusted key' });
  // ...and with the token's own key trusted explicitly, the environment restriction is visible
  // through the vkHash: a production signer only accepts production keys.
  assert.equal(
    solanaCandidates(attestation, [1, 2], 'production'),
    'attestation was proven under the sandbox Solana trusted setup; signer is production',
  );
  const chosen = solanaCandidates(attestation, [1, 2], 'sandbox');
  assert.ok(Array.isArray(chosen) && chosen.length === 1 && chosen[0].circuitVersion === 2);
});

test('a self-hosted trusted setup verifies with its own key', async () => {
  const own = await verifyIdentity({ attestation, signer: pem, solanaVerifyingKey: vkBytes, ...EMAIL });
  assert.equal(own.valid, true);
  const mismatch = await verifyIdentity({ attestation: { ...attestation, vkHash: '0x' + 'cd'.repeat(32) }, signer: pem, solanaVerifyingKey: vkBytes, ...EMAIL });
  assert.deepEqual(mismatch, { valid: false, reason: 'attestation was not produced for the given Solana verifying key' });
  const garbage = await verifyIdentity({ attestation: { ...attestation, vkHash: undefined }, signer: pem, solanaVerifyingKey: vkBytes.subarray(0, 100), ...EMAIL });
  assert.equal(garbage.valid, false);
  assert.match((garbage as { reason: string }).reason, /malformed Solana verifying key/);
});

test('the /v2 entry point verifies Solana attestations; /v1 has no Solana key', async () => {
  assert.equal((await V2.verifyIdentity({ attestation, signer: 'sandbox', ...EMAIL })).valid, true);
  assert.deepEqual(await V1.verifyIdentity({ attestation: { ...attestation, circuitVersion: undefined, vkHash: undefined }, signer: 'sandbox', ...EMAIL }), {
    valid: false, reason: 'no Solana verifying key is bundled for the sandbox environment for circuit version 1',
  });
});

test('an Ethereum attestation labelled solana, or an unknown network, is refused', async () => {
  const evm = new Uint8Array(readFileSync(join(root, 'fixtures', 'email.proof')));
  const evmInputs = new Uint8Array(readFileSync(join(root, 'fixtures', 'email.public_inputs')));
  const wrong = await verifyIdentity({
    attestation: { network: 'solana', proof: evm, publicInputs: evmInputs, wallet: '0xA01b6E60D51eDB3fEB9f86a62b846f4F90070f98' }, signer: pem, ...EMAIL,
  });
  assert.deepEqual(wrong, { valid: false, reason: 'invalid proof' });
  const unknown = await verifyIdentity({ attestation: { ...attestation, network: 'bitcoin' as 'solana' }, signer: pem, ...EMAIL });
  assert.deepEqual(unknown, { valid: false, reason: 'unknown attestation network "bitcoin"' });
});
