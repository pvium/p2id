//! P2ID fee policy, the Solana counterpart of `PviumP2IDPolicy`: one `PolicyConfig` account per
//! (authority, vault program, rate) that vaults consult for the fee rate at funding (`quote_fee`)
//! and notify at claim time after transferring the fee (`collect_fee_*`), which books it per mint
//! for the authority to withdraw. A new rate is a new PolicyConfig address, proposed to the vault
//! factory behind its notice. The policy never holds an allowance and never pulls funds.
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

pub mod token;
use token::transfer_tokens;

declare_id!("7Pk7qV1WMJn5iN4mfS1eKJxJgzWska4Uk8X1nej8A2VX");

pub const POLICY_SEED: &[u8] = b"p2id.policy.v1";
pub const POLICY_MINT_SEED: &[u8] = b"p2id.policy-mint.v1";
/// Same ceiling as the vault factory's MAX_FEE_BPS (1%).
pub const MAX_FEE_BPS: u16 = 100;
pub const ACCOUNT_VERSION: u8 = 1;

#[account]
#[derive(InitSpace)]
pub struct PolicyConfig {
    pub version: u8,
    /// Withdraws fees, binds the factory, transfers authority (two steps).
    pub authority: Pubkey,
    /// The authority this policy was created for: a PDA seed, never changes.
    pub seed_authority: Pubkey,
    pub pending_authority: Option<Pubkey>,
    /// The vault program whose vaults may report fees; a PDA seed.
    pub vault_program: Pubkey,
    /// Bound once with set_factory, as PviumP2IDPolicy.setFactory; fees are refused until then.
    pub factory: Pubkey,
    /// The rate quoted to every vault; a PDA seed, so a new rate is a new policy address.
    pub fee_bps: u16,
    /// SOL booked through collect_fee_sol and not yet withdrawn / all SOL ever booked (receipt check).
    pub fees_owed_sol: u64,
    pub accounted_sol: u64,
    pub bump: u8,
    pub _reserved: [u8; 64],
}

#[account]
#[derive(InitSpace)]
pub struct PolicyMint {
    pub version: u8,
    pub policy: Pubkey,
    pub mint: Pubkey,
    pub fees_owed: u64,
    pub accounted: u64,
    pub bump: u8,
    pub _reserved: [u8; 32],
}

#[event]
pub struct FeeReceived {
    pub policy: Pubkey,
    pub vault: Pubkey,
    pub verifier: Pubkey,
    pub mint: Pubkey,
    pub claimer: Pubkey,
    pub amount: u64,
}

#[event]
pub struct FeeWithdrawn {
    pub policy: Pubkey,
    pub mint: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum PolicyError {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Fee exceeds MAX_FEE_BPS")]
    FeeTooHigh,
    #[msg("Factory already set")]
    FactoryAlreadySet,
    #[msg("Factory account is not owned by the vault program")]
    InvalidFactory,
    #[msg("Policy is not bound to this factory")]
    WrongFactory,
    #[msg("Caller is not a vault of the vault program")]
    NotVault,
    #[msg("Fee not received")]
    FeeNotReceived,
    #[msg("Insufficient booked fees")]
    InsufficientFees,
    #[msg("Caller is not the pending authority")]
    NotPendingAuthority,
    #[msg("Amount must be nonzero")]
    InvalidAmount,
}

fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    **from.try_borrow_mut_lamports()? = from.lamports().checked_sub(amount).ok_or(PolicyError::InvalidAmount)?;
    **to.try_borrow_mut_lamports()? = to.lamports().checked_add(amount).ok_or(PolicyError::InvalidAmount)?;
    Ok(())
}

/// A vault of the configured vault program is any account that program signed for (invoke_signed).
fn require_vault(policy: &PolicyConfig, factory: &UncheckedAccount, vault: &Signer) -> Result<()> {
    require!(policy.factory != Pubkey::default() && factory.key() == policy.factory, PolicyError::WrongFactory);
    require!(*vault.owner == policy.vault_program, PolicyError::NotVault);
    Ok(())
}

#[program]
pub mod p2id_policy {
    use super::*;

