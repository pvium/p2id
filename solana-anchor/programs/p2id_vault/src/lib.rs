use std::str::FromStr;

use anchor_lang::prelude::*;
use anchor_lang::Key;
use anchor_lang::system_program::{transfer as sol_transfer, Transfer as SolTransfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer as TokenTransfer};

pub mod errors;
pub mod proof;
pub mod state;

use errors::VaultError;
use proof::{identity_hash, parse_public_witness, sha256, verify_proof, PublicInputs};
use state::*;

declare_id!("DaQSQnyAHJLRMdN8m5ENm1Zr9dQKCeRBG8QoxMjEvVzf");

fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let from_lamports = from.lamports();
    let to_lamports = to.lamports();
    **from.try_borrow_mut_lamports()? = from_lamports
        .checked_sub(amount)
        .ok_or(VaultError::InvalidAmount)?;
    **to.try_borrow_mut_lamports()? = to_lamports
        .checked_add(amount)
        .ok_or(VaultError::InvalidAmount)?;
    Ok(())
}

#[program]
pub mod p2id_vault {
    use super::*;

    pub fn initialize_factory(
        ctx: Context<InitializeFactory>,
        default_verifier: Pubkey,
        policy: Pubkey,
        fee_bps: u16,
        circuit_version: u16,
        vk_hash: [u8; 32],
        min_refund_window: i64,
        max_refund_window: i64,
    ) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, VaultError::FeeTooHigh);
        require!(
            min_refund_window > 0 && min_refund_window <= max_refund_window,
            VaultError::InvalidRefundWindow
        );

        let factory = &mut ctx.accounts.factory;
        factory.authority = ctx.accounts.authority.key();
        factory.pending_authority = None;
        factory.scheme_version = scheme_version_bytes();
        factory.ns_hash = sha256(&[SCHEME_VERSION]);
        factory.default_verifier = default_verifier;
        factory.proposed_verifier = Pubkey::default();
        factory.proposed_verifier_eta = 0;
        factory.policy = policy;
        factory.fee_bps = fee_bps;
        factory.verifier_change_delay = DEFAULT_VERIFIER_DELAY;
        factory.min_refund_window = min_refund_window;
        factory.max_refund_window = max_refund_window;
        factory.circuit_version = circuit_version;
        factory.vk_hash = vk_hash;
        factory.allowed_verifiers = vec![default_verifier];
        factory.bump = ctx.bumps.factory;
        Ok(())
    }

    pub fn propose_verifier(ctx: Context<FactoryAdmin>, verifier: Pubkey) -> Result<()> {
        let factory = &mut ctx.accounts.factory;
        factory.proposed_verifier = verifier;
        factory.proposed_verifier_eta = ctx.accounts.clock.unix_timestamp
            .checked_add(factory.verifier_change_delay)
            .ok_or(VaultError::VerifierChangeNotReady)?;
        Ok(())
    }

    pub fn activate_verifier(ctx: Context<FactoryAdmin>) -> Result<()> {
        let factory = &mut ctx.accounts.factory;
        require!(
            factory.proposed_verifier != Pubkey::default(),
            VaultError::NoVerifierProposed
        );
        require!(
            ctx.accounts.clock.unix_timestamp >= factory.proposed_verifier_eta,
            VaultError::VerifierChangeNotReady
        );
        let proposed = factory.proposed_verifier;
        if !factory.allowed_verifiers.contains(&proposed) {
            require!(
                factory.allowed_verifiers.len() < MAX_ALLOWED_VERIFIERS,
                VaultError::VerifierNotAllowed
            );
            factory.allowed_verifiers.push(proposed);
        }
        factory.default_verifier = proposed;
        factory.proposed_verifier = Pubkey::default();
        factory.proposed_verifier_eta = 0;
        Ok(())
    }

    pub fn cancel_verifier_proposal(ctx: Context<FactoryAdmin>) -> Result<()> {
        let factory = &mut ctx.accounts.factory;
        factory.proposed_verifier = Pubkey::default();
        factory.proposed_verifier_eta = 0;
        Ok(())
    }

    pub fn deploy_vault(ctx: Context<DeployVault>, identity_hash: [u8; 32]) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.factory = ctx.accounts.factory.key();
        vault.identity_hash = identity_hash;
        vault.ns_hash = ctx.accounts.factory.ns_hash;
        vault.owner = Pubkey::default();
        vault.latest_proof_iat = 0;
        vault.owner_revision = 0;
        vault.deposit_seq = 0;
        vault.bump = ctx.bumps.vault;
        Ok(())
    }

    pub fn fund_sol(
        ctx: Context<FundSol>,
        amount: u64,
        constraint: [u8; 32],
        refund_window: i64,
        refunder: Option<Pubkey>,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let factory = &ctx.accounts.factory;
        let vault = &ctx.accounts.vault;
        let id = vault.deposit_seq;

        populate_deposit(
            &mut ctx.accounts.deposit,
            vault,
            factory,
            id,
            ctx.accounts.funder.key(),
            Pubkey::default(),
            amount,
            constraint,
            refund_window,
            clock.unix_timestamp,
            refunder,
            ctx.bumps.deposit,
        )?;

        sol_transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                SolTransfer {
                    from: ctx.accounts.funder.to_account_info(),
                    to: vault.to_account_info(),
                },
            ),
            amount,
        )?;

        let vault = &mut ctx.accounts.vault;
        vault.deposit_seq = id.checked_add(1).ok_or(VaultError::InvalidAmount)?;
        Ok(())
    }

    pub fn fund_token(
        ctx: Context<FundToken>,
        amount: u64,
        constraint: [u8; 32],
        refund_window: i64,
        refunder: Option<Pubkey>,
    ) -> Result<()> {
        require!(ctx.accounts.mint.key() != Pubkey::default(), VaultError::InvalidAmount);
        let clock = Clock::get()?;
        let factory = &ctx.accounts.factory;
        let vault = &ctx.accounts.vault;
        let id = vault.deposit_seq;

        populate_deposit(
            &mut ctx.accounts.deposit,
            vault,
            factory,
            id,
            ctx.accounts.funder.key(),
            ctx.accounts.mint.key(),
            amount,
            constraint,
            refund_window,
            clock.unix_timestamp,
            refunder,
            ctx.bumps.deposit,
        )?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TokenTransfer {
                    from: ctx.accounts.funder_token_account.to_account_info(),
                    to: ctx.accounts.vault_token_account.to_account_info(),
                    authority: ctx.accounts.funder.to_account_info(),
                },
            ),
            amount,
        )?;

        let vault = &mut ctx.accounts.vault;
        vault.deposit_seq = id.checked_add(1).ok_or(VaultError::InvalidAmount)?;
        Ok(())
    }

    pub fn claim_sol(
        ctx: Context<ClaimSol>,
        id: u64,
        wallet: String,
        proof: Vec<u8>,
        public_witness: Vec<u8>,
    ) -> Result<()> {
        let inputs = check_proof(
            &ctx.accounts.factory,
            &ctx.accounts.vault,
            &ctx.accounts.deposit,
            &ctx.accounts.verifier_program,
            &ctx.accounts.owner,
            id,
            &wallet,
            &proof,
            &public_witness,
        )?;

        let amount = ctx.accounts.deposit.amount;
        let fee = fee_for(amount, ctx.accounts.deposit.fee_bps);
        let net = amount.checked_sub(fee).ok_or(VaultError::InvalidAmount)?;

        move_lamports(
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.owner.to_account_info(),
            net,
        )?;
        move_lamports(
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.policy.to_account_info(),
            fee,
        )?;

        finish_claim(&mut ctx.accounts.vault, &mut ctx.accounts.deposit, inputs, &ctx.accounts.owner.key())?;
        Ok(())
    }

    pub fn claim_token(
        ctx: Context<ClaimToken>,
        id: u64,
        wallet: String,
        proof: Vec<u8>,
        public_witness: Vec<u8>,
    ) -> Result<()> {
        let inputs = check_proof(
            &ctx.accounts.factory,
            &ctx.accounts.vault,
            &ctx.accounts.deposit,
            &ctx.accounts.verifier_program,
            &ctx.accounts.owner,
            id,
            &wallet,
            &proof,
            &public_witness,
        )?;

        let expected_policy_ata = anchor_spl::associated_token::get_associated_token_address(
            &ctx.accounts.factory.policy,
            &ctx.accounts.mint.key(),
        );
        require!(
            ctx.accounts.policy_token_account.key() == expected_policy_ata,
            VaultError::Unauthorized
        );

        let amount = ctx.accounts.deposit.amount;
        let fee = fee_for(amount, ctx.accounts.deposit.fee_bps);
        let net = amount.checked_sub(fee).ok_or(VaultError::InvalidAmount)?;

        let identity_hash = ctx.accounts.vault.identity_hash;
        let bump = ctx.accounts.vault.bump;
        let seeds: &[&[u8]] = &[VAULT_SEED, identity_hash.as_ref(), &[bump]];
        let signer_seeds = &[seeds];

        if net > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    TokenTransfer {
                        from: ctx.accounts.vault_token_account.to_account_info(),
                        to: ctx.accounts.owner_token_account.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    signer_seeds,
                ),
                net,
            )?;
        }
        if fee > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    TokenTransfer {
                        from: ctx.accounts.vault_token_account.to_account_info(),
                        to: ctx.accounts.policy_token_account.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    signer_seeds,
                ),
                fee,
            )?;
        }

        finish_claim(&mut ctx.accounts.vault, &mut ctx.accounts.deposit, inputs, &ctx.accounts.owner.key())?;
        Ok(())
    }

    pub fn refund_sol(ctx: Context<RefundSol>, id: u64) -> Result<()> {
        let clock = Clock::get()?;
        let deposit = &mut ctx.accounts.deposit;
        require!(deposit.id == id, VaultError::InvalidIdentityHash);
        validate_refund(deposit, &ctx.accounts.caller.key(), clock.unix_timestamp)?;
        require!(deposit.is_sol(), VaultError::InvalidAmount);

        move_lamports(
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.caller.to_account_info(),
            deposit.amount,
        )?;
        deposit.consumed = true;
        Ok(())
    }

    pub fn refund_token(ctx: Context<RefundToken>, id: u64) -> Result<()> {
        let clock = Clock::get()?;
        let deposit = &mut ctx.accounts.deposit;
        require!(deposit.id == id, VaultError::InvalidIdentityHash);
        validate_refund(deposit, &ctx.accounts.caller.key(), clock.unix_timestamp)?;
        require!(!deposit.is_sol(), VaultError::InvalidAmount);

        let identity_hash = ctx.accounts.vault.identity_hash;
        let bump = ctx.accounts.vault.bump;
        let seeds: &[&[u8]] = &[VAULT_SEED, identity_hash.as_ref(), &[bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TokenTransfer {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    to: ctx.accounts.caller_token_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[seeds],
            ),
            deposit.amount,
        )?;
        deposit.consumed = true;
        Ok(())
    }
}

