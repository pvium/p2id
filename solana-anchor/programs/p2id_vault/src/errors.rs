use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Wrong factory for this vault")]
    WrongFactory,
    #[msg("Deposit does not belong to this vault")]
    WrongVault,
    #[msg("Invalid identity hash")]
    InvalidIdentityHash,
    #[msg("Public witness has an unexpected layout")]
    InvalidPublicWitness,
    #[msg("Verifier is not in the factory allowlist")]
    VerifierNotAllowed,
    #[msg("No verifier proposal is pending")]
    NoVerifierProposed,
    #[msg("Verifier change notice has not elapsed")]
    VerifierChangeNotReady,
    #[msg("Refund window is outside factory bounds")]
    InvalidRefundWindow,
    #[msg("Deposit was already consumed")]
    DepositConsumed,
    #[msg("Refund window is closed")]
    RefundWindowClosed,
    #[msg("Proof wallet does not match the claimer")]
    InvalidWallet,
    #[msg("Proof is stale or not newer than the cached proof")]
    ProofNotFresh,
    #[msg("Verifier rejected the proof")]
    ProofVerificationFailed,
    #[msg("Verifier program is not executable")]
    VerifierNotExecutable,
    #[msg("Verifier program does not match the pinned deposit verifier")]
    VerifierMismatch,
    #[msg("Proof payload exceeds the transaction-safe limit")]
    PayloadTooLarge,
    #[msg("Proof is empty")]
    EmptyProof,
    #[msg("Amount must be nonzero")]
    InvalidAmount,
    #[msg("Constraint does not match the deposit")]
    ConstraintMismatch,
    #[msg("Policy fee exceeds the factory ceiling")]
    FeeTooHigh,
}
