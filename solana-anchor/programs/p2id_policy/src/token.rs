//! One token transfer for both token programs. `transfer_checked` is the only transfer Token-2022
//! accepts for every mint (transfer hooks require it), so it is used for classic SPL Token too.
//! When the mint carries a transfer hook, the hook's extra accounts are resolved on-chain from the
//! accounts the caller appended (`remaining_accounts`), exactly as the token program will resolve
//! them. The amount the destination actually gained is returned, which is less than `amount` for a
//! transfer-fee mint: callers record and book what arrived, never what was sent.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use spl_token_2022_interface::extension::{transfer_hook, StateWithExtensions};
use spl_token_2022_interface::state::Mint as MintState;
use spl_transfer_hook_interface::onchain::add_extra_accounts_for_execute_cpi;

/// Offset of `amount` in a token account's data, identical in both token programs.
const AMOUNT_OFFSET: usize = 64;

pub fn token_amount(account: &AccountInfo) -> Result<u64> {
    let data = account.try_borrow_data()?;
    let bytes: [u8; 8] = data
        .get(AMOUNT_OFFSET..AMOUNT_OFFSET + 8)
        .and_then(|s| s.try_into().ok())
        .ok_or(ProgramError::InvalidAccountData)?;
    Ok(u64::from_le_bytes(bytes))
}

#[allow(clippy::too_many_arguments)]
pub fn transfer_tokens<'info>(
    token_program: &AccountInfo<'info>,
    source: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    additional_accounts: &[AccountInfo<'info>],
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[&[u8]]],
) -> Result<u64> {
    if amount == 0 {
        return Ok(0);
    }
    let before = token_amount(destination)?;
    let mut instruction = spl_token_2022_interface::instruction::transfer_checked(
        token_program.key,
        source.key,
        mint.key,
        destination.key,
        authority.key,
        &[],
        amount,
        decimals,
    )?;
    let mut infos = vec![source.clone(), mint.clone(), destination.clone(), authority.clone()];
    let hook_program = {
        let data = mint.try_borrow_data()?;
        let state = StateWithExtensions::<MintState>::unpack(&data)?;
        transfer_hook::get_program_id(&state)
    };
    if let Some(hook_program) = hook_program {
        add_extra_accounts_for_execute_cpi(
            &mut instruction,
            &mut infos,
            &hook_program,
            source.clone(),
            mint.clone(),
            destination.clone(),
            authority.clone(),
            amount,
            additional_accounts,
        )?;
    }
    invoke_signed(&instruction, &infos, signer_seeds)?;
    Ok(token_amount(destination)?.saturating_sub(before))
}
