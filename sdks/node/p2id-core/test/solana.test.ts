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
const PROGRAMS = { router: '2zhNs3tEhpreRbmb98icGSwDuom6i2JWDbid9Ur6P4QH', policy: '7Pk7qV1WMJn5iN4mfS1eKJxJgzWska4Uk8X1nej8A2VX', implementation: 'HeCmyjbG5nVMY2msxiUkfhf8WqPMEVqh7gR1nFEmAfdt' };
const VERIFIER = '7DoBQ1FcAXB8rf3PVXo5gikJCw4mamQswKXDeVE8rBYu';
const AUTHORITY = '11111111111111111111111111111112';
const ATTESTER = 'SysvarC1ock11111111111111111111111111111111';
const PRIVY_KEY = '0x95b9d9d18fbed9f5c3b8aab466271793539be2cbc86a7090dd92f4df600850de3acff34d3319d44a03afdd818474d3551e2b37ee2ff029ceac1ee74924eeb813';
const VK_HASH = '0x3032c70ed03cf803fd426789d694cc8575ebd8d39fc91e9b6263a6e4a919c59e';
const EMAIL_COMMITMENT = '0xbcda0f09fa9732b2bfdea38199486b654a84e8e06085d7e364af8137f8d7deaf';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const POLICY = '9gLdrBjNnuHVEMzZT6WDjv18kP1i6tsQvgfsXy5qu5Bq';
const FACTORY = 'GrRhjuddAgjzDvy4hi4Le4pfSBYNRmHtLmQ4Y21FZdYG';
const VAULT = '91w1SMP7wzhWUieo1GvmNUNGVtwGTscSM11gND96wwyG';
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
  assert.equal(isOnCurve(fromBase58('GrRhjuddAgjzDvy4hi4Le4pfSBYNRmHtLmQ4Y21FZdYG')), false);
  assert.deepEqual(findProgramAddress(['p2id.impl-authority.v1'], PROGRAMS.implementation), { address: 'XUCYMEDTQojgDA1SWutUKrtseCBBM6hkKuK6TKbGR7E', bump: 255 });
  assert.equal(createProgramAddress(['p2id.impl-authority.v1', new Uint8Array([255])], PROGRAMS.implementation), 'XUCYMEDTQojgDA1SWutUKrtseCBBM6hkKuK6TKbGR7E');
  assert.throws(() => fromBase58('not-a-key'), /not a base58 key/);
  assert.throws(() => fromBase58('1111'), /32-byte key/);
  assert.throws(() => findProgramAddress([new Uint8Array(33)], PROGRAMS.router), /maximum is 32/);
});

test('the scheme records the program ids and the sandbox factory deployed on devnet', () => {
  assert.deepEqual(solanaPrograms(), PROGRAMS);
  // solana-anchor/deployments/pvium.vault.v1.sandbox.devnet.json; the vault PDA computed with web3.js.
  const SANDBOX_FACTORY = '48SXtqHqyRWF9zqipRWvZ3AAi9csUNDBiXeRbj2Sk1UY';
  const SANDBOX_VAULT = 'BEYhbfTSSeNDCMJbsJZHNkDATG5Ueu29cHhXC7tjMzPx';
  assert.equal(p2idAddress({ identityType: IdentityType.Email, identityValue: 'test-9988@privy.io', environment: 'sandbox' }), SANDBOX_VAULT);
  assert.equal(p2idAddressForHash(EMAIL_COMMITMENT, { environment: 'sandbox' }), SANDBOX_VAULT);
  assert.equal(p2idAddressForHash(EMAIL_COMMITMENT, { factory: SANDBOX_FACTORY }), SANDBOX_VAULT);
  assert.throws(() => p2idAddressForHash(EMAIL_COMMITMENT, { environment: 'production' }), /no production Solana factory/);
  assert.throws(() => p2idAddressForHash(EMAIL_COMMITMENT, { environment: 'devnet' as never }), /unknown environment/);
});

