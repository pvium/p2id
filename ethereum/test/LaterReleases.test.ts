import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import {
  CURRENT_SCHEME,
  circuitRelease,
  deployStack,
  deployVerifierSet,
  environmentSettings,
  stackCircuitVersion,
  type StackParams,
} from '../scripts/lib/deterministic';
import { implementationCreationCode } from '../scripts/lib/implementation';
import {
  IMPLEMENTATION_SALT,
  laterCircuits,
  syncReleases,
  verifierSetParams,
} from '../scripts/lib/laterReleases';

// What deploy-deterministic.ts does after the stack: bring the chain up to ethereum/releases.json
// (later verifier sets, later vault implementations, the environment's owner settings), sending
// owner transactions only as the owner and leaving them as pending Safe steps otherwise.
describe('release sync: a chain is brought up to everything released, owner steps left for the owner', function () {
  this.timeout(120_000);
  const DAY = 86400;
  // the P-256 generator: any point on the curve will do
  const key = {
    x: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
    y: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
  };
  const production = environmentSettings('production');
  const OLD_SIGNER = production.retiredConstraintSigners![0];
  const NEW_SIGNER = production.constraintSigners![0];

  async function stack(owner: string, salt: string, environment = 'sandbox') {
    const [deployer] = await ethers.getSigners();
    const circuitVersion = stackCircuitVersion(CURRENT_SCHEME);
    const params: StackParams = {
      owner,
      scheme: CURRENT_SCHEME,
      circuitVersion,
      vkHash: circuitRelease(circuitVersion).vkHash,
      signerKeys: [key],
      attester: OLD_SIGNER,
      alphaAttester: OLD_SIGNER,
      policyChangeDelay: 7 * DAY,
      minRefundWindow: DAY,
      maxRefundWindow: 90 * DAY,
      salt: ethers.id(salt),
    };
    const addresses = await deployStack(params, deployer);
    const factory = await ethers.getContractAt(
      'PviumP2IdVaultFactory',
      addresses.factory,
    );
    const policy = await ethers.getContractAt(
      'PviumP2IDPolicy',
      addresses.policy,
    );
    const sets = await Promise.all(
      laterCircuits(circuitVersion).map((v) =>
        deployVerifierSet(verifierSetParams(params, v), null),
      ),
    );
    const v2 = ethers.getCreate2Address(
      addresses.factory,
      IMPLEMENTATION_SALT,
      ethers.keccak256(
        await implementationCreationCode('P2IDVaultV2', addresses.factory),
      ),
    );
    const run = (signer: any = deployer) =>
      syncReleases({
        environment,
        networkName: 'hardhat',
        chainId: 31337,
        params,
        keys: [key],
        addresses,
        signer,
      });
    const signerOn = async (verifier: string, who: string) =>
      (
        await ethers.getContractAt('PviumVerifierV2', verifier)
      ).isConstraintSigner(who); // same getter on every PviumVerifier
    return { deployer, addresses, factory, policy, sets, v2, run, signerOn };
  }
  const labels = (steps: { label: string }[]) => steps.map((s) => s.label);

  it("the stack is built from the scheme's first circuit, and there is something released after it", async () => {
    expect(stackCircuitVersion(CURRENT_SCHEME)).to.equal(1);
    expect(laterCircuits(1)).to.include(2);
    const s = await stack((await ethers.getSigners())[0].address, 'salt-check');
    expect(await s.factory.IMPLEMENTATION_SALT()).to.equal(IMPLEMENTATION_SALT); // predicted offline with this constant
  });

  it('as the owner: everything is sent, a re-run changes nothing, and registration follows after the notice', async () => {
    const [deployer] = await ethers.getSigners();
    const s = await stack(deployer.address, 'sync-owner');
    const first = await s.run();
    expect(first.pending).to.deep.equal([]);
    expect(labels(first.sent)).to.deep.equal([
      'set-factory',
      'circuit-v2.approve',
      'vault-v2-propose',
    ]);
    expect(await s.policy.factory()).to.equal(s.addresses.factory);
    for (const set of s.sets) {
      expect(await ethers.provider.getCode(set.pviumVerifier)).to.not.equal(
        '0x',
      );
      expect(await s.policy.isVerifierAllowed(set.pviumVerifier)).to.equal(
        true,
      );
    }
    expect(await s.factory.defaultVerifier()).to.equal(
      s.addresses.pviumVerifier,
    ); // the default stays the stack's own
    expect(await ethers.provider.getCode(s.v2)).to.not.equal('0x');
    expect(await s.factory.proposedImplementation()).to.equal(s.v2);
    expect(await s.factory.proposedImplementationMakeDefault()).to.equal(true);
    expect(await s.factory.isRegisteredImplementation(s.v2)).to.equal(false); // only after the factory's notice
    const eta = await s.factory.proposedImplementationEta();

    const second = await s.run(); // approved and proposed: skipped, and the notice is not restarted
    expect(second.sent).to.deep.equal([]);
    expect(second.pending).to.deep.equal([]);
    expect(await s.factory.proposedImplementationEta()).to.equal(eta);

    await time.increaseTo(eta);
    expect(labels((await s.run()).sent)).to.deep.equal(['vault-v2-register']);
    expect(await s.factory.baseImplementation()).to.equal(s.v2);
    const last = await s.run(); // registered: nothing left to do
    expect([...last.sent, ...last.pending]).to.deep.equal([]);
  });

  it('as a deployer that is not the owner: contracts are deployed, every owner step is left pending and nothing is changed', async () => {
    const [, , safe] = await ethers.getSigners();
    const s = await stack(safe.address, 'sync-safe');
    const result = await s.run();
    expect(result.sent).to.deep.equal([]);
    expect(labels(result.pending)).to.deep.equal([
      'set-factory',
      'circuit-v2.approve',
      'vault-v2-propose',
    ]);
    for (const set of s.sets) {
      expect(await ethers.provider.getCode(set.pviumVerifier)).to.not.equal(
        '0x',
      );
      expect(await s.policy.isVerifierAllowed(set.pviumVerifier)).to.equal(
        false,
      );
    }
    expect(await s.policy.factory()).to.equal(ethers.ZeroAddress);
    expect(await ethers.provider.getCode(s.v2)).to.equal('0x');
    expect(await s.factory.proposedImplementation()).to.equal(
      ethers.ZeroAddress,
    );

    // the pending steps are exactly what the owner sends, in order
    for (const step of result.pending)
      await safe.sendTransaction({ to: step.to, data: step.data });
    expect(await s.policy.isVerifierAllowed(s.sets[0].pviumVerifier)).to.equal(
      true,
    );
    expect(await s.factory.proposedImplementation()).to.equal(s.v2);
    expect((await s.run()).pending).to.deep.equal([]);
  });

  it('with no signer: nothing is sent or deployed, and the verifier set is reported as still to deploy', async () => {
    const [, , safe] = await ethers.getSigners();
    const s = await stack(safe.address, 'sync-plan');
    const result = await s.run(null);
    expect(result.sent).to.deep.equal([]);
    expect(result.undeployed).to.have.length(1);
    expect(labels(result.pending)).to.deep.equal([
      'set-factory',
      'vault-v2-propose',
    ]); // no approval for a verifier that is not there
    expect(await ethers.provider.getCode(s.sets[0].pviumVerifier)).to.equal(
      '0x',
    );
    expect(await ethers.provider.getCode(s.v2)).to.equal('0x');
  });

  it("an environment's owner settings: the alpha attester and constraint signers are rotated on the factory and every verifier", async () => {
    const [deployer] = await ethers.getSigners();
    const s = await stack(deployer.address, 'sync-settings', 'production');
    expect(await s.factory.defaultAttester()).to.equal(OLD_SIGNER);
    const epoch = await s.factory.alphaEpoch();
    const result = await s.run();
    expect(labels(result.sent)).to.deep.equal([
      'set-factory',
      'rotate-attester',
      'circuit-v2.approve',
      'rotate-constraint-signer',
      'rotate-constraint-signer',
      'rotate-constraint-signer',
      'rotate-constraint-signer',
      'vault-v2-propose',
    ]);
    expect(await s.factory.defaultAttester()).to.equal(NEW_SIGNER);
    expect(await s.factory.alphaEpoch()).to.equal(epoch + 1n); // outstanding alpha authorizations are void
    for (const verifier of [
      s.addresses.pviumVerifier,
      s.sets[0].pviumVerifier,
    ]) {
      expect(await s.signerOn(verifier, NEW_SIGNER)).to.equal(true);
      expect(await s.signerOn(verifier, OLD_SIGNER)).to.equal(false);
    }
    const again = await s.run();
    expect([...again.sent, ...again.pending]).to.deep.equal([]);
  });
});
