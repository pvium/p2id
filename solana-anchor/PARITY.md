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
- [x] Classic SPL Token and Token-2022 (transfer fees, transfer hooks) on every token path
- [x] Verifier interface (`crates/p2id_verifier_interface`): `verify(proof) -> Attestation`, the
  EVM `IVerifier` / `getIdentityWallet` shape. The implementation passes opaque proof bytes and
  checks the attestation; `p2id_solana_verifier` is the registered verifier for circuit v2 and
  fronts the Sunspot program (fixed at build time via `P2ID_ZK_VERIFIER`). Witness parsing moved
  out of the implementation. Tested end to end through the suite (23 passing) and directly
  (`.view()` returns the attestation; wrong backend, upgradeable backend, bad payload refused).
- [x] Immutability enforced on-chain, not by deployment discipline: `initialize_factory`,
  `register_implementation` and `activate_verifier` read loader state (upgradeable loader
  ProgramData authority, loader-v4 status, legacy loaders) and refuse upgradeable or missing
  programs; the verifier refuses an upgradeable Sunspot program on every call. Tested with
  `test_hook` (upgradeable) as implementation/verifier, a missing program, and a wrong ProgramData.

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

- [x] **Close consumed deposits.** Router `close_deposit(id)`: permissionless once `consumed`,
  closes the Deposit account and returns its rent to `deposit.funder` (who paid it). Deposit ids
  are never reused. Tested: unconsumed refused, wrong recipient refused, rent returned, account gone.
- [x] **Transaction size.** `refresh_proof` then proofless claim is the documented primary flow.
  The one-shot proof-carrying claim is covered by a test that builds a v0 transaction with an
  address lookup table holding the claim's accounts (388-byte proof + 364-byte witness) and asserts
  the same claim does not serialize as a legacy transaction. The SDK needs both paths.
- [ ] **Real verifier end to end.** Blocked on tooling: this machine has no `sunspot` CLI, no
  compiled Sunspot verifier `.so` for the 11-input circuit, and no Solana-format proof
  (`circuit/target/proof_p2id` is a 10 KB Barretenberg proof for the EVM path). Needs: Sunspot
  installed, `pvium_identity.so` + keypair built from the current circuit, one Groth16 proof with
  its 364-byte public witness and the wallet it names. Then: build `p2id_solana_verifier` with
  `P2ID_ZK_VERIFIER=<sunspot id>`, load the Sunspot program finalized (or finalize it in `before`),
  a factory whose default verifier is it, `deploy_vault` for the witness's identity hash,
  `refresh_proof`, assert the cached owner. The interface and the Sunspot payload format
  (`proof || witness`, forwarded unchanged) are already what `solana-test/verify-anchor.js` sends.
- [x] **Alpha attestation.** EVM gates every payout (`refreshProof`, `refreshProofAndSweep`,
  `sweepBucket*`, proxy `upgradeTo`) behind the backend attester's signature while the verifier's vk
  is in alpha. Solana: `Factory.alpha_attester` (an `initialize_factory` argument, in `params_hash`;
  zero means the authority) + `alpha_epoch` + `set_alpha_attester`; `VerifierConfig.alpha` (true from
  creation) + `set_alpha`; router `require_alpha_attestation` in `set_owner_cache`, `settle_*`,
  `sweep_untracked_*`, `set_vault_implementation` over the attester's Ed25519 instruction
  (`"p2id.alpha.sol.v1" || deadline || sha256(factory || vault || verifier || destination || iat ||
  action || subject || epoch)`). EVM `alphaRevision` is `key_set_revision` here (bumped on re-entry;
  same restore/no-move semantics as EVM `_apply`, verified). No nonce (deposit settles once, same-iat
  cannot move the owner). Tested: stale cache after re-entry; refresh refused without / wrong key /
  wrong iat / wrong action / expired; settle bound to its deposit; sweep and move gated; attester
  rotation voids the old epoch; release resumes proofless payouts and keeps the revision.
  Transaction size: proof-carrying `refresh_proof` + the attester's instruction needs a v0
  transaction with a lookup table (documented in the README).
- [x] **P-256 on-curve check** in `initialize_factory`, `propose_verifier` and
  `propose_signer_key` (`curve::is_on_p256`, p256 crate, admin paths only). Tested with an
  all-9s blob, swapped x/y of a real key, and the generator in a unit test.
- [x] **Token-2022** (decided in scope). Both token programs accepted everywhere (router,
  implementation, policy) through `token_interface`; every transfer is `transfer_checked`; a
  transfer hook's extra accounts come as remaining accounts and are re-resolved on-chain; the
  programs record and book what actually arrived (transfer-fee mints take a cut on every hop).
  Tested with classic SPL Token, a transfer-fee mint and a transfer-hook mint (`programs/test_hook`).
- [x] **`claim_many`.** Closed by design: on Solana a batch is several `claim_*` instructions in
  one transaction (with a lookup table when the account set is large); no program support needed.

## 3. Housekeeping

- [ ] Commit the current work: new `crates/p2id_verifier_interface/`, `.cargo/config.toml`,
  `programs/test_hook/`, `programs/p2id_policy/src/token.rs`, `programs/p2id_router/src/curve.rs`;
  rewritten `programs/p2id_solana_verifier/`; deleted `programs/p2id_vault/src/proof.rs`;
  `solana-test/verify-anchor.js` ported to the interface; alpha attestation (router, implementation,
  tests, README).
- [ ] Code review items from the external review, status: verifier wrapper disconnected → fixed
  (it is the verifier now); immutability not enforced → fixed (router + verifier check loader
  state); router trusts the implementation's owner update → by design (the implementation is
  immutable, registered behind notice, and opted into per vault; the router cannot verify a proof
  without freezing proof semantics). Policy program immutability is not enforced: it cannot reach
  vault funds (fees are quoted at funding and capped by the router), decide separately.
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
- [ ] Alpha approvals: backend endpoint signing the alpha message (ed25519 attester key, the
  Solana counterpart of the EVM `alphaAttestation` flow), SDK assembling the Ed25519 instruction in
  front of the gated instruction, v0 + lookup table for proof-carrying refreshes while in alpha.
- [ ] Event parsing for the indexer (Funded, Claimed, Refunded, OwnerRefreshed).
- [ ] Deploy records for Solana alongside `contracts/deployments/*.json` (program ids,
  factory/verifier/policy PDAs, params hash).

## 5. Deploy sequence (once 1–3 are done)

1. Generate and vault the program keypairs; `anchor keys sync`; commit the ids.
2. Deploy the Sunspot verifier program and burn its upgrade authority (`solana program
   set-upgrade-authority --final`). Build `p2id_solana_verifier` with `P2ID_ZK_VERIFIER=<its id>`.
3. Deploy `p2id_solana_verifier`, `p2id_policy`, `p2id_router`, `p2id_vault` to devnet.
4. Burn the upgrade authority of `p2id_solana_verifier` and `p2id_vault` now: `initialize_factory`
   refuses them otherwise (pass each program and its ProgramData account).
5. `initialize_policy(squads, router_program, fee_bps)`.
6. `initialize_factory(squads, params_hash, keys, verifier, policy, vault_program, alpha_attester, …)`
   on the router; the verifier starts in alpha, release it with `set_alpha(false)` when ready.
7. `set_factory` on the policy.
8. Burn the upgrade authority of `p2id_router`; decide the policy program's per item 1.
9. Repeat on mainnet from the Squads multisig.
