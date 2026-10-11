import { expect } from 'chai';
import { ethers } from 'hardhat';
import { createHash, createPublicKey } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { deployIdentityProof, deployVerifier } from './helpers/deployVerifier';

/**
 * Circuit version 2: an email identity can be proven from a Google, LinkedIn or Apple login, not
 * only a Privy email account, and hashes as `email` either way. The fixture is a real version 2
 * proof of `Dummy.User@Example.com` from a dummy token whose only identity account is
 * `google_oauth` (signed with the throwaway test key), proven as identity type 0 (email).
 * Regenerate with circuit/scripts/gen_prover.py --type email on such a token, then bb prove into
 * circuit/target/proof_google; scripts/refresh-fixtures.sh copies it here.
 */
const fixtures = join(__dirname, 'fixtures');
const EMAIL = 'dummy.user@example.com';
const WALLET = '0x1111111111111111111111111111111111111111';
const IAT = 1789240094n;
const EMAIL_TYPE = 0;
const GOOGLE_TYPE = 2;

const idHash = (type: number, value: string) =>
  '0x' + createHash('sha256').update(Buffer.concat([Buffer.from('p2id.identity.v1'), Buffer.from([type]), Buffer.from(value)])).digest('hex');

const proof = '0x' + readFileSync(join(fixtures, 'google_email.proof')).toString('hex');
const publicInputs = (() => {
  const raw = readFileSync(join(fixtures, 'google_email.public_inputs'));
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 32) out.push('0x' + raw.subarray(i, i + 32).toString('hex'));
  return out;
})();
const testKey = (() => {
  const jwk = createPublicKey(readFileSync(join(fixtures, 'test_es256_public.pem'))).export({ format: 'jwk' });
  return { x: BigInt('0x' + Buffer.from(jwk.x!, 'base64url').toString('hex')), y: BigInt('0x' + Buffer.from(jwk.y!, 'base64url').toString('hex')) };
})();

describe('circuit v2: email proven from a Google login, verified on chain', function () {
  let identity: any, verifier: any;

  before(async () => {
    const { verifier: zk } = await deployVerifier();
    identity = await deployIdentityProof(await zk.getAddress(), testKey.x, testKey.y, 2);
    const [admin] = await ethers.getSigners();
    verifier = await ethers.deployContract('PviumVerifier', [await identity.getAddress(), admin.address, []]);
  });

  it('PviumIdentity accepts it as an email identity (type 0) and returns its issue time', async () => {
    const walletHash = idHash(12, WALLET);
    expect(await identity.verifyIdentity(proof, publicInputs, EMAIL_TYPE, idHash(EMAIL_TYPE, EMAIL), walletHash)).to.equal(IAT);
  });

  it('the public identity type is email, not google: a google-typed claim of the same proof is refused', async () => {
    expect(BigInt(publicInputs[0])).to.equal(BigInt(EMAIL_TYPE));
    await expect(identity.verifyIdentity(proof, publicInputs, GOOGLE_TYPE, idHash(GOOGLE_TYPE, EMAIL), idHash(12, WALLET))).to.be.reverted;
  });

  it('PviumVerifier resolves the email commitment, which is what a P2ID vault holds, to the proven wallet', async () => {
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(['bytes', 'bytes32[]'], [proof, publicInputs]);
    const [wallet, iat] = await verifier.getIdentityWallet(idHash(EMAIL_TYPE, EMAIL), encoded, { commitment: ethers.ZeroHash, signature: '0x' });
    expect(wallet).to.equal(ethers.getAddress(WALLET));
    expect(iat).to.equal(IAT);
    await expect(verifier.getIdentityWallet(idHash(EMAIL_TYPE, 'someone@example.com'), encoded, { commitment: ethers.ZeroHash, signature: '0x' })).to.be.reverted;
  });
});