    /// Create the policy for `authority` quoting `fee_bps` to vaults of `vault_program`. All three
    /// are PDA seeds, so anyone may submit this and only that policy comes out.
    pub fn initialize_policy(ctx: Context<InitializePolicy>, authority: Pubkey, vault_program: Pubkey, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, PolicyError::FeeTooHigh);
        let p = &mut ctx.accounts.policy;
        p.version = ACCOUNT_VERSION;
        p.authority = authority;
        p.seed_authority = authority;
        p.pending_authority = None;
        p.vault_program = vault_program;
        p.factory = Pubkey::default();
        p.fee_bps = fee_bps;
        p.fees_owed_sol = 0;
        p.accounted_sol = 0;
        p.bump = ctx.bumps.policy;
        p._reserved = [0u8; 64];
        Ok(())
    }

    /// Bind the factory once (PviumP2IDPolicy.setFactory). Fees are refused until then.
    pub fn set_factory(ctx: Context<PolicyAdminWithFactory>) -> Result<()> {
        let p = &mut ctx.accounts.policy;
        require!(p.factory == Pubkey::default(), PolicyError::FactoryAlreadySet);
        let f = &ctx.accounts.factory;
        require!(*f.owner == p.vault_program && !f.data_is_empty(), PolicyError::InvalidFactory);
        p.factory = f.key();
        Ok(())
    }

    /// The rate a vault freezes into a deposit at funding (IP2IDPolicy.feeBps). Returned as return data.
    pub fn quote_fee(ctx: Context<QuoteFee>, _verifier: Pubkey, _mint: Pubkey) -> Result<u16> {
        Ok(ctx.accounts.policy.fee_bps.min(MAX_FEE_BPS))
    }

    /// A vault reports SOL it just transferred to this policy. Books it only if the balance shows
    /// it arrived (accounted + amount <= balance above rent), as collectFee does.
    pub fn collect_fee_sol(ctx: Context<CollectFeeSol>, verifier: Pubkey, claimer: Pubkey, amount: u64) -> Result<()> {
        require_vault(&ctx.accounts.policy, &ctx.accounts.factory, &ctx.accounts.vault)?;
        let info = ctx.accounts.policy.to_account_info();
        let rent = Rent::get()?.minimum_balance(info.data_len());
        let available = info.lamports().saturating_sub(rent);
        let p = &mut ctx.accounts.policy;
        let needed = p.accounted_sol.checked_add(amount).ok_or(PolicyError::InvalidAmount)?;
        require!(available >= needed, PolicyError::FeeNotReceived);
        p.accounted_sol = needed;
        p.fees_owed_sol = p.fees_owed_sol.checked_add(amount).ok_or(PolicyError::InvalidAmount)?;
        emit!(FeeReceived { policy: p.key(), vault: ctx.accounts.vault.key(), verifier, mint: Pubkey::default(), claimer, amount });
        Ok(())
    }

    /// A vault reports tokens it just transferred to this policy's associated token account (`amount`
    /// is what arrived, after any Token-2022 transfer fee).
    pub fn collect_fee_token(ctx: Context<CollectFeeToken>, verifier: Pubkey, claimer: Pubkey, amount: u64) -> Result<()> {
        require_vault(&ctx.accounts.policy, &ctx.accounts.factory, &ctx.accounts.vault)?;
        let pm = &mut ctx.accounts.policy_mint;
        if pm.policy == Pubkey::default() {
            pm.version = ACCOUNT_VERSION;
            pm.policy = ctx.accounts.policy.key();
            pm.mint = ctx.accounts.mint.key();
            pm.bump = ctx.bumps.policy_mint;
            pm._reserved = [0u8; 32];
        }
        let needed = pm.accounted.checked_add(amount).ok_or(PolicyError::InvalidAmount)?;
        require!(ctx.accounts.policy_token_account.amount >= needed, PolicyError::FeeNotReceived);
        pm.accounted = needed;
        pm.fees_owed = pm.fees_owed.checked_add(amount).ok_or(PolicyError::InvalidAmount)?;
        emit!(FeeReceived {
            policy: ctx.accounts.policy.key(),
            vault: ctx.accounts.vault.key(),
            verifier,
            mint: ctx.accounts.mint.key(),
            claimer,
            amount,
        });
        Ok(())
    }

    pub fn withdraw_fees_sol(ctx: Context<WithdrawFeesSol>, amount: u64) -> Result<()> {
        let p = &mut ctx.accounts.policy;
        require!(amount > 0 && amount <= p.fees_owed_sol, PolicyError::InsufficientFees);
        p.fees_owed_sol -= amount;
        p.accounted_sol = p.accounted_sol.saturating_sub(amount);
        let key = p.key();
        move_lamports(&p.to_account_info(), &ctx.accounts.to.to_account_info(), amount)?;
        emit!(FeeWithdrawn { policy: key, mint: Pubkey::default(), to: ctx.accounts.to.key(), amount });
        Ok(())
    }

    pub fn withdraw_fees_token<'info>(ctx: Context<'info, WithdrawFeesToken<'info>>, amount: u64) -> Result<()> {
        let pm = &mut ctx.accounts.policy_mint;
        require!(amount > 0 && amount <= pm.fees_owed, PolicyError::InsufficientFees);
        pm.fees_owed -= amount;
        pm.accounted = pm.accounted.saturating_sub(amount);
        let p = &ctx.accounts.policy;
        let fee = p.fee_bps.to_be_bytes();
        let bump = [p.bump];
        let signer: &[&[u8]] = &[POLICY_SEED, p.seed_authority.as_ref(), p.vault_program.as_ref(), &fee, &bump];
        transfer_tokens(
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.policy_token_account.to_account_info(),
            &ctx.accounts.mint.to_account_info(),
            &ctx.accounts.to_token_account.to_account_info(),
            &p.to_account_info(),
            ctx.remaining_accounts,
            amount,
            ctx.accounts.mint.decimals,
            &[signer],
        )?;
        emit!(FeeWithdrawn { policy: p.key(), mint: ctx.accounts.mint.key(), to: ctx.accounts.to_token_account.key(), amount });
        Ok(())
    }

    pub fn transfer_authority(ctx: Context<PolicyAdmin>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.policy.pending_authority = Some(new_authority);
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        let p = &mut ctx.accounts.policy;
        require!(p.pending_authority == Some(ctx.accounts.new_authority.key()), PolicyError::NotPendingAuthority);
        p.authority = ctx.accounts.new_authority.key();
        p.pending_authority = None;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(authority: Pubkey, vault_program: Pubkey, fee_bps: u16)]
