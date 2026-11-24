//! The public witness as Sunspot serializes it for the P2ID circuit (gnark): a 12-byte header (the
//! input count as u32 and u64, big-endian) and 11 big-endian 32-byte field elements. Hashes and key
//! coordinates arrive split into 128-bit halves because they do not fit a BN254 field element.
use anchor_lang::prelude::*;
use p2id_verifier_interface::{Attestation, SIGNER_KEY_LEN};

use crate::VerifierError;

pub const PUBLIC_INPUT_COUNT: usize = 11;
pub const PUBLIC_INPUT_SIGNER_X_HI: usize = 2;
pub const PUBLIC_INPUT_SIGNER_X_LO: usize = 3;
pub const PUBLIC_INPUT_SIGNER_Y_HI: usize = 4;
pub const PUBLIC_INPUT_SIGNER_Y_LO: usize = 5;
pub const PUBLIC_INPUT_IAT: usize = 6;
pub const PUBLIC_INPUT_IDENTITY_HASH_HI: usize = 7;
pub const PUBLIC_INPUT_IDENTITY_HASH_LO: usize = 8;
pub const PUBLIC_INPUT_WALLET_HASH_HI: usize = 9;
pub const PUBLIC_INPUT_WALLET_HASH_LO: usize = 10;
pub const PW_HEADER_LEN: usize = 12;
pub const FIELD_LEN: usize = 32;
pub const PW_LEN: usize = PW_HEADER_LEN + PUBLIC_INPUT_COUNT * FIELD_LEN;

fn field(bytes: &[u8], index: usize) -> Result<[u8; FIELD_LEN]> {
    let start = PW_HEADER_LEN + index * FIELD_LEN;
    let slice = bytes.get(start..start + FIELD_LEN).ok_or(VerifierError::InvalidPublicWitness)?;
    Ok(slice.try_into().map_err(|_| VerifierError::InvalidPublicWitness)?)
}

fn from_halves(hi: [u8; FIELD_LEN], lo: [u8; FIELD_LEN]) -> Result<[u8; 32]> {
    require!(
        hi[..16].iter().all(|b| *b == 0) && lo[..16].iter().all(|b| *b == 0),
        VerifierError::InvalidPublicWitness
    );
    let mut out = [0u8; 32];
    out[..16].copy_from_slice(&hi[16..]);
    out[16..].copy_from_slice(&lo[16..]);
    Ok(out)
}

/// Read the attestation out of a public witness. Only the layout is checked here; whether the
/// proof actually proves these values is the proof system's job.
pub fn parse_public_witness(bytes: &[u8]) -> Result<Attestation> {
    require!(bytes.len() == PW_LEN, VerifierError::InvalidPublicWitness);
    let count = u32::from_be_bytes(bytes[0..4].try_into().unwrap());
    let wide_count = u64::from_be_bytes(bytes[4..12].try_into().unwrap());
    require!(
        count == PUBLIC_INPUT_COUNT as u32 && wide_count == PUBLIC_INPUT_COUNT as u64,
        VerifierError::InvalidPublicWitness
    );

    let iat_field = field(bytes, PUBLIC_INPUT_IAT)?;
    require!(iat_field[..24].iter().all(|b| *b == 0), VerifierError::InvalidPublicWitness);
    let iat = u64::from_be_bytes(iat_field[24..32].try_into().unwrap());
    require!(iat > 0 && iat <= i64::MAX as u64, VerifierError::InvalidPublicWitness);

    let signer_x = from_halves(field(bytes, PUBLIC_INPUT_SIGNER_X_HI)?, field(bytes, PUBLIC_INPUT_SIGNER_X_LO)?)?;
    let signer_y = from_halves(field(bytes, PUBLIC_INPUT_SIGNER_Y_HI)?, field(bytes, PUBLIC_INPUT_SIGNER_Y_LO)?)?;
    let mut signer_key = [0u8; SIGNER_KEY_LEN];
    signer_key[..32].copy_from_slice(&signer_x);
    signer_key[32..].copy_from_slice(&signer_y);

    Ok(Attestation {
        signer_key,
        identity_hash: from_halves(
            field(bytes, PUBLIC_INPUT_IDENTITY_HASH_HI)?,
            field(bytes, PUBLIC_INPUT_IDENTITY_HASH_LO)?,
        )?,
        wallet_hash: from_halves(
            field(bytes, PUBLIC_INPUT_WALLET_HASH_HI)?,
            field(bytes, PUBLIC_INPUT_WALLET_HASH_LO)?,
        )?,
        iat: iat as i64,
    })
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
        values[2] = 0xaaaa;
        values[3] = 0xbbbb;
        values[4] = 0xcccc;
        values[5] = 0xdddd;
        let parsed = parse_public_witness(&witness(&values)).unwrap();
        assert_eq!(parsed.iat, 1_700_000_000);
        assert_eq!(&parsed.signer_key[14..16], &[0xaa, 0xaa]);
        assert_eq!(&parsed.signer_key[30..32], &[0xbb, 0xbb]);
        assert_eq!(&parsed.signer_key[46..48], &[0xcc, 0xcc]);
        assert_eq!(&parsed.signer_key[62..64], &[0xdd, 0xdd]);
        assert_eq!(&parsed.identity_hash[..16], &hi.to_be_bytes());
        assert_eq!(&parsed.identity_hash[16..], &lo.to_be_bytes());
    }

    #[test]
    fn rejects_wrong_header_hash_halves_and_iat() {
        let mut bytes = witness(&[1; PUBLIC_INPUT_COUNT]);
        bytes[3] = 2;
        assert!(parse_public_witness(&bytes).is_err());

        let mut bytes = witness(&[1; PUBLIC_INPUT_COUNT]);
        bytes[PW_HEADER_LEN + 7 * FIELD_LEN] = 1;
        assert!(parse_public_witness(&bytes).is_err());

        let mut values = [1u128; PUBLIC_INPUT_COUNT];
        values[6] = 0;
        assert!(parse_public_witness(&witness(&values)).is_err());
        values[6] = 1u128 << 70;
        assert!(parse_public_witness(&witness(&values)).is_err());

        assert!(parse_public_witness(&witness(&[1; PUBLIC_INPUT_COUNT])[..PW_LEN - 1]).is_err());
    }
}
