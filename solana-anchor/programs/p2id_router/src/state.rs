use anchor_lang::prelude::*;

pub const SCHEME_VERSION: &[u8] = b"pvium.vault.v1";
pub const FACTORY_SEED: &[u8] = b"p2id.factory.v1";
pub const VAULT_SEED: &[u8] = b"p2id.vault.v1";
pub const DEPOSIT_SEED: &[u8] = b"p2id.deposit.v1";
/// Per-(vault, mint) bookkeeping: how much of the vault's token balance belongs to recorded deposits.
pub const VAULT_MINT_SEED: &[u8] = b"p2id.vault-mint.v1";
/// Per-(factory, verifier program) state: the Solana counterpart of PviumVerifier + PviumIdentity.
pub const VERIFIER_SEED: &[u8] = b"p2id.verifier.v1";
/// The one PDA of an implementation program that may call the router's gated instructions;
/// derived under the implementation's program id with no further seeds.
pub const IMPL_AUTHORITY_SEED: &[u8] = b"p2id.impl-authority.v1";

pub const IDENTITY_PREFIX: &[u8] = b"p2id.identity.v1";
/// Domain prefix of the factory parameter commitment that is part of the factory PDA.
pub const FACTORY_PARAMS_PREFIX: &[u8] = b"p2id.factory.params.v1";
/// Domain prefix of the message a constraint signer signs (ed25519) for a constrained deposit:
/// CONSTRAINT_PREFIX || factory || commitment. The factory key stops replay across factories/clusters.
pub const CONSTRAINT_PREFIX: &[u8] = b"p2id.constraint.sol.v1";
/// Domain prefix of the message the factory's alpha attester signs (ed25519) to approve one payout
/// while the deposit's verifier is in alpha: ALPHA_PREFIX || deadline_le_i64 || sha256(fields), where
/// fields = factory || vault || verifier || destination || iat_le_i64 || action || subject || epoch_le_u64.
/// `subject` is the deposit for a settlement, the mint (zero for SOL) for an untracked sweep, the
/// target program for an implementation move, zero for a bare owner update.
pub const ALPHA_PREFIX: &[u8] = b"p2id.alpha.sol.v1";
pub const ALPHA_MESSAGE_LEN: usize = 17 + 8 + 32;
pub const ALPHA_ACTION_OWNER_UPDATE: u8 = 1;
pub const ALPHA_ACTION_SETTLE: u8 = 2;
pub const ALPHA_ACTION_SWEEP_UNTRACKED: u8 = 3;
pub const ALPHA_ACTION_SET_IMPLEMENTATION: u8 = 4;
pub const IDENTITY_TYPE_WALLET: u8 = 12;

/// Sysvar1nstructions: read at settlement to find a constraint signer's Ed25519 instruction.
pub const INSTRUCTIONS_SYSVAR_ID: Pubkey = Pubkey::from_str_const("Sysvar1nstructions1111111111111111111111111");
/// Ed25519SigVerify: the native program whose successful instruction attests an ed25519 signature.
pub const ED25519_PROGRAM_ID: Pubkey = Pubkey::from_str_const("Ed25519SigVerify111111111111111111111111111");

/// Fee ceiling every quote is clamped to (1%), as PviumP2IdVaultFactory.MAX_FEE_BPS.
pub const MAX_FEE_BPS: u16 = 100;
/// Accepted Privy token-signing keys (P-256, x || y). Privy publishes two at a time; room for rotation.
pub const MAX_SIGNER_KEYS: usize = 8;
pub use p2id_verifier_interface::SIGNER_KEY_LEN;
/// Notice a signer-key addition gives before it can be activated (EVM PviumIdentity.SIGNER_KEY_DELAY).
pub const SIGNER_KEY_DELAY: i64 = 7 * 24 * 60 * 60;
/// ed25519 keys whose signature satisfies a deposit constraint (EVM PviumVerifier constraint signers).
pub const MAX_CONSTRAINT_SIGNERS: usize = 8;
/// Implementation programs a factory can have registered at once.
pub const MAX_IMPLEMENTATIONS: usize = 16;
pub const FUTURE_SLACK: i64 = 15 * 60;
/// Notice every factory-level change (verifier, policy, implementation) gives before activation.
pub const DEFAULT_VERIFIER_DELAY: i64 = 14 * 24 * 60 * 60;
pub const SCHEME_VERSION_LEN: usize = 16;
/// Bytes kept free in every account so a later implementation can add fields without reallocating.
pub const RESERVED_LEN: usize = 128;
/// Layout version written into every account.
pub const ACCOUNT_VERSION: u8 = 1;

pub fn scheme_version_bytes() -> [u8; SCHEME_VERSION_LEN] {
    let mut out = [0u8; SCHEME_VERSION_LEN];
    out[..SCHEME_VERSION.len()].copy_from_slice(SCHEME_VERSION);
    out
}

