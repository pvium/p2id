import { checkBb, ensureCircuitJson, loadCircuitVersion, type CircuitVersion, type ProverConfig } from './config.js';
import { InputError } from './errors.js';
import { PUBLIC_INPUT_COUNT, PUBLIC_INPUT_IAT, TYPES, type IdentityTypeName } from './identity.js';
import { Prover, type ProofNetwork } from './prove.js';
import { authenticate, normalizeLowS, parseToken } from './token.js';
import { buildWitness } from './witness.js';

export interface AttestationRequest {
  identityType: IdentityTypeName;
  identityValue: string;
  jwt: string;
  /** Linked wallet to bind (proves identity and wallet belong to the same Privy user). */
  wallet?: string;
  /** Circuit version to prove for. Omit for the latest; this prover serves exactly one. */
  version?: number;
  /**
   * If set, the request is accepted with 202 and the attestation (or the error) is POSTed to this
   * URL when ready. Put a secret in the URL if you need to authenticate the delivery. Without it
   * the response is synchronous.
   */
  callbackUrl?: string;
  /** Proof target. Omit for backwards-compatible Ethereum/Barretenberg proofs. */
  network?: ProofNetwork;
}

/** What the resolution API stores and later returns; verifiable with @pvium/p2id-verifier. */
export interface Attestation {
  proof: string; // base64
  /** Base64 public inputs: 11 fields for Ethereum; Sunspot's complete .pw file for Solana. */
  publicInputs: string;
  /** Alias of publicInputs for Solana verifiers that expect the serialized Sunspot witness. */
  publicWitness?: string;
  network: ProofNetwork;
  wallet: string | null;
  identityType: IdentityTypeName;
  issuedAt: number;
  /** Which circuit build produced this proof; verifiers must use the matching vk / contract. */
  circuitVersion: number;
  /** Ethereum Barretenberg verification-key hash; omitted for Solana proofs. */
  vkHash?: string;
  /** kid of the Privy key that signed the token, when the token carried one. */
  kid?: string;
}

export class AttestationService {
  private readonly prover: Prover;
  private bbChecked = false;
  readonly version: CircuitVersion;

  constructor(private readonly cfg: ProverConfig) {
    ensureCircuitJson(cfg);
    this.version = loadCircuitVersion(cfg);
    this.prover = new Prover(cfg);
  }

  get stats() {
    return this.prover.stats;
  }

  close(): Promise<void> {
    return this.prover.close();
  }

  /** Structural validation only; throws InputError. Used to reject bad async requests up front. */
  validateRequest(req: AttestationRequest): void {
    validate(req);
    if (req.version !== undefined && req.version !== this.version.circuitVersion) {
      throw new InputError(`unsupported circuit version ${req.version}; this prover serves version ${this.version.circuitVersion}`);
    }
  }

  async generate(req: AttestationRequest): Promise<Attestation> {
    validate(req);
    if (req.version !== undefined && req.version !== this.version.circuitVersion) {
      throw new InputError(`unsupported circuit version ${req.version}; this prover serves version ${this.version.circuitVersion}`);
    }
    const network = normalizeNetwork(req.network);
    const token = parseToken(req.jwt);
    const signer = await authenticate(token, this.cfg.signer); // fails fast on bad tokens
    const { inputs, iat } = buildWitness(
      { token, signer, identityType: req.identityType, identityValue: req.identityValue, wallet: req.wallet },
      normalizeLowS(token.signature),
    );
    if (network === 'ethereum' && !this.bbChecked) {
      checkBb(this.cfg);
      this.bbChecked = true;
    }
    const { proof, publicInputs, publicWitness } = await this.prover.prove(inputs, network);
    if (network === 'ethereum') {
      if (publicInputs.length !== PUBLIC_INPUT_COUNT * 32) throw new Error(`unexpected public input size ${publicInputs.length}`);
      const iatOut = Number(BigInt('0x' + publicInputs.subarray(PUBLIC_INPUT_IAT * 32, (PUBLIC_INPUT_IAT + 1) * 32).toString('hex')));
      if (iatOut !== iat) throw new Error('circuit iat does not match token iat');
    }
    return {
      proof: proof.toString('base64'),
      publicInputs: publicInputs.toString('base64'),
      ...(publicWitness && { publicWitness: publicWitness.toString('base64') }),
      network,
      wallet: req.wallet ?? null,
      identityType: req.identityType,
      issuedAt: iat,
      circuitVersion: this.version.circuitVersion,
      ...(network === 'ethereum' && { vkHash: this.version.vkSha256 }),
      kid: signer.kid,
    };
  }
}

function validate(req: AttestationRequest): void {
  if (typeof req !== 'object' || req === null) throw new InputError('body must be a JSON object');
  if (typeof req.identityType !== 'string' || !(req.identityType in TYPES)) {
    throw new InputError(`identityType must be one of: ${Object.keys(TYPES).join(', ')}`);
  }
  if (typeof req.identityValue !== 'string' || req.identityValue.length === 0) throw new InputError('identityValue is required');
  if (typeof req.jwt !== 'string' || req.jwt.length === 0) throw new InputError('jwt is required');
  if (req.wallet !== undefined && (typeof req.wallet !== 'string' || req.wallet.length === 0)) throw new InputError('wallet must be a non-empty string');
  if (req.version !== undefined && (!Number.isInteger(req.version) || req.version < 1)) throw new InputError('version must be a positive integer');
  if (req.callbackUrl !== undefined && typeof req.callbackUrl !== 'string') throw new InputError('callbackUrl must be a string');
  normalizeNetwork(req.network);
}

export function normalizeNetwork(network: unknown): ProofNetwork {
  if (network === undefined) return 'ethereum';
  if (typeof network !== 'string') throw new InputError('network must be one of: ethereum, solana');
  const normalized = network.toLowerCase();
  if (normalized !== 'ethereum' && normalized !== 'solana') {
    throw new InputError('network must be one of: ethereum, solana');
  }
  return normalized;
}
