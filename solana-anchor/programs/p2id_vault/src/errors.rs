use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Wrong factory for this vault")]
    WrongFactory,
    #[msg("Deposit does not belong to this vault")]
    WrongVault,
    #[msg("Deposit was already consumed")]
    DepositConsumed,
    #[msg("Invalid identity hash")]
    InvalidIdentityHash,
    #[msg("Verifier is not allowed by the factory")]
    VerifierNotAllowed,
    #[msg("Verifier config does not belong to this verifier")]
    WrongVerifierConfig,
    #[msg("Verifier program does not match the pinned deposit verifier")]
    VerifierMismatch,
    #[msg("Proof wallet does not match the destination")]
    InvalidWallet,
    #[msg("Proof is stale: older than the newest proof this vault has seen")]
    ProofNotFresh,
    #[msg("Proof issue time is in the future")]
    ProofFromFuture,
    #[msg("Proof was produced from a token signed by a key this verifier does not accept")]
    UnknownSignerKey,
    #[msg("Verifier rejected the proof")]
    ProofVerificationFailed,
    #[msg("Verifier returned no attestation: not a P2ID verifier")]
    InvalidAttestation,
    #[msg("Verifier program is not executable")]
    VerifierNotExecutable,
    #[msg("Proof payload exceeds the transaction-safe limit")]
    PayloadTooLarge,
    #[msg("Proof is empty")]
    EmptyProof,
    #[msg("Give the proof inline or as a registered buffer with its registerer, not both")]
    AmbiguousProof,
    #[msg("The registered proof belongs to another registerer")]
    WrongRegisterer,
    #[msg("The registered proof does not match its address or hash")]
    ProofBufferMismatch,
}
