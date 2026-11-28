//! P2ID vault implementation v1 (EVM P2IDVaultV2 semantics). The user-facing program: funders call
//! `fund_*`, anyone submits `claim_*` or `refresh_proof` for the owner. It owns no accounts and holds
//! no funds; it has the deposit's verifier program check the identity proof (the verifier interface:
//! opaque proof in, attestation out), checks what the attestation says (an accepted signer key, this
//! vault's identity, freshness, the wallet binding) and asks the router to record the result and move
//! the money, signing with its authority PDA. The router enforces the funder protections and applies every state change. A later
//! implementation is a new program the factory registers behind notice; vault owners move to it
//! through the router. Refunds and untracked sweeps are router instructions and never pass through here.
//!
//! A Sunspot proof and witness are ~750 bytes: a claim carrying them inline does not fit a legacy
//! transaction, and with the alpha attester's approval beside it neither does `refresh_proof`.
//! Proofs therefore travel by reference: `register_proof` stores the proof in a buffer account first
//! (its own transaction); `claim_*` and `refresh_proof` read it from there and close it, returning the
//! rent to whoever registered it. `claim_*` never takes a proof inline; `refresh_proof` still may,
//! for the proof-only refresh that fits (11 accounts, no approval).
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::TokenInterface;
use p2id_router::cpi::{self as router_cpi, accounts as router_accounts};
use p2id_router::hash::{identity_hash, sha256};
use p2id_router::program::P2idRouter;
use p2id_router::state::*;
use p2id_verifier_interface::{verify, Attestation, VerifyError, MAX_PROOF_LEN};

pub mod errors;

use errors::VaultError;

declare_id!("7TExBifS2846TvPGSeAzR6XseXxs1D3YXkHaourqcxTr");

