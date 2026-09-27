import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { createHash, createPublicKey, verify as ecdsaVerify } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { deployIdentityProof, deployVerifier } from './helpers/deployVerifier';

// Must match circuit/src/main.nr
const HASH_PREFIX = 'p2id.identity.v1';
const IDENTITY_TYPE_EMAIL = 0;

// Public input order emitted by the circuit
const PI = {
  identityType: 0,
  wallet: 1,
  signerXHi: 2,
  signerXLo: 3,
  signerYHi: 4,
  signerYLo: 5,
  iat: 6,
  identityHashHi: 7,
  identityHashLo: 8,
  walletHashHi: 9,
  walletHashLo: 10,
} as const;
const PUBLIC_INPUT_COUNT = 11;
const IDENTITY_TYPE_WALLET = 12;
const SAMPLE_WALLET = '0xA01b6E60D51eDB3fEB9f86a62b846f4F90070f98';

const fixtures = join(__dirname, 'fixtures');

function loadProof(): string {
  return '0x' + readFileSync(join(fixtures, 'email.proof')).toString('hex');
}

function loadPublicInputs(): string[] {
  const raw = readFileSync(join(fixtures, 'email.public_inputs'));
  expect(raw.length % 32).to.equal(0);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 32) {
    out.push('0x' + raw.subarray(i, i + 32).toString('hex'));
  }
  return out;
}

/** Reassemble a 32-byte hash from the two 128-bit halves the circuit outputs. */
function joinHalves(hi: string, lo: string): string {
  return ethers.toBeHex((BigInt(hi) << 128n) | BigInt(lo), 32);
}

function sha256(...parts: Buffer[]): string {
  return '0x' + createHash('sha256').update(Buffer.concat(parts)).digest('hex');
}

/** The sample token is a real (expired) Privy identity token; the PEM is Privy's key from its JWKS. */
function sampleToken() {
  const token = readFileSync(join(fixtures, 'sample_token.jwt'), 'utf8').trim();
  const [header, payload, signature] = token.split('.');
  return {
    signingInput: Buffer.from(`${header}.${payload}`),
    signature: Buffer.from(signature, 'base64url'),
    publicKey: createPublicKey(readFileSync(join(fixtures, 'privy_es256_public.pem'))),
  };
}

/** Raw (x, y) of the sample signer key, as a claim contract would be constructed with. */
function sampleSignerKey(): { x: bigint; y: bigint } {
  const jwk = sampleToken().publicKey.export({ format: 'jwk' });
  return {
    x: BigInt('0x' + Buffer.from(jwk.x as string, 'base64url').toString('hex')),
    y: BigInt('0x' + Buffer.from(jwk.y as string, 'base64url').toString('hex')),
  };
}

