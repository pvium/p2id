# Solana port: remaining work

Working checklist for bringing `solana-anchor/` to parity with the EVM V2 stack
(P2IDVaultV2, PviumVerifierV2, PviumP2IdVaultFactory, PviumP2IDPolicy) and making it
deployable. Tick or delete items as they land. Items are ordered: decisions first,
since they change PDA addresses or program layout and are cheap to change only before
the first deploy with a kept program id.

## Done

- [x] Factory PDA keyed by authority and committed init params (no squatting)
- [x] Two-step authority transfer
- [x] Verifier notice: `propose_verifier` / `activate_verifier` / `cancel` / `revoke` (14 days)
- [x] Policy as its own program (`p2id_policy`), reached by CPI; `propose_policy` / `activate_policy` notice
- [x] Signer-key set on the verifier config: propose (7 days), activate, cancel, immediate remove, `key_set_revision`
- [x] Constraint signers on the verifier config (Ed25519 instruction introspection)
- [x] One funding instruction covering fund / fundWith / fundWithRefunder (V2 exclusive refunder)
- [x] Claims any time, refund only after `funded_at + refund_window`
- [x] Owner cache rules (`_apply` semantics), `refresh_proof`, proofless relayer claims
- [x] Untracked SOL / token sweeps with fee
- [x] Events: Funded, Claimed, Refunded, OwnerRefreshed, UntrackedSwept, FeeReceived, FeeWithdrawn
- [x] `version` + `_reserved` bytes on every account for layout evolution

## 1. Decisions (before any deploy with a kept program id)

- [x] **Upgradeability model: decided, router + immutable implementations.** Reason: the
  zero-custody claim requires that nobody, including us, can change the code holding funds.
  A per-vault "behaviour version" opt-in in one upgradeable program was rejected (the
  upgrade authority can rewrite the dispatch); a plain time-locked upgradeable program was
  rejected for the same reason.
  Design (to build, see section 1a):
  - `p2id_router` (immutable after deploy) owns Factory, VerifierConfig, Vault, VaultMint,
    Deposit; token authority is the router's vault PDA. Exposes only PDA-gated primitives:
    `create_deposit`, `create_vault_mint`, `set_owner_cache`, `settle_deposit`,
    `sweep_untracked`, `set_vault_implementation`, plus factory admin (implementation
    registration behind the 14-day notice, verifier/policy notices, signer keys).
  - Refund after the window is a router instruction callable directly by the named refunder,
    so no implementation can withhold it.
  - Frozen funder protections in `settle_deposit`: deposit settles once; payout + fee ==
    amount; fee <= rate quoted at funding; recipient == cached owner.
  - `p2id_vault_v1` (implementation, upgrade authority burned) is the user entry point:
    fund / refresh_proof / claim / sweep. Holds proof verification, signer-key and owner-cache
    rules, constraints, refund-before-window refusal. Owns no state and no funds; signs router
    calls with its authority PDA. Router checks the PDA derives from `vault.implementation`
    and that the implementation is registered.
  - Call direction is user → implementation → router (→ policy). Router → implementation is
    not used (indirect reentrancy is forbidden and would freeze the user-facing API).
  - Shared `p2id_state` crate for account layouts and hashes.

## 1a. Router split (build order)

- [x] Shared layouts: `p2id_router::state` (account types, seeds, `OwnerUpdate`) and
  `p2id_router::hash` are imported by the implementation through the `cpi` feature; no separate
  crate needed since Anchor account types must live with their owner program.
- [x] `p2id_router`: factory + verifier/policy/signer-key admin, `propose_implementation(program,
  make_default)` / `register_implementation` / `cancel_implementation_proposal` /
  `set_default_implementation`; `Factory.implementations` (max 16, never shrinks),
  `Vault.implementation`; `params_hash` commits to the default implementation.
- [x] `p2id_router`: gated primitives `create_deposit_sol/token`, `set_owner_cache`,
  `settle_sol/token(id, owner_update?)` with implementation-PDA gating and the frozen invariants
  (settle once, amount − quoted fee, owner proven under the deposit's verifier and current key set,
  constraint attested).
- [x] `p2id_router`: `refund_sol/token` and `sweep_untracked_sol/token` direct (no implementation
  involved); `set_vault_implementation` by the cached owner, registered targets only.
