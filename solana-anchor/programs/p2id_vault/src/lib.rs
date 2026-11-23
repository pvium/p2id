//! P2ID vault implementation v1 (EVM P2IDVaultV2 semantics). The user-facing program: funders call
//! `fund_*`, anyone submits `claim_*` or `refresh_proof` for the owner. It owns no accounts and holds
//! no funds; it verifies identity proofs (Sunspot verifier CPI, accepted signer keys, freshness, the
//! wallet binding) and asks the router to record the result and move the money, signing with its
//! authority PDA. The router enforces the funder protections and applies every state change. A later
//! implementation is a new program the factory registers behind notice; vault owners move to it
//! through the router. Refunds and untracked sweeps are router instructions and never pass through here.
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};
use p2id_router::cpi::{self as router_cpi, accounts as router_accounts};
use p2id_router::hash::identity_hash;
use p2id_router::program::P2idRouter;
use p2id_router::state::*;

pub mod errors;
pub mod proof;

use errors::VaultError;
use proof::{parse_public_witness, verify_proof, PublicInputs};

declare_id!("DaQSQnyAHJLRMdN8m5ENm1Zr9dQKCeRBG8QoxMjEvVzf");

#[program]
pub mod p2id_vault {
    use super::*;

    /// Record a SOL deposit under the verifier whose config is passed (EVM P2IDVaultV2 fund /
    /// fundWith / fundWithRefunder in one: any allowed verifier; `refunder`, when given, is the one
    /// account that may refund after the window and is paid; `reference` is emitted only).
    pub fn fund_sol(
        ctx: Context<FundSol>,
        amount: u64,
        constraint: [u8; 32],
        refund_window: i64,
        refunder: Option<Pubkey>,
        reference: [u8; 32],
    ) -> Result<()> {
        let bump = [ctx.bumps.impl_authority];
        let signer: &[&[u8]] = &[IMPL_AUTHORITY_SEED, &bump];
        let signers = [signer];
        let a = &ctx.accounts;
        let cpi = CpiContext::new_with_signer(
            a.router_program.key(),
            router_accounts::CreateDepositSol {
                factory: a.factory.to_account_info(),
                verifier_config: a.verifier_config.to_account_info(),
                vault: a.vault.to_account_info(),
                deposit: a.deposit.to_account_info(),
                policy: a.policy.to_account_info(),
                policy_program: a.policy_program.to_account_info(),
                funder: a.funder.to_account_info(),
                impl_authority: a.impl_authority.to_account_info(),
                system_program: a.system_program.to_account_info(),
            },
            &signers,
        );
        router_cpi::create_deposit_sol(cpi, amount, constraint, refund_window, refunder, reference)
    }

    /// Record an SPL-token deposit; same terms as fund_sol.
    pub fn fund_token(
        ctx: Context<FundToken>,
        amount: u64,
        constraint: [u8; 32],
        refund_window: i64,
        refunder: Option<Pubkey>,
        reference: [u8; 32],
    ) -> Result<()> {
        let bump = [ctx.bumps.impl_authority];
        let signer: &[&[u8]] = &[IMPL_AUTHORITY_SEED, &bump];
        let signers = [signer];
        let a = &ctx.accounts;
        let cpi = CpiContext::new_with_signer(
            a.router_program.key(),
            router_accounts::CreateDepositToken {
                factory: a.factory.to_account_info(),
                verifier_config: a.verifier_config.to_account_info(),
                vault: a.vault.to_account_info(),
                deposit: a.deposit.to_account_info(),
                vault_mint: a.vault_mint.to_account_info(),
                policy: a.policy.to_account_info(),
                policy_program: a.policy_program.to_account_info(),
                funder: a.funder.to_account_info(),
                impl_authority: a.impl_authority.to_account_info(),
                mint: a.mint.to_account_info(),
                funder_token_account: a.funder_token_account.to_account_info(),
                vault_token_account: a.vault_token_account.to_account_info(),
                token_program: a.token_program.to_account_info(),
                associated_token_program: a.associated_token_program.to_account_info(),
                system_program: a.system_program.to_account_info(),
            },
            &signers,
        );
        router_cpi::create_deposit_token(cpi, amount, constraint, refund_window, refunder, reference)
    }

