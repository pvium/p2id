import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alphaApprovalMessage, associatedTokenAddress, constraintMessage, depositAddress, factoryAddress, factoryParamsHash, fundAccounts,
  implAuthorityAddress, p2idAddress, p2idAddressForHash, policyAddress, policyMintAddress, solanaPrograms, solanaFactory, p2idFundingVerifier, vaultMintAddress, verifierConfigAddress,
  TOKEN_2022_PROGRAM_ID, SYSTEM_PROGRAM_ID, fromBase58, toBase58,
} from '../src/solana/index.js';
import { createProgramAddress, findProgramAddress, isOnCurve } from '../src/solana/pda.js';
import { IdentityType } from '../src/identity.js';

// Every vector below was produced with @solana/web3.js (PublicKey.findProgramAddressSync) and
// node:crypto against the seeds in solana-anchor/README.md "Addresses".
const PROGRAMS = { router: '6H6C79DN1nFPkpt3ZobzrzHqvyLTk8qNFs7GMM11mAMu', policy: '6kABDmgwKTZ9m6DgCNte91cXnZmaTPQF3PSiYu1K9Nur', implementation: '7TExBifS2846TvPGSeAzR6XseXxs1D3YXkHaourqcxTr' };
const VERIFIER = 'C4uP1e8GtueUQgppaPeiUSwtN6m5pscQcrJsFPNq6A8v';
const AUTHORITY = '11111111111111111111111111111112';
const ATTESTER = 'SysvarC1ock11111111111111111111111111111111';
const PRIVY_KEY = '0x95b9d9d18fbed9f5c3b8aab466271793539be2cbc86a7090dd92f4df600850de3acff34d3319d44a03afdd818474d3551e2b37ee2ff029ceac1ee74924eeb813';
const VK_HASH = '0x3032c70ed03cf803fd426789d694cc8575ebd8d39fc91e9b6263a6e4a919c59e';
const EMAIL_COMMITMENT = '0xbcda0f09fa9732b2bfdea38199486b654a84e8e06085d7e364af8137f8d7deaf';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const POLICY = 'PHBT6UoVnwSnzeqJjR3fnZ4sWxRNDRr8A4VYAd5Ky53';
const FACTORY = 'DD6YpQN45nsacgLoKjQpoouVv2Jnx1jCjUDvctdq8iBF';
const VAULT = '3gGnGJoGgNwtARKF8M2DRUUuUth3fD2huAG7jk5FBWwi';
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
  assert.equal(isOnCurve(fromBase58(FACTORY)), false);
  assert.deepEqual(findProgramAddress(['p2id.impl-authority.v1'], PROGRAMS.implementation), { address: '2S4viRtcMdRggL1m93htCVTUTFbMgMbWxu5wNNKLaZmb', bump: 255 });
  assert.equal(createProgramAddress(['p2id.impl-authority.v1', new Uint8Array([255])], PROGRAMS.implementation), '2S4viRtcMdRggL1m93htCVTUTFbMgMbWxu5wNNKLaZmb');
  assert.throws(() => fromBase58('not-a-key'), /not a base58 key/);
  assert.throws(() => fromBase58('1111'), /32-byte key/);
  assert.throws(() => findProgramAddress([new Uint8Array(33)], PROGRAMS.router), /maximum is 32/);
});

test('the scheme records the program ids and the sandbox factory deployed on devnet', () => {
  assert.deepEqual(solanaPrograms(), PROGRAMS);
  const recorded = solanaFactory({ environment: 'sandbox' })!;
  assert.equal(recorded.address, 'G1g7bieZvwjJEeDy15uDDpJtDDhFfmuB7TL26K77CaHm');
  assert.equal(recorded.paramsHash, '0x5ee702bdab6c650f2bdec60c1bbddb9024ebeda8a59304902bc8c7ca8efcbe46');
  assert.equal(factoryAddress({ authority: recorded.authority, params: recorded.params }).address, recorded.address);
  assert.equal(policyAddress({ authority: recorded.authority, feeBps: recorded.policyFeeBps }), '9aq8HoqMmH72eSfGSgquGda8moTqinbRuxgQZH5RQX34');
  assert.equal(verifierConfigAddress(VERIFIER, { environment: 'sandbox' }), '7gzZKckj5gW3C3nn1V44qm12Ga7bsE7bQpdKKEGKq26t');
  assert.deepEqual(p2idFundingVerifier({ environment: 'sandbox' }), {
    circuitVersion: 2,
    verifier: { program: VERIFIER, zkVerifier: '2v3hY61vHSBgS8Z6oj5VFJSbfYEYx3cqrfuGJ4TyEJaw', vkHash: VK_HASH },
  });
  const funding = fundAccounts({ identityHash: EMAIL_COMMITMENT, depositId: 0, funder: recorded.authority, environment: 'sandbox' });
  assert.equal(funding.program, PROGRAMS.implementation);
  assert.equal(funding.accounts.factory, recorded.address);
  assert.equal(funding.accounts.policy, recorded.params.policy);
  assert.equal(funding.accounts.verifierConfig, '7gzZKckj5gW3C3nn1V44qm12Ga7bsE7bQpdKKEGKq26t');
  // solana-anchor/deployments/pvium.vault.v1.sandbox.devnet.json; the vault PDA computed with web3.js.
  const SANDBOX_FACTORY = 'G1g7bieZvwjJEeDy15uDDpJtDDhFfmuB7TL26K77CaHm';
  const SANDBOX_VAULT = 'J1wKgfEd7fBQ78qRt9B1PnEN6aNHNbU32m7Z3XHAAcdG';
  assert.equal(p2idAddress({ identityType: IdentityType.Email, identityValue: 'test-9988@privy.io', environment: 'sandbox' }), SANDBOX_VAULT);
  assert.equal(p2idAddressForHash(EMAIL_COMMITMENT, { environment: 'sandbox' }), SANDBOX_VAULT);
  assert.equal(p2idAddressForHash(EMAIL_COMMITMENT, { factory: SANDBOX_FACTORY }), SANDBOX_VAULT);
  assert.throws(() => p2idAddressForHash(EMAIL_COMMITMENT, { environment: 'production' }), /no production Solana factory/);
  assert.throws(() => p2idAddressForHash(EMAIL_COMMITMENT, { environment: 'devnet' as never }), /unknown environment/);
});