describe('PviumZKVerifier (generated Honk verifier)', function () {
  this.timeout(120_000);

  let verifier: any;
  let proof: string;
  let publicInputs: string[];

  before(async () => {
    const deployed = await deployVerifier();
    verifier = deployed.verifier;
    proof = loadProof();
    publicInputs = loadPublicInputs();

    for (const [name, c] of Object.entries(deployed)) {
      const code = await ethers.provider.getCode(await c.getAddress());
      console.log(`      ${name} bytecode: ${(code.length - 2) / 2} bytes (EIP-170 limit 24576)`);
    }
  });

  it('exposes the same number of public inputs the circuit emits', () => {
    expect(publicInputs.length).to.equal(PUBLIC_INPUT_COUNT);
  });

  it('verifies the sample proof', async () => {
    expect(await verifier.verify(proof, publicInputs)).to.equal(true);
    const gas = await verifier.verify.estimateGas(proof, publicInputs);
    console.log(`      verify gas: ${gas.toString()}`);
  });

  it('public inputs decode to the expected identity type, wallet and iat', () => {
    expect(BigInt(publicInputs[PI.identityType])).to.equal(BigInt(IDENTITY_TYPE_EMAIL));
    expect(BigInt(publicInputs[PI.wallet])).to.equal(BigInt(SAMPLE_WALLET));
    expect(BigInt(publicInputs[PI.iat])).to.equal(1789240094n);
  });

  it('signer public key outputs equal the raw key the token was signed with', () => {
    const { x, y } = sampleSignerKey();
    expect(BigInt(joinHalves(publicInputs[PI.signerXHi], publicInputs[PI.signerXLo]))).to.equal(x);
    expect(BigInt(joinHalves(publicInputs[PI.signerYHi], publicInputs[PI.signerYLo]))).to.equal(y);
  });

  it('the sample token really is signed by that key over sha256(header.payload)', () => {
    // Sanity check on the fixture itself; the circuit performs this same check in-circuit.
    const { signingInput, signature, publicKey } = sampleToken();
    const ok = ecdsaVerify('sha256', signingInput, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);
    expect(ok).to.equal(true);
    expect(signature.length).to.equal(64); // r || s
  });

  it('identity_hash equals sha256(prefix || type || lowercase(email))', () => {
    const identityHash = joinHalves(publicInputs[PI.identityHashHi], publicInputs[PI.identityHashLo]);
    const expected = sha256(
      Buffer.from(HASH_PREFIX),
      Buffer.from([IDENTITY_TYPE_EMAIL]),
      Buffer.from('test-9988@privy.io'),
    );
    expect(identityHash).to.equal(expected);
  });

  it('wallet_hash equals sha256(prefix || wallet || lowercase(0x address))', () => {
    const walletHash = joinHalves(publicInputs[PI.walletHashHi], publicInputs[PI.walletHashLo]);
    const expected = sha256(
      Buffer.from(HASH_PREFIX),
      Buffer.from([IDENTITY_TYPE_WALLET]),
      Buffer.from(SAMPLE_WALLET.toLowerCase()),
    );
    expect(walletHash).to.equal(expected);
  });

  it('rejects a proof whose wallet was changed', async () => {
    const tampered = [...publicInputs];
    tampered[PI.wallet] = ethers.toBeHex(2n, 32);
    await expect(verifier.verify(proof, tampered)).to.be.reverted;
  });

  it('rejects a proof whose signer key was changed', async () => {
    const tampered = [...publicInputs];
    tampered[PI.signerXLo] = ethers.toBeHex(BigInt(tampered[PI.signerXLo]) ^ 1n, 32);
    await expect(verifier.verify(proof, tampered)).to.be.reverted;
  });

  it('rejects a proof whose identity hash was changed', async () => {
    const tampered = [...publicInputs];
    tampered[PI.identityHashLo] = ethers.toBeHex(BigInt(tampered[PI.identityHashLo]) ^ 1n, 32);
    await expect(verifier.verify(proof, tampered)).to.be.reverted;
  });

  it('rejects a proof with a flipped byte', async () => {
    const bytes = ethers.getBytes(proof);
    bytes[bytes.length - 1] ^= 0x01;
    await expect(verifier.verify(ethers.hexlify(bytes), publicInputs)).to.be.reverted;
  });

  it('rejects a proof of the wrong length', async () => {
    await expect(verifier.verify(proof + '00', publicInputs)).to.be.revertedWithCustomError(
      verifier,
      'ProofLengthWrongWithLogN',
    );
  });

  it('rejects the wrong number of public inputs', async () => {
    await expect(verifier.verify(proof, publicInputs.slice(0, 10))).to.be.revertedWithCustomError(
      verifier,
      'PublicInputsLengthWrong',
    );
  });
});

