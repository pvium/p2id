import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alphaApprovalMessage, associatedTokenAddress, constraintMessage, depositAddress, factoryAddress, factoryParamsHash, fundAccounts,
  implAuthorityAddress, p2idAddress, p2idAddressForHash, policyAddress, policyMintAddress, solanaPrograms, vaultMintAddress, verifierConfigAddress,
  TOKEN_2022_PROGRAM_ID, SYSTEM_PROGRAM_ID, fromBase58, toBase58,
} from '../src/solana/index.js';
import { createProgramAddress, findProgramAddress, isOnCurve } from '../src/solana/pda.js';
import { IdentityType } from '../src/identity.js';

// Every vector below was produced with @solana/web3.js (PublicKey.findProgramAddressSync) and
// node:crypto against the seeds in solana-anchor/README.md "Addresses".
const PROGRAMS = { router: '4Xy1ad1x63e6o3dMgrEE2JvKtem2jQvqSV4tRaHmvuc3', policy: '32CHoykPA8eVDvuY84uc8yvJCgkjj6kwsJqweX76G7oJ', implementation: 'A48yVmhHBvP2Hf3zc2p9XGzV9CtVStFmq8DRuwWgGp53' };
const VERIFIER = '9WgYShJxUEFQmjird4GKbauXtq32uXbrRD8EdTcjoBxj';
const AUTHORITY = '11111111111111111111111111111112';
const ATTESTER = 'SysvarC1ock11111111111111111111111111111111';
const PRIVY_KEY = '0x95b9d9d18fbed9f5c3b8aab466271793539be2cbc86a7090dd92f4df600850de3acff34d3319d44a03afdd818474d3551e2b37ee2ff029ceac1ee74924eeb813';
const VK_HASH = '0x3032c70ed03cf803fd426789d694cc8575ebd8d39fc91e9b6263a6e4a919c59e';
const EMAIL_COMMITMENT = '0xbcda0f09fa9732b2bfdea38199486b654a84e8e06085d7e364af8137f8d7deaf';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const POLICY = 'H91C9z94kyU8VXzPygRz8Wf6GGS2XxmuGo8dJj1rGPzh';
const FACTORY = '9ZfLm3wbiN1w7RCabqpMTc6QTV7Vm4gP5P2ZNM8y2J8N';
const VAULT = '8UJtkyx7UkypaNd22CcPYj61dTDrWf8RTmqoYScLBeRj';
const PARAMS = {
  signerKeys: [PRIVY_KEY] as const, defaultVerifier: VERIFIER, policy: POLICY, defaultImplementation: PROGRAMS.implementation,
  alphaAttester: ATTESTER, circuitVersion: 2, vkHash: VK_HASH as `0x${string}`, minRefundWindow: 3600, maxRefundWindow: 31536000,
};

test('program-derived addresses match the runtime', () => {
  assert.equal(toBase58(fromBase58(AUTHORITY)), AUTHORITY);
  assert.equal(Buffer.from(fromBase58(AUTHORITY)).toString('hex'), '00'.repeat(31) + '01');
  assert.equal(isOnCurve(fromBase58(AUTHORITY)), false);
  // Wallet keys and vanity ids that happen to decode are on the curve; derived addresses never are.
  assert.equal(isOnCurve(fromBase58('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')), true);
  assert.equal(isOnCurve(fromBase58('SysvarC1ock11111111111111111111111111111111')), true);
  assert.equal(isOnCurve(fromBase58('9ZfLm3wbiN1w7RCabqpMTc6QTV7Vm4gP5P2ZNM8y2J8N')), false);
  assert.deepEqual(findProgramAddress(['p2id.impl-authority.v1'], PROGRAMS.implementation), { address: 'E9aHJe4KZVRh6QC7i3qdkMYrProhfvxD8X5HJENUh7dX', bump: 255 });
  assert.equal(createProgramAddress(['p2id.impl-authority.v1', new Uint8Array([255])], PROGRAMS.implementation), 'E9aHJe4KZVRh6QC7i3qdkMYrProhfvxD8X5HJENUh7dX');
  assert.throws(() => fromBase58('not-a-key'), /not a base58 key/);
  assert.throws(() => fromBase58('1111'), /32-byte key/);
  assert.throws(() => findProgramAddress([new Uint8Array(33)], PROGRAMS.router), /maximum is 32/);
});

test('the scheme records the program ids and no factory yet', () => {
  assert.deepEqual(solanaPrograms(), PROGRAMS);
  assert.throws(() => p2idAddress({ identityType: IdentityType.Email, identityValue: 'test-9988@privy.io', environment: 'sandbox' }), /no sandbox Solana factory/);
  assert.throws(() => p2idAddressForHash(EMAIL_COMMITMENT, { environment: 'devnet' as never }), /unknown environment/);
});