test('factory, policy and verifier config derive from authority and parameters', () => {
  assert.equal(policyAddress({ authority: AUTHORITY, feeBps: 0 }), POLICY);
  assert.equal(factoryParamsHash(PARAMS), '0xd72a13d11887d4784eb15020189cb5c379cb7891db7a6dc2463c3a9c262b853e');
  assert.deepEqual(factoryAddress({ authority: AUTHORITY, params: PARAMS }), { address: FACTORY, bump: 255, paramsHash: '0xd72a13d11887d4784eb15020189cb5c379cb7891db7a6dc2463c3a9c262b853e' });
  assert.equal(verifierConfigAddress(VERIFIER, { factory: FACTORY }), '8sxqTTPt8oVXXQ3BBbHBDrwkYPxihHhA8BwuojC7MpD3');
  assert.equal(implAuthorityAddress(), '2S4viRtcMdRggL1m93htCVTUTFbMgMbWxu5wNNKLaZmb');
  assert.equal(policyMintAddress(POLICY, USDC), 'E2fznuXTgBjmtgNvpQN1PppW5u4ZXRRXQkZMMDymM1Sz');
  // The parameter hash covers every field: a different window moves the factory.
  assert.notEqual(factoryAddress({ authority: AUTHORITY, params: { ...PARAMS, maxRefundWindow: 31536001 } }).address, FACTORY);
});

test('vaults, deposits and token accounts derive from the identity commitment', () => {
  assert.equal(p2idAddress({ identityType: 'email', identityValue: 'Test-9988@privy.io', factory: FACTORY }), VAULT);
  assert.equal(p2idAddressForHash(EMAIL_COMMITMENT, { factory: FACTORY }), VAULT);
  assert.equal(depositAddress(VAULT, 7), 'DdNsv5ErwNWKdzxr68g8r5izpD3eKZPiQJzgm9ooLZLd');
  assert.equal(depositAddress(VAULT, 7n), 'DdNsv5ErwNWKdzxr68g8r5izpD3eKZPiQJzgm9ooLZLd');
  assert.equal(vaultMintAddress(VAULT, USDC), '8rEADKJsFpa7xdpEnLyKtNULxM5U9NHZntZbTArkZquF');
  assert.equal(associatedTokenAddress(VAULT, USDC), '6kFfz7vPynXy9bF3Yz3WTdDmeQh1JqWtQkr85QYsG3jW');
  assert.equal(associatedTokenAddress(VAULT, USDC, TOKEN_2022_PROGRAM_ID), '9RD4ypviBNJR3se4RSsyUXRifofvsYqtQ1zaaUAJ3rEN');
});

test('fundAccounts names every account fund_sol and fund_token take', () => {
  const funder = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const sol = fundAccounts({ identityHash: EMAIL_COMMITMENT, depositId: 7, funder, factory: FACTORY, policy: POLICY, verifierProgram: VERIFIER });
  assert.equal(sol.program, PROGRAMS.implementation);
  assert.deepEqual(sol.accounts, {
    factory: FACTORY, verifierConfig: '8sxqTTPt8oVXXQ3BBbHBDrwkYPxihHhA8BwuojC7MpD3', vault: VAULT, deposit: 'DdNsv5ErwNWKdzxr68g8r5izpD3eKZPiQJzgm9ooLZLd',
    policy: POLICY, policyProgram: PROGRAMS.policy, funder, implAuthority: '2S4viRtcMdRggL1m93htCVTUTFbMgMbWxu5wNNKLaZmb',
    routerProgram: PROGRAMS.router, systemProgram: SYSTEM_PROGRAM_ID,
  });
  const token = fundAccounts({ identityHash: EMAIL_COMMITMENT, depositId: 7, funder, factory: FACTORY, policy: POLICY, verifierProgram: VERIFIER, mint: USDC });
  assert.equal(token.accounts.vaultTokenAccount, '6kFfz7vPynXy9bF3Yz3WTdDmeQh1JqWtQkr85QYsG3jW');
  assert.equal(token.accounts.vaultMint, '8rEADKJsFpa7xdpEnLyKtNULxM5U9NHZntZbTArkZquF');
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
  const a = alphaApprovalMessage({ factory: FACTORY, vault: VAULT, verifier: VERIFIER, destination: AUTHORITY, iat: 1789240094, action: 2, subject: 'DdNsv5ErwNWKdzxr68g8r5izpD3eKZPiQJzgm9ooLZLd', epoch: 3, deadline: 1789243694 });
  assert.equal(a.length, 17 + 8 + 32);
  assert.equal(Buffer.from(a.subarray(0, 17)).toString(), 'p2id.alpha.sol.v1');
  assert.equal(Buffer.from(a.subarray(17, 25)).readBigInt64LE(), 1789243694n);
  // Alpha approvals bind the subject: a different deposit is a different message.
  assert.notDeepEqual(a, alphaApprovalMessage({ factory: FACTORY, vault: VAULT, verifier: VERIFIER, destination: AUTHORITY, iat: 1789240094, action: 2, epoch: 3, deadline: 1789243694 }));
});
