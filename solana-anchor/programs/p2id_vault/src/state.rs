use anchor_lang::prelude::*;

pub const SCHEME_VERSION: &[u8] = b"pvium.vault.v1";
pub const FACTORY_SEED: &[u8] = b"p2id-factory";
pub const VAULT_SEED: &[u8] = b"p2id-vault";
pub const DEPOSIT_SEED: &[u8] = b"p2id-deposit";

pub const IDENTITY_PREFIX: &[u8] = b"p2id.identity.v1";
pub const IDENTITY_TYPE_WALLET: u8 = 12;

pub const PUBLIC_INPUT_COUNT: usize = 11;
pub const PUBLIC_INPUT_IAT: usize = 6;
pub const PUBLIC_INPUT_IDENTITY_HASH_HI: usize = 7;
pub const PUBLIC_INPUT_IDENTITY_HASH_LO: usize = 8;
pub const PUBLIC_INPUT_WALLET_HASH_HI: usize = 9;
pub const PUBLIC_INPUT_WALLET_HASH_LO: usize = 10;
pub const PW_HEADER_LEN: usize = 12;
pub const FIELD_LEN: usize = 32;
pub const PW_LEN: usize = PW_HEADER_LEN + PUBLIC_INPUT_COUNT * FIELD_LEN;

pub const MAX_VERIFIER_PAYLOAD_LEN: usize = 900;
pub const MAX_FEE_BPS: u16 = 100;
pub const MAX_ALLOWED_VERIFIERS: usize = 32;
pub const FUTURE_SLACK: i64 = 15 * 60;
pub const DEFAULT_VERIFIER_DELAY: i64 = 14 * 24 * 60 * 60;
pub const SCHEME_VERSION_LEN: usize = 16;

pub fn scheme_version_bytes() -> [u8; SCHEME_VERSION_LEN] {
    let mut out = [0u8; SCHEME_VERSION_LEN];
    out[..SCHEME_VERSION.len()].copy_from_slice(SCHEME_VERSION);
    out
}

#[account]
#[derive(InitSpace)]
pub struct Factory {
    pub authority: Pubkey,
    pub pending_authority: Option<Pubkey>,
    pub scheme_version: [u8; SCHEME_VERSION_LEN],
    pub ns_hash: [u8; 32],
    pub default_verifier: Pubkey,
    pub proposed_verifier: Pubkey,
    pub proposed_verifier_eta: i64,
    pub policy: Pubkey,
    pub fee_bps: u16,
    pub verifier_change_delay: i64,
    pub min_refund_window: i64,
    pub max_refund_window: i64,
    pub circuit_version: u16,
    pub vk_hash: [u8; 32],
    #[max_len(MAX_ALLOWED_VERIFIERS)]
    pub allowed_verifiers: Vec<Pubkey>,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub factory: Pubkey,
    pub identity_hash: [u8; 32],
    pub ns_hash: [u8; 32],
    pub owner: Pubkey,
    pub latest_proof_iat: i64,
    pub owner_revision: u64,
    pub deposit_seq: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Deposit {
    pub vault: Pubkey,
    pub id: u64,
    pub funder: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub verifier: Pubkey,
    pub fee_bps: u16,
    pub constraint: [u8; 32],
    pub refund_window: i64,
    pub funded_at: i64,
    pub consumed: bool,
    pub refunder: Option<Pubkey>,
    pub bump: u8,
}

impl Deposit {
    pub fn is_sol(&self) -> bool {
        self.mint == Pubkey::default()
    }
}
