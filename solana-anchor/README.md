# P2ID on Solana

Four programs live here.

- `programs/p2id_router` owns every account and holds every balance: a `Factory` PDA with the
  default verifier, policy, refund bounds and the registered implementations, a `VerifierConfig` PDA
  per verifier, one `Vault` PDA per identity, one `Deposit` PDA per recorded deposit. It is deployed
  once and made immutable, so the code holding funds can never change. It exposes the factory
  administration, refunds and untracked sweeps directly, and a small set of state-changing
  primitives only a vault's implementation may call.
- `programs/p2id_vault` is the first implementation (EVM `P2IDVaultV2` semantics) and the program
  users talk to: `fund_*`, `refresh_proof`, `claim_*`. It verifies identity proofs and asks the
  router to record the result and move the money. It owns nothing and holds no funds. A later
  implementation is a new program, registered by the factory behind notice; each vault owner moves
  their vault to it, or does not.
- `programs/p2id_policy` is the fee policy (`PviumP2IDPolicy`): the router asks it for the rate at
  funding and reports fees to it at settlement.
- `programs/p2id_solana_verifier` is a thin CPI wrapper around a Sunspot verifier, described further
  down; the vault does not use it. `programs/test_verifier` accepts any proof and exists only for
  the local tests.

## Router and implementations

On Solana only an account's owner program can write its data or debit its lamports, and a program
cannot call back into a program that is already on the call stack. So the split is: accounts and
balances in the router, proof logic in implementations, and calls flow one way, user →
implementation → router (→ policy, → Sunspot verifier from the implementation).

An implementation signs its router calls with its authority PDA
(`PDA(["p2id.impl-authority.v1"], implementationProgram)`), and the router accepts the call only if
that PDA belongs to `vault.implementation`. The gated primitives are `create_deposit_sol/token`,
`set_owner_cache` and `settle_sol/token`. On every settlement the router itself enforces what no
implementation may waive: the deposit is unconsumed and settles once, for its amount less the fee
quoted when it was funded, to the owner proven under the verifier the deposit pins and under the
present signer-key set, with the deposit's constraint attested earlier in the transaction. Refunds
(`refund_sol/token`) and untracked sweeps are plain router instructions, so a broken or hostile
implementation cannot stop a refunder taking an unconsumed deposit back after its window.

The factory registers implementations the way the EVM factory does: `propose_implementation(program,
make_default)`, then `register_implementation` after the 14-day notice (`cancel_implementation_proposal`
in between); `set_default_implementation` picks, among registered ones, what new vaults start on.
Nothing ever unregisters an implementation, so a vault keeps the one its owner chose. The cached
owner moves a vault with `set_vault_implementation(program)` (router, owner signs, cache must be
current); nobody else can.

The implementation programs' upgrade authority is burned at deploy and the router's as well, which
is the point: the only way behaviour changes for a vault is a new program the factory announced two
weeks earlier and the owner opted into.

## Addresses

```text
factory    = PDA(["p2id.factory.v1", "pvium.vault.v1", authority, paramsHash], p2id_router)
verifier   = PDA(["p2id.verifier.v1", factory, verifierProgram],                 p2id_router)
policy     = PDA(["p2id.policy.v1", authority, p2id_router, feeBps_be_u16],      p2id_policy)
paramsHash = sha256("p2id.factory.params.v1" || nKeys_u8 || signerKey_1 || … || defaultVerifier || policy
                    || defaultImplementation || circuitVersion_be_u16 || vkHash || minRefundWindow_be_i64 || maxRefundWindow_be_i64)
vault      = PDA(["p2id.vault.v1", factory, identityHash],    p2id_router)
deposit    = PDA(["p2id.deposit.v1", vault, depositId_le_u64], p2id_router)
vaultMint  = PDA(["p2id.vault-mint.v1", vault, mint],           p2id_router)
implAuth   = PDA(["p2id.impl-authority.v1"],                    implementationProgram)
```