    /// Verify an identity proof under any allowed verifier and update the owner cache without
    /// paying anything out (EVM refreshProof). `owner` is the wallet the proof names.
    pub fn refresh_proof(ctx: Context<RefreshProof>, proof: Vec<u8>, public_witness: Vec<u8>) -> Result<()> {
        let a = &ctx.accounts;
        require!(a.verifier_config.allowed, VaultError::VerifierNotAllowed);
        require!(a.verifier_config.verifier == a.verifier_program.key(), VaultError::WrongVerifierConfig);
        let inputs = verify_owner_proof(&a.factory, &a.verifier_config, &a.vault, &a.verifier_program, &a.owner.key(), &proof, &public_witness)?;
        let update = owner_update(&a.vault, &inputs, &a.owner.key())?;

        let bump = [ctx.bumps.impl_authority];
        let signer: &[&[u8]] = &[IMPL_AUTHORITY_SEED, &bump];
        let signers = [signer];
        let cpi = CpiContext::new_with_signer(
            a.router_program.key(),
            router_accounts::SetOwnerCache {
                factory: a.factory.to_account_info(),
                vault: a.vault.to_account_info(),
                verifier_config: a.verifier_config.to_account_info(),
                impl_authority: a.impl_authority.to_account_info(),
            },
            &signers,
        );
        router_cpi::set_owner_cache(cpi, update)
    }

    /// Pay SOL deposit `id` to `owner`: the wallet the proof names, or the cached owner when `proof`
    /// and `public_witness` are empty. Anyone may submit it (EVM refreshProofAndSweep / sweep).
    /// A constrained deposit needs an ed25519 instruction by a constraint signer earlier in the
    /// transaction; the router checks it.
    pub fn claim_sol(ctx: Context<ClaimSol>, id: u64, proof: Vec<u8>, public_witness: Vec<u8>) -> Result<()> {
        let a = &ctx.accounts;
        let update = authorize_claim(&a.factory, &a.verifier_config, &a.vault, &a.deposit, &a.verifier_program, &a.owner.key(), id, &proof, &public_witness)?;

        let bump = [ctx.bumps.impl_authority];
        let signer: &[&[u8]] = &[IMPL_AUTHORITY_SEED, &bump];
        let signers = [signer];
        let cpi = CpiContext::new_with_signer(
            a.router_program.key(),
            router_accounts::SettleSol {
                factory: a.factory.to_account_info(),
                verifier_config: a.verifier_config.to_account_info(),
                vault: a.vault.to_account_info(),
                deposit: a.deposit.to_account_info(),
                owner: a.owner.to_account_info(),
                policy: a.policy.to_account_info(),
                policy_program: a.policy_program.to_account_info(),
                instructions: a.instructions.to_account_info(),
                impl_authority: a.impl_authority.to_account_info(),
            },
            &signers,
        );
        router_cpi::settle_sol(cpi, id, update)
    }