fn populate_deposit(
    deposit: &mut Account<'_, Deposit>,
    vault: &Account<'_, Vault>,
    factory: &Account<'_, Factory>,
    id: u64,
    funder: Pubkey,
    mint: Pubkey,
    amount: u64,
    constraint: [u8; 32],
    refund_window: i64,
    funded_at: i64,
    refunder: Option<Pubkey>,
    bump: u8,
) -> Result<()> {
    require!(amount > 0, VaultError::InvalidAmount);
    require!(
        refund_window >= factory.min_refund_window && refund_window <= factory.max_refund_window,
        VaultError::InvalidRefundWindow
    );
    require!(
        factory.default_verifier != Pubkey::default()
            && factory.allowed_verifiers.contains(&factory.default_verifier),
        VaultError::VerifierNotAllowed
    );

    deposit.vault = vault.key();
    deposit.id = id;
    deposit.funder = funder;
    deposit.mint = mint;
    deposit.amount = amount;
    deposit.verifier = factory.default_verifier;
    deposit.fee_bps = factory.fee_bps;
    deposit.constraint = constraint;
    deposit.refund_window = refund_window;
    deposit.funded_at = funded_at;
    deposit.consumed = false;
    deposit.refunder = refunder;
    deposit.bump = bump;
    Ok(())
}

