//! Test-only Token-2022 transfer hook: counts the transfers of a mint in a `Counter` PDA that the
//! token program must be handed on every transfer. Exists so the suite can prove the router and
//! policy carry a hook's extra accounts through their CPIs.
use anchor_lang::prelude::*;
use anchor_lang::system_program::{create_account, CreateAccount};
use spl_discriminator::SplDiscriminate;
use spl_tlv_account_resolution::{account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

declare_id!("ETVm4N6WjGkF8NVT8NYJvY54zKqaNuR1EPupuYrJvSV9");

pub const COUNTER_SEED: &[u8] = b"counter";
pub const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";

#[program]
pub mod test_hook {
    use super::*;

    /// Create the mint's ExtraAccountMetaList (one entry: the counter PDA, writable) and the counter.
    pub fn initialize_extra_account_meta_list(ctx: Context<InitializeExtraAccountMetaList>) -> Result<()> {
        let metas = [ExtraAccountMeta::new_with_seeds(
            &[Seed::Literal { bytes: COUNTER_SEED.to_vec() }, Seed::AccountKey { index: 1 }],
            false,
            true,
        )
        .map_err(|_| error!(HookError::Resolution))?];
        let size = ExtraAccountMetaList::size_of(metas.len()).map_err(|_| error!(HookError::Resolution))?;
        let mint = ctx.accounts.mint.key();
        let bump = [ctx.bumps.extra_account_meta_list];
        let seeds: &[&[u8]] = &[EXTRA_ACCOUNT_METAS_SEED, mint.as_ref(), &bump];
        create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.extra_account_meta_list.to_account_info(),
                },
                &[seeds],
            ),
            Rent::get()?.minimum_balance(size),
            size as u64,
            ctx.program_id,
        )?;
        let mut data = ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?;
        ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &metas).map_err(|_| error!(HookError::Resolution))?;
        Ok(())
    }

    /// The token program's Execute call: accounts are source, mint, destination, owner, the
    /// ExtraAccountMetaList, then the resolved extras (here the counter).
    pub fn fallback(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> Result<()> {
        require!(
            data.len() >= 8 && data[..8] == *ExecuteInstruction::SPL_DISCRIMINATOR_SLICE,
            HookError::UnknownInstruction
        );
        let counter = accounts.get(5).ok_or_else(|| error!(HookError::MissingCounter))?;
        require!(counter.owner == program_id, HookError::MissingCounter);
        let mut data = counter.try_borrow_mut_data()?;
        let transfers = u64::from_le_bytes(data[8..16].try_into().map_err(|_| error!(HookError::MissingCounter))?);
        data[8..16].copy_from_slice(&(transfers + 1).to_le_bytes());
        Ok(())
    }
}

#[account]
pub struct Counter {
    pub transfers: u64,
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: created here at the address the transfer-hook interface derives.
    #[account(mut, seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()], bump)]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    /// CHECK: any mint.
    pub mint: UncheckedAccount<'info>,
    #[account(init, payer = payer, space = 8 + 8, seeds = [COUNTER_SEED, mint.key().as_ref()], bump)]
    pub counter: Account<'info, Counter>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum HookError {
    #[msg("Unknown instruction")]
    UnknownInstruction,
    #[msg("Counter account missing")]
    MissingCounter,
    #[msg("Extra account meta resolution failed")]
    Resolution,
}