`authority` is the key that administers the factory (verifier, policy and implementation
proposals). It and `paramsHash`, a commitment to every other `initialize_factory` argument, are
arguments, not signers, and both are part of the factory address, as the EVM factory's constructor
arguments are part of its CREATE2 address. Anyone may submit the instruction and pay the rent, and
the only factory they can create at an address is the one with exactly that authority and those
terms; other values land at an unrelated address. A deployment is therefore reproducible from
`(programId, authority, params)` by any key, and cannot be squatted. In production the authority
is a Squads multisig vault; the tests use the provider keypair. The vault PDA includes the factory,
so each factory has its own set of vaults. `identityHash` is the P2ID identity commitment from
`P2ID.md`, unchanged from the EVM scheme.

## Owner changes carry notice

The authority changes the default verifier, the fee policy and the implementation set only through
a proposal that becomes activatable after a delay, as the EVM factory does: `propose_verifier` /
`activate_verifier`, `propose_policy(policy)` / `activate_policy` and `propose_implementation` /
`register_implementation`, each with a `cancel_*` counterpart. All delays start at 14 days. The
policy is a `PolicyConfig` account of the policy program whose rate is one of its seeds, so a new
rate is a new policy address that has to go through the notice, exactly as a new `PviumP2IDPolicy`
contract does on EVM; rates are capped at `MAX_FEE_BPS` (1%) on both sides. A deposit keeps the rate
quoted when it was funded; the policy live at settlement receives the fee. Nothing changes a fee,
a verifier or an implementation instantly.

**Fee policy program.** `initialize_policy(authority, vault_program, fee_bps)` creates a policy
(`vault_program` is the router); `set_factory` binds it once (fees are refused before). The router
calls `quote_fee(verifier, mint)` by CPI at funding and freezes the answer into the deposit
(`IP2IDPolicy.feeBps`); at settlement it transfers the fee to the policy account (SOL) or the
policy's associated token account, then calls `collect_fee_sol` / `collect_fee_token` signed as the
vault, and the policy books the amount only if its balance shows it arrived (`collectFee`).
`withdraw_fees_*` pays booked fees out to the authority's chosen account. The policy never holds an
allowance, never pulls funds and never blocks on anything but the receipt check. Two deviations
from EVM: a failing policy fails the settlement rather than waiving the fee (a Solana CPI error
cannot be caught), which is why the policy only books receipts, and a zero fee skips the call.

## Claims, owner cache and refunds (EVM P2IDVault parity)