- [x] `p2id_vault` (implementation v1): `fund_sol/token`, `refresh_proof`, `claim_sol/token` CPI
  into the router signed by `PDA(["p2id.impl-authority.v1"])`.
- [x] Tests ported to the two-program flow (18 passing): added impostor-PDA refusals on
  `create_deposit_sol`, `settle_sol`, `set_owner_cache`; implementation notice; owner-only /
  registered-only vault move; stale cache blocks the move; claim after settle refused.
- [x] Transaction size measured: proof-carrying `claim_sol` (13 accounts) no longer fits a legacy
  transaction; `refresh_proof` (8 accounts) does. Documented refresh-then-proofless-claim as the
  flow; ALT is the alternative. Proofless `claim_token` ≈ 160k CU.
- [x] README rewritten for the router split.
- [ ] Not testable locally: `register_implementation` after the 14-day notice and a real second
  implementation taking over a vault (needs a second program or a clock warp). Cover on devnet.

## 2. Code gaps (no decision needed)

- [ ] **Close consumed deposits.** `close_deposit(id)`: once `consumed`, close the Deposit
  account and return rent to the payer recorded at funding. Needs a `rent_payer` field on
  `Deposit` (or reuse `funder`). Test: rent returned, second close fails.
- [ ] **Transaction size.** (a) done: `refresh_proof` then proofless claim is the documented
  primary flow (README); the SDK must drive it. (b) open: an address-lookup-table test for the
  one-shot proof-carrying claim, since neither `claim_sol` (13 accounts) nor `claim_token` fits a
  legacy transaction with a real-size proof.
- [ ] **Real verifier end to end.** Tests use `test_verifier`. Run the full fund → refresh →
  claim flow against `p2id_solana_verifier` with a real Sunspot proof on the local validator.
- [ ] **P-256 on-curve check** for keys passed to `initialize_factory`, `propose_verifier` and
  `propose_signer_key`, so a malformed key cannot be accepted after the 7-day wait.
- [ ] **Token-2022** (if in scope): switch token paths to `token_interface`, make receipt
  checks extension-aware (transfer fee reduces received amount), handle transfer hooks'
  extra accounts.
- [ ] **`claim_many`** (parity only): batch of proofless claims in one instruction. Low value
  on Solana; skip unless the SDK wants it.

## 3. Housekeeping

- [ ] Commit the current work: `programs/p2id_policy/`, `programs/p2id_router/` and this file are
  untracked; README has mixed staged and unstaged edits; `programs/p2id_vault/src/state.rs` is
  deleted (moved to the router).
- [ ] README: strip anything that reads as internal status before publishing (constraint:
  public content carries no release status, repo paths or maintainer notes). Keep this file
  out of the public README.
- [ ] Rust unit tests for `factory_params_hash` and `identity_hash` vectors shared with the
  EVM/TS side (same inputs, same digests).

## 4. SDK and API

- [ ] PDA derivation helpers in the Node SDK: factory, verifier config, policy config, vault
  (from identity hash), vault-mint, deposit (vault, seq), implementation authority. The SDK reads
  `vault.implementation` to know which program to send `fund_*` / `claim_*` to.
- [ ] `factoryParamsHash` in the SDK, matching `programs/p2id_router/src/hash.rs` (includes the default implementation).
- [ ] Fund / refresh / claim / refund builders, including the two-transaction
  refresh-then-claim flow and Ed25519 constraint instruction assembly.
- [ ] Event parsing for the indexer (Funded, Claimed, Refunded, OwnerRefreshed).
- [ ] Deploy records for Solana alongside `contracts/deployments/*.json` (program ids,
  factory/verifier/policy PDAs, params hash).

## 5. Deploy sequence (once 1–3 are done)

1. Generate and vault the program keypairs; `anchor keys sync`; commit the ids.
2. Deploy `p2id_solana_verifier`, `p2id_policy`, `p2id_router`, `p2id_vault` to devnet.
3. `initialize_policy(squads, router_program, fee_bps)`.
4. `initialize_factory(squads, params_hash, keys, verifier, policy, vault_program, …)` on the router.
5. `set_factory` on the policy.
6. Burn the upgrade authority of `p2id_router` and `p2id_vault` (`solana program set-upgrade-authority
   --final`); decide the policy program's per item 1.
7. Repeat on mainnet from the Squads multisig.