    /// Pay SPL-token deposit `id` to `owner`'s associated token account (created if needed, rent
    /// paid by `payer`). Same authorization as claim_sol.
    pub fn claim_token(ctx: Context<ClaimToken>, id: u64, proof: Vec<u8>, public_witness: Vec<u8>) -> Result<()> {
        let a = &ctx.accounts;
        let update = authorize_claim(&a.factory, &a.verifier_config, &a.vault, &a.deposit, &a.verifier_program, &a.owner.key(), id, &proof, &public_witness)?;

        let bump = [ctx.bumps.impl_authority];
        let signer: &[&[u8]] = &[IMPL_AUTHORITY_SEED, &bump];
        let signers = [signer];
        let cpi = CpiContext::new_with_signer(
            a.router_program.key(),
            router_accounts::SettleToken {
                factory: a.factory.to_account_info(),
                verifier_config: a.verifier_config.to_account_info(),
                vault: a.vault.to_account_info(),
                deposit: a.deposit.to_account_info(),
                vault_mint: a.vault_mint.to_account_info(),
                payer: a.payer.to_account_info(),
                owner: a.owner.to_account_info(),
                mint: a.mint.to_account_info(),
                vault_token_account: a.vault_token_account.to_account_info(),
                owner_token_account: a.owner_token_account.to_account_info(),
                policy: a.policy.to_account_info(),
                policy_program: a.policy_program.to_account_info(),
                policy_mint: a.policy_mint.to_account_info(),
                policy_token_account: a.policy_token_account.to_account_info(),
                instructions: a.instructions.to_account_info(),
                impl_authority: a.impl_authority.to_account_info(),
                token_program: a.token_program.to_account_info(),
                associated_token_program: a.associated_token_program.to_account_info(),
                system_program: a.system_program.to_account_info(),
            },
            &signers,
        );
        router_cpi::settle_token(cpi, id, update)
    }
}

// ------------------------------------------------------------------ internals

/// Verify an identity proof for this vault that names `destination` as the wallet. Checks, in order:
/// the token's signing key is accepted, the identity hash is this vault's, the issue time is within
/// bounds, the wallet hash commits to `destination` (its base58 string, type 12), then the ZK proof.
fn verify_owner_proof(
    factory: &Account<'_, Factory>,
    verifier_config: &Account<'_, VerifierConfig>,
    vault: &Account<'_, Vault>,
    verifier_program: &UncheckedAccount<'_>,
    destination: &Pubkey,
    proof: &[u8],
    public_witness: &[u8],
) -> Result<PublicInputs> {
    let inputs = parse_public_witness(public_witness)?;
    // The circuit proves the token was signed by the key in public inputs 2-5; only keys this verifier
    // accepts (Privy's JWKS) make that statement worth anything. Checked before the proof CPI.
    require!(verifier_config.signer_keys.contains(&inputs.signer_key), VaultError::UnknownSignerKey);
    require!(
        inputs.identity_hash == vault.identity_hash && vault.ns_hash == factory.ns_hash,
        VaultError::InvalidIdentityHash
    );
    let now = Clock::get()?.unix_timestamp;
    require!(inputs.iat <= now.saturating_add(FUTURE_SLACK), VaultError::ProofFromFuture);
    // Same-age proofs are allowed (a replayed copy pays the cached owner, see owner_update); older ones
    // are not, so a leaked old proof can never roll the owner back.
    require!(inputs.iat >= vault.latest_proof_iat, VaultError::ProofNotFresh);

    let wallet = destination.to_string();
    require!(
        inputs.wallet_hash == identity_hash(IDENTITY_TYPE_WALLET, wallet.as_bytes()),
        VaultError::InvalidWallet
    );
    verify_proof(verifier_program, proof, public_witness)?;
    Ok(inputs)
}

/// Owner-cache rules, as P2IDVault._apply: a newer proof (or the first) makes its wallet the owner; a
/// same-age proof must name the cached owner (it re-validates the cache after a key-set change);
/// older proofs were rejected in verify_owner_proof. The router records the result.
fn owner_update(vault: &Account<'_, Vault>, inputs: &PublicInputs, destination: &Pubkey) -> Result<OwnerUpdate> {
    if inputs.iat == vault.latest_proof_iat && vault.owner != Pubkey::default() {
        require!(vault.owner == *destination, VaultError::InvalidWallet);
    }
    Ok(OwnerUpdate { owner: *destination, iat: inputs.iat })
}

