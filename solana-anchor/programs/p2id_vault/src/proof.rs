use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke;
use sha2::{Digest, Sha256};

use crate::errors::VaultError;
use crate::state::{
    FIELD_LEN, IDENTITY_PREFIX, IDENTITY_TYPE_WALLET, PW_HEADER_LEN, PW_LEN, PUBLIC_INPUT_COUNT,
    PUBLIC_INPUT_IAT, PUBLIC_INPUT_IDENTITY_HASH_HI, PUBLIC_INPUT_IDENTITY_HASH_LO,
    PUBLIC_INPUT_WALLET_HASH_HI, PUBLIC_INPUT_WALLET_HASH_LO, MAX_VERIFIER_PAYLOAD_LEN,
};

#[derive(Debug, Clone, Copy)]
pub struct PublicInputs {
    pub identity_type: [u8; 32],
    pub wallet: [u8; 32],
    pub identity_hash: [u8; 32],
    pub wallet_hash: [u8; 32],
    pub iat: i64,
}

fn field(bytes: &[u8], index: usize) -> Result<[u8; FIELD_LEN]> {
    let start = PW_HEADER_LEN + index * FIELD_LEN;
    let slice = bytes
        .get(start..start + FIELD_LEN)
        .ok_or(VaultError::InvalidPublicWitness)?;
    Ok(slice.try_into().map_err(|_| VaultError::InvalidPublicWitness)?)
}

fn hash_from_halves(hi: [u8; FIELD_LEN], lo: [u8; FIELD_LEN]) -> Result<[u8; 32]> {
    require!(
        hi[..16].iter().all(|b| *b == 0) && lo[..16].iter().all(|b| *b == 0),
        VaultError::InvalidPublicWitness
    );
    let mut out = [0u8; 32];
    out[..16].copy_from_slice(&hi[16..]);
    out[16..].copy_from_slice(&lo[16..]);
    Ok(out)
}

pub fn parse_public_witness(bytes: &[u8]) -> Result<PublicInputs> {
    require!(bytes.len() == PW_LEN, VaultError::InvalidPublicWitness);

    let count = u32::from_be_bytes(
        bytes[0..4]
            .try_into()
            .map_err(|_| VaultError::InvalidPublicWitness)?,
    );
    let wide_count = u64::from_be_bytes(
        bytes[4..12]
            .try_into()
            .map_err(|_| VaultError::InvalidPublicWitness)?,
    );
    require!(
        count == PUBLIC_INPUT_COUNT as u32 && wide_count == PUBLIC_INPUT_COUNT as u64,
        VaultError::InvalidPublicWitness
    );

    let iat_field = field(bytes, PUBLIC_INPUT_IAT)?;
    let iat = u64::from_be_bytes(
        iat_field[24..32]
            .try_into()
            .map_err(|_| VaultError::InvalidPublicWitness)?,
    ) as i64;
    require!(iat > 0, VaultError::InvalidPublicWitness);

    Ok(PublicInputs {
        identity_type: field(bytes, 0)?,
        wallet: field(bytes, 1)?,
        identity_hash: hash_from_halves(
            field(bytes, PUBLIC_INPUT_IDENTITY_HASH_HI)?,
            field(bytes, PUBLIC_INPUT_IDENTITY_HASH_LO)?,
        )?,
        wallet_hash: hash_from_halves(
            field(bytes, PUBLIC_INPUT_WALLET_HASH_HI)?,
            field(bytes, PUBLIC_INPUT_WALLET_HASH_LO)?,
        )?,
        iat,
    })
}

pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

pub fn identity_hash(identity_type: u8, value: &[u8]) -> [u8; 32] {
    sha256(&[IDENTITY_PREFIX, &[identity_type], &normalize(identity_type, value)])
}

fn normalize(identity_type: u8, value: &[u8]) -> Vec<u8> {
    let lowercase = identity_type == IDENTITY_TYPE_WALLET
        && value.len() >= 2
        && value[0] == b'0'
        && value[1] == b'x';
    if !lowercase {
        return value.to_vec();
    }
    value
        .iter()
        .map(|c| if c.is_ascii_uppercase() { c.to_ascii_lowercase() } else { *c })
        .collect()
}

pub fn verify_proof(verifier: &AccountInfo, proof: &[u8], public_witness: &[u8]) -> Result<()> {
    require!(!proof.is_empty(), VaultError::EmptyProof);
    require!(
        proof.len() + public_witness.len() <= MAX_VERIFIER_PAYLOAD_LEN,
        VaultError::PayloadTooLarge
    );
    require!(verifier.executable, VaultError::VerifierNotExecutable);

    let mut data = Vec::with_capacity(proof.len() + public_witness.len());
    data.extend_from_slice(proof);
    data.extend_from_slice(public_witness);

    invoke(
        &Instruction {
            program_id: verifier.key(),
            accounts: Vec::new(),
            data,
        },
        &[verifier.clone()],
    )
    .map_err(|_| VaultError::ProofVerificationFailed)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn witness(values: &[u128; PUBLIC_INPUT_COUNT]) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(PW_LEN);
        bytes.extend_from_slice(&(PUBLIC_INPUT_COUNT as u32).to_be_bytes());
        bytes.extend_from_slice(&(PUBLIC_INPUT_COUNT as u64).to_be_bytes());
        for value in values {
            let mut field = [0u8; FIELD_LEN];
            field[16..].copy_from_slice(&value.to_be_bytes());
            bytes.extend_from_slice(&field);
        }
        bytes
    }

    #[test]
    fn parses_generated_witness_layout() {
        let mut values = [0u128; PUBLIC_INPUT_COUNT];
        values[6] = 1_700_000_000;
        let hi = 0x1111_2222_3333_4444_5555_6666_7777_8888u128;
        let lo = 0x9999_aaaa_bbbb_cccc_dddd_eeee_ffff_0000u128;
        values[7] = hi;
        values[8] = lo;
        let parsed = parse_public_witness(&witness(&values)).unwrap();
        assert_eq!(parsed.iat, 1_700_000_000);
        assert_eq!(&parsed.identity_hash[..16], &hi.to_be_bytes());
        assert_eq!(&parsed.identity_hash[16..], &lo.to_be_bytes());
    }

    #[test]
    fn rejects_wrong_header_and_hash_halves() {
        let mut bytes = witness(&[1; PUBLIC_INPUT_COUNT]);
        bytes[3] = 2;
        assert!(parse_public_witness(&bytes).is_err());

        let mut bytes = witness(&[1; PUBLIC_INPUT_COUNT]);
        bytes[PW_HEADER_LEN + 7 * FIELD_LEN] = 1;
        assert!(parse_public_witness(&bytes).is_err());
    }

    #[test]
    fn wallet_hash_matches_evm_normalization() {
        let lower = identity_hash(IDENTITY_TYPE_WALLET, b"0xabcd");
        let upper = identity_hash(IDENTITY_TYPE_WALLET, b"0xABCD");
        assert_eq!(lower, upper);

        let base58 = identity_hash(IDENTITY_TYPE_WALLET, b"AbCd");
        let lower_base58 = identity_hash(IDENTITY_TYPE_WALLET, b"abcd");
        assert_ne!(base58, lower_base58);
    }
}
