use anchor_lang::prelude::*;

#[error_code]
pub enum RouterError {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Caller is not the authority PDA of this vault's implementation")]
    NotImplementation,
    #[msg("Implementation is not registered with the factory")]
    ImplementationNotRegistered,
    #[msg("Implementation must be a nonzero address")]
    InvalidImplementation,
    #[msg("Too many registered implementations")]
    TooManyImplementations,
    #[msg("No implementation proposal is pending")]
    NoImplementationProposed,
    #[msg("Implementation notice has not elapsed")]
    ImplementationChangeNotReady,
    #[msg("Wrong factory for this vault")]
    WrongFactory,
    #[msg("Deposit does not belong to this vault")]
    WrongVault,
    #[msg("Verifier is not allowed by the factory")]
    VerifierNotAllowed,
    #[msg("Verifier config does not belong to this verifier")]
    WrongVerifierConfig,
    #[msg("The default verifier cannot be revoked; activate another first")]
    CannotRevokeDefault,
    #[msg("No verifier proposal is pending")]
    NoVerifierProposed,
    #[msg("Verifier change notice has not elapsed")]
    VerifierChangeNotReady,
    #[msg("Refund window is outside factory bounds")]
    InvalidRefundWindow,
    #[msg("Deposit was already consumed")]
    DepositConsumed,
    #[msg("Refund window has not elapsed")]
    RefundNotReady,
    #[msg("Caller is not this deposit's refunder (the named refunder, else the funder)")]
    NotFunderOrRefunder,
    #[msg("Owner update is older than the newest proof this vault has seen")]
    OwnerUpdateNotFresh,
    #[msg("Destination is not the cached owner of this vault")]
    NotCachedOwner,
    #[msg("Owner cache is stale: a signer key was removed since the owner was proven")]
    OwnerCacheStale,
    #[msg("Owner cache was proven under a different verifier than this deposit pins")]
    OwnerCacheVerifierMismatch,
    #[msg("Amount must be nonzero")]
    InvalidAmount,
    #[msg("Constraints are not supported: the verifier has no constraint signers")]
    ConstraintsUnsupported,
    #[msg("Constraint not satisfied: no ed25519 signature by a constraint signer over this deposit's commitment precedes this instruction")]
    ConstraintNotSatisfied,
    #[msg("Too many constraint signers")]
    TooManyConstraintSigners,
    #[msg("params_hash does not commit to the given factory parameters")]
    InvalidFactoryParams,
    #[msg("Policy must be a nonzero address")]
    InvalidPolicy,
    #[msg("No policy proposal is pending")]
    NoPolicyProposed,
    #[msg("Policy change notice has not elapsed")]
    PolicyChangeNotReady,
    #[msg("Signer key is all zero")]
    InvalidSignerKey,
    #[msg("Signer key is already accepted")]
    SignerKeyAlreadyAccepted,
    #[msg("At least one signer key is required")]
    NoSignerKeys,
    #[msg("Too many signer keys")]
    TooManySignerKeys,
    #[msg("No signer key proposal is pending")]
    NoSignerKeyProposed,
    #[msg("Signer key notice has not elapsed")]
    SignerKeyChangeNotReady,
    #[msg("Unknown signer key")]
    UnknownSignerKey,
    #[msg("Caller is not the pending authority")]
    NotPendingAuthority,
    #[msg("Nothing untracked to sweep")]
    NothingToSweep,
    #[msg("Wrong mint for this account")]
    WrongMint,
}