fn fee_for(amount: u64, fee_bps: u16) -> u64 {
    let bps = u128::from(fee_bps.min(MAX_FEE_BPS));
    (u128::from(amount) * bps / 10_000) as u64
}

fn validate_refund(deposit: &Deposit, caller: &Pubkey, now: i64) -> Result<()> {
    require!(!deposit.consumed, VaultError::DepositConsumed);
    require!(
        *caller == deposit.funder || Some(*caller) == deposit.refunder,
        VaultError::Unauthorized
    );
    let deadline = deposit
        .funded_at
        .checked_add(deposit.refund_window)
        .ok_or(VaultError::InvalidRefundWindow)?;
    require!(now < deadline, VaultError::RefundWindowClosed);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn check_proof(
    factory: &Account<'_, Factory>,
    vault: &Account<'_, Vault>,
    deposit: &Account<'_, Deposit>,
    verifier_program: &UncheckedAccount<'_>,
    owner: &Signer<'_>,
    id: u64,
    wallet: &str,
    proof: &[u8],
    public_witness: &[u8],
) -> Result<PublicInputs> {
    require!(vault.factory == factory.key(), VaultError::WrongFactory);
    require!(deposit.vault == vault.key(), VaultError::WrongVault);
    require!(deposit.id == id, VaultError::InvalidIdentityHash);
    require!(!deposit.consumed, VaultError::DepositConsumed);
    require!(
        verifier_program.key() == deposit.verifier,
        VaultError::VerifierMismatch
    );
    require!(
        factory.allowed_verifiers.contains(&verifier_program.key()),
        VaultError::VerifierNotAllowed
    );

    let inputs = parse_public_witness(public_witness)?;
    require!(
        inputs.identity_hash == vault.identity_hash && vault.ns_hash == factory.ns_hash,
        VaultError::InvalidIdentityHash
    );
    let now = Clock::get()?.unix_timestamp;
    require!(
        inputs.iat > vault.latest_proof_iat && inputs.iat <= now.saturating_add(FUTURE_SLACK),
        VaultError::ProofNotFresh
    );

    let expected_wallet_hash = identity_hash(IDENTITY_TYPE_WALLET, wallet.as_bytes());
    require!(inputs.wallet_hash == expected_wallet_hash, VaultError::InvalidWallet);
    let wallet_key = Pubkey::from_str(wallet).map_err(|_| VaultError::InvalidWallet)?;
    require!(wallet_key == owner.key(), VaultError::InvalidWallet);

    verify_proof(verifier_program, proof, public_witness)?;
    Ok(inputs)
}

fn finish_claim(vault: &mut Vault, deposit: &mut Deposit, inputs: PublicInputs, owner: &Pubkey) -> Result<()> {
    if vault.owner == Pubkey::default() {
        vault.owner = *owner;
    }
    require!(vault.owner == *owner, VaultError::InvalidWallet);
    vault.latest_proof_iat = inputs.iat;
    vault.owner_revision = vault
        .owner_revision
        .checked_add(1)
        .ok_or(VaultError::ProofNotFresh)?;
    deposit.consumed = true;
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeFactory<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Factory::INIT_SPACE,
        seeds = [FACTORY_SEED, SCHEME_VERSION],
        bump
    )]
    pub factory: Account<'info, Factory>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FactoryAdmin<'info> {
    #[account(
        mut,
        seeds = [FACTORY_SEED, SCHEME_VERSION],
        bump = factory.bump,
        has_one = authority @ VaultError::Unauthorized
    )]
    pub factory: Account<'info, Factory>,
    pub authority: Signer<'info>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
