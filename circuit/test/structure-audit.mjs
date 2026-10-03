// Reproduce structural parsing gaps, using only the public throwaway fixture key.
// Accepted cases demonstrate circuit behavior, NOT the ability to obtain such a Privy-signed JWT.
// Run: node test/structure-audit.mjs
// Optional: PROVE=1 additionally generates and verifies a proof for the nested-claims case.
import { createPrivateKey, createPublicKey, createHash, sign } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const key = createPrivateKey(readFileSync(join(root, 'test/fixtures/test_es256_private.pem')));
const jwk = createPublicKey(key).export({ format: 'jwk' });
const x = [...Buffer.from(jwk.x, 'base64url')], y = [...Buffer.from(jwk.y, 'base64url')];
const wallet = '0x1111111111111111111111111111111111111111';
const victim = 'victim@example.com';
const accounts = [{ type: 'email', address: victim }, { type: 'wallet', address: wallet }];
const iat = 1788916490;
const n = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551n;
const work = mkdtempSync(join(tmpdir(), 'pvium-circuit-structure-'));

function witness(raw, selectedIat = raw.indexOf('"iat":'), selectedLa = raw.indexOf('"linked_accounts":"')) {
  const payload = Buffer.from(raw);
  const input = Buffer.from(Buffer.from('{"alg":"ES256","typ":"JWT"}').toString('base64url') + '.' + payload.toString('base64url'));
  const signature = sign('sha256', input, { key, dsaEncoding: 'ieee-p1363' });
  const s = BigInt('0x' + signature.subarray(32).toString('hex'));
  if (s > n / 2n) Buffer.from((n - s).toString(16).padStart(64, '0'), 'hex').copy(signature, 32);
  const fields = {
    signing_input: [...input, ...Array(8129 - input.length).fill(0)],
    signing_input_len: input.length, signature: [...signature], signer_x: x, signer_y: y,
    payload_b64_start: input.indexOf(46) + 1, iat_idx: selectedIat, linked_accounts_idx: selectedLa,
    identity_type: 0, wallet: BigInt(wallet).toString(),
  };
  function account(type, address, prefix) {
    const pattern = JSON.stringify({ type, address }).slice(1, -1).replaceAll('"', '\\"');
    const start = raw.indexOf('{' + pattern, selectedLa);
    assert(start >= 0);
    const end = raw.indexOf('}', start);
    fields[prefix + 'acct_start'] = start;
    fields[prefix + 'acct_end'] = end;
    fields[prefix + 'type_idx'] = raw.indexOf('\\"type\\":\\"', start);
    fields[prefix + 'value_idx'] = raw.indexOf('\\"address\\":\\"', start);
    fields[prefix + 'value_len'] = address.length;
  }
  account('email', victim, '');
  account('wallet', wallet, 'wallet_');
  return fields;
}
function run(name, fields, accepted, expectedIat = iat) {
  const prover = 'ProverStructureAudit_' + name;
  const witnessName = 'structure_audit_' + name;
  const path = join(root, prover + '.toml');
  const toml = Object.entries(fields).map(([k, v]) =>
    k + ' = ' + (Array.isArray(v) ? JSON.stringify(v) : JSON.stringify(String(v)))).join('\n');
  writeFileSync(path, toml + '\n', { flag: 'wx' });
  let result;
  try {
    result = spawnSync('nargo', ['execute', '-p', prover, witnessName], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } finally { unlinkSync(path); }
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  writeFileSync(join(work, name + '.log'), output);
  if (accepted) {
    assert.equal(result.status, 0, output.slice(-2000));
    assert(output.includes('successfully solved'));
    assert(output.includes('iat: ' + expectedIat));
    const hash = createHash('sha256').update(Buffer.concat([Buffer.from('p2id.identity.v1'), Buffer.from([0]), Buffer.from(victim)])).digest('hex');
    assert(output.includes('identity_hash_hi: 0x' + hash.slice(0, 32)));
    assert(output.includes('identity_hash_lo: 0x' + hash.slice(32)));
    console.log('ACCEPTED:', name, '(expected current behavior)');
  } else {
    assert.notEqual(result.status, 0, name + ' unexpectedly accepted');
    assert(/invalid ES256 signature|wallet does not match/.test(output), output.slice(-2000));
    console.log('REJECTED:', name);
  }
  return witnessName;
}

const honest = JSON.stringify({ iat, linked_accounts: JSON.stringify(accounts) });
run('honest', witness(honest), true);
const nestedClaims = JSON.stringify({
  custom_metadata: { iat: iat + 100, linked_accounts: JSON.stringify(accounts) },
  iat, linked_accounts: '[]',
});
const nestedWitness = run('nested_claims', witness(nestedClaims), true, iat + 100);
const nestedTime = JSON.stringify({ iat, custom_metadata: { iat: iat + 200 }, linked_accounts: JSON.stringify(accounts) });
run('nested_iat', witness(nestedTime, nestedTime.lastIndexOf('"iat":')), true, iat + 200);
const nestedAccount = JSON.stringify({ iat, linked_accounts: JSON.stringify([
  { type: 'custom_jwt', metadata: accounts[0] }, accounts[1],
]) });
run('nested_account', witness(nestedAccount), true);
const duplicateType = honest.replace('email\\",', 'email\\",\\"type\\":\\"custom_jwt\\",');
// Use honest offsets adjusted for the injected member: the standard JSON decoder sees custom_jwt.
const duplicateFields = witness(honest);
const duplicate = witness(honest);
const duplicateRaw = JSON.stringify({ iat, linked_accounts: '[{"type":"email","address":"' + victim + '","type":"custom_jwt"},' + JSON.stringify(accounts[1]) + ']' });
run('duplicate_type', witness(duplicateRaw), true);

const forged = witness(honest);
forged.signature[10] ^= 1;
run('tampered_signature', forged, false);
const wrongWallet = witness(honest);
wrongWallet.wallet = '2';
run('wrong_public_wallet', wrongWallet, false);
if (process.env.PROVE === '1') {
  const outputDir = join(work, 'proof');
  const result = spawnSync('bb', ['prove', '-b', 'target/pvium_identity.json',
    '-w', 'target/' + nestedWitness + '.gz', '-t', 'evm', '--write_vk', '--verify', '-o', outputDir],
  { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(join(work, 'prove.log'), (result.stdout ?? '') + (result.stderr ?? ''));
  assert.equal(result.status, 0, (result.stderr ?? '').slice(-2000));
  const hash = createHash('sha256').update(readFileSync(join(outputDir, 'vk'))).digest('hex');
  const expected = JSON.parse(readFileSync(join(root, 'version.json'))).vkSha256;
  assert.equal('0x' + hash, expected, 'Proof used a different circuit verification key');
  console.log('Nested-claims proof generated and verified; VK matches circuit/version.json');
}
console.log('Logs:', work);
