//! P2ID router: the one program that owns every `Factory`, `VerifierConfig`, `Vault`, `VaultMint`
//! and `Deposit` account and holds every balance. It is deployed once and made immutable, so the
//! code holding funds can never change. Everything that may evolve (how an identity proof is
//! verified, the owner-cache rules) lives in implementation programs, which the factory registers
//! behind a 14-day notice and a vault owner opts into per vault (EVM: proxy + registered
//! implementations). An implementation acts on a vault only through the gated instructions here,
//! signing with its authority PDA; the router applies the state change and enforces the funder
//! protections no implementation can waive: a deposit settles once, for exactly its amount, at the
//! fee quoted when it was funded, to an owner proven under the verifier the deposit pins, with its
//! constraint satisfied; and the refunder can always take an unconsumed deposit back after the window.
use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer as sol_transfer, Transfer as SolTransfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer as TokenTransfer};
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use p2id_policy::cpi::{self as policy_cpi, accounts as policy_accounts};

pub mod errors;
pub mod hash;
pub mod state;

use errors::RouterError;
use hash::{factory_params_hash, sha256};
use state::*;

declare_id!("4Xy1ad1x63e6o3dMgrEE2JvKtem2jQvqSV4tRaHmvuc3");

// ------------------------------------------------------------------ events (EVM IP2IDVault names)

#[event]
pub struct Funded {
    pub vault: Pubkey,
    pub id: u64,
    pub funder: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub verifier: Pubkey,
    pub constraint: [u8; 32],
    pub refund_window: i64,
    pub fee_bps: u16,
    pub reference: [u8; 32],
}

#[event]
pub struct Claimed {
    pub vault: Pubkey,
    pub id: u64,
    pub to: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub fee: u64,
}

#[event]
pub struct Refunded {
    pub vault: Pubkey,
    pub id: u64,
    pub to: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct OwnerRefreshed {
    pub vault: Pubkey,
    pub verifier: Pubkey,
    pub owner: Pubkey,
    pub iat: i64,
}

#[event]
pub struct UntrackedSwept {
    pub vault: Pubkey,
    pub to: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub fee: u64,
}

#[event]
pub struct ImplementationRegistered {
    pub factory: Pubkey,
    pub implementation: Pubkey,
    pub is_default: bool,
}

#[event]
pub struct VaultImplementationChanged {
    pub vault: Pubkey,
    pub implementation: Pubkey,
}

fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let from_lamports = from.lamports();
    let to_lamports = to.lamports();
    **from.try_borrow_mut_lamports()? = from_lamports
        .checked_sub(amount)
        .ok_or(RouterError::InvalidAmount)?;
    **to.try_borrow_mut_lamports()? = to_lamports
        .checked_add(amount)
        .ok_or(RouterError::InvalidAmount)?;
    Ok(())
}

#[program]
pub mod p2id_router {
    use super::*;

    // ------------------------------------------------------------------ factory

    /// Create the factory administered by `authority` with the given terms. The authority and a
    /// commitment to every other argument (`params_hash`, see `factory_params_hash`) are seeds of the
    /// factory PDA, so whoever submits this instruction and pays the rent can only create the factory
    /// with exactly these values; different values give an unrelated address. Nobody needs to sign
    /// but the payer. In production `authority` is a Squads multisig vault. `default_implementation`
    /// is registered at once and is what new vaults start on.
    #[allow(clippy::too_many_arguments)]
    pub fn initialize_factory(
        ctx: Context<InitializeFactory>,
        authority: Pubkey,
        params_hash: [u8; 32],
        signer_keys: Vec<[u8; SIGNER_KEY_LEN]>,
        default_verifier: Pubkey,
        policy: Pubkey,
        default_implementation: Pubkey,
        circuit_version: u16,
        vk_hash: [u8; 32],
        min_refund_window: i64,
        max_refund_window: i64,
    ) -> Result<()> {
        require!(
            params_hash
                == factory_params_hash(
                    &signer_keys,
                    &default_verifier,
                    &policy,
                    &default_implementation,
                    circuit_version,
                    &vk_hash,
                    min_refund_window,
                    max_refund_window
                ),
            RouterError::InvalidFactoryParams
        );
        validate_signer_keys(&signer_keys)?;
        require!(policy != Pubkey::default(), RouterError::InvalidPolicy);
        require!(default_implementation != Pubkey::default(), RouterError::InvalidImplementation);
        require!(
            min_refund_window > 0 && min_refund_window <= max_refund_window,
            RouterError::InvalidRefundWindow
        );

        let factory = &mut ctx.accounts.factory;
        factory.version = ACCOUNT_VERSION;
        factory.authority = authority;
        factory.seed_authority = authority;
        factory.params_hash = params_hash;
        factory.pending_authority = None;
        factory.scheme_version = scheme_version_bytes();
        factory.ns_hash = sha256(&[SCHEME_VERSION]);
        factory.default_verifier = default_verifier;
        factory.proposed_verifier = Pubkey::default();
        factory.proposed_verifier_eta = 0;
        factory.policy = policy;
        factory.proposed_policy = Pubkey::default();
        factory.proposed_policy_eta = 0;
        factory.policy_change_delay = DEFAULT_VERIFIER_DELAY;
        factory.verifier_change_delay = DEFAULT_VERIFIER_DELAY;
        factory.min_refund_window = min_refund_window;
        factory.max_refund_window = max_refund_window;
        factory.default_implementation = default_implementation;
        factory.implementations = vec![default_implementation];
        factory.proposed_implementation = Pubkey::default();
        factory.proposed_implementation_eta = 0;
        factory.proposed_implementation_make_default = false;
        factory.implementation_change_delay = DEFAULT_VERIFIER_DELAY;
        factory.bump = ctx.bumps.factory;
        factory._reserved = [0u8; RESERVED_LEN];

        let factory_key = factory.key();
        init_verifier_config(
            &mut ctx.accounts.verifier_config,
            factory_key,
            default_verifier,
            true,
            circuit_version,
            vk_hash,
            signer_keys,
            ctx.bumps.verifier_config,
        );
        emit!(ImplementationRegistered { factory: factory_key, implementation: default_implementation, is_default: true });
        Ok(())
    }

    /// Two-step authority transfer (EVM transferOwnership / acceptOwnership).
    pub fn transfer_authority(ctx: Context<FactoryAdmin>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.factory.pending_authority = Some(new_authority);
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        let factory = &mut ctx.accounts.factory;
        require!(
            factory.pending_authority == Some(ctx.accounts.new_authority.key()),
            RouterError::NotPendingAuthority
        );
        factory.authority = ctx.accounts.new_authority.key();
        factory.pending_authority = None;
        Ok(())
    }

    // ------------------------------------------------------------------ implementations

    /// Announce an implementation program (EVM proposeImplementation). Registrable after the notice;
    /// replaces any pending proposal. With `make_default`, registration also makes it what new vaults
    /// start on.
    pub fn propose_implementation(ctx: Context<FactoryAdmin>, program: Pubkey, make_default: bool) -> Result<()> {
        require!(program != Pubkey::default(), RouterError::InvalidImplementation);
        let factory = &mut ctx.accounts.factory;
        factory.proposed_implementation = program;
        factory.proposed_implementation_make_default = make_default;
        factory.proposed_implementation_eta = ctx
            .accounts
            .clock
            .unix_timestamp
            .checked_add(factory.implementation_change_delay)
            .ok_or(RouterError::ImplementationChangeNotReady)?;
        Ok(())
    }

    /// EVM registerImplementation: after the notice, vault owners may move to it.
    pub fn register_implementation(ctx: Context<FactoryAdmin>) -> Result<()> {
        let factory = &mut ctx.accounts.factory;
        require!(factory.proposed_implementation_eta != 0, RouterError::NoImplementationProposed);
        require!(
            ctx.accounts.clock.unix_timestamp >= factory.proposed_implementation_eta,
            RouterError::ImplementationChangeNotReady
        );
        let program = factory.proposed_implementation;
        if !factory.implementations.contains(&program) {
            require!(
                factory.implementations.len() < MAX_IMPLEMENTATIONS,
                RouterError::TooManyImplementations
            );
            factory.implementations.push(program);
        }
        let is_default = factory.proposed_implementation_make_default;
        if is_default {
            factory.default_implementation = program;
        }
        factory.proposed_implementation = Pubkey::default();
        factory.proposed_implementation_eta = 0;
        factory.proposed_implementation_make_default = false;
        emit!(ImplementationRegistered { factory: factory.key(), implementation: program, is_default });
        Ok(())
    }

