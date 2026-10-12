import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANY_REGISTERED_SIGNER, constraintClaimSignature, constraintCommitment, constraintTypedData } from '../src/constraint.js';

// Vectors computed with ethers' AbiCoder / keccak256, matching PviumVerifier.constraintCommitment.
const POLICY = '0x8799d081d7c863f1ac12b9d6337ea605e82dbf40770bcc1f19f377f9e441a1c4';
const IDENTITY = '0xbcda0f09fa9732b2bfdea38199486b654a84e8e06085d7e364af8137f8d7deaf';
const SALT = '0xbc5085122a8642d294a6d3f48afcf02e728bc3f543c7b2a26e1579ed242f9461';
const SIGNER = '0x1111111111111111111111111111111111111111';

test('commitment: any registered signer (the default) and a payer-chosen signer', () => {
  const registered = '0x90691aab0c30021cfcce6c1cea197d1977052773c505b4b0b9e1a767675f7baa';
  assert.equal(constraintCommitment({ policyHash: POLICY, identityHash: IDENTITY, salt: SALT }), registered);
  assert.equal(constraintCommitment({ signer: ANY_REGISTERED_SIGNER, policyHash: POLICY, identityHash: IDENTITY, salt: SALT }), registered);
  assert.equal(constraintCommitment({ signer: SIGNER, policyHash: POLICY, identityHash: IDENTITY, salt: SALT }),
    '0x199a9269d87619bd6c3f595bac3bcf669949cc72354ffcce221b0a9324f7efd3');
});

test('claim signature: abi.encode(signer, policyHash, salt, signature)', () => {
  const sig = '0x' + 'ab'.repeat(65);
  assert.equal(constraintClaimSignature({ signer: SIGNER, policyHash: POLICY, salt: SALT, signature: sig }),
    '0x0000000000000000000000001111111111111111111111111111111111111111' + POLICY.slice(2) + SALT.slice(2) +
    '0000000000000000000000000000000000000000000000000000000000000080' +
    '0000000000000000000000000000000000000000000000000000000000000041' + 'ab'.repeat(65) + '00'.repeat(31));
});

test('claim signature for a registered contract signer names the approver', () => {
  assert.equal(constraintClaimSignature({ policyHash: POLICY, salt: SALT, signature: '0x' + 'cd'.repeat(65), approver: '0x3333333333333333333333333333333333333333' }),
    '0x00000000000000000000000000000000000000000000000000000000000000008799d081d7c863f1ac12b9d6337ea605e82dbf40770bcc1f19f377f9e441a1c4bc5085122a8642d294a6d3f48afcf02e728bc3f543c7b2a26e1579ed242f9461000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000333333333333333333333333333333333333333300000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000041cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd00000000000000000000000000000000000000000000000000000000000000');
  assert.throws(() => constraintClaimSignature({ signer: SIGNER, policyHash: POLICY, salt: SALT, signature: '0x00', approver: SIGNER }), /registered-signer constraints only/);
});

test('typed data for the signer, and input validation', () => {
  const td = constraintTypedData({ verifier: '0x2222222222222222222222222222222222222222', chainId: 8453, commitment: SALT });
  assert.deepEqual(td.domain, { name: 'PviumVerifier', version: '1', chainId: 8453n, verifyingContract: '0x2222222222222222222222222222222222222222' });
  assert.deepEqual(td.types, { Constraint: [{ name: 'commitment', type: 'bytes32' }] });
  assert.throws(() => constraintCommitment({ policyHash: '0x12', identityHash: IDENTITY, salt: SALT }), /policyHash must be 32 bytes/);
  assert.throws(() => constraintCommitment({ signer: '0x123', policyHash: POLICY, identityHash: IDENTITY, salt: SALT }), /bad signer address/);
});
