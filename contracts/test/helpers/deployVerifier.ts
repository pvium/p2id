import { ethers } from 'hardhat';
import { circuitRelease } from '../../scripts/lib/deterministic';

/** The circuit the fixtures' proofs were made with: circuit/version.json. */
export const CURRENT_CIRCUIT: { circuitVersion: number; vkSha256: string } = require('../../../circuit/version.json');
/**
 * That circuit's contracts (contracts/releases.json). Every circuit version keeps its own generated
 * ZK verifier and PviumVerifier, so tests name them through this instead of a fixed contract name.
 */
export const CURRENT = circuitRelease(CURRENT_CIRCUIT.circuitVersion);

/**
 * Deploys the current circuit's bb-generated Honk verifier together with the external libraries bb
 * splits out of it (RelationsLib, ZKTranscriptLib) and links them. Every generated verifier file
 * declares those library names, so they are addressed by file.
 */
export async function deployVerifier() {
  const source = CURRENT.zkVerifier.split(':')[0];
  const relations = await ethers.deployContract(`${source}:RelationsLib`);
  const transcript = await ethers.deployContract(`${source}:ZKTranscriptLib`);
  await Promise.all([relations.waitForDeployment(), transcript.waitForDeployment()]);

  const verifier = await ethers.deployContract(CURRENT.zkVerifier, {
    libraries: {
      [`${source}:RelationsLib`]: await relations.getAddress(),
      [`${source}:ZKTranscriptLib`]: await transcript.getAddress(),
    },
  });
  await verifier.waitForDeployment();
  return { verifier, relations, transcript };
}

/** Deploys PviumIdentity bound to a verifier and one signer key (or pass `extraKeys` for a key set). */
export async function deployIdentityProof(
  verifierAddress: string,
  signerX: bigint,
  signerY: bigint,
  circuitVersion = 1,
  extraKeys: { x: bigint; y: bigint }[] = [],
  owner?: string,
) {
  const keys = [{ x: signerX, y: signerY }, ...extraKeys];
  owner ??= (await ethers.getSigners())[0].address;
  const proof = await ethers.deployContract('PviumIdentity', [verifierAddress, circuitVersion, CURRENT_CIRCUIT.vkSha256, owner, keys.map((k) => k.x), keys.map((k) => k.y)]);
  await proof.waitForDeployment();
  return proof;
}