describe('PviumIdentity', function () {
  this.timeout(120_000);

  let verifierAddress: string;
  let proof: string;
  let publicInputs: string[];

  before(async () => {
    verifierAddress = await (await deployVerifier()).verifier.getAddress();
    proof = loadProof();
    publicInputs = loadPublicInputs();
  });

  it('stores the accepted signer key set and its owner; a zero owner makes the set permanent', async () => {
    const { x, y } = sampleSignerKey();
    const [deployer, other] = await ethers.getSigners();
    const gate = await deployIdentityProof(verifierAddress, x, y);
    expect(await gate.isSignerKey(x, y)).to.equal(true);
    expect(await gate.signerKeyCount()).to.equal(1n);
    expect(await gate.verifier()).to.equal(verifierAddress);
    expect(await gate.circuitVersion()).to.equal(1n);
    expect(await gate.owner()).to.equal(deployer.address);
    const frozen = await deployIdentityProof(verifierAddress, x, y, 1, [], ethers.ZeroAddress);
    await expect(frozen.proposeSignerKey(x, y, '', '')).to.be.revertedWithCustomError(frozen, 'NotOwner');
    await expect(frozen.connect(other).acceptOwnership()).to.be.revertedWithCustomError(frozen, 'NotPendingOwner');
  });

  it('a key is accepted 7 days after it is proposed with its JWKS URL, and refused the moment it is removed', async () => {
    const { x, y } = sampleSignerKey();
    const [owner, other] = await ethers.getSigners();
    const gx = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
    const gy = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;
    const gate = await deployIdentityProof(verifierAddress, gx, gy); // deployed without the token's key
    await expect(gate.verifyAttestation(proof, publicInputs)).to.be.revertedWithCustomError(gate, 'UnknownSigner');

    const url = 'https://auth.privy.io/api/v1/apps/app/jwks.json';
    await expect(gate.connect(other).proposeSignerKey(x, y, url, 'kid-1')).to.be.revertedWithCustomError(gate, 'NotOwner');
    await expect(gate.proposeSignerKey(x, y ^ 1n, url, 'kid-1')).to.be.revertedWithCustomError(gate, 'InvalidPublicKey');
    await expect(gate.proposeSignerKey(gx, gy, url, 'kid-0')).to.be.revertedWithCustomError(gate, 'KeyAlreadyAccepted');
    const tx = await gate.proposeSignerKey(x, y, url, 'kid-1');
    const eta = BigInt((await ethers.provider.getBlock((await tx.wait())!.blockNumber))!.timestamp) + 7n * 24n * 3600n;
    await expect(tx).to.emit(gate, 'SignerKeyProposed').withArgs(x, y, eta, url, 'kid-1');
    const pending = await gate.signerKeyProposals(await gate.signerKeyHash(x, y));
    expect([pending.eta, pending.url, pending.kid]).to.deep.equal([eta, url, 'kid-1']);

    await expect(gate.activateSignerKey(x, y)).to.be.revertedWithCustomError(gate, 'TimelockNotElapsed');
    await expect(gate.verifyAttestation(proof, publicInputs)).to.be.revertedWithCustomError(gate, 'UnknownSigner'); // not yet
    await time.increase(7 * 24 * 3600);
    await expect(gate.connect(other).activateSignerKey(x, y)).to.emit(gate, 'SignerKeyAdded').withArgs(x, y); // anyone, once due
    expect(await gate.signerKeyCount()).to.equal(2n);
    expect((await gate.verifyAttestation(proof, publicInputs)).iat).to.equal(1789240094n);
    await expect(gate.activateSignerKey(x, y)).to.be.revertedWithCustomError(gate, 'NothingProposed');

    // cancel: a proposal can be withdrawn until it is activated
    await gate.proposeSignerKey(1n + gx, gy, url, 'kid-2').catch(() => {}); // off-curve, ignored
    await gate.removeSignerKey(gx, gy);
    await gate.proposeSignerKey(gx, gy, url, 'kid-0');
    await expect(gate.cancelSignerKeyProposal(gx, gy)).to.emit(gate, 'SignerKeyProposalCancelled').withArgs(gx, gy);
    await expect(gate.cancelSignerKeyProposal(gx, gy)).to.be.revertedWithCustomError(gate, 'NothingProposed');

    // remove: immediate, even the last key (a freeze is the safe state), and each removal bumps the revision
    expect(await gate.signerKeyCount()).to.equal(1n);
    expect(await gate.keySetRevision()).to.equal(1n);
    await expect(gate.removeSignerKey(gx, gy)).to.be.revertedWithCustomError(gate, 'UnknownKey');
    await gate.proposeSignerKey(gx, gy, url, 'kid-0');
    await time.increase(7 * 24 * 3600);
    await gate.activateSignerKey(gx, gy);
    await expect(gate.removeSignerKey(x, y)).to.emit(gate, 'SignerKeyRemoved').withArgs(x, y);
    await expect(gate.verifyAttestation(proof, publicInputs)).to.be.revertedWithCustomError(gate, 'UnknownSigner');
    await gate.removeSignerKey(gx, gy);
    expect(await gate.signerKeyCount()).to.equal(0n);
    expect(await gate.keySetRevision()).to.equal(3n);

    // ownership: two steps
    await gate.transferOwnership(other.address);
    await expect(gate.connect(other).removeSignerKey(gx, gy)).to.be.revertedWithCustomError(gate, 'NotOwner');
    await gate.connect(other).acceptOwnership();
    expect(await gate.owner()).to.equal(other.address);
    await expect(gate.proposeSignerKey(x, y, url, 'kid-1')).to.be.revertedWithCustomError(gate, 'NotOwner');
  });

  it('accepts a proof signed by any key in the set, and refuses empty or duplicate sets', async () => {
    const { x, y } = sampleSignerKey();
    const gx = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n; // P-256 generator: a valid point
    const gy = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;
    // the Privy JWKS lists several keys; the token's key may be any of them, in any position
    const gate = await deployIdentityProof(verifierAddress, gx, gy, 1, [{ x, y }]);
    expect(await gate.signerKeyCount()).to.equal(2n);
    expect((await gate.verifyAttestation(proof, publicInputs)).iat).to.equal(1789240094n);
    const factory = await ethers.getContractFactory('PviumIdentity');
    const [deployer] = await ethers.getSigners();
    await expect(factory.deploy(verifierAddress, 2, deployer.address, [], [])).to.be.revertedWithCustomError(factory, 'NoSignerKeys');
    await expect(factory.deploy(verifierAddress, 2, deployer.address, [x], [])).to.be.revertedWithCustomError(factory, 'NoSignerKeys');
    await expect(factory.deploy(verifierAddress, 2, deployer.address, [x, x], [y, y])).to.be.revertedWithCustomError(factory, 'DuplicateSignerKey');
  });

  it('refuses circuit version 0', async () => {
    const { x, y } = sampleSignerKey();
    await expect(deployIdentityProof(verifierAddress, x, y, 0)).to.be.revertedWithCustomError(
      await ethers.getContractFactory('PviumIdentity'),
      'InvalidCircuitVersion',
    );
  });

  it('refuses to register a point that is not on P-256', async () => {
    const { x, y } = sampleSignerKey();
    await expect(deployIdentityProof(verifierAddress, x, y ^ 1n)).to.be.revertedWithCustomError(
      await ethers.getContractFactory('PviumIdentity'),
      'InvalidPublicKey',
    );
  });

  it('verifyAttestation: registered signer passes and decodes the claim', async () => {
    const { x, y } = sampleSignerKey();
    const gate = await deployIdentityProof(verifierAddress, x, y);
    const claim = await gate.verifyAttestation(proof, publicInputs);
    expect(claim.identityType).to.equal(BigInt(IDENTITY_TYPE_EMAIL));
    expect(claim.wallet).to.equal(SAMPLE_WALLET);
    expect(claim.iat).to.equal(1789240094n);
    expect(claim.identityHash).to.equal(
      sha256(Buffer.from(HASH_PREFIX), Buffer.from([IDENTITY_TYPE_EMAIL]), Buffer.from('test-9988@privy.io')),
    );
    expect(claim.walletHash).to.equal(
      sha256(Buffer.from(HASH_PREFIX), Buffer.from([IDENTITY_TYPE_WALLET]), Buffer.from(SAMPLE_WALLET.toLowerCase())),
    );
    console.log(`      verifyAttestation gas: ${(await gate.verifyAttestation.estimateGas(proof, publicInputs)).toString()}`);
  });

  it('rejects a valid proof whose signer is not the registered key', async () => {
    // Register a different valid P-256 point: the generator.
    const gx = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
    const gy = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;
    const gate = await deployIdentityProof(verifierAddress, gx, gy);
    await expect(gate.verifyAttestation(proof, publicInputs)).to.be.revertedWithCustomError(gate, 'UnknownSigner');
  });

  it('rejects a tampered proof even with the right signer', async () => {
    const { x, y } = sampleSignerKey();
    const gate = await deployIdentityProof(verifierAddress, x, y);
    const bytes = ethers.getBytes(proof);
    bytes[bytes.length - 1] ^= 0x01;
    await expect(gate.verifyAttestation(ethers.hexlify(bytes), publicInputs)).to.be.reverted;
  });

  it('rejects the wrong number of public inputs', async () => {
    const { x, y } = sampleSignerKey();
    const gate = await deployIdentityProof(verifierAddress, x, y);
    await expect(gate.verifyAttestation(proof, publicInputs.slice(0, 10))).to.be.revertedWithCustomError(
      gate,
      'WrongPublicInputCount',
    );
  });
});