    pub fn cancel_implementation_proposal(ctx: Context<FactoryAdmin>) -> Result<()> {
        let factory = &mut ctx.accounts.factory;
        require!(factory.proposed_implementation_eta != 0, RouterError::NoImplementationProposed);
        factory.proposed_implementation = Pubkey::default();
        factory.proposed_implementation_eta = 0;
        factory.proposed_implementation_make_default = false;
        Ok(())
    }

    /// Make an already registered implementation the default for new vaults, immediately: it has
    /// had its notice when it was registered.
    pub fn set_default_implementation(ctx: Context<FactoryAdmin>, program: Pubkey) -> Result<()> {
        let factory = &mut ctx.accounts.factory;
        require!(factory.implementations.contains(&program), RouterError::ImplementationNotRegistered);
        factory.default_implementation = program;
        Ok(())
    }

    // ------------------------------------------------------------------ verifiers, policy, keys

    /// Announce a new default verifier (a new circuit version), creating its VerifierConfig with
    /// the circuit it verifies and the Privy keys it accepts (EVM: deploying PviumIdentity +
    /// PviumVerifier, then proposeDefaultVerifier). Activatable after the notice. Re-proposing a
    /// verifier that already has a config keeps that config.
    pub fn propose_verifier(
        ctx: Context<ProposeVerifier>,
        verifier: Pubkey,
        circuit_version: u16,
        vk_hash: [u8; 32],
        signer_keys: Vec<[u8; SIGNER_KEY_LEN]>,
    ) -> Result<()> {
        require!(verifier != Pubkey::default(), RouterError::VerifierNotAllowed);
        if ctx.accounts.verifier_config.factory == Pubkey::default() {
            validate_signer_keys(&signer_keys)?;
            let factory_key = ctx.accounts.factory.key();
            init_verifier_config(
                &mut ctx.accounts.verifier_config,
                factory_key,
                verifier,
                false,
                circuit_version,
                vk_hash,
                signer_keys,
                ctx.bumps.verifier_config,
            );
        }
        let factory = &mut ctx.accounts.factory;
        factory.proposed_verifier = verifier;
        factory.proposed_verifier_eta = ctx
            .accounts
            .clock
            .unix_timestamp
            .checked_add(factory.verifier_change_delay)
            .ok_or(RouterError::VerifierChangeNotReady)?;
        Ok(())
    }

    pub fn activate_verifier(ctx: Context<ActivateVerifier>) -> Result<()> {
        let factory = &mut ctx.accounts.factory;
        require!(
            factory.proposed_verifier != Pubkey::default(),
            RouterError::NoVerifierProposed
        );
        require!(
            ctx.accounts.clock.unix_timestamp >= factory.proposed_verifier_eta,
            RouterError::VerifierChangeNotReady
        );
        let proposed = factory.proposed_verifier;
        ctx.accounts.verifier_config.allowed = true;
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

    /// Stop accepting a verifier immediately (EVM policy.approveVerifier(v, false)). The default
    /// verifier cannot be revoked: propose and activate another one first. Deposits pinned to a
    /// revoked verifier can only be refunded.
    pub fn revoke_verifier(ctx: Context<VerifierAdmin>) -> Result<()> {
        let config = &mut ctx.accounts.verifier_config;
        require!(config.verifier != ctx.accounts.factory.default_verifier, RouterError::CannotRevokeDefault);
        require!(config.allowed, RouterError::VerifierNotAllowed);
        config.allowed = false;
        Ok(())
    }

    /// Announce a new policy (a PolicyConfig account; a new rate is a new address). Takes effect after
    /// `policy_change_delay` via activate_policy; replaces any pending proposal. Deposits keep the rate
    /// they were funded with; fees at settlement go to the policy live then (EVM proposePolicy).
    pub fn propose_policy(ctx: Context<FactoryAdmin>, policy: Pubkey) -> Result<()> {
        require!(policy != Pubkey::default(), RouterError::InvalidPolicy);
        let factory = &mut ctx.accounts.factory;
        factory.proposed_policy = policy;
        factory.proposed_policy_eta = ctx
            .accounts
            .clock
            .unix_timestamp
            .checked_add(factory.policy_change_delay)
            .ok_or(RouterError::PolicyChangeNotReady)?;
        Ok(())
    }

    pub fn activate_policy(ctx: Context<FactoryAdmin>) -> Result<()> {
        let factory = &mut ctx.accounts.factory;
        require!(factory.proposed_policy_eta != 0, RouterError::NoPolicyProposed);
        require!(
            ctx.accounts.clock.unix_timestamp >= factory.proposed_policy_eta,
            RouterError::PolicyChangeNotReady
        );
        factory.policy = factory.proposed_policy;
        factory.proposed_policy = Pubkey::default();
        factory.proposed_policy_eta = 0;
        Ok(())
    }

    pub fn cancel_policy_proposal(ctx: Context<FactoryAdmin>) -> Result<()> {
        let factory = &mut ctx.accounts.factory;
        require!(factory.proposed_policy_eta != 0, RouterError::NoPolicyProposed);
        factory.proposed_policy = Pubkey::default();
        factory.proposed_policy_eta = 0;
        Ok(())
    }

    /// Announce an additional token-signing key (Privy rotation). Activatable after SIGNER_KEY_DELAY;
    /// replaces any pending key proposal.
    pub fn propose_signer_key(ctx: Context<VerifierAdmin>, key: [u8; SIGNER_KEY_LEN]) -> Result<()> {
        require!(key.iter().any(|b| *b != 0), RouterError::InvalidSignerKey);
        let config = &mut ctx.accounts.verifier_config;
        require!(!config.signer_keys.contains(&key), RouterError::SignerKeyAlreadyAccepted);
        require!(config.signer_keys.len() < MAX_SIGNER_KEYS, RouterError::TooManySignerKeys);
        config.proposed_signer_key = key;
        config.proposed_signer_key_eta = ctx
            .accounts
            .clock
            .unix_timestamp
            .checked_add(SIGNER_KEY_DELAY)
            .ok_or(RouterError::SignerKeyChangeNotReady)?;
        Ok(())
    }

    pub fn activate_signer_key(ctx: Context<VerifierAdmin>) -> Result<()> {
        let config = &mut ctx.accounts.verifier_config;
        require!(config.proposed_signer_key_eta != 0, RouterError::NoSignerKeyProposed);
        require!(
            ctx.accounts.clock.unix_timestamp >= config.proposed_signer_key_eta,
            RouterError::SignerKeyChangeNotReady
        );
        let key = config.proposed_signer_key;
        require!(!config.signer_keys.contains(&key), RouterError::SignerKeyAlreadyAccepted);
        require!(config.signer_keys.len() < MAX_SIGNER_KEYS, RouterError::TooManySignerKeys);
        config.signer_keys.push(key);
        config.proposed_signer_key = [0u8; SIGNER_KEY_LEN];
        config.proposed_signer_key_eta = 0;
        Ok(())
    }

    pub fn cancel_signer_key_proposal(ctx: Context<VerifierAdmin>) -> Result<()> {
        let config = &mut ctx.accounts.verifier_config;
        require!(config.proposed_signer_key_eta != 0, RouterError::NoSignerKeyProposed);
        config.proposed_signer_key = [0u8; SIGNER_KEY_LEN];
        config.proposed_signer_key_eta = 0;
        Ok(())
    }

    /// Stop accepting a key immediately (compromise or retirement) and bump key_set_revision.
    /// The last key may be removed; the verifier then rejects every proof until a key is added.
    pub fn remove_signer_key(ctx: Context<VerifierAdmin>, key: [u8; SIGNER_KEY_LEN]) -> Result<()> {
        let config = &mut ctx.accounts.verifier_config;
        let before = config.signer_keys.len();
        config.signer_keys.retain(|k| *k != key);
        require!(config.signer_keys.len() < before, RouterError::UnknownSignerKey);
        config.key_set_revision = config
            .key_set_revision
            .checked_add(1)
            .ok_or(RouterError::UnknownSignerKey)?;
        Ok(())
    }

    /// Add or remove an ed25519 constraint signer, effective immediately (EVM setConstraintSigner).
    pub fn set_constraint_signer(ctx: Context<VerifierAdmin>, signer: Pubkey, allowed: bool) -> Result<()> {
        require!(signer != Pubkey::default(), RouterError::Unauthorized);
        let config = &mut ctx.accounts.verifier_config;
        if allowed {
            if !config.constraint_signers.contains(&signer) {
                require!(
                    config.constraint_signers.len() < MAX_CONSTRAINT_SIGNERS,
                    RouterError::TooManyConstraintSigners
                );
                config.constraint_signers.push(signer);
            }
        } else {
            config.constraint_signers.retain(|s| *s != signer);
        }
        Ok(())
    }

    // ------------------------------------------------------------------ vaults (direct)

    /// Create the vault PDA for `identity_hash` under `factory`; permissionless, the payer only funds
    /// rent. The vault starts on the factory's default implementation.
    pub fn deploy_vault(ctx: Context<DeployVault>, identity_hash: [u8; 32]) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.version = ACCOUNT_VERSION;
        vault.factory = ctx.accounts.factory.key();
        vault.identity_hash = identity_hash;
        vault.ns_hash = ctx.accounts.factory.ns_hash;
        vault.owner = Pubkey::default();
        vault.latest_proof_iat = 0;
        vault.owner_revision = 0;
        vault.owner_verifier = Pubkey::default();
        vault.owner_key_set_revision = 0;
        vault.deposit_seq = 0;
        vault.tracked_sol = 0;
        vault.implementation = ctx.accounts.factory.default_implementation;
        vault.bump = ctx.bumps.vault;
        vault._reserved = [0u8; RESERVED_LEN];
        Ok(())
    }

