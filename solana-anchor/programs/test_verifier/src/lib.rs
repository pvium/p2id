use anchor_lang::prelude::*;

anchor_lang::declare_id!("SgPm1N4qiMD7XfSQxrzZ1Yj9LQ4xWn44HAwhehfMFCJ");

#[program]
pub mod test_verifier {
    use super::*;

    pub fn noop(_ctx: Context<Noop>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Noop {}

#[cfg(feature = "custom-entrypoint")]
pub fn process_instruction(
    _program_id: &Pubkey,
    _accounts: &[AccountInfo],
    _instruction_data: &[u8],
) -> anchor_lang::solana_program::entrypoint::ProgramResult {
    Ok(())
}

#[cfg(feature = "custom-entrypoint")]
anchor_lang::solana_program::entrypoint!(process_instruction);