test('factory, policy and verifier config derive from authority and parameters', () => {
  assert.equal(policyAddress({ authority: AUTHORITY, feeBps: 0 }), POLICY);
  assert.equal(factoryParamsHash(PARAMS), '0x08ee60d83f87101927fc994f280f8d98de6c46ff134755fb5fed64ef220558e5');
  assert.deepEqual(factoryAddress({ authority: AUTHORITY, params: PARAMS }), { address: FACTORY, bump: 255, paramsHash: '0x08ee60d83f87101927fc994f280f8d98de6c46ff134755fb5fed64ef220558e5' });
  assert.equal(verifierConfigAddress(VERIFIER, { factory: FACTORY }), 'EhG553faNNXFCsNT61ErxwdGAn51zuJxMyfzXNqVutnd');
  assert.equal(implAuthorityAddress(), 'XUCYMEDTQojgDA1SWutUKrtseCBBM6hkKuK6TKbGR7E');
  assert.equal(policyMintAddress(POLICY, USDC), 'AEZwTqJenuGQfAp2SMKtBTyWUuvGPcfF5hwEGoHmvzem');
  // The parameter hash covers every field: a different window moves the factory.
  assert.notEqual(factoryAddress({ authority: AUTHORITY, params: { ...PARAMS, maxRefundWindow: 31536001 } }).address, FACTORY);
});

test('vaults, deposits and token accounts derive from the identity commitment', () => {
  assert.equal(p2idAddress({ identityType: 'email', identityValue: 'Test-9988@privy.io', factory: FACTORY }), VAULT);
  assert.equal(p2idAddressForHash(EMAIL_COMMITMENT, { factory: FACTORY }), VAULT);
  assert.equal(depositAddress(VAULT, 7), 'H1HG3xYXWN885rRa1tpdfUwbBkjECFmtBsma5DS4L5LS');
  assert.equal(depositAddress(VAULT, 7n), 'H1HG3xYXWN885rRa1tpdfUwbBkjECFmtBsma5DS4L5LS');
  assert.equal(vaultMintAddress(VAULT, USDC), '7np1d5KfiGkHpvA8WP5CWGQ44qtJX6ndjBDy3dzEaQry');
  assert.equal(associatedTokenAddress(VAULT, USDC), '9jWi4wDR8n434MLKqqJHqLZgy2WUtfqPwmpooGhaiyeD');
  assert.equal(associatedTokenAddress(VAULT, USDC, TOKEN_2022_PROGRAM_ID), 'FnHwHpeSxkeajMhUhp7zKSuWVUmtwbmsmcAHddgKqVAH');
});

test('fundAccounts names every account fund_sol and fund_token take', () => {
  const funder = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const sol = fundAccounts({ identityHash: EMAIL_COMMITMENT, depositId: 7, funder, factory: FACTORY, policy: POLICY, verifierProgram: VERIFIER });
  assert.equal(sol.program, PROGRAMS.implementation);
  assert.deepEqual(sol.accounts, {
    factory: FACTORY, verifierConfig: 'EhG553faNNXFCsNT61ErxwdGAn51zuJxMyfzXNqVutnd', vault: VAULT, deposit: 'H1HG3xYXWN885rRa1tpdfUwbBkjECFmtBsma5DS4L5LS',
    policy: POLICY, policyProgram: PROGRAMS.policy, funder, implAuthority: 'XUCYMEDTQojgDA1SWutUKrtseCBBM6hkKuK6TKbGR7E',
    routerProgram: PROGRAMS.router, systemProgram: SYSTEM_PROGRAM_ID,
  });
  const token = fundAccounts({ identityHash: EMAIL_COMMITMENT, depositId: 7, funder, factory: FACTORY, policy: POLICY, verifierProgram: VERIFIER, mint: USDC });
  assert.equal(token.accounts.vaultTokenAccount, '9jWi4wDR8n434MLKqqJHqLZgy2WUtfqPwmpooGhaiyeD');
  assert.equal(token.accounts.vaultMint, '7np1d5KfiGkHpvA8WP5CWGQ44qtJX6ndjBDy3dzEaQry');
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
  const a = alphaApprovalMessage({ factory: FACTORY, vault: VAULT, verifier: VERIFIER, destination: AUTHORITY, iat: 1789240094, action: 2, subject: 'H1HG3xYXWN885rRa1tpdfUwbBkjECFmtBsma5DS4L5LS', epoch: 3, deadline: 1789243694 });
  assert.equal(a.length, 17 + 8 + 32);
  assert.equal(Buffer.from(a.subarray(0, 17)).toString(), 'p2id.alpha.sol.v1');
  assert.equal(Buffer.from(a.subarray(17, 25)).readBigInt64LE(), 1789243694n);
  // Alpha approvals bind the subject: a different deposit is a different message.
  assert.notDeepEqual(a, alphaApprovalMessage({ factory: FACTORY, vault: VAULT, verifier: VERIFIER, destination: AUTHORITY, iat: 1789240094, action: 2, epoch: 3, deadline: 1789243694 }));
});