    /// The cached owner moves their vault to another registered implementation (EVM: the owner
    /// upgrading their proxy). Requires a current owner cache: refresh the proof through the current
    /// implementation first if it is stale.
    pub fn set_vault_implementation(ctx: Context<SetVaultImplementation>, implementation: Pubkey) -> Result<()> {
        require!(
            ctx.accounts.factory.implementations.contains(&implementation),
            RouterError::ImplementationNotRegistered
        );
        let vault = &ctx.accounts.vault;
        require_current_cache(&ctx.accounts.verifier_config, vault, &ctx.accounts.owner.key(), vault.owner_verifier)?;
        let vault = &mut ctx.accounts.vault;
        vault.implementation = implementation;
        emit!(VaultImplementationChanged { vault: vault.key(), implementation });
        Ok(())
    }

    /// Return an unconsumed SOL deposit to its refunder after the refund window: the named refunder
    /// if the deposit has one, else the funder. Direct, so no implementation can withhold it.
    pub fn refund_sol(ctx: Context<RefundSol>, id: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let deposit = &mut ctx.accounts.deposit;
        require!(deposit.id == id, RouterError::WrongVault);
        validate_refund(deposit, &ctx.accounts.caller.key(), now)?;
        require!(deposit.is_sol(), RouterError::WrongMint);

        move_lamports(&ctx.accounts.vault.to_account_info(), &ctx.accounts.caller.to_account_info(), deposit.amount)?;
        deposit.consumed = true;
        let vault = &mut ctx.accounts.vault;
        vault.tracked_sol = vault.tracked_sol.checked_sub(deposit.amount).ok_or(RouterError::InvalidAmount)?;
        emit!(Refunded { vault: vault.key(), id, to: ctx.accounts.caller.key(), mint: Pubkey::default(), amount: deposit.amount });
        Ok(())
    }

