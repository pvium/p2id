//! The P2ID verifier interface: what an implementation asks of the verifier program a deposit pins,
//! and what it gets back. It is the Solana form of the EVM pair `IVerifier.verify(proof, inputs)` /
//! `PviumVerifier.getIdentityWallet(proof)`: the implementation hands over the proof as opaque bytes
//! and receives an [`Attestation`]; the verifier alone knows the proof system and the witness layout.
//!
//! A verifier program implements one instruction,
//!
//! ```text
//! verify(proof: Vec<u8>) -> Attestation
//! ```
//!
//! with the Anchor discriminator `sha256("global:verify")[..8]` ([`VERIFY_DISCRIMINATOR`]) and
//! Borsh-encoded argument and return value. Its accounts are its own business: the implementation
//! passes through, in order, the accounts the caller appended for it. The instruction fails unless
//! `proof` is genuine and returns the attestation as return data; it never pays, signs or writes.
//!
//! The implementation decides what an attestation means: whose vault it opens, whether its signer
//! key is one the factory accepts, how fresh it must be, which wallet it names. The verifier decides
//! only whether the proof is genuine. Both the verifier and whatever program it delegates to must be
//! immutable, see [`program_status`].
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{get_return_data, invoke};

pub mod loader;
pub use loader::{program_data_address, program_status, ProgramStatus};

/// `sha256("global:verify")[..8]`: the Anchor discriminator of the `verify` instruction.
pub const VERIFY_DISCRIMINATOR: [u8; 8] = [133, 161, 141, 48, 120, 198, 88, 150];
/// Largest proof an implementation forwards: what fits in a transaction beside a claim's accounts.
pub const MAX_PROOF_LEN: usize = 900;
/// A P-256 public key, x || y, as the circuit exposes it.
pub const SIGNER_KEY_LEN: usize = 64;

/// What a genuine proof attests. Every hash is `sha256("p2id.identity.v1" || type || value)` as the
/// circuit computes it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Attestation {
    /// The P-256 key that signed the identity token the proof was made from.
    pub signer_key: [u8; SIGNER_KEY_LEN],
    /// Hash of the identity the token names: the vault it opens.
    pub identity_hash: [u8; 32],
    /// Hash of the wallet the token names (type 12, the base58 address): where the owner is paid.
    pub wallet_hash: [u8; 32],
    /// Issue time of the token, Unix seconds.
    pub iat: i64,
}

impl Attestation {
    pub const LEN: usize = SIGNER_KEY_LEN + 32 + 32 + 8;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyError {
    EmptyProof,
    ProofTooLarge,
    VerifierNotExecutable,
    /// The verifier failed: the proof is not genuine, or its accounts were wrong.
    Rejected,
    /// The verifier succeeded without returning a well-formed attestation: not a verifier.
    NoAttestation,
}

/// Call `verify` on `verifier` with `proof`, passing `accounts` through, and read the attestation
/// back. Accounts are passed read-only and unsigned; a verifier never needs more.
pub fn verify<'info>(
    verifier: &AccountInfo<'info>,
    accounts: &[AccountInfo<'info>],
    proof: &[u8],
) -> std::result::Result<Attestation, VerifyError> {
    if proof.is_empty() {
        return Err(VerifyError::EmptyProof);
    }
    if proof.len() > MAX_PROOF_LEN {
        return Err(VerifyError::ProofTooLarge);
    }
    if !verifier.executable {
        return Err(VerifyError::VerifierNotExecutable);
    }
    let mut data = Vec::with_capacity(VERIFY_DISCRIMINATOR.len() + 4 + proof.len());
    data.extend_from_slice(&VERIFY_DISCRIMINATOR);
    data.extend_from_slice(&(proof.len() as u32).to_le_bytes());
    data.extend_from_slice(proof);
    let metas = accounts
        .iter()
        .map(|a| AccountMeta::new_readonly(*a.key, false))
        .collect();
    let mut infos = Vec::with_capacity(accounts.len() + 1);
    infos.push(verifier.clone());
    infos.extend(accounts.iter().cloned());
    invoke(
        &Instruction { program_id: *verifier.key, accounts: metas, data },
        &infos,
    )
    .map_err(|_| VerifyError::Rejected)?;
    let (program, bytes) = get_return_data().ok_or(VerifyError::NoAttestation)?;
    if program != *verifier.key || bytes.len() != Attestation::LEN {
        return Err(VerifyError::NoAttestation);
    }
    Attestation::try_from_slice(&bytes).map_err(|_| VerifyError::NoAttestation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discriminator_is_anchors() {
        let digest = {
            use sha2::{Digest, Sha256};
            Sha256::digest(b"global:verify")
        };
        assert_eq!(&digest[..8], &VERIFY_DISCRIMINATOR);
    }

    #[test]
    fn attestation_has_a_fixed_length() {
        let a = Attestation { signer_key: [1; 64], identity_hash: [2; 32], wallet_hash: [3; 32], iat: 4 };
        let mut bytes = Vec::new();
        a.serialize(&mut bytes).unwrap();
        assert_eq!(bytes.len(), Attestation::LEN);
        assert_eq!(Attestation::try_from_slice(&bytes).unwrap(), a);
    }
}
