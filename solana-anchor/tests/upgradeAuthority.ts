import { strict as assert } from 'assert';
import { Keypair, PublicKey } from '@solana/web3.js';
import { assertUpgradeAuthority, mustBurnUpgradeAuthority, transferUpgradeAuthority } from '../scripts/lib/upgradeAuthority';

describe('policy program upgrade authority', () => {
  it('requires immutable verifiers and implementation on every cluster, and router/policy only on mainnet', () => {
    const deployer = Keypair.generate().publicKey;
    const live = { status: 'upgradeable' as const, authority: deployer };
    for (const cluster of ['mainnet', 'devnet', 'localnet']) {
      for (const role of ['zkVerifier', 'verifier', 'implementation', 'router', 'policyProgram']) {
        const required = cluster === 'mainnet' || ['zkVerifier', 'verifier', 'implementation'].includes(role);
        assert.equal(mustBurnUpgradeAuthority(cluster, role), required);
        if (required)
          assert.throws(() => assertUpgradeAuthority(role, live, deployer, required), /expected immutable/);
        else
          assert.doesNotThrow(() => assertUpgradeAuthority(role, live, deployer, required));
      }
    }
  });
  const program = Keypair.generate().publicKey;
  const deployer = Keypair.generate().publicKey;
  const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
  const [target] = PublicKey.findProgramAddressSync([Buffer.from('multisig-vault')], program);

  it('hands off to a multisig PDA using the deployer as the only authority signer', () => {
    const ix = transferUpgradeAuthority(program, deployer, deployer, target)!;
    const [programData] = PublicKey.findProgramAddressSync([program.toBuffer()], loader);
    assert(ix.programId.equals(loader));
    assert.deepEqual([...ix.data], [4, 0, 0, 0]);
    assert.deepEqual(ix.keys, [
      { pubkey: programData, isSigner: false, isWritable: true },
      { pubkey: deployer, isSigner: true, isWritable: false },
      { pubkey: target, isSigner: false, isWritable: false },
    ]);
    assert.equal(PublicKey.isOnCurve(target.toBytes()), false);
  });

  it('skips a completed transfer on reruns', () => {
    assert.equal(transferUpgradeAuthority(program, target, deployer, target), null);
    assert.equal(transferUpgradeAuthority(program, deployer, deployer, deployer), null);
  });

  it('rejects an unexpected current authority', () => {
    assert.throws(() => transferUpgradeAuthority(program, Keypair.generate().publicKey, deployer, target), /current authority must transfer it/);
  });

  it('accepts burned authorities for every program and the configured authority for the policy', () => {
    for (const label of ['zkVerifier', 'verifier', 'policyProgram', 'router', 'implementation']) {
      assert.doesNotThrow(() => assertUpgradeAuthority(label, { status: 'immutable' }, target, label !== 'policyProgram'));
    }
    assert.doesNotThrow(() => assertUpgradeAuthority('policyProgram', { status: 'upgradeable', authority: target }, target, false));
  });

  it('rejects retained deployer control, missing programs, and unknown authority state', () => {
    for (const label of ['zkVerifier', 'verifier', 'policyProgram', 'router', 'implementation']) {
      const immutableOnly = label !== 'policyProgram';
      for (const status of ['missing', 'foreign', 'upgradeable'] as const) {
        assert.throws(() => assertUpgradeAuthority(label, { status }, target, immutableOnly), /unsafe upgrade authority/);
      }
      assert.throws(() => assertUpgradeAuthority(label, { status: 'upgradeable', authority: deployer }, target, immutableOnly), /unsafe upgrade authority/);
    }
  });

  it('requires burns for verifiers, router, implementation and a finalized policy even under SOL_AUTHORITY', () => {
    for (const label of ['zkVerifier', 'verifier', 'router', 'implementation', 'policyProgram']) {
      assert.throws(() => assertUpgradeAuthority(label, { status: 'upgradeable', authority: target }, target, true), /expected immutable/);
    }
  });
});