    pub fn refund_token(ctx: Context<RefundToken>, id: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let deposit = &mut ctx.accounts.deposit;
        require!(deposit.id == id, RouterError::WrongVault);
        validate_refund(deposit, &ctx.accounts.caller.key(), now)?;
        require!(deposit.mint == ctx.accounts.mint.key(), RouterError::WrongMint);

        let seeds = vault_seeds(&ctx.accounts.vault);
        transfer_from_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.vault_token_account,
            &ctx.accounts.caller_token_account,
            &ctx.accounts.vault,
            &seeds,
            deposit.amount,
        )?;
        deposit.consumed = true;
        let vault_mint = &mut ctx.accounts.vault_mint;
        vault_mint.tracked = vault_mint.tracked.checked_sub(deposit.amount).ok_or(RouterError::InvalidAmount)?;
        emit!(Refunded {
            vault: ctx.accounts.vault.key(),
            id,
            to: ctx.accounts.caller.key(),
            mint: ctx.accounts.mint.key(),
            amount: deposit.amount,
        });
        Ok(())
    }

    /// Pay SOL that reached the vault outside any deposit record to the cached owner (EVM
    /// sweepUntracked). Anyone may submit it; requires a current owner cache under the default
    /// verifier; the current policy rate applies.
    pub fn sweep_untracked_sol(ctx: Context<SweepUntrackedSol>) -> Result<()> {
        let factory = &ctx.accounts.factory;
        let vault = &ctx.accounts.vault;
        require_current_cache(&ctx.accounts.verifier_config, vault, &ctx.accounts.owner.key(), factory.default_verifier)?;
        let info = vault.to_account_info();
        let rent = Rent::get()?.minimum_balance(info.data_len());
        let reserved = rent.checked_add(vault.tracked_sol).ok_or(RouterError::InvalidAmount)?;
        let amount = info.lamports().saturating_sub(reserved);
        require!(amount > 0, RouterError::NothingToSweep);
        let fee_bps = quote_fee(&ctx.accounts.policy_program, &ctx.accounts.policy, factory.default_verifier, Pubkey::default())?;
        let fee = fee_for(amount, fee_bps);
        let net = amount.checked_sub(fee).ok_or(RouterError::InvalidAmount)?;
        move_lamports(&info, &ctx.accounts.policy.to_account_info(), fee)?;
        collect_fee_sol(
            &ctx.accounts.policy_program,
            &ctx.accounts.policy,
            &ctx.accounts.factory,
            &ctx.accounts.vault,
            factory.default_verifier,
            ctx.accounts.owner.key(),
            fee,
        )?;
        move_lamports(&info, &ctx.accounts.owner.to_account_info(), net)?;
        emit!(UntrackedSwept { vault: vault.key(), to: ctx.accounts.owner.key(), mint: Pubkey::default(), amount, fee });
        Ok(())
    }

    /// Pay tokens that reached the vault's ATA outside any deposit record to the cached owner.
    pub fn sweep_untracked_token(ctx: Context<SweepUntrackedToken>) -> Result<()> {
        let factory = &ctx.accounts.factory;
        require_current_cache(&ctx.accounts.verifier_config, &ctx.accounts.vault, &ctx.accounts.owner.key(), factory.default_verifier)?;
        init_vault_mint(&mut ctx.accounts.vault_mint, ctx.accounts.vault.key(), ctx.accounts.mint.key(), ctx.bumps.vault_mint);
        let amount = ctx
            .accounts
            .vault_token_account
            .amount
            .saturating_sub(ctx.accounts.vault_mint.tracked);
        require!(amount > 0, RouterError::NothingToSweep);
        let fee_bps = quote_fee(&ctx.accounts.policy_program, &ctx.accounts.policy, factory.default_verifier, ctx.accounts.mint.key())?;
        let fee = fee_for(amount, fee_bps);
        let net = amount.checked_sub(fee).ok_or(RouterError::InvalidAmount)?;
        let seeds = vault_seeds(&ctx.accounts.vault);
        transfer_from_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.vault_token_account,
            &ctx.accounts.owner_token_account,
            &ctx.accounts.vault,
            &seeds,
            net,
        )?;
        transfer_from_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.vault_token_account,
            &ctx.accounts.policy_token_account,
            &ctx.accounts.vault,
            &seeds,
            fee,
        )?;
        collect_fee_token(
            &ctx.accounts.policy_program,
            &ctx.accounts.policy,
            &ctx.accounts.policy_mint,
            &ctx.accounts.factory,
            &ctx.accounts.vault,
            &ctx.accounts.payer,
            &ctx.accounts.mint,
            &ctx.accounts.policy_token_account,
            &ctx.accounts.system_program,
            factory.default_verifier,
            ctx.accounts.owner.key(),
            fee,
        )?;
        emit!(UntrackedSwept {
            vault: ctx.accounts.vault.key(),
            to: ctx.accounts.owner.key(),
            mint: ctx.accounts.mint.key(),
            amount,
            fee,
        });
        Ok(())
    }

    // ------------------------------------------------------------------ vaults (implementation-gated)

    /// Record a SOL deposit on behalf of the vault's implementation (which passes the funder's
    /// signature through). The verifier is whichever allowed config is passed; the fee rate is
    /// quoted from the policy now and frozen into the deposit.
    pub fn create_deposit_sol(
        ctx: Context<CreateDepositSol>,
        amount: u64,
        constraint: [u8; 32],
        refund_window: i64,
        refunder: Option<Pubkey>,
        reference: [u8; 32],
    ) -> Result<()> {
        require_implementation(&ctx.accounts.vault, &ctx.accounts.impl_authority)?;
        let now = Clock::get()?.unix_timestamp;
        let id = ctx.accounts.vault.deposit_seq;
        let fee_bps = quote_fee(
            &ctx.accounts.policy_program,
            &ctx.accounts.policy,
            ctx.accounts.verifier_config.verifier,
            Pubkey::default(),
        )?;
        populate_deposit(
            &mut ctx.accounts.deposit,
            &ctx.accounts.vault,
            &ctx.accounts.factory,
            &ctx.accounts.verifier_config,
            DepositTerms {
                id,
                fee_bps,
                funder: ctx.accounts.funder.key(),
                mint: Pubkey::default(),
                amount,
                constraint,
                refund_window,
                funded_at: now,
                refunder,
                reference,
            },
            ctx.bumps.deposit,
        )?;

        sol_transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                SolTransfer {
                    from: ctx.accounts.funder.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            amount,
        )?;

        let vault = &mut ctx.accounts.vault;
        vault.deposit_seq = id.checked_add(1).ok_or(RouterError::InvalidAmount)?;
        vault.tracked_sol = vault.tracked_sol.checked_add(amount).ok_or(RouterError::InvalidAmount)?;
        emit_funded(&ctx.accounts.deposit, vault.key());
        Ok(())
    }

    /// Record an SPL-token deposit; same terms as create_deposit_sol.
    pub fn create_deposit_token(
        ctx: Context<CreateDepositToken>,
        amount: u64,
        constraint: [u8; 32],
        refund_window: i64,
        refunder: Option<Pubkey>,
        reference: [u8; 32],
    ) -> Result<()> {
        require_implementation(&ctx.accounts.vault, &ctx.accounts.impl_authority)?;
        let now = Clock::get()?.unix_timestamp;
        let id = ctx.accounts.vault.deposit_seq;
        let fee_bps = quote_fee(
            &ctx.accounts.policy_program,
            &ctx.accounts.policy,
            ctx.accounts.verifier_config.verifier,
            ctx.accounts.mint.key(),
        )?;
        populate_deposit(
            &mut ctx.accounts.deposit,
            &ctx.accounts.vault,
            &ctx.accounts.factory,
            &ctx.accounts.verifier_config,
            DepositTerms {
                id,
                fee_bps,
                funder: ctx.accounts.funder.key(),
                mint: ctx.accounts.mint.key(),
                amount,
                constraint,
                refund_window,
                funded_at: now,
                refunder,
                reference,
            },
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

        init_vault_mint(&mut ctx.accounts.vault_mint, ctx.accounts.vault.key(), ctx.accounts.mint.key(), ctx.bumps.vault_mint);
        let vault_mint = &mut ctx.accounts.vault_mint;
        vault_mint.tracked = vault_mint.tracked.checked_add(amount).ok_or(RouterError::InvalidAmount)?;

        let vault = &mut ctx.accounts.vault;
        vault.deposit_seq = id.checked_add(1).ok_or(RouterError::InvalidAmount)?;
        emit_funded(&ctx.accounts.deposit, vault.key());
        Ok(())
    }

    /// Record the wallet an identity proof names, after the implementation verified that proof
    /// under `verifier_config`'s verifier (EVM refreshProof). Never moves funds.
    pub fn set_owner_cache(ctx: Context<SetOwnerCache>, update: OwnerUpdate) -> Result<()> {
        require_implementation(&ctx.accounts.vault, &ctx.accounts.impl_authority)?;
        require!(ctx.accounts.verifier_config.allowed, RouterError::VerifierNotAllowed);
        apply_owner_update(&mut ctx.accounts.vault, update, &ctx.accounts.verifier_config)
    }

    /// Pay SOL deposit `id` to the vault's owner: after applying `owner_update` if the implementation
    /// verified a proof, or the cached owner as is. The router enforces what no implementation may
    /// waive: the deposit is unconsumed, the owner was proven under the verifier the deposit pins and
    /// under the present signer-key set, the constraint (if any) is attested earlier in this
    /// transaction, and the payout is the amount less the fee frozen at funding.
    pub fn settle_sol(ctx: Context<SettleSol>, id: u64, owner_update: Option<OwnerUpdate>) -> Result<()> {
        require_implementation(&ctx.accounts.vault, &ctx.accounts.impl_authority)?;
        require!(ctx.accounts.deposit.id == id, RouterError::WrongVault);
        require!(ctx.accounts.deposit.is_sol(), RouterError::WrongMint);
        authorize_settlement(
            &ctx.accounts.factory,
            &ctx.accounts.verifier_config,
            &mut ctx.accounts.vault,
            &ctx.accounts.deposit,
            &ctx.accounts.owner.key(),
            &ctx.accounts.instructions,
            owner_update,
        )?;

        let amount = ctx.accounts.deposit.amount;
        let fee = fee_for(amount, ctx.accounts.deposit.fee_bps);
        let net = amount.checked_sub(fee).ok_or(RouterError::InvalidAmount)?;
        // Fee first, then the payout: the runtime checks lamport balance over the accounts passed to a
        // CPI, so the owner (not passed to the policy) must be credited after the policy call.
        move_lamports(&ctx.accounts.vault.to_account_info(), &ctx.accounts.policy.to_account_info(), fee)?;
        let verifier = ctx.accounts.deposit.verifier;
        collect_fee_sol(
            &ctx.accounts.policy_program,
            &ctx.accounts.policy,
            &ctx.accounts.factory,
            &ctx.accounts.vault,
            verifier,
            ctx.accounts.owner.key(),
            fee,
        )?;
        move_lamports(&ctx.accounts.vault.to_account_info(), &ctx.accounts.owner.to_account_info(), net)?;

        let vault = &mut ctx.accounts.vault;
        vault.tracked_sol = vault.tracked_sol.checked_sub(amount).ok_or(RouterError::InvalidAmount)?;
        ctx.accounts.deposit.consumed = true;
        emit!(Claimed { vault: vault.key(), id, to: ctx.accounts.owner.key(), mint: Pubkey::default(), amount, fee });
        Ok(())
    }

    /// Pay SPL-token deposit `id` to the owner's associated token account (created if needed, rent
    /// paid by `payer`). Same authorization as settle_sol.
    pub fn settle_token(ctx: Context<SettleToken>, id: u64, owner_update: Option<OwnerUpdate>) -> Result<()> {
        require_implementation(&ctx.accounts.vault, &ctx.accounts.impl_authority)?;
        require!(ctx.accounts.deposit.id == id, RouterError::WrongVault);
        require!(ctx.accounts.deposit.mint == ctx.accounts.mint.key(), RouterError::WrongMint);
        authorize_settlement(
            &ctx.accounts.factory,
            &ctx.accounts.verifier_config,
            &mut ctx.accounts.vault,
            &ctx.accounts.deposit,
            &ctx.accounts.owner.key(),
            &ctx.accounts.instructions,
            owner_update,
        )?;

        let amount = ctx.accounts.deposit.amount;
        let fee = fee_for(amount, ctx.accounts.deposit.fee_bps);
        let net = amount.checked_sub(fee).ok_or(RouterError::InvalidAmount)?;
        let seeds = vault_seeds(&ctx.accounts.vault);
        transfer_from_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.vault_token_account,
            &ctx.accounts.owner_token_account,
            &ctx.accounts.vault,
            &seeds,
            net,
        )?;
        transfer_from_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.vault_token_account,
            &ctx.accounts.policy_token_account,
            &ctx.accounts.vault,
            &seeds,
            fee,
        )?;
        let verifier = ctx.accounts.deposit.verifier;
        collect_fee_token(
            &ctx.accounts.policy_program,
            &ctx.accounts.policy,
            &ctx.accounts.policy_mint,
            &ctx.accounts.factory,
            &ctx.accounts.vault,
            &ctx.accounts.payer,
            &ctx.accounts.mint,
            &ctx.accounts.policy_token_account,
            &ctx.accounts.system_program,
            verifier,
            ctx.accounts.owner.key(),
            fee,
        )?;

        let vault_mint = &mut ctx.accounts.vault_mint;
        vault_mint.tracked = vault_mint.tracked.checked_sub(amount).ok_or(RouterError::InvalidAmount)?;
        ctx.accounts.deposit.consumed = true;
        emit!(Claimed {
            vault: ctx.accounts.vault.key(),
            id,
            to: ctx.accounts.owner.key(),
            mint: ctx.accounts.mint.key(),
            amount,
            fee,
        });
        Ok(())
    }
}

