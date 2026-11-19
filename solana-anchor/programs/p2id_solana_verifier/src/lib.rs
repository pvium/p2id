use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::Instruction,
    program::{invoke, set_return_data},
};

declare_id!("DrPN26cNYpZrqAQgkARpds1ftm6q3hJXWY6Uh4RYgeNJ");

const MAX_VERIFIER_PAYLOAD_LEN: usize = 900;

#[program]
pub mod p2id_solana_verifier {
    use super::*;

    pub fn verify(
        ctx: Context<VerifyProof>,
        verifier_program_id: Pubkey,
        proof: Vec<u8>,
        public_witness: Vec<u8>,
    ) -> Result<()> {
        validate_payload(&proof, &public_witness)?;

        let verifier_program = ctx.accounts.verifier_program.to_account_info();
        require_keys_eq!(
            verifier_program.key(),
            verifier_program_id,
            VerifierError::VerifierProgramMismatch
        );
        require!(
            verifier_program.executable,
            VerifierError::VerifierProgramNotExecutable
        );

        let mut verifier_data = Vec::with_capacity(proof.len() + public_witness.len());
        verifier_data.extend_from_slice(&proof);
        verifier_data.extend_from_slice(&public_witness);

        invoke(
            &Instruction {
                program_id: verifier_program_id,
                accounts: Vec::new(),
                data: verifier_data,
            },
            &[verifier_program],
        )?;

        set_return_data(&[1]);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct VerifyProof<'info> {
    /// CHECK: The instruction checks that this is the requested executable verifier program.
    pub verifier_program: UncheckedAccount<'info>,
}

fn validate_payload(proof: &[u8], public_witness: &[u8]) -> Result<()> {
    require!(
        !proof.is_empty() && !public_witness.is_empty(),
        VerifierError::EmptyProofPayload
    );
    require!(
        proof.len() + public_witness.len() <= MAX_VERIFIER_PAYLOAD_LEN,
        VerifierError::ProofPayloadTooLarge
    );
    Ok(())
}

#[error_code]
pub enum VerifierError {
    #[msg("Proof and public witness must both be non-empty")]
    EmptyProofPayload,
    #[msg("Combined verifier payload exceeds the supported size")]
    ProofPayloadTooLarge,
    #[msg("Verifier program account does not match the requested program ID")]
    VerifierProgramMismatch,
    #[msg("Verifier program account is not executable")]
    VerifierProgramNotExecutable,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_current_sunspot_payload_size() {
        let proof = vec![1; 388];
        let public_witness = vec![2; 76];

        assert!(validate_payload(&proof, &public_witness).is_ok());
    }

    #[test]
    fn rejects_empty_proof_or_public_witness() {
        assert!(validate_payload(&[], &[1]).is_err());
        assert!(validate_payload(&[1], &[]).is_err());
    }

    #[test]
    fn rejects_payloads_that_exceed_the_transaction_safe_limit() {
        let proof = vec![1; MAX_VERIFIER_PAYLOAD_LEN];
        let public_witness = vec![2];

        assert!(validate_payload(&proof, &public_witness).is_err());
    }
}