test('factory, policy and verifier config derive from authority and parameters', () => {
  assert.equal(policyAddress({ authority: AUTHORITY, feeBps: 0 }), POLICY);
  assert.equal(factoryParamsHash(PARAMS), '0x1b1bdf4f98001606a8fa9b8980421439af3eed5f2e98c9e5ff08ba80e048bc51');
  assert.deepEqual(factoryAddress({ authority: AUTHORITY, params: PARAMS }), { address: FACTORY, bump: 254, paramsHash: '0x1b1bdf4f98001606a8fa9b8980421439af3eed5f2e98c9e5ff08ba80e048bc51' });
  assert.equal(verifierConfigAddress(VERIFIER, { factory: FACTORY }), 'X7DrqRFGEASQJcbDwwHZnRG2QsgjMZvKcbMtSR87Bxu');
  assert.equal(implAuthorityAddress(), 'E9aHJe4KZVRh6QC7i3qdkMYrProhfvxD8X5HJENUh7dX');
  assert.equal(policyMintAddress(POLICY, USDC), '8vhpJ5fR5kaPmDpGKpnyDmXyQJXBo9T23JUNZH9nSukw');
  // The parameter hash covers every field: a different window moves the factory.
  assert.notEqual(factoryAddress({ authority: AUTHORITY, params: { ...PARAMS, maxRefundWindow: 31536001 } }).address, FACTORY);
});

test('vaults, deposits and token accounts derive from the identity commitment', () => {
  assert.equal(p2idAddress({ identityType: 'email', identityValue: 'Test-9988@privy.io', factory: FACTORY }), VAULT);
  assert.equal(p2idAddressForHash(EMAIL_COMMITMENT, { factory: FACTORY }), VAULT);
  assert.equal(depositAddress(VAULT, 7), 'GuCn9yKmpr2azJ8JTqnSp6WBpS1eNWeUxMRnjcgzGeV');
  assert.equal(depositAddress(VAULT, 7n), 'GuCn9yKmpr2azJ8JTqnSp6WBpS1eNWeUxMRnjcgzGeV');
  assert.equal(vaultMintAddress(VAULT, USDC), 'EWs9Ww1Hf7jHEqrRS5cbYABxoBkjjaSaz7LbusSntP21');
  assert.equal(associatedTokenAddress(VAULT, USDC), '54PxEHTDYXSzsVW7yYNrpCTdkeX8PtCWpB47USnDtBHg');
  assert.equal(associatedTokenAddress(VAULT, USDC, TOKEN_2022_PROGRAM_ID), '32MY5j8wU7fxqVwYt4siRuYEyc9ey62McL4J7dobua1X');
});

test('fundAccounts names every account fund_sol and fund_token take', () => {
  const funder = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const sol = fundAccounts({ identityHash: EMAIL_COMMITMENT, depositId: 7, funder, factory: FACTORY, policy: POLICY, verifierProgram: VERIFIER });
  assert.equal(sol.program, PROGRAMS.implementation);
  assert.deepEqual(sol.accounts, {
    factory: FACTORY, verifierConfig: 'X7DrqRFGEASQJcbDwwHZnRG2QsgjMZvKcbMtSR87Bxu', vault: VAULT, deposit: 'GuCn9yKmpr2azJ8JTqnSp6WBpS1eNWeUxMRnjcgzGeV',
    policy: POLICY, policyProgram: PROGRAMS.policy, funder, implAuthority: 'E9aHJe4KZVRh6QC7i3qdkMYrProhfvxD8X5HJENUh7dX',
    routerProgram: PROGRAMS.router, systemProgram: SYSTEM_PROGRAM_ID,
  });
  const token = fundAccounts({ identityHash: EMAIL_COMMITMENT, depositId: 7, funder, factory: FACTORY, policy: POLICY, verifierProgram: VERIFIER, mint: USDC });
  assert.equal(token.accounts.vaultTokenAccount, '54PxEHTDYXSzsVW7yYNrpCTdkeX8PtCWpB47USnDtBHg');
  assert.equal(token.accounts.vaultMint, 'EWs9Ww1Hf7jHEqrRS5cbYABxoBkjjaSaz7LbusSntP21');
  assert.equal(Object.keys(token.accounts).length, 16);
  assert.throws(() => fundAccounts({ identityHash: EMAIL_COMMITMENT, depositId: 0, funder, factory: FACTORY, verifierProgram: VERIFIER }), /pass `policy`/);
  assert.throws(() => fundAccounts({ identityHash: EMAIL_COMMITMENT, depositId: 0, funder, factory: FACTORY, policy: POLICY }), /no verifier is recorded/);
});

test('signed messages lay out as the router reads them', () => {
  const commitment = '0x' + 'ab'.repeat(32) as `0x${string}`;
  const m = constraintMessage({ factory: FACTORY, commitment });
  assert.equal(m.length, 22 + 32 + 32);
  assert.equal(Buffer.from(m.subarray(0, 22)).toString(), 'p2id.constraint.sol.v1');
  assert.deepEqual(m.subarray(22, 54), fromBase58(FACTORY));
  const a = alphaApprovalMessage({ factory: FACTORY, vault: VAULT, verifier: VERIFIER, destination: AUTHORITY, iat: 1789240094, action: 2, subject: 'GuCn9yKmpr2azJ8JTqnSp6WBpS1eNWeUxMRnjcgzGeV', epoch: 3, deadline: 1789243694 });
  assert.equal(a.length, 17 + 8 + 32);
  assert.equal(Buffer.from(a.subarray(0, 17)).toString(), 'p2id.alpha.sol.v1');
  assert.equal(Buffer.from(a.subarray(17, 25)).readBigInt64LE(), 1789243694n);
  // Alpha approvals bind the subject: a different deposit is a different message.
  assert.notDeepEqual(a, alphaApprovalMessage({ factory: FACTORY, vault: VAULT, verifier: VERIFIER, destination: AUTHORITY, iat: 1789240094, action: 2, epoch: 3, deadline: 1789243694 }));
});