// ------------------------------------------------------------------ internals

struct DepositTerms {
    id: u64,
    fee_bps: u16,
    funder: Pubkey,
    mint: Pubkey,
    amount: u64,
    constraint: [u8; 32],
    refund_window: i64,
    funded_at: i64,
    refunder: Option<Pubkey>,
    reference: [u8; 32],
}

/// The caller of a gated instruction must be the authority PDA of the implementation the vault is
/// on: `find_program_address([IMPL_AUTHORITY_SEED], vault.implementation)`, signed via invoke_signed.
fn require_implementation(vault: &Account<'_, Vault>, impl_authority: &Signer<'_>) -> Result<()> {
    let (expected, _) = Pubkey::find_program_address(&[IMPL_AUTHORITY_SEED], &vault.implementation);
    require!(impl_authority.key() == expected, RouterError::NotImplementation);
    Ok(())
}

fn validate_signer_keys(signer_keys: &[[u8; SIGNER_KEY_LEN]]) -> Result<()> {
    require!(!signer_keys.is_empty(), RouterError::NoSignerKeys);
    require!(signer_keys.len() <= MAX_SIGNER_KEYS, RouterError::TooManySignerKeys);
    for (i, key) in signer_keys.iter().enumerate() {
        require!(key.iter().any(|b| *b != 0), RouterError::InvalidSignerKey);
        require!(!signer_keys[..i].contains(key), RouterError::SignerKeyAlreadyAccepted);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn init_verifier_config(
    config: &mut Account<'_, VerifierConfig>,
    factory: Pubkey,
    verifier: Pubkey,
    allowed: bool,
    circuit_version: u16,
    vk_hash: [u8; 32],
    signer_keys: Vec<[u8; SIGNER_KEY_LEN]>,
    bump: u8,
) {
    config.version = ACCOUNT_VERSION;
    config.factory = factory;
    config.verifier = verifier;
    config.allowed = allowed;
    config.circuit_version = circuit_version;
    config.vk_hash = vk_hash;
    config.signer_keys = signer_keys;
    config.proposed_signer_key = [0u8; SIGNER_KEY_LEN];
    config.proposed_signer_key_eta = 0;
    config.key_set_revision = 0;
    config.constraint_signers = Vec::new();
    config.bump = bump;
    config._reserved = [0u8; 64];
}

fn populate_deposit(
    deposit: &mut Account<'_, Deposit>,
    vault: &Account<'_, Vault>,
    factory: &Account<'_, Factory>,
    verifier_config: &Account<'_, VerifierConfig>,
    t: DepositTerms,
    bump: u8,
) -> Result<()> {
    require!(t.amount > 0, RouterError::InvalidAmount);
    require!(
        t.refund_window >= factory.min_refund_window && t.refund_window <= factory.max_refund_window,
        RouterError::InvalidRefundWindow
    );
    // P2IDVaultV2 fundWith: any verifier the factory allows, pinned by the deposit; clients pass the
    // default verifier's config for plain fund().
    require!(
        verifier_config.factory == factory.key() && verifier_config.allowed,
        RouterError::VerifierNotAllowed
    );
    // A constrained deposit is only claimable with one of this verifier's constraint signers; refuse
    // to record one nobody could release (EVM: nonzero constraint needs verifier.supportsConstraints()).
    if t.constraint != [0u8; 32] {
        require!(!verifier_config.constraint_signers.is_empty(), RouterError::ConstraintsUnsupported);
    }

    deposit.version = ACCOUNT_VERSION;
    deposit.vault = vault.key();
    deposit.id = t.id;
    deposit.funder = t.funder;
    deposit.mint = t.mint;
    deposit.amount = t.amount;
    deposit.verifier = verifier_config.verifier;
    deposit.fee_bps = t.fee_bps.min(MAX_FEE_BPS);
    deposit.constraint = t.constraint;
    deposit.refund_window = t.refund_window;
    deposit.funded_at = t.funded_at;
    deposit.consumed = false;
    deposit.refunder = t.refunder;
    deposit.reference = t.reference;
    deposit.bump = bump;
    deposit._reserved = [0u8; 32];
    Ok(())
}

fn emit_funded(deposit: &Deposit, vault: Pubkey) {
    emit!(Funded {
        vault,
        id: deposit.id,
        funder: deposit.funder,
        mint: deposit.mint,
        amount: deposit.amount,
        verifier: deposit.verifier,
        constraint: deposit.constraint,
        refund_window: deposit.refund_window,
        fee_bps: deposit.fee_bps,
        reference: deposit.reference,
    });
}

fn init_vault_mint(vault_mint: &mut Account<'_, VaultMint>, vault: Pubkey, mint: Pubkey, bump: u8) {
    if vault_mint.vault == Pubkey::default() {
        vault_mint.version = ACCOUNT_VERSION;
        vault_mint.vault = vault;
        vault_mint.mint = mint;
        vault_mint.tracked = 0;
        vault_mint.bump = bump;
        vault_mint._reserved = [0u8; 32];
    }
}

/// IP2IDPolicy.feeBps: the rate the policy quotes for (verifier, mint), clamped to the factory ceiling.
fn quote_fee<'info>(
    policy_program: &UncheckedAccount<'info>,
    policy: &UncheckedAccount<'info>,
    verifier: Pubkey,
    mint: Pubkey,
) -> Result<u16> {
    let cpi = CpiContext::new(
        policy_program.key(),
        policy_accounts::QuoteFee { policy: policy.to_account_info() },
    );
    let quoted = policy_cpi::quote_fee(cpi, verifier, mint)?.get();
    Ok(quoted.min(MAX_FEE_BPS))
}

/// IP2IDPolicy.collectFee for SOL: after transferring `fee` to the policy, tell it what arrived, signed
/// as this vault. Nothing is sent for a zero fee. Unlike EVM, a failing policy fails the settlement (a
/// CPI error cannot be caught), so the policy's booking does nothing but verify receipt and count.
fn collect_fee_sol<'info>(
    policy_program: &UncheckedAccount<'info>,
    policy: &UncheckedAccount<'info>,
    factory: &Account<'info, Factory>,
    vault: &Account<'info, Vault>,
    verifier: Pubkey,
    claimer: Pubkey,
    fee: u64,
) -> Result<()> {
    if fee == 0 {
        return Ok(());
    }
    let seeds = vault_seeds(vault);
    let bump = [vault.bump];
    let signer: &[&[u8]] = &[VAULT_SEED, &seeds[0], &seeds[1], &bump];
    let signers = [signer];
    let cpi = CpiContext::new_with_signer(
        policy_program.key(),
        policy_accounts::CollectFeeSol {
            policy: policy.to_account_info(),
            factory: factory.to_account_info(),
            vault: vault.to_account_info(),
        },
        &signers,
    );
    policy_cpi::collect_fee_sol(cpi, verifier, claimer, fee)
}

#[allow(clippy::too_many_arguments)]
fn collect_fee_token<'info>(
    policy_program: &UncheckedAccount<'info>,
    policy: &UncheckedAccount<'info>,
    policy_mint: &UncheckedAccount<'info>,
    factory: &Account<'info, Factory>,
    vault: &Account<'info, Vault>,
    payer: &Signer<'info>,
    mint: &Account<'info, Mint>,
    policy_token_account: &Account<'info, TokenAccount>,
    system_program: &Program<'info, System>,
    verifier: Pubkey,
    claimer: Pubkey,
    fee: u64,
) -> Result<()> {
    if fee == 0 {
        return Ok(());
    }
    let seeds = vault_seeds(vault);
    let bump = [vault.bump];
    let signer: &[&[u8]] = &[VAULT_SEED, &seeds[0], &seeds[1], &bump];
    let signers = [signer];
    let cpi = CpiContext::new_with_signer(
        policy_program.key(),
        policy_accounts::CollectFeeToken {
            policy: policy.to_account_info(),
            factory: factory.to_account_info(),
            vault: vault.to_account_info(),
            policy_mint: policy_mint.to_account_info(),
            payer: payer.to_account_info(),
            mint: mint.to_account_info(),
            policy_token_account: policy_token_account.to_account_info(),
            system_program: system_program.to_account_info(),
        },
        &signers,
    );
    policy_cpi::collect_fee_token(cpi, verifier, claimer, fee)
}