/// Seed of a registered proof: PDA(["p2id.proof.v1", registerer, sha256(payload)]).
pub const PROOF_BUFFER_SEED: &[u8] = b"p2id.proof.v1";

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

    /// Record a token deposit (classic SPL Token or Token-2022); same terms as fund_sol. For a
    /// transfer-hook mint, append the hook's extra accounts as remaining accounts.
    pub fn fund_token<'info>(
        ctx: Context<'info, FundToken<'info>>,
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
        router_cpi::create_deposit_token(
            cpi.with_remaining_accounts(ctx.remaining_accounts.to_vec()),
            amount,
            constraint,
            refund_window,
            refunder,
            reference,
        )
    }

    /// Verify an identity proof under any allowed verifier and update the owner cache without
    /// paying anything out (EVM refreshProof). `owner` is the wallet the proof names. The proof is
    /// `proof`, or, when that is empty, the payload of a `register_proof` buffer (`proof_buffer`,
    /// with its `registerer`); the buffer is closed afterwards and its rent returned to the
    /// registerer. Accounts the verifier needs follow as remaining accounts.
    pub fn refresh_proof<'info>(ctx: Context<'info, RefreshProof<'info>>, proof: Vec<u8>) -> Result<()> {
        let registered = registered_proof(&ctx.accounts.proof_buffer, &ctx.accounts.registerer)?;
        let proof = match (registered, proof.is_empty()) {
            (Some(payload), true) => payload,
            (None, false) => proof,
            (Some(_), false) => return err!(VaultError::AmbiguousProof),
            (None, true) => return err!(VaultError::EmptyProof),
        };

        let a = &ctx.accounts;
        require!(a.verifier_config.allowed, VaultError::VerifierNotAllowed);
        require!(a.verifier_config.verifier == a.verifier_program.key(), VaultError::WrongVerifierConfig);
        let attestation = verify_owner_proof(
            &a.factory, &a.verifier_config, &a.vault, &a.verifier_program, ctx.remaining_accounts, &a.owner.key(), &proof,
        )?;
        let update = owner_update(&a.vault, &attestation, &a.owner.key())?;

        let bump = [ctx.bumps.impl_authority];
        let signer: &[&[u8]] = &[IMPL_AUTHORITY_SEED, &bump];
        let signers = [signer];
        let cpi = CpiContext::new_with_signer(
            a.router_program.key(),
            router_accounts::SetOwnerCache {
                factory: a.factory.to_account_info(),
                vault: a.vault.to_account_info(),
                verifier_config: a.verifier_config.to_account_info(),
                instructions: a.instructions.to_account_info(),
                impl_authority: a.impl_authority.to_account_info(),
            },
            &signers,
        );
        router_cpi::set_owner_cache(cpi, update)?;
        close_presented_proof(&ctx.accounts.proof_buffer, &ctx.accounts.registerer)
    }

    /// Store an identity proof for a later `refresh_proof`, in its own transaction. The buffer is
    /// PDA(["p2id.proof.v1", registerer, sha256(payload)]): its address commits to who paid its rent
    /// and exactly what it holds, and `refresh_proof` re-derives it from the stored payload before
    /// using it. Anyone may register; the registerer gets the rent back when the proof is presented
    /// or through `close_proof`.
    pub fn register_proof(ctx: Context<RegisterProof>, payload_hash: [u8; 32], payload: Vec<u8>) -> Result<()> {
        require!(!payload.is_empty(), VaultError::EmptyProof);
        require!(payload.len() <= MAX_PROOF_LEN, VaultError::PayloadTooLarge);
        require!(sha256(&[&payload]) == payload_hash, VaultError::ProofBufferMismatch);
        let buffer = &mut ctx.accounts.proof_buffer;
        buffer.version = ACCOUNT_VERSION;
        buffer.registerer = ctx.accounts.registerer.key();
        buffer.payload_hash = payload_hash;
        buffer.bump = ctx.bumps.proof_buffer;
        buffer.payload = payload;
        Ok(())
    }

    /// Return a registered proof's rent to its registerer without presenting it (e.g. it went stale).
    pub fn close_proof(_ctx: Context<CloseProof>) -> Result<()> {
        Ok(())
    }

    /// Pay SOL deposit `id` to `owner`: the wallet a registered proof names (`proof_buffer` with its
    /// `registerer`, see `register_proof`), or the cached owner when no buffer is given. Anyone may
    /// submit it (EVM refreshProofAndSweep / sweep). A constrained deposit needs an ed25519
    /// instruction by a constraint signer earlier in the transaction; the router checks it. With a
    /// proof, the accounts the verifier needs follow as remaining accounts, and the buffer is closed
    /// afterwards, its rent returned to the registerer.
    pub fn claim_sol<'info>(ctx: Context<'info, ClaimSol<'info>>, id: u64) -> Result<()> {
        let a = &ctx.accounts;
        let proof = registered_proof(&a.proof_buffer, &a.registerer)?;
        let update = authorize_claim(
            &a.factory, &a.verifier_config, &a.vault, &a.deposit, &a.verifier_program, ctx.remaining_accounts, &a.owner.key(), id,
            proof.as_deref().unwrap_or(&[]),
        )?;

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
        router_cpi::settle_sol(cpi, id, update)?;
        close_presented_proof(&a.proof_buffer, &a.registerer)
    }

    /// Pay SPL-token deposit `id` to `owner`'s associated token account (created if needed, rent
    /// paid by `payer`). Same authorization and proof handling as claim_sol. Remaining accounts: the
    /// verifier's accounts first (with a registered proof), then any the mint's transfer hook needs;
    /// both calls receive the whole list and take what they declare.
    pub fn claim_token<'info>(ctx: Context<'info, ClaimToken<'info>>, id: u64) -> Result<()> {
        let a = &ctx.accounts;
        let proof = registered_proof(&a.proof_buffer, &a.registerer)?;
        let update = authorize_claim(
            &a.factory, &a.verifier_config, &a.vault, &a.deposit, &a.verifier_program, ctx.remaining_accounts, &a.owner.key(), id,
            proof.as_deref().unwrap_or(&[]),
        )?;

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
        router_cpi::settle_token(cpi.with_remaining_accounts(ctx.remaining_accounts.to_vec()), id, update)?;
        close_presented_proof(&a.proof_buffer, &a.registerer)
    }
}

// ------------------------------------------------------------------ internals