describe('PviumIdentity developer API', function () {
  this.timeout(120_000);

  const EMAIL = 'test-9988@privy.io';
  let gate: any;
  let proof: string;
  let publicInputs: string[];

  before(async () => {
    const verifierAddress = await (await deployVerifier()).verifier.getAddress();
    const { x, y } = sampleSignerKey();
    gate = await deployIdentityProof(verifierAddress, x, y);
    proof = loadProof();
    publicInputs = loadPublicInputs();
  });

  const idHash = (type: number, value: string) => sha256(Buffer.from(HASH_PREFIX), Buffer.from([type]), Buffer.from(value));
  const EMAIL_HASH = idHash(IDENTITY_TYPE_EMAIL, EMAIL);
  const WALLET_HASH = idHash(IDENTITY_TYPE_WALLET, SAMPLE_WALLET.toLowerCase());

  it('verifyIdentity(identityHash, walletHash) returns issuedAt', async () => {
    expect(await gate.verifyIdentity(proof, publicInputs, IDENTITY_TYPE_EMAIL, EMAIL_HASH, WALLET_HASH)).to.equal(1789240094n);
    console.log(`      verifyIdentity gas: ${(await gate.verifyIdentity.estimateGas(proof, publicInputs, IDENTITY_TYPE_EMAIL, EMAIL_HASH, WALLET_HASH)).toString()}`);
  });

  it('P2IDHash computes the same hashes on chain: case-insensitive, EVM and non-EVM wallets', async () => {
    const lib = await ethers.deployContract('MockP2IDHash');
    expect(await lib.identityHash(IDENTITY_TYPE_EMAIL, ethers.toUtf8Bytes(EMAIL))).to.equal(EMAIL_HASH);
    expect(await lib.identityHash(IDENTITY_TYPE_EMAIL, ethers.toUtf8Bytes('TEST-9988@Privy.IO'))).to.equal(EMAIL_HASH);
    expect(await lib.walletHash(SAMPLE_WALLET)).to.equal(WALLET_HASH);
    expect(await lib.walletHashString(SAMPLE_WALLET)).to.equal(WALLET_HASH);
    const solana = 'EXnVUEeELHiYynvjoQ9YhgxfMSDJC6tJm7VkFQY2b8Wj'; // base58 is case-sensitive: hashed as is
    expect(await lib.walletHashString(solana)).to.equal(idHash(IDENTITY_TYPE_WALLET, solana));
  });

  it('rejects a wallet the proof does not bind', async () => {
    const other = idHash(IDENTITY_TYPE_WALLET, '0x899BA183F2c55BF9C627D9Af2984fbdED2E64311'.toLowerCase());
    await expect(gate.verifyIdentity(proof, publicInputs, IDENTITY_TYPE_EMAIL, EMAIL_HASH, other))
      .to.be.revertedWithCustomError(gate, 'WalletMismatch');
  });

  it('rejects the wrong identity value or type', async () => {
    await expect(gate.verifyIdentity(proof, publicInputs, IDENTITY_TYPE_EMAIL, idHash(IDENTITY_TYPE_EMAIL, 'other@gmail.com'), WALLET_HASH))
      .to.be.revertedWithCustomError(gate, 'IdentityMismatch');
    await expect(gate.verifyIdentity(proof, publicInputs, 5, EMAIL_HASH, WALLET_HASH))
      .to.be.revertedWithCustomError(gate, 'IdentityTypeMismatch');
  });

  it('rejects a tampered proof after the cheap checks pass', async () => {
    const bytes = ethers.getBytes(proof);
    bytes[300] ^= 0x01;
    await expect(gate.verifyIdentity(ethers.hexlify(bytes), publicInputs, IDENTITY_TYPE_EMAIL, EMAIL_HASH, WALLET_HASH)).to.be.reverted;
  });
});