fn fee_for(amount: u64, fee_bps: u16) -> u64 {
    let bps = u128::from(fee_bps.min(MAX_FEE_BPS));
    (u128::from(amount) * bps / 10_000) as u64
}

fn vault_seeds(vault: &Account<'_, Vault>) -> [[u8; 32]; 2] {
    [vault.factory.to_bytes(), vault.identity_hash]
}

fn transfer_from_vault<'info>(
    token_program: &Program<'info, Token>,
    from: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    vault: &Account<'info, Vault>,
    seeds: &[[u8; 32]; 2],
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let bump = [vault.bump];
    let signer: &[&[u8]] = &[VAULT_SEED, &seeds[0], &seeds[1], &bump];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.key(),
            TokenTransfer {
                from: from.to_account_info(),
                to: to.to_account_info(),
                authority: vault.to_account_info(),
            },
            &[signer],
        ),
        amount,
    )
}

fn validate_refund(deposit: &Deposit, caller: &Pubkey, now: i64) -> Result<()> {
    require!(!deposit.consumed, RouterError::DepositConsumed);
    // P2IDVaultV2: a named refunder is the one account that may refund and is paid; otherwise the funder.
    let refunder = deposit.refunder.unwrap_or(deposit.funder);
    require!(*caller == refunder, RouterError::NotFunderOrRefunder);
    let deadline = deposit
        .funded_at
        .checked_add(deposit.refund_window)
        .ok_or(RouterError::InvalidRefundWindow)?;
    // The payee has the whole window to claim; the funder may take the deposit back after it (P2ID.md).
    require!(now > deadline, RouterError::RefundNotReady);
    Ok(())
}

/// A proofless action pays the cached owner only while the cache is current: proven under `verifier`
/// and under the present signer key set (EVM: proofless sweeps require a current owner cache).
fn require_current_cache(
    verifier_config: &Account<'_, VerifierConfig>,
    vault: &Account<'_, Vault>,
    destination: &Pubkey,
    verifier: Pubkey,
) -> Result<()> {
    require!(verifier_config.verifier == verifier, RouterError::WrongVerifierConfig);
    require!(
        vault.owner != Pubkey::default() && vault.owner == *destination,
        RouterError::NotCachedOwner
    );
    require!(vault.owner_verifier == verifier, RouterError::OwnerCacheVerifierMismatch);
    require!(
        vault.owner_key_set_revision == verifier_config.key_set_revision,
        RouterError::OwnerCacheStale
    );
    Ok(())
}

/// Record what an implementation proved. The router only insists the update is not older than the
/// newest proof seen (an old leaked token can never roll the owner back); which proofs are acceptable
/// is the implementation's rule set.
fn apply_owner_update(
    vault: &mut Account<'_, Vault>,
    update: OwnerUpdate,
    verifier_config: &Account<'_, VerifierConfig>,
) -> Result<()> {
    require!(update.owner != Pubkey::default(), RouterError::NotCachedOwner);
    require!(update.iat >= vault.latest_proof_iat, RouterError::OwnerUpdateNotFresh);
    if vault.owner != update.owner {
        vault.owner_revision = vault.owner_revision.checked_add(1).ok_or(RouterError::OwnerUpdateNotFresh)?;
    }
    vault.owner = update.owner;
    vault.latest_proof_iat = update.iat;
    vault.owner_verifier = verifier_config.verifier;
    vault.owner_key_set_revision = verifier_config.key_set_revision;
    emit!(OwnerRefreshed { vault: vault.key(), verifier: verifier_config.verifier, owner: update.owner, iat: update.iat });
    Ok(())
}

/// The funder protections of a settlement, applied after any owner update the implementation
/// brought: unconsumed deposit, verifier still allowed, destination is the cached owner proven under
/// the deposit's verifier and the present key set, constraint attested.
fn authorize_settlement(
    factory: &Account<'_, Factory>,
    verifier_config: &Account<'_, VerifierConfig>,
    vault: &mut Account<'_, Vault>,
    deposit: &Account<'_, Deposit>,
    destination: &Pubkey,
    instructions: &UncheckedAccount<'_>,
    owner_update: Option<OwnerUpdate>,
) -> Result<()> {
    require!(deposit.vault == vault.key(), RouterError::WrongVault);
    require!(!deposit.consumed, RouterError::DepositConsumed);
    require!(verifier_config.verifier == deposit.verifier, RouterError::WrongVerifierConfig);
    require!(verifier_config.allowed, RouterError::VerifierNotAllowed);
    if let Some(update) = owner_update {
        require!(update.owner == *destination, RouterError::NotCachedOwner);
        apply_owner_update(vault, update, verifier_config)?;
    }
    require_current_cache(verifier_config, vault, destination, deposit.verifier)?;
    check_constraint(factory, verifier_config, deposit, instructions)
}

/// A constrained deposit (EVM sweepBucket with a Constraint) is released only if an earlier
/// instruction of this transaction is the Ed25519 program verifying a signature by one of the
/// deposit's verifier's constraint signers over CONSTRAINT_PREFIX || factory || commitment. The runtime has
/// already checked that signature when this instruction runs; we only confirm what it checked.
fn check_constraint(
    factory: &Account<'_, Factory>,
    verifier_config: &Account<'_, VerifierConfig>,
    deposit: &Deposit,
    instructions: &UncheckedAccount<'_>,
) -> Result<()> {
    if deposit.constraint == [0u8; 32] {
        return Ok(());
    }
    require!(!verifier_config.constraint_signers.is_empty(), RouterError::ConstraintsUnsupported);
    let mut expected = Vec::with_capacity(CONSTRAINT_PREFIX.len() + 64);
    expected.extend_from_slice(CONSTRAINT_PREFIX);
    expected.extend_from_slice(factory.key().as_ref());
    expected.extend_from_slice(&deposit.constraint);

    let info = instructions.to_account_info();
    let current = load_current_index_checked(&info)? as usize;
    for index in 0..current {
        let ix = load_instruction_at_checked(index, &info)?;
        if ix.program_id.to_bytes() != ED25519_PROGRAM_ID.to_bytes() {
            continue;
        }
        if ed25519_instruction_covers(&ix.data, index, &expected, &verifier_config.constraint_signers) {
            return Ok(());
        }
    }
    err!(RouterError::ConstraintNotSatisfied)
}

/// Parse an Ed25519 program instruction (count, padding, then 14-byte offset records) and report
/// whether one of its signatures is by an allowed signer over `expected`, with all three parts
/// (signature, key, message) located in the instruction itself.
fn ed25519_instruction_covers(data: &[u8], own_index: usize, expected: &[u8], signers: &[Pubkey]) -> bool {
    if data.len() < 2 {
        return false;
    }
    let count = data[0] as usize;
    let u16_at = |p: usize| u16::from_le_bytes([data[p], data[p + 1]]) as usize;
    let here = |ix: usize| ix == u16::MAX as usize || ix == own_index;
    for n in 0..count {
        let o = 2 + n * 14;
        if data.len() < o + 14 {
            return false;
        }
        let signature_ix = u16_at(o + 2);
        let key_offset = u16_at(o + 4);
        let key_ix = u16_at(o + 6);
        let message_offset = u16_at(o + 8);
        let message_len = u16_at(o + 10);
        let message_ix = u16_at(o + 12);
        if !(here(signature_ix) && here(key_ix) && here(message_ix)) {
            continue;
        }
        let (Some(key), Some(message)) = (
            data.get(key_offset..key_offset + 32),
            data.get(message_offset..message_offset + message_len),
        ) else {
            continue;
        };
        if message == expected && signers.iter().any(|s| s.as_ref() == key) {
            return true;
        }
    }
    false
}