/// Verify an identity proof for this vault that names `destination` as the wallet. The verifier
/// program establishes the proof is genuine and says what it attests; this checks what it attests:
/// the token's signing key is one the verifier config accepts, the identity is this vault's, the
/// issue time is within bounds, the wallet hash commits to `destination` (its base58 string, type 12).
fn verify_owner_proof<'info>(
    factory: &Account<'info, Factory>,
    verifier_config: &Account<'info, VerifierConfig>,
    vault: &Account<'info, Vault>,
    verifier_program: &UncheckedAccount<'info>,
    verifier_accounts: &[AccountInfo<'info>],
    destination: &Pubkey,
    proof: &[u8],
) -> Result<Attestation> {
    let attestation = verify(verifier_program, verifier_accounts, proof).map_err(|e| match e {
        VerifyError::EmptyProof => VaultError::EmptyProof,
        VerifyError::ProofTooLarge => VaultError::PayloadTooLarge,
        VerifyError::VerifierNotExecutable => VaultError::VerifierNotExecutable,
        VerifyError::Rejected => VaultError::ProofVerificationFailed,
        VerifyError::NoAttestation => VaultError::InvalidAttestation,
    })?;
    // The circuit proves the token was signed by the attested key; only keys this verifier accepts
    // (Privy's JWKS) make that statement worth anything.
    require!(verifier_config.signer_keys.contains(&attestation.signer_key), VaultError::UnknownSignerKey);
    require!(
        attestation.identity_hash == vault.identity_hash && vault.ns_hash == factory.ns_hash,
        VaultError::InvalidIdentityHash
    );
    let now = Clock::get()?.unix_timestamp;
    require!(attestation.iat <= now.saturating_add(FUTURE_SLACK), VaultError::ProofFromFuture);
    // Same-age proofs are allowed (a replayed copy pays the cached owner, see owner_update); older ones
    // are not, so a leaked old proof can never roll the owner back.
    require!(attestation.iat >= vault.latest_proof_iat, VaultError::ProofNotFresh);

    let wallet = destination.to_string();
    require!(
        attestation.wallet_hash == identity_hash(IDENTITY_TYPE_WALLET, wallet.as_bytes()),
        VaultError::InvalidWallet
    );
    Ok(attestation)
}

/// The payload of a registered proof, after checking the buffer is what it claims to be: owned by
/// this program (Account), at the address its registerer and payload hash derive, holding a payload
/// with that hash, and paired with its registerer (who receives the rent when it is closed). None
/// when no buffer is given.
fn registered_proof(
    buffer: &Option<Account<'_, ProofBuffer>>,
    registerer: &Option<UncheckedAccount<'_>>,
) -> Result<Option<Vec<u8>>> {
    let Some(buffer) = buffer else {
        require!(registerer.is_none(), VaultError::AmbiguousProof);
        return Ok(None);
    };
    let registerer = registerer.as_ref().ok_or(VaultError::WrongRegisterer)?;
    require_keys_eq!(buffer.registerer, registerer.key(), VaultError::WrongRegisterer);
    let payload_hash = sha256(&[&buffer.payload]);
    require!(payload_hash == buffer.payload_hash, VaultError::ProofBufferMismatch);
    let derived = Pubkey::create_program_address(
        &[PROOF_BUFFER_SEED, buffer.registerer.as_ref(), &payload_hash, &[buffer.bump]],
        &crate::ID,
    )
    .map_err(|_| error!(VaultError::ProofBufferMismatch))?;
    require_keys_eq!(derived, buffer.key(), VaultError::ProofBufferMismatch);
    Ok(Some(buffer.payload.clone()))
}

/// A registered proof has been presented: free its buffer, the rent back to whoever paid it. Nothing
/// to do without a buffer (`registered_proof` already paired the two accounts).
fn close_presented_proof<'info>(buffer: &Option<Account<'info, ProofBuffer>>, registerer: &Option<UncheckedAccount<'info>>) -> Result<()> {
    if let (Some(buffer), Some(registerer)) = (buffer, registerer) {
        buffer.close(registerer.to_account_info())?;
    }
    Ok(())
}

/// Owner-cache rules, as P2IDVault._apply: a newer proof (or the first) makes its wallet the owner; a
/// same-age proof must name the cached owner (it re-validates the cache after a key-set change);
/// older proofs were rejected in verify_owner_proof. The router records the result.
fn owner_update(vault: &Account<'_, Vault>, attestation: &Attestation, destination: &Pubkey) -> Result<OwnerUpdate> {
    if attestation.iat == vault.latest_proof_iat && vault.owner != Pubkey::default() {
        require!(vault.owner == *destination, VaultError::InvalidWallet);
    }
    Ok(OwnerUpdate { owner: *destination, iat: attestation.iat })
}

