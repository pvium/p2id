//! P-256 point validation for Privy token-signing keys. A key the factory accepts is a public input
//! of the circuit; a 64-byte blob that is not a curve point can never match a real token signature,
//! so accepting one (a typo, a swapped x/y) is a dead key that only shows up after the 7-day notice.
use p256::elliptic_curve::sec1::FromEncodedPoint;
use p256::{AffinePoint, EncodedPoint};

use crate::state::SIGNER_KEY_LEN;

/// True if `key` (x || y, big-endian) is an affine point on P-256.
pub fn is_on_p256(key: &[u8; SIGNER_KEY_LEN]) -> bool {
    let mut sec1 = [0u8; 65];
    sec1[0] = 4; // uncompressed
    sec1[1..].copy_from_slice(key);
    let Ok(encoded) = EncodedPoint::from_bytes(sec1) else {
        return false;
    };
    bool::from(AffinePoint::from_encoded_point(&encoded).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn from_hex(hex: &str) -> Vec<u8> {
        (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn accepts_the_generator_and_rejects_garbage() {
        let mut g = [0u8; 64];
        g[..32].copy_from_slice(&from_hex("6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"));
        g[32..].copy_from_slice(&from_hex("4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5"));
        assert!(is_on_p256(&g));

        assert!(!is_on_p256(&[9u8; 64]));
        assert!(!is_on_p256(&[0u8; 64]));
        let mut swapped = [0u8; 64];
        swapped[..32].copy_from_slice(&g[32..]);
        swapped[32..].copy_from_slice(&g[..32]);
        assert!(!is_on_p256(&swapped));
    }
}