// ------------------------------------------------------------------ accounts

#[derive(Accounts)]
#[instruction(authority: Pubkey, params_hash: [u8; 32], signer_keys: Vec<[u8; SIGNER_KEY_LEN]>, default_verifier: Pubkey)]
pub struct InitializeFactory<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Factory::INIT_SPACE,
        seeds = [FACTORY_SEED, SCHEME_VERSION, authority.as_ref(), params_hash.as_ref()],
        bump
    )]
    pub factory: Box<Account<'info, Factory>>,
    #[account(
        init,
        payer = payer,
        space = 8 + VerifierConfig::INIT_SPACE,
        seeds = [VERIFIER_SEED, factory.key().as_ref(), default_verifier.as_ref()],
        bump
    )]
    pub verifier_config: Box<Account<'info, VerifierConfig>>,
    /// Pays the rent; any key. The factory is administered by the `authority` argument, not the payer.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FactoryAdmin<'info> {
    #[account(
        mut,
        seeds = [FACTORY_SEED, SCHEME_VERSION, factory.seed_authority.as_ref(), factory.params_hash.as_ref()],
        bump = factory.bump,
        has_one = authority @ RouterError::Unauthorized
    )]
    pub factory: Box<Account<'info, Factory>>,
    pub authority: Signer<'info>,
    pub clock: Sysvar<'info, Clock>,
}

/// Factory authority acting on one verifier's config (keys, constraint signers, revocation).
#[derive(Accounts)]
pub struct VerifierAdmin<'info> {
    #[account(
        seeds = [FACTORY_SEED, SCHEME_VERSION, factory.seed_authority.as_ref(), factory.params_hash.as_ref()],
        bump = factory.bump,
        has_one = authority @ RouterError::Unauthorized
    )]
    pub factory: Box<Account<'info, Factory>>,
    #[account(
        mut,
        seeds = [VERIFIER_SEED, factory.key().as_ref(), verifier_config.verifier.as_ref()],
        bump = verifier_config.bump,
        has_one = factory @ RouterError::WrongFactory
    )]
    pub verifier_config: Box<Account<'info, VerifierConfig>>,
    pub authority: Signer<'info>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
#[instruction(verifier: Pubkey)]
pub struct ProposeVerifier<'info> {
    #[account(
        mut,
        seeds = [FACTORY_SEED, SCHEME_VERSION, factory.seed_authority.as_ref(), factory.params_hash.as_ref()],
        bump = factory.bump,
        has_one = authority @ RouterError::Unauthorized
    )]
    pub factory: Box<Account<'info, Factory>>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + VerifierConfig::INIT_SPACE,
        seeds = [VERIFIER_SEED, factory.key().as_ref(), verifier.as_ref()],
        bump
    )]
    pub verifier_config: Box<Account<'info, VerifierConfig>>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub clock: Sysvar<'info, Clock>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ActivateVerifier<'info> {
    #[account(
        mut,
        seeds = [FACTORY_SEED, SCHEME_VERSION, factory.seed_authority.as_ref(), factory.params_hash.as_ref()],
        bump = factory.bump,
        has_one = authority @ RouterError::Unauthorized
    )]
    pub factory: Box<Account<'info, Factory>>,
    #[account(
        mut,
        seeds = [VERIFIER_SEED, factory.key().as_ref(), factory.proposed_verifier.as_ref()],
        bump = verifier_config.bump
    )]
    pub verifier_config: Box<Account<'info, VerifierConfig>>,
    pub authority: Signer<'info>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(
        mut,
        seeds = [FACTORY_SEED, SCHEME_VERSION, factory.seed_authority.as_ref(), factory.params_hash.as_ref()],
        bump = factory.bump
    )]
    pub factory: Box<Account<'info, Factory>>,
    pub new_authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(identity_hash: [u8; 32])]