#[instruction(identity_hash: [u8; 32])]
pub struct DeployVault<'info> {
    pub factory: Account<'info, Factory>,
    #[account(
        init,
        payer = payer,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, identity_hash.as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundSol<'info> {
    pub factory: Account<'info, Factory>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.identity_hash.as_ref()],
        bump = vault.bump,
        has_one = factory @ VaultError::WrongFactory
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        init,
        payer = funder,
        space = 8 + Deposit::INIT_SPACE,
        seeds = [DEPOSIT_SEED, vault.key().as_ref(), &vault.deposit_seq.to_le_bytes()],
        bump
    )]
    pub deposit: Account<'info, Deposit>,
    #[account(mut)]
    pub funder: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundToken<'info> {
    pub factory: Account<'info, Factory>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.identity_hash.as_ref()],
        bump = vault.bump,
        has_one = factory @ VaultError::WrongFactory
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        init,
        payer = funder,
        space = 8 + Deposit::INIT_SPACE,
        seeds = [DEPOSIT_SEED, vault.key().as_ref(), &vault.deposit_seq.to_le_bytes()],
        bump
    )]
    pub deposit: Account<'info, Deposit>,
    #[account(mut)]
    pub funder: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        constraint = funder_token_account.owner == funder.key() @ VaultError::Unauthorized,
        constraint = funder_token_account.mint == mint.key() @ VaultError::Unauthorized
    )]
    pub funder_token_account: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = funder,
        associated_token::mint = mint,
        associated_token::authority = vault
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct ClaimSol<'info> {
    pub factory: Account<'info, Factory>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.identity_hash.as_ref()],
        bump = vault.bump,
        has_one = factory @ VaultError::WrongFactory
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [DEPOSIT_SEED, vault.key().as_ref(), &id.to_le_bytes()],
        bump = deposit.bump,
        constraint = deposit.vault == vault.key() @ VaultError::WrongVault
    )]
    pub deposit: Account<'info, Deposit>,
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: pinned to the deposit verifier and factory allowlist in `check_proof`.
    pub verifier_program: UncheckedAccount<'info>,
    /// CHECK: validated against `factory.policy`.
    #[account(mut, constraint = policy.key() == factory.policy @ VaultError::Unauthorized)]
    pub policy: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct ClaimToken<'info> {
    pub factory: Account<'info, Factory>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.identity_hash.as_ref()],
        bump = vault.bump,
        has_one = factory @ VaultError::WrongFactory
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [DEPOSIT_SEED, vault.key().as_ref(), &id.to_le_bytes()],
        bump = deposit.bump,
        constraint = deposit.vault == vault.key() @ VaultError::WrongVault
    )]
    pub deposit: Account<'info, Deposit>,
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: pinned to the deposit verifier and factory allowlist in `check_proof`.
    pub verifier_program: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = owner
    )]
    pub owner_token_account: Account<'info, TokenAccount>,
    /// CHECK: validated as the policy ATA in the handler.
    #[account(mut)]
    pub policy_token_account: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct RefundSol<'info> {
    pub factory: Account<'info, Factory>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.identity_hash.as_ref()],
        bump = vault.bump,
        has_one = factory @ VaultError::WrongFactory
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [DEPOSIT_SEED, vault.key().as_ref(), &id.to_le_bytes()],
        bump = deposit.bump,
        constraint = deposit.vault == vault.key() @ VaultError::WrongVault
    )]
    pub deposit: Account<'info, Deposit>,
    #[account(mut)]
    pub caller: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct RefundToken<'info> {
    pub factory: Account<'info, Factory>,
    #[account(
        seeds = [VAULT_SEED, vault.identity_hash.as_ref()],
        bump = vault.bump,
        has_one = factory @ VaultError::WrongFactory
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [DEPOSIT_SEED, vault.key().as_ref(), &id.to_le_bytes()],
        bump = deposit.bump,
        constraint = deposit.vault == vault.key() @ VaultError::WrongVault
    )]
    pub deposit: Account<'info, Deposit>,
    #[account(mut)]
    pub caller: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = caller
    )]
    pub caller_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
