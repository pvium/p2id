import { checkBb, ensureCircuitJson, ensureSunspotArtifacts, loadCircuitVersion, solanaEnabled, type CircuitVersion, type ProverConfig } from './config.js';
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
  /**
   * sha256 of the verifying key this proof is for: Ethereum, the Barretenberg vk (circuit/version.json);
   * Solana, the Sunspot vk as deployed (the factory's vkHash), which tells a sandbox proof from a
   * production one. Verifiers must use the matching vk / contract / program.
   */
  vkHash?: string;
  /** kid of the Privy key that signed the token, when the token carried one. */
  kid?: string;
}

export interface SolanaStatus {
  enabled: boolean;
  /** sunspotd is up with the proving key loaded. Always false when not enabled. */
  ready: boolean;
  vkHash?: string;
  constraints?: number;
  publicInputs?: number;
  loadMs?: number;
}

export class AttestationService {
  private readonly prover: Prover;
  private bbChecked = false;
  private solanaVkHash?: string;
  private solanaReady?: Promise<void>;
  readonly version: CircuitVersion;

  constructor(private readonly cfg: ProverConfig) {
    ensureCircuitJson(cfg);
    this.version = loadCircuitVersion(cfg);
    this.prover = new Prover(cfg);
  }

  get stats() {
    return this.prover.stats;
  }

  /** Whether Solana proving is configured, and what the resident prover reports once started. */
  get solana(): SolanaStatus {
    const d = this.prover.sunspotd;
    return solanaEnabled(this.cfg)
      ? { enabled: true, ready: d.running && d.info !== undefined, vkHash: this.solanaVkHash, ...d.info }
      : { enabled: false, ready: false };
  }

  /**
   * Bring the Solana side up: artifacts in place and hashed, sunspotd started with the key loaded.
   * Called at startup when Solana is enabled so a bad deployment fails its health check instead of
   * the first user's request; a request arriving earlier waits for the same promise.
   */
  startSolana(): Promise<void> {
    if (!solanaEnabled(this.cfg)) return Promise.resolve();
    this.solanaReady ??= (async () => {
      const { vkHash } = await ensureSunspotArtifacts(this.cfg);
      this.solanaVkHash = vkHash;
      const info = await this.prover.startSolana();
      if (info.publicInputs !== PUBLIC_INPUT_COUNT) {
        throw new Error(`Sunspot ACIR has ${info.publicInputs} public inputs, expected ${PUBLIC_INPUT_COUNT}`);
      }
      console.log(`sunspotd ready: ${info.constraints} constraints, constraint system ${info.ccs ?? 'compiled'}, key loaded in ${info.loadMs} ms, vkHash ${vkHash}`);
    })().catch((e) => { this.solanaReady = undefined; throw e; });
    return this.solanaReady;
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
    if (network === 'solana') {
      if (!solanaEnabled(this.cfg)) throw new InputError('Solana proofs are not available from this prover');
      await this.startSolana();
    }
    const { proof, publicInputs, publicWitness } = await this.prover.prove(inputs, network);
    // The proof's iat must be the token's: a mismatch means the witness builder and the circuit
    // disagree about the token, whichever backend proved it.
    const iatOut = network === 'ethereum' ? ethereumIat(publicInputs) : solanaIat(publicWitness!);
    if (iatOut !== iat) throw new Error('circuit iat does not match token iat');
    return {
      proof: proof.toString('base64'),
      publicInputs: publicInputs.toString('base64'),
      ...(publicWitness && { publicWitness: publicWitness.toString('base64') }),
      network,
      wallet: req.wallet ?? null,
      identityType: req.identityType,
      issuedAt: iat,
      circuitVersion: this.version.circuitVersion,
      vkHash: network === 'ethereum' ? this.version.vkSha256 : this.solanaVkHash,
      kid: signer.kid,
    };
  }
}

function ethereumIat(publicInputs: Buffer): number {
  if (publicInputs.length !== PUBLIC_INPUT_COUNT * 32) throw new Error(`unexpected public input size ${publicInputs.length}`);
  return Number(BigInt('0x' + publicInputs.subarray(PUBLIC_INPUT_IAT * 32, (PUBLIC_INPUT_IAT + 1) * 32).toString('hex')));
}

/** Sunspot's public witness: a 12-byte header (the input count as u32 and u64, big-endian), then the 11 inputs as 32-byte big-endian fields. */
export const SUNSPOT_PW_HEADER = 12;
export const SUNSPOT_PW_LEN = SUNSPOT_PW_HEADER + PUBLIC_INPUT_COUNT * 32;

export function solanaIat(publicWitness: Buffer): number {
  if (publicWitness.length !== SUNSPOT_PW_LEN) throw new Error(`unexpected public witness size ${publicWitness.length}`);
  if (publicWitness.readUInt32BE(0) !== PUBLIC_INPUT_COUNT || publicWitness.readBigUInt64BE(4) !== BigInt(PUBLIC_INPUT_COUNT)) {
    throw new Error('unexpected public witness header');
  }
  const start = SUNSPOT_PW_HEADER + PUBLIC_INPUT_IAT * 32;
  return Number(BigInt('0x' + publicWitness.subarray(start, start + 32).toString('hex')));
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