/// Deposit binding plus either a fresh proof (`Some(update)`; the payload of a registered buffer) or
/// nothing, in which case the router pays the cached owner if the cache is current.
#[allow(clippy::too_many_arguments)]
fn authorize_claim<'info>(
    factory: &Account<'info, Factory>,
    verifier_config: &Account<'info, VerifierConfig>,
    vault: &Account<'info, Vault>,
    deposit: &Account<'info, Deposit>,
    verifier_program: &UncheckedAccount<'info>,
    verifier_accounts: &[AccountInfo<'info>],
    destination: &Pubkey,
    id: u64,
    proof: &[u8],
) -> Result<Option<OwnerUpdate>> {
    require!(vault.factory == factory.key(), VaultError::WrongFactory);
    require!(deposit.vault == vault.key() && deposit.id == id, VaultError::WrongVault);
    require!(!deposit.consumed, VaultError::DepositConsumed);
    require!(verifier_program.key() == deposit.verifier, VaultError::VerifierMismatch);
    require!(verifier_config.verifier == deposit.verifier, VaultError::WrongVerifierConfig);
    require!(verifier_config.allowed, VaultError::VerifierNotAllowed);
    if proof.is_empty() {
        return Ok(None);
    }
    let attestation = verify_owner_proof(factory, verifier_config, vault, verifier_program, verifier_accounts, destination, proof)?;
    Ok(Some(owner_update(vault, &attestation, destination)?))
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
    pub token_program: Interface<'info, TokenInterface>,
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
    /// CHECK: the wallet the proof names; verified against the attested wallet hash, never a signer.
    pub owner: UncheckedAccount<'info>,
    /// CHECK: any verifier the factory allows (its config must say so); its accounts follow as remaining accounts.
    pub verifier_program: UncheckedAccount<'info>,
    /// CHECK: the instructions sysvar; the router reads it for the alpha attester's instruction.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    /// CHECK: this program's authority PDA; the router checks it belongs to vault.implementation.
    #[account(seeds = [IMPL_AUTHORITY_SEED], bump)]
    pub impl_authority: UncheckedAccount<'info>,
    pub router_program: Program<'info, P2idRouter>,
    /// The registered proof, when `proof` is empty; checked in `registered_proof` and closed.
    #[account(mut)]
    pub proof_buffer: Option<Account<'info, ProofBuffer>>,
    /// CHECK: must be the buffer's registerer (checked in `registered_proof`); receives its rent.
    #[account(mut)]
    pub registerer: Option<UncheckedAccount<'info>>,
}

#[derive(Accounts)]
#[instruction(payload_hash: [u8; 32], payload: Vec<u8>)]
pub struct RegisterProof<'info> {
    #[account(mut)]
    pub registerer: Signer<'info>,
    #[account(
        init,
        payer = registerer,
        space = ProofBuffer::space(payload.len()),
        seeds = [PROOF_BUFFER_SEED, registerer.key().as_ref(), payload_hash.as_ref()],
        bump
    )]
    pub proof_buffer: Account<'info, ProofBuffer>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseProof<'info> {
    #[account(mut)]
    pub registerer: Signer<'info>,
    #[account(mut, close = registerer, has_one = registerer @ VaultError::WrongRegisterer)]
    pub proof_buffer: Account<'info, ProofBuffer>,
}

/// An identity proof registered for a later `refresh_proof` (see `register_proof`).
#[account]
pub struct ProofBuffer {
    pub version: u8,
    /// Paid the rent; receives it back when the buffer is closed.
    pub registerer: Pubkey,
    /// sha256(payload); a seed of this account.
    pub payload_hash: [u8; 32],
    pub bump: u8,
    /// The proof as `refresh_proof` takes it (for Sunspot: proof || public witness).
    pub payload: Vec<u8>,
}

impl ProofBuffer {
    pub fn space(payload_len: usize) -> usize {
        8 + 1 + 32 + 32 + 1 + 4 + payload_len
    }
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
    /// CHECK: pinned to the deposit verifier in `authorize_claim`; its accounts follow as remaining accounts.
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
    /// The registered proof to present (see `register_proof`); none pays the cached owner.
    #[account(mut)]
    pub proof_buffer: Option<Account<'info, ProofBuffer>>,
    /// CHECK: must be the buffer's registerer (checked in `registered_proof`); receives its rent.
    #[account(mut)]
    pub registerer: Option<UncheckedAccount<'info>>,
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
    /// CHECK: pinned to the deposit verifier in `authorize_claim`; its accounts follow as remaining accounts.
    pub verifier_program: UncheckedAccount<'info>,
    /// CHECK: validated by the router.
    pub mint: UncheckedAccount<'info>,
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
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// The registered proof to present (see `register_proof`); none pays the cached owner.
    #[account(mut)]
    pub proof_buffer: Option<Account<'info, ProofBuffer>>,
    /// CHECK: must be the buffer's registerer (checked in `registered_proof`); receives its rent.
    #[account(mut)]
    pub registerer: Option<UncheckedAccount<'info>>,
}