| EVM | Solana (program) |
| --- | --- |
| `fund`, `fundWith(verifier, …)`, `fundWithRefunder(…, refundAddress, …)` (V2) | one instruction per asset: `fund_sol` / `fund_token(amount, constraint, refund_window, refunder?, reference)` (implementation); the verifier is the `verifier_config` account passed (the default's for plain funding), `refunder` null means the funder |
| `refreshProof(verifier, proof)` | `refresh_proof(proof, public_witness)` with any allowed `verifier_program` (implementation) |
| `refreshProofAndSweep` / `sweepDeposits` | `claim_sol` / `claim_token(id, proof, public_witness)` (implementation) |
| `sweep` (proofless, cached owner) | the same instructions with an empty `proof` and `public_witness` |
| `sweepBucket(…, Constraint{commitment, signature}, …)` | the same instructions, preceded in the transaction by an Ed25519 instruction (see below) |
| `sweepUntracked(token)` | `sweep_untracked_sol` / `sweep_untracked_token` (router) |
| `refund(depositId)` | `refund_sol` / `refund_token(id)` (router) |
| `upgradeTo(implementation)` on a vault | `set_vault_implementation(program)` (router, cached owner signs) |
| `Funded`, `Claimed`, `Refunded`, `OwnerRefreshed`, `Swept` events | `Funded`, `Claimed`, `Refunded`, `OwnerRefreshed`, `UntrackedSwept`, plus `ImplementationRegistered`, `VaultImplementationChanged` (all emitted by the router) |

Nobody signs a claim but the transaction fee payer: `owner` is a plain destination account, so a
relayer can submit a user's proof and pay the fees, as on EVM. With a proof, `owner` must be the
wallet the proof names (public inputs 9-10 commit to its base58 string, type 12). The newest
accepted proof makes its wallet the vault's cached owner; a same-age proof must name that owner;
an older proof is refused, so a leaked proof can never roll the owner back. Later deposits can be
claimed for the cached owner with an empty proof and witness while the cache is current: the
deposit pins the verifier the owner was proven under and no signer key has been removed since.
Token claims create the payee's and the policy's associated token accounts when missing (rent paid
by `payer`). A deposit can be refunded only after `funded_at + refund_window`, by the refunder named
at funding or, when none was named, by the funder (P2IDVaultV2 semantics: a named refunder is the
one account that may refund and is paid); the payee may claim at any time until that happens.

The implementation follows the current EVM release, `P2IDVaultV2` and `PviumVerifierV2`; it does
not reproduce behaviour of the first implementation that V2 changed.

**Constraints.** A deposit funded with a nonzero `constraint` (a screening commitment) is released
only if an earlier instruction of the same transaction is the Ed25519 program verifying a signature
by one of the deposit's verifier's `constraint_signers` over `"p2id.constraint.sol.v1" || factory || commitment`.
The runtime checks the signature; the router reads the instructions sysvar at settlement to confirm
which key signed what. The authority adds and removes a verifier's constraint signers immediately
(`set_constraint_signer`), as the EVM verifier owner does; funding with a constraint is refused
while the chosen verifier has none (EVM: `supportsConstraints()`).

**Untracked funds.** SOL or tokens sent straight to a vault (no deposit record) are swept to the
cached owner by `sweep_untracked_*`, at the current policy rate; recorded deposits and the vault's
rent are never touched (`tracked_sol`, `VaultMint.tracked`).

**Transaction size and compute.** A Sunspot proof plus witness is ~750 bytes; a proof-carrying
`claim_sol` has 13 accounts and does not fit a legacy transaction, `claim_token` with ~22 accounts
even less so. Present the proof once with `refresh_proof` (8 accounts, fits) and claim without a
proof afterwards, or use an address lookup table. A proofless token claim uses ~160k compute units
across the three programs; a proof-carrying one needs a compute-budget instruction sized for the
Sunspot verifier as well.

**Account layout.** Every account carries a `version` and 128 (32 for deposits) reserved bytes so a
later implementation can record more without the router reallocating.

Each verifier program the factory accepts has a `VerifierConfig` account, the counterpart of the
EVM `PviumVerifier` + `PviumIdentity` pair (the Sunspot verifier program itself is stateless): whether
it is allowed, the circuit version and vk hash it verifies, the P-256 keys a proof's Privy token must
have been signed by (public inputs 2-5; the proof binds the token signature to that key), and its
constraint signers. `propose_verifier` creates the config for a new circuit version with its keys;
`activate_verifier` allows it and makes it the default after the notice; `revoke_verifier` disallows
a non-default one immediately. Per config, `propose_signer_key` / `activate_signer_key` add a key
after a 7-day notice and `remove_signer_key` retires one immediately, incrementing
`key_set_revision`. A claim is checked against the config of the verifier its deposit pins, so keys
and signers rotate per circuit version, as on EVM.

## Verifier wrapper

The `p2id_solana_verifier` program forwards a Sunspot proof to a caller-selected verifier program using a
cross-program invocation (CPI). It passes the proof bytes followed by the serialized public
witness bytes, matching the interface used by
[`solana-test/verify-anchor.js`](../solana-test/verify-anchor.js).
The instruction succeeds only if the CPI succeeds. On success, the wrapper sets Solana return data
to the single byte `1`.

The verifier program ID is an instruction argument and its executable account is also supplied
to the instruction. The program checks that the account key equals the requested ID and that the
account is executable. The caller must still choose and trust the correct verifier: an arbitrary
executable program could return success without verifying the proof.

## Build

The workspace is configured for Anchor CLI 1.1.2 and Solana CLI 3.1.10. To set up a deployable
program ID, create a program keypair locally and synchronize the declared ID:

```sh
cd solana-anchor
mkdir -p target/deploy
for p in p2id_router p2id_vault p2id_policy p2id_solana_verifier; do
  solana-keygen new -o target/deploy/$p-keypair.json --no-bip39-passphrase
done
anchor keys sync
anchor build
```

Keep the generated keypair private and out of version control. `anchor keys sync` updates the
program IDs in `Anchor.toml` and each program's `declare_id!` to match them. Local tests run against
the workspace programs with `anchor test --validator legacy`.

## Instruction

`verify(verifier_program_id, proof, public_witness)` takes:

- `verifier_program_id`: the deployed Sunspot verifier program address.
- `proof`: the decoded bytes from the prover response's base64 `proof` field.
- `public_witness`: the decoded bytes from `publicWitness` (or Solana `publicInputs`).

The verifier CPI receives `proof || public_witness` as its instruction data and no account metas,
matching Sunspot's stateless verifier interface. The combined payload is capped at 900 bytes.
The local sample response is 388 proof bytes plus 76 public-witness bytes.

The outer transaction must include a compute-budget instruction sized for the verifier. The
existing direct-verifier example uses 600,000 units; CPI adds wrapper overhead, so simulate the
transaction and increase the budget as needed, up to the cluster's transaction limit. A successful
Anchor instruction means the CPI returned successfully; return data is `[1]`.

## Local test setup

Build the Sunspot verifier and the Anchor wrapper first. The following commands assume the
Sunspot artifacts are in `circuit/target` and that the wrapper keypair was created at
`solana-anchor/target/deploy/p2id_solana_verifier-keypair.json`.

In Terminal 1, from the repository root, start a fresh local validator with the Sunspot verifier
preloaded at the address derived from its keypair:

```sh
solana-test-validator --reset \
  --bpf-program circuit/target/pvium_identity-keypair.json circuit/target/pvium_identity.so
```

In another terminal, derive and print the verifier's public program ID from its keypair file:

```sh
solana address -k circuit/target/pvium_identity-keypair.json
```

Use the printed address as `SUNSPOT_VERIFIER_PROGRAM_ID`. The command prints only the public
address; keep the keypair file private.

In Terminal 2, deploy the Anchor wrapper and confirm its program is visible on the local
validator:

```sh
cd solana-anchor
solana airdrop 5 --url http://127.0.0.1:8899
anchor deploy
solana program show "$(solana address -k target/deploy/p2id_solana_verifier-keypair.json)" \
  --url http://127.0.0.1:8899
```

Save a Solana attestation response to `solana-test/data.json`. In Terminal 3, from the repository
root, copy the example environment file if needed, export the IDs derived from the two program
keypairs, and run the Anchor client:

```sh
cd solana-test
test -f .env || cp .env.example .env
export P2ID_ANCHOR_PROGRAM_ID="$(solana address -k ../solana-anchor/target/deploy/p2id_solana_verifier-keypair.json)"
export SUNSPOT_VERIFIER_PROGRAM_ID="$(solana address -k ../circuit/target/pvium_identity-keypair.json)"
yarn install
yarn verify:anchor
```

The client sends `proof || public_witness` through the Anchor wrapper and checks that the wrapper
returns `[1]`. `--reset` clears the validator's local ledger at startup; omit it to preserve an
existing ledger, but make sure the Sunspot verifier is already deployed there. The wrapper does
not deploy or configure the verifier program itself. The direct verifier path is available
separately as `yarn verify:direct`; it uses `VERIFIER_PROGRAM_ID` and bypasses the Anchor wrapper.