pub struct InitializePolicy<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + PolicyConfig::INIT_SPACE,
        seeds = [POLICY_SEED, authority.as_ref(), vault_program.as_ref(), &fee_bps.to_be_bytes()],
        bump
    )]
    pub policy: Account<'info, PolicyConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PolicyAdmin<'info> {
    #[account(
        mut,
        seeds = [POLICY_SEED, policy.seed_authority.as_ref(), policy.vault_program.as_ref(), &policy.fee_bps.to_be_bytes()],
        bump = policy.bump,
        has_one = authority @ PolicyError::Unauthorized
    )]
    pub policy: Account<'info, PolicyConfig>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct PolicyAdminWithFactory<'info> {
    #[account(
        mut,
        seeds = [POLICY_SEED, policy.seed_authority.as_ref(), policy.vault_program.as_ref(), &policy.fee_bps.to_be_bytes()],
        bump = policy.bump,
        has_one = authority @ PolicyError::Unauthorized
    )]
    pub policy: Account<'info, PolicyConfig>,
    pub authority: Signer<'info>,
    /// CHECK: must be owned by the vault program; the vault program binds it to this policy on its side.
    pub factory: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(
        mut,
        seeds = [POLICY_SEED, policy.seed_authority.as_ref(), policy.vault_program.as_ref(), &policy.fee_bps.to_be_bytes()],
        bump = policy.bump
    )]
    pub policy: Account<'info, PolicyConfig>,
    pub new_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct QuoteFee<'info> {
    pub policy: Account<'info, PolicyConfig>,
}

#[derive(Accounts)]
pub struct CollectFeeSol<'info> {
    #[account(mut)]
    pub policy: Account<'info, PolicyConfig>,
    /// CHECK: compared with policy.factory.
    pub factory: UncheckedAccount<'info>,
    /// The reporting vault: a PDA the vault program signed for via invoke_signed.
    pub vault: Signer<'info>,
}

#[derive(Accounts)]
pub struct CollectFeeToken<'info> {
    #[account(mut)]
    pub policy: Account<'info, PolicyConfig>,
    /// CHECK: compared with policy.factory.
    pub factory: UncheckedAccount<'info>,
    /// The reporting vault: a PDA the vault program signed for via invoke_signed.
    pub vault: Signer<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + PolicyMint::INIT_SPACE,
        seeds = [POLICY_MINT_SEED, policy.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub policy_mint: Account<'info, PolicyMint>,
    /// Pays rent for a first-seen mint; the claim transaction's payer, passed through the CPI.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(associated_token::mint = mint, associated_token::authority = policy, associated_token::token_program = token_program)]
    pub policy_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawFeesSol<'info> {
    #[account(
        mut,
        seeds = [POLICY_SEED, policy.seed_authority.as_ref(), policy.vault_program.as_ref(), &policy.fee_bps.to_be_bytes()],
        bump = policy.bump,
        has_one = authority @ PolicyError::Unauthorized
    )]
    pub policy: Account<'info, PolicyConfig>,
    pub authority: Signer<'info>,
    /// CHECK: recipient chosen by the authority.
    #[account(mut)]
    pub to: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct WithdrawFeesToken<'info> {
    #[account(
        seeds = [POLICY_SEED, policy.seed_authority.as_ref(), policy.vault_program.as_ref(), &policy.fee_bps.to_be_bytes()],
        bump = policy.bump,
        has_one = authority @ PolicyError::Unauthorized
    )]
    pub policy: Account<'info, PolicyConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [POLICY_MINT_SEED, policy.key().as_ref(), mint.key().as_ref()],
        bump = policy_mint.bump
    )]
    pub policy_mint: Account<'info, PolicyMint>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = policy, associated_token::token_program = token_program)]
    pub policy_token_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: recipient token account chosen by the authority; created if needed.
    #[account(init_if_needed, payer = authority, associated_token::mint = mint, associated_token::authority = to, associated_token::token_program = token_program)]
    pub to_token_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: owner of the recipient token account.
    pub to: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