/// What an implementation asks the router to record after verifying an identity proof: the wallet
/// the proof names and the token's issue time.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct OwnerUpdate {
    pub owner: Pubkey,
    pub iat: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Factory {
    pub version: u8,
    /// Administers verifiers, policy, signer keys, constraint signers and implementations.
    /// Transferred in two steps.
    pub authority: Pubkey,
    /// The authority this factory was created for: a seed of this PDA
    /// (`[FACTORY_SEED, SCHEME_VERSION, seed_authority, params_hash]`); never changes.
    pub seed_authority: Pubkey,
    /// sha256 commitment to every other initialize_factory argument; also a seed of this PDA, so the
    /// only factory anyone can create at this address is the one with exactly these values.
    pub params_hash: [u8; 32],
    pub pending_authority: Option<Pubkey>,
    pub scheme_version: [u8; SCHEME_VERSION_LEN],
    pub ns_hash: [u8; 32],
    pub default_verifier: Pubkey,
    pub proposed_verifier: Pubkey,
    pub proposed_verifier_eta: i64,
    /// The fee policy: a `PolicyConfig` account of the p2id_policy program (or a successor with the
    /// same instruction interface), which quotes the rate at funding and books fees at settlement.
    /// Changed through propose_policy / activate_policy after `policy_change_delay`, so a new rate,
    /// being a new policy address, always carries public notice (EVM: proposePolicy → activatePolicy).
    pub policy: Pubkey,
    pub proposed_policy: Pubkey,
    pub proposed_policy_eta: i64,
    pub policy_change_delay: i64,
    pub verifier_change_delay: i64,
    pub min_refund_window: i64,
    pub max_refund_window: i64,
    /// Implementation program new vaults start on (EVM defaultImplementation).
    pub default_implementation: Pubkey,
    /// Implementation programs a vault owner may move their vault to (EVM isRegistered). Only the
    /// factory authority adds to this list, after `implementation_change_delay` notice; nothing
    /// removes from it, so a vault never loses the implementation its owner chose.
    #[max_len(MAX_IMPLEMENTATIONS)]
    pub implementations: Vec<Pubkey>,
    pub proposed_implementation: Pubkey,
    pub proposed_implementation_eta: i64,
    pub proposed_implementation_make_default: bool,
    pub implementation_change_delay: i64,
    /// ed25519 key whose signature approves payouts under a verifier that is in alpha (EVM
    /// defaultAttester): the backend, which knows which wallet each identity authenticated with and
    /// so can refuse what a flawed circuit would let through. It can withhold, never move funds.
    pub alpha_attester: Pubkey,
    /// Signed into every alpha approval; bumped when the attester or any verifier's alpha mode
    /// changes, so approvals already handed out stop working (EVM alphaEpoch).
    pub alpha_epoch: u64,
    pub bump: u8,
    pub _reserved: [u8; RESERVED_LEN],
}

/// What the EVM stack keeps in PviumVerifier and PviumIdentity, per verifier program: whether the
/// factory accepts it, which circuit it verifies, the Privy keys a token must be signed by, and the
/// constraint signers. The Sunspot verifier program itself is stateless. Created by propose_verifier
/// (or initialize_factory for the first), administered by the factory authority. Deposits pin a
/// verifier, so a settlement is checked against the deposit's config.
#[account]
#[derive(InitSpace)]
pub struct VerifierConfig {
    pub version: u8,
    pub factory: Pubkey,
    pub verifier: Pubkey,
    /// False until activated, and again after revoke_verifier. Deposits pinned to a verifier that is
    /// no longer allowed can only be refunded.
    pub allowed: bool,
    pub circuit_version: u16,
    pub vk_hash: [u8; 32],
    /// P-256 keys (x || y) a proof's token must have been signed by; public inputs 2-5 of the
    /// circuit name the key and the ZK proof binds the token signature to it. Additions wait
    /// SIGNER_KEY_DELAY, removals are immediate (EVM PviumIdentity).
    #[max_len(MAX_SIGNER_KEYS)]
    pub signer_keys: Vec<[u8; SIGNER_KEY_LEN]>,
    pub proposed_signer_key: [u8; SIGNER_KEY_LEN],
    pub proposed_signer_key_eta: i64,
    /// Incremented by remove_signer_key and when a released verifier re-enters alpha; owner caches
    /// built under an older revision are stale (EVM ownerRevision + alphaRevision).
    pub key_set_revision: u64,
    /// While true, every payout under this verifier needs the factory's alpha attester to have
    /// approved it earlier in the transaction (EVM isAlpha(vkHash): a new verifier is in alpha until
    /// the authority releases it with set_alpha(false)).
    pub alpha: bool,
    /// ed25519 keys whose signature over CONSTRAINT_PREFIX || factory || commitment releases a
    /// constrained deposit funded under this verifier. Managed immediately (EVM setConstraintSigner).
    #[max_len(MAX_CONSTRAINT_SIGNERS)]
    pub constraint_signers: Vec<Pubkey>,
    pub bump: u8,
    pub _reserved: [u8; 64],
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub version: u8,
    pub factory: Pubkey,
    pub identity_hash: [u8; 32],
    pub ns_hash: [u8; 32],
    /// Wallet of the newest accepted proof; receives proofless settlements while the cache is current.
    pub owner: Pubkey,
    pub latest_proof_iat: i64,
    pub owner_revision: u64,
    /// Verifier the cached owner was proven under; a deposit is paid only if it pins this verifier.
    pub owner_verifier: Pubkey,
    /// verifier_config.key_set_revision when the owner was cached; a signer-key removal invalidates the cache.
    pub owner_key_set_revision: u64,
    pub deposit_seq: u64,
    /// Lamports held for unconsumed SOL deposits; anything above rent + this is untracked.
    pub tracked_sol: u64,
    /// The implementation program whose authority PDA may fund and settle this vault (EVM: the
    /// implementation a vault proxy points at). Set from factory.default_implementation at deploy;
    /// only the cached owner moves it, and only to a registered implementation.
    pub implementation: Pubkey,
    pub bump: u8,
    pub _reserved: [u8; RESERVED_LEN],
}

/// Token balance of `vault`'s ATA for `mint` that belongs to unconsumed deposits.
#[account]
#[derive(InitSpace)]
pub struct VaultMint {
    pub version: u8,
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub tracked: u64,
    pub bump: u8,
    pub _reserved: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct Deposit {
    pub version: u8,
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
    pub reference: [u8; 32],
    pub bump: u8,
    pub _reserved: [u8; 32],
}

impl Deposit {
    pub fn is_sol(&self) -> bool {
        self.mint == Pubkey::default()
    }
}
