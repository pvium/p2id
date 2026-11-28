//! The P2ID verifier for circuit v2 proofs made with Sunspot (gnark Groth16 over BN254). It
//! implements the `p2id_verifier_interface` in front of the Sunspot-generated verifier program, which
//! only answers "valid or not" to `proof || public witness`. This program checks the witness layout,
//! forwards the payload unchanged, and returns the attestation the witness carries. The Sunspot
//! program it fronts is fixed at build time (`P2ID_ZK_VERIFIER`, see `.cargo/config.toml`) and must
//! itself be immutable: that is checked on every call, so the whole verification path is code nobody
//! can change. A new circuit is a new build of this program behind a new Sunspot program.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke;
use p2id_verifier_interface::{program_status, Attestation, ProgramStatus, MAX_PROOF_LEN};

pub mod witness;

use witness::{parse_public_witness, PW_LEN};

declare_id!("C4uP1e8GtueUQgppaPeiUSwtN6m5pscQcrJsFPNq6A8v");

/// The proof-system program: a Sunspot-generated Groth16 verifier for the P2ID circuit.
pub const ZK_VERIFIER: Pubkey =
    Pubkey::from_str_const(env!("P2ID_ZK_VERIFIER", "set P2ID_ZK_VERIFIER to the Sunspot verifier program id"));

#[program]
pub mod p2id_solana_verifier {
    use super::*;

    /// `proof` is the Groth16 proof followed by the serialized public witness, exactly the bytes the
    /// Sunspot program takes. Fails unless the proof is genuine; returns what it attests.
    pub fn verify(ctx: Context<Verify>, proof: Vec<u8>) -> Result<Attestation> {
        require!(proof.len() > PW_LEN && proof.len() <= MAX_PROOF_LEN, VerifierError::InvalidPayload);
        let zk_verifier = &ctx.accounts.zk_verifier;
        require_keys_eq!(zk_verifier.key(), ZK_VERIFIER, VerifierError::WrongZkVerifier);
        require!(
            program_status(zk_verifier, Some(&ctx.accounts.zk_verifier_data)) == ProgramStatus::Immutable,
            VerifierError::ZkVerifierNotImmutable
        );
        let attestation = parse_public_witness(&proof[proof.len() - PW_LEN..])?;
        invoke(
            &Instruction { program_id: ZK_VERIFIER, accounts: Vec::new(), data: proof },
            &[zk_verifier.to_account_info()],
        )
        .map_err(|_| VerifierError::ProofRejected)?;
        Ok(attestation)
    }
}

#[derive(Accounts)]
pub struct Verify<'info> {
    /// CHECK: must be `ZK_VERIFIER`, executable and immutable; checked in the handler.
    pub zk_verifier: UncheckedAccount<'info>,
    /// CHECK: `ZK_VERIFIER`'s ProgramData account (upgradeable loader); any account for other loaders.
    pub zk_verifier_data: UncheckedAccount<'info>,
}

#[error_code]
pub enum VerifierError {
    #[msg("Proof payload is not a Groth16 proof followed by an 11-input public witness")]
    InvalidPayload,
    #[msg("Public witness has an unexpected layout")]
    InvalidPublicWitness,
    #[msg("Not the ZK verifier program this verifier fronts")]
    WrongZkVerifier,
    #[msg("ZK verifier program is not immutable")]
    ZkVerifierNotImmutable,
    #[msg("Proof is not valid")]
    ProofRejected,
}