/**
 * What a client (e.g. the Flutter app) does with the attestation JSON the backend returns:
 * base64 -> bytes, split public inputs into bytes32 words, hash identity + wallet locally, and
 * make a raw eth_call to verifyIdentity. No raw identity ever reaches the RPC node.
 */
describe('eth_call from the backend attestation JSON', function () {
  this.timeout(120_000);

  const iface = new ethers.Interface([
    'function verifyIdentity(bytes proof, bytes32[] publicInputs, uint8 identityType, bytes32 identityHash, bytes32 walletHash) view returns (uint64)',
    'error WalletMismatch()',
    'error IdentityMismatch()',
    'error InvalidProof()',
  ]);
  let gateAddress: string;
  let attestation: { proof: string; publicInputs: string; wallet: string; identityType: string; circuitVersion: number };

  before(async () => {
    const verifierAddress = await (await deployVerifier()).verifier.getAddress();
    const { x, y } = sampleSignerKey();
    gateAddress = await (await deployIdentityProof(verifierAddress, x, y)).getAddress();
    // Exactly the JSON shape http-prover / the Pvium API return.
    attestation = {
      proof: readFileSync(join(fixtures, 'email.proof')).toString('base64'),
      publicInputs: readFileSync(join(fixtures, 'email.public_inputs')).toString('base64'),
      wallet: SAMPLE_WALLET,
      identityType: 'email',
      circuitVersion: 1,
    };
  });

  function calldata(identityValue: string, wallet: string): string {
    const proofBytes = Buffer.from(attestation.proof, 'base64');
    const piBytes = Buffer.from(attestation.publicInputs, 'base64');
    const words: string[] = [];
    for (let i = 0; i < piBytes.length; i += 32) words.push('0x' + piBytes.subarray(i, i + 32).toString('hex'));
    const identityHash = sha256(Buffer.from(HASH_PREFIX), Buffer.from([IDENTITY_TYPE_EMAIL]), Buffer.from(identityValue.toLowerCase()));
    const walletHash = sha256(Buffer.from(HASH_PREFIX), Buffer.from([IDENTITY_TYPE_WALLET]), Buffer.from(wallet.toLowerCase()));
    return iface.encodeFunctionData('verifyIdentity', [proofBytes, words, IDENTITY_TYPE_EMAIL, identityHash, walletHash]);
  }

  it('selector is stable (hardcoded in the Dart example)', () => {
    expect(iface.getFunction('verifyIdentity')!.selector).to.equal('0x' + ethers.id('verifyIdentity(bytes,bytes32[],uint8,bytes32,bytes32)').slice(2, 10));
    console.log(`      selector: ${iface.getFunction('verifyIdentity')!.selector}`);
  });

  it('raw eth_call verifies and returns issuedAt', async () => {
    const ret = await ethers.provider.call({ to: gateAddress, data: calldata('test-9988@privy.io', attestation.wallet) });
    const [issuedAt] = iface.decodeFunctionResult('verifyIdentity', ret);
    expect(issuedAt).to.equal(1789240094n);
  });

  it('raw eth_call reverts with a decodable custom error on a wrong wallet', async () => {
    try {
      await ethers.provider.call({ to: gateAddress, data: calldata('test-9988@privy.io', '0x899BA183F2c55BF9C627D9Af2984fbdED2E64311') });
      expect.fail('should have reverted');
    } catch (e: any) {
      const data: string = e.data ?? e.info?.error?.data ?? '';
      expect(iface.parseError(data)?.name).to.equal('WalletMismatch');
    }
  });
});