/// Deposit binding plus either a fresh proof (`Some(update)`) or nothing, in which case the router pays
/// the cached owner if the cache is current.
#[allow(clippy::too_many_arguments)]
fn authorize_claim(
    factory: &Account<'_, Factory>,
    verifier_config: &Account<'_, VerifierConfig>,
    vault: &Account<'_, Vault>,
    deposit: &Account<'_, Deposit>,
    verifier_program: &UncheckedAccount<'_>,
    destination: &Pubkey,
    id: u64,
    proof: &[u8],
    public_witness: &[u8],
) -> Result<Option<OwnerUpdate>> {
    require!(vault.factory == factory.key(), VaultError::WrongFactory);
    require!(deposit.vault == vault.key() && deposit.id == id, VaultError::WrongVault);
    require!(!deposit.consumed, VaultError::DepositConsumed);
    require!(verifier_program.key() == deposit.verifier, VaultError::VerifierMismatch);
    require!(verifier_config.verifier == deposit.verifier, VaultError::WrongVerifierConfig);
    require!(verifier_config.allowed, VaultError::VerifierNotAllowed);
    if proof.is_empty() && public_witness.is_empty() {
        return Ok(None);
    }
    let inputs = verify_owner_proof(factory, verifier_config, vault, verifier_program, destination, proof, public_witness)?;
    Ok(Some(owner_update(vault, &inputs, destination)?))
}

// ------------------------------------------------------------------ accounts
//
// Router-owned accounts the implementation only forwards are UncheckedAccounts (the router validates
// them); the ones it reads are deserialized read-only. `mut` marks what the router will write so the
// transaction carries them writable; this program never writes them itself.

#[derive(Accounts)]
pub struct FundSol<'info> {
    /// CHECK: router-owned; validated by the router.
    pub factory: UncheckedAccount<'info>,
    /// CHECK: router-owned; validated by the router.
    pub verifier_config: UncheckedAccount<'info>,
    /// CHECK: router-owned; validated by the router.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: created by the router.
    #[account(mut)]
    pub deposit: UncheckedAccount<'info>,
    /// CHECK: validated by the router against the factory.
    pub policy: UncheckedAccount<'info>,
    /// CHECK: validated by the router.
    pub policy_program: UncheckedAccount<'info>,
    #[account(mut)]
    pub funder: Signer<'info>,
    /// CHECK: this program's authority PDA; the router checks it belongs to vault.implementation.
    #[account(seeds = [IMPL_AUTHORITY_SEED], bump)]
    pub impl_authority: UncheckedAccount<'info>,
    pub router_program: Program<'info, P2idRouter>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundToken<'info> {
    /// CHECK: router-owned; validated by the router.
    pub factory: UncheckedAccount<'info>,
    /// CHECK: router-owned; validated by the router.
    pub verifier_config: UncheckedAccount<'info>,
    /// CHECK: router-owned; validated by the router.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: created by the router.
    #[account(mut)]
    pub deposit: UncheckedAccount<'info>,
    /// CHECK: created by the router on first use.
    #[account(mut)]
    pub vault_mint: UncheckedAccount<'info>,
    /// CHECK: validated by the router against the factory.
    pub policy: UncheckedAccount<'info>,
    /// CHECK: validated by the router.
    pub policy_program: UncheckedAccount<'info>,
    #[account(mut)]
    pub funder: Signer<'info>,
    /// CHECK: this program's authority PDA; the router checks it belongs to vault.implementation.
    #[account(seeds = [IMPL_AUTHORITY_SEED], bump)]
    pub impl_authority: UncheckedAccount<'info>,
    /// CHECK: validated by the router.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: validated by the router.
    #[account(mut)]
    pub funder_token_account: UncheckedAccount<'info>,
    /// CHECK: created by the router on first use.
    #[account(mut)]
    pub vault_token_account: UncheckedAccount<'info>,
    pub router_program: Program<'info, P2idRouter>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RefreshProof<'info> {
    pub factory: Box<Account<'info, Factory>>,
    #[account(mut, has_one = factory @ VaultError::WrongFactory)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(has_one = factory @ VaultError::WrongFactory)]
    pub verifier_config: Box<Account<'info, VerifierConfig>>,
    /// CHECK: the wallet the proof names; verified against public inputs 9-10, never a signer.
    pub owner: UncheckedAccount<'info>,
    /// CHECK: any verifier the factory allows (its config must say so).
    pub verifier_program: UncheckedAccount<'info>,
    /// CHECK: this program's authority PDA; the router checks it belongs to vault.implementation.
    #[account(seeds = [IMPL_AUTHORITY_SEED], bump)]
    pub impl_authority: UncheckedAccount<'info>,
    pub router_program: Program<'info, P2idRouter>,
}

#[derive(Accounts)]
pub struct ClaimSol<'info> {
    pub factory: Box<Account<'info, Factory>>,
    #[account(has_one = factory @ VaultError::WrongFactory)]
    pub verifier_config: Box<Account<'info, VerifierConfig>>,
    #[account(mut, has_one = factory @ VaultError::WrongFactory)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut)]
    pub deposit: Box<Account<'info, Deposit>>,
    /// CHECK: the destination: the wallet the proof names, or the cached owner. Not a signer.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    /// CHECK: pinned to the deposit verifier in `authorize_claim`.
    pub verifier_program: UncheckedAccount<'info>,
    /// CHECK: validated by the router against the factory.
    #[account(mut)]
    pub policy: UncheckedAccount<'info>,
    /// CHECK: validated by the router.
    pub policy_program: UncheckedAccount<'info>,
    /// CHECK: the instructions sysvar; the router reads it for the constraint signer's instruction.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    /// CHECK: this program's authority PDA; the router checks it belongs to vault.implementation.
    #[account(seeds = [IMPL_AUTHORITY_SEED], bump)]
    pub impl_authority: UncheckedAccount<'info>,
    pub router_program: Program<'info, P2idRouter>,
}

