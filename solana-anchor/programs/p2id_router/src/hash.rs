use anchor_lang::prelude::*;
use sha2::{Digest, Sha256};

use crate::state::{FACTORY_PARAMS_PREFIX, IDENTITY_PREFIX, IDENTITY_TYPE_WALLET, SIGNER_KEY_LEN};

pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

/// Commitment to the factory parameters other than the authority:
/// sha256("p2id.factory.params.v1" || n_keys_u8 || signer_key_1 || … || default_verifier || policy
///        || default_implementation || alpha_attester || circuit_version_be || vk_hash
///        || min_refund_window_be || max_refund_window_be)
#[allow(clippy::too_many_arguments)]
pub fn factory_params_hash(
    signer_keys: &[[u8; SIGNER_KEY_LEN]],
    default_verifier: &Pubkey,
    policy: &Pubkey,
    default_implementation: &Pubkey,
    alpha_attester: &Pubkey,
    circuit_version: u16,
    vk_hash: &[u8; 32],
    min_refund_window: i64,
    max_refund_window: i64,
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(FACTORY_PARAMS_PREFIX);
    hasher.update([signer_keys.len() as u8]);
    for key in signer_keys {
        hasher.update(key);
    }
    for part in [
        default_verifier.as_ref(),
        policy.as_ref(),
        default_implementation.as_ref(),
        alpha_attester.as_ref(),
        &circuit_version.to_be_bytes(),
        vk_hash,
        &min_refund_window.to_be_bytes(),
        &max_refund_window.to_be_bytes(),
    ] {
        hasher.update(part);
    }
    hasher.finalize().into()
}

/// sha256("p2id.identity.v1" || type || normalized value), as the EVM/TS side computes it.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wallet_hash_matches_evm_normalization() {
        let lower = identity_hash(IDENTITY_TYPE_WALLET, b"0xabcd");
        let upper = identity_hash(IDENTITY_TYPE_WALLET, b"0xABCD");
        assert_eq!(lower, upper);

        let base58 = identity_hash(IDENTITY_TYPE_WALLET, b"AbCd");
        let lower_base58 = identity_hash(IDENTITY_TYPE_WALLET, b"abcd");
        assert_ne!(base58, lower_base58);
    }

    #[test]
    fn params_hash_commits_to_the_implementation() {
        let keys = [[1u8; SIGNER_KEY_LEN]];
        let a = factory_params_hash(&keys, &Pubkey::new_unique(), &Pubkey::default(), &Pubkey::new_from_array([1; 32]), &Pubkey::default(), 1, &[0; 32], 1, 2);
        let b = factory_params_hash(&keys, &Pubkey::new_unique(), &Pubkey::default(), &Pubkey::new_from_array([2; 32]), &Pubkey::default(), 1, &[0; 32], 1, 2);
        assert_ne!(a, b);
        let c = factory_params_hash(&keys, &Pubkey::new_unique(), &Pubkey::default(), &Pubkey::new_from_array([1; 32]), &Pubkey::new_from_array([3; 32]), 1, &[0; 32], 1, 2);
        assert_ne!(a, c);
    }
}