pub struct DeployVault<'info> {
    pub factory: Box<Account<'info, Factory>>,
    #[account(
        init,
        payer = payer,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, factory.key().as_ref(), identity_hash.as_ref()],
        bump
    )]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetVaultImplementation<'info> {
    pub factory: Box<Account<'info, Factory>>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.factory.as_ref(), vault.identity_hash.as_ref()],
        bump = vault.bump,
        has_one = factory @ RouterError::WrongFactory
    )]
    pub vault: Box<Account<'info, Vault>>,
    /// The config the owner was cached under; proves the cache is current.
    #[account(
        seeds = [VERIFIER_SEED, factory.key().as_ref(), vault.owner_verifier.as_ref()],
        bump = verifier_config.bump
    )]
    pub verifier_config: Box<Account<'info, VerifierConfig>>,
    /// The cached owner.
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct CreateDepositSol<'info> {
    pub factory: Box<Account<'info, Factory>>,
    /// The verifier this deposit is funded under: any allowed one (the default for plain funding).
    #[account(
        seeds = [VERIFIER_SEED, factory.key().as_ref(), verifier_config.verifier.as_ref()],
        bump = verifier_config.bump
    )]
    pub verifier_config: Box<Account<'info, VerifierConfig>>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.factory.as_ref(), vault.identity_hash.as_ref()],
        bump = vault.bump,
        has_one = factory @ RouterError::WrongFactory
    )]
    pub vault: Box<Account<'info, Vault>>,
    #[account(
        init,
        payer = funder,
        space = 8 + Deposit::INIT_SPACE,
        seeds = [DEPOSIT_SEED, vault.key().as_ref(), &vault.deposit_seq.to_le_bytes()],
        bump
    )]
    pub deposit: Box<Account<'info, Deposit>>,
    /// CHECK: the factory's policy (a PolicyConfig of the policy program).
    #[account(constraint = policy.key() == factory.policy @ RouterError::Unauthorized)]
    pub policy: UncheckedAccount<'info>,
    /// CHECK: the program owning the policy account; quotes and books fees.
    #[account(executable, constraint = policy_program.key() == *policy.owner @ RouterError::InvalidPolicy)]
    pub policy_program: UncheckedAccount<'info>,
    #[account(mut)]
    pub funder: Signer<'info>,
    /// The implementation's authority PDA, signed through invoke_signed; checked against vault.implementation.
    pub impl_authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateDepositToken<'info> {
    pub factory: Box<Account<'info, Factory>>,
    /// The verifier this deposit is funded under: any allowed one (the default for plain funding).
    #[account(
        seeds = [VERIFIER_SEED, factory.key().as_ref(), verifier_config.verifier.as_ref()],
        bump = verifier_config.bump
    )]
    pub verifier_config: Box<Account<'info, VerifierConfig>>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.factory.as_ref(), vault.identity_hash.as_ref()],
        bump = vault.bump,
        has_one = factory @ RouterError::WrongFactory
    )]
    pub vault: Box<Account<'info, Vault>>,
    #[account(
        init,
        payer = funder,
        space = 8 + Deposit::INIT_SPACE,
        seeds = [DEPOSIT_SEED, vault.key().as_ref(), &vault.deposit_seq.to_le_bytes()],
        bump
    )]
    pub deposit: Box<Account<'info, Deposit>>,
    #[account(
        init_if_needed,
        payer = funder,
        space = 8 + VaultMint::INIT_SPACE,
        seeds = [VAULT_MINT_SEED, vault.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub vault_mint: Box<Account<'info, VaultMint>>,
    /// CHECK: the factory's policy (a PolicyConfig of the policy program).
    #[account(constraint = policy.key() == factory.policy @ RouterError::Unauthorized)]
    pub policy: UncheckedAccount<'info>,
    /// CHECK: the program owning the policy account; quotes and books fees.
    #[account(executable, constraint = policy_program.key() == *policy.owner @ RouterError::InvalidPolicy)]
    pub policy_program: UncheckedAccount<'info>,
    #[account(mut)]
    pub funder: Signer<'info>,
    /// The implementation's authority PDA, signed through invoke_signed; checked against vault.implementation.
    pub impl_authority: Signer<'info>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        constraint = funder_token_account.owner == funder.key() @ RouterError::Unauthorized,
        constraint = funder_token_account.mint == mint.key() @ RouterError::WrongMint
    )]
    pub funder_token_account: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = funder,
        associated_token::mint = mint,
        associated_token::authority = vault
    )]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetOwnerCache<'info> {
    pub factory: Box<Account<'info, Factory>>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.factory.as_ref(), vault.identity_hash.as_ref()],
        bump = vault.bump,
        has_one = factory @ RouterError::WrongFactory
    )]
    pub vault: Box<Account<'info, Vault>>,
    /// The verifier the implementation verified the proof under.
    #[account(
        seeds = [VERIFIER_SEED, factory.key().as_ref(), verifier_config.verifier.as_ref()],
        bump = verifier_config.bump
    )]
    pub verifier_config: Box<Account<'info, VerifierConfig>>,
    /// The implementation's authority PDA, signed through invoke_signed; checked against vault.implementation.
    pub impl_authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct SettleSol<'info> {
    pub factory: Box<Account<'info, Factory>>,
    #[account(
        seeds = [VERIFIER_SEED, factory.key().as_ref(), deposit.verifier.as_ref()],
        bump = verifier_config.bump
    )]
    pub verifier_config: Box<Account<'info, VerifierConfig>>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.factory.as_ref(), vault.identity_hash.as_ref()],
        bump = vault.bump,
        has_one = factory @ RouterError::WrongFactory
    )]
    pub vault: Box<Account<'info, Vault>>,
    #[account(
        mut,
        seeds = [DEPOSIT_SEED, vault.key().as_ref(), &id.to_le_bytes()],
        bump = deposit.bump,
        constraint = deposit.vault == vault.key() @ RouterError::WrongVault
    )]
    pub deposit: Box<Account<'info, Deposit>>,
    /// CHECK: the destination: the owner after `owner_update`, else the cached owner. Not a signer.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    /// CHECK: validated against `factory.policy`.
    #[account(mut, constraint = policy.key() == factory.policy @ RouterError::Unauthorized)]
    pub policy: UncheckedAccount<'info>,
    /// CHECK: the program owning the policy account; quotes and books fees.
    #[account(executable, constraint = policy_program.key() == *policy.owner @ RouterError::InvalidPolicy)]
    pub policy_program: UncheckedAccount<'info>,
    /// CHECK: the instructions sysvar, read to find the constraint signer's Ed25519 instruction.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    /// The implementation's authority PDA, signed through invoke_signed; checked against vault.implementation.
    pub impl_authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct SettleToken<'info> {
    pub factory: Box<Account<'info, Factory>>,
    #[account(
        seeds = [VERIFIER_SEED, factory.key().as_ref(), deposit.verifier.as_ref()],
        bump = verifier_config.bump
    )]
    pub verifier_config: Box<Account<'info, VerifierConfig>>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.factory.as_ref(), vault.identity_hash.as_ref()],
        bump = vault.bump,
        has_one = factory @ RouterError::WrongFactory
    )]
    pub vault: Box<Account<'info, Vault>>,
    #[account(
        mut,
        seeds = [DEPOSIT_SEED, vault.key().as_ref(), &id.to_le_bytes()],
        bump = deposit.bump,
        constraint = deposit.vault == vault.key() @ RouterError::WrongVault
    )]
    pub deposit: Box<Account<'info, Deposit>>,
    #[account(
        mut,
        seeds = [VAULT_MINT_SEED, vault.key().as_ref(), mint.key().as_ref()],
        bump = vault_mint.bump
    )]
    pub vault_mint: Box<Account<'info, VaultMint>>,
    /// Pays rent for token accounts created here; any key (a relayer), passed through the CPI.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the destination wallet: the owner after `owner_update`, else the cached owner. Not a signer.
    pub owner: UncheckedAccount<'info>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = vault)]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = owner
    )]
    pub owner_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: validated against `factory.policy`; authority of the fee token account.
    #[account(mut, constraint = policy.key() == factory.policy @ RouterError::Unauthorized)]
    pub policy: UncheckedAccount<'info>,
    /// CHECK: the program owning the policy account; quotes and books fees.
    #[account(executable, constraint = policy_program.key() == *policy.owner @ RouterError::InvalidPolicy)]
    pub policy_program: UncheckedAccount<'info>,
    /// CHECK: the policy's per-mint book, a PDA of the policy program; created by it on first use.
    #[account(mut)]
    pub policy_mint: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = policy
    )]
    pub policy_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: the instructions sysvar, read to find the constraint signer's Ed25519 instruction.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    /// The implementation's authority PDA, signed through invoke_signed; checked against vault.implementation.
    pub impl_authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct RefundSol<'info> {
    pub factory: Box<Account<'info, Factory>>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.factory.as_ref(), vault.identity_hash.as_ref()],
        bump = vault.bump,
        has_one = factory @ RouterError::WrongFactory
    )]
    pub vault: Box<Account<'info, Vault>>,
    #[account(
        mut,
        seeds = [DEPOSIT_SEED, vault.key().as_ref(), &id.to_le_bytes()],
        bump = deposit.bump,
        constraint = deposit.vault == vault.key() @ RouterError::WrongVault
    )]
    pub deposit: Box<Account<'info, Deposit>>,
    #[account(mut)]
    pub caller: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct RefundToken<'info> {
    pub factory: Box<Account<'info, Factory>>,
    #[account(
        seeds = [VAULT_SEED, vault.factory.as_ref(), vault.identity_hash.as_ref()],
        bump = vault.bump,
        has_one = factory @ RouterError::WrongFactory
    )]
    pub vault: Box<Account<'info, Vault>>,
    #[account(
        mut,
        seeds = [DEPOSIT_SEED, vault.key().as_ref(), &id.to_le_bytes()],
        bump = deposit.bump,
        constraint = deposit.vault == vault.key() @ RouterError::WrongVault
    )]
    pub deposit: Box<Account<'info, Deposit>>,
    #[account(
        mut,
        seeds = [VAULT_MINT_SEED, vault.key().as_ref(), mint.key().as_ref()],
        bump = vault_mint.bump
    )]
    pub vault_mint: Box<Account<'info, VaultMint>>,
    #[account(mut)]
    pub caller: Signer<'info>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = vault)]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = caller)]
    pub caller_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SweepUntrackedSol<'info> {
    pub factory: Box<Account<'info, Factory>>,
    #[account(
        seeds = [VERIFIER_SEED, factory.key().as_ref(), factory.default_verifier.as_ref()],
        bump = verifier_config.bump
    )]
    pub verifier_config: Box<Account<'info, VerifierConfig>>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.factory.as_ref(), vault.identity_hash.as_ref()],
        bump = vault.bump,
        has_one = factory @ RouterError::WrongFactory
    )]
    pub vault: Box<Account<'info, Vault>>,
    /// CHECK: must be the cached owner.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    /// CHECK: validated against `factory.policy`.
    #[account(mut, constraint = policy.key() == factory.policy @ RouterError::Unauthorized)]
    pub policy: UncheckedAccount<'info>,
    /// CHECK: the program owning the policy account; quotes and books fees.
    #[account(executable, constraint = policy_program.key() == *policy.owner @ RouterError::InvalidPolicy)]
    pub policy_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SweepUntrackedToken<'info> {
    pub factory: Box<Account<'info, Factory>>,
    #[account(
        seeds = [VERIFIER_SEED, factory.key().as_ref(), factory.default_verifier.as_ref()],
        bump = verifier_config.bump
    )]
    pub verifier_config: Box<Account<'info, VerifierConfig>>,
    #[account(
        seeds = [VAULT_SEED, vault.factory.as_ref(), vault.identity_hash.as_ref()],
        bump = vault.bump,
        has_one = factory @ RouterError::WrongFactory
    )]
    pub vault: Box<Account<'info, Vault>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + VaultMint::INIT_SPACE,
        seeds = [VAULT_MINT_SEED, vault.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub vault_mint: Box<Account<'info, VaultMint>>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: must be the cached owner.
    pub owner: UncheckedAccount<'info>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = vault)]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = owner
    )]
    pub owner_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: validated against `factory.policy`; authority of the fee token account.
    #[account(mut, constraint = policy.key() == factory.policy @ RouterError::Unauthorized)]
    pub policy: UncheckedAccount<'info>,
    /// CHECK: the program owning the policy account; quotes and books fees.
    #[account(executable, constraint = policy_program.key() == *policy.owner @ RouterError::InvalidPolicy)]
    pub policy_program: UncheckedAccount<'info>,
    /// CHECK: the policy's per-mint book, a PDA of the policy program; created by it on first use.
    #[account(mut)]
    pub policy_mint: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = policy
    )]
    pub policy_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