#[derive(Accounts)]
pub struct ClaimToken<'info> {
    pub factory: Box<Account<'info, Factory>>,
    #[account(has_one = factory @ VaultError::WrongFactory)]
    pub verifier_config: Box<Account<'info, VerifierConfig>>,
    #[account(mut, has_one = factory @ VaultError::WrongFactory)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut)]
    pub deposit: Box<Account<'info, Deposit>>,
    /// CHECK: router-owned; validated by the router.
    #[account(mut)]
    pub vault_mint: UncheckedAccount<'info>,
    /// Pays rent for token accounts created here; any key (a relayer).
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the destination wallet: the one the proof names, or the cached owner. Not a signer.
    pub owner: UncheckedAccount<'info>,
    /// CHECK: pinned to the deposit verifier in `authorize_claim`.
    pub verifier_program: UncheckedAccount<'info>,
    pub mint: Box<Account<'info, Mint>>,
    /// CHECK: validated by the router.
    #[account(mut)]
    pub vault_token_account: UncheckedAccount<'info>,
    /// CHECK: created by the router if needed.
    #[account(mut)]
    pub owner_token_account: UncheckedAccount<'info>,
    /// CHECK: validated by the router against the factory.
    #[account(mut)]
    pub policy: UncheckedAccount<'info>,
    /// CHECK: validated by the router.
    pub policy_program: UncheckedAccount<'info>,
    /// CHECK: the policy's per-mint book; created by the policy program on first use.
    #[account(mut)]
    pub policy_mint: UncheckedAccount<'info>,
    /// CHECK: created by the router if needed.
    #[account(mut)]
    pub policy_token_account: UncheckedAccount<'info>,
    /// CHECK: the instructions sysvar; the router reads it for the constraint signer's instruction.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    /// CHECK: this program's authority PDA; the router checks it belongs to vault.implementation.
    #[account(seeds = [IMPL_AUTHORITY_SEED], bump)]
    pub impl_authority: UncheckedAccount<'info>,
    pub router_program: Program<'info, P2idRouter>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// Keep the unused-import lint quiet for types referenced only in account structs.
#[allow(dead_code)]
fn _types(_: &TokenAccount) {}
